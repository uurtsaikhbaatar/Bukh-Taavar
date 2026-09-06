/**
 * Имэйл илгээх (bigtwo-ийн загвар).
 *
 *   EMAIL_PROVIDER=brevo|sendgrid|resend
 *   EMAIL_API_KEY=…
 *   EMAIL_FROM="Бөхийн таавар <баталгаажуулсан@хаяг>"
 *
 * Түлхүүр тохируулаагүй бол "консол" горим — илгээх байсан агуулгыг серверийн
 * лог руу бичнэ (локал туршилтад имэйлийн үйлчилгээгүйгээр ажиллана).
 */

export type EmailProvider = 'resend' | 'sendgrid' | 'brevo' | 'console';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export const APP_NAME = 'Бөхийн таавар';

export function emailProvider(): EmailProvider {
  const configured = (process.env.EMAIL_PROVIDER ?? '').toLowerCase();
  if (!process.env.EMAIL_API_KEY) return 'console';
  if (configured === 'resend' || configured === 'sendgrid' || configured === 'brevo') return configured;
  return 'console';
}

function sender(): string {
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM тохируулаагүй байна.');
  return from;
}

function apiKey(): string {
  const key = (process.env.EMAIL_API_KEY ?? '').trim();
  if (!key) throw new Error('EMAIL_API_KEY тохируулаагүй байна.');
  if (!/^[\x20-\x7E]+$/.test(key)) {
    throw new Error('EMAIL_API_KEY-д латин бус тэмдэгт байна — жинхэнэ түлхүүрээ оруулна уу (Brevo-гийнх "xkeysib-" гэж эхэлдэг).');
  }
  return key;
}

function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim();
}

function senderName(value: string): string {
  const match = value.match(/^\s*([^<]+?)\s*</);
  return match ? match[1]! : bareAddress(value);
}

/** Тестэд/локалд илгээлтийг барьж авах хук. */
export let emailSink: ((message: EmailMessage) => void) | null = null;
export function setEmailSink(sink: ((message: EmailMessage) => void) | null): void {
  emailSink = sink;
}

/** Имэйл илгээнэ. Амжилтгүй бол алдаа шиднэ. Консол горимд үргэлж амжилттай. */
export async function sendEmail(message: EmailMessage): Promise<EmailProvider> {
  if (emailSink) emailSink(message);
  const provider = emailProvider();
  if (provider === 'console') {
    console.log('─'.repeat(60));
    console.log(`ИМЭЙЛ (консол горим) → ${message.to}`);
    console.log(`Гарчиг: ${message.subject}`);
    console.log(message.text);
    console.log('─'.repeat(60));
    return provider;
  }
  const key = apiKey();
  const from = sender();
  const requests: Record<Exclude<EmailProvider, 'console'>, { url: string; init: RequestInit }> = {
    resend: {
      url: 'https://api.resend.com/emails',
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      },
    },
    sendgrid: {
      url: 'https://api.sendgrid.com/v3/mail/send',
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: bareAddress(from) },
          subject: message.subject,
          content: [{ type: 'text/plain', value: message.text }, ...(message.html ? [{ type: 'text/html', value: message.html }] : [])],
        }),
      },
    },
    brevo: {
      url: 'https://api.brevo.com/v3/smtp/email',
      init: {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: senderName(from), email: bareAddress(from) },
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
        }),
      },
    },
  };
  const { url, init } = requests[provider];
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${provider} имэйл илгээж чадсангүй (${response.status}): ${body.slice(0, 200)}`);
  }
  return provider;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function codeHtml(intro: string, code: string, extra: string): string {
  return `
    <div style="font-family:system-ui,sans-serif;max-width:420px">
      <h2 style="margin:0 0 8px">${APP_NAME}</h2>
      ${intro}
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:16px 0">${code}</p>
      <p style="color:#666;font-size:13px">${extra}</p>
    </div>`;
}

export function verificationEmail(username: string, code: string): Omit<EmailMessage, 'to'> {
  const text = [
    `Сайн байна уу, ${username}!`,
    '',
    `${APP_NAME} — бүртгэлээ баталгаажуулах код:`,
    '',
    `    ${code}`,
    '',
    'Код 15 минутын дараа хүчингүй болно.',
    'Хэрэв та бүртгүүлээгүй бол энэ захидлыг үл тоомсорлоно уу.',
  ].join('\n');
  const html = codeHtml(
    `<p>Сайн байна уу, <strong>${escapeHtml(username)}</strong>!</p><p>Бүртгэлээ баталгаажуулах код:</p>`,
    code,
    'Код 15 минутын дараа хүчингүй болно.<br>Хэрэв та бүртгүүлээгүй бол энэ захидлыг үл тоомсорлоно уу.',
  );
  return { subject: `${APP_NAME} — баталгаажуулах код ${code}`, text, html };
}

export function passwordResetEmail(username: string, code: string): Omit<EmailMessage, 'to'> {
  const text = [
    `${APP_NAME} — нууц үг сэргээх хүсэлт хүлээн авлаа.`,
    '',
    `Таны хэрэглэгчийн нэр:  ${username}`,
    '',
    'Сэргээх код:',
    '',
    `    ${code}`,
    '',
    'Код 15 минутын дараа хүчингүй болно.',
    'Хэрэв та хүсэлт илгээгээгүй бол энэ захидлыг үл тоомсорлоно уу — нууц үг чинь өөрчлөгдөхгүй.',
  ].join('\n');
  const html = codeHtml(
    `<p>Нууц үг сэргээх хүсэлт хүлээн авлаа.</p><p>Таны хэрэглэгчийн нэр: <strong>${escapeHtml(username)}</strong></p><p>Сэргээх код:</p>`,
    code,
    'Код 15 минутын дараа хүчингүй болно.<br>Хэрэв та хүсэлт илгээгээгүй бол энэ захидлыг үл тоомсорлоно уу — нууц үг чинь өөрчлөгдөхгүй.',
  );
  return { subject: `${APP_NAME} — нууц үг сэргээх код ${code}`, text, html };
}
