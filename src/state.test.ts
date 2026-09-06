import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BukhEvent } from './events.ts';
import { apply, emptyState, replay, serializeState, StateError } from './state.ts';

const at = '2026-08-16T10:00:00.000Z';

function baseEvents(): BukhEvent[] {
  return [
    { id: 'e1', at, type: 'user_created', userId: 'u1', name: 'Бат', role: 'member', balance: 10_000 },
    { id: 'e2', at, type: 'tokens_granted', userId: 'u1', amount: 500, reason: 'тест', balanceAfter: 10_500 },
    { id: 'e3', at, type: 'wrestler_added', wrestler: { id: 'w1', name: 'А.Бөх', title: 'улсын_начин' } },
    { id: 'e4', at, type: 'wrestler_added', wrestler: { id: 'w2', name: 'Б.Бөх', title: 'аймгийн_заан' } },
    { id: 'e5', at, type: 'tournament_created', tournament: { id: 't1', name: 'Тест наадам', date: '2026-07-11', rounds: 3 } },
    { id: 'e6', at, type: 'bout_created', bout: { id: 'b1', tournamentId: 't1', round: 1, aId: 'w1', bId: 'w2' } },
    {
      id: 'e7',
      at,
      type: 'market_created',
      market: { id: 'm1', kind: 'bout', title: 'А.Бөх — Б.Бөх', boutId: 'b1', outcomes: ['А.Бөх', 'Б.Бөх'], outcomeRefs: ['w1', 'w2'], b: 100, q0: [0, 0] },
    },
    {
      id: 'e8',
      at,
      type: 'trade',
      tradeId: 'tr1',
      marketId: 'm1',
      userId: 'u1',
      outcome: 0,
      shares: 150.5,
      delta: -100,
      qAfter: [150.5, 0],
      balanceAfter: 10_400,
      priceBefore: 0.5,
      priceAfter: 0.8,
      requestId: 'r1',
    },
  ];
}

test('reducer: үлдэгдэл, эзэмшил, дэвтэр, хаусын кэш зөв хөтлөгдөнө', () => {
  const s = replay(baseEvents());
  assert.equal(s.users.get('u1')!.balance, 10_400);
  assert.equal(s.users.get('u1')!.contributed, 10_500);
  const m = s.markets.get('m1')!;
  assert.deepEqual(m.q, [150.5, 0]);
  assert.deepEqual(m.positions.get('u1'), [150.5, 0]);
  assert.equal(m.netCost.get('u1'), 100);
  assert.equal(m.houseCash, 100);
  assert.equal(m.volume, 100);
  assert.equal(m.tradeCount, 1);
  assert.equal(s.ledger.length, 3);
  assert.deepEqual(
    s.ledger.map((l) => [l.kind, l.delta, l.balanceAfter]),
    [
      ['start', 10_000, 10_000],
      ['grant', 500, 10_500],
      ['buy', -100, 10_400],
    ],
  );
  assert.equal(s.requestIndex.get('u1:r1'), 'tr1');
  assert.equal(s.eventCount, 8);
});

test('reducer: шийдвэр ба хүчингүй болголт', () => {
  const s = replay(baseEvents());
  apply(s, {
    id: 'e9',
    at,
    type: 'market_resolved',
    marketId: 'm1',
    outcome: 0,
    payouts: [{ userId: 'u1', shares: 150.5, amount: 151, balanceAfter: 10_551 }],
  });
  const m = s.markets.get('m1')!;
  assert.equal(m.status, 'resolved');
  assert.equal(m.resolvedOutcome, 0);
  assert.equal(m.houseCash, 100 - 151);
  assert.equal(s.users.get('u1')!.balance, 10_551);
  assert.equal(s.ledger.at(-1)!.kind, 'payout');
  // Дахин шийдэх боломжгүй
  assert.throws(
    () => apply(s, { id: 'e10', at, type: 'market_resolved', marketId: 'm1', outcome: 1, payouts: [] }),
    StateError,
  );

  const s2 = replay(baseEvents());
  apply(s2, {
    id: 'e9',
    at,
    type: 'market_voided',
    marketId: 'm1',
    reason: 'бөх ирээгүй',
    refunds: [{ userId: 'u1', amount: 100, balanceAfter: 10_500 }],
  });
  assert.equal(s2.markets.get('m1')!.status, 'voided');
  assert.equal(s2.markets.get('m1')!.houseCash, 0);
  assert.equal(s2.users.get('u1')!.balance, 10_500);
});

test('reducer: зөрчилтэй лог → StateError', () => {
  const s = replay(baseEvents());
  // balanceAfter таарахгүй
  assert.throws(
    () => apply(s, { id: 'x', at, type: 'tokens_granted', userId: 'u1', amount: 10, reason: 'r', balanceAfter: 999 }),
    /үлдэгдэл/,
  );
  // байхгүй хэрэглэгч
  assert.throws(
    () => apply(s, { id: 'x', at, type: 'tokens_granted', userId: 'nope', amount: 10, reason: 'r', balanceAfter: 10 }),
    StateError,
  );
  // давхардсан хэрэглэгч
  assert.throws(
    () => apply(s, { id: 'x', at, type: 'user_created', userId: 'u1', name: 'Бат', role: 'member', balance: 1 }),
    StateError,
  );
  // хаагдсан зах зээлд арилжаа
  apply(s, { id: 'c', at, type: 'market_closed', marketId: 'm1' });
  assert.throws(
    () =>
      apply(s, {
        id: 'x',
        at,
        type: 'trade',
        tradeId: 'tr2',
        marketId: 'm1',
        userId: 'u1',
        outcome: 0,
        shares: 1,
        delta: -1,
        qAfter: [151.5, 0],
        balanceAfter: 10_399,
        priceBefore: 0.8,
        priceAfter: 0.81,
      }),
    StateError,
  );
  // сөрөг үлдэгдэл
  const s2 = replay(baseEvents());
  assert.throws(
    () =>
      apply(s2, {
        id: 'x',
        at,
        type: 'trade',
        tradeId: 'tr2',
        marketId: 'm1',
        userId: 'u1',
        outcome: 0,
        shares: 1,
        delta: -20_000,
        qAfter: [151.5, 0],
        balanceAfter: -9_600,
        priceBefore: 0.8,
        priceAfter: 0.81,
      }),
    StateError,
  );
});

test('replay детерминист: ижил лог → ижил төлөв', () => {
  const a = serializeState(replay(baseEvents()));
  const b = serializeState(replay(baseEvents()));
  assert.deepEqual(a, b);
  const s = emptyState();
  assert.equal(s.eventCount, 0);
  assert.deepEqual(serializeState(s), serializeState(emptyState()));
});
