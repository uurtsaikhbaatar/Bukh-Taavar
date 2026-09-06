/** Монгол хэлний харуулалтын туслахууд. */

/** 1234567 → "1 234 567" (зайгаар бүлэглэнэ). */
export function fmtTokens(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Math.round(n));
  return sign + abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 0.6234 → "62%" (digits=1 → "62.3%"). */
export function fmtPct(p: number, digits = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

/** Улаанбаатарын цагаар "2026-07-11 10:30". */
export function fmtDateTime(iso: string, timeZone = 'Asia/Ulaanbaatar'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return parts.replace(',', '');
}

/** Баганыг тэгшитгэх (терминалын хүснэгт). */
export function padEnd(s: string, width: number): string {
  const len = [...s].length;
  return len >= width ? s : s + ' '.repeat(width - len);
}

export function padStart(s: string, width: number): string {
  const len = [...s].length;
  return len >= width ? s : ' '.repeat(width - len) + s;
}

/** Энгийн текст хүснэгт. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = rows.map((r) => r.map((c) => (typeof c === 'number' ? fmtTokens(c) : c)));
  const widths = headers.map((h, i) => Math.max([...h].length, ...cells.map((r) => [...(r[i] ?? '')].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? padEnd(c, widths[i]!) : padStart(c, widths[i]!))).join('  ');
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}
