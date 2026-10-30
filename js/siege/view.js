// Draws an AOSiege game: the lane on the game's grass, buildings as their
// icons on stone platforms (with the unit they train on a badge above), units
// with their in-game animations, and a minimap. Also turns touches into
// actions: drag to look around, tap a plot or building, press and hold a building.

import { LANE, PLOTS, plotPos } from './world.js';

const TILE = 96 / Math.SQRT2;   // screen px per tile at zoom 1 (same as the Test arena)
const DEPTH = 0.5;
const SIDE = ['#4a8de3', '#d5473d'];
const SIDE_DARK = ['#1f3f73', '#6e1f19'];

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
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas); ro.observe(mini);
    this.bindPan();
  }

  setup(world, { sprites = null, unitIcons = {}, buildingIcons = {}, mySide = 0 } = {}) {
    this.w = world;
    this.sprites = sprites;
    this.unitIcons = unitIcons;
    this.buildingIcons = buildingIcons;
    this.me = mySide;
    this.grassPattern = null;
    this.follow = true;
    this.cam.x = mySide === 0 ? 12 : LANE.length - 12;
    this.floaters = [];
    this.seen = world.events.length;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const [c, key] of [[this.canvas, 'ctx'], [this.mini, 'mctx']]) {
      const { width, height } = c.getBoundingClientRect();
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      this[key].setTransform(dpr, 0, 0, dpr, 0, 0);
      if (c === this.canvas) { this.vw = width; this.vh = height; } else { this.mw = width; this.mh = height; }
    }
    // Fit the lane's width (top to bottom) to the view.
    if (this.vh) this.cam.zoom = Math.max(0.3, Math.min(1, (this.vh - 70) / ((LANE.half * 2 + 3) * TILE * DEPTH)));
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
      if (hit?.b) {
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
      if (!cancelled && !p.moved && !p.used) {
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
      if (b.side !== this.me || b.kind !== 'building' || b.hp <= 0) continue;
      const box = this.boxOf(b);
      if (px >= box.x0 - 6 && px <= box.x1 + 6 && py >= box.y0 - 6 && py <= box.y1 + 6) {
        if (!best || box.y1 > best.box.y1) best = { b, box };
      }
    }
    if (best) return { b: best.b };
    for (let i = 0; i < PLOTS; i++) {
      if (this.w.sides[this.me].plots[i]) continue;
      const [x, y] = plotPos(this.me, i);
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
    const size = Math.max(22, b.r * 2 * ppt * (castle ? 0.62 : 0.4));
    const iy = sy - lift - size * 0.8;
    return { x0: lx, x1: rx, y0: iy - size * 0.5, y1: by, size, iy, lift, lx, rx, ty, by };
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
    const dir = this.me === 0 ? 1 : -1;
    let target = this.me === 0 ? 14 : LANE.length - 14;
    const mine = live.filter((u) => u.side === this.me);
    const theirs = live.filter((u) => u.side !== this.me);
    // Where the two armies meet, else the front of whichever army exists.
    const front = (arr, s) => (arr.length ? (s === 0 ? Math.max(...arr.map((u) => u.x)) : Math.min(...arr.map((u) => u.x))) : null);
    const a = front(mine, this.me);
    const b = front(theirs, 1 - this.me);
    if (a !== null && b !== null) target = dir > 0 ? Math.min(a, b) + 2 : Math.max(a, b) - 2;
    else if (a !== null) target = a;
    else if (b !== null) target = b;
    this.cam.x += (target - this.cam.x) * 0.04;
    this.clampCam();
  }

  toScreen(x, y) {
    const ppt = TILE * this.cam.zoom;
    return [this.vw / 2 + (x - this.cam.x) * ppt, this.vh * 0.56 + y * ppt * DEPTH];
  }

  // ---------- Drawing ----------

  draw(alpha = 1) {
    if (!this.w || !this.vw) return;
    this.autoCam();
    const { ctx, vw, vh } = this;
    const zoom = this.cam.zoom;
    const ppt = TILE * zoom;
    const t = this.w.t;

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

    // Empty plots on your side
    const used = new Set(this.w.sides[this.me].plots.map((id, i) => (id ? i : -1)));
    for (let i = 0; i < PLOTS; i++) {
      if (used.has(i)) continue;
      const [x, y] = plotPos(this.me, i);
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
    this.drawFloaters(t, zoom);
    this.drawMini();
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
    // A raised stone platform: front face, then the top in the side's trim
    ctx.fillStyle = dead ? '#2a241c' : '#4b4335';
    ctx.fillRect(lx, by - lift, rx - lx, lift + 2);
    ctx.fillStyle = dead ? '#3a3328' : '#7a7160';
    ctx.fillRect(lx, ty - lift, rx - lx, by - ty);
    const selected = this.selected === b.id;
    ctx.strokeStyle = selected ? '#ffd97a' : SIDE[b.side]; ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(lx, ty - lift, rx - lx, by - ty);
    // The building's icon standing on its platform, framed in the side's colour
    const ix = sx - size / 2;
    ctx.fillStyle = SIDE_DARK[b.side];
    ctx.fillRect(ix - 3, iy - 3, size + 6, size + 6);
    const img = this.buildingIcons[b.building];
    if (img?.complete && img.naturalWidth) {
      if (dead) ctx.filter = 'grayscale(1) brightness(.6)';
      ctx.drawImage(img, ix, iy, size, size);
      ctx.filter = 'none';
    } else {
      ctx.fillStyle = '#8a7a5a';
      ctx.fillRect(ix, iy, size, size);
    }
    ctx.strokeStyle = selected ? '#ffd97a' : SIDE[b.side]; ctx.lineWidth = 2;
    ctx.strokeRect(ix - 2, iy - 2, size + 4, size + 4);
    ctx.globalAlpha = 1;
    if (dead) return;
    const trains = b.kind === 'building' && b.line !== 'market';
    // The unit it trains, on a round badge above it (the castle has none)
    let top = iy - 12;
    if (trains) {
      const line = this.w.line(b.side, b.line);
      const unitId = line.tiers[b.tier].unitId;
      const r = Math.max(10, size * 0.34);
      const cx = sx, cy = iy - r - 4;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = SIDE_DARK[b.side]; ctx.fill();
      const ui = this.unitIcons[unitId];
      if (ui?.complete && ui.naturalWidth) { ctx.save(); ctx.clip(); ctx.drawImage(ui, cx - r, cy - r, r * 2, r * 2); ctx.restore(); }
      ctx.lineWidth = 2; ctx.strokeStyle = b.hold ? '#6cc3ff' : '#ffd97a'; ctx.stroke();
      // Upgrade step: Roman numeral under the badge
      if (b.tier > 0) {
        const label = ['I', 'II', 'III', 'IV', 'V', 'VI'][b.tier];
        ctx.font = `700 ${Math.round(9 + 4 * zoom)}px "Merriweather", Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgb(0 0 0 / .8)';
        ctx.strokeText(label, cx + r * 0.85, cy + r * 0.9);
        ctx.fillStyle = '#ffd97a';
        ctx.fillText(label, cx + r * 0.85, cy + r * 0.9);
      }
      top = cy - r - 10;
    }
    // HP bar
    const bw = Math.max(40, size + 6);
    this.bar(sx - bw / 2, top, bw, 5, b.hp / b.maxHp);
    // Training bar: fills until the next unit comes out. Held: blue, and glowing when the unit is waiting.
    if (trains && b.every) {
      const frac = b.waiting ? 1 : 1 - Math.max(0, b.timer) / b.every;
      const h = Math.max(5, 6 * zoom);
      const y = iy + size + 5;
      ctx.fillStyle = 'rgb(0 0 0 / .6)';
      ctx.fillRect(ix - 3, y - 1, size + 6, h + 2);
      if (b.waiting) {
        ctx.shadowColor = '#6cc3ff';
        ctx.shadowBlur = 8 + 6 * Math.sin(performance.now() / 160);
      }
      ctx.fillStyle = b.hold ? '#4fb0ff' : '#e8d9a8';
      ctx.fillRect(ix - 2, y, (size + 4) * frac, h);
      ctx.shadowBlur = 0;
    }
  }

  bar(x, y, w, h, frac) {
    const { ctx } = this;
    ctx.fillStyle = 'rgb(0 0 0 / .7)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = frac > 0.5 ? '#3fcf3f' : frac > 0.25 ? '#e8c23a' : '#e2412e';
    ctx.fillRect(x, y, w * Math.max(0, frac), h);
  }

  drawUnit(u, x, y, t, zoom) {
    const { ctx } = this;
    const [sx, sy] = this.toScreen(x, y);
    if (sx < -80 || sx > this.vw + 80) return;
    const dead = u.hp <= 0;
    const sprite = this.sprites?.units?.[u.f.unitId];
    let fr = null;
    if (sprite) {
      const side = u.side === 0 ? 'blue' : 'red';
      const { anims } = sprite;
      const seq = (a) => anims[a]?.frames?.[side];
      const at = (a, el, loop) => {
        const fs = seq(a);
        if (!fs?.length) return null;
        let n = Math.floor(el / anims[a].fdur);
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
        const flip = u.side === 0 ? u.face < 0 : u.face > 0;
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
      if ((e.type === 'kill' || e.type === 'razed') && e.side === this.me) this.floaters.push({ t: e.t, x: e.x, y: e.y, text: `+${e.bounty}` });
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
    for (const b of this.w.structures) {
      if (b.hp <= 0) continue;
      const s = b.kind === 'castle' ? 9 : 5;
      c.fillStyle = SIDE[b.side];
      c.fillRect(sx(b.x) - s / 2, sy(b.y) - s / 2, s, s);
    }
    for (const u of this.w.units) {
      if (u.hp <= 0) continue;
      c.fillStyle = u.side === 0 ? '#9cc4ff' : '#ff9c8f';
      c.fillRect(sx(u.x) - 1, sy(u.y) - 1, 2.5, 2.5);
    }
    const half = this.vw / (2 * TILE * this.cam.zoom);
    c.strokeStyle = '#ffe9a8'; c.lineWidth = 1.5;
    c.strokeRect(sx(this.cam.x - half), 1, sx(half * 2), mh - 2);
  }
}
