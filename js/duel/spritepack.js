// Game graphics: unit animations, buildings, projectiles and grass, made from
// AoE2 DE's files by tools/make_sprite_pack.py.
//
// The packs live in their own GitHub repo (SPRITES), listed in its
// manifest.json. The app downloads them once, keeps them on the phone, and on
// later starts re-downloads only files whose hash changed, so new sprites
// arrive without a new app build.
//
// Format 2 (current): each frame is stored once, facing right, with a
// player-colour mask; colours are applied on the phone (tint.js), blue and red
// for the Test tab, any colour for AOSiege players. Facing left is mirrored.
// File: "AOE2PACK" | uint32 version | uint32 header length | JSON header | blobs

import { tintJob } from '../tint.js';

export const SPRITES = 'https://raw.githubusercontent.com/robfulcher321-cloud/extra-sprites-for-aoe2-companion/main/';
const CACHE = 'aoe2-sprites-v2';
const OLD_CACHES = ['aoe2-sprite-pack'];
const MAGIC = 'AOE2PACK';
/** The pack's own blue and red (what the Test tab shows). */
export const TEAM_RGB = { blue: [52, 104, 236], red: [226, 40, 32] };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

class PackFile {
  constructor(buffer) {
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== MAGIC) throw new Error('Not a sprite pack');
    const view = new DataView(buffer);
    this.version = view.getUint32(8, true);
    const headerLen = view.getUint32(12, true);
    this.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headerLen)));
    this.base = 16 + headerLen;
    this.buffer = buffer;
  }

  bitmap([offset, length]) {
    return createImageBitmap(new Blob([this.buffer.slice(this.base + offset, this.base + offset + length)], { type: 'image/webp' }));
  }
}

// ---------- Tinting, in a worker when possible ----------
let worker = null;
let workerOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
let nextJob = 1;
const jobs = new Map();
function tint(job) {
  if (workerOk && !worker) {
    try {
      worker = new Worker(new URL('../tint-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const j = jobs.get(e.data.id);
        jobs.delete(e.data.id);
        if (!j) return;
        if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data);
      };
      worker.onerror = () => { workerOk = false; for (const j of jobs.values()) j.retry(); jobs.clear(); };
    } catch { workerOk = false; }
  }
  const onMain = () => {
    const make = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
    const { canvas, rects } = tintJob(job, make);
    return { bitmap: canvas, rects };
  };
  if (!workerOk) return Promise.resolve().then(onMain);
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    jobs.set(id, { resolve, reject, retry: () => Promise.resolve().then(onMain).then(resolve, reject) });
    worker.postMessage({ id, job });
  });
}

// ---------- All the packs together ----------
class Sprites {
  constructor(files) {
    this.files = files;
    this.unitFile = new Map();
    this.buildingFile = new Map();
    this.sets = {};
    this.cache = new Map();
    for (const f of files) {
      for (const id of Object.keys(f.meta.units || {})) this.unitFile.set(Number(id), f);
      for (const n of Object.keys(f.meta.buildings || {})) this.buildingFile.set(n, f);
      Object.assign(this.sets, f.meta.sets || {});
      if (f.meta.grass) this.grassFile = f;
      if (f.meta.projectiles) this.projFile = f;
      if (f.meta.textures) this.terrainFile = f;
      if (f.meta.rubble) this.rubbleFile = f;
    }
  }

  get unitCount() { return this.unitFile.size; }

  has(unitId) { return this.unitFile.has(Number(unitId)); }

  once(key, make) {
    if (!this.cache.has(key)) {
      const p = make();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return this.cache.get(key);
  }

  grass() { return this.grassFile ? this.once('grass', () => this.grassFile.bitmap(this.grassFile.meta.grass)) : Promise.resolve(null); }

  /** Terrain textures (water, shallow, beach, wetbeach): ImageBitmap or null */
  texture(name) {
    const r = this.terrainFile?.meta.textures?.[name];
    return r ? this.once(`t${name}`, () => this.terrainFile.bitmap(r)) : Promise.resolve(null);
  }

  /** Tree graphics: { name: { atlas, frames: [[x, y, w, h, ax, ay]...] } } (each frame a different tree) */
  trees() {
    const t = this.terrainFile?.meta.trees;
    if (!t) return Promise.resolve({});
    return this.once('trees', async () => Object.fromEntries(await Promise.all(Object.entries(t).map(async ([n, v]) => [n, { ...v, atlas: await this.terrainFile.bitmap(v.atlas) }]))));
  }

  /** Rubble a fallen building leaves: { atlas, frame } or null. kind: barracks, castle, wonder... */
  rubble(kind) {
    const r = this.rubbleFile?.meta.rubble?.[kind];
    return r ? this.once(`r${kind}`, async () => ({ ...r, atlas: await this.rubbleFile.bitmap(r.atlas) })) : Promise.resolve(null);
  }

  /** Projectile by graphic name: { mode, fdur, frames: { right, left }, atlas } or null */
  projectile(name) {
    const p = name && this.projFile?.meta.projectiles?.[name];
    if (!p) return Promise.resolve(null);
    return this.once(`p${name}`, async () => ({ ...p, atlas: await this.projFile.bitmap(p.atlas) }));
  }

  /** The unit's frames tinted in the given colours. variants: [{ name, rgb, mirror }] */
  async tinted(unitId, variants) {
    const f = this.unitFile.get(Number(unitId));
    if (!f) return null;
    const u = f.meta.units[unitId];
    const names = Object.keys(u.anims);
    const flat = names.flatMap((n) => u.anims[n].frames);
    const [atlas, mask] = await Promise.all([f.bitmap(u.atlas), u.mask ? f.bitmap(u.mask) : null]);
    const { bitmap, rects } = await tint({ atlas, mask, rects: flat.map((r) => r.slice(0, 4)), variants: variants.map(({ rgb, mirror }) => ({ rgb, mirror })) });
    const anims = {};
    let i = 0;
    for (const n of names) {
      const a = u.anims[n];
      const frames = {};
      variants.forEach((v, k) => {
        frames[v.name] = a.frames.map((fr, j) => {
          const [x, y, w, h] = rects[k][i + j];
          return [x, y, w, h, v.mirror ? w - fr[4] : fr[4], fr[5]];
        });
      });
      anims[n] = { fdur: a.fdur, frames };
      i += a.frames.length;
    }
    return { radius: u.radius, anims, atlas: bitmap };
  }

  /** { radius, anims: { idle|walk|attack|death: { fdur, frames: { blue: facing right, red: facing left } } }, atlas } */
  unit(unitId) {
    return this.once(`u${unitId}`, () => this.tinted(unitId, [
      { name: 'blue', rgb: TEAM_RGB.blue, mirror: false },
      { name: 'red', rgb: TEAM_RGB.red, mirror: true },
    ]));
  }

  /** The unit in any colour, facing right: frames under the name 'blue' (so it draws like a blue-side unit). */
  unitIn(unitId, rgb) {
    return this.once(`u${unitId}|${rgb.join(',')}`, () => this.tinted(unitId, [{ name: 'blue', rgb, mirror: false }]));
  }

  /** A civ's building graphic names: { barracks, archery, stable, castle, market, blacksmith, workshop, monastery } */
  buildingSet(civ) { return this.sets[civ] || this.sets.Britons || null; }

  /** A building in a player's colour: { atlas, frame: [x, y, w, h, hotspot x, hotspot y] } or null */
  building(name, rgb) {
    const f = this.buildingFile.get(name);
    if (!f) return Promise.resolve(null);
    const b = f.meta.buildings[name];
    return this.once(`b${name}|${rgb.join(',')}`, async () => {
      const [atlas, mask] = await Promise.all([f.bitmap(b.atlas), b.mask ? f.bitmap(b.mask) : null]);
      const { bitmap, rects } = await tint({ atlas, mask, rects: [b.frame.slice(0, 4)], variants: [{ rgb, mirror: false }] });
      return { atlas: bitmap, frame: [...rects[0][0], b.frame[4], b.frame[5]] };
    });
  }
}

// ---------- Download and keep ----------
const progress = new Set();
let state = { done: 0, total: 0, active: false };
/** Follow downloads: fn({ done, total, active }) in bytes. Returns a function to stop following. */
export function onPackProgress(fn) { progress.add(fn); fn(state); return () => progress.delete(fn); }
const report = (s) => { state = { ...state, ...s }; for (const fn of progress) fn(state); };

async function fetchBuffer(url, size) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body?.getReader) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    report({ done: state.done + value.length });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  if (size && got !== size) throw new Error('Download incomplete');
  return out.buffer;
}

async function load() {
  for (const c of OLD_CACHES) caches?.delete(c).catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  let manifest = null;
  try {
    const res = await fetch(`${SPRITES}manifest.json?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (res.ok) { manifest = await res.json(); store.set('sprite-manifest', JSON.stringify(manifest)); }
  } catch { /* offline: use the last one we saw */ }
  if (!manifest) { try { manifest = JSON.parse(store.get('sprite-manifest')); } catch { manifest = null; } }
  if (!manifest?.files?.length) return null;
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null;
  const key = (f) => `${SPRITES}packs/${f.name}?sha=${f.sha256}`;
  const missing = [];
  const buffers = new Map();
  for (const f of manifest.files) {
    const hit = await cache?.match(key(f));
    if (hit) buffers.set(f.name, await hit.arrayBuffer()); else missing.push(f);
  }
  if (missing.length) {
    report({ active: true, done: 0, total: missing.reduce((a, f) => a + f.size, 0) });
    for (const f of missing) {
      try {
        const buf = await fetchBuffer(`${SPRITES}packs/${f.name}?sha=${f.sha256.slice(0, 12)}`, f.size);
        buffers.set(f.name, buf);
        await cache?.put(key(f), new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
      } catch (err) {
        console.warn('Sprite download failed', f.name, err);
      }
    }
    report({ active: false });
  }
  // Drop files that are no longer listed (older versions)
  if (cache) {
    const wanted = new Set(manifest.files.map(key));
    for (const req of await cache.keys()) if (!wanted.has(req.url)) cache.delete(req);
  }
  const files = [];
  for (const f of manifest.files) {
    const buf = buffers.get(f.name);
    if (!buf) continue;
    try { files.push(new PackFile(buf)); } catch (err) { console.warn(err); }
  }
  return files.some((f) => f.meta.units) ? new Sprites(files) : null;
}

let loading = null;
/**
 * The game graphics. Everyone asking while they load waits for the same load;
 * a failed load is retried next time.
 */
export function loadPack() {
  if (!loading) {
    loading = load().catch((err) => { console.warn('Sprites unavailable:', err); return null; });
    loading.then((p) => { if (!p) loading = null; });
  }
  return loading;
}
