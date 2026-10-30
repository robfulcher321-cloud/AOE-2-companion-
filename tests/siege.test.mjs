// Run: node tests/siege.test.mjs [path/to/aoe2techtree/data]
// Plays computer-vs-computer AOSiege games and checks they run sensibly.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildKit } from '../js/siege/kit.js';
import { World, Computer, DT, GAME_SPEED } from '../js/siege/world.js';
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
  const built = w.sides.map((s, i) => w.buildings(i).length);
  // Placed buildings never overlap and stay in their owner's area
  for (const [i, b] of w.structures.filter((x) => x.kind === 'building' && x.hp > 0).entries()) {
    assert.ok(w.inZone(b.owner, b.x, b.y), 'built inside its area');
    for (const c of w.structures.filter((x) => x.kind === 'building' && x.hp > 0).slice(i + 1)) assert.ok(Math.hypot(b.x - c.x, b.y - c.y) >= b.r + c.r + 0.49, 'a gap between buildings');
  }
  console.log(`${keyA} v ${keyB}: ${w.winner === null ? 'no winner' : `${w.winner ? keyB : keyA} won`} after ${(w.t / 60).toFixed(1)} game min; trained ${w.sides.map((s) => s.stats.trained)}, most units on field ${maxUnits}, buildings standing ${built}; ${Math.round(ms)} ms (${(ms / (w.t / DT) * 1000).toFixed(0)} µs per step)`);
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
  const A = [20, -5], B = [20, 5];
  assert.ok(!v.buy(0, 'build', knights, A), 'knights need the Castle Age');
  // Ages: pay, wait, and the next age's units open up
  assert.ok(v.buy(0, 'age'));
  assert.equal(v.price(0, 'age'), null, 'one age at a time');
  while (v.sides[0].aging) v.step();
  assert.equal(v.sides[0].age, 2);
  assert.ok(v.events.some((e) => e.type === 'aged' && e.owner === 0 && e.age === 2), 'everyone hears about it');
  v.sides[0].age = 4;
  assert.ok(!v.canBuy(0, 'build', knights, [60, 0]), 'not in the enemy\'s base');
  assert.ok(!v.canBuy(0, 'build', knights, [13.5, 0]), 'not on the Wonder');
  assert.ok(v.buy(0, 'build', knights, A));
  assert.ok(!v.canBuy(0, 'build', knights, [21, -4]), 'not on top of another building');
  assert.ok(v.buy(0, 'build', knights, B));
  const [b1, b2] = v.buildings(0);
  assert.deepEqual([b1.x, b1.y], A);
  // Under construction: weak, no units, can't upgrade; then it finishes
  assert.ok(!b1.done && b1.hp < b1.maxHp * 0.2);
  assert.equal(v.price(0, 'upgrade', b1.id), null, 'no upgrades while it goes up');
  while (!b1.done) v.step();
  assert.ok(Math.abs(v.t - b1.buildStart - 10 * GAME_SPEED) < 0.1, 'about 10 seconds to build');
  assert.ok(b1.hp >= b1.maxHp * 0.98);
  assert.ok(v.buy(0, 'upgrade', b1.id));
  assert.equal(b1.tier, 1);
  assert.equal(b2.tier, 0, 'upgrades are per building');
  assert.ok(v.toggleHold(0, b1.id));
  assert.ok(v.stop(0), 'the red hand holds everything');
  for (let i = 0; i < 40 * 30; i++) v.step();
  assert.equal(v.units.filter((u) => u.side === 0).length, 0, 'held buildings wait');
  assert.ok(b1.waiting && b2.waiting);
  assert.equal(v.go(0), 2);
  assert.deepEqual(v.units.filter((u) => u.side === 0).map((u) => u.f.name).sort(), ['Cavalier', 'Knight'], 'GO lets them out together');
  assert.ok(!v.sides[0].stopAll, 'GO lifts the red hand');
  assert.ok(v.buy(0, 'market'));
  assert.equal(v.income(0), 10, 'a Market pays once it\'s built');
  for (let i = 0; i < 9 * GAME_SPEED * 30; i++) v.step();
  assert.equal(v.income(0), 15);
  // Defences: a Watch Tower shoots, and goes up to a Guard Tower in place
  const tower = k.defences.find((d) => d.key === 'def:tower');
  assert.ok(v.buy(0, 'build', tower.key, [24, 8]));
  const tw = v.buildings(0).find((b) => b.def);
  while (!tw.done) v.step();
  assert.ok(v.buy(0, 'upgrade', tw.id));
  assert.equal(tw.building, 234);
  assert.ok(!k.lines.some((l) => l.building === 82), 'nothing trains at the Castle');
  assert.ok(k.lines.find((l) => l.tiers[0].unitId === 42 || l.tiers[0].unitId === 331).building === 49, 'Trebuchets at the Siege Workshop');
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
// Gold mines: the first soldier past one builds a camp there; enemies past it pull it down.
{
  const k = await kitFor('Franks');
  const w = new World([k, k], data, { seed: 2 });
  const m = w.mines[0];   // top lane, nearer blue
  const knights = k.lines.find((l) => l.tiers[0].unitId === 38).key;
  w.sides.forEach((s) => { s.age = 4; s.gold = 9999; });
  const put = (side, x) => { w.buy(side, 'build', knights, side === 0 ? [20, -6] : [66, -6]); const b = w.buildings(side).at(-1); w.spawn(side, b); const u = w.units.at(-1); u.x = x; u.y = m.y + 0.5 * Math.sign(m.y); u.f = { ...u.f, speed: 0 }; return u; };
  const blue = put(0, m.x + 2);
  for (let i = 0; i < 30 * 12; i++) { w.updateMines(w.t); w.t += 1 / 30; }
  assert.ok(m.camp?.done && m.camp.owner === 0, 'blue got past: a blue camp');
  const base = w.income(0);
  assert.equal(base, 15, '+5 a tick for a mine in a 1v1');
  blue.hp = 0;
  const red = put(1, m.x - 2);
  for (let i = 0; i < 30 * 4; i++) { w.updateMines(w.t); w.t += 1 / 30; }
  assert.ok(m.camp?.owner === 0, 'still standing while it comes down');
  for (let i = 0; i < 30 * 16; i++) { w.updateMines(w.t); w.t += 1 / 30; }
  assert.ok(m.camp?.done && m.camp.owner === 1, 'then red builds theirs');
  red.hp = 0;
}
// 3v3: three a team; the game still ends.
{
  const civs = ['Franks', 'Britons', 'Goths', 'Mongols', 'Aztecs', 'Japanese'];
  const kits = await Promise.all(civs.map((c) => kitFor(c)));
  const w = new World(kits, data, { seed: 11, teams: [0, 0, 0, 1, 1, 1] });
  assert.equal(w.income(0), 6.5);
  const ais = kits.map((_, i) => new Computer(w, i, { level: 'normal' }));
  while (w.winner === null && w.t < 3600) { for (const a of ais) a.think(); w.step(); }
  assert.notEqual(w.winner, null, '3v3 game ends');
  assert.ok(w.sides.every((s) => s.stats.trained > 10), 'every player trained an army');
  console.log(`3v3: team ${w.winner} won after ${(w.t / 60).toFixed(1)} game min; trained ${w.sides.map((s) => s.stats.trained)}`);
}
// 2v2: each player has their own base half, gold and buildings; the game still ends.
{
  const kits = [await kitFor('Franks'), await kitFor('Britons'), await kitFor('Goths'), await kitFor('Mongols')];
  const w = new World(kits, data, { seed: 5, teams: [0, 0, 1, 1] });
  assert.equal(w.income(0), 6.5, 'two thirds of the base income each in a team game');
  assert.ok(kits[0].lines.find((l) => l.band === 'spear').cost < kits[0].lines.find((l) => l.label === 'Militia').cost, 'spears cheaper than militia');
  assert.ok(kits[0].lines.find((l) => l.label === 'Knight').cost < (await kitFor('Khmer')).lines.find((l) => l.band === 'elephant').cost, 'elephants dearest');
  assert.deepEqual(w.zone(0), w.zone(1), 'teammates share their base');
  assert.ok(w.zone(2).x0 > 43, 'red team builds on the right');
  const ais = kits.map((_, i) => new Computer(w, i, { level: 'normal' }));
  let minesWon = 0;
  while (w.winner === null && w.t < 3600) {
    for (const a of ais) a.think();
    w.step();
    minesWon = Math.max(minesWon, w.mines.filter((m) => m.camp?.done).length);
  }
  assert.notEqual(w.winner, null, '2v2 game ends');
  assert.ok(w.sides.every((s) => s.stats.trained > 20), 'every player trained an army');
  assert.ok(minesWon > 0, 'someone took a gold mine');
  console.log(`2v2 Franks+Britons v Goths+Mongols: team ${w.winner} won after ${(w.t / 60).toFixed(1)} game min; trained ${w.sides.map((s) => s.stats.trained)}`);
}
// Wi-Fi sync: a joined phone's copy matches the host after snapshots (through JSON, like the network).
{
  const kits = [await kitFor('Franks'), await kitFor('Persians'), await kitFor('Goths'), await kitFor('Saracens')];
  const host = new World(kits, data, { seed: 8, teams: [0, 1, 0, 1] });
  const copy = new World(kits, data, { seed: 8, teams: [0, 1, 0, 1] });
  const ais = [1, 2, 3].map((i) => new Computer(host, i, { level: 'normal' }));
  host.sides[0].gold = 500;
  assert.ok(COMMANDS.build(host, 0, { key: kits[0].lines[0].key, at: [20, -6] }), 'command from a joined player builds');
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
// The explosion only lands on your own third; stronger units take longer to come out.
{
  const k = await kitFor('Khmer');
  const w = new World([k, k], data, { seed: 4 });
  assert.equal(w.blast(0, 60, 0), 0, 'blue can\'t drop it on the middle or red\'s side');
  assert.equal(w.sides[0].blasts, 1, 'a refused drop isn\'t used up');
  assert.ok(w.canBlastAt(0, 20) && !w.canBlastAt(0, 40) && w.canBlastAt(1, 70) && !w.canBlastAt(1, 50));
  const line = (band) => k.lines.find((l) => l.band === band);
  assert.equal(line('standard').tiers[0].every, 21, 'Militia every 21 game seconds, its real training time');
  assert.ok(line('spear').cost < line('standard').cost && line('cavalry').cost > line('standard').cost, 'prices follow real costs');
  // Trebuchets: half range, and they pack/unpack
  const treb = k.lines.find((l) => l.tiers[0].unitId === 42);
  const tf = k.fighter(treb.key, 0);
  assert.equal(tf.range, 8, 'trebuchet range halved');
  assert.ok(tf.packs > 0 && tf.walkAs === 331);
}
// Chat: everyone gets it, even when sent while paused (same game time as the last snapshot).
{
  const kits = [await kitFor('Britons'), await kitFor('Goths')];
  const host = new World(kits, data, { seed: 2 });
  const copy = new World(kits, data, { seed: 2 });
  applySnapshot(copy, JSON.parse(JSON.stringify(snapshot(host, -1))));
  const sent = host.t;
  assert.ok(COMMANDS.chat(host, 1, { text: '  GG  ' }));
  assert.ok(!host.chat(1, 'spam'), 'too soon after the last line');
  assert.ok(!host.chat(0, '   '), 'nothing to say');
  applySnapshot(copy, JSON.parse(JSON.stringify(snapshot(host, sent))));
  const got = copy.events.filter((e) => e.type === 'chat');
  assert.deepEqual(got.map((e) => [e.owner, e.text]), [[1, 'GG']]);
  applySnapshot(copy, JSON.parse(JSON.stringify(snapshot(host, sent))));
  assert.equal(copy.events.filter((e) => e.type === 'chat').length, 1, 'sent once');
  assert.equal(host.chat(0, 'x'.repeat(200)), true);
  assert.equal(host.events.at(-1).text.length, 80);
  // Civ summary for the flag panel
  const sum = kits[0].summary();
  assert.ok(sum.strengths.some((x) => /Longbowman/.test(x)) && sum.weaknesses.some((x) => /Hand Cannoneers/.test(x)), 'Britons: Longbows, no Hand Cannons');
  assert.ok(kits[0].help.includes('Foot Archer') && kits[0].techs.some((t) => /\+1 attack/.test(t.help)), 'game help text');
}
console.log('AOSiege checks passed.');
