// Draws an AOSiege game: the lane on the game's grass, buildings as their
// icons on stone platforms (with the unit they train on a badge above), units
// with their in-game animations, and a minimap. Also turns touches into
// actions: drag to look around, tap a plot or building, press and hold a building.

import { LANE, CASTLE_X, RIVER, BLAST } from './world.js';
import { TEAM_RGB } from '../duel/spritepack.js';

const TILE = 96 / Math.SQRT2;   // screen px per tile at zoom 1 (same as the Test arena)
const DEPTH = 0.5;
const SIDE = ['#4a8de3', '#d5473d'];
const SIDE_DARK = ['#1f3f73', '#6e1f19'];
const MAX_DPR = 2;   // sharper than this costs a lot of drawing on 3x phone screens for little visible gain

/** Player colours. The first two are the sprite pack's own blue and red; others are repainted. */
export const COLOURS = [
  { name: 'Blue', hex: '#2f6fe0' }, { name: 'Red', hex: '#d6322b' }, { name: 'Green', hex: '#3bb143' }, { name: 'Yellow', hex: '#e8cf2b' },
  { name: 'Teal', hex: '#2bc8d6' }, { name: 'Purple', hex: '#a04fe0' }, { name: 'Grey', hex: '#a0a0a0' }, { name: 'Orange', hex: '#ee8a2b' },
];
const rgbOf = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = Math.max(...c, 1);
  return c.map((v) => Math.round((v * 236) / m));
};
const BUILDING_KIND = { 12: 'barracks', 87: 'archery', 101: 'stable', 82: 'castle', 84: 'market', 103: 'blacksmith', 49: 'workshop', 104: 'monastery' };

export class SiegeView {
  /** handlers: { tapPlot(i), tapBuilding(b), holdBuilding(b) } */
  constructor(canvas, mini, handlers = {}) {
    this.handlers = handlers;
    this.selected = null;     // building id highlighted while its menu is open
    this.selectedPlot = null;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = mini;
    this.mctx = mini.getContext('2d');
    this.cam = { x: 14, zoom: 0.55 };
    this.follow = true;
    this.lastTouch = 0;
    this.floaters = [];
    this.seen = 0;
    this.tinted = new Map();   // unit or building + colour -> its tinted sprite (or 'pending' / 'failed')
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas); ro.observe(mini);
    this.bindPan();
  }

  /**
   * mySide: the player this screen belongs to. colours: each player's chosen colour,
   * on their buildings, the minimap and their soldiers (blue and red come straight
   * from the sprite pack; other colours are repainted in a worker the first time
   * that unit is needed).
   */
  setup(world, { sprites = null, unitIcons = {}, buildingIcons = {}, mySide = 0, colours = null, civs = [] } = {}) {
    this.w = world;
    this.sprites = sprites;
    this.unitIcons = unitIcons;
    this.buildingIcons = buildingIcons;
    this.me = mySide;
    this.myTeam = world.sides[mySide].team;
    this.colours = colours || world.sides.map((s) => SIDE[s.team]);
    // The pack's own blue and red, or any other colour (brightest channel scaled like theirs)
    this.paint = this.colours.map((hex) => (hex === COLOURS[0].hex ? 'blue' : hex === COLOURS[1].hex ? 'red' : rgbOf(hex)));
    this.civs = civs;
    this.grassPattern = null;
    this.follow = true;
    this.cam.x = CASTLE_X[this.myTeam] + (this.myTeam === 0 ? 6 : -6);
    this.floaters = [];
    this.seen = world.events.length;
  }

  resize() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    for (const [c, key] of [[this.canvas, 'ctx'], [this.mini, 'mctx']]) {
      const { width, height } = c.getBoundingClientRect();
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      this[key].setTransform(dpr, 0, 0, dpr, 0, 0);
      if (c === this.canvas) { this.vw = width; this.vh = height; } else { this.mw = width; this.mh = height; }
    }
    // Fit the lane's width (top to bottom) to the view.
    // (the outermost tile of each edge may be cut off, so units stay a readable size)
    if (this.vh) this.cam.zoom = Math.max(0.3, Math.min(1, (this.vh - 50) / ((LANE.half * 2 - 1) * TILE * DEPTH)));
  }

  // ---------- Camera ----------

  bindPan() {
    // One finger: a short tap acts on what's under it, holding still for half a
    // second opens a building's menu, and moving pans the view.
    let p = null;
    const HOLD_MS = 450;
    const SLOP = 10;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      const r = this.canvas.getBoundingClientRect();
      p = { x0: e.clientX, y0: e.clientY, sx: e.clientX - r.left, sy: e.clientY - r.top, camX: this.cam.x, moved: false, used: false };
      const hit = this.hitTest(p.sx, p.sy);
      if (hit?.b && !this.aiming) {
        p.timer = setTimeout(() => {
          if (p && !p.moved) { p.used = true; navigator.vibrate?.(20); this.handlers.holdBuilding?.(hit.b); }
        }, HOLD_MS);
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!p) return;
      if (!p.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > SLOP) { p.moved = true; clearTimeout(p.timer); this.follow = false; }
      if (p.moved) {
        this.cam.x = p.camX - (e.clientX - p.x0) / (TILE * this.cam.zoom);
        this.clampCam();
        this.lastTouch = performance.now();
      }
    });
    const end = (e, cancelled) => {
      if (!p) return;
      clearTimeout(p.timer);
      if (!cancelled && !p.moved && !p.used && this.aiming) {
        // Aiming the explosion: wherever was tapped
        const [wx, wy] = this.toWorld(p.sx, p.sy);
        this.handlers.aimAt?.(wx, wy);
      } else if (!cancelled && !p.moved && !p.used) {
        const hit = this.hitTest(p.sx, p.sy);
        if (hit?.b) this.handlers.tapBuilding?.(hit.b);
        else if (hit?.plot !== undefined) this.handlers.tapPlot?.(hit.plot);
        else this.handlers.tapEmpty?.();
      }
      p = null;
    };
    this.canvas.addEventListener('pointerup', (e) => end(e, false));
    this.canvas.addEventListener('pointercancel', (e) => end(e, true));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Minimap: tap or drag to look somewhere.
    const jump = (e) => {
      const r = this.mini.getBoundingClientRect();
      this.cam.x = ((e.clientX - r.left) / r.width) * LANE.length;
      this.clampCam();
      this.follow = false;
      this.lastTouch = performance.now();
    };
    let mdown = false;
    this.mini.addEventListener('pointerdown', (e) => { mdown = true; this.mini.setPointerCapture(e.pointerId); jump(e); });
    this.mini.addEventListener('pointermove', (e) => { if (mdown) jump(e); });
    this.mini.addEventListener('pointerup', () => { mdown = false; });
  }

  /** Your building or empty plot under a screen point (CSS px in the canvas). */
  hitTest(px, py) {
    if (!this.w) return null;
    // Buildings: their platform and the icon standing on it
    let best = null;
    for (const b of this.w.structures) {
      if (b.owner !== this.me || b.kind !== 'building' || b.hp <= 0) continue;
      const box = this.boxOf(b);
      if (px >= box.x0 - 6 && px <= box.x1 + 6 && py >= box.y0 - 6 && py <= box.y1 + 6) {
        if (!best || box.y1 > best.box.y1) best = { b, box };
      }
    }
    if (best) return { b: best.b };
    for (let i = 0; i < this.w.plotCount(this.me); i++) {
      if (this.w.sides[this.me].plots[i]) continue;
      const [x, y] = this.w.plotPos(this.me, i);
      const [lx, ty] = this.toScreen(x - 1.5, y - 1.5);
      const [rx, by] = this.toScreen(x + 1.5, y + 1.5);
      if (px >= lx && px <= rx && py >= ty - 10 && py <= by + 4) return { plot: i };
    }
    return null;
  }

  /** Screen box covering a building's platform, icon and badge. */
  boxOf(b) {
    const ppt = TILE * this.cam.zoom;
    const half = b.r * 0.95;
    const [lx, ty] = this.toScreen(b.x - half, b.y - half);
    const [rx, by] = this.toScreen(b.x + half, b.y + half);
    const [, sy] = this.toScreen(b.x, b.y);
    const castle = b.kind === 'castle';
    const lift = Math.max(5, (castle ? 16 : 10) * this.cam.zoom);
    const size = Math.max(26, b.r * 2 * ppt * (castle ? 0.46 : 0.5));
    const iy = sy - lift - size * 0.8;
    return { x0: lx, x1: rx, y0: iy - 16, y1: by, size, iy, lift, lx, rx, ty, by };
  }

  clampCam() {
    const half = this.vw / (2 * TILE * this.cam.zoom);
    this.cam.x = Math.max(half - 1, Math.min(LANE.length + 1 - half, this.cam.x));
  }

  /** Follow the fighting: the furthest your units have pushed, or where the enemy is coming. */
  autoCam() {
    if (!this.follow && performance.now() - this.lastTouch > 8000) this.follow = true;
    if (!this.follow) return;
    const live = this.w.units.filter((u) => u.hp > 0);
    const team = this.myTeam;
    const dir = team === 0 ? 1 : -1;
    let target = CASTLE_X[team] + dir * 8;
    const mine = live.filter((u) => u.side === team);
    const theirs = live.filter((u) => u.side !== team);
    // Where the two armies meet, else the front of whichever army exists.
    const front = (arr, s) => (arr.length ? (s === 0 ? Math.max(...arr.map((u) => u.x)) : Math.min(...arr.map((u) => u.x))) : null);
    const a = front(mine, team);
    const b = front(theirs, 1 - team);
    if (a !== null && b !== null) target = dir > 0 ? Math.min(a, b) + 2 : Math.max(a, b) - 2;
    else if (a !== null) target = a;
    else if (b !== null) target = b;
    this.cam.x += (target - this.cam.x) * 0.04;
    this.clampCam();
  }

  /** Screen point (CSS px in the canvas) to lane position. */
  toWorld(px, py) {
    const ppt = TILE * this.cam.zoom;
    return [this.cam.x + (px - this.vw / 2) / ppt, (py - this.vh * 0.56) / (ppt * DEPTH)];
  }

  toScreen(x, y) {
    const ppt = TILE * this.cam.zoom;
    return [this.vw / 2 + (x - this.cam.x) * ppt, this.vh * 0.56 + y * ppt * DEPTH];
  }

  // ---------- Drawing ----------

  /**
   * alpha: how far between the last two game steps to draw soldiers (0..1).
   * renderT: the game time those positions belong to, used for everything that
   * moves with time (animations, arrows, explosions) so it all glides together
   * instead of jumping a step at a time.
   */
  draw(alpha = 1, renderT = null) {
    if (!this.w || !this.vw) return;
    this.autoCam();
    const { ctx, vw, vh } = this;
    const zoom = this.cam.zoom;
    const ppt = TILE * zoom;
    const t = renderT ?? this.w.t;

    // Ground
    if (this.sprites?.grass) {
      if (!this.grassPattern) this.grassPattern = ctx.createPattern(this.sprites.grass, 'repeat');
      const [ox, oy] = this.toScreen(0, 0);
      this.grassPattern.setTransform(new DOMMatrix().translateSelf(ox, oy).scaleSelf(1, 0.5).rotateSelf(45).scaleSelf(zoom * 0.5));
      ctx.fillStyle = this.grassPattern;
    } else ctx.fillStyle = '#4c6a33';
    ctx.fillRect(0, 0, vw, vh);
    // Outside the lane: darker
    const [, top] = this.toScreen(0, -LANE.half - 0.6);
    const [, bottom] = this.toScreen(0, LANE.half + 0.6);
    ctx.fillStyle = 'rgb(10 18 6 / .45)';
    ctx.fillRect(0, 0, vw, top);
    ctx.fillRect(0, bottom, vw, vh - bottom);
    // Midline
    const [mx] = this.toScreen(LANE.length / 2, 0);
    ctx.strokeStyle = 'rgb(255 255 255 / .12)';
    ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(mx, top); ctx.lineTo(mx, bottom); ctx.stroke();
    ctx.setLineDash([]);
    this.drawRiver(t);
    this.drawScorch(t);

    // Empty plots on your side
    const used = new Set(this.w.sides[this.me].plots.map((id, i) => (id ? i : -1)));
    for (let i = 0; i < this.w.plotCount(this.me); i++) {
      if (used.has(i)) continue;
      const [x, y] = this.w.plotPos(this.me, i);
      const sel = this.selectedPlot === i;
      this.diamond(x, y, 1.4, sel ? 'rgb(255 217 122 / .25)' : 'rgb(255 248 220 / .06)', sel ? '#ffd97a' : 'rgb(255 248 220 / .22)');
      if (!this.w.t || this.w.sides[this.me].plots.every((p) => !p)) {
        // Before the first building: a "+" on each plot says what to tap
        const [px, py] = this.toScreen(x, y);
        this.ctx.fillStyle = 'rgb(255 248 220 / .35)';
        this.ctx.font = `700 ${Math.round(18 + 10 * this.cam.zoom)}px sans-serif`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText('+', px, py + 8);
      }
    }

    // Everything that stands, back to front
    const items = [];
    for (const b of this.w.structures) items.push({ y: b.y, b });
    for (const u of this.w.units) {
      const x = u.px + (u.x - u.px) * alpha;
      const y = u.py + (u.y - u.py) * alpha;
      items.push({ y: u.hp > 0 ? y : y - 100, u, x, uy: y });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      if (it.b) this.drawStructure(it.b, t, ppt);
      else this.drawUnit(it.u, it.x, it.uy, t, zoom);
    }
    this.drawShots(t, zoom, ppt);
    this.drawBlasts(t);
    this.drawFloaters(t, zoom);
    this.drawMini();
  }

  // The river splitting the middle of the map into two lanes
  drawRiver(t) {
    const { ctx } = this;
    const [x0, y0] = this.toScreen(RIVER.x0, -RIVER.half);
    const [x1, y1] = this.toScreen(RIVER.x1, RIVER.half);
    if (x1 < 0 || x0 > this.vw) return;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#2f5d73'); g.addColorStop(0.5, '#3d7590'); g.addColorStop(1, '#2f5d73');
    ctx.fillStyle = '#6b5a3a';   // muddy banks
    ctx.fillRect(x0 - 6, y0 - 5, x1 - x0 + 12, y1 - y0 + 10);
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // ripples drifting along
    ctx.strokeStyle = 'rgb(220 240 255 / .25)';
    ctx.lineWidth = 1.5;
    const ppt = TILE * this.cam.zoom;
    for (let k = 0; k < 6; k++) {
      const yy = y0 + ((k + 0.5) / 6) * (y1 - y0);
      const off = ((t * 0.6 + k * 1.7) % 3) * ppt;
      for (let xx = x0 + off; xx < x1 - 10; xx += 3 * ppt) {
        ctx.beginPath(); ctx.moveTo(xx, yy); ctx.quadraticCurveTo(xx + 6, yy - 3, xx + 12, yy); ctx.stroke();
      }
    }
  }

  ellipse(x, y, r, fill) {
    const [sx, sy] = this.toScreen(x, y);
    const ppt = TILE * this.cam.zoom;
    this.ctx.beginPath();
    this.ctx.ellipse(sx, sy, r * ppt, r * ppt * DEPTH, 0, 0, Math.PI * 2);
    this.ctx.fillStyle = fill;
    this.ctx.fill();
  }

  // Scorched ground where an explosion went off, fading over 8 seconds
  drawScorch(t) {
    for (const e of this.w.effects) {
      const age = t - e.t;
      if (age > 8) continue;
      this.ellipse(e.x, e.y, BLAST.radius * 0.9, `rgb(30 20 10 / ${0.45 * (1 - age / 8)})`);
    }
  }

  // The blast itself: a flash and an expanding ring of fire
  drawBlasts(t) {
    const { ctx } = this;
    const ppt = TILE * this.cam.zoom;
    for (const e of this.w.effects) {
      const age = t - e.t;
      if (age > 1.4) continue;
      const k = age / 1.4;
      const [sx, sy] = this.toScreen(e.x, e.y);
      if (age < 0.25) this.ellipse(e.x, e.y, BLAST.radius * (0.4 + age * 2.4), `rgb(255 245 200 / ${0.85 - age * 2})`);
      ctx.beginPath();
      ctx.ellipse(sx, sy, BLAST.radius * ppt * (0.3 + k * 0.8), BLAST.radius * ppt * DEPTH * (0.3 + k * 0.8), 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgb(255 140 40 / ${1 - k})`;
      ctx.lineWidth = 10 * (1 - k) + 2;
      ctx.stroke();
      // a column of smoke and fire rising
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + e.x;
        const rr = BLAST.radius * ppt * 0.35 * k;
        ctx.fillStyle = i % 2 ? `rgb(255 120 30 / ${0.7 * (1 - k)})` : `rgb(70 60 50 / ${0.6 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a) * rr, sy - k * 60 - Math.sin(a) * rr * DEPTH, (10 + 18 * k) * this.cam.zoom * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Aiming: darken where it can't go (outside your third), then the area it would hit
    if (this.aiming) {
      const [z0, z1] = this.w.blastZone(this.myTeam);
      const [sx0] = this.toScreen(z0, 0);
      const [sx1] = this.toScreen(z1, 0);
      ctx.fillStyle = 'rgb(0 0 0 / .35)';
      if (sx0 > 0) ctx.fillRect(0, 0, sx0, this.vh);
      if (sx1 < this.vw) ctx.fillRect(sx1, 0, this.vw - sx1, this.vh);
      ctx.strokeStyle = 'rgb(255 170 60 / .9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      for (const ex of [sx0, sx1]) if (ex > 0 && ex < this.vw) { ctx.moveTo(ex, 0); ctx.lineTo(ex, this.vh); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.aiming && this.aimPoint) {
      const [ax, ay] = this.toScreen(this.aimPoint[0], this.aimPoint[1]);
      this.ellipse(this.aimPoint[0], this.aimPoint[1], BLAST.radius, 'rgb(255 120 30 / .18)');
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = 'rgb(255 170 60 / .95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(ax, ay, BLAST.radius * ppt, BLAST.radius * ppt * DEPTH, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  diamond(x, y, half, fill, stroke) {
    const { ctx } = this;
    const pts = [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]].map(([px, py]) => this.toScreen(px, py));
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }

  drawStructure(b, t, ppt) {
    const { ctx } = this;
    const [sx] = this.toScreen(b.x, b.y);
    if (sx < -200 || sx > this.vw + 200) return;
    const dead = b.hp <= 0;
    const { size, iy, lift, lx, rx, ty, by } = this.boxOf(b);
    const zoom = this.cam.zoom;
    ctx.globalAlpha = dead ? Math.max(0, 1 - (t - b.diedAt) / 3) : 1;
    const selected = this.selected === b.id;
    const own = b.owner !== undefined ? this.colours[b.owner] : SIDE[b.side];
    // The building itself: the game's graphic for the owner's civ, in their colour.
    // (Until it's ready, or without the graphics: a stone platform.)
    const bs = this.buildingSprite(b);
    let spriteTop = null;
    if (bs) {
      const [fx, fy, fw, fh, ax, ay] = bs.frame;
      const [gx, gy] = this.toScreen(b.x, b.y);
      const k = ((rx - lx) * (b.kind === 'castle' ? 1.3 : 1.3)) / fw;
      if (selected) this.diamond(b.x, b.y, b.r * 1.05, 'rgb(255 217 122 / .18)', '#ffd97a');
      ctx.drawImage(bs.atlas, fx, fy, fw, fh, gx - ax * k, gy - ay * k, fw * k, fh * k);
      if (dead) ctx.globalAlpha *= 0.5;
      spriteTop = gy - ay * k;
    } else {
      // A raised stone platform: front face, then the top in the side's trim
      ctx.fillStyle = dead ? '#2a241c' : '#4b4335';
      ctx.fillRect(lx, by - lift, rx - lx, lift + 2);
      ctx.fillStyle = dead ? '#3a3328' : '#7a7160';
      ctx.fillRect(lx, ty - lift, rx - lx, by - ty);
      ctx.strokeStyle = selected ? '#ffd97a' : own; ctx.lineWidth = selected ? 3 : 2;
      ctx.strokeRect(lx, ty - lift, rx - lx, by - ty);
    }
    // The picture on the platform: for a training building, the unit it makes now
    // (it changes when you upgrade), with the building's own icon small in the corner.
    const trains = b.kind === 'building' && b.line !== 'market';
    const line = trains ? this.w.line(b.owner, b.line) : null;
    const unitImg = trains ? this.unitIcons[line.tiers[b.tier].unitId] : null;
    if (trains) {
      const f = this.w.kits[b.owner].fighter(b.line, b.tier);
      this.spriteFor(f.unitId, b.owner);
      if (f.walkAs) this.spriteFor(f.walkAs, b.owner);
    }   // get its soldiers' colours ready before they come out
    const bImg = this.buildingIcons[b.building];
    const main = unitImg?.complete && unitImg.naturalWidth ? unitImg : bImg;
    // A short pop and gold flash right after an upgrade
    const since = b.upgradedAt !== undefined ? Math.max(0, t - b.upgradedAt) : 99;
    const pop = since < 0.6 ? 1 + 0.18 * Math.sin((since / 0.6) * Math.PI) : 1;
    // With the building graphic, the unit it trains is a smaller badge over its roof.
    const base = bs ? size * 0.62 : size;
    const sz = base * pop;
    const ix = sx - sz / 2;
    const iy2 = (bs ? Math.max(spriteTop - base * 0.35, iy - base) : iy) - (sz - base);
    if (bs && (!trains || b.kind === 'castle')) {
      // Castle and Market: no badge, just their bars
      ctx.globalAlpha = 1;
      if (dead) return;
      const bw = Math.max(40, (rx - lx) * 0.8);
      this.bar(sx - bw / 2, spriteTop - 4, bw, 5, b.hp / b.maxHp);
      return;
    }
    ctx.fillStyle = SIDE_DARK[b.side];
    ctx.fillRect(ix - 3, iy2 - 3, sz + 6, sz + 6);
    if (main?.complete && main.naturalWidth) {
      ctx.drawImage(main, ix, iy2, sz, sz);
      // Destroyed: darkened. (A canvas filter would be simpler but is very slow on phones.)
      if (dead) { ctx.fillStyle = 'rgb(20 16 10 / .65)'; ctx.fillRect(ix, iy2, sz, sz); }
    } else {
      ctx.fillStyle = '#8a7a5a';
      ctx.fillRect(ix, iy2, sz, sz);
    }
    const frame = selected ? '#ffd97a' : b.hold ? '#6cc3ff' : own;
    ctx.strokeStyle = frame; ctx.lineWidth = 2.5;
    ctx.strokeRect(ix - 2, iy2 - 2, sz + 4, sz + 4);
    if (since < 1.2 && !dead) {
      ctx.strokeStyle = `rgb(255 217 122 / ${1 - since / 1.2})`;
      ctx.lineWidth = 4;
      const g = 4 + since * 14;
      ctx.strokeRect(ix - g, iy2 - g, sz + 2 * g, sz + 2 * g);
    }
    ctx.globalAlpha = 1;
    if (dead) return;
    if (trains) {
      // Building icon in the bottom-left corner
      const c = Math.max(12, sz * 0.36);
      ctx.fillStyle = SIDE_DARK[b.side];
      ctx.fillRect(ix - 4, iy2 + sz - c + 4, c + 2, c + 2);
      if (bImg?.complete && bImg.naturalWidth) ctx.drawImage(bImg, ix - 3, iy2 + sz - c + 5, c, c);
      ctx.strokeStyle = frame; ctx.lineWidth = 1.5;
      ctx.strokeRect(ix - 4, iy2 + sz - c + 4, c + 2, c + 2);
      // Upgrade step in the top-right corner: I, II, III...
      if (b.tier > 0) {
        const label = ['I', 'II', 'III', 'IV', 'V', 'VI'][b.tier];
        ctx.font = `700 ${Math.round(10 + 4 * zoom)}px "Merriweather", Georgia, serif`;
        ctx.textAlign = 'right';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgb(0 0 0 / .85)';
        ctx.strokeText(label, ix + sz - 2, iy2 + 13 + 3 * zoom);
        ctx.fillStyle = '#ffd97a';
        ctx.fillText(label, ix + sz - 2, iy2 + 13 + 3 * zoom);
      }
    }
    const top = iy2 - 12;
    // HP bar
    const bw = Math.max(40, sz + 6);
    this.bar(sx - bw / 2, top, bw, 5, b.hp / b.maxHp);
    // Training bar: fills until the next unit comes out. Held: blue, and glowing when the unit is waiting.
    if (trains && b.every) {
      const frac = b.waiting ? 1 : 1 - Math.max(0, b.timer) / b.every;
      const h = Math.max(5, 6 * zoom);
      const y = bs ? by + 2 : iy2 + sz + 5;
      ctx.fillStyle = 'rgb(0 0 0 / .6)';
      ctx.fillRect(ix - 3, y - 1, sz + 6, h + 2);
      ctx.fillStyle = b.hold ? '#4fb0ff' : '#e8d9a8';
      ctx.fillRect(ix - 2, y, (sz + 4) * frac, h);
      if (b.waiting) {
        // Ready and waiting for GO: a pulsing outline (shadow blur is too slow on phones)
        ctx.strokeStyle = `rgb(140 210 255 / ${0.45 + 0.45 * Math.sin(performance.now() / 160)})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(ix - 5, y - 3, sz + 10, h + 6);
      }
    }
  }

  bar(x, y, w, h, frac) {
    const { ctx } = this;
    ctx.fillStyle = 'rgb(0 0 0 / .7)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = frac > 0.5 ? '#3fcf3f' : frac > 0.25 ? '#e8c23a' : '#e2412e';
    ctx.fillRect(x, y, w * Math.max(0, frac), h);
  }

  /**
   * The sprite to draw a unit with, in its player's colour: { sprite, side } where
   * side says which frames ('blue' face right, 'red' face left). Colours are
   * applied in the background (spritepack tint) the first time a unit is needed;
   * buildings ask for theirs as soon as they're built, so it's ready before the
   * first soldier comes out. Until then: any colour already made, else the icon.
   */
  spriteFor(unitId, player) {
    const pack = this.sprites?.pack;
    if (!pack?.has(unitId)) return { sprite: null, side: 'blue' };
    const paint = this.paint?.[player] ?? 'blue';
    const team = typeof paint === 'string';
    const key = team ? `${unitId}|team` : `${unitId}|${paint.join(',')}`;
    const got = this.tinted.get(key);
    if (got && typeof got === 'object') return { sprite: got, side: team ? paint : 'blue' };
    if (!got) {
      this.tinted.set(key, 'pending');
      (team ? pack.unit(unitId) : pack.unitIn(unitId, paint))
        .then((sp) => this.tinted.set(key, sp || 'failed'), () => this.tinted.set(key, 'failed'));
    }
    const any = this.tinted.get(`${unitId}|team`);
    return typeof any === 'object' ? { sprite: any, side: team ? paint : 'blue' } : { sprite: null, side: 'blue' };
  }

  /** A structure's building graphic, in its owner's colour and civ's architecture: { atlas, frame } or null. */
  buildingSprite(b) {
    const pack = this.sprites?.pack;
    const kind = BUILDING_KIND[b.building];
    if (!pack || !kind) return null;
    const player = b.owner ?? this.w.teams[b.side].players[0];
    const name = pack.buildingSet(this.civs?.[player])?.[kind];
    if (!name) return null;
    const paint = this.paint?.[player] ?? 'blue';
    const rgb = typeof paint === 'string' ? TEAM_RGB[paint] : paint;
    const key = `${name}|${rgb.join(',')}`;
    const got = this.tinted.get(key);
    if (got && typeof got === 'object') return got;
    if (!got) {
      this.tinted.set(key, 'pending');
      pack.building(name, rgb).then((sp) => this.tinted.set(key, sp || 'failed'), () => this.tinted.set(key, 'failed'));
    }
    return null;
  }

  dispose() { this.tinted.clear(); }

  drawUnit(u, x, y, t, zoom) {
    const { ctx } = this;
    const [sx, sy] = this.toScreen(x, y);
    if (sx < -80 || sx > this.vw + 80) return;
    const dead = u.hp <= 0;
    // (A trebuchet walks packed: a different unit's graphics.)
    const { sprite, side } = this.spriteFor(u.moving && u.f.walkAs ? u.f.walkAs : u.f.unitId, u.owner ?? this.w.teams[u.side].players[0]);
    let fr = null;
    if (sprite) {
      const { anims } = sprite;
      const seq = (a) => anims[a]?.frames?.[side];
      const at = (a, el, loop) => {
        const fs = seq(a);
        if (!fs?.length) return null;
        let n = Math.floor(Math.max(0, el) / (anims[a].fdur || 0.1));   // (single-frame poses have no frame time)
        n = loop ? ((n % fs.length) + fs.length) % fs.length : Math.min(n, fs.length - 1);
        return fs[n];
      };
      if (dead) fr = at('death', t - u.diedAt, false);
      else {
        const atk = seq('attack');
        if (u.attackStart !== null && atk && t - u.attackStart < atk.length * anims.attack.fdur) fr = at('attack', t - u.attackStart, false);
        else if (u.moving) fr = at('walk', t + u.id * 0.13, true) || at('idle', t, true);
        else fr = at('idle', t + u.id * 0.21, true);
      }
      if (fr) {
        const [fx, fy, fw, fh, ax, ay] = fr;
        if (dead) ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - u.diedAt - 2.5) / 1.5);
        const flip = side === 'blue' ? u.face < 0 : u.face > 0;   // blue frames face right, red ones left
        if (flip) {
          ctx.save(); ctx.translate(sx, 0); ctx.scale(-1, 1);
          ctx.drawImage(sprite.atlas, fx, fy, fw, fh, -ax * zoom, sy - ay * zoom, fw * zoom, fh * zoom);
          ctx.restore();
        } else ctx.drawImage(sprite.atlas, fx, fy, fw, fh, sx - ax * zoom, sy - ay * zoom, fw * zoom, fh * zoom);
        ctx.globalAlpha = 1;
      }
    }
    if (!fr) {
      // No in-game graphics for this unit: its icon in a ring of the side's colour.
      if (dead) return;
      const r = Math.max(9, 22 * zoom);
      ctx.beginPath(); ctx.arc(sx, sy - r, r, 0, Math.PI * 2);
      ctx.fillStyle = SIDE_DARK[u.side]; ctx.fill();
      const img = this.unitIcons[u.f.unitId];
      if (img?.complete && img.naturalWidth) {
        ctx.save(); ctx.clip(); ctx.drawImage(img, sx - r, sy - 2 * r, 2 * r, 2 * r); ctx.restore();
      }
      ctx.lineWidth = 2.5; ctx.strokeStyle = SIDE[u.side]; ctx.stroke();
    }
    if (!dead && u.hp < u.f.hp) {
      const top = sy - (fr ? fr[5] : 44) * zoom - 6;
      const bw = Math.max(16, 26 * zoom);
      this.bar(sx - bw / 2, top, bw, 3, u.hp / u.f.hp);
    }
  }

  drawShots(t, zoom, ppt) {
    const { ctx } = this;
    for (const s of this.w.shots) {
      if (t < s.t0 || t > s.t1) continue;
      const k = (t - s.t0) / Math.max(1e-3, s.t1 - s.t0);
      const dist = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      const gun = /shot/.test(s.sprite || '');
      const peak = gun ? 0.03 * dist : Math.min(1.8, 0.1 + dist * 0.08 + Math.max(0, s.arc) * dist);
      const startH = s.castle ? 2.2 : 0.55;
      const h = (q) => startH * (1 - q) + 0.3 * q + 4 * peak * q * (1 - q);
      const at = (q) => {
        const [x, y] = this.toScreen(s.x0 + (s.x1 - s.x0) * q, s.y0 + (s.y1 - s.y0) * q);
        return [x, y - h(q) * ppt * 0.82];
      };
      const [px, py] = at(k);
      const [qx, qy] = at(Math.min(1, k + 0.03));
      const sprite = this.sprites?.projectiles?.[s.sprite];
      const seq = sprite?.frames?.[s.x1 >= s.x0 ? 'right' : 'left'];
      if (seq?.length && sprite.mode === 'pitch') {
        const ang = Math.atan2(qy - py, Math.abs(qx - px) || 1e-6);
        const n = Math.round(Math.min(1, Math.max(0, (ang + Math.PI / 2.4) / (Math.PI / 1.2))) * (seq.length - 1));
        const [fx, fy, fw, fh, ax, ay] = seq[n];
        const z = Math.max(zoom, 0.7);
        ctx.drawImage(sprite.atlas, fx, fy, fw, fh, px - ax * z, py - ay * z, fw * z, fh * z);
        continue;
      }
      const len = Math.hypot(qx - px, qy - py) || 1;
      const tail = (gun ? 30 : 12) * Math.max(zoom, 0.6);
      ctx.strokeStyle = gun ? 'rgb(255 245 205 / .9)' : 'rgb(240 225 180 / .95)';
      ctx.lineWidth = Math.max(1.4, 2 * zoom);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - ((qx - px) / len) * tail, py - ((qy - py) / len) * tail); ctx.stroke();
    }
  }

  // "+7" gold over enemies your side kills, and building news.
  drawFloaters(t, zoom) {
    const ev = this.w.events;
    // The world trims old events; keep our place in the list.
    if (this.seen > ev.length) this.seen = 0;
    for (; this.seen < ev.length; this.seen++) {
      const e = ev[this.seen];
      if ((e.type === 'kill' || e.type === 'razed') && e.owner === this.me) this.floaters.push({ t: e.t, x: e.x, y: e.y, text: `+${e.bounty}` });
    }
    const { ctx } = this;
    ctx.font = `700 ${Math.round(11 + 4 * zoom)}px "Merriweather", Georgia, serif`;
    ctx.textAlign = 'center';
    this.floaters = this.floaters.filter((f) => t - f.t < 1.2);
    for (const f of this.floaters) {
      const age = t - f.t;
      const [sx, sy] = this.toScreen(f.x, f.y);
      ctx.globalAlpha = 1 - age / 1.2;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgb(0 0 0 / .7)';
      ctx.fillStyle = '#ffd34d';
      ctx.strokeText(f.text, sx, sy - 50 * zoom - age * 30);
      ctx.fillText(f.text, sx, sy - 50 * zoom - age * 30);
    }
    ctx.globalAlpha = 1;
  }

  drawMini() {
    const { mctx: c, mw, mh } = this;
    if (!mw) return;
    const sx = (x) => (x / LANE.length) * mw;
    const sy = (y) => ((y + LANE.half) / (LANE.half * 2)) * (mh - 6) + 3;
    c.fillStyle = '#3d5229';
    c.fillRect(0, 0, mw, mh);
    c.fillStyle = '#3d7590';
    c.fillRect(sx(RIVER.x0), sy(-RIVER.half), sx(RIVER.x1) - sx(RIVER.x0), sy(RIVER.half) - sy(-RIVER.half));
    for (const b of this.w.structures) {
      if (b.hp <= 0) continue;
      const s = b.kind === 'castle' ? 9 : 5;
      c.fillStyle = b.owner !== undefined ? this.colours[b.owner] : SIDE[b.side];
      c.fillRect(sx(b.x) - s / 2, sy(b.y) - s / 2, s, s);
    }
    for (const u of this.w.units) {
      if (u.hp <= 0) continue;
      c.fillStyle = this.colours[u.owner] || (u.side === 0 ? '#9cc4ff' : '#ff9c8f');
      c.fillRect(sx(u.x) - 1, sy(u.y) - 1, 2.5, 2.5);
    }
    const half = this.vw / (2 * TILE * this.cam.zoom);
    c.strokeStyle = '#ffe9a8'; c.lineWidth = 1.5;
    c.strokeRect(sx(this.cam.x - half), 1, sx(half * 2), mh - 2);
  }
}
