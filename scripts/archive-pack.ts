/**
 * devjee архивыг (data/devjee/*) gzip-лэж `archive/` хавтаст хийнэ — git/Docker image-д орно,
 * production сервер эхлэхдээ задална (Dockerfile). Дахин ажиллуулбал дарж бичнэ.
 *   node scripts/archive-pack.ts        → archive/{bouts.jsonl,tournaments.json,wrestlers.json}.gz + summary.json
 *   node scripts/archive-pack.ts --unpack [dir]  → gz-үүдийг data/devjee (эсвэл dir) руу задална
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const SRC = path.join('data', 'devjee');
const OUT = 'archive';
const FILES = ['bouts.jsonl', 'tournaments.json', 'wrestlers.json'];

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function pack(): Promise<void> {
  if (!existsSync(path.join(SRC, 'bouts.jsonl'))) throw new Error(`${SRC}/bouts.jsonl алга — эхлээд npm run archive`);
  mkdirSync(OUT, { recursive: true });
  for (const f of FILES) {
    const src = path.join(SRC, f);
    const dst = path.join(OUT, `${f}.gz`);
    await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst));
    console.log(`${f}: ${mb(statSync(src).size)} → ${mb(statSync(dst).size)}`);
  }
  copyFileSync(path.join(SRC, 'summary.json'), path.join(OUT, 'summary.json'));
  console.log(`→ ${OUT}/ бэлэн`);
}

async function unpack(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const src = path.join(OUT, `${f}.gz`);
    if (!existsSync(src)) throw new Error(`${src} алга`);
    await pipeline(createReadStream(src), createGunzip(), createWriteStream(path.join(dir, f)));
  }
  if (existsSync(path.join(OUT, 'summary.json'))) copyFileSync(path.join(OUT, 'summary.json'), path.join(dir, 'summary.json'));
  console.log(`→ ${dir}/ задарлаа`);
}

const args = process.argv.slice(2);
if (args[0] === '--unpack') await unpack(args[1] ?? SRC);
else await pack();
