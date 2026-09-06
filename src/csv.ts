/**
 * CSV импорт — бөх ба барилдааны түүх (Elo халаах, devjee-гүй горим).
 *
 * Бөхийн CSV баганууд:  id?, name, title (түлхүүр эсвэл devjee код), aimag?, sum?,
 *                        rating?, devjeeId?, birthDate?
 * Барилдааны CSV:        tournament (id), round, a (бөх id), b (бөх id), winner (a|b эсвэл бөх id)
 *
 * Тусгаарлагч таслал, хашилттай талбар, CRLF, BOM-ийг ойлгоно.
 */

import type { Engine } from './engine.ts';
import { isTitle, titleFromCode, type Title } from './rating.ts';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Эхний мөр = баганын нэр. */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    keys.forEach((k, i) => {
      o[k] = (r[i] ?? '').trim();
    });
    return o;
  });
}

export interface ImportSummary {
  added: number;
  skipped: number;
  errors: string[];
}

function parseTitle(raw: string): Title | undefined {
  const v = raw.trim();
  if (v === '') return 'цолгүй';
  if (isTitle(v)) return v;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 21) return titleFromCode(n);
  return undefined;
}

export function importWrestlersCsv(engine: Engine, text: string): ImportSummary {
  const out: ImportSummary = { added: 0, skipped: 0, errors: [] };
  csvToObjects(text).forEach((row, i) => {
    const line = i + 2;
    const name = row.name ?? '';
    if (!name) {
      out.errors.push(`${line}-р мөр: name хоосон`);
      return;
    }
    const title = parseTitle(row.title ?? '');
    if (title === undefined) {
      out.errors.push(`${line}-р мөр: цол танигдсангүй "${row.title}"`);
      return;
    }
    if (row.id && engine.state.wrestlers.has(row.id)) {
      out.skipped += 1;
      return;
    }
    const input: Parameters<Engine['addWrestler']>[0] = { name, title };
    if (row.id) input.id = row.id;
    if (row.aimag) input.aimag = row.aimag;
    if (row.sum) input.sum = row.sum;
    if (row.devjeeId) input.devjeeId = row.devjeeId;
    if (row.birthDate) input.birthDate = row.birthDate;
    try {
      const w = engine.addWrestler(input);
      if (row.rating) {
        const r = Number(row.rating);
        if (Number.isFinite(r)) engine.setRating(w.id, r, row.devjeeId ? 'devjee' : 'local');
      }
      out.added += 1;
    } catch (e) {
      out.errors.push(`${line}-р мөр: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return out;
}

/** Барилдааны түүх: зах зээлгүй барилдаан үүсгээд үр дүнг бүртгэнэ (Elo шинэчлэгдэнэ). */
export function importBoutsCsv(engine: Engine, text: string): ImportSummary {
  const out: ImportSummary = { added: 0, skipped: 0, errors: [] };
  csvToObjects(text).forEach((row, i) => {
    const line = i + 2;
    const tournamentId = row.tournament ?? '';
    const round = Number(row.round);
    const a = row.a ?? '';
    const b = row.b ?? '';
    const winnerRaw = (row.winner ?? '').trim();
    const winner = winnerRaw === 'a' ? a : winnerRaw === 'b' ? b : winnerRaw;
    if (!tournamentId || !a || !b || !winner) {
      out.errors.push(`${line}-р мөр: tournament/a/b/winner дутуу`);
      return;
    }
    if (row.id && engine.state.bouts.has(row.id)) {
      out.skipped += 1;
      return;
    }
    try {
      const input: Parameters<Engine['createBout']>[0] = { tournamentId, round, aId: a, bId: b, withMarket: false };
      if (row.id) input.id = row.id;
      const { bout } = engine.createBout(input);
      engine.recordBoutResult(bout.id, winner);
      out.added += 1;
    } catch (e) {
      out.errors.push(`${line}-р мөр: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return out;
}
