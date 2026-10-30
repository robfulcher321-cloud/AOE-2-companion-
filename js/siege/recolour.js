// Worker: repaints a unit's player colour (its blue frames) in another colour,
// so every player's soldiers can wear their own colour, not just blue or red.
//
// The sprite pack bakes the player-colour areas as blue × brightness
// (tools/make_sprite_pack.py: colour (52,104,236) × lum × 1.7). Pixels with
// that blue hue are found again, their brightness read back, and the new
// colour applied the same way. Only the blue frames are copied (packed tight),
// which keeps the extra memory to about a quarter of the unit's atlas.

const BLUE = [52, 104, 236];
const WIDTH = 2048;

self.onmessage = async (e) => {
  const { key, atlas, rects, colour } = e.data;
  try {
    // Shelf-pack the frames into a new, smaller canvas
    const order = rects.map((r, i) => i).sort((a, b) => rects[b][3] - rects[a][3]);
    const out = new Array(rects.length);
    let x = 0, y = 0, shelf = 0;
    for (const i of order) {
      const [, , w, h] = rects[i];
      if (x + w > WIDTH) { x = 0; y += shelf + 1; shelf = 0; }
      out[i] = [x, y, w, h];
      x += w + 1;
      shelf = Math.max(shelf, h);
    }
    const height = Math.max(1, y + shelf);
    const canvas = new OffscreenCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');
    rects.forEach(([sx, sy, w, h], i) => ctx.drawImage(atlas, sx, sy, w, h, out[i][0], out[i][1], w, h));
    atlas.close?.();
    const img = ctx.getImageData(0, 0, WIDTH, height);
    const d = img.data;
    // Same strength as the pack's own blue and red (brightest channel about 236)
    const m = Math.max(...colour, 1);
    const [tr, tg, tb] = colour.map((c) => (c * 236) / m);
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] < 10) continue;
      const r = d[p], g = d[p + 1], b = d[p + 2];
      // Player blue: blue strongest, then green, red weakest (r ≈ 0.22 b, g ≈ 0.44 b until blue saturates)
      if (b < 28 || g >= b || r >= g || r > b * 0.45) continue;
      if (b < 250 && g > b * 0.75) continue;
      const lum = b < 250 ? b / (BLUE[2] * 1.7) : Math.max(b / (BLUE[2] * 1.7), g / (BLUE[1] * 1.7));
      const k = lum * 1.7;
      d[p] = Math.min(255, tr * k);
      d[p + 1] = Math.min(255, tg * k);
      d[p + 2] = Math.min(255, tb * k);
    }
    ctx.putImageData(img, 0, 0);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ key, bitmap, rects: out }, [bitmap]);
  } catch (err) {
    self.postMessage({ key, error: String(err) });
  }
};
