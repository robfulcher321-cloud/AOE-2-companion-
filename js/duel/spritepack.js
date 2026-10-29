// Sprite pack: real unit animations, projectiles and grass made from AoE2 DE's
// files by tools/make_sprite_pack.py. The app ships with one (assets/).
//
// File layout: "AOE2PACK" | uint32 version | uint32 header length | JSON header | blobs

const CACHE = 'aoe2-sprite-pack';
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

/** The pack bundled with the app. Packs imported by older versions are cleared. */
export async function loadPack() {
  if (current !== undefined) return current;
  current = null;
  try {
    if (typeof caches !== 'undefined') caches.delete(CACHE).catch(() => {});
    const res = await fetch(BUNDLED);
    if (res.ok) current = new SpritePack(await res.arrayBuffer());
  } catch (err) {
    console.warn('Sprite pack unavailable:', err);
  }
  return current;
}
