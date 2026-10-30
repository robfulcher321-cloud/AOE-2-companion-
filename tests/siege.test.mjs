// Run: node tests/siege.test.mjs [path/to/aoe2techtree/data]
// Plays computer-vs-computer AOSiege games and checks they run sensibly.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildKit } from '../js/siege/kit.js';
import { World, Computer, DT, PLOTS } from '../js/siege/world.js';
import { snapshot, applySnapshot, COMMANDS } from '../js/siege/sync.js';

const dir = process.argv[2];
const get = async (p) => (dir
  ? JSON.parse(await readFile(`${dir}/${p}`, 'utf8'))
  : (await fetch(`https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/${p}`)).json());
const data = await get('data.json');
const strings = await get('locales/en/strings.json');
const kitFor = async (civ) => buildKit({ data, strings, tree: await get(`trees/${civ.toUpperCase()}.json`), civ });

// Every civ gets the lines from its tech tree, each with working fighters at every step.
const noUnique = [];
for (const civ of Object.keys(data.civs)) {
  const kit = await kitFor(civ);
  assert.ok(kit.lines.length >= 5, `${civ}: has unit lines (${kit.lines.map((l) => l.label)})`);
  if (!kit.lines.some((l) => l.unique)) noUnique.push(civ);
  const names = kit.lines.map((l) => l.label);
  assert.equal(new Set(names).size, names.length, `${civ}: no line twice`);
  const all = new Set(kit.techs.map((t) => t.id));
  for (const l of kit.lines) {
    for (let t = 0; t < l.tiers.length; t++) {
      const f = kit.fighter(l.key, t, all);
      assert.ok(f.hp > 0 && f.speed > 0, `${civ} ${l.tiers[t].name}: a working fighter`);
      if (t) assert.ok(l.tiers[t].upgrade > 0, `${civ} ${l.tiers[t].name}: upgrade priced`);
    }
  }
  assert.ok(kit.techs.length >= 10, `${civ}: Armory techs`);
}
console.log(`No lane unique unit (siege or ships only): ${noUnique.join(', ')}`);
assert.ok(noUnique.length <= 5);
const per = await kitFor('Persians');
assert.ok(per.lines.some((l) => l.tiers.some((t) => t.unitId === 239)), 'Persians train War Elephants');
assert.ok(!per.lines.some((l) => l.tiers.some((t) => t.unitId === 567)), 'Persians have no Champions');
const arm = await kitFor('Armenians');
assert.ok(arm.techs.some((t) => t.name === 'Fereters'), 'Armenians can research Fereters');
const lsw = arm.lines.find((l) => l.tiers[0].unitId === 74);
const before = arm.fighter(lsw.key, 2, new Set());
const after = arm.fighter(lsw.key, 2, new Set(arm.techs.filter((t) => t.name === 'Fereters').map((t) => t.id)));
assert.equal(after.hp - before.hp, 30, 'Fereters: +30 HP for Long Swordsmen');

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
  // Buying, upgrading one building, holding and GO, selling, research
  const v = new World([k, k], data, { seed: 3 });
  v.sides[0].gold = 5000;
  const knights = k.lines.find((l) => l.tiers[0].unitId === 38).key;
  assert.ok(v.buy(0, 'build', knights, 4));
  assert.ok(v.buy(0, 'build', knights, 5));
  const [b1, b2] = v.buildings(0);
  assert.equal(b1.plot, 4);
  assert.ok(v.buy(0, 'upgrade', b1.id));
  assert.equal(b1.tier, 1);
  assert.equal(b2.tier, 0, 'upgrades are per building');
  assert.ok(!v.canBuy(0, 'build', knights, 4), 'a used plot can\'t be built on');
  assert.ok(v.toggleHold(0, b1.id) && v.toggleHold(0, b2.id));
  for (let i = 0; i < 40 * 30; i++) v.step();
  assert.equal(v.units.filter((u) => u.side === 0).length, 0, 'held buildings wait');
  assert.ok(b1.waiting && b2.waiting);
  assert.equal(v.go(0), 2);
  assert.deepEqual(v.units.filter((u) => u.side === 0).map((u) => u.f.name).sort(), ['Cavalier', 'Knight'], 'GO lets them out together');
  assert.ok(v.buy(0, 'market'));
  assert.equal(v.income(0), 15);
  const gold = v.sides[0].gold;
  const back = v.sellValue(b1.id);
  assert.ok(v.sell(0, b1.id));
  assert.equal(v.sides[0].gold, gold + back);
  assert.equal(back, Math.round((k.lines.find((l) => l.key === knights).cost + k.lines.find((l) => l.key === knights).tiers[1].upgrade) / 2), 'selling gives half of what went in');
  const forging = k.techs.find((t) => t.name === 'Forging');
  const hp0 = v.units.find((u) => u.side === 0).f;
  assert.ok(v.buy(0, 'research', forging.id));
  assert.ok(!v.canBuy(0, 'research', k.techs.find((t) => t.name === 'Iron Casting').id), 'Iron Casting waits for Forging');
  for (let i = 0; i < (forging.time + 1) * 30; i++) v.step();
  assert.ok(v.sides[0].researched.has(forging.id));
  const knight = v.units.find((u) => u.side === 0 && u.hp > 0);
  if (knight) assert.notEqual(knight.f, hp0, 'research reaches units on the field');
}
// 2v2: each player has their own base half, gold and buildings; the game still ends.
{
  const kits = [await kitFor('Franks'), await kitFor('Britons'), await kitFor('Goths'), await kitFor('Mongols')];
  const w = new World(kits, data, { seed: 5, teams: [0, 0, 1, 1] });
  assert.equal(w.plotCount(0), 12);
  assert.equal(w.income(0), 5, 'teammates split the base income');
  assert.ok(kits[0].lines.find((l) => l.band === 'spear').cost < kits[0].lines.find((l) => l.label === 'Militia').cost, 'spears cheaper than militia');
  assert.ok(kits[0].lines.find((l) => l.label === 'Knight').cost < (await kitFor('Khmer')).lines.find((l) => l.band === 'elephant').cost, 'elephants dearest');
  assert.ok(w.plotPos(0, 0)[1] < 0 && w.plotPos(1, 0)[1] > 0, 'top player above the castle, bottom player below');
  assert.ok(w.plotPos(2, 0)[0] > 43, 'red team builds on the right');
  const ais = kits.map((_, i) => new Computer(w, i, { level: 'normal' }));
  let territorySeen = false;
  while (w.winner === null && w.t < 3600) {
    for (const a of ais) a.think();
    w.step();
    if (w.territory[0] || w.territory[1]) territorySeen = true;
  }
  assert.notEqual(w.winner, null, '2v2 game ends');
  assert.ok(w.sides.every((s) => s.stats.trained > 20), 'every player trained an army');
  assert.ok(territorySeen, 'someone held the enemy third at some point');
  console.log(`2v2 Franks+Britons v Goths+Mongols: team ${w.winner} won after ${(w.t / 60).toFixed(1)} game min; trained ${w.sides.map((s) => s.stats.trained)}`);
}
// Wi-Fi sync: a joined phone's copy matches the host after snapshots (through JSON, like the network).
{
  const kits = [await kitFor('Franks'), await kitFor('Persians'), await kitFor('Goths'), await kitFor('Saracens')];
  const host = new World(kits, data, { seed: 8, teams: [0, 1, 0, 1] });
  const copy = new World(kits, data, { seed: 8, teams: [0, 1, 0, 1] });
  const ais = [1, 2, 3].map((i) => new Computer(host, i, { level: 'normal' }));
  host.sides[0].gold = 500;
  assert.ok(COMMANDS.build(host, 0, { key: kits[0].lines[0].key, plot: 0 }), 'command from a joined player builds');
  let sent = 0;
  for (let i = 0; i < 30 * 200; i++) {
    for (const a of ais) a.think();
    host.step();
    if (i % 3 === 0) { applySnapshot(copy, JSON.parse(JSON.stringify(snapshot(host, sent)))); sent = host.t; }
  }
  applySnapshot(copy, JSON.parse(JSON.stringify(snapshot(host, sent))));
  assert.equal(copy.units.length, host.units.length);
  assert.deepEqual(copy.alive, host.alive);
  assert.deepEqual(copy.sides.map((s) => Math.floor(s.gold)), host.sides.map((s) => Math.floor(s.gold)));
  assert.deepEqual(copy.structures.map((b) => `${b.id}:${b.owner}:${b.tier}:${b.hp}`), host.structures.map((b) => `${b.id}:${b.owner}:${b.tier ?? 0}:${Math.max(0, Math.round(b.hp))}`));
  const u = host.units.find((x) => x.hp > 0);
  assert.equal(copy.units.find((x) => x.id === u.id).f.unitId, u.f.unitId, 'same unit type on the copy');
  const bytes = JSON.stringify(snapshot(host, host.t - 0.1)).length;
  console.log(`Wi-Fi snapshot with ${host.units.length} soldiers: ${(bytes / 1024).toFixed(1)} KB`);
}
// Territory: soldiers in the enemy's third add 5 gold a tick.
{
  const k = await kitFor('Franks');
  const w = new World([k, k], data, { seed: 2 });
  const base = w.income(0);
  w.sides[0].gold = 1000;
  w.buy(0, 'build', k.lines[0].key, 0);
  for (let i = 0; i < 30 * 30; i++) w.step();
  const u = w.units.find((x) => x.side === 0 && x.hp > 0);
  u.x = 80; u.y = 0;   // walk it into red's third
  for (let i = 0; i < 30 * 5; i++) w.step();
  if (w.units.includes(u) && u.hp > 0) assert.equal(w.income(0), base + 5, 'territory bonus');
}
console.log('AOSiege checks passed.');
