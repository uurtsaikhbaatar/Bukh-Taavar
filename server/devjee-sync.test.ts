import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DevjeeStateMatch, DevjeeTournamentState, DevjeeWrestler } from '../src/devjee.ts';
import { Engine } from '../src/engine.ts';
import { MemoryLog } from '../src/store.ts';
import { DevjeeSync, shortName, type DevjeeApi } from './devjee-sync.ts';

function fakeApi(state: DevjeeTournamentState) {
  const wrestlers: Record<string, DevjeeWrestler> = {
    wA: { id: 'wA', firstName: 'Орхонбаяр', lastName: 'Баярсайханы', title: '20', aimag: '16' },
    wB: { id: 'wB', firstName: 'Батмагнай', lastName: 'Энхбаярын', title: '17', aimag: '3' },
    wC: { id: 'wC', firstName: 'Хангай', lastName: 'Очирын', title: '18', aimag: '20' },
    wD: { id: 'wD', firstName: 'Тест', lastName: 'Тестийн', title: '4', aimag: '1' },
  };
  const calls = { state: 0, fetch: 0, ratings: 0, current: 0 };
  const api: DevjeeApi = {
    home: async () => ({
      scheduled: [{ id: 'T2', name: 'Ирэх наадам', date: '2026-09-01', location: { aimag: 17, sum: 1 } }],
      home: [{ id: 'T1', name: 'Тест наадам', date: '2026-08-20', location: { aimag: 19, sum: 1 } }],
    }),
    tournament: async (tid) => ({ id: tid, name: 'Тест наадам — маш урт нэртэй тэмцээн бөгөөд энэ нэр нь далан тэмдэгтээс хэтэрнэ шүү', date: '2026-08-20', type: [1], location: { aimag: 19, sum: 1 } }),
    tournamentState: async () => {
      calls.state += 1;
      return { state: structuredClone(state), timestamp: '2026-08-20T03:00:00Z' };
    },
    fetchWrestlers: async (wids) => {
      calls.fetch += 1;
      return Object.fromEntries(wids.filter((w) => wrestlers[w]).map((w) => [w, wrestlers[w]!]));
    },
    latestRatings: async () => {
      calls.ratings += 1;
      return { date: '2026-07-13', ratings: { wA: { rating: 2354, rank: 1 }, wB: { rating: 2301, rank: 2 } } };
    },
    currentRating: async (wid) => {
      calls.current += 1;
      return wid === 'wC' ? { rating: 2259, asOf: '2026-07-10' } : undefined;
    },
  };
  return { api, calls, state };
}

/** Тэмцээний өдрийн цаг (Улаанбаатар) — авто-унтраалт/засварын хугацааг тогтвортой болгоно. */
const ON_DAY = Date.parse('2026-08-20T12:00:00+08:00');

function baseState(): DevjeeTournamentState {
  return {
    name: 'Тест наадам',
    date: '2026-08-20',
    wrestlers: { wA: { id: 'wA', order: 1 }, wB: { id: 'wB', order: 2 }, wC: { id: 'wC', order: 3 }, wD: { id: 'wD', order: 4 } },
    rounds: { '1': { id: 1 }, '2': { id: 2 } },
    matches: {},
  };
}

test('shortName', () => {
  assert.equal(shortName('  Богино   нэр '), 'Богино нэр');
  assert.equal(shortName('а'.repeat(80)).length, 70);
  assert.ok(shortName('а'.repeat(80)).endsWith('…'));
});

test('импорт: тэмцээн, бөхчүүд (id = wid), рейтинг топ-500 + түүхээс, давтан импорт идемпотент', async () => {
  const { api, calls } = fakeApi(baseState());
  const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })() });
  const sync = new DevjeeSync({ client: api, engine, log: () => undefined });

  const home = await sync.home();
  assert.equal(home.scheduled[0]!.place, 'Төв');
  assert.equal(home.recent[0]!.imported, false);

  const r = await sync.importTournament('T1');
  assert.equal(r.created, true);
  assert.equal(r.wrestlersAdded, 4);
  assert.equal(r.ratingsFromTop, 2);
  assert.equal(r.ratingsFromMatches, 1, 'wC улсын аварга → түүхээс; wD сумын заан → хайхгүй');
  const t = engine.tournament(r.tournamentId);
  assert.equal(t.devjeeId, 'T1');
  assert.equal(t.rounds, 2);
  assert.equal(t.kind, 'Улсын наадам');
  assert.equal(t.place, 'Улаанбаатар');
  assert.ok(t.name.length <= 70);
  assert.equal(engine.wrestler('wA').name, 'Б.Орхонбаяр');
  assert.equal(engine.wrestler('wA').title, 'даян_аварга');
  assert.equal(engine.rating('wA').rating, 2354);
  assert.equal(engine.rating('wC').rating, 2259);
  assert.equal(engine.rating('wD').source, 'seed');
  assert.equal((await sync.home()).recent[0]!.imported, true);

  const r2 = await sync.importTournament('T1');
  assert.equal(r2.created, false);
  assert.equal(r2.wrestlersAdded, 0);
  assert.equal(r2.wrestlersExisting, 4);
  assert.equal(calls.current, 1, 'түүхээс хайлт давтагдахгүй (devjee эх сурвалжтай)');
  assert.equal(engine.wrestlers().length, 4);
  assert.ok(sync.isEnabled(r.tournamentId), 'импортын дараа sync автоматаар асна');
  sync.stop();
});

test('sync: шинэ барилдаан → зах зээл; winner → шийдэх; noShow → хүчингүй; давтан sync идемпотент', async () => {
  const st = baseState();
  const { api, state } = fakeApi(st);
  const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })(), defaultB: 1_000, bracket: false });
  engine.createUser({ id: 'u1', name: 'Бат' });
  const changedIds: string[] = [];
  const sync = new DevjeeSync({ client: api, engine, log: () => undefined, onSynced: (r) => void changedIds.push(...r.marketIds), intervalMs: 5, now: () => ON_DAY });
  const { tournamentId } = await sync.importTournament('T1', { withRatings: true });
  assert.ok(sync.isEnabled(tournamentId), 'импортын дараа sync автоматаар асна');
  sync.setEnabled(tournamentId, false); // цаашхи алхмуудыг гараар, детерминистик шалгана

  // 1-р даваа: 2 барилдаан, үр дүнгүй
  state.matches.m1 = { round: 1, w1: 'wA', w2: 'wD', winner: 0, kind: 'o' } as DevjeeStateMatch;
  state.matches.m2 = { round: 1, w1: 'wB', w2: 'wC', winner: 0, kind: 'a' } as DevjeeStateMatch;
  let r = await sync.syncOnce(tournamentId);
  assert.equal(r.newBouts, 2);
  assert.equal(r.marketIds.length, 2);
  const m1 = engine.markets({ boutId: 'dj-m1' })[0]!;
  assert.equal(m1.status, 'open');
  assert.ok(engine.probabilities(m1.id)[0]! > 0.9, 'Орхонбаяр vs сумын заан → загвар >90%');
  engine.buy('u1', m1.id, 1, 100); // Бат гэнэтийн үр дүнд

  // Дахин sync — юу ч өөрчлөгдөхгүй
  r = await sync.syncOnce(tournamentId);
  assert.equal(r.newBouts, 0);
  assert.equal(r.resolved, 0);

  // Үр дүн: m1 wD (гэнэт) давав; m2 гоц (wC ирээгүй, wB давсанд тооцно)
  state.matches.m1!.winner = 2;
  state.matches.m2!.winner = 1;
  state.matches.m2!._noShow = true;
  const m2 = engine.markets({ boutId: 'dj-m2' })[0]!;
  engine.buy('u1', m2.id, 0, 50);
  r = await sync.syncOnce(tournamentId);
  assert.equal(r.resolved, 1);
  assert.equal(r.voided, 1);
  assert.equal(engine.market(m1.id).status, 'resolved');
  assert.equal(engine.market(m1.id).resolvedOutcome, 1);
  assert.equal(engine.market(m2.id).status, 'voided');
  assert.equal(engine.bout('dj-m2').result?.winnerId, 'wB');
  assert.equal(engine.rating('wB').source, 'devjee', 'гоц барилдаанд рейтинг өөрчлөгдөхгүй');
  assert.equal(engine.rating('wD').source, 'local', 'бодит барилдаанд Elo шинэчлэгдсэн');
  // Бат: m1-д 100 → давсан, m2-д 50 буцаалт
  assert.ok(engine.balance('u1') > 100_000);
  engine.checkInvariants();

  // 2-р даваа: танигдаагүй бөх ирвэл татаж нэмнэ; буруу даваа алгасна
  state.matches.m3 = { round: 2, w1: 'wD', w2: 'wB', winner: 0 } as DevjeeStateMatch;
  state.matches.bad = { round: 9, w1: 'wA', w2: 'wB', winner: 0 } as DevjeeStateMatch;
  state.matches.same = { round: 2, w1: 'wA', w2: 'wA', winner: 0 } as DevjeeStateMatch;
  r = await sync.syncOnce(tournamentId);
  assert.equal(r.newBouts, 1);
  assert.equal(r.skipped, 2);

  // Барилдаан эхэлсэн (devjee startedAt) → бооцоо хаагдана; үр дүн ирэхэд шийдэгдэнэ
  state.matches.m3!.startedAt = Date.now();
  r = await sync.syncOnce(tournamentId);
  assert.equal(r.closed, 1);
  assert.equal(engine.markets({ boutId: 'dj-m3' })[0]!.status, 'closed');
  assert.equal((await sync.syncOnce(tournamentId)).closed, 0, 'давтан sync-д дахин хаахгүй');

  // Автомат давталт
  sync.setEnabled(tournamentId, true);
  assert.ok(sync.isEnabled(tournamentId));
  state.matches.m3!.winner = 2;
  await sync.tick();
  assert.equal(engine.bout('dj-m3').result?.winnerId, 'wB');
  assert.ok(changedIds.length > 0);
  const status = sync.status(tournamentId);
  assert.equal(status.enabled, false, 'финал шийдэгдмэгц (аварга тодорсон) sync автоматаар унтарна');
  assert.equal(engine.tournament(tournamentId).syncEnabled, false, 'унтарсан төлөв Engine-д (үйл явдал) хадгалагдана');
  assert.equal(status.bouts, 3);
  assert.equal(status.resolved, 3);
  assert.ok(status.lastSyncAt);
  // Гараар асаах/унтраах үйл явдлаар хадгалагдана
  sync.setEnabled(tournamentId, true);
  assert.equal(engine.tournament(tournamentId).syncEnabled, true);
  sync.setEnabled(tournamentId, false);
  assert.equal(engine.tournament(tournamentId).syncEnabled, false);
  assert.equal(sync.allStatuses().length, 1);
  sync.stop();

  // Дахин асахад (шинэ DevjeeSync, ижил Engine) асаалттай төлөв сэргэнэ
  sync.setEnabled(tournamentId, true);
  sync.stop();
  const sync2 = new DevjeeSync({ client: api, engine, log: () => undefined, intervalMs: 5, now: () => ON_DAY });
  assert.equal(sync2.isEnabled(tournamentId), true, 'сервер дахин ассан ч sync унтрахгүй');
  sync2.stop();
  sync.setEnabled(tournamentId, false);

  // devjee-гүй тэмцээнд sync хийхгүй
  engine.createTournament({ id: 'manual', name: 'Гараар', date: '2026-08-21', rounds: 3 });
  await assert.rejects(sync.syncOnce('manual'), /devjee-тэй холбоогүй/);
});

test('дутуу импорт өөрийгөө засна: даваа өсөж, оролцогч шинэчлэгдэж, дундуур авто-унтрахгүй', async () => {
  // Тэмцээнийг devjee төлөв нь бараг хоосон байхад импортолжээ (2026-10-03-ны бодит алдаа)
  const st = baseState();
  st.wrestlers = { wA: { id: 'wA', order: 1 }, wB: { id: 'wB', order: 2 } };
  st.rounds = { '1': { id: 1 } };
  const { api, state } = fakeApi(st);
  const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })(), defaultB: 1_000, bracket: false });
  const sync = new DevjeeSync({ client: api, engine, log: () => undefined, now: () => ON_DAY });
  const { tournamentId } = await sync.importTournament('T1');
  assert.equal(engine.tournament(tournamentId).rounds, 1, 'дутуу төлөвөөс 1 даваа гэж үүснэ');
  assert.ok(sync.isEnabled(tournamentId), 'шинэ тэмцээнд sync автоматаар асна');

  // devjee төлөв бүрэн болов: 4 бөх, 2 даваа; 1-р даваа бүхэлдээ шийдэгдсэн
  state.wrestlers = baseState().wrestlers;
  state.rounds = { '1': { id: 1 }, '2': { id: 2 } };
  state.matches.m1 = { round: 1, w1: 'wA', w2: 'wD', winner: 1 } as DevjeeStateMatch;
  state.matches.m2 = { round: 1, w1: 'wB', w2: 'wC', winner: 1 } as DevjeeStateMatch;
  let r = await sync.syncOnce(tournamentId);
  assert.equal(engine.tournament(tournamentId).rounds, 2, 'даваа төлөвөөс өснө');
  assert.equal(r.newBouts, 2);
  assert.equal(engine.tournament(tournamentId).entrants?.length, 4, 'оролцогчид нөхөгдөнө');
  assert.equal(engine.roundStatus(tournamentId).finished, false, '1-р даваа дууссан ч тэмцээн дуусаагүй');
  assert.ok(sync.isEnabled(tournamentId), 'финал шийдэгдээгүй тул унтрахгүй');

  // Финал (2-р даваа, 1 барилдаан) шийдэгдэв — одоо л жинхэнэ төгсгөл
  state.matches.m3 = { round: 2, w1: 'wA', w2: 'wB', winner: 2 } as DevjeeStateMatch;
  r = await sync.syncOnce(tournamentId);
  assert.equal(r.newBouts, 1);
  assert.equal(engine.roundStatus(tournamentId).championId, 'wB');
  assert.equal(sync.isEnabled(tournamentId), false, 'финал шийдэгдмэгц sync унтарна');
  sync.stop();
});

/** 32 бөхийн бүтэн хүрээ: x1..x32 (зэрэг дэвээр), дээгүүр нь үргэлж давна → аварга x1. */
function fullBracket32(): { ids: string[]; matches: Record<string, DevjeeStateMatch> } {
  const ids = Array.from({ length: 32 }, (_, i) => `x${i + 1}`);
  const matches: Record<string, DevjeeStateMatch> = {};
  let alive = ids.slice();
  for (let round = 1; alive.length > 1; round++) {
    const next: string[] = [];
    for (let i = 0; i < alive.length / 2; i++) {
      matches[`r${round}m${i + 1}`] = { round, w1: alive[i]!, w2: alive[alive.length - 1 - i]!, winner: 1 } as DevjeeStateMatch;
      next.push(alive[i]!);
    }
    alive = next;
  }
  return { ids, matches };
}

test('хүрээний дүрэм: дутуу бүртгэлтэй (1 даваа · 2 бөх) тэмцээн аварга зарлахгүй, ⚠, sync асаалттай; бүтэн хүрээ + финалаар л аварга', async () => {
  const { ids, matches } = fullBracket32();
  const st = baseState();
  st.wrestlers = Object.fromEntries(ids.map((id, i) => [id, { id, order: i + 1 }]));
  st.rounds = { '1': { id: 1 } };
  st.matches = { r1m1: matches.r1m1! }; // импортын агшинд devjee дээр ганц барилдаан зарлагдсан
  const { api, state } = fakeApi(st);
  const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })(), defaultB: 1_000 }); // анхдагч: Монгол бөхийн хүрээ
  const sync = new DevjeeSync({ client: api, engine, log: () => undefined, now: () => ON_DAY });
  const { tournamentId } = await sync.importTournament('T1', { withRatings: false });
  await sync.syncOnce(tournamentId);
  // 2026-10-03-ны алдааны дүр зураг: даваа 1, оролцогч 2, ганц барилдаан шийдэгдсэн
  assert.equal(engine.tournament(tournamentId).rounds, 1);
  assert.equal(engine.tournament(tournamentId).entrants?.length, 2, 'оролцогчид = бодитоор хослуулсан бөх');
  assert.equal(engine.roundStatus(tournamentId).finished, false, '2 бөхөөр тэмцээн дуусахгүй');
  assert.equal(engine.roundStatus(tournamentId).championId, undefined);
  assert.match(sync.status(tournamentId).warning ?? '', /32/);
  assert.ok(sync.isEnabled(tournamentId), 'бүртгэл дутуу — sync асаалттай үлдэж засагдахыг хүлээнэ');

  // devjee бүрэн болов: 5 даваа зарлагдаж, финалаас бусад бүх барилдаан шийдэгдсэн
  state.rounds = { '1': { id: 1 }, '2': { id: 2 }, '3': { id: 3 }, '4': { id: 4 }, '5': { id: 5 } };
  state.matches = { ...matches };
  const final = state.matches.r5m1!;
  delete state.matches.r5m1;
  await sync.syncOnce(tournamentId);
  assert.equal(engine.tournament(tournamentId).rounds, 5);
  assert.equal(engine.tournament(tournamentId).entrants?.length, 32);
  assert.equal(sync.status(tournamentId).warning, undefined, 'хүрээ бүтэн — анхааруулга арилна');
  assert.equal(engine.roundStatus(tournamentId).finished, false, 'финал болоогүй');
  assert.ok(sync.isEnabled(tournamentId));

  state.matches.r5m1 = final;
  await sync.syncOnce(tournamentId);
  assert.equal(engine.roundStatus(tournamentId).championId, 'x1');
  assert.equal(engine.bouts(tournamentId).length, 31);
  assert.equal(sync.isEnabled(tournamentId), false, 'финал шийдэгдмэгц sync унтарна');
  sync.stop();
});

test('автомат засвар: хүрээ дутуу + sync унтраалттай devjee тэмцээнийг сервер эхлэхэд 72 цагийн дотор асаана', () => {
  const make = () => {
    const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })() });
    engine.addWrestler({ id: 'a', name: 'А', title: 'цолгүй' });
    engine.addWrestler({ id: 'b', name: 'Б', title: 'цолгүй' });
    engine.createTournament({ id: 'dj-T9', name: 'Дутуу', date: '2026-08-20', rounds: 1, devjeeId: 'T9', entrants: ['a', 'b'] });
    return engine;
  };
  const { api } = fakeApi(baseState());
  const within = new DevjeeSync({ client: api, engine: make(), log: () => undefined, now: () => ON_DAY + 24 * 3_600_000 });
  assert.ok(within.isEnabled('dj-T9'), '72 цагийн дотор — засварт асна');
  within.stop();
  const late = new DevjeeSync({ client: api, engine: make(), log: () => undefined, now: () => ON_DAY + 5 * 24 * 3_600_000 });
  assert.equal(late.isEnabled('dj-T9'), false, 'хугацаа өнгөрсөн — дахин асаахгүй (админд ⚠ л үлдэнэ)');
  assert.match(late.status('dj-T9').warning ?? '', /2 бөх/);
  late.stop();
});
