// Run: node tests/combat.test.mjs [path/to/aoe2techtree/data/data.json]
// Without a path it downloads the live data file.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildFighter, damagePerHit, hitsToKill, isDuelEligible, trackFor, otherTechsFor } from '../js/duel/combat.js';
import { simulate, simulateMany } from '../js/duel/sim.js';

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

// Eligibility: melee and ranged land units in; siege, rams and ships out
assert.ok(isDuelEligible(U[554]) && isDuelEligible(U[569]) && isDuelEligible(U[359]));
assert.ok(isDuelEligible(U[4]) && isDuelEligible(U[5]) && isDuelEligible(U[39]) && isDuelEligible(U[879]));
assert.ok(!isDuelEligible(U[1258]) && !isDuelEligible(U[539]) && !isDuelEligible(U[279]) && !isDuelEligible(U[36]));

// Simulation: winner, hit counts consistent with the formula
for (const [x, y] of [[etk, pal], [champ, halb], [halb, pal]]) {
  const r = simulate(x, y);
  const kills = [hitsToKill(x, y), hitsToKill(y, x)];
  assert.notEqual(r.winner, null, `${x.name} vs ${y.name} should have a winner`);
  assert.equal(r.sides[r.winner].hits, kills[r.winner], 'winner lands exactly hits-to-kill');
  assert.ok(r.sides[1 - r.winner].hits < kills[1 - r.winner]);
  console.log(`${x.name} vs ${y.name}: ${[x, y][r.winner].name} wins in ${r.duration.toFixed(1)}s,`,
    `dmg/hit ${damagePerHit(x, y)} / ${damagePerHit(y, x)}, HP left ${r.sides.map((s) => Math.ceil(s.hpLeft)).join(' / ')}`);
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

// Ranged units: the right Blacksmith lines, range and accuracy upgrades
assert.equal(trackFor(U[492], 'attack').key, 'archer');
assert.equal(trackFor(U[492], 'armour').key, 'archer');
assert.equal(trackFor(U[474], 'armour').key, 'archer', 'cavalry archers use archer armour');
assert.equal(trackFor(U[281], 'attack').key, 'melee', 'throwing axemen use Forging');
assert.equal(trackFor(U[569], 'armour').key, 'cavalry');
assert.ok(otherTechsFor(U[492]).some((t) => t.name === 'Thumb Ring'));
assert.ok(!otherTechsFor(U[569]).some((t) => t.name === 'Thumb Ring'));
const allTechs = { attackLevel: 3, armourLevel: 3, techs: [435, 437, 436, 47, 215, 39] };
const arb = buildFighter(U[492], 'Arbalester', allTechs);
assert.equal(arb.attacks.get(3), U[492].Attack + 3 + 1, 'Fletching line +3 pierce, Chemistry +1');
assert.equal(arb.range, U[492].Range + 3, 'Fletching line +3 range');
assert.equal(arb.projectile.accuracy, 100, 'Thumb Ring: 100% accuracy');
assert.equal(arb.armours.get(3), U[492].PierceArmor + 4);
const arbNoUps = buildFighter(U[492], 'Arbalester');
assert.equal(arbNoUps.projectile.accuracy, U[492].AccuracyPercent);
const eckn = buildFighter(U[559], 'Elite Chu Ko Nu', allTechs);
assert.equal(eckn.projectile.count, 5);
assert.equal(eckn.projectile.secondary.attacks.get(3), 3, 'extra arrows keep their own 3 pierce');
const kama = buildFighter(U[879], 'Kamayuk', allTechs);
assert.equal(kama.projectile, null, 'Kamayuk has reach, not projectiles');
// Without Thumb Ring the arbalester misses sometimes, so win rates are sampled
const palF = buildFighter(U[569], 'Paladin', full);
const many = simulateMany(buildFighter(U[492], 'Arbalester', { attackLevel: 3, armourLevel: 3 }), palF, { runs: 100 });
assert.equal(many.runs, 100);
assert.ok(many.rates[1] > 0.9, 'a fully upgraded Paladin beats an Arbalester');
console.log(`Arbalester vs Paladin: Paladin wins ${Math.round(many.rates[1] * 100)}%`);
// Arbalester vs Champion: shots land at range before the champion arrives
const arbVsChamp = simulate(arb, champ);
assert.ok(arbVsChamp.shots.length > 0 && arbVsChamp.shots[0].t0 < arbVsChamp.hits.find((h) => h.by === 1)?.t);
// Archer mirror with perfect accuracy: both die together
const pair = simulate(arb, buildFighter(U[492], 'B', allTechs));
assert.equal(pair.winner, null);
const ecknVsArb = simulateMany(eckn, arb, { runs: 50 });
console.log(`Elite Chu Ko Nu vs Arbalester: ${ecknVsArb.rates.map((r) => Math.round(r * 100) + '%').join(' / ')}`);
const hcVsChamp = simulateMany(buildFighter(U[5], 'Hand Cannoneer', allTechs), champ, { runs: 100 });
console.log(`Hand Cannoneer vs Champion: ${hcVsChamp.rates.map((r) => Math.round(r * 100) + '%').join(' / ')}`);
console.log('Ranged checks passed.');

// Several units a side
const five = simulate(champ, palF, { counts: [5, 1] });
assert.equal(five.winner, 0, 'five Champions beat one Paladin');
assert.equal(five.sides[0].count, 5);
assert.equal(five.sides[0].survivors, 5);
const units = five.frames[0].u;
assert.equal(units.length, 6);
// no two living units overlap by more than a sliver at the end
const last = five.frames[five.frames.length - 1].u;
for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
  assert.ok(Math.hypot(last[i][0] - last[j][0], last[i][1] - last[j][1]) >= 2 * champ.radius - 0.05, 'units keep apart');
}
const arbs = simulateMany(buildFighter(U[492], 'Arbalester', { ...allTechs, techs: [...allTechs.techs, 93] }), palF, { counts: [5, 1], runs: 100 });
assert.ok(arbs.rates[0] > 0.9, 'five Arbalesters beat one Paladin');
const t0 = performance.now();
const big = simulateMany(eckn, buildFighter(U[1233], 'Elite Kipchak', allTechs), { counts: [5, 5], runs: 200 });
const ms = performance.now() - t0;
console.log(`5 Elite Chu Ko Nu vs 5 Elite Kipchak: ${big.rates.map((r) => Math.round(r * 100) + '%').join(' / ')} (${Math.round(ms)} ms for 200 runs)`);
assert.ok(ms < 8000, 'sampling stays fast enough for a phone');
console.log('Multi-unit checks passed.');

// Special abilities, read from the game data
const opt = (extra = {}) => ({ ...full, units: U, ...extra });
const fl = buildFighter(U[1903], 'Elite Fire Lancer', opt());
const flFight = simulate(fl, palF);
const firstMelee = flFight.hits.find((h) => h.side === 0 && !flFight.shots.some((s) => s.kind === 'charge' && Math.abs(s.landed - h.t) < 1e-9));
const chargeShots = flFight.shots.filter((s) => s.kind === 'charge');
assert.equal(chargeShots.length >= 3, true, 'Fire Lancer fires its 3 charge shots');
assert.ok(chargeShots[0].t0 < firstMelee.t, 'charge shots come before the first melee blow');
const shotHits = flFight.hits.filter((h) => h.side === 0 && h.t <= Math.max(...chargeShots.slice(0, 3).map((x) => x.landed)) + 1e-9);
assert.equal(fl.special.charge.projectile.attacks.get(3), 4, 'Elite Fire Lancer upgrade gives its shot +1 pierce (3 -> 4)');
assert.ok(shotHits.length > 0 && shotHits.every((h) => h.dmg === 4), 'Fire Lancer shots ignore armour: 4 each, even against a Paladin');
assert.ok(Math.hypot(chargeShots[0].x1 - chargeShots[0].x0, chargeShots[0].y1 - chargeShots[0].y0) <= 5 + fl.radius + palF.radius + 0.5, 'fired from charge range');
const cous = buildFighter(U[1657], 'Elite Coustillier', opt());
const cousFight = simulate(cous, champ);
const cHits = cousFight.hits.filter((h) => h.side === 0);
assert.equal(cHits[0].note, 'charge');
assert.equal(cHits[0].dmg, damagePerHit(cous, champ, cous.attacks, { extraMelee: 25 }), 'first blow carries the 25 charge');
assert.equal(cHits[1].dmg, damagePerHit(cous, champ), 'then normal blows until it recharges');
const pag = buildFighter(U[1910], 'Elite Iron Pagoda', opt());
const pagFight = simulate(champ, pag);
assert.equal(pagFight.hits.find((h) => h.side === 0).note, 'blocked', 'Iron Pagoda blocks the first melee blow');
const shri = buildFighter(U[1753], 'Elite Shrivamsha', opt());
const shriFight = simulate(arb, shri);
const dodged = shriFight.hits.filter((h) => h.note === 'dodged').length;
assert.ok(dodged >= 7, `Shrivamsha dodges its 7 charges worth of arrows (${dodged})`);
const leitis = buildFighter(U[1236], 'Elite Leitis', opt());
assert.equal(damagePerHit(leitis, teutonEtk), leitis.attacks.get(4), 'Leitis ignores armour');
const urumi = buildFighter(U[1737], 'Elite Urumi', opt());
const uFight = simulate(urumi, buildFighter(U[74], 'Militia'), { counts: [1, 3] });
assert.ok(uFight.hits.some((h) => h.note === 'splash'), 'charged Urumi blow hits nearby enemies');
const konnik = buildFighter(U[1227], 'Elite Konnik', opt());
assert.ok(konnik.dismount, 'Konnik has a dismounted form');
const kFight = simulate(konnik, buildFighter(U[359], 'Halberdier', full), { counts: [1, 2] });
assert.ok(kFight.units.some((u) => u.unitId === 1253), 'Konnik fights on foot after its horse falls');
const obuch = buildFighter(U[1703], 'Elite Obuch', opt());
const oFight = simulate(obuch, teutonEtk);
const oh = oFight.hits.filter((h) => h.side === 0);
assert.ok(oh[3].dmg > oh[0].dmg, 'Obuch tears armour, so later blows hit harder');
const hearth = buildFighter(U[2706], 'Elite Hearth Troop', opt({ attackLevel: 3 }));
assert.equal(hearth.special.charge.event, 6 + 3, 'Fletching line adds javelin range');
const hFight = simulate(hearth, champ);
assert.ok(hFight.shots.some((s) => s.kind === 'charge'), 'Hearth Troop throws its javelin');
const sam = buildFighter(U[560], 'Elite Samurai', opt());
const samFight = simulate(sam, champ, { startGap: 6 });
const noRush = simulate({ ...sam, special: { ...sam.special, rush: null } }, champ, { startGap: 6 });
assert.ok(samFight.hits[0].t < noRush.hits[0].t, 'Samurai charges in faster');
console.log('Special ability checks passed.');

// Mirror match is symmetric: equal units die together
const r = simulate(buildFighter(U[567], 'A', full), buildFighter(U[567], 'B', full));
assert.equal(r.winner, null);
assert.equal(r.timedOut, false);
console.log('All combat tests passed.');
