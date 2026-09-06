/**
 * Тэмцээний прогноз — Монте-Карло симуляци.
 *
 * Оролт: оролцогчид (id, рейтинг), давааны тоо, мэдэгдэж буй үр дүнгүүд.
 * Даваа бүрд амьд үлдэгсдийг САНАМСАРГҮЙ хослуулна (Наадмын «ам авах» сонголтын
 * нөлөөг үл тооцно — энгийн, гэхдээ өнөөх Elo-гоор тэнцвэртэй), барилдааны үр дүн
 * Elo магадлалаар. Мэдэгдсэн үр дүнтэй барилдаан яг тэр чигээрээ явна.
 *
 * Гаралт: бөх бүрийн «хэд давах» тархалт (P(k даваа), k = 0..rounds), мөн
 * симуляци бүрийн давсан тоо (хос харьцуулалтад: А ба Б хэн холдох).
 * Үүнээс: аварга (k = rounds), финалд (k ≥ rounds−1), N.5-аас дээш, яг N, matchup.
 */

import { PREDICT_WEIGHTS, REST_CAP_DAYS } from './rating.ts';

export interface ForecastEntrant {
  id: string;
  rating: number;
  /** Бодит барилдааны тоо (таамгийн калибровкид) — байхгүй бол тэнцүү гэж үзнэ. */
  games?: number;
  /** Сүүлд барилдснаас хойшх хоног — симийн эхний даваанд л нөлөөлнө. */
  daysSinceLast?: number;
}

export interface KnownResult {
  round: number;
  aId: string;
  bId: string;
  winnerId: string;
}

export interface ForecastInput {
  entrants: ForecastEntrant[];
  rounds: number;
  known?: KnownResult[];
  sims?: number;
  seed?: number;
}

export interface Forecast {
  ids: string[];
  rounds: number;
  sims: number;
  /** id → P(яг k даваа давах), k = 0..rounds. */
  winsDist: Map<string, number[]>;
  /** id → хүлээгдэж буй давааны тоо. */
  expectedWins: Map<string, number>;
  /** Симуляци бүрийн давсан тоо: simWins[s * n + i]. */
  simWins: Uint8Array;
  index: Map<string, number>;
  /** Мэдэгдсэн үр дүнгээр аль хэдийн унасан бөх (id → давсан тоо). */
  eliminated: Map<string, number>;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function forecastTournament(input: ForecastInput): Forecast {
  const rounds = Math.max(1, Math.floor(input.rounds));
  const sims = Math.max(1, input.sims ?? 500);
  const rnd = mulberry32(input.seed ?? 20260816);
  const ids = input.entrants.map((e) => e.id);
  const n = ids.length;
  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const rating = new Float64Array(n);
  // Калибровкдсон таамгийн онцлогууд: lg = ln(1+туршлага), ld = ln(1+амралтын хоног) — NaN = мэдэгдэхгүй
  const lg = new Float64Array(n).fill(NaN);
  const ld = new Float64Array(n).fill(NaN);
  input.entrants.forEach((e, i) => {
    rating[i] = e.rating;
    if (e.games !== undefined) lg[i] = Math.log(1 + Math.max(0, e.games));
    if (e.daysSinceLast !== undefined) ld[i] = Math.log(1 + Math.min(Math.max(0, e.daysSinceLast), REST_CAP_DAYS));
  });
  /** predictProbability-тай ижил z; амралтын гишүүн зөвхөн 1-р даваанд (дараа нь бүгд «өнөөдөр» барилдсан). */
  const pairP = (a: number, b: number, round: number): number => {
    let z = (PREDICT_WEIGHTS.dr * (rating[a]! - rating[b]!)) / 400;
    if (!Number.isNaN(lg[a]!) && !Number.isNaN(lg[b]!)) z += PREDICT_WEIGHTS.experience * (lg[a]! - lg[b]!);
    if (round === 1 && !Number.isNaN(ld[a]!) && !Number.isNaN(ld[b]!)) z += PREDICT_WEIGHTS.rest * (ld[a]! - ld[b]!);
    return 1 / (1 + Math.exp(-z));
  };

  // Мэдэгдсэн үр дүн: даваа → [давагч idx, давагдагч idx][]
  const knownByRound = new Map<number, [number, number][]>();
  const eliminated = new Map<string, number>();
  const knownWins = new Int32Array(n);
  const knownLoss = new Int32Array(n).fill(-1); // аль даваанд унасан
  for (const k of input.known ?? []) {
    const w = index.get(k.winnerId);
    const l = index.get(k.winnerId === k.aId ? k.bId : k.aId);
    if (w === undefined || l === undefined) continue;
    const list = knownByRound.get(k.round) ?? [];
    list.push([w, l]);
    knownByRound.set(k.round, list);
  }
  for (const [round, list] of [...knownByRound.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [w, l] of list) {
      knownWins[w] = Math.max(knownWins[w]!, round);
      // R-р даваанд унасан бөх R−1 даваа давсан (өмнөх даваанууд бичигдээгүй байсан ч)
      knownWins[l] = Math.max(knownWins[l]!, round - 1);
      if (knownLoss[l]! < 0) knownLoss[l] = round;
    }
  }
  for (let i = 0; i < n; i++) if (knownLoss[i]! >= 0) eliminated.set(ids[i]!, knownWins[i]!);
  // Мэдэгдсэн барилдаанд орсон бөх тэр даваа хүртэл заавал амьд байна
  const knownAppear = new Int32Array(n);
  for (const [round, list] of knownByRound) for (const [w, l] of list) {
    knownAppear[w] = Math.max(knownAppear[w]!, round);
    knownAppear[l] = Math.max(knownAppear[l]!, round);
  }

  const simWins = new Uint8Array(sims * n);
  const counts = new Float64Array(n * (rounds + 1));
  const alive = new Int32Array(n);
  const wins = new Uint8Array(n);
  const order = new Int32Array(n);

  for (let s = 0; s < sims; s++) {
    wins.fill(0);
    // Бүгд эхлээд «амьд» — мэдэгдсэн үр дүнгээр унасан бөх ч унах давааныхаа өмнөх
    // даваануудад bracket-ын байраа эзэлнэ (хий гоц үүсэхгүй).
    let aliveN = 0;
    for (let i = 0; i < n; i++) alive[aliveN++] = i;
    for (let i = 0; i < n; i++) if (knownLoss[i]! >= 0) wins[i] = knownWins[i]!;
    for (let round = 1; round <= rounds && aliveN > 1; round++) {
      // Энэ даваанд мэдэгдсэн үр дүнтэй бөхчүүд шууд явна (давагч дараагийн даваанд)
      const known = knownByRound.get(round);
      const done = new Set<number>();
      if (known) {
        for (const [w, l] of known) {
          done.add(w);
          done.add(l);
          if (wins[w]! < round) wins[w] = round;
        }
      }
      // Хожим мэдэгдсэн барилдаанд орох бөх энэ даваанд заавал давна (үр дүн нь бичигдээгүй ч)
      const autoAdvance: number[] = [];
      for (let k = 0; k < aliveN; k++) {
        const i = alive[k]!;
        if (!done.has(i) && knownAppear[i]! > round) {
          done.add(i);
          wins[i] = round;
          autoAdvance.push(i);
        }
      }
      // Үлдсэн амьд бөхчүүдийг санамсаргүй хослуулна
      let m = 0;
      for (let k = 0; k < aliveN; k++) if (!done.has(alive[k]!)) order[m++] = alive[k]!;
      for (let k = m - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        const t = order[k]!;
        order[k] = order[j]!;
        order[j] = t;
      }
      // Автоматаар давсан бөх бүр (өрсөлдөгч нь бичигдээгүй) нэг санамсаргүй өрсөлдөгчийг
      // унагасан гэж үзнэ — эс бөгөөс тоо сондгой болж хий гоц үүснэ.
      for (let a = 0; a < autoAdvance.length && m > 0; a++) m -= 1;
      let nextN = 0;
      const next = alive; // in-place дахин бичихийн тулд түр массив
      const survivors: number[] = [];
      for (let k = 0; k + 1 < m; k += 2) {
        const a = order[k]!;
        const b = order[k + 1]!;
        const pA = pairP(a, b, round);
        const w = rnd() < pA ? a : b;
        wins[w] = round;
        survivors.push(w);
      }
      if (m % 2 === 1) {
        // сондгой — нэг бөх гоц (даваа давсанд тооцно)
        const bye = order[m - 1]!;
        wins[bye] = round;
        survivors.push(bye);
      }
      if (known) for (const [w] of known) survivors.push(w);
      for (const w of autoAdvance) survivors.push(w);
      for (const w of survivors) next[nextN++] = w;
      aliveN = nextN;
    }
    for (let i = 0; i < n; i++) {
      const k = Math.min(rounds, wins[i]!);
      simWins[s * n + i] = k;
      counts[i * (rounds + 1) + k] = counts[i * (rounds + 1) + k]! + 1;
    }
  }

  const winsDist = new Map<string, number[]>();
  const expectedWins = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const dist: number[] = [];
    let ev = 0;
    for (let k = 0; k <= rounds; k++) {
      const p = counts[i * (rounds + 1) + k]! / sims;
      dist.push(p);
      ev += k * p;
    }
    winsDist.set(ids[i]!, dist);
    expectedWins.set(ids[i]!, ev);
  }
  return { ids, rounds, sims, winsDist, expectedWins, simWins, index, eliminated };
}

/** P(k ≥ line-ээс дээш): line = 4.5 → P(wins ≥ 5). */
export function probOver(f: Forecast, id: string, line: number): number {
  const d = f.winsDist.get(id);
  if (!d) return 0.5;
  const min = Math.floor(line) + 1;
  let p = 0;
  for (let k = min; k < d.length; k++) p += d[k]!;
  return p;
}

/** Аваргын магадлал (бүх даваа давах). */
export function probChampion(f: Forecast, id: string): number {
  return f.winsDist.get(id)?.[f.rounds] ?? 0;
}

/** Хоёр бөхийн «хэн холдох»: [P(A > B), P(B > A), P(тэнцүү)]. */
export function matchupProbs(f: Forecast, a: string, b: string): [number, number, number] {
  const ia = f.index.get(a);
  const ib = f.index.get(b);
  if (ia === undefined || ib === undefined) return [1 / 3, 1 / 3, 1 / 3];
  const n = f.ids.length;
  let pa = 0;
  let pb = 0;
  let eq = 0;
  for (let s = 0; s < f.sims; s++) {
    const wa = f.simWins[s * n + ia]!;
    const wb = f.simWins[s * n + ib]!;
    if (wa > wb) pa += 1;
    else if (wb > wa) pb += 1;
    else eq += 1;
  }
  return [pa / f.sims, pb / f.sims, eq / f.sims];
}

/** Аваргын магадлалаар эрэмбэлсэн эхний K бөх + үлдсэний нийлбэр («Бусад»). */
export function championTop(f: Forecast, k: number): { ids: string[]; probs: number[]; other: number } {
  const ranked = f.ids.map((id) => ({ id, p: probChampion(f, id) })).sort((x, y) => y.p - x.p);
  const top = ranked.slice(0, k);
  const sum = top.reduce((s, x) => s + x.p, 0);
  return { ids: top.map((x) => x.id), probs: top.map((x) => x.p), other: Math.max(0, 1 - sum) };
}
