/**
 * Архив дээрх шинжилгээ (сервер): хоорондын харьцаа, гинж, BT — API-д.
 * data/devjee архив байвал эхлэхэд ачаална; байхгүй бол идэвхгүй.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { H2hDto } from '../app/src/shared/api.ts';
import type { Engine } from '../src/engine.ts';
import { BoutGraph, eloReplay, loadArchive, type Archive } from '../src/graph.ts';
import { predictProbability, titleLabel } from '../src/rating.ts';

/**
 * Архивын Elo replay-ийн суурь: 1300 → devjee.mn-ийн рейтингтэй ±10 дотор таардаг
 * (Орхонбаяр 2359 vs 2354, Батмагнай 2310 vs 2301 …) — нэг масштаб.
 */
export const ARCHIVE_ELO_SEED = 1300;

export interface ArchiveImportResult {
  added: number;
  updated: number;
  rated: number;
  skipped: number;
}

export class Analytics {
  readonly archive: Archive;
  readonly graph: BoutGraph;
  readonly elo: Map<string, number>;
  /** Архив дахь бодит барилдааны тоо (таамгийн калибровкид). */
  readonly games: Map<string, number>;
  /** Архив дахь сүүлийн барилдааны огноо. */
  readonly lastBout: Map<string, string>;
  readonly latestDate: string;
  readonly loadedAt = new Date().toISOString();

  private constructor(archive: Archive, graph: BoutGraph, replay: ReturnType<typeof eloReplay>, latestDate: string) {
    this.archive = archive;
    this.graph = graph;
    this.elo = replay.ratings;
    this.games = replay.games;
    this.lastBout = replay.lastDate;
    this.latestDate = latestDate;
  }

  static tryLoad(dir = path.join('data', 'devjee'), log: (m: string) => void = console.log): Analytics | undefined {
    if (!existsSync(path.join(dir, 'bouts.jsonl'))) return undefined;
    const t0 = performance.now();
    const archive = loadArchive(dir);
    const graph = new BoutGraph(archive.bouts, { halfLifeYears: 4 });
    graph.bradleyTerry();
    const replay = eloReplay(archive.bouts, { seed: () => ARCHIVE_ELO_SEED });
    let latest = '';
    for (const b of archive.bouts) if (b.date > latest) latest = b.date;
    log(`[analytics] архив: ${archive.bouts.length} барилдаан, ${graph.size} бөх, ${archive.tournaments.size} тэмцээн · BT+Elo ${((performance.now() - t0) / 1000).toFixed(1)} сек`);
    return new Analytics(archive, graph, replay, latest || new Date().toISOString().slice(0, 10));
  }

  /**
   * Архивын БҮХ бөхийг Engine-д оруулна (id = devjee wid): байхгүйг нэмж, байгаагийн
   * дутуу талбарыг (өндөр/жин/дэвжээ/харьяалал/цолын түүх/овог/сум) нөхнө; рейтингийг
   * архивын Elo replay-ээр (devjee масштаб) тавина. Идемпотент — дахин ажиллуулахад юу ч өөрчлөхгүй.
   */
  importAllWrestlers(engine: Engine, options: { limit?: number } = {}): ArchiveImportResult {
    const res: ArchiveImportResult = { added: 0, updated: 0, rated: 0, skipped: 0 };
    let n = 0;
    for (const [wid, w] of Object.entries(this.archive.wrestlers)) {
      if (options.limit !== undefined && n >= options.limit) break;
      n += 1;
      const existing = engine.state.wrestlers.get(wid) ?? engine.wrestlerByDevjeeId(wid);
      const fields = {
        name: w.name,
        title: w.title,
        devjeeId: wid,
        ...(w.fullName ? { fullName: w.fullName } : {}),
        ...(w.aimag ? { aimag: w.aimag } : {}),
        ...(w.sum ? { sum: w.sum } : {}),
        ...(w.birthDate ? { birthDate: w.birthDate } : {}),
        ...(w.height ? { height: w.height } : {}),
        ...(w.weight ? { weight: w.weight } : {}),
        ...(w.club ? { club: w.club } : {}),
        ...(w.affiliations?.length ? { affiliations: w.affiliations } : {}),
        ...(w.titles?.length ? { titles: w.titles } : {}),
      };
      let id: string;
      if (!existing) {
        engine.addWrestler({ id: wid, ...fields });
        id = wid;
        res.added += 1;
      } else {
        id = existing.id;
        const patch: Partial<typeof fields> = {};
        const cur = existing as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(fields) as [keyof typeof fields, unknown][]) {
          if (k === 'name' || k === 'title' || k === 'devjeeId') continue;
          if (cur[k] === undefined && v !== undefined) (patch as Record<string, unknown>)[k] = v;
        }
        if (existing.title !== w.title && w.titleCode > 0) patch.title = w.title;
        if (Object.keys(patch).length) {
          engine.updateWrestler(id, patch);
          res.updated += 1;
        } else res.skipped += 1;
      }
      const r = this.elo.get(wid);
      if (r !== undefined) {
        const cur = engine.state.ratings.get(id);
        const meta: { games?: number; lastBoutAt?: string } = {};
        const g = this.games.get(wid);
        const lb = this.lastBout.get(wid);
        if (g !== undefined) meta.games = g;
        if (lb !== undefined) meta.lastBoutAt = lb;
        // devjee-ээс шууд авсан, архиваас шинэ рейтингийг дарахгүй; бусдыг архиваар тавина
        const keep = cur && cur.source === 'devjee' && cur.asOf >= this.latestDate;
        if (!keep && (!cur || Math.abs(cur.rating - r) > 0.5)) {
          engine.setRating(id, r, 'devjee', this.latestDate, meta);
          res.rated += 1;
        } else if (cur && cur.games === undefined && meta.games !== undefined) {
          // Рейтинг хэвээр — зөвхөн туршлага/огноог нөхнө (таамгийн калибровкид)
          engine.setRating(id, cur.rating, cur.source, cur.asOf, meta);
          res.updated += 1;
        }
      }
    }
    return res;
  }

  private name(id: string): string {
    return this.archive.wrestlers[id]?.name ?? id;
  }

  /** wid → архивын барилдаануудын индексүүд (нэг удаа байгуулагдана). */
  private boutIndex: Map<string, number[]> | undefined;

  private ensureBoutIndex(): Map<string, number[]> {
    if (this.boutIndex) return this.boutIndex;
    const idx = new Map<string, number[]>();
    this.archive.bouts.forEach((b, i) => {
      if (b.winner !== 1 && b.winner !== 2) return;
      (idx.get(b.w1) ?? idx.set(b.w1, []).get(b.w1)!).push(i);
      (idx.get(b.w2) ?? idx.set(b.w2, []).get(b.w2)!).push(i);
    });
    this.boutIndex = idx;
    return idx;
  }

  /** Бөхийн архивын нийт давалт–алдагдал. */
  record(wid: string): { wins: number; losses: number } {
    const r = this.graph.record(wid);
    return { wins: r.wins, losses: r.losses };
  }

  /** Бөхийн бүх барилдааны түүх — шинэ нь эхэндээ, хуудаслалттай. */
  wrestlerBouts(wid: string, offset = 0, limit = 50): { total: number; offset: number; rows: { date: string; tournamentName: string; round: number; opponentId: string; opponentName: string; opponentTitle: import('../src/rating.ts').Title; won: boolean; noShow?: boolean }[] } {
    const indices = this.ensureBoutIndex().get(wid) ?? [];
    const sorted = [...indices].sort((x, y) => {
      const a = this.archive.bouts[x]!;
      const b = this.archive.bouts[y]!;
      return b.date.localeCompare(a.date) || b.round - a.round;
    });
    const rows = sorted.slice(offset, offset + limit).map((i) => {
      const b = this.archive.bouts[i]!;
      const meFirst = b.w1 === wid;
      const oppId = meFirst ? b.w2 : b.w1;
      const opp = this.archive.wrestlers[oppId];
      const row: ReturnType<Analytics['wrestlerBouts']>['rows'][number] = {
        date: b.date,
        tournamentName: this.archive.tournaments.get(b.tid)?.name ?? '',
        round: b.round,
        opponentId: oppId,
        opponentName: opp?.name ?? oppId,
        opponentTitle: opp?.title ?? 'цолгүй',
        won: meFirst ? b.winner === 1 : b.winner === 2,
      };
      if (b.noShow) row.noShow = true;
      return row;
    });
    return { total: sorted.length, offset, rows };
  }

  /**
   * a, b — devjee wid. Гинжийн параметр: backtest-ээр тохируулсан (β=0.8, smooth=0.002,
   * shrink=0.6 → log-loss ≈0.68); гинж нь тайлбарт сайн, таамагт Elo/BT илүү.
   */
  h2h(a: string, b: string, maxHops = 10, beta = 0.8): H2hDto {
    const direct = this.graph.headToHead(a, b);
    const chain = this.graph.chain(a, b, { maxHops, beta, topPaths: 3, smooth: 0.002, shrink: 0.6 });
    const pBt = this.graph.btProbability(a, b);
    const ra = this.elo.get(a);
    const rb = this.elo.get(b);
    const wa = this.archive.wrestlers[a];
    const wb = this.archive.wrestlers[b];
    const recA = this.graph.record(a);
    const recB = this.graph.record(b);
    const dto: H2hDto = {
      a: { id: a, name: this.name(a), title: wa ? titleLabel(wa.title) : '', wins: recA.wins, losses: recA.losses },
      b: { id: b, name: this.name(b), title: wb ? titleLabel(wb.title) : '', wins: recB.wins, losses: recB.losses },
      direct: {
        aWins: direct.aWins,
        bWins: direct.bWins,
        bouts: direct.bouts.slice(0, 20).map((x) => ({
          date: x.date,
          round: x.round,
          winnerId: x.winner === 1 ? x.w1 : x.w2,
          tournament: this.archive.tournaments.get(x.tid)?.name ?? '',
        })),
      },
      chain: {
        pA: chain.pA,
        connected: chain.connected,
        maxHops,
        perHop: chain.perHop,
        pathsAB: chain.topPathsAB.map((p) => ({ names: p.nodes.map((n) => this.name(n)), dates: p.dates, prob: p.prob })),
        pathsBA: chain.topPathsBA.map((p) => ({ names: p.nodes.map((n) => this.name(n)), dates: p.dates, prob: p.prob })),
      },
      bt: pBt !== undefined ? { pA: pBt, eloA: Math.round(this.graph.btElo(a)!), eloB: Math.round(this.graph.btElo(b)!) } : null,
      elo:
        ra !== undefined && rb !== undefined
          ? {
              pA: predictProbability({ rating: ra, games: recA.wins + recA.losses }, { rating: rb, games: recB.wins + recB.losses }),
              ratingA: Math.round(ra),
              ratingB: Math.round(rb),
            }
          : null,
    };
    return dto;
  }
}
