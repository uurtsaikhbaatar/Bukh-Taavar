/**
 * Симуляци — санамсаргүй тэмцээнүүд, шуугиантай итгэлтэй таагчид, LMSR зах зээл.
 *
 *   npm run sim -- [--tournaments 4] [--wrestlers 32] [--bettors 20] [--seed 42] [--b 2000]
 *
 * Шалгах зүйлс (команд бүрийн дараа):
 *  - Σ үлдэгдэл + хаусын кэш = Σ оруулсан (токен хадгалагдана), үлдэгдэл ≥ 0, магадлалын нийлбэр 1;
 *  - хаусын алдагдал зах зээл бүрд ≤ b·ln n (+ тоймлолт);
 * Хэмжих зүйлс:
 *  - загварын анхны магадлал vs зах зээлийн эцсийн үнэ — log-loss, Brier, калибровк;
 *  - таагчдын ашиг/алдагдлын тархалт (мэдлэгтэй нь давж байгаа эсэх);
 *  - хаусын нийт татаас.
 * Сүлжээгүй, детерминист (seed).
 */

import { Engine, EngineError } from '../src/engine.ts';
import { fmtPct, fmtTokens, table } from '../src/format.ts';
import { winProbability, type Title } from '../src/rating.ts';
import { MemoryLog } from '../src/store.ts';

// ── тохиргоо ──
function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
const N_TOURNAMENTS = arg('tournaments', 4);
const N_WRESTLERS = arg('wrestlers', 32);
const N_BETTORS = arg('bettors', 20);
const SEED = arg('seed', 42);
const B = arg('b', 2_000);
const ROUNDS = Math.round(Math.log2(N_WRESTLERS));
if (2 ** ROUNDS !== N_WRESTLERS) {
  console.error('--wrestlers 2-ын зэрэг байх ёстой (16, 32, 64, 128 …).');
  process.exit(1);
}

// ── RNG (mulberry32) ──
let seed = SEED >>> 0;
const rnd = (): number => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const gauss = (): number => {
  const u = 1 - rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ── орчин ──
let n = 0;
let t = Date.parse('2026-08-01T02:00:00.000Z');
const engine = new Engine(new MemoryLog(), {
  now: () => new Date(t),
  idGen: () => `s${++n}`,
  startingBalance: 10_000,
  defaultB: B,
});

interface SimWrestler {
  id: string;
  strength: number; // бодит хүч (үл мэдэгдэх)
}
const titleFor = (rank: number): Title =>
  rank < 2 ? 'улсын_аварга' : rank < 6 ? 'улсын_арслан' : rank < 12 ? 'улсын_заан' : rank < 20 ? 'улсын_начин' : 'аймгийн_заан';

const wrestlers: SimWrestler[] = [];
const strengths = Array.from({ length: N_WRESTLERS }, () => 2000 + 150 * gauss()).sort((a, b) => b - a);
strengths.forEach((s, i) => {
  const id = `w${i + 1}`;
  wrestlers.push({ id, strength: s });
  engine.addWrestler({ id, name: `Бөх-${String(i + 1).padStart(2, '0')}`, title: titleFor(i) });
  // «devjee» рейтинг = бодит хүч + загварын алдаа (σ=60)
  engine.setRating(id, s + 60 * gauss(), 'devjee', '2026-07-13');
});

interface Bettor {
  id: string;
  sigma: number; // итгэлийн шуугиан — бага = мэдлэгтэй
}
const bettors: Bettor[] = [];
for (let i = 0; i < N_BETTORS; i++) {
  const id = `u${i + 1}`;
  const sigma = 0.04 + (0.22 * i) / Math.max(1, N_BETTORS - 1);
  bettors.push({ id, sigma });
  engine.createUser({ id, name: `Таагч-${String(i + 1).padStart(2, '0')} (σ${sigma.toFixed(2)})` });
}

// ── хэмжилт ──
interface Sample {
  prior: number;
  market: number;
  outcome: 0 | 1;
}
const samples: Sample[] = [];
const houseLosses: number[] = [];
let boundViolations = 0;
let tradesTotal = 0;
let rejected = 0;

function invariants(): void {
  engine.checkInvariants();
}

function betRound(marketId: string, beliefs: Map<string, number[]>): void {
  // Санамсаргүй дарааллаар, хоёр удаа эргэнэ (үнэ хөдлөхөд дахин үзнэ)
  for (let pass = 0; pass < 2; pass++) {
    const order = [...bettors].sort(() => rnd() - 0.5);
    for (const b of order) {
      const probs = engine.probabilities(marketId);
      const belief = beliefs.get(b.id)!;
      // хамгийн их зөрүүтэй үр дүн
      let best = -1;
      let bestEdge = 0;
      probs.forEach((p, i) => {
        const edge = belief[i]! - p;
        if (edge > bestEdge) {
          bestEdge = edge;
          best = i;
        }
      });
      if (best < 0 || bestEdge < 0.03) continue;
      const balance = engine.balance(b.id);
      // Kelly-маягийн хэмжээ: зөрүү их бол их, гэхдээ үлдэгдлийн 10%-иас хэтрэхгүй
      const spend = clip(Math.round(balance * Math.min(0.1, bestEdge * 0.8)), 10, balance);
      if (spend < 10) continue;
      try {
        engine.buy(b.id, marketId, best, spend);
        tradesTotal += 1;
      } catch (e) {
        if (e instanceof EngineError && (e.code === 'INSUFFICIENT' || e.code === 'MIN_BET')) rejected += 1;
        else throw e;
      }
      invariants();
    }
  }
  // Заримдаа зарна (ашиг авах)
  for (const b of bettors) {
    if (rnd() > 0.15) continue;
    const pos = engine.market(marketId).positions.get(b.id);
    if (!pos) continue;
    const i = pos.findIndex((s) => s > 1);
    if (i < 0) continue;
    try {
      engine.sell(b.id, marketId, i, pos[i]! / 2);
      tradesTotal += 1;
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
    }
    invariants();
  }
}

/** Монте-Карло: загварын рейтингээр тэмцээний аварга бүрийн магадлал. */
function championPrior(ids: string[], sims: number, ratingOf: (id: string) => number): Map<string, number> {
  const wins = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let s = 0; s < sims; s++) {
    let alive = [...ids];
    while (alive.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < alive.length / 2; i++) {
        const a = alive[i]!;
        const b = alive[alive.length - 1 - i]!;
        const pA = winProbability(ratingOf(a), ratingOf(b));
        next.push(rnd() < pA ? a : b);
      }
      alive = next;
    }
    wins.set(alive[0]!, wins.get(alive[0]!)! + 1);
  }
  return new Map([...wins].map(([id, w]) => [id, w / sims]));
}

const t0 = performance.now();
for (let tour = 1; tour <= N_TOURNAMENTS; tour++) {
  const tid = `t${tour}`;
  const date = `2026-08-${String(tour + 1).padStart(2, '0')}`;
  engine.createTournament({ id: tid, name: `Симуляцийн наадам ${tour}`, date, rounds: ROUNDS });

  // Аваргын зах зээл: рейтингээр эхний 8 + Бусад
  const byRating = [...wrestlers].sort((a, b) => engine.rating(b.id).rating - engine.rating(a.id).rating);
  const top = byRating.slice(0, 8).map((w) => w.id);
  const modelPrior = championPrior(wrestlers.map((w) => w.id), 300, (id) => engine.rating(id).rating);
  const priorTop = top.map((id) => modelPrior.get(id)!);
  const priorOther = Math.max(0.01, 1 - priorTop.reduce((a, c) => a + c, 0));
  const champ = engine.createMarket({
    id: `${tid}-champ`,
    title: `Наадам ${tour} — аварга хэн болох`,
    outcomes: [...top.map((id) => engine.wrestler(id).name), 'Бусад'],
    outcomeRefs: [...top, null],
    prior: [...priorTop, priorOther],
    b: B * 2,
    tournamentId: tid,
  });
  const truePrior = championPrior(wrestlers.map((w) => w.id), 300, (id) => wrestlers.find((w) => w.id === id)!.strength);
  const champBeliefs = new Map<string, number[]>();
  for (const b of bettors) {
    const raw = [...top.map((id) => truePrior.get(id)!), Math.max(0.01, 1 - top.reduce((s, id) => s + truePrior.get(id)!, 0))].map((p) =>
      clip(p + b.sigma * 0.5 * gauss(), 0.005, 0.95),
    );
    const s = raw.reduce((a, c) => a + c, 0);
    champBeliefs.set(b.id, raw.map((p) => p / s));
  }
  betRound(champ.id, champBeliefs);

  // Даваанууд: зэрэг дэвээр хослуулна (дээд нь доодтойгоо — «ам авах» шиг)
  let alive = [...wrestlers].sort((a, b) => engine.rating(b.id).rating - engine.rating(a.id).rating).map((w) => w.id);
  for (let round = 1; round <= ROUNDS; round++) {
    const winners: string[] = [];
    const bouts: { boutId: string; marketId: string; a: string; b: string; pTrue: number }[] = [];
    for (let i = 0; i < alive.length / 2; i++) {
      const a = alive[i]!;
      const b = alive[alive.length - 1 - i]!;
      const { bout, market } = engine.createBout({ tournamentId: tid, round, aId: a, bId: b, scheduledAt: new Date(t + 30 * 60_000).toISOString() });
      const sa = wrestlers.find((w) => w.id === a)!.strength;
      const sb = wrestlers.find((w) => w.id === b)!.strength;
      bouts.push({ boutId: bout.id, marketId: market!.id, a, b, pTrue: winProbability(sa, sb) });
    }
    // 1) Таагчид давааны бүх барилдаанд таавраа тавина
    const priced: { bt: (typeof bouts)[number]; prior: number; market: number }[] = [];
    for (const bt of bouts) {
      const beliefs = new Map<string, number[]>();
      for (const b of bettors) {
        const pa = clip(bt.pTrue + b.sigma * gauss(), 0.02, 0.98);
        beliefs.set(b.id, [pa, 1 - pa]);
      }
      const prior = engine.probabilities(bt.marketId)[0]!;
      betRound(bt.marketId, beliefs);
      priced.push({ bt, prior, market: engine.probabilities(bt.marketId)[0]! });
    }
    // 2) Хаагдах цаг өнгөрнө; барилдаанууд болж, үр дүн бүртгэгдэнэ
    t += 31 * 60_000;
    for (const { bt, prior, market } of priced) {
      const aWins = rnd() < bt.pTrue;
      samples.push({ prior, market, outcome: aWins ? 1 : 0 });
      const winner = aWins ? bt.a : bt.b;
      engine.recordBoutResult(bt.boutId, winner);
      invariants();
      const m = engine.market(bt.marketId);
      const loss = -m.houseCash;
      houseLosses.push(loss);
      const bound = engine.marketView(bt.marketId).maxHouseLoss; // b·ln(1/p0_min)
      if (loss > bound + 0.5 * m.positions.size + 1) boundViolations += 1;
      winners.push(winner);
    }
    alive = winners;
    t += 60 * 60_000;
  }
  const championId = alive[0]!;
  const idx = top.indexOf(championId);
  engine.resolveMarket(champ.id, idx >= 0 ? idx : top.length);
  invariants();
  const cm = engine.market(champ.id);
  if (-cm.houseCash > engine.marketView(champ.id).maxHouseLoss + 0.5 * cm.positions.size + 1) boundViolations += 1;
}
const elapsed = performance.now() - t0;

// ── тайлан ──
const logloss = (get: (s: Sample) => number) =>
  samples.reduce((acc, s) => {
    const p = clip(get(s), 1e-6, 1 - 1e-6);
    return acc - (s.outcome ? Math.log(p) : Math.log(1 - p));
  }, 0) / samples.length;
const brier = (get: (s: Sample) => number) => samples.reduce((acc, s) => acc + (get(s) - s.outcome) ** 2, 0) / samples.length;

console.log(`\nСимуляци: ${N_TOURNAMENTS} тэмцээн × ${N_WRESTLERS} бөх, ${N_BETTORS} таагч, b=${B}, seed=${SEED} — ${(elapsed / 1000).toFixed(1)} сек`);
console.log(`Зах зээл: ${engine.markets().length} · арилжаа: ${tradesTotal} (татгалзсан ${rejected}) · үйл явдал: ${engine.state.eventCount}`);
console.log(`\nТаамаглалын чанар (${samples.length} барилдаан, санамсаргүй = 0.693):`);
console.log(
  table(
    ['Эх сурвалж', 'log-loss', 'Brier'],
    [
      ['Загварын анхны магадлал (Elo)', logloss((s) => s.prior).toFixed(4), brier((s) => s.prior).toFixed(4)],
      ['Зах зээлийн эцсийн үнэ', logloss((s) => s.market).toFixed(4), brier((s) => s.market).toFixed(4)],
    ],
  ),
);

const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, o: 0 }));
for (const s of samples) {
  const b = Math.min(9, Math.floor(s.market * 10));
  bins[b]!.n += 1;
  bins[b]!.p += s.market;
  bins[b]!.o += s.outcome;
}
console.log('\nЗах зээлийн үнийн калибровк:');
console.log(
  table(
    ['Үнэ', 'n', 'Дундаж үнэ', 'Бодит'],
    bins.map((b, i) => [`${i * 10}–${i * 10 + 9}%`, String(b.n), b.n ? fmtPct(b.p / b.n) : '—', b.n ? fmtPct(b.o / b.n) : '—']),
  ),
);

const totalLoss = houseLosses.reduce((a, c) => a + c, 0);
console.log(
  `\nХаус: нийт үр дүн ${fmtTokens(-engine.houseSummary().cash)} токен (эерэг = таагчдад татаас); барилдааны зах зээл бүрийн дундаж ${fmtTokens(totalLoss / houseLosses.length)}, хамгийн их ${fmtTokens(Math.max(...houseLosses))}; хязгаар b·ln(1/p₀) зөрчсөн: ${boundViolations}`,
);

const lb = engine.leaderboard();
console.log('\nСамбар (эхний 5 ба сүүлийн 3) — мэдлэгтэй (σ бага) таагч дээгүүр байх ёстой:');
console.log(
  table(
    ['#', 'Таагч', 'Нийт', 'Ашиг/алдагдал'],
    [...lb.slice(0, 5), ...lb.slice(-3)].map((r) => [String(r.rank), r.name, Math.round(r.total), Math.round(r.pnl)]),
  ),
);
const corr = (() => {
  const xs = lb.map((r) => bettors.find((b) => b.id === r.userId)!.sigma);
  const ys = lb.map((r) => r.pnl);
  const mx = xs.reduce((a, c) => a + c, 0) / xs.length;
  const my = ys.reduce((a, c) => a + c, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  });
  return sxy / Math.sqrt(sxx * syy);
})();
console.log(`σ (шуугиан) ба ашгийн корреляци: ${corr.toFixed(2)} (сөрөг = мэдлэг шагнагдаж байна)`);

invariants();
if (boundViolations > 0) {
  console.error('\n✖ Хаусын алдагдлын хязгаар зөрчигдсөн!');
  process.exit(1);
}
console.log('\n✔ Инвариант бүгд биелэв: токен хадгалагдсан, үлдэгдэл ≥ 0, магадлал нийлбэр 1, хаусын алдагдал хязгаарт.');
