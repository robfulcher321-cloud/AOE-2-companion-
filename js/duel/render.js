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

  load(result, icons) {
    this.result = result;
    this.icons = icons; // [HTMLImageElement, HTMLImageElement]
    const xs = result.frames.flatMap((f) => f.x);
    this.minX = Math.min(...xs) - 1.2;
    this.maxX = Math.max(...xs) + 1.2;
  }

  play() {
    cancelAnimationFrame(this.raf);
    const { duration } = this.result;
    if (this.reduceMotion) { this.draw(duration); this.onDone?.(); return; }
    let simT = 0;
    let last = performance.now();
    const tick = (now) => {
      simT += ((now - last) / 1000) * GAME_SPEED_NORMAL * this.speed;
      last = now;
      if (simT >= duration + 1) { this.draw(duration); this.onDone?.(); return; }
      this.draw(Math.min(simT, duration));
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
      ctx.font = '600 13px "Alegreya Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.ceil(f.hp[i])}`, x, by - 5);
    }

    // Floating damage numbers (last 0.9 game seconds)
    ctx.font = '800 18px "Alegreya", serif';
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

    // Clock
    ctx.textAlign = 'left';
    ctx.font = '600 15px "Alegreya Sans", sans-serif';
    ctx.fillStyle = 'rgb(0 0 0 / .45)';
    ctx.fillRect(8, 8, 118, 26);
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(`${t.toFixed(1)} s game time`, 14, 26);
  }
}
