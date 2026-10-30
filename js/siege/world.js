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
import { MARKET, SMITH_COSTS, structureStats } from './kit.js';

export const DT = 1 / 30;
export const LANE = { length: 70, half: 7.5 };
export const CASTLE_X = [4, 66];
const PLOT_X = [8.5, 12, 15.5, 19];
const PLOT_Y = [-4.6, 0, 4.6];
export const PLOTS = PLOT_X.length * PLOT_Y.length;   // building plots per side
const AGGRO = 6;               // tiles: how far a unit looks for enemies beyond its range
const RETARGET = 0.4;          // seconds between target checks
const CAP = 70;                // most units a side can have on the field
const INCOME_EVERY = 4;        // seconds between income ticks
export const START_GOLD = 250;
export const BASE_INCOME = 10;
const CASTLE_ARROWS = 3;
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

/** Plot centre for side 0 or 1, plots numbered from the middle of the front column back. */
export function plotPos(side, i) {
  const order = [];
  for (let c = PLOT_X.length - 1; c >= 0; c--) for (const r of [1, 0, 2]) order.push([PLOT_X[c], PLOT_Y[r]]);
  const [x, y] = order[i];
  return side === 0 ? [x, y] : [LANE.length - x, y];
}

const cost = (f) => Object.values(f.cost || {}).reduce((a, b) => a + b, 0);

export class World {
  /**
   * kits: [blue kit, red kit] from buildKit; data: aoe2techtree data (for building stats).
   * opts.income: per-side income multipliers (the computer's difficulty).
   */
  constructor(kits, data, { seed = 1, income = [1, 1] } = {}) {
    this.kits = kits;
    this.rand = mulberry32(seed);
    this.t = 0;
    this.units = [];
    this.structures = [];
    this.shots = [];
    this.events = [];          // { t, type, side, ... } for the UI (kills, builds, castle hits)
    this.winner = null;
    this.nextId = 1;
    this.incomeAt = INCOME_EVERY;
    this.sides = [0, 1].map((s) => ({
      gold: START_GOLD,
      incomeMult: income[s],
      tiers: {},              // line key -> tier 0..2
      smith: { attack: 0, armour: 0 },
      markets: 0,
      plots: Array(PLOTS).fill(null),
      stats: { trained: 0, kills: 0, lost: 0, earned: 0, spent: 0 },
    }));
    for (const s of [0, 1]) {
      const st = structureStats(data, 82);
      this.castle(s, st);
    }
    this.buildingStats = (id) => structureStats(data, id);
  }

  castle(side, st) {
    const c = {
      id: this.nextId++, side, kind: 'castle', building: 82, x: CASTLE_X[side], y: 0, r: 2.2,
      hp: st.hp, maxHp: st.hp, f: st, ready: 2,
    };
    this.structures.push(c);
    this.sides[side].castle = c;
    return c;
  }

  income(side) {
    const s = this.sides[side];
    return Math.round((BASE_INCOME + MARKET.income * s.markets) * s.incomeMult);
  }

  // ---------- Spending ----------

  line(side, key) { return this.kits[side].lines.find((l) => l.key === key); }
  freePlot(side) { return this.sides[side].plots.indexOf(null); }
  tier(side, key) { return this.sides[side].tiers[key] ?? 0; }
  count(side, key) { return this.structures.filter((b) => b.side === side && b.line === key && b.hp > 0).length; }

  /** What a purchase costs, or null if it can't be bought now. kind: build | upgrade | market | attack | armour */
  price(side, kind, key) {
    const s = this.sides[side];
    if (this.winner !== null) return null;
    switch (kind) {
      case 'build': {
        const line = this.line(side, key);
        if (!line || this.freePlot(side) < 0) return null;
        return line.cost;
      }
      case 'upgrade': {
        const line = this.line(side, key);
        const t = this.tier(side, key);
        return line && t < 2 ? line.upgrade[t] : null;
      }
      case 'market':
        return s.markets < MARKET.max && this.freePlot(side) >= 0 ? MARKET.cost : null;
      case 'attack': case 'armour':
        return s.smith[kind] < 3 ? SMITH_COSTS[s.smith[kind]] : null;
      default: return null;
    }
  }

  canBuy(side, kind, key) {
    const p = this.price(side, kind, key);
    return p !== null && this.sides[side].gold >= p;
  }

  buy(side, kind, key) {
    if (!this.canBuy(side, kind, key)) return false;
    const s = this.sides[side];
    const p = this.price(side, kind, key);
    s.gold -= p;
    s.stats.spent += p;
    if (kind === 'build' || kind === 'market') {
      const i = this.freePlot(side);
      const [x, y] = plotPos(side, i);
      const isMarket = kind === 'market';
      const line = isMarket ? null : this.line(side, key);
      const st = this.buildingStats(isMarket ? MARKET.building : line.building);
      const b = {
        id: this.nextId++, side, kind: 'building', building: isMarket ? MARKET.building : line.building,
        line: isMarket ? 'market' : key, plot: i, x, y, r: 1.5, hp: st.hp, maxHp: st.hp, f: st,
        timer: isMarket ? 0 : Math.min(8, line.every[this.tier(side, key)] * 0.4), builtAt: this.t,
      };
      s.plots[i] = b.id;
      if (isMarket) s.markets += 1;
      this.structures.push(b);
    } else if (kind === 'upgrade') {
      s.tiers[key] = this.tier(side, key) + 1;
      this.refit(side, key);
    } else {
      s.smith[kind] += 1;
      this.refit(side, null);
    }
    this.events.push({ t: this.t, type: kind, side, key });
    return true;
  }

  /** Knock down your own building for half its price back (frees the plot). */
  sell(side, id) {
    const b = this.structures.find((x) => x.id === id && x.side === side && x.kind === 'building' && x.hp > 0);
    if (!b || this.winner !== null) return false;
    const s = this.sides[side];
    const back = Math.round((b.line === 'market' ? MARKET.cost : this.line(side, b.line).cost) * SELL_BACK);
    s.gold += back;
    s.plots[b.plot] = null;
    if (b.line === 'market') s.markets -= 1;
    b.hp = 0; b.diedAt = this.t; b.sold = true;
    this.events.push({ t: this.t, type: 'sell', side, key: b.line, gold: back });
    return true;
  }

  /** Upgrades reach units already on the field, as in the game. */
  refit(side, key) {
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0 || (key && u.line !== key)) continue;
      const tier = key ? this.tier(side, key) : u.tier;
      const f = this.kits[side].fighter(u.line, tier, this.sides[side].smith);
      if (f.unitId !== u.f.unitId && key) continue; // a new unit type: only new recruits get it
      u.hp += Math.max(0, f.hp - u.f.hp);
      u.f = f;
      u.tier = tier;
    }
  }

  // ---------- Simulation ----------

  spawn(side, b) {
    const s = this.sides[side];
    if (this.units.filter((u) => u.side === side && u.hp > 0).length >= CAP) return;
    const tier = this.tier(side, b.line);
    const f = this.kits[side].fighter(b.line, tier, s.smith);
    const dir = side === 0 ? 1 : -1;
    const u = {
      id: this.nextId++, side, line: b.line, tier, f, r: f.radius,
      x: b.x + dir * (b.r + f.radius + 0.3), y: b.y + (this.rand() - 0.5) * 0.6,
      px: 0, py: 0, hp: f.hp, target: null, retarget: 0, ready: 0, pending: null,
      attackStart: null, diedAt: null, face: dir, moving: false, bornAt: this.t,
    };
    u.px = u.x; u.py = u.y;
    s.stats.trained += 1;
    this.units.push(u);
  }

  enemyCastle(side) { return this.sides[1 - side].castle; }

  pickTarget(u) {
    let best = null;
    let bd = Infinity;
    const reach = u.f.range + AGGRO;
    for (const v of this.units) {
      if (v.side === u.side || v.hp <= 0) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y) - v.r - u.r;
      if (d < bd && d <= reach) { bd = d; best = v; }
    }
    if (best) return best;
    // No enemy soldiers near: the nearest enemy building in reach, else keep marching.
    for (const b of this.structures) {
      if (b.side === u.side || b.hp <= 0) continue;
      const d = Math.hypot(b.x - u.x, b.y - u.y) - b.r - u.r;
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
    const s = this.sides[side];
    const o = this.sides[1 - side];
    if (target.kind === 'castle') {
      this.winner = side;
      this.events.push({ t: this.t, type: 'castle', side });
    } else if (target.kind === 'building') {
      o.plots[target.plot] = null;
      if (target.line === 'market') o.markets -= 1;
      const bounty = 50;
      s.gold += bounty; s.stats.earned += bounty;
      this.events.push({ t: this.t, type: 'razed', side, key: target.line, x: target.x, y: target.y, bounty });
    } else {
      s.stats.kills += 1;
      o.stats.lost += 1;
      const bounty = Math.max(2, Math.round(cost(target.f) * 0.1));
      s.gold += bounty; s.stats.earned += bounty;
      if (by) this.events.push({ t: this.t, type: 'kill', side, x: target.x, y: target.y, bounty });
    }
  }

  launch(u, target, attacks, { accuracy, speed, spread = 0.3 }, isCastle = false) {
    const dist = Math.max(0.1, Math.hypot(target.x - u.x, target.y - u.y));
    const hit = this.rand() * 100 < accuracy;
    let x1 = target.x, y1 = target.y;
    if (!hit) {
      const d = Math.max(0.5, spread * dist / 2);
      x1 += (this.rand() * 2 - 1) * d;
      y1 += (this.rand() * 2 - 1) * d;
    }
    this.shots.push({
      side: u.side, by: u, target, attacks, hit, castle: isCastle,
      x0: u.x, y0: u.y, x1, y1, t0: this.t, t1: this.t + Math.hypot(x1 - u.x, y1 - u.y) / speed,
      sprite: u.f?.projectile?.sprite, arc: u.f?.projectile?.arc ?? 0,
    });
  }

  landShot(s) {
    const f = s.castle ? s.by.f : s.by.f;
    const dmgTo = (v) => damagePerHit({ ...f, attacks: s.attacks, special: f.special || {} }, v.f);
    if (s.hit && s.target.hp > 0) { this.damage(s.side, s.target, dmgTo(s.target), s.by); s.landed = s.target; return; }
    // A miss can still come down on someone: half damage.
    for (const v of this.units) {
      if (v.side === s.side || v.hp <= 0) continue;
      if (Math.abs(v.x - s.x1) <= v.r + 0.1 && Math.abs(v.y - s.y1) <= v.r + 0.1) {
        this.damage(s.side, v, dmgTo(v) / 2, s.by); s.landed = v; return;
      }
    }
  }

  step() {
    if (this.winner !== null) return;
    const t = (this.t += DT);
    // Overtime: both castles crumble, so even a deadlocked game ends.
    if (t > OVERTIME) {
      for (const side of [0, 1]) {
        const c = this.sides[side].castle;
        if (c.hp > 0) this.damage(1 - side, c, (c.maxHp * CRUMBLE * DT) / this.overtime(), null);
        if (this.winner !== null) return;
      }
    }
    // Income
    if (t >= this.incomeAt) {
      this.incomeAt += INCOME_EVERY;
      for (const side of [0, 1]) { const g = this.income(side); this.sides[side].gold += g; this.sides[side].stats.earned += g; }
    }
    // Buildings train their units
    for (const b of this.structures) {
      if (b.kind !== 'building' || b.hp <= 0 || b.line === 'market') continue;
      b.timer -= DT;
      if (b.timer <= 0) {
        const line = this.line(b.side, b.line);
        b.timer += line.every[this.tier(b.side, b.line)];
        b.every = line.every[this.tier(b.side, b.line)];
        this.spawn(b.side, b);
      }
    }
    // Castles shoot the nearest enemy in range
    for (const c of this.structures) {
      if (c.kind !== 'castle' || c.hp <= 0 || t < c.ready) continue;
      let best = null, bd = Infinity;
      for (const v of this.units) {
        if (v.side === c.side || v.hp <= 0) continue;
        const d = Math.hypot(v.x - c.x, v.y - c.y) - c.r;
        if (d <= c.f.range && d < bd) { bd = d; best = v; }
      }
      if (!best) continue;
      c.ready = t + c.f.reload;
      for (let k = 0; k < CASTLE_ARROWS; k++) this.launch(c, best, c.f.attacks, { accuracy: CASTLE_ACCURACY, speed: ARROW_SPEED, spread: 0.4 }, true);
    }
    // Units
    const live = this.units.filter((u) => u.hp > 0);
    for (const u of live) { u.px = u.x; u.py = u.y; u.moving = false; }
    for (const u of live) {
      if ((u.retarget -= DT) <= 0 || !u.target || u.target.hp <= 0) {
        u.retarget = RETARGET * (0.8 + this.rand() * 0.4);
        u.target = this.pickTarget(u);
      }
      if (u.pending) {
        if (t >= u.pending.at) {
          const tg = u.pending.target;
          u.pending = null;
          if (tg.hp > 0) this.release(u, tg);
        }
        continue;
      }
      const tg = u.target;
      const dir = u.side === 0 ? 1 : -1;
      if (!tg) {
        // March down the lane towards the enemy castle.
        const c = this.enemyCastle(u.side);
        const dx = c.x - u.x, dy = (c.y - u.y) * 0.15;
        const len = Math.hypot(dx, dy) || 1;
        this.move(u, dx / len, dy / len, live);
        u.face = dir;
        continue;
      }
      const gap = Math.hypot(tg.x - u.x, tg.y - u.y) - tg.r - u.r;
      const minR = u.f.projectile ? u.f.minRange || 0 : 0;
      if (gap > u.f.range) {
        const len = Math.hypot(tg.x - u.x, tg.y - u.y) || 1;
        this.move(u, (tg.x - u.x) / len, (tg.y - u.y) / len, live, gap - u.f.range);
      } else if (minR > 0 && gap < minR && tg.kind === undefined) {
        const len = Math.hypot(tg.x - u.x, tg.y - u.y) || 1;
        this.move(u, -(tg.x - u.x) / len, -(tg.y - u.y) / len, live);
      } else if (t >= u.ready) {
        u.pending = { at: t + (u.f.attackDelay || 0), target: tg };
        u.ready = t + u.f.reload;
        u.attackStart = t;
        u.face = Math.sign(tg.x - u.x) || u.face;
      }
    }
    // Keep units apart, out of buildings, and on the lane.
    for (let i = 0; i < live.length; i++) {
      const u = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const v = live[j];
        const dx = v.x - u.x, dy = v.y - u.y;
        const need = u.r + v.r;
        if (Math.abs(dx) >= need || Math.abs(dy) >= need) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= need) continue;
        const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1;
        const push = (need - d) / 2;
        u.x -= nx * push; u.y -= ny * push; v.x += nx * push; v.y += ny * push;
      }
      for (const b of this.structures) {
        if (b.hp <= 0) continue;
        const dx = u.x - b.x, dy = u.y - b.y;
        const d = Math.hypot(dx, dy), need = b.r + u.r;
        if (d < need) { const k = d > 1e-6 ? need / d : 1; u.x = b.x + dx * k; u.y = b.y + (d > 1e-6 ? dy * k : need); }
      }
      u.y = Math.max(-LANE.half, Math.min(LANE.half, u.y));
      u.x = Math.max(0.5, Math.min(LANE.length - 0.5, u.x));
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
    }
  }

  /** Walk one step, steering round friends standing in the way. */
  move(u, dx, dy, live, maxStep = Infinity) {
    let side = 0;
    for (const v of live) {
      if (v === u || v.side !== u.side) continue;
      const ox = v.x - u.x, oy = v.y - u.y;
      if (Math.abs(ox) > 1.2 || Math.abs(oy) > 1.2) continue;
      const od = Math.hypot(ox, oy) || 1;
      const ahead = (ox * dx + oy * dy) / od;
      if (ahead < 0.55 || od > u.r + v.r + 0.45) continue;
      side += ((dx * oy - dy * ox) >= 0 ? -1 : 1) * ahead * (1 - od / (u.r + v.r + 0.45));
    }
    if (side) {
      const k = Math.max(-1, Math.min(1, side)) * 0.9;
      const nx = dx - dy * k, ny = dy + dx * k, nl = Math.hypot(nx, ny) || 1;
      dx = nx / nl; dy = ny / nl;
    }
    const len = Math.min(u.f.speed * DT, maxStep);
    u.x += dx * len; u.y += dy * len;
    u.moving = true;
    if (Math.abs(dx) > 0.2) u.face = Math.sign(dx);
  }

  release(u, tg) {
    const p = u.f.projectile;
    if (!p) {
      if (Math.hypot(tg.x - u.x, tg.y - u.y) - tg.r - u.r > u.f.range + 0.5) return;
      this.attackOn(u, tg);
      // Trample: enemies around the target take some of the blow.
      const bl = u.f.special?.blast;
      if (bl) {
        for (const v of this.units) {
          if (v === tg || v.side === u.side || v.hp <= 0) continue;
          if (Math.hypot(v.x - tg.x, v.y - tg.y) - v.r > bl.width) continue;
          const amt = bl.damage < 0 ? -bl.damage : bl.damage * damagePerHit(u.f, v.f);
          this.damage(u.side, v, amt, u);
        }
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
      m[kindOf(b.line, this.kits[side].fighter(b.line, this.tier(side, b.line)))] += 2;
    }
    return m;
  }
}

/** Rough role of a unit line: what counters what. */
export function kindOf(line, f) {
  if (line === 'spears') return 'spear';
  if (line === 'skirms') return 'skirm';
  if (f.armours.has(CLASS.CAVALRY) || f.armours.has(CLASS.ELEPHANT)) return 'cavalry';
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
  cavalry: { archer: 2.5, skirm: 2.5, infantry: 1, cavalry: 1, spear: 0.2 },
};

// How good a line is on its own, before counters (spearmen and skirmishers are cheap specialists).
const BASE = { knights: 1.1, swords: 1.1, eagles: 1.1, champi: 1, archers: 1, cavarchers: 1, scouts: 0.9, spears: 0.8, skirms: 0.7 };

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
    const s = w.sides[this.side];
    const foe = w.mix(1 - this.side);
    const kit = w.kits[this.side];
    const builds = w.structures.filter((b) => b.side === this.side && b.kind === 'building' && b.hp > 0);
    const military = builds.filter((b) => b.line !== 'market').length;
    const options = [];
    for (const line of kit.lines) {
      const kind = kindOf(line.key, kit.fighter(line.key, w.tier(this.side, line.key)));
      const counter = Object.entries(foe).reduce((acc, [k, n]) => acc + (BEATS[kind][k] ?? 1) * n, 0) / (1 + Object.values(foe).reduce((a, b) => a + b, 0));
      const have = w.count(this.side, line.key);
      const base = BASE[line.key] ?? (line.unique ? 1.3 : 1);
      // More buildings means more units: fill plots early, then upgrade.
      const early = w.freePlot(this.side) >= 0 && military < 6 ? 0.8 : 0;
      if (w.price(this.side, 'build', line.key) !== null) options.push({ kind: 'build', key: line.key, score: base + early + 0.7 * counter - have * 0.25 });
      if (have && w.price(this.side, 'upgrade', line.key) !== null) options.push({ kind: 'upgrade', key: line.key, score: 1.1 + have * 0.5 + counter * 0.5 + (w.t > 180 ? 0.5 : 0) });
    }
    // Markets pay for themselves: get them early.
    if (military >= 1 && w.price(this.side, 'market') !== null && w.t < 600) options.push({ kind: 'market', score: 2.2 - s.markets * 0.5 });
    for (const k of ['attack', 'armour']) if (military >= 3 && w.price(this.side, k) !== null) options.push({ kind: k, score: 0.8 + military * 0.12 });
    // Plots full and gold piling up: replace the building that does least against the enemy.
    if (w.freePlot(this.side) < 0 && s.gold > 600 && this.level !== 'easy') {
      const rate = (key) => {
        const kind = kindOf(key, kit.fighter(key, w.tier(this.side, key)));
        return Object.entries(foe).reduce((acc, [k, n]) => acc + (BEATS[kind][k] ?? 1) * n, 0);
      };
      const worst = builds.filter((b) => b.line !== 'market').sort((a, b) => rate(a.line) - rate(b.line))[0];
      const best = kit.lines.map((l) => l.key).sort((a, b) => rate(b) - rate(a))[0];
      if (worst && best && rate(best) > rate(worst.line) * 1.3) { w.sell(this.side, worst.id); return; }
    }
    if (!options.length) return;
    // Easy plays at random; Normal and Hard pick well, with a little variety.
    const noise = this.level === 'easy' ? 3 : this.level === 'hard' ? 0.25 : 0.6;
    for (const o of options) o.score += w.rand() * noise;
    options.sort((a, b) => b.score - a.score);
    const pick = options[0];
    // Save up for the best choice rather than spending on whatever is cheap.
    if (w.canBuy(this.side, pick.kind, pick.key)) w.buy(this.side, pick.kind, pick.key);
  }
}
