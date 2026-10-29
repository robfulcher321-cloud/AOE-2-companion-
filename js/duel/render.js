// Draws a simulation result onto a canvas and plays it back.
// Playback 1× = the game's Normal speed (1.7 game seconds per real second).
// World x runs left to right on screen; world y is depth, drawn foreshortened
// like the game's isometric view.

const GAME_SPEED_NORMAL = 1.7;
const COLORS = { p: ['#4a8de3', '#d5473d'], grass: '#4c6a33', grass2: '#57773a', ink: '#ece5d3' };
const TILE = 96 / Math.SQRT2;   // screen pixels per tile along the horizontal at 100% zoom
const DEPTH = 0.5;              // screen squash for world y

export class ArenaPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.speed = 1;
    this.raf = null;
    this.onDone = null;
    this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = width; this.h = height;
    if (this.result) this.draw(this.lastT ?? 0);
  }

  /** sprites: optional { grass, units: [blue, red], projectiles: [blue, red] } from the sprite pack */
  load(result, icons, sprites = null) {
    this.result = result;
    this.icons = icons;
    this.sprites = sprites;
    this.grassPattern = null;
    this.cam = null;
  }

  play() {
    cancelAnimationFrame(this.raf);
    const { duration } = this.result;
    const end = duration + (this.sprites ? 2.5 : 1); // let death animations finish
    if (this.reduceMotion) { this.draw(end); this.onDone?.(); return; }
    let simT = 0;
    let last = performance.now();
    this.cam = null;
    const tick = (now) => {
      simT += ((now - last) / 1000) * GAME_SPEED_NORMAL * this.speed;
      last = now;
      if (simT >= end) { this.draw(end); this.onDone?.(); return; }
      this.draw(simT);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  frameAt(t) {
    const { frames } = this.result;
    const i = Math.min(frames.length - 1, Math.max(0, Math.round(t / (frames[1]?.t - frames[0].t || 1 / 60))));
    return frames[i];
  }

  draw(t) {
    this.lastT = t;
    if (!this.w) return;
    const f = this.frameAt(Math.min(t, this.result.duration));
    this.updateCamera(f, t);
    if (this.sprites) this.drawSprites(t, f);
    else this.drawTokens(Math.min(t, this.result.duration), f);
    this.drawClock(Math.min(t, this.result.duration));
  }

  isDead(i, t) {
    const d = this.result.units[i].diedAt;
    return d !== null && t >= d;
  }

  // Camera frames every living unit (all of them once the fight is over),
  // zooming in as they close.
  updateCamera(f, t) {
    const { w, h } = this;
    const living = f.u.filter((_, i) => !this.isDead(i, t));
    const pts = living.length ? living : f.u;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const spanX = Math.max(3.4, Math.max(...xs) - Math.min(...xs) + 2.2);
    const spanY = Math.max(2, Math.max(...ys) - Math.min(...ys) + 2.4);
    const zoom = Math.min(1.5, Math.max(0.3, Math.min(w / (spanX * TILE), (h * 0.8) / (spanY * TILE * DEPTH + 60))));
    const target = { zoom, x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    if (!this.cam || t < (this.camT ?? 0)) this.cam = { ...target };
    const k = this.reduceMotion ? 1 : 0.08;
    for (const key of ['zoom', 'x', 'y']) this.cam[key] += (target[key] - this.cam[key]) * k;
    this.camT = t;
  }

  toScreen(x, y) {
    const ppt = TILE * this.cam.zoom;
    return [this.w / 2 + (x - this.cam.x) * ppt, this.h * 0.62 + (y - this.cam.y) * ppt * DEPTH];
  }

  // ---------- In-game look: real sprites on the game's grass ----------

  pickFrame(i, t, f) {
    const unit = this.result.units[i];
    const sprite = this.sprites.units[unit.unitId];
    if (!sprite) return { fr: null, flip: false, atlas: null };
    const [, , , moving, face, attackStart] = f.u[i];
    // The pack has blue facing right and red facing left; the other way is mirrored.
    const side = unit.side === 0 ? 'blue' : 'red';
    const flip = unit.side === 0 ? face < 0 : face > 0;
    const { anims } = sprite;
    const seq = (anim) => anims[anim]?.frames?.[side];
    const at = (anim, elapsed, loop) => {
      const frames = seq(anim);
      if (!frames?.length) return null;
      let n = Math.floor(elapsed / anims[anim].fdur);
      n = loop ? ((n % frames.length) + frames.length) % frames.length : Math.min(n, frames.length - 1);
      return frames[n];
    };
    let fr;
    if (this.isDead(i, t)) fr = at('death', t - unit.diedAt, false) || at('idle', 0, true);
    else {
      const atk = seq('attack');
      if (attackStart !== null && atk && t - attackStart < atk.length * anims.attack.fdur) fr = at('attack', t - attackStart, false);
      else if (moving) fr = at('walk', t + i * 0.13, true) || at('idle', t, true);
      else fr = at('idle', t + i * 0.21, true);
    }
    return { fr, flip, atlas: sprite.atlas };
  }

  drawSprites(t, f) {
    const { ctx, w, h } = this;
    const zoom = this.cam.zoom;
    // Ground: the game's grass texture, projected like the in-game isometric view.
    if (!this.grassPattern) this.grassPattern = ctx.createPattern(this.sprites.grass, 'repeat');
    const [ox, oy] = this.toScreen(0, 0);
    this.grassPattern.setTransform(new DOMMatrix().translateSelf(ox, oy).scaleSelf(1, 0.5).rotateSelf(45).scaleSelf(zoom * 0.5));
    ctx.fillStyle = this.grassPattern;
    ctx.fillRect(0, 0, w, h);

    const draws = f.u.map((p, i) => {
      const [sx, sy] = this.toScreen(p[0], p[1]);
      return { i, sx, sy, dead: this.isDead(i, t), ...this.pickFrame(i, t, f) };
    });
    // Corpses underneath, then back to front.
    draws.sort((a, b) => (Number(b.dead) - Number(a.dead)) || (a.sy - b.sy));
    ctx.imageSmoothingEnabled = true;
    for (const d of draws) {
      if (!d.fr) continue;
      const [sx, sy, sw, sh, ax, ay] = d.fr;
      if (d.flip) {
        ctx.save();
        ctx.translate(d.sx, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(d.atlas, sx, sy, sw, sh, -ax * zoom, d.sy - ay * zoom, sw * zoom, sh * zoom);
        ctx.restore();
      } else {
        ctx.drawImage(d.atlas, sx, sy, sw, sh, d.sx - ax * zoom, d.sy - ay * zoom, sw * zoom, sh * zoom);
      }
    }

    this.drawProjectiles(t, zoom);

    // Health bars, like the in-game ones, above each living unit.
    for (const d of draws) {
      if (d.dead || !d.fr) continue;
      const frac = f.u[d.i][2] / this.result.units[d.i].maxHp;
      const bw = Math.round(30 * Math.max(zoom, 0.6)), bh = Math.max(3, Math.round(4 * zoom));
      const top = d.sy - d.fr[5] * zoom - 8 * zoom;
      ctx.fillStyle = 'rgb(0 0 0 / .7)';
      ctx.fillRect(d.sx - bw / 2 - 1, top - 1, bw + 2, bh + 2);
      ctx.fillStyle = frac > 0.5 ? '#3fcf3f' : frac > 0.25 ? '#e8c23a' : '#e2412e';
      ctx.fillRect(d.sx - bw / 2, top, bw * frac, bh);
    }

    // Damage numbers (not in the real game, but useful here)
    ctx.font = `700 ${Math.round(11 + 3 * zoom)}px "Merriweather", Georgia, serif`;
    ctx.textAlign = 'center';
    for (const hit of this.result.hits) {
      const age = t - hit.t;
      if (age < 0 || age > 0.9) continue;
      const d = draws.find((x) => x.i === hit.victim);
      if (!d) continue;
      const top = d.sy - (d.fr ? d.fr[5] : 50) * zoom - 14 * zoom - age * 30;
      ctx.globalAlpha = 1 - age / 0.9;
      const label = hit.note === 'blocked' ? 'Blocked' : hit.note === 'dodged' ? 'Dodged' : `-${hit.dmg}`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgb(0 0 0 / .75)';
      ctx.fillStyle = hit.note === 'charge' ? '#ffb347' : hit.note === 'blocked' || hit.note === 'dodged' ? '#bfe3ff' : '#fff3c4';
      ctx.strokeText(label, d.sx, top);
      ctx.fillText(label, d.sx, top);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Arrows, bolts, axes and shots in flight, on a shallow arc from the shooter's
   * chest to where they come down. Missed arrows stay stuck in the ground for a moment.
   */
  drawProjectiles(t, zoom) {
    const { ctx } = this;
    const ppt = TILE * zoom;
    for (const s of this.result.shots || []) {
      if (t < s.t0) continue;
      const end = s.landed;
      const flight = Math.max(end - s.t0, 1e-3);
      const stuck = t > end;
      if (stuck && (s.hit !== null || t - end > 0.8)) continue;
      const k = stuck ? 1 : (t - s.t0) / flight;
      const dist = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      const gun = /shot/.test(s.sprite || '');
      const startH = 0.55, endH = s.hit !== null ? 0.4 : 0;
      // Bullets fly almost flat; arrows and thrown weapons arc.
      const peak = gun ? 0.03 * dist : Math.min(1.6, 0.1 + dist * 0.08 + Math.max(0, s.arc) * dist); // tiles
      const height = (q) => startH + (endH - startH) * q + 4 * peak * q * (1 - q);
      const at = (q) => {
        const [x, y] = this.toScreen(s.x0 + (s.x1 - s.x0) * q, s.y0 + (s.y1 - s.y0) * q);
        return [x, y - height(q) * ppt * 0.82];
      };
      const [px, py] = at(k);
      const [qx, qy] = at(Math.min(1, k + 0.02));
      const dx = qx - px, dy = qy - py;
      if (gun) {
        this.drawShot(s, t, at, k, stuck, zoom, ppt);
        continue;
      }
      const sprite = this.sprites?.projectiles?.[s.sprite];
      const seq = sprite?.frames?.[s.x1 >= s.x0 ? 'right' : 'left'];
      if (seq?.length && sprite.atlas) {
        let n;
        if (sprite.mode === 'pitch') {
          // Frame 0 points steeply up, the middle one level, the last steeply down.
          const ang = Math.atan2(dy, Math.abs(dx) || 1e-6);
          const frac = (ang + Math.PI / 2.4) / (Math.PI / 1.2);
          n = Math.round(Math.min(1, Math.max(0, frac)) * (seq.length - 1));
        } else {
          n = stuck ? 0 : Math.floor((t - s.t0) / sprite.fdur) % seq.length;
        }
        const [sx, sy, sw, sh, ax, ay] = seq[n];
        const z = Math.max(zoom, 0.75); // keep tiny arrows visible when zoomed out
        ctx.drawImage(sprite.atlas, sx, sy, sw, sh, px - ax * z, py - ay * z, sw * z, sh * z);
      }
      if (!seq?.length) {
        if (stuck) continue;
        const len = Math.hypot(dx, dy) || 1;
        const tail = 14 * Math.max(zoom, 0.6);
        ctx.strokeStyle = 'rgb(255 236 170 / .9)';
        ctx.lineWidth = Math.max(1.5, 2 * zoom);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - (dx / len) * tail, py - (dy / len) * tail);
        ctx.stroke();
      }
    }
  }

  /**
   * Gunpowder: a muzzle flash and smoke at the gun, and the shot drawn as a
   * long thin streak, so it reads as a near-instant line as in the game.
   */
  drawShot(s, t, at, k, stuck, zoom, ppt) {
    const { ctx } = this;
    const since = t - s.t0;
    const [mx, my] = at(0);
    if (since < 0.7) {
      // smoke drifts up and fades
      ctx.fillStyle = `rgb(215 210 200 / ${0.45 * (1 - since / 0.7)})`;
      ctx.beginPath();
      ctx.arc(mx + (s.x1 >= s.x0 ? 6 : -6) * zoom, my - since * 14 * zoom, (5 + since * 14) * Math.max(zoom, 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    if (since < 0.08) {
      ctx.fillStyle = 'rgb(255 230 140 / .95)';
      ctx.beginPath();
      ctx.arc(mx, my, 4 * Math.max(zoom, 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    if (stuck) return;
    const dist = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1;
    const tailK = Math.max(0, k - 1.4 / dist); // streak about 1.4 tiles long
    const [hx, hy] = at(k);
    const [tx, ty] = at(tailK);
    const grad = ctx.createLinearGradient(tx, ty, hx, hy);
    grad.addColorStop(0, 'rgb(255 240 190 / 0)');
    grad.addColorStop(1, 'rgb(255 245 205 / .95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.2, 1.6 * zoom);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
  }

  drawClock(t) {
    const { ctx } = this;
    ctx.textAlign = 'left';
    ctx.font = '700 13px "Merriweather", Georgia, serif';
    ctx.fillStyle = 'rgb(0 0 0 / .45)';
    const label = `${t.toFixed(1)} s game time`;
    ctx.fillRect(8, 8, ctx.measureText(label).width + 14, 26);
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(label, 15, 26);
  }

  // ---------- Fallback: icon tokens on a plain field ----------

  drawTokens(t, f) {
    const { ctx, w, h } = this;
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(0, 0, w, h);
    const r = Math.max(10, Math.min(30, TILE * this.cam.zoom * 0.32));
    const order = f.u.map((_, i) => i).sort((a, b) => f.u[a][1] - f.u[b][1]);
    for (const i of order) {
      const unit = this.result.units[i];
      const [x, y] = this.toScreen(f.u[i][0], f.u[i][1]);
      const dead = this.isDead(i, t);
      ctx.save();
      ctx.globalAlpha = dead ? 0.35 : 1;
      ctx.beginPath(); ctx.arc(x, y - r, r, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = '#1f2e49'; ctx.fill();
      ctx.save(); ctx.clip();
      const img = this.icons?.[unit.side];
      if (img?.complete && img.naturalWidth) {
        if (dead) ctx.filter = 'grayscale(1)';
        ctx.drawImage(img, x - r, y - 2 * r, r * 2, r * 2);
      }
      ctx.restore();
      ctx.lineWidth = 3; ctx.strokeStyle = COLORS.p[unit.side]; ctx.stroke();
      ctx.restore();
      if (!dead) {
        const frac = f.u[i][2] / unit.maxHp;
        ctx.fillStyle = 'rgb(0 0 0 / .55)'; ctx.fillRect(x - r - 1, y - 2 * r - 9, 2 * r + 2, 6);
        ctx.fillStyle = frac > 0.33 ? '#58c35a' : '#e2b13c';
        ctx.fillRect(x - r, y - 2 * r - 8, 2 * r * frac, 4);
      }
    }
    ctx.strokeStyle = '#f3e7c0';
    ctx.lineWidth = 2;
    for (const s of this.result.shots || []) {
      if (t < s.t0 || t > s.landed) continue;
      const k = (t - s.t0) / Math.max(s.landed - s.t0, 1e-3);
      const [x, y] = this.toScreen(s.x0 + (s.x1 - s.x0) * k, s.y0 + (s.y1 - s.y0) * k);
      const lift = r + Math.sin(k * Math.PI) * 20;
      const dir = s.x1 >= s.x0 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(x, y - lift); ctx.lineTo(x - dir * 10, y - lift + Math.cos(k * Math.PI) * 3); ctx.stroke();
    }
  }
}
