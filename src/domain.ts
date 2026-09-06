/**
 * Домэйний төрлүүд — хэрэглэгч, бөх, тэмцээн, барилдаан, зах зээл, дэвтэр.
 *
 * Токен = бүхэл тоо, виртуал оноо (бодит мөнгө биш). Хувь (share) = бутархай.
 */

import type { Title } from './rating.ts';

export type UserId = string;
export type WrestlerId = string;
export type TournamentId = string;
export type BoutId = string;
export type MarketId = string;
export type TradeId = string;

export type Role = 'admin' | 'member';

export interface User {
  id: UserId;
  name: string;
  role: Role;
  /** Одоогийн үлдэгдэл (токен, бүхэл). */
  balance: number;
  /** Анхны + админы олгосон нийт токен — ашиг/алдагдал тооцоход. */
  contributed: number;
  createdAt: string;
}

/** Цол хүртсэн түүхийн бичлэг. */
export interface TitleRecord {
  title: Title;
  /** YYYY-MM-DD */
  date: string;
  /** «6/6» — хэд давсан / хэдэн даваатай. */
  rounds?: string;
  /** Хаана хүртсэн — «Сэлэнгэ, Цагааннуур». */
  place?: string;
}

export interface Wrestler {
  id: WrestlerId;
  /** Харагдах нэр, жишээ: "Б.Орхонбаяр". */
  name: string;
  /** Бүтэн нэр, жишээ: "Баярсайханы Орхонбаяр". */
  fullName?: string;
  title: Title;
  aimag?: string;
  sum?: string;
  /** YYYY-MM-DD */
  birthDate?: string;
  /** devjee.mn-ийн wid — байвал рейтинг/түүхийг тэндээс авна. */
  devjeeId?: string;
  note?: string;
  /** см */
  height?: number;
  /** кг */
  weight?: number;
  /** Дэвжээ (клуб), жишээ «Таван Хан». */
  club?: string;
  /** Харьяалал / ивээн тэтгэгч. */
  affiliations?: string[];
  /** Цол хүртсэн түүх (огноогоор өсөх). */
  titles?: TitleRecord[];
}

export type RatingSource = 'devjee' | 'local' | 'seed';

export interface RatingEntry {
  rating: number;
  source: RatingSource;
  /** Рейтинг аль өдрийн байдлаар вэ (YYYY-MM-DD эсвэл ISO). */
  asOf: string;
}

export interface Tournament {
  id: TournamentId;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  /** Давааны тоо (Наадам 9 эсвэл 10). */
  rounds: number;
  devjeeId?: string;
  /** Төрөл: "улсын_наадам", "аймгийн_наадам", … (чөлөөт текст). */
  kind?: string;
  place?: string;
  /** Оролцогч бөхчүүд (зэрэг дэвийн дарааллаар) — прогнозд; байхгүй бол барилдаанаас гаргана. */
  entrants?: WrestlerId[];
  /** devjee автомат sync асаалттай эсэх (сервер дахин ассан ч хадгалагдана). */
  syncEnabled?: boolean;
}

export interface BoutResult {
  winnerId: WrestlerId;
  recordedAt: string;
}

export interface Bout {
  id: BoutId;
  tournamentId: TournamentId;
  /** Даваа (1-ээс). */
  round: number;
  aId: WrestlerId;
  bId: WrestlerId;
  scheduledAt?: string;
  result?: BoutResult;
  devjeeMatchId?: string;
}

export type MarketKind = 'bout' | 'custom';
export type MarketStatus = 'open' | 'closed' | 'resolved' | 'voided';

/**
 * Автоматаар шийдэгдэх зах зээлийн дүрэм (тэмцээний явцаас):
 *  - wins_over:  X бөх line-ээс дээш даваа давах уу (үр дүн: [дээш, доош])
 *  - wins_exact: X бөх яг хэд давах (үр дүн: 0..rounds)
 *  - matchup:    А, Б хэн нь илүү холд давах (үр дүн: [А, Б, тэнцүү])
 *  - champion:   аварга хэн (үр дүн: топ-K бөх + «Бусад»)
 */
export type MarketRule =
  | { type: 'wins_over'; tournamentId: TournamentId; wrestlerId: WrestlerId; line: number }
  | { type: 'wins_exact'; tournamentId: TournamentId; wrestlerId: WrestlerId }
  | { type: 'matchup'; tournamentId: TournamentId; aId: WrestlerId; bId: WrestlerId }
  | { type: 'champion'; tournamentId: TournamentId };

export interface Market {
  id: MarketId;
  kind: MarketKind;
  title: string;
  boutId?: BoutId;
  tournamentId?: TournamentId;
  /** Үр дүнгийн нэрс ("Б.Орхонбаяр", "Бусад" …). */
  outcomes: string[];
  /** Үр дүн бүрд харгалзах бөх/объектын id (байхгүй бол null). */
  outcomeRefs: (string | null)[];
  /** LMSR хөрвөх чадвар. */
  b: number;
  /** LMSR-ийн гаргасан хувийн вектор (үр дүн бүрд). */
  q: number[];
  /** Анхны q (анхны магадлалаас) — хаусын алдагдлын хязгаар тооцоход. */
  q0: number[];
  status: MarketStatus;
  createdAt: string;
  closesAt?: string;
  closedAt?: string;
  resolvedAt?: string;
  resolvedOutcome?: number;
  voidReason?: string;
  /** Автомат шийдэлтийн дүрэм (байвал). */
  rule?: MarketRule;
  /** Хэрэглэгч бүрийн эзэмшил: userId → үр дүн бүрийн хувь. */
  positions: Map<UserId, number[]>;
  /** Хэрэглэгч бүрийн цэвэр зарцуулалт (авсан − зарсан) — хүчингүй болгоход буцаана. */
  netCost: Map<UserId, number>;
  /** Нийт эргэлт (токен). */
  volume: number;
  /** Хаусын (зах зээл үүсгэгчийн) энэ зах зээл дэх кэш: + орлого, − төлбөр. */
  houseCash: number;
  tradeCount: number;
}

export type LedgerKind =
  | 'start'
  | 'grant'
  | 'buy'
  | 'sell'
  | 'payout'
  | 'refund'
  | 'coupon'
  | 'coupon_win'
  | 'coupon_refund'
  | 'toto'
  | 'toto_win'
  | 'toto_refund';

// ───────────────────────── тото (пул) ─────────────────────────

export type TotoStatus = 'open' | 'settled' | 'voided';

export interface TotoEntry {
  userId: UserId;
  /** Барилдаан бүрд таасан давагчийн id (алгасвал null). */
  picks: (WrestlerId | null)[];
  at: string;
  /** Шийдэгдсэний дараа. */
  correct?: number;
  payout?: number;
}

export interface Toto {
  id: string;
  title: string;
  tournamentId: TournamentId;
  /** Багтсан барилдаанууд (дараалал тогтмол). */
  boutIds: BoutId[];
  /** Оролцооны хураамж (токен). */
  fee: number;
  status: TotoStatus;
  createdAt: string;
  closesAt?: string;
  settledAt?: string;
  entries: Map<UserId, TotoEntry>;
  /** Цугласан пул (хураамжийн нийлбэр). */
  pool: number;
  /** Шатласан хуваарилалт: [0.6, 0.3, 0.1]. */
  tiers: number[];
}

// ───────────────────────── купон (экспресс / систем) ─────────────────────────

export type CouponKind = 'express' | 'system';
export type CouponStatus = 'open' | 'won' | 'lost' | 'void';

export interface CouponLeg {
  marketId: MarketId;
  outcome: number;
  /** Худалдан авах үеийн зах зээлийн магадлал (тогтмол коэффициент = 1/price). */
  price: number;
  /** Харуулах: зах зээлийн гарчиг ба үр дүнгийн нэр. */
  marketTitle: string;
  outcomeLabel: string;
  /** Шийдэгдсэний дараа. */
  result?: 'won' | 'lost' | 'void';
}

export interface Coupon {
  id: string;
  userId: UserId;
  kind: CouponKind;
  legs: CouponLeg[];
  /** Нийт бооцоо (бүхэл). */
  stake: number;
  /** Систем: хослолын хэмжээнүүд (жишээ [2,3]); экспресс: [n]. */
  sizes: number[];
  /** Хослолын тоо (экспресс = 1). */
  combos: number;
  createdAt: string;
  status: CouponStatus;
  payout?: number;
  settledAt?: string;
}

export interface LedgerEntry {
  id: string;
  at: string;
  userId: UserId;
  kind: LedgerKind;
  /** Үлдэгдлийн өөрчлөлт (+/−). */
  delta: number;
  balanceAfter: number;
  marketId?: MarketId;
  tradeId?: TradeId;
  note?: string;
}

export interface TradeRecord {
  id: TradeId;
  at: string;
  marketId: MarketId;
  userId: UserId;
  outcome: number;
  /** + авсан, − зарсан хувь. */
  shares: number;
  /** Үлдэгдлийн өөрчлөлт: авахад −зарцуулалт, зарахад +орлого. */
  delta: number;
  priceBefore: number;
  priceAfter: number;
  requestId?: string;
}
