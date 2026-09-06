/**
 * Демо — цөмийн бүтэн явцыг терминалд монголоор үзүүлнэ (сүлжээгүй, детерминист).
 *
 *   npm run demo
 *
 * Үйл явдлын лог `data/demo-events.jsonl`-д бичигдэнэ (Notepad-аар нээж болно).
 * Бөхчүүдийн рейтинг = devjee.mn 2026-07-13-ны Elo (нийтийн мэдээлэл).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Engine } from '../src/engine.ts';
import { fmtPct, fmtTokens, table } from '../src/format.ts';
import { titleLabel } from '../src/rating.ts';
import { JsonlLog } from '../src/store.ts';

const LOG_PATH = join('data', 'demo-events.jsonl');
mkdirSync('data', { recursive: true });
if (existsSync(LOG_PATH)) rmSync(LOG_PATH);

let n = 0;
let t = Date.parse('2026-08-20T02:00:00.000Z'); // 10:00 УБ цагаар
const engine = new Engine(new JsonlLog(LOG_PATH), {
  now: () => new Date(t),
  idGen: () => `${String(++n).padStart(4, '0')}`,
  startingBalance: 10_000,
  defaultB: 2_000,
});
const tick = (minutes: number) => {
  t += minutes * 60_000;
};

const h = (title: string) => console.log(`\n══ ${title} ${'═'.repeat(Math.max(0, 60 - [...title].length))}`);
const probsLine = (marketId: string) => {
  const v = engine.marketView(marketId);
  return v.outcomes.map((o, i) => `${o} ${fmtPct(v.probs[i]!)}`).join(' · ');
};

h('1. Хэрэглэгчид (эхлэлийн 10 000 токен)');
engine.createUser({ id: 'batzengel', name: 'Батцэнгэл', role: 'admin' });
engine.createUser({ id: 'bat', name: 'Бат' });
engine.createUser({ id: 'bold', name: 'Болд' });
engine.createUser({ id: 'saraa', name: 'Сараа' });
console.log(table(['Нэр', 'Үүрэг', 'Токен'], engine.users().map((u) => [u.name, u.role, u.balance])));

h('2. Бөхчүүд (devjee.mn Elo, 2026-07-13)');
const wrestlers = [
  { id: 'orkhonbayar', name: 'Б.Орхонбаяр', title: 'даян_аварга', aimag: 'Сэлэнгэ', rating: 2354, devjeeId: '-KiYk5VeDPhT2vMoLFSY' },
  { id: 'batmagnai', name: 'Э.Батмагнай', title: 'улсын_арслан', aimag: 'Баянхонгор', rating: 2301, devjeeId: '-Lpa5T3yxCoxj2ROQUkQ' },
  { id: 'khangai', name: 'О.Хангай', title: 'улсын_аварга', aimag: 'Ховд', rating: 2259, devjeeId: '-KhXcfy8dtr9XJWho671' },
  { id: 'khuderbulga', name: 'Д.Хүдэрбулга', title: 'улсын_заан', aimag: 'Төв', rating: 2251 },
  { id: 'testbukh', name: 'Ц.Тестбөх', title: 'сумын_заан', aimag: 'Өвөрхангай' }, // рейтинггүй → цолын суурь
] as const;
for (const w of wrestlers) {
  const input: Parameters<Engine['addWrestler']>[0] = { id: w.id, name: w.name, title: w.title, aimag: w.aimag };
  if ('devjeeId' in w) input.devjeeId = w.devjeeId;
  engine.addWrestler(input);
  if ('rating' in w) engine.setRating(w.id, w.rating, 'devjee', '2026-07-13');
}
console.log(
  table(
    ['Бөх', 'Цол', 'Аймаг', 'Рейтинг', 'Эх'],
    engine.wrestlers().map((w) => {
      const r = engine.rating(w.id);
      return [w.name, titleLabel(w.title), w.aimag ?? '', Math.round(r.rating), r.source];
    }),
  ),
);

h('3. Тэмцээн ба барилдаан → зах зээл автоматаар нээгдэнэ');
engine.createTournament({ id: 'demo2026', name: 'Демо наадам', date: '2026-08-20', rounds: 9 });
const prior = engine.priorForBout('orkhonbayar', 'khuderbulga');
console.log(`Загварын магадлал (Elo ${Math.round(prior.ratingA)} vs ${Math.round(prior.ratingB)}): Орхонбаяр ${fmtPct(prior.pA)} — Хүдэрбулга ${fmtPct(prior.pB)}`);
const { market: m1 } = engine.createBout({
  id: 'bout1',
  tournamentId: 'demo2026',
  round: 5,
  aId: 'orkhonbayar',
  bId: 'khuderbulga',
  scheduledAt: new Date(t + 90 * 60_000).toISOString(), // 90 минутын дараа хаагдана
});
console.log(`Зах зээл: «${m1!.title}» · b=${m1!.b} · хаагдах: 90 минутын дараа`);
console.log(`Анхны магадлал: ${probsLine(m1!.id)}`);

h('4. Таавар тавих (авах) — үнэ хөдөлнө');
tick(5);
const q1 = engine.quoteBuy(m1!.id, 0, 500);
console.log(`Бат: 500 токен → Орхонбаяр. Санал: ${q1.shares.toFixed(1)} хувь, давбал ${fmtTokens(q1.payoutIfWin)} (×${q1.multiplier.toFixed(2)}), үнэ ${fmtPct(q1.priceBefore)} → ${fmtPct(q1.priceAfter)}`);
engine.buy('bat', m1!.id, 0, 500, 'bat-1');
console.log(`   → ${probsLine(m1!.id)}`);
tick(3);
const q2 = engine.quoteBuy(m1!.id, 1, 1_000);
console.log(`Болд: 1 000 токен → Хүдэрбулга. Санал: ${q2.shares.toFixed(1)} хувь, давбал ${fmtTokens(q2.payoutIfWin)} (×${q2.multiplier.toFixed(2)})`);
engine.buy('bold', m1!.id, 1, 1_000, 'bold-1');
console.log(`   → ${probsLine(m1!.id)}`);
tick(2);
engine.buy('bold', m1!.id, 1, 1_000, 'bold-1'); // давхар товшилт — ижил requestId → давхар төлбөргүй
console.log(`Болд дахин дарлаа (ижил requestId) → үлдэгдэл хэвээр ${fmtTokens(engine.balance('bold'))}, арилжаа ${engine.state.trades.size} ширхэг`);
tick(4);
const s1 = engine.buy('saraa', m1!.id, 1, 300, 'saraa-1');
console.log(`Сараа: 300 токен → Хүдэрбулга (${s1.shares.toFixed(1)} хувь)   → ${probsLine(m1!.id)}`);
tick(10);
const half = s1.shares / 2;
const sq = engine.quoteSell(m1!.id, 1, half);
engine.sell('saraa', m1!.id, 1, half, 'saraa-2');
console.log(`Сараа хагасыг нь зарлаа: ${half.toFixed(1)} хувь → ${fmtTokens(sq.proceeds)} токен   → ${probsLine(m1!.id)}`);
console.log(table(['Хэрэглэгч', 'Үлдэгдэл'], engine.users().map((u) => [u.name, u.balance])));

h('5. Олон үр дүнтэй зах зээл — «Аварга хэн болох»');
const champ = engine.createMarket({
  id: 'champ',
  title: 'Демо наадам — аварга хэн болох',
  outcomes: ['Б.Орхонбаяр', 'Э.Батмагнай', 'О.Хангай', 'Бусад'],
  outcomeRefs: ['orkhonbayar', 'batmagnai', 'khangai', null],
  prior: [0.4, 0.25, 0.15, 0.2],
  b: 3_000,
  tournamentId: 'demo2026',
});
console.log(`Анхны: ${probsLine(champ.id)}`);
engine.buy('bat', champ.id, 0, 1_500);
engine.buy('saraa', champ.id, 3, 800);
engine.buy('batzengel', champ.id, 1, 400);
console.log(`Тааврын дараа: ${probsLine(champ.id)}`);

h('6. Цаг дуусав → зах зээл хаагдана; үр дүн → төлбөр');
tick(90);
try {
  engine.buy('bat', m1!.id, 0, 100);
} catch (e) {
  console.log(`Бат хожимдож дарлаа → ${(e as Error).message}`);
}
console.log('Үр дүн: Хүдэрбулга Орхонбаярыг даваа (гэнэтийн)!');
const res = engine.recordBoutResult('bout1', 'khuderbulga');
console.log(`Шийдэгдсэн зах зээл: ${res.resolvedMarkets.length}. Төлбөр:`);
const m1v = engine.marketView(m1!.id);
console.log(
  table(
    ['Хэрэглэгч', 'Хувь', 'Төлбөр'],
    [...engine.market(m1!.id).positions.entries()]
      .filter(([, pos]) => (pos[m1v.resolvedOutcome!] ?? 0) > 1e-9)
      .map(([uid, pos]) => [engine.user(uid).name, pos[m1v.resolvedOutcome!]!.toFixed(1), Math.round(pos[m1v.resolvedOutcome!]!)]),
  ),
);
console.log(`Elo шинэчлэлт: Орхонбаяр ${Math.round(engine.rating('orkhonbayar').rating)}, Хүдэрбулга ${Math.round(engine.rating('khuderbulga').rating)} (K=32, эх: local)`);

h('7. Хүчингүй болгох — бөх ирээгүй');
const { market: m2 } = engine.createBout({ id: 'bout2', tournamentId: 'demo2026', round: 5, aId: 'batmagnai', bId: 'testbukh' });
console.log(`«${m2!.title}» анхны: ${probsLine(m2!.id)} (Тестбөх рейтинггүй → сумын заан суурь 1650)`);
engine.buy('bold', m2!.id, 0, 600);
engine.buy('bat', m2!.id, 1, 200);
const v = engine.voidMarket(m2!.id, 'Тестбөх ирсэнгүй');
console.log(`Буцаалт: ${v.refunds.map((r) => `${engine.user(r.userId).name} ${fmtTokens(r.amount)}`).join(', ')}`);

h('8. Самбар, дэвтэр, хаус');
console.log(
  table(
    ['#', 'Нэр', 'Үлдэгдэл', 'Нээлттэй эзэмшил', 'Нийт', 'Ашиг/алдагдал'],
    engine.leaderboard().map((r) => [String(r.rank), r.name, r.balance, Math.round(r.positionsValue), Math.round(r.total), Math.round(r.pnl)]),
  ),
);
console.log('\nБолдын дэвтэр (сүүлийнх нь дээрээ):');
console.log(table(['Төрөл', 'Өөрчлөлт', 'Үлдэгдэл', 'Тэмдэглэл'], engine.ledger('bold').map((l) => [l.kind, l.delta, l.balanceAfter, l.note ?? ''])));
const hs = engine.houseSummary();
console.log(`\nХаус: кэш ${fmtTokens(hs.cash)} · зах зээл ${hs.markets} (нээлттэй ${hs.open}, шийдэгдсэн ${hs.resolved}, хүчингүй ${hs.voided}) · нээлттэйн хамгийн их алдагдлын хязгаар ${fmtTokens(hs.maxLossBoundOpen)}`);
engine.checkInvariants();
console.log('Инвариант: Σ үлдэгдэл + хаусын кэш = Σ оруулсан ✔ · үлдэгдэл ≥ 0 ✔ · магадлалын нийлбэр 1 ✔');

h('9. Лог');
console.log(`${engine.state.eventCount} үйл явдал → ${LOG_PATH}`);
const replayed = new Engine(new JsonlLog(LOG_PATH));
console.log(`Логоос дахин уншихад: ${replayed.state.eventCount} үйл явдал, ${replayed.users().length} хэрэглэгч, Болдын үлдэгдэл ${fmtTokens(replayed.balance('bold'))} — ижил ✔`);
