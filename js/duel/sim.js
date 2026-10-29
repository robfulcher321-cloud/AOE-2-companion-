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

import { damagePerHit } from './combat.js';

export const DT = 1 / 60;          // simulation step, game seconds
const MAX_TIME = 600;
const PROJECTILE_SIZE = 0.05;      // half-size of a projectile's own hitbox, tiles
const BURST_GAP = 0.06;            // seconds between arrows in one burst

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

export const hasRandomness = (a, b) => [a, b].some((f) => f.projectile && (f.projectile.accuracy < 100 || f.projectile.count > 1));

/**
 * a, b: fighter stats from buildFighter. opts.counts: [blue count, red count].
 * opts.record: keep per-step frames for playback (off when sampling win rates).
 */
export function simulate(a, b, { counts = [1, 1], seed = 1, startGap, record = true } = {}) {
  const rand = mulberry32(seed);
  const fighters = [a, b];
  const maxR = Math.max(a.radius, b.radius);
  const gap = startGap ?? Math.max(5, Math.max(a.range, b.range) + 2);
  const spacing = Math.max(2 * maxR + 0.3, 0.8);
  const units = [];
  for (let side = 0; side < 2; side++) {
    const n = Math.max(1, Math.min(5, counts[side] | 0));
    for (let k = 0; k < n; k++) {
      units.push({
        id: units.length, side, f: fighters[side], r: fighters[side].radius,
        x: side === 0 ? 0 : a.radius + b.radius + gap,
        y: (k - (n - 1) / 2) * spacing,
        vx: 0, vy: 0, hp: fighters[side].hp, target: null, ready: 0, pending: null,
        attackStart: null, diedAt: null, face: side === 0 ? 1 : -1, moving: false,
        hits: 0, shots: 0, dealt: 0,
      });
    }
  }
  // Damage of each side's blow/shot and of its extra arrows, against the other side
  const dmg = [damagePerHit(a, b), damagePerHit(b, a)];
  const secDmg = fighters.map((f, i) => (f.projectile?.secondary ? damagePerHit(f, fighters[1 - i], f.projectile.secondary.attacks) : 0));

  const frames = [];
  const hits = [];
  const shots = [];
  const flying = [];
  let t = 0;

  const alive = (u) => u.hp > 0;
  const enemies = (u) => units.filter((e) => e.side !== u.side && alive(e));
  const centre = (u, v) => Math.hypot(v.x - u.x, v.y - u.y);
  const edge = (u, v) => centre(u, v) - u.r - v.r;
  const sideAlive = (s) => units.some((u) => u.side === s && alive(u));

  const deal = (by, victim, amount, at) => {
    if (!alive(victim)) return;
    victim.hp -= amount;
    by.hits += 1;
    by.dealt += amount;
    hits.push({ t: at, by: by.id, side: by.side, victim: victim.id, dmg: Math.round(amount * 100) / 100 });
    if (victim.hp <= 0 && victim.diedAt === null) victim.diedAt = at;
  };

  // Which enemy (if any) a landing projectile comes down on: the target if its
  // hitbox covers the spot, otherwise (for misses) the first other enemy there.
  const inBox = (u, x, y, pad = 0) => Math.abs(u.x - x) <= u.r + PROJECTILE_SIZE + pad && Math.abs(u.y - y) <= u.r + PROJECTILE_SIZE + pad;

  const launch = (u, target, extra, releaseAt) => {
    const p = u.f.projectile;
    const dist = Math.max(centre(u, target), 0.01);
    let aimX = target.x;
    let aimY = target.y;
    if (p.ballistics) {
      // Lead the target by where it will be when the shot arrives.
      const flight = dist / p.speed;
      aimX += target.vx * flight;
      aimY += target.vy * flight;
    }
    const accurate = rand() * 100 < p.accuracy;
    if (!accurate) {
      const d = (p.spread * dist) / 2;
      aimX += (rand() * 2 - 1) * d;
      aimY += (rand() * 2 - 1) * d;
    }
    const shot = {
      by: u.id, side: u.side, target: target.id, accurate, extra,
      t0: releaseAt, x0: u.x, y0: u.y, x1: aimX, y1: aimY,
      landed: releaseAt + Math.hypot(aimX - u.x, aimY - u.y) / p.speed,
      hit: null, sprite: p.sprite, arc: p.arc,
      dmg: extra ? secDmg[u.side] : dmg[u.side],
    };
    u.shots += 1;
    shots.push(shot);
    flying.push(shot);
  };

  // Where a projectile is along its flight at time `at` (ground position).
  const posAt = (s, at) => {
    const k = Math.max(0, Math.min(1, (at - s.t0) / Math.max(s.landed - s.t0, 1e-6)));
    return [s.x0 + (s.x1 - s.x0) * k, s.y0 + (s.y1 - s.y0) * k, k];
  };

  // Checked every step while the projectile flies. It hits its target if the
  // target is in its path (so units walking straight at the shooter are still
  // hit, while ones that step aside are missed). A missed shot can also come
  // down on another enemy near the end of its flight, for half damage.
  const fly = (s) => {
    const shooter = units[s.by];
    const p = shooter.f.projectile;
    const target = units[s.target];
    const [px, py, k] = posAt(s, t);
    const done = t >= s.landed - 1e-9;
    const foes = units.filter((e) => e.side !== s.side && alive(e));
    if (p.blast > 0) {
      if (!done) return false;
      // Area shot (grenadier): everything in the blast takes the damage.
      for (const e of foes) {
        if (Math.hypot(e.x - px, e.y - py) <= p.blast + e.r) { deal(shooter, e, s.dmg, t); s.hit = s.hit ?? e.id; }
      }
      return true;
    }
    if (p.pierces) {
      // Chakram: hits each enemy it passes through, once.
      s.struck = s.struck || new Set();
      for (const e of foes) {
        if (!s.struck.has(e.id) && inBox(e, px, py)) { s.struck.add(e.id); deal(shooter, e, s.dmg, t); s.hit = s.hit ?? e.id; }
      }
      return done;
    }
    if (alive(target) && inBox(target, px, py)) {
      deal(shooter, target, s.dmg, t);
      s.hit = target.id; s.landed = t; s.x1 = px; s.y1 = py;
      return true;
    }
    if (!s.accurate && k > 0.7) {
      const stray = foes.find((e) => e.id !== s.target && inBox(e, px, py));
      if (stray) {
        deal(shooter, stray, p.fullStray ? s.dmg : s.dmg / 2, t);
        s.hit = stray.id; s.landed = t; s.x1 = px; s.y1 = py;
        return true;
      }
    }
    return done;
  };

  const release = (u) => {
    const target = units[u.pending.target];
    const p = u.f.projectile;
    if (!p) {
      // Melee (and reach weapons): lands if the target is still close enough.
      if (alive(target) && edge(u, target) <= u.f.range + 0.5) deal(u, target, dmg[u.side], t);
      return;
    }
    // Extra arrows go in bursts; the first burst carries the main arrow.
    const bursts = u.pending.bursts;
    let n = 0;
    for (let b = 0; b < bursts.length; b++) {
      for (let k = 0; k < bursts[b]; k++, n++) {
        launch(u, target, n > 0 && Boolean(p.secondary), t + b * u.f.attackDelay + k * BURST_GAP);
      }
    }
  };

  const pickTarget = (u) => {
    if (u.target !== null && alive(units[u.target])) return units[u.target];
    let best = null;
    for (const e of enemies(u)) if (!best || centre(u, e) < centre(u, best)) best = e;
    u.target = best ? best.id : null;
    return best;
  };

  while (t < MAX_TIME && sideAlive(0) && sideAlive(1)) {
    // Everyone decides from the same snapshot, so nobody gets a head start
    // from being processed first.
    const moves = units.map(() => null);
    for (const u of units) {
      u.moving = false;
      if (!alive(u)) continue;
      let target = pickTarget(u);
      if (!target) continue;
      if (u.pending) continue;
      const minR = u.f.projectile ? u.f.minRange || 0 : 0;
      if (minR > 0 && edge(u, target) < minR) {
        // Too close to shoot: switch to an enemy that is in range, or step back.
        const alt = enemies(u).find((e) => edge(u, e) >= minR && edge(u, e) <= u.f.range);
        if (alt) { u.target = alt.id; target = alt; } else {
          const d = centre(u, target) || 1;
          moves[u.id] = [((u.x - target.x) / d) * u.f.speed * DT, ((u.y - target.y) / d) * u.f.speed * DT];
          continue;
        }
      }
      const reach = u.f.range;
      const gapNow = edge(u, target);
      if (gapNow > reach + 1e-9) {
        const step = Math.min(u.f.speed * DT, gapNow - reach);
        const d = centre(u, target) || 1;
        moves[u.id] = [((target.x - u.x) / d) * step, ((target.y - u.y) / d) * step];
      } else if (t >= u.ready) {
        const p = u.f.projectile;
        let bursts = [1];
        if (p) {
          const n = p.count;
          if (n > 1) {
            // Elite Chu Ko Nu: 5 arrows in 3 to 5 bursts (infosheet)
            const nb = Math.min(n, 3 + Math.floor(rand() * (n - 2)));
            bursts = Array.from({ length: nb }, (_, i) => Math.floor(n / nb) + (i < n % nb ? 1 : 0));
          }
        }
        u.pending = { at: t + u.f.attackDelay, started: t, target: target.id, bursts };
        u.attackStart = t;
        // Reload counts from the last burst for multi-arrow units (≈ infosheet's 3.6–4.1 s for Elite Chu Ko Nu).
        u.ready = t + u.f.reload + (bursts.length > 1 ? (bursts.length - 1) * u.f.attackDelay + 0.13 : 0);
        u.face = Math.sign(target.x - u.x) || u.face;
      }
    }
    // Apply moves, then push overlapping units apart.
    for (const u of units) {
      const m = moves[u.id];
      u.vx = 0; u.vy = 0;
      if (!m) continue;
      u.x += m[0]; u.y += m[1];
      u.vx = m[0] / DT; u.vy = m[1] / DT;
      u.moving = true;
      if (Math.abs(m[0]) > 1e-6) u.face = Math.sign(m[0]);
      const tg = u.target !== null ? units[u.target] : null;
      if (tg && Math.sign(tg.x - u.x)) u.face = Math.sign(tg.x - u.x) || u.face;
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!alive(u)) continue;
      for (let j = i + 1; j < units.length; j++) {
        const v = units[j];
        if (!alive(v)) continue;
        const d = centre(u, v);
        const need = u.r + v.r;
        if (d >= need - 1e-6) continue;
        const nx = d > 1e-6 ? (v.x - u.x) / d : 0;
        const ny = d > 1e-6 ? (v.y - u.y) / d : (i % 2 ? 1 : -1);
        const push = (need - d);
        // The unit that is standing still (e.g. attacking) gives way less.
        const wu = u.moving ? (v.moving ? 0.5 : 0.8) : (v.moving ? 0.2 : 0.5);
        u.x -= nx * push * wu; u.y -= ny * push * wu;
        v.x += nx * push * (1 - wu); v.y += ny * push * (1 - wu);
      }
    }
    // Blows and shots due this step are released together, so mutual kills are possible.
    const due = units.filter((u) => u.pending && alive(u) && t >= u.pending.at - 1e-9);
    for (const u of due) { release(u); u.pending = null; }
    for (const u of units) if (!alive(u) && u.pending) u.pending = null;
    // Projectiles in the air
    for (let k = flying.length - 1; k >= 0; k--) {
      if (t >= flying[k].t0 && fly(flying[k])) flying.splice(k, 1);
    }
    if (record) {
      frames.push({
        t,
        u: units.map((u) => [u.x, u.y, Math.max(0, u.hp), u.moving ? 1 : 0, u.face, u.attackStart]),
      });
    }
    t += DT;
  }
  // Shots still in the air when the fight ends finish their flight (for drawing).
  for (const s of flying) s.hit = null;

  const survivors = [0, 1].map((s) => units.filter((u) => u.side === s && alive(u)).length);
  const dead = [survivors[0] === 0, survivors[1] === 0];
  const winner = dead[0] && dead[1] ? null : dead[1] ? 0 : dead[0] ? 1 : null;
  const sum = (s, key) => units.filter((u) => u.side === s).reduce((acc, u) => acc + Math.max(0, u[key]), 0);
  return {
    frames,
    hits,
    shots,
    duration: t,
    winner,                 // 0, 1, or null for a draw / timeout
    timedOut: !dead[0] && !dead[1],
    damage: dmg,
    secondaryDamage: secDmg,
    seed,
    units: units.map((u) => ({ id: u.id, side: u.side, maxHp: u.f.hp, hpLeft: Math.max(0, u.hp), diedAt: u.diedAt, hits: u.hits, shots: u.shots })),
    sides: [0, 1].map((s) => ({
      count: units.filter((u) => u.side === s).length,
      survivors: survivors[s],
      hpLeft: sum(s, 'hp'),
      hpTotal: fighters[s].hp * units.filter((u) => u.side === s).length,
      hits: units.filter((u) => u.side === s).reduce((acc, u) => acc + u.hits, 0),
      shots: units.filter((u) => u.side === s).reduce((acc, u) => acc + u.shots, 0),
      dealt: units.filter((u) => u.side === s).reduce((acc, u) => acc + u.dealt, 0),
      diedAt: survivors[s] === 0 ? Math.max(...units.filter((u) => u.side === s).map((u) => u.diedAt ?? 0)) : null,
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
