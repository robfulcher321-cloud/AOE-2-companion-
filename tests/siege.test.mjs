// Run: node tests/siege.test.mjs [path/to/aoe2techtree/data]
// Plays computer-vs-computer AOSiege games and checks they run sensibly.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildKit } from '../js/siege/kit.js';
import { World, Computer, DT, PLOTS } from '../js/siege/world.js';

const dir = process.argv[2];
const get = async (p) => (dir
  ? JSON.parse(await readFile(`${dir}/${p}`, 'utf8'))
  : (await fetch(`https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/${p}`)).json());
const data = await get('data.json');
const strings = await get('locales/en/strings.json');
const kitFor = async (civ) => buildKit({ data, strings, tree: await get(`trees/${civ.toUpperCase()}.json`), civ });

// Every civ gets lines it can actually build, each with three tiers.
for (const civ of Object.keys(data.civs)) {
  const kit = await kitFor(civ);
  assert.ok(kit.lines.length >= 5, `${civ}: has unit lines (${kit.lines.map((l) => l.key)})`);
  for (const l of kit.lines) {
    assert.equal(l.tiers.length, 3, `${civ} ${l.key}: three tiers`);
    for (let t = 0; t < 3; t++) {
      const f = kit.fighter(l.key, t, { attack: t, armour: t });
      assert.ok(f.hp > 0 && f.speed > 0, `${civ} ${l.key} tier ${t}: a working fighter`);
    }
    assert.ok(l.cost > 0 && l.upgrade.every((c) => c > 0), `${civ} ${l.key}: priced`);
  }
}

// Computer-vs-computer games end with a castle down, at a reasonable pace.
const games = [['Franks', 'Britons'], ['Goths', 'Mongols'], ['Aztecs', 'Teutons'], ['Inca', 'Chinese']];
for (const [i, [a, b]] of games.entries()) {
  const keyA = Object.keys(data.civs).find((k) => k.toLowerCase().startsWith(a.toLowerCase().slice(0, 4)));
  const keyB = Object.keys(data.civs).find((k) => k.toLowerCase().startsWith(b.toLowerCase().slice(0, 4)));
  const w = new World([await kitFor(keyA), await kitFor(keyB)], data, { seed: i + 1 });
  const ais = [new Computer(w, 0, { level: 'normal' }), new Computer(w, 1, { level: 'normal' })];
  const t0 = performance.now();
  let maxUnits = 0;
  while (w.winner === null && w.t < 3600) {
    for (const ai of ais) ai.think();
    w.step();
    maxUnits = Math.max(maxUnits, w.units.filter((u) => u.hp > 0).length);
    for (const s of w.sides) assert.ok(s.gold >= 0, 'gold never negative');
  }
  const ms = performance.now() - t0;
  for (const u of w.units) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), 'positions are numbers');
  const built = w.sides.map((s) => s.plots.filter(Boolean).length);
  console.log(`${keyA} v ${keyB}: ${w.winner === null ? 'no winner' : `${w.winner ? keyB : keyA} won`} after ${(w.t / 60).toFixed(1)} game min; trained ${w.sides.map((s) => s.stats.trained)}, most units on field ${maxUnits}, plots used ${built}/${PLOTS}; ${Math.round(ms)} ms (${(ms / (w.t / DT) * 1000).toFixed(0)} µs per step)`);
  assert.notEqual(w.winner, null, 'someone wins within an hour of game time');
  assert.ok(w.t > 180, 'a game lasts more than three minutes');
}
// Nobody builds anything: overtime still ends the game.
{
  const k = await kitFor('Franks');
  const w = new World([k, k], data, { seed: 9 });
  while (w.winner === null && w.t < 3600) w.step();
  assert.notEqual(w.winner, null, 'overtime ends an idle game');
  assert.ok(w.t > 25 * 60 && w.t < 40 * 60, `idle game ends in overtime (${(w.t / 60).toFixed(1)} min)`);
  // Buying, upgrading and selling
  const v = new World([k, k], data, { seed: 3 });
  v.sides[0].gold = 2000;
  assert.ok(v.buy(0, 'build', 'knights'));
  assert.ok(v.buy(0, 'upgrade', 'knights'));
  assert.equal(v.tier(0, 'knights'), 1);
  assert.ok(v.buy(0, 'market'));
  assert.equal(v.income(0), 15);
  const b = v.structures.find((x) => x.side === 0 && x.line === 'knights');
  const before = v.sides[0].gold;
  assert.ok(v.sell(0, b.id));
  assert.equal(v.sides[0].gold, before + 75, 'selling gives half back');
  assert.equal(v.freePlot(0), 0, 'the plot is free again');
}
console.log('AOSiege checks passed.');
