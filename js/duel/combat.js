// Pure combat rules. No DOM, so it can be tested with Node.
//
// Damage per hit (flat ground, melee or projectile):
//   max(1, sum over attack classes of max(0, attack[c] - armour[c]))
// Only classes the defender has an armour entry for count. Melee is class 4,
// pierce is class 3; everything else is a bonus class (e.g. 27 Spearmen).

import { RADII } from './radii.js';
import { UNIT_CLASS, CIV_EFFECTS, PLAYER_TECHS, UNIT_UPGRADES } from './effects.js';
import { RANGED, PROJECTILE_CLASS } from './ranged.js';
import { SPECIALS } from './specials.js';

export const CLASS = { INFANTRY: 1, PIERCE: 3, MELEE: 4, ELEPHANT: 5, CAVALRY: 8, ARCHER: 15, SHIP: 16, RAM: 17, SIEGE: 20, CAMEL: 30 };
// Units that fight by blowing themselves up (Flaming Camel, Petard): not lane fighters.
const SUICIDE = new Set([1263, 440]);

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

/**
 * Units the duel supports: land units that fight, melee or ranged, including
 * siege; no ships. Camels (including the Mameluke) have their own armour class,
 * not Cavalry, so they're listed too.
 */
export function isDuelEligible(u) {
  if (!u || !(u.Attack > 0) || SUICIDE.has(u.ID)) return false;
  const c = armourClasses(u);
  if (c.has(CLASS.SHIP)) return false;
  return c.has(CLASS.INFANTRY) || c.has(CLASS.CAVALRY) || c.has(CLASS.ELEPHANT) || c.has(CLASS.ARCHER) || c.has(CLASS.CAMEL)
    || c.has(CLASS.SIEGE) || c.has(CLASS.RAM);
}

/** Rams, trebuchets and armoured elephants: they only attack buildings (and other siege). */
export const buildingsOnly = (u) => armourClasses(u).has(CLASS.RAM);

export const isRanged = (u) => Boolean(RANGED[u?.ID]);

// Collision radius in tiles, from the game data file where known; otherwise
// a fallback by unit type. It only affects when the first blow lands.
export function radiusOf(u) {
  if (RADII[u.ID] !== undefined) return RADII[u.ID];
  const c = armourClasses(u);
  if (c.has(CLASS.ELEPHANT) || c.has(CLASS.CAVALRY) || c.has(CLASS.CAMEL)) return 0.25;
  return 0.2;
}

// Charge shots a unique tech adds to a unit that doesn't have one in the game data we read.
// Gothikon (Varangians): Varangian Guards throw an axe within 3 tiles every 30 seconds.
// (Published: the 30 s and the 3 tiles. The axe's damage is our estimate, like a Throwing
// Axeman's axe: 7 for the Varangian Guard, 9 for the Elite, melee, against armour.)
const CHARGE_SHOTS = {
  2703: { max: 1, rate: 1 / 30, projectile: { id: 0, attacks: [[4, 7]], speed: 7, arc: -0.05, sprite: 'p_throwing_axe_x1', minRange: 0.5, accuracy: 100, spread: 0.3, fullStray: true, count: 1, combat: 0 } },
  2704: { max: 1, rate: 1 / 30, projectile: { id: 0, attacks: [[4, 9]], speed: 7, arc: -0.05, sprite: 'p_throwing_axe_x1', minRange: 0.5, accuracy: 100, spread: 0.3, fullStray: true, count: 1, combat: 0 } },
};
// Unique techs whose effects aren't plain stat changes in the game data we read (abilities added
// in newer DLCs), written out by hand. who(id, cls) says which units it changes; apply(f) changes
// the finished fighter. Numbers marked "est." aren't published; they're our best estimate.
const INFANTRY = 6, CAVALRY = 12, SCOUT = 47, FOOT_ARCHER = 0;
const GUNPOWDER = new Set([5, 36, 1001, 1003, 771, 773, 46, 557, 1911]);
export const CUSTOM_UTS = {
  // Hamask (Danes): infantry hit harder as they lose HP: up to +50% near death (est.)
  1484: { who: (id, cls) => cls === INFANTRY, apply: (f) => { f.special.hamask = 0.5; } },
  // Shield Wall (Saxons): infantry +1/+1 armour for each 15 infantry near it (3 tiles, est.), up to +3/+3
  1464: { who: (id, cls) => cls === INFANTRY, apply: (f) => { f.special.shieldWall = { per: 15, max: 3, radius: 3 }; } },
  // Coiled Serpent Array (Shu): Spearman-line and White Feather Guards up to +15% HP with 30 of them near (3 tiles, est.)
  1070: { who: (id) => [93, 358, 359, 1959, 1961].includes(id), apply: (f) => { f.special.serpent = { share: 0.15, full: 30, radius: 3 }; } },
  // Ordo Cavalry (Khitans): melee cavalry regenerate while fighting: 30 HP a minute (est.)
  1007: { who: (id, cls, ranged) => (cls === CAVALRY || cls === SCOUT) && !ranged, apply: (f) => { f.special.combatRegen = 30; } },
  // Curare (Tupi): foot archers poison what they hit: 5 more damage over 5 seconds (est.)
  1393: { who: (id, cls, ranged) => cls === FOOT_ARCHER && ranged, apply: (f) => { f.special.poison = { dmg: 5, secs: 5 }; } },
  // Malon (Mapuche): Bolas Riders, Slingers and Skirmishers' shots go on into the enemy behind: half damage (est.)
  1379: { who: (id) => [2569, 2571, 185, 7, 6, 1155].includes(id), apply: (f) => { if (f.projectile) f.projectile.pass = 0.5; } },
  // Pirotechnia (Italians): Hand Cannoneers' shots go on into the enemy behind for 15% (and +accuracy, in the data)
  902: { who: (id) => id === 5, apply: (f) => { if (f.projectile) f.projectile.pass = (f.projectile.pass || 0) + 0.15; } },
  // Thunderclap Bombs (Jurchens): Rocket Carts and Grenadiers blow up when killed: 20 damage within 1.25 tiles (est.)
  997: { who: (id) => [1904, 1907, 1911].includes(id), apply: (f) => { f.special.deathBlast = { radius: 1.25, dmg: 20 }; } },
  // Arquebus (Portuguese): gunpowder units aim ahead of moving targets (like Ballistics)
  573: { who: (id) => GUNPOWDER.has(id), apply: (f) => { if (f.projectile) f.projectile.ballistics = true; } },
  // Red Cliffs Tactics (Wu): Fire Archers set buildings burning: 5 more damage over 5 seconds
  1080: { who: (id) => id === 1968 || id === 1970, apply: (f) => { f.special.burn = { dmg: 5, secs: 5 }; } },
  // Butalmapu (Mapuche): Kona and Bolas Riders cost -15%
  1380: { who: (id) => [2566, 2568, 2569, 2571].includes(id), apply: (f) => { for (const k of Object.keys(f.cost)) f.cost[k] = Math.round(f.cost[k] * 0.85); } },
};
/** Does one of the hand-written unique techs change this unit? */
export const customUtAffects = (techId, unit) => Boolean(CUSTOM_UTS[techId]?.who(unit.ID, UNIT_CLASS[unit.ID], Boolean(RANGED[unit.ID])));

const ATTR = { HP: 0, SPEED: 5, ARMOUR: 8, ATTACK: 9, RELOAD: 10, ACCURACY: 11, RANGE: 12, PROJECTILES: 102 };
// Special-ability attributes (UGC guide numbering), kept in stats.sp
const SP_ATTRS = new Set([22, 24, 59, 60, 61, 62, 63, 109, 115, 118]);
// Cost attributes: 100 every resource, then one resource each
const COST_ATTRS = { 103: 'Food', 104: 'Wood', 105: 'Gold', 106: 'Stone' };

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
    case 100:
      if (!stats.cost) return false;
      for (const k of Object.keys(stats.cost)) stats.cost[k] = op(stats.cost[k]);
      break;
    case 101:
      if (stats.trainTime === undefined) return false;
      stats.trainTime = op(stats.trainTime);
      break;
    case 103: case 104: case 105: case 106:
      if (!stats.cost) return false;
      stats.cost[COST_ATTRS[attr]] = op(stats.cost[COST_ATTRS[attr]] ?? 0);
      break;
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
export function applyEffects(stats, me, { civEffects, playerTechs, chosen, maxAge = 4 }) {
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
  for (let age = 1; age <= maxAge; age++) {
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
    baseBlast: spBase(SPECIALS[unit.ID])[22] || 0,
    cost: { Food: 0, Wood: 0, Gold: 0, Stone: 0, ...(unit.Cost || {}) },
    trainTime: unit.TrainTime || 0,
  };
  const me = meOf(unit);
  const civEffects = civ ? CIV_EFFECTS[civ] : null;
  const utRecs = Object.fromEntries((civEffects?.uts || []).map((u) => [u.id, u]));
  // The unit's own upgrade tech (e.g. Elite Fire Lancer) can also change its projectiles.
  const upgrade = UNIT_UPGRADES[unit.ID];
  const effectOpts = {
    civEffects,
    playerTechs: { ...PLAYER_TECHS, ...utRecs, ...(upgrade ? { [upgrade.id]: upgrade } : {}) },
    chosen: [...playerTechIds(unit, opts), ...uts, ...(upgrade ? [upgrade.id] : [])],
    maxAge: opts.age ?? 4,   // civ bonuses up to this age (AOSiege: the player's age)
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
  // A charge a tech gives a unit that has no charge shot of its own in the data (Gothikon)
  const given = CHARGE_SHOTS[unit.ID];
  const special = {
    charge: chargeType && sp[59] > 0 ? {
      type: chargeType, max: given?.max ?? sp[59], rate: given?.rate ?? sp[60], event: Math.round(sp[61] || 0),
      projectile: chargeShot(spec.charge?.projectile || given?.projectile),
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

  const out = {
    name,
    unitId: unit.ID,
    cls: UNIT_CLASS[unit.ID],
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
    cost: Object.fromEntries(Object.entries(stats.cost).map(([k, v]) => [k, Math.round(v)]).filter(([, v]) => v > 0)),
    trainTime: Math.round(stats.trainTime * 10) / 10,
    projectile: ranged && {
      speed: ranged.speed,
      arc: ranged.arc,
      // Chemistry: burning arrows, bolts and stones, as in the game
      sprite: effectOpts.chosen.includes(47) && ranged.fire ? ranged.fire : ranged.sprite,
      spread: ranged.spread,
      // (techs that widen the blast, Warwolf and Torsion Engines, add to the projectile's)
      blast: (ranged.blast || 0) + Math.max(0, (stats.sp[22] || 0) - stats.baseBlast),
      ballistics: hasBallistics,
      fullStray: Boolean(ranged.fullStray),
      pierces: Boolean(ranged.pierces),
      count: Math.max(1, Math.round(stats.projectiles)),
      accuracy: Math.min(100, Math.max(0, stats.accuracy)),
      secondary,
    },
  };
  for (const id of uts) if (customUtAffects(id, unit)) CUSTOM_UTS[id].apply(out);
  return out;
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
 * opts.extraMelee: charge damage added to this blow;
 * opts.ignoreArmour: the projectile itself ignores armour (Fire Lancer shot).
 * Armour-ignoring attackers (Leitis, Composite Bowman) skip melee and pierce
 * armour; bonus damage resistance (Sicilians, Bengali elephants) shrinks the
 * bonus part of the attack.
 */
export function damagePerHit(attacker, defender, attacks = attacker.attacks, { armourLoss = 0, extraMelee = 0, ignoreArmour = false } = {}) {
  let sum = 0;
  const ignore = (ignoreArmour || ((attacker.special?.combat || 0) & 1)) && !((defender.special?.combat || 0) & 2);
  const resist = defender.special?.bonusResist || 0;
  for (const [cls, raw] of attacks) {
    if (!defender.armours.has(cls)) continue;
    const amount = raw + (cls === CLASS.MELEE ? extraMelee : 0);
    const base = cls === CLASS.MELEE || cls === CLASS.PIERCE;
    let armour = defender.armours.get(cls);
    if (base) armour = ignore ? Math.min(0, armour) : armour > 0 ? Math.max(0, armour - armourLoss) : armour;
    // A negative bonus (mounted units' -3 in class 39) takes damage off, as in the game:
    // camels' own -3 cancels it, and Royal Heirs (+3) lets it through.
    let part = !base && raw < 0 ? Math.min(0, amount - armour) : Math.max(0, amount - armour);
    if (!base && part > 0) part *= 1 - resist;
    sum += part;
  }
  if (extraMelee && !attacks.has(CLASS.MELEE) && defender.armours.has(CLASS.MELEE)) {
    sum += Math.max(0, extraMelee - (ignore ? 0 : defender.armours.get(CLASS.MELEE)));
  }
  return Math.max(1, sum);
}

export const hitsToKill = (attacker, defender) => Math.ceil(defender.hp / damagePerHit(attacker, defender));
