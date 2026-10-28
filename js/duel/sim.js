// 1v1 simulation in game seconds.
// Units start apart and walk until the enemy is within range (measured edge to
// edge, as in the game), then attack on their reload timer. A blow or shot is
// released `attackDelay` seconds into each attack and is cancelled if the
// attacker dies first. Projectiles then fly at their own speed and still land
// if the shooter has died meanwhile.
//
// Ranged shots roll against accuracy. A missed shot lands somewhere within
// `spread` × distance of the target and can still hit it if it lands on the
// unit (or within the blast radius). Ranged units stand and shoot; they don't
// retreat from melee units (no micro), and minimum range isn't modelled.

import { damagePerHit } from './combat.js';

export const DT = 1 / 60;          // simulation step, game seconds
const MAX_TIME = 600;

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

export const hasRandomness = (a, b) => [a, b].some((f) => f.projectile && (f.projectile.accuracy < 100));

export function simulate(a, b, { startGap, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const fighters = [a, b];
  const sides = fighters.map((f) => ({ f, hp: f.hp, ready: 0, pending: null, hits: 0, shots: 0, dealt: 0, attackStart: null, diedAt: null }));
  const reach = (s) => s.f.range + a.radius + b.radius;
  // Start just outside the longer reach so ranged units walk into range too.
  const gap = startGap ?? Math.max(5, Math.max(a.range, b.range) + 2);
  const pos = [0, a.radius + b.radius + gap];
  const dmg = [damagePerHit(a, b), damagePerHit(b, a)];
  const secDmg = fighters.map((f, i) => (f.projectile?.secondary ? damagePerHit(f, fighters[1 - i], f.projectile.secondary.attacks) : 0));
  const frames = [];
  const hits = [];
  const shots = [];          // every projectile, for drawing
  const flying = [];         // projectiles still in the air
  let t = 0;

  const alive = (i) => sides[i].hp > 0;
  const deal = (i, amount, at) => {
    const j = 1 - i;
    if (sides[j].hp <= 0) return;
    sides[j].hp -= amount;
    sides[i].hits += 1;
    sides[i].dealt += amount;
    hits.push({ t: at, by: i, dmg: Math.round(amount * 100) / 100, hpAfter: Math.max(0, sides[j].hp) });
  };

  const release = (i) => {
    const s = sides[i];
    const p = s.f.projectile;
    if (!p) { deal(i, dmg[i], t); return; }
    const j = 1 - i;
    const dist = Math.abs(pos[j] - pos[i]);
    const targetR = fighters[j].radius;
    for (let n = 0; n < p.count; n++) {
      const extra = n > 0 && p.secondary;
      // Where it comes down relative to the target, in tiles (along, across).
      let off = [0, 0];
      let hit = rand() * 100 < p.accuracy;
      if (!hit) {
        const r = Math.sqrt(rand()) * p.spread * Math.max(dist, 1);
        const ang = rand() * Math.PI * 2;
        off = [Math.cos(ang) * r, Math.sin(ang) * r];
        hit = Math.hypot(off[0], off[1]) <= targetR + (p.blast || 0);
      } else if (p.count > 1) {
        const ang = rand() * Math.PI * 2;
        off = [Math.cos(ang) * targetR * 0.6, Math.sin(ang) * targetR * 0.6];
      }
      const shot = { by: i, t0: t, x0: pos[i], x: pos[i], off, hit, dmg: extra ? secDmg[i] : dmg[i], landed: null, x1: null, speed: p.speed, sprite: p.sprite, arc: p.arc };
      s.shots += 1;
      shots.push(shot);
      flying.push(shot);
    }
  };

  while (t < MAX_TIME && alive(0) && alive(1)) {
    // Both units decide from the same snapshot, so neither gets a head start
    // from being processed first.
    const dist = Math.abs(pos[1] - pos[0]);
    const steps = [0, 0];
    for (let i = 0; i < 2; i++) {
      const me = sides[i];
      if (dist > reach(me) + 1e-9 && !me.pending) {
        steps[i] = Math.min(me.f.speed * DT, dist - reach(me));
      } else if (!me.pending && t >= me.ready) {
        me.pending = { at: t + me.f.attackDelay, started: t };
        me.attackStart = t;
        me.ready = t + me.f.reload;
      }
    }
    // Don't let two approaching units overshoot each other's reach.
    const movers = [0, 1].filter((i) => steps[i] > 0);
    if (movers.length) {
      const room = dist - Math.max(...movers.map((i) => reach(sides[i])));
      const total = steps[0] + steps[1];
      const k = total > room ? Math.max(0, room) / total : 1;
      pos[0] += steps[0] * k;
      pos[1] -= steps[1] * k;
    }
    // Blows and shots due this step are released together, so mutual kills are possible.
    const due = [0, 1].filter((i) => sides[i].pending && t >= sides[i].pending.at - 1e-9);
    for (const i of due) { release(i); sides[i].pending = null; }
    // Projectiles fly toward where the target is now (straight line, so no
    // leading is needed) and land when they reach it.
    for (let k = flying.length - 1; k >= 0; k--) {
      const p = flying[k];
      const tx = pos[1 - p.by] + p.off[0] * (p.by === 0 ? 1 : -1);
      const dir = Math.sign(tx - p.x) || 0;
      const step = p.speed * DT;
      if (Math.abs(tx - p.x) <= step) {
        p.x = tx; p.x1 = tx; p.landed = t;
        if (p.hit) deal(p.by, p.dmg, t);
        flying.splice(k, 1);
      } else {
        p.x += dir * step;
      }
    }
    for (const s of sides) if (s.hp <= 0 && s.diedAt === null) s.diedAt = t;
    frames.push({
      t,
      x: [pos[0], pos[1]],
      hp: [Math.max(0, sides[0].hp), Math.max(0, sides[1].hp)],
      swing: sides.map((s) => (s.pending ? (t - s.pending.started) / Math.max(s.pending.at - s.pending.started, 0.15) : 0)),
      moving: [steps[0] > 0, steps[1] > 0],
      attackStart: [sides[0].attackStart, sides[1].attackStart],
    });
    t += DT;
  }
  // Arrows already in the air when the fight ends still finish their flight (for drawing).
  for (const p of flying) {
    const tx = pos[1 - p.by] + p.off[0] * (p.by === 0 ? 1 : -1);
    p.x1 = tx;
    p.landed = t + Math.abs(tx - p.x) / p.speed;
  }

  const dead = [!alive(0), !alive(1)];
  const winner = dead[0] && dead[1] ? null : dead[1] ? 0 : dead[0] ? 1 : null;
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
    sides: sides.map((s) => ({ hpLeft: Math.max(0, s.hp), hits: s.hits, shots: s.shots, dealt: s.dealt, diedAt: s.diedAt })),
  };
}

/**
 * Runs the matchup many times with different random seeds (only when there is
 * randomness) and returns win rates plus one representative fight to show:
 * one won by the most common winner, with a typical length.
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
    const r = simulate(a, b, { ...opts, seed: s });
    wins[r.winner === null ? 2 : r.winner] += 1;
    outcomes.push({ seed: s, winner: r.winner, duration: r.duration, hpLeft: r.winner === null ? 0 : r.sides[r.winner].hpLeft });
  }
  const top = wins[0] >= wins[1] && wins[0] >= wins[2] ? 0 : wins[1] >= wins[2] ? 1 : null;
  const pool = outcomes.filter((o) => o.winner === top);
  const byHp = [...pool].sort((x, y) => x.hpLeft - y.hpLeft);
  const pick = byHp[Math.floor(byHp.length / 2)] || outcomes[0];
  const result = simulate(a, b, { ...opts, seed: pick.seed });
  return { result, runs, wins, rates: wins.map((w) => w / runs) };
}
