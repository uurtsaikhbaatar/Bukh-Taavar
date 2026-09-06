/**
 * Үйл явдлын лог — системийн цорын ганц үнэн эх сурвалж.
 *
 * Зарчим: команд → баталгаажуулалт → үйл явдал (append-only) → төлөв.
 * Тоо бодох (LMSR, тойм, төлбөр) бүгд командын үед хийгдэж үр дүн нь үйл
 * явдалд БИЧИГДЭНЭ; reducer (state.ts) дахин тооцохгүй, зөвхөн хэрэгжүүлнэ.
 * Ингэснээр логийг дахин уншихад төлөв яг ижил, математик өөрчлөгдсөн ч
 * түүх өөрчлөгдөхгүй.
 */

import type {
  Bout,
  BoutId,
  CouponKind,
  CouponLeg,
  MarketId,
  MarketKind,
  MarketRule,
  RatingSource,
  Role,
  Tournament,
  TradeId,
  UserId,
  Wrestler,
  WrestlerId,
} from './domain.ts';

interface Base {
  /** Үйл явдлын өвөрмөц id. */
  id: string;
  /** ISO цаг (UTC). */
  at: string;
}

export interface UserCreated extends Base {
  type: 'user_created';
  userId: UserId;
  name: string;
  role: Role;
  /** Эхлэлийн үлдэгдэл. */
  balance: number;
}

export interface TokensGranted extends Base {
  type: 'tokens_granted';
  userId: UserId;
  amount: number;
  reason: string;
  balanceAfter: number;
}

export interface WrestlerAdded extends Base {
  type: 'wrestler_added';
  wrestler: Wrestler;
}

export interface WrestlerUpdated extends Base {
  type: 'wrestler_updated';
  wrestlerId: WrestlerId;
  patch: Partial<Omit<Wrestler, 'id'>>;
}

export interface RatingSet extends Base {
  type: 'rating_set';
  wrestlerId: WrestlerId;
  rating: number;
  source: RatingSource;
  asOf: string;
  /** Бодит барилдааны тоо (архивын гүйлтээс) — өгөхгүй бол өмнөх утга хадгалагдана. */
  games?: number;
  /** Сүүлд барилдсан огноо — өгөхгүй бол өмнөх утга хадгалагдана. */
  lastBoutAt?: string;
}

export interface TournamentCreated extends Base {
  type: 'tournament_created';
  tournament: Tournament;
}

export interface TournamentUpdated extends Base {
  type: 'tournament_updated';
  tournamentId: string;
  patch: Partial<Omit<Tournament, 'id'>>;
}

export interface BoutCreated extends Base {
  type: 'bout_created';
  bout: Bout;
}

export interface BoutResultRecorded extends Base {
  type: 'bout_result';
  boutId: BoutId;
  winnerId: WrestlerId;
  /** Elo шинэчлэлт (байвал) — reducer шууд хэрэгжүүлнэ. */
  ratingUpdates: { wrestlerId: WrestlerId; rating: number; source: RatingSource; asOf: string }[];
}

export interface MarketCreated extends Base {
  type: 'market_created';
  market: {
    id: MarketId;
    kind: MarketKind;
    title: string;
    boutId?: BoutId;
    tournamentId?: string;
    outcomes: string[];
    outcomeRefs: (string | null)[];
    b: number;
    q0: number[];
    closesAt?: string;
    rule?: MarketRule;
  };
}

export interface MarketClosed extends Base {
  type: 'market_closed';
  marketId: MarketId;
}

export interface Trade extends Base {
  type: 'trade';
  tradeId: TradeId;
  marketId: MarketId;
  userId: UserId;
  outcome: number;
  /** + авсан, − зарсан хувь. */
  shares: number;
  /** Хэрэглэгчийн үлдэгдлийн өөрчлөлт: авахад −S, зарахад +P (бүхэл). */
  delta: number;
  qAfter: number[];
  balanceAfter: number;
  priceBefore: number;
  priceAfter: number;
  requestId?: string;
}

export interface MarketResolved extends Base {
  type: 'market_resolved';
  marketId: MarketId;
  outcome: number;
  payouts: { userId: UserId; shares: number; amount: number; balanceAfter: number }[];
}

export interface MarketVoided extends Base {
  type: 'market_voided';
  marketId: MarketId;
  reason: string;
  refunds: { userId: UserId; amount: number; balanceAfter: number }[];
}

export interface CouponPlaced extends Base {
  type: 'coupon_placed';
  couponId: string;
  userId: UserId;
  kind: CouponKind;
  legs: CouponLeg[];
  stake: number;
  sizes: number[];
  combos: number;
  balanceAfter: number;
  requestId?: string;
}

export interface CouponSettled extends Base {
  type: 'coupon_settled';
  couponId: string;
  userId: UserId;
  status: 'won' | 'lost' | 'void';
  legResults: ('won' | 'lost' | 'void')[];
  payout: number;
  balanceAfter: number;
}

export interface TotoCreated extends Base {
  type: 'toto_created';
  toto: { id: string; title: string; tournamentId: string; boutIds: BoutId[]; fee: number; tiers: number[]; closesAt?: string };
}

export interface TotoEntered extends Base {
  type: 'toto_entered';
  totoId: string;
  userId: UserId;
  picks: (WrestlerId | null)[];
  fee: number;
  balanceAfter: number;
  requestId?: string;
}

export interface TotoSettled extends Base {
  type: 'toto_settled';
  totoId: string;
  status: 'settled' | 'voided';
  /** Давагчид (хамгийн олон зөв таасан гурван шат). */
  results: { userId: UserId; correct: number; payout: number; balanceAfter: number }[];
  /** Зөв таасан тоо (шийдэгдсэн барилдаанаас). */
  scored: number;
}

export type BukhEvent =
  | UserCreated
  | TokensGranted
  | CouponPlaced
  | CouponSettled
  | TotoCreated
  | TotoEntered
  | TotoSettled
  | WrestlerAdded
  | WrestlerUpdated
  | RatingSet
  | TournamentCreated
  | TournamentUpdated
  | BoutCreated
  | BoutResultRecorded
  | MarketCreated
  | MarketClosed
  | Trade
  | MarketResolved
  | MarketVoided;

export type EventType = BukhEvent['type'];

const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'user_created',
  'tokens_granted',
  'wrestler_added',
  'wrestler_updated',
  'rating_set',
  'tournament_created',
  'tournament_updated',
  'bout_created',
  'bout_result',
  'market_created',
  'market_closed',
  'trade',
  'market_resolved',
  'market_voided',
  'coupon_placed',
  'coupon_settled',
  'toto_created',
  'toto_entered',
  'toto_settled',
]);

/** Логоос уншсан объект үйл явдал мөн эсэхийг бүдүүвчээр шалгана. */
export function isBukhEvent(value: unknown): value is BukhEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.at === 'string' && typeof v.type === 'string' && EVENT_TYPES.has(v.type);
}
