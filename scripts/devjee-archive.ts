/**
 * devjee.mn-ийн БҮХ түүхийг нэг удаа татаж локал архив үүсгэнэ (СҮЛЖЭЭ).
 *
 *   npm run archive            (≈2 300 хүсэлт, 300 мс завсартай ≈ 15–25 мин; тасарвал кэшнээс үргэлжилнэ)
 *   npm run archive -- --from 2000 --to 2026     (жилийн хүрээ)
 *
 * Тэмцээний жагсаалт: жилийн жагсаалт (devjee-ийн хайлт) + нүүр хуудас + production сервер +
 * `archive/extra-tournaments.json`. Жилийн хайлт зарим тэмцээнийг (тойргийн/багийн, мөн ердийн
 * зарим — 2026-10-11-нд production-ий 22 тэмцээний 9 нь) буцаадаггүй; тэд зөвхөн нүүр хуудсанд
 * (сүүлийн 10) гардаг. Production сервер нүүр хуудсыг 10 минут тутам шалгаж бүгдийг оруулдаг тул
 * түүний жагсаалтыг (`/api/public/devjee-tournaments`, `BUKH_URL`-ээр солино, `BUKH_URL=-` бол үгүй)
 * авч, харсан бүрээ `extra-tournaments.json`-д хуримтлуулна (git-д орно). Сүүлийн 3 долоо хоногийн
 * тэмцээний төлөвийг кэшээс биш шинээр татна (явцын дундуур архивласан тэмцээн дутуу үлдэхгүй).
 *
 * Гаралт (data/devjee/):
 *   tournaments.json  — тэмцээн бүр: мета + бүртгэгдсэн бөх (зэрэг дэв) + давааны тоо (+ roundInfo)
 *   bouts.jsonl       — барилдаан бүр нэг мөр: {tid,date,round,w1,w2,winner,kind,noShow,mid,fmt,other}
 *                       fmt: 'rr' тойргийн / 'team' багийн даваа; other: Монгол бөх биш (өвөрмонгол г.м)
 *   wrestlers.json    — бөх бүр: нэр, цол, аймаг, төрсөн он …
 *   summary.json      — тоо баримт
 *   archive.log       — явц
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AIMAGS, DevjeeClient, DevjeeError, roundInfoFromState, toWrestler, type DevjeeTournament, type DevjeeTournamentState } from '../src/devjee.ts';
import type { RoundInfo } from '../src/domain.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def: number): number => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const FROM = opt('from', 1900);
const TO = opt('to', new Date().getFullYear());
/** --refresh-wrestlers: бөхийн бичлэгийг (кэшээс) шинэ талбаруудаар дахин үүсгэнэ. */
const REFRESH_WRESTLERS = argv.includes('--refresh-wrestlers');
const OUT = path.join('data', 'devjee');
const YEAR = 365 * 24 * 3_600_000;
const HOUR = 3_600_000;
/** Жилийн жагсаалтад ордоггүй (тойргийн/багийн) тэмцээнүүд — харсан бүрээ хуримтлуулна. */
const EXTRA = path.join('archive', 'extra-tournaments.json');
/** Энэ хугацаанаас шинэ тэмцээний төлөвийг кэшээс биш шинээр татна (явцын дундуур архивласан байж болно). */
const FRESH_DAYS = 21;
/** Манай production сервер — түүнд орсон devjee тэмцээнүүдийн жагсаалтыг авна. */
const BUKH_URL = process.env.BUKH_URL ?? 'https://bukh-taavar.onrender.com';
mkdirSync(OUT, { recursive: true });

const logFile = path.join(OUT, 'archive.log');
const log = (m: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  appendFileSync(logFile, line + '\n', 'utf8');
};

const client = new DevjeeClient({ ttlMs: YEAR, minIntervalMs: 300 });

async function retry<T>(fn: () => Promise<T>, what: string, tries = 4): Promise<T | undefined> {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof DevjeeError ? err.status : undefined;
      if (status === 404) return undefined; // байхгүй баримт — алгасна
      const wait = 2_000 * i;
      log(`  ${what}: алдаа (${err instanceof Error ? err.message : String(err)}) — ${wait / 1000} сек дараа дахин (${i}/${tries})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return undefined;
}

export interface ArchiveTournament {
  id: string;
  name: string;
  date: string;
  rank?: number;
  types?: number[];
  place?: string;
  arena?: string | null;
  rounds: number;
  wrestlerCount: number;
  matchCount: number;
  /** wid → зэрэг дэв (order) */
  order: Record<string, number>;
  hasState: boolean;
  /** Шигшээ биш / нэртэй даваанууд (тойргийн, багийн). */
  roundInfo?: Record<string, RoundInfo>;
}

export interface ArchiveBout {
  tid: string;
  date: string;
  round: number;
  w1: string;
  w2: string;
  winner: 1 | 2;
  kind?: string;
  noShow?: boolean;
  mid: string;
  /** Шигшээ биш даваа: тойргийн ('rr') / багийн ('team') — `round` нь хүрээний даваа биш. */
  fmt?: 'rr' | 'team';
  /** Монгол үндэсний бөх биш (өвөрмонгол г.м) — рейтинг, загварт орохгүй. */
  other?: boolean;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  log(`Архив эхэллээ: ${FROM}–${TO}`);

  // 1) Тэмцээний жагсаалт
  const metas = new Map<string, DevjeeTournament>();
  for (let year = FROM; year <= TO; year++) {
    let page = 1;
    for (;;) {
      const res = await retry(() => client.tournaments({ year, page, limit: 100, ttlMs: year < TO ? YEAR : 6 * 3_600_000 }), `жагсаалт ${year}/${page}`);
      if (!res) break;
      for (const t of res.tournaments) metas.set(t.id, t);
      if (!res.hasMore || res.tournaments.length === 0) break;
      page += 1;
    }
    if (metas.size && year % 10 === 0) log(`  ${year} он хүртэл: ${metas.size} тэмцээн`);
  }
  // 1б) Жилийн жагсаалтад ороогүй тэмцээнүүд: өмнө хуримтлуулсан + одоо нүүр хуудсанд байгаа
  const extra = new Map<string, DevjeeTournament>();
  if (existsSync(EXTRA)) for (const t of JSON.parse(readFileSync(EXTRA, 'utf8')) as DevjeeTournament[]) extra.set(t.id, t);
  const home = await retry(() => client.home(), 'нүүр хуудас');
  const today = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
  for (const t of [...(home?.home ?? []), ...(home?.scheduled ?? [])]) {
    // Ирээдүйн (товлогдсон) тэмцээнд барилдаан байхгүй — болсных нь дараа орно
    if (!t?.id || !/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '') || t.date > today) continue;
    if (!metas.has(t.id)) extra.set(t.id, { id: t.id, name: t.name, date: t.date, ...(t.type ? { type: t.type } : {}), ...(t.rank !== undefined ? { rank: t.rank } : {}), ...(t.location ? { location: t.location } : {}), ...(t.arena !== undefined ? { arena: t.arena } : {}) } as DevjeeTournament);
  }
  // 1в) Production серверт орсон тэмцээнүүд (жилийн хайлт ч, одоогийн нүүр хуудас ч мэдэхгүйг нөхнө)
  if (BUKH_URL !== '-') {
    try {
      const res = await fetch(`${BUKH_URL}/api/public/devjee-tournaments`, { signal: AbortSignal.timeout(60_000) });
      const list = res.ok ? ((await res.json()) as { id: string; name: string; date: string }[]) : [];
      let fromProd = 0;
      for (const t of list) {
        if (!t?.id || metas.has(t.id) || extra.has(t.id) || !/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '') || t.date > today) continue;
        // Бүтэн мета (төрөл, байршил, зэрэглэл) devjee-ээс; олдохгүй бол серверийн нэр/огноогоор
        const full = await retry(() => client.tournament(t.id), `мета ${t.id}`);
        extra.set(t.id, full ? ({ id: t.id, name: full.name || t.name, date: full.date || t.date, ...(full.type ? { type: full.type } : {}), ...(full.rank !== undefined ? { rank: full.rank } : {}), ...(full.location ? { location: full.location } : {}), ...(full.arena !== undefined ? { arena: full.arena } : {}) } as DevjeeTournament) : ({ id: t.id, name: t.name, date: t.date } as DevjeeTournament));
        fromProd += 1;
      }
      log(`Production сервер: ${list.length} тэмцээн, шинээр ${fromProd}${res.ok ? '' : ` (HTTP ${res.status})`}`);
    } catch (err) {
      log(`Production серверийн жагсаалт уншигдсангүй (${err instanceof Error ? err.message : String(err)}) — алгаслаа`);
    }
  }
  let added = 0;
  for (const [id, t] of [...extra]) {
    if (metas.has(id)) {
      extra.delete(id); // жилийн жагсаалтад орсон бол давхар хадгалахгүй
      continue;
    }
    const y = Number(t.date.slice(0, 4));
    if (y < FROM || y > TO) continue;
    metas.set(id, t);
    added += 1;
  }
  mkdirSync(path.dirname(EXTRA), { recursive: true });
  writeFileSync(EXTRA, JSON.stringify([...extra.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), null, 1) + '\n', 'utf8');
  log(`Тэмцээн: ${metas.size} (жилийн жагсаалтаас гадуур ${added})`);

  // 2) Тэмцээн бүрийн төлөв (барилдаанууд)
  const tournaments: ArchiveTournament[] = [];
  const bouts: ArchiveBout[] = [];
  const wids = new Set<string>();
  const boutsPath = path.join(OUT, 'bouts.jsonl');
  writeFileSync(boutsPath, '', 'utf8');
  let i = 0;
  let noState = 0;
  for (const meta of [...metas.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    i += 1;
    const fresh = Date.now() - Date.parse(meta.date) < FRESH_DAYS * 24 * HOUR;
    const res = await retry(() => client.tournamentState(meta.id, fresh ? HOUR : YEAR), `төлөв ${meta.id}`);
    const state: DevjeeTournamentState | undefined = res?.state;
    const rec: ArchiveTournament = {
      id: meta.id,
      name: meta.name,
      date: meta.date,
      rounds: 0,
      wrestlerCount: 0,
      matchCount: 0,
      order: {},
      hasState: !!state,
    };
    if (meta.rank !== undefined) rec.rank = meta.rank;
    if (meta.type) rec.types = meta.type;
    if (meta.arena !== undefined) rec.arena = meta.arena;
    const place = meta.location ? AIMAGS[meta.location.aimag] : undefined;
    if (place) rec.place = place;
    if (state) {
      for (const [wid, w] of Object.entries(state.wrestlers ?? {})) {
        rec.order[wid] = w.order;
        wids.add(wid);
      }
      rec.wrestlerCount = Object.keys(rec.order).length;
      rec.rounds = Object.keys(state.rounds ?? {}).length;
      const roundInfo = roundInfoFromState({ rounds: state.rounds ?? {} });
      if (roundInfo) rec.roundInfo = roundInfo;
      const lines: string[] = [];
      for (const [mid, m] of Object.entries(state.matches ?? {})) {
        if (!m.w1 || !m.w2 || (m.winner !== 1 && m.winner !== 2)) continue;
        const b: ArchiveBout = { tid: meta.id, date: state.date || meta.date, round: m.round, w1: m.w1, w2: m.w2, winner: m.winner, mid };
        if (m.kind) b.kind = m.kind;
        if (m._noShow) b.noShow = true;
        const info = roundInfo?.[String(m.round)];
        if (info?.format === 'round-robin') b.fmt = 'rr';
        else if (info?.format === 'team') b.fmt = 'team';
        if (info?.otherStyle) b.other = true;
        bouts.push(b);
        wids.add(m.w1);
        wids.add(m.w2);
        lines.push(JSON.stringify(b));
      }
      rec.matchCount = lines.length;
      if (lines.length) appendFileSync(boutsPath, lines.join('\n') + '\n', 'utf8');
    } else noState += 1;
    tournaments.push(rec);
    if (i % 50 === 0) log(`  ${i}/${metas.size} тэмцээн · ${bouts.length} барилдаан · ${wids.size} бөх · төлөвгүй ${noState} · сүлжээ ${client.stats.network}, кэш ${client.stats.cached}`);
  }
  writeFileSync(path.join(OUT, 'tournaments.json'), JSON.stringify(tournaments), 'utf8');
  log(`Барилдаан: ${bouts.length}, төлөвгүй тэмцээн: ${noState}`);

  // 3) Бөхчүүд (100-аар багцалж)
  const wrestlersPath = path.join(OUT, 'wrestlers.json');
  const wrestlers: Record<string, ReturnType<typeof toWrestler> & { titleCode: number; aimagCode: number; isInactive?: boolean; lastTournamentDate?: string; sumCode?: string }> =
    existsSync(wrestlersPath) && !REFRESH_WRESTLERS ? (JSON.parse(readFileSync(wrestlersPath, 'utf8')) as typeof wrestlers) : {};
  const missing = [...wids].filter((w) => !wrestlers[w]);
  log(`Бөх: ${wids.size}, татах ${missing.length}`);
  for (let j = 0; j < missing.length; j += 100) {
    const chunk = missing.slice(j, j + 100);
    const details = await retry(() => client.fetchWrestlers(chunk, YEAR), `бөх ${j}`);
    for (const wid of chunk) {
      const dw = details?.[wid];
      if (!dw) {
        wrestlers[wid] = { name: wid, title: 'цолгүй', devjeeId: wid, titleCode: 0, aimagCode: 0 };
        continue;
      }
      const w = toWrestler(dw);
      const rec: (typeof wrestlers)[string] = { ...w, titleCode: Number(dw.title) || 0, aimagCode: Number(dw.aimag) || 0 };
      if (dw.isInactive) rec.isInactive = true;
      if (dw.lastTournamentDate) rec.lastTournamentDate = dw.lastTournamentDate;
      if (dw.sum !== undefined && dw.sum !== '') rec.sumCode = String(dw.sum);
      wrestlers[wid] = rec;
    }
    if ((j / 100) % 20 === 0) {
      writeFileSync(wrestlersPath, JSON.stringify(wrestlers), 'utf8');
      log(`  бөх ${Math.min(j + 100, missing.length)}/${missing.length}`);
    }
  }
  writeFileSync(wrestlersPath, JSON.stringify(wrestlers), 'utf8');

  // 4) Тойм
  const byYear: Record<string, { tournaments: number; bouts: number }> = {};
  for (const t of tournaments) {
    const y = t.date.slice(0, 4);
    byYear[y] = byYear[y] ?? { tournaments: 0, bouts: 0 };
    byYear[y].tournaments += 1;
    byYear[y].bouts += t.matchCount;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    range: [FROM, TO],
    tournaments: tournaments.length,
    tournamentsWithState: tournaments.length - noState,
    bouts: bouts.length,
    wrestlers: Object.keys(wrestlers).length,
    byYear,
    network: client.stats.network,
    cached: client.stats.cached,
    minutes: Math.round((Date.now() - t0) / 60_000),
  };
  writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8');
  log(`ДУУСЛАА: ${summary.tournaments} тэмцээн, ${summary.bouts} барилдаан, ${summary.wrestlers} бөх · ${summary.minutes} мин · сүлжээ ${summary.network}, кэш ${summary.cached}`);
}

main().catch((err) => {
  log(`АЛДАА: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
