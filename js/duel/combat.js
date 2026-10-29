// Pure combat rules. No DOM, so it can be tested with Node.
//
// Damage per hit (flat ground, melee or projectile):
//   max(1, sum over attack classes of max(0, attack[c] - armour[c]))
// Only classes the defender has an armour entry for count. Melee is class 4,
// pierce is class 3; everything else is a bonus class (e.g. 27 Spearmen).

import { RADII } from './radii.js';
import { UNIT_CLASS, CIV_EFFECTS, PLAYER_TECHS } from './effects.js';
import { RANGED, PROJECTILE_CLASS } from './ranged.js';
import { SPECIALS } from './specials.js';

export const CLASS = { INFANTRY: 1, PIERCE: 3, MELEE: 4, ELEPHANT: 5, CAVALRY: 8, ARCHER: 15, SHIP: 16, RAM: 17, SIEGE: 20 };

// Blacksmith lines: index = number of upgrades researched. Which line applies to
// a unit is read from the techs' own effects (e.g. Fletching for archers and
// cavalry archers, Forging for throwing-axe infantry).
export const TRACKS = {
  attack: [
    { key: 'melee', techs: [67, 68, 75], names: ['Forging', 'Iron Casting', 'Blast Furnace'] },
    { key: 'archer', techs: [199, 200, 201], names: ['Fletching', 'Bodkin Arrow', 'Bracer'] },
  ],
  armour: [
    { key: 'archer', techs: [211, 212, 219], names: ['Padded Archer Armor', 'Leather Archer Armor', 'Ring Archer Armor'] },
    { key: 'cavalry', techs: [81, 82, 80], names: ['Scale Barding Armor', 'Chain Barding Armor', 'Plate Barding Armor'] },
    { key: 'infantry', techs: [74, 76, 77], names: ['Scale Mail Armor', 'Chain Mail Armor', 'Plate Mail Armor'] },
  ],
};
// Single upgrades offered as switches when they change the unit.
export const OTHER_TECHS = [
  { id: 435, name: 'Bloodlines' },
  { id: 437, name: 'Thumb Ring' },
  { id: 436, name: 'Parthian Tactics' },
  { id: 47, name: 'Chemistry' },
  { id: 215, name: 'Squires' },
  { id: 39, name: 'Husbandry' },
  // Ballistics changes the projectile, not the unit, so it's matched by the unit's projectile data.
  { id: 93, name: 'Ballistics', applies: (unit) => Boolean(RANGED[unit.ID]?.ballistics) },
];
// Kept for older callers and tests
export const BLACKSMITH = {
  attack: { techs: TRACKS.attack[0].techs },
  infantryArmour: { techs: TRACKS.armour[2].techs },
  cavalryArmour: { techs: TRACKS.armour[1].techs },
  bloodlines: { tech: 435, hp: 20 },
};

const armourClasses = (u) => new Set((u.Armours || []).map((a) => a.Class));
export const isInfantry = (u) => armourClasses(u).has(CLASS.INFANTRY);
export const isCavalry = (u) => armourClasses(u).has(CLASS.CAVALRY);

/** Units the duel supports: land units that fight, melee or ranged; no siege, rams or ships. */
export function isDuelEligible(u) {
  if (!u || !(u.Attack > 0)) return false;
  const c = armourClasses(u);
  if (c.has(CLASS.SHIP) || c.has(CLASS.SIEGE) || c.has(CLASS.RAM)) return false;
  return c.has(CLASS.INFANTRY) || c.has(CLASS.CAVALRY) || c.has(CLASS.ELEPHANT) || c.has(CLASS.ARCHER);
}

export const isRanged = (u) => Boolean(RANGED[u?.ID]);

// Collision radius in tiles, from the game data file where known; otherwise
// a fallback by unit type. It only affects when the first blow lands.
export function radiusOf(u) {
  if (RADII[u.ID] !== undefined) return RADII[u.ID];
  const c = armourClasses(u);
  if (c.has(CLASS.ELEPHANT) || c.has(CLASS.CAVALRY)) return 0.25;
  return 0.2;
}

const ATTR = { HP: 0, SPEED: 5, ARMOUR: 8, ATTACK: 9, RELOAD: 10, ACCURACY: 11, RANGE: 12, PROJECTILES: 102 };
// Special-ability attributes (UGC guide numbering), kept in stats.sp
const SP_ATTRS = new Set([22, 24, 59, 60, 61, 62, 63, 109, 115, 118]);

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
    case ATTR.ACCURACY: if (stats.accuracy === undefined) return false; stats.accuracy = op(stats.accuracy); break;
    case ATTR.RANGE: if (stats.range === undefined) return false; stats.range = op(stats.range); break;
    case ATTR.PROJECTILES: if (stats.projectiles === undefined) return false; stats.projectiles = op(stats.projectiles); break;
    default:
      if (!SP_ATTRS.has(attr) || !stats.sp) return false;
      stats.sp[attr] = op(stats.sp[attr] ?? 0);
      return true;
    case ATTR.ARMOUR:
    case ATTR.ATTACK: {
      const map = attr === ATTR.ARMOUR ? stats.armours : stats.attacks;
      const { cls, amount } = unpack(value);
      if (!map.has(cls) && attr === ATTR.ARMOUR) return false; // unit isn't in that armour class
      const current = map.get(cls) ?? 0;
      map.set(cls, type === 0 ? amount : type === 4 ? current + amount : current * (amount / 100));
      break;
    }
  }
  return true;
}

const meOf = (unit) => ({ id: unit.ID, cls: UNIT_CLASS[unit.ID] });
const touches = (techId, me) => Boolean(PLAYER_TECHS[techId]) && affectsUnit(PLAYER_TECHS[techId], me);

/** The Blacksmith line ('attack' or 'armour') that upgrades this unit, or null. */
export function trackFor(unit, kind) {
  const me = meOf(unit);
  return TRACKS[kind].find((t) => touches(t.techs[0], me)) || null;
}

/** The single-tech switches (Bloodlines, Thumb Ring, ...) that change this unit. */
export function otherTechsFor(unit) {
  const me = meOf(unit);
  return OTHER_TECHS.filter((t) => (t.applies ? t.applies(unit) : touches(t.id, me)));
}

/**
 * Tech IDs for the chosen upgrade levels and switches.
 * techs: ids of the switches turned on; bloodlines: legacy flag for Bloodlines.
 */
export function playerTechIds(unit, { attackLevel = 0, armourLevel = 0, bloodlines = false, techs = [] } = {}) {
  const ids = [];
  // Every line that upgrades the unit counts (Hearth Troops get Forging for the
  // sword and Fletching for the javelin).
  const me = meOf(unit);
  for (const t of TRACKS.attack) if (touches(t.techs[0], me)) ids.push(...t.techs.slice(0, attackLevel));
  for (const t of TRACKS.armour) if (touches(t.techs[0], me)) ids.push(...t.techs.slice(0, armourLevel));
  const others = new Set(otherTechsFor(unit).map((t) => t.id));
  if (bloodlines && others.has(435)) ids.push(435);
  for (const id of techs) if (others.has(id) && !ids.includes(id)) ids.push(id);
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
  const ranged = RANGED[unit.ID] || null;
  const stats = {
    hp: unit.HP,
    speed: unit.Speed,
    reload: unit.ReloadTime,
    range: unit.Range || 0,
    accuracy: ranged ? unit.AccuracyPercent ?? 100 : undefined,
    projectiles: ranged ? ranged.count : undefined,
    attacks: new Map((unit.Attacks || []).map((a) => [a.Class, a.Amount])),
    armours: new Map((unit.Armours || []).map((a) => [a.Class, a.Amount])),
    sp: spBase(SPECIALS[unit.ID]),
  };
  const me = meOf(unit);
  const civEffects = civ ? CIV_EFFECTS[civ] : null;
  const utRecs = Object.fromEntries((civEffects?.uts || []).map((u) => [u.id, u]));
  const effectOpts = {
    civEffects,
    playerTechs: { ...PLAYER_TECHS, ...utRecs },
    chosen: [...playerTechIds(unit, opts), ...uts],
  };
  const bonuses = applyEffects(stats, me, effectOpts);
  const hasBallistics = effectOpts.chosen.includes(93) && Boolean(ranged?.ballistics);

  // Extra projectiles (Chu Ko Nu, Kipchak) carry their own attack, which techs
  // can change separately from the unit's.
  let secondary = null;
  if (ranged?.secondary) {
    const sec = { attacks: new Map(ranged.secondary.attacks), armours: new Map(), hp: 0, speed: 0, reload: 0 };
    applyEffects(sec, { id: ranged.secondary.id, cls: PROJECTILE_CLASS }, effectOpts);
    secondary = { attacks: sec.attacks };
  }

  // Charge projectiles (Fire Lancer, Hearth Troop, Bolas Rider, Xianbei) are
  // upgraded separately from the unit, like extra arrows.
  const spec = SPECIALS[unit.ID] || {};
  const chargeShot = (rec) => {
    if (!rec) return null;
    const ps = { attacks: new Map(rec.attacks), armours: new Map(), hp: 0, speed: 0, reload: 0 };
    applyEffects(ps, { id: rec.id, cls: PROJECTILE_CLASS }, effectOpts);
    return { ...rec, attacks: ps.attacks, ballistics: effectOpts.chosen.includes(93) };
  };
  const sp = stats.sp;
  const chargeType = Math.round(sp[62] || 0);
  const special = {
    charge: chargeType && sp[59] > 0 ? {
      type: chargeType, max: sp[59], rate: sp[60], event: Math.round(sp[61] || 0),
      projectile: chargeShot(spec.charge?.projectile),
      extra: chargeShot(spec.charge?.extra),
    } : null,
    rush: spec.rush || null,
    blast: sp[22] > 0 ? { width: sp[22], level: spec.blast?.level ?? 2, damage: sp[115] || 1 } : null,
    combat: Math.round(sp[63] || 0),
    bonusResist: sp[24] || 0,
    regen: sp[109] || 0,             // HP per minute
    reflect: sp[118] || 0,
  };
  let dismount = null;
  if (spec.dismount && opts.units?.[spec.dismount]) {
    dismount = buildFighter(opts.units[spec.dismount], `${name} (on foot)`, { ...opts, units: null });
  }

  const bump = (map, cls, by) => { if (by) map.set(cls, (map.get(cls) ?? 0) + by); };
  const mainAttack = ranged ? CLASS.PIERCE : CLASS.MELEE;
  bump(stats.attacks, mainAttack, Number(extra.attack) || 0);
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
    range: stats.range,
    minRange: unit.MinRange || 0,
    radius: radiusOf(unit),
    bonuses,
    special,
    dismount,
    projectile: ranged && {
      speed: ranged.speed,
      arc: ranged.arc,
      sprite: ranged.sprite,
      spread: ranged.spread,
      blast: ranged.blast,
      ballistics: hasBallistics,
      fullStray: Boolean(ranged.fullStray),
      pierces: Boolean(ranged.pierces),
      count: Math.max(1, Math.round(stats.projectiles)),
      accuracy: Math.min(100, Math.max(0, stats.accuracy)),
      secondary,
    },
  };
}

/** Special-ability attributes a unit starts with (charge, trample, etc.). */
function spBase(rec) {
  const sp = {};
  if (!rec) return sp;
  if (rec.charge) { sp[62] = rec.charge.type; sp[59] = rec.charge.max; sp[60] = rec.charge.rate; sp[61] = rec.charge.event; }
  if (rec.blast) { sp[22] = rec.blast.width; sp[115] = rec.blast.damage; }
  else if (rec.blastDamage !== undefined) sp[115] = rec.blastDamage;
  if (rec.combat) sp[63] = rec.combat;
  if (rec.bonusResist) sp[24] = rec.bonusResist;
  if (rec.reflect) sp[118] = rec.reflect;
  return sp;
}

/**
 * Damage of one blow or projectile. `attacks` defaults to the attacker's own.
 * opts.armourLoss: armour torn off the defender so far (Obuch);
 * opts.extraMelee: charge damage added to this blow.
 * Armour-ignoring attackers (Leitis, Composite Bowman) skip melee and pierce
 * armour; bonus damage resistance (Sicilians, Bengali elephants) shrinks the
 * bonus part of the attack.
 */
export function damagePerHit(attacker, defender, attacks = attacker.attacks, { armourLoss = 0, extraMelee = 0 } = {}) {
  let sum = 0;
  const ignore = ((attacker.special?.combat || 0) & 1) && !((defender.special?.combat || 0) & 2);
  const resist = defender.special?.bonusResist || 0;
  for (const [cls, raw] of attacks) {
    if (!defender.armours.has(cls)) continue;
    const amount = raw + (cls === CLASS.MELEE ? extraMelee : 0);
    const base = cls === CLASS.MELEE || cls === CLASS.PIERCE;
    let armour = defender.armours.get(cls);
    if (base) armour = ignore ? Math.min(0, armour) : armour > 0 ? Math.max(0, armour - armourLoss) : armour;
    let part = Math.max(0, amount - armour);
    if (!base && part > 0) part *= 1 - resist;
    sum += part;
  }
  if (extraMelee && !attacks.has(CLASS.MELEE) && defender.armours.has(CLASS.MELEE)) {
    sum += Math.max(0, extraMelee - (ignore ? 0 : defender.armours.get(CLASS.MELEE)));
  }
  return Math.max(1, sum);
}

export const hitsToKill = (attacker, defender) => Math.ceil(defender.hp / damagePerHit(attacker, defender));
