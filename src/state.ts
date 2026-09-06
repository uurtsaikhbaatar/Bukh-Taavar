/**
 * Төлөв ба reducer.
 *
 * `apply(state, event)` — цэвэр, детерминист, тоо БОДОХГҮЙ: үйл явдалд бичигдсэн
 * тоог л хэрэгжүүлнэ. Логийг эхнээс нь дахин уншихад яг ижил төлөв гарна.
 * Зөрчил илэрвэл (жишээ нь balanceAfter таарахгүй) StateError шидэж, эвдэрсэн
 * логийг чимээгүй өнгөрөөхгүй.
 */

import type {
  Bout,
  BoutId,
  Coupon,
  Toto,
  LedgerEntry,
  Market,
  MarketId,
  RatingEntry,
  Tournament,
  TournamentId,
  TradeId,
  TradeRecord,
  User,
  UserId,
  Wrestler,
  WrestlerId,
} from './domain.ts';
import type { BukhEvent } from './events.ts';

export class StateError extends Error {}

export interface State {
  users: Map<UserId, User>;
  wrestlers: Map<WrestlerId, Wrestler>;
  ratings: Map<WrestlerId, RatingEntry>;
  tournaments: Map<TournamentId, Tournament>;
  bouts: Map<BoutId, Bout>;
  markets: Map<MarketId, Market>;
  ledger: LedgerEntry[];
  trades: Map<TradeId, TradeRecord>;
  /** `${userId}:${requestId}` → tradeId/couponId — идемпотент давхар илгээлт. */
  requestIndex: Map<string, TradeId>;
  coupons: Map<string, Coupon>;
  /** Купоны хаусын кэш: + бооцоо, − төлбөр. */
  couponHouse: number;
  totos: Map<string, Toto>;
  /** Тотогийн барьцаа (цугласан, тараагаагүй пул). */
  totoHouse: number;
  eventCount: number;
  lastEventAt?: string;
}

export function emptyState(): State {
  return {
    users: new Map(),
    wrestlers: new Map(),
    ratings: new Map(),
    tournaments: new Map(),
    bouts: new Map(),
    markets: new Map(),
    ledger: [],
    trades: new Map(),
    requestIndex: new Map(),
    coupons: new Map(),
    couponHouse: 0,
    totos: new Map(),
    totoHouse: 0,
    eventCount: 0,
  };
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new StateError(`Лог зөрчилтэй: ${what} олдсонгүй.`);
  return value;
}

function applyBalance(state: State, e: BukhEvent, userId: UserId, delta: number, balanceAfter: number, entry: Omit<LedgerEntry, 'id' | 'at' | 'userId' | 'delta' | 'balanceAfter'>): void {
  const user = need(state.users.get(userId), `хэрэглэгч ${userId}`);
  const next = user.balance + delta;
  if (next !== balanceAfter) {
    throw new StateError(
      `Лог зөрчилтэй: ${userId}-ийн үлдэгдэл ${user.balance}+${delta}=${next}, үйл явдалд ${balanceAfter} (${e.type} ${e.id}).`,
    );
  }
  if (next < 0) throw new StateError(`Лог зөрчилтэй: ${userId}-ийн үлдэгдэл сөрөг (${e.id}).`);
  user.balance = next;
  state.ledger.push({ id: `${e.id}:${state.ledger.length}`, at: e.at, userId, delta, balanceAfter, ...entry });
}

/** Үйл явдлыг төлөвт хэрэгжүүлнэ (төлөвийг өөрчилнө). */
export function apply(state: State, e: BukhEvent): void {
  switch (e.type) {
    case 'user_created': {
      if (state.users.has(e.userId)) throw new StateError(`Лог зөрчилтэй: ${e.userId} давхардсан.`);
      state.users.set(e.userId, {
        id: e.userId,
        name: e.name,
        role: e.role,
        balance: 0,
        contributed: e.balance,
        createdAt: e.at,
      });
      applyBalance(state, e, e.userId, e.balance, e.balance, { kind: 'start', note: 'Эхлэлийн токен' });
      break;
    }
    case 'tokens_granted': {
      const user = need(state.users.get(e.userId), `хэрэглэгч ${e.userId}`);
      user.contributed += e.amount;
      applyBalance(state, e, e.userId, e.amount, e.balanceAfter, { kind: 'grant', note: e.reason });
      break;
    }
    case 'wrestler_added': {
      if (state.wrestlers.has(e.wrestler.id)) throw new StateError(`Лог зөрчилтэй: бөх ${e.wrestler.id} давхардсан.`);
      state.wrestlers.set(e.wrestler.id, { ...e.wrestler });
      break;
    }
    case 'wrestler_updated': {
      const w = need(state.wrestlers.get(e.wrestlerId), `бөх ${e.wrestlerId}`);
      Object.assign(w, e.patch);
      break;
    }
    case 'rating_set': {
      need(state.wrestlers.get(e.wrestlerId), `бөх ${e.wrestlerId}`);
      const prev = state.ratings.get(e.wrestlerId);
      const entry: RatingEntry = { rating: e.rating, source: e.source, asOf: e.asOf };
      // games/lastBoutAt өгөгдөөгүй бол өмнөх утгыг хадгална (зөвхөн рейтинг шинэчлэх үйл явдал)
      const games = e.games ?? prev?.games;
      const lastBoutAt = e.lastBoutAt ?? prev?.lastBoutAt;
      if (games !== undefined) entry.games = games;
      if (lastBoutAt !== undefined) entry.lastBoutAt = lastBoutAt;
      state.ratings.set(e.wrestlerId, entry);
      break;
    }
    case 'tournament_created': {
      if (state.tournaments.has(e.tournament.id)) throw new StateError(`Лог зөрчилтэй: тэмцээн ${e.tournament.id} давхардсан.`);
      state.tournaments.set(e.tournament.id, { ...e.tournament });
      break;
    }
    case 'tournament_updated': {
      const t = need(state.tournaments.get(e.tournamentId), `тэмцээн ${e.tournamentId}`);
      Object.assign(t, e.patch);
      break;
    }
    case 'bout_created': {
      if (state.bouts.has(e.bout.id)) throw new StateError(`Лог зөрчилтэй: барилдаан ${e.bout.id} давхардсан.`);
      need(state.tournaments.get(e.bout.tournamentId), `тэмцээн ${e.bout.tournamentId}`);
      state.bouts.set(e.bout.id, { ...e.bout });
      break;
    }
    case 'bout_result': {
      const bout = need(state.bouts.get(e.boutId), `барилдаан ${e.boutId}`);
      bout.result = { winnerId: e.winnerId, recordedAt: e.at };
      // Бодит барилдаан (гоц биш → ratingUpdates-тэй): туршлага +1, сүүлийн барилдааны огноо
      for (const u of e.ratingUpdates) {
        const prev = state.ratings.get(u.wrestlerId);
        state.ratings.set(u.wrestlerId, { rating: u.rating, source: u.source, asOf: u.asOf, games: (prev?.games ?? 0) + 1, lastBoutAt: e.at });
      }
      break;
    }
    case 'market_created': {
      const m = e.market;
      if (state.markets.has(m.id)) throw new StateError(`Лог зөрчилтэй: зах зээл ${m.id} давхардсан.`);
      const market: Market = {
        id: m.id,
        kind: m.kind,
        title: m.title,
        outcomes: [...m.outcomes],
        outcomeRefs: [...m.outcomeRefs],
        b: m.b,
        q: [...m.q0],
        q0: [...m.q0],
        status: 'open',
        createdAt: e.at,
        positions: new Map(),
        netCost: new Map(),
        volume: 0,
        houseCash: 0,
        tradeCount: 0,
      };
      if (m.boutId !== undefined) market.boutId = m.boutId;
      if (m.tournamentId !== undefined) market.tournamentId = m.tournamentId;
      if (m.closesAt !== undefined) market.closesAt = m.closesAt;
      if (m.rule !== undefined) market.rule = structuredClone(m.rule);
      state.markets.set(m.id, market);
      break;
    }
    case 'market_closed': {
      const market = need(state.markets.get(e.marketId), `зах зээл ${e.marketId}`);
      if (market.status !== 'open') throw new StateError(`Лог зөрчилтэй: ${e.marketId} нээлттэй биш байхад хаагдав.`);
      market.status = 'closed';
      market.closedAt = e.at;
      break;
    }
    case 'trade': {
      const market = need(state.markets.get(e.marketId), `зах зээл ${e.marketId}`);
      if (market.status !== 'open') throw new StateError(`Лог зөрчилтэй: ${e.marketId} нээлттэй биш байхад арилжаа хийв.`);
      if (e.qAfter.length !== market.q.length) throw new StateError(`Лог зөрчилтэй: q урт зөрүүтэй (${e.id}).`);
      if (state.trades.has(e.tradeId)) throw new StateError(`Лог зөрчилтэй: арилжаа ${e.tradeId} давхардсан.`);
      const pos = market.positions.get(e.userId) ?? new Array<number>(market.q.length).fill(0);
      pos[e.outcome] = (pos[e.outcome] ?? 0) + e.shares;
      market.positions.set(e.userId, pos);
      market.netCost.set(e.userId, (market.netCost.get(e.userId) ?? 0) - e.delta);
      market.q = [...e.qAfter];
      market.volume += Math.abs(e.delta);
      market.houseCash -= e.delta;
      market.tradeCount += 1;
      applyBalance(state, e, e.userId, e.delta, e.balanceAfter, {
        kind: e.delta < 0 ? 'buy' : 'sell',
        marketId: e.marketId,
        tradeId: e.tradeId,
      });
      const record: TradeRecord = {
        id: e.tradeId,
        at: e.at,
        marketId: e.marketId,
        userId: e.userId,
        outcome: e.outcome,
        shares: e.shares,
        delta: e.delta,
        priceBefore: e.priceBefore,
        priceAfter: e.priceAfter,
      };
      if (e.requestId !== undefined) {
        record.requestId = e.requestId;
        state.requestIndex.set(`${e.userId}:${e.requestId}`, e.tradeId);
      }
      state.trades.set(e.tradeId, record);
      break;
    }
    case 'market_resolved': {
      const market = need(state.markets.get(e.marketId), `зах зээл ${e.marketId}`);
      if (market.status === 'resolved' || market.status === 'voided') {
        throw new StateError(`Лог зөрчилтэй: ${e.marketId} аль хэдийн дууссан.`);
      }
      market.status = 'resolved';
      market.resolvedAt = e.at;
      market.resolvedOutcome = e.outcome;
      for (const p of e.payouts) {
        market.houseCash -= p.amount;
        applyBalance(state, e, p.userId, p.amount, p.balanceAfter, {
          kind: 'payout',
          marketId: e.marketId,
          note: `${market.outcomes[e.outcome] ?? e.outcome} — ${p.shares.toFixed(2)} хувь`,
        });
      }
      break;
    }
    case 'market_voided': {
      const market = need(state.markets.get(e.marketId), `зах зээл ${e.marketId}`);
      if (market.status === 'resolved' || market.status === 'voided') {
        throw new StateError(`Лог зөрчилтэй: ${e.marketId} аль хэдийн дууссан.`);
      }
      market.status = 'voided';
      market.resolvedAt = e.at;
      market.voidReason = e.reason;
      for (const r of e.refunds) {
        market.houseCash -= r.amount;
        applyBalance(state, e, r.userId, r.amount, r.balanceAfter, {
          kind: 'refund',
          marketId: e.marketId,
          note: e.reason,
        });
      }
      break;
    }
    case 'coupon_placed': {
      if (state.coupons.has(e.couponId)) throw new StateError(`Лог зөрчилтэй: купон ${e.couponId} давхардсан.`);
      const coupon: Coupon = {
        id: e.couponId,
        userId: e.userId,
        kind: e.kind,
        legs: e.legs.map((l) => ({ ...l })),
        stake: e.stake,
        sizes: [...e.sizes],
        combos: e.combos,
        createdAt: e.at,
        status: 'open',
      };
      state.coupons.set(e.couponId, coupon);
      state.couponHouse += e.stake;
      applyBalance(state, e, e.userId, -e.stake, e.balanceAfter, {
        kind: 'coupon',
        note: `${e.kind === 'express' ? 'Экспресс' : 'Систем'} ${e.legs.length} сонголт`,
      });
      if (e.requestId !== undefined) state.requestIndex.set(`${e.userId}:${e.requestId}`, e.couponId);
      break;
    }
    case 'coupon_settled': {
      const coupon = need(state.coupons.get(e.couponId), `купон ${e.couponId}`);
      if (coupon.status !== 'open') throw new StateError(`Лог зөрчилтэй: купон ${e.couponId} аль хэдийн шийдэгдсэн.`);
      coupon.status = e.status;
      coupon.settledAt = e.at;
      coupon.payout = e.payout;
      e.legResults.forEach((r, i) => {
        const leg = coupon.legs[i];
        if (leg) leg.result = r;
      });
      state.couponHouse -= e.payout;
      if (e.payout > 0) {
        applyBalance(state, e, e.userId, e.payout, e.balanceAfter, {
          kind: e.status === 'void' ? 'coupon_refund' : 'coupon_win',
          note: e.status === 'void' ? 'Купон хүчингүй — буцаалт' : `Купон давлаа (${coupon.legs.length} сонголт)`,
        });
      } else if (e.balanceAfter !== need(state.users.get(e.userId), `хэрэглэгч ${e.userId}`).balance) {
        throw new StateError(`Лог зөрчилтэй: купон ${e.couponId} — үлдэгдэл таарахгүй.`);
      }
      break;
    }
    case 'toto_created': {
      const t = e.toto;
      if (state.totos.has(t.id)) throw new StateError(`Лог зөрчилтэй: тото ${t.id} давхардсан.`);
      need(state.tournaments.get(t.tournamentId), `тэмцээн ${t.tournamentId}`);
      const toto: Toto = {
        id: t.id,
        title: t.title,
        tournamentId: t.tournamentId,
        boutIds: [...t.boutIds],
        fee: t.fee,
        status: 'open',
        createdAt: e.at,
        entries: new Map(),
        pool: 0,
        tiers: [...t.tiers],
      };
      if (t.closesAt !== undefined) toto.closesAt = t.closesAt;
      state.totos.set(t.id, toto);
      break;
    }
    case 'toto_entered': {
      const toto = need(state.totos.get(e.totoId), `тото ${e.totoId}`);
      if (toto.status !== 'open') throw new StateError(`Лог зөрчилтэй: тото ${e.totoId} нээлттэй биш.`);
      if (toto.entries.has(e.userId)) throw new StateError(`Лог зөрчилтэй: ${e.userId} тотод давхар орсон.`);
      toto.entries.set(e.userId, { userId: e.userId, picks: [...e.picks], at: e.at });
      toto.pool += e.fee;
      state.totoHouse += e.fee;
      applyBalance(state, e, e.userId, -e.fee, e.balanceAfter, { kind: 'toto', note: toto.title });
      if (e.requestId !== undefined) state.requestIndex.set(`${e.userId}:${e.requestId}`, e.totoId);
      break;
    }
    case 'toto_settled': {
      const toto = need(state.totos.get(e.totoId), `тото ${e.totoId}`);
      if (toto.status !== 'open') throw new StateError(`Лог зөрчилтэй: тото ${e.totoId} аль хэдийн шийдэгдсэн.`);
      toto.status = e.status;
      toto.settledAt = e.at;
      for (const r of e.results) {
        const entry = toto.entries.get(r.userId);
        if (entry) {
          entry.correct = r.correct;
          entry.payout = r.payout;
        }
        state.totoHouse -= r.payout;
        if (r.payout > 0) {
          applyBalance(state, e, r.userId, r.payout, r.balanceAfter, {
            kind: e.status === 'voided' ? 'toto_refund' : 'toto_win',
            note: e.status === 'voided' ? `${toto.title} — хүчингүй, буцаалт` : `${toto.title} — ${r.correct} зөв`,
          });
        }
      }
      break;
    }
    default: {
      const never: never = e;
      throw new StateError(`Танигдаагүй үйл явдал: ${JSON.stringify(never)}`);
    }
  }
  state.eventCount += 1;
  state.lastEventAt = e.at;
}

/** Үйл явдлын дарааллаас төлөв босгоно. */
export function replay(events: Iterable<BukhEvent>): State {
  const state = emptyState();
  for (const e of events) apply(state, e);
  return state;
}

/**
 * Төлөвийг JSON-д хөрвөх энгийн объект болгоно (Map → эрэмбэлсэн объект).
 * Тест/харьцуулалт, snapshot-д хэрэглэнэ.
 */
export function serializeState(state: State): unknown {
  const mapToObj = <V>(m: Map<string, V>, conv: (v: V) => unknown = (v) => v): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of [...m.keys()].sort()) out[k] = conv(m.get(k)!);
    return out;
  };
  return {
    users: mapToObj(state.users),
    wrestlers: mapToObj(state.wrestlers),
    ratings: mapToObj(state.ratings),
    tournaments: mapToObj(state.tournaments),
    bouts: mapToObj(state.bouts),
    markets: mapToObj(state.markets, (m) => ({
      ...m,
      positions: mapToObj(m.positions),
      netCost: mapToObj(m.netCost),
    })),
    ledger: state.ledger,
    trades: mapToObj(state.trades),
    requestIndex: mapToObj(state.requestIndex),
    coupons: mapToObj(state.coupons),
    couponHouse: state.couponHouse,
    totos: mapToObj(state.totos, (t) => ({ ...t, entries: mapToObj(t.entries) })),
    totoHouse: state.totoHouse,
    eventCount: state.eventCount,
    lastEventAt: state.lastEventAt ?? null,
  };
}
