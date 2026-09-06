/**
 * Үйл явдлын логийн хадгалалт.
 *
 * - MemoryLog — тест, симуляцид.
 * - JsonlLog  — нэг мөр = нэг үйл явдал (JSON Lines), append-only файл.
 *   Notepad-аар нээгээд уншиж болно. Phase 2-т Postgres/SQLite-руу энэ
 *   интерфэйсээр солино.
 *
 * Бүх үйлдэл синхрон — цөм ганц процесст дараалан ажилладаг.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isBukhEvent, type BukhEvent } from './events.ts';

export interface EventLog {
  append(event: BukhEvent): void;
  readAll(): BukhEvent[];
}

export class MemoryLog implements EventLog {
  private readonly events: BukhEvent[] = [];

  append(event: BukhEvent): void {
    this.events.push(structuredClone(event));
  }

  readAll(): BukhEvent[] {
    return this.events.map((e) => structuredClone(e));
  }

  get length(): number {
    return this.events.length;
  }
}

export class LogCorruptError extends Error {}

export class JsonlLog implements EventLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(event: BukhEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf8');
  }

  readAll(): BukhEvent[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: BukhEvent[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new LogCorruptError(`${this.path}: ${i + 1}-р мөр JSON биш.`);
      }
      if (!isBukhEvent(parsed)) throw new LogCorruptError(`${this.path}: ${i + 1}-р мөр үйл явдал биш.`);
      out.push(parsed);
    }
    return out;
  }
}
