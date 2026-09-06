/**
 * Гинжийн параметрийг backtest дээр тохируулна: β (үеийн бууралт), smooth (сэлбэлт), shrink.
 *   npm run tune -- [--split 2026-01-01] [--sample 400]
 */

import { table } from '../src/format.ts';
import { BoutGraph, loadArchive } from '../src/graph.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const SPLIT = opt('split', '2026-01-01');
const SAMPLE = Number(opt('sample', '400'));

const archive = loadArchive();
const clean = archive.bouts.filter((b) => !b.noShow && b.w1 !== b.w2);
const train = clean.filter((b) => b.date < SPLIT);
const seen = new Set<string>();
for (const b of train) {
  seen.add(b.w1);
  seen.add(b.w2);
}
const test = clean.filter((b) => b.date >= SPLIT && seen.has(b.w1) && seen.has(b.w2));
let s = 12345;
const rnd = () => {
  s = (s * 1664525 + 1013904223) % 4294967296;
  return s / 4294967296;
};
const sample = [...test].sort(() => rnd() - 0.5).slice(0, SAMPLE);
const g = new BoutGraph(clean, { asOf: SPLIT, halfLifeYears: 4 });

const grid: { beta: number; smooth: number; shrink: number }[] = [];
for (const beta of [0.5, 0.8]) for (const smooth of [0, 0.002, 0.01, 0.05]) for (const shrink of [1, 0.6, 0.35]) grid.push({ beta, smooth, shrink });

// Гинжийн score-ийг нэг удаа тооцоод (β-ээс хамаарна) сэлбэлт/shrink-ийг хурдан үнэлнэ
const rows: string[][] = [];
for (const beta of [0.5, 0.8]) {
  const scores = sample.map((b) => {
    const c = g.chain(b.w1, b.w2, { maxHops: 10, beta, topPaths: 0 });
    return { ab: c.scoreAB, ba: c.scoreBA, won1: b.winner === 1 };
  });
  for (const cfg of grid.filter((x) => x.beta === beta)) {
    let ll = 0;
    let brier = 0;
    for (const x of scores) {
      let p = 0.5;
      if (x.ab + x.ba > 0) {
        const logit = Math.log((x.ab + cfg.smooth) / (x.ba + cfg.smooth)) * cfg.shrink;
        p = 1 / (1 + Math.exp(-logit));
      }
      p = Math.min(1 - 1e-6, Math.max(1e-6, p));
      ll -= x.won1 ? Math.log(p) : Math.log(1 - p);
      brier += (p - (x.won1 ? 1 : 0)) ** 2;
    }
    rows.push([String(cfg.beta), String(cfg.smooth), String(cfg.shrink), (ll / scores.length).toFixed(4), (brier / scores.length).toFixed(4)]);
  }
}
rows.sort((a, b) => Number(a[3]) - Number(b[3]));
console.log(`Гинжийн тохируулга — sample ${sample.length} (${SPLIT}-ээс хойш), санамсаргүй log-loss 0.693`);
console.log(table(['β', 'smooth', 'shrink', 'log-loss', 'Brier'], rows));
