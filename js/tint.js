// Player colours, the way the game does them: each sprite frame has a
// player-colour mask, and the masked pixels are tinted with the player's
// colour at their own brightness (colour x brightness x 1.7, as the pack
// tool and the game's look). Runs in a worker (tint-worker.js), or on the
// main thread if workers can't draw.
//
// job: { atlas: ImageBitmap, mask: ImageBitmap|null, rects: [[x, y, w, h]...],
//        variants: [{ rgb: [r, g, b], mirror: bool }] }
// Returns { bitmap, rects: [variant][frame] = [x, y, w, h] } with every variant's
// frames packed into one new image.

const WIDTH = 2048;

export function tintJob({ atlas, mask, rects, variants }, makeCanvas) {
  const width = Math.max(...rects.map((r) => r[2]), Math.min(WIDTH, rects.reduce((a, r) => a + r[2] + 1, 0)));
  // Shelf-pack each variant's frames, one after another down the image
  const order = rects.map((r, i) => i).sort((a, b) => rects[b][3] - rects[a][3]);
  const out = [];
  let y = 0;
  for (let v = 0; v < variants.length; v++) {
    const place = new Array(rects.length);
    let x = 0, shelf = 0;
    for (const i of order) {
      const [, , w, h] = rects[i];
      if (x + w > width) { x = 0; y += shelf + 1; shelf = 0; }
      place[i] = [x, y, w, h];
      x += w + 1;
      shelf = Math.max(shelf, h);
    }
    y += shelf + 1;
    out.push(place);
  }
  const height = Math.max(1, y);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mcanvas = mask ? makeCanvas(width, height) : null;
  const mctx = mcanvas?.getContext('2d', { willReadFrequently: true });
  variants.forEach(({ mirror }, v) => {
    rects.forEach(([sx, sy, w, h], i) => {
      const [dx, dy] = out[v][i];
      for (const [c, src] of [[ctx, atlas], [mctx, mask]]) {
        if (!c) continue;
        if (mirror) {
          c.save();
          c.translate(dx + w, dy);
          c.scale(-1, 1);
          c.drawImage(src, sx, sy, w, h, 0, 0, w, h);
          c.restore();
        } else c.drawImage(src, sx, sy, w, h, dx, dy, w, h);
      }
    });
  });
  if (mask) {
    const img = ctx.getImageData(0, 0, width, height);
    const m = mctx.getImageData(0, 0, width, height).data;
    const d = img.data;
    // Which variant owns each row (variants are stacked top to bottom)
    const starts = out.map((place) => Math.min(...place.map((r) => r[1])));
    for (let v = 0; v < variants.length; v++) {
      const [tr, tg, tb] = variants[v].rgb;
      const y0 = starts[v];
      const y1 = v + 1 < variants.length ? starts[v + 1] : height;
      for (let p = y0 * width * 4; p < y1 * width * 4; p += 4) {
        const a = m[p];
        if (a < 4 || d[p + 3] === 0) continue;
        const k = a / 255;
        const lum = ((d[p] + d[p + 1] + d[p + 2]) / 765) * 1.7;
        d[p] = d[p] * (1 - k) + Math.min(255, tr * lum) * k;
        d[p + 1] = d[p + 1] * (1 - k) + Math.min(255, tg * lum) * k;
        d[p + 2] = d[p + 2] * (1 - k) + Math.min(255, tb * lum) * k;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return { canvas, rects: out };
}
