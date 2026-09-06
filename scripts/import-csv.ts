/**
 * CSV импорт — бөхчүүд ба/эсвэл барилдааны түүхийг үйл явдлын лог руу оруулна.
 *
 *   node scripts/import-csv.ts --wrestlers data/жишээ-бөхчүүд.csv
 *   node scripts/import-csv.ts --bouts data/жишээ-барилдаан.csv --tournament t2025 "Наадам 2025" 2025-07-11 9
 *   node scripts/import-csv.ts --log data/bukh.jsonl --wrestlers ...   (лог файлыг заах; анхдагч data/bukh.jsonl)
 *
 * Баганууд — бөх: id?, name, title (түлхүүр эсвэл devjee код 0–21), aimag?, sum?, rating?, devjeeId?, birthDate?
 *           барилдаан: tournament, round, a, b, winner (a|b эсвэл бөхийн id)
 */

import { readFileSync } from 'node:fs';

import { importBoutsCsv, importWrestlersCsv } from '../src/csv.ts';
import { Engine, EngineError } from '../src/engine.ts';
import { JsonlLog } from '../src/store.ts';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const logPath = opt('log') ?? 'data/bukh.jsonl';
const engine = new Engine(new JsonlLog(logPath));
console.log(`Лог: ${logPath} (${engine.state.eventCount} үйл явдал байна)`);

const tIdx = argv.indexOf('--tournament');
if (tIdx >= 0) {
  const [id, name, date, rounds] = argv.slice(tIdx + 1, tIdx + 5);
  if (!id || !name || !date || !rounds) {
    console.error('--tournament <id> <нэр> <YYYY-MM-DD> <давааны тоо>');
    process.exit(1);
  }
  if (!engine.state.tournaments.has(id)) {
    engine.createTournament({ id, name, date, rounds: Number(rounds) });
    console.log(`Тэмцээн үүсгэв: ${id} «${name}» ${date}, ${rounds} даваа`);
  }
}

const wPath = opt('wrestlers');
if (wPath) {
  const r = importWrestlersCsv(engine, readFileSync(wPath, 'utf8'));
  console.log(`Бөх: нэмсэн ${r.added}, алгассан ${r.skipped}, алдаа ${r.errors.length}`);
  for (const e of r.errors) console.log('  ' + e);
}

const bPath = opt('bouts');
if (bPath) {
  try {
    const r = importBoutsCsv(engine, readFileSync(bPath, 'utf8'));
    console.log(`Барилдаан: нэмсэн ${r.added}, алгассан ${r.skipped}, алдаа ${r.errors.length}`);
    for (const e of r.errors) console.log('  ' + e);
  } catch (e) {
    if (e instanceof EngineError) console.error(e.message);
    else throw e;
  }
}

if (!wPath && !bPath) console.log('Юу ч оруулсангүй: --wrestlers <csv> эсвэл --bouts <csv> өг.');
console.log(`Одоо: бөх ${engine.wrestlers().length}, тэмцээн ${engine.tournaments().length}, барилдаан ${engine.bouts().length}, үйл явдал ${engine.state.eventCount}`);
