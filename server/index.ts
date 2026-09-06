/**
 * Веб сервер — эхлүүлэх цэг.
 *
 *   npm run web            локал: JSONL лог (data/web-events.jsonl) + файлд хадгалдаг бүртгэл
 *                          (data/web-auth.json), имэйл консол горим, порт 8787
 *   DATABASE_URL=… node server/index.ts   production: Neon Postgres (лог + бүртгэл)
 *
 * Орчны хувьсагч: PORT, DATABASE_URL, EMAIL_PROVIDER/EMAIL_API_KEY/EMAIL_FROM,
 * DEVJEE_FIREBASE_KEY (заавал биш), DEVJEE_DISABLED=1 (devjee холболтгүй),
 * SECURE_COOKIES=1 (https-ийн ард), STATIC_DIR (анхдагч app/dist).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DevjeeClient } from '../src/devjee.ts';
import { Engine } from '../src/engine.ts';
import { JsonlLog, type EventLog } from '../src/store.ts';
import { Analytics } from './analytics.ts';
import { createRouter, devCors } from './api.ts';
import { MemoryAuthStore, type AuthSnapshot, type AuthStore } from './auth-store.ts';
import { Auth } from './auth.ts';
import { closePool, initSchema, PostgresAuthStore, PostgresLog } from './db.ts';
import { DevjeeSync } from './devjee-sync.ts';
import { emailProvider } from './email.ts';
import { SseHub, staticServer } from './http.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = process.env.STATIC_DIR ?? path.join(ROOT, 'app', 'dist');

/** Файлд хадгалдаг санах ойн бүртгэл — локал хөгжүүлэлтэд. */
function fileAuthStore(file: string): MemoryAuthStore {
  const store = new MemoryAuthStore();
  if (existsSync(file)) {
    try {
      store.restore(JSON.parse(readFileSync(file, 'utf8')) as AuthSnapshot);
    } catch (err) {
      console.error(`Бүртгэлийн файл уншигдсангүй (${file}):`, err instanceof Error ? err.message : err);
    }
  }
  store.onChange = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(store.snapshot(), null, 1), 'utf8');
  };
  return store;
}

async function main(): Promise<void> {
  let log: EventLog & { flush?: () => Promise<void> };
  let authStore: AuthStore;
  let mode: string;
  if (process.env.DATABASE_URL) {
    await initSchema();
    log = await PostgresLog.load();
    authStore = new PostgresAuthStore();
    mode = 'Postgres';
  } else {
    mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    log = new JsonlLog(path.join(ROOT, 'data', 'web-events.jsonl'));
    authStore = fileAuthStore(path.join(ROOT, 'data', 'web-auth.json'));
    mode = 'локал (JSONL + JSON файл)';
  }

  const engine = new Engine(log);
  const auth = new Auth(authStore);
  const hub = new SseHub();
  const flush = async () => {
    if (log.flush) await log.flush();
  };

  let devjee: DevjeeSync | undefined;
  if (process.env.DEVJEE_DISABLED !== '1') {
    const client = new DevjeeClient({ cacheDir: path.join(ROOT, 'data', 'cache', 'devjee') });
    devjee = new DevjeeSync({
      client,
      engine,
      onSynced: async (r) => {
        await flush();
        hub.broadcast('changed', { type: 'changed', marketIds: r.marketIds, at: new Date().toISOString() });
      },
    });
  }

  let analytics: Analytics | undefined;
  try {
    analytics = Analytics.tryLoad(path.join(ROOT, 'data', 'devjee'));
  } catch (err) {
    console.error('Архивын шинжилгээ ачаалагдсангүй:', err instanceof Error ? err.message : err);
  }

  const router = createRouter({
    engine,
    auth,
    flush,
    hub,
    secureCookies: process.env.SECURE_COOKIES === '1',
    ...(devjee ? { devjee } : {}),
    ...(analytics ? { analytics } : {}),
  });
  const serveStatic = staticServer(STATIC_DIR);
  const isProd = process.env.NODE_ENV === 'production';

  const server = createServer(async (req, res) => {
    try {
      if (!isProd && devCors(req, res)) return;
      if (await router.handle(req, res)) return;
      if ((req.method ?? 'GET') === 'GET' && (await serveStatic(req, res))) return;
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Бөхийн таавар</title><body style="font-family:system-ui;padding:24px"><h2>Бөхийн таавар — сервер ажиллаж байна</h2><p>Апп хараахан бүтээгдээгүй: <code>npm run build:web</code> ажиллуулна уу. API: <a href="/health">/health</a></p>`,
      );
    } catch (err) {
      console.error('Хүсэлт боловсруулахад алдаа:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Серверийн алдаа.', code: 'INTERNAL' }));
      } else res.end();
    }
  });

  const pingTimer = setInterval(() => hub.ping(), 25_000);
  pingTimer.unref();

  server.listen(PORT, () => {
    console.log(`Бөхийн таавар — сервер: http://localhost:${PORT}`);
    console.log(`  хадгалалт: ${mode} · имэйл: ${emailProvider()} · devjee: ${devjee ? 'идэвхтэй' : 'унтраалттай'} · архив: ${analytics ? `${analytics.archive.bouts.length} барилдаан` : 'байхгүй'} · статик: ${STATIC_DIR}${existsSync(STATIC_DIR) ? '' : ' (байхгүй)'}`);
    console.log(`  төлөв: ${engine.state.eventCount} үйл явдал, ${engine.state.users.size} хэрэглэгч, ${engine.state.markets.size} зах зээл`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — зогсож байна…`);
    clearInterval(pingTimer);
    devjee?.stop();
    hub.closeAll();
    server.close();
    try {
      await flush();
      await closePool();
    } catch (err) {
      console.error('Хаахад алдаа:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Сервер эхэлж чадсангүй:', err);
  process.exit(1);
});
