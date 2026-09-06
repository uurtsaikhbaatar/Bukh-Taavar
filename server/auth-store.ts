/**
 * Бүртгэл/нэвтрэлтийн хадгалалтын интерфэйс + санах ойн хэрэгжүүлэлт (тест, локал).
 *
 * Postgres хэрэгжүүлэлт: `db.ts`. Engine-ийн `users` (үлдэгдэл, самбар) ба энд
 * буй `AuthUser` (нууц үг, имэйл, session) ижил `id`-тэй (uuid).
 */

export type AuthRole = 'admin' | 'member';

export interface AuthUser {
  id: string;
  username: string;
  /** Харьцуулах хэлбэр (жижиг үсэг). */
  usernameKey: string;
  passwordHash: string;
  email: string;
  emailKey: string;
  emailVerified: boolean;
  role: AuthRole;
  createdAt: string;
}

export type CodeKind = 'verify' | 'reset';

export interface CodeRecord {
  userId: string;
  codeHash: string;
  /** epoch ms */
  expiresAt: number;
  attempts: number;
  /** epoch ms */
  sentAt: number;
}

export interface AuthStore {
  createUser(user: AuthUser): Promise<void>;
  userById(id: string): Promise<AuthUser | null>;
  userByUsernameKey(key: string): Promise<AuthUser | null>;
  userByEmailKey(key: string): Promise<AuthUser | null>;
  updateUser(id: string, patch: Partial<Pick<AuthUser, 'passwordHash' | 'emailVerified' | 'role' | 'email' | 'emailKey'>>): Promise<void>;
  listUsers(): Promise<AuthUser[]>;

  createSession(token: string, userId: string, expiresAt: number): Promise<void>;
  userIdForSession(token: string, now: number): Promise<string | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessionsFor(userId: string): Promise<void>;

  setCode(kind: CodeKind, record: CodeRecord): Promise<void>;
  getCode(kind: CodeKind, userId: string): Promise<CodeRecord | null>;
  bumpAttempts(kind: CodeKind, userId: string): Promise<void>;
  deleteCode(kind: CodeKind, userId: string): Promise<void>;
}

export interface AuthSnapshot {
  users: AuthUser[];
  sessions: { token: string; userId: string; expiresAt: number }[];
  codes: { kind: CodeKind; record: CodeRecord }[];
}

export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  private readonly codes = new Map<string, CodeRecord>();
  /** Өөрчлөлт бүрийн дараа дуудагдана (файлд хадгалахад). */
  onChange: (() => void) | null = null;

  snapshot(): AuthSnapshot {
    return {
      users: [...this.users.values()].map((u) => ({ ...u })),
      sessions: [...this.sessions].map(([token, s]) => ({ token, ...s })),
      codes: [...this.codes].map(([k, record]) => ({ kind: k.split(':')[0] as CodeKind, record: { ...record } })),
    };
  }

  restore(s: AuthSnapshot): void {
    this.users.clear();
    this.sessions.clear();
    this.codes.clear();
    for (const u of s.users) this.users.set(u.id, { ...u });
    for (const x of s.sessions) this.sessions.set(x.token, { userId: x.userId, expiresAt: x.expiresAt });
    for (const c of s.codes) this.codes.set(`${c.kind}:${c.record.userId}`, { ...c.record });
  }

  private changed(): void {
    this.onChange?.();
  }

  async createUser(user: AuthUser): Promise<void> {
    this.users.set(user.id, { ...user });
    this.changed();
  }

  async userById(id: string): Promise<AuthUser | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async userByUsernameKey(key: string): Promise<AuthUser | null> {
    for (const u of this.users.values()) if (u.usernameKey === key) return { ...u };
    return null;
  }

  async userByEmailKey(key: string): Promise<AuthUser | null> {
    for (const u of this.users.values()) if (u.emailKey === key) return { ...u };
    return null;
  }

  async updateUser(id: string, patch: Partial<Pick<AuthUser, 'passwordHash' | 'emailVerified' | 'role' | 'email' | 'emailKey'>>): Promise<void> {
    const u = this.users.get(id);
    if (u) Object.assign(u, patch);
    this.changed();
  }

  async listUsers(): Promise<AuthUser[]> {
    return [...this.users.values()].map((u) => ({ ...u }));
  }

  async createSession(token: string, userId: string, expiresAt: number): Promise<void> {
    this.sessions.set(token, { userId, expiresAt });
    this.changed();
  }

  async userIdForSession(token: string, now: number): Promise<string | null> {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }
    return s.userId;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
    this.changed();
  }

  async deleteSessionsFor(userId: string): Promise<void> {
    for (const [t, s] of this.sessions) if (s.userId === userId) this.sessions.delete(t);
    this.changed();
  }

  async setCode(kind: CodeKind, record: CodeRecord): Promise<void> {
    this.codes.set(`${kind}:${record.userId}`, { ...record });
    this.changed();
  }

  async getCode(kind: CodeKind, userId: string): Promise<CodeRecord | null> {
    const c = this.codes.get(`${kind}:${userId}`);
    return c ? { ...c } : null;
  }

  async bumpAttempts(kind: CodeKind, userId: string): Promise<void> {
    const c = this.codes.get(`${kind}:${userId}`);
    if (c) c.attempts += 1;
    this.changed();
  }

  async deleteCode(kind: CodeKind, userId: string): Promise<void> {
    this.codes.delete(`${kind}:${userId}`);
    this.changed();
  }
}
