/**
 * Бүртгэл, нэвтрэлт, имэйл баталгаажуулалт, нууц үг сэргээх (bigtwo-ийн загвар).
 *
 * - Нууц үг: scrypt (Node-д суурилагдсан), давстай, буцаан задлах боломжгүй.
 * - Session: санамсаргүй token (cookie-д HttpOnly), 60 хоног.
 * - Баталгаажуулах/сэргээх код: 6 оронтой, hash-лан хадгална, 15 мин, 5 оролдлого.
 * - Хадгалалт: `AuthStore` (санах ой / Postgres) — тестэд санах ой.
 *
 * Engine-ийн хэрэглэгч (үлдэгдэл) энд үүсдэггүй — `api.ts` бүртгэлийн дараа
 * ижил id-гаар `engine.createUser` дуудна.
 */

import { randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { AuthRole, AuthStore, AuthUser, CodeKind } from './auth-store.ts';
import { passwordResetEmail, sendEmail as defaultSendEmail, verificationEmail, type EmailMessage } from './email.ts';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
export const SESSION_DAYS = 60;
export const MIN_USERNAME = 2;
export const MAX_USERNAME = 16;
export const MIN_PASSWORD = 6;
const CODE_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60_000;

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Account {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  role: AuthRole;
}

export const normalise = (value: string): string => value.trim().toLowerCase();

export function isEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed);
}

export function validateUsername(username: string): string {
  const name = username.trim();
  if (name.length < MIN_USERNAME || name.length > MAX_USERNAME) {
    throw new AuthError(`Нэр ${MIN_USERNAME}–${MAX_USERNAME} тэмдэгт байх ёстой.`);
  }
  if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) throw new AuthError('Нэрэнд үсэг, тоо, зай, доогуур зураас л орно.');
  return name;
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError(`Нууц үг дор хаяж ${MIN_PASSWORD} тэмдэгт байх ёстой.`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

function toAccount(u: AuthUser): Account {
  return { id: u.id, username: u.username, email: u.email, emailVerified: u.emailVerified, role: u.role };
}

export interface AuthOptions {
  now?: () => number;
  idGen?: () => string;
  sendEmail?: (message: EmailMessage) => Promise<unknown>;
}

export class Auth {
  private readonly store: AuthStore;
  private readonly now: () => number;
  private readonly idGen: () => string;
  private readonly send: (message: EmailMessage) => Promise<unknown>;

  constructor(store: AuthStore, options: AuthOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.idGen = options.idGen ?? (() => randomUUID());
    this.send = options.sendEmail ?? defaultSendEmail;
  }

  /** Шинэ хэрэглэгч. Эхний бүртгэл админ болно (`firstIsAdmin`). */
  async register(username: string, password: string, email: string, firstIsAdmin = true): Promise<{ account: Account; token: string; codeSent: boolean }> {
    const name = validateUsername(username);
    validatePassword(password);
    if (!isEmail(email)) throw new AuthError('Имэйл хаяг буруу байна.');
    const address = email.trim();
    if (await this.store.userByUsernameKey(normalise(name))) throw new AuthError('Энэ нэр аль хэдийн бүртгэгдсэн байна.');
    if (await this.store.userByEmailKey(normalise(address))) throw new AuthError('Энэ имэйлээр бүртгэл үүссэн байна.');
    const role: AuthRole = firstIsAdmin && (await this.store.listUsers()).length === 0 ? 'admin' : 'member';
    const user: AuthUser = {
      id: this.idGen(),
      username: name,
      usernameKey: normalise(name),
      passwordHash: await hashPassword(password),
      email: address,
      emailKey: normalise(address),
      emailVerified: false,
      role,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.store.createUser(user);
    // Имэйл илгээхэд алдаа гарсан ч бүртгэл хүчинтэй — дараа нь дахин илгээнэ.
    const codeSent = await this.issueCode('verify', user, false);
    return { account: toAccount(user), token: await this.openSession(user.id), codeSent };
  }

  async login(username: string, password: string): Promise<{ account: Account; token: string }> {
    const user = await this.store.userByUsernameKey(normalise(username));
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) throw new AuthError('Нэр эсвэл нууц үг буруу байна.', 401);
    return { account: toAccount(user), token: await this.openSession(user.id) };
  }

  async logout(token: string): Promise<void> {
    if (token) await this.store.deleteSession(token);
  }

  async accountForToken(token: string | undefined): Promise<Account | null> {
    if (!token) return null;
    const userId = await this.store.userIdForSession(token, this.now());
    if (!userId) return null;
    const user = await this.store.userById(userId);
    return user ? toAccount(user) : null;
  }

  async account(userId: string): Promise<Account | null> {
    const user = await this.store.userById(userId);
    return user ? toAccount(user) : null;
  }

  private async openSession(userId: string): Promise<string> {
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    await this.store.createSession(token, userId, this.now() + SESSION_DAYS * 24 * 3_600_000);
    return token;
  }

  // ── имэйл код ──

  private async issueCode(kind: CodeKind, user: AuthUser, throwOnSendFailure: boolean): Promise<boolean> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.store.setCode(kind, {
      userId: user.id,
      codeHash: await hashPassword(code),
      expiresAt: this.now() + CODE_TTL_MS,
      attempts: 0,
      sentAt: this.now(),
    });
    const message = kind === 'verify' ? verificationEmail(user.username, code) : passwordResetEmail(user.username, code);
    try {
      await this.send({ to: user.email, ...message });
      return true;
    } catch (err) {
      console.error(`${kind} имэйл илгээж чадсангүй:`, err instanceof Error ? err.message : err);
      if (throwOnSendFailure) throw new AuthError('Имэйл илгээж чадсангүй. Түр зуур дахин оролдоно уу.', 502);
      return false;
    }
  }

  private async checkCode(kind: CodeKind, userId: string, code: string): Promise<void> {
    const rec = await this.store.getCode(kind, userId);
    if (!rec) throw new AuthError('Код олдсонгүй. Дахин илгээнэ үү.');
    if (rec.expiresAt <= this.now()) throw new AuthError('Кодын хугацаа дууссан. Дахин илгээнэ үү.');
    if (rec.attempts >= MAX_CODE_ATTEMPTS) throw new AuthError('Хэт олон удаа буруу оруулсан. Дахин илгээнэ үү.');
    if (!(await verifyPassword(code.trim(), rec.codeHash))) {
      await this.store.bumpAttempts(kind, userId);
      const left = MAX_CODE_ATTEMPTS - rec.attempts - 1;
      throw new AuthError(`Код буруу байна.${left > 0 ? ` ${left} оролдлого үлдлээ.` : ''}`);
    }
  }

  async verifyEmail(userId: string, code: string): Promise<Account> {
    const user = await this.store.userById(userId);
    if (!user) throw new AuthError('Хэрэглэгч олдсонгүй.', 404);
    if (user.emailVerified) return toAccount(user);
    await this.checkCode('verify', userId, code);
    await this.store.updateUser(userId, { emailVerified: true });
    await this.store.deleteCode('verify', userId);
    return { ...toAccount(user), emailVerified: true };
  }

  async resendCode(userId: string): Promise<void> {
    const user = await this.store.userById(userId);
    if (!user) throw new AuthError('Хэрэглэгч олдсонгүй.', 404);
    if (user.emailVerified) throw new AuthError('Имэйл аль хэдийн баталгаажсан байна.');
    const last = await this.store.getCode('verify', userId);
    if (last) {
      const wait = Math.ceil((last.sentAt + RESEND_COOLDOWN_MS - this.now()) / 1000);
      if (wait > 0) throw new AuthError(`${wait} секундын дараа дахин оролдоно уу.`, 429);
    }
    await this.issueCode('verify', user, true);
  }

  /** Имэйл бүртгэлтэй эсэхийг задруулахгүй — үргэлж ижил хариу. */
  async forgotPassword(email: string): Promise<void> {
    if (!isEmail(email)) return;
    const user = await this.store.userByEmailKey(normalise(email));
    if (!user) return;
    const last = await this.store.getCode('reset', user.id);
    if (last && last.sentAt + RESEND_COOLDOWN_MS > this.now()) return;
    await this.issueCode('reset', user, false);
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    validatePassword(newPassword);
    const user = await this.store.userByEmailKey(normalise(email));
    if (!user) throw new AuthError('Код буруу байна.');
    await this.checkCode('reset', user.id, code);
    await this.store.updateUser(user.id, { passwordHash: await hashPassword(newPassword), emailVerified: true });
    await this.store.deleteCode('reset', user.id);
    await this.store.deleteSessionsFor(user.id);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    validatePassword(newPassword);
    const user = await this.store.userById(userId);
    if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) throw new AuthError('Одоогийн нууц үг буруу байна.', 401);
    await this.store.updateUser(userId, { passwordHash: await hashPassword(newPassword) });
  }

  // ── админ/CLI ──

  async setRole(userId: string, role: AuthRole): Promise<void> {
    const user = await this.store.userById(userId);
    if (!user) throw new AuthError('Хэрэглэгч олдсонгүй.', 404);
    await this.store.updateUser(userId, { role });
  }

  async adminResetPassword(userId: string, newPassword: string): Promise<void> {
    validatePassword(newPassword);
    const user = await this.store.userById(userId);
    if (!user) throw new AuthError('Хэрэглэгч олдсонгүй.', 404);
    await this.store.updateUser(userId, { passwordHash: await hashPassword(newPassword) });
    await this.store.deleteSessionsFor(userId);
  }

  async listAccounts(): Promise<Account[]> {
    return (await this.store.listUsers()).map(toAccount);
  }

  async accountByUsername(username: string): Promise<Account | null> {
    const user = await this.store.userByUsernameKey(normalise(username));
    return user ? toAccount(user) : null;
  }
}
