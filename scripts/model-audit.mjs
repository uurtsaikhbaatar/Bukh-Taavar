// Загварын аудит: scripts/ab-test.ts-ийн гаралт (data/ab/ab-<шошго>.json) → хэсэг хэсгээр нарийвчлал, калибровк.
//   node scripts/model-audit.mjs <шошго> [харьцуулах шошго]
// Фаворит давсан = загвар >50% өгсөн бөх давсан хувь; log-loss бага нь сайн (0.693 = зоос);
// «зөрүү» = фаворитын дундаж таамаг − бодит давалт (эерэг = хэт итгэлтэй), z = зөрүү / стандарт алдаа.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const load = (l) => JSON.parse(readFileSync(path.join('data', 'ab', `ab-${l}.json`), 'utf8'));
const A = load(process.argv[2]);
const B = process.argv[3] ? load(process.argv[3]) : null;
const tinfo = new Map(A.tournaments.map((t) => [t.tid, t]));
const keyOf = (r) => `${r.tid}|${r.mid}`;
const other = B ? new Map(B.rows.map((r) => [keyOf(r), r])) : null;
const rows = A.rows.filter((r) => r.p !== null && (!other || other.get(keyOf(r))?.p != null));

const stat = (rs, get = (r) => r.p) => {
  const n = rs.length;
  if (!n) return null;
  let fav = 0, ll = 0, br = 0, sp = 0, sv = 0;
  for (const r of rs) {
    const p = get(r);
    const f = Math.max(p, 1 - p);
    fav += p > 0.5 ? 1 : p === 0.5 ? 0.5 : 0;
    ll -= Math.log(Math.max(1e-12, p));
    br += (1 - p) ** 2;
    sp += f;
    sv += f * (1 - f);
  }
  const gap = sp / n - fav / n;
  return { n, fav: fav / n, ll: ll / n, br: br / n, exp: sp / n, gap, z: gap / Math.sqrt(sv / n / n) };
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f3 = (x) => x.toFixed(3);
const sgn = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}`;

function table(title, groups) {
  console.log(`\n### ${title}`);
  console.log(B ? '| Хэсэг | Барилдаан | Фаворит давсан | Таамаг | Зөрүү (нэгж хувь) | z | Log-loss | Харьцуулах log-loss | Δ |' : '| Хэсэг | Барилдаан | Фаворит давсан | Таамаг | Зөрүү (нэгж хувь) | z | Log-loss |');
  console.log(B ? '|---|---:|---:|---:|---:|---:|---:|---:|---:|' : '|---|---:|---:|---:|---:|---:|---:|');
  for (const [name, rs] of groups) {
    const s = stat(rs);
    if (!s) continue;
    let line = `| ${name} | ${s.n} | ${pct(s.fav)} | ${pct(s.exp)} | ${sgn(s.gap)} | ${s.z.toFixed(1)} | ${f3(s.ll)} |`;
    if (B) {
      const o = stat(rs, (r) => other.get(keyOf(r)).p);
      line += ` ${f3(o.ll)} | ${(s.ll - o.ll >= 0 ? '+' : '') + (s.ll - o.ll).toFixed(4)} |`;
    }
    console.log(line);
  }
}
const group = (keyFn, order) => {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === undefined || k === null) continue;
    (m.get(k) ?? m.set(k, []).get(k)).push(r);
  }
  const keys = order ?? [...m.keys()].sort();
  return keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)]);
};

console.log(`Хамрах хүрээ: ${A.n} тэмцээн, ${A.tournaments[0].date} … ${A.tournaments.at(-1).date}; нийт ${A.rows.length} барилдаан, таавартай ${rows.length}`);
table('Нийт', [['Бүгд', rows]]);
table('Оноор', group((r) => r.date.slice(0, 4)));
table('Хэлбэрээр', group((r) => ({ ko: 'Шигшээ', rr: 'Тойргийн', team: 'Багийн' })[r.fmt], ['Шигшээ', 'Тойргийн', 'Багийн']));
const ko = rows.filter((r) => r.fmt === 'ko');
const sub = (title, keyFn, order, base = ko) => {
  const m = new Map();
  for (const r of base) { const k = keyFn(r); if (k == null) continue; (m.get(k) ?? m.set(k, []).get(k)).push(r); }
  table(title, (order ?? [...m.keys()].sort()).filter((k) => m.has(k)).map((k) => [k, m.get(k)]));
};
sub('Даваагаар (шигшээ)', (r) => (r.round >= 8 ? '8+ даваа' : `${r.round}-р даваа`), ['1-р даваа', '2-р даваа', '3-р даваа', '4-р даваа', '5-р даваа', '6-р даваа', '7-р даваа', '8+ даваа']);
const gb = (g) => (g === 0 ? '0 (анх удаа)' : g <= 2 ? '1–2' : g <= 5 ? '3–5' : g <= 10 ? '6–10' : g <= 20 ? '11–20' : g <= 50 ? '21–50' : g <= 150 ? '51–150' : '151+');
const GO = ['0 (анх удаа)', '1–2', '3–5', '6–10', '11–20', '21–50', '51–150', '151+'];
sub('Туршлага багатай талын өмнөх барилдааны тоогоор (шигшээ)', (r) => gb(Math.min(r.g1, r.g2)), GO);
// Туршлага багатай тал нь ФАВОРИТ уу, сул тал уу
sub('Туршлага багатай (≤5) бөх: загвар түүнийг фаворит гэсэн үү', (r) => {
  const lo = r.g1 <= r.g2 ? 1 : 2;
  if (Math.min(r.g1, r.g2) > 5 || Math.max(r.g1, r.g2) <= 5) return null;
  const pLo = lo === 1 ? r.p1 : 1 - r.p1;
  return pLo > 0.5 ? 'шинэ бөх фаворит' : pLo > 0.2 ? 'шинэ бөх 20–50%' : pLo > 0.05 ? 'шинэ бөх 5–20%' : 'шинэ бөх <5%';
}, ['шинэ бөх фаворит', 'шинэ бөх 20–50%', 'шинэ бөх 5–20%', 'шинэ бөх <5%']);
sub('Фаворитын магадлалын бүсээр (калибровк, шигшээ)', (r) => {
  const f = Math.max(r.p, 1 - r.p);
  return f < 0.55 ? '50–55%' : f < 0.6 ? '55–60%' : f < 0.7 ? '60–70%' : f < 0.8 ? '70–80%' : f < 0.9 ? '80–90%' : f < 0.95 ? '90–95%' : f < 0.98 ? '95–98%' : '98–100%';
}, ['50–55%', '55–60%', '60–70%', '70–80%', '80–90%', '90–95%', '95–98%', '98–100%']);
sub('Тэмцээний хэмжээгээр (барилдсан бөх, шигшээ)', (r) => {
  const n = tinfo.get(r.tid).size;
  return n < 32 ? '<32' : n < 100 ? '32–99' : n < 200 ? '100–199' : n < 400 ? '200–399' : n < 800 ? '400–799' : '800+';
}, ['<32', '32–99', '100–199', '200–399', '400–799', '800+']);
const TYPE = { 1: 'Улсын наадам', 34: 'Аймгийн баяр наадам', 35: 'Орон нутгийн барилдаан', 37: 'Ойн барилдаан', 30: 'Нэрэмжит барилдаан', 31: 'Аймгийн цолтон', 33: 'Сумын цолтон', 38: 'Цолгүй залуу бөхчүүд', 28: 'Наадмын сорилго', 8: 'Цэргийн наадам', 2: 'Цагаан сар' };
sub('Тэмцээний төрлөөр (шигшээ; 400-аас дээш барилдаантай төрөл)', (r) => {
  const ty = tinfo.get(r.tid).types?.[0];
  return ty === undefined ? 'төрөлгүй' : TYPE[ty] ?? `бусад төрөл`;
});
sub('Насны зөрүүгээр (фаворит − сул тал, шигшээ)', (r) => {
  if (r.a1 == null || r.a2 == null) return 'нас мэдэгдэхгүй';
  const favIs1 = r.p1 >= 0.5; const d = favIs1 ? r.a1 - r.a2 : r.a2 - r.a1;
  return d < -8 ? 'фаворит 8+ залуу' : d < -3 ? 'фаворит 3–8 залуу' : d <= 3 ? '±3 жил' : d <= 8 ? 'фаворит 3–8 ах' : 'фаворит 8+ ах';
}, ['фаворит 8+ залуу', 'фаворит 3–8 залуу', '±3 жил', 'фаворит 3–8 ах', 'фаворит 8+ ах', 'нас мэдэгдэхгүй']);
sub('Хосолгооны төрлөөр (шигшээ)', (r) => ({ o: 'оноолт', a: 'ам', t: 'түнээ', s: 'сугалаа', y: 'гоц', '': 'тэмдэггүй' })[r.kind] ?? 'бусад');
sub('Рейтингийн зөрүүгээр (хурдан рейтинг, шигшээ)', (r) => {
  const d = Math.abs(r.r1 - r.r2);
  return d < 50 ? '<50' : d < 100 ? '50–99' : d < 200 ? '100–199' : d < 400 ? '200–399' : '400+';
}, ['<50', '50–99', '100–199', '200–399', '400+']);
// Хамгийн том гэнэтийн үр дүнгүүдийн төвлөрөл: давсан бөхийн магадлал <5%
const upsets = ko.filter((r) => r.p < 0.05);
console.log(`\nДавсан бөхөд загвар 5%-аас бага өгсөн: ${upsets.length} (${pct(upsets.length / ko.length)}); эдгээрээс туршлага ≤5 талтай ${upsets.filter((r) => Math.min(r.g1, r.g2) <= 5).length}; эдгээрийн log-loss-д эзлэх хувь ${pct(upsets.reduce((s, r) => s - Math.log(Math.max(1e-12, r.p)), 0) / ko.reduce((s, r) => s - Math.log(Math.max(1e-12, r.p)), 0))}`);
