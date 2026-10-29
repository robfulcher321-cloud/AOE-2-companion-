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

// The app's starter builds: an early-game build and a boom for every civ.
const starter = JSON.parse(await readFile(new URL('../assets/builds/starter.json', import.meta.url), 'utf8'));
let worst = { lag: 0 };
for (const civ of Object.keys(data.civs)) {
  for (const role of ['early', 'boom']) {
    const id = `app-${civ.toLowerCase()}-${role}`;
    const bo = starter.builds[id];
    assert.ok(bo, `${id} exists`);
    assert.ok(starter.list.some((e) => e.id === id && e.faction === civ && e.role === role), `${id} listed`);
    const tl = timeline(bo, data);
    assert.equal(tl.estimated, false, `${id}: has its own times`);
    assert.deepEqual(tl.ages.map((a) => a.age), [2, 3], `${id}: Feudal then Castle`);
    for (let i = 1; i < tl.steps.length; i++) assert.ok(tl.steps[i].t >= tl.steps[i - 1].t, `${id}: step times increase`);
    const last = tl.steps.at(-1);
    assert.equal(tl.villagersAt(last.t + 1), last.vills, `${id}: villager count adds up`);
    for (const st of tl.steps) {
      const sum = ['food', 'wood', 'gold', 'stone', 'builder'].reduce((n, k) => n + (st.res[k] || 0), 0);
      assert.equal(sum, st.vills, `${id}: villagers on resources add up at ${fmtTime(st.t)}`);
    }
    for (let t = 0; t < tl.end; t += 5) {
      const b = tl.bankAt(t);
      for (const k of ['food', 'wood', 'gold', 'stone']) assert.ok(b[k] > -1e-6, `${id}: bank never negative`);
    }
    for (const e of tl.events) if (e.paidAt !== undefined && e.paidAt - e.t > worst.lag) worst = { lag: e.paidAt - e.t, id, what: e.what, t: e.t };
    const ov = overview(bo, data);
    assert.ok(ov.buildings.length >= 4, `${id}: buildings listed`);
  }
}
const chi = timeline(starter.builds['app-chinese-boom'], data);
assert.equal(chi.villagersAt(0), 6, 'Chinese start with 6 villagers');
const ben = timeline(starter.builds['app-bengalis-early'], data);
assert.equal(ben.villagers.filter((v) => v.free).length, 4, 'Bengalis: 2 free villagers per age');
const mal = timeline(starter.builds['app-malay-boom'], data);
assert.equal(mal.ages[0].reach - mal.ages[0].click, 78, 'Malay Feudal research is faster');
assert.ok(!JSON.stringify(starter.builds['app-huns-early']).includes('House_aoe2DE'), 'Huns build no houses');
assert.ok(!JSON.stringify(starter.builds['app-incas-boom']).includes('Mill_aoe2de'), 'Incas use Settlements');
console.log(`All ${Object.keys(data.civs).length * 2} starter builds checked. Longest wait for resources: ${Math.round(worst.lag)}s (${worst.id}, ${worst.what} at ${fmtTime(worst.t || 0)}).`);
