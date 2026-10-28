// Draws a simulation result onto a canvas and plays it back.
// Playback 1× = the game's Normal speed (1.7 game seconds per real second).

const GAME_SPEED_NORMAL = 1.7;
const COLORS = { p: ['#4a8de3', '#d5473d'], grass: '#4c6a33', grass2: '#57773a', ink: '#ece5d3' };

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

  /** sprites: optional { grass: ImageBitmap, units: [unitSprites, unitSprites] } from the sprite pack */
  load(result, icons, sprites = null) {
    this.result = result;
    this.icons = icons; // [HTMLImageElement, HTMLImageElement]
    this.sprites = sprites;
    this.grassPattern = null;
    this.cam = null;
    const xs = result.frames.flatMap((f) => f.x);
    this.minX = Math.min(...xs) - 1.2;
    this.maxX = Math.max(...xs) + 1.2;
  }

  play() {
    cancelAnimationFrame(this.raf);
    const { duration } = this.result;
    const end = duration + (this.sprites ? 2.5 : 1); // let death animations finish
    if (this.reduceMotion) { this.draw(end); this.onDone?.(); return; }
    let simT = 0;
    let last = performance.now();
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
    if (this.sprites) this.drawSprites(t);
    else this.drawTokens(Math.min(t, this.result.duration));
  }

  // ---------- In-game look: real sprites on the game's grass ----------

  pickFrame(i, t, f, unit) {
    const side = i === 0 ? 'blue' : 'red';
    const { anims } = unit;
    const diedAt = this.result.sides[i].diedAt;
    const seq = (anim) => anims[anim]?.frames?.[side];
    const at = (anim, elapsed, loop) => {
      const frames = seq(anim);
      if (!frames?.length) return null;
      let n = Math.floor(elapsed / anims[anim].fdur);
      n = loop ? ((n % frames.length) + frames.length) % frames.length : Math.min(n, frames.length - 1);
      return frames[n];
    };
    if (diedAt !== null && t >= diedAt) return at('death', t - diedAt, false) || at('idle', 0, true);
    const start = f.attackStart[i];
    const atk = seq('attack');
    if (start !== null && atk && t - start < atk.length * anims.attack.fdur) return at('attack', t - start, false);
    if (f.moving[i]) return at('walk', t, true) || at('idle', t, true);
    return at('idle', t, true);
  }

  drawSprites(t) {
    const { ctx, w, h } = this;
    if (!w) return;
    const { grass, units } = this.sprites;
    const f = this.frameAt(Math.min(t, this.result.duration));
    const TILE = 96 / Math.SQRT2;       // screen pixels per tile along the horizontal at 100% zoom
    // Camera follows the action: frame both units, zooming in as they close.
    const span = Math.max(3.4, Math.abs(f.x[1] - f.x[0]) + 2.2);
    const target = { zoom: Math.min(1.5, Math.max(0.6, w / (span * TILE))), mid: (f.x[0] + f.x[1]) / 2 };
    if (!this.cam || t < (this.camT ?? 0)) this.cam = { ...target };
    const k = this.reduceMotion ? 1 : 0.08;
    this.cam.zoom += (target.zoom - this.cam.zoom) * k;
    this.cam.mid += (target.mid - this.cam.mid) * k;
    this.camT = t;
    const zoom = this.cam.zoom;
    const ppt = TILE * zoom;
    const toPx = (x) => w / 2 + (x - this.cam.mid) * ppt;
    const groundY = h * 0.7;

    // Ground: the game's grass texture, projected like the in-game isometric view.
    if (!this.grassPattern) this.grassPattern = ctx.createPattern(grass, 'repeat');
    const m = new DOMMatrix().translateSelf(toPx(0), groundY).scaleSelf(1, 0.5).rotateSelf(45).scaleSelf(zoom * 0.5);
    this.grassPattern.setTransform(m);
    ctx.fillStyle = this.grassPattern;
    ctx.fillRect(0, 0, w, h);

    const draws = [0, 1].map((i) => {
      const fr = this.pickFrame(i, t, f, units[i]);
      return { i, fr, x: toPx(f.x[i]), dead: this.result.sides[i].diedAt !== null && t >= this.result.sides[i].diedAt };
    });
    draws.sort((a, b) => Number(b.dead) - Number(a.dead)); // corpses underneath
    ctx.imageSmoothingEnabled = true;
    for (const d of draws) {
      if (!d.fr) continue;
      const [sx, sy, sw, sh, ax, ay] = d.fr;
      ctx.drawImage(units[d.i].atlas, sx, sy, sw, sh, d.x - ax * zoom, groundY - ay * zoom, sw * zoom, sh * zoom);
    }

    // Health bars, like the in-game ones, above each living unit.
    for (const d of draws) {
      if (d.dead || !d.fr) continue;
      const maxHp = this.result.frames[0].hp[d.i];
      const frac = f.hp[d.i] / maxHp;
      const bw = Math.round(34 * zoom), bh = Math.max(3, Math.round(4 * zoom));
      const top = groundY - d.fr[5] * zoom - 10 * zoom;
      ctx.fillStyle = 'rgb(0 0 0 / .7)';
      ctx.fillRect(d.x - bw / 2 - 1, top - 1, bw + 2, bh + 2);
      ctx.fillStyle = frac > 0.5 ? '#3fcf3f' : frac > 0.25 ? '#e8c23a' : '#e2412e';
      ctx.fillRect(d.x - bw / 2, top, bw * frac, bh);
    }

    // Damage numbers (not in the real game, but useful here)
    ctx.font = `700 ${Math.round(13 + 3 * zoom)}px "Merriweather", Georgia, serif`;
    ctx.textAlign = 'center';
    for (const hit of this.result.hits) {
      const age = t - hit.t;
      if (age < 0 || age > 0.9) continue;
      const d = draws.find((x) => x.i === 1 - hit.by);
      const top = groundY - (d.fr ? d.fr[5] : 50) * zoom - 18 * zoom - age * 30;
      ctx.globalAlpha = 1 - age / 0.9;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgb(0 0 0 / .75)'; ctx.fillStyle = '#fff3c4';
      ctx.strokeText(`-${hit.dmg}`, d.x, top);
      ctx.fillText(`-${hit.dmg}`, d.x, top);
      ctx.globalAlpha = 1;
    }
    this.drawClock(Math.min(t, this.result.duration));
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

  drawTokens(t) {
    const { ctx, w, h } = this;
    if (!w) return;
    const f = this.frameAt(t);
    const scale = Math.min(w / (this.maxX - this.minX), 90);
    const ox = (w - (this.maxX - this.minX) * scale) / 2;
    const toPx = (x) => ox + (x - this.minX) * scale;
    const cy = h * 0.58;

    // Ground: AoE-style diamond tiles.
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = COLORS.grass2;
    ctx.lineWidth = 1;
    const tile = scale;
    ctx.beginPath();
    for (let x = -h * 2; x < w + h * 2; x += tile) {
      ctx.moveTo(x, 0); ctx.lineTo(x + h * 2, h);
      ctx.moveTo(x, 0); ctx.lineTo(x - h * 2, h);
    }
    ctx.stroke();

    // Units
    const r = Math.max(22, Math.min(40, scale * 0.45));
    // Tokens are drawn larger than real unit size, so keep them from overlapping.
    const px = [toPx(f.x[0]), toPx(f.x[1])];
    const minGap = r * 2 + 6;
    if (px[1] - px[0] < minGap) {
      const mid = (px[0] + px[1]) / 2;
      px[0] = mid - minGap / 2; px[1] = mid + minGap / 2;
    }
    this.tokenX = px;
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? 1 : -1;
      const dead = f.hp[i] <= 0;
      const lunge = dead ? 0 : Math.sin(Math.min(1, f.swing[i]) * Math.PI) * r * 0.3 * dir;
      const x = px[i] + lunge;
      const y = cy;

      // shadow
      ctx.fillStyle = 'rgb(0 0 0 / .25)';
      ctx.beginPath(); ctx.ellipse(x, y + r * 0.95, r * 0.9, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();

      ctx.save();
      ctx.globalAlpha = dead ? 0.35 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = '#1f2e49'; ctx.fill();
      ctx.save(); ctx.clip();
      const img = this.icons?.[i];
      if (img?.complete && img.naturalWidth) {
        if (dead) ctx.filter = 'grayscale(1)';
        ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
      }
      ctx.restore();
      ctx.lineWidth = 4; ctx.strokeStyle = COLORS.p[i]; ctx.stroke();
      ctx.restore();

      // HP bar
      const maxHp = this.result.frames[0].hp[i];
      const bw = r * 2, bh = 6, bx = x - r, by = y - r - 14;
      ctx.fillStyle = 'rgb(0 0 0 / .55)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = f.hp[i] / maxHp > 0.33 ? '#58c35a' : '#e2b13c';
      ctx.fillRect(bx, by, bw * (f.hp[i] / maxHp), bh);
      ctx.fillStyle = COLORS.ink;
      ctx.font = '700 12px "Merriweather", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.ceil(f.hp[i])}`, x, by - 5);
    }

    // Floating damage numbers (last 0.9 game seconds)
    ctx.font = '700 18px "Merriweather", Georgia, serif';
    ctx.textAlign = 'center';
    for (const hit of this.result.hits) {
      const age = t - hit.t;
      if (age < 0 || age > 0.9) continue;
      const target = 1 - hit.by;
      const tx = this.tokenX[target] + (target === 0 ? -r * 0.6 : r * 0.6);
      ctx.globalAlpha = 1 - age / 0.9;
      ctx.fillStyle = '#fff3c4';
      ctx.strokeStyle = 'rgb(0 0 0 / .7)'; ctx.lineWidth = 3;
      const ty = cy - r - 34 - age * 40;
      ctx.strokeText(`-${hit.dmg}`, tx, ty);
      ctx.fillText(`-${hit.dmg}`, tx, ty);
      ctx.globalAlpha = 1;
    }

    this.drawClock(t);
  }
}
