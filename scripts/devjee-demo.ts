/**
 * devjee.mn-ийн бодит өгөгдлөөр магадлал харуулах демо (СҮЛЖЭЭ хэрэгтэй).
 *
 *   npm run devjee
 *
 * Юу хийх вэ:
 *  1. Хамгийн сүүлийн Elo snapshot → топ 10 бөх (нэр, цол, аймаг, рейтинг);
 *  2. Топ бөхчүүдийн хоорондын барилдааны магадлал (Elo);
 *  3. Нүүрэн дэх тэмцээнүүд + сүүлчийнхийн бүтэн төлөв (бөх/барилдаан/w1 давсан хувь);
 *  4. Нэг бөхийн сүүлийн 5 барилдаан + тухайн үеийн загварын магадлал.
 * Бүх хүсэлт кэштэй (data/cache/devjee), хоорондоо 400 мс завсартай.
 */

import { AIMAGS, DevjeeClient, DevjeeError, eloProbability, impliedExpectation, MATCH_KINDS, toWrestler } from '../src/devjee.ts';
import { fmtPct, table } from '../src/format.ts';
import { titleLabel } from '../src/rating.ts';

const client = new DevjeeClient();
const h = (title: string) => console.log(`\n══ ${title} ${'═'.repeat(Math.max(0, 64 - [...title].length))}`);

try {
  h('1. devjee.mn Elo — хамгийн сүүлийн snapshot');
  const { date, ratings } = await client.latestRatings();
  const top = Object.entries(ratings)
    .sort((a, b) => a[1].rank - b[1].rank)
    .slice(0, 10);
  const info = await client.fetchWrestlers(top.map(([wid]) => wid));
  const rows = top.map(([wid, r]) => {
    const dw = info[wid];
    const w = dw ? toWrestler(dw) : undefined;
    return [String(r.rank), w?.name ?? wid, w ? titleLabel(w.title) : '?', w?.aimag ?? '', String(r.rating)];
  });
  console.log(`Огноо: ${date} · нийт ${Object.keys(ratings).length} бөх жагсаалтад`);
  console.log(table(['#', 'Бөх', 'Цол', 'Аймаг', 'Elo'], rows));

  h('2. Хоорондын барилдааны магадлал (Elo, K=32 систем)');
  const [first, ...rest] = top;
  const fw = toWrestler(info[first![0]]!);
  console.log(
    table(
      ['Барилдаан', 'Магадлал А', 'Магадлал Б'],
      rest.slice(0, 5).map(([wid, r]) => {
        const w = toWrestler(info[wid]!);
        const p = eloProbability(first![1].rating, r.rating);
        return [`${fw.name} (${first![1].rating}) — ${w.name} (${r.rating})`, fmtPct(p), fmtPct(1 - p)];
      }),
    ),
  );

  h('3. Тэмцээнүүд (нүүр хуудас) ба сүүлчийнхийн төлөв');
  const home = await client.home();
  console.log(`Товлогдсон: ${home.scheduled.length} · сүүлийн: ${home.home.length}`);
  for (const t of home.home.slice(0, 5)) {
    const place = t.location ? `${AIMAGS[t.location.aimag] ?? t.location.aimag}` : '';
    console.log(`  ${t.date}  ${t.name.slice(0, 70)}${t.name.length > 70 ? '…' : ''}  [${place}] id=${t.id}`);
  }
  const latest = home.home[0];
  if (latest) {
    const { state, timestamp } = await client.tournamentState(latest.id);
    const matches = Object.values(state.matches);
    const w1Wins = matches.filter((m) => m.winner === 1).length;
    const kinds = new Map<string, number>();
    for (const m of matches) kinds.set(m.kind ?? '?', (kinds.get(m.kind ?? '?') ?? 0) + 1);
    console.log(`\n«${state.name}» (${state.date}) — төлөв ${timestamp ?? ''}`);
    console.log(
      `Бүртгэгдсэн бөх: ${Object.keys(state.wrestlers).length} · даваа: ${Object.keys(state.rounds).length} · барилдаан: ${matches.length} · w1 (дээд зэрэглэл) давсан: ${matches.length ? fmtPct(w1Wins / matches.length) : '—'}`,
    );
    console.log(`Хэлбэр: ${[...kinds].map(([k, n]) => `${MATCH_KINDS[k] ?? 'тодорхойгүй'} ${n}`).join(', ')}`);
    // Эхний давааны 3 барилдаан нэрээр
    const r1 = matches.filter((m) => m.round === 1).slice(0, 3);
    const ids = [...new Set(r1.flatMap((m) => [m.w1, m.w2]))];
    const ws = await client.fetchWrestlers(ids);
    for (const m of r1) {
      const a = ws[m.w1] ? toWrestler(ws[m.w1]!) : undefined;
      const b = ws[m.w2] ? toWrestler(ws[m.w2]!) : undefined;
      const ra = ratings[m.w1]?.rating;
      const rb = ratings[m.w2]?.rating;
      const p = ra !== undefined && rb !== undefined ? ` · Elo магадлал ${fmtPct(eloProbability(ra, rb))}` : '';
      console.log(`  1-р даваа: ${a?.name ?? m.w1} — ${b?.name ?? m.w2} → ${m.winner === 1 ? 'зүүн' : m.winner === 2 ? 'баруун' : '?'} давсан${p}`);
    }
  }

  h(`4. ${fw.name} — сүүлийн 5 барилдаан`);
  const ms = (await client.wrestlerMatches(first![0])).slice(0, 5);
  const opp = await client.fetchWrestlers(ms.map((m) => m.opponent));
  console.log(
    table(
      ['Огноо', 'Өрсөлдөгч', 'Үр дүн', 'Elo өмнө', 'Elo дараа', 'Загварын магадлал'],
      ms.map((m) => [
        m.date,
        opp[m.opponent] ? toWrestler(opp[m.opponent]!).name : m.opponent,
        m.won ? 'давсан' : 'унасан',
        String(Math.round(m.ratingBefore)),
        String(Math.round(m.ratingAfter)),
        fmtPct(impliedExpectation(m)),
      ]),
    ),
  );

  console.log(`\nСүлжээний хүсэлт: ${client.stats.network} · кэшээс: ${client.stats.cached}`);
} catch (e) {
  if (e instanceof DevjeeError) {
    console.error(`devjee.mn-д хандаж чадсангүй: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
