import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BatchBuyResultDto, BoardDto, HomeDto, MarketDetailDto, MeDto, PortfolioDto, QuoteDto, TradeResultDto } from '../app/src/shared/api.ts';
import { Engine } from '../src/engine.ts';
import { MemoryLog } from '../src/store.ts';
import { createRouter } from './api.ts';
import { MemoryAuthStore } from './auth-store.ts';
import { Auth } from './auth.ts';
import type { EmailMessage } from './email.ts';
import { SseHub } from './http.ts';

interface TestServer {
  base: string;
  engine: Engine;
  emails: EmailMessage[];
  hub: SseHub;
  clock: { t: number; advance(ms: number): void };
  flushes: number;
  close(): Promise<void>;
}

async function startServer(opts: { failFlush?: boolean } = {}): Promise<TestServer> {
  const clock = {
    t: Date.parse('2026-08-20T02:00:00Z'),
    advance(ms: number) {
      this.t += ms;
    },
  };
  let n = 0;
  const engine = new Engine(new MemoryLog(), { now: () => new Date(clock.t), idGen: () => `e${++n}`, defaultB: 1_000 });
  const emails: EmailMessage[] = [];
  const auth = new Auth(new MemoryAuthStore(), {
    now: () => clock.t,
    sendEmail: async (m) => {
      emails.push(m);
    },
  });
  const hub = new SseHub();
  const state = { flushes: 0 } as { flushes: number };
  const fatal: unknown[] = [];
  const router = createRouter({
    engine,
    auth,
    hub,
    now: () => clock.t,
    flush: async () => {
      state.flushes += 1;
      if (opts.failFlush) throw new Error('db down');
    },
    onFatal: (e) => fatal.push(e),
  });
  const server: Server = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const ts: TestServer = {
    base: `http://127.0.0.1:${port}`,
    engine,
    emails,
    hub,
    clock,
    get flushes() {
      return state.flushes;
    },
    close: () =>
      new Promise<void>((r) => {
        hub.closeAll();
        server.close(() => r());
      }),
  };
  return ts;
}

interface Client {
  token: string;
  cookie: string;
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  post<T = unknown>(path: string, body?: unknown, useCookie?: boolean): Promise<{ status: number; body: T }>;
}

function client(base: string): Client {
  const c: Client = {
    token: '',
    cookie: '',
    async get(path) {
      const res = await fetch(base + path, { headers: c.token ? { authorization: `Bearer ${c.token}` } : {} });
      return { status: res.status, body: (await res.json()) as never };
    },
    async post(path, body, useCookie = false) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (useCookie && c.cookie) headers.cookie = c.cookie;
      else if (c.token) headers.authorization = `Bearer ${c.token}`;
      const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) c.cookie = setCookie.split(';')[0]!;
      return { status: res.status, body: (await res.json()) as never };
    },
  };
  return c;
}

const codeFrom = (m: EmailMessage) => m.subject.match(/(\d{6})/)![1]!;

test('API: бүртгэл → баталгаажуулалт → админ тэмцээн/барилдаан → таавар → үр дүн → самбар (бүрэн урсгал)', async () => {
  const s = await startServer();
  try {
    const admin = client(s.base);
    const r1 = await admin.post<{ me: MeDto; token: string; codeSent: boolean }>('/api/register', { username: 'Батцэнгэл', password: 'secret1', email: 'bz@example.com' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.me.account.role, 'admin', 'эхний бүртгэл админ');
    assert.equal(r1.body.me.balance, 10_000);
    assert.ok(r1.body.token);
    assert.ok(admin.cookie.startsWith('bukh_session='));
    admin.token = r1.body.token;

    // Cookie-гоор ч ажиллана
    const meCookie = await fetch(`${s.base}/api/me`, { headers: { cookie: admin.cookie } });
    assert.equal(meCookie.status, 200);
    // Токенгүй → 401
    assert.equal((await fetch(`${s.base}/api/me`)).status, 401);

    // Баталгаажуулаагүй бол таавар тавьж чадахгүй (403), харин харж болно
    const bat = client(s.base);
    const r2 = await bat.post<{ me: MeDto; token: string }>('/api/register', { username: 'Бат', password: 'secret2', email: 'bat@example.com' });
    bat.token = r2.body.token;
    assert.equal(r2.body.me.account.role, 'member');

    // Админ: бөх, тэмцээн, барилдаан (зах зээлтэй)
    const w1 = await admin.post<{ wrestler: { id: string } }>('/api/admin/wrestlers', { id: 'orkhon', name: 'Б.Орхонбаяр', title: 'даян_аварга', aimag: 'Сэлэнгэ', rating: 2354 });
    assert.equal(w1.status, 200);
    await admin.post('/api/admin/wrestlers', { id: 'batmagnai', name: 'Э.Батмагнай', title: 'улсын_арслан', rating: 2301 });
    // member админ endpoint руу орж чадахгүй
    assert.equal((await bat.post('/api/admin/wrestlers', { name: 'x', title: 'цолгүй' })).status, 403);
    const t = await admin.post<{ tournament: { id: string } }>('/api/admin/tournaments', { id: 'naadam', name: 'Тест наадам', date: '2026-08-20', rounds: 9 });
    assert.equal(t.status, 200);
    const b = await admin.post<{ bout: { id: string; priorA: number }; market: { id: string; probs: number[]; modelProbs: number[] } }>('/api/admin/bouts', {
      tournamentId: 'naadam',
      round: 9,
      aId: 'orkhon',
      bId: 'batmagnai',
    });
    assert.equal(b.status, 200);
    const marketId = b.body.market.id;
    assert.ok(Math.abs(b.body.market.probs[0]! - b.body.bout.priorA) < 1e-9);
    assert.deepEqual(b.body.market.modelProbs, b.body.market.probs);

    // Нүүр: барилдааны зах зээл нүүрэнд биш — тэмцээний самбар дээр (хосоор)
    const home = await bat.get<HomeDto>('/api/home');
    assert.equal(home.status, 200);
    assert.equal(home.body.markets.length, 0);
    assert.equal(home.body.tournaments[0]!.openMarkets, 1);
    assert.equal(home.body.tournaments[0]!.currentRound, 9);
    assert.equal(home.body.tournaments[0]!.currentPending, 1);
    const board = await bat.get<BoardDto>('/api/tournaments/naadam/board');
    assert.equal(board.status, 200);
    assert.equal(board.body.round, 9);
    assert.equal(board.body.bouts.length, 1);
    assert.equal(board.body.bouts[0]!.marketId, marketId);
    assert.equal(board.body.bouts[0]!.status, 'open');
    assert.ok(Math.abs(board.body.bouts[0]!.probs[0] - b.body.bout.priorA) < 1e-9);
    assert.equal(board.body.status.current, 9);

    // Quote ажиллана, buy → 403 (баталгаажаагүй)
    const q = await bat.post<QuoteDto>(`/api/markets/${marketId}/quote`, { outcome: 1, spend: 500 });
    assert.equal(q.status, 200);
    assert.ok(q.body.shares > 500);
    const denied = await bat.post(`/api/markets/${marketId}/buy`, { outcome: 1, spend: 500 });
    assert.equal(denied.status, 403);
    assert.equal((denied.body as { code: string }).code, 'UNVERIFIED');

    // Имэйл баталгаажуулах
    const batEmail = s.emails.find((m) => m.to === 'bat@example.com')!;
    const v = await bat.post<MeDto>('/api/verify', { code: codeFrom(batEmail) });
    assert.equal(v.status, 200);
    assert.equal(v.body.account.emailVerified, true);

    // SSE холболт
    const sseCtl = new AbortController();
    const sseRes = await fetch(`${s.base}/api/events?token=${bat.token}`, { signal: sseCtl.signal });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = sseRes.body!.getReader();
    const readChunk = async () => new TextDecoder().decode((await reader.read()).value);
    let sseText = await readChunk();
    assert.match(sseText, /event: hello/);

    // Buy (идемпотент requestId)
    const buy1 = await bat.post<TradeResultDto>(`/api/markets/${marketId}/buy`, { outcome: 1, spend: 500, requestId: 'r-1' });
    assert.equal(buy1.status, 200);
    assert.equal(buy1.body.balance, 9_500);
    assert.ok(buy1.body.market.probs[1]! > b.body.market.probs[1]!);
    assert.deepEqual(buy1.body.market.myPosition?.map((x) => Math.round(x)), [0, Math.round(buy1.body.trade.shares)]);
    const buy2 = await bat.post<TradeResultDto>(`/api/markets/${marketId}/buy`, { outcome: 1, spend: 500, requestId: 'r-1' });
    assert.equal(buy2.body.trade.id, buy1.body.trade.id);
    assert.equal(buy2.body.balance, 9_500, 'давхар төлөгдөөгүй');
    assert.ok(s.flushes >= 1);

    // SSE-д changed ирсэн
    sseText = await readChunk();
    assert.match(sseText, /event: changed/);
    assert.match(sseText, new RegExp(marketId));
    sseCtl.abort();

    // Sell хагас
    const half = buy1.body.trade.shares / 2;
    const sell = await bat.post<TradeResultDto>(`/api/markets/${marketId}/sell`, { outcome: 1, shares: half });
    assert.equal(sell.status, 200);
    assert.ok(sell.body.trade.delta > 0 && sell.body.trade.delta < 500);

    // Дэлгэрэнгүй, арилжааны түүх
    const detail = await bat.get<MarketDetailDto>(`/api/markets/${marketId}`);
    assert.equal(detail.body.recentTrades.length, 2);
    assert.equal(detail.body.recentTrades[0]!.userName, 'Бат');
    assert.equal(detail.body.bout?.a.name, 'Б.Орхонбаяр');

    // Админ үр дүн бүртгэнэ → Батмагнай давав → Бат төлбөр авна
    const res = await admin.post<{ resolved: number }>(`/api/admin/bouts/${b.body.bout.id}/result`, { winnerId: 'batmagnai' });
    assert.equal(res.body.resolved, 1);
    const port = await bat.get<PortfolioDto>('/api/portfolio');
    assert.equal(port.body.balance, 9_500 + sell.body.trade.delta + Math.round(half));
    assert.equal(port.body.ledger[0]!.kind, 'payout');
    assert.equal(port.body.ledger[0]!.marketTitle, buy1.body.market.title);

    const lb = await bat.get<{ rows: { name: string; me: boolean; pnl: number }[] }>('/api/leaderboard');
    assert.equal(lb.body.rows[0]!.name, 'Бат');
    assert.ok(lb.body.rows[0]!.me);
    assert.ok(lb.body.rows[0]!.pnl > 0);

    // Админ: токен олгох, custom зах зээл, хаах/хүчингүй
    const grant = await admin.post<{ balance: number }>('/api/admin/grant', { userId: r2.body.me.account.id, amount: 1_000, reason: 'урамшуулал' });
    assert.equal(grant.body.balance, port.body.balance + 1_000);
    const cm = await admin.post<{ market: { id: string } }>('/api/admin/markets', { title: 'Аварга хэн болох', outcomes: ['А', 'Б', 'Бусад'], prior: [0.5, 0.3, 0.2], b: 500, tournamentId: 'naadam' });
    assert.equal(cm.status, 200);
    await bat.post(`/api/markets/${cm.body.market.id}/buy`, { outcome: 2, spend: 100 });
    const closed = await admin.post<{ market: { status: string } }>(`/api/admin/markets/${cm.body.market.id}/close`);
    assert.equal(closed.body.market.status, 'closed');
    assert.equal((await bat.post(`/api/markets/${cm.body.market.id}/buy`, { outcome: 2, spend: 100 })).status, 400);
    const voided = await admin.post<{ refunds: { userId: string; amount: number }[] }>(`/api/admin/markets/${cm.body.market.id}/void`, { reason: 'тест' });
    assert.deepEqual(voided.body.refunds, [{ userId: r2.body.me.account.id, amount: 100 }]);

    // Хэрэглэгчийн жагсаалт (админ), эрх солих
    const users = await admin.get<{ users: { account: { username: string }; balance: number }[] }>('/api/admin/users');
    assert.equal(users.body.users.length, 2);
    assert.equal((await admin.post('/api/admin/role', { userId: r1.body.me.account.id, role: 'member' })).status, 400, 'өөрийгөө хасахгүй');
    assert.equal((await admin.post('/api/admin/role', { userId: r2.body.me.account.id, role: 'admin' })).status, 200);

    // Туршилтын тэмцээн үүсгэх (generate) → даваа эхлүүлэх → самбар → олон бооцоо нэг дор → даваа дуусгах
    for (let i = 0; i < 6; i++) await admin.post('/api/admin/wrestlers', { id: `g${i}`, name: `Г.Бөх${i}`, title: 'аймгийн_заан', rating: 1800 - i * 20 });
    const gen = await admin.post<{ tournament: { id: string; rounds: number; entrants: number }; entrants: number }>('/api/admin/tournaments/generate', { size: 8, name: 'Найман бөх' });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.entrants, 8, 'аймгийн/улсын цолтой: orkhon, batmagnai + g0..g5');
    assert.equal(gen.body.tournament.rounds, 3);
    const gid = gen.body.tournament.id;
    const st1 = await admin.post<{ round: number; bouts: number; markets: number; status: { current: number; next: number } }>(`/api/admin/tournaments/${gid}/rounds/1/start`, { pairing: 'rank' });
    assert.equal(st1.status, 200);
    assert.deepEqual([st1.body.bouts, st1.body.markets, st1.body.status.current, st1.body.status.next], [4, 4, 1, 0]);
    assert.equal((await admin.post(`/api/admin/tournaments/${gid}/rounds/2/start`)).status, 400, 'өмнөх даваа дуусаагүй');
    const gb = await bat.get<BoardDto>(`/api/tournaments/${gid}/board`);
    assert.equal(gb.body.bouts.length, 4);
    assert.equal(gb.body.bouts[0]!.a.id, 'orkhon', 'оноолт: дээд зэрэглэл эхэнд');
    const orders = gb.body.bouts.map((x, i) => ({ marketId: x.marketId!, outcome: i % 2, spend: 100, requestId: `bb-${i}` }));
    orders.push({ marketId: 'байхгүй', outcome: 0, spend: 100, requestId: 'bb-x' });
    s.clock.advance(3_000); // арилжааны хурдны хязгаарын цонх шинээр
    const bb = await bat.post<BatchBuyResultDto>('/api/markets/buy-batch', { orders });
    assert.equal(bb.status, 200);
    assert.equal(bb.body.placed, 4);
    assert.equal(bb.body.results.filter((x) => !x.ok).length, 1, 'буруу зах зээл бусдад саад болохгүй');
    const bb2 = await bat.post<BatchBuyResultDto>('/api/markets/buy-batch', { orders: orders.slice(0, 1) });
    assert.equal(bb2.body.balance, bb.body.balance, 'requestId идемпотент — давхар төлөгдөхгүй');
    const gb2 = await bat.get<BoardDto>(`/api/tournaments/${gid}/board`);
    assert.ok(gb2.body.bouts[0]!.myShares && gb2.body.bouts[0]!.myShares[0] > 0);
    const fin = await admin.post<{ recorded: number; resolvedMarkets: number; status: { current: number; next: number; alive: number } }>(`/api/admin/tournaments/${gid}/rounds/1/finish`, { mode: 'favorite' });
    assert.deepEqual([fin.body.recorded, fin.body.resolvedMarkets, fin.body.status.next, fin.body.status.alive], [4, 4, 2, 4]);
    const gb3 = await bat.get<BoardDto>(`/api/tournaments/${gid}/board?round=1`);
    assert.equal(gb3.body.bouts.filter((x) => x.winnerId).length, 4);
    assert.equal(gb3.body.bouts[0]!.winnerId, 'orkhon');

    // Хайлт: цол + аймаг үгсээр
    const search = await bat.get<{ wrestlers: { name: string }[]; total: number }>('/api/wrestlers?q=' + encodeURIComponent('даян сэлэнгэ'));
    assert.deepEqual(search.body.wrestlers.map((w) => w.name), ['Б.Орхонбаяр']);

    // Гарах → 401
    await bat.post('/api/logout');
    assert.equal((await bat.get('/api/me')).status, 401);
    // Буруу JSON → 400
    const badJson = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{буруу' });
    assert.equal(badJson.status, 400);
    // Дутуу талбар → 400
    assert.equal((await client(s.base).post('/api/login', { username: 'x' })).status, 400);
    // 404 API замд (router олохгүй → сервер 404)
    assert.equal((await fetch(`${s.base}/api/nope`)).status, 404);
    // health
    const health = await (await fetch(`${s.base}/health`)).json();
    assert.equal((health as { ok: boolean }).ok, true);
    s.engine.checkInvariants();
  } finally {
    await s.close();
  }
});

test('API: нэвтрэлтийн хурдны хязгаар, нууц үг сэргээх, flush бүтэлгүйтэл', async () => {
  const s = await startServer();
  try {
    const c = client(s.base);
    await c.post('/api/register', { username: 'Бат', password: 'secret1', email: 'bat@example.com' });
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await client(s.base).post('/api/login', { username: 'Бат', password: 'буруу' })).status;
    assert.equal(last, 429, 'IP-д минутанд 12-оос дээш → 429');
    s.clock.advance(61_000);
    assert.equal((await client(s.base).post('/api/login', { username: 'Бат', password: 'secret1' })).status, 200);

    // Мартсан нууц үг → код → сэргээх → шинэ нууц үгээр нэвтэрнэ
    const before = s.emails.length;
    assert.equal((await client(s.base).post('/api/forgot', { email: 'nobody@example.com' })).status, 200);
    assert.equal(s.emails.length, before);
    await client(s.base).post('/api/forgot', { email: 'bat@example.com' });
    assert.equal(s.emails.length, before + 1);
    const code = codeFrom(s.emails.at(-1)!);
    assert.equal((await client(s.base).post('/api/reset', { email: 'bat@example.com', code, password: 'newpass1' })).status, 200);
    assert.equal((await client(s.base).post('/api/login', { username: 'Бат', password: 'newpass1' })).status, 200);
  } finally {
    await s.close();
  }

  // flush бүтэлгүйтвэл 503 + onFatal
  const s2 = await startServer({ failFlush: true });
  try {
    const c = client(s2.base);
    const r = await c.post('/api/register', { username: 'Бат', password: 'secret1', email: 'bat@example.com' });
    assert.equal(r.status, 503);
    assert.equal((r.body as { code: string }).code, 'PERSIST');
  } finally {
    await s2.close();
  }
});
