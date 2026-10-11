/** Аппын харуулалтын туслахууд (серверийн `src/format.ts`-тэй ижил дүрэм). */

export function fmtTokens(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Math.round(n));
  return sign + abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function fmtPct(p: number, digits = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtSigned(n: number): string {
  return n > 0 ? `+${fmtTokens(n)}` : fmtTokens(n);
}

/** ISO → "08-20 10:30" (УБ цагаар, хөтчийн Intl). */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ulaanbaatar', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(d)
      .replace(',', '');
  } catch {
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }
}

/** Давааны нэр: devjee дээр нэртэй / шигшээ биш даваа бол тэр нэр («15 нас»), үгүй бол «N-р даваа». */
export function roundName(round: number, labels?: Record<string, string>): string {
  return labels?.[String(round)] ?? `${round}-р даваа`;
}

/** Шигшээ биш тэмцээний хэлбэрийн нэр. */
export function formatName(format: 'round-robin' | 'team'): string {
  return format === 'team' ? 'багийн барилдаан' : 'тойргийн барилдаан';
}

/** ISO → "5 секундын өмнө" / "35 минутын өмнө" / "3 цагийн өмнө" / "2 хоногийн өмнө". */
export function fmtAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 90) return `${sec} секундын өмнө`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} минутын өмнө`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} цагийн өмнө`;
  return `${Math.round(hr / 24)} хоногийн өмнө`;
}

export function fmtShares(s: number): string {
  return s >= 100 ? fmtTokens(s) : s.toFixed(1);
}
