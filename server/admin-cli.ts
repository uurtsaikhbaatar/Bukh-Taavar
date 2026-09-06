/**
 * Админы командууд (PowerShell):
 *
 *   npm run admin -- users                       хэрэглэгчид, үлдэгдэл
 *   npm run admin -- make-admin <нэр>            админ болгох
 *   npm run admin -- grant <нэр> <тоо> [шалтгаан] токен олгох
 *   npm run admin -- reset-pw <нэр> <шинэ нууц үг>
 *   npm run admin -- verify <нэр>                имэйлийг гараар баталгаажуулах
 *
 * DATABASE_URL байвал Postgres, үгүй бол локал файлууд (data/). Сервер ажиллаж
 * байхад локал файл дээр ажиллуулбал серверийн санах ойн төлөвтэй зөрөх тул
 * production-д Postgres дээр (сервер нь дараагийн уншилтаараа авна) л хэрэглэ.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from '../src/engine.ts';
import { fmtTokens, table } from '../src/format.ts';
import { JsonlLog, type EventLog } from '../src/store.ts';
import { MemoryAuthStore, type AuthSnapshot, type AuthStore } from './auth-store.ts';
import { Auth } from './auth.ts';
import { closePool, initSchema, PostgresAuthStore, PostgresLog } from './db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  let log: EventLog & { flush?: () => Promise<void> };
  let store: AuthStore;
  if (process.env.DATABASE_URL) {
    await initSchema();
    log = await PostgresLog.load();
    store = new PostgresAuthStore();
  } else {
    log = new JsonlLog(path.join(ROOT, 'data', 'web-events.jsonl'));
    const mem = new MemoryAuthStore();
    const file = path.join(ROOT, 'data', 'web-auth.json');
    if (existsSync(file)) mem.restore(JSON.parse(readFileSync(file, 'utf8')) as AuthSnapshot);
    mem.onChange = () => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(mem.snapshot(), null, 1), 'utf8');
    };
    store = mem;
  }
  const engine = new Engine(log);
  const auth = new Auth(store);
  const flush = async () => {
    if (log.flush) await log.flush();
  };
  const find = async (name: string) => {
    const acc = await auth.accountByUsername(name);
    if (!acc) throw new Error(`«${name}» нэртэй хэрэглэгч олдсонгүй.`);
    return acc;
  };

  switch (cmd) {
    case 'users': {
      const accounts = await auth.listAccounts();
      console.log(
        table(
          ['Нэр', 'Имэйл', 'Баталгаа', 'Үүрэг', 'Үлдэгдэл'],
          accounts.map((a) => [a.username, a.email, a.emailVerified ? 'тийм' : 'үгүй', a.role, engine.state.users.get(a.id)?.balance ?? 0]),
        ),
      );
      break;
    }
    case 'make-admin': {
      const acc = await find(args[0] ?? '');
      await auth.setRole(acc.id, 'admin');
      console.log(`${acc.username} → админ.`);
      break;
    }
    case 'grant': {
      const acc = await find(args[0] ?? '');
      const amount = Number(args[1]);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Тоо бүхэл, эерэг байх ёстой.');
      if (!engine.state.users.has(acc.id)) engine.createUser({ id: acc.id, name: acc.username, role: acc.role });
      const balance = engine.grantTokens(acc.id, amount, args.slice(2).join(' ') || 'админы олголт');
      await flush();
      console.log(`${acc.username}: +${fmtTokens(amount)} → ${fmtTokens(balance)}`);
      break;
    }
    case 'reset-pw': {
      const acc = await find(args[0] ?? '');
      await auth.adminResetPassword(acc.id, args[1] ?? '');
      console.log(`${acc.username}: нууц үг шинэчлэгдлээ (бүх session хаагдсан).`);
      break;
    }
    case 'verify': {
      const acc = await find(args[0] ?? '');
      // Гараар баталгаажуулах: код үүсгэхгүйгээр шууд.
      await store.updateUser(acc.id, { emailVerified: true });
      console.log(`${acc.username}: имэйл баталгаажсанд тооцов.`);
      break;
    }
    default:
      console.log('Командууд: users | make-admin <нэр> | grant <нэр> <тоо> [шалтгаан] | reset-pw <нэр> <нууц үг> | verify <нэр>');
  }
  await closePool().catch(() => undefined);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
