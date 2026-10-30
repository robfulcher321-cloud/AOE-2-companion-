// Battle simulation in game seconds: 1 to 5 units a side on open, flat ground.
//
// Movement and targeting: each unit goes for the nearest living enemy and keeps
// that target until it dies. Units walk until the target is within range
// (measured edge to edge, as in the game), then attack on their reload timer.
// Units can't overlap; they push past each other, so melee units spread round
// a target. No micro: ranged units don't run from melee units.
//
// Attacks: a blow or shot is released `attackDelay` seconds into each attack
// and is cancelled if the attacker dies first. What follows is how the game
// handles projectiles (AoE II DE infosheet, Jineapple's work; UGC guide):
//   - Each shot rolls against the unit's accuracy. A hit is aimed at the
//     target; a miss is aimed at a random point near it, within
//     dispersion × distance ÷ 2 tiles (a square area, as in the game).
//   - Projectiles fly at their own speed and hit the target if it is in their
//     path. A target that stepped out of the path is missed, unless Ballistics
//     made the shot lead it. Shots still land if the shooter has died.
//   - A miss that still meets the target does full damage; one that comes down
//     on another enemy does half (full for Arambai, chakrams and fire archers).
//   - Extra arrows (Chu Ko Nu, Kipchak) leave in bursts, each burst taking an
//     attack delay, and the reload starts after the last one.
//   - Units with a minimum range (skirmishers, slingers...) switch to another
//     enemy in range when theirs is too close, or step back to shoot.
//
// Special abilities, from each unit's charge settings in the game data (UGC
// guide's meaning of each charge type). A unit's charge refills at its
// recharge rate and units start fully charged.
//   1 attack charge (Coustillier, Roman Comitatenses): a full charge adds its
//     value to the next blow.
//   3 area charge (Urumi): the charged blow also hits enemies around the target.
//   4 agility (Shrivamsha): each charge point dodges one projectile.
//   5 block (Iron Pagoda): a full charge blocks one melee blow.
//   6 charge projectiles: melee units (Fire Lancer, Hearth Troop) fire them as
//     they close in, within the charge range (these shots ignore armour); ranged units (Bolas Rider) fire
//     them instead of their next normal shot.
//   7 (Xianbei Raider): the next shot is a charge arrow plus extra arrows.
//   Samurai: charges in faster from 2 to 6–7 tiles away when charged.
// Also: trample/area blows (elephants, Logistica, Druzhina, Lechitic Legacy,
// Ghulam, Ibirapema), armour-ignoring (Leitis, Composite Bowman, Wootz Steel),
// armour tearing (Obuch), bonus-damage resistance (Sicilians, Bengali
// elephants), regeneration (civ bonuses and techs), melee damage reflection
// (Lamellar Armor) and the Konnik fighting on after its horse falls.

import { damagePerHit } from './combat.js';

export const DT = 1 / 60;          // simulation step, game seconds
const MAX_TIME = 600;
const PROJECTILE_SIZE = 0.05;      // half-size of a projectile's own hitbox, tiles
const BURST_GAP = 0.06;            // seconds between arrows in one burst
const CONE = Math.cos(Math.PI / 7); // narrow frontal cone for spear thrusts
const CELL = 1.5;                  // spatial grid cell, tiles: nearby-unit lookups only check a few cells
const RECORD_EVERY = 3;            // keep every 3rd step for playback (20 a second); the player interpolates
const STUCK_AFTER = 1.2;           // seconds a melee unit can be blocked before picking another enemy
export const MAX_PER_SIDE = 500;
const MELEE_SLACK = 0.2;
// Siege with a minimum range backs away from enemies too close to shoot, as in the game, but
// turns round first (and again before it can fire): slow work for a catapult or scorpion.
const SIEGE_TURN = 1.2;          // game seconds to turn about          // tiles: a melee unit this close counts as touching, so it swings instead of shuffling on the spot

/** Small, fast seeded random generator so each run can be replayed exactly. */
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

const chancy = (p) => p && (p.accuracy < 100 || p.count > 1);
export const hasRandomness = (a, b) => [a, b].some((f) => chancy(f.projectile)
  || chancy(f.special?.charge?.projectile) || Boolean(f.special?.charge?.extra)
  || (f.dismount && hasRandomness(f.dismount, f.dismount)));

/**
 * a, b: fighter stats from buildFighter. opts.counts: [blue count, red count].
 * opts.record: keep per-step frames for playback (off when sampling win rates).
 */
export function simulate(a, b, { counts = [1, 1], seed = 1, startGap, record = true } = {}) {
  const rand = mulberry32(seed);
  const fighters = [a, b];
  const maxR = Math.max(a.radius, b.radius);
  const reachOf = (f) => Math.max(f.range, f.special?.charge?.projectile && !f.projectile ? f.special.charge.event : 0);
  const gap = startGap ?? Math.max(5, Math.max(reachOf(a), reachOf(b)) + 2);
  const spacing = Math.max(2 * maxR + 0.3, 0.8);
  const units = [];
  const spawn = (f, side, x, y, at) => {
    const ch = f.special?.charge;
    const u = {
      id: units.length, side, f, r: f.radius, x, y,
      vx: 0, vy: 0, hp: f.hp, target: null, ready: at, pending: null,
      attackStart: null, diedAt: null, spawnedAt: at, face: side === 0 ? 1 : -1, moving: false,
      hits: 0, shots: 0, dealt: 0, charge: ch ? ch.max : 0, armourLoss: 0, rushing: false, stuck: 0,
    };
    units.push(u);
    return u;
  };
  for (let side = 0; side < 2; side++) {
    const n = Math.max(1, Math.min(MAX_PER_SIDE, counts[side] | 0));
    // Ranks of up to 5 (more than 25 units: wider ranks), the back ranks further from the enemy.
    const perRank = n <= 5 ? n : Math.max(5, Math.ceil(Math.sqrt(n)));
    const front = side === 0 ? 0 : a.radius + b.radius + gap;
    const back = side === 0 ? -1 : 1;
    for (let k = 0; k < n; k++) {
      const rank = Math.floor(k / perRank);
      const inRank = Math.min(perRank, n - rank * perRank);
      const slot = k - rank * perRank;
      spawn(fighters[side], side, front + back * rank * spacing, (slot - (inRank - 1) / 2) * spacing, 0);
    }
  }
  const startCounts = [0, 1].map((s) => units.filter((u) => u.side === s).length);

  const frames = [];
  const hits = [];
  const shots = [];
  const flying = [];
  let t = 0;

  const alive = (u) => u.hp > 0;
  // Spatial grid of living units, rebuilt every step, so "who is near here"
  // only looks at a few cells instead of every unit on the field.
  let grid = new Map();
  const cellKey = (cx, cy) => cx * 100003 + cy;
  // Small fights: checking everyone is quicker than keeping a grid.
  let small = true;
  const rebuildGrid = () => {
    small = units.length <= 40;
    if (small) return;
    grid = new Map();
    for (const u of units) {
      if (!alive(u)) continue;
      const k = cellKey(Math.floor(u.x / CELL), Math.floor(u.y / CELL));
      const list = grid.get(k);
      if (list) list.push(u); else grid.set(k, [u]);
    }
  };
  /** Calls fn(unit) for living units whose centre may be within r of (x, y). */
  const near = (x, y, r, fn) => {
    if (small) { for (const v of units) if (alive(v)) fn(v); return; }
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = grid.get(cellKey(cx, cy));
        if (list) for (const v of list) fn(v);
      }
    }
  };
  const enemiesNear = (u, x, y, r) => {
    const out = [];
    near(x, y, r, (v) => { if (v.side !== u.side && alive(v)) out.push(v); });
    return out;
  };
  const anyEnemyOf = (side) => units.some((v) => v.side !== side && alive(v));
  const centre = (u, v) => { const dx = v.x - u.x, dy = v.y - u.y; return Math.sqrt(dx * dx + dy * dy); };
  const edge = (u, v) => centre(u, v) - u.r - v.r;
  const sideAlive = (s) => units.some((u) => u.side === s && alive(u));
  const chargeOf = (u) => u.f.special?.charge || null;
  const full = (u) => { const ch = chargeOf(u); return ch && u.charge >= ch.max - 1e-9; };
  const dmgOf = (u, v, attacks, extraMelee = 0, ignoreArmour = false) => damagePerHit(u.f, v.f, attacks ?? u.f.attacks, { armourLoss: v.armourLoss, extraMelee, ignoreArmour });

  const deal = (by, victim, amount, at, note) => {
    if (!alive(victim)) return;
    victim.hp -= amount;
    by.hits += 1;
    by.dealt += amount;
    hits.push({ t: at, by: by.id, side: by.side, victim: victim.id, dmg: Math.round(amount * 100) / 100, note });
    if ((by.f.special?.combat || 0) & 4) victim.armourLoss += 1;   // Obuch tears armour
    if (victim.hp <= 0 && victim.diedAt === null) {
      victim.diedAt = at;
      // Konnik: the rider fights on as infantry.
      if (victim.f.dismount) spawn(victim.f.dismount, victim.side, victim.x, victim.y, at);
    }
  };

  const inBox = (u, x, y) => Math.abs(u.x - x) <= u.r + PROJECTILE_SIZE && Math.abs(u.y - y) <= u.r + PROJECTILE_SIZE;

  // p: projectile settings; attacks: the damage it carries.
  const launch = (u, target, p, attacks, releaseAt, kind) => {
    const dist = Math.max(centre(u, target), 0.01);
    let aimX = target.x;
    let aimY = target.y;
    if (p.ballistics) {
      // Lead the target by where it will be when the shot arrives.
      const flight = dist / p.speed;
      aimX += target.vx * flight;
      aimY += target.vy * flight;
    }
    const accurate = rand() * 100 < (p.accuracy ?? 100);
    if (!accurate) {
      const d = ((p.spread || 0) * dist) / 2;
      aimX += (rand() * 2 - 1) * d;
      aimY += (rand() * 2 - 1) * d;
    } else if (kind === 'charge' && (p.count || 1) > 1) {
      // Several charge shots spread a little over the target.
      aimX += (rand() * 2 - 1) * target.r * 0.7;
      aimY += (rand() * 2 - 1) * target.r * 0.7;
    }
    const shot = {
      by: u.id, side: u.side, target: target.id, accurate, kind, p, attacks,
      t0: releaseAt, x0: u.x, y0: u.y, x1: aimX, y1: aimY,
      landed: releaseAt + Math.hypot(aimX - u.x, aimY - u.y) / p.speed,
      hit: null, sprite: p.sprite, arc: p.arc,
    };
    u.shots += 1;
    shots.push(shot);
    flying.push(shot);
  };

  const posAt = (s, at) => {
    const k = Math.max(0, Math.min(1, (at - s.t0) / Math.max(s.landed - s.t0, 1e-6)));
    return [s.x0 + (s.x1 - s.x0) * k, s.y0 + (s.y1 - s.y0) * k, k];
  };

  // Shrivamsha: a charge point dodges an incoming projectile.
  const dodges = (v) => {
    const ch = chargeOf(v);
    if (ch?.type !== 4 || v.charge < 1) return false;
    v.charge -= 1;
    return true;
  };

  // Checked every step while the projectile flies. It hits its target if the
  // target is in its path (so units walking straight at the shooter are still
  // hit, while ones that step aside are missed). A missed shot can also come
  // down on another enemy near the end of its flight, for half damage.
  const fly = (s) => {
    const shooter = units[s.by];
    const p = s.p;
    const target = units[s.target];
    const [px, py, k] = posAt(s, t);
    const done = t >= s.landed - 1e-9;
    const foesNear = () => enemiesNear(shooter, px, py, 1.6 + (p.blast || 0));
    const pierceArmour = Boolean((p.combat || 0) & 1); // shot ignores armour (Fire Lancer, Hearth Troop)
    const shotDmg = (e) => dmgOf(shooter, e, s.attacks, 0, pierceArmour);
    const stop = (id) => { s.hit = id; s.landed = t; s.x1 = px; s.y1 = py; return true; };
    if (p.blast > 0) {
      if (!done) return false;
      // Area shot (grenadier): everything in the blast takes the damage.
      for (const e of foesNear()) {
        if (Math.hypot(e.x - px, e.y - py) <= p.blast + e.r) { deal(shooter, e, shotDmg(e), t); s.hit = s.hit ?? e.id; }
      }
      return true;
    }
    if (p.pierces) {
      // Chakram: hits each enemy it passes through, once.
      s.struck = s.struck || new Set();
      for (const e of foesNear()) {
        if (!s.struck.has(e.id) && inBox(e, px, py)) {
          s.struck.add(e.id);
          if (!dodges(e)) { deal(shooter, e, shotDmg(e), t); s.hit = s.hit ?? e.id; }
        }
      }
      return done;
    }
    if (alive(target) && !s.dodged && inBox(target, px, py)) {
      if (dodges(target)) {
        s.dodged = true;
        s.accurate = true; // a dodged shot flies on harmlessly
        hits.push({ t, by: shooter.id, side: s.side, victim: target.id, dmg: 0, note: 'dodged' });
      } else {
        deal(shooter, target, shotDmg(target), t);
        return stop(target.id);
      }
    }
    if (!s.accurate && k > 0.7) {
      const stray = foesNear().find((e) => e.id !== s.target && inBox(e, px, py));
      if (stray && !dodges(stray)) {
        const d = shotDmg(stray);
        deal(shooter, stray, p.fullStray ? d : d / 2, t);
        return stop(stray.id);
      }
    }
    return done;
  };

  // A melee blow, with trample, charges, blocking and reflection.
  const strike = (u, target) => {
    if (!alive(target) || edge(u, target) > u.f.range + MELEE_SLACK + 0.5) return;
    const ch = chargeOf(u);
    let extra = 0;
    let area = u.f.special?.blast || null;
    let note;
    if (ch && (ch.type === 1 || ch.type === 3) && full(u) && (ch.type === 3 || ch.event === 1)) {
      extra = ch.max;
      u.charge = 0;
      note = 'charge';
      if (ch.type === 3) area = area || { width: 0.75, level: 2, damage: 0.5 };
    } else if (ch?.type === 3) {
      area = null; // Urumi only sweeps with a charged blow
    }
    // Iron Pagoda: a full charge blocks the blow.
    const tch = chargeOf(target);
    if (tch?.type === 5 && full(target)) {
      target.charge = 0;
      hits.push({ t, by: u.id, side: u.side, victim: target.id, dmg: 0, note: 'blocked' });
      return;
    }
    const d = dmgOf(u, target, null, extra);
    deal(u, target, d, t, note);
    const refl = target.f.special?.reflect || 0;
    if (refl > 0 && alive(u)) {
      u.hp -= d * refl;
      if (u.hp <= 0 && u.diedAt === null) { u.diedAt = t; if (u.f.dismount) spawn(u.f.dismount, u.side, u.x, u.y, t); }
    }
    if (area) {
      const dx = target.x - u.x, dy = target.y - u.y;
      const len = Math.hypot(dx, dy) || 1;
      for (const e of enemiesNear(u, target.x, target.y, area.width + 1.5 + (area.level & 128 ? edge(u, target) : 0))) {
        if (e.id === target.id) continue;
        if (area.level & 128) {
          // Spear thrust: only enemies in a narrow cone, up to `width` past the target
          const ex = e.x - u.x, ey = e.y - u.y;
          const el = Math.sqrt(ex * ex + ey * ey) || 1;
          if ((ex * dx + ey * dy) / (el * len) < CONE || el > len + area.width + e.r) continue;
        } else if (centre(target, e) - e.r > area.width) continue;
        const amount = area.damage < 0 ? -area.damage : area.damage * dmgOf(u, e, null, extra);
        deal(u, e, amount, t, 'splash');
      }
    }
  };

  const release = (u) => {
    const target = units[u.pending.target];
    const kind = u.pending.kind;
    const ch = chargeOf(u);
    if (kind === 'charge') {
      // Charge projectiles thrown or fired while closing in (Fire Lancer, Hearth Troop)
      const p = ch.projectile;
      for (let k = 0; k < (p.count || 1); k++) launch(u, target, p, p.attacks, t + k * BURST_GAP, 'charge');
      return;
    }
    const p = u.f.projectile;
    if (!p) { strike(u, target); return; }
    if (kind === 'charged-shot') {
      // Bolas Rider: the charge shot replaces the normal one.
      // Xianbei Raider: a charge arrow plus extra arrows.
      launch(u, target, ch.projectile, ch.projectile.attacks, t, 'charge');
      const ex = ch.extra;
      if (ex) for (let k = 0; k < (ex.count || 0); k++) launch(u, target, ex, ex.attacks, t + (k + 1) * BURST_GAP, 'charge');
      return;
    }
    // Extra arrows go in bursts; the first burst carries the main arrow.
    const bursts = u.pending.bursts;
    let n = 0;
    for (let bi = 0; bi < bursts.length; bi++) {
      for (let k = 0; k < bursts[bi]; k++, n++) {
        const extra = n > 0 && Boolean(p.secondary);
        launch(u, target, p, extra ? p.secondary.attacks : u.f.attacks, t + bi * u.f.attackDelay + k * BURST_GAP, extra ? 'extra' : 'main');
      }
    }
  };

  // Nearest living enemy: look close by first, then further out.
  const nearestEnemy = (u, exclude = -1) => {
    for (const r of [3, 6, 12]) {
      let best = null;
      let bd = Infinity;
      near(u.x, u.y, r, (v) => {
        if (v.side === u.side || !alive(v) || v.id === exclude) return;
        const d = centre(u, v);
        if (d < bd) { bd = d; best = v; }
      });
      if (best && bd <= r) return best;
    }
    let best = null;
    let bd = Infinity;
    for (const v of units) {
      if (v.side === u.side || !alive(v) || v.id === exclude) continue;
      const d = centre(u, v);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  };
  const pickTarget = (u) => {
    if (u.target !== null && alive(units[u.target])) {
      // A melee unit that has been blocked from its target for a while (by
      // its own side crowding round it) goes for another enemy it can reach.
      if (u.stuck > STUCK_AFTER && !u.f.projectile) {
        const alt = nearestEnemy(u, u.target);
        if (alt && edge(u, alt) < edge(u, units[u.target]) + 1.5) { u.target = alt.id; u.stuck = 0; }
      }
      return units[u.target];
    }
    const best = nearestEnemy(u);
    u.target = best ? best.id : null;
    u.stuck = 0;
    return best;
  };

  /** Siege turning round: true once it faces `dir` (−1 left, 1 right); others turn at once. */
  const turnTo = (u, dir) => {
    if (u.face === dir || !(u.f.minRange > 0)) { u.turnUntil = null; if (!(u.f.minRange > 0)) u.face = dir; return true; }
    if (u.turnUntil == null) u.turnUntil = t + SIEGE_TURN;
    if (t < u.turnUntil) return false;
    u.face = dir;
    u.turnUntil = null;
    return true;
  };

  const startAttack = (u, target, kind, bursts = [1]) => {
    u.pending = { at: t + u.f.attackDelay, started: t, target: target.id, bursts, kind };
    u.attackStart = t;
    // Reload counts from the last burst for multi-arrow units (≈ infosheet's 3.6–4.1 s for Elite Chu Ko Nu).
    u.ready = t + u.f.reload + (bursts.length > 1 ? (bursts.length - 1) * u.f.attackDelay + 0.13 : 0);
    u.face = Math.sign(target.x - u.x) || u.face;
    if (u.rushing) { u.rushing = false; u.charge = 0; }
  };

  let step = 0;
  while (t < MAX_TIME && sideAlive(0) && sideAlive(1)) {
    rebuildGrid();
    // Charges refill; regeneration heals.
    for (const u of units) {
      if (!alive(u)) continue;
      const ch = chargeOf(u);
      if (ch && u.charge < ch.max) u.charge = Math.min(ch.max, u.charge + ch.rate * DT);
      const regen = u.f.special?.regen || 0;
      if (regen > 0 && u.hp < u.f.hp) u.hp = Math.min(u.f.hp, u.hp + (regen / 60) * DT);
    }
    // Everyone decides from the same snapshot, so nobody gets a head start
    // from being processed first.
    const moves = units.map(() => null);
    for (const u of units) {
      u.moving = false;
      if (!alive(u) || t < u.spawnedAt) continue;
      let target = pickTarget(u);
      if (!target) continue;
      if (u.pending) continue;
      const ch = chargeOf(u);
      const p = u.f.projectile;
      const gapNow = edge(u, target);
      // Melee units with a charge projectile use it as they close in.
      if (!p && ch?.type === 6 && ch.projectile && full(u) && gapNow <= ch.event && gapNow >= (ch.projectile.minRange || 0) && t >= u.ready) {
        startAttack(u, target, 'charge');
        u.charge = 0;
        continue;
      }
      const minR = p ? u.f.minRange || 0 : 0;
      u.retreating = false;
      if (minR > 0 && gapNow < minR) {
        // Too close to shoot: switch to an enemy that is in range, or turn round and back off.
        const alt = enemiesNear(u, u.x, u.y, u.f.range + u.r + 1.5).find((e) => edge(u, e) >= minR && edge(u, e) <= u.f.range);
        if (alt) { u.target = alt.id; target = alt; } else {
          if (!turnTo(u, Math.sign(u.x - target.x) || -u.face)) continue;
          const d = centre(u, target) || 1;
          moves[u.id] = [((u.x - target.x) / d) * u.f.speed * DT, ((u.y - target.y) / d) * u.f.speed * DT];
          u.retreating = true;
          continue;
        }
      }
      // Siege turns to face its target before walking at it or firing.
      if (minR > 0 && !turnTo(u, Math.sign(target.x - u.x) || u.face)) continue;
      const reach = u.f.range + (p ? 0 : MELEE_SLACK);
      const gap2 = edge(u, target);
      if (gap2 > reach + 1e-9) {
        // Samurai: charge in faster when the charge is full and the target is in the window.
        const rush = u.f.special?.rush;
        if (rush && full(u)) {
          const c = centre(u, target);
          if (c >= rush.from && c <= rush.to) u.rushing = true;
        }
        const speed = u.f.speed * (u.rushing && rush ? rush.speed : 1);
        // Step a little inside reach, so a target backing off at the same moment can't keep it
        // exactly one step short for ever.
        const stepLen = Math.min(speed * DT, gap2 - reach + (p ? 0.05 : MELEE_SLACK / 2));
        const d = centre(u, target) || 1;
        let dx = (target.x - u.x) / d;
        let dy = (target.y - u.y) / d;
        // Steer round friendly units standing in the way, so a crowd flows
        // round the target instead of piling up behind the front row.
        let side = 0;
        near(u.x, u.y, u.r * 2 + 0.6, (v) => {
          if (v === u || v.side !== u.side || !alive(v)) return;
          const ox = v.x - u.x, oy = v.y - u.y;
          const od = Math.sqrt(ox * ox + oy * oy) || 1;
          const ahead = (ox * dx + oy * dy) / od;
          if (ahead < 0.55 || od > u.r + v.r + 0.45) return;
          const cross = dx * oy - dy * ox;           // which side the blocker is on
          side += (cross >= 0 ? -1 : 1) * ahead * (1 - od / (u.r + v.r + 0.45));
        });
        if (side) {
          const k = Math.max(-1, Math.min(1, side)) * 0.9;
          const nx = dx - dy * k, ny = dy + dx * k;
          const nl = Math.hypot(nx, ny) || 1;
          dx = nx / nl; dy = ny / nl;
        }
        moves[u.id] = [dx * stepLen, dy * stepLen];
      } else if (t >= u.ready) {
        if (p && ch && (ch.type === 6 || ch.type === 7) && ch.projectile && full(u)) {
          startAttack(u, target, 'charged-shot');
          u.charge = 0;
          continue;
        }
        let bursts = [1];
        if (p && p.count > 1) {
          // Elite Chu Ko Nu: 5 arrows in 3 to 5 bursts (infosheet)
          const n = p.count;
          const nb = Math.min(n, 3 + Math.floor(rand() * (n - 2)));
          bursts = Array.from({ length: nb }, (_, i) => Math.floor(n / nb) + (i < n % nb ? 1 : 0));
        }
        startAttack(u, target, 'normal', bursts);
      }
    }
    // Apply moves, then push overlapping units apart.
    const before = units.map((u) => (u.target !== null && alive(u) ? edge(u, units[u.target]) : null));
    for (const u of units) {
      const m = moves[u.id];
      u.x0 = u.x; u.y0 = u.y;
      u.vx = 0; u.vy = 0;
      if (!m) continue;
      u.x += m[0]; u.y += m[1];
      u.vx = m[0] / DT; u.vy = m[1] / DT;
      u.moving = true;
      if (Math.abs(m[0]) > 1e-6 && !u.f.minRange) u.face = Math.sign(m[0]);
      const tg = u.target !== null ? units[u.target] : null;
      if (tg && Math.sign(tg.x - u.x) && !u.retreating && !u.f.minRange) u.face = Math.sign(tg.x - u.x) || u.face;
    }
    for (const u of units) {
      if (!alive(u)) continue;
      near(u.x, u.y, u.r + 1, (v) => {
        if (v.id <= u.id || !alive(v)) return;
        const i = u.id;
        const d = centre(u, v);
        const need = u.r + v.r;
        const nx = d > 1e-6 ? (v.x - u.x) / d : 0;
        const ny = d > 1e-6 ? (v.y - u.y) / d : (i % 2 ? 1 : -1);
        const push = (need - d);
        if (d >= need - 1e-6) return;
        // The unit that is standing still (e.g. attacking) gives way less.
        const wu = u.moving ? (v.moving ? 0.5 : 0.8) : (v.moving ? 0.2 : 0.5);
        u.x -= nx * push * wu; u.y -= ny * push * wu;
        v.x += nx * push * (1 - wu); v.y += ny * push * (1 - wu);
      });
    }
    // Shown walking only if it actually got somewhere this step (no running on the spot).
    for (const u of units) {
      const m = moves[u.id];
      u.walking = Boolean(m) && alive(u) && Math.hypot(u.x - (u.x0 ?? u.x), u.y - (u.y0 ?? u.y)) > u.f.speed * DT * 0.3;
    }
    // Blocked: tried to walk to its target but got no closer.
    for (const u of units) {
      if (!alive(u) || !u.moving || before[u.id] === null) { if (!u.moving) u.stuck = 0; continue; }
      const nowGap = edge(u, units[u.target]);
      if (before[u.id] - nowGap < u.f.speed * DT * 0.25) u.stuck += DT; else u.stuck = 0;
    }
    // Blows and shots due this step are released together, so mutual kills are possible.
    const due = units.filter((u) => u.pending && alive(u) && t >= u.pending.at - 1e-9);
    for (const u of due) { release(u); u.pending = null; }
    for (const u of units) if (!alive(u) && u.pending) u.pending = null;
    // Projectiles in the air
    for (let k = flying.length - 1; k >= 0; k--) {
      if (t >= flying[k].t0 && fly(flying[k])) flying.splice(k, 1);
    }
    if (record && step % RECORD_EVERY === 0) {
      frames.push({
        t,
        u: units.map((u) => [u.x, u.y, Math.max(0, u.hp), u.walking ? 1 : 0, u.face, u.attackStart]),
      });
    }
    t += DT;
    step += 1;
  }
  // Shots still in the air when the fight ends finish their flight (for drawing).
  for (const s of flying) s.hit = null;

  const survivors = [0, 1].map((s) => units.filter((u) => u.side === s && alive(u)).length);
  const dead = [survivors[0] === 0, survivors[1] === 0];
  const winner = dead[0] && dead[1] ? null : dead[1] ? 0 : dead[0] ? 1 : null;
  const ofSide = (s) => units.filter((u) => u.side === s);
  return {
    frames,
    hits,
    shots,
    duration: t,
    winner,                 // 0, 1, or null for a draw / timeout
    timedOut: !dead[0] && !dead[1],
    seed,
    units: units.map((u) => ({
      id: u.id, side: u.side, unitId: u.f.unitId, maxHp: u.f.hp, hpLeft: Math.max(0, u.hp),
      diedAt: u.diedAt, spawnedAt: u.spawnedAt, hits: u.hits, shots: u.shots,
    })),
    sides: [0, 1].map((s) => ({
      count: startCounts[s],
      survivors: survivors[s],
      hpLeft: ofSide(s).reduce((acc, u) => acc + Math.max(0, u.hp), 0),
      hpTotal: fighters[s].hp * startCounts[s],
      hits: ofSide(s).reduce((acc, u) => acc + u.hits, 0),
      shots: ofSide(s).reduce((acc, u) => acc + u.shots, 0),
      dealt: ofSide(s).reduce((acc, u) => acc + u.dealt, 0),
      diedAt: survivors[s] === 0 ? Math.max(...ofSide(s).map((u) => u.diedAt ?? 0)) : null,
    })),
  };
}

/**
 * Runs the battle many times with different random seeds (only when there is
 * randomness) and returns win rates plus one representative fight to show:
 * one won by the most common winner, with a typical margin.
 */
export function simulateMany(a, b, { runs = 200, ...opts } = {}) {
  if (!hasRandomness(a, b)) {
    const one = simulate(a, b, opts);
    const wins = [0, 0, 0];
    wins[one.winner === null ? 2 : one.winner] = 1;
    return { result: one, runs: 1, wins, rates: wins.slice() };
  }
  const outcomes = [];
  const wins = [0, 0, 0];
  for (let s = 1; s <= runs; s++) {
    const r = simulate(a, b, { ...opts, seed: s, record: false });
    wins[r.winner === null ? 2 : r.winner] += 1;
    outcomes.push({ seed: s, winner: r.winner, hpLeft: r.winner === null ? 0 : r.sides[r.winner].hpLeft });
  }
  const top = wins[0] >= wins[1] && wins[0] >= wins[2] ? 0 : wins[1] >= wins[2] ? 1 : null;
  const pool = outcomes.filter((o) => o.winner === top).sort((x, y) => x.hpLeft - y.hpLeft);
  const pick = pool[Math.floor(pool.length / 2)] || outcomes[0];
  const result = simulate(a, b, { ...opts, seed: pick.seed });
  return { result, runs, wins, rates: wins.map((w) => w / runs) };
}
