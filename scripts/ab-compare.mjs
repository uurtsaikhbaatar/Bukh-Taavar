// A/B харьцуулалт: data/ab/ab-old.json ба ab-new.json (scripts/ab-test.ts-ийн гаралт) → хүснэгтүүд.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.join('data', 'ab');
const load = (l) => JSON.parse(readFileSync(path.join(dir, `ab-${l}.json`), 'utf8'));
const O = load('old'), N = load('new');
const key = (r) => `${r.tid}|${r.mid}`;
const newBy = new Map(N.rows.map((r) => [key(r), r]));
const pairs = O.rows.map((o) => ({ o, n: newBy.get(key(o)) }));

const stat = (ps) => {
  const n = ps.length;
  if (!n) return { n: 0 };
  let fav = 0, ll = 0, br = 0;
  for (const p of ps) { fav += p > 0.5 ? 1 : p === 0.5 ? 0.5 : 0; ll -= Math.log(Math.max(1e-12, p)); br += (1 - p) ** 2; }
  return { n, fav: fav / n, ll: ll / n, br: br / n };
};
const pct = (x) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const f3 = (x) => (x === undefined ? '—' : x.toFixed(3));
const line = (name, sub) => {
  const both = sub.filter((x) => x.o.p !== null && x.n?.p != null);
  const a = stat(both.map((x) => x.o.p)), b = stat(both.map((x) => x.n.p));
  const changed = both.filter((x) => Math.abs(x.o.p - x.n.p) > 1e-9).length;
  return `| ${name} | ${a.n} | ${changed} | ${pct(a.fav)} | ${pct(b.fav)} | ${f3(a.ll)} | ${f3(b.ll)} | ${a.n ? (b.ll - a.ll >= 0 ? '+' : '') + (b.ll - a.ll).toFixed(3) : '—'} | ${f3(a.br)} | ${f3(b.br)} |`;
};

console.log(`Хамрах хүрээ: ${O.n} тэмцээн, ${O.tournaments[0].date} … ${O.tournaments.at(-1).date}; нийт ${O.rows.length} барилдаан`);
const noShow = O.rows.filter((r) => r.noShow).length;
const oldOnly = pairs.filter((x) => x.o.p !== null && x.n?.p == null);
const newOnly = pairs.filter((x) => x.o.p === null && x.n?.p != null && !x.o.noShow);
console.log(`гоц (ирээгүй) ${noShow}; хуучин л таавар нээсэн ${oldOnly.length} (өөр төрлийн бөх ${oldOnly.filter((x) => x.o.other).length}); шинэ л нээсэн ${newOnly.length} (ижил нэртэй бөх)`);
const so = stat(oldOnly.map((x) => x.o.p));
console.log(`хуучны «өөр төрлийн бөх»-ийн ${so.n} таавар: фаворит ${pct(so.fav)}, log-loss ${f3(so.ll)}`);
console.log(`хуучин БҮХ таавар: ${JSON.stringify(stat(O.rows.filter((r) => r.p !== null).map((r) => r.p)))}`);
console.log(`шинэ БҮХ таавар: ${JSON.stringify(stat(N.rows.filter((r) => r.p !== null).map((r) => r.p)))}`);

console.log('\n| Хэсэг | Барилдаан | Таамаг өөрчлөгдсөн | Фаворит давсан: хуучин | шинэ | Log-loss: хуучин | шинэ | Зөрүү | Brier: хуучин | шинэ |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
console.log(line('Бүгд (хоёулаа таавар нээсэн)', pairs));
console.log(line('Шигшээ даваа', pairs.filter((x) => x.o.fmt === 'ko')));
console.log(line('Тойргийн даваа', pairs.filter((x) => x.o.fmt === 'rr')));
console.log(line('Багийн даваа (Монгол бөх)', pairs.filter((x) => x.o.fmt === 'team')));
console.log(line('Түүхгүй бөх оролцсон', pairs.filter((x) => x.o.newcomer)));
console.log(line('Хоёулаа түүхтэй', pairs.filter((x) => !x.o.newcomer)));

// хосолсон зөрүүний найдвартай байдал (тэмцээнээр бүлэглэсэн)
const both = pairs.filter((x) => x.o.p !== null && x.n?.p != null);
const byT = new Map();
for (const x of both) (byT.get(x.o.tid) ?? byT.set(x.o.tid, []).get(x.o.tid)).push(x);
let better = 0, worse = 0, same = 0;
const tdiff = [];
for (const [, xs] of byT) {
  const d = stat(xs.map((x) => x.n.p)).ll - stat(xs.map((x) => x.o.p)).ll;
  tdiff.push(d * xs.length);
  if (d < -1e-9) better += 1; else if (d > 1e-9) worse += 1; else same += 1;
}
console.log(`\nТэмцээнээр: шинэ нь сайжирсан ${better}, муудсан ${worse}, ижил ${same}`);
// бөөгнөрсөн (тэмцээнээр) bootstrap
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const arr = [...byT.values()]; const boots = [];
for (let i = 0; i < 4000; i++) { let s = 0, n = 0; for (let k = 0; k < arr.length; k++) { const xs = arr[Math.floor(rnd() * arr.length)]; for (const x of xs) { s += -Math.log(Math.max(1e-12, x.n.p)) + Math.log(Math.max(1e-12, x.o.p)); n += 1; } } boots.push(s / n); }
boots.sort((a, b) => a - b);
console.log(`Log-loss-ийн зөрүү (шинэ − хуучин), тэмцээнээр бөөгнөрүүлсэн bootstrap 95%: [${boots[100].toFixed(4)}, ${boots[3899].toFixed(4)}]`);

// калибровк (шинэ)
console.log('\nШинэ хувилбарын калибровк (фаворитын таамаг → бодит):');
const B = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001];
for (let i = 0; i < B.length - 1; i++) {
  for (const [lab, src] of [['хуучин', 'o'], ['шинэ', 'n']]) {
    let n = 0, sp = 0, sy = 0;
    for (const x of both) { const p = x[src].p; const fav = Math.max(p, 1 - p); if (fav >= B[i] && fav < B[i + 1]) { n += 1; sp += fav; sy += p > 0.5 ? 1 : p === 0.5 ? 0.5 : 0; } }
    if (n) console.log(`  ${(B[i] * 100).toFixed(0)}–${Math.min(100, B[i + 1] * 100).toFixed(0)}% ${lab}: n=${n} таамаг ${(sp / n * 100).toFixed(1)}% бодит ${(sy / n * 100).toFixed(1)}%`);
  }
}

// тэмцээн бүрээр
const fmtName = (t) => (t.formats.includes('team') ? 'багийн' : t.formats.includes('round-robin') ? 'тойргийн' : 'шигшээ');
console.log('\n| № | Огноо | Тэмцээн | Хэлбэр | Барилдаан | Фаворит: хуучин | шинэ | Log-loss: хуучин | шинэ | Зөрүү |');
console.log('|---:|---|---|---|---:|---:|---:|---:|---:|---:|');
[...N.tournaments].reverse().forEach((t, i) => {
  const xs = byT.get(t.tid) ?? [];
  const a = stat(xs.map((x) => x.o.p)), b = stat(xs.map((x) => x.n.p));
  const name = t.name.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  const d = b.ll - a.ll;
  console.log(`| ${i + 1} | ${t.date.slice(5)} | ${name.length > 46 ? name.slice(0, 45) + '…' : name} | ${fmtName(t)} | ${a.n} | ${pct(a.fav)} | ${pct(b.fav)} | ${f3(a.ll)} | ${f3(b.ll)} | ${Math.abs(d) < 0.0005 ? '0' : (d > 0 ? '+' : '') + d.toFixed(3)} |`);
});

// сүүлийн 50 хос барилдаан (он цагийн дарааллаар хамгийн сүүлийнх)
const last = both.slice(-50);
const lo = stat(last.map((x) => x.o.p)), ln = stat(last.map((x) => x.n.p));
console.log(`\nСүүлийн 50 хос барилдаан (${last[0].o.date} … ${last.at(-1).o.date}; тэмцээн: ${[...new Set(last.map((x) => x.o.tid))].join(', ')}): хуучин фаворит ${pct(lo.fav)}, log-loss ${f3(lo.ll)}; шинэ ${pct(ln.fav)}, ${f3(ln.ll)}`);
