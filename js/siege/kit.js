// What each civ can build in AOSiege, read from its tech tree: every unit line
// its Barracks, Archery Range, Stable and Castle can train, each with its real
// upgrade steps (Militia → Man-at-Arms → … → Champion), and the techs the
// Armory offers (Blacksmith, unit upgrades like Bloodlines and Ballistics, and
// the civ's unique techs). Pure (no DOM), so it runs in Node tests too.
//
// Everything is paid in gold. Prices come from the game's own costs, scaled
// down: a building trains about the same value of army per second whatever it
// makes, so cheap units come in numbers and expensive ones in quality.

import { buildFighter, otherTechsFor, isDuelEligible, buildingsOnly, trackFor, affectsUnit, TRACKS, OTHER_TECHS } from '../duel/combat.js';
import { CIV_EFFECTS, UNIT_CLASS, PLAYER_TECHS } from '../duel/effects.js';

export const TRAIN_AT = [12, 87, 101, 49, 82];    // read from: Barracks, Archery Range, Stable, Siege Workshop, Castle
// Castle units (unique units, the Trebuchet) train at the building of their kind instead:
// the Castle is a defence here.
const TRAINS_IN = [12, 87, 101, 49];
export const BUILDING_NAMES = { 12: 'Barracks', 87: 'Archery Range', 101: 'Stable', 49: 'Siege Workshop', 82: 'Castle', 84: 'Market', 79: 'Watch Tower', 234: 'Guard Tower', 235: 'Keep', 236: 'Bombard Tower' };
export const MARKET = { key: 'market', label: 'Market', building: 84, cost: 300, income: 5, max: 3, age: 2, r: 1.3, build: 8 };
// Size (tiles, as a circle) and build time (real seconds) of each kind of building.
export const FOOTPRINT = { train: { r: 1.4, build: 10 } };
// Defences: towers (upgraded in place, like a unit line), the Bombard Tower and the Castle.
// They shoot the nearest enemy soldier in range; they don't train anything.
export const DEFENCES = [
  { key: 'def:tower', label: 'Watch Tower', tiers: [{ building: 79, age: 2 }, { building: 234, age: 3, upgrade: 150 }, { building: 235, age: 4, upgrade: 225 }], cost: 175, r: 0.75, build: 8, arrows: 1, shot: 'p_arrow_x1' },
  { key: 'def:bombard', label: 'Bombard Tower', tiers: [{ building: 236, age: 4 }], needs: 47, cost: 425, r: 0.85, build: 10, arrows: 1, shot: 'p_ball_x1' },
  { key: 'def:castle', label: 'Castle', tiers: [{ building: 82, age: 3 }], cost: 800, r: 1.95, build: 12, arrows: 2, shot: 'p_arrow_x1' },
];
// Everything a little dearer than before; siege dearer still, and slower to come out.
const PRICE_UP = 1.15;
const SIEGE_PRICE = 1.3;
const SIEGE_TIME = 1.4;
export const NOT_UNITS = new Set([440]);         // Petard: not a lane fighter
// The tech tree lists the Trebuchet packed; it fights unpacked.
const FIGHTS_AS = { 331: 42 };
const SIEGE_CLASSES = [17, 20];
const isSiege = (u) => (u?.Armours || []).some((a) => SIEGE_CLASSES.includes(a.Class));
export const NEEDS = { 5: 47, 36: 47 };         // unit -> tech it needs (Hand Cannoneer, Bombard Cannon: Chemistry)
// What a building costs follows what its unit costs in the game, with this
// civ's bonuses (Goths' cheap infantry, Mayan archers...) at the player's age.
// Gold (and stone) count double, so gold-heavy units, and their upgrades, cost more.
const weight = (c) => (c.Food || 0) + (c.Wood || 0) + 2 * ((c.Gold || 0) + (c.Stone || 0));
export const unitPrice = (w) => round5(60 + Math.min(w, 200) + 0.6 * Math.max(0, w - 200));
const UNIQUE_MARKUP = 1.15;
const MARKUP = { 42: 1.25 };   // Trebuchets: a bit dearer still
// How often a building sends out a unit: the unit's real training time (with civ bonuses), in game seconds.
const TRAIN_SCALE = 1;
// Ages: 1 Dark, 2 Feudal, 3 Castle, 4 Imperial. Everyone starts in the Dark Age.
export const AGES = [
  null,
  { name: 'Dark Age', tech: 104 },
  { name: 'Feudal Age', tech: 101, cost: 175, time: 15 },
  { name: 'Castle Age', tech: 102, cost: 400, time: 22 },
  { name: 'Imperial Age', tech: 103, cost: 750, time: 30 },
];
// Trebuchets: half their real range in this lane, and they pack/unpack (quicker than the game's).
export const TREB = { id: 42, packed: 331, rangeShare: 0.5, packTime: 2 };
const ARMOUR = { ELEPHANT: 5, CAVALRY: 8, CAMEL: 30 };
/** Where a Castle unit trains instead: siege at the Workshop, archers (on foot or mounted) at the Archery Range, riders at the Stable, the rest at the Barracks. */
function classBuilding(u) {
  const c = new Set((u?.Armours || []).map((a) => a.Class));
  if (SIEGE_CLASSES.some((k) => c.has(k))) return 49;
  if (c.has(15) || c.has(36)) return 87;
  if (c.has(ARMOUR.CAVALRY) || c.has(ARMOUR.CAMEL) || c.has(ARMOUR.ELEPHANT)) return 101;
  return 12;
}
/** Which price band a line's first unit falls in. */
export function priceBand(rootId, unit) {
  if (rootId === 93) return 'spear';
  if (rootId === 7) return 'skirm';
  const armours = new Set((unit?.Armours || []).map((a) => a.Class));
  if (armours.has(17) || armours.has(20)) return 'siege';   // rams, catapults, cannons, trebuchets
  if (armours.has(ARMOUR.ELEPHANT)) return 'elephant';
  if (rootId === 448 || rootId === 751 || rootId === 1755) return 'scout';   // Scout Cavalry, Eagle Scout, Camel Scout
  if (armours.has(ARMOUR.CAVALRY) || armours.has(ARMOUR.CAMEL)) return 'cavalry';
  return 'standard';
}
const UPGRADE_SHARE = 0.3;   // building upgrades cost this share of the real upgrade's resources (+30)
const TECH_SHARE = 0.33;     // Armory techs: same idea (+25)
const TECH_TIME = 0.3;       // and this share of the real research time

// Building upgrades: 30% of the real upgrade's resources (+30) up to 600 of them, then
// only 10% of the rest, so the last steps (Paladin, Elite unique units) stay affordable.
const upgradePrice = (c) => round5(30 + UPGRADE_SHARE * Math.min(c, 600) + 0.1 * Math.max(0, c - 600));
const total = (cost) => Object.values(cost || {}).reduce((a, b) => a + b, 0);
const round5 = (n) => Math.round(n / 5) * 5;
/** The game's help text, without the "Create <b>X</b> (cost)" opening and the list of upgrades. */
const helpText = (s) => clean(String(s || '').replace(/^.*?\(‹cost›\)\s*(<br>)?/s, '').replace(/<i>.*?<\/i>/gs, '').replace(/‹[^›]*›/g, ''));
const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// The usual top of each common unit line, and lines most civs have, to say what a civ lacks.
const TOPS = { 74: 567, 93: 359, 4: 492, 7: 6, 448: 441, 38: 569, 329: 330, 39: 474, 1258: 548, 280: 588, 279: 542, 751: 752, 1132: 1134 };
const COMMON_LINES = { 38: 'Knights', 39: 'Cavalry Archers', 5: 'Hand Cannoneers', 36: 'Bombard Cannons', 280: 'Mangonels', 279: 'Scorpions', 448: 'Scout Cavalry', 4: 'Archers', 93: 'Spearmen', 74: 'Militia' };
const KEY_TECHS = { 75: 'Blast Furnace', 77: 'Plate Mail Armor', 82: 'Plate Barding Armor', 201: 'Bracer', 219: 'Ring Archer Armor', 435: 'Bloodlines', 437: 'Thumb Ring', 47: 'Chemistry', 93: 'Ballistics', 39: 'Husbandry', 215: 'Squires' };

function civSummary({ lines, techs, U, techOk, civStats, linePrice, name }) {
  const strengths = [];
  const weaknesses = [];
  const rootOf = (l) => Number(l.key.split('-')[1]);
  const uniques = lines.filter((l) => l.unique && l.tiers[0].unitId !== TREB.id);
  if (uniques.length) strengths.push(`Unique: ${uniques.map((l) => l.tiers.at(-1).name).join(', ')}`);
  const full = [];
  for (const l of lines) {
    const top = TOPS[rootOf(l)];
    if (!top) continue;
    if (l.tiers.some((t) => t.unitId === top)) full.push(l.tiers.at(-1).name);
    else weaknesses.push(`No ${name(top)} (${l.tiers[0].name} line stops at ${l.tiers.at(-1).name})`);
  }
  if (full.length) strengths.push(`Fully upgraded: ${full.join(', ')}`);
  const roots = new Set(lines.map(rootOf));
  for (const [id, label] of Object.entries(COMMON_LINES)) if (!roots.has(Number(id))) weaknesses.push(`No ${label}`);
  const missing = Object.entries(KEY_TECHS).filter(([id]) => !techOk.has(Number(id))).map(([, n]) => n);
  if (missing.length) weaknesses.push(`Missing ${missing.join(', ')}`);
  // Cheaper or quicker than everyone else's version, by the Imperial Age
  const unitPriceOf = (id) => unitPrice((U[id].Cost.Food || 0) + (U[id].Cost.Wood || 0) + 2 * ((U[id].Cost.Gold || 0) + (U[id].Cost.Stone || 0)));
  for (const l of lines) {
    const base = round5(unitPriceOf(l.tiers[0].unitId) * l.markup);
    const now = linePrice(l, 4);
    if (now < base - 2) strengths.push(`${l.tiers[0].name} buildings ${Math.round((1 - now / base) * 100)}% cheaper (${now} vs ${base} gold)`);
    const t = l.tiers.at(-1);
    const real = U[t.unitId].TrainTime;
    const mine = civStats(t.unitId, 4).trainTime;
    if (real && mine < real - 0.5) strengths.push(`${t.name} train ${Math.round((1 - mine / real) * 100)}% faster`);
  }
  return { strengths, weaknesses, uniqueTechs: techs.filter((t) => t.group === 'Unique techs').map((t) => t.name) };
}

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
    && !NOT_UNITS.has(n.node_id) && U[FIGHTS_AS[n.node_id] ?? n.node_id] && isDuelEligible(U[FIGHTS_AS[n.node_id] ?? n.node_id]);

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
      // (Siege at the Castle, like the Trebuchet, is its own line.)
      if (building === 82 && castleLines > 0 && chain.length < 2 && !isSiege(U[FIGHTS_AS[root.node_id] ?? root.node_id])) continue;
      if (building === 82) castleLines += 1;
      chain.forEach((n) => seen.add(n.node_id));
      const band = priceBand(root.node_id, U[FIGHTS_AS[root.node_id] ?? root.node_id]);
      const rootUnit = U[FIGHTS_AS[root.node_id] ?? root.node_id];
      const siege = isSiege(rootUnit);
      const tiers = chain.map((n, i) => {
        const up = i ? data.data.unit_upgrades?.[n.node_id] : null;
        return {
          unitId: FIGHTS_AS[n.node_id] ?? n.node_id,
          name: name(n),
          picture: n.picture_index,
          age: n.age_id || 1,
          realUpgrade: i ? total(up?.Cost || { Gold: 500 }) : 0,
          help: helpText(strings[(U[FIGHTS_AS[n.node_id] ?? n.node_id]?.LanguageNameId ?? -1e9) + 21000]),
        };
      });
      // Castle units go to the building of their kind; the Trebuchet to the Siege Workshop, from the Castle Age.
      const at = building === 82 ? classBuilding(rootUnit) : building;
      if (rootUnit?.ID === TREB.id) tiers.forEach((t) => { t.age = Math.min(t.age, 3); });
      lines.push({
        key: `${at}-${root.node_id}`,
        building: at,
        unique: building === 82 && !siege,
        siege,
        label: tiers[0].name,
        band,
        age: rootUnit?.ID === TREB.id ? 3 : root.age_id || 1,
        markup: PRICE_UP * (building === 82 && !siege ? UNIQUE_MARKUP : 1) * (siege ? SIEGE_PRICE : 1) * (MARKUP[FIGHTS_AS[root.node_id] ?? root.node_id] || 1),
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
    return { cost: round5((25 + TECH_SHARE * total(t?.Cost)) * PRICE_UP), time: Math.max(6, Math.round((t?.ResearchTime || 40) * TECH_TIME)) };
  };
  const techRec = (id, group, label, extra = {}) => {
    const n = techNode.get(id);
    const age = n?.age_id || PLAYER_TECHS[id]?.age || (CIV_EFFECTS[civ]?.uts || []).find((u) => u.id === id)?.age || 2;
    return { id, group, name: n ? clean(strings[n.name_string_id] || n.name) : label, picture: n?.picture_index, age,
      help: helpText(strings[(data.data.Tech[id]?.LanguageNameId ?? -1e9) + 21000]), ...techCost(id), ...extra };
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
  const civStats = (unitId, age) => buildFighter(U[unitId], '', { civ, age, units: U });
  const priceCache = new Map();
  /** A line's building price at an age (civ cost bonuses depend on the age). */
  const linePrice = (line, age) => {
    const k = `${line.key}|${age}`;
    if (!priceCache.has(k)) priceCache.set(k, round5(unitPrice(weight(civStats(line.tiers[0].unitId, Math.max(age, line.age)).cost)) * line.markup));
    return priceCache.get(k);
  };
  for (const line of lines) {
    line.cost = linePrice(line, line.age);
    for (const t of line.tiers) {
      const st = civStats(t.unitId, 4);
      t.every = Math.max(6, Math.min(90, Math.round(st.trainTime * TRAIN_SCALE * (line.siege ? SIEGE_TIME : 1) * 10) / 10));
      // Upgrades: the real upgrade's resources, scaled down; dearer the more gold the unit costs.
      t.upgrade = t.realUpgrade ? round5(upgradePrice(t.realUpgrade) * (1 + ((st.cost.Gold || 0) + (st.cost.Stone || 0)) / 200) * PRICE_UP * (line.siege ? SIEGE_PRICE : 1)) : 0;
    }
  }

  // Defences this civ has: tower steps it can reach, the Bombard Tower, the Castle.
  const bstatus = new Map((tree.buildings || []).map((b) => [b.node_id ?? b.building_id, b.node_status]));
  const hasB = (id) => bstatus.has(id) && bstatus.get(id) !== 'NotAvailable';
  const defences = [];
  for (const d of DEFENCES) {
    const tiers = [];
    for (const t of d.tiers) { if (!hasB(t.building)) break; tiers.push(t); }
    if (!tiers.length || (d.needs && !techOk.has(d.needs))) continue;
    defences.push({
      ...d,
      defence: true,
      building: tiers[0].building,
      age: tiers[0].age,
      tiers: tiers.map((t) => ({ ...t, name: clean(strings[data.data.Building[t.building]?.LanguageNameId] || BUILDING_NAMES[t.building]), picture: buildingPicture.get(t.building), upgrade: t.upgrade || 0 })),
    });
  }

  return {
    civ,
    lines,
    techs,
    defences,
    buildingPicture: (id) => buildingPicture.get(id),
    /** Icon of an age's tech (Feudal, Castle, Imperial). */
    agePicture: (age) => techNode.get(AGES[age]?.tech)?.picture_index,
    /** The civ's description from the game (bullets of bonuses, unique units and techs). */
    help: strings[data.civs[civ]?.help_string_id] || '',
    /** What this civ has and lacks, for Wonder Wars: see civSummary(). */
    summary: () => civSummary({ lines, techs, U, techOk, civStats, linePrice, name: (id) => {
      const n = nodes.find((x) => x.node_id === id);
      return n ? clean(strings[n.name_string_id] || n.name) : clean(strings[U[id]?.LanguageNameId] || strings[U[id]?.LanguageNameId + 9000] || `Unit ${id}`);
    } }),
    line: (key) => lines.find((l) => l.key === key) || defences.find((d) => d.key === key),
    /** Fighter stats for a line at a tier with the researched techs (a Set of tech ids). */
    linePrice,
    fighter(lineKey, tier, researched = new Set(), key = [...researched].sort().join(','), age = 4) {
      const ck = `${lineKey}|${tier}|${key}|${age}`;
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
        const f = buildFighter(unit, t.name, {
          civ,
          age,
          attackLevel: level('attack'),
          armourLevel: level('armour'),
          techs: otherTechsFor(unit).map((o) => o.id).filter((id) => researched.has(id)),
          uts: [...researched].filter((id) => utIds.has(id)),
          units: U,
        });
        // Rams and trebuchets only go for buildings; a trebuchet walks packed (at its packed speed).
        f.buildingsOnly = buildingsOnly(unit);
        const packed = Object.entries(FIGHTS_AS).find(([, v]) => v === t.unitId)?.[0];
        if (!(f.speed > 0) && packed) { f.speed = U[packed].Speed; f.walkAs = Number(packed); }
        if (t.unitId === TREB.id) {
          f.range *= TREB.rangeShare;
          f.minRange = (f.minRange || 0) * TREB.rangeShare;
          f.packs = TREB.packTime;
        }
        cache.set(ck, f);
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
