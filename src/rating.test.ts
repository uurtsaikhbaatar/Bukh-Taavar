import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_K,
  isTitle,
  PREDICT_WEIGHTS,
  predictProbability,
  seedRating,
  titleFromCode,
  titleInfo,
  titleLabel,
  titleRank,
  TITLES,
  updateRatings,
  winProbability,
} from './rating.ts';

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('winProbability: тэнцүү = 0.5, монотон, тэгш хэм', () => {
  close(winProbability(1800, 1800), 0.5);
  close(winProbability(2000, 1600), 1 / (1 + Math.pow(10, -1)));
  close(winProbability(2000, 1600) + winProbability(1600, 2000), 1);
  assert.ok(winProbability(2200, 1500) > winProbability(2100, 1500));
  // devjee-ийн бодит жишээ: 2345 vs 2174 → 0.728
  close(winProbability(2345, 2174), 0.728, 0.001);
});

test('predictProbability: калибровкдсон таамаг — тэгш хэм, туршлага/амралтын нөлөө, дутуу мэдээлэл', () => {
  // Тэнцүү талууд → 0.5; тэгш хэм
  close(predictProbability({ rating: 1800 }, { rating: 1800 }), 0.5);
  close(predictProbability({ rating: 2000, games: 50, daysSinceLast: 10 }, { rating: 1700, games: 8, daysSinceLast: 400 }) + predictProbability({ rating: 1700, games: 8, daysSinceLast: 400 }, { rating: 2000, games: 50, daysSinceLast: 10 }), 1);
  // Зөвхөн рейтинг: z = DR·Δ/400
  close(predictProbability({ rating: 2000 }, { rating: 1600 }), 1 / (1 + Math.exp(-PREDICT_WEIGHTS.dr)));
  // Туршлага их нь давуу (ижил рейтингтэй)
  assert.ok(predictProbability({ rating: 1800, games: 100 }, { rating: 1800, games: 5 }) > 0.5);
  // Удаан завсарласан нь сул (ижил рейтинг, ижил туршлага)
  assert.ok(predictProbability({ rating: 1800, games: 30, daysSinceLast: 700 }, { rating: 1800, games: 30, daysSinceLast: 7 }) < 0.5);
  // Амралтын гишүүн 3 жилээс цааш өсөхгүй (cap)
  close(
    predictProbability({ rating: 1800, games: 30, daysSinceLast: 2000 }, { rating: 1800, games: 30, daysSinceLast: 7 }),
    predictProbability({ rating: 1800, games: 30, daysSinceLast: 1095 }, { rating: 1800, games: 30, daysSinceLast: 7 }),
  );
  // Нэг талын мэдээлэл дутуу → тухайн гишүүн тооцогдохгүй (зөвхөн рейтинг)
  close(predictProbability({ rating: 2000, games: 50 }, { rating: 1600 }), predictProbability({ rating: 2000 }, { rating: 1600 }));
  // Калибровк 400-аас хурц биш — DR < ln10 (архивын хэмжилт), гэхдээ монотон
  assert.ok(predictProbability({ rating: 2200 }, { rating: 1500 }) > predictProbability({ rating: 2100 }, { rating: 1500 }));
});

test('updateRatings: K=32, тэг нийлбэр, devjee-ийн бодит хостой тохирно', () => {
  assert.equal(DEFAULT_K, 32);
  // 2026-07-10: 2345.08 vs 2174 → давсан → +8.70 / −8.70
  const [a, b] = updateRatings(2345.079, 2174.0, true);
  close(a - 2345.079, 8.7, 0.05);
  close(a + b, 2345.079 + 2174.0, 1e-9);
  // Алдвал том хасагдана
  const [c, d] = updateRatings(2158, 1738, false);
  close(2158 - c, 29.37, 0.05);
  close(d - 1738, 29.37, 0.05);
  // Өөр K
  const [e] = updateRatings(1500, 1500, true, 40);
  close(e, 1520);
});

test('цолын код ↔ цол, суурь рейтинг эрэмбэтэй', () => {
  assert.equal(TITLES.length, 22);
  assert.equal(titleFromCode(21), 'дархан_аварга');
  assert.equal(titleFromCode('20'), 'даян_аварга');
  assert.equal(titleFromCode(4), 'сумын_заан');
  assert.equal(titleFromCode(1), 'залуу_бөх');
  assert.equal(titleFromCode(99), 'цолгүй');
  assert.equal(titleFromCode(null), 'цолгүй');
  assert.equal(titleFromCode(undefined), 'цолгүй');
  assert.equal(titleLabel('улсын_арслан'), 'Улсын арслан');
  assert.equal(titleInfo('дархан_аварга').short, 'дар.а');
  assert.ok(isTitle('улсын_начин'));
  assert.ok(!isTitle('хаан'));
  assert.ok(seedRating('дархан_аварга') > seedRating('улсын_арслан'));
  assert.ok(seedRating('улсын_арслан') > seedRating('улсын_начин'));
  assert.ok(seedRating('улсын_начин') >= seedRating('аймгийн_арслан'));
  assert.ok(seedRating('аймгийн_начин') > seedRating('сумын_заан'));
  assert.ok(seedRating('сумын_заан') > seedRating('залуу_бөх'));
  assert.ok(seedRating('залуу_бөх') > seedRating('цолгүй'));
  assert.ok(titleRank('улсын_гарьд') > titleRank('улсын_заан'));
  // Улсын цолтны кодууд devjee-тэй ижил дараалалтай
  const uls = TITLES.filter((t) => t.level === 'uls').map((t) => t.code);
  assert.deepEqual(uls, [13, 14, 15, 16, 17, 18, 19, 20, 21]);
});
