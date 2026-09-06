/**
 * devjee.mn-ийн БҮХ түүхийг нэг удаа татаж локал архив үүсгэнэ (СҮЛЖЭЭ).
 *
 *   npm run archive            (≈2 300 хүсэлт, 300 мс завсартай ≈ 15–25 мин; тасарвал кэшнээс үргэлжилнэ)
 *   npm run archive -- --from 2000 --to 2026     (жилийн хүрээ)
 *
 * Гаралт (data/devjee/):
 *   tournaments.json  — тэмцээн бүр: мета + бүртгэгдсэн бөх (зэрэг дэв) + давааны тоо
 *   bouts.jsonl       — барилдаан бүр нэг мөр: {tid,date,round,w1,w2,winner,kind,noShow,mid}
 *   wrestlers.json    — бөх бүр: нэр, цол, аймаг, төрсөн он …
 *   summary.json      — тоо баримт
 *   archive.log       — явц
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AIMAGS, DevjeeClient, DevjeeError, toWrestler, type DevjeeTournament, type DevjeeTournamentState } from '../src/devjee.ts';

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
  log(`Тэмцээн: ${metas.size}`);

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
    const res = await retry(() => client.tournamentState(meta.id, YEAR), `төлөв ${meta.id}`);
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
      const lines: string[] = [];
      for (const [mid, m] of Object.entries(state.matches ?? {})) {
        if (!m.w1 || !m.w2 || (m.winner !== 1 && m.winner !== 2)) continue;
        const b: ArchiveBout = { tid: meta.id, date: state.date || meta.date, round: m.round, w1: m.w1, w2: m.w2, winner: m.winner, mid };
        if (m.kind) b.kind = m.kind;
        if (m._noShow) b.noShow = true;
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
