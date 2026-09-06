import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine, EngineError } from './engine.ts';
import { winProbability } from './rating.ts';
import { serializeState } from './state.ts';
import { JsonlLog, MemoryLog } from './store.ts';

interface Harness {
  engine: Engine;
  log: MemoryLog;
  clock: { t: number; advance(ms: number): void };
}

function makeEngine(opts: { startingBalance?: number; defaultB?: number } = {}): Harness {
  const log = new MemoryLog();
  const clock = {
    t: Date.parse('2026-07-10T00:00:00.000Z'),
    advance(ms: number) {
      this.t += ms;
    },
  };
  let n = 0;
  const engine = new Engine(log, {
    now: () => new Date(clock.t),
    idGen: () => `id${String(++n).padStart(4, '0')}`,
    startingBalance: opts.startingBalance ?? 10_000,
    defaultB: opts.defaultB ?? 1_000,
  });
  return { engine, log, clock };
}

/** Хоёр бөх, нэг тэмцээн, нэг барилдаан + зах зээл бүхий бэлэн орчин. */
function seeded() {
  const h = makeEngine();
  const { engine } = h;
  engine.createUser({ id: 'admin', name: 'Батцэнгэл', role: 'admin' });
  engine.createUser({ id: 'u1', name: 'Бат' });
  engine.createUser({ id: 'u2', name: 'Болд' });
  engine.addWrestler({ id: 'w1', name: 'Б.Орхонбаяр', title: 'даян_аварга', aimag: 'Сэлэнгэ' });
  engine.addWrestler({ id: 'w2', name: 'Э.Батмагнай', title: 'улсын_арслан', aimag: 'Баянхонгор' });
  engine.addWrestler({ id: 'w3', name: 'Ц.Тестбөх', title: 'сумын_заан' });
  engine.setRating('w1', 2354, 'devjee', '2026-07-13');
  engine.setRating('w2', 2301, 'devjee', '2026-07-13');
  engine.createTournament({ id: 't1', name: 'Тест наадам', date: '2026-07-11', rounds: 9 });
  const { bout, market } = engine.createBout({ id: 'b1', tournamentId: 't1', round: 9, aId: 'w1', bId: 'w2' });
  return { ...h, bout, market: market! };
}

test('амьдралын мөчлөг: prior → авах → үнэ хөдлөх → зарах → үр дүн → төлбөр → самбар', () => {
  const { engine, market } = seeded();
  // Prior = Elo(2354, 2301)
  const pA = winProbability(2354, 2301);
  const probs0 = engine.probabilities(market.id);
  assert.ok(Math.abs(probs0[0]! - pA) < 1e-9);
  assert.equal(market.kind, 'bout');
  assert.equal(market.title, 'Тест наадам · 9-р даваа: Б.Орхонбаяр — Э.Батмагнай');
  assert.deepEqual(market.outcomeRefs, ['w1', 'w2']);

  // Quote ба buy тохирно
  const q = engine.quoteBuy(market.id, 1, 1_000);
  assert.ok(q.shares > 1_000, 'хувь > зарцуулалт (үнэ < 1)');
  assert.ok(q.priceAfter > q.priceBefore);
  assert.equal(q.payoutIfWin, Math.round(q.shares));
  const tr = engine.buy('u1', market.id, 1, 1_000, 'req-1');
  assert.equal(tr.delta, -1_000);
  assert.ok(Math.abs(tr.shares - q.shares) < 1e-9);
  assert.equal(engine.balance('u1'), 9_000);
  assert.ok(engine.probabilities(market.id)[1]! > probs0[1]!);

  // Идемпотент: ижил requestId → ижил арилжаа, давхар төлбөргүй
  const again = engine.buy('u1', market.id, 1, 1_000, 'req-1');
  assert.equal(again.id, tr.id);
  assert.equal(engine.balance('u1'), 9_000);
  assert.equal(engine.state.trades.size, 1);

  // Хоёр дахь хэрэглэгч нөгөө талд
  engine.buy('u2', market.id, 0, 500);
  assert.equal(engine.balance('u2'), 9_500);
  engine.checkInvariants();

  // Хагасыг нь зарах — орлого ≤ зарцуулалт (үнэ буурсан тул), бүхэл тоо
  const half = tr.shares / 2;
  const sq = engine.quoteSell(market.id, 1, half);
  assert.ok(Number.isInteger(sq.proceeds));
  const sold = engine.sell('u1', market.id, 1, half);
  assert.equal(sold.delta, sq.proceeds);
  assert.ok(sold.delta > 0 && sold.delta < 1_000);
  assert.equal(engine.balance('u1'), 9_000 + sq.proceeds);
  engine.checkInvariants();

  // Эзэмшил
  const pos = engine.positions('u1');
  assert.equal(pos.length, 1);
  assert.ok(Math.abs(pos[0]!.shares - half) < 1e-9);
  assert.equal(pos[0]!.outcomeLabel, 'Э.Батмагнай');

  // Үр дүн: Батмагнай (w2) давлаа → u1 хувь бүрд 1 токен
  const res = engine.recordBoutResult('b1', 'w2');
  assert.equal(res.resolvedMarkets.length, 1);
  const m = engine.market(market.id);
  assert.equal(m.status, 'resolved');
  assert.equal(m.resolvedOutcome, 1);
  assert.equal(engine.balance('u1'), 9_000 + sq.proceeds + Math.round(half));
  assert.equal(engine.balance('u2'), 9_500);
  engine.checkInvariants();

  // Elo шинэчлэгдсэн (K=32), source local
  const r1 = engine.rating('w1');
  const r2 = engine.rating('w2');
  assert.equal(r1.source, 'local');
  assert.ok(r1.rating < 2354 && r2.rating > 2301);
  assert.ok(Math.abs(r1.rating + r2.rating - (2354 + 2301)) < 1e-9);
  assert.ok(Math.abs(2301 + 32 * (1 - winProbability(2301, 2354)) - r2.rating) < 1e-9);

  // Самбар: u1 давсан, дараа нь u2, дараа нь admin (юу ч хийгээгүй)
  const lb = engine.leaderboard();
  assert.equal(lb[0]!.userId, 'u1');
  assert.ok(lb[0]!.pnl > 0);
  assert.equal(lb[1]!.userId, 'admin');
  assert.equal(lb[1]!.pnl, 0);
  assert.equal(lb[2]!.userId, 'u2');
  assert.equal(lb[2]!.pnl, -500);

  // Дэвтэр
  const led = engine.ledger('u1');
  assert.deepEqual(
    led.map((l) => l.kind),
    ['payout', 'sell', 'buy', 'start'],
  );

  // Хаус: кэш = 1000 + 500 − proceeds − payout
  const hs = engine.houseSummary();
  assert.equal(hs.cash, 1_000 + 500 - sq.proceeds - Math.round(half));
  assert.equal(hs.resolved, 1);
});

test('replay: лог → шинэ Engine → яг ижил төлөв (MemoryLog ба JsonlLog)', () => {
  const { engine, log, market } = seeded();
  engine.buy('u1', market.id, 1, 700, 'a');
  engine.buy('u2', market.id, 0, 300);
  engine.sell('u1', market.id, 1, 100);
  engine.grantTokens('u2', 2_000, 'урамшуулал');
  engine.recordBoutResult('b1', 'w1');
  engine.checkInvariants();

  const replayed = new Engine(log);
  assert.deepEqual(serializeState(replayed.state), serializeState(engine.state));

  // JSONL-ээр дамжуулан
  const dir = mkdtempSync(join(tmpdir(), 'bukh-engine-'));
  try {
    const path = join(dir, 'events.jsonl');
    const jl = new JsonlLog(path);
    for (const e of log.readAll()) jl.append(e);
    const fromFile = new Engine(new JsonlLog(path));
    assert.deepEqual(serializeState(fromFile.state), serializeState(engine.state));
    // Дараа нь үргэлжлүүлж болно
    fromFile.createUser({ id: 'u9', name: 'Шинэ' });
    assert.equal(new Engine(new JsonlLog(path)).users().length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('алдаанууд: хүрэлцээгүй, доод хэмжээ, буруу оролт, хаагдсан, давхар', () => {
  const { engine, market } = seeded();
  const err = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof EngineError, `EngineError хүлээсэн, ирсэн: ${String(e)}`);
      assert.equal(e.code, code);
      return;
    }
    assert.fail(`${code} алдаа гарах ёстой байсан`);
  };
  err(() => engine.buy('u1', market.id, 0, 20_000), 'MAX_BET');
  engine.createUser({ id: 'poor', name: 'Ядуу', balance: 20 });
  err(() => engine.buy('poor', market.id, 0, 100), 'INSUFFICIENT');
  err(() => engine.buy('u1', market.id, 0, 5), 'MIN_BET');
  err(() => engine.buy('u1', market.id, 0, 10.5), 'NOT_INTEGER');
  err(() => engine.buy('u1', market.id, 2, 100), 'BAD_OUTCOME');
  err(() => engine.buy('u1', 'nope', 0, 100), 'MARKET_NOT_FOUND');
  err(() => engine.buy('nobody', market.id, 0, 100), 'USER_NOT_FOUND');
  err(() => engine.sell('u1', market.id, 0, 10), 'INSUFFICIENT');
  err(() => engine.sell('u1', market.id, 0, -1), 'BAD_AMOUNT');
  engine.buy('u1', market.id, 0, 100);
  err(() => engine.sell('u1', market.id, 0, 1e-6), 'TOO_SMALL');
  err(() => engine.createUser({ id: 'u1', name: 'Давхар' }), 'DUPLICATE');
  err(() => engine.createUser({ name: '   ' }), 'BAD_NAME');
  err(() => engine.addWrestler({ id: 'w1', name: 'Давхар', title: 'цолгүй' }), 'DUPLICATE');
  err(() => engine.addWrestler({ name: 'Х', title: 'хаан' as never }), 'BAD_TITLE');
  err(() => engine.createBout({ tournamentId: 't1', round: 1, aId: 'w1', bId: 'w1' }), 'SAME_WRESTLER');
  err(() => engine.createBout({ tournamentId: 't1', round: 10, aId: 'w1', bId: 'w2' }), 'BAD_ROUND');
  err(() => engine.createBout({ tournamentId: 'nope', round: 1, aId: 'w1', bId: 'w2' }), 'TOURNAMENT_NOT_FOUND');
  err(() => engine.createTournament({ name: 'x', date: '2026/07/11', rounds: 9 }), 'BAD_DATE');
  err(() => engine.createMarket({ title: 'x', outcomes: ['a'] }), 'BAD_OUTCOMES');
  err(() => engine.createMarket({ title: 'x', outcomes: ['a', 'a'] }), 'BAD_OUTCOMES');
  err(() => engine.createMarket({ title: 'x', outcomes: ['a', 'b'], prior: [1] }), 'BAD_PRIOR');
  err(() => engine.createMarket({ title: 'x', outcomes: ['a', 'b'], b: 0 }), 'BAD_B');
  err(() => engine.grantTokens('u1', -5, 'x'), 'BAD_AMOUNT');
  err(() => engine.recordBoutResult('b1', 'w3'), 'BAD_WINNER');
  err(() => engine.resolveMarket(market.id, 5), 'BAD_OUTCOME');

  engine.closeMarket(market.id);
  err(() => engine.buy('u1', market.id, 0, 100), 'MARKET_CLOSED');
  err(() => engine.sell('u1', market.id, 0, 10), 'MARKET_CLOSED');
  err(() => engine.closeMarket(market.id), 'MARKET_CLOSED');
  engine.resolveMarket(market.id, 0);
  err(() => engine.resolveMarket(market.id, 0), 'ALREADY_RESOLVED');
  err(() => engine.voidMarket(market.id, 'x'), 'ALREADY_RESOLVED');
  engine.recordBoutResult('b1', 'w1'); // зах зээл аль хэдийн шийдэгдсэн — алгасна
  err(() => engine.recordBoutResult('b1', 'w1'), 'ALREADY_RESOLVED');
  engine.checkInvariants();
});

test('closesAt: хугацаа дуусмагц автоматаар хаагдана', () => {
  const { engine, clock } = seeded();
  const closesAt = new Date(clock.t + 60_000).toISOString();
  const { market } = engine.createBout({ id: 'b2', tournamentId: 't1', round: 1, aId: 'w2', bId: 'w3', closesAt });
  engine.buy('u1', market!.id, 0, 100);
  clock.advance(59_999);
  engine.buy('u1', market!.id, 0, 100);
  clock.advance(1);
  assert.throws(() => engine.buy('u1', market!.id, 0, 100), (e: unknown) => e instanceof EngineError && e.code === 'MARKET_CLOSED');
  assert.equal(engine.market(market!.id).status, 'closed');
  // Хаагдсан ч үр дүн бүртгэж шийдэж болно
  const r = engine.recordBoutResult('b2', 'w2');
  assert.equal(r.resolvedMarkets.length, 1);
  assert.equal(engine.market(market!.id).status, 'resolved');
  engine.checkInvariants();
});

test('хүчингүй болгох: цэвэр зарцуулалт буцна, ашигтай зарсан хүн буцаалт авахгүй', () => {
  const { engine, market } = seeded();
  const t1 = engine.buy('u1', market.id, 0, 1_000); // u1 эрт авлаа
  engine.buy('u2', market.id, 0, 3_000); // u2 их авч үнийг өсгөв
  const sold = engine.sell('u1', market.id, 0, t1.shares); // u1 ашигтай зарлаа
  assert.ok(sold.delta > 1_000, 'ашигтай зарсан');
  const before1 = engine.balance('u1');
  const before2 = engine.balance('u2');
  const { refunds } = engine.voidMarket(market.id, 'бөх ирээгүй');
  assert.deepEqual(refunds, [{ userId: 'u2', amount: 3_000 }]);
  assert.equal(engine.balance('u1'), before1);
  assert.equal(engine.balance('u2'), before2 + 3_000);
  assert.equal(engine.market(market.id).status, 'voided');
  assert.equal(engine.market(market.id).voidReason, 'бөх ирээгүй');
  engine.checkInvariants();
  // Хүчингүй зах зээлийн эзэмшил үнэгүй
  const p2 = engine.positions('u2');
  assert.equal(p2[0]!.value, 0);
});

test('олон үр дүнтэй зах зээл: аварга хэн болох', () => {
  const { engine } = seeded();
  const m = engine.createMarket({
    id: 'champ',
    title: 'Наадам 2026 — аварга хэн болох',
    outcomes: ['Б.Орхонбаяр', 'Э.Батмагнай', 'О.Хангай', 'Бусад'],
    outcomeRefs: ['w1', 'w2', null, null],
    prior: [0.35, 0.25, 0.15, 0.25],
    b: 3_000,
    tournamentId: 't1',
  });
  const p0 = engine.probabilities('champ');
  assert.ok(Math.abs(p0[0]! - 0.35) < 1e-9);
  // Хаусын хязгаар = b·ln(1/p_min) — хамгийн бага магадлалтай үр дүн биелбэл
  assert.ok(Math.abs(engine.marketView('champ').maxHouseLoss - 3_000 * Math.log(1 / 0.15)) < 1e-6);
  engine.buy('u1', 'champ', 3, 2_000); // Бусад
  engine.buy('u2', 'champ', 0, 2_000);
  engine.buy('admin', 'champ', 3, 500);
  const p1 = engine.probabilities('champ');
  assert.ok(p1[3]! > 0.25 && p1[0]! > 0.35 && p1[1]! < 0.25);
  assert.ok(Math.abs(p1.reduce((a, c) => a + c, 0) - 1) < 1e-9);
  const { payouts } = engine.resolveMarket('champ', 3);
  assert.equal(payouts.length, 2);
  assert.deepEqual(
    payouts.map((p) => p.userId),
    ['admin', 'u1'],
  );
  for (const p of payouts) assert.equal(p.amount, Math.round(p.shares));
  const view = engine.marketView('champ');
  assert.equal(view.status, 'resolved');
  assert.equal(view.resolvedOutcome, 3);
  assert.equal(view.traders, 3);
  assert.equal(view.volume, 4_500);
  engine.checkInvariants();
  // Хаусын алдагдал ≤ b·ln(1/p0[давсан]) (+ тоймлолт)
  assert.ok(-m.houseCash <= 3_000 * Math.log(1 / 0.25) + 0.5 * m.positions.size + 1);
});

test('олон арилжааны дараа ч инвариант, хаусын алдагдал хязгаарт', () => {
  const { engine, market } = seeded();
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const users = ['admin', 'u1', 'u2'];
  for (let i = 0; i < 300; i++) {
    const u = users[Math.floor(rnd() * 3)]!;
    const side = rnd() < 0.5 ? 0 : 1;
    const held = engine.market(market.id).positions.get(u)?.[side] ?? 0;
    try {
      if (held > 1 && rnd() < 0.3) engine.sell(u, market.id, side, held * rnd());
      else engine.buy(u, market.id, side, 10 + Math.floor(rnd() * 400));
    } catch (e) {
      if (!(e instanceof EngineError) || !['INSUFFICIENT', 'TOO_SMALL'].includes(e.code)) throw e;
    }
    engine.checkInvariants();
  }
  const m = engine.market(market.id);
  assert.ok(m.tradeCount > 200);
  const winner = rnd() < 0.5 ? 0 : 1;
  const bound = engine.marketView(market.id).maxHouseLoss;
  const p0 = winProbability(2354, 2301);
  assert.ok(Math.abs(bound - 1_000 * Math.log(1 / Math.min(p0, 1 - p0))) < 1e-6);
  engine.resolveMarket(market.id, winner);
  engine.checkInvariants();
  const traders = m.positions.size;
  assert.ok(-m.houseCash <= bound + 0.5 * traders + 1, `хаусын алдагдал ${-m.houseCash} > ${bound}`);
});

test('bout зах зээл нээхгүй байх, prior гараар өгөх, prior-гүй бөх цолын сууриар', () => {
  const { engine } = seeded();
  const r = engine.createBout({ id: 'b3', tournamentId: 't1', round: 2, aId: 'w1', bId: 'w3', withMarket: false });
  assert.equal(r.market, undefined);
  assert.equal(engine.markets({ boutId: 'b3' }).length, 0);
  // w3 рейтинггүй → сумын заан суурь 1650
  const prior = engine.priorForBout('w1', 'w3');
  assert.equal(prior.sourceB, 'seed');
  assert.equal(prior.ratingB, 1650);
  assert.ok(prior.pA > 0.95);
  const r2 = engine.createBout({ id: 'b4', tournamentId: 't1', round: 2, aId: 'w2', bId: 'w3', prior: [0.6, 0.4] });
  assert.ok(Math.abs(engine.probabilities(r2.market!.id)[0]! - 0.6) < 1e-9);
  // Үр дүн бүртгэхэд зах зээл байхгүй барилдаан ч болно
  const res = engine.recordBoutResult('b3', 'w3', { updateRatings: false });
  assert.equal(res.resolvedMarkets.length, 0);
  assert.equal(engine.rating('w3').source, 'seed');
});

test('дүрэмт зах зээл: хэд давах / хэн холдох / аварга / яг хэд — тэмцээний явцаас автомат шийдэгдэнэ', () => {
  const { engine, log } = seeded();
  engine.addWrestler({ id: 'w4', name: 'Д.Дөрөв', title: 'аймгийн_заан' });
  engine.addWrestler({ id: 'w9', name: 'Е.Ирээгүй', title: 'аймгийн_начин' });
  engine.createTournament({ id: 't2', name: 'Аймгийн наадам', date: '2026-08-21', rounds: 2, entrants: ['w1', 'w2', 'w3', 'w4'] });
  engine.updateTournament('t2', { entrants: ['w1', 'w2', 'w3', 'w4', 'w9'] });
  assert.equal(engine.tournament('t2').entrants?.length, 5);

  const over = engine.createRuleMarket({ rule: { type: 'wins_over', tournamentId: 't2', wrestlerId: 'w1', line: 0.5 }, prior: [0.7, 0.3] });
  assert.equal(over.outcomes[0], '1+ даваа давна');
  assert.deepEqual(over.outcomeRefs, ['w1', null]);
  const mu = engine.createRuleMarket({ rule: { type: 'matchup', tournamentId: 't2', aId: 'w1', bId: 'w2' } });
  assert.deepEqual(mu.outcomes, ['Б.Орхонбаяр', 'Э.Батмагнай', 'Тэнцүү']);
  const champ = engine.createRuleMarket({ rule: { type: 'champion', tournamentId: 't2' }, listed: ['w1', 'w2'], prior: [0.5, 0.3, 0.2] });
  assert.deepEqual(champ.outcomes, ['Б.Орхонбаяр', 'Э.Батмагнай', 'Бусад']);
  const exact = engine.createRuleMarket({ rule: { type: 'wins_exact', tournamentId: 't2', wrestlerId: 'w3' } });
  assert.equal(exact.outcomes.length, 3);
  assert.equal(exact.outcomes[2], '2 даваа (аварга)');
  const ghost = engine.createRuleMarket({ rule: { type: 'wins_over', tournamentId: 't2', wrestlerId: 'w9', line: 0.5 } });
  assert.throws(() => engine.createRuleMarket({ rule: { type: 'wins_over', tournamentId: 't2', wrestlerId: 'w1', line: 2 } }), /Босго/);
  engine.buy('u1', over.id, 0, 100);
  engine.buy('u2', mu.id, 1, 100);
  engine.buy('u1', ghost.id, 0, 50);

  // 1-р даваа: w1 давав w2 → over шийдэгдэнэ (1 > 0.5), matchup: w2 унасан 0, w1 1 > 0 → w1
  const b1 = engine.createBout({ tournamentId: 't2', round: 1, aId: 'w1', bId: 'w2', withMarket: false }).bout;
  const r1 = engine.recordBoutResult(b1.id, 'w1');
  assert.ok(r1.resolvedMarkets.some((m) => m.id === over.id));
  assert.equal(engine.market(over.id).status, 'resolved');
  assert.equal(engine.market(over.id).resolvedOutcome, 0);
  assert.equal(engine.market(mu.id).status, 'resolved');
  assert.equal(engine.market(mu.id).resolvedOutcome, 0);
  assert.equal(engine.market(champ.id).status, 'open');
  assert.equal(engine.market(exact.id).status, 'open');
  const p = engine.tournamentProgress('t2');
  assert.equal(p.eliminated.get('w2'), 0);
  assert.equal(p.wins.get('w1'), 1);
  assert.equal(p.finished, false);

  const b2 = engine.createBout({ tournamentId: 't2', round: 1, aId: 'w3', bId: 'w4', withMarket: false }).bout;
  engine.recordBoutResult(b2.id, 'w3');
  // Финал: w3 давав w1 → аварга w3 (жагсаалтад байхгүй → Бусад), яг хэд w3 = 2, ирээгүй бөхийн зах зээл хүчингүй
  const fin = engine.createBout({ tournamentId: 't2', round: 2, aId: 'w1', bId: 'w3', withMarket: false }).bout;
  engine.recordBoutResult(fin.id, 'w3');
  assert.equal(engine.tournamentProgress('t2').championId, 'w3');
  assert.equal(engine.market(champ.id).status, 'resolved');
  assert.equal(engine.market(champ.id).resolvedOutcome, 2);
  assert.equal(engine.market(exact.id).status, 'resolved');
  assert.equal(engine.market(exact.id).resolvedOutcome, 2);
  assert.equal(engine.market(ghost.id).status, 'voided');
  assert.equal(engine.balance('u1') >= 10_000 - 100 - 50 + 50, true, 'ирээгүй бөхийн бооцоо буцсан');
  engine.checkInvariants();
  // Replay-д ч rule, entrants хадгалагдана
  const again = new Engine(log);
  assert.equal(again.market(over.id).rule?.type, 'wins_over');
  assert.equal(again.tournament('t2').entrants?.length, 5);
  assert.deepEqual(serializeState(again.state), serializeState(engine.state));
});

test('аварга: сүүлийн даваанд нэмэлт (3-р байрын/цолын) барилдаан байхад унасан бөх аварга болохгүй', () => {
  const { engine } = seeded();
  engine.addWrestler({ id: 'w4', name: 'Д.Дөрөвдэх', title: 'сумын_заан' });
  engine.createTournament({ id: 't3', name: 'Сумын наадам', date: '2026-08-13', rounds: 2 });
  const b = (round: number, aId: string, bId: string, winner: string) => {
    const bout = engine.createBout({ tournamentId: 't3', round, aId, bId, withMarket: false }).bout;
    engine.recordBoutResult(bout.id, winner);
  };
  b(1, 'w1', 'w2', 'w1');
  b(1, 'w3', 'w4', 'w3');
  b(2, 'w1', 'w3', 'w3'); // финал: w3 давав
  assert.equal(engine.tournamentProgress('t3').championId, 'w3');
  b(2, 'w1', 'w4', 'w1'); // нэмэлт барилдаан (devjee-д тохиолддог): w1 давсан ч финалд унасан
  const p = engine.tournamentProgress('t3');
  assert.equal(p.championId, 'w3', 'аварга = унаагүй, сүүлийн даваанд давсан бөх');
  assert.equal(p.finished, true);
  assert.equal(p.eliminated.get('w1'), 2, 'w1 хоёр давсан ч унасан');
});

test('даваа удирдах: startRound (оноолт, гоц) → finishRound (favorite/simulate) → roundStatus → аварга', () => {
  const { engine } = makeEngine();
  engine.createUser({ id: 'u1', name: 'Бат' });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `e${i}`;
    engine.addWrestler({ id, name: `Бөх${i}`, title: 'аймгийн_начин' });
    engine.setRating(id, 1900 - i * 50, 'devjee', '2026-07-13'); // e0 хамгийн хүчтэй
    ids.push(id);
  }
  engine.createTournament({ id: 'r8', name: 'Найман бөх', date: '2026-08-20', rounds: 3, entrants: ids });
  let st = engine.roundStatus('r8');
  assert.deepEqual([st.current, st.next, st.alive, st.entrants, st.finished], [0, 1, 8, 8, false]);
  assert.throws(() => engine.startRound('r8', 2), /Дараагийн даваа 1/);

  // 1-р даваа: оноолт — 1↔5, 2↔6, 3↔7, 4↔8
  const r1 = engine.startRound('r8', 1);
  assert.equal(r1.bouts.length, 4);
  assert.equal(r1.markets.length, 4);
  assert.deepEqual(r1.bouts.map((b) => [b.aId, b.bId]), [['e0', 'e4'], ['e1', 'e5'], ['e2', 'e6'], ['e3', 'e7']]);
  assert.equal(r1.byes.length, 0);
  st = engine.roundStatus('r8');
  assert.deepEqual([st.current, st.next, st.perRound[0]!.pending], [1, 0, 4]);
  assert.throws(() => engine.startRound('r8', 2), /дуусаагүй/);
  assert.throws(() => engine.startRound('r8', 1), /дуусаагүй/);

  // Бооцоо тавиад дуусгахад зах зээл шийдэгдэнэ
  engine.buy('u1', r1.markets[0]!.id, 0, 200);
  const f1 = engine.finishRound('r8', 1, { mode: 'favorite' });
  assert.equal(f1.recorded, 4);
  assert.equal(f1.resolvedMarkets, 4);
  assert.deepEqual(f1.results.map((r) => r.winnerId), ['e0', 'e1', 'e2', 'e3'], 'favorite: рейтинг өндөр нь давна');
  assert.ok(engine.balance('u1') > 10_000, 'e0 давсан → төлбөр');
  assert.throws(() => engine.finishRound('r8', 1), /хүлээгдэж буй барилдаан алга/);
  st = engine.roundStatus('r8');
  assert.deepEqual([st.current, st.next, st.alive], [1, 2, 4]);

  // 2-р даваа: зөвхөн давсан 4 бөх; simulate детерминист rng-тэй
  const r2 = engine.startRound('r8', 2, { pairing: 'rank' });
  assert.deepEqual(r2.bouts.map((b) => [b.aId, b.bId]), [['e0', 'e2'], ['e1', 'e3']]);
  let n = 0;
  const f2 = engine.finishRound('r8', 2, { rng: () => [0.99, 0.01][n++ % 2]! }); // e0 унана (0.99 > pA), e1 давна
  assert.deepEqual(f2.results.map((r) => r.winnerId), ['e2', 'e1']);
  const r3 = engine.startRound('r8', 3);
  assert.equal(r3.bouts.length, 1);
  engine.finishRound('r8', 3, { mode: 'favorite' });
  st = engine.roundStatus('r8');
  assert.equal(st.finished, true);
  assert.equal(st.championId, 'e1');
  assert.equal(st.next, 0);
  assert.throws(() => engine.startRound('r8', 4), /дууссан/);
  engine.checkInvariants();

  // Сондгой: 5 бөх → дээд зэрэглэлийнх гоц, 2 барилдаан; санамсаргүй хослол
  engine.createTournament({ id: 'r5', name: 'Таван бөх', date: '2026-08-21', rounds: 3, entrants: ids.slice(0, 5) });
  const q = engine.startRound('r5', 1, { pairing: 'random', rng: () => 0.5 });
  assert.deepEqual(q.byes, ['e0']);
  assert.equal(q.bouts.length, 2);
  engine.finishRound('r5', 1, { mode: 'favorite' });
  const q2 = engine.startRound('r5', 2);
  assert.equal(q2.bouts.length + q2.byes.length * 0, 1, 'гоц e0 + 2 давагч = 3 → 1 барилдаан + 1 гоц');
  assert.deepEqual(q2.byes, ['e0']);
});

test('купон: экспресс — санал, тааз, давхардал, шийдэлт (давалт/алдагдал/хүчингүй хөл), идемпотент', () => {
  const { engine, market } = seeded();
  // Хоёр дахь барилдаан (w3 vs w4), гурав дахь custom
  engine.addWrestler({ id: 'w4', name: 'Д.Дөрөв', title: 'аймгийн_заан' });
  const m2 = engine.createBout({ id: 'b2', tournamentId: 't1', round: 1, aId: 'w3', bId: 'w4', prior: [0.5, 0.5] }).market!;
  const m3 = engine.createMarket({ id: 'c3', title: 'Гуравдугаар', outcomes: ['Х', 'Ү'], prior: [0.25, 0.75] });
  const p1 = engine.probabilities(market.id)[1]!; // Батмагнай ~0.42

  const q = engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 1 }, { marketId: m2.id, outcome: 0 }, { marketId: m3.id, outcome: 0 }] });
  const expectedCoef = (1 / p1) * 2 * 4;
  assert.ok(Math.abs(q.coefficient - expectedCoef) < 1e-9);
  assert.equal(q.combos, 1);
  assert.equal(q.maxPayout, Math.floor(100 * expectedCoef));
  assert.equal(q.capped, false);
  // Тааз: 0.01 магадлалтай зах зээл → 100× дээр таардаг
  const tiny = engine.createMarket({ id: 'tiny', title: 'Жижиг', outcomes: ['А', 'Б'], prior: [0.001, 0.999] });
  const qc = engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: tiny.id, outcome: 0 }, { marketId: m3.id, outcome: 0 }] });
  assert.equal(qc.capped, true);
  assert.equal(qc.maxPayout, 100 * 100);
  // Давхардал: сонгосон үр дүн нэг бөхтэй холбоотой бол хориглоно (market: w1,w2 · matchup w1-w3)
  engine.createTournament({ id: 'tt', name: 'Т', date: '2026-08-22', rounds: 3, entrants: ['w1', 'w2', 'w3', 'w4'] });
  const mu = engine.createRuleMarket({ rule: { type: 'matchup', tournamentId: 'tt', aId: 'w1', bId: 'w3' } });
  assert.throws(() => engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 0 }, { marketId: mu.id, outcome: 0 }] }), /Хамааралтай/);
  // Өөр бөх сонговол зөвшөөрнө (w2 vs w3)
  assert.ok(engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 1 }, { marketId: mu.id, outcome: 1 }] }).coefficient > 1);
  // «Тэнцүү» (ref=null) сонголт нь тухайн зах зээлийн бүх бөхөөс хамаарна
  assert.throws(() => engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 0 }, { marketId: mu.id, outcome: 2 }] }), /Хамааралтай/);
  assert.throws(() => engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 0 }, { marketId: market.id, outcome: 1 }] }), /хоёр сонголт/);
  assert.throws(() => engine.quoteCoupon({ kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 0 }] }), /2 сонголт/);
  assert.throws(() => engine.quoteCoupon({ kind: 'express', stake: 6_000, legs: [{ marketId: market.id, outcome: 0 }, { marketId: m2.id, outcome: 0 }] }), /дээд/);
  assert.throws(() => engine.quoteBuy(market.id, 0, 6_000), /дээд/);

  // Тавих (идемпотент)
  const c = engine.placeCoupon('u1', { kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 1 }, { marketId: m2.id, outcome: 0 }, { marketId: m3.id, outcome: 0 }] }, 'cp-1');
  const cAgain = engine.placeCoupon('u1', { kind: 'express', stake: 100, legs: [{ marketId: market.id, outcome: 1 }, { marketId: m2.id, outcome: 0 }, { marketId: m3.id, outcome: 0 }] }, 'cp-1');
  assert.equal(c.id, cAgain.id);
  assert.equal(engine.balance('u1'), 9_900);
  assert.equal(engine.state.couponHouse, 100);
  assert.equal(engine.coupons('u1').length, 1);
  engine.checkInvariants();
  // Самбарт нээлттэй купон өртгөөрөө тооцогдоно
  assert.equal(engine.leaderboard().find((r) => r.userId === 'u1')!.total, 10_000);

  // Хөл 1: Батмагнай давав (won); хөл 2: хүчингүй (void → хасагдана); хөл 3: Х (won) → payout = 100 × (1/p1) × 4
  engine.recordBoutResult('b1', 'w2');
  assert.equal(engine.coupons('u1')[0]!.status, 'open');
  engine.voidMarket(m2.id, 'бөх ирээгүй');
  assert.equal(engine.coupons('u1')[0]!.status, 'open');
  engine.resolveMarket(m3.id, 0);
  const done = engine.coupons('u1')[0]!;
  assert.equal(done.status, 'won');
  assert.deepEqual(done.legs.map((l) => l.result), ['won', 'void', 'won']);
  assert.equal(done.payout, Math.floor(100 * (1 / p1) * 4));
  assert.equal(engine.balance('u1'), 9_900 + done.payout!);
  engine.checkInvariants();

  // Алдсан купон ба бүгд хүчингүй купон
  const m4 = engine.createMarket({ id: 'c4', title: 'Дөрөв', outcomes: ['А', 'Б'] });
  const m5 = engine.createMarket({ id: 'c5', title: 'Тав', outcomes: ['А', 'Б'] });
  const lost = engine.placeCoupon('u2', { kind: 'express', stake: 50, legs: [{ marketId: m4.id, outcome: 0 }, { marketId: m5.id, outcome: 0 }] });
  const voided = engine.placeCoupon('admin', { kind: 'express', stake: 70, legs: [{ marketId: m4.id, outcome: 1 }, { marketId: m5.id, outcome: 1 }] });
  engine.resolveMarket(m4.id, 1); // u2-ийн хөл алдав, admin-ийнх таарав
  engine.voidMarket(m5.id, 'x');
  assert.equal(engine.state.coupons.get(lost.id)!.status, 'lost');
  assert.equal(engine.state.coupons.get(lost.id)!.payout, 0);
  const v = engine.state.coupons.get(voided.id)!;
  assert.equal(v.status, 'won'); // 1 хөл таарсан, 1 хүчингүй → зөвхөн таарсан хөлийн коэффициентээр
  assert.equal(v.payout, Math.floor(70 * 2));
  engine.checkInvariants();
});

test('купон: систем 2/3, Lucky, Patent — дэд хослолуудын нийлбэр', () => {
  const { engine } = seeded();
  const a = engine.createMarket({ id: 'sa', title: 'A', outcomes: ['x', 'y'], prior: [0.5, 0.5] });
  const b = engine.createMarket({ id: 'sb', title: 'B', outcomes: ['x', 'y'], prior: [0.5, 0.5] });
  const c = engine.createMarket({ id: 'sc', title: 'C', outcomes: ['x', 'y'], prior: [0.5, 0.5] });
  const legs = [{ marketId: a.id, outcome: 0 }, { marketId: b.id, outcome: 0 }, { marketId: c.id, outcome: 0 }];
  // Систем 2/3: 3 хослол, тус бүр 100/3; коэффициент 4 → бүгд таарвал 3 × 33.33 × 4 = 400
  const q = engine.quoteCoupon({ kind: 'system', stake: 300, sizes: [2], legs });
  assert.equal(q.combos, 3);
  assert.equal(q.maxPayout, 3 * 100 * 4);
  // Lucky (1,2,3): 7 хослол; Patent (2,3): 4 хослол
  assert.equal(engine.quoteCoupon({ kind: 'system', stake: 700, sizes: [1, 2, 3], legs }).combos, 7);
  assert.equal(engine.quoteCoupon({ kind: 'system', stake: 400, sizes: [2, 3], legs }).combos, 4);
  assert.throws(() => engine.quoteCoupon({ kind: 'system', stake: 100, sizes: [3], legs }), /экспресс/);
  assert.throws(() => engine.quoteCoupon({ kind: 'system', stake: 100, sizes: [4], legs }), /хэмжээ/);

  const cp = engine.placeCoupon('u1', { kind: 'system', stake: 300, sizes: [2], legs });
  engine.resolveMarket(a.id, 0);
  engine.resolveMarket(b.id, 0);
  engine.resolveMarket(c.id, 1); // C алдав → зөвхөн (A,B) хослол таарна: 100 × 4 = 400
  const done = engine.state.coupons.get(cp.id)!;
  assert.equal(done.status, 'won');
  assert.equal(done.payout, 400);
  engine.checkInvariants();
});

test('тото: пул, 60/30/10 шатлал, хаагдах, бүгд буруу таавал буцаалт', () => {
  const { engine } = seeded();
  engine.addWrestler({ id: 'w4', name: 'Д.Дөрөв', title: 'аймгийн_заан' });
  engine.createUser({ id: 'u3', name: 'Дорж' });
  engine.createUser({ id: 'u4', name: 'Гэрэл' });
  const b1 = engine.createBout({ id: 'tb1', tournamentId: 't1', round: 1, aId: 'w1', bId: 'w2', withMarket: false }).bout;
  const b2 = engine.createBout({ id: 'tb2', tournamentId: 't1', round: 1, aId: 'w3', bId: 'w4', withMarket: false }).bout;
  const toto = engine.createToto({ id: 'toto1', title: 'Наадмын тото', tournamentId: 't1', boutIds: [b1.id, b2.id], fee: 100 });
  assert.equal(toto.pool, 0);
  assert.deepEqual(toto.tiers, [0.6, 0.3, 0.1]);
  assert.throws(() => engine.createToto({ title: 'x', tournamentId: 't1', boutIds: [b1.id] }), /2 барилдаан/);
  assert.throws(() => engine.createToto({ title: 'x', tournamentId: 't1', boutIds: [b1.id, b2.id], tiers: [0.5, 0.4] }), /нийлбэр 1/);

  engine.enterToto('u1', 'toto1', ['w1', 'w3'], 'r1'); // 2 зөв болно
  engine.enterToto('u1', 'toto1', ['w1', 'w3'], 'r1'); // идемпотент
  assert.throws(() => engine.enterToto('u1', 'toto1', ['w1', 'w3']), /аль хэдийн орсон/);
  engine.enterToto('u2', 'toto1', ['w1', 'w4']); // 1 зөв
  engine.enterToto('u3', 'toto1', ['w2', 'w3']); // 1 зөв
  engine.enterToto('u4', 'toto1', [null, 'w4']); // 0 зөв
  assert.throws(() => engine.enterToto('admin', 'toto1', ['w1']), /2 барилдаанд/);
  assert.throws(() => engine.enterToto('admin', 'toto1', ['w3', 'w1']), /буруу бөх/);
  assert.throws(() => engine.enterToto('admin', 'toto1', [null, null]), /дор хаяж нэг/i);
  assert.equal(engine.toto('toto1').pool, 400);
  assert.equal(engine.balance('u1'), 9_900);
  engine.checkInvariants();

  // Барилдаан эхэлмэгц шинээр орох боломжгүй
  engine.recordBoutResult(b1.id, 'w1');
  assert.throws(() => engine.enterToto('admin', 'toto1', ['w1', 'w3']), /хаагдсан/);
  assert.equal(engine.toto('toto1').status, 'open');
  // Хоёр дахь барилдаан дуусмагц автоматаар шийдэгдэнэ
  engine.recordBoutResult(b2.id, 'w3');
  const done = engine.toto('toto1');
  assert.equal(done.status, 'settled');
  // u1: 2 зөв (1-р шат 60% + үлдэгдэл), u2 ба u3: 1 зөв (2-р шат 30% хуваана), u4: 0
  assert.equal(done.entries.get('u1')!.correct, 2);
  assert.equal(done.entries.get('u2')!.correct, 1);
  assert.equal(done.entries.get('u4')!.correct, 0);
  assert.equal(done.entries.get('u1')!.payout, 240 + 40); // 60% + үлдсэн 10%
  assert.equal(done.entries.get('u2')!.payout, 60); // 30%/2
  assert.equal(done.entries.get('u3')!.payout, 60);
  assert.equal(done.entries.get('u4')!.payout, 0);
  assert.equal(engine.balance('u1'), 9_900 + 280);
  engine.checkInvariants();
  assert.equal(engine.state.totoHouse, 0);

  // Хэн ч таагаагүй тото → бүгдэд буцаалт
  const b3 = engine.createBout({ id: 'tb3', tournamentId: 't1', round: 2, aId: 'w1', bId: 'w3', withMarket: false }).bout;
  const b4 = engine.createBout({ id: 'tb4', tournamentId: 't1', round: 2, aId: 'w2', bId: 'w4', withMarket: false }).bout;
  engine.createToto({ id: 'toto2', title: 'Тото 2', tournamentId: 't1', boutIds: [b3.id, b4.id], fee: 50 });
  engine.enterToto('u1', 'toto2', ['w3', 'w4']);
  engine.enterToto('u2', 'toto2', ['w3', 'w4']);
  const before = engine.balance('u1');
  engine.recordBoutResult(b3.id, 'w1');
  engine.recordBoutResult(b4.id, 'w2');
  assert.equal(engine.toto('toto2').status, 'voided');
  assert.equal(engine.balance('u1'), before + 50);
  engine.checkInvariants();
});

test('бөх засах, devjee id-аар хайх, дэвтэр хязгаар', () => {
  const { engine } = seeded();
  engine.updateWrestler('w3', { title: 'аймгийн_начин', devjeeId: '-Kabc' });
  assert.equal(engine.wrestler('w3').title, 'аймгийн_начин');
  assert.equal(engine.wrestlerByDevjeeId('-Kabc')?.id, 'w3');
  assert.equal(engine.wrestlerByDevjeeId('none'), undefined);
  assert.equal(engine.rating('w3').rating, 1800);
  for (let i = 0; i < 5; i++) engine.grantTokens('u1', 10, 'тест');
  assert.equal(engine.ledger('u1', 3).length, 3);
  assert.equal(engine.ledger(undefined, 100).length, 3 + 5);
});
