// Deterministic 1v1 melee simulation in game seconds.
// Units start apart, walk until in reach, then attack on their reload timer.
// A blow lands `attackDelay` seconds into each attack cycle, and is cancelled
// if the attacker dies before it lands.

import { damagePerHit } from './combat.js';

export const DT = 1 / 60;          // simulation step, game seconds
const MAX_TIME = 600;

export function simulate(a, b, { startGap = 5 } = {}) {
  const sides = [a, b].map((f) => ({ f, hp: f.hp, ready: 0, pending: null, hits: 0, dealt: 0, contactAt: null }));
  const reach = (s) => s.f.range + a.radius + b.radius;
  // positions in tiles along one axis; gap is edge-to-edge
  const pos = [0, a.radius + b.radius + startGap];
  const dmg = [damagePerHit(a, b), damagePerHit(b, a)];
  const frames = [];
  const hits = [];
  let t = 0;

  const alive = (i) => sides[i].hp > 0;

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
        if (me.contactAt === null) me.contactAt = t;
        me.pending = { at: t + me.f.attackDelay, started: t };
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
    // Resolve blows due this step simultaneously, so mutual kills are possible.
    const due = [0, 1].filter((i) => sides[i].pending && t >= sides[i].pending.at - 1e-9);
    for (const i of due) {
      const j = 1 - i;
      sides[j].hp -= dmg[i];
      sides[i].hits += 1;
      sides[i].dealt += dmg[i];
      hits.push({ t, by: i, dmg: dmg[i], hpAfter: Math.max(0, sides[j].hp) });
      sides[i].pending = null;
    }
    frames.push({
      t,
      x: [pos[0], pos[1]],
      hp: [Math.max(0, sides[0].hp), Math.max(0, sides[1].hp)],
      swing: sides.map((s) => (s.pending ? (t - s.pending.started) / Math.max(s.pending.at - s.pending.started, 0.15) : 0)),
    });
    t += DT;
  }

  const dead = [!alive(0), !alive(1)];
  const winner = dead[0] && dead[1] ? null : dead[1] ? 0 : dead[0] ? 1 : null;
  return {
    frames,
    hits,
    duration: t,
    winner,                 // 0, 1, or null for a draw / timeout
    timedOut: !dead[0] && !dead[1],
    damage: dmg,
    sides: sides.map((s) => ({ hpLeft: Math.max(0, s.hp), hits: s.hits, dealt: s.dealt })),
  };
}
