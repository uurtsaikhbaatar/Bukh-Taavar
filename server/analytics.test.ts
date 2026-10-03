import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../src/engine.ts';
import { MemoryLog } from '../src/store.ts';
import { Analytics } from './analytics.ts';

/** Жижиг хиймэл архив: А нь Б, В-г давж, Б нь В-г давна. */
function tinyArchive(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bukh-archive-'));
  const bouts = [
    { tid: 'T1', date: '2026-01-01', round: 1, w1: 'A', w2: 'B', winner: 1, mid: 'm1' },
    { tid: 'T2', date: '2026-02-01', round: 1, w1: 'A', w2: 'C', winner: 1, mid: 'm2' },
    { tid: 'T3', date: '2026-03-01', round: 1, w1: 'B', w2: 'C', winner: 1, mid: 'm3' },
  ];
  writeFileSync(join(dir, 'bouts.jsonl'), bouts.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8');
  const w = (id: string) => ({ name: id, title: 'цолгүй', titleCode: 0, aimagCode: 0, devjeeId: id });
  writeFileSync(join(dir, 'wrestlers.json'), JSON.stringify({ A: w('A'), B: w('B'), C: w('C') }), 'utf8');
  writeFileSync(join(dir, 'tournaments.json'), '[]', 'utf8');
  return dir;
}

test('backfillPredictive: хурдан рейтинг нөхнө, туршлагыг архивынх хүртэл өсгөнө (бууруулахгүй), бичлэггүй бөхөд бүтэн; идемпотент', () => {
  const dir = tinyArchive();
  try {
    const an = Analytics.tryLoad(dir, () => undefined)!;
    const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `a${++n}`; })(), bracket: false });
    for (const id of ['A', 'B', 'C']) engine.addWrestler({ id, name: id, title: 'цолгүй' });
    // А: туршлагагүй бичлэгээс локал 1 барилдаан тоологдсон (0-ээс эхэлсэн алдааны дүр зураг)
    engine.setRating('A', 1500, 'local', '2026-03-05', { games: 1, lastBoutAt: '2026-01-15' });
    // В: локалд архиваас ОЛОН барилдсан (архивын дараах барилдаан) — бууруулахгүй
    engine.setRating('C', 1400, 'local', '2026-03-05', { games: 5, lastBoutAt: '2026-04-01T10:00:00.000Z' });
    assert.equal(an.backfillPredictive(engine), 3);
    const a = engine.rating('A');
    assert.equal(a.games, 2, 'архивт А 2 барилдсан');
    assert.equal(a.lastBoutAt, '2026-02-01');
    assert.equal(a.rating, 1500, 'дэлгэцийн рейтинг хөндөгдөхгүй');
    assert.ok(a.fast !== undefined && a.fast > 1300, 'хурдан рейтинг нөхөгдсөн (А хоёуланг давсан)');
    const b = engine.rating('B');
    assert.equal(b.source, 'devjee', 'бичлэггүй бөхөд архивын бүтэн бичлэг');
    assert.equal(b.games, 2);
    const c = engine.rating('C');
    assert.equal(c.games, 5, 'туршлагыг бууруулахгүй (max)');
    assert.equal(c.lastBoutAt, '2026-04-01T10:00:00.000Z', 'шинэ огноог хуучнаар дарахгүй');
    assert.ok(c.fast !== undefined);
    assert.equal(an.backfillPredictive(engine), 0, 'дахин ажиллуулахад юу ч бичихгүй');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
