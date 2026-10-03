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
import { AIMAGS, TOURNAMENT_TYPES, toWrestler, type DevjeeClient, type DevjeeRating, type DevjeeStateMatch, type DevjeeTournamentState } from '../src/devjee.ts';
import type { Engine } from '../src/engine.ts';
import { MIN_BRACKET_ROUNDS, titleFromCode, titleInfo } from '../src/rating.ts';

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
const HOUR = 3_600_000;
/** Хүрээ дутуу тэмцээнийг тэмцээний өдрөөс хойш энэ хугацаанд автоматаар засахыг оролдоно. */
const REPAIR_WINDOW_MS = 72 * HOUR;
/** Бүх барилдаан шийдэгдсэн боловч финал тодроогүй (халз, багийн г.м) — энэ хугацааны дараа sync унтарна. */
const EXPIRE_RESOLVED_MS = 72 * HOUR;
/** Юу ч болсон энэ хугацааны дараа sync унтарна. */
const EXPIRE_HARD_MS = 7 * 24 * HOUR;

/**
 * devjee төлөвт зарлагдсан давааны тоо: `rounds` map эсвэл 1-р давааны барилдааны тооноос
 * (2·n бөх → ⌈log2 2n⌉ даваа; гоцтой хүрээ дараа нь өснө) — аль их нь. 0 = юу ч зарлагдаагүй.
 */
export function declaredRounds(state: DevjeeTournamentState): number {
  let r1 = 0;
  for (const m of Object.values(state.matches)) if (m.round === 1 && m.w1 && m.w2 && m.w1 !== m.w2) r1 += 1;
  return Math.max(Object.keys(state.rounds).length, r1 > 0 ? Math.ceil(Math.log2(2 * r1)) : 0);
}

/** Тэмцээний өдрийн төгсгөл (Улаанбаатарын цагаар). */
const dayEnd = (date: string): number => Date.parse(`${date}T23:59:59+08:00`);

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
    this.autoRepair();
    this.refreshTimer();
  }

  /**
   * Хүрээний дүрэм зөрчсөн (32-оос цөөн бөх / 5-аас цөөн даваа — бүртгэл дутуу) devjee
   * тэмцээнийг тэмцээний өдрөөс 72 цагийн дотор бол sync-ийг асааж засна: дараагийн
   * sync даваа, оролцогч, барилдааныг devjee-ээс нөхнө. Монгол бөхийн тэмцээн 1-2 бөхөөр
   * дуусдаггүй — ийм төлөв бол алдаа.
   */
  autoRepair(): string[] {
    const repaired: string[] = [];
    for (const [id, st] of this.states) {
      if (st.enabled || !this.engine.state.tournaments.has(id)) continue;
      const t = this.engine.tournament(id);
      const issue = this.engine.bracketIssue(id);
      if (!issue || this.now() - dayEnd(t.date) > REPAIR_WINDOW_MS) continue;
      this.setEnabled(id, true);
      repaired.push(id);
      this.log(`${id}: хүрээ дутуу (${issue}) — sync автоматаар асав (засвар)`);
    }
    return repaired;
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
    // Даваа: зарласан давааны тоо эсвэл 1-р давааны барилдааны тооноос (аль их нь); аль аль нь
    // байхгүй бол бүртгэлээс. Дутуу байвал дараагийн sync-үүд өсгөнө (growRounds).
    const declared = declaredRounds(state);
    const rounds = Math.max(1, declared || Math.ceil(Math.log2(Math.max(2, wids.length))));

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

    // Мета: даваа өссөн бол нэмж, оролцогчдыг шинэчилнэ
    const grown = this.growRounds(tournament.id, state);
    this.refreshEntrants(tournament.id, state, grown);

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
    // Импортын дараа sync АВТОМАТААР асна (дууссан тэмцээнийг дахин импортлоход үгүй) —
    // тэмцээний өдөр «Sync асаах» дарахаа мартсанаас даваанууд орж ирэхгүй байх явдлыг таслав.
    if (!this.isEnabled(tournament.id) && !this.engine.roundStatus(tournament.id).finished) {
      this.setEnabled(tournament.id, true);
    }
    this.log(`импорт ${tid}: бөх +${added} (${existing} байсан), рейтинг топ ${fromTop}, түүхээс ${fromMatches}`);
    return { tournamentId: tournament.id, devjeeId: tid, created, wrestlersAdded: added, wrestlersExisting: existing, ratingsFromTop: fromTop, ratingsFromMatches: fromMatches };
  }

  // ── sync ──

  /**
   * Давааны тоог devjee төлөвөөс ӨСГӨЖ шинэчилнэ (хэзээ ч бууруулахгүй). Тэмцээнийг
   * төлөв нь дутуу байхад (даваа зарлагдаагүй) импортолсон бол дараагийн sync-үүд засна.
   */
  private growRounds(tournamentId: string, state: DevjeeTournamentState): number {
    const prev = this.engine.tournament(tournamentId).rounds;
    const fromState = declaredRounds(state);
    if (fromState > prev) {
      this.engine.updateTournament(tournamentId, { rounds: fromState });
      this.log(`${tournamentId}: даваа ${prev} → ${fromState}`);
      return fromState;
    }
    return prev;
  }

  /**
   * Оролцогчид зэрэг дэвийн дарааллаар (зөвхөн бидэнд бүртгэлтэй бөх). Барилдаан зарлагдсан
   * бол = бодитоор хослуулсан бөхчүүд (бүртгэлд барилдаагүй бөх олон байдаг — 276 бүртгэлээс
   * 128 барилдсан); үгүй бол бүртгэлийн эхний 2^max(даваа, 5).
   */
  private refreshEntrants(tournamentId: string, state: DevjeeTournamentState, rounds: number): void {
    const t = this.engine.tournament(tournamentId);
    const localId = (wid: string) => (this.engine.state.wrestlers.has(wid) ? wid : this.engine.wrestlerByDevjeeId(wid)?.id);
    const orderOf = (wid: string) => state.wrestlers[wid]?.order ?? Number.MAX_SAFE_INTEGER;
    const paired = new Set<string>();
    for (const m of Object.values(state.matches)) {
      if (!m.w1 || !m.w2 || m.w1 === m.w2) continue;
      paired.add(m.w1);
      paired.add(m.w2);
    }
    const source = paired.size ? [...paired] : Object.keys(state.wrestlers);
    const sorted = source.sort((a, b) => orderOf(a) - orderOf(b));
    const capped = paired.size ? sorted : sorted.slice(0, 2 ** Math.min(Math.max(rounds, MIN_BRACKET_ROUNDS), 10));
    const ordered = capped.map(localId).filter((id): id is string => !!id);
    const prev = t.entrants ?? [];
    if (ordered.length && (prev.length !== ordered.length || prev.some((id, i) => id !== ordered[i]))) {
      this.engine.updateTournament(tournamentId, { entrants: ordered });
    }
  }

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
      // Мета эхэлж өснө — дутуу үед нь импортолсон тэмцээний даваа нэмэгдэж, дараагийн
      // давааны барилдаанууд орж ирнэ (өмнө нь round > rounds гэж алгасдаг байсан).
      const rounds = this.growRounds(tournamentId, state);
      const entries = Object.entries(state.matches).sort(([, a], [, b]) => a.round - b.round);
      for (const [mid, m] of entries) {
        await this.applyMatch(t.id, rounds, mid, m, result);
      }
      this.refreshEntrants(tournamentId, state, rounds);
      st.lastSyncAt = new Date(this.now()).toISOString();
      delete st.lastError;
      // Авто-унтраалт: (1) ЖИНХЭНЭ төгсгөл — аварга тодорсон (хүрээний дүрэм хангагдсан,
      // финал шийдэгдсэн) ба бүх барилдаан шийдэгдсэн; (2) финалгүй (халз, багийн) — бүгд
      // шийдэгдээд 72 цаг; (3) юу ч болсон 7 хоног. Дутуу төлөвийг «дууссан» гэж андуурахгүй.
      if (st.enabled) {
        const valid = Object.values(state.matches).filter((m) => m.w1 && m.w2 && m.w1 !== m.w2 && m.round >= 1 && m.round <= rounds);
        const allResolved = valid.length > 0 && valid.every((m) => m.winner === 1 || m.winner === 2);
        const maxRound = valid.reduce((mx, m) => Math.max(mx, m.round), 0);
        const finalSeen = valid.filter((m) => m.round === maxRound).length === 1;
        const age = this.now() - dayEnd(state.date || t.date);
        const done = allResolved && finalSeen && this.engine.roundStatus(tournamentId).finished;
        const expired = (allResolved && age > EXPIRE_RESOLVED_MS) || age > EXPIRE_HARD_MS;
        if (done || expired) {
          this.setEnabled(tournamentId, false);
          this.log(`${tournamentId}: ${done ? 'тэмцээн дууссан' : 'хугацаа өнгөрсөн'} — sync автоматаар унтрав`);
        }
      }
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
    const issue = this.engine.bracketIssue(tournamentId);
    if (issue) dto.warning = issue;
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
