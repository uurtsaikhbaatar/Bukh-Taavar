/**
 * Engine — командууд, зах зээлийн мөчлөг, токены дэвтэр.
 *
 * Бүх өөрчлөлт: команд → баталгаажуулалт → тоо бодох (LMSR/Elo) → үйл явдал
 * (лог руу append) → reducer. Тоо бүр үйл явдалд бичигдэнэ (state.ts-ийг үз).
 *
 * Тоймлолтын дүрэм (токен бүхэл, хувь бутархай):
 *  - Авах: зарцуулалт S бүхэл ≥ minBet; хувь = LMSR (бутархай).
 *  - Зарах: орлого = floor(LMSR өртөг) — хэрэглэгчийн эсрэг доош тоймлоно.
 *  - Шийдвэр: төлбөр = round(хувь).
 *  - Хүчингүй: цэвэр зарцуулалт (авсан − зарсан) > 0 бол бүтнээр буцаана.
 *
 * Ганц процесс, командууд дараалан → зэрэгцээ бичилтийн асуудалгүй.
 */

import { randomUUID } from 'node:crypto';

import type {
  Bout,
  BoutId,
  Coupon,
  CouponKind,
  CouponLeg,
  Toto,
  LedgerEntry,
  Market,
  MarketId,
  MarketKind,
  MarketRule,
  RatingSource,
  Role,
  Tournament,
  TournamentId,
  TradeRecord,
  User,
  UserId,
  Wrestler,
  WrestlerId,
} from './domain.ts';
import type { BukhEvent } from './events.ts';
import { costToBuy, initialQuantities, maxLossFromInitial, prices, sharesForSpend } from './lmsr.ts';
import { DEFAULT_K, isTitle, seedRating, updateRatings, winProbability } from './rating.ts';
import { apply, emptyState, type State } from './state.ts';
import type { EventLog } from './store.ts';

export class EngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface EngineOptions {
  /** Цаг — тестэд тогтмол өгнө. */
  now?: () => Date;
  /** Id үүсгэгч — тестэд дараалсан өгнө. */
  idGen?: () => string;
  /** Шинэ хэрэглэгчийн эхлэлийн токен. */
  startingBalance?: number;
  /** Зах зээлийн анхдагч хөрвөх чадвар b. */
  defaultB?: number;
  /** Хамгийн бага бооцоо (токен). */
  minBet?: number;
  /** Нэг зах зээлийн үр дүнгийн дээд тоо. */
  maxOutcomes?: number;
  /** Elo K. */
  eloK?: number;
  /** Нэг арилжааны дээд бооцоо (токен). */
  maxBet?: number;
  /** Купоны дээд бооцоо. */
  maxCouponStake?: number;
  /** Купоны нэг хослолын давалтын дээд үржүүлэгч (× unit stake). */
  maxCouponMultiplier?: number;
  /** Купоны дээд сонголт. */
  maxCouponLegs?: number;
}

interface ResolvedOptions {
  now: () => Date;
  idGen: () => string;
  startingBalance: number;
  defaultB: number;
  minBet: number;
  maxOutcomes: number;
  eloK: number;
  maxBet: number;
  maxCouponStake: number;
  maxCouponMultiplier: number;
  maxCouponLegs: number;
}

export const DEFAULTS: Omit<ResolvedOptions, 'now' | 'idGen'> = {
  startingBalance: 10_000,
  defaultB: 2_000,
  minBet: 10,
  maxOutcomes: 64,
  eloK: DEFAULT_K,
  maxBet: 5_000,
  maxCouponStake: 5_000,
  maxCouponMultiplier: 100,
  maxCouponLegs: 8,
};

export interface CouponQuote {
  kind: CouponKind;
  legs: CouponLeg[];
  stake: number;
  sizes: number[];
  combos: number;
  unitStake: number;
  /** Экспресс: коэффициент (Π 1/p, таазтай). */
  coefficient: number;
  /** Бүх сонголт таарвал авах дээд төлбөр. */
  maxPayout: number;
  capped: boolean;
}

export interface BuyQuote {
  marketId: MarketId;
  outcome: number;
  spend: number;
  shares: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  /** Давбал авах токен (round(shares)). */
  payoutIfWin: number;
  /** payoutIfWin / spend. */
  multiplier: number;
}

export interface SellQuote {
  marketId: MarketId;
  outcome: number;
  shares: number;
  proceeds: number;
  priceBefore: number;
  priceAfter: number;
}

export interface MarketView {
  id: MarketId;
  kind: MarketKind;
  title: string;
  status: Market['status'];
  outcomes: string[];
  outcomeRefs: (string | null)[];
  probs: number[];
  b: number;
  volume: number;
  tradeCount: number;
  traders: number;
  houseCash: number;
  maxHouseLoss: number;
  createdAt: string;
  closesAt?: string;
  resolvedOutcome?: number;
  voidReason?: string;
  boutId?: BoutId;
  tournamentId?: TournamentId;
}

export interface PositionView {
  marketId: MarketId;
  title: string;
  status: Market['status'];
  outcome: number;
  outcomeLabel: string;
  shares: number;
  price: number;
  /** Одоогийн үнэлгээ = shares × price (нээлттэй бол), шийдэгдсэн бол төлбөр. */
  value: number;
  netCost: number;
}

export interface LeaderboardRow {
  rank: number;
  userId: UserId;
  name: string;
  balance: number;
  positionsValue: number;
  total: number;
  contributed: number;
  pnl: number;
}

export interface BoutPrior {
  aId: WrestlerId;
  bId: WrestlerId;
  ratingA: number;
  ratingB: number;
  sourceA: RatingSource;
  sourceB: RatingSource;
  pA: number;
  pB: number;
}

const EPS = 1e-9;

export class Engine {
  readonly state: State;
  private readonly log: EventLog;
  private readonly opts: ResolvedOptions;

  constructor(log: EventLog, options: EngineOptions = {}) {
    this.log = log;
    this.opts = {
      now: options.now ?? (() => new Date()),
      idGen: options.idGen ?? (() => randomUUID()),
      startingBalance: options.startingBalance ?? DEFAULTS.startingBalance,
      defaultB: options.defaultB ?? DEFAULTS.defaultB,
      minBet: options.minBet ?? DEFAULTS.minBet,
      maxOutcomes: options.maxOutcomes ?? DEFAULTS.maxOutcomes,
      eloK: options.eloK ?? DEFAULTS.eloK,
      maxBet: options.maxBet ?? DEFAULTS.maxBet,
      maxCouponStake: options.maxCouponStake ?? DEFAULTS.maxCouponStake,
      maxCouponMultiplier: options.maxCouponMultiplier ?? DEFAULTS.maxCouponMultiplier,
      maxCouponLegs: options.maxCouponLegs ?? DEFAULTS.maxCouponLegs,
    };
    this.state = emptyState();
    for (const e of log.readAll()) apply(this.state, e);
  }

  // ───────────────────────── дотоод туслахууд ─────────────────────────

  private nowIso(): string {
    return this.opts.now().toISOString();
  }

  private stamp(): { id: string; at: string } {
    return { id: this.opts.idGen(), at: this.nowIso() };
  }

  /** Төлөвт хэрэгжүүлээд логд бичнэ. Reducer татгалзвал лог бохирдохгүй. */
  private emit(e: BukhEvent): void {
    apply(this.state, e);
    this.log.append(e);
  }

  private requireUser(userId: UserId): User {
    const u = this.state.users.get(userId);
    if (!u) throw new EngineError('USER_NOT_FOUND', `Хэрэглэгч олдсонгүй: ${userId}`);
    return u;
  }

  private requireWrestler(id: WrestlerId): Wrestler {
    const w = this.state.wrestlers.get(id);
    if (!w) throw new EngineError('WRESTLER_NOT_FOUND', `Бөх олдсонгүй: ${id}`);
    return w;
  }

  private requireTournament(id: TournamentId): Tournament {
    const t = this.state.tournaments.get(id);
    if (!t) throw new EngineError('TOURNAMENT_NOT_FOUND', `Тэмцээн олдсонгүй: ${id}`);
    return t;
  }

  private requireBout(id: BoutId): Bout {
    const b = this.state.bouts.get(id);
    if (!b) throw new EngineError('BOUT_NOT_FOUND', `Барилдаан олдсонгүй: ${id}`);
    return b;
  }

  private requireMarket(id: MarketId): Market {
    const m = this.state.markets.get(id);
    if (!m) throw new EngineError('MARKET_NOT_FOUND', `Зах зээл олдсонгүй: ${id}`);
    return m;
  }

  private requireOutcome(market: Market, outcome: number): void {
    if (!Number.isInteger(outcome) || outcome < 0 || outcome >= market.outcomes.length) {
      throw new EngineError('BAD_OUTCOME', `Үр дүнгийн дугаар буруу: ${outcome}`);
    }
  }

  /** Хугацаа нь дууссан бол хаана; нээлттэй биш бол алдаа. */
  private ensureTradable(market: Market): void {
    if (market.status === 'open' && market.closesAt !== undefined) {
      if (Date.parse(market.closesAt) <= this.opts.now().getTime()) {
        this.emit({ ...this.stamp(), type: 'market_closed', marketId: market.id });
      }
    }
    if (market.status !== 'open') {
      throw new EngineError('MARKET_CLOSED', `Зах зээл нээлттэй биш (${market.status}): ${market.title}`);
    }
  }

  private newId(given?: string): string {
    if (given !== undefined) {
      if (given.trim() === '') throw new EngineError('BAD_ID', 'Id хоосон байж болохгүй.');
      return given;
    }
    return this.opts.idGen();
  }

  private static cleanName(name: string, what: string): string {
    const n = name.trim();
    if (n.length === 0) throw new EngineError('BAD_NAME', `${what} хоосон байж болохгүй.`);
    return n;
  }

  private static assertInteger(value: number, what: string): void {
    if (!Number.isInteger(value)) throw new EngineError('NOT_INTEGER', `${what} бүхэл тоо байх ёстой.`);
  }

  // ───────────────────────── хэрэглэгч, токен ─────────────────────────

  createUser(input: { id?: string; name: string; role?: Role; balance?: number }): User {
    const id = this.newId(input.id);
    if (this.state.users.has(id)) throw new EngineError('DUPLICATE', `Хэрэглэгч аль хэдийн бий: ${id}`);
    const name = Engine.cleanName(input.name, 'Нэр');
    const balance = input.balance ?? this.opts.startingBalance;
    Engine.assertInteger(balance, 'Эхлэлийн токен');
    if (balance < 0) throw new EngineError('BAD_AMOUNT', 'Эхлэлийн токен сөрөг байж болохгүй.');
    this.emit({ ...this.stamp(), type: 'user_created', userId: id, name, role: input.role ?? 'member', balance });
    return this.requireUser(id);
  }

  /**
   * Өдөр тутмын урамшуулал: үлдэгдэл багатай хүнд өдөрт нэг удаа токен нэмнэ.
   * Сүүлийн олголтоос хойш 20 цаг өнгөрсөн ба үлдэгдэл `below`-оос доош бол.
   * Буцаах: олгосон дүн (0 = олгоогүй).
   */
  claimDailyBonus(userId: UserId, options: { amount?: number; below?: number; hours?: number } = {}): number {
    const user = this.requireUser(userId);
    const amount = options.amount ?? 200;
    const below = options.below ?? 5_000;
    const hours = options.hours ?? 20;
    if (user.balance >= below) return 0;
    const cutoff = this.opts.now().getTime() - hours * 3_600_000;
    for (let i = this.state.ledger.length - 1; i >= 0; i--) {
      const l = this.state.ledger[i]!;
      if (l.userId !== userId || l.kind !== 'grant' || l.note !== 'Өдөр тутмын урамшуулал') continue;
      if (Date.parse(l.at) > cutoff) return 0;
      break;
    }
    this.grantTokens(userId, amount, 'Өдөр тутмын урамшуулал');
    return amount;
  }

  grantTokens(userId: UserId, amount: number, reason: string): number {
    const user = this.requireUser(userId);
    Engine.assertInteger(amount, 'Хэмжээ');
    if (amount <= 0) throw new EngineError('BAD_AMOUNT', 'Хэмжээ эерэг байх ёстой.');
    this.emit({
      ...this.stamp(),
      type: 'tokens_granted',
      userId,
      amount,
      reason: reason.trim() || 'олголт',
      balanceAfter: user.balance + amount,
    });
    return user.balance;
  }

  user(userId: UserId): User {
    return this.requireUser(userId);
  }

  balance(userId: UserId): number {
    return this.requireUser(userId).balance;
  }

  users(): User[] {
    return [...this.state.users.values()];
  }

  // ───────────────────────── бөх, рейтинг ─────────────────────────

  addWrestler(input: Omit<Wrestler, 'id'> & { id?: string }): Wrestler {
    const id = this.newId(input.id);
    if (this.state.wrestlers.has(id)) throw new EngineError('DUPLICATE', `Бөх аль хэдийн бий: ${id}`);
    if (!isTitle(input.title)) throw new EngineError('BAD_TITLE', `Танигдаагүй цол: ${String(input.title)}`);
    const wrestler: Wrestler = { ...input, id, name: Engine.cleanName(input.name, 'Бөхийн нэр') };
    for (const k of Object.keys(wrestler) as (keyof Wrestler)[]) {
      if (wrestler[k] === undefined) delete wrestler[k];
    }
    this.emit({ ...this.stamp(), type: 'wrestler_added', wrestler });
    return this.requireWrestler(id);
  }

  updateWrestler(id: WrestlerId, patch: Partial<Omit<Wrestler, 'id'>>): Wrestler {
    this.requireWrestler(id);
    if (patch.title !== undefined && !isTitle(patch.title)) {
      throw new EngineError('BAD_TITLE', `Танигдаагүй цол: ${String(patch.title)}`);
    }
    if (patch.name !== undefined) patch = { ...patch, name: Engine.cleanName(patch.name, 'Бөхийн нэр') };
    this.emit({ ...this.stamp(), type: 'wrestler_updated', wrestlerId: id, patch });
    return this.requireWrestler(id);
  }

  wrestler(id: WrestlerId): Wrestler {
    return this.requireWrestler(id);
  }

  wrestlers(): Wrestler[] {
    return [...this.state.wrestlers.values()];
  }

  /** devjee id-аар бөх хайх. */
  wrestlerByDevjeeId(devjeeId: string): Wrestler | undefined {
    for (const w of this.state.wrestlers.values()) if (w.devjeeId === devjeeId) return w;
    return undefined;
  }

  setRating(wrestlerId: WrestlerId, rating: number, source: RatingSource, asOf?: string): void {
    this.requireWrestler(wrestlerId);
    if (!Number.isFinite(rating)) throw new EngineError('BAD_RATING', 'Рейтинг тоо байх ёстой.');
    this.emit({ ...this.stamp(), type: 'rating_set', wrestlerId, rating, source, asOf: asOf ?? this.nowIso().slice(0, 10) });
  }

  /** Бөхийн рейтинг: тогтоосон бол тэр, үгүй бол цолын суурь. */
  rating(wrestlerId: WrestlerId): { rating: number; source: RatingSource; asOf?: string } {
    const w = this.requireWrestler(wrestlerId);
    const r = this.state.ratings.get(wrestlerId);
    if (r) return { rating: r.rating, source: r.source, asOf: r.asOf };
    return { rating: seedRating(w.title), source: 'seed' };
  }

  /** Хоёр бөхийн барилдааны загварын магадлал (Elo). */
  priorForBout(aId: WrestlerId, bId: WrestlerId): BoutPrior {
    const a = this.rating(aId);
    const b = this.rating(bId);
    const pA = winProbability(a.rating, b.rating);
    return { aId, bId, ratingA: a.rating, ratingB: b.rating, sourceA: a.source, sourceB: b.source, pA, pB: 1 - pA };
  }

  // ───────────────────────── тэмцээн, барилдаан ─────────────────────────

  createTournament(input: Omit<Tournament, 'id'> & { id?: string }): Tournament {
    const id = this.newId(input.id);
    if (this.state.tournaments.has(id)) throw new EngineError('DUPLICATE', `Тэмцээн аль хэдийн бий: ${id}`);
    if (!Number.isInteger(input.rounds) || input.rounds < 1) throw new EngineError('BAD_ROUNDS', 'Давааны тоо ≥ 1.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new EngineError('BAD_DATE', 'Огноо YYYY-MM-DD хэлбэртэй байх ёстой.');
    const tournament: Tournament = { ...input, id, name: Engine.cleanName(input.name, 'Тэмцээний нэр') };
    for (const k of Object.keys(tournament) as (keyof Tournament)[]) {
      if (tournament[k] === undefined) delete tournament[k];
    }
    this.emit({ ...this.stamp(), type: 'tournament_created', tournament });
    return this.requireTournament(id);
  }

  tournament(id: TournamentId): Tournament {
    return this.requireTournament(id);
  }

  tournaments(): Tournament[] {
    return [...this.state.tournaments.values()];
  }

  updateTournament(id: TournamentId, patch: Partial<Omit<Tournament, 'id'>>): Tournament {
    this.requireTournament(id);
    if (patch.name !== undefined) patch = { ...patch, name: Engine.cleanName(patch.name, 'Тэмцээний нэр') };
    if (patch.rounds !== undefined && (!Number.isInteger(patch.rounds) || patch.rounds < 1)) throw new EngineError('BAD_ROUNDS', 'Давааны тоо ≥ 1.');
    if (patch.entrants) for (const w of patch.entrants) this.requireWrestler(w);
    this.emit({ ...this.stamp(), type: 'tournament_updated', tournamentId: id, patch });
    return this.requireTournament(id);
  }

  /**
   * Тэмцээний явц: бөх бүрийн давсан тоо, унасан эсэх, аварга, дууссан эсэх.
   * Гоц (ирээгүй) барилдааны давагч ч даваа давсанд тооцогдоно.
   */
  tournamentProgress(tournamentId: TournamentId): {
    wins: Map<WrestlerId, number>;
    eliminated: Map<WrestlerId, number>;
    participated: Set<WrestlerId>;
    championId?: WrestlerId;
    finished: boolean;
    entrants: WrestlerId[];
  } {
    const t = this.requireTournament(tournamentId);
    const wins = new Map<WrestlerId, number>();
    const eliminated = new Map<WrestlerId, number>();
    const participated = new Set<WrestlerId>();
    let championId: WrestlerId | undefined;
    const bouts = this.bouts(tournamentId);
    for (const b of bouts) {
      participated.add(b.aId);
      participated.add(b.bId);
      if (!b.result) continue;
      wins.set(b.result.winnerId, (wins.get(b.result.winnerId) ?? 0) + 1);
    }
    for (const b of bouts) {
      if (!b.result) continue;
      const loser = b.result.winnerId === b.aId ? b.bId : b.aId;
      eliminated.set(loser, wins.get(loser) ?? 0);
    }
    // Аварга = сүүлийн давааны барилдаанд давсан, унаагүй бөх (сүүлийн даваанд нэмэлт — жишээ нь
    // 3-р байрын/цолын — барилдаан байж болно; тэнд давсан ч унасан бол аварга биш).
    for (const b of bouts) {
      if (!b.result || b.round !== t.rounds) continue;
      const w = b.result.winnerId;
      if (!eliminated.has(w) || championId === undefined) championId = w;
      if (!eliminated.has(w)) break;
    }
    const entrants = t.entrants && t.entrants.length ? t.entrants : [...participated];
    const out: ReturnType<Engine['tournamentProgress']> = { wins, eliminated, participated, finished: championId !== undefined, entrants };
    if (championId) out.championId = championId;
    return out;
  }

  // ── даваа удирдах (админ: эхлүүлэх / дуусгах) ──

  /**
   * Давааны төлөв: даваа бүрийн барилдааны тоо ба хүлээгдэж буй, одоо явж буй даваа,
   * дараагийн эхлүүлж болох даваа (0 = боломжгүй), амьд үлдсэн бөхийн тоо.
   */
  roundStatus(tournamentId: TournamentId): {
    rounds: number;
    perRound: { round: number; total: number; pending: number }[];
    /** Хамгийн сүүлд эхэлсэн даваа (0 = нэг ч даваа эхлээгүй). */
    current: number;
    /** Дараагийн эхлүүлж болох даваа; 0 = одоогийнх дуусаагүй эсвэл тэмцээн дууссан. */
    next: number;
    /** Унаагүй (амьд) бөхийн тоо. */
    alive: number;
    entrants: number;
    finished: boolean;
    championId?: WrestlerId;
  } {
    const t = this.requireTournament(tournamentId);
    const p = this.tournamentProgress(tournamentId);
    const bouts = this.bouts(tournamentId);
    const perRound: { round: number; total: number; pending: number }[] = [];
    let current = 0;
    for (let r = 1; r <= t.rounds; r++) {
      const list = bouts.filter((b) => b.round === r);
      const pending = list.filter((b) => !b.result).length;
      perRound.push({ round: r, total: list.length, pending });
      if (list.length) current = r;
    }
    const currentPending = current ? perRound[current - 1]!.pending : 0;
    let next = 0;
    if (!p.finished) {
      if (current === 0) next = 1;
      else if (currentPending === 0 && current < t.rounds) next = current + 1;
    }
    const alive = p.entrants.filter((id) => !p.eliminated.has(id)).length;
    const out: ReturnType<Engine['roundStatus']> = { rounds: t.rounds, perRound, current, next, alive, entrants: p.entrants.length, finished: p.finished };
    if (p.championId) out.championId = p.championId;
    return out;
  }

  /**
   * Давааг эхлүүлнэ: амьд үлдсэн бөхчүүдийг хослуулж барилдаан (+ зах зээл) үүсгэнэ.
   * Хослол: `rank` (анхдагч) — зэрэглэлээр эрэмбэлж дээд хагас нь доод хагастай (1↔n/2+1 …),
   * наадмын оноолт шиг; `random` — санамсаргүй; `seq` — 1↔2, 3↔4.
   * Сондгой тоотой бол хамгийн дээд зэрэглэлийн бөх гоц (шууд дараагийн даваанд).
   * Зөвхөн дараагийн ээлжит давааг л эхлүүлнэ (өмнөх нь бүрэн дууссан байх).
   */
  startRound(
    tournamentId: TournamentId,
    round: number,
    options: { pairing?: 'rank' | 'random' | 'seq'; rng?: () => number; withMarket?: boolean; b?: number } = {},
  ): { round: number; bouts: Bout[]; markets: Market[]; byes: WrestlerId[] } {
    const t = this.requireTournament(tournamentId);
    const st = this.roundStatus(tournamentId);
    if (st.finished) throw new EngineError('FINISHED', 'Тэмцээн дууссан — аварга тодорсон.');
    if (round !== st.next) {
      if (st.next === 0) throw new EngineError('ROUND_PENDING', `${st.current}-р даваа дуусаагүй байна (хүлээгдэж буй барилдаан бий).`);
      throw new EngineError('BAD_ROUND', `Дараагийн даваа ${st.next} байх ёстой (${round} биш).`);
    }
    const p = this.tournamentProgress(tournamentId);
    let pool = p.entrants.filter((id) => !p.eliminated.has(id));
    if (round > 1) {
      const prev = this.bouts(tournamentId).filter((b) => b.round === round - 1);
      const winners = new Set(prev.map((b) => b.result!.winnerId));
      const took = new Set(prev.flatMap((b) => [b.aId, b.bId]));
      // Өмнөх даваанд давсан, эсвэл гоц (барилдаагүй) бөх л үргэлжилнэ
      pool = pool.filter((id) => winners.has(id) || !took.has(id));
    }
    if (pool.length < 2) throw new EngineError('NO_ENTRANTS', round === 1 ? 'Оролцогчдын жагсаалт хэрэгтэй (дор хаяж 2 бөх) — тэмцээний entrants тавь.' : 'Хослуулах бөх хүрэлцэхгүй.');
    const rank = new Map(p.entrants.map((id, i) => [id, i]));
    const byEntrants = !!(t.entrants && t.entrants.length);
    pool.sort((a, b) => (byEntrants ? rank.get(a)! - rank.get(b)! : this.rating(b).rating - this.rating(a).rating));
    const byes: WrestlerId[] = [];
    if (pool.length % 2 === 1) byes.push(pool.shift()!);
    const pairing = options.pairing ?? 'rank';
    const pairs: [WrestlerId, WrestlerId][] = [];
    if (pairing === 'random') {
      const rng = options.rng ?? Math.random;
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      for (let i = 0; i < pool.length; i += 2) pairs.push([pool[i]!, pool[i + 1]!]);
    } else if (pairing === 'seq') {
      for (let i = 0; i < pool.length; i += 2) pairs.push([pool[i]!, pool[i + 1]!]);
    } else {
      const half = pool.length / 2;
      for (let i = 0; i < half; i++) pairs.push([pool[i]!, pool[i + half]!]);
    }
    const bouts: Bout[] = [];
    const markets: Market[] = [];
    for (const [aId, bId] of pairs) {
      const input: Parameters<Engine['createBout']>[0] = { tournamentId, round, aId, bId, withMarket: options.withMarket ?? true };
      if (options.b !== undefined) input.b = options.b;
      const r = this.createBout(input);
      bouts.push(r.bout);
      if (r.market) markets.push(r.market);
    }
    return { round, bouts, markets, byes };
  }

  /**
   * Давааг дуусгана: хүлээгдэж буй бүх барилдааны үр дүнг бүртгэнэ.
   * `simulate` (анхдагч) — давсан бөхийг загварын (Elo) магадлалаар санамсаргүй сугална (туршилт);
   * `favorite` — рейтинг өндөр нь давна. Үр дүн бүр `recordBoutResult`-ээр орно (зах зээл шийдэгдэж,
   * дүрэмт зах зээл/тото автоматаар тооцогдоно, Elo шинэчлэгдэнэ).
   */
  finishRound(
    tournamentId: TournamentId,
    round: number,
    options: { mode?: 'simulate' | 'favorite'; rng?: () => number } = {},
  ): { round: number; recorded: number; resolvedMarkets: number; results: { boutId: BoutId; winnerId: WrestlerId }[] } {
    this.requireTournament(tournamentId);
    const pending = this.bouts(tournamentId).filter((b) => b.round === round && !b.result);
    if (!pending.length) throw new EngineError('NOTHING_PENDING', `${round}-р даваанд хүлээгдэж буй барилдаан алга.`);
    const rng = options.rng ?? Math.random;
    const mode = options.mode ?? 'simulate';
    const results: { boutId: BoutId; winnerId: WrestlerId }[] = [];
    let resolvedMarkets = 0;
    for (const b of pending) {
      const p = this.priorForBout(b.aId, b.bId);
      const aWins = mode === 'favorite' ? p.pA >= 0.5 : rng() < p.pA;
      const winnerId = aWins ? b.aId : b.bId;
      const r = this.recordBoutResult(b.id, winnerId);
      resolvedMarkets += r.resolvedMarkets.length;
      results.push({ boutId: b.id, winnerId });
    }
    return { round, recorded: results.length, resolvedMarkets, results };
  }

  /**
   * Дүрэмтэй зах зээлүүдийг тэмцээний явцаас автоматаар шийднэ / хүчингүй болгоно.
   * `recordBoutResult` бүрийн дараа дуудагдана; гараар ч дуудаж болно.
   */
  /** Дүрмийн шийдвэр (гаж нөлөөгүй): outcome | voidReason | шийдэгдээгүй. */
  private decideRule(rule: MarketRule, outcomeRefs: (string | null)[], outcomeCount: number, p: ReturnType<Engine['tournamentProgress']>, rounds: number): { outcome?: number; voidReason?: string } {
    const finalWins = (id: WrestlerId): number | undefined => (p.championId === id ? rounds : p.eliminated.get(id));
    const neverWrestled = (id: WrestlerId) => p.finished && !p.participated.has(id);
    const r = rule;
    if (r.type === 'wins_over') {
      const w = p.wins.get(r.wrestlerId) ?? 0;
      const fin = finalWins(r.wrestlerId);
      if (w > r.line) return { outcome: 0 };
      if (fin !== undefined) return { outcome: 1 };
      if (neverWrestled(r.wrestlerId)) return { voidReason: 'Бөх тэмцээнд оролцоогүй' };
      return {};
    }
    if (r.type === 'wins_exact') {
      const fin = finalWins(r.wrestlerId);
      if (fin !== undefined) return { outcome: Math.min(fin, outcomeCount - 1) };
      if (neverWrestled(r.wrestlerId)) return { voidReason: 'Бөх тэмцээнд оролцоогүй' };
      return {};
    }
    if (r.type === 'matchup') {
      const fa = finalWins(r.aId);
      const fb = finalWins(r.bId);
      const wa = p.wins.get(r.aId) ?? 0;
      const wb = p.wins.get(r.bId) ?? 0;
      if (fa !== undefined && fb !== undefined) return { outcome: fa > fb ? 0 : fb > fa ? 1 : 2 };
      if (fa !== undefined && wb > fa) return { outcome: 1 };
      if (fb !== undefined && wa > fb) return { outcome: 0 };
      if (neverWrestled(r.aId) || neverWrestled(r.bId)) return { voidReason: 'Бөх тэмцээнд оролцоогүй' };
      return {};
    }
    if (p.championId) {
      const idx = outcomeRefs.indexOf(p.championId);
      if (idx >= 0) return { outcome: idx };
      const other = outcomeRefs.indexOf(null);
      if (other >= 0) return { outcome: other };
      return { voidReason: 'Аварга жагсаалтад байгаагүй' };
    }
    return {};
  }

  settleTournamentMarkets(tournamentId: TournamentId): { resolved: Market[]; voided: Market[] } {
    const t = this.requireTournament(tournamentId);
    const p = this.tournamentProgress(tournamentId);
    const resolved: Market[] = [];
    const voided: Market[] = [];
    for (const m of [...this.state.markets.values()]) {
      if (!m.rule || m.rule.tournamentId !== tournamentId) continue;
      if (m.status !== 'open' && m.status !== 'closed') continue;
      const d = this.decideRule(m.rule, m.outcomeRefs, m.outcomes.length, p, t.rounds);
      if (d.outcome !== undefined) {
        this.resolveMarket(m.id, d.outcome);
        resolved.push(m);
      } else if (d.voidReason) {
        this.voidMarket(m.id, d.voidReason);
        voided.push(m);
      }
    }
    return { resolved, voided };
  }

  /**
   * Дүрэмт зах зээл нээх — гарчиг, үр дүнгүүдийг дүрмээс өөрөө үүсгэнэ.
   * `prior`-ыг дуудагч (прогноз) өгнө; өгөхгүй бол жигд.
   */
  createRuleMarket(input: { id?: string; rule: MarketRule; prior?: number[]; b?: number; closesAt?: string; listed?: WrestlerId[] }): Market {
    const r = input.rule;
    const t = this.requireTournament(r.tournamentId);
    let title: string;
    let outcomes: string[];
    let refs: (string | null)[];
    if (r.type === 'wins_over') {
      const w = this.requireWrestler(r.wrestlerId);
      if (!Number.isFinite(r.line) || r.line < 0 || r.line >= t.rounds) throw new EngineError('BAD_LINE', `Босго 0–${t.rounds - 1} хооронд байх ёстой.`);
      const over = Math.floor(r.line) + 1;
      title = `${t.name} · ${w.name} ${over}+ даваа давах уу?`;
      outcomes = [`${over}+ даваа давна`, `${over - 1} ба түүнээс бага`];
      refs = [w.id, null];
    } else if (r.type === 'wins_exact') {
      const w = this.requireWrestler(r.wrestlerId);
      title = `${t.name} · ${w.name} яг хэд давах вэ?`;
      outcomes = Array.from({ length: t.rounds + 1 }, (_, k) => (k === t.rounds ? `${k} даваа (аварга)` : `${k} даваа`));
      refs = outcomes.map(() => null);
    } else if (r.type === 'matchup') {
      if (r.aId === r.bId) throw new EngineError('SAME_WRESTLER', 'Хоёр өөр бөх сонго.');
      const a = this.requireWrestler(r.aId);
      const b = this.requireWrestler(r.bId);
      title = `${t.name} · хэн холдох: ${a.name} — ${b.name}`;
      outcomes = [a.name, b.name, 'Тэнцүү'];
      refs = [a.id, b.id, null];
    } else {
      const listed = input.listed ?? [];
      if (listed.length < 1) throw new EngineError('BAD_OUTCOMES', 'Аваргын жагсаалтад дор хаяж 1 бөх.');
      const names = listed.map((id) => this.requireWrestler(id).name);
      title = `${t.name} · аварга хэн болох?`;
      outcomes = [...names, 'Бусад'];
      refs = [...listed, null];
    }
    // Аль хэдийн шийдэгдсэн/хүчингүй байх зах зээл нээхгүй
    const d = this.decideRule(r, refs, outcomes.length, this.tournamentProgress(t.id), t.rounds);
    if (d.outcome !== undefined) throw new EngineError('ALREADY_DECIDED', `Энэ үр дүн аль хэдийн тодорхой: «${outcomes[d.outcome]}».`);
    if (d.voidReason) throw new EngineError('ALREADY_DECIDED', d.voidReason);
    const mi: Parameters<Engine['createMarket']>[0] = { kind: 'custom', title, outcomes, outcomeRefs: refs, tournamentId: t.id, rule: r };
    if (input.id !== undefined) mi.id = input.id;
    if (input.prior !== undefined) mi.prior = input.prior;
    if (input.b !== undefined) mi.b = input.b;
    if (input.closesAt !== undefined) mi.closesAt = input.closesAt;
    return this.createMarket(mi);
  }

  createBout(input: {
    id?: string;
    tournamentId: TournamentId;
    round: number;
    aId: WrestlerId;
    bId: WrestlerId;
    scheduledAt?: string;
    devjeeMatchId?: string;
    /** Барилдааны зах зээл шууд нээх үү (анхдагч: тийм). */
    withMarket?: boolean;
    b?: number;
    closesAt?: string;
    /** [pA, pB] — өгөхгүй бол Elo-гоос. */
    prior?: [number, number];
  }): { bout: Bout; market?: Market } {
    const id = this.newId(input.id);
    if (this.state.bouts.has(id)) throw new EngineError('DUPLICATE', `Барилдаан аль хэдийн бий: ${id}`);
    const t = this.requireTournament(input.tournamentId);
    if (!Number.isInteger(input.round) || input.round < 1 || input.round > t.rounds) {
      throw new EngineError('BAD_ROUND', `Даваа 1–${t.rounds} хооронд байх ёстой.`);
    }
    if (input.aId === input.bId) throw new EngineError('SAME_WRESTLER', 'Бөх өөртэйгөө барилдахгүй.');
    const a = this.requireWrestler(input.aId);
    const b = this.requireWrestler(input.bId);
    const bout: Bout = { id, tournamentId: input.tournamentId, round: input.round, aId: input.aId, bId: input.bId };
    if (input.scheduledAt !== undefined) bout.scheduledAt = input.scheduledAt;
    if (input.devjeeMatchId !== undefined) bout.devjeeMatchId = input.devjeeMatchId;
    this.emit({ ...this.stamp(), type: 'bout_created', bout });

    const result: { bout: Bout; market?: Market } = { bout: this.requireBout(id) };
    if (input.withMarket ?? true) {
      const prior = input.prior ?? (() => {
        const p = this.priorForBout(input.aId, input.bId);
        return [p.pA, p.pB] as [number, number];
      })();
      const marketInput: Parameters<Engine['createMarket']>[0] = {
        kind: 'bout',
        title: `${t.name} · ${input.round}-р даваа: ${a.name} — ${b.name}`,
        outcomes: [a.name, b.name],
        outcomeRefs: [a.id, b.id],
        prior,
        boutId: id,
        tournamentId: input.tournamentId,
      };
      if (input.b !== undefined) marketInput.b = input.b;
      const closesAt = input.closesAt ?? input.scheduledAt;
      if (closesAt !== undefined) marketInput.closesAt = closesAt;
      result.market = this.createMarket(marketInput);
    }
    return result;
  }

  bout(id: BoutId): Bout {
    return this.requireBout(id);
  }

  bouts(tournamentId?: TournamentId): Bout[] {
    const all = [...this.state.bouts.values()];
    return tournamentId === undefined ? all : all.filter((b) => b.tournamentId === tournamentId);
  }

  /**
   * Барилдааны үр дүн бүртгэнэ: Elo шинэчилж, холбоотой зах зээлүүдийг шийднэ.
   */
  recordBoutResult(
    boutId: BoutId,
    winnerId: WrestlerId,
    options: { updateRatings?: boolean } = {},
  ): { bout: Bout; resolvedMarkets: Market[]; skippedMarkets: Market[] } {
    const bout = this.requireBout(boutId);
    if (bout.result) throw new EngineError('ALREADY_RESOLVED', 'Энэ барилдааны үр дүн аль хэдийн бүртгэгдсэн.');
    if (winnerId !== bout.aId && winnerId !== bout.bId) {
      throw new EngineError('BAD_WINNER', 'Давагч нь барилдааны хоёр бөхийн нэг байх ёстой.');
    }
    const t = this.requireTournament(bout.tournamentId);
    const ratingUpdates: { wrestlerId: WrestlerId; rating: number; source: RatingSource; asOf: string }[] = [];
    if (options.updateRatings ?? true) {
      const ra = this.rating(bout.aId).rating;
      const rb = this.rating(bout.bId).rating;
      const [na, nb] = updateRatings(ra, rb, winnerId === bout.aId, this.opts.eloK);
      ratingUpdates.push(
        { wrestlerId: bout.aId, rating: na, source: 'local', asOf: t.date },
        { wrestlerId: bout.bId, rating: nb, source: 'local', asOf: t.date },
      );
    }
    this.emit({ ...this.stamp(), type: 'bout_result', boutId, winnerId, ratingUpdates });

    const resolvedMarkets: Market[] = [];
    const skippedMarkets: Market[] = [];
    for (const m of this.state.markets.values()) {
      if (m.boutId !== boutId || m.status === 'resolved' || m.status === 'voided') continue;
      const outcome = m.outcomeRefs.indexOf(winnerId);
      if (outcome < 0) {
        skippedMarkets.push(m);
        continue;
      }
      this.resolveMarket(m.id, outcome);
      resolvedMarkets.push(m);
    }
    // Дүрэмт зах зээлүүд (хэд давах, хэн холдох, аварга) — тэмцээний явцаас
    const settled = this.settleTournamentMarkets(bout.tournamentId);
    resolvedMarkets.push(...settled.resolved, ...settled.voided);
    this.settleReadyTotos(bout.tournamentId);
    return { bout: this.requireBout(boutId), resolvedMarkets, skippedMarkets };
  }

  // ───────────────────────── зах зээл ─────────────────────────

  createMarket(input: {
    id?: string;
    kind?: MarketKind;
    title: string;
    outcomes: string[];
    outcomeRefs?: (string | null)[];
    b?: number;
    /** Анхны магадлал бүр — өгөхгүй бол жигд. */
    prior?: number[];
    closesAt?: string;
    boutId?: BoutId;
    tournamentId?: TournamentId;
    rule?: MarketRule;
  }): Market {
    const id = this.newId(input.id);
    if (this.state.markets.has(id)) throw new EngineError('DUPLICATE', `Зах зээл аль хэдийн бий: ${id}`);
    const title = Engine.cleanName(input.title, 'Зах зээлийн нэр');
    const outcomes = input.outcomes.map((o) => Engine.cleanName(o, 'Үр дүнгийн нэр'));
    if (outcomes.length < 2) throw new EngineError('BAD_OUTCOMES', 'Дор хаяж 2 үр дүн хэрэгтэй.');
    if (outcomes.length > this.opts.maxOutcomes) {
      throw new EngineError('BAD_OUTCOMES', `Үр дүн ${this.opts.maxOutcomes}-аас олон байж болохгүй.`);
    }
    if (new Set(outcomes).size !== outcomes.length) throw new EngineError('BAD_OUTCOMES', 'Үр дүнгийн нэр давхардсан.');
    const outcomeRefs = input.outcomeRefs ?? outcomes.map(() => null);
    if (outcomeRefs.length !== outcomes.length) throw new EngineError('BAD_OUTCOMES', 'outcomeRefs урт таарахгүй.');
    const b = input.b ?? this.opts.defaultB;
    if (!Number.isFinite(b) || b <= 0) throw new EngineError('BAD_B', 'b эерэг байх ёстой.');
    const prior = input.prior ?? outcomes.map(() => 1 / outcomes.length);
    if (prior.length !== outcomes.length) throw new EngineError('BAD_PRIOR', 'Анхны магадлалын урт таарахгүй.');
    for (const p of prior) if (!Number.isFinite(p) || p < 0) throw new EngineError('BAD_PRIOR', 'Магадлал 0-ээс их байх ёстой.');
    if (prior.reduce((s, p) => s + p, 0) <= 0) throw new EngineError('BAD_PRIOR', 'Магадлалын нийлбэр 0.');
    if (input.closesAt !== undefined && Number.isNaN(Date.parse(input.closesAt))) {
      throw new EngineError('BAD_DATE', 'closesAt огноо буруу.');
    }
    if (input.boutId !== undefined) this.requireBout(input.boutId);
    if (input.tournamentId !== undefined) this.requireTournament(input.tournamentId);

    const market: BukhEvent & { type: 'market_created' } = {
      ...this.stamp(),
      type: 'market_created',
      market: {
        id,
        kind: input.kind ?? 'custom',
        title,
        outcomes,
        outcomeRefs,
        b,
        q0: initialQuantities(prior, b),
      },
    };
    if (input.closesAt !== undefined) market.market.closesAt = input.closesAt;
    if (input.boutId !== undefined) market.market.boutId = input.boutId;
    if (input.tournamentId !== undefined) market.market.tournamentId = input.tournamentId;
    if (input.rule !== undefined) market.market.rule = input.rule;
    this.emit(market);
    return this.requireMarket(id);
  }

  closeMarket(marketId: MarketId): Market {
    const m = this.requireMarket(marketId);
    if (m.status !== 'open') throw new EngineError('MARKET_CLOSED', `Зах зээл нээлттэй биш (${m.status}).`);
    this.emit({ ...this.stamp(), type: 'market_closed', marketId });
    return m;
  }

  resolveMarket(marketId: MarketId, outcome: number): { market: Market; payouts: { userId: UserId; shares: number; amount: number }[] } {
    const m = this.requireMarket(marketId);
    if (m.status === 'resolved' || m.status === 'voided') {
      throw new EngineError('ALREADY_RESOLVED', `Зах зээл аль хэдийн дууссан (${m.status}).`);
    }
    this.requireOutcome(m, outcome);
    const payouts: { userId: UserId; shares: number; amount: number; balanceAfter: number }[] = [];
    for (const [userId, pos] of [...m.positions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const shares = pos[outcome] ?? 0;
      if (shares <= EPS) continue;
      const amount = Math.round(shares);
      if (amount <= 0) continue;
      const user = this.requireUser(userId);
      payouts.push({ userId, shares, amount, balanceAfter: user.balance + amount });
    }
    this.emit({ ...this.stamp(), type: 'market_resolved', marketId, outcome, payouts });
    this.settleCouponsFor(marketId);
    return { market: m, payouts: payouts.map(({ userId, shares, amount }) => ({ userId, shares, amount })) };
  }

  voidMarket(marketId: MarketId, reason: string): { market: Market; refunds: { userId: UserId; amount: number }[] } {
    const m = this.requireMarket(marketId);
    if (m.status === 'resolved' || m.status === 'voided') {
      throw new EngineError('ALREADY_RESOLVED', `Зах зээл аль хэдийн дууссан (${m.status}).`);
    }
    const refunds: { userId: UserId; amount: number; balanceAfter: number }[] = [];
    for (const [userId, net] of [...m.netCost.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (net <= 0) continue;
      const user = this.requireUser(userId);
      refunds.push({ userId, amount: net, balanceAfter: user.balance + net });
    }
    this.emit({ ...this.stamp(), type: 'market_voided', marketId, reason: reason.trim() || 'хүчингүй', refunds });
    this.settleCouponsFor(marketId);
    return { market: m, refunds: refunds.map(({ userId, amount }) => ({ userId, amount })) };
  }

  market(marketId: MarketId): Market {
    return this.requireMarket(marketId);
  }

  markets(filter?: { status?: Market['status']; tournamentId?: TournamentId; boutId?: BoutId }): Market[] {
    let all = [...this.state.markets.values()];
    if (filter?.status) all = all.filter((m) => m.status === filter.status);
    if (filter?.tournamentId) all = all.filter((m) => m.tournamentId === filter.tournamentId);
    if (filter?.boutId) all = all.filter((m) => m.boutId === filter.boutId);
    return all;
  }

  probabilities(marketId: MarketId): number[] {
    const m = this.requireMarket(marketId);
    return prices(m.q, m.b);
  }

  marketView(marketId: MarketId): MarketView {
    const m = this.requireMarket(marketId);
    const view: MarketView = {
      id: m.id,
      kind: m.kind,
      title: m.title,
      status: m.status,
      outcomes: [...m.outcomes],
      outcomeRefs: [...m.outcomeRefs],
      probs: prices(m.q, m.b),
      b: m.b,
      volume: m.volume,
      tradeCount: m.tradeCount,
      traders: m.positions.size,
      houseCash: m.houseCash,
      maxHouseLoss: maxLossFromInitial(m.q0, m.b),
      createdAt: m.createdAt,
    };
    if (m.closesAt !== undefined) view.closesAt = m.closesAt;
    if (m.resolvedOutcome !== undefined) view.resolvedOutcome = m.resolvedOutcome;
    if (m.voidReason !== undefined) view.voidReason = m.voidReason;
    if (m.boutId !== undefined) view.boutId = m.boutId;
    if (m.tournamentId !== undefined) view.tournamentId = m.tournamentId;
    return view;
  }

  // ───────────────────────── арилжаа ─────────────────────────

  quoteBuy(marketId: MarketId, outcome: number, spend: number): BuyQuote {
    const m = this.requireMarket(marketId);
    this.requireOutcome(m, outcome);
    Engine.assertInteger(spend, 'Зарцуулалт');
    if (spend < this.opts.minBet) throw new EngineError('MIN_BET', `Хамгийн бага бооцоо ${this.opts.minBet} токен.`);
    if (spend > this.opts.maxBet) throw new EngineError('MAX_BET', `Нэг удаагийн дээд бооцоо ${this.opts.maxBet} токен.`);
    const shares = sharesForSpend(m.q, m.b, outcome, spend);
    const q2 = m.q.slice();
    q2[outcome] = q2[outcome]! + shares;
    const priceBefore = prices(m.q, m.b)[outcome]!;
    const priceAfter = prices(q2, m.b)[outcome]!;
    const payoutIfWin = Math.round(shares);
    return {
      marketId,
      outcome,
      spend,
      shares,
      avgPrice: spend / shares,
      priceBefore,
      priceAfter,
      payoutIfWin,
      multiplier: payoutIfWin / spend,
    };
  }

  quoteSell(marketId: MarketId, outcome: number, shares: number): SellQuote {
    const m = this.requireMarket(marketId);
    this.requireOutcome(m, outcome);
    if (!Number.isFinite(shares) || shares <= 0) throw new EngineError('BAD_AMOUNT', 'Хувийн тоо эерэг байх ёстой.');
    const proceeds = Math.floor(-costToBuy(m.q, m.b, outcome, -shares) + 1e-7);
    const q2 = m.q.slice();
    q2[outcome] = q2[outcome]! - shares;
    return {
      marketId,
      outcome,
      shares,
      proceeds,
      priceBefore: prices(m.q, m.b)[outcome]!,
      priceAfter: prices(q2, m.b)[outcome]!,
    };
  }

  private existingTrade(userId: UserId, requestId?: string): TradeRecord | undefined {
    if (requestId === undefined) return undefined;
    const tradeId = this.state.requestIndex.get(`${userId}:${requestId}`);
    return tradeId === undefined ? undefined : this.state.trades.get(tradeId);
  }

  /** `spend` токеноор `outcome`-ын хувь авна. */
  buy(userId: UserId, marketId: MarketId, outcome: number, spend: number, requestId?: string): TradeRecord {
    const dup = this.existingTrade(userId, requestId);
    if (dup) return dup;
    const user = this.requireUser(userId);
    const m = this.requireMarket(marketId);
    this.ensureTradable(m);
    const quote = this.quoteBuy(marketId, outcome, spend);
    if (user.balance < spend) {
      throw new EngineError('INSUFFICIENT', `Үлдэгдэл хүрэлцэхгүй: ${user.balance} < ${spend}.`);
    }
    const qAfter = m.q.slice();
    qAfter[outcome] = qAfter[outcome]! + quote.shares;
    const tradeId = this.opts.idGen();
    const e: BukhEvent & { type: 'trade' } = {
      ...this.stamp(),
      type: 'trade',
      tradeId,
      marketId,
      userId,
      outcome,
      shares: quote.shares,
      delta: -spend,
      qAfter,
      balanceAfter: user.balance - spend,
      priceBefore: quote.priceBefore,
      priceAfter: quote.priceAfter,
    };
    if (requestId !== undefined) e.requestId = requestId;
    this.emit(e);
    return this.state.trades.get(tradeId)!;
  }

  /** Эзэмшиж буй хувиасаа `shares`-ийг буцааж зарна. */
  sell(userId: UserId, marketId: MarketId, outcome: number, shares: number, requestId?: string): TradeRecord {
    const dup = this.existingTrade(userId, requestId);
    if (dup) return dup;
    const user = this.requireUser(userId);
    const m = this.requireMarket(marketId);
    this.ensureTradable(m);
    this.requireOutcome(m, outcome);
    if (!Number.isFinite(shares) || shares <= 0) throw new EngineError('BAD_AMOUNT', 'Хувийн тоо эерэг байх ёстой.');
    const holding = m.positions.get(userId)?.[outcome] ?? 0;
    if (shares > holding + EPS) {
      throw new EngineError('INSUFFICIENT', `Эзэмшил хүрэлцэхгүй: ${holding.toFixed(2)} хувь байна.`);
    }
    const toSell = Math.min(shares, holding);
    const quote = this.quoteSell(marketId, outcome, toSell);
    if (quote.proceeds < 1) throw new EngineError('TOO_SMALL', 'Зарах хэмжээ хэт бага (1 токенд хүрэхгүй).');
    const qAfter = m.q.slice();
    qAfter[outcome] = qAfter[outcome]! - toSell;
    const tradeId = this.opts.idGen();
    const e: BukhEvent & { type: 'trade' } = {
      ...this.stamp(),
      type: 'trade',
      tradeId,
      marketId,
      userId,
      outcome,
      shares: -toSell,
      delta: quote.proceeds,
      qAfter,
      balanceAfter: user.balance + quote.proceeds,
      priceBefore: quote.priceBefore,
      priceAfter: quote.priceAfter,
    };
    if (requestId !== undefined) e.requestId = requestId;
    this.emit(e);
    return this.state.trades.get(tradeId)!;
  }

  // ───────────────────────── купон (экспресс / систем) ─────────────────────────

  private static combinations(n: number, k: number): number[][] {
    const out: number[][] = [];
    const cur: number[] = [];
    const rec = (start: number) => {
      if (cur.length === k) {
        out.push([...cur]);
        return;
      }
      for (let i = start; i < n; i++) {
        cur.push(i);
        rec(i + 1);
        cur.pop();
      }
    };
    rec(0);
    return out;
  }

  private couponCombos(n: number, sizes: number[]): number[][] {
    const all: number[][] = [];
    for (const k of sizes) all.push(...Engine.combinations(n, k));
    return all;
  }

  /**
   * Купоны санал: сонголтуудын одоогийн магадлал (тогтмол коэффициент), хослол,
   * дээд төлбөр. Экспресс: бүх сонголт таарах ёстой; систем: `sizes` хэмжээтэй
   * бүх дэд хослол тус бүрд stake/combos бооцоо (Lucky = 1..n, Patent = 2..n).
   */
  quoteCoupon(input: { legs: { marketId: MarketId; outcome: number }[]; stake: number; kind: CouponKind; sizes?: number[] }): CouponQuote {
    const n = input.legs.length;
    if (n < 2) throw new EngineError('BAD_COUPON', 'Купонд дор хаяж 2 сонголт хэрэгтэй.');
    if (n > this.opts.maxCouponLegs) throw new EngineError('BAD_COUPON', `Купонд ${this.opts.maxCouponLegs}-аас олон сонголт байж болохгүй.`);
    Engine.assertInteger(input.stake, 'Бооцоо');
    if (input.stake < this.opts.minBet) throw new EngineError('MIN_BET', `Хамгийн бага бооцоо ${this.opts.minBet} токен.`);
    if (input.stake > this.opts.maxCouponStake) throw new EngineError('MAX_BET', `Купоны дээд бооцоо ${this.opts.maxCouponStake} токен.`);
    const seenMarkets = new Set<string>();
    const seenRefs = new Set<string>();
    const legs: CouponLeg[] = [];
    for (const l of input.legs) {
      const m = this.requireMarket(l.marketId);
      this.requireOutcome(m, l.outcome);
      if (seenMarkets.has(m.id)) throw new EngineError('BAD_COUPON', 'Нэг зах зээлээс хоёр сонголт болохгүй.');
      seenMarkets.add(m.id);
      // Эерэг хамаарлыг хориглоно: сонгосон үр дүнтэй холбоотой бөх давхцвал болохгүй.
      // «Бусад»/«Тэнцүү» (ref = null) сонголт нь тухайн зах зээлийн БҮХ бөхөөс хамаарна.
      const own = m.outcomeRefs[l.outcome];
      const refs = own !== null && own !== undefined ? [own] : m.outcomeRefs.filter((r): r is string => r !== null);
      for (const ref of refs) {
        if (seenRefs.has(ref)) throw new EngineError('BAD_COUPON', `Хамааралтай сонголт: ${this.state.wrestlers.get(ref)?.name ?? ref} өөр сонголтод давхардаж байна.`);
      }
      for (const ref of refs) seenRefs.add(ref);
      if (m.status !== 'open') throw new EngineError('MARKET_CLOSED', `Зах зээл нээлттэй биш: ${m.title}`);
      const price = prices(m.q, m.b)[l.outcome]!;
      if (!(price > 0)) throw new EngineError('BAD_COUPON', 'Магадлал 0 үр дүнг купонд оруулахгүй.');
      legs.push({ marketId: m.id, outcome: l.outcome, price, marketTitle: m.title, outcomeLabel: m.outcomes[l.outcome]! });
    }
    let sizes: number[];
    if (input.kind === 'express') sizes = [n];
    else {
      sizes = [...new Set((input.sizes ?? []).map((k) => Math.round(k)))].sort((a, b) => a - b);
      if (sizes.length === 0 || sizes.some((k) => k < 1 || k > n)) throw new EngineError('BAD_COUPON', `Системийн хослолын хэмжээ 1–${n} хооронд.`);
      if (sizes.length === 1 && sizes[0] === n) throw new EngineError('BAD_COUPON', 'Энэ бол экспресс — kind=express сонго.');
    }
    const combos = this.couponCombos(n, sizes);
    const unitStake = input.stake / combos.length;
    let maxPayout = 0;
    let capped = false;
    let coefficient = 1;
    for (const combo of combos) {
      let coef = 1;
      for (const i of combo) coef *= 1 / legs[i]!.price;
      if (coef > this.opts.maxCouponMultiplier) {
        coef = this.opts.maxCouponMultiplier;
        capped = true;
      }
      if (input.kind === 'express') coefficient = coef;
      maxPayout += unitStake * coef;
    }
    return { kind: input.kind, legs, stake: input.stake, sizes, combos: combos.length, unitStake, coefficient, maxPayout: Math.floor(maxPayout), capped };
  }

  placeCoupon(userId: UserId, input: { legs: { marketId: MarketId; outcome: number }[]; stake: number; kind: CouponKind; sizes?: number[] }, requestId?: string): Coupon {
    if (requestId !== undefined) {
      const prev = this.state.requestIndex.get(`${userId}:${requestId}`);
      if (prev !== undefined && this.state.coupons.has(prev)) return this.state.coupons.get(prev)!;
    }
    const user = this.requireUser(userId);
    for (const l of input.legs) this.ensureTradable(this.requireMarket(l.marketId));
    const q = this.quoteCoupon(input);
    if (user.balance < q.stake) throw new EngineError('INSUFFICIENT', `Үлдэгдэл хүрэлцэхгүй: ${user.balance} < ${q.stake}.`);
    const couponId = this.opts.idGen();
    const e: BukhEvent & { type: 'coupon_placed' } = {
      ...this.stamp(),
      type: 'coupon_placed',
      couponId,
      userId,
      kind: q.kind,
      legs: q.legs,
      stake: q.stake,
      sizes: q.sizes,
      combos: q.combos,
      balanceAfter: user.balance - q.stake,
    };
    if (requestId !== undefined) e.requestId = requestId;
    this.emit(e);
    return this.state.coupons.get(couponId)!;
  }

  /** Тухайн зах зээлтэй холбоотой нээлттэй купонуудыг (бүх сонголт нь шийдэгдсэн бол) шийднэ. */
  private settleCouponsFor(marketId: MarketId): Coupon[] {
    const settled: Coupon[] = [];
    for (const c of [...this.state.coupons.values()]) {
      if (c.status !== 'open' || !c.legs.some((l) => l.marketId === marketId)) continue;
      const results: ('won' | 'lost' | 'void')[] = [];
      let pending = false;
      for (const l of c.legs) {
        const m = this.state.markets.get(l.marketId);
        if (!m) {
          results.push('void');
          continue;
        }
        if (m.status === 'voided') results.push('void');
        else if (m.status === 'resolved') results.push(m.resolvedOutcome === l.outcome ? 'won' : 'lost');
        else {
          pending = true;
          break;
        }
      }
      if (pending) continue;
      const allVoid = results.every((r) => r === 'void');
      let payout = 0;
      let status: 'won' | 'lost' | 'void' = 'lost';
      if (allVoid) {
        payout = c.stake;
        status = 'void';
      } else {
        const combos = this.couponCombos(c.legs.length, c.sizes);
        const unit = c.stake / combos.length;
        let sum = 0;
        for (const combo of combos) {
          if (combo.some((i) => results[i] === 'lost')) continue;
          let coef = 1;
          for (const i of combo) if (results[i] === 'won') coef *= 1 / c.legs[i]!.price;
          sum += unit * Math.min(coef, this.opts.maxCouponMultiplier);
        }
        payout = Math.floor(sum);
        status = payout > 0 ? 'won' : 'lost';
      }
      const user = this.requireUser(c.userId);
      this.emit({
        ...this.stamp(),
        type: 'coupon_settled',
        couponId: c.id,
        userId: c.userId,
        status,
        legResults: results,
        payout,
        balanceAfter: user.balance + payout,
      });
      settled.push(c);
    }
    return settled;
  }

  coupons(userId?: UserId): Coupon[] {
    const all = [...this.state.coupons.values()];
    return (userId ? all.filter((c) => c.userId === userId) : all).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ───────────────────────── тото (пул) ─────────────────────────

  /** Наадмын тото: N барилдааны давагчийг таах; пул шатлан (60/30/10) хуваагдана. */
  createToto(input: { id?: string; title: string; tournamentId: TournamentId; boutIds: BoutId[]; fee?: number; tiers?: number[]; closesAt?: string }): Toto {
    const id = this.newId(input.id);
    if (this.state.totos.has(id)) throw new EngineError('DUPLICATE', `Тото аль хэдийн бий: ${id}`);
    this.requireTournament(input.tournamentId);
    const title = Engine.cleanName(input.title, 'Тотогийн нэр');
    const boutIds = [...new Set(input.boutIds)];
    if (boutIds.length < 2) throw new EngineError('BAD_TOTO', 'Дор хаяж 2 барилдаан сонго.');
    if (boutIds.length > 32) throw new EngineError('BAD_TOTO', '32-оос олон барилдаан болохгүй.');
    for (const b of boutIds) {
      const bout = this.requireBout(b);
      if (bout.tournamentId !== input.tournamentId) throw new EngineError('BAD_TOTO', 'Барилдаанууд нэг тэмцээнийх байх ёстой.');
      if (bout.result) throw new EngineError('BAD_TOTO', 'Аль хэдийн болсон барилдаан орж болохгүй.');
    }
    const fee = input.fee ?? 100;
    Engine.assertInteger(fee, 'Хураамж');
    if (fee < this.opts.minBet) throw new EngineError('BAD_TOTO', `Хураамж ${this.opts.minBet}-аас багагүй.`);
    if (fee > this.opts.maxCouponStake) throw new EngineError('BAD_TOTO', `Хураамж ${this.opts.maxCouponStake}-аас ихгүй.`);
    const tiers = input.tiers ?? [0.6, 0.3, 0.1];
    if (tiers.length === 0 || tiers.some((x) => !(x > 0)) || Math.abs(tiers.reduce((a, c) => a + c, 0) - 1) > 1e-9) {
      throw new EngineError('BAD_TOTO', 'Шатлалын нийлбэр 1 байх ёстой (жишээ 0.6, 0.3, 0.1).');
    }
    const e: BukhEvent & { type: 'toto_created' } = {
      ...this.stamp(),
      type: 'toto_created',
      toto: { id, title, tournamentId: input.tournamentId, boutIds, fee, tiers },
    };
    if (input.closesAt !== undefined) {
      if (Number.isNaN(Date.parse(input.closesAt))) throw new EngineError('BAD_DATE', 'closesAt огноо буруу.');
      e.toto.closesAt = input.closesAt;
    }
    this.emit(e);
    return this.state.totos.get(id)!;
  }

  private requireToto(id: string): Toto {
    const t = this.state.totos.get(id);
    if (!t) throw new EngineError('TOTO_NOT_FOUND', `Тото олдсонгүй: ${id}`);
    return t;
  }

  toto(id: string): Toto {
    return this.requireToto(id);
  }

  totos(filter?: { status?: Toto['status']; tournamentId?: TournamentId }): Toto[] {
    let all = [...this.state.totos.values()];
    if (filter?.status) all = all.filter((t) => t.status === filter.status);
    if (filter?.tournamentId) all = all.filter((t) => t.tournamentId === filter.tournamentId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Тото нээлттэй эсэх: хугацаа дуусаагүй, ямар ч барилдаан эхлээгүй. */
  private ensureTotoOpen(toto: Toto): void {
    if (toto.status !== 'open') throw new EngineError('TOTO_CLOSED', 'Тото хаагдсан.');
    if (toto.closesAt && Date.parse(toto.closesAt) <= this.opts.now().getTime()) throw new EngineError('TOTO_CLOSED', 'Тотогийн хугацаа дууссан.');
    for (const b of toto.boutIds) if (this.requireBout(b).result) throw new EngineError('TOTO_CLOSED', 'Барилдаан эхэлсэн — тото хаагдсан.');
  }

  enterToto(userId: UserId, totoId: string, picks: (WrestlerId | null)[], requestId?: string): Toto {
    if (requestId !== undefined) {
      const prev = this.state.requestIndex.get(`${userId}:${requestId}`);
      if (prev === totoId && this.state.totos.get(totoId)?.entries.has(userId)) return this.requireToto(totoId);
    }
    const user = this.requireUser(userId);
    const toto = this.requireToto(totoId);
    this.ensureTotoOpen(toto);
    if (toto.entries.has(userId)) throw new EngineError('DUPLICATE', 'Та энэ тотод аль хэдийн орсон байна.');
    if (picks.length !== toto.boutIds.length) throw new EngineError('BAD_TOTO', `${toto.boutIds.length} барилдаанд таамаг өгнө үү.`);
    const clean: (WrestlerId | null)[] = [];
    picks.forEach((p, i) => {
      if (p === null || p === undefined || p === '') {
        clean.push(null);
        return;
      }
      const bout = this.requireBout(toto.boutIds[i]!);
      if (p !== bout.aId && p !== bout.bId) throw new EngineError('BAD_TOTO', `${i + 1}-р барилдаанд буруу бөх сонгосон.`);
      clean.push(p);
    });
    if (clean.every((p) => p === null)) throw new EngineError('BAD_TOTO', 'Дор хаяж нэг таамаг өгнө үү.');
    if (user.balance < toto.fee) throw new EngineError('INSUFFICIENT', `Үлдэгдэл хүрэлцэхгүй: ${user.balance} < ${toto.fee}.`);
    const e: BukhEvent & { type: 'toto_entered' } = {
      ...this.stamp(),
      type: 'toto_entered',
      totoId,
      userId,
      picks: clean,
      fee: toto.fee,
      balanceAfter: user.balance - toto.fee,
    };
    if (requestId !== undefined) e.requestId = requestId;
    this.emit(e);
    return this.requireToto(totoId);
  }

  /**
   * Бүх барилдаан нь шийдэгдсэн тотог тооцно: зөв таасан тоогоор эрэмбэлж,
   * пулыг шатлан (60/30/10) хуваана. Оролцогчгүй/зөв таагаагүй бол буцаалт.
   */
  settleToto(totoId: string): Toto {
    const toto = this.requireToto(totoId);
    if (toto.status !== 'open') throw new EngineError('ALREADY_RESOLVED', 'Тото аль хэдийн шийдэгдсэн.');
    const winners = new Map<BoutId, WrestlerId | 'void'>();
    for (const b of toto.boutIds) {
      const bout = this.requireBout(b);
      if (!bout.result) throw new EngineError('NOT_READY', 'Бүх барилдаан дуусаагүй байна.');
      winners.set(b, bout.result.winnerId);
    }
    const scored = toto.boutIds.length;
    const entries = [...toto.entries.values()];
    const scoredEntries = entries.map((en) => {
      let correct = 0;
      toto.boutIds.forEach((b, i) => {
        const pick = en.picks[i];
        if (pick && winners.get(b) === pick) correct += 1;
      });
      return { userId: en.userId, correct };
    });
    const results: { userId: UserId; correct: number; payout: number; balanceAfter: number }[] = [];
    const anyCorrect = scoredEntries.some((x) => x.correct > 0);
    if (entries.length === 0 || !anyCorrect) {
      // Хэн ч таагаагүй → бүгдэд буцаалт
      const balances = new Map<UserId, number>();
      for (const x of scoredEntries) {
        const u = this.requireUser(x.userId);
        const prev = balances.get(x.userId) ?? u.balance;
        const payout = toto.fee;
        balances.set(x.userId, prev + payout);
        results.push({ userId: x.userId, correct: x.correct, payout, balanceAfter: prev + payout });
      }
      this.emit({ ...this.stamp(), type: 'toto_settled', totoId, status: 'voided', results, scored });
      return this.requireToto(totoId);
    }
    // Шатлал: зөв таасан тоогоор бүлэглээд дээрээс нь tiers-ээр
    const groups = new Map<number, UserId[]>();
    for (const x of scoredEntries) groups.set(x.correct, [...(groups.get(x.correct) ?? []), x.userId]);
    const levels = [...groups.keys()].filter((k) => k > 0).sort((a, b) => b - a);
    const pool = toto.pool;
    const shares = new Map<UserId, number>();
    let distributed = 0;
    levels.forEach((level, idx) => {
      const share = toto.tiers[idx];
      if (share === undefined) return;
      const users = groups.get(level)!;
      const amount = Math.floor((pool * share) / users.length);
      for (const u of users) {
        shares.set(u, (shares.get(u) ?? 0) + amount);
        distributed += amount;
      }
    });
    // Тарааж амжаагүй үлдэгдэл (доод шатлал байхгүй эсвэл тоймлолт) → дээд шатлалынханд
    const remainder = pool - distributed;
    if (remainder > 0) {
      const topUsers = groups.get(levels[0]!)!;
      const add = Math.floor(remainder / topUsers.length);
      if (add > 0) for (const u of topUsers) shares.set(u, (shares.get(u) ?? 0) + add);
    }
    const balances = new Map<UserId, number>();
    for (const x of scoredEntries.sort((a, b) => b.correct - a.correct)) {
      const payout = shares.get(x.userId) ?? 0;
      const u = this.requireUser(x.userId);
      const prev = balances.get(x.userId) ?? u.balance;
      balances.set(x.userId, prev + payout);
      results.push({ userId: x.userId, correct: x.correct, payout, balanceAfter: prev + payout });
    }
    this.emit({ ...this.stamp(), type: 'toto_settled', totoId, status: 'settled', results, scored });
    return this.requireToto(totoId);
  }

  /** Барилдааны үр дүн бүртгэсний дараа бэлэн болсон тотог автоматаар шийднэ. */
  private settleReadyTotos(tournamentId: TournamentId): Toto[] {
    const out: Toto[] = [];
    for (const t of this.totos({ status: 'open', tournamentId })) {
      if (t.boutIds.every((b) => this.state.bouts.get(b)?.result)) {
        this.settleToto(t.id);
        out.push(t);
      }
    }
    return out;
  }

  // ───────────────────────── харагдац ─────────────────────────

  positions(userId: UserId): PositionView[] {
    this.requireUser(userId);
    const out: PositionView[] = [];
    for (const m of this.state.markets.values()) {
      const pos = m.positions.get(userId);
      if (!pos) continue;
      const probs = prices(m.q, m.b);
      pos.forEach((shares, i) => {
        if (shares <= EPS) return;
        let value: number;
        if (m.status === 'resolved') value = m.resolvedOutcome === i ? Math.round(shares) : 0;
        else if (m.status === 'voided') value = 0;
        else value = shares * probs[i]!;
        out.push({
          marketId: m.id,
          title: m.title,
          status: m.status,
          outcome: i,
          outcomeLabel: m.outcomes[i]!,
          shares,
          price: probs[i]!,
          value,
          netCost: m.netCost.get(userId) ?? 0,
        });
      });
    }
    return out;
  }

  leaderboard(): LeaderboardRow[] {
    const rows: Omit<LeaderboardRow, 'rank'>[] = [];
    for (const u of this.state.users.values()) {
      let positionsValue = 0;
      for (const p of this.positions(u.id)) {
        if (p.status === 'open' || p.status === 'closed') positionsValue += p.value;
      }
      // Нээлттэй купон/тото — өртгөөр (бооцоо) тооцно
      for (const c of this.state.coupons.values()) if (c.userId === u.id && c.status === 'open') positionsValue += c.stake;
      for (const t of this.state.totos.values()) if (t.status === 'open' && t.entries.has(u.id)) positionsValue += t.fee;
      const total = u.balance + positionsValue;
      rows.push({ userId: u.id, name: u.name, balance: u.balance, positionsValue, total, contributed: u.contributed, pnl: total - u.contributed });
    }
    rows.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return rows.map((r, i) => ({ rank: i + 1, ...r }));
  }

  ledger(userId?: UserId, limit = 50): LedgerEntry[] {
    const all = userId === undefined ? this.state.ledger : this.state.ledger.filter((l) => l.userId === userId);
    return all.slice(-limit).reverse();
  }

  /** Хаусын нэгдсэн дүн: Σ кэш, хамгийн их боломжит алдагдал. */
  houseSummary(): { cash: number; markets: number; open: number; resolved: number; voided: number; maxLossBoundOpen: number; couponCash: number; openCoupons: number } {
    let cash = 0;
    let open = 0;
    let resolved = 0;
    let voided = 0;
    let bound = 0;
    for (const m of this.state.markets.values()) {
      cash += m.houseCash;
      if (m.status === 'open' || m.status === 'closed') {
        open += 1;
        bound += maxLossFromInitial(m.q0, m.b);
      } else if (m.status === 'resolved') resolved += 1;
      else voided += 1;
    }
    let openCoupons = 0;
    for (const c of this.state.coupons.values()) if (c.status === 'open') openCoupons += 1;
    return { cash, markets: this.state.markets.size, open, resolved, voided, maxLossBoundOpen: bound, couponCash: this.state.couponHouse, openCoupons };
  }

  /**
   * Инвариант шалгалт (тест/симуляцид): Σ үлдэгдэл + Σ хаусын кэш = Σ оруулсан;
   * үлдэгдэл ≥ 0; магадлалын нийлбэр 1.
   */
  checkInvariants(): void {
    let balances = 0;
    let contributed = 0;
    for (const u of this.state.users.values()) {
      if (u.balance < 0) throw new EngineError('INVARIANT', `Сөрөг үлдэгдэл: ${u.id}`);
      if (!Number.isInteger(u.balance)) throw new EngineError('INVARIANT', `Бутархай үлдэгдэл: ${u.id}`);
      balances += u.balance;
      contributed += u.contributed;
    }
    let house = 0;
    for (const m of this.state.markets.values()) {
      house += m.houseCash;
      const p = prices(m.q, m.b);
      const s = p.reduce((a, c) => a + c, 0);
      if (Math.abs(s - 1) > 1e-9) throw new EngineError('INVARIANT', `Магадлалын нийлбэр ${s}: ${m.id}`);
      for (const [uid, pos] of m.positions) {
        for (const sh of pos) if (sh < -1e-6) throw new EngineError('INVARIANT', `Сөрөг эзэмшил: ${uid} @ ${m.id}`);
      }
    }
    if (balances + house + this.state.couponHouse + this.state.totoHouse !== contributed) {
      throw new EngineError('INVARIANT', `Токен хадгалагдсангүй: ${balances} + ${house} + ${this.state.couponHouse} + ${this.state.totoHouse} ≠ ${contributed}`);
    }
  }
}
