/**
 * Таамгийн калибровкийн тохируулга — архив дээр, сүлжээгүй.
 *
 *   npm run calib   (= node scripts/calib-tune.ts [--train-end 2023-12-31])
 *
 * Асуулт: Elo-гийн 400-ын хуваарь (P = 1/(1+10^(Δ/400))) бодит давалттай хэр нийцэж
 * байна вэ, хурцалбал (α < 400) сайжрах уу, туршлагаас хамааруулбал?
 *
 * Арга: барилдаануудыг он цагаар нэг удаа гүйж, барилдаан бүрийн ӨМНӨХ төлөвөөс
 * (рейтинг, хоёр бөхийн туршлага = өмнөх барилдааны тоо, сүүлд барилдснаас хойшх
 * хоног) бичлэг үүсгэнэ — ирээдүйн мэдээлэл орох боломжгүй. Рейтингийн ШИНЭЧЛЭЛ
 * хэвээр (K=32, 400) — devjee масштаб өөрчлөгдөхгүй; зөвхөн ТААМГИЙН хуваарийг тохируулна.
 *
 * Загварууд:
 *   M0  α=400 (одоогийнх)
 *   M1  α тогтмол — сургалтын log-loss-оор алтан огтлолцолоор
 *   M2  α туршлагаас: α(g) = A + B·min(g,C)/C, g = хоёулангийн бага туршлага
 *   M3  logistic (Δr, туршлагын зөрүү, амралтын зөрүү, шинэ-бөхийн интеракц) — судалгаанд
 *   M3b M3 + талын intercept (w1 = дэвжээний дээд тал) — зөвхөн ОНООЛТЫН мэдээлэл хэр
 *       их болохыг хэмжинэ; аппад ашиглахгүй (гараар үүсгэсэн барилдаанд тал утгагүй)
 */

import { table } from '../src/format.ts';
import { loadArchive, type ArchiveBout } from '../src/graph.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const TRAIN_END = opt('train-end', '2023-12-31');
const SEED = 1300; // = ARCHIVE_ELO_SEED (server/analytics.ts) — devjee-тэй ижил масштаб
const K = 32;
const LN10 = Math.LN10;
const DAY = 86_400_000;
const BARILGA_TID = '4rexqpGpslt2FUPvonkA';

interface Row {
  date: string;
  tid: string;
  dr: number; // r1 − r2 (өмнөх)
  g1: number; // w1-ийн өмнөх барилдааны тоо
  g2: number;
  d1: number; // w1 сүүлд барилдснаас хойшх хоног (дебютэд 9999)
  d2: number;
  won1: boolean;
}

// ── 1. Он цагийн гүйлт — бичлэг үүсгэх ──
const t0 = performance.now();
const archive = loadArchive();
const clean: ArchiveBout[] = archive.bouts
  .filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 !== b.w2 && !b.noShow)
  .sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);

const rating = new Map<string, number>();
const games = new Map<string, number>();
const last = new Map<string, number>();
const rows: Row[] = [];
for (const b of clean) {
  const r1 = rating.get(b.w1) ?? SEED;
  const r2 = rating.get(b.w2) ?? SEED;
  const t = Date.parse(b.date);
  const g1 = games.get(b.w1) ?? 0;
  const g2 = games.get(b.w2) ?? 0;
  const d1 = last.has(b.w1) ? Math.min(9999, Math.round((t - last.get(b.w1)!) / DAY)) : 9999;
  const d2 = last.has(b.w2) ? Math.min(9999, Math.round((t - last.get(b.w2)!) / DAY)) : 9999;
  rows.push({ date: b.date, tid: b.tid, dr: r1 - r2, g1, g2, d1, d2, won1: b.winner === 1 });
  // Шинэчлэл — үргэлж 400 (devjee масштаб хэвээр)
  const e1 = 1 / (1 + Math.pow(10, (r2 - r1) / 400));
  const delta = K * ((b.winner === 1 ? 1 : 0) - e1);
  rating.set(b.w1, r1 + delta);
  rating.set(b.w2, r2 - delta);
  games.set(b.w1, g1 + 1);
  games.set(b.w2, g2 + 1);
  last.set(b.w1, t);
  last.set(b.w2, t);
}
const train = rows.filter((r) => r.date <= TRAIN_END);
const testYears = ['2024', '2025', '2026'];
const tests = new Map(testYears.map((y) => [y, rows.filter((r) => r.date.startsWith(y))]));
const barilga = rows.filter((r) => r.tid === BARILGA_TID);
const pooled = rows.filter((r) => r.date > TRAIN_END);
console.log(`Архив ${clean.length} барилдаан · сургалт ${train.length} (≤ ${TRAIN_END}) · шалгалт ${pooled.length}${testYears.map((y) => ` · ${y}: ${tests.get(y)!.length}`).join('')} · Барилга-100: ${barilga.length}`);

// ── 2. Хэмжүүр ──
const clamp = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
const logLoss = (rs: Row[], f: (r: Row) => number): number => {
  let s = 0;
  for (const r of rs) {
    const p = clamp(f(r));
    s -= r.won1 ? Math.log(p) : Math.log(1 - p);
  }
  return s / rs.length;
};

// ── 3. Загварууд ──
const pAlpha = (alpha: number) => (r: Row) => 1 / (1 + Math.exp((-r.dr / alpha) * LN10));

// M1: алтан огтлолцол
function golden(f: (x: number) => number, lo: number, hi: number, iters = 40): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}
const alpha1 = golden((x) => logLoss(train, pAlpha(x)), 150, 800);

// M2: α(g) = A + B·min(g,C)/C — бүдүүн тор + нарийвчлал
const pExp = (A: number, B: number, C: number) => (r: Row) => {
  const g = Math.min(r.g1, r.g2, C);
  const alpha = A + (B * g) / C;
  return 1 / (1 + Math.exp((-r.dr / alpha) * LN10));
};
let best2 = { A: 400, B: 0, C: 20, ll: Infinity };
for (const C of [5, 10, 20, 40, 80]) {
  for (let A = 200; A <= 420; A += 20) {
    for (let B = -100; B <= 300; B += 25) {
      if (A + B < 150) continue;
      const ll = logLoss(train, pExp(A, B, C));
      if (ll < best2.ll) best2 = { A, B, C, ll };
    }
  }
}
// нарийвчлал A, B (C тогтмол)
for (let A = best2.A - 18; A <= best2.A + 18; A += 6) {
  for (let B = best2.B - 20; B <= best2.B + 20; B += 5) {
    if (A + B < 150) continue;
    const ll = logLoss(train, pExp(A, B, best2.C));
    if (ll < best2.ll) best2 = { A, B, C: best2.C, ll };
  }
}

// M3: logistic — Δr/400, туршлагын лог-харьцаа, амралтын лог-харьцаа (+ M3-4f: шинэ-бөхийн интеракц)
const feats3 = (r: Row): number[] => [
  r.dr / 400,
  Math.log((1 + r.g1) / (1 + r.g2)),
  Math.log((1 + Math.min(r.d1, 1095)) / (1 + Math.min(r.d2, 1095))),
];
const feats = (r: Row): number[] => {
  const novice = 1 / Math.log2(4 + Math.min(r.g1, r.g2));
  return [...feats3(r), (r.dr / 400) * novice];
};
function fitLogistic(rs: Row[], withIntercept: boolean, fx: (r: Row) => number[] = feats): number[] {
  const X = rs.map(fx);
  const y = rs.map((r) => (r.won1 ? 1 : 0));
  const dim = X[0]!.length + (withIntercept ? 1 : 0);
  const w = new Array(dim).fill(0);
  w[0] = LN10; // эхлэл ≈ одоогийн загвар
  const lr = 0.5;
  for (let it = 0; it < 400; it++) {
    const grad = new Array(dim).fill(0);
    for (let i = 0; i < X.length; i++) {
      let z = 0;
      for (let j = 0; j < X[i]!.length; j++) z += w[j]! * X[i]![j]!;
      if (withIntercept) z += w[dim - 1]!;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i]!;
      for (let j = 0; j < X[i]!.length; j++) grad[j] += err * X[i]![j]!;
      if (withIntercept) grad[dim - 1] += err;
    }
    for (let j = 0; j < dim; j++) w[j] -= (lr * grad[j]!) / X.length;
  }
  return w;
}
const pLogistic = (w: number[], withIntercept: boolean, fx: (r: Row) => number[] = feats) => (r: Row) => {
  const x = fx(r);
  let z = 0;
  for (let j = 0; j < x.length; j++) z += w[j]! * x[j]!;
  if (withIntercept) z += w[w.length - 1]!;
  return 1 / (1 + Math.exp(-z));
};
const w3 = fitLogistic(train, false);
const w3b = fitLogistic(train, true);
const w3c = fitLogistic(train, false, feats3);

// ── 4. Тайлан ──
const models: [string, (r: Row) => number][] = [
  ['M0 α=400 (одоогийнх)', pAlpha(400)],
  [`M1 α=${alpha1.toFixed(0)}`, pAlpha(alpha1)],
  [`M2 α(g)=${best2.A}+${best2.B}·min(g,${best2.C})/${best2.C}`, pExp(best2.A, best2.B, best2.C)],
  ['M3 logistic (Δr, туршлага, амралт, шинэ)', pLogistic(w3, false)],
  ['M3c logistic (Δr, туршлага, амралт)', pLogistic(w3c, false, feats3)],
  ['M3b + талын intercept (зөвхөн хэмжилт)', pLogistic(w3b, true)],
];
const cols = ['Загвар', 'сургалт', ...testYears, 'OOS нийт', 'Барилга-100'];
const out: string[][] = [];
for (const [name, f] of models) {
  out.push([
    name,
    logLoss(train, f).toFixed(4),
    ...testYears.map((y) => logLoss(tests.get(y)!, f).toFixed(4)),
    logLoss(pooled, f).toFixed(4),
    logLoss(barilga, f).toFixed(4),
  ]);
}
console.log('\nLog-loss (бага нь сайн; санамсаргүй 0.6931):');
console.log(table(cols, out));
console.log(`\nM1 α* = ${alpha1.toFixed(1)} · M2 = {A:${best2.A}, B:${best2.B}, C:${best2.C}} · M3 жин = [${w3.map((x) => x.toFixed(3)).join(', ')}] · M3c жин = [${w3c.map((x) => x.toFixed(3)).join(', ')}] · M3b intercept = ${w3b[w3b.length - 1]!.toFixed(3)}`);

// Production жин: OOS-оор загвараа сонгосны ДАРАА бүх өгөгдлөөр дахин тохируулна
const wProd = fitLogistic(rows, false, feats3);
console.log(`PRODUCTION (M3c, бүх ${rows.length} барилдаанаар): [${wProd.map((x) => x.toFixed(4)).join(', ')}]`);

// Шилдэг OOS загварын калибровк (фаворитын бүсээр)
const bestModel = models
  .slice(0, 5) // M3b-г хасна (талын мэдээлэл аппад байхгүй)
  .map(([name, f]) => ({ name, f, ll: logLoss(pooled, f) }))
  .sort((a, b) => a.ll - b.ll)[0]!;
console.log(`\nШилдэг (OOS): ${bestModel.name} — калибровк OOS дээр:`);
const buckets = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.001]] as const;
const calRows: string[][] = [];
for (const [lo, hi] of buckets) {
  const g = pooled.filter((r) => {
    const p = Math.max(bestModel.f(r), 1 - bestModel.f(r));
    return p >= lo && p < hi;
  });
  const won = g.filter((r) => (bestModel.f(r) >= 0.5) === r.won1).length;
  const avg = g.length ? g.reduce((s, r) => s + Math.max(bestModel.f(r), 1 - bestModel.f(r)), 0) / g.length : 0;
  calRows.push([`${Math.round(lo * 100)}–${Math.round(Math.min(hi, 1) * 100)}%`, String(g.length), (avg * 100).toFixed(1) + '%', g.length ? ((won / g.length) * 100).toFixed(1) + '%' : '—']);
}
console.log(table(['Фаворитын таамаг', 'n', 'Дундаж таамаг', 'Бодит давалт'], calRows));
console.log(`\nНийт ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
