// AOSiege: a simple Castle Fight for AoE2 units. Pure game state, no DOM.
//
// Two castles at the ends of one lane. Each side spends gold on buildings;
// every building trains its unit on a timer, and units march down the lane on
// their own, fighting whatever they meet. Knock down the enemy castle to win.
//
// Fighting uses the same damage rules as the Test tab (armour, bonus damage,
// civ bonuses, Blacksmith upgrades), with a lighter model of the rest: units
// target the nearest enemy close to them, shots roll accuracy and fly at their
// real speed, and a miss can still hit someone else. Charge attacks, dodging
// and other specials aren't modelled here, except trample.
//
// Times are game seconds (Normal speed runs 1.7 game seconds per real second).

import { damagePerHit, CLASS } from '../duel/combat.js';
import { MARKET, AGES, structureStats } from './kit.js';

export const DT = 1 / 30;
export const LANE = { length: 86, half: 10 };
// The middle of the map is split by a river into two lanes, as in Castle Fight.
// Units cross only at the ends, near the bases; arrows fly over.
export const RIVER = { x0: 31, x1: 55, half: 2.6 };
const LANE_Y = (RIVER.half + LANE.half) / 2;   // centre line of each lane
export const CASTLE_X = [13, 73];
// Building plots for blue (red mirrors them), in the order the computer fills them.
// One player a team: three columns in front of the castle, one each side of it,
// two columns behind it. Two a team: each gets two rows, top player above the
// castle (top lane), bottom player below it (bottom lane).
const ROWS = [0, -6, 6];
const PLOT_LAYOUT = [
  ...[18.5, 22, 25.5].flatMap((x) => ROWS.map((y) => [x, y])),
  [13, -7], [13, 7],
  ...[8, 4.5].flatMap((x) => ROWS.map((y) => [x, y])),
];
const HALF_LAYOUT = (rows) => [18.5, 22, 25.5, 29, 8, 4.5].flatMap((x) => rows.map((y) => [x, y]));
const TEAM_LAYOUTS = { 1: [PLOT_LAYOUT], 2: [HALF_LAYOUT([-3.6, -7.6]), HALF_LAYOUT([3.6, 7.6])] };
export const PLOTS = PLOT_LAYOUT.length;   // building plots for a player alone on their team
export const TERRITORY = { share: 1 / 3, bonus: 5 };   // +5 gold a tick while you hold the enemy's third
const BIN = 2;                 // tiles: units are bucketed along the lane for "who's near" lookups
const MELEE_SLACK = 0.35;      // tiles: a melee unit this close counts as touching (no running on the spot in a crowd)
const BUILDING_SLACK = 0.45;   // tiles: buildings are big; a unit at their foot can hit them
const STUCK_AFTER = 0.6;       // seconds without getting closer before a unit finds another way
const AGGRO = 6;               // tiles: how far a unit looks for enemies beyond its range
const RETARGET = 0.4;          // seconds between target checks
const CAP = 70;                // most units a side can have on the field
const INCOME_EVERY = 4;        // seconds between income ticks
export const START_GOLD = 250;
export const BASE_INCOME = 10;
const CASTLE_ARROWS = 3;
export const BLAST = { radius: 4, share: 0.6, flat: 25, per: 1 };   // the explosion: once per player
export const OVERTIME = 25 * 60;   // after this, buildings take more damage every minute, so games end
const SELL_BACK = 0.5;
const CRUMBLE = 0.004;          // share of a castle's HP lost per second in overtime
const CASTLE_ACCURACY = 80;
const ARROW_SPEED = 7;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plot centre for a lone player on team 0 or 1 (kept for older callers). */
export function plotPos(team, i) {
  const [x, y] = PLOT_LAYOUT[i];
  return team === 0 ? [x, y] : [LANE.length - x, y];
}

// Math.hypot is slow in hot loops; this is the same for two values.
const hyp = (x, y) => Math.sqrt(x * x + y * y);
const cost = (f) => Object.values(f.cost || {}).reduce((a, b) => a + b, 0);

export class World {
  /**
   * kits: one per player, from buildKit; data: aoe2techtree data (for building stats).
   * opts.teams: each player's team (0 blue, 1 red); default one player a team.
   * opts.income: per-player income multipliers (the computer's difficulty).
   *
   * Players ("sides" below, for history) each have their own gold, buildings,
   * Armory and explosion. Teams share a castle; soldiers fight for their team.
   */
  constructor(kits, data, { seed = 1, income = null, teams = null } = {}) {
    teams ||= kits.map((_, i) => i);
    income ||= kits.map(() => 1);
    this.kits = kits;
    this.rand = mulberry32(seed);
    this.t = 0;
    this.units = [];
    this.structures = [];
    this.shots = [];
    this.events = [];          // { t, type, side, ... } for the UI (kills, builds, castle hits)
    this.winner = null;
    this.nextId = 1;
    this.sbins = [];
    this.incomeAt = INCOME_EVERY;
    this.alive = [0, 0];       // living units per team
    this.territory = [false, false];   // team holding the enemy's third of the map this tick
    this.effects = [];         // explosions, for drawing: { t, x, y, side }
    this.bins = [];            // living units by lane position, rebuilt each step
    this.teams = [0, 1].map((t) => ({ players: teams.map((x, i) => (x === t ? i : -1)).filter((i) => i >= 0), castle: null }));
    this.sides = kits.map((_, s) => ({
      team: teams[s],
      rank: this.teams[teams[s]].players.indexOf(s),   // 0 = top half of the base, 1 = bottom
      gold: START_GOLD,
      incomeMult: income[s],
      researched: new Set(),   // Armory techs done
      researchKey: '|1',
      research: null,          // { id, endsAt, time } being researched
      markets: 0,
      plots: null,
      stats: { trained: 0, kills: 0, lost: 0, earned: 0, spent: 0 },
      blasts: BLAST.per,       // explosions left
      age: 1,                  // 1 Dark, 2 Feudal, 3 Castle, 4 Imperial
      aging: null,             // { to, endsAt, time } while advancing
    }));
    for (const s of this.sides) s.plots = Array(this.layout(s).length).fill(null);
    // Each team's Wonder is the one from a random player's civ on that team.
    for (const t of [0, 1]) {
      const ps = this.teams[t].players;
      this.teams[t].wonderOwner = ps[Math.floor(this.rand() * ps.length)];
      this.castle(t, structureStats(data, 82));
    }
    this.castles = this.teams.map((t) => t.castle);
    this.buildingStats = (id) => structureStats(data, id);
  }

  layout(s) {
    const n = this.teams[s.team].players.length;
    return (TEAM_LAYOUTS[n] || TEAM_LAYOUTS[2])[Math.min(s.rank, 1)];
  }

  /** Where player p's plot i is. */
  plotPos(p, i) {
    const s = this.sides[p];
    const [x, y] = this.layout(s)[i];
    return s.team === 0 ? [x, y] : [LANE.length - x, y];
  }

  plotCount(p) { return this.sides[p].plots.length; }

  castle(team, st) {
    const c = {
      // The team's Wonder: drawn as a Wonder (276), defended like a Castle (its arrows and armour).
      id: this.nextId++, side: team, kind: 'castle', building: 276, x: CASTLE_X[team], y: 0, r: 2.2,
      hp: st.hp, maxHp: st.hp, f: st, ready: 2,
    };
    this.structures.push(c);
    this.teams[team].castle = c;
    for (const p of this.teams[team].players) this.sides[p].castle = c;
    return c;
  }

  /**
   * Gold player p gets each tick. The base income and the territory bonus are
   * shared out between teammates (a 2v2 team earns what one player does in a
   * 1v1); each player's own Markets pay them in full.
   */
  income(side) {
    const s = this.sides[side];
    const share = 1 / this.teams[s.team].players.length;
    const g = ((BASE_INCOME + (this.territory[s.team] ? TERRITORY.bonus : 0)) * share + MARKET.income * s.markets) * s.incomeMult;
    return Math.round(g * 2) / 2;
  }

  // ---------- Spending ----------

  line(side, key) { return this.kits[side].line(key); }
  freePlot(side) { return this.sides[side].plots.indexOf(null); }
  building(id) { return this.structures.find((b) => b.id === id && b.kind === 'building' && b.hp > 0) || null; }
  buildings(side) { return this.structures.filter((b) => b.owner === side && b.kind === 'building' && b.hp > 0); }
  count(side, key) { return this.buildings(side).filter((b) => b.line === key).length; }
  tech(side, id) { return this.kits[side].techs.find((t) => t.id === id) || null; }

  /** Can this side's line be built yet? (Hand Cannoneers need Chemistry.) */
  unlocked(side, line) { return !line.needs || this.sides[side].researched.has(line.needs); }

  /** Is an Armory tech ready to research: not done, not under way, and the one before it done. */
  techOpen(side, t) {
    const s = this.sides[side];
    return t && !s.researched.has(t.id) && s.research?.id !== t.id && (!t.after || s.researched.has(t.after));
  }

  /**
   * What a purchase costs, or null if it can't be bought now.
   * kind: build (key = line, plot = plot index) | market (plot) | upgrade (key = building id) | research (key = tech id)
   */
  price(side, kind, key, plot = null) {
    const s = this.sides[side];
    if (this.winner !== null) return null;
    const plotFree = plot === null ? this.freePlot(side) >= 0 : s.plots[plot] === null;
    switch (kind) {
      case 'build': {
        const line = this.line(side, key);
        return line && plotFree && this.unlocked(side, line) && line.age <= s.age ? this.kits[side].linePrice(line, s.age) : null;
      }
      case 'market':
        return s.markets < MARKET.max && plotFree && s.age >= MARKET.age ? MARKET.cost : null;
      case 'upgrade': {
        const b = this.building(key);
        if (!b || b.owner !== side || b.line === 'market') return null;
        const line = this.line(side, b.line);
        const next = line.tiers[b.tier + 1];
        return next && next.age <= s.age ? next.upgrade : null;
      }
      case 'research': {
        const t = this.tech(side, key);
        return this.techOpen(side, t) && !s.research && t.age <= s.age ? t.cost : null;
      }
      case 'age':
        return s.age < 4 && !s.aging ? AGES[s.age + 1].cost : null;
      default: return null;
    }
  }

  canBuy(side, kind, key, plot = null) {
    const p = this.price(side, kind, key, plot);
    return p !== null && this.sides[side].gold >= p;
  }

  buy(side, kind, key, plot = null) {
    if (!this.canBuy(side, kind, key, plot)) return false;
    const s = this.sides[side];
    const p = this.price(side, kind, key, plot);
    s.gold -= p;
    s.stats.spent += p;
    if (kind === 'build' || kind === 'market') {
      const i = plot ?? this.freePlot(side);
      const [x, y] = this.plotPos(side, i);
      const isMarket = kind === 'market';
      const line = isMarket ? null : this.line(side, key);
      const st = this.buildingStats(isMarket ? MARKET.building : line.building);
      const b = {
        id: this.nextId++, side: s.team, owner: side, kind: 'building', building: isMarket ? MARKET.building : line.building,
        line: isMarket ? 'market' : key, plot: i, x, y, r: 1.5, hp: st.hp, maxHp: st.hp, f: st,
        tier: 0, invested: p, hold: false, waiting: false,
        timer: isMarket ? 0 : Math.min(8, line.tiers[0].every * 0.4), every: isMarket ? 0 : line.tiers[0].every, builtAt: this.t,
      };
      s.plots[i] = b.id;
      if (isMarket) s.markets += 1;
      this.structures.push(b);
    } else if (kind === 'upgrade') {
      // Only this building: its next units are the new type. Units already out stay as they are.
      const b = this.building(key);
      b.tier += 1;
      b.invested += p;
      b.upgradedAt = this.t;
      b.every = this.line(side, b.line).tiers[b.tier].every;
    } else if (kind === 'research') {
      const t = this.tech(side, key);
      s.research = { id: t.id, endsAt: this.t + t.time, time: t.time };
    } else if (kind === 'age') {
      const a = AGES[s.age + 1];
      s.aging = { to: s.age + 1, endsAt: this.t + a.time, time: a.time };
    }
    this.events.push({ t: this.t, type: kind, side, key });
    return true;
  }

  /**
   * The explosion (once per player, like Castle Fight's comeback ability): hurts
   * every enemy soldier within BLAST.radius of (x, y) for 60% of its full HP + 25.
   */
  /** Where team `team` may drop its explosion: its own third of the map (to defend, not to push). */
  blastZone(team) {
    const edge = LANE.length * TERRITORY.share;
    return team === 0 ? [0, edge] : [LANE.length - edge, LANE.length];
  }

  canBlastAt(team, x) { const [a, b] = this.blastZone(team); return x >= a && x <= b; }

  blast(side, x, y) {
    const s = this.sides[side];
    if (s.blasts <= 0 || this.winner !== null || !this.canBlastAt(s.team, x)) return 0;
    s.blasts -= 1;
    let hit = 0;
    for (const v of this.units) {
      if (v.side === s.team || v.hp <= 0) continue;
      if (hyp(v.x - x, v.y - y) - v.r > BLAST.radius) continue;
      this.damage(s.team, v, v.f.hp * BLAST.share + BLAST.flat, { side: s.team, owner: side });
      hit += 1;
    }
    this.effects.push({ t: this.t, x, y, side: s.team, owner: side, hit });
    this.events.push({ t: this.t, type: 'blast', side: s.team, owner: side, x, y, hit });
    return hit;
  }

  /** Best spot for an explosion against team `team`'s enemies: [x, y, how many it would hit]. */
  blastSpot(team) {
    let best = null;
    const foes = this.units.filter((v) => v.side !== team && v.hp > 0);
    for (const a of foes) {
      if (!this.canBlastAt(team, a.x)) continue;
      let n = 0;
      for (const v of foes) if (hyp(v.x - a.x, v.y - a.y) <= BLAST.radius) n += 1;
      if (!best || n > best[2]) best = [a.x, a.y, n];
    }
    return best;
  }

  /** Knock down your own building for half of what you put into it (frees the plot). */
  sell(side, id) {
    const b = this.building(id);
    if (!b || b.owner !== side || this.winner !== null) return false;
    const s = this.sides[side];
    const back = Math.round(b.invested * SELL_BACK);
    s.gold += back;
    s.plots[b.plot] = null;
    if (b.line === 'market') s.markets -= 1;
    b.hp = 0; b.diedAt = this.t; b.sold = true;
    this.events.push({ t: this.t, type: 'sell', side, key: b.line, gold: back });
    return true;
  }

  sellValue(id) { const b = this.building(id); return b ? Math.round(b.invested * SELL_BACK) : 0; }

  /** Tap a building: hold its next unit (it waits when ready), or stop holding. */
  toggleHold(side, id) {
    const b = this.building(id);
    if (!b || b.owner !== side || b.line === 'market') return false;
    b.hold = !b.hold;
    if (!b.hold && b.waiting) this.releaseUnit(b);
    return true;
  }

  /** GO: every held building lets its unit out now if it's ready, and stops holding. */
  go(side) {
    let n = 0;
    for (const b of this.buildings(side)) {
      if (!b.hold) continue;
      b.hold = false;
      if (b.waiting) { this.releaseUnit(b); n += 1; }
    }
    this.events.push({ t: this.t, type: 'go', side, n });
    return n;
  }

  held(side) { return this.buildings(side).filter((b) => b.hold); }

  releaseUnit(b) {
    b.waiting = false;
    b.timer = b.every;
    this.spawn(b.owner, b);
  }

  /** Researched techs reach units already on the field, as in the game. */
  refit(side) {
    const s = this.sides[side];
    s.researchKey = `${[...s.researched].sort().join(',')}|${s.age}`;
    for (const u of this.units) {
      if (u.owner !== side || u.hp <= 0) continue;
      const f = this.kits[side].fighter(u.line, u.tier, s.researched, s.researchKey, s.age);
      u.hp += Math.max(0, f.hp - u.f.hp);
      u.f = f;
    }
  }

  // ---------- Simulation ----------

  spawn(side, b) {
    const s = this.sides[side];
    const team = s.team;
    // The unit cap is per team, shared fairly between its players.
    if (this.alive[team] >= CAP || (s.out ?? 0) >= Math.ceil(CAP / this.teams[team].players.length)) return;
    this.alive[team] += 1;
    s.out = (s.out ?? 0) + 1;
    const tier = b.tier;
    const f = this.kits[side].fighter(b.line, tier, s.researched, s.researchKey, s.age);
    const dir = team === 0 ? 1 : -1;
    // Which lane: by the building's row; the middle row takes turns.
    b.nextLane = -(b.nextLane || 1);
    const lane = b.y < -1 ? -1 : b.y > 1 ? 1 : b.nextLane;
    const u = {
      id: this.nextId++, side: team, owner: side, line: b.line, tier, f, r: f.radius, lane,
      x: b.x + dir * (b.r + f.radius + 0.3), y: b.y + (this.rand() - 0.5) * 0.6,
      px: 0, py: 0, hp: f.hp, target: null, retarget: 0, ready: 0, pending: null,
      attackStart: null, diedAt: null, face: dir, moving: false, bornAt: this.t, stuck: 0, lastGap: null, sidestep: 0,
    };
    u.px = u.x; u.py = u.y;
    if (f.packs) { u.packed = true; u.packing = null; }   // trebuchets come out packed
    s.stats.trained += 1;
    this.units.push(u);
  }

  enemyCastle(team) { return this.teams[1 - team].castle; }

  /** Calls fn(v) for living units whose lane position is within r of x (a quick pre-filter). */
  near(x, r, fn) {
    const b0 = Math.max(0, Math.floor((x - r) / BIN));
    const b1 = Math.min(this.bins.length - 1, Math.floor((x + r) / BIN));
    for (let b = b0; b <= b1; b++) {
      const list = this.bins[b];
      if (list) for (let i = 0; i < list.length; i++) fn(list[i]);
    }
  }

  /** Does the river stand between two points? (Only its long middle stretch blocks.) */
  acrossRiver(ax, ay, bx, by) {
    if ((ay > -RIVER.half && ay < RIVER.half) || (by > -RIVER.half && by < RIVER.half)) {
      // one end on the bank line: blocked if both ends are beside the river and on different sides of it
      if (Math.sign(ay) === Math.sign(by)) return false;
    }
    if (ay * by >= 0) return false;
    const k = ay / (ay - by);
    const xm = ax + (bx - ax) * k;
    return xm > RIVER.x0 && xm < RIVER.x1;
  }

  /** Melee units can't go after enemies across the river; ranged ones only if they can shoot from here. */
  canReach(u, v, gap) {
    if (!this.acrossRiver(u.x, u.y, v.x, v.y)) return true;
    return Boolean(u.f.projectile) && gap <= u.f.range;
  }

  /** Nearest enemy (soldier or building) it can already hit without moving, or null. */
  inReach(u, reach) {
    let best = null;
    let bd = Infinity;
    if (!u.f.buildingsOnly) this.near(u.x, reach + 1, (v) => {
      if (v.side === u.side || v.hp <= 0) return;
      const d = hyp(v.x - u.x, v.y - u.y) - v.r - u.r;
      if (d <= reach && d < bd && this.canReach(u, v, d)) { bd = d; best = v; }
    });
    for (const b of this.sbins[Math.max(0, Math.floor(u.x / BIN))] || []) {
      if (b.side === u.side || b.hp <= 0) continue;
      const d = hyp(b.x - u.x, b.y - u.y) - b.r - u.r;
      if (d <= reach && d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /** Nearest enemy soldier in reach, else the nearest enemy building in reach. `skip`: a target to avoid. */
  pickTarget(u, skip = null) {
    let best = null;
    let bd = Infinity;
    const reach = u.f.range + AGGRO;
    // Rams and trebuchets ignore soldiers and go for buildings.
    if (!u.f.buildingsOnly) this.near(u.x, reach + 1, (v) => {
      if (v.side === u.side || v.hp <= 0 || v === skip) return;
      const d = hyp(v.x - u.x, v.y - u.y) - v.r - u.r;
      if (d < bd && d <= reach && this.canReach(u, v, d)) { bd = d; best = v; }
    });
    if (best) return best;
    // No enemy soldiers near: the nearest enemy building in reach, else keep marching.
    for (const b of this.structures) {
      if (b.side === u.side || b.hp <= 0 || b === skip) continue;
      const d = hyp(b.x - u.x, b.y - u.y) - b.r - u.r;
      if (d < bd && d <= reach) { bd = d; best = b; }
    }
    return best;
  }

  attackOn(u, target, extra = 1) {
    if (target.hp <= 0) return;
    const d = damagePerHit(u.f, target.f) * extra;
    this.damage(u.side, target, d, u);
  }

  /** Damage multiplier on buildings in overtime: +20% for each minute past it. */
  overtime() { return this.t > OVERTIME ? 1 + 0.2 * Math.ceil((this.t - OVERTIME) / 60) : 1; }

  damage(side, target, amount, by) {
    if (target.hp <= 0) return;
    if (target.kind) amount *= this.overtime();
    target.hp -= amount;
    if (target.hp > 0) return;
    target.diedAt = this.t;
    if (!target.kind) { this.alive[target.side] -= 1; this.sides[target.owner].out -= 1; }
    // Bounties go to the player whose soldier (or explosion) did it; castle arrows pay the team's first player.
    const s = this.sides[by?.owner ?? this.teams[side].players[0]];
    const o = this.sides[target.owner ?? this.teams[target.side].players[0]];
    if (target.kind === 'castle') {
      this.winner = side;
      this.events.push({ t: this.t, type: 'castle', side });
    } else if (target.kind === 'building') {
      o.plots[target.plot] = null;
      if (target.line === 'market') o.markets -= 1;
      const bounty = 50;
      s.gold += bounty; s.stats.earned += bounty;
      this.events.push({ t: this.t, type: 'razed', side, owner: by?.owner, key: target.line, x: target.x, y: target.y, bounty });
    } else {
      s.stats.kills += 1;
      o.stats.lost += 1;
      const bounty = Math.max(2, Math.round(cost(target.f) * 0.1));
      s.gold += bounty; s.stats.earned += bounty;
      if (by) this.events.push({ t: this.t, type: 'kill', side, owner: by.owner, x: target.x, y: target.y, bounty });
    }
  }

  launch(u, target, attacks, { accuracy, speed, spread = 0.3 }, isCastle = false) {
    const dist = Math.max(0.1, hyp(target.x - u.x, target.y - u.y));
    const hit = this.rand() * 100 < accuracy;
    let x1 = target.x, y1 = target.y;
    if (!hit) {
      const d = Math.max(0.5, spread * dist / 2);
      x1 += (this.rand() * 2 - 1) * d;
      y1 += (this.rand() * 2 - 1) * d;
    }
    this.shots.push({
      side: u.side, by: u, target, attacks, hit, castle: isCastle,
      x0: u.x, y0: u.y, x1, y1, t0: this.t, t1: this.t + hyp(x1 - u.x, y1 - u.y) / speed,
      sprite: u.f?.projectile?.sprite, arc: u.f?.projectile?.arc ?? 0,
    });
  }

  landShot(s) {
    const f = s.castle ? s.by.f : s.by.f;
    const dmgTo = (v) => damagePerHit({ ...f, attacks: s.attacks, special: f.special || {} }, v.f);
    const p = f.projectile || {};
    // Extra stones with no attack of their own (a mangonel's scatter) are just for show.
    if (s.attacks && (s.attacks.length === 0 || s.attacks.size === 0)) { s.landed = null; return; }
    // Catapult stones and cannon balls: everyone in the blast. (Enemies only, to keep the lane readable.)
    if (p.blast > 0 && !s.castle) {
      let any = null;
      this.near(s.x1, p.blast + 1, (v) => {
        if (v.side === s.side || v.hp <= 0) return;
        if (hyp(v.x - s.x1, v.y - s.y1) > p.blast + v.r) return;
        this.damage(s.side, v, dmgTo(v), s.by);
        any = any || v;
      });
      if (s.target.kind && s.target.hp > 0 && hyp(s.target.x - s.x1, s.target.y - s.y1) <= s.target.r + p.blast) { this.damage(s.side, s.target, dmgTo(s.target), s.by); any = any || s.target; }
      s.landed = any;
      return;
    }
    // Scorpion bolts go through: every enemy along the line takes the hit.
    if (p.pierces && !s.castle) {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = hyp(dx, dy) || 1;
      const ex = s.x1 + (dx / len) * 2, ey = s.y1 + (dy / len) * 2;
      const lx = Math.min(s.x0, ex), hx = Math.max(s.x0, ex);
      this.near((lx + hx) / 2, (hx - lx) / 2 + 1, (v) => {
        if (v.side === s.side || v.hp <= 0) return;
        const t = Math.max(0, Math.min(1, ((v.x - s.x0) * (ex - s.x0) + (v.y - s.y0) * (ey - s.y0)) / ((ex - s.x0) ** 2 + (ey - s.y0) ** 2 || 1)));
        if (hyp(v.x - (s.x0 + (ex - s.x0) * t), v.y - (s.y0 + (ey - s.y0) * t)) <= v.r + 0.15) this.damage(s.side, v, dmgTo(v), s.by);
      });
      if (s.target.kind && s.target.hp > 0) this.damage(s.side, s.target, dmgTo(s.target), s.by);
      s.landed = s.target;
      return;
    }
    if (s.hit && s.target.hp > 0) { this.damage(s.side, s.target, dmgTo(s.target), s.by); s.landed = s.target; return; }
    // A miss can still come down on someone: half damage.
    let hitV = null;
    this.near(s.x1, 1, (v) => {
      if (hitV || v.side === s.side || v.hp <= 0) return;
      if (Math.abs(v.x - s.x1) <= v.r + 0.1 && Math.abs(v.y - s.y1) <= v.r + 0.1) hitV = v;
    });
    if (hitV) { this.damage(s.side, hitV, dmgTo(hitV) / 2, s.by); s.landed = hitV; }
  }

  step() {
    if (this.winner !== null) return;
    const t = (this.t += DT);
    // Overtime: both castles crumble, so even a deadlocked game ends.
    if (t > OVERTIME) {
      for (const team of [0, 1]) {
        const c = this.teams[team].castle;
        if (c.hp > 0) this.damage(1 - team, c, (c.maxHp * CRUMBLE * DT) / this.overtime(), null);
        if (this.winner !== null) return;
      }
    }
    // Income
    if (t >= this.incomeAt) {
      this.incomeAt += INCOME_EVERY;
      // Territory: a team with soldiers in the enemy's third of the map earns extra (like Direct Strike).
      for (const team of [0, 1]) {
        const line = team === 0 ? LANE.length * (1 - TERRITORY.share) : LANE.length * TERRITORY.share;
        this.territory[team] = this.units.some((u) => u.side === team && u.hp > 0 && (team === 0 ? u.x > line : u.x < line));
      }
      this.sides.forEach((s, i) => { const g = this.income(i); s.gold += g; s.stats.earned += g; });
    }
    // Armory research and ages finishing
    for (let side = 0; side < this.sides.length; side++) {
      const s = this.sides[side];
      if (s.aging && t >= s.aging.endsAt) {
        s.age = s.aging.to;
        s.aging = null;
        this.events.push({ t, type: 'aged', side: s.team, owner: side, age: s.age });
        this.refit(side);
      }
      if (s.research && t >= s.research.endsAt) {
        s.researched.add(s.research.id);
        this.events.push({ t, type: 'researched', side, key: s.research.id });
        s.research = null;
        this.refit(side);
      }
    }
    // Buildings train their units; held ones wait when ready until GO (or tapped again).
    for (const b of this.structures) {
      if (b.kind !== 'building' || b.hp <= 0 || b.line === 'market' || b.waiting) continue;
      b.timer -= DT;
      if (b.timer <= 0) {
        if (b.hold) { b.timer = 0; b.waiting = true; } else this.releaseUnit(b);
      }
    }
    // Castles shoot the nearest enemy in range
    for (const c of this.structures) {
      if (c.kind !== 'castle' || c.hp <= 0 || t < c.ready) continue;
      let best = null, bd = Infinity;
      this.near(c.x, c.f.range + c.r + 1, (v) => {
        if (v.side === c.side || v.hp <= 0) return;
        const d = hyp(v.x - c.x, v.y - c.y) - c.r;
        if (d <= c.f.range && d < bd) { bd = d; best = v; }
      });
      if (!best) continue;
      c.ready = t + c.f.reload;
      for (let k = 0; k < CASTLE_ARROWS; k++) this.launch(c, best, c.f.attacks, { accuracy: CASTLE_ACCURACY, speed: ARROW_SPEED, spread: 0.4 }, true);
    }
    // Units
    const live = this.units.filter((u) => u.hp > 0);
    this.bins = [];
    this.sbins = [];
    for (const b of this.structures) {
      if (b.hp <= 0) continue;
      for (let k = Math.floor((b.x - b.r - 2) / BIN); k <= Math.floor((b.x + b.r + 2) / BIN); k++) (this.sbins[Math.max(0, k)] ||= []).push(b);
    }
    for (const u of live) {
      const b = Math.max(0, Math.floor(u.x / BIN));
      (this.bins[b] ||= []).push(u);
      u.px = u.x; u.py = u.y; u.wantsMove = false;
    }
    for (const u of live) {
      if ((u.retarget -= DT) <= 0 || !u.target || u.target.hp <= 0) {
        u.retarget = RETARGET * (0.8 + this.rand() * 0.4);
        u.target = this.pickTarget(u);
        u.lastGap = null;
      }
      if (u.pending) {
        if (t >= u.pending.at) {
          const tg = u.pending.target;
          u.pending = null;
          if (tg.hp > 0) this.release(u, tg);
        }
        continue;
      }
      // Trebuchets: unpack to fire, pack to move; neither can do anything while (un)packing.
      if (u.f.packs) {
        if (u.packing) {
          if (t < u.packUntil) continue;
          u.packed = u.packing === 'pack';
          u.packing = null;
        }
        const g = u.target ? hyp(u.target.x - u.x, u.target.y - u.y) - u.target.r - u.r : Infinity;
        const inRange = g <= u.f.range + 0.1 + (u.target?.kind ? BUILDING_SLACK : 0) && g >= (u.f.minRange || 0);
        if (inRange === u.packed) {
          u.packing = inRange ? 'unpack' : 'pack';
          u.packStart = t;
          u.packUntil = t + u.f.packs;
          if (inRange) u.face = Math.sign(u.target.x - u.x) || u.face;
          continue;
        }
      }
      const tg = u.target;
      const dir = u.side === 0 ? 1 : -1;
      if (!tg) {
        // March down your lane towards the enemy castle; past the river, head for the castle.
        const c = this.enemyCastle(u.side);
        const past = dir > 0 ? u.x > RIVER.x1 + 1 : u.x < RIVER.x0 - 1;
        const before = dir > 0 ? u.x < RIVER.x0 - 6 : u.x > RIVER.x1 + 6;
        // Beside the river, its lane is whichever bank it's on (it may have chased someone across).
        if (u.x > RIVER.x0 - 1 && u.x < RIVER.x1 + 1) u.lane = Math.sign(u.y) || u.lane;
        const aimY = past ? c.y : u.lane * LANE_Y;
        const dx = c.x - u.x, dy = (aimY - u.y) * (before ? 0.12 : 0.35);
        const len = hyp(dx, dy) || 1;
        this.move(u, dx / len, dy / len);
        u.face = dir;
        continue;
      }
      const gap = hyp(tg.x - u.x, tg.y - u.y) - tg.r - u.r;
      const ranged = Boolean(u.f.projectile);
      const minR = ranged ? u.f.minRange || 0 : 0;
      // Melee units count as touching a little before their edges meet, so they
      // swing instead of shuffling on the spot when the crowd nudges them.
      const reach = u.f.range + (ranged ? 0.1 : MELEE_SLACK) + (tg.kind ? BUILDING_SLACK : 0);
      if (gap > reach) {
        // Blocked (by friends in the way): try another target, or step aside.
        if (u.lastGap !== null && u.lastGap - gap < u.f.speed * DT * 0.25) u.stuck += DT; else u.stuck = Math.max(0, u.stuck - DT);
        u.lastGap = gap;
        if (u.stuck > STUCK_AFTER) {
          u.stuck = 0;
          // First choice: anything it can hit from here (often the building it's pressed against).
          // (It sticks with the new choice for a while instead of switching straight back.)
          const here = this.inReach(u, u.f.range + (ranged ? 0 : MELEE_SLACK + BUILDING_SLACK) + 0.3);
          if (here) { u.target = here; u.lastGap = null; u.retarget = 1.5; continue; }
          const alt = this.pickTarget(u, tg);
          if (alt && alt !== tg) { u.target = alt; u.lastGap = null; u.retarget = 1.5; continue; }
          u.sidestep = 0.6;   // nobody else in reach: walk round the crowd for a moment
          u.retarget = Math.max(u.retarget, 0.8);
        }
        const len = hyp(tg.x - u.x, tg.y - u.y) || 1;
        let dx = (tg.x - u.x) / len, dy = (tg.y - u.y) / len;
        if (u.sidestep > 0) {
          u.sidestep -= DT;
          const k = (u.id % 2 ? 1 : -1) * (u.y > LANE.half - 1.5 ? -1 : u.y < -LANE.half + 1.5 ? 1 : 1);
          const sx = dx - dy * 1.2 * k, sy = dy + dx * 1.2 * k, sl = hyp(sx, sy) || 1;
          dx = sx / sl; dy = sy / sl;
        }
        this.move(u, dx, dy, gap - reach + 0.05);
      } else if (minR > 0 && gap < minR && tg.kind === undefined) {
        const len = hyp(tg.x - u.x, tg.y - u.y) || 1;
        this.move(u, -(tg.x - u.x) / len, -(tg.y - u.y) / len);
      } else {
        u.stuck = 0;
        u.lastGap = null;
        u.face = Math.sign(tg.x - u.x) || u.face;
        if (t >= u.ready) {
          u.pending = { at: t + (u.f.attackDelay || 0), target: tg };
          u.ready = t + u.f.reload;
          u.attackStart = t;
        }
      }
    }
    // Keep units apart (a unit standing its ground gives way less than one
    // walking past), out of buildings, and on the lane.
    for (const u of live) {
      if (u.hp <= 0) continue;
      this.near(u.x, u.r + 0.7, (v) => {
        if (v.id <= u.id || v.hp <= 0) return;
        const dx = v.x - u.x, dy = v.y - u.y;
        const need = u.r + v.r;
        if (Math.abs(dx) >= need || Math.abs(dy) >= need) return;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= need) return;
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : (u.id % 2 ? 1 : -1);
        const push = need - d;
        const wu = u.wantsMove ? (v.wantsMove ? 0.5 : 0.85) : (v.wantsMove ? 0.15 : 0.5);
        u.x -= nx * push * wu; u.y -= ny * push * wu;
        v.x += nx * push * (1 - wu); v.y += ny * push * (1 - wu);
      });
    }
    for (const u of live) {
      for (const b of this.sbins[Math.max(0, Math.floor(u.x / BIN))] || []) {
        if (b.hp <= 0) continue;
        const dx = u.x - b.x, dy = u.y - b.y;
        const d = hyp(dx, dy), need = b.r + u.r;
        if (d < need) { const k = d > 1e-6 ? need / d : 1; u.x = b.x + dx * k; u.y = b.y + (d > 1e-6 ? dy * k : need); }
      }
      u.y = Math.max(-LANE.half, Math.min(LANE.half, u.y));
      u.x = Math.max(0.5, Math.min(LANE.length - 0.5, u.x));
      // Out of the river, back onto the bank it came from
      if (u.x > RIVER.x0 - u.r && u.x < RIVER.x1 + u.r && Math.abs(u.y) < RIVER.half + u.r) {
        const bank = Math.sign(u.py || u.y || u.lane) || 1;
        u.y = bank * (RIVER.half + u.r);
      }
      // Only shown walking if it actually got somewhere (no running on the spot).
      // (and kept for a moment after, so a nudge in a crowd doesn't flicker idle/walk).
      if (u.wantsMove && hyp(u.x - u.px, u.y - u.py) > u.f.speed * DT * 0.3) u.movedAt = t;
      u.moving = u.wantsMove && t - (u.movedAt ?? -1) < 0.25;
    }
    // Shots land
    for (let k = this.shots.length - 1; k >= 0; k--) {
      const s = this.shots[k];
      if (t >= s.t1 && !s.done) { s.done = true; this.landShot(s); }
      if (t > s.t1 + 0.6) this.shots.splice(k, 1);
    }
    // Clear old bodies and rubble
    if (Math.round(t / DT) % 30 === 0) {
      this.units = this.units.filter((u) => u.hp > 0 || t - u.diedAt < 4);
      this.structures = this.structures.filter((b) => b.hp > 0 || b.kind === 'castle' || t - b.diedAt < 3);
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
      this.effects = this.effects.filter((e) => t - e.t < 8);
    }
  }

  /** Walk one step, steering round friends and buildings in the way. */
  move(u, dx, dy, maxStep = Infinity) {
    let side = 0;
    this.near(u.x, 1.3, (v) => {
      if (v === u || v.side !== u.side || v.hp <= 0) return;
      const ox = v.x - u.x, oy = v.y - u.y;
      if (Math.abs(oy) > 1.3) return;
      const od = hyp(ox, oy) || 1;
      const ahead = (ox * dx + oy * dy) / od;
      if (ahead < 0.55 || od > u.r + v.r + 0.45) return;
      side += ((dx * oy - dy * ox) >= 0 ? -1 : 1) * ahead * (1 - od / (u.r + v.r + 0.45));
    });
    // Buildings (the castle especially) are walked round, not pushed against.
    for (const b of this.sbins[Math.max(0, Math.floor(u.x / BIN))] || []) {
      if (b.hp <= 0) continue;
      const ox = b.x - u.x, oy = b.y - u.y;
      if (Math.abs(oy) > b.r + u.r + 1.2) continue;
      const od = hyp(ox, oy) || 1;
      if (od > b.r + u.r + 1.2) continue;
      const ahead = (ox * dx + oy * dy) / od;
      if (ahead < 0.3) continue;
      side += ((dx * oy - dy * ox) >= 0 ? -1.5 : 1.5) * ahead;
    }
    if (side) {
      const k = Math.max(-1, Math.min(1, side)) * 0.9;
      const nx = dx - dy * k, ny = dy + dx * k, nl = hyp(nx, ny) || 1;
      dx = nx / nl; dy = ny / nl;
    }
    const len = Math.min(u.f.speed * DT, Math.max(0, maxStep));
    u.x += dx * len; u.y += dy * len;
    u.wantsMove = true;
    // Turn round only on a clear change of direction, not every sidestep.
    if (Math.abs(dx) > 0.35 && Math.sign(dx) !== u.face && this.t - (u.turnedAt ?? -1) > 0.4) { u.face = Math.sign(dx); u.turnedAt = this.t; }
  }

  release(u, tg) {
    const p = u.f.projectile;
    if (!p) {
      if (hyp(tg.x - u.x, tg.y - u.y) - tg.r - u.r > u.f.range + MELEE_SLACK + BUILDING_SLACK + 0.5) return;
      this.attackOn(u, tg);
      // Trample: enemies around the target take some of the blow.
      const bl = u.f.special?.blast;
      if (bl) {
        this.near(tg.x, bl.width + 1, (v) => {
          if (v === tg || v.side === u.side || v.hp <= 0) return;
          if (hyp(v.x - tg.x, v.y - tg.y) - v.r > bl.width) return;
          const amt = bl.damage < 0 ? -bl.damage : bl.damage * damagePerHit(u.f, v.f);
          this.damage(u.side, v, amt, u);
        });
      }
      return;
    }
    for (let k = 0; k < (p.count || 1); k++) {
      const attacks = k > 0 && p.secondary ? p.secondary.attacks : u.f.attacks;
      this.launch(u, tg, attacks, { accuracy: tg.kind ? 100 : p.accuracy, speed: p.speed, spread: p.spread || 0.3 });
    }
  }

  /** Units of a side by what kind they are, for the computer's choices. */
  mix(side) {
    const m = { infantry: 0, archer: 0, cavalry: 0, spear: 0, skirm: 0 };
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0) continue;
      m[kindOf(u.line, u.f)] += 1;
    }
    for (const b of this.structures) {
      if (b.side !== side || b.kind !== 'building' || b.hp <= 0 || b.line === 'market') continue;
      m[kindOf(b.line, this.kits[b.owner].fighter(b.line, b.tier))] += 2;
    }
    return m;
  }
}

/** Rough role of a unit line: what counters what. */
export function kindOf(line, f) {
  const root = Number(String(line).split('-')[1]);
  if (root === 93) return 'spear';     // Spearman line
  if (root === 7) return 'skirm';      // Skirmisher line
  if (f.buildingsOnly) return 'ram';   // rams, trebuchets
  if (f.armours.has(CLASS.SIEGE)) return 'siege';
  if (f.armours.has(CLASS.CAVALRY) || f.armours.has(CLASS.ELEPHANT) || f.armours.has(CLASS.CAMEL)) return 'cavalry';
  if (f.projectile) return 'archer';
  return 'infantry';
}

// ---------- The computer player ----------

// What each kind beats (higher = better against it).
const BEATS = {
  infantry: { spear: 2, skirm: 2, archer: 0.5, infantry: 1, cavalry: 0.3 },
  spear: { cavalry: 3, infantry: 0.4, archer: 0.3, spear: 1, skirm: 1.5 },
  archer: { infantry: 1.5, spear: 2, archer: 1, cavalry: 0.3, skirm: 0.2 },
  skirm: { archer: 3, spear: 1, skirm: 1, infantry: 0.2, cavalry: 0.2 },
  cavalry: { archer: 2.5, skirm: 2.5, infantry: 1, cavalry: 1, spear: 0.2, siege: 3 },
  siege: { infantry: 2, archer: 2, spear: 2, skirm: 2, cavalry: 0.4, siege: 1 },
  ram: { infantry: 0.2, archer: 0.4, spear: 0.4, skirm: 0.4, cavalry: 0.2, siege: 0.3 },
};
// How good a kind of unit is on its own, before counters (spearmen and skirmishers are cheap specialists).
const BASE = { cavalry: 1.1, infantry: 1.1, archer: 1, spear: 0.8, skirm: 0.7, siege: 0.8, ram: 0.6 };

export class Computer {
  constructor(world, side, { level = 'normal' } = {}) {
    this.w = world;
    this.side = side;
    this.level = level;
    this.next = 1;
  }

  think() {
    const w = this.w;
    if (w.t < this.next || w.winner !== null) return;
    this.next = w.t + (this.level === 'easy' ? 4 : 2.5);
    const side = this.side;
    const s = w.sides[side];
    const team = s.team;
    // The explosion: on a big enough clump, or when the castle is in danger.
    if (s.blasts > 0) {
      const spot = w.blastSpot(team);
      const castle = w.teams[team].castle;
      const nearCastle = w.units.filter((v) => v.side !== team && v.hp > 0 && Math.abs(v.x - castle.x) < 16).length;
      const need = this.level === 'easy' ? 22 : this.level === 'hard' ? 11 : 15;
      if (spot && (spot[2] >= need || (nearCastle >= 10 && spot[2] >= 6))) { w.blast(side, spot[0], spot[1]); return; }
    }
    const foe = w.mix(1 - team);
    const foeTotal = 1 + Object.values(foe).reduce((a, b) => a + b, 0);
    const kit = w.kits[side];
    const builds = w.buildings(side);
    const military = builds.filter((b) => b.line !== 'market');
    const vs = (kind) => Object.entries(foe).reduce((acc, [k, n]) => acc + (BEATS[kind][k] ?? 1) * n, 0) / foeTotal;
    const options = [];
    const free = w.freePlot(side) >= 0;
    for (const line of kit.lines) {
      if (!w.unlocked(side, line)) continue;
      const kind = kindOf(line.key, kit.fighter(line.key, 0));
      const have = w.count(side, line.key);
      // More buildings means more units: fill plots early, then upgrade.
      const early = free && military.length < 6 ? 0.8 : 0;
      if (w.price(side, 'build', line.key) !== null) {
        options.push({ kind: 'build', key: line.key, score: (BASE[kind] ?? 1) + (line.unique ? 0.2 : 0) + early + 0.7 * vs(kind) - have * 0.25 });
      }
    }
    // Upgrade the lowest-tier building of a useful line.
    for (const b of military) {
      const p = w.price(side, 'upgrade', b.id);
      if (p === null) continue;
      const kind = kindOf(b.line, kit.fighter(b.line, b.tier));
      options.push({ kind: 'upgrade', key: b.id, score: 1 + 0.5 * vs(kind) - b.tier * 0.25 + (w.t > 180 ? 0.5 : 0) - p / 1500 });
    }
    // Ages: when the army is growing and the gold is there (Easy waits longer).
    const nextAge = w.price(side, 'age');
    if (nextAge !== null && military.length >= s.age + (this.level === 'easy' ? 2 : this.level === 'hard' ? 0 : 1)) {
      options.push({ kind: 'age', key: null, score: 4 + military.length * 0.1 - s.age * 0.3 });
    }
    // Armory: once there's an army to make better
    if (military.length >= 3 && !s.research) {
      for (const t of kit.techs) {
        if (w.price(side, 'research', t.id) === null) continue;
        options.push({ kind: 'research', key: t.id, score: 0.7 + military.length * 0.08 + (t.group === 'Blacksmith' ? 0.3 : 0) - t.cost / 1200 });
      }
    }
    if (military.length >= 1 && w.price(side, 'market') !== null && w.t < 600) options.push({ kind: 'market', score: 2.2 - s.markets * 0.5 });
    // Plots full and gold piling up: replace the building that does least against the enemy.
    if (!free && s.gold > 600 && this.level !== 'easy' && military.length) {
      const rate = (key, tier) => vs(kindOf(key, kit.fighter(key, tier)));
      const worst = [...military].sort((a, b) => rate(a.line, a.tier) - rate(b.line, b.tier))[0];
      const best = kit.lines.filter((l) => w.unlocked(side, l)).sort((a, b) => rate(b.key, 0) - rate(a.key, 0))[0];
      if (worst && best && worst.tier === 0 && rate(best.key, 0) > rate(worst.line, worst.tier) * 1.3) { w.sell(side, worst.id); return; }
    }
    if (!options.length) return;
    // Easy plays at random; Normal and Hard pick well, with a little variety.
    const noise = this.level === 'easy' ? 3 : this.level === 'hard' ? 0.25 : 0.6;
    for (const o of options) o.score += w.rand() * noise;
    options.sort((a, b) => b.score - a.score);
    const pick = options[0];
    // Save up for the best choice rather than spending on whatever is cheap.
    if (w.canBuy(side, pick.kind, pick.key)) w.buy(side, pick.kind, pick.key);
  }
}
