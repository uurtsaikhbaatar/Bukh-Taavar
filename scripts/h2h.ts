/**
 * Хоёр бөхийн хоорондын харьцаа + 10 үеийн давамгайллын гинж + BT/Elo магадлал.
 *
 *   npm run h2h -- "Орхонбаяр" "Батмагнай"
 *   npm run h2h -- "Б.Орхонбаяр" "Э.Батмагнай" --hops 10 --beta 0.5 --halflife 4
 *   npm run h2h -- --wid -KiYk5VeDPhT2vMoLFSY --wid -Lpa5T3yxCoxj2ROQUkQ
 *
 * Архив хэрэгтэй: npm run archive (data/devjee/).
 */

import { AIMAGS } from '../src/devjee.ts';
import { fmtPct, table } from '../src/format.ts';
import { BoutGraph, boutCounts, eloReplay, findWrestlers, loadArchive, seedFromArchive, type Archive, type ChainPath } from '../src/graph.ts';
import { titleLabel } from '../src/rating.ts';

const argv = process.argv.slice(2);
const optNum = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const HOPS = optNum('hops', 10);
const BETA = optNum('beta', 0.8);
const HALFLIFE = optNum('halflife', 4);
/** Backtest-ээр тохируулсан сэлбэлт (chain-tune): цөөн барилдаанд 0/100% руу үсрэхгүй. */
const SMOOTH = optNum('smooth', 0.002);
const SHRINK = optNum('shrink', 0.6);
const wids: string[] = [];
const names: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--wid') wids.push(argv[++i] ?? '');
  else if (a.startsWith('--')) i += 1;
  else names.push(a);
}

const t0 = performance.now();
const archive: Archive = loadArchive();
const counts = boutCounts(archive.bouts);
const label = (id: string) => {
  const w = archive.wrestlers[id];
  if (!w) return id;
  return `${w.name} (${titleLabel(w.title)}${w.aimag ? `, ${w.aimag}` : ''})`;
};

function resolve(query: string): string {
  const m = findWrestlers(archive, query, counts, 6);
  if (m.length === 0) {
    console.error(`«${query}» нэртэй бөх олдсонгүй.`);
    process.exit(1);
  }
  if (m.length > 1 && m[0]!.score - m[1]!.score < 15) {
    console.log(`«${query}» — хэд хэдэн бөх таарлаа, эхнийхийг авлаа (нарийвчлахын тулд --wid):`);
    for (const x of m) console.log(`   ${x.wrestler.name} · ${titleLabel(x.wrestler.title)} · ${x.wrestler.aimag ?? ''} · ${x.bouts} барилдаан · wid=${x.id}`);
  }
  return m[0]!.id;
}

const ids = [...wids, ...names.map(resolve)];
if (ids.length !== 2) {
  console.error('Хоёр бөхийн нэр (эсвэл --wid) өгнө үү.');
  process.exit(1);
}
const [A, B] = ids as [string, string];
const graph = new BoutGraph(archive.bouts, { halfLifeYears: HALFLIFE });

console.log(`\nАрхив: ${archive.bouts.length} барилдаан, ${graph.size} бөх, ${archive.tournaments.size} тэмцээн · граф ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
console.log(`А = ${label(A)}   ·   Б = ${label(B)}`);
const rA = graph.record(A);
const rB = graph.record(B);
console.log(`Нийт: А ${rA.wins}–${rA.losses} (${rA.bouts}) · Б ${rB.wins}–${rB.losses} (${rB.bouts})`);

// 1. Шууд харьцаа
const h = graph.headToHead(A, B);
console.log(`\n══ 1. Хоорондын барилдаан: ${h.aWins}–${h.bWins} (${h.bouts.length}) ${'═'.repeat(30)}`);
if (h.bouts.length) {
  console.log(
    table(
      ['Огноо', 'Даваа', 'Давсан', 'Тэмцээн'],
      h.bouts.slice(0, 15).map((b) => {
        const t = archive.tournaments.get(b.tid);
        const winner = b.winner === 1 ? b.w1 : b.w2;
        return [b.date, String(b.round), archive.wrestlers[winner]?.name ?? winner, (t?.name ?? b.tid).slice(0, 60)];
      }),
    ),
  );
  if (h.bouts.length > 15) console.log(`… нийт ${h.bouts.length}`);
} else console.log('Хоорондоо барилдаж байгаагүй.');

// 2. Гинж
const c = graph.chain(A, B, { maxHops: HOPS, beta: BETA, topPaths: 4, smooth: SMOOTH, shrink: SHRINK });
console.log(`\n══ 2. Давамгайллын гинж (${HOPS} үе, β=${BETA}, сэлбэлт ${SMOOTH}/${SHRINK}, хагас задрал ${HALFLIFE} жил) ${'═'.repeat(8)}`);
if (!c.connected) console.log('Гинжээр холбогдоогүй (нийтлэг өрсөлдөгчгүй) → 50%.');
else {
  console.log(
    table(
      ['Үе', 'А→…→Б', 'Б→…→А'],
      c.perHop.map((x) => [String(x.k), x.ab.toExponential(2), x.ba.toExponential(2)]),
    ),
  );
  console.log(`Нийлбэр: А→Б ${c.scoreAB.toExponential(3)} · Б→А ${c.scoreBA.toExponential(3)} → **А давах магадлал ${fmtPct(c.pA, 1)}**`);
  const showPaths = (title: string, paths: ChainPath[]) => {
    if (!paths.length) return;
    console.log(title);
    for (const p of paths) {
      const parts = p.nodes.map((id, i) => (i < p.dates.length ? `${archive.wrestlers[id]?.name ?? id} ─(${p.dates[i]!.slice(0, 7)})→ ` : (archive.wrestlers[id]?.name ?? id)));
      console.log(`   ${parts.join('')}   [${p.nodes.length - 1} үе, ${p.prob.toExponential(2)}]`);
    }
  };
  showPaths('Хамгийн хүчтэй замууд А→Б:', c.topPathsAB);
  showPaths('Хамгийн хүчтэй замууд Б→А:', c.topPathsBA);
}

// 3. Bradley–Terry ба Elo replay
const t1 = performance.now();
const pBT = graph.btProbability(A, B);
const eloA = graph.btElo(A);
const eloB = graph.btElo(B);
console.log(`\n══ 3. Загварууд ${'═'.repeat(50)}`);
const rep = eloReplay(archive.bouts, { seed: seedFromArchive(archive.wrestlers) });
const ra = rep.ratings.get(A);
const rb = rep.ratings.get(B);
const pElo = ra !== undefined && rb !== undefined ? 1 / (1 + Math.pow(10, (rb - ra) / 400)) : undefined;
console.log(
  table(
    ['Загвар', 'А', 'Б', 'P(А давна)'],
    [
      ['Bradley–Terry (бүх граф, жинтэй)', eloA !== undefined ? String(Math.round(eloA)) : '—', eloB !== undefined ? String(Math.round(eloB)) : '—', pBT !== undefined ? fmtPct(pBT, 1) : '—'],
      ['Elo replay (K=32, цолын суурь)', ra !== undefined ? String(Math.round(ra)) : '—', rb !== undefined ? String(Math.round(rb)) : '—', pElo !== undefined ? fmtPct(pElo, 1) : '—'],
      [`Давамгайллын гинж (${HOPS} үе)`, '', '', c.connected ? fmtPct(c.pA, 1) : '50% (холбоогүй)'],
      ['Шууд харьцаа', String(h.aWins), String(h.bWins), h.bouts.length ? fmtPct((h.aWins + 1) / (h.bouts.length + 2), 1) + ' (Laplace)' : '—'],
    ],
  ),
);
console.log(`(тооцоо ${((performance.now() - t1) / 1000).toFixed(1)} сек)`);
const wa = archive.wrestlers[A];
const wb = archive.wrestlers[B];
if (wa && wb) console.log(`\nА: ${wa.fullName ?? wa.name} · ${titleLabel(wa.title)} · ${wa.aimag ?? AIMAGS[wa.aimagCode] ?? ''} · төрсөн ${wa.birthDate ?? '?'} · сүүлд ${wa.lastTournamentDate ?? '?'}`);
if (wa && wb) console.log(`Б: ${wb.fullName ?? wb.name} · ${titleLabel(wb.title)} · ${wb.aimag ?? AIMAGS[wb.aimagCode] ?? ''} · төрсөн ${wb.birthDate ?? '?'} · сүүлд ${wb.lastTournamentDate ?? '?'}`);
