/**
 * Санах ойн хэмжилт: архив (Analytics) + Engine-ийг локал логоос ачаалахад хэр их RAM хэрэгтэй вэ
 * (Render free = 512 MB). `node scripts/mem-check.ts`
 */
import { Engine } from '../src/engine.ts';
import { JsonlLog } from '../src/store.ts';
import { Analytics } from '../server/analytics.ts';

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const show = (label: string) => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const m = process.memoryUsage();
  console.log(`${label.padEnd(28)} rss ${mb(m.rss)} · heap ${mb(m.heapUsed)} / ${mb(m.heapTotal)}`);
};

show('эхлэл');
const analytics = Analytics.tryLoad('data/devjee', () => undefined);
show(`архив (${analytics ? analytics.archive.bouts.length : 0} барилдаан)`);
const log = new JsonlLog('data/web-events.jsonl');
const engine = new Engine(log);
show(`engine (${engine.wrestlers().length} бөх, ${engine.markets().length} зах зээл)`);
