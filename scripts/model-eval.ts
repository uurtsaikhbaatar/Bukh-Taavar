/**
 * Загваруудын backtest — архив дээр (сүлжээгүй).
 *
 *   npm run eval -- [--split 2026-01-01] [--sample 400] [--hops 10] [--beta 0.5] [--halflife 4]
 *
 * Сургалт: split-ээс өмнөх барилдаан; шалгалт: split-ээс хойших (хоёул өмнө нь барилдаж байсан бөх).
 *   - Цолын суурь (зөвхөн цол)                — суурь харьцуулалт
 *   - Elo replay (K=32, цолын суурь, онлайн)  — devjee-ийн Elo-г дахин бүтээсэн
 *   - Bradley–Terry (split хүртэл, статик)
 *   - Давамгайллын гинж (K үе, sample дээр — удаан)
 * Хэмжүүр: log-loss (санамсаргүй 0.693), Brier, калибровк. Мөн BT-ийн топ-20 (нүүр царай).
 */

import { fmtPct, table } from '../src/format.ts';
import { BoutGraph, eloReplay, loadArchive, seedFromArchive } from '../src/graph.ts';
import { titleLabel, winProbability } from '../src/rating.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const SPLIT = opt('split', '2026-01-01');
const SAMPLE = Number(opt('sample', '400'));
const HOPS = Number(opt('hops', '10'));
const BETA = Number(opt('beta', '0.5'));
const HALFLIFE = Number(opt('halflife', '4'));

const t0 = performance.now();
const archive = loadArchive();
const seed = seedFromArchive(archive.wrestlers);
const clean = archive.bouts.filter((b) => !b.noShow && b.w1 !== b.w2);
const train = clean.filter((b) => b.date < SPLIT);
const seen = new Set<string>();
for (const b of train) {
  seen.add(b.w1);
  seen.add(b.w2);
}
const test = clean.filter((b) => b.date >= SPLIT && seen.has(b.w1) && seen.has(b.w2)).sort((a, b) => a.date.localeCompare(b.date));
console.log(`Архив ${archive.bouts.length} · сургалт ${train.length} (< ${SPLIT}) · шалгалт ${test.length} (хоёул мэдэгдэх бөх)`);

interface Pred {
  p1: number;
  won1: boolean;
}
const metrics = (preds: Pred[]) => {
  let ll = 0;
  let brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, o: 0 }));
  for (const { p1, won1 } of preds) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, p1));
    ll -= won1 ? Math.log(p) : Math.log(1 - p);
    brier += (p - (won1 ? 1 : 0)) ** 2;
    const b = bins[Math.min(9, Math.floor(p * 10))]!;
    b.n += 1;
    b.p += p;
    b.o += won1 ? 1 : 0;
  }
  return { n: preds.length, logloss: ll / preds.length, brier: brier / preds.length, bins };
};

// 1. Цолын суурь
const seedPreds: Pred[] = test.map((b) => ({ p1: winProbability(seed(b.w1), seed(b.w2)), won1: b.winner === 1 }));

// 2. Elo replay (онлайн — шалгалтын үед ч шинэчлэгдэнэ, гэхдээ барилдааны ӨМНӨХ рейтингээр таамаглана)
const rep = eloReplay(clean, { seed });
const eloPreds: Pred[] = rep.predictions.filter((p) => p.date >= SPLIT).map((p) => ({ p1: p.p1, won1: p.won1 }));

// 3. Bradley–Terry (статик, split хүртэл)
const g = new BoutGraph(clean, { asOf: SPLIT, halfLifeYears: HALFLIFE });
const btT = performance.now();
g.bradleyTerry();
const btPreds: Pred[] = [];
for (const b of test) {
  const p = g.btProbability(b.w1, b.w2);
  if (p !== undefined) btPreds.push({ p1: p, won1: b.winner === 1 });
}
const btSec = (performance.now() - btT) / 1000;

// 4. Гинж (sample)
let s = 12345;
const rnd = () => {
  s = (s * 1664525 + 1013904223) % 4294967296;
  return s / 4294967296;
};
const sample = [...test].sort(() => rnd() - 0.5).slice(0, SAMPLE);
const chT = performance.now();
const chainPreds: Pred[] = [];
let unconnected = 0;
for (const b of sample) {
  const c = g.chain(b.w1, b.w2, { maxHops: HOPS, beta: BETA, topPaths: 0 });
  if (!c.connected) unconnected += 1;
  chainPreds.push({ p1: c.pA, won1: b.winner === 1 });
}
const chSec = (performance.now() - chT) / 1000;
// Ижил sample дээр бусад загварууд (шударга харьцуулалт)
const idx = new Map(test.map((b, i) => [b.mid + b.tid, i]));
const sampleIdx = new Set(sample.map((b) => idx.get(b.mid + b.tid)!));
const onSample = (preds: Pred[]) => preds.filter((_, i) => sampleIdx.has(i));

const rows: (string | number)[][] = [];
const add = (name: string, m: ReturnType<typeof metrics>) => rows.push([name, String(m.n), m.logloss.toFixed(4), m.brier.toFixed(4)]);
add('Цолын суурь', metrics(seedPreds));
add('Elo replay (K=32)', metrics(eloPreds));
add(`Bradley–Terry (½ ${HALFLIFE}ж)`, metrics(btPreds));
console.log('\nБүх шалгалтын барилдаан:');
console.log(table(['Загвар', 'n', 'log-loss', 'Brier'], rows));

const rows2: (string | number)[][] = [];
const eloOnSample = eloPreds.length === test.length ? onSample(eloPreds) : [];
rows2.push(['Цолын суурь', String(onSample(seedPreds).length), metrics(onSample(seedPreds)).logloss.toFixed(4), metrics(onSample(seedPreds)).brier.toFixed(4)]);
if (eloOnSample.length) rows2.push(['Elo replay', String(eloOnSample.length), metrics(eloOnSample).logloss.toFixed(4), metrics(eloOnSample).brier.toFixed(4)]);
if (btPreds.length === test.length) rows2.push(['Bradley–Terry', String(onSample(btPreds).length), metrics(onSample(btPreds)).logloss.toFixed(4), metrics(onSample(btPreds)).brier.toFixed(4)]);
rows2.push([`Гинж (${HOPS} үе, β=${BETA})`, String(chainPreds.length), metrics(chainPreds).logloss.toFixed(4), metrics(chainPreds).brier.toFixed(4)]);
console.log(`\nSample ${sample.length} барилдаан (гинж ${chSec.toFixed(0)} сек, холбоогүй ${unconnected}):`);
console.log(table(['Загвар', 'n', 'log-loss', 'Brier'], rows2));

const cal = metrics(btPreds);
console.log('\nBradley–Terry калибровк:');
console.log(table(['Таамаг', 'n', 'Дундаж', 'Бодит'], cal.bins.map((b, i) => [`${i * 10}–${i * 10 + 9}%`, String(b.n), b.n ? fmtPct(b.p / b.n, 1) : '—', b.n ? fmtPct(b.o / b.n, 1) : '—'])));

// Топ-20 BT (сүүлийн 2 жилд барилдсан)
const recent = new Set<string>();
for (const b of clean) if (b.date >= '2025-01-01') recent.add(b.w1), recent.add(b.w2);
const top = g.ids
  .filter((id) => recent.has(id))
  .map((id) => ({ id, elo: g.btElo(id)!, rec: g.record(id) }))
  .filter((x) => x.rec.bouts >= 20)
  .sort((a, b) => b.elo - a.elo)
  .slice(0, 20);
console.log(`\nBradley–Terry топ-20 (2025-оос хойш идэвхтэй, ≥20 барилдаан), Elo масштаб; BT ${btSec.toFixed(1)} сек:`);
console.log(
  table(
    ['#', 'Бөх', 'Цол', 'Аймаг', 'BT-Elo', 'Elo replay', 'Давалт–алдагдал'],
    top.map((x, i) => {
      const w = archive.wrestlers[x.id];
      return [String(i + 1), w?.name ?? x.id, w ? titleLabel(w.title) : '', w?.aimag ?? '', String(Math.round(x.elo)), String(Math.round(rep.ratings.get(x.id) ?? 0)), `${x.rec.wins}–${x.rec.losses}`];
    }),
  ),
);
console.log(`\nНийт ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
