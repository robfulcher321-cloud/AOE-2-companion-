"""Build the AoE2 Companion sprite packs (format 2) from YOUR OWN copy of
Age of Empires II: Definitive Edition.

Format 2 works like the game: each frame is stored once (facing right), with
its player-colour mask beside it, and the app tints the mask with each
player's colour at run time (blue, red or any other). Facing left is the
same frame mirrored.

Writes several .aoe2pack files plus manifest.json into --out-dir:
  units-1.aoe2pack ...  unit animations (idle, walk, attack, death), split to stay
                        well under GitHub's file size limits; the first also holds
                        the grass and projectiles
  buildings.aoe2pack    Barracks, Archery Range, Stable, Castle, Market, Blacksmith,
                        Siege Workshop and Monastery for every architecture set
The app downloads the files listed in manifest.json from the sprites repo and
keeps them on the phone, re-downloading only files whose hash changed.

Usage:
  pip install genieutils-py numpy pillow
  python tools/make_sprite_pack.py --game "D:/Steam/steamapps/common/AoE2DE" --out-dir packs/

Options:
  --units 554,569      only these unit IDs
  --techtree data.json aoe2techtree's data.json (default: downloaded)
  --split-mb 24        start a new units file after this many MB
"""
import argparse
import hashlib
import io
import json
import os
import struct
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

sys.setrecursionlimit(10000)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sld import SLD, MAIN, SHADOW, PCOLOR  # noqa: E402

TECHTREE_URL = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/data.json'
ANIMS = ['idle', 'walk', 'attack', 'death']
MAX_FRAMES = 30
SHADOW_ALPHA = 0.55
MAGIC = b'AOE2PACK'
VERSION = 2

# Imperial-look buildings the app draws, by the unit ID that has that look
BUILDINGS = {'barracks': 20, 'archery': 14, 'stable': 153, 'castle': 82, 'market': 137,
             'blacksmith': 19, 'workshop': 150, 'monastery': 104, 'wonder': 276,
             'tower1': 79, 'tower2': 234, 'tower3': 235, 'bombard': 236, 'miningcamp': 584}
# Extra animations: the Trebuchet's assembly stages (its build graphic) play as packing/unpacking.
EXTRA_ANIMS = {42: {'pack': (137, 0.2)}}
# Game data civ names that differ from aoe2techtree's civ keys
CIV_KEYS = {'British': 'Britons', 'French': 'Franks', 'Byzantine': 'Byzantines', 'Mayan': 'Mayans'}

PITCHED = ('arrow', 'dart', 'spear', 'bolt')


def wanted(u, uid):
    """Land units the app can show: everything that fights (incl. siege, rams, camels), and Monks."""
    classes = {a['Class'] for a in u['Armours']}
    if uid in (1263, 440):   # Flaming Camel, Petard: suicide units
        return False
    if uid == 125:           # Monk
        return True
    if classes & {16}:       # ships
        return False
    return bool(classes & {1, 5, 8, 15, 17, 20, 30})


def compose(frame, mirror=False):
    """Main layer over its shadow, plus the player-colour mask. Returns (RGBA, mask L, hotspot x, y) or None."""
    main = frame[MAIN]
    if main is None or main.w == 0:
        return None
    shadow = frame[SHADOW]
    layers = [main] + ([shadow] if shadow is not None and shadow.w else [])
    x0 = min(l.x1 for l in layers)
    y0 = min(l.y1 for l in layers)
    x1 = max(l.x1 + l.img.shape[1] for l in layers)
    y1 = max(l.y1 + l.img.shape[0] for l in layers)
    canvas = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
    mask = np.zeros((y1 - y0, x1 - x0), np.float32)
    if shadow is not None and shadow.w:
        a = shadow.img.astype(np.float32) / 255 * SHADOW_ALPHA
        sl = canvas[shadow.y1 - y0:shadow.y1 - y0 + a.shape[0], shadow.x1 - x0:shadow.x1 - x0 + a.shape[1]]
        sl[..., 3] = np.maximum(sl[..., 3], a)
    rgba = main.img.astype(np.float32)
    a = rgba[..., 3:] / 255
    oy, ox = main.y1 - y0, main.x1 - x0
    dst = canvas[oy:oy + a.shape[0], ox:ox + a.shape[1]]
    dst[..., :3] = rgba[..., :3] * a + dst[..., :3] * (1 - a)
    dst[..., 3:] = a + dst[..., 3:] * (1 - a)
    pc = frame[PCOLOR]
    if pc is not None and pc.w:
        mask[oy:oy + a.shape[0], ox:ox + a.shape[1]] = pc.img.astype(np.float32) * a[..., 0]
    out = np.zeros_like(canvas)
    out[..., :3] = np.where(canvas[..., 3:] > 0, canvas[..., :3], 0)
    out[..., 3] = canvas[..., 3] * 255
    img = Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA')
    m = Image.fromarray(mask.clip(0, 255).astype(np.uint8), 'L')
    bbox = img.getbbox()
    if not bbox:
        return None
    img, m = img.crop(bbox), m.crop(bbox)
    hx, hy = frame['hotspot']
    ax, ay = hx - x0 - bbox[0], hy - y0 - bbox[1]
    if mirror:
        img, m = img.transpose(Image.FLIP_LEFT_RIGHT), m.transpose(Image.FLIP_LEFT_RIGHT)
        ax = img.width - ax
    return img, m, ax, ay


def pack_atlas(images, width=2048):
    """Shelf-pack images. Returns ([(x, y, w, h)], height)."""
    order = sorted(range(len(images)), key=lambda i: -images[i].height)
    rects = [None] * len(images)
    x = y = shelf = 0
    for i in order:
        w, h = images[i].size
        if x + w > width:
            x, y, shelf = 0, y + shelf + 1, 0
        rects[i] = (x, y, w, h)
        x += w + 1
        shelf = max(shelf, h)
    return rects, y + shelf


def atlas_pair(images, masks, width=2048):
    """Atlas and its mask, same layout. Returns (atlas webp bytes, mask webp bytes or None, rects)."""
    rects, height = pack_atlas(images, width)
    atlas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    mask = Image.new('L', (width, height), 0)
    for img, m, (rx, ry, _, _) in zip(images, masks, rects):
        atlas.paste(img, (rx, ry))
        mask.paste(m, (rx, ry))
    buf = io.BytesIO()
    atlas.save(buf, 'WEBP', quality=88, method=4)
    mbuf = None
    if mask.getbbox():
        b = io.BytesIO()
        mask.convert('RGB').save(b, 'WEBP', lossless=True, method=4)
        mbuf = b.getvalue()
    return buf.getvalue(), mbuf, rects


class Pack:
    """One output file: JSON header + blobs."""

    def __init__(self, kind):
        self.blobs = []
        self.size = 0
        self.meta = {'version': VERSION, 'kind': kind, 'created': time.strftime('%Y-%m-%d'), 'tileSize': 96}

    def add(self, data):
        off = self.size
        self.blobs.append(data)
        self.size += len(data)
        return [off, len(data)]

    def write(self, path):
        header = json.dumps(self.meta, separators=(',', ':')).encode()
        with open(path, 'wb') as fh:
            fh.write(MAGIC + struct.pack('<II', VERSION, len(header)) + header)
            for b in self.blobs:
                fh.write(b)
        return os.path.getsize(path)


def projectile_entry(g, sld):
    """Frames of a projectile graphic flying right (angle 0) and left (half way round)."""
    per_angle = max(1, g.frame_count)
    mode = 'pitch' if any(k in g.file_name for k in PITCHED) and per_angle > 1 else 'spin'
    images, frames = [], {}
    for side, angle16 in (('right', 0), ('left', 8)):
        angle_idx = angle16 * g.angle_count // 16 if g.angle_count > 1 else 0
        seq = []
        for f in range(per_angle):
            fi = angle_idx * per_angle + f
            if fi >= len(sld.frames):
                continue
            try:
                comp = compose(sld.frame(fi))
            except KeyError:
                continue
            if comp is None:
                continue
            img, _, ax, ay = comp
            seq.append([len(images), ax, ay])
            images.append(img)
        frames[side] = seq
    return mode, images, frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True, help='AoE2 DE install folder')
    ap.add_argument('--out-dir', default='packs')
    ap.add_argument('--units', default='')
    ap.add_argument('--techtree', default='')
    ap.add_argument('--split-mb', type=float, default=24)
    ap.add_argument('--skip', default='', help='comma list: units,buildings')
    args = ap.parse_args()
    skip = set(args.skip.split(','))
    os.makedirs(args.out_dir, exist_ok=True)

    from genieutils.datfile import DatFile
    common = os.path.join(args.game, 'resources', '_common')
    gfx_dir = os.path.join(common, 'drs', 'graphics')
    print('Reading game data...')
    dat = DatFile.parse(os.path.join(common, 'dat', 'empires2_x2_p1.dat'))
    tt = json.load(open(args.techtree)) if args.techtree else json.load(urllib.request.urlopen(TECHTREE_URL))
    units = [int(i) for i in args.units.split(',') if i] or \
        sorted(int(k) for k, u in tt['data']['Unit'].items() if wanted(u, int(k)))
    files = []

    def sld_for(gid):
        if gid < 0 or not dat.graphics[gid]:
            return None, None
        g = dat.graphics[gid]
        path = os.path.join(gfx_dir, g.file_name + '.sld')
        if not os.path.exists(path):
            print(f'  missing {g.file_name}.sld, skipped')
            return g, None
        return g, SLD(path)

    def finish(pack, name):
        path = os.path.join(args.out_dir, name)
        size = pack.write(path)
        sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        files.append({'name': name, 'kind': pack.meta['kind'], 'size': size, 'sha256': sha})
        print(f'Wrote {name}: {size / 1e6:.1f} MB')

    # ---------- Units ----------
    if 'units' not in skip:
        n_file = 1
        pack = Pack('units')
        pack.meta['units'] = {}
        # Grass and projectiles go in the first units file
        grass = Image.open(os.path.join(common, 'terrain', 'textures', '2x', 'g_grs.dds')).convert('RGB')
        buf = io.BytesIO()
        grass.resize((1024, 1024), Image.LANCZOS).save(buf, 'WEBP', quality=85)
        pack.meta['grass'] = pack.add(buf.getvalue())
        pack.meta['projectiles'] = {}
        names = set()
        for uid in units:
            u = dat.civs[1].units[uid]
            if u.type_50 and u.type_50.projectile_unit_id >= 0:
                gid = dat.civs[1].units[u.type_50.projectile_unit_id].standing_graphic[0]
                if gid >= 0:
                    names.add(gid)
        # Chemistry's burning versions of every projectile it upgrades
        chem = {c.a: c.b for c in dat.effects[dat.techs[47].effect_id].effect_commands if c.type == 3}
        for uid in units:
            u = dat.civs[1].units[uid]
            pid = u.type_50.projectile_unit_id if u.type_50 else -1
            if pid in chem and chem[pid] >= 0:
                gid = dat.civs[1].units[chem[pid]].standing_graphic[0]
                if gid >= 0:
                    names.add(gid)
        for gid in sorted(names):
            g, sld = sld_for(gid)
            if not sld:
                continue
            mode, images, frames = projectile_entry(g, sld)
            if not images:
                continue
            rects, height = pack_atlas(images, 512)
            atlas = Image.new('RGBA', (512, height), (0, 0, 0, 0))
            for img, (rx, ry, _, _) in zip(images, rects):
                atlas.paste(img, (rx, ry))
            for side, seq in frames.items():
                frames[side] = [list(rects[i]) + [ax, ay] for i, ax, ay in seq]
            b = io.BytesIO()
            atlas.save(b, 'WEBP', lossless=True)
            pack.meta['projectiles'][g.file_name] = {'mode': mode, 'fdur': g.frame_duration or 0.05,
                                                    'atlas': pack.add(b.getvalue()), 'frames': frames}

        for n, uid in enumerate(units, 1):
            u = dat.civs[1].units[uid]
            gids = {'idle': u.standing_graphic[0], 'walk': u.dead_fish.walking_graphic if u.dead_fish else -1,
                    'attack': u.type_50.attack_graphic if u.type_50 else -1, 'death': u.dying_graphic}
            images, masks, entries = [], [], {}
            for anim in ANIMS:
                g, sld = sld_for(gids[anim])
                if not sld:
                    continue
                per_angle = max(1, g.frame_count)
                step = max(1, -(-per_angle // MAX_FRAMES))
                picks = range(0, per_angle, step)
                seq = []
                for f in picks:
                    if f >= len(sld.frames):
                        continue
                    try:
                        comp = compose(sld.frame(f))   # angle 0: facing right
                    except KeyError:
                        continue
                    if comp is None:
                        continue
                    img, m, ax, ay = comp
                    seq.append([len(images), ax, ay])
                    images.append(img)
                    masks.append(m)
                entries[anim] = {'fdur': g.frame_duration * step, 'frames': seq}
            for anim, (gid, fdur) in EXTRA_ANIMS.get(uid, {}).items():
                g, sld = sld_for(gid)
                if not sld:
                    continue
                seq = []
                for f in range(max(1, g.frame_count)):
                    comp = compose(sld.frame(f))
                    if comp is None:
                        continue
                    img, m, ax, ay = comp
                    seq.append([len(images), ax, ay])
                    images.append(img)
                    masks.append(m)
                entries[anim] = {'fdur': fdur, 'frames': seq}
            if not images:
                continue
            atlas, mask, rects = atlas_pair(images, masks)
            for e in entries.values():
                e['frames'] = [list(rects[i]) + [ax, ay] for i, ax, ay in e['frames']]
            entry = {'radius': round(float(u.collision_size_x), 3), 'atlas': pack.add(atlas), 'anims': entries}
            if mask:
                entry['mask'] = pack.add(mask)
            pack.meta['units'][str(uid)] = entry
            print(f'[{n}/{len(units)}] {u.name}: {len(images)} frames, {(len(atlas) + len(mask or b"")) // 1024} KB')
            if pack.size > args.split_mb * 1e6:
                finish(pack, f'units-{n_file}.aoe2pack')
                n_file += 1
                pack = Pack('units')
                pack.meta['units'] = {}
        if pack.meta['units']:
            finish(pack, f'units-{n_file}.aoe2pack')

    # ---------- Buildings ----------
    if 'buildings' not in skip:
        pack = Pack('buildings')
        pack.meta['buildings'] = {}
        pack.meta['sets'] = {}
        done = {}
        for c in dat.civs[1:]:
            key = CIV_KEYS.get(c.name, c.name)
            if key not in tt['civs']:
                continue
            sets = {}
            for kind, uid in BUILDINGS.items():
                if uid >= len(c.units) or not c.units[uid]:
                    continue
                gid = c.units[uid].standing_graphic[0]
                g, sld = sld_for(gid)
                if not sld:
                    continue
                name = g.file_name
                if name not in done:
                    comp = compose(sld.frame(0))
                    if comp is None:
                        continue
                    img, m, ax, ay = comp
                    atlas, mask, rects = atlas_pair([img], [m], width=img.width)
                    e = {'atlas': pack.add(atlas), 'frame': list(rects[0]) + [ax, ay]}
                    if mask:
                        e['mask'] = pack.add(mask)
                    pack.meta['buildings'][name] = e
                    done[name] = True
                    print(f'Building {name}: {img.width}x{img.height}')
                sets[kind] = name
            pack.meta['sets'][key] = sets
        # Rubble left where a building falls (the game's foundation rubble, the same for every civ)
        pack.meta['rubble'] = {}
        for kind, uid in BUILDINGS.items():
            u = dat.civs[1].units[uid]
            gid = u.building.destruction_rubble_graphic_id if u.building else -1
            g, sld = sld_for(gid)
            if not sld:
                continue
            comp = compose(sld.frame(0))
            if comp is None:
                continue
            img, m, ax, ay = comp
            atlas, _, rects = atlas_pair([img], [m], width=img.width)
            pack.meta['rubble'][kind] = {'atlas': pack.add(atlas), 'frame': list(rects[0]) + [ax, ay]}
        # The gold mine (Gaia's), every variation
        pack.meta['nature'] = {}
        g0 = dat.civs[0].units[66]
        g, sld = sld_for(g0.standing_graphic[0])
        if sld:
            images, masks, frames = [], [], []
            for f in range(len(sld.frames)):
                comp = compose(sld.frame(f))
                if comp is None:
                    continue
                img, m, ax, ay = comp
                frames.append((ax, ay)); images.append(img); masks.append(m)
            atlas, _, rects = atlas_pair(images, masks)
            pack.meta['nature']['goldmine'] = {'atlas': pack.add(atlas), 'frames': [list(r) + [ax, ay] for r, (ax, ay) in zip(rects, frames)]}
            print(f'Gold mine: {len(images)} variations')
        # Construction sites: the game's scaffolding, in its build stages (the same for every civ)
        pack.meta['foundations'] = {}
        for kind, uid in BUILDINGS.items():
            u = dat.civs[1].units[uid]
            gid = u.building.construction_graphic_id if u.building else -1
            g, sld = sld_for(gid)
            if not sld or kind == 'wonder':
                continue
            images, masks, frames = [], [], []
            for f in range(len(sld.frames)):
                comp = compose(sld.frame(f))
                if comp is None:
                    continue
                img, m, ax, ay = comp
                frames.append((ax, ay))
                images.append(img)
                masks.append(m)
            if not images:
                continue
            atlas, _, rects = atlas_pair(images, masks)
            pack.meta['foundations'][kind] = {'atlas': pack.add(atlas), 'frames': [list(r) + [ax, ay] for r, (ax, ay) in zip(rects, frames)]}
            print(f'Foundation {kind}: {g.file_name}, {len(images)} stages')
        finish(pack, 'buildings.aoe2pack')

    # ---------- Terrain: water, shore, trees ----------
    if 'terrain' not in skip:
        pack = Pack('terrain')
        tex = os.path.join(common, 'terrain', 'textures', '2x')
        pack.meta['textures'] = {}
        for name, file in (('water', 'g_wt2.dds'), ('shallow', 'g_wtr.dds'), ('beach', 'g_bch.dds'), ('wetbeach', 'g_beach_wet.dds')):
            path = os.path.join(tex, file)
            if not os.path.exists(path):
                print(f'  missing {file}, skipped')
                continue
            b = io.BytesIO()
            Image.open(path).convert('RGB').resize((512, 512), Image.LANCZOS).save(b, 'WEBP', quality=82)
            pack.meta['textures'][name] = pack.add(b.getvalue())
        # Shore foam: the game's animated wave sheet (8 x 8 frames, a grey alpha mask) as white foam
        foam = os.path.join(common, 'terrain', 'water', 'atlas_v1_ortho_1.png')
        if os.path.exists(foam):
            m = Image.open(foam).convert('L').resize((1024, 1024), Image.LANCZOS)
            white = Image.new('RGBA', m.size, (255, 255, 255, 0))
            white.putalpha(m)
            b = io.BytesIO()
            white.save(b, 'WEBP', quality=80, method=4)
            pack.meta['foam'] = {'atlas': pack.add(b.getvalue()), 'cols': 8, 'rows': 8, 'size': 128}
            print(f'Foam: {len(b.getvalue()) // 1024} KB')
        pack.meta['trees'] = {}
        for name in ('n_tree_oak_x1', 'n_tree_green_oak_x1', 'n_tree_pine_x1', 'n_tree_willow_x1', 'n_tree_palm_x1', 'n_tree_bush_a_x1', 'n_tree_reeds_x1'):
            path = os.path.join(gfx_dir, name + '.sld')
            if not os.path.exists(path):
                continue
            sld = SLD(path)
            images, masks, frames = [], [], []
            for f in range(len(sld.frames)):
                comp = compose(sld.frame(f))
                if comp is None:
                    continue
                img, m, ax, ay = comp
                frames.append([len(images), ax, ay])
                images.append(img)
                masks.append(m)
            if not images:
                continue
            atlas, _, rects = atlas_pair(images, masks)
            pack.meta['trees'][name] = {'atlas': pack.add(atlas), 'frames': [list(rects[i]) + [ax, ay] for i, ax, ay in frames]}
            print(f'Tree {name}: {len(images)} variations')
        finish(pack, 'terrain.aoe2pack')

    manifest_path = os.path.join(args.out_dir, 'manifest.json')
    old = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {'files': []}
    keep = [f for f in old['files'] if f['name'] not in {x['name'] for x in files}]
    manifest = {'format': VERSION, 'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'files': sorted(keep + files, key=lambda f: f['name'])}
    json.dump(manifest, open(manifest_path, 'w'), indent=1)
    print(f'manifest.json: {len(manifest["files"])} files, {sum(f["size"] for f in manifest["files"]) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
