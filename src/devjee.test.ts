import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  AIMAGS,
  DevjeeClient,
  DevjeeError,
  eloProbability,
  HOSTS,
  impliedExpectation,
  inflateState,
  MATCH_KINDS,
  parseStateDocument,
  toWrestler,
  TOURNAMENT_TYPES,
  type DevjeeTournamentState,
  type DevjeeWrestler,
} from './devjee.ts';

const orkhon: DevjeeWrestler = {
  id: '-KiYk5VeDPhT2vMoLFSY',
  firstName: 'Орхонбаяр',
  lastName: 'Баярсайханы',
  title: '20',
  aimag: '16',
  sum: '16',
  dateOfBirth: '1998-07-01',
  height: '183',
  lastTournamentDate: '2026-07-13',
};

test('толь бичгүүд бүрэн', () => {
  assert.equal(Object.keys(AIMAGS).length, 23);
  assert.equal(AIMAGS[16], 'Сэлэнгэ');
  assert.equal(AIMAGS[19], 'Улаанбаатар');
  assert.equal(Object.keys(TOURNAMENT_TYPES).length, 40);
  assert.equal(TOURNAMENT_TYPES[1], 'Улсын наадам');
  assert.equal(TOURNAMENT_TYPES[36], 'Үндэсний алтан цом');
  assert.equal(MATCH_KINDS.a, 'ам');
  assert.equal(MATCH_KINDS.o, 'оноолт');
});

test('toWrestler: нэр, цол, аймаг/сум, төрсөн өдөр, өндөр/жин, дэвжээ, харьяалал, цолын түүх', () => {
  const w = toWrestler({
    ...orkhon,
    weight: '108',
    devjee: '26',
    affiliations: JSON.stringify(['"Алдар" спорт хороо', 'АПУ ХК']),
    titleDocs: JSON.stringify([
      { id: 'a', aimag: '16', sum: '16', date: '2022-07-12', fulfilledOn: '2022-07-12', rounds: '9/9', title: '17' },
      { id: 'b', aimag: '17', sum: '8', date: '2016-07-16', fulfilledOn: '2016-07-16', rounds: '6/6', title: '4' },
      { id: 'c', aimag: '', sum: '', date: '', title: '0' },
    ]),
  });
  assert.equal(w.name, 'Б.Орхонбаяр');
  assert.equal(w.fullName, 'Баярсайханы Орхонбаяр');
  assert.equal(w.title, 'даян_аварга');
  assert.equal(w.aimag, 'Сэлэнгэ');
  assert.equal(w.sum, 'Цагааннуур');
  assert.equal(w.birthDate, '1998-07-01');
  assert.equal(w.devjeeId, '-KiYk5VeDPhT2vMoLFSY');
  assert.equal(w.height, 183);
  assert.equal(w.weight, 108);
  assert.equal(w.club, 'Таван Хан');
  assert.deepEqual(w.affiliations, ['"Алдар" спорт хороо', 'АПУ ХК']);
  assert.equal(w.titles?.length, 2, 'цолгүй/огноогүй бичлэг хасагдана');
  assert.equal(w.titles?.[0]?.title, 'сумын_заан');
  assert.equal(w.titles?.[0]?.date, '2016-07-16');
  assert.equal(w.titles?.[0]?.rounds, '6/6');
  assert.equal(w.titles?.[1]?.title, 'улсын_арслан');
  assert.equal(w.titles?.[1]?.place, 'Сэлэнгэ, Цагааннуур');
  // Утгагүй өндөр/жин, эвдэрсэн JSON
  const bad = toWrestler({ ...orkhon, height: '0', weight: 'abc', affiliations: '{эвдэрсэн', titleDocs: 'x' });
  assert.equal(bad.height, undefined);
  assert.equal(bad.weight, undefined);
  assert.equal(bad.affiliations, undefined);
  assert.equal(bad.titles, undefined);
  // овоггүй, огноогүй, танигдаагүй код
  const w2 = toWrestler({ id: 'x', firstName: 'Бат', lastName: '', title: 99, aimag: 0, dateOfBirth: '' });
  assert.equal(w2.name, 'Бат');
  assert.equal(w2.fullName, undefined);
  assert.equal(w2.title, 'цолгүй');
  assert.equal(w2.aimag, undefined);
  assert.equal(w2.birthDate, undefined);
});

test('eloProbability, impliedExpectation (K=32)', () => {
  assert.ok(Math.abs(eloProbability(2345, 2174) - 0.728) < 0.001);
  const e = impliedExpectation({ id: 1, wid: 'a', opponent: 'b', date: '2026-07-10', won: 1, ratingBefore: 2345.079, ratingAfter: 2353.779 });
  assert.ok(Math.abs(e - 0.728) < 0.002);
  const e2 = impliedExpectation({ id: 2, wid: 'a', opponent: 'b', date: '2026-07-10', won: 0, ratingBefore: 2158, ratingAfter: 2128.63 });
  assert.ok(Math.abs(e2 - 0.918) < 0.002);
});

test('inflateState / parseStateDocument: шахсан Firestore баримт задарна', () => {
  const state: DevjeeTournamentState = {
    name: 'Тест',
    date: '2026-08-13',
    rank: 3,
    types: [35],
    wrestlers: { a: { id: 'a', order: 1 }, b: { id: 'b', order: 2 } },
    rounds: { '1': { id: 1, isLocked: true } },
    matches: { m1: { round: 1, w1: 'a', w2: 'b', winner: 1, kind: 'o' } },
  };
  const b64 = deflateSync(Buffer.from(JSON.stringify(state), 'utf8')).toString('base64');
  assert.deepEqual(inflateState(b64), state);
  const doc = {
    name: 'projects/x/databases/(default)/documents/states3/t1',
    fields: { data: { bytesValue: b64 }, timestamp: { timestampValue: '2026-08-13T11:30:17.920Z' }, actionId: { stringValue: '-Oz' } },
  };
  const parsed = parseStateDocument(doc);
  assert.equal(parsed.state.matches.m1!.w1, 'a');
  assert.equal(parsed.timestamp, '2026-08-13T11:30:17.920Z');
  assert.equal(parsed.actionId, '-Oz');
  assert.throws(() => parseStateDocument({ fields: {} }), DevjeeError);
});

interface FakeCall {
  url: string;
  method: string;
  body?: string;
}

function fakeFetch(routes: Record<string, unknown | ((call: FakeCall) => unknown)>, calls: FakeCall[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: FakeCall = { url, method: init?.method ?? 'GET' };
    if (typeof init?.body === 'string') call.body = init.body;
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const v = routes[key];
    const body = typeof v === 'function' ? (v as (c: FakeCall) => unknown)(call) : v;
    if (typeof body === 'string') return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

test('клиент: кэш, завсар (rate limit), хуудаслалт, POST fetch, алдаа', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bukh-devjee-'));
  const calls: FakeCall[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const routes = {
    [`${HOSTS.wrestlers}/search?title=21&page=1`]: { wrestlers: [orkhon], page: 1, pageSize: 100, hasMore: true },
    [`${HOSTS.wrestlers}/search?title=21&page=2`]: { wrestlers: [{ ...orkhon, id: 'w2', firstName: 'Батсуурь', lastName: 'Насанжаргалын', title: '21', aimag: '18' }], page: 2, pageSize: 100, hasMore: false },
    [`${HOSTS.wrestlers}/fetch`]: (c: FakeCall) => {
      const { wids } = JSON.parse(c.body!) as { wids: string[] };
      return Object.fromEntries(wids.map((w) => [w, { ...orkhon, id: w }]));
    },
    [`${HOSTS.ratings}/dates`]: { dates: ['2026-07-10', '2026-07-13'] },
    [`${HOSTS.ratings}/?date=2026-07-13`]: { ratings: { [orkhon.id]: { rating: 2354, rank: 1 } } },
    [`${HOSTS.ratings}/matches/w2`]: { wid: 'w2', matches: [{ id: 9, wid: 'w2', opponent: 'x', date: '2026-07-10', won: 1, ratingBefore: 2160, ratingAfter: 2168 }] },
    [`${HOSTS.ratings}/matches/none`]: { wid: 'none', matches: [] },
    [`${HOSTS.tournaments}/home`]: { scheduled: [], home: [{ id: 't1', name: 'Тест', date: '2026-08-13' }] },
    [`${HOSTS.tournaments}/search?mode=synced&page=1&limit=50&year=2025`]: { tournaments: [{ id: 't', name: 'x', date: '2025-07-11' }], page: 1, pageSize: 50, hasMore: false },
    [`${HOSTS.tournaments}/broken`]: (): never => {
      throw new Error('unused');
    },
  };
  const client = new DevjeeClient({
    fetch: fakeFetch(routes, calls),
    cacheDir: dir,
    minIntervalMs: 400,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  try {
    // Хуудаслалт: 2 хуудас, 2 бөх
    const all: string[] = [];
    for await (const w of client.iterateWrestlers({ title: 21 })) all.push(w.id);
    assert.deepEqual(all, [orkhon.id, 'w2']);
    assert.equal(client.stats.network, 2);
    // Хоёр дахь удаа кэшээс — сүлжээ хандахгүй
    const again = await client.searchWrestlers({ title: 21, page: 1 });
    assert.equal(again.wrestlers.length, 1);
    assert.equal(client.stats.network, 2);
    assert.equal(client.stats.cached, 1);
    // Завсар: 2 дараалсан сүлжээний дуудлагын хооронд 400 мс хүлээсэн
    assert.ok(sleeps.length >= 1 && sleeps.every((s) => s > 0 && s <= 400), JSON.stringify(sleeps));

    // POST fetch — эрэмбэлсэн wids-ээр кэшлэгдэнэ
    const m = await client.fetchWrestlers(['b', 'a']);
    assert.deepEqual(Object.keys(m).sort(), ['a', 'b']);
    const m2 = await client.fetchWrestlers(['a', 'b']);
    assert.deepEqual(m2, m);
    assert.equal(calls.filter((c) => c.url.endsWith('/fetch')).length, 1);
    assert.deepEqual(await client.fetchWrestlers([]), {});

    // Рейтинг
    const latest = await client.latestRatings();
    assert.equal(latest.date, '2026-07-13');
    assert.equal(latest.ratings[orkhon.id]!.rating, 2354);
    const r1 = await client.currentRating(orkhon.id, latest.ratings);
    assert.deepEqual(r1, { rating: 2354, asOf: '2026-07-13', rank: 1 });
    const r2 = await client.currentRating('w2', latest.ratings);
    assert.deepEqual(r2, { rating: 2168, asOf: '2026-07-10' });
    assert.equal(await client.currentRating('none', latest.ratings), undefined);

    // Тэмцээн
    const home = await client.home();
    assert.equal(home.home[0]!.id, 't1');
    const ts = await client.tournaments({ year: 2025 });
    assert.equal(ts.tournaments.length, 1);

    // 404 → DevjeeError статустай
    await assert.rejects(client.tournament('nope'), (e: unknown) => e instanceof DevjeeError && e.status === 404);

    // Кэш TTL дууссан бол дахин татна
    now += 25 * 3_600_000;
    await client.searchWrestlers({ title: 21, page: 1 });
    assert.equal(client.stats.network, calls.length);
    assert.ok(calls.filter((c) => c.url.includes('title=21&page=1')).length === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('клиент: кэшгүй горим ба states3 (Firebase key нээх → баримт задлах)', async () => {
  const state: DevjeeTournamentState = {
    name: 'Наадам',
    date: '2026-07-10',
    wrestlers: { a: { id: 'a', order: 1 } },
    rounds: {},
    matches: { m: { round: 1, w1: 'a', w2: 'b', winner: 2, kind: 'a' } },
  };
  const b64 = deflateSync(Buffer.from(JSON.stringify(state))).toString('base64');
  const calls: FakeCall[] = [];
  const routes = {
    [`${HOSTS.site}/assets/index-abc.js`]: 'var x={apiKey:"AIza-TEST",authDomain:"bukh-dd4e0.firebaseapp.com"};',
    [`${HOSTS.site}/`]: '<html><script src="/assets/index-abc.js"></script></html>',
    [`${HOSTS.firestore}/states3/tid1`]: { fields: { data: { bytesValue: b64 }, timestamp: { timestampValue: '2026-07-10T05:00:00Z' } } },
  };
  const client = new DevjeeClient({ fetch: fakeFetch(routes, calls), cacheDir: null, minIntervalMs: 0 });
  const key = await client.discoverFirebaseKey();
  assert.equal(key, 'AIza-TEST');
  const { state: st, timestamp } = await client.tournamentState('tid1');
  assert.equal(st.matches.m!.winner, 2);
  assert.equal(timestamp, '2026-07-10T05:00:00Z');
  assert.ok(calls.some((c) => c.url.includes('states3/tid1?key=AIza-TEST')));
  // Кэшгүй → дахин дуудахад дахин татна
  await client.tournamentState('tid1');
  assert.equal(calls.filter((c) => c.url.includes('states3/tid1')).length, 2);
  // Өгсөн key-г ашиглана (нээхгүй)
  const c2 = new DevjeeClient({ fetch: fakeFetch(routes, calls), cacheDir: null, firebaseApiKey: 'GIVEN', minIntervalMs: 0 });
  assert.equal(await c2.discoverFirebaseKey(), 'GIVEN');
});

test('клиент: төлөвийг snapshot-оос түрүүлж авна; хоосон snapshot → states3 fallback', async () => {
  const state: DevjeeTournamentState = {
    name: 'Барилгын салбар 100 жил',
    date: '2026-09-05',
    wrestlers: { a: { id: 'a', order: 1 } },
    rounds: { '1': { id: 1 } },
    matches: { m: { round: 1, w1: 'a', w2: 'b', winner: 1, kind: 'o' } },
  };
  const full = deflateSync(Buffer.from(JSON.stringify(state))).toString('base64');
  const empty = deflateSync(Buffer.from(JSON.stringify({ name: 'х', date: '2026-01-01', wrestlers: {}, rounds: {}, matches: {} }))).toString('base64');

  // 1) snapshot бүрэн → states3 руу огт хандахгүй, Firebase key ч нээхгүй
  const calls1: FakeCall[] = [];
  const c1 = new DevjeeClient({ fetch: fakeFetch({ [`${HOSTS.api}/tournament-state/snapshot`]: { actionId: 'a1', data: full } }, calls1), cacheDir: null, minIntervalMs: 0 });
  const r1 = await c1.tournamentState('tid9');
  assert.equal(r1.state.matches.m!.winner, 1);
  assert.equal(r1.actionId, 'a1');
  assert.equal(calls1.length, 1);
  assert.ok(calls1[0]!.url.startsWith(`${HOSTS.api}/tournament-state/snapshot?id=tid9`));

  // 2) snapshot хоосон төлөвтэй (цэвэрлэгдсэн) → states3-оос авна
  const calls2: FakeCall[] = [];
  const c2 = new DevjeeClient({
    fetch: fakeFetch(
      {
        [`${HOSTS.api}/tournament-state/snapshot`]: { data: empty },
        [`${HOSTS.firestore}/states3/tid9`]: { fields: { data: { bytesValue: full } } },
      },
      calls2,
    ),
    cacheDir: null,
    firebaseApiKey: 'K',
    minIntervalMs: 0,
  });
  const r2 = await c2.tournamentState('tid9');
  assert.equal(Object.keys(r2.state.wrestlers).length, 1);
  assert.ok(calls2.some((c) => c.url.includes('states3/tid9')));

  // 3) snapshot 404 (хуучин тэмцээн) → states3 (өмнөх тестийн зам) — фallback хэвээр
  const calls3: FakeCall[] = [];
  const c3 = new DevjeeClient({ fetch: fakeFetch({ [`${HOSTS.firestore}/states3/old1`]: { fields: { data: { bytesValue: full } } } }, calls3), cacheDir: null, firebaseApiKey: 'K', minIntervalMs: 0 });
  assert.equal((await c3.tournamentState('old1')).state.name, state.name);
});
