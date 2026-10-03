/**
 * Таамгийн загварын судалгаа — архив дээр, сүлжээгүй, look-ahead-гүй.
 *
 *   npm run research   (= node scripts/model-research.ts)
 *
 * Барилдаануудыг он цагаар нэг удаа гүйж, барилдаан бүрийн ӨМНӨХ төлөвөөс шинж
 * (feature) бичнэ — ирээдүйн мэдээлэл орох боломжгүй. Дараа нь logistic загваруудыг
 * «өнгөрсөн бүх он → дараагийн он» (rolling origin) байдлаар 2023/2024/2025/2026 дээр
 * шалгаж, суурь загвартай (production: Δr + туршлага + амралт) харьцуулна.
 *
 * Шалгах таамаглалууд:
 *   side   w1 тал (devjee: w1 ≈ зэрэг дэвээр дээгүүр бөх) — тогтмол давуу тал
 *   kind   хосолгооны төрөл (o/a/t/b/s) тус бүрийн талын давуу тал
 *   ord    тэмцээний зэрэг дэвийн лог-харьцаа ln(order1/order2)
 *   ttl    тухайн үеийн цолын зөрүү (цолын түүхээс, барилдааны өмнөх)
 *   round  Δr-ийн налуу 1-р даваанд / 4+ даваанд өөр эсэх
 *   age    нас (шугаман + 27 насны оргилоос зөрөх квадрат)
 *   home   нутгийн (аймгийн) давуу тал
 *   h2h    хоорондын өмнөх барилдааны лог-харьцаа
 *   form   «хурдан» Elo (K=64) − «удаан» Elo (K=32) — сүүлийн үеийн хэлбэр
 *   big    улсын наадамд Δr-ийн налуу өөр эсэх
 *   K      Elo-гийн K (16/24/40/48) — зөвхөн таамгийн рейтингт
 */

import { table } from '../src/format.ts';
import { loadArchive } from '../src/graph.ts';
import { TITLES, type Title } from '../src/rating.ts';

const t0 = performance.now();
const SEED = 1300;
const DAY = 86_400_000;
const BARILGA = '4rexqpGpslt2FUPvonkA';
const NAMAR = 'KmiT1QkKINXdYv9qDNTf';

const archive = loadArchive();
const clean = archive.bouts
  .filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 !== b.w2 && !b.noShow)
  .sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
const N = clean.length;

// ── Туслах: цол (түүхээс), нас ──
const seedOf = new Map<Title, number>(TITLES.map((t) => [t.key, t.seed]));
const NONE_SEED = seedOf.get('цолгүй')!;
const titleHist = new Map<string, { t: number; seed: number }[]>();
for (const [wid, w] of Object.entries(archive.wrestlers)) {
  if (!w.titles?.length) continue;
  titleHist.set(wid, w.titles.map((x) => ({ t: Date.parse(x.date), seed: seedOf.get(x.title) ?? NONE_SEED })).sort((a, b) => a.t - b.t));
}
const titleSeedAt = (wid: string, t: number): number => {
  const h = titleHist.get(wid);
  if (!h) return NONE_SEED;
  let best = NONE_SEED;
  for (const x of h) {
    if (x.t >= t) break; // тухайн тэмцээнд авсан цолыг оруулахгүй
    best = Math.max(best, x.seed);
  }
  return best;
};
const birth = new Map<string, number>();
for (const [wid, w] of Object.entries(archive.wrestlers)) {
  if (!w.birthDate || w.birthDate.startsWith('1900-01-01')) continue;
  const t = Date.parse(w.birthDate);
  if (Number.isFinite(t)) birth.set(wid, t);
}
const ageAt = (wid: string, t: number): number | undefined => {
  const b = birth.get(wid);
  if (b === undefined) return undefined;
  const age = (t - b) / (365.25 * DAY);
  return age >= 14 && age <= 65 ? age : undefined;
};

// ── Шинжүүд ──
const NAMES = [
  'dr32', 'exp', 'rest', 'side', 'kO', 'kA', 'kT', 'kB', 'kS', 'ord', 'ttl', 'drR1', 'drLate',
  'ageLin', 'ageQ', 'home', 'h2h', 'form', 'drBig', 'dr16', 'dr24', 'dr40', 'dr48',
  'dr64', 'dr80', 'dr96', 'dr128', 'r1F', 'lateF', 'bigF',
] as const;
type FName = (typeof NAMES)[number];
const F: Record<FName, Float64Array> = Object.fromEntries(NAMES.map((n) => [n, new Float64Array(N)])) as Record<FName, Float64Array>;
const Y = new Float64Array(N);
const YEAR = new Int16Array(N);
const TID: string[] = new Array(N);
const ROUND = new Int16Array(N);

const KS = [16, 24, 32, 40, 48, 64, 80, 96, 128] as const;
const elo = new Map<number, Map<string, number>>(KS.map((k) => [k, new Map()]));
const games = new Map<string, number>();
const last = new Map<string, number>();
const h2h = new Map<string, [number, number]>();
const coverage = { ord: 0, ttl: 0, age: 0, home: 0, h2h: 0 };

for (let i = 0; i < N; i++) {
  const b = clean[i]!;
  const t = Date.parse(b.date);
  const T = archive.tournaments.get(b.tid);
  const r = (k: number, w: string) => elo.get(k)!.get(w) ?? SEED;
  const dr = (k: number) => (r(k, b.w1) - r(k, b.w2)) / 400;
  const g1 = games.get(b.w1) ?? 0;
  const g2 = games.get(b.w2) ?? 0;
  const d1 = last.has(b.w1) ? Math.min(1095, (t - last.get(b.w1)!) / DAY) : 1095;
  const d2 = last.has(b.w2) ? Math.min(1095, (t - last.get(b.w2)!) / DAY) : 1095;

  F.dr32[i] = dr(32);
  F.exp[i] = Math.log((1 + g1) / (1 + g2));
  F.rest[i] = Math.log((1 + d1) / (1 + d2));
  F.side[i] = 1;
  F.kO[i] = b.kind === 'o' ? 1 : 0;
  F.kA[i] = b.kind === 'a' ? 1 : 0;
  F.kT[i] = b.kind === 't' ? 1 : 0;
  F.kB[i] = b.kind === 'b' ? 1 : 0;
  F.kS[i] = b.kind === 's' ? 1 : 0;
  const o1 = T?.order[b.w1];
  const o2 = T?.order[b.w2];
  if (o1 && o2 && o1 > 0 && o2 > 0) {
    F.ord[i] = Math.log(o1 / o2);
    coverage.ord += 1;
  }
  const s1 = titleSeedAt(b.w1, t);
  const s2 = titleSeedAt(b.w2, t);
  F.ttl[i] = (s1 - s2) / 400;
  if (s1 !== NONE_SEED || s2 !== NONE_SEED) coverage.ttl += 1;
  F.drR1[i] = b.round === 1 ? F.dr32[i]! : 0;
  F.drLate[i] = b.round >= 4 ? F.dr32[i]! : 0;
  const a1 = ageAt(b.w1, t);
  const a2 = ageAt(b.w2, t);
  if (a1 !== undefined && a2 !== undefined) {
    F.ageLin[i] = (a1 - a2) / 10;
    F.ageQ[i] = ((a1 - 27) ** 2 - (a2 - 27) ** 2) / 100;
    coverage.age += 1;
  }
  const place = T?.place;
  if (place) {
    const h1 = archive.wrestlers[b.w1]?.aimag === place ? 1 : 0;
    const h2 = archive.wrestlers[b.w2]?.aimag === place ? 1 : 0;
    F.home[i] = h1 - h2;
    if (h1 !== h2) coverage.home += 1;
  }
  const key = b.w1 < b.w2 ? `${b.w1}|${b.w2}` : `${b.w2}|${b.w1}`;
  const rec = h2h.get(key) ?? [0, 0];
  const [x1, x2] = b.w1 < b.w2 ? rec : [rec[1], rec[0]];
  F.h2h[i] = Math.log((1 + x1) / (1 + x2));
  if (x1 + x2 > 0) coverage.h2h += 1;
  F.form[i] = (r(64, b.w1) - r(32, b.w1) - (r(64, b.w2) - r(32, b.w2))) / 400;
  F.drBig[i] = T?.types?.includes(1) ? F.dr32[i]! : 0;
  F.dr16[i] = dr(16);
  F.dr24[i] = dr(24);
  F.dr40[i] = dr(40);
  F.dr48[i] = dr(48);
  F.dr64[i] = dr(64);
  F.dr80[i] = dr(80);
  F.dr96[i] = dr(96);
  F.dr128[i] = dr(128);
  F.r1F[i] = b.round === 1 ? F.dr64[i]! : 0;
  F.lateF[i] = b.round >= 4 ? F.dr64[i]! : 0;
  F.bigF[i] = T?.types?.includes(1) ? F.dr64[i]! : 0;

  Y[i] = b.winner === 1 ? 1 : 0;
  YEAR[i] = Number(b.date.slice(0, 4));
  TID[i] = b.tid;
  ROUND[i] = b.round;

  // ── шинэчлэл (бүх K) ──
  for (const k of KS) {
    const m = elo.get(k)!;
    const ra = m.get(b.w1) ?? SEED;
    const rb = m.get(b.w2) ?? SEED;
    const e1 = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const delta = k * (Y[i]! - e1);
    m.set(b.w1, ra + delta);
    m.set(b.w2, rb - delta);
  }
  games.set(b.w1, g1 + 1);
  games.set(b.w2, g2 + 1);
  last.set(b.w1, t);
  last.set(b.w2, t);
  if (b.w1 < b.w2) h2h.set(key, Y[i] ? [rec[0] + 1, rec[1]] : [rec[0], rec[1] + 1]);
  else h2h.set(key, Y[i] ? [rec[0], rec[1] + 1] : [rec[0] + 1, rec[1]]);
}
const pct = (x: number) => `${((x / N) * 100).toFixed(0)}%`;
console.log(`Архив ${N} барилдаан · шинжийн хамрах хүрээ: зэрэг дэв ${pct(coverage.ord)}, цол ${pct(coverage.ttl)}, нас ${pct(coverage.age)}, нутаг ${pct(coverage.home)}, хоорондын түүх ${pct(coverage.h2h)} · ${((performance.now() - t0) / 1000).toFixed(1)} сек`);

// ── Logistic (Newton/IRLS + бага ridge) ──
function solve(A: Float64Array, b: Float64Array, d: number): Float64Array {
  const M = new Float64Array(A);
  const x = new Float64Array(b);
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(M[r * d + c]!) > Math.abs(M[p * d + c]!)) p = r;
    if (p !== c) {
      for (let k = 0; k < d; k++) [M[c * d + k], M[p * d + k]] = [M[p * d + k]!, M[c * d + k]!];
      [x[c], x[p]] = [x[p]!, x[c]!];
    }
    const piv = M[c * d + c]!;
    for (let r = c + 1; r < d; r++) {
      const f = M[r * d + c]! / piv;
      if (f === 0) continue;
      for (let k = c; k < d; k++) M[r * d + k] = M[r * d + k]! - f * M[c * d + k]!;
      x[r] = x[r]! - f * x[c]!;
    }
  }
  for (let c = d - 1; c >= 0; c--) {
    let s = x[c]!;
    for (let k = c + 1; k < d; k++) s -= M[c * d + k]! * x[k]!;
    x[c] = s / M[c * d + c]!;
  }
  return x;
}

function fit(cols: FName[], rows: Int32Array, lambda = 1e-5): Float64Array {
  const d = cols.length;
  const X = cols.map((c) => F[c]);
  const w = new Float64Array(d);
  const n = rows.length;
  const x = new Float64Array(d);
  for (let it = 0; it < 30; it++) {
    const H = new Float64Array(d * d);
    const g = new Float64Array(d);
    for (let q = 0; q < n; q++) {
      const i = rows[q]!;
      let z = 0;
      for (let j = 0; j < d; j++) {
        x[j] = X[j]![i]!;
        z += w[j]! * x[j]!;
      }
      const p = 1 / (1 + Math.exp(-z));
      const wi = p * (1 - p);
      const e = p - Y[i]!;
      for (let j = 0; j < d; j++) {
        const xj = x[j]!;
        g[j] = g[j]! + e * xj;
        const wx = wi * xj;
        for (let k = j; k < d; k++) H[j * d + k] = H[j * d + k]! + wx * x[k]!;
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) H[j * d + k] = H[k * d + j]!;
      H[j * d + j] = H[j * d + j]! + lambda * n;
      g[j] = g[j]! + lambda * n * w[j]!;
    }
    const step = solve(H, g, d);
    let mx = 0;
    for (let j = 0; j < d; j++) {
      w[j] = w[j]! - step[j]!;
      mx = Math.max(mx, Math.abs(step[j]!));
    }
    if (mx < 1e-8) break;
  }
  return w;
}

function logLoss(cols: FName[], w: Float64Array, rows: Int32Array): number {
  const X = cols.map((c) => F[c]);
  let s = 0;
  for (let q = 0; q < rows.length; q++) {
    const i = rows[q]!;
    let z = 0;
    for (let j = 0; j < cols.length; j++) z += w[j]! * X[j]![i]!;
    const p = Math.min(1 - 1e-12, Math.max(1e-12, 1 / (1 + Math.exp(-z))));
    s -= Y[i] ? Math.log(p) : Math.log(1 - p);
  }
  return s / rows.length;
}

const select = (pred: (i: number) => boolean): Int32Array => {
  const out: number[] = [];
  for (let i = 0; i < N; i++) if (pred(i)) out.push(i);
  return Int32Array.from(out);
};

// ── Загварууд ──
const BASE: FName[] = ['dr32', 'exp', 'rest'];
const KIND: FName[] = ['kO', 'kA', 'kT', 'kB', 'kS'];
const MODELS: [string, FName[]][] = [
  ['B0 суурь (production)', BASE],
  ['+ side (тогтмол w1 давуу)', [...BASE, 'side']],
  ['+ kind (төрөл тус бүрийн тал)', [...BASE, ...KIND]],
  ['+ ord (зэрэг дэв)', [...BASE, 'ord']],
  ['+ ttl (тухайн үеийн цол)', [...BASE, 'ttl']],
  ['+ round (Δr×1-р, Δr×4+)', [...BASE, 'drR1', 'drLate']],
  ['+ age (нас)', [...BASE, 'ageLin', 'ageQ']],
  ['+ home (нутаг)', [...BASE, 'home']],
  ['+ h2h (хоорондын түүх)', [...BASE, 'h2h']],
  ['+ form (хэлбэр K64−K32)', [...BASE, 'form']],
  ['+ big (Δr×улсын наадам)', [...BASE, 'drBig']],
  ['K=16', ['dr16', 'exp', 'rest']],
  ['K=24', ['dr24', 'exp', 'rest']],
  ['K=40', ['dr40', 'exp', 'rest']],
  ['K=48', ['dr48', 'exp', 'rest']],
];
MODELS.push(
  ['K=64', ['dr64', 'exp', 'rest']],
  ['K=80', ['dr80', 'exp', 'rest']],
  ['K=96', ['dr96', 'exp', 'rest']],
  ['K=128', ['dr128', 'exp', 'rest']],
  ['P_A: K32+хэлбэр+нас+даваа+улсын', ['dr32', 'exp', 'rest', 'form', 'ageLin', 'ageQ', 'drR1', 'drLate', 'drBig']],
  ['P_B: K64+нас+даваа+улсын', ['dr64', 'exp', 'rest', 'ageLin', 'ageQ', 'r1F', 'lateF', 'bigF']],
  ['P_C: K64+нас+даваа', ['dr64', 'exp', 'rest', 'ageLin', 'ageQ', 'r1F', 'lateF']],
  ['P_D: K64+нас', ['dr64', 'exp', 'rest', 'ageLin', 'ageQ']],
  ['P_E: K80+нас+даваа+улсын', ['dr80', 'exp', 'rest', 'ageLin', 'ageQ', 'r1F', 'lateF', 'bigF']],
);
const ALL: FName[] = [...BASE, ...KIND, 'ord', 'ttl', 'drR1', 'drLate', 'ageLin', 'ageQ', 'home', 'h2h', 'form', 'drBig'];
MODELS.push(['БҮГД', ALL]);
const GROUPS: [string, FName[]][] = [
  ['kind', KIND], ['ord', ['ord']], ['ttl', ['ttl']], ['round', ['drR1', 'drLate']], ['age', ['ageLin', 'ageQ']],
  ['home', ['home']], ['h2h', ['h2h']], ['form', ['form']], ['big', ['drBig']],
];
for (const [g, cs] of GROUPS) MODELS.push([`БҮГД − ${g}`, ALL.filter((c) => !cs.includes(c))]);

const FOLDS = [2023, 2024, 2025, 2026];
const trainIdx = new Map(FOLDS.map((y) => [y, select((i) => YEAR[i]! < y)]));
const testIdx = new Map(FOLDS.map((y) => [y, select((i) => YEAR[i] === y)]));
const barilga = select((i) => TID[i] === BARILGA);
const namar = select((i) => TID[i] === NAMAR);
console.log(`Шалгалтын онууд: ${FOLDS.map((y) => `${y} (${testIdx.get(y)!.length})`).join(', ')} · Барилга-100 ${barilga.length} · Намрын нээлт ${namar.length}`);

const res: { name: string; cols: FName[]; ll: number[]; mean: number; bar: number; nam: number }[] = [];
for (const [name, cols] of MODELS) {
  const ll: number[] = [];
  let bar = NaN, nam = NaN;
  for (const y of FOLDS) {
    const w = fit(cols, trainIdx.get(y)!);
    ll.push(logLoss(cols, w, testIdx.get(y)!));
    if (y === 2026) {
      bar = logLoss(cols, w, barilga);
      nam = logLoss(cols, w, namar);
    }
  }
  res.push({ name, cols, ll, mean: ll.reduce((s, x) => s + x, 0) / ll.length, bar, nam });
  process.stdout.write('.');
}
console.log('');
const base = res[0]!;
const fmt = (x: number) => x.toFixed(4);
const dlt = (x: number, b: number) => `${x - b >= 0 ? '+' : ''}${((x - b) * 1000).toFixed(1)}`;
console.log('\nLog-loss (бага нь сайн) · Δ = суурьтай зөрүү ×1000 (сөрөг = сайжирсан)');
console.log(table(
  ['Загвар', ...FOLDS.map(String), 'дундаж', 'Δ', 'бүх онд сайн?', 'Барилга', 'Намар'],
  res.map((r) => [
    r.name,
    ...r.ll.map(fmt),
    fmt(r.mean),
    dlt(r.mean, base.mean),
    r.ll.every((x, k) => x < base.ll[k]!) ? 'тийм' : 'үгүй',
    fmt(r.bar),
    fmt(r.nam),
  ]),
));

// Шилдэг загварын жин (2026 хүртэл сургасан) — тайлбарлах боломжтой эсэх
const best = [...res].sort((a, b) => a.mean - b.mean)[0]!;
const wBest = fit(best.cols, select((i) => YEAR[i]! < 2026));
console.log(`\nШилдэг: ${best.name} — жин: ${best.cols.map((c, j) => `${c}=${wBest[j]!.toFixed(3)}`).join(', ')}`);
const wAllFull = fit(ALL, select(() => true));
console.log(`БҮГД (бүх өгөгдлөөр): ${ALL.map((c, j) => `${c}=${wAllFull[j]!.toFixed(3)}`).join(', ')}`);

// Давааны калибровк: суурь vs шилдэг (2024–2026)
const oos = select((i) => YEAR[i]! >= 2024);
const wB = fit(BASE, select((i) => YEAR[i]! < 2024));
const wS = fit(best.cols, select((i) => YEAR[i]! < 2024));
const pOf = (cols: FName[], w: Float64Array, i: number) => {
  let z = 0;
  for (let j = 0; j < cols.length; j++) z += w[j]! * F[cols[j]!][i]!;
  return 1 / (1 + Math.exp(-z));
};
const calRows: string[][] = [];
for (const [lab, lo, hi] of [['1-р даваа', 1, 1], ['2–3', 2, 3], ['4–6', 4, 6], ['7+', 7, 99]] as const) {
  let n = 0, fb = 0, fs = 0, llb = 0, lls = 0;
  for (let q = 0; q < oos.length; q++) {
    const i = oos[q]!;
    if (ROUND[i]! < lo || ROUND[i]! > hi) continue;
    n += 1;
    const pb = pOf(BASE, wB, i);
    const ps = pOf(best.cols, wS, i);
    if ((pb >= 0.5) === (Y[i] === 1)) fb += 1;
    if ((ps >= 0.5) === (Y[i] === 1)) fs += 1;
    llb -= Y[i] ? Math.log(pb) : Math.log(1 - pb);
    lls -= Y[i] ? Math.log(ps) : Math.log(1 - ps);
  }
  calRows.push([lab, String(n), `${((fb / n) * 100).toFixed(1)}%`, `${((fs / n) * 100).toFixed(1)}%`, (llb / n).toFixed(4), (lls / n).toFixed(4)]);
}
console.log('\n2024–2026 даваагаар (суурь → шилдэг):');
console.log(table(['Даваа', 'n', 'фаворит зөв (суурь)', 'фаворит зөв (шилдэг)', 'log-loss (суурь)', 'log-loss (шилдэг)'], calRows));
console.log(`\nНийт ${((performance.now() - t0) / 1000).toFixed(1)} сек`);

// ── PRODUCTION жин: P_B-г бүх өгөгдлөөр (src/rating.ts PREDICT_WEIGHTS-д хуулна) ──
const PROD: FName[] = ['dr64', 'exp', 'rest', 'ageLin', 'ageQ', 'r1F', 'lateF', 'bigF'];
const wProd = fit(PROD, select(() => true));
console.log(`\nPRODUCTION (P_B, бүх ${N} барилдаанаар): ${PROD.map((c, j) => `${c}=${wProd[j]!.toFixed(4)}`).join(', ')}`);
