// Run: node tests/guides.test.mjs [path/to/aoe2techtree/data/data.json]
// Checks every bundled build order turns into a sensible practice timeline.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timeline, overview, fmtTime, parseTime } from '../js/guides/econ.js';

const src = process.argv[2];
const data = src
  ? JSON.parse(await readFile(src, 'utf8'))
  : await (await fetch('https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/data.json')).json();
const index = JSON.parse(await readFile(new URL('../assets/builds/index.json', import.meta.url), 'utf8'));
assert.ok(index.length >= 30, 'bundled build orders present');
assert.equal(parseTime('7:05'), 425);
assert.equal(fmtTime(425), '7:05');
for (const entry of index) {
  const bo = JSON.parse(await readFile(new URL(`../assets/builds/aoe2/${entry.id}.json`, import.meta.url), 'utf8'));
  const tl = timeline(bo, data);
  assert.ok(tl.steps.length > 0, entry.id);
  for (let i = 1; i < tl.steps.length; i++) assert.ok(tl.steps[i].t >= tl.steps[i - 1].t, `${entry.id}: step times increase`);
  for (let t = 0; t < tl.end; t += 5) {
    const b = tl.bankAt(t);
    for (const k of ['food', 'wood', 'gold', 'stone']) assert.ok(b[k] > -1e-6, `${entry.id}: bank never negative (${k} at ${t}s)`);
  }
  assert.equal(tl.stepAt(0), 0);
  assert.equal(tl.stepAt(tl.steps.at(-1).t + 1), tl.steps.length - 1);
  overview(bo, data);
}
const mon = timeline(JSON.parse(await readFile(new URL('../assets/builds/aoe2/mon15popscouts.json', import.meta.url), 'utf8')), data);
assert.equal(fmtTime(mon.ages[0].click), '5:00', '15 pop Feudal click at 5:00');
console.log(`All ${index.length} build orders checked.`);
