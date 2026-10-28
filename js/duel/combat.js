// Pure combat rules. No DOM, so it can be tested with Node.
//
// Damage per hit (melee, flat ground):
//   max(1, sum over attack classes of max(0, attack[c] - armour[c]))
// Only classes the defender has an armour entry for count. Melee is class 4,
// pierce is class 3; everything else is a bonus class (e.g. 27 Spearmen).

import { RADII } from './radii.js';
import { UNIT_CLASS, CIV_EFFECTS, PLAYER_TECHS } from './effects.js';

export const CLASS = { INFANTRY: 1, PIERCE: 3, MELEE: 4, ELEPHANT: 5, CAVALRY: 8, SHIP: 16, RAM: 17, SIEGE: 20 };

// Blacksmith steps: index = number of upgrades researched.
export const BLACKSMITH = {
  attack: { techs: [67, 68, 75], melee: [0, 1, 2, 4] },          // Forging, Iron Casting, Blast Furnace
  infantryArmour: { techs: [74, 76, 77], melee: [0, 1, 2, 3], pierce: [0, 1, 2, 4] }, // Scale/Chain/Plate Mail
  cavalryArmour: { techs: [81, 82, 80], melee: [0, 1, 2, 3], pierce: [0, 1, 2, 4] },  // Scale/Chain/Plate Barding
  bloodlines: { tech: 435, hp: 20 },
};

const armourClasses = (u) => new Set((u.Armours || []).map((a) => a.Class));
export const isInfantry = (u) => armourClasses(u).has(CLASS.INFANTRY);
export const isCavalry = (u) => armourClasses(u).has(CLASS.CAVALRY);

/** Units this first version can duel: melee land units. */
export function isDuelEligible(u) {
  if (!u || !(u.Attack > 0) || u.Range >= 1) return false;
  const c = armourClasses(u);
  if (c.has(CLASS.SHIP) || c.has(CLASS.SIEGE) || c.has(CLASS.RAM)) return false;
  return c.has(CLASS.INFANTRY) || c.has(CLASS.CAVALRY) || c.has(CLASS.ELEPHANT);
}

// Collision radius in tiles, from the game data file where known; otherwise
// a fallback by unit type. It only affects when the first blow lands.
export function radiusOf(u) {
  if (RADII[u.ID] !== undefined) return RADII[u.ID];
  const c = armourClasses(u);
  if (c.has(CLASS.ELEPHANT) || c.has(CLASS.CAVALRY)) return 0.25;
  return 0.2;
}

const ATTR = { HP: 0, SPEED: 5, ARMOUR: 8, ATTACK: 9, RELOAD: 10 };

/** Armour/attack effect values pack class * 256 + amount (amount may be negative). */
function unpack(value) {
  const v = Math.round(value);
  let cls = v >> 8;
  let amount = v & 0xff;
  if (amount >= 128) { amount -= 256; cls += 1; }
  return { cls, amount };
}

function applyCommand(stats, [type, unit, unitClass, attr, value], me) {
  const matches = unit === me.id || (unit === -1 && unitClass === me.cls);
  if (!matches) return false;
  const op = (current) => (type === 0 ? value : type === 4 ? current + value : current * value);
  switch (attr) {
    case ATTR.HP: stats.hp = op(stats.hp); break;
    case ATTR.SPEED: stats.speed = op(stats.speed); break;
    case ATTR.RELOAD: stats.reload = op(stats.reload); break;
    case ATTR.ARMOUR:
    case ATTR.ATTACK: {
      const map = attr === ATTR.ARMOUR ? stats.armours : stats.attacks;
      const { cls, amount } = unpack(value);
      if (!map.has(cls) && attr === ATTR.ARMOUR) return false; // unit isn't in that armour class
      const current = map.get(cls) ?? 0;
      map.set(cls, type === 0 ? amount : type === 4 ? current + amount : current * (amount / 100));
      break;
    }
    default: return false;
  }
  return true;
}

/** Tech IDs for the chosen Blacksmith levels and Bloodlines. */
export function playerTechIds(unit, { attackLevel = 0, armourLevel = 0, bloodlines = false } = {}) {
  const ids = [];
  const inf = isInfantry(unit);
  const cav = isCavalry(unit);
  if (inf || cav) ids.push(...BLACKSMITH.attack.techs.slice(0, attackLevel));
  const track = cav ? BLACKSMITH.cavalryArmour : inf ? BLACKSMITH.infantryArmour : null;
  if (track) ids.push(...track.techs.slice(0, armourLevel));
  if (cav && bloodlines) ids.push(BLACKSMITH.bloodlines.tech);
  return ids;
}

/**
 * Applies techs and civ bonuses in the order the game would by the Imperial Age:
 * age by age, the player's techs for that age first, then any civ bonuses whose
 * requirements are now met. Bonuses can switch each other off (e.g. a version
 * that accounts for Bloodlines replaces the one that doesn't).
 * Returns the names of civ bonuses that changed this unit.
 */
export function applyEffects(stats, me, { civEffects, playerTechs, chosen }) {
  const active = new Set();
  const disabled = new Set();
  const done = new Set();
  const applied = [];
  const runTech = (rec) => {
    let changed = false;
    for (const cmd of rec.cmds) changed = applyCommand(stats, cmd, me) || changed;
    active.add(rec.id);
    done.add(rec.id);
    for (const id of rec.disables || []) disabled.add(id);
    return changed;
  };
  const ready = (rec) => rec.req.filter((r) => active.has(r)).length >= rec.count;
  const bonuses = [...(civEffects?.bonuses || [])].sort((a, b) => a.id - b.id);
  const picks = chosen.map((id) => playerTechs[id]).filter(Boolean);
  for (let age = 1; age <= 4; age++) {
    active.add(age === 1 ? 104 : 99 + age); // 104 Dark, 101 Feudal, 102 Castle, 103 Imperial
    for (const rec of picks.filter((r) => r.age === age).sort((a, b) => a.id - b.id)) runTech(rec);
    let progress = true;
    while (progress) {
      progress = false;
      for (const b of bonuses) {
        if (done.has(b.id) || disabled.has(b.id) || b.age > age || !ready(b)) continue;
        if (runTech(b)) applied.push(b.name);
        progress = true;
      }
    }
  }
  for (const cmd of civEffects?.team || []) {
    if (applyCommand(stats, cmd, me)) applied.push('Team bonus');
  }
  return [...new Set(applied)];
}

/** True if any of a tech's stat changes would touch this unit. */
export function affectsUnit(rec, me) {
  return rec.cmds.some(([, unit, cls]) => unit === me.id || (unit === -1 && cls === me.cls));
}

/**
 * Turns a raw unit record + chosen upgrades into fighter stats.
 * opts: { civ, attackLevel, armourLevel, bloodlines, uts: [tech ids], extra: { attack, meleeArmour, pierceArmour, hp } }
 */
export function buildFighter(unit, name, opts = {}) {
  const { civ, uts = [], extra = {} } = opts;
  const stats = {
    hp: unit.HP,
    speed: unit.Speed,
    reload: unit.ReloadTime,
    attacks: new Map((unit.Attacks || []).map((a) => [a.Class, a.Amount])),
    armours: new Map((unit.Armours || []).map((a) => [a.Class, a.Amount])),
  };
  const me = { id: unit.ID, cls: UNIT_CLASS[unit.ID] };
  const civEffects = civ ? CIV_EFFECTS[civ] : null;
  const utRecs = Object.fromEntries((civEffects?.uts || []).map((u) => [u.id, u]));
  const bonuses = applyEffects(stats, me, {
    civEffects,
    playerTechs: { ...PLAYER_TECHS, ...utRecs },
    chosen: [...playerTechIds(unit, opts), ...uts],
  });

  const bump = (map, cls, by) => { if (by) map.set(cls, (map.get(cls) ?? 0) + by); };
  bump(stats.attacks, CLASS.MELEE, Number(extra.attack) || 0);
  bump(stats.armours, CLASS.MELEE, Number(extra.meleeArmour) || 0);
  bump(stats.armours, CLASS.PIERCE, Number(extra.pierceArmour) || 0);
  stats.hp += Number(extra.hp) || 0;

  return {
    name,
    unitId: unit.ID,
    hp: Math.max(1, Math.round(stats.hp * 100) / 100),
    attacks: stats.attacks,
    armours: stats.armours,
    reload: stats.reload,
    attackDelay: unit.AttackDelaySeconds || 0,
    speed: stats.speed,
    range: unit.Range || 0,
    radius: radiusOf(unit),
    bonuses,
  };
}

export function damagePerHit(attacker, defender) {
  let sum = 0;
  for (const [cls, amount] of attacker.attacks) {
    if (defender.armours.has(cls)) sum += Math.max(0, amount - defender.armours.get(cls));
  }
  return Math.max(1, sum);
}

export const hitsToKill = (attacker, defender) => Math.ceil(defender.hp / damagePerHit(attacker, defender));
