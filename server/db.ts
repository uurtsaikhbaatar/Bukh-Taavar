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
 *
 * ГАНЦ БИЧИГЧ (fencing): лог нь санах ойн төлөвийн үргэлжлэл тул хоёр процесс зэрэг бичвэл
 * (deploy-ийн үед хуучин ба шинэ instance 15–20 сек зэрэг амьд; сервер ажиллаж байхад admin-cli)
 * тус бүр нөгөөгийнхөө үйл явдлыг мэдэлгүй бичиж, дараагийн эхлэлд лог «зөрчилтэй» болж сервер
 * босохгүй байх эрсдэлтэй. Хамгаалалт: `log_writer` хүснэгтийн ганц мөр дэх `epoch`.
 *   - Бичигч эхлэхдээ epoch-ийг +1 болгож АВНА (claim), ДАРАА нь логийг уншина;
 *   - flush бүр гүйлгээн дотроо тэр мөрийг `FOR UPDATE` түгжиж epoch-оо шалгана: өөр болсон
 *     бол юу ч бичихгүй, `WriterFencedError` шиднэ (хамгийн сүүлд эхэлсэн бичигч ялна).
 * Мөрийн түгжээ нь flush ба claim-ийг дараалуулдаг тул «уншсаны дараа хуучин бичигч нэмж бичих»
 * цонх байхгүй. Session advisory lock биш — Neon-ы pooler (transaction mode) дээр найдвартай
 * ажиллахгүй; тогтмол асуулга ч биш — DB-г унтуулахгүй байлгаж compute квот шатаана.
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

  CREATE TABLE IF NOT EXISTS log_writer (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    epoch      BIGINT NOT NULL,
    owner      TEXT NOT NULL DEFAULT '',
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO log_writer (id, epoch) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

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

export async function initSchema(p: LogDb = getPool()): Promise<void> {
  await p.query(SCHEMA_SQL);
}

/** PostgresLog-д хэрэгтэй хамгийн бага DB интерфэйс — `pg.Pool` хангана (тестэд PGlite). */
export interface LogDbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}
export interface LogDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<LogDbClient>;
}

/** Бичих эрх өөр (шинэ) бичигчид шилжсэн — энэ процесс цаашид лог руу бичиж чадахгүй. */
export class WriterFencedError extends Error {
  readonly code = 'FENCED';
  /** Эрхийг авсан бичигч (`server:…`, `cli:…`). */
  readonly owner: string;
  constructor(owner: string) {
    super(`Логийн бичих эрх өөр процесст шилжсэн (${owner || 'тодорхойгүй'}).`);
    this.owner = owner;
  }
}

/** Хойшлуулсан эрх авалт (CLI): уншсанаас хойш лог өөрчлөгдсөн тул хуучирсан төлөв дээр бичихгүй. */
export class LogMovedError extends Error {
  readonly code = 'LOG_MOVED';
  constructor() {
    super('Уншсанаас хойш логт шинэ үйл явдал нэмэгдсэн — командыг дахин ажиллуулна уу.');
  }
}

// ───────────────────────── үйл явдлын лог ─────────────────────────

export interface FlushableLog extends EventLog {
  flush(): Promise<void>;
  readonly pending: number;
}

interface EventRow {
  payload: unknown;
}

export interface PostgresLogOptions {
  /** Бичигчийн нэр: `server:<instance>` / `cli:<команд>` — хэн эрхийг авсныг ялгахад. */
  owner?: string;
  /**
   * true (анхдагч): эхлэхдээ бичих эрхийг шууд авна — урт ажилладаг сервер.
   * false: эрхийг анхны flush хүртэл хойшлуулна (admin-cli): зөвхөн уншдаг команд серверийг
   * бичих эрхгүй болгохгүй; бичих үедээ уншсанаас хойш лог өөрчлөгдөөгүйг шалгана.
   */
  claim?: boolean;
}

const CLAIM_SQL = 'UPDATE log_writer SET epoch = epoch + 1, owner = $1, claimed_at = now() WHERE id = 1 RETURNING epoch';

export class PostgresLog implements FlushableLog {
  private readonly pool: LogDb;
  private readonly loaded: BukhEvent[];
  private readonly owner: string;
  private queue: BukhEvent[] = [];
  private inflight: Promise<void> = Promise.resolve();
  /** Миний бичих эрхийн дугаар; undefined = хараахан аваагүй (хойшлуулсан). */
  private epoch: number | undefined;
  /** Уншсан агшны хамгийн их seq — хойшлуулсан эрх авалтад «лог хөдлөөгүй»-г шалгана. */
  private readonly seqAtLoad: number;
  private fencedOwner: string | undefined;
  /** Бичих эрхээ алдсаныг анх мэдэх үед нэг удаа дуудагдана. */
  onFenced: ((owner: string) => void) | undefined;

  private constructor(pool: LogDb, loaded: BukhEvent[], owner: string, epoch: number | undefined, seqAtLoad: number) {
    this.pool = pool;
    this.loaded = loaded;
    this.owner = owner;
    this.epoch = epoch;
    this.seqAtLoad = seqAtLoad;
  }

  /**
   * Бичих эрхийг авч (claim), ДАРАА нь бүх үйл явдлыг seq дарааллаар уншина. Дараалал чухал:
   * эрхээ авсны дараа өмнөх бичигчийн flush бүтэлгүйтэх тул уншсан лог бол эцсийн лог.
   */
  static async load(p: LogDb = getPool(), options: PostgresLogOptions = {}): Promise<PostgresLog> {
    const owner = options.owner ?? `proc:${process.pid}`;
    let epoch: number | undefined;
    if (options.claim ?? true) {
      const c = await p.query(CLAIM_SQL, [owner]);
      if (!c.rows[0]) throw new Error('log_writer мөр алга — initSchema ажиллуулаагүй байна.');
      epoch = Number(c.rows[0].epoch);
    }
    const res = await p.query('SELECT seq, payload FROM events ORDER BY seq');
    const events: BukhEvent[] = [];
    let seq = 0;
    for (const row of res.rows as (EventRow & { seq: string | number | bigint })[]) {
      if (!isBukhEvent(row.payload)) throw new Error('events хүснэгтэд танигдаагүй бичлэг байна.');
      events.push(row.payload);
      seq = Number(row.seq);
    }
    return new PostgresLog(p, events, owner, epoch, seq);
  }

  readAll(): BukhEvent[] {
    return this.loaded.map((e) => structuredClone(e));
  }

  append(event: BukhEvent): void {
    // Эрхээ алдсан процесс юу ч дараалалд авахгүй — чимээгүй «амжилттай» мэт харагдуулахгүй
    if (this.fencedOwner !== undefined) throw new WriterFencedError(this.fencedOwner);
    this.queue.push(structuredClone(event));
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Бичих эрхийн дугаар (хараахан аваагүй бол undefined). */
  get writerEpoch(): number | undefined {
    return this.epoch;
  }

  /** Бичих эрхээ өөр бичигчид алдсан эсэх. */
  get fenced(): boolean {
    return this.fencedOwner !== undefined;
  }

  private fence(owner: string): WriterFencedError {
    const first = this.fencedOwner === undefined;
    this.fencedOwner = owner;
    this.queue = [];
    if (first && this.onFenced) {
      try {
        this.onFenced(owner);
      } catch {
        // мэдэгдлийн алдаа логийн төлөвт нөлөөлөхгүй
      }
    }
    return new WriterFencedError(owner);
  }

  /** Дараалалд буй үйл явдлуудыг нэг гүйлгээгээр бичнэ (дараалсан, зэрэгцээ биш). */
  flush(): Promise<void> {
    const run = this.inflight.then(async () => {
      if (this.fencedOwner !== undefined) throw new WriterFencedError(this.fencedOwner);
      if (this.queue.length === 0) return;
      const batch = this.queue;
      this.queue = [];
      const client = await this.pool.connect();
      let claimed: number | undefined;
      try {
        await client.query('BEGIN');
        if (this.epoch === undefined) {
          // Хойшлуулсан эрх авалт (UPDATE нь мөрийг түгжинэ) + уншсанаас хойш лог хөдлөөгүйг шалгана
          const c = await client.query(CLAIM_SQL, [this.owner]);
          const m = await client.query('SELECT COALESCE(max(seq), 0) AS seq FROM events');
          if (!c.rows[0] || Number(m.rows[0]?.seq) !== this.seqAtLoad) {
            await client.query('ROLLBACK');
            this.queue = [];
            throw new LogMovedError();
          }
          claimed = Number(c.rows[0].epoch);
        } else {
          // Мөрийн түгжээ flush ба шинэ бичигчийн claim-ийг дараалуулна
          const w = await client.query('SELECT epoch, owner FROM log_writer WHERE id = 1 FOR UPDATE');
          if (Number(w.rows[0]?.epoch) !== this.epoch) {
            await client.query('ROLLBACK');
            throw this.fence(String(w.rows[0]?.owner ?? ''));
          }
        }
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
        if (claimed !== undefined) this.epoch = claimed;
        this.loaded.push(...batch);
      } catch (err) {
        if (err instanceof WriterFencedError || err instanceof LogMovedError) throw err; // багц хаягдсан
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
