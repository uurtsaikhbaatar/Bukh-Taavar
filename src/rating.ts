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

/**
 * А бөх Б бөхийг давах магадлал (Elo логистик, 400) — РЕЙТИНГИЙН ШИНЭЧЛЭЛД (devjee масштаб).
 * Таамаглалд `predictProbability`-г хэрэглэ (калибровкдсон).
 */
export function winProbability(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / ELO_SCALE));
}

/**
 * Таамгийн загвар (2026-10-03, `scripts/model-research.ts`): архивын 247 099 барилдааныг
 * он цагаар гүйж (look-ahead хаалттай), «өнгөрсөн бүх он → дараагийн он» байдлаар
 * 2023/2024/2025/2026 дээр тус тусад нь шалгасан logistic — log-loss 0.5029 → 0.4920
 * (он бүрд сайжирсан; өмнөх калибровк 0.5186 → 0.5044-ийн дээр). Жинг бүх өгөгдлөөр
 * дахин тохируулсан.
 *
 *   Δ = (R_A − R_B)/400, R = ТААМГИЙН (хурдан, K=64) рейтинг — devjee-ийн K=32 рейтинг
 *       таамагт хэт удаан; хурдан рейтинг байхгүй бол үндсэн рейтинг.
 *   z = (DR + R1·[1-р даваа] + LATE·[4+ даваа] + BIG·[улсын наадам])·Δ
 *     + EXP·ln((1+g_A)/(1+g_B)) + REST·ln((1+d_A)/(1+d_B))
 *     + AGE·(нас_A − нас_B)/10 + AGEQ·((нас_A−27)² − (нас_B−27)²)/100
 *
 * g = өмнөх барилдааны тоо, d = сүүлд барилдснаас хойшх хоног (≤3 жил). Нас: ижил
 * рейтингтэй бол залуу нь давуу (рейтинг өсөлтөөс хоцордог). 1-р даваанд фаворит илүү
 * найдвартай (сонгож авсан хос), хожуу даваанд бага; улсын наадамд илүү. Мэдээлэл
 * дутуу гишүүнийг тэнцүү гэж үзнэ. Дэлгэцийн рейтинг K=32 (devjee масштаб) хэвээр.
 */
export const PREDICT_WEIGHTS = {
  dr: 1.5781,
  round1: 0.1501,
  late: -0.2018,
  big: 0.4766,
  experience: 0.3629,
  rest: -0.0953,
  age: -0.4395,
  ageQ: -0.0382,
} as const;
export const REST_CAP_DAYS = 1095;
/** Таамгийн (хурдан) рейтингийн K — зөвхөн таамагт; дэлгэцийн рейтинг DEFAULT_K. */
export const FAST_K = 64;
export const LATE_ROUND = 4;
export const AGE_PEAK = 27;
/** devjee-ийн тэмцээний төрөл (TOURNAMENT_TYPES[1]) — таамагт «улсын наадам». */
export const BIG_TOURNAMENT_KIND = 'Улсын наадам';

export interface PredictSide {
  /** Үндсэн (дэлгэцийн, K=32) рейтинг. */
  rating: number;
  /** Таамгийн (хурдан, K=64) рейтинг — байхгүй бол `rating`. */
  fast?: number;
  /** Өмнөх (бодит) барилдааны тоо. */
  games?: number;
  /** Сүүлд барилдснаас хойшх хоног. */
  daysSinceLast?: number;
  /** Нас (жилээр). */
  age?: number;
}

export interface PredictContext {
  /** Даваа (1-ээс). */
  round?: number;
  /** Улсын наадам эсэх. */
  big?: boolean;
}

/** Төрсөн огнооноос нас; «1900-01-01» (мэдэгдэхгүйн тэмдэг) ба 14–65-аас гадуурхийг мэдэгдэхгүй гэж үзнэ. */
export function ageFromBirthDate(birthDate: string | undefined, at: Date | number): number | undefined {
  if (!birthDate || birthDate.startsWith('1900-01-01')) return undefined;
  const b = Date.parse(birthDate);
  if (!Number.isFinite(b)) return undefined;
  const age = ((typeof at === 'number' ? at : at.getTime()) - b) / (365.25 * 86_400_000);
  return age >= 14 && age <= 65 ? age : undefined;
}

export function predictProbability(a: PredictSide, b: PredictSide, ctx: PredictContext = {}): number {
  const W = PREDICT_WEIGHTS;
  let slope = W.dr;
  if (ctx.round === 1) slope += W.round1;
  else if (ctx.round !== undefined && ctx.round >= LATE_ROUND) slope += W.late;
  if (ctx.big) slope += W.big;
  let z = (slope * ((a.fast ?? a.rating) - (b.fast ?? b.rating))) / ELO_SCALE;
  if (a.games !== undefined && b.games !== undefined) {
    z += W.experience * Math.log((1 + Math.max(0, a.games)) / (1 + Math.max(0, b.games)));
  }
  if (a.daysSinceLast !== undefined && b.daysSinceLast !== undefined) {
    const da = Math.min(Math.max(0, a.daysSinceLast), REST_CAP_DAYS);
    const db = Math.min(Math.max(0, b.daysSinceLast), REST_CAP_DAYS);
    z += W.rest * Math.log((1 + da) / (1 + db));
  }
  if (a.age !== undefined && b.age !== undefined) {
    z += (W.age * (a.age - b.age)) / 10 + (W.ageQ * ((a.age - AGE_PEAK) ** 2 - (b.age - AGE_PEAK) ** 2)) / 100;
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * Монгол бөхийн тэмцээний хүрээ: бүртгэл 32, 64, 128, 256, 512, 1024 (= 5–10 даваа).
 * Тэмцээн 1-2 бөхөөр хэзээ ч дуусдаггүй — ийм бол бүртгэл/өгөгдөл дутуу (алдаа).
 */
export const BRACKET_SIZES = [32, 64, 128, 256, 512, 1024] as const;
export const MIN_BRACKET = 32;
export const MIN_BRACKET_ROUNDS = 5;

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
