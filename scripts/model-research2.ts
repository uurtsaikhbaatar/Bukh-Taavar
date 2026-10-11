/**
 * Таамгийн загварын судалгаа №2 (2026-10-12) — 2020 оноос хойших аудитаар (scripts/model-audit.mjs)
 * илэрсэн системтэй гажгуудын засварыг шалгана. Сүлжээгүй, look-ahead-гүй: барилдаануудыг он цагаар
 * нэг удаа гүйж шинжийг барилдааны ӨМНӨХ төлөвөөс бичээд, «өмнөх бүх он → дараагийн он» байдлаар
 * 2020…2026 долоон онд тус тусад нь шалгана.
 *
 *   node --max-old-space-size=6144 scripts/model-research2.ts          (бүдүүн тор: хурд + damp)
 *   node --max-old-space-size=6144 scripts/model-research2.ts --fine   (нарийн тор: K0 × b × τ, эцсийн бүтцээр)
 *   node --max-old-space-size=6144 scripts/model-research2.ts --final  (эцсийн загвар: сургалтын цонх, калибровк, PRODUCTION жин)
 *
 * Таамаглалууд:
 *   prov   шинэ бөхийн рейтинг хурдан сурах (K_i = 64·(1 + b·τ/(τ+g_i))) — цөөн барилдсан бөхийг
 *          хэт өндөр/доогуур үнэлэх, тойргийн барилдаанд мэдээлэл удаан хуримтлагдах хоёрыг зэрэг
 *   damp   өрсөлдөгч нь шинэ (рейтинг нь тодорхойгүй) бол туршлагатай бөхийн рейтинг бага өөрчлөгдөнө
 *   exp    туршлагын гишүүний хэлбэр (ln((c+g_A)/(c+g_B)), c = 1, 5, 20)
 *   type   тэмцээний төрлөөр Δ-ийн налуу (аймгийн баяр наадам, сумын цолтон, цолгүй залуус)
 *   stage  төгсгөлөөс тоолсон шат (финал, хагас, шөвгийн 8) — «4+ даваа»-ны оронд
 *   size   том хүрээ (400+ бөх)
 */

import { table } from '../src/format.ts';
import { loadArchive } from '../src/graph.ts';

const t0 = performance.now();
const SEED = 1300;
const DAY = 86_400_000;
const archive = loadArchive();
const clean = archive.bouts
  .filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 !== b.w2 && !b.noShow)
  .sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
const N = clean.length;

// Тэмцээний нийт даваа, оролцогч (шат, хэмжээний шинжид) — тэмцээний бүтэц нь урьдчилан мэдэгддэг
const tRounds = new Map<string, number>();
const tSize = new Map<string, Set<string>>();
for (const b of archive.bouts) {
  tRounds.set(b.tid, Math.max(tRounds.get(b.tid) ?? 0, b.round));
  const s = tSize.get(b.tid) ?? tSize.set(b.tid, new Set()).get(b.tid)!;
  s.add(b.w1);
  s.add(b.w2);
}
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

// ── Рейтингийн хувилбарууд ──
interface Variant { name: string; k0: number; b: number; tau: number; damp: number }
const FINE = process.argv.includes('--fine');
const FINAL = process.argv.includes('--final');
const VARIANTS: Variant[] = [{ name: 'K64 (одоогийн)', k0: 64, b: 0, tau: 1, damp: 0 }];
if (FINAL) {
  VARIANTS.push({ name: 'K32 b=3 τ=20', k0: 32, b: 3, tau: 20, damp: 0 });
} else if (FINE) {
  for (const k0 of [32, 40, 48, 56]) for (const b of [2, 3, 4, 6]) for (const tau of [5, 10, 20]) VARIANTS.push({ name: `K${k0} b=${b} τ=${tau}`, k0, b, tau, damp: 0 });
} else {
  for (const b of [1, 2, 4]) for (const tau of [3, 10, 30]) VARIANTS.push({ name: `prov b=${b} τ=${tau}`, k0: 64, b, tau, damp: 0 });
  for (const [b, tau] of [[2, 10], [4, 10], [2, 30]] as const) for (const damp of [3, 10]) VARIANTS.push({ name: `prov b=${b} τ=${tau} damp=${damp}`, k0: 64, b, tau, damp });
  for (const [b, tau] of [[2, 10], [4, 10]] as const) VARIANTS.push({ name: `K48 prov b=${b} τ=${tau}`, k0: 48, b, tau, damp: 0 });
}
const V = VARIANTS.length;

const DR = VARIANTS.map(() => new Float64Array(N));
const IND = ['r1', 'late', 'big', 'tAimag', 'tSum', 'tYouth', 'sFinal', 'sSemi', 'sQuarter', 'sizeBig'] as const;
type Ind = (typeof IND)[number];
const I: Record<Ind, Uint8Array> = Object.fromEntries(IND.map((n) => [n, new Uint8Array(N)])) as Record<Ind, Uint8Array>;
const EXTRA = ['exp', 'exp5', 'exp20', 'rest', 'ageLin', 'ageQ'] as const;
type Extra = (typeof EXTRA)[number];
const X: Record<Extra, Float64Array> = Object.fromEntries(EXTRA.map((n) => [n, new Float64Array(N)])) as Record<Extra, Float64Array>;
const Y = new Float64Array(N);
const YEAR = new Int16Array(N);
const GMIN = new Int32Array(N);
const FMT = new Uint8Array(N); // 0 шигшээ, 1 тойргийн, 2 багийн

const elo = VARIANTS.map(() => new Map<string, number>());
const games = new Map<string, number>();
const last = new Map<string, number>();

for (let i = 0; i < N; i++) {
  const b = clean[i]!;
  const t = Date.parse(b.date);
  const T = archive.tournaments.get(b.tid);
  const g1 = games.get(b.w1) ?? 0;
  const g2 = games.get(b.w2) ?? 0;
  const d1 = last.has(b.w1) ? Math.min(1095, (t - last.get(b.w1)!) / DAY) : 1095;
  const d2 = last.has(b.w2) ? Math.min(1095, (t - last.get(b.w2)!) / DAY) : 1095;
  const ko = !b.fmt;
  const rounds = tRounds.get(b.tid) ?? b.round;
  const stage = rounds - b.round; // 0 = сүүлийн даваа
  const type = T?.types?.[0];
  I.r1[i] = ko && b.round === 1 ? 1 : 0;
  I.late[i] = ko && b.round >= 4 ? 1 : 0;
  I.big[i] = T?.types?.includes(1) ? 1 : 0;
  I.tAimag[i] = type === 34 ? 1 : 0;
  I.tSum[i] = type === 33 ? 1 : 0;
  I.tYouth[i] = type === 38 ? 1 : 0;
  I.sFinal[i] = ko && rounds >= 5 && stage === 0 ? 1 : 0;
  I.sSemi[i] = ko && rounds >= 5 && stage === 1 ? 1 : 0;
  I.sQuarter[i] = ko && rounds >= 5 && stage === 2 ? 1 : 0;
  I.sizeBig[i] = (tSize.get(b.tid)?.size ?? 0) >= 400 ? 1 : 0;
  X.exp[i] = Math.log((1 + g1) / (1 + g2));
  X.exp5[i] = Math.log((5 + g1) / (5 + g2));
  X.exp20[i] = Math.log((20 + g1) / (20 + g2));
  X.rest[i] = Math.log((1 + d1) / (1 + d2));
  const a1 = ageAt(b.w1, t);
  const a2 = ageAt(b.w2, t);
  if (a1 !== undefined && a2 !== undefined) {
    X.ageLin[i] = (a1 - a2) / 10;
    X.ageQ[i] = ((a1 - 27) ** 2 - (a2 - 27) ** 2) / 100;
  }
  const y = b.winner === 1 ? 1 : 0;
  Y[i] = y;
  YEAR[i] = Number(b.date.slice(0, 4));
  GMIN[i] = Math.min(g1, g2);
  FMT[i] = b.fmt === 'rr' ? 1 : b.fmt === 'team' ? 2 : 0;
  for (let v = 0; v < V; v++) {
    const m = elo[v]!;
    const va = VARIANTS[v]!;
    const ra = m.get(b.w1) ?? SEED;
    const rb = m.get(b.w2) ?? SEED;
    DR[v]![i] = (ra - rb) / 400;
    const e1 = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    let k1 = va.k0 * (1 + (va.b * va.tau) / (va.tau + g1));
    let k2 = va.k0 * (1 + (va.b * va.tau) / (va.tau + g2));
    if (va.damp > 0) {
      // өрсөлдөгч нь цөөн барилдсан бол (рейтинг нь тодорхойгүй) миний өөрчлөлт багасна
      k1 *= (g2 + 1) / (g2 + 1 + va.damp) + va.damp / (g2 + 1 + va.damp) * 0.25;
      k2 *= (g1 + 1) / (g1 + 1 + va.damp) + va.damp / (g1 + 1 + va.damp) * 0.25;
    }
    m.set(b.w1, ra + k1 * (y - e1));
    m.set(b.w2, rb - k2 * (y - e1));
  }
  games.set(b.w1, g1 + 1);
  games.set(b.w2, g2 + 1);
  last.set(b.w1, t);
  last.set(b.w2, t);
}
console.log(`Архив ${N} барилдаан, ${V} рейтингийн хувилбар · ${((performance.now() - t0) / 1000).toFixed(1)} сек`);

// ── Загвар = рейтингийн хувилбар + налуугийн өөрчлөгчид + нэмэлт гишүүд ──
interface Model { name: string; v: number; slopes: Ind[]; extras: Extra[] }
const colsOf = (m: Model): ((i: number) => number)[] => [
  (i) => DR[m.v]![i]!,
  ...m.slopes.map((s) => (i: number) => (I[s][i] ? DR[m.v]![i]! : 0)),
  ...m.extras.map((e) => (i: number) => X[e][i]!),
];

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

/** Дизайны матрицыг нэг удаа бодож (мөр × багана) IRLS-ээр тохируулна. */
function design(m: Model): Float64Array {
  const cols = colsOf(m);
  const d = cols.length;
  const D = new Float64Array(N * d);
  for (let i = 0; i < N; i++) for (let j = 0; j < d; j++) D[i * d + j] = cols[j]!(i);
  return D;
}
function fit(D: Float64Array, d: number, rows: Int32Array, lambda = 1e-5): Float64Array {
  const w = new Float64Array(d);
  const n = rows.length;
  for (let it = 0; it < 25; it++) {
    const H = new Float64Array(d * d);
    const g = new Float64Array(d);
    for (let q = 0; q < n; q++) {
      const o = rows[q]! * d;
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j]! * D[o + j]!;
      const p = 1 / (1 + Math.exp(-z));
      const wi = p * (1 - p);
      const e = p - Y[rows[q]!]!;
      for (let j = 0; j < d; j++) {
        const xj = D[o + j]!;
        g[j] = g[j]! + e * xj;
        const wx = wi * xj;
        for (let k = j; k < d; k++) H[j * d + k] = H[j * d + k]! + wx * D[o + k]!;
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
    if (mx < 1e-7) break;
  }
  return w;
}
const prob = (D: Float64Array, d: number, w: Float64Array, i: number, cap = 1): number => {
  let z = 0;
  for (let j = 0; j < d; j++) z += w[j]! * D[i * d + j]!;
  const p = 1 / (1 + Math.exp(-z));
  return Math.min(cap, Math.max(1 - cap, p));
};
const select = (pred: (i: number) => boolean): Int32Array => {
  const out: number[] = [];
  for (let i = 0; i < N; i++) if (pred(i)) out.push(i);
  return Int32Array.from(out);
};

const FOLDS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const trainIdx = new Map(FOLDS.map((y) => [y, select((i) => YEAR[i]! < y)]));
const testIdx = new Map(FOLDS.map((y) => [y, select((i) => YEAR[i] === y)]));
const BASE_SLOPES: Ind[] = ['r1', 'late', 'big'];
const BASE_EXTRAS: Extra[] = ['exp', 'rest', 'ageLin', 'ageQ'];

interface Res { name: string; ll: number[]; mean: number; lowExp: number; rr: number; preds: Float64Array }
/** Он бүрийг өмнөх онуудаар сургасан жингээр таана; бүх 2020+ барилдааны таамгийг буцаана. */
function evaluate(m: Model, cap = 1, trainFrom = 0, scale = 1): Res {
  const D = design(m);
  const d = 1 + m.slopes.length + m.extras.length;
  const preds = new Float64Array(N);
  const ll: number[] = [];
  let sLow = 0, nLow = 0, sRr = 0, nRr = 0;
  for (const y of FOLDS) {
    const w = fit(D, d, trainFrom ? select((i) => YEAR[i]! >= trainFrom && YEAR[i]! < y) : trainIdx.get(y)!);
    if (scale !== 1) for (let j = 0; j < d; j++) w[j] = w[j]! * scale;
    let s = 0;
    const te = testIdx.get(y)!;
    for (let q = 0; q < te.length; q++) {
      const i = te[q]!;
      const p1 = prob(D, d, w, i, cap);
      preds[i] = p1;
      const p = Math.min(1 - 1e-12, Math.max(1e-12, Y[i] ? p1 : 1 - p1));
      const l = -Math.log(p);
      s += l;
      if (GMIN[i]! <= 5) { sLow += l; nLow += 1; }
      if (FMT[i] === 1) { sRr += l; nRr += 1; }
    }
    ll.push(s / te.length);
  }
  let tot = 0, cnt = 0;
  FOLDS.forEach((y, k) => { tot += ll[k]! * testIdx.get(y)!.length; cnt += testIdx.get(y)!.length; });
  return { name: m.name, ll, mean: tot / cnt, lowExp: sLow / nLow, rr: nRr ? sRr / nRr : NaN, preds };
}
const fmt = (x: number) => x.toFixed(4);
const show = (title: string, rs: Res[], base: Res) => {
  console.log(`\n${title}`);
  console.log(table(
    ['Загвар', ...FOLDS.map(String), 'нийт', 'Δ×1000', 'сайжирсан он', 'туршлага ≤5', 'тойргийн'],
    rs.map((r) => [r.name, ...r.ll.map(fmt), fmt(r.mean), `${r.mean - base.mean >= 0 ? '+' : ''}${((r.mean - base.mean) * 1000).toFixed(2)}`, `${r.ll.filter((x, k) => x < base.ll[k]! - 1e-9).length}/${FOLDS.length}`, fmt(r.lowExp), Number.isNaN(r.rr) ? '—' : fmt(r.rr)]),
  ));
};

// ── Эцсийн загвар: сургалтын цонх ба калибровк ──
if (FINAL) {
  const fm: Model = { name: 'v4', v: 1, slopes: ['late', 'tAimag'], extras: ['exp', 'exp20', 'rest', 'ageLin', 'ageQ'] };
  const base0 = evaluate({ name: 'v3 (одоогийн)', v: 0, slopes: BASE_SLOPES, extras: BASE_EXTRAS });
  const gapOf = (r: Res) => {
    let n = 0, sp = 0, sf = 0;
    for (const y of FOLDS) for (const i of testIdx.get(y)!) { const p = r.preds[i]!; n += 1; sp += Math.max(p, 1 - p); sf += (p > 0.5) === (Y[i] === 1) ? 1 : p === 0.5 ? 0.5 : 0; }
    return `${(((sp - sf) / n) * 100).toFixed(2)}`;
  };
  const runs: Res[] = [base0];
  for (const from of [0, 2001, 2010, 2015, 2018]) runs.push({ ...evaluate(fm, 1, from), name: `v4, сургалт ${from || 1925}-оос` });
  for (const sc of [1.02, 1.04, 1.06]) runs.push({ ...evaluate(fm, 1, 0, sc), name: `v4, бүх он, жин ×${sc}` });
  show('Эцсийн загвар — сургалтын цонх ба жингийн масштаб', runs, base0);
  console.log('Калибровкийн зөрүү (фаворитын таамаг − бодит, нэгж хувь; сөрөг = дутуу итгэлтэй): ' + runs.map((r) => `${r.name}: ${gapOf(r)}`).join(' · '));
  const D = design(fm);
  const d = 1 + fm.slopes.length + fm.extras.length;
  const names = ['dr', ...fm.slopes, ...fm.extras];
  for (const from of [0, 2015]) {
    const w = fit(D, d, select((i) => YEAR[i]! >= from));
    console.log(`PRODUCTION жин (v4, ${from || 1925}-оос бүх өгөгдөл): ${names.map((n, j) => `${n}=${w[j]!.toFixed(4)}`).join(', ')}`);
  }
  console.log(`Нийт ${((performance.now() - t0) / 1000).toFixed(0)} сек`);
  process.exit(0);
}

// ── 1) Рейтингийн хувилбар ──
// Нарийн торд эцсийн бүтцээр (exp+exp20, аймгийн наадам) харьцуулна; суурь нь үргэлж одоогийн загвар
const base = evaluate({ name: 'K64 — одоогийн загвар', v: 0, slopes: BASE_SLOPES, extras: BASE_EXTRAS });
const S1: Ind[] = FINE ? ['r1', 'late', 'big', 'tAimag'] : BASE_SLOPES;
const E1: Extra[] = FINE ? ['exp', 'exp20', 'rest', 'ageLin', 'ageQ'] : BASE_EXTRAS;
const step1 = VARIANTS.map((va, v) => evaluate({ name: va.name, v, slopes: S1, extras: E1 }));
show(FINE ? '1) Рейтинг шинэчлэх хурд — нарийн тор (exp+exp20, аймгийн наадамтай)' : '1) Рейтинг шинэчлэх хурд (бусад гишүүн одоогийнхоор)', [base, ...step1.slice(FINE ? 1 : 0)].sort((a, b) => a.mean - b.mean).slice(0, 22), base);
const bestV = step1.indexOf([...step1].sort((a, b) => a.mean - b.mean)[0]!);
console.log(`→ шилдэг: ${VARIANTS[bestV]!.name}`);

// ── 2) Туршлагын гишүүний хэлбэр (шилдэг рейтингтэй) ──
const expSets: [string, Extra[]][] = [
  ['exp(1) — одоогийн', ['exp']],
  ['exp(5)', ['exp5']],
  ['exp(20)', ['exp20']],
  ['exp(1)+exp(20)', ['exp', 'exp20']],
  ['exp(1)+exp(5)+exp(20)', ['exp', 'exp5', 'exp20']],
  ['туршлагын гишүүнгүй', []],
];
const step2 = expSets.map(([name, e]) => evaluate({ name, v: bestV, slopes: BASE_SLOPES, extras: [...e, 'rest', 'ageLin', 'ageQ'] }));
show(`2) Туршлагын гишүүн (${VARIANTS[bestV]!.name})`, step2, base);
const bestExp = expSets[step2.indexOf([...step2].sort((a, b) => a.mean - b.mean)[0]!)]![1];

// ── 3) Налуугийн өөрчлөгчид ──
const ex: Extra[] = [...bestExp, 'rest', 'ageLin', 'ageQ'];
const slopeSets: [string, Ind[]][] = [
  ['r1 + late + big — одоогийн', ['r1', 'late', 'big']],
  ['+ төрөл (аймгийн наадам, сумын цолтон, залуус)', ['r1', 'late', 'big', 'tAimag', 'tSum', 'tYouth']],
  ['+ аймгийн наадам', ['r1', 'late', 'big', 'tAimag']],
  ['+ сумын цолтон', ['r1', 'late', 'big', 'tSum']],
  ['+ том хүрээ (400+)', ['r1', 'late', 'big', 'sizeBig']],
  ['late → шат (финал, хагас, шөвгийн 8)', ['r1', 'big', 'sFinal', 'sSemi', 'sQuarter']],
  ['late + шат', ['r1', 'late', 'big', 'sFinal', 'sSemi', 'sQuarter']],
  ['бүгд', ['r1', 'late', 'big', 'tAimag', 'tSum', 'tYouth', 'sizeBig', 'sFinal', 'sSemi', 'sQuarter']],
  ['late + аймгийн наадам (r1, big-гүй)', ['late', 'tAimag']],
  ['late + big + аймгийн наадам (r1-гүй)', ['late', 'big', 'tAimag']],
  ['зөвхөн аймгийн наадам', ['tAimag']],
];
const step3 = slopeSets.map(([name, s]) => evaluate({ name, v: bestV, slopes: s, extras: ex }));
show('3) Δ-ийн налуугийн өөрчлөгчид', step3, base);

// ── 4) Дээд хязгаар (шилдэг хослол дээр) ──
const best3 = slopeSets[step3.indexOf([...step3].sort((a, b) => a.mean - b.mean)[0]!)]!;
const finalModel: Model = { name: 'шилдэг', v: bestV, slopes: best3[1], extras: ex };
const caps = [1, 0.995, 0.99, 0.985, 0.98, 0.975].map((c) => ({ ...evaluate({ ...finalModel, name: `хязгаар ${(c * 100).toFixed(1)}%` }, c) }));
show(`4) Таамгийн дээд хязгаар (${best3[0]})`, caps, base);

// ── Жин (бүх өгөгдлөөр) ──
const cand: Model[] = [
  { name: 'одоогийн', v: 0, slopes: BASE_SLOPES, extras: BASE_EXTRAS },
  finalModel,
  { name: 'exp+exp20, r1+late+big+аймаг', v: bestV, slopes: ['r1', 'late', 'big', 'tAimag'], extras: ['exp', 'exp20', 'rest', 'ageLin', 'ageQ'] },
  { name: 'exp+exp20, late+аймаг', v: bestV, slopes: ['late', 'tAimag'], extras: ['exp', 'exp20', 'rest', 'ageLin', 'ageQ'] },
  { name: 'exp+exp20, late+big+аймаг', v: bestV, slopes: ['late', 'big', 'tAimag'], extras: ['exp', 'exp20', 'rest', 'ageLin', 'ageQ'] },
];
for (const m of cand) {
  const D = design(m);
  const d = 1 + m.slopes.length + m.extras.length;
  const w = fit(D, d, select(() => true));
  const names = ['dr', ...m.slopes, ...m.extras];
  console.log(`\nЖин — ${m.name} [${VARIANTS[m.v]!.name}]: ${names.map((n, j) => `${n}=${w[j]!.toFixed(4)}`).join(', ')}`);
}
console.log(`\nНийт ${((performance.now() - t0) / 1000).toFixed(0)} сек`);
