/**
 * LMSR — Logarithmic Market Scoring Rule (Hanson, 2003).
 *
 * Автомат зах зээл үүсгэгч: n үр дүнтэй зах зээлд `q[i]` = i-р үр дүнгийн
 * гаргасан хувийн (share) тоо. Хувь бүр тухайн үр дүн биелбэл 1 токен төлнө.
 *
 *   C(q)  = b · ln Σ exp(q_i / b)          — өртгийн функц
 *   p_i   = exp(q_i / b) / Σ exp(q_j / b)   — үнэ = магадлал (нийлбэр 1)
 *   Δ хувь авах өртөг = C(q + Δ·e_i) − C(q) = b · ln(1 + p_i · (e^{Δ/b} − 1))
 *   Хаусын хамгийн их алдагдал = b · ln n
 *
 * `b` = хөрвөх чадварын параметр: том b → үнэ удаан хөдөлнө, хаусын татаас их.
 * Жишээ (2 үр дүн, 50/50): b=1000-д 275 токен → 62%, 1000 токен → 82%;
 * b=2000-д 1000 токен → 70%.
 *
 * Бүх томьёо log-орон зайд (log-sum-exp, log1p, expm1) бичигдсэн тул маш том
 * бооцоо, маш жижиг магадлал (underflow) ч Infinity/NaN гаргахгүй.
 */

const MIN_PROB = 1e-9;

export class LmsrError extends Error {}

function assertB(b: number): void {
  if (!Number.isFinite(b) || b <= 0) throw new LmsrError('b эерэг тоо байх ёстой.');
}

function assertQ(q: readonly number[]): void {
  if (q.length < 2) throw new LmsrError('Дор хаяж 2 үр дүн хэрэгтэй.');
  for (const x of q) if (!Number.isFinite(x)) throw new LmsrError('q дотор төгсгөлгүй тоо байна.');
}

function assertIndex(q: readonly number[], i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= q.length) throw new LmsrError('Үр дүнгийн индекс буруу.');
}

/** ln Σ exp(x_i) — хамгийн том утгаар шилжүүлж тооцно (overflow-гүй). */
export function logSumExp(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** ln(e^y − 1), y > 0 — тогтвортой. */
function logExpm1(y: number): number {
  return y < 1 ? Math.log(Math.expm1(y)) : y + Math.log1p(-Math.exp(-y));
}

/** Өртгийн функц C(q). */
export function cost(q: readonly number[], b: number): number {
  assertB(b);
  assertQ(q);
  return b * logSumExp(q.map((x) => x / b));
}

/** ln p_i бүр (log-үнэ) — underflow-гүй. */
export function logPrices(q: readonly number[], b: number): number[] {
  assertB(b);
  assertQ(q);
  const xs = q.map((x) => x / b);
  const lse = logSumExp(xs);
  return xs.map((x) => x - lse);
}

/** Одоогийн үнэ = магадлал бүр. Нийлбэр нь яг 1 (тоймлолтын дотор). */
export function prices(q: readonly number[], b: number): number[] {
  return logPrices(q, b).map((lp) => Math.exp(lp));
}

/**
 * i-р үр дүнгийн `shares` хувийг авах (shares > 0) эсвэл зарах (shares < 0)
 * өртөг. Зарах үед сөрөг тоо буцна = хэрэглэгчид өгөх токен.
 */
export function costToBuy(q: readonly number[], b: number, i: number, shares: number): number {
  assertB(b);
  assertQ(q);
  assertIndex(q, i);
  if (!Number.isFinite(shares)) throw new LmsrError('Хувийн тоо төгсгөлгүй байна.');
  if (shares === 0) return 0;
  const lp = logPrices(q, b)[i]!;
  const x = shares / b;
  if (x < 0) {
    // ln(1 + p·(e^x − 1)); expm1(x) ∈ (−1, 0) → log1p тогтвортой.
    return b * Math.log1p(Math.exp(lp) * Math.expm1(x));
  }
  // x > 0: ln(1 + p(e^x − 1)) = x + ln(e^{−x} + p·(1 − e^{−x}))
  return b * (x + logSumExp([-x, lp + Math.log1p(-Math.exp(-x))]));
}

/**
 * `spend` токеноор i-р үр дүнгийн хэдэн хувь авахыг тооцно (costToBuy-ийн урвуу).
 *
 *   Δ = b · [ln(e^{S/b} − 1 + p_i) − ln p_i]
 */
export function sharesForSpend(q: readonly number[], b: number, i: number, spend: number): number {
  assertB(b);
  assertQ(q);
  assertIndex(q, i);
  if (!Number.isFinite(spend) || spend <= 0) throw new LmsrError('Зарцуулалт эерэг байх ёстой.');
  const lp = logPrices(q, b)[i]!;
  const y = spend / b;
  return b * (logSumExp([logExpm1(y), lp]) - lp);
}

/**
 * Анхны магадлалаас q векторыг үүсгэнэ: q_i = b · ln p_i.
 * Магадлалыг нийлбэр 1 болгож хэвийн болгоно; 0-ийг MIN_PROB болгож өргөнө.
 */
export function initialQuantities(probs: readonly number[], b: number): number[] {
  assertB(b);
  if (probs.length < 2) throw new LmsrError('Дор хаяж 2 үр дүн хэрэгтэй.');
  const clipped = probs.map((p) => {
    if (!Number.isFinite(p) || p < 0) throw new LmsrError('Магадлал 0-ээс их байх ёстой.');
    return Math.max(p, MIN_PROB);
  });
  const s = clipped.reduce((a, c) => a + c, 0);
  return clipped.map((p) => b * Math.log(p / s));
}

/** Хаусын хамгийн их алдагдлын дээд хязгаар — ЖИГД анхны магадлалтай үед: b · ln n. */
export function maxLoss(n: number, b: number): number {
  assertB(b);
  if (!Number.isInteger(n) || n < 2) throw new LmsrError('n ≥ 2 байх ёстой.');
  return b * Math.log(n);
}

/**
 * Хаусын хамгийн их алдагдал — дурын анхны q0-оос: max_i [C(q0) − q0_i]
 * (= b · ln(1/p0_i), хамгийн бага магадлалтай үр дүн биелэх үед).
 * Жигд бол b·ln n-тэй давхцана.
 */
export function maxLossFromInitial(q0: readonly number[], b: number): number {
  const c = cost(q0, b);
  let min = Infinity;
  for (const x of q0) if (x < min) min = x;
  return c - min;
}
