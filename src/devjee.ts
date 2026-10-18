/**
 * devjee.mn — Үндэсний бөхийн мэдээллийн сангийн нээлттэй API-ийн клиент.
 *
 * Зөвхөн УНШИНА. Хөнгөн хэрэглээний зарчим:
 *  - файлын кэш (анхдагч 6 цаг) — ижил хүсэлтийг давтахгүй;
 *  - хүсэлт хоорондын хамгийн бага завсар (анхдагч 400 мс);
 *  - зөвхөн хэрэгтэй зүйлээ (тэмцээний өдөр, бүртгэлтэй бөх) татна.
 *
 * Эх сурвалж/бүтэц: Обсидиан «22. Монгол бөхийн таавар/Inputs/devjee.mn — сайтын судалгаа».
 * API баримтжаагүй тул хэлбэр өөрчлөгдвөл энд л засна.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { placeName, sumName } from './devjee-places.ts';
import type { RoundFormat, RoundInfo, Wrestler } from './domain.ts';
import { titleFromCode, winProbability, type Title } from './rating.ts';

// ───────────────────────── API-ийн хэлбэрүүд ─────────────────────────

export interface DevjeeWrestler {
  id: string;
  firstName: string;
  lastName: string;
  title: string | number;
  aimag: string | number;
  sum?: string | number;
  khoroo?: string;
  dateOfBirth?: string;
  height?: string;
  weight?: string;
  devjee?: string;
  affiliations?: string;
  titleDocs?: string;
  imagePath?: string | null;
  isDeleted?: number;
  isInactive?: number;
  lastTournamentDate?: string;
  searchName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DevjeeSearchResult {
  wrestlers: DevjeeWrestler[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface DevjeeRating {
  rating: number;
  rank: number;
}

export interface DevjeeRatedMatch {
  id: number;
  wid: string;
  opponent: string;
  date: string;
  won: number | boolean;
  ratingBefore: number;
  ratingAfter: number;
}

export interface DevjeeTournament {
  id: string;
  name: string;
  date: string;
  arena?: string | null;
  location?: { aimag: number; sum: number } | null;
  type?: number[];
  rank?: number;
  leaders?: string[];
  tags?: string[];
  isOfficial?: boolean;
  isPublic?: boolean;
  wrestlersLimit?: number | null;
  registrationDeadline?: string | number | null;
}

export interface DevjeeTournamentSearch {
  tournaments: DevjeeTournament[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface DevjeeStateMatch {
  round: number;
  w1: string;
  w2: string;
  winner: 0 | 1 | 2;
  kind?: string;
  _noShow?: boolean;
  startedAt?: number;
  endedAt?: number;
}

/**
 * 2026-10 devjee-ийн шинэ формат (`tournament-state` worker-ийн `/live/{tid}/state` → `snapshot`):
 * товчилсон түлхүүртэй. `w` = бөх (o = зэрэг дэв, r = бүртгүүлсэн, u = бүртгэлээс гарсан цаг),
 * `r` = давааны массив (tags: default/round-robin/team, name, m = барилдаан). Барилдаан: w1, w2
 * (гоцод байхгүй), w = давагч 1/2 (байхгүй = болоогүй), k = хосолгооны төрлийн код (1-ээс),
 * s = эхэлсэн цаг, e = үргэлжилсэн хугацаа, n = 1 гоц (ирээгүй), b = багц, l = түгжээтэй.
 */
export interface DevjeeLiveSnapshot {
  name?: string;
  date?: string;
  isArchived?: boolean;
  isPublic?: boolean;
  isSynced?: boolean;
  wrestlersLocked?: boolean;
  tags?: string[];
  w?: Record<string, { o: number; r?: number; u?: number }>;
  r?: { name?: string; tags?: string[]; isLocked?: boolean; m?: Record<string, { w1: string; w2?: string; w?: 1 | 2; k?: number; s?: number; e?: number; n?: 1; b?: number }> }[];
}

/** Шинэ форматын хосолгооны кодууд (devjee: picked, assigned, last, drawn, team, round-robin, bye, placeholder) → манай товчлол. */
const LIVE_KINDS = ['a', 'o', 't', 's', 'b', 'g', 'y', 'd'] as const;

/**
 * Шинэ форматын snapshot-ийг хуучин `DevjeeTournamentState` болгоно — sync, архив хуучин
 * бүтцээрээ ажиллана. Бүртгэлээс гарсан (`u`) бөхийг оруулахгүй; давааны дугаар = массивын
 * индекс + 1. Match id нь тэмцээн дотор давхардвал (шинэ богино id) `id@даваа` болгоно.
 */
export function fromLiveSnapshot(s: DevjeeLiveSnapshot): DevjeeTournamentState {
  const wrestlers: DevjeeTournamentState['wrestlers'] = {};
  for (const [wid, w] of Object.entries(s.w ?? {})) {
    if (!w || w.u !== undefined) continue;
    const rec: DevjeeTournamentState['wrestlers'][string] = { id: wid, order: w.o };
    if (typeof w.r === 'number') rec.registeredAt = w.r;
    wrestlers[wid] = rec;
  }
  const rounds: DevjeeTournamentState['rounds'] = {};
  const matches: DevjeeTournamentState['matches'] = {};
  (s.r ?? []).forEach((r, i) => {
    const round = i + 1;
    const tags = r.tags ?? [];
    const type = tags.includes('round-robin') ? 'round-robin' : tags.includes('team') ? 'team' : 'default';
    const info: DevjeeTournamentState['rounds'][string] = { id: round, type };
    if (r.name) info._name = r.name;
    if (r.isLocked) info.isLocked = true;
    rounds[String(round)] = info;
    for (const [mid, m] of Object.entries(r.m ?? {})) {
      if (!m) continue;
      const out: DevjeeStateMatch = { round, w1: m.w1, w2: m.w2 ?? '', winner: m.w === 1 || m.w === 2 ? m.w : 0 };
      const kind = m.k !== undefined ? LIVE_KINDS[m.k - 1] : undefined;
      if (kind) out.kind = kind;
      if (m.n === 1) out._noShow = true;
      if (typeof m.s === 'number') out.startedAt = m.s;
      matches[mid in matches ? `${mid}@${round}` : mid] = out;
    }
  });
  const state: DevjeeTournamentState = { name: s.name ?? '', date: s.date ?? '', wrestlers, rounds, matches };
  if (s.isArchived !== undefined) state.isArchived = s.isArchived;
  if (s.isPublic !== undefined) state.isPublic = s.isPublic;
  if (s.isSynced !== undefined) state.isSynced = s.isSynced;
  if (s.wrestlersLocked !== undefined) state.wrestlersLocked = s.wrestlersLocked;
  return state;
}

export interface DevjeeTournamentState {
  name: string;
  date: string;
  rank?: number;
  types?: number[];
  wrestlers: Record<string, { id: string; order: number; registeredAt?: number }>;
  rounds: Record<string, { id: number; isLocked?: boolean; _name?: string; type?: string }>;
  matches: Record<string, DevjeeStateMatch>;
  isArchived?: boolean;
  isPublic?: boolean;
  isSynced?: boolean;
  wrestlersLocked?: boolean;
}

export interface DevjeeWrestlerTournamentEntry {
  result: number;
  summary: number[];
  tid: string;
  wid: string;
  tournament: {
    date: string;
    name: string;
    rank: number;
    type: number[];
    matches: {
      id: number;
      kind: string;
      noShow: boolean;
      round: number;
      tid: string;
      w1: string;
      w2: string;
      winner: number;
    }[];
  };
}

// ───────────────────────── толь бичгүүд (devjee enum) ─────────────────────────

export const AIMAGS: Readonly<Record<number, string>> = {
  1: 'Архангай', 2: 'Баян-Өлгий', 3: 'Баянхонгор', 4: 'Булган', 5: 'Говь-Алтай', 6: 'Говьсүмбэр',
  7: 'Дархан-Уул', 8: 'Дорноговь', 9: 'Дорнод', 10: 'Дундговь', 11: 'Завхан', 12: 'Орхон',
  13: 'Өвөрхангай', 14: 'Өмнөговь', 15: 'Сүхбаатар', 16: 'Сэлэнгэ', 17: 'Төв', 18: 'Увс',
  19: 'Улаанбаатар', 20: 'Ховд', 21: 'Хөвсгөл', 22: 'Хэнтий', 23: 'Бусад',
};

export const TOURNAMENT_TYPES: Readonly<Record<number, string>> = {
  1: 'Улсын наадам', 2: 'Цагаан сар', 3: 'Цагаан сар (сум)', 4: 'Цагаан сар (аймгийн начин)',
  5: 'Цагаан сар (аймаг, цэрэг)', 6: 'БНМАУ тунхагласны ой', 7: 'Ерөнхийлөгчийн цом', 8: 'Цэргийн наадам',
  9: 'Начин цолны хүндэтгэл', 10: 'Харцага цолны хүндэтгэл', 11: 'Заан цолны хүндэтгэл', 12: 'Гарьд цолны хүндэтгэл',
  13: 'Арслан цолны хүндэтгэл', 14: 'Аварга цолны хүндэтгэл', 15: 'Сонгинохайрхан хишиг', 16: 'Баянзүрх хишиг',
  17: 'Богдхан хишиг', 18: 'Чингэлтэй хишиг', 19: 'Хатан Туулын хишиг', 20: 'Зэвсэгт хүчний ой',
  21: 'Наурызын баяр', 22: 'Атар хэвийн боовны баяр', 23: 'Шинэ үндсэн хуулийн барилдаан', 24: 'Эх орончдын өдөр',
  25: 'Монгол бахархлын өдөр', 26: 'Ардчилсан намын ой', 27: 'Ардчилсан хувьсгалын ой', 28: 'Наадмын сорилго',
  29: 'Уяачдын наадам', 30: 'Нэрэмжит барилдаан', 31: 'Аймгийн цолтон', 32: 'Аймгийн начин', 33: 'Сумын цолтон',
  34: 'Аймгийн баяр наадам', 35: 'Орон нутгийн барилдаан', 36: 'Үндэсний алтан цом', 37: 'Ойн барилдаан',
  38: 'Цолгүй залуу бөхчүүдийн барилдаан', 39: 'Нийтийн монгол бөх', 40: 'Нийслэл Улаанбаатар хотын ой',
};

export const MATCH_KINDS: Readonly<Record<string, string>> = {
  a: 'ам', o: 'оноолт', t: 'түнээ', s: 'сугалаа', b: 'баг', g: 'тойрог', y: 'гоц', d: 'дүүргэлт', h: 'халз',
};

/** Дэвжээ (клуб) — devjee код → нэр. */
export const CLUBS: Readonly<Record<number, string>> = {
  1: 'Алдартан', 2: 'Алтайн Хүчтэн', 3: 'Бөхбилэгт', 4: 'Бөх Эрдэнэ', 5: 'Булган Хан', 6: 'Булган Хангай', 7: 'Дархан Хайрхан',
  8: 'Даян', 9: 'Дорнын Хүчтэн', 10: 'Дорнод Нутаг', 11: 'Дүнжингарав', 12: 'Говийн Хүчтэн', 13: 'Их Богд', 14: 'Их Монголын Хүчтэн',
  15: 'Их Шавь', 16: 'Жавхлант', 17: 'Женко', 18: 'Хан Хэнтийн Аварга', 19: 'Хан Хөхийн Хүчтэн', 20: 'Хантайшир', 21: 'Хонгор Нутаг',
  22: 'Ховд', 23: 'Хүчтэн', 24: 'Хур Харцага', 25: 'Хөвсгөлийн Хүчтэн', 26: 'Таван Хан', 27: 'Түшээт Ханы Аварга', 28: 'Өлгийн Хүчтэн',
  29: 'Увс Нуур', 30: 'Есөн Шөвөг', 31: 'Завхан', 32: 'Хутагтын Хүчтэн',
};

/** devjee-ийн рейтингийн Elo K (хос бичлэгээр баталгаажсан). */
export const DEVJEE_ELO_K = 32;

// ───────────────────────── хөрвүүлэлт ─────────────────────────

/** JSON текст (devjee-ийн `affiliations`, `titleDocs`) — эвдэрсэн бол []. */
function parseJsonArray(text: string | undefined): unknown[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** devjee бөх → манай бөх (id-гүй; devjeeId тавигдсан). Өндөр/жин/дэвжээ/харьяалал/цолын түүх орно. */
export function toWrestler(dw: DevjeeWrestler): Omit<Wrestler, 'id'> & { devjeeId: string } {
  const first = (dw.firstName ?? '').trim();
  const last = (dw.lastName ?? '').trim();
  const initial = last ? `${[...last][0]}.` : '';
  const title: Title = titleFromCode(dw.title);
  const out: Omit<Wrestler, 'id'> & { devjeeId: string } = {
    name: `${initial}${first}` || dw.id,
    title,
    devjeeId: dw.id,
  };
  if (last) out.fullName = `${last} ${first}`;
  const aimag = AIMAGS[Number(dw.aimag)];
  if (aimag) out.aimag = aimag;
  const sum = sumName(dw.aimag, dw.sum);
  if (sum) out.sum = sum;
  if (dw.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(dw.dateOfBirth)) out.birthDate = dw.dateOfBirth;
  const height = Number(dw.height);
  if (Number.isFinite(height) && height >= 100 && height <= 250) out.height = height;
  const weight = Number(dw.weight);
  if (Number.isFinite(weight) && weight >= 40 && weight <= 250) out.weight = weight;
  const club = CLUBS[Number(dw.devjee)];
  if (club) out.club = club;
  const affiliations = parseJsonArray(dw.affiliations).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (affiliations.length) out.affiliations = affiliations.map((x) => x.trim());
  const titles = parseJsonArray(dw.titleDocs)
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((d) => {
      const rec: NonNullable<Wrestler['titles']>[number] = {
        title: titleFromCode(d.title as string | number | undefined),
        date: String(d.fulfilledOn ?? d.date ?? ''),
      };
      if (typeof d.rounds === 'string' && d.rounds) rec.rounds = d.rounds;
      const place = placeName(d.aimag as string | number | undefined, d.sum as string | number | undefined);
      if (place) rec.place = place;
      return rec;
    })
    .filter((r) => r.title !== 'цолгүй' && r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (titles.length) out.titles = titles;
  return out;
}

/** devjee рейтингээр А-гийн Б-г давах магадлал. */
export function eloProbability(ratingA: number, ratingB: number): number {
  return winProbability(ratingA, ratingB);
}

/**
 * Рейтингтэй барилдааны бичлэгээс тухайн үеийн загварын таамгийг сэргээнэ:
 * Δ = K(S − E) → E = S − Δ/K.
 */
export function impliedExpectation(m: DevjeeRatedMatch, k: number = DEVJEE_ELO_K): number {
  const s = m.won ? 1 : 0;
  return s - (m.ratingAfter - m.ratingBefore) / k;
}

/** Firestore `states3/{tid}` баримтын шахсан `data`-г задална. */
export function inflateState(base64: string): DevjeeTournamentState {
  const buf = Buffer.from(base64, 'base64');
  const text = inflateSync(buf).toString('utf8');
  return JSON.parse(text) as DevjeeTournamentState;
}

/**
 * Монгол үндэсний бөх БИШ барилдааны нэр (devjee-ийн давааны `_name`): өвөрмонгол г.м.
 * Ийм даваанд таавар нээхгүй, үр дүнг рейтингт тооцохгүй — 2026-10-10-ны багийн тэмцээний
 * «Өвөрмонгол бөх» үед загварын 99%-ийн 25 фаворитоос 15 нь унасан (өөр төрлийн бөх).
 */
const OTHER_STYLE = /өвөр\s*-?\s*монгол|өвөрлөгч|буриад\s+бөх|халимаг\s+бөх|тува\s+бөх|чөлөөт\s+бөх|жүдо|самбо|сумо|к[үу]р[эе]ш|хүрэш/i;

export function isOtherStyle(name: string | undefined): boolean {
  return !!name && OTHER_STYLE.test(name);
}

/** devjee-ийн давааны `type` → манай хэлбэр (тэмдэглээгүй/`default` = шигшээ). */
export function roundFormat(type: string | undefined): RoundFormat {
  return type === 'round-robin' ? 'round-robin' : type === 'team' ? 'team' : 'knockout';
}

/**
 * Шигшээ биш эсвэл нэртэй даваанууд (түлхүүр = давааны дугаар). Бүх даваа ердийн шигшээ,
 * нэргүй бол undefined.
 */
export function roundInfoFromState(state: Pick<DevjeeTournamentState, 'rounds'>): Record<string, RoundInfo> | undefined {
  const out: Record<string, RoundInfo> = {};
  for (const [key, r] of Object.entries(state.rounds ?? {})) {
    const format = roundFormat(r.type);
    const name = (r._name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (format === 'knockout' && !name) continue;
    const info: RoundInfo = { format };
    if (name) info.name = name;
    if (isOtherStyle(name)) info.otherStyle = true;
    out[key] = info;
  }
  return Object.keys(out).length ? out : undefined;
}

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

/**
 * Firebase push id-ийн эхний 8 тэмдэгт = үүссэн цаг (мс). devjee-ийн snapshot-ийн `actionId`
 * нь хамгийн сүүлд орсон үйлдлийн push id тул «devjee дээрх төлөв хамгийн сүүлд хэзээ
 * өөрчлөгдсөн»-ийг үүгээр мэднэ (манай sync зогссон уу, devjee өөрөө чимээгүй байна уу гэдгийг
 * ялгахад). Push id биш бол undefined.
 */
export function pushIdTime(id: string | undefined): number | undefined {
  if (!id || id.length < 8) return undefined;
  let t = 0;
  for (let i = 0; i < 8; i++) {
    const k = PUSH_CHARS.indexOf(id[i]!);
    if (k < 0) return undefined;
    t = t * 64 + k;
  }
  // 2014–2100 оны гадна бол санамсаргүй мөр
  return t > 1.4e12 && t < 4.2e12 ? t : undefined;
}

/** Firestore REST баримт → {state, timestamp, actionId}. */
export function parseStateDocument(doc: unknown): { state: DevjeeTournamentState; timestamp?: string; actionId?: string } {
  const fields = (doc as { fields?: Record<string, Record<string, unknown>> }).fields;
  const b64 = fields?.data?.bytesValue;
  if (typeof b64 !== 'string') throw new DevjeeError('states3 баримтад data байхгүй.');
  const out: { state: DevjeeTournamentState; timestamp?: string; actionId?: string } = { state: inflateState(b64) };
  const ts = fields?.timestamp?.timestampValue;
  if (typeof ts === 'string') out.timestamp = ts;
  const aid = fields?.actionId?.stringValue;
  if (typeof aid === 'string') out.actionId = aid;
  return out;
}

// ───────────────────────── клиент ─────────────────────────

export class DevjeeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    if (status !== undefined) this.status = status;
  }
}

export interface DevjeeClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Кэшийн хавтас; null → кэшгүй. */
  cacheDir?: string | null;
  /** Кэшийн анхдагч амьдрах хугацаа (мс). */
  ttlMs?: number;
  /** Сүлжээний хүсэлт хоорондын хамгийн бага завсар (мс). */
  minIntervalMs?: number;
  /** Firestore (states3) уншихад хэрэглэх нийтийн web API key; байхгүй бол env DEVJEE_FIREBASE_KEY, эсвэл сайтаас нээнэ. */
  firebaseApiKey?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const HOSTS = {
  wrestlers: 'https://wrestlers.devjee.workers.dev',
  tournaments: 'https://tournaments.devjee.workers.dev',
  wrestlerTournaments: 'https://wrestler-tournaments.devjee.workers.dev',
  ratings: 'https://ratings.devjee.workers.dev',
  site: 'https://www.devjee.mn',
  firestore: 'https://firestore.googleapis.com/v1/projects/bukh-dd4e0/databases/(default)/documents',
  /** 2026-09 сайтын шинэчлэлийн API — тэмцээний төлөвийн snapshot энд (2026-10 хүртэл). */
  api: 'https://api.devjee.mn',
  /** 2026-10 сайтын шинэчлэлээс хойш тэмцээний амьд төлөв: `/{tid}/state`, `/{tid}/patches?after=`. */
  state: 'https://tournament-state.devjee.workers.dev/live',
} as const;

const HOUR = 3_600_000;

interface CacheRecord {
  url: string;
  at: number;
  body: unknown;
}

export class DevjeeClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cacheDir: string | null;
  private readonly ttlMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private firebaseApiKey: string | undefined;
  private lastRequestAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Статистик: хэдэн удаа сүлжээнд хандав / кэшээс авав. */
  readonly stats = { network: 0, cached: 0 };

  constructor(options: DevjeeClientOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.cacheDir = options.cacheDir === undefined ? join('data', 'cache', 'devjee') : options.cacheDir;
    this.ttlMs = options.ttlMs ?? 6 * HOUR;
    this.minIntervalMs = options.minIntervalMs ?? 400;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.firebaseApiKey = options.firebaseApiKey ?? process.env.DEVJEE_FIREBASE_KEY;
  }

  // ── кэш ──

  private cachePath(key: string): string | null {
    if (this.cacheDir === null) return null;
    const hash = createHash('sha1').update(key).digest('hex');
    return join(this.cacheDir, `${hash}.json`);
  }

  private readCache(key: string, ttlMs: number): unknown | undefined {
    const path = this.cachePath(key);
    if (path === null || !existsSync(path)) return undefined;
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8')) as CacheRecord;
      if (this.now() - rec.at > ttlMs) return undefined;
      return rec.body;
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, url: string, body: unknown): void {
    const path = this.cachePath(key);
    if (path === null) return;
    mkdirSync(this.cacheDir!, { recursive: true });
    const rec: CacheRecord = { url, at: this.now(), body };
    writeFileSync(path, JSON.stringify(rec), 'utf8');
  }

  // ── сүлжээ ──

  /** Дараалсан, завсартай сүлжээний дуудлага. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      return fn();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** JSON авах (GET эсвэл POST body-тэй), кэштэй. */
  async request<T>(url: string, init: { method?: 'GET' | 'POST'; body?: unknown; ttlMs?: number; text?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const bodyText = init.body === undefined ? '' : JSON.stringify(init.body);
    const key = `${method} ${url} ${bodyText}`;
    const ttl = init.ttlMs ?? this.ttlMs;
    const cached = this.readCache(key, ttl);
    if (cached !== undefined) {
      this.stats.cached += 1;
      return cached as T;
    }
    const result = await this.throttled(async () => {
      this.stats.network += 1;
      const res = await this.fetchFn(url, {
        method,
        headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : bodyText,
      });
      if (!res.ok) throw new DevjeeError(`devjee ${method} ${url} → HTTP ${res.status}`, res.status);
      return init.text ? ((await res.text()) as unknown) : ((await res.json()) as unknown);
    });
    this.writeCache(key, url.replace(/([?&])key=[^&]+/, '$1key=…'), result);
    return result as T;
  }

  private static qs(params: Record<string, string | number | undefined | (string | number)[]>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
      else sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  // ── бөх ──

  searchWrestlers(params: {
    name?: string;
    title?: number | number[];
    aimag?: number;
    sum?: number;
    page?: number;
    pageSize?: number;
  } = {}): Promise<DevjeeSearchResult> {
    const q = DevjeeClient.qs({
      name: params.name,
      title: params.title,
      aimag: params.aimag,
      sum: params.sum,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 100,
    });
    return this.request<DevjeeSearchResult>(`${HOSTS.wrestlers}/search${q}`, { ttlMs: 24 * HOUR });
  }

  /** Хайлтын бүх хуудсыг дараалан татна (хамгийн ихдээ maxPages). */
  async *iterateWrestlers(
    params: { name?: string; title?: number | number[]; aimag?: number; sum?: number; pageSize?: number },
    maxPages = 200,
  ): AsyncGenerator<DevjeeWrestler> {
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.searchWrestlers({ ...params, page });
      for (const w of res.wrestlers) yield w;
      if (!res.hasMore || res.wrestlers.length === 0) return;
    }
  }

  wrestler(wid: string): Promise<DevjeeWrestler> {
    return this.request<DevjeeWrestler>(`${HOSTS.wrestlers}/${encodeURIComponent(wid)}`, { ttlMs: 24 * HOUR });
  }

  fetchWrestlers(wids: string[], ttlMs = 24 * HOUR): Promise<Record<string, DevjeeWrestler>> {
    if (wids.length === 0) return Promise.resolve({});
    const sorted = [...new Set(wids)].sort();
    return this.request<Record<string, DevjeeWrestler>>(`${HOSTS.wrestlers}/fetch`, {
      method: 'POST',
      body: { wids: sorted },
      ttlMs,
    });
  }

  // ── рейтинг ──

  async ratingDates(): Promise<string[]> {
    const r = await this.request<{ dates: string[] }>(`${HOSTS.ratings}/dates`, { ttlMs: 6 * HOUR });
    return r.dates;
  }

  async ratings(date: string): Promise<Record<string, DevjeeRating>> {
    const r = await this.request<{ ratings: Record<string, DevjeeRating> }>(
      `${HOSTS.ratings}/${DevjeeClient.qs({ date })}`,
      { ttlMs: 7 * 24 * HOUR },
    );
    return r.ratings;
  }

  async latestRatings(): Promise<{ date: string; ratings: Record<string, DevjeeRating> }> {
    const dates = await this.ratingDates();
    const date = dates[dates.length - 1];
    if (!date) throw new DevjeeError('Рейтингийн огноо олдсонгүй.');
    return { date, ratings: await this.ratings(date) };
  }

  async wrestlerMatches(wid: string): Promise<DevjeeRatedMatch[]> {
    const r = await this.request<{ wid: string; matches: DevjeeRatedMatch[] }>(
      `${HOSTS.ratings}/matches/${encodeURIComponent(wid)}`,
      { ttlMs: 6 * HOUR },
    );
    return r.matches ?? [];
  }

  /**
   * Бөхийн хамгийн сүүлийн мэдэгдэж буй рейтинг: топ-500 жагсаалтад байвал тэр,
   * үгүй бол сүүлийн барилдааны ratingAfter. Юу ч олдохгүй бол undefined.
   */
  async currentRating(wid: string, latest?: Record<string, DevjeeRating>): Promise<{ rating: number; asOf: string; rank?: number } | undefined> {
    const top = latest ?? (await this.latestRatings()).ratings;
    const hit = top[wid];
    if (hit) {
      const dates = await this.ratingDates();
      return { rating: hit.rating, asOf: dates[dates.length - 1] ?? '', rank: hit.rank };
    }
    const matches = await this.wrestlerMatches(wid);
    const last = matches[0];
    if (!last) return undefined;
    return { rating: last.ratingAfter, asOf: last.date };
  }

  // ── тэмцээн ──

  tournaments(params: { year?: number; month?: number; type?: number; page?: number; limit?: number; ttlMs?: number } = {}): Promise<DevjeeTournamentSearch> {
    const q = DevjeeClient.qs({
      mode: 'synced',
      page: params.page ?? 1,
      limit: params.limit ?? 50,
      year: params.year,
      month: params.month,
      type: params.type,
    });
    return this.request<DevjeeTournamentSearch>(`${HOSTS.tournaments}/search${q}`, { ttlMs: params.ttlMs ?? 6 * HOUR });
  }

  tournament(tid: string): Promise<DevjeeTournament> {
    return this.request<DevjeeTournament>(`${HOSTS.tournaments}/${encodeURIComponent(tid)}`, { ttlMs: 6 * HOUR });
  }

  /** Нүүр хуудасны тэмцээнүүд: товлогдсон (scheduled) ба сүүлийн (home). */
  home(): Promise<{ scheduled: DevjeeTournament[]; home: DevjeeTournament[] }> {
    return this.request(`${HOSTS.tournaments}/home`, { ttlMs: 1 * HOUR });
  }

  /** Тухайн жилийн шошготой (жишээ: Наадам 2026-ийн аймгуудын наадам) тэмцээнүүд. */
  tag(year: number): Promise<DevjeeTournament[]> {
    return this.request(`${HOSTS.tournaments}/tag/${year}`, { ttlMs: 6 * HOUR });
  }

  wrestlerTournaments(wid: string, page = 1, pageSize = 10): Promise<{ entries: DevjeeWrestlerTournamentEntry[]; hasMore: boolean; page: number }> {
    const q = DevjeeClient.qs({ wid, page, pageSize });
    return this.request(`${HOSTS.wrestlerTournaments}/${q}`, { ttlMs: 6 * HOUR });
  }

  // ── тэмцээний төлөв (Firestore) ──

  /** Сайтын JS bundle-аас нийтийн Firebase web API key-г олно (7 хоног кэшлэнэ). */
  async discoverFirebaseKey(): Promise<string> {
    if (this.firebaseApiKey) return this.firebaseApiKey;
    const html = await this.request<string>(`${HOSTS.site}/`, { text: true, ttlMs: 7 * 24 * HOUR });
    const asset = html.match(/assets\/index-[\w-]+\.js/)?.[0];
    if (!asset) throw new DevjeeError('devjee.mn bundle олдсонгүй.');
    const js = await this.request<string>(`${HOSTS.site}/${asset}`, { text: true, ttlMs: 7 * 24 * HOUR });
    const key = js.match(/apiKey:"([^"]+)"/)?.[1];
    if (!key) throw new DevjeeError('Firebase key олдсонгүй.');
    this.firebaseApiKey = key;
    return key;
  }

  /**
   * Тэмцээний бүтэн төлөв: бүртгэгдсэн бөхчүүд (order = зэрэг дэв), даваанууд,
   * барилдаанууд (w1, w2, winner, kind). Амьд тэмцээнд богино TTL өг.
   *
   * Эх сурвалжууд (дарааллаар): 2026-10-оос `tournament-state.devjee.workers.dev/live/{tid}/state`
   * (шинэ товчилсон формат → `fromLiveSnapshot`; `sequence` = төлөвийн хувилбар); 2026-09-ийн
   * `api.devjee.mn` snapshot (zlib+base64 `data`); хамгийн хуучин нь Firestore `states3`.
   * 2026-10-13…18 хооронд devjee хуучин хоёрыг хаасан (404) тул импорт, sync зогссон байв.
   */
  async tournamentState(tid: string, ttlMs = 10 * 60_000): Promise<{ state: DevjeeTournamentState; timestamp?: string; actionId?: string; sequence?: number }> {
    try {
      // Амьд sync (богино TTL) бол worker-ийн кэшийг тойрч шинэ төлөв авна (сайт ч `fresh` хэрэглэдэг)
      const url = `${HOSTS.state}/${encodeURIComponent(tid)}/state${ttlMs <= 60_000 ? '?fresh' : ''}`;
      const doc = await this.request<{ snapshot?: DevjeeLiveSnapshot; sequence?: number; ok?: boolean }>(url, { ttlMs });
      if (doc && typeof doc.snapshot === 'object' && doc.snapshot && !('ok' in doc)) {
        const state = fromLiveSnapshot(doc.snapshot);
        if (Object.keys(state.wrestlers).length || Object.keys(state.matches).length) {
          const out: { state: DevjeeTournamentState; sequence?: number } = { state };
          if (typeof doc.sequence === 'number') out.sequence = doc.sequence;
          return out;
        }
      }
    } catch {
      // шинэ worker алга/алдаа → хуучин эх сурвалжууд
    }
    try {
      const doc = await this.request<{ actionId?: string; data?: string }>(`${HOSTS.api}/tournament-state/snapshot?id=${encodeURIComponent(tid)}`, { ttlMs });
      if (typeof doc?.data === 'string') {
        const state = inflateState(doc.data);
        // Хоосон төлөв = цэвэрлэгдсэн/дутуу баримт байж болно → states3-оос давхар шалгана
        if (Object.keys(state.wrestlers ?? {}).length || Object.keys(state.matches ?? {}).length) {
          const out: { state: DevjeeTournamentState; timestamp?: string; actionId?: string } = { state };
          if (typeof doc.actionId === 'string') out.actionId = doc.actionId;
          return out;
        }
      }
    } catch {
      // snapshot алга (хуучин тэмцээн г.м.) → states3
    }
    const key = await this.discoverFirebaseKey();
    const url = `${HOSTS.firestore}/states3/${encodeURIComponent(tid)}?key=${encodeURIComponent(key)}`;
    const doc = await this.request<unknown>(url, { ttlMs });
    return parseStateDocument(doc);
  }
}
