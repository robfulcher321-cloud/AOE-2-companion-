// What each civ can build in AOSiege: the unit lines, their three tiers, and
// what everything costs. Pure (no DOM), so it runs in Node tests too.
//
// Costs are in gold only. They're scaled from the units' real costs, so a
// Paladin building costs more than a Spearman one, and a Castle (unique unit)
// most of all.

import { buildFighter, otherTechsFor, isDuelEligible } from '../duel/combat.js';
import { CIV_EFFECTS } from '../duel/effects.js';

// Unit lines. Each tier lists unit IDs to try in order; the first the civ has wins.
export const LINES = [
  { key: 'swords', label: 'Swordsmen', building: 12, tiers: [[75], [77], [567, 473, 77]] },
  { key: 'champi', label: 'Champi', building: 12, tiers: [[2550], [2552], [2554]] },
  { key: 'eagles', label: 'Eagles', building: 12, tiers: [[751], [753], [752]] },
  { key: 'spears', label: 'Spearmen', building: 12, tiers: [[93], [358], [359, 358]] },
  { key: 'archers', label: 'Archers', building: 87, tiers: [[4], [24], [492, 24]] },
  { key: 'skirms', label: 'Skirmishers', building: 87, tiers: [[7], [6], [6]] },
  { key: 'cavarchers', label: 'Cavalry archers', building: 87, tiers: [[39], [474], [474]] },
  { key: 'scouts', label: 'Light cavalry', building: 101, tiers: [[448], [546], [441, 546]] },
  { key: 'knights', label: 'Knights', building: 101, tiers: [[38], [283], [569, 283]] },
];
export const UNIQUE_KEY = 'unique';
export const TIER_NAMES = ['Feudal', 'Castle', 'Imperial'];
export const MARKET = { key: 'market', label: 'Market', building: 84, cost: 175, income: 5, max: 3 };
export const SMITH_COSTS = [125, 225, 325];   // Blacksmith attack / armour, levels 1-3
export const NOT_UNITS = new Set([440, 331]);  // Petard, Trebuchet: not lane fighters
export const BUILD_COST = 150;
export const UNIQUE_COST = 225;
const OUTPUT = 4.5;   // resources' worth of units a building trains per game second

const total = (cost) => Object.values(cost || {}).reduce((a, b) => a + b, 0);

/**
 * data: aoe2techtree data.json; strings: names; tree: the civ's tech tree; civ: civ key.
 * Returns { civ, lines: [...], buildingIcon(id), fighter(lineKey, tier, smith) }.
 */
export function buildKit({ data, strings = {}, tree, civ }) {
  const nodes = tree.units_techs;
  const ok = (n) => n && n.node_status !== 'NotAvailable';
  const unitNode = new Map();
  for (const n of nodes) if (n.use_type === 'Unit' && ok(n) && !unitNode.has(n.node_id)) unitNode.set(n.node_id, n);
  const techOk = new Set(nodes.filter((n) => n.use_type === 'Tech' && ok(n)).map((n) => n.node_id));
  const nameOf = (id) => {
    const n = unitNode.get(id);
    const s = n ? strings[n.name_string_id] : null;
    return (s || n?.name || `Unit ${id}`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const has = (id) => unitNode.has(id) && Boolean(data.data.Unit[id]);
  const pictureOf = (id) => unitNode.get(id)?.picture_index;

  const lines = [];
  for (const def of LINES) {
    const tiers = [];
    for (const ids of def.tiers) {
      const id = ids.find(has) ?? tiers.at(-1)?.unitId;
      if (id === undefined) break;
      tiers.push({ unitId: id, name: nameOf(id), picture: pictureOf(id) });
    }
    if (tiers.length === 3) lines.push({ ...def, tiers });
  }
  // The unique unit, trained at the Castle: the first two fighters listed there.
  const uu = nodes.filter((n) => n.use_type === 'Unit' && n.building_id === 82 && ok(n) && !NOT_UNITS.has(n.node_id)
    && isDuelEligible(data.data.Unit[n.node_id]) && !/hero/i.test(n.name || '')).map((n) => n.node_id);
  const uuIds = [...new Set(uu)].slice(0, 2);
  if (uuIds.length) {
    const tiers = [uuIds[0], uuIds[1] ?? uuIds[0], uuIds[1] ?? uuIds[0]].map((id) => ({ unitId: id, name: nameOf(id), picture: pictureOf(id) }));
    lines.push({ key: UNIQUE_KEY, label: tiers[0].name, building: 82, tiers, unique: true });
  }

  // Every building costs the same and turns out the same value of army over
  // time: a cheap Spearman every 13 s, a costly Knight every 30 s. So cheap
  // units come in numbers and expensive ones in quality, as in the game.
  for (const line of lines) {
    const units = line.tiers.map((t) => data.data.Unit[t.unitId]);
    line.cost = line.unique ? UNIQUE_COST : BUILD_COST;
    line.upgrade = line.unique ? [325, 300] : [175, 300];
    line.every = units.map((u) => Math.max(10, Math.min(45, Math.round((total(u.Cost) / OUTPUT) * 10) / 10)));
  }

  const buildingPicture = new Map((tree.buildings || []).map((b) => [b.node_id ?? b.id, b.picture_index]));
  // Upgrades a unit gets in the Imperial tier: its own switches (Bloodlines, Thumb Ring...) and the civ's unique techs.
  const imperialTechs = (unit) => otherTechsFor(unit).map((t) => t.id).filter((id) => techOk.has(id));
  const uts = (CIV_EFFECTS[civ]?.uts || []).map((u) => u.id).filter((id) => techOk.has(id));
  const cache = new Map();

  return {
    civ,
    lines,
    buildingPicture: (id) => buildingPicture.get(id),
    /** Fighter stats for a line at a tier (0-2) with Blacksmith levels { attack, armour }. */
    fighter(lineKey, tier, smith = { attack: 0, armour: 0 }) {
      const key = `${lineKey}|${tier}|${smith.attack}|${smith.armour}`;
      if (!cache.has(key)) {
        const line = lines.find((l) => l.key === lineKey);
        const t = line.tiers[tier];
        const unit = data.data.Unit[t.unitId];
        const top = tier === 2;
        cache.set(key, buildFighter(unit, t.name, {
          civ,
          attackLevel: smith.attack,
          armourLevel: smith.armour,
          techs: top ? imperialTechs(unit) : [],
          uts: top ? uts : [],
          units: data.data.Unit,
        }));
      }
      return cache.get(key);
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
