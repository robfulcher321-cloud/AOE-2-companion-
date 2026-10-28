// Run: node tests/combat.test.mjs [path/to/aoe2techtree/data/data.json]
// Without a path it downloads the live data file.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFighter, damagePerHit, hitsToKill, isDuelEligible } from '../js/duel/combat.js';
import { simulate } from '../js/duel/sim.js';

const src = process.argv[2];
const data = src
  ? JSON.parse(await readFile(src, 'utf8'))
  : await (await fetch('https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/data.json')).json();
const U = data.data.Unit;
const full = { attackLevel: 3, armourLevel: 3, bloodlines: true };

const etk = buildFighter(U[554], 'Elite Teutonic Knight', full);
const pal = buildFighter(U[569], 'Paladin', full);
const halb = buildFighter(U[359], 'Halberdier', full);
const champ = buildFighter(U[567], 'Champion', full);

// Hand-checked against the data file values:
// ETK attack 17+4=21 vs Paladin melee armour 2+3=5 -> 16
assert.equal(damagePerHit(etk, pal), U[554].Attack + 4 - (U[569].MeleeArmor + 3));
// Paladin 14+4 vs ETK 8+3
assert.equal(damagePerHit(pal, etk), U[569].Attack + 4 - (U[554].MeleeArmor + 3));
// Bloodlines adds 20 HP to cavalry only
assert.equal(pal.hp, U[569].HP + 20);
assert.equal(etk.hp, U[554].HP);
// Halberdier bonus vs cavalry is applied
const halbVsCav = U[359].Attacks.find((a) => a.Class === 8).Amount;
assert.equal(damagePerHit(halb, pal), (U[359].Attack + 4 - (U[569].MeleeArmor + 3)) + halbVsCav);
// Minimum damage is 1
const militia = buildFighter(U[74], 'Militia');
const tank = buildFighter(U[554], 'ETK', { armourLevel: 3, extra: { meleeArmour: 50 } });
assert.equal(damagePerHit(militia, tank), 1);

// Eligibility: melee land units in, archers/siege/ships out
assert.ok(isDuelEligible(U[554]) && isDuelEligible(U[569]) && isDuelEligible(U[359]));
assert.ok(!isDuelEligible(U[4]) && !isDuelEligible(U[1258]) && !isDuelEligible(U[539]));

// Simulation: winner, hit counts consistent with the formula
for (const [x, y] of [[etk, pal], [champ, halb], [halb, pal]]) {
  const r = simulate(x, y);
  const kills = [hitsToKill(x, y), hitsToKill(y, x)];
  assert.notEqual(r.winner, null, `${x.name} vs ${y.name} should have a winner`);
  assert.equal(r.sides[r.winner].hits, kills[r.winner], 'winner lands exactly hits-to-kill');
  assert.ok(r.sides[1 - r.winner].hits < kills[1 - r.winner]);
  console.log(`${x.name} vs ${y.name}: ${[x, y][r.winner].name} wins in ${r.duration.toFixed(1)}s,`,
    `dmg/hit ${r.damage.join(' / ')}, HP left ${r.sides.map((s) => Math.ceil(s.hpLeft)).join(' / ')}`);
}

// Civ bonuses and unique techs come from the game data, applied in game order
const teutonEtk = buildFighter(U[554], 'ETK', { ...full, civ: 'Teutons' });
assert.equal(teutonEtk.armours.get(4), U[554].MeleeArmor + 3 + 2, 'Teutons: +1 melee armour in Castle and Imperial');
const frankPal = buildFighter(U[569], 'Paladin', { ...full, bloodlines: false, civ: 'Franks' });
assert.equal(frankPal.hp, U[569].HP * 1.2, 'Franks: cavalry +20% HP');
const mongolHussar = buildFighter(U[441], 'Hussar', { ...full, civ: 'Mongols' });
assert.ok(Math.abs(mongolHussar.hp - (U[441].HP * 1.3 + 20)) < 0.1, 'Mongols: +30% on base HP, Bloodlines on top');
const vikingChamp = buildFighter(U[567], 'Champion', { ...full, civ: 'Vikings' });
assert.equal(vikingChamp.hp, U[567].HP * 1.2, 'Vikings: infantry +20% HP');
const celtChamp = buildFighter(U[567], 'Champion', { ...full, civ: 'Celts' });
assert.ok(Math.abs(celtChamp.speed - U[567].Speed * 1.2) < 0.01, 'Celts: infantry +20% speed by Imperial');
console.log('Civ bonus checks passed.');

// Mirror match is symmetric: equal units die together
const r = simulate(buildFighter(U[567], 'A', full), buildFighter(U[567], 'B', full));
assert.equal(r.winner, null);
assert.equal(r.timedOut, false);
console.log('All combat tests passed.');
