/**
 * Рейтинг: Elo (K = 32, 400 масштаб — devjee.mn-ийн системтэй ижил) ба
 * цолын суурь рейтинг (devjee рейтинг мэдэгдэхгүй бөхөд анхны утга).
 *
 * Цолын код 1–21 нь devjee.mn-ийн кодтой ижил (0 = цолгүй, манайх).
 * Суурь рейтингүүд нь devjee-ийн 2026-07 топ-500 тархалтаас гаргасан бүдүүвч
 * тооцоо — тохируулж болно; бодит бөхөд devjee рейтинг үргэлж давуу.
 */

export const DEFAULT_K = 32;
export const ELO_SCALE = 400;

export type TitleLevel = 'none' | 'sum' | 'tsereg' | 'aimag' | 'uls';

export interface TitleInfo {
  readonly code: number;
  readonly key: Title;
  readonly label: string;
  /** devjee-ийн товчлол (з.б, у.ар, дар.а …). */
  readonly short: string;
  readonly level: TitleLevel;
  readonly seed: number;
}

export type Title =
  | 'цолгүй'
  | 'залуу_бөх'
  | 'сумын_начин'
  | 'сумын_харцага'
  | 'сумын_заан'
  | 'цэргийн_начин'
  | 'цэргийн_харцага'
  | 'цэргийн_заан'
  | 'цэргийн_арслан'
  | 'аймгийн_начин'
  | 'аймгийн_харцага'
  | 'аймгийн_заан'
  | 'аймгийн_арслан'
  | 'улсын_начин'
  | 'улсын_харцага'
  | 'улсын_заан'
  | 'улсын_гарьд'
  | 'улсын_арслан'
  | 'улсын_аварга'
  | 'далай_аварга'
  | 'даян_аварга'
  | 'дархан_аварга';

export const TITLES: readonly TitleInfo[] = [
  { code: 0, key: 'цолгүй', label: 'Цолгүй', short: '', level: 'none', seed: 1450 },
  { code: 1, key: 'залуу_бөх', label: 'Залуу бөх', short: 'з.б', level: 'sum', seed: 1500 },
  { code: 2, key: 'сумын_начин', label: 'Сумын начин', short: 'с.н', level: 'sum', seed: 1550 },
  { code: 3, key: 'сумын_харцага', label: 'Сумын харцага', short: 'с.х', level: 'sum', seed: 1600 },
  { code: 4, key: 'сумын_заан', label: 'Сумын заан', short: 'с.з', level: 'sum', seed: 1650 },
  { code: 5, key: 'цэргийн_начин', label: 'Цэргийн начин', short: 'ц.н', level: 'tsereg', seed: 1800 },
  { code: 6, key: 'цэргийн_харцага', label: 'Цэргийн харцага', short: 'ц.х', level: 'tsereg', seed: 1850 },
  { code: 7, key: 'цэргийн_заан', label: 'Цэргийн заан', short: 'ц.з', level: 'tsereg', seed: 1900 },
  { code: 8, key: 'цэргийн_арслан', label: 'Цэргийн арслан', short: 'ц.а', level: 'tsereg', seed: 1950 },
  { code: 9, key: 'аймгийн_начин', label: 'Аймгийн начин', short: 'а.н', level: 'aimag', seed: 1800 },
  { code: 10, key: 'аймгийн_харцага', label: 'Аймгийн харцага', short: 'а.х', level: 'aimag', seed: 1850 },
  { code: 11, key: 'аймгийн_заан', label: 'Аймгийн заан', short: 'а.з', level: 'aimag', seed: 1900 },
  { code: 12, key: 'аймгийн_арслан', label: 'Аймгийн арслан', short: 'а.а', level: 'aimag', seed: 1950 },
  { code: 13, key: 'улсын_начин', label: 'Улсын начин', short: 'у.н', level: 'uls', seed: 1950 },
  { code: 14, key: 'улсын_харцага', label: 'Улсын харцага', short: 'у.х', level: 'uls', seed: 2000 },
  { code: 15, key: 'улсын_заан', label: 'Улсын заан', short: 'у.з', level: 'uls', seed: 2050 },
  { code: 16, key: 'улсын_гарьд', label: 'Улсын гарьд', short: 'у.г', level: 'uls', seed: 2100 },
  { code: 17, key: 'улсын_арслан', label: 'Улсын арслан', short: 'у.ар', level: 'uls', seed: 2150 },
  { code: 18, key: 'улсын_аварга', label: 'Улсын аварга', short: 'у.ав', level: 'uls', seed: 2200 },
  { code: 19, key: 'далай_аварга', label: 'Далай аварга', short: 'дал.а', level: 'uls', seed: 2300 },
  { code: 20, key: 'даян_аварга', label: 'Даян аварга', short: 'дая.а', level: 'uls', seed: 2300 },
  { code: 21, key: 'дархан_аварга', label: 'Дархан аварга', short: 'дар.а', level: 'uls', seed: 2300 },
];

const BY_KEY = new Map<string, TitleInfo>(TITLES.map((t) => [t.key, t]));
const BY_CODE = new Map<number, TitleInfo>(TITLES.map((t) => [t.code, t]));

export function isTitle(value: string): value is Title {
  return BY_KEY.has(value);
}

export function titleInfo(title: Title): TitleInfo {
  const info = BY_KEY.get(title);
  if (!info) throw new Error(`Танигдаагүй цол: ${title}`);
  return info;
}

/** devjee-ийн цолын код (1–21) → манай цол. Танигдаагүй код → 'цолгүй'. */
export function titleFromCode(code: number | string | null | undefined): Title {
  const n = typeof code === 'string' ? Number(code) : code;
  if (n === null || n === undefined || !Number.isInteger(n)) return 'цолгүй';
  return BY_CODE.get(n)?.key ?? 'цолгүй';
}

export function titleLabel(title: Title): string {
  return titleInfo(title).label;
}

/** Цолын дарааллын эрэмбэ — их = өндөр цол. */
export function titleRank(title: Title): number {
  return titleInfo(title).code;
}

/** Рейтинг мэдэгдэхгүй бөхийн анхны (суурь) рейтинг — цолоор. */
export function seedRating(title: Title): number {
  return titleInfo(title).seed;
}

/** А бөх Б бөхийг давах магадлал (Elo логистик). */
export function winProbability(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / ELO_SCALE));
}

/**
 * Барилдааны дараах рейтинг: [шинэ А, шинэ Б]. Тэг нийлбэр.
 * devjee.mn: K = 32 (хос бичлэгээр баталгаажсан).
 */
export function updateRatings(
  ratingA: number,
  ratingB: number,
  aWon: boolean,
  k: number = DEFAULT_K,
): [number, number] {
  const expectedA = winProbability(ratingA, ratingB);
  const scoreA = aWon ? 1 : 0;
  const delta = k * (scoreA - expectedA);
  return [ratingA + delta, ratingB - delta];
}
