// What each civ can build in AOSiege, read from its tech tree: every unit line
// its Barracks, Archery Range, Stable and Castle can train, each with its real
// upgrade steps (Militia → Man-at-Arms → … → Champion), and the techs the
// Armory offers (Blacksmith, unit upgrades like Bloodlines and Ballistics, and
// the civ's unique techs). Pure (no DOM), so it runs in Node tests too.
//
// Everything is paid in gold. Prices come from the game's own costs, scaled
// down: a building trains about the same value of army per second whatever it
// makes, so cheap units come in numbers and expensive ones in quality.

import { buildFighter, otherTechsFor, isDuelEligible, trackFor, affectsUnit, TRACKS, OTHER_TECHS } from '../duel/combat.js';
import { CIV_EFFECTS, UNIT_CLASS } from '../duel/effects.js';

export const TRAIN_AT = [12, 87, 101, 82];        // Barracks, Archery Range, Stable, Castle
export const BUILDING_NAMES = { 12: 'Barracks', 87: 'Archery Range', 101: 'Stable', 82: 'Castle', 84: 'Market' };
export const MARKET = { key: 'market', label: 'Market', building: 84, cost: 175, income: 5, max: 3 };
export const NOT_UNITS = new Set([440, 331]);    // Petard, Trebuchet: not lane fighters
export const NEEDS = { 5: 47 };                // unit -> tech it needs (Hand Cannoneer: Chemistry)
export const BUILD_COST = 150;
export const UNIQUE_COST = 225;
const OUTPUT = 4.5;          // resources' worth of units a building trains per game second
const UPGRADE_SHARE = 0.3;   // building upgrades cost this share of the real upgrade's resources (+30)
const TECH_SHARE = 0.3;      // Armory techs: same idea (+25)
const TECH_TIME = 0.3;       // and this share of the real research time

const total = (cost) => Object.values(cost || {}).reduce((a, b) => a + b, 0);
const round5 = (n) => Math.round(n / 5) * 5;
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * data: aoe2techtree data.json; strings: names; tree: the civ's tech tree; civ: civ key.
 * Returns { civ, lines, techs, buildingPicture(id), fighter(lineKey, tier, researched) }.
 */
export function buildKit({ data, strings = {}, tree, civ }) {
  const nodes = tree.units_techs;
  const ok = (n) => n && n.node_status !== 'NotAvailable';
  const U = data.data.Unit;
  const name = (n) => clean(strings[n.name_string_id] || n.name);
  const techOk = new Set(nodes.filter((n) => n.use_type === 'Tech' && ok(n)).map((n) => n.node_id));
  const techNode = new Map(nodes.filter((n) => n.use_type === 'Tech').map((n) => [n.node_id, n]));
  // Units that need a tech first: Hand Cannoneers need Chemistry (from the Armory).
  // Copies of unique units unlocked by a tech elsewhere (Huskarls at the
  // Barracks, Tarkans at the Stable) are left out; the Castle trains them.
  const fights = (n) => n.use_type === 'Unit' && ok(n) && (n.node_status !== 'ResearchRequired' || NEEDS[n.node_id])
    && !NOT_UNITS.has(n.node_id) && U[n.node_id] && isDuelEligible(U[n.node_id]);

  // Unit lines: each unit with nothing before it starts a line; follow the
  // units that upgrade from it, one step at a time.
  const lines = [];
  const seen = new Set();
  for (const building of TRAIN_AT) {
    const here = nodes.filter((n) => n.building_id === building && fights(n));
    const ids = new Set(here.map((n) => n.node_id));
    const roots = here.filter((n) => n.link_node_type === 'BuildingTech' || n.link_id === null || !ids.has(n.link_id));
    let castleLines = 0;
    for (const root of roots) {
      if (seen.has(root.node_id)) continue;
      const chain = [root];
      for (;;) {
        const next = here.find((n) => n.link_id === chain.at(-1).node_id && !chain.includes(n));
        if (!next) break;
        chain.push(next);
      }
      // At the Castle: unique units have an Elite version; heroes don't.
      if (building === 82 && castleLines > 0 && chain.length < 2) continue;
      if (building === 82) castleLines += 1;
      chain.forEach((n) => seen.add(n.node_id));
      const tiers = chain.map((n, i) => {
        const up = i ? data.data.unit_upgrades?.[n.node_id] : null;
        return {
          unitId: n.node_id,
          name: name(n),
          picture: n.picture_index,
          upgrade: i ? round5(30 + UPGRADE_SHARE * total(up?.Cost || { Gold: 500 })) : 0,
          every: Math.max(8, Math.min(45, Math.round((total(U[n.node_id].Cost) / OUTPUT) * 10) / 10)),
        };
      });
      lines.push({
        key: `${building}-${root.node_id}`,
        building,
        unique: building === 82,
        label: tiers[0].name,
        cost: building === 82 ? UNIQUE_COST : BUILD_COST,
        needs: NEEDS[root.node_id] ?? null,
        tiers,
      });
    }
  }

  // Every unit any line can make, for deciding which techs matter.
  const allUnits = lines.flatMap((l) => l.tiers.map((t) => U[t.unitId]));
  const meOf = (u) => ({ id: u.ID, cls: UNIT_CLASS[u.ID] });
  const techCost = (id) => {
    const t = data.data.Tech[id];
    return { cost: round5(25 + TECH_SHARE * total(t?.Cost)), time: Math.max(6, Math.round((t?.ResearchTime || 40) * TECH_TIME)) };
  };
  const techRec = (id, group, label, extra = {}) => {
    const n = techNode.get(id);
    return { id, group, name: n ? clean(strings[n.name_string_id] || n.name) : label, picture: n?.picture_index, ...techCost(id), ...extra };
  };
  const techs = [];
  // Blacksmith: each line in order (Forging before Iron Casting)
  for (const kind of ['attack', 'armour']) {
    for (const track of TRACKS[kind]) {
      if (!allUnits.some((u) => trackFor(u, kind)?.key === track.key)) continue;
      track.techs.forEach((id, i) => {
        if (!techOk.has(id)) return;
        techs.push(techRec(id, 'Blacksmith', track.names[i], { after: i ? track.techs[i - 1] : null, track: `${kind}:${track.key}` }));
      });
    }
  }
  // Single upgrades: Bloodlines, Thumb Ring, Parthian Tactics, Chemistry, Squires, Husbandry, Ballistics
  for (const t of OTHER_TECHS) {
    if (!techOk.has(t.id)) continue;
    if (!allUnits.some((u) => otherTechsFor(u).some((o) => o.id === t.id))) continue;
    techs.push(techRec(t.id, 'Unit upgrades', t.name));
  }
  // The civ's unique techs that change its units
  const uts = (CIV_EFFECTS[civ]?.uts || []).filter((u) => techOk.has(u.id) && allUnits.some((x) => affectsUnit(u, meOf(x))));
  for (const u of uts) techs.push(techRec(u.id, 'Unique techs', u.name || `Tech ${u.id}`));
  const utIds = new Set(uts.map((u) => u.id));

  const buildingPicture = new Map((tree.buildings || []).map((b) => [b.node_id ?? b.building_id, b.picture_index]));
  const cache = new Map();

  return {
    civ,
    lines,
    techs,
    buildingPicture: (id) => buildingPicture.get(id),
    line: (key) => lines.find((l) => l.key === key),
    /** Fighter stats for a line at a tier with the researched techs (a Set of tech ids). */
    fighter(lineKey, tier, researched = new Set(), key = [...researched].sort().join(',')) {
      const ck = `${lineKey}|${tier}|${key}`;
      if (!cache.has(ck)) {
        const line = lines.find((l) => l.key === lineKey);
        const t = line.tiers[Math.min(tier, line.tiers.length - 1)];
        const unit = U[t.unitId];
        const level = (kind) => {
          const track = trackFor(unit, kind);
          if (!track) return 0;
          let n = 0;
          while (n < 3 && researched.has(track.techs[n])) n++;
          return n;
        };
        cache.set(ck, buildFighter(unit, t.name, {
          civ,
          attackLevel: level('attack'),
          armourLevel: level('armour'),
          techs: otherTechsFor(unit).map((o) => o.id).filter((id) => researched.has(id)),
          uts: [...researched].filter((id) => utIds.has(id)),
          units: U,
        }));
      }
      return cache.get(ck);
    },
  };
}

/** A structure's defensive stats in the shape damagePerHit expects. */
export function structureStats(data, buildingId) {
  const b = data.data.Building[buildingId] || {};
  return {
    name: 'Building',
    hp: b.HP || 2000,
    armours: new Map((b.Armours || [{ Class: 4, Amount: 2 }, { Class: 3, Amount: 7 }]).map((a) => [a.Class, a.Amount])),
    attacks: new Map((b.Attacks || []).map((a) => [a.Class, a.Amount])),
    range: b.Range || 0,
    reload: b.ReloadTime || 2,
    special: {},
  };
}
