import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cost,
  costToBuy,
  initialQuantities,
  LmsrError,
  logSumExp,
  maxLoss,
  maxLossFromInitial,
  prices,
  sharesForSpend,
} from './lmsr.ts';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (eps ${eps})`);

test('үнэ: нийлбэр 1, тэгш хэм, магадлалтай тохирно', () => {
  const b = 1000;
  const p = prices([0, 0], b);
  close(p[0]!, 0.5);
  close(p[1]!, 0.5);

  const q = initialQuantities([0.7, 0.2, 0.1], b);
  const pr = prices(q, b);
  close(pr[0]!, 0.7);
  close(pr[1]!, 0.2);
  close(pr[2]!, 0.1);
  close(pr.reduce((a, c) => a + c, 0), 1);
});

test('initialQuantities: хэвийн болгож, 0-ийг өргөнө', () => {
  const q = initialQuantities([2, 2], 100);
  const p = prices(q, 100);
  close(p[0]!, 0.5);
  const q2 = initialQuantities([1, 0], 100);
  const p2 = prices(q2, 100);
  assert.ok(p2[1]! > 0 && p2[1]! < 1e-6);
  assert.throws(() => initialQuantities([1], 100), LmsrError);
  assert.throws(() => initialQuantities([-1, 1], 100), LmsrError);
});

test('costToBuy ба sharesForSpend хоорондоо урвуу', () => {
  const b = 500;
  const q = initialQuantities([0.6, 0.4], b);
  for (const spend of [1, 10, 100, 1000, 10_000, 1e6, 1e8]) {
    const shares = sharesForSpend(q, b, 1, spend);
    assert.ok(Number.isFinite(shares) && shares > 0, `shares finite for ${spend}`);
    const c = costToBuy(q, b, 1, shares);
    close(c, spend, Math.max(1e-6, spend * 1e-9));
    // Хувь нь зарцуулалтаас их (үнэ < 1), гэхдээ хамгийн ихдээ spend + b·ln(1/p).
    assert.ok(shares > spend, 'хувь > зарцуулалт');
    assert.ok(shares <= spend + b * Math.log(1 / 0.4) + 1e-6);
  }
});

test('өртөг нь C(q+Δ) − C(q)-тэй таарна', () => {
  const b = 300;
  const q = initialQuantities([0.3, 0.3, 0.4], b);
  const shares = 250;
  const q2 = q.slice();
  q2[2] = q2[2]! + shares;
  close(costToBuy(q, b, 2, shares), cost(q2, b) - cost(q, b), 1e-7);
  // зарах = сөрөг өртөг
  close(costToBuy(q2, b, 2, -shares), -(cost(q2, b) - cost(q, b)), 1e-7);
});

test('авсны дараа үнэ өснө; зарвал буцна', () => {
  const b = 1000;
  const q = initialQuantities([0.5, 0.5], b);
  const shares = sharesForSpend(q, b, 0, 1000);
  const q2 = q.slice();
  q2[0] = q2[0]! + shares;
  const p2 = prices(q2, b);
  // 50/50, S = b → Δ/b = ln(2e − 1) → p' = 1 − 1/(2e) ≈ 0.816
  close(p2[0]!, 1 - 1 / (2 * Math.E), 1e-9);
  const proceeds = -costToBuy(q2, b, 0, -shares);
  close(proceeds, 1000, 1e-6);
  // 275 токен → ~62%, 1000 токен b=2000-д → ~70%
  const q3 = q.slice();
  q3[0] = q3[0]! + sharesForSpend(q, b, 0, 275);
  assert.ok(Math.abs(prices(q3, b)[0]! - 0.62) < 0.005);
  const qb = initialQuantities([0.5, 0.5], 2000);
  qb[0] = qb[0]! + sharesForSpend(qb, 2000, 0, 1000);
  assert.ok(Math.abs(prices(qb, 2000)[0]! - 0.696) < 0.005);
});

test('underflow: 0 болсон үнэтэй үр дүнг авах/зарах — төгсгөлтэй', () => {
  const b = 100;
  const q = [0, -200_000]; // p_1 = e^{-2000} → double-д 0
  assert.equal(prices(q, b)[1], 0);
  const sh = sharesForSpend(q, b, 1, 50);
  assert.ok(Number.isFinite(sh) && sh > 0);
  const q2 = q.slice();
  q2[1] = q2[1]! + sh;
  const p2 = prices(q2, b);
  assert.ok(p2[1]! > 0 && p2[1]! < 1);
  const c = costToBuy(q, b, 1, sh);
  assert.ok(Math.abs(c - 50) < 1e-6, `cost ${c}`);
  assert.equal(Math.abs(costToBuy(q, b, 1, -1e6)), 0); // юу ч биш зүйлийг зарах = 0
});

test('хаусын алдагдал ≤ b·ln n (санамсаргүй арилжаа)', () => {
  const b = 200;
  const n = 5;
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const q = initialQuantities(Array(n).fill(1 / n), b);
  const start = cost(q, b);
  let cash = 0;
  const holdings = Array(n).fill(0) as number[];
  for (let t = 0; t < 2000; t++) {
    const i = Math.floor(rnd() * n);
    if (rnd() < 0.7 || holdings[i]! <= 0) {
      const spend = 1 + Math.floor(rnd() * 500);
      const sh = sharesForSpend(q, b, i, spend);
      q[i] = q[i]! + sh;
      holdings[i] = holdings[i]! + sh;
      cash += spend;
    } else {
      const sh = holdings[i]! * rnd();
      const proceeds = -costToBuy(q, b, i, -sh);
      q[i] = q[i]! - sh;
      holdings[i] = holdings[i]! - sh;
      cash -= proceeds;
    }
  }
  // Ямар ч үр дүн биелсэн ч хаусын алдагдал = payout − cash ≤ b ln n
  for (let w = 0; w < n; w++) {
    const loss = holdings[w]! - cash;
    assert.ok(loss <= maxLoss(n, b) + 1e-6, `loss ${loss} > bound ${maxLoss(n, b)}`);
  }
  // Мөн cash − (C(q) − C(q0)) = 0 (тодорхойлолтоор)
  close(cash, cost(q, b) - start, 1e-6);
});

test('maxLossFromInitial: жигд бол b·ln n, хазайсан бол b·ln(1/p_min); санамсаргүй арилжаанд биелнэ', () => {
  const b = 150;
  close(maxLossFromInitial(initialQuantities([0.25, 0.25, 0.25, 0.25], b), b), maxLoss(4, b), 1e-9);
  const q0 = initialQuantities([0.9, 0.1], b);
  close(maxLossFromInitial(q0, b), b * Math.log(10), 1e-9);
  // Хазайсан анхны магадлалтай зах зээлд санамсаргүй арилжаа хийгээд шалгана
  let seed = 99;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const q = q0.slice();
  const holdings = [0, 0];
  let cash = 0;
  for (let t = 0; t < 1000; t++) {
    const i = rnd() < 0.5 ? 0 : 1;
    const spend = 1 + Math.floor(rnd() * 300);
    const sh = sharesForSpend(q, b, i, spend);
    q[i] = q[i]! + sh;
    holdings[i] = holdings[i]! + sh;
    cash += spend;
  }
  for (let w = 0; w < 2; w++) {
    assert.ok(holdings[w]! - cash <= maxLossFromInitial(q0, b) + 1e-6);
  }
  // Гэхдээ b·ln2-оос давж БОЛНО (доод магадлалтай тал давбал)
  assert.ok(maxLossFromInitial(q0, b) > maxLoss(2, b));
});

test('64 үр дүн, хэт том/жижиг утга — NaN/Infinity гарахгүй', () => {
  const b = 50;
  const n = 64;
  const probs = Array.from({ length: n }, (_, i) => (i === 0 ? 0.5 : 0.5 / (n - 1)));
  const q = initialQuantities(probs, b);
  const p = prices(q, b);
  close(p.reduce((a, c) => a + c, 0), 1);
  const sh = sharesForSpend(q, b, 63, 1e9);
  assert.ok(Number.isFinite(sh) && sh > 0);
  const c = costToBuy(q, b, 63, sh);
  close(c, 1e9, 1e-3);
  assert.ok(Number.isFinite(costToBuy(q, b, 0, -1e6)));
  close(logSumExp([-1e6, -1e6]), -1e6 + Math.log(2));
  assert.equal(logSumExp([]), -Infinity);
});

test('буруу оролт — LmsrError', () => {
  assert.throws(() => prices([0, 0], 0), LmsrError);
  assert.throws(() => prices([0], 1), LmsrError);
  assert.throws(() => costToBuy([0, 0], 1, 2, 1), LmsrError);
  assert.throws(() => sharesForSpend([0, 0], 1, 0, 0), LmsrError);
  assert.throws(() => sharesForSpend([0, 0], 1, 0, -5), LmsrError);
  assert.throws(() => maxLoss(1, 10), LmsrError);
  assert.throws(() => prices([NaN, 0], 10), LmsrError);
});
