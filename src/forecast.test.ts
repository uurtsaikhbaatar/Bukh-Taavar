import { test } from 'node:test';
import assert from 'node:assert/strict';

import { championTop, forecastTournament, matchupProbs, probChampion, probOver } from './forecast.ts';

const close = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`);

test('тэнцүү 4 бөх, 2 даваа: аварга ≈ 25%, тархалт нийлбэр 1, EV ≈ 0.75', () => {
  const f = forecastTournament({ entrants: ['A', 'B', 'C', 'D'].map((id) => ({ id, rating: 1800 })), rounds: 2, sims: 4000, seed: 1 });
  for (const id of ['A', 'B', 'C', 'D']) {
    const d = f.winsDist.get(id)!;
    close(d.reduce((s, x) => s + x, 0), 1, 1e-9);
    close(probChampion(f, id), 0.25, 0.03);
    close(f.expectedWins.get(id)!, 0.75, 0.05);
    close(probOver(f, id, 0.5), 0.5, 0.03);
  }
  const [pa, pb, eq] = matchupProbs(f, 'A', 'B');
  close(pa + pb + eq, 1, 1e-9);
  close(pa, pb, 0.04);
  const top = championTop(f, 2);
  assert.equal(top.ids.length, 2);
  close(top.probs[0]! + top.probs[1]! + top.other, 1, 1e-9);
});

test('хүчтэй бөх аварга болох магадлал өндөр; сондгой тоонд гоц', () => {
  const entrants = [{ id: 'S', rating: 2600 }, ...['a', 'b', 'c', 'd'].map((id) => ({ id, rating: 1600 }))];
  const f = forecastTournament({ entrants, rounds: 3, sims: 2000, seed: 2 });
  assert.ok(probChampion(f, 'S') > 0.85, `${probChampion(f, 'S')}`);
  assert.ok(f.expectedWins.get('S')! > 2.7);
  // 5 бөх → 1-р даваанд нэг нь гоц; хэн ч 3-аас олон давахгүй
  for (const id of f.ids) assert.equal(f.winsDist.get(id)!.length, 4);
});

test('мэдэгдсэн үр дүн: унасан бөх тогтмол, давагч цааш; дараагийн давааны бичлэг өмнөх давааг батална', () => {
  const entrants = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => ({ id, rating: 1800 }));
  const f = forecastTournament({
    entrants,
    rounds: 3,
    sims: 1000,
    seed: 3,
    known: [
      { round: 1, aId: 'A', bId: 'B', winnerId: 'A' },
      // C 2-р даваанд D-г давсан гэж бичигдсэн (1-р давааны бичлэг алга) → C, D хоёул 1-р даваа давсан
      { round: 2, aId: 'C', bId: 'D', winnerId: 'C' },
    ],
  });
  assert.deepEqual(f.winsDist.get('B'), [1, 0, 0, 0]);
  assert.equal(f.eliminated.get('B'), 0);
  assert.equal(f.eliminated.get('D'), 1);
  close(probOver(f, 'A', 0.5), 1, 1e-9);
  close(probOver(f, 'C', 1.5), 1, 1e-9);
  assert.deepEqual(f.winsDist.get('D'), [0, 1, 0, 0]);
  // C ба A хоёул амьд; матчап тэнцүү биш байх магадлалтай
  const [pa, pc, eq] = matchupProbs(f, 'A', 'C');
  close(pa + pc + eq, 1, 1e-9);
  assert.ok(pc > pa, 'C аль хэдийн 2 давсан тул A-аас илүү холд явна');
  // Танигдаагүй id
  assert.deepEqual(matchupProbs(f, 'A', 'ZZ'), [1 / 3, 1 / 3, 1 / 3]);
  assert.equal(probChampion(f, 'ZZ'), 0);
  assert.equal(probOver(f, 'ZZ', 0.5), 0.5);
});

test('мэдэгдсэн үр дүнтэй ч аваргын магадлалын нийлбэр 1 (хий гоц үүсэхгүй)', () => {
  const ids = Array.from({ length: 16 }, (_, i) => `w${i}`);
  const f = forecastTournament({
    entrants: ids.map((id, i) => ({ id, rating: 1700 + (i % 4) * 30 })),
    rounds: 4,
    sims: 800,
    seed: 5,
    known: [
      { round: 1, aId: 'w0', bId: 'w5', winnerId: 'w0' },
      { round: 2, aId: 'w0', bId: 'w6', winnerId: 'w0' }, // w6-ийн 1-р давааны бичлэг алга
    ],
  });
  let sum = 0;
  for (const id of ids) sum += probChampion(f, id);
  close(sum, 1, 1e-9);
  // Симуляци бүрд яг нэг аварга
  const n = ids.length;
  for (let s = 0; s < f.sims; s++) {
    let champs = 0;
    for (let i = 0; i < n; i++) if (f.simWins[s * n + i] === 4) champs += 1;
    assert.equal(champs, 1);
  }
  assert.equal(f.eliminated.get('w5'), 0);
  assert.equal(f.eliminated.get('w6'), 1);
  close(probOver(f, 'w0', 1.5), 1, 1e-9);
});
