import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // В: архивт байхгүй локал барилдаантай (архивын дараах) — рейтинг, туршлагыг нь архиваар дарахгүй
    engine.addWrestler({ id: 'Z', name: 'Z', title: 'цолгүй' });
    engine.createTournament({ id: 'loc', name: 'Локал', date: '2026-04-01', rounds: 1 });
    engine.createBout({ id: 'lb1', tournamentId: 'loc', round: 1, aId: 'C', bId: 'Z', withMarket: false });
    engine.recordBoutResult('lb1', 'C', { updateRatings: false });
    engine.setRating('C', 1400, 'local', '2026-03-05', { games: 5, lastBoutAt: '2026-04-01T10:00:00.000Z' });
    assert.equal(an.backfillPredictive(engine), 3);
    const a = engine.rating('A');
    assert.equal(a.games, 2, 'архивт А 2 барилдсан');
    assert.equal(a.lastBoutAt, '2026-02-01');
    assert.ok(Math.abs(a.rating - an.elo.get('A')!) < 1e-9, 'архив бүрэн хамарсан бөхийн рейтинг архивынхаар тавигдана');
    assert.equal(a.source, 'devjee');
    assert.ok(a.fast !== undefined && a.fast > 1300, 'хурдан рейтинг нөхөгдсөн (А хоёуланг давсан)');
    const b = engine.rating('B');
    assert.equal(b.source, 'devjee', 'бичлэггүй бөхөд архивын бүтэн бичлэг');
    assert.equal(b.games, 2);
    const c = engine.rating('C');
    assert.equal(c.rating, 1400, 'архиваас урагшилсан бөхийн рейтингийг хөндөхгүй');
    assert.equal(c.games, 5, 'туршлагыг бууруулахгүй (max)');
    assert.equal(c.lastBoutAt, '2026-04-01T10:00:00.000Z', 'шинэ огноог хуучнаар дарахгүй');
    assert.ok(c.fast !== undefined);
    assert.equal(an.backfillPredictive(engine), 0, 'дахин ажиллуулахад юу ч бичихгүй');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('рейтингийг архивтай тулгах: архивт байгаа барилдаанаас үүссэн гажсан локал рейтинг засагдана; архивт байхгүй барилдаантай бөхийг хөндөхгүй; өөр төрлийн бөхийн үр дүн тооцогдохгүй', () => {
  const dir = tinyArchive();
  try {
    // Архивт нэмэлт: Монгол бөх биш (өвөрмонгол) барилдаан — А нь В-д унасан. Рейтингт орох ёсгүй.
    appendFileSync(join(dir, 'bouts.jsonl'), JSON.stringify({ tid: 'T4', date: '2026-03-02', round: 2, w1: 'A', w2: 'C', winner: 2, mid: 'm4', fmt: 'team', other: true }) + '\n', 'utf8');
    const an = Analytics.tryLoad(dir, () => undefined)!;
    assert.equal(an.archive.bouts.length, 3, 'өөр төрлийн бөхийн барилдаан үндсэн жагсаалтад орохгүй');
    assert.equal(an.archive.skipped?.length, 1);
    const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `r${++n}`; })(), bracket: false, now: () => new Date('2026-03-02T05:00:00Z') });
    for (const id of ['A', 'B', 'C', 'D', 'E']) engine.addWrestler({ id, name: id, title: 'цолгүй' });
    // Сервер архивын T3 (Б–В) ба T4 (А–В, өвөрмонгол) тэмцээнийг амьдаар нь бүртгэсэн. Тухайн үед
    // түүхгүй бөхийг 1450-аас эхлүүлж, өвөрмонгол бөхийн үр дүнг ч рейтингт оруулдаг байсан (гажиг).
    for (const id of ['A', 'B', 'C']) engine.setRating(id, 1450, 'local', '2026-02-15', { fast: 1450, games: 1, lastBoutAt: '2026-02-01' });
    engine.createTournament({ id: 'dj-T3', name: 'Т3', date: '2026-03-01', rounds: 1, devjeeId: 'T3' });
    engine.createBout({ id: 'dj-m3', tournamentId: 'dj-T3', round: 1, aId: 'B', bId: 'C', devjeeMatchId: 'm3', withMarket: false });
    engine.recordBoutResult('dj-m3', 'B');
    engine.createTournament({ id: 'dj-T4', name: 'Т4', date: '2026-03-02', rounds: 2, devjeeId: 'T4' });
    engine.createBout({ id: 'dj-m4', tournamentId: 'dj-T4', round: 2, aId: 'A', bId: 'C', devjeeMatchId: 'm4', withMarket: false });
    engine.recordBoutResult('dj-m4', 'C');
    // Архивт байхгүй (гараар үүсгэсэн) тэмцээн: Г–Д
    engine.createTournament({ id: 'local', name: 'Гар тэмцээн', date: '2026-03-02', rounds: 1 });
    engine.createBout({ id: 'x1', tournamentId: 'local', round: 1, aId: 'D', bId: 'E', withMarket: false });
    engine.recordBoutResult('x1', 'D');
    const dBefore = engine.rating('D');
    assert.ok(engine.rating('A').rating < 1450, 'гажиг: өвөрмонгол бөхөд унасан нь А-ийн рейтингийг бууруулсан');

    an.backfillPredictive(engine);
    for (const id of ['A', 'B', 'C']) {
      const r = engine.rating(id);
      assert.ok(Math.abs(r.rating - an.elo.get(id)!) < 1e-9, `${id}: рейтинг архивынхаар`);
      assert.ok(Math.abs(r.fast! - an.fast.get(id)!) < 1e-9, `${id}: хурдан рейтинг архивынхаар`);
      assert.equal(r.games, an.games.get(id));
    }
    assert.ok(engine.rating('A').rating > 1300, 'А архивт хоёр давсан — өвөрмонгол бөхийн уналт тооцогдоогүй');
    assert.deepEqual(engine.rating('D'), dBefore, 'архивт байхгүй барилдаантай бөхийн рейтинг хэвээр');
    assert.equal(an.backfillPredictive(engine), 0, 'идемпотент');
    // Архиваас хойш шинэ барилдаан орвол тэр бөхчүүдийг хөндөхгүй
    engine.createBout({ id: 'x2', tournamentId: 'local', round: 1, aId: 'A', bId: 'D', withMarket: false });
    engine.recordBoutResult('x2', 'D');
    const aAfter = engine.rating('A');
    assert.equal(an.backfillPredictive(engine), 0);
    assert.deepEqual(engine.rating('A'), aAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
