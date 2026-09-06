/**
 * devjee.mn → Engine синхрончлол.
 *
 *  - importTournament(tid): devjee тэмцээнийг манай тэмцээн болгож, бүртгэгдсэн
 *    бөхчүүдийг (wid = манай бөхийн id) нэмж, рейтингийг devjee-ээс тавина.
 *  - syncOnce(tournamentId): `states3`-ийг уншиж шинэ барилдаан → зах зээл нээх,
 *    winner ирсэн → шийдэх, `_noShow` → хүчингүй болгох.
 *  - setEnabled: 30 сек тутам автоматаар sync (тэмцээний өдөр л асаана).
 *
 * devjee-д ачаалал өгөхгүй: states doc 20 сек кэштэй, бөхийн мэдээлэл 100-аар
 * багцалж, рейтингийн нэг бүрчилсэн хайлтыг хязгаарлана.
 */

import type { DevjeeHomeDto, DevjeeSyncStatusDto, DevjeeTournamentDto } from '../app/src/shared/api.ts';
import { AIMAGS, TOURNAMENT_TYPES, toWrestler, type DevjeeClient, type DevjeeRating, type DevjeeStateMatch } from '../src/devjee.ts';
import type { Engine } from '../src/engine.ts';
import { titleFromCode, titleInfo } from '../src/rating.ts';

export type DevjeeApi = Pick<DevjeeClient, 'home' | 'tournament' | 'tournamentState' | 'fetchWrestlers' | 'latestRatings' | 'currentRating'>;

export interface DevjeeSyncOptions {
  client: DevjeeApi;
  engine: Engine;
  now?: () => number;
  intervalMs?: number;
  /** Топ-500-д байхгүй бөхийн рейтингийг нэг бүрчлэн хайх дээд тоо (импортод). */
  maxRatingLookups?: number;
  /** Автомат sync-ийн дараа дуудагдана (лог бичих + SSE). */
  onSynced?: (result: SyncResult) => Promise<void> | void;
  log?: (message: string) => void;
}

export interface ImportResult {
  tournamentId: string;
  devjeeId: string;
  created: boolean;
  wrestlersAdded: number;
  wrestlersExisting: number;
  ratingsFromTop: number;
  ratingsFromMatches: number;
}

export interface SyncResult {
  tournamentId: string;
  newBouts: number;
  resolved: number;
  voided: number;
  /** Эхэлсэн барилдааны хаагдсан зах зээл. */
  closed: number;
  marketIds: string[];
  skipped: number;
}

interface SyncState {
  devjeeId: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastError?: string;
}

const CHUNK = 100;
const TITLE_LOOKUP_MIN_CODE = 9; // аймгийн начин ба түүнээс дээш

export function shortName(name: string, max = 70): string {
  const n = name.trim().replace(/\s+/g, ' ');
  return n.length <= max ? n : `${n.slice(0, max - 1).trimEnd()}…`;
}

export class DevjeeSync {
  private readonly client: DevjeeApi;
  private readonly engine: Engine;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxRatingLookups: number;
  private readonly onSynced: ((result: SyncResult) => Promise<void> | void) | undefined;
  private readonly log: (message: string) => void;
  private readonly states = new Map<string, SyncState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: DevjeeSyncOptions) {
    this.client = options.client;
    this.engine = options.engine;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 30_000;
    this.maxRatingLookups = options.maxRatingLookups ?? 300;
    this.onSynced = options.onSynced;
    this.log = options.log ?? ((m) => console.log(`[devjee] ${m}`));
    // Engine-д байгаа devjee тэмцээнүүдийг мэднэ; асаалттай байсан sync-ийг сэргээнэ (дахин асахад алдагдахгүй).
    for (const t of this.engine.tournaments()) {
      if (t.devjeeId) this.states.set(t.id, { devjeeId: t.devjeeId, enabled: !!t.syncEnabled });
    }
    this.refreshTimer();
  }

  // ── жагсаалт ──

  async home(): Promise<DevjeeHomeDto> {
    const h = await this.client.home();
    const imported = new Set(this.engine.tournaments().map((t) => t.devjeeId).filter((x): x is string => !!x));
    const conv = (t: { id: string; name: string; date: string; location?: { aimag: number; sum: number } | null }): DevjeeTournamentDto => {
      const dto: DevjeeTournamentDto = { id: t.id, name: t.name, date: t.date, imported: imported.has(t.id) };
      const place = t.location ? AIMAGS[t.location.aimag] : undefined;
      if (place) dto.place = place;
      return dto;
    };
    return { scheduled: h.scheduled.map(conv), recent: h.home.map(conv) };
  }

  // ── импорт ──

  private tournamentByDevjeeId(tid: string) {
    return this.engine.tournaments().find((t) => t.devjeeId === tid);
  }

  async importTournament(tid: string, options: { withRatings?: boolean } = {}): Promise<ImportResult> {
    const withRatings = options.withRatings ?? true;
    const info = await this.client.tournament(tid);
    const { state } = await this.client.tournamentState(tid, 60_000);
    const wids = Object.keys(state.wrestlers);
    const roundsFromState = Object.keys(state.rounds).length;
    const rounds = Math.max(1, roundsFromState || Math.ceil(Math.log2(Math.max(2, wids.length))));

    let tournament = this.tournamentByDevjeeId(tid);
    let created = false;
    if (!tournament) {
      const input: Parameters<Engine['createTournament']>[0] = {
        id: `dj-${tid}`,
        name: shortName(info.name || state.name || tid),
        date: info.date || state.date,
        rounds,
        devjeeId: tid,
      };
      const kind = info.type?.[0] !== undefined ? TOURNAMENT_TYPES[info.type[0]] : undefined;
      if (kind) input.kind = kind;
      const place = info.location ? AIMAGS[info.location.aimag] : undefined;
      if (place) input.place = place;
      tournament = this.engine.createTournament(input);
      created = true;
    }

    // Бөхчүүд — багцаар татаж, байхгүйг нь нэмнэ (id = devjee wid);
    // байгаа боловч овог/сум дутуу бол нөхнө.
    let added = 0;
    let existing = 0;
    const missing = wids.filter((wid) => !this.engine.state.wrestlers.has(wid) && !this.engine.wrestlerByDevjeeId(wid));
    const incomplete = wids.filter((wid) => {
      const w = this.engine.state.wrestlers.get(wid) ?? this.engine.wrestlerByDevjeeId(wid);
      return !!w && (!w.fullName || !w.sum);
    });
    existing = wids.length - missing.length;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const details = await this.client.fetchWrestlers(chunk);
      for (const wid of chunk) {
        const dw = details[wid];
        if (!dw) {
          this.engine.addWrestler({ id: wid, name: wid, title: 'цолгүй', devjeeId: wid });
        } else {
          this.engine.addWrestler({ id: wid, ...toWrestler(dw) });
        }
        added += 1;
      }
    }
    for (let i = 0; i < incomplete.length; i += CHUNK) {
      const chunk = incomplete.slice(i, i + CHUNK);
      const details = await this.client.fetchWrestlers(chunk);
      for (const wid of chunk) {
        const dw = details[wid];
        const local = this.engine.state.wrestlers.get(wid) ?? this.engine.wrestlerByDevjeeId(wid);
        if (!dw || !local) continue;
        const fresh = toWrestler(dw);
        const patch: Partial<typeof fresh> = {};
        if (!local.fullName && fresh.fullName) patch.fullName = fresh.fullName;
        if (!local.sum && fresh.sum) patch.sum = fresh.sum;
        if (!local.aimag && fresh.aimag) patch.aimag = fresh.aimag;
        if (!local.birthDate && fresh.birthDate) patch.birthDate = fresh.birthDate;
        if (Object.keys(patch).length) this.engine.updateWrestler(local.id, patch);
      }
    }

    // Оролцогчид зэрэг дэвийн дарааллаар (прогнозд); дээд тал нь 2^rounds
    const ordered = Object.values(state.wrestlers)
      .sort((a, b) => a.order - b.order)
      .map((w) => w.id)
      .filter((id) => this.engine.state.wrestlers.has(id))
      .slice(0, 2 ** rounds);
    const prev = tournament.entrants ?? [];
    if (ordered.length && (prev.length !== ordered.length || prev.some((id, i) => id !== ordered[i]))) {
      this.engine.updateTournament(tournament.id, { entrants: ordered });
    }

    // Рейтинг
    let fromTop = 0;
    let fromMatches = 0;
    if (withRatings) {
      const { date, ratings } = await this.client.latestRatings();
      let lookups = 0;
      for (const wid of wids) {
        const local = this.engine.state.wrestlers.get(wid) ?? this.engine.wrestlerByDevjeeId(wid);
        if (!local) continue;
        const top: DevjeeRating | undefined = ratings[wid];
        const current = this.engine.rating(local.id);
        if (top) {
          if (current.source !== 'devjee' || current.asOf !== date || Math.abs(current.rating - top.rating) > 1e-9) {
            this.engine.setRating(local.id, top.rating, 'devjee', date);
          }
          fromTop += 1;
          continue;
        }
        if (current.source === 'devjee') continue; // өмнө нь олсон
        if (titleInfo(local.title).code < TITLE_LOOKUP_MIN_CODE) continue;
        if (lookups >= this.maxRatingLookups) continue;
        lookups += 1;
        const r = await this.client.currentRating(wid, ratings);
        if (r) {
          this.engine.setRating(local.id, r.rating, 'devjee', r.asOf);
          fromMatches += 1;
        }
      }
    }

    if (!this.states.has(tournament.id)) this.states.set(tournament.id, { devjeeId: tid, enabled: false });
    this.log(`импорт ${tid}: бөх +${added} (${existing} байсан), рейтинг топ ${fromTop}, түүхээс ${fromMatches}`);
    return { tournamentId: tournament.id, devjeeId: tid, created, wrestlersAdded: added, wrestlersExisting: existing, ratingsFromTop: fromTop, ratingsFromMatches: fromMatches };
  }

  // ── sync ──

  private async ensureWrestler(wid: string): Promise<string> {
    if (this.engine.state.wrestlers.has(wid)) return wid;
    const byDevjee = this.engine.wrestlerByDevjeeId(wid);
    if (byDevjee) return byDevjee.id;
    const details = await this.client.fetchWrestlers([wid]);
    const dw = details[wid];
    this.engine.addWrestler(dw ? { id: wid, ...toWrestler(dw) } : { id: wid, name: wid, title: 'цолгүй', devjeeId: wid });
    return wid;
  }

  async syncOnce(tournamentId: string): Promise<SyncResult> {
    const t = this.engine.tournament(tournamentId);
    if (!t.devjeeId) throw new Error('Энэ тэмцээн devjee-тэй холбоогүй.');
    const st = this.states.get(tournamentId) ?? { devjeeId: t.devjeeId, enabled: false };
    this.states.set(tournamentId, st);
    const result: SyncResult = { tournamentId, newBouts: 0, resolved: 0, voided: 0, closed: 0, marketIds: [], skipped: 0 };
    try {
      const { state } = await this.client.tournamentState(t.devjeeId, 20_000);
      const entries = Object.entries(state.matches).sort(([, a], [, b]) => a.round - b.round);
      for (const [mid, m] of entries) {
        await this.applyMatch(t.id, t.rounds, mid, m, result);
      }
      st.lastSyncAt = new Date(this.now()).toISOString();
      delete st.lastError;
    } catch (err) {
      st.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return result;
  }

  private async applyMatch(tournamentId: string, rounds: number, mid: string, m: DevjeeStateMatch, result: SyncResult): Promise<void> {
    if (!m.w1 || !m.w2 || m.w1 === m.w2) {
      result.skipped += 1;
      return;
    }
    if (m.round < 1 || m.round > rounds) {
      result.skipped += 1;
      return;
    }
    const boutId = `dj-${mid}`;
    let bout = this.engine.state.bouts.get(boutId);
    if (!bout) {
      const aId = await this.ensureWrestler(m.w1);
      const bId = await this.ensureWrestler(m.w2);
      const created = this.engine.createBout({ id: boutId, tournamentId, round: m.round, aId, bId, devjeeMatchId: mid, withMarket: true });
      bout = created.bout;
      if (created.market) result.marketIds.push(created.market.id);
      result.newBouts += 1;
    }
    if (bout.result) return;
    if (m.winner !== 1 && m.winner !== 2) {
      // Барилдаан эхэлсэн (devjee `startedAt`) боловч үр дүн ороогүй → бооцоог хаана (амьд барилдаанд бооцоо авахгүй)
      if (m.startedAt) {
        for (const mk of this.engine.markets({ boutId: bout.id })) {
          if (mk.status === 'open') {
            this.engine.closeMarket(mk.id);
            result.marketIds.push(mk.id);
            result.closed += 1;
          }
        }
      }
      return;
    }
    const winnerId = m.winner === 1 ? bout.aId : bout.bId;
    if (m._noShow) {
      for (const mk of this.engine.markets({ boutId: bout.id })) {
        if (mk.status === 'open' || mk.status === 'closed') {
          this.engine.voidMarket(mk.id, 'Бөх ирээгүй (гоц)');
          result.marketIds.push(mk.id);
          result.voided += 1;
        }
      }
      this.engine.recordBoutResult(bout.id, winnerId, { updateRatings: false });
      return;
    }
    const r = this.engine.recordBoutResult(bout.id, winnerId);
    for (const mk of r.resolvedMarkets) result.marketIds.push(mk.id);
    result.resolved += r.resolvedMarkets.length;
  }

  // ── автомат давталт ──

  /** Асаах/унтраах — Engine-д (үйл явдал) хадгална, тул сервер дахин ассан ч төлөв үлдэнэ. */
  setEnabled(tournamentId: string, enabled: boolean): void {
    const t = this.engine.tournament(tournamentId);
    if (!t.devjeeId) throw new Error('Энэ тэмцээн devjee-тэй холбоогүй.');
    const st = this.states.get(tournamentId) ?? { devjeeId: t.devjeeId, enabled: false };
    st.enabled = enabled;
    this.states.set(tournamentId, st);
    if (!!t.syncEnabled !== enabled) this.engine.updateTournament(tournamentId, { syncEnabled: enabled });
    this.refreshTimer();
  }

  isEnabled(tournamentId: string): boolean {
    return this.states.get(tournamentId)?.enabled ?? false;
  }

  private refreshTimer(): void {
    const any = [...this.states.values()].some((s) => s.enabled);
    if (any && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    } else if (!any && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Идэвхтэй бүх тэмцээнийг нэг удаа sync хийнэ (давталт эсвэл гараар). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [id, st] of this.states) {
        if (!st.enabled) continue;
        try {
          const r = await this.syncOnce(id);
          if (r.newBouts || r.resolved || r.voided) {
            this.log(`sync ${id}: шинэ ${r.newBouts}, шийдсэн ${r.resolved}, хүчингүй ${r.voided}`);
          }
          if (this.onSynced && (r.marketIds.length > 0 || r.newBouts > 0)) await this.onSynced(r);
        } catch (err) {
          this.log(`sync ${id} алдаа: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  status(tournamentId: string): DevjeeSyncStatusDto {
    const t = this.engine.tournament(tournamentId);
    const st = this.states.get(tournamentId);
    const bouts = this.engine.bouts(tournamentId);
    const dto: DevjeeSyncStatusDto = {
      tournamentId,
      devjeeId: t.devjeeId ?? '',
      enabled: st?.enabled ?? false,
      wrestlers: this.engine.wrestlers().length,
      bouts: bouts.length,
      resolved: bouts.filter((b) => b.result).length,
    };
    if (st?.lastSyncAt) dto.lastSyncAt = st.lastSyncAt;
    if (st?.lastError) dto.lastError = st.lastError;
    return dto;
  }

  allStatuses(): DevjeeSyncStatusDto[] {
    return [...this.states.keys()].filter((id) => this.engine.state.tournaments.has(id)).map((id) => this.status(id));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Тэмцээний бүртгэлийн цолын кодыг манай цол болгоно (импортод хэрэглэнэ). */
export const titleOfCode = titleFromCode;
