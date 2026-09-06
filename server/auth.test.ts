import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryAuthStore } from './auth-store.ts';
import { Auth, AuthError, hashPassword, verifyPassword } from './auth.ts';
import type { EmailMessage } from './email.ts';

function harness() {
  const sent: EmailMessage[] = [];
  let t = Date.parse('2026-08-16T10:00:00Z');
  const clock = { advance: (ms: number) => (t += ms) };
  let n = 0;
  const auth = new Auth(new MemoryAuthStore(), {
    now: () => t,
    idGen: () => `u${++n}`,
    sendEmail: async (m) => {
      sent.push(m);
    },
  });
  const lastCode = () => sent.at(-1)!.subject.match(/(\d{6})/)![1]!;
  return { auth, sent, clock, lastCode };
}

const expectErr = async (p: Promise<unknown>, re: RegExp, status?: number) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AuthError, `AuthError хүлээсэн: ${String(e)}`);
    assert.match(e.message, re);
    if (status !== undefined) assert.equal(e.status, status);
    return;
  }
  assert.fail(`алдаа гарах ёстой байсан: ${re}`);
};

test('scrypt hash/verify', async () => {
  const h = await hashPassword('нууц-үг1');
  assert.ok(await verifyPassword('нууц-үг1', h));
  assert.ok(!(await verifyPassword('буруу', h)));
  assert.ok(!(await verifyPassword('x', 'эвдэрсэн')));
});

test('бүртгэл: эхнийх админ, давхардал, баталгаажуулалт, session', async () => {
  const { auth, sent, lastCode, clock } = harness();
  const r1 = await auth.register('Батцэнгэл', 'secret1', 'bz@example.com');
  assert.equal(r1.account.role, 'admin');
  assert.equal(r1.account.emailVerified, false);
  assert.ok(r1.codeSent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'bz@example.com');
  const r2 = await auth.register('Бат', 'secret2', 'bat@example.com');
  assert.equal(r2.account.role, 'member');

  await expectErr(auth.register('батцэнгэл', 'secret3', 'x@example.com'), /аль хэдийн/);
  await expectErr(auth.register('Өөр', 'secret3', 'BZ@example.com'), /имэйлээр/);
  await expectErr(auth.register('a', 'secret3', 'a@example.com'), /тэмдэгт/);
  await expectErr(auth.register('Зөв нэр', '123', 'a@example.com'), /Нууц үг/);
  await expectErr(auth.register('Зөв нэр', 'secret3', 'буруу-имэйл'), /Имэйл/);
  await expectErr(auth.register('Нэр!@#', 'secret3', 'a@example.com'), /үсэг, тоо/);

  // session
  const acc = await auth.accountForToken(r1.token);
  assert.equal(acc?.id, 'u1');
  assert.equal(await auth.accountForToken('байхгүй'), null);
  assert.equal(await auth.accountForToken(undefined), null);

  // баталгаажуулалт: буруу код → оролдлого хасагдана; зөв → verified
  const codeBat = lastCode();
  await expectErr(auth.verifyEmail('u2', '000000'), /Код буруу/);
  const ok = await auth.verifyEmail('u2', codeBat);
  assert.equal(ok.emailVerified, true);
  assert.equal((await auth.account('u2'))?.emailVerified, true);
  // Дахин баталгаажуулах шаардлагагүй
  await expectErr(auth.resendCode('u2'), /аль хэдийн/);

  clock.advance(61 * 24 * 3_600_000);
  assert.equal(await auth.accountForToken(r1.token), null, 'session 60 хоногт дуусна');
});

test('код: хугацаа, оролдлогын хязгаар, дахин илгээх хүлээлт', async () => {
  const { auth, lastCode, clock, sent } = harness();
  await auth.register('Бат', 'secret1', 'bat@example.com');
  for (let i = 0; i < 5; i++) await expectErr(auth.verifyEmail('u1', '000000'), /Код буруу|Хэт олон/);
  await expectErr(auth.verifyEmail('u1', lastCode()), /Хэт олон/);
  await expectErr(auth.resendCode('u1'), /секундын дараа/, 429);
  clock.advance(61_000);
  await auth.resendCode('u1');
  assert.equal(sent.length, 2);
  clock.advance(16 * 60_000);
  await expectErr(auth.verifyEmail('u1', lastCode()), /хугацаа дууссан/);
});

test('нэвтрэх, гарах, нууц үг сэргээх (мэдээлэл задруулахгүй)', async () => {
  const { auth, sent, lastCode, clock } = harness();
  await auth.register('Бат', 'secret1', 'bat@example.com');
  await expectErr(auth.login('Бат', 'буруу'), /буруу/, 401);
  await expectErr(auth.login('байхгүй', 'secret1'), /буруу/, 401);
  const { token } = await auth.login('бат', 'secret1');
  assert.ok(await auth.accountForToken(token));
  await auth.logout(token);
  assert.equal(await auth.accountForToken(token), null);

  // Мартсан: бүртгэлгүй имэйлд ч алдаа шидэхгүй, юу ч илгээхгүй
  const before = sent.length;
  await auth.forgotPassword('nobody@example.com');
  assert.equal(sent.length, before);
  await auth.forgotPassword('BAT@example.com');
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1)!.subject, /сэргээх/);
  // Дахин хүсвэл 60 сек дотор илгээхгүй
  await auth.forgotPassword('bat@example.com');
  assert.equal(sent.length, before + 1);
  const code = lastCode();
  await expectErr(auth.resetPassword('bat@example.com', '000000', 'newpass1'), /Код буруу/);
  await expectErr(auth.resetPassword('bat@example.com', code, '123'), /Нууц үг/);
  await auth.resetPassword('bat@example.com', code, 'newpass1');
  await expectErr(auth.login('Бат', 'secret1'), /буруу/);
  const again = await auth.login('Бат', 'newpass1');
  assert.ok(again.token);
  // Сэргээснээр имэйл баталгаажсанд тооцно
  assert.equal(again.account.emailVerified, true);
  clock.advance(1);

  // Нууц үг солих
  await expectErr(auth.changePassword('u1', 'буруу', 'abcdef'), /Одоогийн/, 401);
  await auth.changePassword('u1', 'newpass1', 'abcdef');
  assert.ok((await auth.login('Бат', 'abcdef')).token);

  // Админ үйлдлүүд
  await auth.setRole('u1', 'admin');
  assert.equal((await auth.account('u1'))?.role, 'admin');
  await auth.adminResetPassword('u1', 'zzzzzz');
  assert.ok((await auth.login('Бат', 'zzzzzz')).token);
  assert.equal((await auth.listAccounts()).length, 1);
  assert.equal((await auth.accountByUsername('БАТ'))?.id, 'u1');
});
