/**
 * Хуучин ба шинэ хувилбарын A/B туршилт: сүүлийн N тэмцээнийг тухайн хувилбарын ЖИНХЭНЭ Engine-ээр
 * «амьд» нөхцөлд дахин тоглуулна (look-ahead-гүй).
 *
 *   node scripts/ab-test.ts <кодын үндэс> <шошго> [N=50]     → data/ab/ab-<шошго>.json
 *   node scripts/ab-compare.mjs                              → хүснэгтүүд (old ба new шошготой хоёр файлаас)
 *
 * Жишээ (production-д байгаа commit-ийг ажлын хувилбартай харьцуулах):
 *   git worktree add --detach ../bukh-old <commit>
 *   node scripts/ab-test.ts ../bukh-old old && node scripts/ab-test.ts . new && node scripts/ab-compare.mjs
 *   git worktree remove --force ../bukh-old
 *
 * Тэмцээн бүрд: бөхчүүдийн төлөв = тэмцээний өдрөөс ӨМНӨХ бүх архив барилдаанаас (K32 + хурдан K64,
 * туршлага, сүүлийн огноо; суурь 1300). Түүхгүй бөхөд рейтинг тавихгүй — хувилбар өөрөө суурийг сонгоно.
 * Даваа бүрийн хослолыг эхлээд бүгдийг нь нээж (зах зээл), дараа нь үр дүнг дарааллаар нь оруулна;
 * үр дүн орохын өмнөхөн зах зээлийн (арилжаагүй = загварын) магадлалыг авна.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2]!);
const LABEL = process.argv[3]!;
const N = Number(process.argv[4] ?? 50);
const DATA = path.join('data', 'devjee');
const OUT = path.join('data', 'ab');
mkdirSync(OUT, { recursive: true });

const mod = (p: string) => import(pathToFileURL(path.join(ROOT, p)).href);
const { Engine } = await mod('src/engine.ts');
const { MemoryLog } = await mod('src/store.ts');
const { BIG_TOURNAMENT_KIND } = await mod('src/rating.ts');

interface B { tid: string; date: string; round: number; w1: string; w2: string; winner: 1 | 2; noShow?: boolean; mid: string; fmt?: 'rr' | 'team'; other?: boolean }
interface T { id: string; name: string; date: string; types?: number[]; roundInfo?: Record<string, { format: string; name?: string; otherStyle?: boolean }> }
interface W { name: string; title: string; birthDate?: string }

const all: B[] = readFileSync(path.join(DATA, 'bouts.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as B);
const tournaments = new Map<string, T>((JSON.parse(readFileSync(path.join(DATA, 'tournaments.json'), 'utf8')) as T[]).map((t) => [t.id, t]));
const wrestlers = JSON.parse(readFileSync(path.join(DATA, 'wrestlers.json'), 'utf8')) as Record<string, W>;

const valid = all.filter((b) => (b.winner === 1 || b.winner === 2) && b.w1 && b.w2 && b.w1 !== b.w2);
const byTid = new Map<string, B[]>();
for (const b of valid) (byTid.get(b.tid) ?? byTid.set(b.tid, []).get(b.tid)!).push(b);
const targets = [...byTid.keys()]
  .map((tid) => ({ tid, date: byTid.get(tid)![0]!.date }))
  .sort((a, b) => b.date.localeCompare(a.date) || b.tid.localeCompare(a.tid))
  .slice(0, N)
  .sort((a, b) => a.date.localeCompare(b.date) || a.tid.localeCompare(b.tid));

// ── Архивын төлөв (он цагаар): Монгол бөхийн бодит барилдаан л (өөр төрөл, гоц орохгүй) ──
const clean = valid.filter((b) => !b.other && !b.noShow).sort((a, b) => a.date.localeCompare(b.date) || a.round - b.round);
const R = new Map<string, number>(), F = new Map<string, number>(), G = new Map<string, number>(), L = new Map<string, string>();
const upd = (m: Map<string, number>, a: string, b: string, aWon: boolean, k: number) => {
  const ra = m.get(a) ?? 1300, rb = m.get(b) ?? 1300;
  const d = k * ((aWon ? 1 : 0) - 1 / (1 + Math.pow(10, (rb - ra) / 400)));
  m.set(a, ra + d); m.set(b, rb - d);
};
let ptr = 0;
const advance = (date: string) => {
  for (; ptr < clean.length && clean[ptr]!.date < date; ptr++) {
    const b = clean[ptr]!;
    upd(R, b.w1, b.w2, b.winner === 1, 32); upd(F, b.w1, b.w2, b.winner === 1, 64);
    G.set(b.w1, (G.get(b.w1) ?? 0) + 1); G.set(b.w2, (G.get(b.w2) ?? 0) + 1);
    L.set(b.w1, b.date); L.set(b.w2, b.date);
  }
};

interface Row { tid: string; date: string; round: number; fmt: string; other: boolean; noShow: boolean; mid: string; p: number | null; newcomer: boolean }
const rows: Row[] = [];
let failed = 0;
const t0 = performance.now();
for (const { tid, date } of targets) {
  advance(date);
  const meta = tournaments.get(tid);
  const bouts = byTid.get(tid)!;
  let n = 0;
  const engine = new Engine(new MemoryLog(), { now: () => new Date(`${date}T04:00:00Z`), idGen: () => `e${++n}` });
  const ids = new Set<string>();
  for (const b of bouts) { ids.add(b.w1); ids.add(b.w2); }
  const fresh = new Set<string>();
  for (const wid of ids) {
    const w = wrestlers[wid];
    const input: Record<string, unknown> = { id: wid, name: w?.name || wid, title: w?.title ?? 'цолгүй' };
    if (w?.birthDate) input.birthDate = w.birthDate;
    engine.addWrestler(input);
    if ((G.get(wid) ?? 0) > 0) engine.setRating(wid, R.get(wid)!, 'devjee', L.get(wid)!, { games: G.get(wid)!, lastBoutAt: L.get(wid)!, fast: F.get(wid)! });
    else fresh.add(wid);
  }
  const maxRound = Math.max(...bouts.map((b) => b.round));
  const tin: Record<string, unknown> = { id: 't', name: (meta?.name || tid).trim().slice(0, 70) || tid, date, rounds: maxRound };
  if (meta?.types?.includes(1)) tin.kind = BIG_TOURNAMENT_KIND;
  if (meta?.roundInfo) tin.roundInfo = meta.roundInfo; // хуучин хувилбар үүнийг мэдэхгүй (үл тооно)
  engine.createTournament(tin);
  for (let r = 1; r <= maxRound; r++) {
    const list = bouts.filter((b) => b.round === r);
    // Давааны бүх хослол эхлээд зарлагдана (амьд нөхцөл)
    const market = new Map<string, string | undefined>();
    for (const b of list) {
      try {
        const c = engine.createBout({ id: `b-${b.mid}`, tournamentId: 't', round: r, aId: b.w1, bId: b.w2, withMarket: true });
        market.set(b.mid, c.market?.id);
      } catch (err) {
        // Хуучин хувилбар: ижил нэртэй хоёр бөхийн зах зээл нээгддэггүй (барилдаан нь үүссэн байдаг)
        if ((err as { code?: string }).code !== 'BAD_OUTCOMES') throw err;
        failed += 1;
      }
    }
    for (const b of list) {
      const mk = market.get(b.mid);
      const row: Row = { tid, date, round: r, fmt: b.fmt ?? 'ko', other: !!b.other, noShow: !!b.noShow, mid: b.mid, p: null, newcomer: fresh.has(b.w1) || fresh.has(b.w2) };
      if (mk && !b.noShow) row.p = engine.probabilities(mk)[b.winner - 1] as number;
      rows.push(row);
      engine.recordBoutResult(`b-${b.mid}`, b.winner === 1 ? b.w1 : b.w2, b.noShow ? { updateRatings: false } : {});
    }
  }
}
const meta = targets.map(({ tid, date }) => ({ tid, date, name: tournaments.get(tid)?.name ?? tid, formats: [...new Set(Object.values(tournaments.get(tid)?.roundInfo ?? {}).map((x) => x.format))] }));
writeFileSync(path.join(OUT, `ab-${LABEL}.json`), JSON.stringify({ label: LABEL, n: targets.length, tournaments: meta, rows }), 'utf8');
const priced = rows.filter((r) => r.p !== null);
const ll = priced.reduce((s, r) => s - Math.log(Math.max(1e-12, r.p!)), 0) / priced.length;
console.log(`${LABEL}: ${targets.length} тэмцээн (${targets[0]!.date} … ${targets.at(-1)!.date}), ${rows.length} барилдаан, таавартай ${priced.length}, зах зээл нээгдээгүй (ижил нэр) ${failed}, log-loss ${ll.toFixed(4)} · ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
