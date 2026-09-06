/**
 * devjee.mn-ийн аймаг/сумын нэрсийн жагсаалтыг bundle-аас задалж
 * `src/devjee-places.ts` файлыг үүсгэнэ (нэг удаа; сум нэмэгдвэл дахин).
 *
 *   node scripts/devjee-places-gen.ts
 */

import { writeFileSync } from 'node:fs';

const html = await (await fetch('https://www.devjee.mn/')).text();
const asset = html.match(/assets\/index-[\w-]+\.js/)?.[0];
if (!asset) throw new Error('bundle олдсонгүй');
const js = await (await fetch(`https://www.devjee.mn/${asset}`)).text();

// me(Pe,"Arkhangai",1) … → нэр → код
const codes = new Map<string, number>();
for (const m of js.matchAll(/me\(Pe,"([A-Za-z]+)",(\d+)\)/g)) codes.set(m[1]!, Number(m[2]));

// me(Pe,"data",{ … }) объектыг тэнцвэртэй хаалтаар таслана
const start = js.indexOf('me(Pe,"data",{');
if (start < 0) throw new Error('data объект олдсонгүй');
let i = start + 'me(Pe,"data",'.length;
let depth = 0;
let end = -1;
for (; i < js.length; i++) {
  const ch = js[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
let src = js.slice(start + 'me(Pe,"data",'.length, end);
src = src.replace(/\[Pe\.([A-Za-z]+)\]/g, (_, n: string) => `"${codes.get(n)}"`);
src = src.replace(/([{,])\s*([A-Za-z_]\w*|\d+)\s*:/g, '$1"$2":');
src = src.replace(/!0/g, 'true').replace(/!1/g, 'false');
const data = JSON.parse(src) as Record<string, { name: string; shortName: string; sum: Record<string, { name: string; hiddenFromSelector?: boolean }> }>;

const lines: string[] = [
  '/** АВТОМАТААР ҮҮСГЭСЭН — scripts/devjee-places-gen.ts (devjee.mn-ийн аймаг/сумын нэрс). Гараар засахгүй. */',
  '',
  'export interface PlaceAimag {',
  '  name: string;',
  '  short: string;',
  '  sums: Record<number, string>;',
  '}',
  '',
  'export const PLACES: Readonly<Record<number, PlaceAimag>> = {',
];
for (const [code, a] of Object.entries(data).sort((x, y) => Number(x[0]) - Number(y[0]))) {
  const sums = Object.entries(a.sum)
    .sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([k, s]) => `${k}: ${JSON.stringify(s.name)}`)
    .join(', ');
  lines.push(`  ${code}: { name: ${JSON.stringify(a.name)}, short: ${JSON.stringify(a.shortName)}, sums: { ${sums} } },`);
}
lines.push('};', '', '/** «Сэлэнгэ, Цагааннуур» — код → нэр (сум байхгүй бол зөвхөн аймаг). */', 'export function placeName(aimag: number | string | undefined, sum?: number | string | undefined): string | undefined {', '  const a = PLACES[Number(aimag)];', '  if (!a) return undefined;', '  const s = sum !== undefined && sum !== "" ? a.sums[Number(sum)] : undefined;', '  return s ? `${a.name}, ${s}` : a.name;', '}', '', 'export function sumName(aimag: number | string | undefined, sum: number | string | undefined): string | undefined {', '  return PLACES[Number(aimag)]?.sums[Number(sum)];', '}', '');
writeFileSync('src/devjee-places.ts', lines.join('\n'), 'utf8');
const total = Object.values(data).reduce((n, a) => n + Object.keys(a.sum).length, 0);
console.log(`src/devjee-places.ts: ${Object.keys(data).length} аймаг, ${total} сум/дүүрэг`);
