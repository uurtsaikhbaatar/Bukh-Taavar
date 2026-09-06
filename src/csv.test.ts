import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvToObjects, importBoutsCsv, importWrestlersCsv, parseCsv } from './csv.ts';
import { Engine } from './engine.ts';
import { fmtDateTime, fmtPct, fmtTokens, table } from './format.ts';
import { MemoryLog } from './store.ts';

test('parseCsv: хашилт, CRLF, BOM, хоосон мөр', () => {
  const text = '\uFEFFid,name,note\r\nw1,"Б.Орхонбаяр","Даян аварга, ""Таван хан"""\r\n\r\nw2,Э.Батмагнай,\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    ['id', 'name', 'note'],
    ['w1', 'Б.Орхонбаяр', 'Даян аварга, "Таван хан"'],
    ['w2', 'Э.Батмагнай', ''],
  ]);
  const objs = csvToObjects(text);
  assert.equal(objs.length, 2);
  assert.equal(objs[0]!.name, 'Б.Орхонбаяр');
  assert.deepEqual(csvToObjects(''), []);
});

test('importWrestlersCsv + importBoutsCsv: бөх, рейтинг, барилдааны түүх → Elo халаагдана', () => {
  const engine = new Engine(new MemoryLog(), { idGen: (() => { let n = 0; return () => `i${++n}`; })() });
  engine.createTournament({ id: 't1', name: 'Түүх', date: '2025-07-11', rounds: 9 });
  const wr = importWrestlersCsv(
    engine,
    [
      'id,name,title,aimag,rating,devjeeId',
      'w1,Б.Орхонбаяр,даян_аварга,Сэлэнгэ,2354,-KiY',
      'w2,Э.Батмагнай,17,Баянхонгор,,',
      'w3,Ц.Тест,4,,,',
      'w4,,4,,,',
      'w5,Х.Буруу,хаан,,,',
      'w1,Давхар,4,,,',
    ].join('\n'),
  );
  assert.equal(wr.added, 3);
  assert.equal(wr.skipped, 1);
  assert.equal(wr.errors.length, 2);
  assert.equal(engine.wrestler('w2').title, 'улсын_арслан');
  assert.equal(engine.rating('w1').rating, 2354);
  assert.equal(engine.rating('w1').source, 'devjee');
  assert.equal(engine.rating('w2').source, 'seed');

  const before = engine.rating('w3').rating;
  const br = importBoutsCsv(
    engine,
    ['tournament,round,a,b,winner', 't1,1,w1,w3,a', 't1,2,w2,w3,w3', 't1,3,w2,w9,a', 't1,,w1,w2,'].join('\n'),
  );
  assert.equal(br.added, 2);
  assert.equal(br.errors.length, 2);
  assert.equal(engine.bouts('t1').length, 2);
  assert.equal(engine.markets().length, 0, 'түүхэн барилдаанд зах зээл нээхгүй');
  assert.ok(engine.rating('w3').rating > before, 'w3 арсланг давсан тул рейтинг өссөн');
  assert.equal(engine.rating('w3').source, 'local');
});

test('format: токен, хувь, огноо, хүснэгт', () => {
  assert.equal(fmtTokens(1234567), '1 234 567');
  assert.equal(fmtTokens(-950), '−950');
  assert.equal(fmtTokens(12.6), '13');
  assert.equal(fmtPct(0.6234), '62%');
  assert.equal(fmtPct(0.6234, 1), '62.3%');
  assert.equal(fmtDateTime('2026-07-11T02:30:00.000Z'), '2026-07-11 10:30');
  assert.equal(fmtDateTime('буруу'), 'буруу');
  const t = table(['Нэр', 'Токен'], [['Бат', 10_000], ['Болд', 950]]);
  const lines = t.split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[2]!.startsWith('Бат '));
  assert.ok(lines[3]!.endsWith('950'));
});
