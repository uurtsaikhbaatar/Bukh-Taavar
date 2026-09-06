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

export function fmtShares(s: number): string {
  return s >= 100 ? fmtTokens(s) : s.toFixed(1);
}
