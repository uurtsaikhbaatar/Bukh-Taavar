/**
 * devjee.mn-ийн Elo рейтингийн калибровкийн шалгалт (СҮЛЖЭЭ хэрэгтэй).
 *
 *   npm run calibrate -- [--picks 19]
 *
 * Топ-500 жагсаалтаас янз бүрийн байрын бөхчүүдийг сонгож, тус бүрийн сүүлийн
 * 50 барилдааны рейтингийн өөрчлөлтөөс тухайн үеийн загварын таамгийг сэргээнэ
 * (E = S − Δ/32) → таамагласан магадлал vs бодит давалтыг арваар нь харьцуулна.
 * log-loss (санамсаргүй = 0.693) ба Brier хэвлэнэ.
 */

import { DevjeeClient, DevjeeError, impliedExpectation } from '../src/devjee.ts';
import { fmtPct, table } from '../src/format.ts';

const picksArg = process.argv.indexOf('--picks');
const PICKS = picksArg >= 0 ? Number(process.argv[picksArg + 1]) || 19 : 19;

const client = new DevjeeClient();
try {
  const { date, ratings } = await client.latestRatings();
  const byRank = Object.entries(ratings).sort((a, b) => a[1].rank - b[1].rank);
  const step = Math.max(1, Math.floor(byRank.length / PICKS));
  const picks = Array.from({ length: PICKS }, (_, i) => byRank[Math.min(byRank.length - 1, i * step)]![0]);

  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, o: 0 }));
  let n = 0;
  let ll = 0;
  let brier = 0;
  for (const wid of picks) {
    for (const m of await client.wrestlerMatches(wid)) {
      const e = impliedExpectation(m);
      if (!(e > 0.001 && e < 0.999)) continue;
      const s = m.won ? 1 : 0;
      const b = Math.min(9, Math.floor(e * 10));
      bins[b]!.n += 1;
      bins[b]!.p += e;
      bins[b]!.o += s;
      n += 1;
      ll -= s ? Math.log(e) : Math.log(1 - e);
      brier += (e - s) ** 2;
    }
  }
  console.log(`devjee.mn Elo калибровк — snapshot ${date}, ${PICKS} бөх (1–${byRank.length}-р байр), ${n} барилдаан`);
  console.log(
    table(
      ['Таамаг', 'n', 'Дундаж таамаг', 'Бодит давалт'],
      bins.map((b, i) => [`${i * 10}–${i * 10 + 9}%`, String(b.n), b.n ? fmtPct(b.p / b.n, 1) : '—', b.n ? fmtPct(b.o / b.n, 1) : '—']),
    ),
  );
  console.log(`\nlog-loss ${(ll / n).toFixed(4)} (санамсаргүй 0.6931) · Brier ${(brier / n).toFixed(4)}`);
  console.log(`Сүлжээний хүсэлт: ${client.stats.network} · кэшээс: ${client.stats.cached}`);
} catch (e) {
  if (e instanceof DevjeeError) {
    console.error(`devjee.mn-д хандаж чадсангүй: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
