// Pure combat rules. No DOM, so it can be tested with Node.
//
// Damage per hit (melee, flat ground):
//   max(1, sum over attack classes of max(0, attack[c] - armour[c]))
// Only classes the defender has an armour entry for count. Melee is class 4,
// pierce is class 3; everything else is a bonus class (e.g. 27 Spearmen).

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

// Collision radius in tiles. The tech-tree data doesn't include it, so these
// are approximations by unit type. They only affect when the first blow lands.
export function radiusOf(u) {
  const c = armourClasses(u);
  if (c.has(CLASS.ELEPHANT)) return 0.6;
  if (c.has(CLASS.CAVALRY)) return 0.4;
  return 0.2;
}

/**
 * Turns a raw unit record + chosen upgrades into fighter stats.
 * opts: { attackLevel, armourLevel, bloodlines, extra: { attack, meleeArmour, pierceArmour, hp } }
 */
export function buildFighter(unit, name, opts = {}) {
  const { attackLevel = 0, armourLevel = 0, bloodlines = false, extra = {} } = opts;
  const attacks = new Map((unit.Attacks || []).map((a) => [a.Class, a.Amount]));
  const armours = new Map((unit.Armours || []).map((a) => [a.Class, a.Amount]));
  const inf = isInfantry(unit);
  const cav = isCavalry(unit);
  let hp = unit.HP;

  const bump = (map, cls, by) => { if (by) map.set(cls, (map.get(cls) ?? 0) + by); };

  if (inf || cav) bump(attacks, CLASS.MELEE, BLACKSMITH.attack.melee[attackLevel] || 0);
  const armourTrack = cav ? BLACKSMITH.cavalryArmour : inf ? BLACKSMITH.infantryArmour : null;
  if (armourTrack) {
    bump(armours, CLASS.MELEE, armourTrack.melee[armourLevel] || 0);
    bump(armours, CLASS.PIERCE, armourTrack.pierce[armourLevel] || 0);
  }
  if (cav && bloodlines) hp += BLACKSMITH.bloodlines.hp;

  bump(attacks, CLASS.MELEE, Number(extra.attack) || 0);
  bump(armours, CLASS.MELEE, Number(extra.meleeArmour) || 0);
  bump(armours, CLASS.PIERCE, Number(extra.pierceArmour) || 0);
  hp += Number(extra.hp) || 0;

  return {
    name,
    unitId: unit.ID,
    hp: Math.max(1, hp),
    attacks,
    armours,
    reload: unit.ReloadTime,
    attackDelay: unit.AttackDelaySeconds || 0,
    speed: unit.Speed,
    range: unit.Range || 0,
    radius: radiusOf(unit),
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
