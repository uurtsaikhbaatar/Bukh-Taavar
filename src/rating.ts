/**
 * Рейтинг: Elo (K = 32, 400 масштаб — devjee.mn-ийн системтэй ижил) ба
 * түүхгүй бөхийн суурь рейтинг.
 *
 * Цолын код 1–21 нь devjee.mn-ийн кодтой ижил (0 = цолгүй, манайх).
 *
 * Суурь рейтинг (2026-10-11): архивын Elo бүх бөхийг 1300-аас эхлүүлдэг, таамгийн загвар
 * ч тэгж сурсан. Өмнө нь түүхгүй бөхөд цолоор 1450–2300 өгдөг байсан нь devjee-ийн
 * топ-500-ийн тархалтаас авсан бүдүүвч тоо — архивт анх удаа барилдсан 20 484 барилдаан
 * дээр (2022–2026, «өмнөх онууд → дараагийн он») log-loss 0.381, тогтмол 1300 нь 0.343.
 * Цолоор нарийвчлах нь зөвхөн цэргийн/аймгийн цолтой шинэ бөхөд тогтвортой ашигтай
 * (+120…+160; тэд 36–42% давдаг, цолгүй шинэ бөх 9%) — тэр хэсгийг л үлдээв.
 */

export const DEFAULT_K = 32;
export const ELO_SCALE = 400;
/** Түүхгүй бөхийн суурь рейтинг = архивын Elo-гийн эхлэл (devjee масштаб). */
export const BASE_RATING = 1300;

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
  { code: 0, key: 'цолгүй', label: 'Цолгүй', short: '', level: 'none', seed: 1300 },
  { code: 1, key: 'залуу_бөх', label: 'Залуу бөх', short: 'з.б', level: 'sum', seed: 1300 },
  { code: 2, key: 'сумын_начин', label: 'Сумын начин', short: 'с.н', level: 'sum', seed: 1300 },
  { code: 3, key: 'сумын_харцага', label: 'Сумын харцага', short: 'с.х', level: 'sum', seed: 1300 },
  { code: 4, key: 'сумын_заан', label: 'Сумын заан', short: 'с.з', level: 'sum', seed: 1300 },
  { code: 5, key: 'цэргийн_начин', label: 'Цэргийн начин', short: 'ц.н', level: 'tsereg', seed: 1420 },
  { code: 6, key: 'цэргийн_харцага', label: 'Цэргийн харцага', short: 'ц.х', level: 'tsereg', seed: 1420 },
  { code: 7, key: 'цэргийн_заан', label: 'Цэргийн заан', short: 'ц.з', level: 'tsereg', seed: 1420 },
  { code: 8, key: 'цэргийн_арслан', label: 'Цэргийн арслан', short: 'ц.а', level: 'tsereg', seed: 1420 },
  { code: 9, key: 'аймгийн_начин', label: 'Аймгийн начин', short: 'а.н', level: 'aimag', seed: 1450 },
  { code: 10, key: 'аймгийн_харцага', label: 'Аймгийн харцага', short: 'а.х', level: 'aimag', seed: 1450 },
  { code: 11, key: 'аймгийн_заан', label: 'Аймгийн заан', short: 'а.з', level: 'aimag', seed: 1450 },
  { code: 12, key: 'аймгийн_арслан', label: 'Аймгийн арслан', short: 'а.а', level: 'aimag', seed: 1450 },
  { code: 13, key: 'улсын_начин', label: 'Улсын начин', short: 'у.н', level: 'uls', seed: 1450 },
  { code: 14, key: 'улсын_харцага', label: 'Улсын харцага', short: 'у.х', level: 'uls', seed: 1450 },
  { code: 15, key: 'улсын_заан', label: 'Улсын заан', short: 'у.з', level: 'uls', seed: 1450 },
  { code: 16, key: 'улсын_гарьд', label: 'Улсын гарьд', short: 'у.г', level: 'uls', seed: 1450 },
  { code: 17, key: 'улсын_арслан', label: 'Улсын арслан', short: 'у.ар', level: 'uls', seed: 1450 },
  { code: 18, key: 'улсын_аварга', label: 'Улсын аварга', short: 'у.ав', level: 'uls', seed: 1450 },
  { code: 19, key: 'далай_аварга', label: 'Далай аварга', short: 'дал.а', level: 'uls', seed: 1450 },
  { code: 20, key: 'даян_аварга', label: 'Даян аварга', short: 'дая.а', level: 'uls', seed: 1450 },
  { code: 21, key: 'дархан_аварга', label: 'Дархан аварга', short: 'дар.а', level: 'uls', seed: 1450 },
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

/** Архивт түүхгүй бөхийн суурь рейтинг: 1300; цэргийн цолтой 1420, аймаг/улсын цолтой 1450. */
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
 * Таамгийн загвар v4 (2026-10-12, `scripts/model-research2.ts --fine`). Архивын 249 144
 * барилдааныг он цагаар гүйж (look-ahead хаалттай), «өнгөрсөн бүх он → дараагийн он» байдлаар
 * 2020…2026 долоон онд тус тусад нь шалгасан logistic: log-loss 0.4929 (v3) → 0.4849, долоон
 * онд бүгдэд нь сайжирсан. Жинг 2015 оноос хойших өгөгдлөөр тохируулсан (`--final`): бүх оноор
 * сургасантай log-loss ижил боловч калибровк сайн (фаворитын таамаг − бодит: −1.0 → −0.4 нэгж
 * хувь) — эртний цөөн тэмцээний үе өнөөгийн барилдааныг төлөөлөхгүй.
 *
 *   Δ = (R_A − R_B)/400, R = ТААМГИЙН рейтинг (доорх `fastK` — шинэ бөхөд хурдан сурдаг);
 *       байхгүй бол үндсэн (дэлгэцийн, K=32) рейтинг.
 *   z = (DR + LATE·[шигшээ 4+ даваа] + LOCAL·[аймгийн баяр наадам])·Δ
 *     + EXP·ln((1+g_A)/(1+g_B)) + EXP20·ln((20+g_A)/(20+g_B))
 *     + REST·ln((1+d_A)/(1+d_B))
 *     + AGE·(нас_A − нас_B)/10 + AGEQ·((нас_A−27)² − (нас_B−27)²)/100
 *
 * g = өмнөх барилдааны тоо, d = сүүлд барилдснаас хойшх хоног (≤3 жил). Мэдээлэл дутуу
 * гишүүнийг тэнцүү гэж үзнэ. Дэлгэцийн рейтинг K=32 (devjee масштаб) хэвээр.
 *
 * v3-аас юу өөрчлөгдсөн бэ (2020 оноос хойших 598 тэмцээний аудит, `scripts/model-audit.mjs`):
 *  - Цөөн барилдсан бөхийг системтэй буруу үнэлдэг байв: өмнө 1–5 барилдсан бөхөд загвар
 *    20–50% өгөхөд бодитоор 24% л давсан. Шалтгаан нь хоёр: рейтинг нь K=64-өөр удаан сурдаг,
 *    туршлагын ганц лог гишүүн эхний хэдэн барилдааны огцом нөлөөг барьдаггүй.
 *    → K шинэ бөхөд их (`fastK`), туршлага хоёр гишүүнтэй (эхний барилдаанууд илүү жинтэй:
 *    0→5 барилдаан +1.20 logit, 50→500 нь +0.35).
 *  - Рейтинг зөв сурч эхэлмэгц «1-р даваанд фаворит найдвартай» ба «улсын наадам» гэсэн v3-ийн
 *    налуугийн засварууд хэрэггүй болсон (жин ≈ 0) — тэд шинэ бөхийн буруу рейтингийн
 *    орлуулагч байжээ. Хассан.
 *  - Аймгийн баяр наадамд фаворит бага найдвартай (LOCAL): v3 тэнд +1.8 нэгж хувиар хэт
 *    итгэлтэй байв (devjee-д түүх багатай нутгийн бөхчүүд).
 *  - Шалгаад ХАССАН (нэмэр ≈ 0): нийтийн дээд хязгаар, тэмцээний хэмжээ, финал/хагас шигшээ
 *    шатны налуу, сумын цолтон/залуусын төрөл, өрсөлдөгчийн тодорхойгүй байдлаар сааруулах.
 */
export const PREDICT_WEIGHTS = {
  dr: 2.0238,
  late: -0.2402,
  local: -0.633,
  experience: 0.7525,
  experience20: -0.6809,
  rest: -0.0351,
  age: -0.3335,
  ageQ: -0.0819,
} as const;
export const REST_CAP_DAYS = 1095;
export const LATE_ROUND = 4;
export const AGE_PEAK = 27;
/** devjee-ийн тэмцээний төрөл (TOURNAMENT_TYPES[34]) — таамагт «аймгийн баяр наадам». */
export const LOCAL_NAADAM_KIND = 'Аймгийн баяр наадам';

/**
 * Таамгийн рейтингийн K — бөхийн ӨӨРИЙН өмнөх барилдааны тооноос хамаарна:
 *   K(g) = 32·(1 + 3·20/(20 + g)) → шинэ бөх 128, 20 барилдааны дараа 80, 180-ын дараа 42,
 *   олон жилийн бөхөд devjee-ийн K = 32 руу дөхнө.
 * Шинэ бөхийн тухай мэдээлэл бага тул үр дүн бүр нь их жинтэй (шатрын «түр рейтинг», Glicko-ийн
 * санаа). Тэгш K=64-тэй харьцуулахад долоон оны долоод сайжирсан; тойргийн барилдаанд (бүгд
 * шинэ бөх) мэдээлэл хурдан хуримтлагдана. Зөвхөн таамагт; дэлгэцийн рейтинг DEFAULT_K.
 */
export const FAST_K = 32;
export const FAST_K_BOOST = 3;
export const FAST_K_TAU = 20;

export function fastK(games: number | undefined): number {
  const g = Math.max(0, games ?? 0);
  return FAST_K * (1 + (FAST_K_BOOST * FAST_K_TAU) / (FAST_K_TAU + g));
}

/**
 * Таамгийн рейтингийн шинэчлэл: [шинэ А, шинэ Б]. Тал бүр өөрийн K-тэй тул тэг нийлбэр БИШ
 * (шинэ бөх их хөдөлнө, туршлагатай өрсөлдөгч нь бага).
 */
export function updateFast(fastA: number, fastB: number, aWon: boolean, gamesA: number | undefined, gamesB: number | undefined): [number, number] {
  const surprise = (aWon ? 1 : 0) - winProbability(fastA, fastB);
  return [fastA + fastK(gamesA) * surprise, fastB - fastK(gamesB) * surprise];
}

export interface PredictSide {
  /** Үндсэн (дэлгэцийн, K=32) рейтинг. */
  rating: number;
  /** Таамгийн рейтинг (`fastK`) — байхгүй бол `rating`. */
  fast?: number;
  /** Өмнөх (бодит) барилдааны тоо. */
  games?: number;
  /** Сүүлд барилдснаас хойшх хоног. */
  daysSinceLast?: number;
  /** Нас (жилээр). */
  age?: number;
}

export interface PredictContext {
  /** Шигшээ хүрээний даваа (1-ээс); тойргийн/багийн даваанд өгөхгүй. */
  round?: number;
  /** Аймгийн баяр наадам эсэх. */
  local?: boolean;
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
  if (ctx.round !== undefined && ctx.round >= LATE_ROUND) slope += W.late;
  if (ctx.local) slope += W.local;
  let z = (slope * ((a.fast ?? a.rating) - (b.fast ?? b.rating))) / ELO_SCALE;
  if (a.games !== undefined && b.games !== undefined) {
    const ga = Math.max(0, a.games);
    const gb = Math.max(0, b.games);
    z += W.experience * Math.log((1 + ga) / (1 + gb)) + W.experience20 * Math.log((20 + ga) / (20 + gb));
  }
  if (a.daysSinceLast !== undefined && b.daysSinceLast !== undefined) {
    const da = Math.min(Math.max(0, a.daysSinceLast), REST_CAP_DAYS);
    const db = Math.min(Math.max(0, b.daysSinceLast), REST_CAP_DAYS);
    z += W.rest * Math.log((1 + da) / (1 + db));
  }
  if (a.age !== undefined && b.age !== undefined) {
    z += (W.age * (a.age - b.age)) / 10 + (W.ageQ * ((a.age - AGE_PEAK) ** 2 - (b.age - AGE_PEAK) ** 2)) / 100;
  }
  const p = 1 / (1 + Math.exp(-z));
  // Аль нэг тал нь анх удаа барилдаж буй бол итгэлийг хязгаарлана (доорх NEWCOMER_CAP)
  if (a.games === 0 || b.games === 0) return Math.min(NEWCOMER_CAP, Math.max(1 - NEWCOMER_CAP, p));
  return p;
}

/**
 * Түүхгүй бөхтэй барилдааны таамгийн дээд хязгаар. Архивт нэг тал нь анх удаа барилдсан
 * 6 139 барилдаанд (2022–2026) загвар 99–99.9% гэсэн үед фаворит бодитоор 97.4–98.0% давсан
 * — мэдэхгүй бөхийн эсрэг 99.9% гэх үндэсгүй. 97.5%-иар хязгаарлахад log-loss 0.3249 → 0.3223.
 */
export const NEWCOMER_CAP = 0.975;

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
