// Checks every unique tech does something, in the duel and in Wonder Wars.
// Run: node tests/uts.audit.mjs [data dir]   (prints one line per tech; exits 1 if any does nothing)
import { readFile } from 'node:fs/promises';
import { buildKit, WW_UTS, DEFENCES } from '../js/siege/kit.js';
import { World } from '../js/siege/world.js';
import { simulate } from '../js/duel/sim.js';
import { buildFighter } from '../js/duel/combat.js';
import { CIV_EFFECTS } from '../js/duel/effects.js';

const dir = process.argv[2];
const get = async (p) => (dir ? JSON.parse(await readFile(`${dir}/${p}`, 'utf8')) : (await fetch(`https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/${p}`)).json());
const data = await get('data.json');
const strings = await get('locales/en/strings.json');
const U = data.data.Unit;
const clean = (x) => String(x || '').replace(/<[^>]+>/g, '').replace(/‹[^›]*›/g, '').replace(/\s+/g, ' ').trim();
const rep = (k, v) => (v instanceof Map ? [...v] : v);
const ser = (f) => JSON.stringify(f, rep);
// Generic Castle techs every civ has, and ones with nothing to act on in either mode
const GENERIC = new Set([379, 315, 321, 408]);
const NOTHING_HERE = {
  16: 'Huskarls at the Barracks: in Wonder Wars they already train there', 483: 'Tarkans at the Stable: in Wonder Wars they already train there',
  28: 'Monks', 487: 'houses', 492: 'Monks', 440: 'Villagers', 21: 'Relics and Wonder victory', 499: 'trade', 1404: 'map and ships',
  576: 'Town Centers', 624: 'Docks', 690: 'free units at Castles', 691: 'Town Centers', 755: 'Villagers', 756: 'Town Centers',
  785: 'Monks', 834: 'population', 922: 'ships', 924: 'population', 1491: 'Monks', 464: 'ships and Bombard Tower blast (no blast here)',
  455: 'stone costs (no stone here)',
};
const foesOf = async () => {
  const fr = await buildKit({ data, strings, tree: await get('trees/FRANKS.json'), civ: 'Franks' });
  return { kit: fr, lines: ['12-74', '101-38', '87-4'].map((k) => fr.lines.find((l) => l.key === k)) };
};
const foes = await foesOf();
const top = (line) => line.tiers.length - 1;

/** Duel: n of A against n of B; how much damage A deals and keeps. */
const duelScore = (a, b) => {
  const r = simulate(a, b, { counts: [16, 16], seed: 7, record: false, startGap: 10 });
  return Math.round((r.sides[0].dealt - r.sides[1].dealt + r.sides[0].hpLeft + r.duration) * 100) / 100;
};

/** Wonder Wars: 6 of A meet 6 of B in blue's end of the field; damage dealt minus taken after 25 s. */
const wwScore = (kitA, line, tier, researched, foeLine) => {
  const w = new World([kitA, foes.kit], data, { seed: 5 });
  const sA = w.sides[0];
  sA.age = 4;
  for (const id of researched) sA.researched.add(id);
  w.refit(0);
  w.sides[1].age = 4; w.refit(1);
  const fA = kitA.fighter(line.key, tier, sA.researched, sA.researchKey, 4);
  const fB = foes.kit.fighter(foeLine.key, top(foeLine), w.sides[1].researched, w.sides[1].researchKey, 4);
  const mine = [], theirs = [];
  // near red's Wonder, so siege has a building to hit
  for (let i = 0; i < 16; i++) {
    mine.push(w.addUnit(0, line.key, tier, fA, 52 - Math.floor(i / 4) * 0.8, 2 + (i % 4) * 0.8, 1));
    theirs.push(w.addUnit(1, foeLine.key, top(foeLine), fB, 64 + Math.floor(i / 4) * 0.8, 2 + (i % 4) * 0.8, 1));
  }
  w.alive = [16, 16];
  w.sides[0].out = 16; w.sides[1].out = 16;
  // a building for rams and trebuchets to hit (the foes stand in front of it)
  const hp0 = (us) => us.reduce((s, u) => s + Math.max(0, u.hp), 0);
  const a0 = hp0(mine), b0 = hp0(theirs), c0 = w.teams[1].castle.hp;
  for (let k = 0; k < 40 * 60; k++) w.step();
  const castle = c0 - w.teams[1].castle.hp;
  return Math.round(((b0 - hp0(theirs)) + hp0(mine) + castle) * 100) / 100;
};

let bad = 0;
const rows = [];
for (const civ of Object.keys(CIV_EFFECTS)) {
  let tree;
  try { tree = await get(`trees/${civ.toUpperCase()}.json`); } catch { continue; }
  const kit = await buildKit({ data, strings, tree, civ });
  const treeUts = (JSON.stringify(tree).match(/\{[^{}]*"building_id":82[^{}]*"use_type":"Tech"[^{}]*\}/g) || []).map((m) => JSON.parse(m)).filter((n) => !GENERIC.has(n.node_id));
  for (const node of treeUts) {
    const id = node.node_id;
    const name = clean(strings[node.name_string_id] || node.name);
    const inArmory = kit.techs.some((t) => t.id === id);
    const res = new Set([id]);
    const notes = [];
    let duelOk = null, wwOk = null;
    // Units it changes
    const lines = [];
    for (const line of kit.lines) {
      const t = top(line);
      const a = kit.fighter(line.key, t, new Set(), '', 4), b = kit.fighter(line.key, t, res, String(id), 4);
      const cost = kit.linePrice(line, 4, new Set()) !== kit.linePrice(line, 4, res);
      const train = kit.every(line, t, new Set()) !== kit.every(line, t, res);
      if (ser(a) !== ser(b) || cost || train) lines.push({ line, t, a, b, cost, train, stats: ser({ ...a, cost: 0, trainTime: 0, name: 0 }) !== ser({ ...b, cost: 0, trainTime: 0, name: 0 }) });
    }
    for (const L of lines.slice(0, 3)) {
      if (L.cost) notes.push(`${L.line.tiers[L.t].name} cheaper`);
      if (L.train) notes.push(`${L.line.tiers[L.t].name} trains faster`);
      if (!L.stats) continue;
      // Duel: the duel's own fighters (straight from buildFighter, as the Duel screen makes them)
      const unit = U[L.a.unitId];
      const fa = buildFighter(unit, 'A', { civ, age: 4, units: U, uts: [] });
      const fb = buildFighter(unit, 'B', { civ, age: 4, units: U, uts: [id] });
      const dScores = foes.lines.map((fl) => { const foe = buildFighter(U[fl.tiers[top(fl)].unitId], 'F', { civ: 'Franks', age: 4, units: U }); return [duelScore(fa, foe), duelScore(fb, foe)]; });
      const wScores = foes.lines.map((fl) => [wwScore(kit, L.line, L.t, [], fl), wwScore(kit, L.line, L.t, [id], fl)]);
      // Trebuchets don't fight soldiers, and fire only burns buildings: nothing for the duel to show.
      // (A wider trebuchet blast, Warwolf, only catches soldiers standing by the building it hits.)
      const duelNa = L.b.buildingsOnly || (L.b.special?.burn && !L.a.special?.burn);
      const blastUp = L.b.buildingsOnly && (L.b.projectile?.blast || 0) > (L.a.projectile?.blast || 0);
      const d = duelNa ? null : dScores.some(([x, y]) => x !== y), ww = wScores.some(([x, y]) => x !== y) || blastUp;
      if (duelNa) notes.push('(duel: nothing to show)');
      if (d !== null) duelOk = duelOk || d; wwOk = wwOk || ww;
      notes.push(`${L.line.tiers[L.t].name}: duel ${dScores.map(([x, y]) => `${Math.round(x)}→${Math.round(y)}`).join(' ')}; WW ${wScores.map(([x, y]) => `${Math.round(x)}→${Math.round(y)}`).join(' ')}`);
    }
    const ww = WW_UTS[id];
    if (ww?.income) { const a = kit.incomeBonus(new Set()), b = kit.incomeBonus(res); wwOk = wwOk || ser(a) !== ser(b); notes.push(`income x${b.mult} +${b.flat}`); }
    if (ww?.def) { const b = kit.defenceBonus(ww.def.keys[0], res); wwOk = wwOk || ser(b) !== ser(kit.defenceBonus(ww.def.keys[0], new Set())); notes.push(`defences: ${ww.note}`); }
    if (ww?.train) wwOk = wwOk || lines.some((L) => L.train);
    const costOnly = lines.length && lines.every((L) => !L.stats);
    if (costOnly) wwOk = true;
    let verdict;
    if (NOTHING_HERE[id]) verdict = `n/a (${NOTHING_HERE[id]})`;
    else if (!inArmory) verdict = 'MISSING from the Wonder Wars Armory';
    else if (costOnly) verdict = 'ok (cost/training only)';
    else if (wwOk && (duelOk || duelOk === null)) verdict = duelOk === null ? 'ok (Wonder Wars only)' : 'ok';
    else verdict = `NO EFFECT in ${[duelOk === false ? 'duel' : '', wwOk ? '' : 'Wonder Wars'].filter(Boolean).join(' and ')}`;
    if (/NO EFFECT|MISSING/.test(verdict)) bad++;
    rows.push(`${verdict.padEnd(40)} ${civ} | ${name} (${id}) | ${notes.join(' / ')}`);
  }
}
console.log(rows.join('\n'));
console.log(bad ? `${bad} unique techs need work.` : 'Every unique tech does something.');
process.exitCode = bad ? 1 : 0;
