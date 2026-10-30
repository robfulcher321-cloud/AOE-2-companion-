// Keeping joined phones in step with the host in a Wi-Fi game.
//
// The host runs the real game. About ten times a second it sends a snapshot of
// everything the screen shows (gold, buildings, soldiers, arrows, explosions);
// each joined phone copies it into its own World object and draws that,
// sliding soldiers smoothly between snapshots. Taps on a joined phone are sent
// to the host as commands and show up in the next snapshot.

const r2 = (v) => Math.round(v * 100) / 100;

/** Commands a joined player can send, and how the host runs them for that player. */
export const COMMANDS = {
  build: (w, p, a) => w.buy(p, 'build', a.key, a.plot),
  market: (w, p, a) => w.buy(p, 'market', null, a.plot),
  upgrade: (w, p, a) => w.buy(p, 'upgrade', a.id),
  research: (w, p, a) => w.buy(p, 'research', a.id),
  sell: (w, p, a) => w.sell(p, a.id),
  hold: (w, p, a) => w.toggleHold(p, a.id),
  go: (w, p) => w.go(p),
  blast: (w, p, a) => w.blast(p, a.x, a.y),
  age: (w, p) => w.buy(p, 'age'),
  chat: (w, p, a) => w.chat(p, a.text),
};

/** Snapshot of the host's world. `since`: send only events after this game time. */
export function snapshot(w, since) {
  // Chat goes by number, not time: a line sent while paused (or between two steps) shares the last snapshot's time.
  const chatFrom = w.chatSent || 0;
  w.chatSent = w.chatSeq || 0;
  return {
    t: r2(w.t),
    winner: w.winner,
    alive: w.alive,
    territory: w.territory,
    players: w.sides.map((s) => ({
      gold: Math.floor(s.gold), markets: s.markets, plots: s.plots, researched: [...s.researched],
      research: s.research, blasts: s.blasts, stats: s.stats, out: s.out || 0, age: s.age, aging: s.aging,
    })),
    structures: w.structures.map((b) => [
      b.id, b.kind === 'castle' ? 0 : 1, b.side, b.owner ?? -1, b.building, b.line ?? '', b.plot ?? -1,
      r2(b.x), r2(b.y), b.r, Math.max(0, Math.round(b.hp)), b.maxHp, b.tier ?? 0, b.hold ? 1 : 0, b.waiting ? 1 : 0,
      r2(b.timer ?? 0), b.every ?? 0, b.upgradedAt ?? -1, b.diedAt ?? -1, b.invested ?? 0,
    ]),
    units: w.units.map((u) => [
      u.id, u.side, u.owner, u.line, u.tier, r2(u.x), r2(u.y), Math.max(0, Math.round(u.hp * 10) / 10),
      u.face, u.moving ? 1 : 0, u.attackStart ?? -1, u.diedAt ?? -1,
      u.f.packs ? (u.packing === 'pack' ? 2 : u.packing === 'unpack' ? 3 : u.packed ? 1 : 0) : 0, r2(u.packStart ?? 0),
    ]),
    shots: w.shots.filter((s) => !s.done || w.t - s.t1 < 0.6).map((s) => [
      r2(s.x0), r2(s.y0), r2(s.x1), r2(s.y1), r2(s.t0), r2(s.t1), s.sprite || '', s.arc || 0, s.castle ? 1 : 0, s.landed ? 1 : 0,
    ]),
    effects: w.effects.map((e) => [r2(e.t), r2(e.x), r2(e.y), e.side, e.owner ?? -1]),
    events: w.events.filter((e) => (e.type === 'chat' ? e.n > chatFrom : e.t > since)).map((e) => ({ ...e, x: e.x !== undefined ? r2(e.x) : undefined, y: e.y !== undefined ? r2(e.y) : undefined })),
  };
}

/** Copies a snapshot into a joined phone's World so the screen and menus can read it. */
export function applySnapshot(w, snap) {
  w.t = snap.t;
  w.winner = snap.winner;
  w.alive = snap.alive;
  w.territory = snap.territory;
  snap.players.forEach((p, i) => {
    const s = w.sides[i];
    Object.assign(s, { gold: p.gold, markets: p.markets, plots: p.plots, research: p.research, blasts: p.blasts, stats: p.stats, out: p.out, aging: p.aging });
    if (p.researched.length !== s.researched.size || p.age !== s.age) {
      s.researched = new Set(p.researched);
      s.age = p.age;
      s.researchKey = `${[...s.researched].sort().join(',')}|${s.age}`;
    }
  });
  // Buildings and castles, keeping the same objects so the screen's selection sticks
  const byId = new Map(w.structures.map((b) => [b.id, b]));
  w.structures = snap.structures.map(([id, kind, side, owner, building, line, plot, x, y, r, hp, maxHp, tier, hold, waiting, timer, every, upgradedAt, diedAt, invested]) => {
    const b = byId.get(id) || { id, f: w.buildingStats(building) };
    Object.assign(b, {
      kind: kind === 0 ? 'castle' : 'building', side, building, x, y, r, hp, maxHp,
      tier, hold: Boolean(hold), waiting: Boolean(waiting), timer, every, invested,
      upgradedAt: upgradedAt < 0 ? undefined : upgradedAt, diedAt: diedAt < 0 ? undefined : diedAt,
    });
    if (kind === 1) { b.owner = owner; b.line = line; b.plot = plot; }
    return b;
  });
  w.castles = [0, 1].map((t) => w.structures.find((b) => b.kind === 'castle' && b.side === t));
  w.teams.forEach((t, i) => { t.castle = w.castles[i]; });
  w.sides.forEach((s) => { s.castle = w.castles[s.team]; });
  // Soldiers: last positions become the starting point for this round of sliding
  const units = new Map(w.units.map((u) => [u.id, u]));
  w.units = snap.units.map(([id, side, owner, line, tier, x, y, hp, face, moving, attackStart, diedAt, pack, packStart]) => {
    let u = units.get(id);
    const s = w.sides[owner];
    if (!u) u = { id, x, y, r: 0.2 };
    u.px = u.x; u.py = u.y;
    if (u.line !== line || u.tier !== tier || u.key !== s.researchKey) {
      u.f = w.kits[owner].fighter(line, tier, s.researched, s.researchKey, s.age);
      u.key = s.researchKey;
      u.r = u.f.radius;
    }
    Object.assign(u, { side, owner, line, tier, x, y, hp, face, moving: Boolean(moving),
      attackStart: attackStart < 0 ? null : attackStart, diedAt: diedAt < 0 ? null : diedAt,
      packed: pack === 1, packing: pack === 2 ? 'pack' : pack === 3 ? 'unpack' : null, packStart });
    return u;
  });
  w.shots = snap.shots.map(([x0, y0, x1, y1, t0, t1, sprite, arc, castle, landed]) => ({ x0, y0, x1, y1, t0, t1, sprite, arc, castle: Boolean(castle), landed: Boolean(landed) }));
  w.effects = snap.effects.map(([t, x, y, side, owner]) => ({ t, x, y, side, owner }));
  for (const e of snap.events) w.events.push(e);
  if (w.events.length > 200) w.events.splice(0, w.events.length - 200);
}
