// Sprite pack: real unit animations and grass made from AoE2 DE's files by
// tools/make_sprite_pack.py. The app ships with one (assets/), and a different
// pack can be imported on the Duel screen; imports are kept only on the device.
//
// File layout: "AOE2PACK" | uint32 version | uint32 header length | JSON header | blobs

const CACHE = 'aoe2-sprite-pack';
const KEY = new URL('sprite-pack.aoe2pack', location.href).href;
const MAGIC = 'AOE2PACK';
const BUNDLED = 'assets/AoE2-sprites.aoe2pack';

class SpritePack {
  constructor(buffer) {
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8));
    if (magic !== MAGIC) throw new Error('That file isn\'t a sprite pack. Choose the .aoe2pack file made by the pack tool.');
    const view = new DataView(buffer);
    const headerLen = view.getUint32(12, true);
    this.meta = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + headerLen)));
    this.base = 16 + headerLen;
    this.buffer = buffer;
    this.bitmaps = new Map();
  }

  get unitCount() { return Object.keys(this.meta.units).length; }

  has(unitId) { return Boolean(this.meta.units[unitId]); }

  async bitmap(key, [offset, length]) {
    if (!this.bitmaps.has(key)) {
      const blob = new Blob([this.buffer.slice(this.base + offset, this.base + offset + length)], { type: 'image/webp' });
      this.bitmaps.set(key, createImageBitmap(blob));
    }
    return this.bitmaps.get(key);
  }

  grass() { return this.bitmap('grass', this.meta.grass); }

  /** Projectile sprite by graphic name: { mode, fdur, frames: { right, left }, atlas } or null */
  async projectile(name) {
    const p = name && this.meta.projectiles?.[name];
    if (!p) return null;
    return { ...p, atlas: await this.bitmap(`p${name}`, p.atlas) };
  }

  /** { radius, anims, atlas: ImageBitmap } or null */
  async unit(unitId) {
    const u = this.meta.units[unitId];
    if (!u) return null;
    return { ...u, atlas: await this.bitmap(`u${unitId}`, u.atlas) };
  }
}

let current;

/** A pack the user imported takes priority; otherwise the one bundled with the app. */
export async function loadPack() {
  if (current !== undefined) return current;
  current = null;
  try {
    if (typeof caches !== 'undefined') {
      const res = await (await caches.open(CACHE)).match(KEY);
      if (res) current = new SpritePack(await res.arrayBuffer());
    }
    if (!current) {
      const res = await fetch(BUNDLED);
      if (res.ok) {
        current = new SpritePack(await res.arrayBuffer());
        current.bundled = true;
      }
    }
  } catch (err) {
    console.warn('Sprite pack unavailable:', err);
  }
  return current;
}

export async function importPack(file) {
  const buffer = await file.arrayBuffer();
  const pack = new SpritePack(buffer); // validates before saving
  if (typeof caches !== 'undefined') {
    const cache = await caches.open(CACHE);
    await cache.put(KEY, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } }));
  }
  current = pack;
  return pack;
}

/** Removes an imported pack; the app goes back to the bundled one. */
export async function removePack() {
  current = undefined;
  if (typeof caches !== 'undefined') await caches.delete(CACHE);
  return loadPack();
}
