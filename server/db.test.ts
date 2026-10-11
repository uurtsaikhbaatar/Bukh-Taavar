import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import type { BukhEvent } from '../src/events.ts';
import { initSchema, LogMovedError, PostgresLog, WriterFencedError, type LogDb } from './db.ts';

/** Жинхэнэ Postgres (WASM, процесс дотор) — `pg.Pool`-ын хэрэгтэй хэсгийг дуурайна. */
async function memoryDb(): Promise<{ db: LogDb; close: () => Promise<void> }> {
  const pg = new PGlite();
  const query = async (text: string, params?: unknown[]) => {
    // Олон мэдэгдэлтэй, параметргүй SQL (схем) — exec; бусад нь query
    if (params === undefined && text.split(';').filter((s) => s.trim() !== '').length > 1) {
      await pg.exec(text);
      return { rows: [] };
    }
    const r = await pg.query(text, params as never[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };
  const db: LogDb = { query, connect: async () => ({ query, release: () => undefined }) };
  await initSchema(db);
  return { db, close: () => pg.close() };
}

let n = 0;
const ev = (name: string): BukhEvent => ({ id: `e${++n}-${name}`, at: new Date(Date.UTC(2026, 9, 11, 0, 0, n)).toISOString(), type: 'user_created', userId: `u-${name}-${n}`, name, role: 'member', balance: 100 });
const names = (log: PostgresLog) => log.readAll().map((e) => (e as { name?: string }).name);
const stored = async (db: LogDb) => (await db.query('SELECT payload FROM events ORDER BY seq')).rows.map((r) => (r.payload as { name: string }).name);

test('ганц бичигч: шинэ бичигч эрхийг авмагц хуучных нь юу ч бичиж чадахгүй (deploy-ийн давхцал)', async () => {
  const { db, close } = await memoryDb();
  try {
    const old = await PostgresLog.load(db, { owner: 'server:old' });
    old.append(ev('эхний'));
    await old.flush();
    assert.equal(old.fenced, false);

    // Шинэ instance асч байна: эрхийг авч, ДАРАА нь логийг уншина — хуучны бичсэн бүгд харагдана
    const fresh = await PostgresLog.load(db, { owner: 'server:new' });
    assert.deepEqual(names(fresh), ['эхний']);
    assert.equal(fresh.writerEpoch, old.writerEpoch! + 1);

    // Хуучин instance хараахан амьд, бичих гэж оролдоно → татгалзана, юу ч нэмэгдэхгүй
    let notified = '';
    old.onFenced = (owner) => (notified += owner);
    old.append(ev('хоцорсон'));
    old.append(ev('хоцорсон-2'));
    await assert.rejects(old.flush(), (err: unknown) => err instanceof WriterFencedError && err.owner === 'server:new');
    assert.equal(notified, 'server:new');
    assert.equal(old.fenced, true);
    assert.equal(old.pending, 0, 'бичигдээгүй багц хаягдана — дахин оролдохгүй');
    assert.throws(() => old.append(ev('дахиад')), WriterFencedError);
    await assert.rejects(old.flush(), WriterFencedError);
    assert.equal(notified, 'server:new', 'мэдэгдэл нэг л удаа');

    // Шинэ instance хэвийн бичнэ; лог дан ганц бичигчийн үйл явдлуудаас тогтоно
    fresh.append(ev('шинэ'));
    await fresh.flush();
    assert.deepEqual(await stored(db), ['эхний', 'шинэ']);
    const again = await PostgresLog.load(db, { owner: 'server:restart' });
    assert.deepEqual(names(again), ['эхний', 'шинэ']);
  } finally {
    await close();
  }
});

test('admin-cli (хойшлуулсан эрх авалт): уншихдаа серверийг хөндөхгүй; бичихдээ эрхийг авна; лог хөдөлсөн бол бичихгүй', async () => {
  const { db, close } = await memoryDb();
  try {
    const server = await PostgresLog.load(db, { owner: 'server:a' });
    server.append(ev('сервер-1'));
    await server.flush();

    // Зөвхөн унших команд (жагсаалт): эрх авахгүй → сервер бичсээр байна
    const reader = await PostgresLog.load(db, { owner: 'cli:users', claim: false });
    assert.equal(reader.writerEpoch, undefined);
    assert.deepEqual(names(reader), ['сервер-1']);
    await reader.flush(); // бичих зүйлгүй — юу ч хийхгүй
    server.append(ev('сервер-2'));
    await server.flush();
    assert.equal(server.fenced, false);

    // Уншсанаас хойш сервер бичсэн → хуучирсан төлөв дээр бичихгүй, серверийн эрхийг ч авахгүй
    reader.append(ev('хуучирсан-олголт'));
    await assert.rejects(reader.flush(), LogMovedError);
    assert.equal(reader.pending, 0);
    server.append(ev('сервер-3'));
    await server.flush();
    assert.equal(server.fenced, false, 'бүтэлгүйтсэн CLI серверийг хаахгүй (эрх авалт буцсан)');

    // Шинэ уншилттай команд бичнэ → эрх CLI-д шилжиж, сервер дараагийн бичилтээрээ мэднэ (дахин асаж логийг уншина)
    const cli = await PostgresLog.load(db, { owner: 'cli:grant', claim: false });
    cli.append(ev('олголт'));
    await cli.flush();
    assert.ok(cli.writerEpoch! > server.writerEpoch!);
    server.append(ev('сервер-4'));
    await assert.rejects(server.flush(), (err: unknown) => err instanceof WriterFencedError && err.owner === 'cli:grant');
    assert.deepEqual(await stored(db), ['сервер-1', 'сервер-2', 'сервер-3', 'олголт']);
  } finally {
    await close();
  }
});

test('ердийн алдаа (давхардсан id): багц буцаж дараалалд орно, эрх хэвээр; схем давтан үүсгэхэд эрхийн дугаар хадгалагдана', async () => {
  const { db, close } = await memoryDb();
  try {
    const log = await PostgresLog.load(db, { owner: 'server:a' });
    const first = ev('нэг');
    log.append(first);
    await log.flush();
    log.append({ ...first }); // ижил id → UNIQUE зөрчил
    await assert.rejects(log.flush());
    assert.equal(log.pending, 1, 'бичигдээгүй үйл явдал алдагдахгүй');
    assert.equal(log.fenced, false);
    assert.deepEqual(await stored(db), ['нэг']);
    await initSchema(db);
    const next = await PostgresLog.load(db, { owner: 'server:b' });
    assert.equal(next.writerEpoch, log.writerEpoch! + 1, 'initSchema эрхийн тоолуурыг тэглэхгүй');
  } finally {
    await close();
  }
});
