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
import type { Wrestler } from './domain.ts';
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
  /** 2026-09 сайтын шинэчлэлийн API — тэмцээний төлөвийн snapshot энд. */
  api: 'https://api.devjee.mn',
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
   * Эх сурвалж 2: 2026-09 сайтын шинэчлэлээс хойш төлөв `api.devjee.mn`-ийн snapshot
   * дээр (ижил zlib+base64 `data`), хуучин `states3` баримтууд хоосорсон/устсан байж
   * болзошгүй → эхлээд snapshot, бүтэлгүйтвэл (эсвэл хоосон бол) states3.
   */
  async tournamentState(tid: string, ttlMs = 10 * 60_000): Promise<{ state: DevjeeTournamentState; timestamp?: string; actionId?: string }> {
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
