/**
 * devjee.mn → Engine синхрончлол.
 *
 *  - importTournament(tid): devjee тэмцээнийг манай тэмцээн болгож, бүртгэгдсэн
 *    бөхчүүдийг (wid = манай бөхийн id) нэмж, рейтингийг devjee-ээс тавина.
 *  - syncOnce(tournamentId): төлөвийг уншиж шинэ барилдаан → зах зээл нээх,
 *    winner ирсэн → шийдэх, `_noShow` → хүчингүй болгох, devjee дээр устсан/өөрчлөгдсөн
 *    хослол → цуцлах.
 *  - setEnabled: 30 сек тутам автоматаар sync (импортын дараа өөрөө асна).
 *  - autoImport: devjee-ийн нүүр хуудсанд гарсан ойрын тэмцээнийг өөрөө оруулна —
 *    тэмцээн эхлэхээс өмнө зах зээл нээгдэж, амьд үед таамаг тавих боломжтой болно.
 *
 * devjee-д ачаалал өгөхгүй: төлөв 20 сек кэштэй, бөхийн мэдээлэл 100-аар багцалж,
 * рейтингийн нэг бүрчилсэн хайлтыг хязгаарлана; тэмцээний өдөр биш үед sync сийрэгжинэ.
 */

import type { DevjeeHomeDto, DevjeeSyncStatusDto, DevjeeTournamentDto } from '../app/src/shared/api.ts';
import { AIMAGS, pushIdTime, roundFormat, roundInfoFromState, TOURNAMENT_TYPES, toWrestler, type DevjeeClient, type DevjeeRating, type DevjeeStateMatch, type DevjeeTournamentState } from '../src/devjee.ts';
import type { Bout } from '../src/domain.ts';
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
  /** Автомат импортын дараа дуудагдана (лог бичих + SSE). */
  onImported?: (result: ImportResult) => Promise<void> | void;
  /** devjee-ийн нүүр хуудсанд гарсан ойрын тэмцээнийг өөрөө импортлох уу (анхдагч: үгүй). */
  autoImport?: boolean;
  /** Автомат импортын давтамж (анхдагч 10 минут). */
  autoImportMs?: number;
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
  /** devjee дээр устсан/хослол нь өөрчлөгдсөн тул цуцлагдсан барилдаан. */
  cancelled: number;
  marketIds: string[];
  skipped: number;
}

interface SyncState {
  devjeeId: string;
  enabled: boolean;
  /** Сүүлд devjee-ээс амжилттай шалгасан цаг. */
  lastSyncAt?: string;
  lastError?: string;
  /** devjee дээрх төлөв хамгийн сүүлд өөрчлөгдсөн цаг (snapshot-ийн actionId-аас). */
  devjeeChangedAt?: string;
  /** Sync хамгийн сүүлд шинэ барилдаан/үр дүн авчирсан цаг. */
  lastChangeAt?: string;
  /** Сийрэг горимд дараагийн автомат sync хийх хамгийн эрт цаг (мс). */
  skipUntil?: number;
  /** Сүүлд харсан төлөвийн тэмдэг (шинэ форматад actionId байхгүй — өөрчлөлтийг үүгээр илрүүлнэ). */
  stateSig?: string;
}

/** Автомат sync шаардлагагүй болсон шалтгаан: тэмцээн дууссан / хугацаа өнгөрсөн. */
export type SyncOffReason = 'finished' | 'expired';

const CHUNK = 100;
const TITLE_LOOKUP_MIN_CODE = 9; // аймгийн начин ба түүнээс дээш
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Хүрээ дутуу тэмцээнийг тэмцээний өдрөөс хойш энэ хугацаанд автоматаар засахыг оролдоно. */
const REPAIR_WINDOW_MS = 72 * HOUR;
/** Бүх барилдаан шийдэгдсэн боловч финал тодроогүй (халз, багийн г.м) — энэ хугацааны дараа sync унтарна. */
const EXPIRE_RESOLVED_MS = 72 * HOUR;
/** Юу ч болсон энэ хугацааны дараа sync унтарна. */
const EXPIRE_HARD_MS = 7 * DAY;
/** Тэмцээний өдрөөс хойш devjee дээр энэ хугацаанд өөрчлөлт ороогүй бол sync унтарна (шийдэгдээгүй барилдаан үлдсэн ч). */
const EXPIRE_SILENT_MS = 48 * HOUR;
/** Сийрэг sync: тэмцээний өдрөөс өмнө (бүртгэл, хослол аажим өөрчлөгдөнө). */
const SLOW_BEFORE_MS = 10 * 60_000;
/** Сийрэг sync: тэмцээний өдөр өнгөрч, devjee чимээгүй болсон үед. Амьд үед үргэлж `intervalMs`. */
const SLOW_AFTER_MS = 2 * 60_000;
/** devjee энэ хугацаанд өөрчлөгдөөгүй бол «чимээгүй». */
const QUIET_MS = 3 * HOUR;
/** Автомат импортын цонх: өчигдрөөс нөгөөдөр хүртэлх тэмцээн. */
const AUTO_IMPORT_BACK_DAYS = 1;
const AUTO_IMPORT_AHEAD_DAYS = 2;
/** Автомат импорт бүтэлгүйтвэл дахин оролдохоос өмнө хүлээх хугацаа. */
const AUTO_IMPORT_RETRY_MS = 30 * 60_000;
const CANCEL_REASON = 'devjee дээр хослол өөрчлөгдсөн';

/** Барилдаан хүчинтэй хослолтой эсэх (хоёр өөр бөх). */
const paired = (m: DevjeeStateMatch | undefined): m is DevjeeStateMatch => !!m && !!m.w1 && !!m.w2 && m.w1 !== m.w2;

/**
 * devjee төлөвт зарлагдсан давааны тоо: `rounds` map эсвэл 1-р давааны барилдааны тооноос
 * (2·n бөх → ⌈log2 2n⌉ даваа; гоцтой хүрээ дараа нь өснө) — аль их нь. 0 = юу ч зарлагдаагүй.
 * Хосын тооноос тооцох нь ШИГШЭЭ 1-р даваанд л утгатай: тойргийн/багийн «даваа» дотор бүгд
 * бүгдтэйгээ барилддаг тул 28 барилдаан = 6 даваа гэж андуурч болохгүй.
 */
export function declaredRounds(state: DevjeeTournamentState): number {
  let declared = 0;
  for (const key of Object.keys(state.rounds)) {
    const n = Number(key);
    declared = Math.max(declared, Number.isInteger(n) && n > 0 ? n : 0);
  }
  declared = Math.max(declared, Object.keys(state.rounds).length);
  if (roundFormat(state.rounds['1']?.type) !== 'knockout') return declared;
  let r1 = 0;
  for (const m of Object.values(state.matches)) if (m.round === 1 && paired(m)) r1 += 1;
  return Math.max(declared, r1 > 0 ? Math.ceil(Math.log2(2 * r1)) : 0);
}

/** Тэмцээний өдрийн эхлэл / төгсгөл (Улаанбаатарын цагаар). */
const dayStart = (date: string): number => Date.parse(`${date}T00:00:00+08:00`);
const dayEnd = (date: string): number => Date.parse(`${date}T23:59:59+08:00`);
/** Улаанбаатарын өнөөдрийн огноо (YYYY-MM-DD) + `offsetDays`. */
const ubDate = (now: number, offsetDays = 0): string => new Date(now + 8 * HOUR + offsetDays * DAY).toISOString().slice(0, 10);

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
  private readonly onImported: ((result: ImportResult) => Promise<void> | void) | undefined;
  private readonly log: (message: string) => void;
  private readonly states = new Map<string, SyncState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private importTimer: ReturnType<typeof setInterval> | null = null;
  private importKick: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private importing = false;
  private stopped = false;
  /** Автомат импорт бүтэлгүйтсэн тэмцээн → дахин оролдох хамгийн эрт цаг. */
  private readonly importRetryAt = new Map<string, number>();
  /** Нэг удаа л анхааруулах зөрчлүүд (үр дүнтэй барилдаан devjee дээр өөрчлөгдсөн г.м). */
  private readonly warned = new Set<string>();

  constructor(options: DevjeeSyncOptions) {
    this.client = options.client;
    this.engine = options.engine;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 30_000;
    this.maxRatingLookups = options.maxRatingLookups ?? 300;
    this.onSynced = options.onSynced;
    this.onImported = options.onImported;
    this.log = options.log ?? ((m) => console.log(`[devjee] ${m}`));
    // Engine-д байгаа devjee тэмцээнүүдийг мэднэ; асаалттай байсан sync-ийг сэргээнэ (дахин асахад алдагдахгүй).
    for (const t of this.engine.tournaments()) {
      if (t.devjeeId) this.states.set(t.id, { devjeeId: t.devjeeId, enabled: !!t.syncEnabled });
    }
    this.autoRepair();
    this.refreshTimer();
    if (options.autoImport) {
      const every = options.autoImportMs ?? 10 * 60_000;
      this.importTimer = setInterval(() => void this.autoImport(), every);
      if (typeof this.importTimer.unref === 'function') this.importTimer.unref();
      // Сервер ассаны дараахан нэг удаа (эхлэлийг удаашруулахгүйн тулд бага зэрэг хойшлуулна)
      this.importKick = setTimeout(() => void this.autoImport(), Math.min(every, 20_000));
      if (typeof this.importKick.unref === 'function') this.importKick.unref();
    }
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

  /**
   * devjee-ийн нүүр хуудсанд гарсан, өчигдрөөс нөгөөдөр хүртэлх огноотой, хараахан
   * оруулаагүй тэмцээнүүдийг импортолно (импорт sync-ийг өөрөө асаадаг). 2026-10-04…10-10-ны
   * гурван тэмцээн дууссаных нь дараа гараар орсон тул амьд үед нь таамаг тавих боломж
   * гараагүй — үүнийг таслав. Буцаах: шинээр оруулсан тэмцээний id-ууд.
   */
  async autoImport(): Promise<string[]> {
    if (this.importing || this.stopped) return [];
    this.importing = true;
    const done: string[] = [];
    try {
      const h = await this.client.home();
      const from = ubDate(this.now(), -AUTO_IMPORT_BACK_DAYS);
      const to = ubDate(this.now(), AUTO_IMPORT_AHEAD_DAYS);
      const known = new Set(this.engine.tournaments().map((t) => t.devjeeId).filter((x): x is string => !!x));
      const seen = new Set<string>();
      for (const t of [...h.scheduled, ...h.home]) {
        if (this.stopped) break;
        if (!t?.id || seen.has(t.id) || known.has(t.id)) continue;
        seen.add(t.id);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '') || t.date < from || t.date > to) continue;
        if ((this.importRetryAt.get(t.id) ?? 0) > this.now()) continue;
        try {
          const r = await this.importTournament(t.id);
          this.importRetryAt.delete(t.id);
          done.push(r.tournamentId);
          this.log(`автомат импорт: ${t.date} «${shortName(t.name, 50)}»`);
          if (this.onImported) await this.onImported(r);
        } catch (err) {
          this.importRetryAt.set(t.id, this.now() + AUTO_IMPORT_RETRY_MS);
          this.log(`автомат импорт ${t.id} алдаа: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.log(`автомат импорт — жагсаалт уншигдсангүй: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.importing = false;
    }
    return done;
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
      const roundInfo = roundInfoFromState(state);
      if (roundInfo) input.roundInfo = roundInfo;
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

    // Мета: давааны хэлбэр, даваа өссөн бол нэмж, оролцогчдыг шинэчилнэ
    this.refreshRoundInfo(tournament.id, state);
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
    // Хуучин тэмцээн ч нэг удаа sync хийгдэж барилдаанууд нь орж ирээд өөрөө унтарна.
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
   * Давааны хэлбэр/нэрийг (тойргийн, багийн; «15 нас», «Өвөрмонгол бөх») devjee төлөвөөс
   * дагуулна. Барилдаан үүсгэхээс ӨМНӨ дуудагдах ёстой — зах зээлийн гарчиг, таамгийн
   * контекст, «өөр төрлийн бөхөд таавар нээхгүй» гэдэг нь үүнээс хамаарна.
   */
  private refreshRoundInfo(tournamentId: string, state: DevjeeTournamentState): void {
    const next = roundInfoFromState(state);
    const prev = this.engine.tournament(tournamentId).roundInfo;
    const canon = (x: unknown) => JSON.stringify(x ?? {}, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
    if (canon(next) === canon(prev)) return;
    this.engine.updateTournament(tournamentId, { roundInfo: next ?? {} });
    const kinds = Object.values(next ?? {}).map((r) => r.name ?? r.format);
    this.log(`${tournamentId}: давааны хэлбэр шинэчлэгдэв${kinds.length ? ` — ${kinds.join(', ')}` : ''}`);
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
    const inBouts = new Set<string>();
    for (const m of Object.values(state.matches)) {
      if (!paired(m)) continue;
      inBouts.add(m.w1);
      inBouts.add(m.w2);
    }
    const source = inBouts.size ? [...inBouts] : Object.keys(state.wrestlers);
    const sorted = source.sort((a, b) => orderOf(a) - orderOf(b));
    const capped = inBouts.size ? sorted : sorted.slice(0, 2 ** Math.min(Math.max(rounds, MIN_BRACKET_ROUNDS), 10));
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
    const result: SyncResult = { tournamentId, newBouts: 0, resolved: 0, voided: 0, closed: 0, cancelled: 0, marketIds: [], skipped: 0 };
    try {
      const { state, actionId, sequence } = await this.client.tournamentState(t.devjeeId, 20_000);
      // Мета эхэлж шинэчлэгдэнэ — давааны хэлбэр (тойргийн/багийн) барилдаан үүсэхээс өмнө
      // мэдэгдэж, дутуу үед нь импортолсон тэмцээний даваа нэмэгдэж дараагийн давааны
      // барилдаанууд орж ирнэ (өмнө нь round > rounds гэж алгасдаг байсан).
      this.refreshRoundInfo(tournamentId, state);
      const rounds = this.growRounds(tournamentId, state);
      // Тэмцээн хойшлогдвол огноог дагуулна — эс бөгөөс хуучин огноогоор «хугацаа өнгөрсөн» болно
      const prevDate = t.date;
      if (/^\d{4}-\d{2}-\d{2}$/.test(state.date ?? '') && state.date !== prevDate) {
        this.engine.updateTournament(tournamentId, { date: state.date });
        this.log(`${tournamentId}: огноо ${prevDate} → ${state.date}`);
      }
      // Идэвхтэй (цуцлагдаагүй) барилдаануудыг devjee-ийн match id-аар
      const byMid = new Map<string, Bout>();
      for (const b of this.engine.bouts(tournamentId)) if (b.devjeeMatchId) byMid.set(b.devjeeMatchId, b);
      // Эхлээд устсан хослолыг цуцална — нэг бөх хуучин ба шинэ хоёр хослолд зэрэг харагдахгүй
      this.cancelVanished(tournamentId, state, byMid, result);
      const entries = Object.entries(state.matches).sort(([, a], [, b]) => a.round - b.round);
      for (const [mid, m] of entries) {
        await this.applyMatch(t.id, rounds, mid, m, byMid, result);
      }
      this.refreshEntrants(tournamentId, state, rounds);
      st.lastSyncAt = new Date(this.now()).toISOString();
      delete st.lastError;
      const changedAt = pushIdTime(actionId);
      if (changedAt !== undefined) st.devjeeChangedAt = new Date(changedAt).toISOString();
      else {
        // 2026-10-ийн шинэ форматад сүүлийн үйлдлийн id байхгүй → төлөв өөрчлөгдсөнийг ажиглаж цаг тэмдэглэнэ
        const all = Object.values(state.matches);
        const sig = `${sequence ?? ''}|${all.length}|${all.filter((m) => m.winner === 1 || m.winner === 2).length}|${all.filter((m) => m.startedAt).length}`;
        if (st.stateSig !== sig) {
          st.stateSig = sig;
          st.devjeeChangedAt = st.lastSyncAt;
        }
      }
      if (result.newBouts || result.resolved || result.voided || result.closed || result.cancelled) st.lastChangeAt = st.lastSyncAt;
      // Авто-унтраалт (offReason): жинхэнэ төгсгөл эсвэл хугацаа өнгөрсөн үед л.
      const reason = st.enabled ? this.offReason(tournamentId) : undefined;
      if (reason) {
        this.setEnabled(tournamentId, false);
        this.log(`${tournamentId}: ${reason === 'finished' ? 'тэмцээн дууссан' : 'хугацаа өнгөрсөн'} — sync автоматаар унтрав`);
      }
    } catch (err) {
      st.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return result;
  }

  /**
   * devjee дээр устсан (эсвэл хосгүй болсон) барилдаануудыг цуцална: зах зээл нь хүчингүй болж
   * бооцоо буцна. Зохион байгуулагч хослолыг дахин оноох үед хуучин match устаж шинэ id-тай
   * үүсдэг — 2026-10-11-нд ийм хоёр барилдааны зах зээл нээлттэй үлдэж, тэмцээнийг «дуусаагүй»
   * болгож байв. Үр дүнтэй барилдааг хөндөхгүй (зах зээл аль хэдийн шийдэгдсэн).
   *
   * Хамгаалалт: devjee-ийн төлөв гэнэт хоосорсон/хумигдсан мэт бол (бидний мэдэх үр дүнтэй
   * барилдааны талаас цөөн хос үлдсэн) юу ч цуцлахгүй — дутуу баримтаас болж зах зээлүүдийг
   * бөөнөөр хүчингүй болгохгүй.
   */
  private cancelVanished(tournamentId: string, state: DevjeeTournamentState, byMid: Map<string, Bout>, result: SyncResult): void {
    const valid = Object.values(state.matches).filter(paired).length;
    let resolvedKnown = 0;
    for (const b of byMid.values()) if (b.result) resolvedKnown += 1;
    if (valid === 0 || valid < resolvedKnown / 2) return;
    for (const [mid, b] of [...byMid]) {
      if (paired(state.matches[mid])) continue;
      if (b.result) {
        this.warnOnce(`gone:${b.id}`, `${tournamentId}: үр дүнтэй барилдаан ${b.id} devjee дээр устсан — манайд хэвээр үлдэнэ`);
        continue;
      }
      this.cancel(b, result);
      byMid.delete(mid);
    }
  }

  private cancel(b: Bout, result: SyncResult): void {
    const r = this.engine.cancelBout(b.id, CANCEL_REASON);
    for (const mk of r.voidedMarkets) result.marketIds.push(mk.id);
    result.voided += r.voidedMarkets.length;
    result.cancelled += 1;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(message);
  }

  /** `dj-<mid>` (эсвэл хослол нь солигдсон бол `dj-<mid>~2`, `~3` …) — давхардахгүй id. */
  private freeBoutId(mid: string): string {
    const base = `dj-${mid}`;
    if (!this.engine.state.bouts.has(base)) return base;
    for (let n = 2; ; n++) if (!this.engine.state.bouts.has(`${base}~${n}`)) return `${base}~${n}`;
  }

  private async applyMatch(tournamentId: string, rounds: number, mid: string, m: DevjeeStateMatch, byMid: Map<string, Bout>, result: SyncResult): Promise<void> {
    if (!paired(m)) {
      result.skipped += 1;
      return;
    }
    if (m.round < 1 || m.round > rounds) {
      result.skipped += 1;
      return;
    }
    const aId = await this.ensureWrestler(m.w1);
    const bId = await this.ensureWrestler(m.w2);
    let bout = byMid.get(mid);
    // Ижил match id-тай боловч бөх нь солигдсон → хуучныг цуцалж шинийг үүсгэнэ
    if (bout && !((bout.aId === aId && bout.bId === bId) || (bout.aId === bId && bout.bId === aId))) {
      if (bout.result) {
        this.warnOnce(`changed:${bout.id}`, `${tournamentId}: үр дүнтэй барилдаан ${bout.id}-ийн бөхчүүд devjee дээр өөрчлөгдсөн — манайд хэвээр үлдэнэ`);
        return;
      }
      this.cancel(bout, result);
      byMid.delete(mid);
      bout = undefined;
    }
    if (!bout) {
      const created = this.engine.createBout({ id: this.freeBoutId(mid), tournamentId, round: m.round, aId, bId, devjeeMatchId: mid, withMarket: true });
      bout = created.bout;
      byMid.set(mid, bout);
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
    // Давагчийг devjee-ийн w1/w2-оос тодорхойлно (манай А/Б-ийн дараалал өөр байж болно)
    const winnerId = m.winner === 1 ? aId : bId;
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
    delete st.skipUntil;
    this.states.set(tournamentId, st);
    if (!!t.syncEnabled !== enabled) this.engine.updateTournament(tournamentId, { syncEnabled: enabled });
    this.refreshTimer();
  }

  isEnabled(tournamentId: string): boolean {
    return this.states.get(tournamentId)?.enabled ?? false;
  }

  /**
   * Автомат sync шаардлагагүй болсон шалтгаан (байхгүй бол undefined = sync хэрэгтэй):
   *  - 'finished': аварга тодорсон (хүрээний дүрэм хангагдсан, финал шийдэгдсэн) БА бүх
   *    барилдаан шийдэгдсэн — devjee дээр шинэ мэдээлэл гарахгүй;
   *  - 'expired': финалгүй формат (халз, тойргийн, багийн) бүгд шийдэгдээд 72 цаг өнгөрсөн;
   *    эсвэл тэмцээний өдрөөс 48 цаг өнгөрч devjee ч 48 цаг чимээгүй (шийдэгдээгүй барилдаан
   *    үлдсэн ч — зохион байгуулагч оруулаагүй үр дүнг хүлээгээд 7 хоног асаалттай байхгүй);
   *    эсвэл юу ч болсон тэмцээний өдрөөс 7 хоног өнгөрсөн.
   * Дутуу төлөвийг (зөвхөн 1-р даваа орж ирсэн г.м) «дууссан» гэж андуурахгүй. Сүлжээгүй —
   * Engine-ийн төлөвөөс (sync-ийн дараа devjee-ийн хүчинтэй барилдаануудтай ижил).
   */
  offReason(tournamentId: string): SyncOffReason | undefined {
    const t = this.engine.tournament(tournamentId);
    const bouts = this.engine.bouts(tournamentId);
    const allResolved = bouts.length > 0 && bouts.every((b) => b.result);
    if (allResolved && this.engine.roundStatus(tournamentId).finished) return 'finished';
    const age = this.now() - dayEnd(t.date);
    if ((allResolved && age > EXPIRE_RESOLVED_MS) || age > EXPIRE_HARD_MS) return 'expired';
    const changedAt = this.states.get(tournamentId)?.devjeeChangedAt;
    if (changedAt && age > EXPIRE_SILENT_MS && this.now() - Date.parse(changedAt) > EXPIRE_SILENT_MS) return 'expired';
    return undefined;
  }

  /**
   * Дараагийн автомат sync хүртэлх нэмэлт хүлээлт (0 = энгийн давтамж). Тэмцээний өдөр,
   * мөн devjee сүүлийн 3 цагт өөрчлөгдсөн бол үргэлж энгийн давтамж — амьд барилдааны
   * зах зээл цагтаа хаагдах ёстой. Тэмцээний өдрөөс өмнө 10 минут, өдөр өнгөрч devjee
   * чимээгүй болсон үед 2 минут тутам л шалгана (devjee-д дэмий ачаалал өгөхгүй).
   */
  private slowDelay(tournamentId: string, st: SyncState): number {
    const t = this.engine.tournament(tournamentId);
    const now = this.now();
    if (now < dayStart(t.date)) return SLOW_BEFORE_MS;
    if (now <= dayEnd(t.date)) return 0;
    const changedAt = st.devjeeChangedAt ? Date.parse(st.devjeeChangedAt) : undefined;
    return changedAt !== undefined && now - changedAt > QUIET_MS ? SLOW_AFTER_MS : 0;
  }

  private refreshTimer(): void {
    if (this.stopped) return;
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
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const [id, st] of this.states) {
        if (!st.enabled || this.stopped) continue;
        if (st.skipUntil !== undefined && this.now() < st.skipUntil) continue;
        try {
          const r = await this.syncOnce(id);
          if (r.newBouts || r.resolved || r.voided || r.cancelled) {
            this.log(`sync ${id}: шинэ ${r.newBouts}, шийдсэн ${r.resolved}, хүчингүй ${r.voided}${r.cancelled ? `, цуцалсан ${r.cancelled}` : ''}`);
          }
          const delay = this.slowDelay(id, st);
          if (delay > 0) st.skipUntil = this.now() + delay;
          else delete st.skipUntil;
          if (this.onSynced && (r.marketIds.length > 0 || r.newBouts > 0 || r.cancelled > 0)) await this.onSynced(r);
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
      name: t.name,
      date: t.date,
      enabled: st?.enabled ?? false,
      finished: this.engine.roundStatus(tournamentId).finished,
      wrestlers: this.engine.wrestlers().length,
      bouts: bouts.length,
      resolved: bouts.filter((b) => b.result).length,
    };
    if (st?.lastSyncAt) dto.lastSyncAt = st.lastSyncAt;
    if (st?.lastError) dto.lastError = st.lastError;
    if (st?.devjeeChangedAt) dto.devjeeChangedAt = st.devjeeChangedAt;
    if (st?.lastChangeAt) dto.lastChangeAt = st.lastChangeAt;
    const reason = this.offReason(tournamentId);
    if (reason) dto.offReason = reason;
    const issue = this.engine.bracketIssue(tournamentId);
    if (issue) dto.warning = issue;
    const formats = [...new Set(Object.values(t.roundInfo ?? {}).map((r) => r.format).filter((f) => f !== 'knockout'))];
    if (formats.length) dto.format = formats.includes('team') ? 'team' : 'round-robin';
    return dto;
  }

  /** Бүх devjee тэмцээний төлөв: автомат sync асаалттай нь эхэндээ, дараа нь шинэ огноогоор. */
  allStatuses(): DevjeeSyncStatusDto[] {
    return [...this.states.keys()]
      .filter((id) => this.engine.state.tournaments.has(id))
      .map((id) => this.status(id))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.date.localeCompare(a.date));
  }

  /** Бүх давталтыг зогсооно (дахин асахгүй) — сервер унтрах, бичих эрхээ алдах үед. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.importTimer) clearInterval(this.importTimer);
    if (this.importKick) clearTimeout(this.importKick);
    this.timer = null;
    this.importTimer = null;
    this.importKick = null;
  }
}

/** Тэмцээний бүртгэлийн цолын кодыг манай цол болгоно (импортод хэрэглэнэ). */
export const titleOfCode = titleFromCode;
