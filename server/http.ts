/**
 * Жижиг HTTP суурь — Node `http` дээр: чиглүүлэгч, JSON body, cookie, статик
 * файл, SSE (Server-Sent Events) хаб, хурдны хязгаар. Framework-гүй.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  cookies: Record<string, string>;
  ip: string;
}

/** Хариуг өөрөө бичсэн handler энэ тэмдгийг буцаана. */
export const RESPONDED: unique symbol = Symbol('responded');

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const MAX_BODY = 64 * 1024;

export function ipOf(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? '').trim();
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: { maxAgeSec?: number; secure?: boolean; path?: string } = {},
): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${opts.maxAgeSec}`);
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('set-cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('set-cookie', [...list, parts.join('; ')]);
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Хүсэлт хэт том.', 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'JSON буруу.', 'BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i]!;
        const p = parts[i]!;
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(p);
        else if (rp !== p) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method' : null;
  }

  /** Тохирох маршрут байвал боловсруулаад true; байхгүй бол false. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const m = this.match(method, url.pathname);
    if (m === null) return false;
    try {
      if (m === 'method') throw new HttpError(405, 'Method зөвшөөрөгдөхгүй.', 'METHOD');
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readJson(req) : undefined;
      const ctx: Ctx = {
        req,
        res,
        method,
        path: url.pathname,
        query: url.searchParams,
        params: m.params,
        body,
        cookies: parseCookies(req),
        ip: ipOf(req),
      };
      const result = await m.route.handler(ctx);
      if (result === RESPONDED) return true;
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      const e = toHttpError(err);
      if (e.status >= 500) console.error(`[http] ${method} ${url.pathname}:`, err);
      sendJson(res, e.status, { error: e.message, code: e.code });
    }
    return true;
  }
}

/** Ямар ч алдааг HttpError болгоно (EngineError/AuthError-ийн статусыг хүндэтгэнэ). */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; status?: number; code?: string; name?: string };
    if (typeof e.status === 'number') return new HttpError(e.status, e.message ?? 'Алдаа', e.code ?? 'ERROR');
    if (e.name === 'EngineError' || e.name === 'DevjeeError' || typeof e.code === 'string') {
      return new HttpError(400, e.message ?? 'Алдаа', e.code ?? 'ERROR');
    }
  }
  return new HttpError(500, 'Серверийн алдаа.', 'INTERNAL');
}

// ───────────────────────── SSE ─────────────────────────

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private counter = 0;

  /** Хүсэлтийг SSE урсгал болгож бүртгэнэ. */
  attach(req: IncomingMessage, res: ServerResponse, hello?: unknown): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    if (hello !== undefined) res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  broadcast(event: string, data: unknown): void {
    const payload = `id: ${++this.counter}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try {
        c.write(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** Холболтыг амьд байлгах (proxy-ууд 30–60 сек чимээгүйд таслана). */
  ping(): void {
    for (const c of this.clients) {
      try {
        c.write(`: ping\n\n`);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

// ───────────────────────── хурдны хязгаар ─────────────────────────

/** Энгийн цонхлосон тоолуур: `limit` хүсэлт / `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Зөвшөөрөгдвөл true. */
  allow(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

// ───────────────────────── статик файл ─────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * `root` доторх файлыг илгээнэ; олдохгүй бол SPA-гийн ёсоор index.html.
 * Ямар ч файл байхгүй бол false.
 */
export function staticServer(root: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const ROOT = path.resolve(root);
  return async (req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const candidate = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, candidate);
    const safe = resolved === ROOT || resolved.startsWith(ROOT + path.sep);
    const target = safe && (await isFile(resolved)) ? resolved : path.join(ROOT, 'index.html');
    if (!(await isFile(target))) return false;
    const ext = path.extname(target).toLowerCase();
    const immutable = target.includes(`${path.sep}_expo${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(target).pipe(res);
    return true;
  };
}
