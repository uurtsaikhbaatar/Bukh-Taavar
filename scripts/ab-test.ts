/**
 * Хуучин ба шинэ хувилбарын A/B туршилт: сүүлийн N тэмцээнийг тухайн хувилбарын ЖИНХЭНЭ Engine-ээр
 * «амьд» нөхцөлд дахин тоглуулна (look-ahead-гүй).
 *
 *   node scripts/ab-test.ts <кодын үндэс> <шошго> [N=50 | since:2020-01-01]   → data/ab/ab-<шошго>.json
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
const ARG = process.argv[4] ?? '50';
/** `since:YYYY-MM-DD` — тэр өдрөөс хойших бүх тэмцээн; тоо — сүүлийн N тэмцээн. */
const SINCE = ARG.startsWith('since:') ? ARG.slice(6) : undefined;
const N = SINCE ? Infinity : Number(ARG);
const DATA = path.join('data', 'devjee');
const OUT = path.join('data', 'ab');
mkdirSync(OUT, { recursive: true });

const mod = (p: string) => import(pathToFileURL(path.join(ROOT, p)).href);
const { Engine } = await mod('src/engine.ts');
const { MemoryLog } = await mod('src/store.ts');
const ratingMod = await mod('src/rating.ts');
const { TOURNAMENT_TYPES } = await mod('src/devjee.ts');
/** Тухайн хувилбарын таамгийн рейтингийн шинэчлэл (v4+: `updateFast`); хуучин хувилбарт тэгш K=64. */
const updFast: (fa: number, fb: number, aWon: boolean, ga: number, gb: number) => [number, number] =
  ratingMod.updateFast ??
  ((fa: number, fb: number, aWon: boolean) => {
    const d = 64 * ((aWon ? 1 : 0) - 1 / (1 + Math.pow(10, (fb - fa) / 400)));
    return [fa + d, fb - d];
  });

interface B { tid: string; date: string; round: number; w1: string; w2: string; winner: 1 | 2; kind?: string; noShow?: boolean; mid: string; fmt?: 'rr' | 'team'; other?: boolean }
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
  .filter((t) => !SINCE || t.date >= SINCE)
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
    upd(R, b.w1, b.w2, b.winner === 1, 32);
    const [n1, n2] = updFast(F.get(b.w1) ?? 1300, F.get(b.w2) ?? 1300, b.winner === 1, G.get(b.w1) ?? 0, G.get(b.w2) ?? 0);
    F.set(b.w1, n1); F.set(b.w2, n2);
    G.set(b.w1, (G.get(b.w1) ?? 0) + 1); G.set(b.w2, (G.get(b.w2) ?? 0) + 1);
    L.set(b.w1, b.date); L.set(b.w2, b.date);
  }
};

/** p = давсан бөхийн магадлал; p1 = w1-ийн магадлал; y = w1 давсан; g/r/a = барилдааны өмнөх туршлага, хурдан рейтинг, нас. */
const ageOf = (wid: string, date: string): number | null => {
  const bd = wrestlers[wid]?.birthDate;
  if (!bd || bd.startsWith('1900-01-01')) return null;
  const a = (Date.parse(date) - Date.parse(bd)) / (365.25 * 86_400_000);
  return a >= 14 && a <= 65 ? Math.round(a * 10) / 10 : null;
};
interface Row { tid: string; date: string; round: number; fmt: string; other: boolean; noShow: boolean; mid: string; p: number | null; newcomer: boolean; p1: number | null; y: 0 | 1; g1: number; g2: number; r1: number; r2: number; a1: number | null; a2: number | null; kind: string }
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
  // Production-ий импорттой адил: төрөл = devjee-ийн эхний төрлийн нэр (улсын наадам, аймгийн баяр наадам …)
  const kind = meta?.types?.[0] !== undefined ? TOURNAMENT_TYPES[meta.types[0]] : undefined;
  if (kind) tin.kind = kind;
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
      const s1 = engine.rating(b.w1), s2 = engine.rating(b.w2);
      const row: Row = { tid, date, round: r, fmt: b.fmt ?? 'ko', other: !!b.other, noShow: !!b.noShow, mid: b.mid, p: null, newcomer: fresh.has(b.w1) || fresh.has(b.w2), p1: null, y: b.winner === 1 ? 1 : 0, g1: s1.games ?? 0, g2: s2.games ?? 0, r1: Math.round(s1.fast ?? s1.rating), r2: Math.round(s2.fast ?? s2.rating), a1: ageOf(b.w1, date), a2: ageOf(b.w2, date), kind: b.kind ?? '' };
      if (mk && !b.noShow) {
        const pr = engine.probabilities(mk) as number[];
        row.p = pr[b.winner - 1]!;
        row.p1 = pr[0]!;
      }
      rows.push(row);
      engine.recordBoutResult(`b-${b.mid}`, b.winner === 1 ? b.w1 : b.w2, b.noShow ? { updateRatings: false } : {});
    }
  }
}
const meta = targets.map(({ tid, date }) => ({ tid, date, name: tournaments.get(tid)?.name ?? tid, formats: [...new Set(Object.values(tournaments.get(tid)?.roundInfo ?? {}).map((x) => x.format))], types: tournaments.get(tid)?.types ?? [], size: new Set(byTid.get(tid)!.flatMap((b) => [b.w1, b.w2])).size, rounds: Math.max(...byTid.get(tid)!.map((b) => b.round)) }));
writeFileSync(path.join(OUT, `ab-${LABEL}.json`), JSON.stringify({ label: LABEL, n: targets.length, tournaments: meta, rows }), 'utf8');
const priced = rows.filter((r) => r.p !== null);
const ll = priced.reduce((s, r) => s - Math.log(Math.max(1e-12, r.p!)), 0) / priced.length;
console.log(`${LABEL}: ${targets.length} тэмцээн (${targets[0]!.date} … ${targets.at(-1)!.date}), ${rows.length} барилдаан, таавартай ${priced.length}, зах зээл нээгдээгүй (ижил нэр) ${failed}, log-loss ${ll.toFixed(4)} · ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
