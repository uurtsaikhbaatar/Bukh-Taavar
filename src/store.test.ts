import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BukhEvent } from './events.ts';
import { JsonlLog, LogCorruptError, MemoryLog } from './store.ts';

const at = '2026-08-16T10:00:00.000Z';
const ev: BukhEvent[] = [
  { id: 'e1', at, type: 'user_created', userId: 'u1', name: 'Бат', role: 'admin', balance: 10_000 },
  { id: 'e2', at, type: 'wrestler_added', wrestler: { id: 'w1', name: 'Б.Орхонбаяр', title: 'даян_аварга', aimag: 'Сэлэнгэ' } },
];

test('MemoryLog: хуулбарлаж хадгална (гадна өөрчлөлт нөлөөлөхгүй)', () => {
  const log = new MemoryLog();
  const e = structuredClone(ev[0]!);
  log.append(e);
  (e as { name: string }).name = 'ӨӨРЧЛӨГДСӨН';
  const all = log.readAll();
  assert.equal(all.length, 1);
  assert.equal((all[0] as { name: string }).name, 'Бат');
  assert.equal(log.length, 1);
});

test('JsonlLog: бичээд буцааж уншихад ижил (кирилл, UTF-8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bukh-'));
  try {
    const path = join(dir, 'дэд', 'лог.jsonl');
    const log = new JsonlLog(path);
    assert.deepEqual(log.readAll(), []);
    for (const e of ev) log.append(e);
    assert.deepEqual(log.readAll(), ev);
    assert.equal(readFileSync(path, 'utf8').split('\n').length, 3); // 2 мөр + төгсгөлийн хоосон
    // Дахин нээхэд үргэлжлүүлж нэмнэ
    const log2 = new JsonlLog(path);
    log2.append({ id: 'e3', at, type: 'market_closed', marketId: 'm1' });
    assert.equal(log2.readAll().length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonlLog: эвдэрсэн мөр → LogCorruptError (чимээгүй алгасахгүй)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bukh-'));
  try {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, JSON.stringify(ev[0]) + '\n{эвдэрсэн\n', 'utf8');
    assert.throws(() => new JsonlLog(path).readAll(), LogCorruptError);
    writeFileSync(path, JSON.stringify(ev[0]) + '\n{"type":"юу_ч_биш","id":"x","at":"y"}\n', 'utf8');
    assert.throws(() => new JsonlLog(path).readAll(), LogCorruptError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
