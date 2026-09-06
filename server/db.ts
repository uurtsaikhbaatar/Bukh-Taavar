/**
 * Postgres (Neon) — үйл явдлын лог + бүртгэлийн хүснэгтүүд.
 *
 * `DATABASE_URL` тохируулсан үед л ашиглагдана (production). Локал/тестэд
 * JsonlLog + MemoryAuthStore.
 *
 * PostgresLog: Engine синхрон `append` хийдэг тул үйл явдлыг эхлээд санах ойн
 * дараалалд аваад, HTTP хариу өгөхөөс өмнө `flush()`-ээр багцаар INSERT хийнэ.
 * flush бүтэлгүйтвэл дуудагч (api.ts) процессыг зогсооно — төлөв Postgres
 * логоос дахин босно (санах ойн төлөв логоос түрүүлж болохгүй).
 */

import pg from 'pg';

import { isBukhEvent, type BukhEvent } from '../src/events.ts';
import type { EventLog } from '../src/store.ts';
import type { AuthStore, AuthUser, CodeKind, CodeRecord } from './auth-store.ts';

export type Pool = pg.Pool;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL тохируулаагүй байна.');
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: url.includes('localhost') || url.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    seq      BIGSERIAL PRIMARY KEY,
    id       TEXT NOT NULL UNIQUE,
    at       TIMESTAMPTZ NOT NULL,
    type     TEXT NOT NULL,
    payload  JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    username_key   TEXT NOT NULL UNIQUE,
    password       TEXT NOT NULL,
    email          TEXT NOT NULL,
    email_key      TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    role           TEXT NOT NULL DEFAULT 'member',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS codes (
    kind       TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, user_id)
  );
`;

export async function initSchema(p: pg.Pool = getPool()): Promise<void> {
  await p.query(SCHEMA_SQL);
}

// ───────────────────────── үйл явдлын лог ─────────────────────────

export interface FlushableLog extends EventLog {
  flush(): Promise<void>;
  readonly pending: number;
}

interface EventRow {
  payload: unknown;
}

export class PostgresLog implements FlushableLog {
  private readonly pool: pg.Pool;
  private readonly loaded: BukhEvent[];
  private queue: BukhEvent[] = [];
  private inflight: Promise<void> = Promise.resolve();

  private constructor(pool: pg.Pool, loaded: BukhEvent[]) {
    this.pool = pool;
    this.loaded = loaded;
  }

  /** Бүх үйл явдлыг seq дарааллаар урьдчилан уншиж, логийг бэлдэнэ. */
  static async load(p: pg.Pool = getPool()): Promise<PostgresLog> {
    const res = await p.query<EventRow>('SELECT payload FROM events ORDER BY seq');
    const events: BukhEvent[] = [];
    for (const row of res.rows) {
      if (!isBukhEvent(row.payload)) throw new Error('events хүснэгтэд танигдаагүй бичлэг байна.');
      events.push(row.payload);
    }
    return new PostgresLog(p, events);
  }

  readAll(): BukhEvent[] {
    return this.loaded.map((e) => structuredClone(e));
  }

  append(event: BukhEvent): void {
    this.queue.push(structuredClone(event));
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Дараалалд буй үйл явдлуудыг нэг гүйлгээгээр бичнэ (дараалсан, зэрэгцээ биш). */
  flush(): Promise<void> {
    const run = this.inflight.then(async () => {
      if (this.queue.length === 0) return;
      const batch = this.queue;
      this.queue = [];
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // Олон мөрийг нэг INSERT-ээр (500 мөр = 2 000 параметр): 46к үйл явдлын импорт, 1024 бөхийн
        // даваа эхлэх зэрэг том багц Neon руу секундэд багтана (мөр бүрд тусдаа гүйлгээ бол минутууд).
        const CHUNK = 500;
        for (let i = 0; i < batch.length; i += CHUNK) {
          const rows = batch.slice(i, i + CHUNK);
          const values: unknown[] = [];
          const marks = rows.map((e, k) => {
            values.push(e.id, e.at, e.type, JSON.stringify(e));
            const b = k * 4;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
          });
          await client.query(`INSERT INTO events (id, at, type, payload) VALUES ${marks.join(', ')}`, values);
        }
        await client.query('COMMIT');
        this.loaded.push(...batch);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // Бичигдээгүй үйл явдлуудыг буцааж дараалалд тавина — дуудагч зогсоох эсэхээ шийднэ.
        this.queue = [...batch, ...this.queue];
        throw err;
      } finally {
        client.release();
      }
    });
    this.inflight = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ───────────────────────── бүртгэл ─────────────────────────

interface UserRow {
  id: string;
  username: string;
  username_key: string;
  password: string;
  email: string;
  email_key: string;
  email_verified: boolean;
  role: string;
  created_at: Date;
}

function rowToUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    username: r.username,
    usernameKey: r.username_key,
    passwordHash: r.password,
    email: r.email,
    emailKey: r.email_key,
    emailVerified: r.email_verified,
    role: r.role === 'admin' ? 'admin' : 'member',
    createdAt: r.created_at.toISOString(),
  };
}

const USER_COLS = 'id, username, username_key, password, email, email_key, email_verified, role, created_at';

export class PostgresAuthStore implements AuthStore {
  private readonly pool: pg.Pool;

  constructor(p: pg.Pool = getPool()) {
    this.pool = p;
  }

  async createUser(u: AuthUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, username, username_key, password, email, email_key, email_verified, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [u.id, u.username, u.usernameKey, u.passwordHash, u.email, u.emailKey, u.emailVerified, u.role, u.createdAt],
    );
  }

  private async one(where: string, params: unknown[]): Promise<AuthUser | null> {
    const res = await this.pool.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE ${where}`, params);
    const row = res.rows[0];
    return row ? rowToUser(row) : null;
  }

  userById(id: string): Promise<AuthUser | null> {
    return this.one('id = $1', [id]);
  }

  userByUsernameKey(key: string): Promise<AuthUser | null> {
    return this.one('username_key = $1', [key]);
  }

  userByEmailKey(key: string): Promise<AuthUser | null> {
    return this.one('email_key = $1', [key]);
  }

  async updateUser(id: string, patch: Partial<Pick<AuthUser, 'passwordHash' | 'emailVerified' | 'role' | 'email' | 'emailKey'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.passwordHash !== undefined) add('password', patch.passwordHash);
    if (patch.emailVerified !== undefined) add('email_verified', patch.emailVerified);
    if (patch.role !== undefined) add('role', patch.role);
    if (patch.email !== undefined) add('email', patch.email);
    if (patch.emailKey !== undefined) add('email_key', patch.emailKey);
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  async listUsers(): Promise<AuthUser[]> {
    const res = await this.pool.query<UserRow>(`SELECT ${USER_COLS} FROM users ORDER BY created_at`);
    return res.rows.map(rowToUser);
  }

  async createSession(token: string, userId: string, expiresAt: number): Promise<void> {
    await this.pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, new Date(expiresAt)]);
  }

  async userIdForSession(token: string, now: number): Promise<string | null> {
    const res = await this.pool.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE token = $1 AND expires_at > $2', [token, new Date(now)]);
    return res.rows[0]?.user_id ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async deleteSessionsFor(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async setCode(kind: CodeKind, rec: CodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO codes (kind, user_id, code_hash, expires_at, attempts, sent_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (kind, user_id) DO UPDATE SET code_hash = $3, expires_at = $4, attempts = $5, sent_at = $6`,
      [kind, rec.userId, rec.codeHash, new Date(rec.expiresAt), rec.attempts, new Date(rec.sentAt)],
    );
  }

  async getCode(kind: CodeKind, userId: string): Promise<CodeRecord | null> {
    const res = await this.pool.query<{ code_hash: string; expires_at: Date; attempts: number; sent_at: Date }>(
      'SELECT code_hash, expires_at, attempts, sent_at FROM codes WHERE kind = $1 AND user_id = $2',
      [kind, userId],
    );
    const r = res.rows[0];
    return r ? { userId, codeHash: r.code_hash, expiresAt: r.expires_at.getTime(), attempts: r.attempts, sentAt: r.sent_at.getTime() } : null;
  }

  async bumpAttempts(kind: CodeKind, userId: string): Promise<void> {
    await this.pool.query('UPDATE codes SET attempts = attempts + 1 WHERE kind = $1 AND user_id = $2', [kind, userId]);
  }

  async deleteCode(kind: CodeKind, userId: string): Promise<void> {
    await this.pool.query('DELETE FROM codes WHERE kind = $1 AND user_id = $2', [kind, userId]);
  }
}
