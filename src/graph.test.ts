import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BoutGraph, boutCounts, eloReplay, findWrestlers, seedFromArchive, type Archive, type ArchiveBout } from './graph.ts';

const bout = (w1: string, w2: string, winner: 1 | 2, date: string, extra: Partial<ArchiveBout> = {}): ArchiveBout => ({
  tid: 't',
  date,
  round: 1,
  w1,
  w2,
  winner,
  mid: `${w1}-${w2}-${date}`,
  ...extra,
});

/** Гинж: A давсан B, B давсан C, C давсан D. A ба D шууд барилдаагүй. E тусдаа. */
const chainBouts: ArchiveBout[] = [
  bout('A', 'B', 1, '2025-07-11'),
  bout('B', 'C', 1, '2025-07-11'),
  bout('C', 'D', 1, '2025-07-11'),
  bout('E', 'F', 1, '2025-07-11'),
];

test('headToHead ба record', () => {
  const g = new BoutGraph([bout('A', 'B', 1, '2024-01-01'), bout('B', 'A', 1, '2025-01-01'), bout('A', 'B', 1, '2026-01-01'), bout('A', 'C', 2, '2026-02-01', { noShow: true })]);
  const h = g.headToHead('A', 'B');
  assert.equal(h.aWins, 2);
  assert.equal(h.bWins, 1);
  assert.equal(h.bouts[0]!.date, '2026-01-01', 'шинэ нь эхэнд');
  assert.deepEqual(g.record('A'), { wins: 2, losses: 1, bouts: 3 }, 'гоц барилдаан хасагдсан');
  const g2 = new BoutGraph(g.bouts.concat([bout('A', 'C', 2, '2026-02-01', { noShow: true })]), { excludeNoShow: false });
  assert.equal(g2.record('A').losses, 2);
});

test('давамгайллын гинж: A→B→C→D — A давна; эсрэг чиглэл 0; холбоогүй → 0.5', () => {
  const g = new BoutGraph(chainBouts, { halfLifeYears: 0 });
  const r = g.chain('A', 'D', { maxHops: 10, beta: 0.5 });
  assert.ok(r.connected);
  assert.equal(r.pA, 1, 'D-ээс A руу зам байхгүй → 100%');
  assert.equal(r.perHop[2]!.k, 3);
  assert.ok(r.perHop[2]!.ab > 0 && r.perHop[0]!.ab === 0 && r.perHop[1]!.ab === 0, '3 үеийн дараа л хүрнэ');
  assert.deepEqual(r.topPathsAB[0]!.nodes, ['A', 'B', 'C', 'D']);
  assert.equal(r.topPathsAB[0]!.dates.length, 3);
  assert.equal(r.topPathsBA.length, 0);
  // Холбоогүй
  const u = g.chain('A', 'E');
  assert.equal(u.connected, false);
  assert.equal(u.pA, 0.5);
  // Үеийн хязгаар: 2 үеэр D-д хүрэхгүй
  assert.equal(g.chain('A', 'D', { maxHops: 2 }).connected, false);
  // Байхгүй бөх
  assert.equal(g.chain('A', 'ZZ').pA, 0.5);
});

test('гинж: β бууруулалт, шууд барилдаан давуу, тэгш хэм', () => {
  // A B-г шууд давсан; B нь A-г давсан хүнийг (C) давсан → 2 үеэр буцаж ирнэ
  const g = new BoutGraph([bout('A', 'B', 1, '2025-01-01'), bout('C', 'A', 1, '2025-01-01'), bout('B', 'C', 1, '2025-01-01')], { halfLifeYears: 0 });
  const r = g.chain('A', 'B', { maxHops: 10, beta: 0.5 });
  assert.ok(r.pA > 0.5, `шууд ялалт давуу: ${r.pA}`);
  assert.ok(r.pA < 1, 'B→C→A гинж эсрэг нотолгоо');
  const r2 = g.chain('B', 'A');
  assert.ok(Math.abs(r.pA + r2.pA - 1) < 1e-9, 'тэгш хэм');
  // β=0 → зөвхөн шууд
  const r0 = g.chain('A', 'B', { beta: 0 });
  assert.equal(r0.pA, 1);
});

test('Bradley–Terry: гинжийн дарааллыг сэргээнэ, магадлал тэгш хэмтэй, Elo масштаб', () => {
  const many: ArchiveBout[] = [];
  for (let i = 0; i < 4; i++) many.push(...chainBouts.map((b) => ({ ...b, mid: `${b.mid}-${i}` })));
  const g = new BoutGraph(many, { halfLifeYears: 0 });
  const s = (id: string) => g.btStrength(id)!;
  assert.ok(s('A') > s('B') && s('B') > s('C') && s('C') > s('D'), `${s('A')} ${s('B')} ${s('C')} ${s('D')}`);
  const p = g.btProbability('A', 'D')!;
  assert.ok(p > 0.8 && p < 1);
  assert.ok(Math.abs(g.btProbability('D', 'A')! + p - 1) < 1e-12);
  assert.equal(g.btProbability('A', 'ZZ'), undefined);
  assert.ok(g.btElo('A')! > g.btElo('D')!);
  // Тусдаа бүрэлдэхүүн (E, F) ч тодорхойлогдоно (anchor)
  assert.ok(Number.isFinite(s('E')) && s('E') > s('F'));
});

test('eloReplay: K=32, цолын суурь, asOf', () => {
  const bouts = [bout('A', 'B', 1, '2025-01-01'), bout('A', 'B', 1, '2025-02-01'), bout('A', 'B', 2, '2026-01-01')];
  const r = eloReplay(bouts, { seed: () => 1500 });
  assert.equal(r.predictions.length, 3);
  assert.ok(Math.abs(r.predictions[0]!.p1 - 0.5) < 1e-9);
  assert.ok(r.predictions[1]!.p1 > 0.5);
  assert.ok(r.ratings.get('A')! + r.ratings.get('B')! - 3000 < 1e-9);
  const r2 = eloReplay(bouts, { seed: () => 1500, asOf: '2026-01-01' });
  assert.equal(r2.predictions.length, 2);
  const archive: Archive = {
    wrestlers: { A: { name: 'А.Бөх', title: 'даян_аварга', titleCode: 20, aimagCode: 1, devjeeId: 'A' }, B: { name: 'Б.Бөх', title: 'сумын_заан', titleCode: 4, aimagCode: 1, devjeeId: 'B' } },
    bouts,
    tournaments: new Map(),
  };
  const seed = seedFromArchive(archive.wrestlers);
  assert.equal(seed('A'), 2300);
  assert.equal(seed('B'), 1650);
  assert.equal(seed('none'), 1500);
});

test('findWrestlers: нэр, овгийн үсэг, бүтэн нэр, эрэмбэ', () => {
  const archive: Archive = {
    wrestlers: {
      w1: { name: 'Б.Орхонбаяр', fullName: 'Баярсайханы Орхонбаяр', title: 'даян_аварга', titleCode: 20, aimagCode: 16, devjeeId: 'w1' },
      w2: { name: 'Д.Орхонбаяр', fullName: 'Доржийн Орхонбаяр', title: 'сумын_заан', titleCode: 4, aimagCode: 1, devjeeId: 'w2' },
      w3: { name: 'Э.Батмагнай', fullName: 'Энхбаярын Батмагнай', title: 'улсын_арслан', titleCode: 17, aimagCode: 3, devjeeId: 'w3' },
    },
    bouts: [bout('w1', 'w3', 1, '2026-07-10'), bout('w1', 'w2', 1, '2025-01-01')],
    tournaments: new Map(),
  };
  const counts = boutCounts(archive.bouts);
  const r = findWrestlers(archive, 'Орхонбаяр', counts);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.id, 'w1', 'цол өндөр, барилдаан олон нь эхэнд');
  assert.equal(findWrestlers(archive, 'Б.Орхонбаяр', counts)[0]!.id, 'w1');
  assert.equal(findWrestlers(archive, 'баярсайханы орхонбаяр', counts)[0]!.id, 'w1');
  assert.equal(findWrestlers(archive, 'батм', counts)[0]!.id, 'w3');
  assert.equal(findWrestlers(archive, 'байхгүй', counts).length, 0);
  assert.equal(counts.get('w1'), 2);
});
