/**
 * HTTP API — Engine + Auth-ыг JSON endpoint болгоно.
 *
 * Зарчим: бизнес логик Engine/Auth-д; энд зөвхөн (1) эрх шалгах, (2) оролт
 * задлах, (3) Engine дуудах, (4) `flush()` — лог бичигдсэний ДАРАА хариулах,
 * (5) SSE-ээр «өөрчлөгдлөө» гэж мэдэгдэх.
 *
 * Session: cookie `bukh_session` (HttpOnly, SameSite=Lax) эсвэл
 * `Authorization: Bearer <token>` (Expo dev сервер өөр порт дээр байхад).
 * SSE-д зөвхөн `?token=` (EventSource толгой тавьж чаддаггүй).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import type {
  AccountDto,
  AdminUserDto,
  BatchBuyResultDto,
  BoardBoutDto,
  BoardDto,
  BoardSideDto,
  BoutDto,
  CouponDto,
  CouponQuoteDto,
  DevjeeHomeDto,
  DevjeeSyncStatusDto,
  HomeDto,
  LeaderboardRowDto,
  LedgerDto,
  MarketDetailDto,
  MarketDto,
  MeDto,
  PortfolioDto,
  PositionDto,
  QuoteDto,
  RoundStatusDto,
  SellQuoteDto,
  SseMessage,
  TotoDto,
  TotoEntryDto,
  TournamentDetailDto,
  TournamentDto,
  TradeDto,
  TradeResultDto,
  WrestlerBoutsDto,
  WrestlerDetailDto,
  WrestlerDto,
} from '../app/src/shared/api.ts';
import type { Bout, Coupon, LedgerEntry, Market, Toto, Tournament, TradeRecord, Wrestler } from '../src/domain.ts';
import { Engine } from '../src/engine.ts';
import { prices } from '../src/lmsr.ts';
import { isTitle, titleInfo, titleLabel } from '../src/rating.ts';
import type { Analytics } from './analytics.ts';
import { Auth, SESSION_DAYS, type Account } from './auth.ts';
import type { DevjeeSync } from './devjee-sync.ts';
import { ForecastService } from './forecast-service.ts';
import { HttpError, RateLimiter, RESPONDED, Router, setCookie, SseHub, type Ctx } from './http.ts';

export const SESSION_COOKIE = 'bukh_session';

export interface ApiDeps {
  engine: Engine;
  auth: Auth;
  /** Логийг бат бөх хадгална (Postgres); JSONL-д no-op. */
  flush: () => Promise<void>;
  hub: SseHub;
  devjee?: DevjeeSync;
  /** Архивын шинжилгээ (хоорондын харьцаа, гинж, BT) — байвал. */
  analytics?: Analytics;
  now?: () => number;
  secureCookies?: boolean;
  /** flush бүтэлгүйтэх зэрэг ноцтой алдаа — анхдагч: лог бичээд процесс зогсооно. */
  onFatal?: (err: unknown) => void;
  /** /health-д харуулах орчны мэдээлэл (нууц биш). */
  info?: { storage: 'postgres' | 'jsonl'; email: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function str(body: unknown, key: string, required = true): string {
  const v = isRecord(body) ? body[key] : undefined;
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number') return String(v);
  if (required) throw new HttpError(400, `«${key}» талбар дутуу.`, 'BAD_INPUT');
  return '';
}

function num(body: unknown, key: string, required = true): number {
  const v = isRecord(body) ? body[key] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (required) throw new HttpError(400, `«${key}» тоо байх ёстой.`, 'BAD_INPUT');
  return NaN;
}

function optStr(body: unknown, key: string): string | undefined {
  const v = str(body, key, false);
  return v === '' ? undefined : v;
}

function optNum(body: unknown, key: string): number | undefined {
  const v = num(body, key, false);
  return Number.isNaN(v) ? undefined : v;
}

function bool(body: unknown, key: string, def = false): boolean {
  const v = isRecord(body) ? body[key] : undefined;
  return typeof v === 'boolean' ? v : def;
}

function strArray(body: unknown, key: string): string[] {
  const v = isRecord(body) ? body[key] : undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, `«${key}» текстийн массив байх ёстой.`, 'BAD_INPUT');
  return v as string[];
}

export function createRouter(deps: ApiDeps): Router {
  const { engine, auth, hub } = deps;
  const now = deps.now ?? (() => Date.now());
  const onFatal =
    deps.onFatal ??
    ((err: unknown) => {
      console.error('НОЦТОЙ: лог бичиж чадсангүй — процесс зогсоно.', err);
      setTimeout(() => process.exit(1), 100);
    });
  const authLimiter = new RateLimiter(12, 60_000, now);
  const tradeLimiter = new RateLimiter(6, 2_000, now);
  const forecasts = new ForecastService(engine);
  const router = new Router();

  // ── DTO хөрвүүлэлт ──

  const wrestlerDto = (w: Wrestler): WrestlerDto => {
    const r = engine.rating(w.id);
    const dto: WrestlerDto = { id: w.id, name: w.name, title: w.title, titleLabel: titleLabel(w.title), rating: Math.round(r.rating), ratingSource: r.source };
    if (w.fullName) dto.fullName = w.fullName;
    if (w.aimag) dto.aimag = w.aimag;
    if (w.sum) dto.sum = w.sum;
    if (w.aimag) dto.place = w.sum ? `${w.aimag}, ${w.sum}` : w.aimag;
    if (w.birthDate) dto.birthDate = w.birthDate;
    if (w.devjeeId) dto.devjeeId = w.devjeeId;
    if (w.height) dto.height = w.height;
    if (w.weight) dto.weight = w.weight;
    if (w.club) dto.club = w.club;
    if (w.affiliations?.length) dto.affiliations = w.affiliations;
    if (w.titles?.length) {
      dto.titles = w.titles.map((t) => {
        const row: NonNullable<WrestlerDto['titles']>[number] = { title: t.title, titleLabel: titleLabel(t.title), date: t.date };
        if (t.rounds) row.rounds = t.rounds;
        if (t.place) row.place = t.place;
        return row;
      });
    }
    return dto;
  };

  /** Загварын магадлал (priorA) зөвхөн админд — энгийн хэрэглэгч зөвхөн бооцооны үнийг харна. */
  const boutDto = (b: Bout, admin = false): BoutDto => {
    const dto: BoutDto = {
      id: b.id,
      tournamentId: b.tournamentId,
      round: b.round,
      a: wrestlerDto(engine.wrestler(b.aId)),
      b: wrestlerDto(engine.wrestler(b.bId)),
      ...(admin ? { priorA: engine.priorForBout(b.aId, b.bId).pA } : {}),
    };
    if (b.result) dto.winnerId = b.result.winnerId;
    if (b.scheduledAt) dto.scheduledAt = b.scheduledAt;
    return dto;
  };

  const modelProbs = (m: Market): number[] => {
    if (m.kind === 'bout' && m.boutId) {
      const b = engine.state.bouts.get(m.boutId);
      if (b && m.outcomeRefs[0] === b.aId && m.outcomeRefs[1] === b.bId) {
        const p = engine.priorForBout(b.aId, b.bId);
        return [p.pA, p.pB];
      }
    }
    return prices(m.q0, m.b);
  };

  /**
   * admin=false: загварын магадлал (modelProbs) явахгүй; бооцоо ОГТ ороогүй зах зээлийн
   * probs = [] (эхлэлийн үнэ нь загварын таамаг тул нуугдана — «зөвхөн бооцооноос»).
   */
  const marketDto = (m: Market, userId?: string, admin = false): MarketDto => {
    const v = engine.marketView(m.id);
    const dto: MarketDto = {
      id: v.id,
      kind: v.kind,
      title: v.title,
      status: v.status,
      outcomes: v.outcomes,
      outcomeRefs: v.outcomeRefs,
      probs: admin || v.tradeCount > 0 || v.status === 'resolved' || v.status === 'voided' ? v.probs : [],
      ...(admin ? { modelProbs: modelProbs(m) } : {}),
      b: v.b,
      volume: v.volume,
      tradeCount: v.tradeCount,
      traders: v.traders,
      createdAt: v.createdAt,
    };
    if (v.closesAt) dto.closesAt = v.closesAt;
    if (v.resolvedOutcome !== undefined) dto.resolvedOutcome = v.resolvedOutcome;
    if (v.voidReason) dto.voidReason = v.voidReason;
    if (v.boutId) {
      dto.boutId = v.boutId;
      const b = engine.state.bouts.get(v.boutId);
      if (b) {
        dto.round = b.round;
        const wa = engine.state.wrestlers.get(b.aId);
        const wb = engine.state.wrestlers.get(b.bId);
        if (wa && wb) dto.wrestlers = { a: wrestlerDto(wa), b: wrestlerDto(wb) };
      }
    }
    if (v.tournamentId) {
      dto.tournamentId = v.tournamentId;
      const t = engine.state.tournaments.get(v.tournamentId);
      if (t) dto.tournamentName = t.name;
    }
    if (userId) {
      const pos = m.positions.get(userId);
      if (pos && pos.some((s) => s > 1e-9)) {
        dto.myPosition = pos;
        dto.myNetCost = m.netCost.get(userId) ?? 0;
      }
    }
    return dto;
  };

  const tradeDto = (t: TradeRecord): TradeDto => {
    const u = engine.state.users.get(t.userId);
    const dto: TradeDto = { id: t.id, at: t.at, marketId: t.marketId, userId: t.userId, outcome: t.outcome, shares: t.shares, delta: t.delta, priceBefore: t.priceBefore, priceAfter: t.priceAfter };
    if (u) dto.userName = u.name;
    return dto;
  };

  const roundStatusDto = (tournamentId: string): RoundStatusDto => {
    const st = engine.roundStatus(tournamentId);
    const dto: RoundStatusDto = { rounds: st.rounds, perRound: st.perRound, current: st.current, next: st.next, alive: st.alive, entrants: st.entrants, finished: st.finished };
    if (st.championId) {
      dto.championId = st.championId;
      dto.championName = engine.state.wrestlers.get(st.championId)?.name ?? st.championId;
    }
    return dto;
  };

  const tournamentDto = (t: Tournament): TournamentDto => {
    const bouts = engine.bouts(t.id);
    const open = engine.markets({ tournamentId: t.id, status: 'open' }).length;
    const st = engine.roundStatus(t.id);
    const cur = st.current ? st.perRound[st.current - 1]! : { total: 0, pending: 0 };
    const dto: TournamentDto = {
      id: t.id,
      name: t.name,
      date: t.date,
      rounds: t.rounds,
      boutCount: bouts.length,
      openMarkets: open,
      syncEnabled: deps.devjee?.isEnabled(t.id) ?? false,
      currentRound: st.current,
      currentPending: cur.pending,
      currentTotal: cur.total,
      finished: st.finished,
      entrants: st.entrants,
    };
    if (st.championId) dto.championName = engine.state.wrestlers.get(st.championId)?.name ?? st.championId;
    if (t.kind) dto.kind = t.kind;
    if (t.place) dto.place = t.place;
    if (t.devjeeId) dto.devjeeId = t.devjeeId;
    return dto;
  };

  /** admin=false: загварын магадлал явахгүй; бооцоо ороогүй хосын probs = [] («—» харагдана). */
  const boardDto = (tournamentId: string, round: number | undefined, userId: string, admin = false): BoardDto => {
    const t = engine.tournament(tournamentId);
    const status = roundStatusDto(t.id);
    const r = round && round >= 1 && round <= t.rounds ? round : status.current || 1;
    const marketByBout = new Map<string, Market>();
    for (const m of engine.markets({ tournamentId: t.id })) if (m.boutId && m.kind === 'bout') marketByBout.set(m.boutId, m);
    const side = (id: string): BoardSideDto => {
      const w = engine.state.wrestlers.get(id);
      const out: BoardSideDto = { id, name: w?.name ?? id, titleLabel: w ? titleLabel(w.title) : '', rating: Math.round(engine.rating(id).rating) };
      if (w?.fullName && w.fullName !== w.name) out.fullName = w.fullName;
      if (w?.aimag) out.place = w.sum ? `${w.aimag}, ${w.sum}` : w.aimag;
      return out;
    };
    const bouts = engine
      .bouts(t.id)
      .filter((b) => b.round === r)
      .map((b): BoardBoutDto => {
        const m = marketByBout.get(b.id);
        const prior = admin ? engine.priorForBout(b.aId, b.bId) : undefined;
        const row: BoardBoutDto = {
          id: b.id,
          round: b.round,
          status: m ? m.status : 'none',
          a: side(b.aId),
          b: side(b.bId),
          probs: prior ? [prior.pA, prior.pB] : [],
          ...(prior ? { model: [prior.pA, prior.pB] as [number, number] } : {}),
          volume: 0,
        };
        if (m) {
          const v = engine.marketView(m.id);
          row.marketId = m.id;
          // Зах зээлийн үр дүнгүүд [А, Б] дарааллаар үүсдэг (createBout)
          if (admin || v.tradeCount > 0 || v.status === 'resolved' || v.status === 'voided') {
            row.probs = [v.probs[0] ?? 0.5, v.probs[1] ?? 0.5];
          } else {
            row.probs = [];
          }
          row.volume = v.volume;
          const pos = m.positions.get(userId);
          if (pos && pos.some((s) => s > 1e-9)) {
            row.myShares = [pos[0] ?? 0, pos[1] ?? 0];
            row.myCost = m.netCost.get(userId) ?? 0;
          }
        }
        if (b.result) row.winnerId = b.result.winnerId;
        return row;
      });
    return { tournament: tournamentDto(t), status, round: r, bouts };
  };

  const ledgerDto = (l: LedgerEntry): LedgerDto => {
    const dto: LedgerDto = { id: l.id, at: l.at, kind: l.kind, delta: l.delta, balanceAfter: l.balanceAfter };
    if (l.marketId) {
      dto.marketId = l.marketId;
      const m = engine.state.markets.get(l.marketId);
      if (m) dto.marketTitle = m.title;
    }
    if (l.note) dto.note = l.note;
    return dto;
  };

  const couponDto = (c: Coupon): CouponDto => {
    // Экспрессийн коэффициент / системийн дээд төлбөрийг санал болгох үеийн үнээр дахин тооцно
    let maxPayout = 0;
    let coefficient = 1;
    const combosOf = (n: number, sizes: number[]) => {
      const out: number[][] = [];
      const rec = (start: number, k: number, cur: number[]) => {
        if (cur.length === k) {
          out.push([...cur]);
          return;
        }
        for (let i = start; i < n; i++) rec(i + 1, k, [...cur, i]);
      };
      for (const k of sizes) rec(0, k, []);
      return out;
    };
    const combos = combosOf(c.legs.length, c.sizes);
    const unit = c.stake / Math.max(1, combos.length);
    for (const combo of combos) {
      let coef = 1;
      for (const i of combo) coef *= 1 / c.legs[i]!.price;
      coef = Math.min(coef, 100);
      if (c.kind === 'express') coefficient = coef;
      maxPayout += unit * coef;
    }
    const dto: CouponDto = {
      id: c.id,
      kind: c.kind,
      legs: c.legs.map((l) => ({ ...l })),
      stake: c.stake,
      sizes: c.sizes,
      combos: c.combos,
      status: c.status,
      createdAt: c.createdAt,
      coefficient,
      maxPayout: Math.floor(maxPayout),
    };
    if (c.payout !== undefined) dto.payout = c.payout;
    if (c.settledAt) dto.settledAt = c.settledAt;
    return dto;
  };

  const totoDto = (t: Toto, userId?: string, admin = false): TotoDto => {
    const brief = (id: string) => {
      const w = engine.state.wrestlers.get(id);
      const r = engine.rating(id);
      const out: TotoDto['bouts'][number]['a'] = { id, name: w?.name ?? id, titleLabel: w ? titleLabel(w.title) : '', rating: Math.round(r.rating) };
      if (w?.aimag) out.place = w.sum ? `${w.aimag}, ${w.sum}` : w.aimag;
      return out;
    };
    const bouts: TotoDto['bouts'] = t.boutIds.map((id) => {
      const b = engine.bout(id);
      const row: TotoDto['bouts'][number] = { boutId: b.id, round: b.round, a: brief(b.aId), b: brief(b.bId) };
      if (admin) row.priorA = engine.priorForBout(b.aId, b.bId).pA;
      if (b.result) row.winnerId = b.result.winnerId;
      return row;
    });
    const started = t.boutIds.some((id) => engine.state.bouts.get(id)?.result);
    const expired = t.closesAt ? Date.parse(t.closesAt) <= now() : false;
    const dto: TotoDto = {
      id: t.id,
      title: t.title,
      tournamentId: t.tournamentId,
      status: t.status,
      fee: t.fee,
      pool: t.pool,
      tiers: t.tiers,
      createdAt: t.createdAt,
      bouts,
      entries: [...t.entries.values()]
        .map((en) => {
          const u = engine.state.users.get(en.userId);
          const row: TotoEntryDto = { userId: en.userId, userName: u?.name ?? en.userId, picks: en.picks, me: en.userId === userId };
          if (en.correct !== undefined) row.correct = en.correct;
          if (en.payout !== undefined) row.payout = en.payout;
          return row;
        })
        .sort((a, b) => (b.correct ?? -1) - (a.correct ?? -1)),
      canEnter: t.status === 'open' && !started && !expired && (userId ? !t.entries.has(userId) : true),
    };
    const tour = engine.state.tournaments.get(t.tournamentId);
    if (tour) dto.tournamentName = tour.name;
    if (t.closesAt) dto.closesAt = t.closesAt;
    if (t.settledAt) dto.settledAt = t.settledAt;
    const mine = userId ? t.entries.get(userId) : undefined;
    if (mine) dto.myPicks = mine.picks;
    return dto;
  };

  const accountDto = (a: Account): AccountDto => ({ id: a.id, username: a.username, email: a.email, emailVerified: a.emailVerified, role: a.role });

  const meDto = (a: Account): MeDto => {
    const u = engine.state.users.get(a.id);
    return { account: accountDto(a), balance: u?.balance ?? 0, contributed: u?.contributed ?? 0 };
  };

  // ── эрх ──

  const tokenOf = (ctx: Ctx, allowQuery = false): string | undefined => {
    const header = ctx.req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
    if (ctx.cookies[SESSION_COOKIE]) return ctx.cookies[SESSION_COOKIE];
    if (allowQuery) return ctx.query.get('token') ?? undefined;
    return undefined;
  };

  const requireUser = async (ctx: Ctx, allowQuery = false): Promise<Account> => {
    const acc = await auth.accountForToken(tokenOf(ctx, allowQuery));
    if (!acc) throw new HttpError(401, 'Нэвтрэх шаардлагатай.', 'UNAUTHORIZED');
    // Engine-д байхгүй бол (жишээ нь лог шинээр эхэлсэн) үүсгэнэ.
    if (!engine.state.users.has(acc.id)) {
      engine.createUser({ id: acc.id, name: acc.username, role: acc.role });
      await persist();
    }
    return acc;
  };

  const requireAdmin = async (ctx: Ctx): Promise<Account> => {
    const acc = await requireUser(ctx);
    if (acc.role !== 'admin') throw new HttpError(403, 'Зөвхөн админ.', 'FORBIDDEN');
    return acc;
  };

  const requireVerified = (acc: Account): void => {
    if (!acc.emailVerified) throw new HttpError(403, 'Таавар тавихын өмнө имэйлээ баталгаажуулна уу.', 'UNVERIFIED');
  };

  /** Логийг бичнэ; бүтэлгүйтвэл ноцтой. */
  const persist = async (): Promise<void> => {
    try {
      await deps.flush();
    } catch (err) {
      onFatal(err);
      throw new HttpError(503, 'Хадгалж чадсангүй. Түр зуур дахин оролдоно уу.', 'PERSIST');
    }
  };

  const changed = (marketIds?: string[], userIds?: string[]): void => {
    const msg: SseMessage = { type: 'changed', at: new Date(now()).toISOString() };
    if (marketIds?.length) msg.marketIds = marketIds;
    if (userIds?.length) msg.userIds = userIds;
    hub.broadcast('changed', msg);
  };

  const setSessionCookie = (res: ServerResponse, token: string, clear = false): void => {
    setCookie(res, SESSION_COOKIE, clear ? '' : token, { maxAgeSec: clear ? 0 : SESSION_DAYS * 86_400, secure: deps.secureCookies ?? false });
  };

  const guardAuthRate = (ctx: Ctx): void => {
    if (!authLimiter.allow(`auth:${ctx.ip}`)) throw new HttpError(429, 'Хэт олон оролдлого. 1 минутын дараа дахин оролдоно уу.', 'RATE');
  };

  // ── health ──
  router.get('/health', () => ({
    ok: true,
    events: engine.state.eventCount,
    users: engine.state.users.size,
    sse: hub.size,
    ...(deps.info ? { storage: deps.info.storage, email: deps.info.email, archive: deps.analytics ? deps.analytics.archive.bouts.length : 0 } : {}),
  }));

  // ── бүртгэл / нэвтрэлт ──
  router.post('/api/register', async (ctx) => {
    guardAuthRate(ctx);
    const { account, token, codeSent } = await auth.register(str(ctx.body, 'username'), str(ctx.body, 'password'), str(ctx.body, 'email'));
    engine.createUser({ id: account.id, name: account.username, role: account.role });
    // Найз урих бонус: урьсан хүн ба шинэ хэрэглэгч хоёуланд 1 000 токен
    const referrerName = optStr(ctx.body, 'referrer');
    let referral: string | undefined;
    if (referrerName) {
      const ref = await auth.accountByUsername(referrerName);
      if (ref && ref.id !== account.id && engine.state.users.has(ref.id)) {
        engine.grantTokens(ref.id, 1_000, `Найз урьсан: ${account.username}`);
        engine.grantTokens(account.id, 1_000, `Урилгаар бүртгүүлсэн (${ref.username})`);
        referral = ref.username;
        changed(undefined, [ref.id]);
      }
    }
    await persist();
    setSessionCookie(ctx.res, token);
    return { me: meDto(account), token, codeSent, referral: referral ?? null };
  });

  router.post('/api/login', async (ctx) => {
    guardAuthRate(ctx);
    const { account, token } = await auth.login(str(ctx.body, 'username'), str(ctx.body, 'password'));
    if (!engine.state.users.has(account.id)) {
      engine.createUser({ id: account.id, name: account.username, role: account.role });
      await persist();
    }
    setSessionCookie(ctx.res, token);
    return { me: meDto(account), token };
  });

  router.post('/api/logout', async (ctx) => {
    await auth.logout(tokenOf(ctx) ?? '');
    setSessionCookie(ctx.res, '', true);
    return { ok: true };
  });

  router.get('/api/me', async (ctx) => meDto(await requireUser(ctx)));

  /** Өдөр тутмын урамшуулал (үлдэгдэл 5 000-аас доош бол 200 токен, 20 цагт нэг). */
  router.post('/api/bonus', async (ctx) => {
    const acc = await requireUser(ctx);
    const amount = engine.claimDailyBonus(acc.id);
    if (amount > 0) {
      await persist();
      changed(undefined, [acc.id]);
    }
    return { amount, me: meDto(acc) };
  });

  router.post('/api/verify', async (ctx) => {
    const acc = await requireUser(ctx);
    const updated = await auth.verifyEmail(acc.id, str(ctx.body, 'code'));
    return meDto(updated);
  });

  router.post('/api/resend', async (ctx) => {
    guardAuthRate(ctx);
    const acc = await requireUser(ctx);
    await auth.resendCode(acc.id);
    return { ok: true };
  });

  router.post('/api/forgot', async (ctx) => {
    guardAuthRate(ctx);
    await auth.forgotPassword(str(ctx.body, 'email'));
    return { ok: true, message: 'Хэрэв энэ имэйл бүртгэлтэй бол сэргээх код илгээгдлээ.' };
  });

  router.post('/api/reset', async (ctx) => {
    guardAuthRate(ctx);
    await auth.resetPassword(str(ctx.body, 'email'), str(ctx.body, 'code'), str(ctx.body, 'password'));
    return { ok: true };
  });

  router.post('/api/password', async (ctx) => {
    const acc = await requireUser(ctx);
    await auth.changePassword(acc.id, str(ctx.body, 'oldPassword'), str(ctx.body, 'newPassword'));
    return { ok: true };
  });

  // ── унших ──
  router.get('/api/home', async (ctx): Promise<HomeDto> => {
    const acc = await requireUser(ctx);
    // Барилдааны зах зээлүүд тэмцээний самбар дээр (хосоор) харагдана; энд зөвхөн бусад нь
    const all = [...engine.state.markets.values()].filter((m) => m.kind !== 'bout');
    const open = all.filter((m) => m.status === 'open' || m.status === 'closed');
    const done = all
      .filter((m) => m.status === 'resolved' || m.status === 'voided')
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
      .slice(0, 10);
    return {
      me: meDto(acc),
      tournaments: engine
        .tournaments()
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(tournamentDto),
      markets: [...open, ...done].map((m) => marketDto(m, acc.id, acc.role === 'admin')),
    };
  });

  router.get('/api/markets', async (ctx) => {
    const acc = await requireUser(ctx);
    const status = ctx.query.get('status');
    const tournamentId = ctx.query.get('tournamentId');
    let list = [...engine.state.markets.values()];
    if (status) list = list.filter((m) => m.status === status);
    if (tournamentId) list = list.filter((m) => m.tournamentId === tournamentId);
    return { markets: list.map((m) => marketDto(m, acc.id, acc.role === 'admin')) };
  });

  router.get('/api/markets/:id', async (ctx): Promise<MarketDetailDto> => {
    const acc = await requireUser(ctx);
    const m = engine.market(ctx.params.id!);
    const dto: MarketDetailDto = {
      market: marketDto(m, acc.id, acc.role === 'admin'),
      recentTrades: [...engine.state.trades.values()]
        .filter((t) => t.marketId === m.id)
        .slice(-20)
        .reverse()
        .map(tradeDto),
    };
    if (m.boutId) {
      const b = engine.state.bouts.get(m.boutId);
      if (b) dto.bout = boutDto(b, acc.role === 'admin');
    }
    return dto;
  });

  router.post('/api/markets/:id/quote', async (ctx): Promise<QuoteDto> => {
    await requireUser(ctx);
    return engine.quoteBuy(ctx.params.id!, num(ctx.body, 'outcome'), num(ctx.body, 'spend'));
  });

  router.post('/api/markets/:id/quote-sell', async (ctx): Promise<SellQuoteDto> => {
    await requireUser(ctx);
    return engine.quoteSell(ctx.params.id!, num(ctx.body, 'outcome'), num(ctx.body, 'shares'));
  });

  const tradeResult = (t: TradeRecord, userId: string): TradeResultDto => ({
    trade: tradeDto(t),
    market: marketDto(engine.market(t.marketId), userId),
    balance: engine.balance(userId),
  });

  router.post('/api/markets/:id/buy', async (ctx): Promise<TradeResultDto> => {
    const acc = await requireUser(ctx);
    requireVerified(acc);
    if (!tradeLimiter.allow(`trade:${acc.id}`)) throw new HttpError(429, 'Хэт хурдан. Түр хүлээнэ үү.', 'RATE');
    const t = engine.buy(acc.id, ctx.params.id!, num(ctx.body, 'outcome'), num(ctx.body, 'spend'), optStr(ctx.body, 'requestId'));
    await persist();
    changed([t.marketId], [acc.id]);
    return tradeResult(t, acc.id);
  });

  /**
   * Олон дан бооцоог нэг дор (самбараас): {orders: [{marketId, outcome, spend, requestId?}]}.
   * Захиалга бүр тусдаа — нэг нь алдвал бусад нь хэвээр тавигдана; нэг л удаа хадгална.
   */
  router.post('/api/markets/buy-batch', async (ctx): Promise<BatchBuyResultDto> => {
    const acc = await requireUser(ctx);
    requireVerified(acc);
    if (!tradeLimiter.allow(`trade:${acc.id}`)) throw new HttpError(429, 'Хэт хурдан. Түр хүлээнэ үү.', 'RATE');
    const raw = isRecord(ctx.body) ? ctx.body.orders : undefined;
    if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, '«orders» массив хэрэгтэй.', 'BAD_INPUT');
    if (raw.length > 64) throw new HttpError(400, 'Нэг удаад 64 хүртэл бооцоо.', 'BAD_INPUT');
    const results: BatchBuyResultDto['results'] = [];
    const marketIds: string[] = [];
    for (const o of raw) {
      const marketId = str(o, 'marketId');
      try {
        const t = engine.buy(acc.id, marketId, num(o, 'outcome'), num(o, 'spend'), optStr(o, 'requestId'));
        marketIds.push(t.marketId);
        results.push({ marketId, ok: true, trade: tradeDto(t), probs: engine.marketView(t.marketId).probs });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        const row: BatchBuyResultDto['results'][number] = { marketId, ok: false, error: err.message ?? 'Алдаа' };
        if (err.code) row.code = err.code;
        results.push(row);
      }
    }
    if (marketIds.length) {
      await persist();
      changed(marketIds, [acc.id]);
    }
    return { results, placed: marketIds.length, balance: engine.balance(acc.id) };
  });

  router.post('/api/markets/:id/sell', async (ctx): Promise<TradeResultDto> => {
    const acc = await requireUser(ctx);
    requireVerified(acc);
    if (!tradeLimiter.allow(`trade:${acc.id}`)) throw new HttpError(429, 'Хэт хурдан. Түр хүлээнэ үү.', 'RATE');
    const t = engine.sell(acc.id, ctx.params.id!, num(ctx.body, 'outcome'), num(ctx.body, 'shares'), optStr(ctx.body, 'requestId'));
    await persist();
    changed([t.marketId], [acc.id]);
    return tradeResult(t, acc.id);
  });

  router.get('/api/portfolio', async (ctx): Promise<PortfolioDto> => {
    const acc = await requireUser(ctx);
    const u = engine.user(acc.id);
    const positions: PositionDto[] = engine.positions(acc.id).sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1));
    return { balance: u.balance, contributed: u.contributed, positions, ledger: engine.ledger(acc.id, 100).map(ledgerDto), coupons: engine.coupons(acc.id).slice(0, 50).map(couponDto) };
  });

  // ── купон ──
  const parseCoupon = (body: unknown): Parameters<Engine['quoteCoupon']>[0] => {
    if (!isRecord(body) || !Array.isArray(body.legs)) throw new HttpError(400, '«legs» дутуу.', 'BAD_INPUT');
    const legs = body.legs.map((l) => ({ marketId: str(l, 'marketId'), outcome: num(l, 'outcome') }));
    const kind = str(body, 'kind', false) === 'system' ? 'system' : 'express';
    const input: Parameters<Engine['quoteCoupon']>[0] = { legs, stake: num(body, 'stake'), kind };
    if (Array.isArray(body.sizes)) input.sizes = body.sizes.map(Number);
    return input;
  };

  router.post('/api/coupons/quote', async (ctx): Promise<CouponQuoteDto> => {
    await requireUser(ctx);
    return engine.quoteCoupon(parseCoupon(ctx.body));
  });

  router.post('/api/coupons', async (ctx): Promise<{ coupon: CouponDto; balance: number }> => {
    const acc = await requireUser(ctx);
    requireVerified(acc);
    if (!tradeLimiter.allow(`trade:${acc.id}`)) throw new HttpError(429, 'Хэт хурдан. Түр хүлээнэ үү.', 'RATE');
    const c = engine.placeCoupon(acc.id, parseCoupon(ctx.body), optStr(ctx.body, 'requestId'));
    await persist();
    changed(undefined, [acc.id]);
    return { coupon: couponDto(c), balance: engine.balance(acc.id) };
  });

  router.get('/api/coupons', async (ctx): Promise<{ coupons: CouponDto[] }> => {
    const acc = await requireUser(ctx);
    return { coupons: engine.coupons(acc.id).map(couponDto) };
  });

  // ── тото ──
  router.get('/api/totos', async (ctx): Promise<{ totos: TotoDto[] }> => {
    const acc = await requireUser(ctx);
    const filter: Parameters<Engine['totos']>[0] = {};
    const st = ctx.query.get('status');
    if (st === 'open' || st === 'settled' || st === 'voided') filter.status = st;
    const tid = ctx.query.get('tournamentId');
    if (tid) filter.tournamentId = tid;
    return { totos: engine.totos(filter).map((t) => totoDto(t, acc.id, acc.role === 'admin')) };
  });

  router.get('/api/totos/:id', async (ctx): Promise<TotoDto> => {
    const acc = await requireUser(ctx);
    return totoDto(engine.toto(ctx.params.id!), acc.id, acc.role === 'admin');
  });

  router.post('/api/totos/:id/enter', async (ctx): Promise<{ toto: TotoDto; balance: number }> => {
    const acc = await requireUser(ctx);
    requireVerified(acc);
    if (!tradeLimiter.allow(`trade:${acc.id}`)) throw new HttpError(429, 'Хэт хурдан. Түр хүлээнэ үү.', 'RATE');
    const raw = isRecord(ctx.body) ? ctx.body.picks : undefined;
    if (!Array.isArray(raw)) throw new HttpError(400, '«picks» массив байх ёстой.', 'BAD_INPUT');
    const picks = raw.map((p) => (typeof p === 'string' && p ? p : null));
    const t = engine.enterToto(acc.id, ctx.params.id!, picks, optStr(ctx.body, 'requestId'));
    await persist();
    changed(undefined, [acc.id]);
    return { toto: totoDto(t, acc.id, acc.role === 'admin'), balance: engine.balance(acc.id) };
  });

  router.post('/api/admin/totos', async (ctx) => {
    await requireAdmin(ctx);
    const input: Parameters<Engine['createToto']>[0] = {
      title: str(ctx.body, 'title'),
      tournamentId: str(ctx.body, 'tournamentId'),
      boutIds: strArray(ctx.body, 'boutIds'),
    };
    const fee = optNum(ctx.body, 'fee');
    if (fee !== undefined) input.fee = fee;
    const closesAt = optStr(ctx.body, 'closesAt');
    if (closesAt) input.closesAt = closesAt;
    if (isRecord(ctx.body) && Array.isArray(ctx.body.tiers)) input.tiers = ctx.body.tiers.map(Number);
    const t = engine.createToto(input);
    await persist();
    changed();
    return { toto: totoDto(t, undefined, true) };
  });

  router.post('/api/admin/totos/:id/settle', async (ctx) => {
    const acc = await requireAdmin(ctx);
    const t = engine.settleToto(ctx.params.id!);
    await persist();
    changed(undefined, [...t.entries.keys()]);
    return { toto: totoDto(t, acc.id, true) };
  });

  router.get('/api/leaderboard', async (ctx): Promise<{ rows: LeaderboardRowDto[] }> => {
    const acc = await requireUser(ctx);
    return { rows: engine.leaderboard().map((r) => ({ ...r, me: r.userId === acc.id })) };
  });

  router.get('/api/tournaments', async (ctx) => {
    await requireUser(ctx);
    return { tournaments: engine.tournaments().sort((a, b) => b.date.localeCompare(a.date)).map(tournamentDto) };
  });

  router.get('/api/tournaments/:id', async (ctx): Promise<TournamentDetailDto> => {
    const acc = await requireUser(ctx);
    const t = engine.tournament(ctx.params.id!);
    return {
      tournament: tournamentDto(t),
      status: roundStatusDto(t.id),
      bouts: engine.bouts(t.id).sort((a, b) => a.round - b.round).map((x) => boutDto(x, acc.role === 'admin')),
      markets: engine.markets({ tournamentId: t.id }).map((m) => marketDto(m, acc.id, acc.role === 'admin')),
    };
  });

  /** Бооцооны самбар: тухайн давааны (анхдагч: одоогийн) хосууд + миний эзэмшил. */
  router.get('/api/tournaments/:id/board', async (ctx): Promise<BoardDto> => {
    const acc = await requireUser(ctx);
    const round = Number(ctx.query.get('round') ?? '') || undefined;
    return boardDto(ctx.params.id!, round, acc.id, acc.role === 'admin');
  });

  router.get('/api/tournaments/:id/forecast', async (ctx) => {
    await requireAdmin(ctx); // прогноз = загварын гаралт — энгийн хэрэглэгчид харагдахгүй
    const opts: Parameters<ForecastService['dto']>[1] = { top: Math.min(50, Number(ctx.query.get('top') ?? 15) || 15) };
    const w = ctx.query.get('wrestlerId');
    if (w) opts.wrestlerId = w;
    const a = ctx.query.get('aId');
    const b = ctx.query.get('bId');
    if (a && b) {
      opts.aId = a;
      opts.bId = b;
    }
    return forecasts.dto(ctx.params.id!, opts);
  });

  router.get('/api/wrestlers', async (ctx) => {
    await requireUser(ctx);
    // Хайлт: үг бүр нэр / овог нэр / цол / аймаг / сум-ын аль нэгэнд таарах ёстой (AND).
    // Жишээ: «улсын заан ховд», «сумъяа алтай», «аймгийн арслан».
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const limit = Math.min(200, Number(ctx.query.get('limit') ?? 50) || 50);
    let list = engine.wrestlers();
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      list = list.filter((w) => {
        const hay = [w.name, w.fullName ?? '', titleLabel(w.title), w.title.replace(/_/g, ' '), w.aimag ?? '', w.sum ?? ''].map((x) => x.toLowerCase());
        return tokens.every((tok) => hay.some((h) => h.includes(tok)));
      });
    }
    list.sort((a, b) => engine.rating(b.id).rating - engine.rating(a.id).rating);
    return { wrestlers: list.slice(0, limit).map(wrestlerDto), total: list.length };
  });

  /** Бөхийн дэлгэрэнгүй + архивын давалт–алдагдал. */
  router.get('/api/wrestlers/:id', async (ctx): Promise<WrestlerDetailDto> => {
    await requireUser(ctx);
    const w = engine.wrestler(ctx.params.id!);
    const dto: WrestlerDetailDto = { wrestler: wrestlerDto(w) };
    const wid = w.devjeeId ?? w.id;
    if (deps.analytics && deps.analytics.archive.wrestlers[wid]) dto.record = deps.analytics.record(wid);
    return dto;
  });

  /** Бөхийн бүх барилдааны түүх (архиваас, шинэ нь эхэндээ). */
  router.get('/api/wrestlers/:id/bouts', async (ctx): Promise<WrestlerBoutsDto> => {
    await requireUser(ctx);
    if (!deps.analytics) throw new HttpError(503, 'Архив ачаалагдаагүй (npm run archive).', 'NO_ARCHIVE');
    const w = engine.wrestler(ctx.params.id!);
    const wid = w.devjeeId ?? w.id;
    const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(ctx.query.get('limit') ?? 50) || 50));
    const r = deps.analytics.wrestlerBouts(wid, offset, limit);
    return {
      total: r.total,
      offset: r.offset,
      rows: r.rows.map((x) => ({
        date: x.date,
        tournamentName: x.tournamentName,
        round: x.round,
        opponentId: x.opponentId,
        opponentName: x.opponentName,
        opponentTitleLabel: titleLabel(x.opponentTitle),
        won: x.won,
        ...(x.noShow ? { noShow: true } : {}),
      })),
    };
  });

  // ── хоорондын харьцаа (архив) ──
  router.get('/api/h2h', async (ctx) => {
    const acc = await requireUser(ctx);
    if (!deps.analytics) throw new HttpError(503, 'Архивын шинжилгээ идэвхгүй (npm run archive).', 'NO_ARCHIVE');
    const toWid = (v: string): string => {
      const w = engine.state.wrestlers.get(v);
      return w?.devjeeId ?? v;
    };
    const a = ctx.query.get('a');
    const b = ctx.query.get('b');
    if (!a || !b) throw new HttpError(400, 'a ба b (бөхийн id) хэрэгтэй.', 'BAD_INPUT');
    const hops = Math.min(15, Math.max(1, Number(ctx.query.get('hops') ?? 10) || 10));
    const dto = deps.analytics.h2h(toWid(a), toWid(b), hops);
    if (acc.role !== 'admin') {
      // Энгийн хэрэглэгчид бодит түүх (харьцаа, барилдаанууд, замууд, рейтинг) л очно — магадлалын тоонууд очихгүй
      delete dto.chain.pA;
      delete dto.chain.perHop;
      for (const p of [...dto.chain.pathsAB, ...dto.chain.pathsBA]) delete p.prob;
      dto.bt = null;
      if (dto.elo) delete dto.elo.pA;
    }
    return dto;
  });

  // ── SSE ──
  router.get('/api/events', async (ctx) => {
    await requireUser(ctx, true);
    hub.attach(ctx.req, ctx.res, { type: 'hello', at: new Date(now()).toISOString() } satisfies SseMessage);
    return RESPONDED;
  });

  // ── админ ──
  router.get('/api/admin/users', async (ctx): Promise<{ users: AdminUserDto[] }> => {
    await requireAdmin(ctx);
    const accounts = await auth.listAccounts();
    return {
      users: accounts.map((a) => {
        const u = engine.state.users.get(a.id);
        const dto: AdminUserDto = { account: accountDto(a), balance: u?.balance ?? 0, contributed: u?.contributed ?? 0 };
        if (u) dto.createdAt = u.createdAt;
        return dto;
      }),
    };
  });

  router.post('/api/admin/grant', async (ctx) => {
    await requireAdmin(ctx);
    const userId = str(ctx.body, 'userId');
    const balance = engine.grantTokens(userId, num(ctx.body, 'amount'), optStr(ctx.body, 'reason') ?? 'админы олголт');
    await persist();
    changed(undefined, [userId]);
    return { balance };
  });

  router.post('/api/admin/role', async (ctx) => {
    const me = await requireAdmin(ctx);
    const userId = str(ctx.body, 'userId');
    const role = str(ctx.body, 'role');
    if (role !== 'admin' && role !== 'member') throw new HttpError(400, 'role admin эсвэл member.', 'BAD_INPUT');
    if (userId === me.id && role !== 'admin') throw new HttpError(400, 'Өөрийгөө админаас хасаж болохгүй.', 'BAD_INPUT');
    await auth.setRole(userId, role);
    return { ok: true };
  });

  router.post('/api/admin/wrestlers', async (ctx) => {
    await requireAdmin(ctx);
    const title = str(ctx.body, 'title');
    if (!isTitle(title)) throw new HttpError(400, `Танигдаагүй цол: ${title}`, 'BAD_INPUT');
    const input: Parameters<Engine['addWrestler']>[0] = { name: str(ctx.body, 'name'), title };
    for (const k of ['id', 'fullName', 'aimag', 'sum', 'birthDate', 'devjeeId', 'note'] as const) {
      const v = optStr(ctx.body, k);
      if (v !== undefined) input[k] = v;
    }
    const w = engine.addWrestler(input);
    const rating = optNum(ctx.body, 'rating');
    if (rating !== undefined) engine.setRating(w.id, rating, 'local');
    await persist();
    return { wrestler: wrestlerDto(w) };
  });

  router.post('/api/admin/wrestlers/:id/rating', async (ctx) => {
    await requireAdmin(ctx);
    engine.setRating(ctx.params.id!, num(ctx.body, 'rating'), 'local');
    await persist();
    return { wrestler: wrestlerDto(engine.wrestler(ctx.params.id!)) };
  });

  router.post('/api/admin/tournaments', async (ctx) => {
    await requireAdmin(ctx);
    const input: Parameters<Engine['createTournament']>[0] = { name: str(ctx.body, 'name'), date: str(ctx.body, 'date'), rounds: num(ctx.body, 'rounds') };
    for (const k of ['id', 'kind', 'place', 'devjeeId'] as const) {
      const v = optStr(ctx.body, k);
      if (v !== undefined) input[k] = v;
    }
    const t = engine.createTournament(input);
    await persist();
    changed();
    return { tournament: tournamentDto(t) };
  });

  /** Оролцогчдын жагсаалт (зэрэг дэвийн дарааллаар) — прогнозд. */
  router.post('/api/admin/tournaments/:id/entrants', async (ctx) => {
    await requireAdmin(ctx);
    const ids = strArray(ctx.body, 'entrants');
    const t = engine.updateTournament(ctx.params.id!, { entrants: ids });
    await persist();
    changed();
    return { tournament: tournamentDto(t) };
  });

  /**
   * Туршилтын тэмцээн: улс/аймгийн цолтой, сүүлийн үед барилдсан бөхчүүдээс рейтингээр
   * топ `size`-ийг оролцогч болгож үүсгэнэ. {name?, date?, size=1024, rounds=log2(size), activeSince='2024-01-01', levels?}
   */
  router.post('/api/admin/tournaments/generate', async (ctx) => {
    await requireAdmin(ctx);
    const size = Math.max(2, Math.min(4096, Math.round(optNum(ctx.body, 'size') ?? 1024)));
    const rounds = Math.max(1, Math.round(optNum(ctx.body, 'rounds') ?? Math.ceil(Math.log2(size))));
    const activeSince = optStr(ctx.body, 'activeSince') ?? '2024-01-01';
    const levels = new Set((optStr(ctx.body, 'levels') ?? 'aimag,uls').split(',').map((x) => x.trim()));
    const date = optStr(ctx.body, 'date') ?? new Date(now()).toISOString().slice(0, 10);
    const name = optStr(ctx.body, 'name') ?? `Туршилтын наадам — ${size} бөх`;
    const archive = deps.analytics?.archive.wrestlers;
    const candidates = engine.wrestlers().filter((w) => {
      if (!levels.has(titleInfo(w.title).level)) return false;
      if (!archive) return true;
      const a = archive[w.devjeeId ?? w.id];
      // Архивт байвал сүүлийн тэмцээний огноогоор идэвхтэйг шүүнэ; архивт байхгүй (гараар нэмсэн) бол оруулна
      return !a || !a.lastTournamentDate || a.lastTournamentDate >= activeSince;
    });
    candidates.sort((a, b) => engine.rating(b.id).rating - engine.rating(a.id).rating);
    const entrants = candidates.slice(0, size).map((w) => w.id);
    if (entrants.length < 2) throw new HttpError(400, `Шалгуурт нийцэх бөх хүрэлцэхгүй (${entrants.length}).`, 'NO_ENTRANTS');
    const t = engine.createTournament({ name, date, rounds, kind: 'туршилт', entrants });
    await persist();
    changed();
    return { tournament: tournamentDto(t), entrants: entrants.length, candidates: candidates.length };
  });

  /** Давааг эхлүүлнэ: амьд бөхчүүдийг хослуулж барилдаан + зах зээл нээнэ. {pairing?: 'rank'|'random'|'seq', b?} */
  router.post('/api/admin/tournaments/:id/rounds/:round/start', async (ctx) => {
    await requireAdmin(ctx);
    const round = Number(ctx.params.round);
    if (!Number.isInteger(round) || round < 1) throw new HttpError(400, 'Даваа буруу.', 'BAD_INPUT');
    const pairingRaw = optStr(ctx.body, 'pairing');
    const opts: Parameters<Engine['startRound']>[2] = {};
    if (pairingRaw === 'rank' || pairingRaw === 'random' || pairingRaw === 'seq') opts.pairing = pairingRaw;
    const b = optNum(ctx.body, 'b');
    if (b !== undefined) opts.b = b;
    const r = engine.startRound(ctx.params.id!, round, opts);
    await persist();
    changed();
    return { round: r.round, bouts: r.bouts.length, markets: r.markets.length, byes: r.byes.map((id) => engine.state.wrestlers.get(id)?.name ?? id), status: roundStatusDto(ctx.params.id!) };
  });

  /** Давааг дуусгана: хүлээгдэж буй бүх барилдааны үр дүн. {mode?: 'simulate'|'favorite'} */
  router.post('/api/admin/tournaments/:id/rounds/:round/finish', async (ctx) => {
    await requireAdmin(ctx);
    const round = Number(ctx.params.round);
    if (!Number.isInteger(round) || round < 1) throw new HttpError(400, 'Даваа буруу.', 'BAD_INPUT');
    const modeRaw = optStr(ctx.body, 'mode');
    const opts: Parameters<Engine['finishRound']>[2] = {};
    if (modeRaw === 'simulate' || modeRaw === 'favorite') opts.mode = modeRaw;
    const r = engine.finishRound(ctx.params.id!, round, opts);
    await persist();
    changed();
    return { round: r.round, recorded: r.recorded, resolvedMarkets: r.resolvedMarkets, status: roundStatusDto(ctx.params.id!) };
  });

  router.post('/api/admin/bouts', async (ctx) => {
    await requireAdmin(ctx);
    const input: Parameters<Engine['createBout']>[0] = {
      tournamentId: str(ctx.body, 'tournamentId'),
      round: num(ctx.body, 'round'),
      aId: str(ctx.body, 'aId'),
      bId: str(ctx.body, 'bId'),
      withMarket: bool(ctx.body, 'withMarket', true),
    };
    const closesAt = optStr(ctx.body, 'closesAt');
    if (closesAt) input.closesAt = closesAt;
    const scheduledAt = optStr(ctx.body, 'scheduledAt');
    if (scheduledAt) input.scheduledAt = scheduledAt;
    const b = optNum(ctx.body, 'b');
    if (b !== undefined) input.b = b;
    const { bout, market } = engine.createBout(input);
    await persist();
    changed(market ? [market.id] : undefined);
    return { bout: boutDto(bout, true), market: market ? marketDto(market, undefined, true) : null };
  });

  router.post('/api/admin/bouts/:id/result', async (ctx) => {
    await requireAdmin(ctx);
    const r = engine.recordBoutResult(ctx.params.id!, str(ctx.body, 'winnerId'));
    await persist();
    changed(r.resolvedMarkets.map((m) => m.id));
    return { bout: boutDto(r.bout, true), resolved: r.resolvedMarkets.length };
  });

  router.post('/api/admin/markets', async (ctx) => {
    await requireAdmin(ctx);
    const input: Parameters<Engine['createMarket']>[0] = { title: str(ctx.body, 'title'), outcomes: strArray(ctx.body, 'outcomes') };
    if (isRecord(ctx.body) && Array.isArray(ctx.body.outcomeRefs)) input.outcomeRefs = ctx.body.outcomeRefs.map((x) => (typeof x === 'string' && x ? x : null));
    if (isRecord(ctx.body) && Array.isArray(ctx.body.prior)) input.prior = ctx.body.prior.map(Number);
    const b = optNum(ctx.body, 'b');
    if (b !== undefined) input.b = b;
    for (const k of ['closesAt', 'tournamentId', 'boutId', 'id'] as const) {
      const v = optStr(ctx.body, k);
      if (v !== undefined) input[k] = v;
    }
    const m = engine.createMarket(input);
    await persist();
    changed([m.id]);
    return { market: marketDto(m, undefined, true) };
  });

  /** Дүрэмт зах зээл: {rule:{type,...}, b?, closesAt?} — анхны магадлал прогнозоос. */
  router.post('/api/admin/markets/rule', async (ctx) => {
    await requireAdmin(ctx);
    const raw = isRecord(ctx.body) ? ctx.body.rule : undefined;
    if (!isRecord(raw) || typeof raw.type !== 'string' || typeof raw.tournamentId !== 'string') throw new HttpError(400, '«rule» дутуу.', 'BAD_INPUT');
    let ruleDto: Parameters<ForecastService['priorFor']>[0];
    if (raw.type === 'wins_over') ruleDto = { type: 'wins_over', tournamentId: raw.tournamentId, wrestlerId: str(raw, 'wrestlerId'), line: num(raw, 'line') };
    else if (raw.type === 'wins_exact') ruleDto = { type: 'wins_exact', tournamentId: raw.tournamentId, wrestlerId: str(raw, 'wrestlerId') };
    else if (raw.type === 'matchup') ruleDto = { type: 'matchup', tournamentId: raw.tournamentId, aId: str(raw, 'aId'), bId: str(raw, 'bId') };
    else if (raw.type === 'champion') {
      ruleDto = { type: 'champion', tournamentId: raw.tournamentId };
      const k = optNum(raw, 'topK');
      if (k !== undefined) ruleDto.topK = Math.max(1, Math.min(30, Math.round(k)));
    } else throw new HttpError(400, `Танигдаагүй дүрэм: ${raw.type}`, 'BAD_INPUT');
    const { rule, prior, listed } = forecasts.priorFor(ruleDto);
    const input: Parameters<Engine['createRuleMarket']>[0] = { rule, prior };
    if (listed) input.listed = listed;
    const b = optNum(ctx.body, 'b');
    if (b !== undefined) input.b = b;
    const closesAt = optStr(ctx.body, 'closesAt');
    if (closesAt) input.closesAt = closesAt;
    const m = engine.createRuleMarket(input);
    await persist();
    changed([m.id]);
    return { market: marketDto(m) };
  });

  router.post('/api/admin/markets/:id/close', async (ctx) => {
    await requireAdmin(ctx);
    engine.closeMarket(ctx.params.id!);
    await persist();
    changed([ctx.params.id!]);
    return { market: marketDto(engine.market(ctx.params.id!), undefined, true) };
  });

  router.post('/api/admin/markets/:id/resolve', async (ctx) => {
    await requireAdmin(ctx);
    const r = engine.resolveMarket(ctx.params.id!, num(ctx.body, 'outcome'));
    await persist();
    changed([ctx.params.id!], r.payouts.map((p) => p.userId));
    return { market: marketDto(engine.market(ctx.params.id!), undefined, true), payouts: r.payouts };
  });

  router.post('/api/admin/markets/:id/void', async (ctx) => {
    await requireAdmin(ctx);
    const r = engine.voidMarket(ctx.params.id!, optStr(ctx.body, 'reason') ?? 'хүчингүй');
    await persist();
    changed([ctx.params.id!], r.refunds.map((p) => p.userId));
    return { market: marketDto(engine.market(ctx.params.id!), undefined, true), refunds: r.refunds };
  });

  // ── devjee ──
  const requireDevjee = (): DevjeeSync => {
    if (!deps.devjee) throw new HttpError(503, 'devjee холболт идэвхгүй.', 'NO_DEVJEE');
    return deps.devjee;
  };

  router.get('/api/admin/devjee/home', async (ctx): Promise<DevjeeHomeDto> => {
    await requireAdmin(ctx);
    return requireDevjee().home();
  });

  router.post('/api/admin/devjee/import', async (ctx) => {
    await requireAdmin(ctx);
    const r = await requireDevjee().importTournament(str(ctx.body, 'tid'), { withRatings: bool(ctx.body, 'withRatings', true) });
    await persist();
    changed();
    return { tournament: tournamentDto(engine.tournament(r.tournamentId)), imported: r };
  });

  /** {now?: true} — нэг удаа sync; {enabled?: bool} — автомат давталтыг асаах/унтраах. */
  router.post('/api/admin/devjee/sync/:tournamentId', async (ctx) => {
    await requireAdmin(ctx);
    const d = requireDevjee();
    const id = ctx.params.tournamentId!;
    const hasEnabled = isRecord(ctx.body) && typeof ctx.body.enabled === 'boolean';
    const enabled = bool(ctx.body, 'enabled', false);
    const now_ = bool(ctx.body, 'now', !hasEnabled || enabled);
    let result: Awaited<ReturnType<DevjeeSync['syncOnce']>> | undefined;
    if (now_) {
      result = await d.syncOnce(id);
      await persist();
      changed(result.marketIds);
    }
    if (hasEnabled) {
      d.setEnabled(id, enabled);
      await persist(); // syncEnabled нь Engine-ийн үйл явдал — дахин асахад сэргэнэ
      changed();
    }
    return { status: d.status(id), result: result ?? null };
  });

  /** Архивын бүх бөхийг Engine-д оруулна (өргөтгөсөн талбар + devjee масштабын Elo). */
  router.post('/api/admin/import-archive', async (ctx) => {
    await requireAdmin(ctx);
    if (!deps.analytics) throw new HttpError(503, 'Архив ачаалагдаагүй (npm run archive).', 'NO_ARCHIVE');
    const t0 = Date.now();
    const limit = optNum(ctx.body, 'limit');
    const r = deps.analytics.importAllWrestlers(engine, limit !== undefined ? { limit } : {});
    await persist();
    changed();
    return { ...r, wrestlers: engine.wrestlers().length, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  });

  router.get('/api/admin/devjee/status', async (ctx): Promise<{ statuses: DevjeeSyncStatusDto[] }> => {
    await requireAdmin(ctx);
    return { statuses: requireDevjee().allStatuses() };
  });

  return router;
}

/** Хөгжүүлэлтийн үед өөр порт дээрх Expo dev серверт CORS зөвшөөрнө. */
export function devCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const ok = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
  if (!ok) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('vary', 'origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** Туршилтын id үүсгэгч биш — production-д randomUUID. */
export const newRequestId = (): string => randomUUID();
