/**
 * Барилдааны граф — хоорондын харьцаа, давамгайллын гинж, Bradley–Terry.
 *
 * Орц: devjee архив (`data/devjee/bouts.jsonl` …) эсвэл дурын барилдааны жагсаалт.
 *
 * Гурван магадлалын эх:
 *  1. Шууд харьцаа (head-to-head): А–Б хоорондоо хэд барилдаж хэн хэд давсан.
 *  2. Давамгайллын гинж (K үе): А → (А-гийн давсан хүн) → (түүний давсан хүн) → … → Б
 *     замуудыг цаг хугацааны жинтэй, үе бүрд β-ээр бууруулж нэгтгэнэ; эсрэг чиглэлтэй
 *     (Б → … → А) харьцуулж магадлал гаргана. Алхам бүр «санамсаргүй ялалтын алхам»
 *     (мөр-нормчилсон) тул олон барилддаг бөх давуу тал авахгүй.
 *  3. Bradley–Terry (MM алгоритм): бүх бөхийн хүчийг НЭГЭН ЗЭРЭГ, харилцан
 *     хамааралтайгаар үнэлнэ — гинжийг ил тоолохгүй ч бүх шууд/шууд бус
 *     харьцуулалтыг статистикийн зөв жинтэй нэгтгэдэг. P = 1/(1+e^{s_B−s_A}).
 *
 * Мөн Elo replay (K=32, цолын суурь) — devjee-ийн рейтингийг дахин бүтээж тулгахад.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { seedRating, titleFromCode, updateRatings, winProbability, type Title } from './rating.ts';

export interface ArchiveWrestler {
  name: string;
  fullName?: string;
  title: Title;
  titleCode: number;
  aimag?: string;
  aimagCode: number;
  /** Сумын нэр («Цагааннуур»). */
  sum?: string;
  sumCode?: string;
  birthDate?: string;
  devjeeId: string;
  isInactive?: boolean;
  lastTournamentDate?: string;
  height?: number;
  weight?: number;
  club?: string;
  affiliations?: string[];
  titles?: { title: Title; date: string; rounds?: string; place?: string }[];
}

export interface ArchiveBout {
  tid: string;
  date: string;
  round: number;
  w1: string;
  w2: string;
  winner: 1 | 2;
  kind?: string;
  noShow?: boolean;
  mid: string;
}

export interface ArchiveTournamentMeta {
  id: string;
  name: string;
  date: string;
  rank?: number;
  types?: number[];
  place?: string;
  rounds: number;
  wrestlerCount: number;
  matchCount: number;
  order: Record<string, number>;
  hasState: boolean;
}

export interface Archive {
  wrestlers: Record<string, ArchiveWrestler>;
  bouts: ArchiveBout[];
  tournaments: Map<string, ArchiveTournamentMeta>;
}

/** data/devjee/ архивыг уншина. */
export function loadArchive(dir = path.join('data', 'devjee')): Archive {
  const boutsPath = path.join(dir, 'bouts.jsonl');
  if (!existsSync(boutsPath)) throw new Error(`Архив олдсонгүй: ${boutsPath} — эхлээд «npm run archive» ажиллуул.`);
  const bouts: ArchiveBout[] = [];
  for (const line of readFileSync(boutsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    bouts.push(JSON.parse(line) as ArchiveBout);
  }
  const wPath = path.join(dir, 'wrestlers.json');
  const wrestlers = existsSync(wPath) ? (JSON.parse(readFileSync(wPath, 'utf8')) as Record<string, ArchiveWrestler>) : {};
  const tPath = path.join(dir, 'tournaments.json');
  const tournaments = new Map<string, ArchiveTournamentMeta>();
  if (existsSync(tPath)) for (const t of JSON.parse(readFileSync(tPath, 'utf8')) as ArchiveTournamentMeta[]) tournaments.set(t.id, t);
  return { wrestlers, bouts, tournaments };
}

const DAY = 86_400_000;

export interface GraphOptions {
  /** Энэ өдрөөс хойших барилдааныг оруулахгүй (backtest); анхдагч — бүгд. */
  asOf?: string;
  /** Жингийн хагас задралын хугацаа (жил); 0 = жин тэнцүү. */
  halfLifeYears?: number;
  /** Гоц/ирээгүй барилдааныг хасах (анхдагч тийм). */
  excludeNoShow?: boolean;
}

export interface HeadToHead {
  aWins: number;
  bWins: number;
  bouts: ArchiveBout[];
}

export interface ChainPath {
  /** А-аас Б хүртэлх бөхчүүдийн id (А эхэнд, Б төгсгөлд). */
  nodes: string[];
  /** Ирмэг бүрийн хамгийн сүүлийн огноо. */
  dates: string[];
  /** Замын магадлал (алхмуудын үржвэр). */
  prob: number;
}

export interface ChainResult {
  a: string;
  b: string;
  maxHops: number;
  beta: number;
  /** Үе бүрийн хувь нэмэр (β^{k−1}·(P^k)[a,b]) — А→Б ба Б→А. */
  perHop: { k: number; ab: number; ba: number }[];
  scoreAB: number;
  scoreBA: number;
  /** А Б-г давах магадлал (score харьцаа). Холбоогүй бол 0.5. */
  pA: number;
  /** Холбогдсон эсэх. */
  connected: boolean;
  topPathsAB: ChainPath[];
  topPathsBA: ChainPath[];
}

interface Edge {
  to: number;
  weight: number;
  count: number;
  lastDate: string;
}

export class BoutGraph {
  readonly ids: string[];
  readonly index = new Map<string, number>();
  /** Давагч → давагдагч ирмэгүүд (нэгтгэсэн). */
  readonly out: Edge[][];
  readonly outWeight: Float64Array;
  readonly bouts: ArchiveBout[];
  readonly asOfMs: number;
  readonly halfLifeYears: number;
  private bt: Float64Array | null = null;

  constructor(bouts: ArchiveBout[], options: GraphOptions = {}) {
    const excludeNoShow = options.excludeNoShow ?? true;
    const asOf = options.asOf;
    this.halfLifeYears = options.halfLifeYears ?? 4;
    let used = bouts.filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 !== b.w2);
    if (excludeNoShow) used = used.filter((b) => !b.noShow);
    if (asOf) used = used.filter((b) => b.date < asOf);
    this.bouts = used;
    let latest = '';
    for (const b of used) if (b.date > latest) latest = b.date;
    this.asOfMs = Date.parse(asOf ?? latest ?? '2000-01-01') || Date.now();

    for (const b of used) {
      if (!this.index.has(b.w1)) this.index.set(b.w1, this.index.size);
      if (!this.index.has(b.w2)) this.index.set(b.w2, this.index.size);
    }
    this.ids = [...this.index.keys()];
    const n = this.ids.length;
    const maps: Map<number, Edge>[] = Array.from({ length: n }, () => new Map());
    for (const b of used) {
      const w = b.winner === 1 ? this.index.get(b.w1)! : this.index.get(b.w2)!;
      const l = b.winner === 1 ? this.index.get(b.w2)! : this.index.get(b.w1)!;
      const wt = this.recency(b.date);
      const m = maps[w]!;
      const e = m.get(l);
      if (e) {
        e.weight += wt;
        e.count += 1;
        if (b.date > e.lastDate) e.lastDate = b.date;
      } else m.set(l, { to: l, weight: wt, count: 1, lastDate: b.date });
    }
    this.out = maps.map((m) => [...m.values()]);
    this.outWeight = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const e of this.out[i]!) s += e.weight;
      this.outWeight[i] = s;
    }
  }

  /** Цаг хугацааны жин: 0.5^(нас/хагас задрал). */
  recency(date: string): number {
    if (this.halfLifeYears <= 0) return 1;
    const age = Math.max(0, (this.asOfMs - Date.parse(date)) / (365.25 * DAY));
    return Math.pow(0.5, age / this.halfLifeYears);
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  // ── 1. шууд харьцаа ──

  headToHead(a: string, b: string): HeadToHead {
    const list = this.bouts.filter((x) => (x.w1 === a && x.w2 === b) || (x.w1 === b && x.w2 === a)).sort((x, y) => y.date.localeCompare(x.date));
    let aWins = 0;
    let bWins = 0;
    for (const x of list) {
      const winner = x.winner === 1 ? x.w1 : x.w2;
      if (winner === a) aWins += 1;
      else bWins += 1;
    }
    return { aWins, bWins, bouts: list };
  }

  /** Бөхийн нийт давалт/алдагдал (жингүй тоо). */
  record(id: string): { wins: number; losses: number; bouts: number } {
    let wins = 0;
    let losses = 0;
    for (const x of this.bouts) {
      if (x.w1 !== id && x.w2 !== id) continue;
      const winner = x.winner === 1 ? x.w1 : x.w2;
      if (winner === id) wins += 1;
      else losses += 1;
    }
    return { wins, losses, bouts: wins + losses };
  }

  // ── 2. давамгайллын гинж ──

  /**
   * А-аас эхлэх «ялалтын санамсаргүй алхаа»: v_0 = e_A; v_k = v_{k−1}·P
   * (P[i][j] = w(i→j)/Σw(i→·)). Б дээрх масс = (P^k)[A,B].
   * Мөн хамгийн магадлалтай замуудыг (Viterbi) буцаана.
   */
  private walk(a: number, b: number, maxHops: number, beta: number, topPaths: number): { perHop: number[]; paths: ChainPath[] } {
    const n = this.ids.length;
    let v = new Float64Array(n);
    v[a] = 1;
    const perHop: number[] = [];
    // Viterbi: best[k][node] = хамгийн магадлалтай k алхмын зам А→node
    let best = new Float64Array(n);
    best[a] = 1;
    const back: Int32Array[] = [];
    const paths: ChainPath[] = [];
    let discount = 1;
    for (let k = 1; k <= maxHops; k++) {
      const nv = new Float64Array(n);
      const nb = new Float64Array(n);
      const bp = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        const mass = v[i]!;
        const bi = best[i]!;
        if (mass === 0 && bi === 0) continue;
        const total = this.outWeight[i]!;
        if (total === 0) continue;
        for (const e of this.out[i]!) {
          const p = e.weight / total;
          if (mass > 0) nv[e.to] = nv[e.to]! + mass * p;
          if (bi > 0) {
            const cand = bi * p;
            if (cand > nb[e.to]!) {
              nb[e.to] = cand;
              bp[e.to] = i;
            }
          }
        }
      }
      // Б-д хүрсэн масс — цааш нь Б-ээс үргэлжлүүлэхгүй (Б-г дайрсан зам давхардахгүй)
      perHop.push(discount * nv[b]!);
      if (nb[b]! > 0) {
        const nodes: number[] = [b];
        let cur = b;
        for (let s = k; s >= 1; s--) {
          const prev = s === k ? bp[cur]! : back[s - 1]![cur]!;
          nodes.push(prev);
          cur = prev;
        }
        nodes.reverse();
        const dates: string[] = [];
        for (let s = 0; s < nodes.length - 1; s++) {
          const e = this.out[nodes[s]!]!.find((x) => x.to === nodes[s + 1]);
          dates.push(e?.lastDate ?? '');
        }
        paths.push({ nodes: nodes.map((i) => this.ids[i]!), dates, prob: discount * nb[b]! });
        // Б-ээс цааш зам үргэлжлүүлэхгүй
        nb[b] = 0;
      }
      nv[b] = 0;
      back.push(bp);
      v = nv;
      best = nb;
      discount *= beta;
    }
    paths.sort((x, y) => y.prob - x.prob);
    return { perHop, paths: paths.slice(0, topPaths) };
  }

  chain(a: string, b: string, options: { maxHops?: number; beta?: number; topPaths?: number; smooth?: number; shrink?: number } = {}): ChainResult {
    const maxHops = options.maxHops ?? 10;
    const beta = options.beta ?? 0.5;
    const topPaths = options.topPaths ?? 5;
    /** Псевдо-масс: цөөн барилдаанд 0/100% руу үсрэхээс сэргийлнэ (0 = сэлбэлтгүй). */
    const smooth = options.smooth ?? 0;
    /** Log-odds-ийг 0 руу татах коэффициент (1 = татахгүй). */
    const shrink = options.shrink ?? 1;
    const ia = this.index.get(a);
    const ib = this.index.get(b);
    const empty: ChainResult = { a, b, maxHops, beta, perHop: [], scoreAB: 0, scoreBA: 0, pA: 0.5, connected: false, topPathsAB: [], topPathsBA: [] };
    if (ia === undefined || ib === undefined || ia === ib) return empty;
    const ab = this.walk(ia, ib, maxHops, beta, topPaths);
    const ba = this.walk(ib, ia, maxHops, beta, topPaths);
    const perHop = ab.perHop.map((x, i) => ({ k: i + 1, ab: x, ba: ba.perHop[i] ?? 0 }));
    const scoreAB = perHop.reduce((s, h) => s + h.ab, 0);
    const scoreBA = perHop.reduce((s, h) => s + h.ba, 0);
    const connected = scoreAB + scoreBA > 0;
    let pA = 0.5;
    if (connected) {
      const logit = Math.log((scoreAB + smooth) / (scoreBA + smooth)) * shrink;
      pA = 1 / (1 + Math.exp(-logit));
    }
    return {
      a,
      b,
      maxHops,
      beta,
      perHop,
      scoreAB,
      scoreBA,
      pA,
      connected,
      topPathsAB: ab.paths,
      topPathsBA: ba.paths,
    };
  }

  // ── 3. Bradley–Terry ──

  /**
   * MM (Hunter 2004) — жинтэй ялалтууд. Тогтворжуулахын тулд бөх бүр
   * «хийсвэр дундаж бөх»-тэй `anchor` жинтэй 1 давалт, 1 алдагдалтай гэж үзнэ.
   * Буцаах: log-хүч s_i (дундаж 0). Elo масштаб = s·400/ln10.
   */
  bradleyTerry(options: { iterations?: number; anchor?: number } = {}): Float64Array {
    if (this.bt) return this.bt;
    const iterations = options.iterations ?? 80;
    const anchor = options.anchor ?? 0.5;
    const n = this.ids.length;
    // хосын нийт жин n_ij (симметрик) ба i-ийн жинтэй ялалт W_i
    const W = new Float64Array(n);
    const pairs: { i: number; j: number; w: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (const e of this.out[i]!) {
        W[i] = W[i]! + e.weight;
        pairs.push({ i, j: e.to, w: e.weight });
      }
    }
    let pi = new Float64Array(n).fill(1);
    for (let it = 0; it < iterations; it++) {
      const denom = new Float64Array(n);
      for (const p of pairs) {
        const s = p.w / (pi[p.i]! + pi[p.j]!);
        denom[p.i] = denom[p.i]! + s;
        denom[p.j] = denom[p.j]! + s;
      }
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        // anchor: 1 давалт (жин anchor) ба 1 алдагдал (жин anchor) хүч=1 бөхтэй
        const num = W[i]! + anchor;
        const den = denom[i]! + (2 * anchor) / (pi[i]! + 1);
        next[i] = den > 0 ? num / den : 1;
      }
      // геометр дундаж = 1 болгож хэвийн болгоно
      let logSum = 0;
      for (let i = 0; i < n; i++) logSum += Math.log(next[i]!);
      const scale = Math.exp(logSum / n);
      for (let i = 0; i < n; i++) next[i] = next[i]! / scale;
      pi = next;
    }
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.log(pi[i]!);
    this.bt = s;
    return s;
  }

  btStrength(id: string): number | undefined {
    const i = this.index.get(id);
    if (i === undefined) return undefined;
    return this.bradleyTerry()[i]!;
  }

  /** BT магадлал А>Б. Аль нэг нь байхгүй бол undefined. */
  btProbability(a: string, b: string): number | undefined {
    const sa = this.btStrength(a);
    const sb = this.btStrength(b);
    if (sa === undefined || sb === undefined) return undefined;
    return 1 / (1 + Math.exp(sb - sa));
  }

  /** BT-г Elo масштабад (400/ln10) — devjee-тэй харьцуулахад. */
  btElo(id: string, center = 1800): number | undefined {
    const s = this.btStrength(id);
    return s === undefined ? undefined : center + (s * 400) / Math.LN10;
  }
}

// ── 4. Elo replay ──

export interface EloReplayOptions {
  k?: number;
  /** Бөх бүрийн анхны рейтинг (цолын суурь өгөхөд ашиглана). */
  seed?: (id: string) => number;
  asOf?: string;
  excludeNoShow?: boolean;
}

/**
 * Барилдаануудыг огноогоор дараалуулан Elo тооцно (devjee: K=32).
 * Буцаах: id → рейтинг, мөн барилдаан бүрийн өмнөх таамаг (калибровкид).
 */
export function eloReplay(
  bouts: ArchiveBout[],
  options: EloReplayOptions = {},
): { ratings: Map<string, number>; predictions: { date: string; p1: number; won1: boolean }[]; games: Map<string, number>; lastDate: Map<string, string> } {
  const k = options.k ?? 32;
  const seed = options.seed ?? (() => 1500);
  const ratings = new Map<string, number>();
  const games = new Map<string, number>();
  const lastDate = new Map<string, string>();
  const predictions: { date: string; p1: number; won1: boolean }[] = [];
  const get = (id: string) => ratings.get(id) ?? seed(id);
  const excludeNoShow = options.excludeNoShow ?? true;
  const sorted = [...bouts]
    .filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 !== b.w2 && !(excludeNoShow && b.noShow) && (!options.asOf || b.date < options.asOf))
    .sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
  for (const b of sorted) {
    const r1 = get(b.w1);
    const r2 = get(b.w2);
    const p1 = winProbability(r1, r2);
    predictions.push({ date: b.date, p1, won1: b.winner === 1 });
    const [n1, n2] = updateRatings(r1, r2, b.winner === 1, k);
    ratings.set(b.w1, n1);
    ratings.set(b.w2, n2);
    games.set(b.w1, (games.get(b.w1) ?? 0) + 1);
    games.set(b.w2, (games.get(b.w2) ?? 0) + 1);
    lastDate.set(b.w1, b.date);
    lastDate.set(b.w2, b.date);
  }
  return { ratings, predictions, games, lastDate };
}

/** Архивын бөхийн цолын суурь рейтинг (devjee код → манай цол → суурь). */
export function seedFromArchive(wrestlers: Record<string, ArchiveWrestler>): (id: string) => number {
  return (id) => {
    const w = wrestlers[id];
    if (!w) return 1500;
    return seedRating(w.title ?? titleFromCode(w.titleCode));
  };
}

// ── 5. нэр хайх ──

export interface NameMatch {
  id: string;
  wrestler: ArchiveWrestler;
  bouts: number;
  score: number;
}

/**
 * «Орхонбаяр», «Б.Орхонбаяр», «Баярсайханы Орхонбаяр» гэх мэт оролтоор бөх олно.
 * Онооны эрэмбэ: яг таарсан нэр > эхлэл > агуулсан; дараа нь цол өндөр, барилдаан олон.
 */
export function findWrestlers(archive: Archive, query: string, counts?: Map<string, number>, limit = 8): NameMatch[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const bare = q.replace(/^[^.\s]{1,2}\./, ''); // «Б.Орхонбаяр» → «орхонбаяр»
  const out: NameMatch[] = [];
  for (const [id, w] of Object.entries(archive.wrestlers)) {
    const name = w.name.toLowerCase();
    const full = (w.fullName ?? '').toLowerCase();
    const first = name.replace(/^[^.\s]{1,2}\./, '');
    let score = 0;
    if (name === q || full === q) score = 100;
    else if (first === bare) score = 90;
    else if (name.startsWith(q) || first.startsWith(bare)) score = 70;
    else if (full.includes(q) || name.includes(q)) score = 50;
    if (score === 0) continue;
    const bouts = counts?.get(id) ?? 0;
    score += Math.min(9, w.titleCode / 3) + Math.min(9, Math.log10(bouts + 1) * 3);
    if (w.isInactive) score -= 5;
    out.push({ id, wrestler: w, bouts, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Бөх бүрийн барилдааны тоо (нэр хайлтын эрэмбэд). */
export function boutCounts(bouts: ArchiveBout[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bouts) {
    m.set(b.w1, (m.get(b.w1) ?? 0) + 1);
    m.set(b.w2, (m.get(b.w2) ?? 0) + 1);
  }
  return m;
}
