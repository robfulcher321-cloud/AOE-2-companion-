// Worker side of tint.js: tints sprite frames off the main thread so the game doesn't stutter.
import { tintJob } from './tint.js';

self.onmessage = (e) => {
  const { id, job } = e.data;
  try {
    const { canvas, rects } = tintJob(job, (w, h) => new OffscreenCanvas(w, h));
    job.atlas.close?.();
    job.mask?.close?.();
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap, rects }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
