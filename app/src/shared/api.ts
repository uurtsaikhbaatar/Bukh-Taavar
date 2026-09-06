/**
 * Сервер ↔ апп хоорондын JSON хэлбэрүүд (DTO).
 *
 * Энэ файлыг сервер (`server/api.ts`) ба апп хоёулаа импортолно — зөвхөн
 * төрөл, Node/React-аас хамааралгүй.
 */

export type Role = 'admin' | 'member';
export type MarketStatus = 'open' | 'closed' | 'resolved' | 'voided';
export type MarketKind = 'bout' | 'custom';

export interface AccountDto {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: Role;
}

export interface MeDto {
  account: AccountDto;
  balance: number;
  contributed: number;
}

export interface WrestlerDto {
  id: string;
  name: string;
  /** Овог нэр: «Баярсайханы Орхонбаяр». */
  fullName?: string;
  title: string;
  titleLabel: string;
  aimag?: string;
  sum?: string;
  /** «Сэлэнгэ, Цагааннуур» — аймаг + сум. */
  place?: string;
  birthDate?: string;
  rating: number;
  ratingSource: 'devjee' | 'local' | 'seed';
  devjeeId?: string;
  height?: number;
  weight?: number;
  club?: string;
  affiliations?: string[];
  /** Цол хүртсэн түүх (огноогоор өсөх). */
  titles?: { title: string; titleLabel: string; date: string; rounds?: string; place?: string }[];
}

export interface BoutDto {
  id: string;
  tournamentId: string;
  round: number;
  a: WrestlerDto;
  b: WrestlerDto;
  /** Загварын магадлал (Elo) — А тал. */
  priorA: number;
  winnerId?: string;
  scheduledAt?: string;
}

export interface MarketDto {
  id: string;
  kind: MarketKind;
  title: string;
  status: MarketStatus;
  outcomes: string[];
  outcomeRefs: (string | null)[];
  /** Зах зээлийн одоогийн магадлал. */
  probs: number[];
  /** Загварын (анхны) магадлал. */
  modelProbs: number[];
  b: number;
  volume: number;
  tradeCount: number;
  traders: number;
  createdAt: string;
  closesAt?: string;
  resolvedOutcome?: number;
  voidReason?: string;
  boutId?: string;
  tournamentId?: string;
  tournamentName?: string;
  round?: number;
  /** Барилдааны зах зээлд — хоёр бөхийн мэдээлэл (овог нэр, цол, нутаг). */
  wrestlers?: { a: WrestlerDto; b: WrestlerDto };
  /** Миний эзэмшил (үр дүн бүрд хувь) ба цэвэр зарцуулалт. */
  myPosition?: number[];
  myNetCost?: number;
}

export interface TradeDto {
  id: string;
  at: string;
  marketId: string;
  userId: string;
  userName?: string;
  outcome: number;
  shares: number;
  delta: number;
  priceBefore: number;
  priceAfter: number;
}

export interface MarketDetailDto {
  market: MarketDto;
  bout?: BoutDto;
  recentTrades: TradeDto[];
}

export interface QuoteDto {
  marketId: string;
  outcome: number;
  spend: number;
  shares: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  payoutIfWin: number;
  multiplier: number;
}

export interface SellQuoteDto {
  marketId: string;
  outcome: number;
  shares: number;
  proceeds: number;
  priceBefore: number;
  priceAfter: number;
}

export interface TradeResultDto {
  trade: TradeDto;
  market: MarketDto;
  balance: number;
}

/** Самбараас олон дан бооцоо нэг дор тавихад. */
export interface BatchBuyOrder {
  marketId: string;
  outcome: number;
  spend: number;
  requestId?: string;
}

export interface BatchBuyResultDto {
  results: { marketId: string; ok: boolean; trade?: TradeDto; probs?: number[]; error?: string; code?: string }[];
  placed: number;
  balance: number;
}

export interface PositionDto {
  marketId: string;
  title: string;
  status: MarketStatus;
  outcome: number;
  outcomeLabel: string;
  shares: number;
  price: number;
  value: number;
  netCost: number;
}

export interface LedgerDto {
  id: string;
  at: string;
  kind: 'start' | 'grant' | 'buy' | 'sell' | 'payout' | 'refund' | 'coupon' | 'coupon_win' | 'coupon_refund' | 'toto' | 'toto_win' | 'toto_refund';
  delta: number;
  balanceAfter: number;
  marketId?: string;
  marketTitle?: string;
  note?: string;
}

export interface PortfolioDto {
  balance: number;
  contributed: number;
  positions: PositionDto[];
  ledger: LedgerDto[];
  coupons: CouponDto[];
}

// ── купон (экспресс / систем) ──

export type CouponKind = 'express' | 'system';
export type CouponStatus = 'open' | 'won' | 'lost' | 'void';

export interface CouponLegDto {
  marketId: string;
  outcome: number;
  price: number;
  marketTitle: string;
  outcomeLabel: string;
  result?: 'won' | 'lost' | 'void';
}

export interface CouponDto {
  id: string;
  kind: CouponKind;
  legs: CouponLegDto[];
  stake: number;
  sizes: number[];
  combos: number;
  status: CouponStatus;
  payout?: number;
  createdAt: string;
  settledAt?: string;
  /** Экспресс: коэффициент (тааз тооцсон); систем: дээд боломжит төлбөр/бооцоо. */
  coefficient: number;
  maxPayout: number;
}

export interface CouponQuoteDto {
  kind: CouponKind;
  legs: CouponLegDto[];
  stake: number;
  sizes: number[];
  combos: number;
  unitStake: number;
  coefficient: number;
  maxPayout: number;
  capped: boolean;
}

// ── тото (пул) ──

export type TotoStatus = 'open' | 'settled' | 'voided';

export interface TotoBoutDto {
  boutId: string;
  round: number;
  a: { id: string; name: string; titleLabel: string; place?: string; rating: number };
  b: { id: string; name: string; titleLabel: string; place?: string; rating: number };
  priorA: number;
  winnerId?: string;
}

export interface TotoEntryDto {
  userId: string;
  userName: string;
  picks: (string | null)[];
  correct?: number;
  payout?: number;
  me: boolean;
}

export interface TotoDto {
  id: string;
  title: string;
  tournamentId: string;
  tournamentName?: string;
  status: TotoStatus;
  fee: number;
  pool: number;
  tiers: number[];
  createdAt: string;
  closesAt?: string;
  settledAt?: string;
  bouts: TotoBoutDto[];
  entries: TotoEntryDto[];
  /** Миний оролт (байвал). */
  myPicks?: (string | null)[];
  /** Шинээр орох боломжтой эсэх (нээлттэй, барилдаан эхлээгүй, би ороогүй). */
  canEnter: boolean;
}

export interface CouponRequest {
  legs: { marketId: string; outcome: number }[];
  stake: number;
  kind: CouponKind;
  sizes?: number[];
  requestId?: string;
}

export interface LeaderboardRowDto {
  rank: number;
  userId: string;
  name: string;
  balance: number;
  positionsValue: number;
  total: number;
  pnl: number;
  me: boolean;
}

/** Давааны төлөв (админ удирдлага + бооцооны самбарын толгой). */
export interface RoundStatusDto {
  rounds: number;
  perRound: { round: number; total: number; pending: number }[];
  /** Хамгийн сүүлд эхэлсэн даваа (0 = эхлээгүй). */
  current: number;
  /** Дараагийн эхлүүлж болох даваа (0 = одоогийнх дуусаагүй эсвэл тэмцээн дууссан). */
  next: number;
  /** Унаагүй бөхийн тоо. */
  alive: number;
  entrants: number;
  finished: boolean;
  championId?: string;
  championName?: string;
}

export interface TournamentDto {
  id: string;
  name: string;
  date: string;
  rounds: number;
  kind?: string;
  place?: string;
  devjeeId?: string;
  boutCount: number;
  openMarkets: number;
  syncEnabled: boolean;
  /** Одоо явж буй даваа (0 = эхлээгүй) ба түүний хүлээгдэж буй/нийт барилдаан. */
  currentRound: number;
  currentPending: number;
  currentTotal: number;
  finished: boolean;
  championName?: string;
  entrants: number;
}

export interface TournamentDetailDto {
  tournament: TournamentDto;
  status: RoundStatusDto;
  bouts: BoutDto[];
  markets: MarketDto[];
}

/** Бооцооны самбар — тухайн давааны хосууд. */
export interface BoardSideDto {
  id: string;
  name: string;
  fullName?: string;
  titleLabel: string;
  place?: string;
  rating: number;
}

export interface BoardBoutDto {
  id: string;
  round: number;
  marketId?: string;
  /** Зах зээлийн төлөв; `none` = зах зээлгүй барилдаан. */
  status: MarketStatus | 'none';
  a: BoardSideDto;
  b: BoardSideDto;
  /** Зах зээлийн магадлал [А, Б]. */
  probs: [number, number];
  /** Загварын (Elo) магадлал [А, Б]. */
  model: [number, number];
  volume: number;
  winnerId?: string;
  /** Миний эзэмшил [А хувь, Б хувь] ба цэвэр зарцуулалт. */
  myShares?: [number, number];
  myCost?: number;
}

export interface BoardDto {
  tournament: TournamentDto;
  status: RoundStatusDto;
  /** Харуулж буй даваа. */
  round: number;
  bouts: BoardBoutDto[];
}

export interface HomeDto {
  me: MeDto;
  tournaments: TournamentDto[];
  /** Нээлттэй + сүүлд шийдэгдсэн зах зээлүүд (барилдааны зах зээл орохгүй — тэд самбар дээр). */
  markets: MarketDto[];
}

export interface AdminUserDto {
  account: AccountDto;
  balance: number;
  contributed: number;
  createdAt?: string;
}

export interface DevjeeHomeDto {
  scheduled: DevjeeTournamentDto[];
  recent: DevjeeTournamentDto[];
}

export interface DevjeeTournamentDto {
  id: string;
  name: string;
  date: string;
  place?: string;
  imported: boolean;
}

export interface DevjeeSyncStatusDto {
  tournamentId: string;
  devjeeId: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastError?: string;
  wrestlers: number;
  bouts: number;
  resolved: number;
}

/** Тэмцээний Монте-Карло прогноз. */
export interface ForecastDto {
  tournamentId: string;
  rounds: number;
  sims: number;
  entrants: number;
  knownResults: number;
  finished: boolean;
  /** Аваргын магадлалаар эрэмбэлсэн эхний N бөх. */
  champions: { id: string; name: string; titleLabel: string; place?: string; rating: number; pChampion: number; expectedWins: number; eliminated?: number }[];
  /** Хүссэн бөхийн «хэд давах» тархалт (k = 0..rounds). */
  wrestler?: { id: string; name: string; dist: number[]; expectedWins: number; eliminated?: number };
  /** Хүссэн хоёр бөхийн «хэн холдох». */
  matchup?: { aId: string; bId: string; probs: [number, number, number] };
}

export type MarketRuleDto =
  | { type: 'wins_over'; tournamentId: string; wrestlerId: string; line: number }
  | { type: 'wins_exact'; tournamentId: string; wrestlerId: string }
  | { type: 'matchup'; tournamentId: string; aId: string; bId: string }
  | { type: 'champion'; tournamentId: string; topK?: number };

/** Хоёр бөхийн хоорондын харьцаа + гинж + загварууд (архив дээр). */
export interface H2hDto {
  a: { id: string; name: string; title: string; wins: number; losses: number };
  b: { id: string; name: string; title: string; wins: number; losses: number };
  direct: { aWins: number; bWins: number; bouts: { date: string; round: number; winnerId: string; tournament: string }[] };
  chain: {
    pA: number;
    connected: boolean;
    maxHops: number;
    perHop: { k: number; ab: number; ba: number }[];
    pathsAB: { names: string[]; dates: string[]; prob: number }[];
    pathsBA: { names: string[]; dates: string[]; prob: number }[];
  };
  bt: { pA: number; eloA: number; eloB: number } | null;
  elo: { pA: number; ratingA: number; ratingB: number } | null;
}

export type SseMessage =
  | { type: 'hello'; at: string }
  | { type: 'changed'; marketIds?: string[]; userIds?: string[]; at: string };

export interface ApiError {
  error: string;
  code: string;
}
