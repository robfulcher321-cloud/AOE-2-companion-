"""Build a private sprite pack for the AoE2 Companion duel arena.

Reads unit animations and the grass texture from YOUR OWN copy of
Age of Empires II: Definitive Edition and writes one .aoe2pack file that the
app imports and keeps on your device. The pack contains Microsoft's game art,
so don't commit or share it; this script contains no game art itself.

Usage:
  pip install genieutils-py numpy pillow
  python tools/make_sprite_pack.py --game "D:/Steam/steamapps/common/AoE2DE" --out sprites.aoe2pack

Options:
  --units 554,569      only these unit IDs (default: every unit the duel supports)
  --techtree data.json aoe2techtree's data.json (default: downloaded)
"""
import argparse
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
SIDES = [  # (name, facing angle out of 16, player colour)
    ('blue', 0, (52, 104, 236)),   # left side, faces right
    ('red', 8, (226, 40, 32)),     # right side, faces left
]
MAX_FRAMES = 30
SHADOW_ALPHA = 0.55
MAGIC = b'AOE2PACK'


# Projectiles whose frames are tilt steps along the flight (rising -> falling);
# the rest (axes, chakrams, bolas...) spin, so their frames loop.
PITCHED = ('arrow', 'dart', 'spear', 'bolt')


def duel_eligible(u):
    """Land units that fight, melee or ranged; no siege, rams or ships."""
    classes = {a['Class'] for a in u['Armours']}
    if not u['Attack'] > 0:
        return False
    if classes & {16, 17, 20}:
        return False
    # 30: camels (incl. Mameluke) have their own class, not Cavalry. 1263 Flaming Camel, 440 Petard: suicide units.
    if u.get('ID') in (1263, 440):
        return False
    return bool(classes & {1, 5, 8, 15, 30})


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
                comp = compose(sld.frame(fi), (200, 200, 200))
            except KeyError:
                comp = None
            if comp is None:
                continue
            img, ax, ay = comp
            seq.append([len(images), ax, ay])
            images.append(img)
        frames[side] = seq
    return mode, images, frames


def compose(frame, colour):
    """Main layer with player colour applied, over its shadow. Returns (RGBA image, hotspot x, y)."""
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
    if shadow is not None and shadow.w:
        a = shadow.img.astype(np.float32) / 255 * SHADOW_ALPHA
        sl = canvas[shadow.y1 - y0:shadow.y1 - y0 + a.shape[0], shadow.x1 - x0:shadow.x1 - x0 + a.shape[1]]
        sl[..., 3] = np.maximum(sl[..., 3], a)
    rgba = main.img.astype(np.float32)
    pc = frame[PCOLOR]
    if pc is not None and pc.w:
        m = pc.img.astype(np.float32)[..., None] / 255
        lum = rgba[..., :3].mean(-1, keepdims=True) / 255
        tint = np.clip(np.array(colour, np.float32) * lum * 1.7, 0, 255)
        rgba[..., :3] = rgba[..., :3] * (1 - m) + tint * m
    a = rgba[..., 3:] / 255
    dst = canvas[main.y1 - y0:main.y1 - y0 + a.shape[0], main.x1 - x0:main.x1 - x0 + a.shape[1]]
    dst[..., :3] = rgba[..., :3] * a + dst[..., :3] * (1 - a)
    dst[..., 3:] = a + dst[..., 3:] * (1 - a)
    out = np.zeros_like(canvas)
    out[..., :3] = np.where(canvas[..., 3:] > 0, canvas[..., :3], 0)
    out[..., 3] = canvas[..., 3] * 255
    img = Image.fromarray(out.clip(0, 255).astype(np.uint8), 'RGBA')
    bbox = img.getbbox()
    if not bbox:
        return None
    img = img.crop(bbox)
    hx, hy = frame['hotspot']
    return img, hx - x0 - bbox[0], hy - y0 - bbox[1]


def pack_atlas(images, width=2048):
    """Shelf-pack images. Returns (atlas image, [(x, y, w, h)])."""
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
    atlas = Image.new('RGBA', (width, y + shelf), (0, 0, 0, 0))
    for img, (rx, ry, _, _) in zip(images, rects):
        atlas.paste(img, (rx, ry))
    return atlas, rects


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True, help='AoE2 DE install folder')
    ap.add_argument('--out', default='sprites.aoe2pack')
    ap.add_argument('--units', default='')
    ap.add_argument('--techtree', default='')
    args = ap.parse_args()

    from genieutils.datfile import DatFile
    common = os.path.join(args.game, 'resources', '_common')
    print('Reading game data...')
    dat = DatFile.parse(os.path.join(common, 'dat', 'empires2_x2_p1.dat'))
    if args.techtree:
        tt = json.load(open(args.techtree))
    else:
        tt = json.load(urllib.request.urlopen(TECHTREE_URL))
    units = [int(i) for i in args.units.split(',') if i] or \
        sorted(int(k) for k, u in tt['data']['Unit'].items() if duel_eligible(u))

    blobs = []
    meta = {'version': 1, 'created': time.strftime('%Y-%m-%d'), 'tileSize': 96, 'units': {}}

    def add_blob(data):
        off = sum(len(b) for b in blobs)
        blobs.append(data)
        return [off, len(data)]

    grass = Image.open(os.path.join(common, 'terrain', 'textures', '2x', 'g_grs.dds')).convert('RGB')
    buf = io.BytesIO()
    grass.resize((1024, 1024), Image.LANCZOS).save(buf, 'WEBP', quality=85)
    meta['grass'] = add_blob(buf.getvalue())

    gfx_dir = os.path.join(common, 'drs', 'graphics')
    for n, uid in enumerate(units, 1):
        u = dat.civs[1].units[uid]
        gids = {'idle': u.standing_graphic[0], 'walk': u.dead_fish.walking_graphic,
                'attack': u.type_50.attack_graphic, 'death': u.dying_graphic}
        images, entries = [], {}
        for anim in ANIMS:
            gid = gids[anim]
            if gid < 0:
                continue
            g = dat.graphics[gid]
            path = os.path.join(gfx_dir, g.file_name + '.sld')
            if not os.path.exists(path):
                print(f'  missing {g.file_name}.sld, skipped')
                continue
            sld = SLD(path)
            per_angle = g.frame_count
            step = max(1, -(-per_angle // MAX_FRAMES))
            picks = list(range(0, per_angle, step))
            entry = {'fdur': g.frame_duration * step, 'frames': {}}
            for side, angle, colour in SIDES:
                angle_idx = angle * g.angle_count // 16
                frames = []
                for f in picks:
                    fi = angle_idx * per_angle + f
                    if fi >= len(sld.frames):
                        continue
                    comp = compose(sld.frame(fi), colour)
                    if comp is None:
                        continue
                    img, ax, ay = comp
                    frames.append([len(images), ax, ay])
                    images.append(img)
                entry['frames'][side] = frames
            entries[anim] = entry
        if not images:
            continue
        atlas, rects = pack_atlas(images)
        for entry in entries.values():
            for side, frames in entry['frames'].items():
                entry['frames'][side] = [list(rects[i]) + [ax, ay] for i, ax, ay in frames]
        buf = io.BytesIO()
        atlas.save(buf, 'WEBP', quality=88, method=4)
        meta['units'][str(uid)] = {
            'radius': round(float(u.collision_size_x), 3),
            'atlas': add_blob(buf.getvalue()),
            'anims': entries,
        }
        print(f'[{n}/{len(units)}] {u.name}: {len(images)} frames, {len(buf.getvalue()) // 1024} KB')

    # Projectile sprites used by the ranged units in the pack
    meta['projectiles'] = {}
    names = set()
    for uid in units:
        pid = dat.civs[1].units[uid].type_50.projectile_unit_id
        if pid >= 0:
            gid = dat.civs[1].units[pid].standing_graphic[0]
            if gid >= 0:
                names.add(gid)
    for gid in sorted(names):
        g = dat.graphics[gid]
        path = os.path.join(gfx_dir, g.file_name + '.sld')
        if not os.path.exists(path):
            print(f'  missing {g.file_name}.sld, skipped')
            continue
        mode, images, frames = projectile_entry(g, SLD(path))
        if not images:
            print(f'  {g.file_name}: no visible frames (drawn as a tracer in the app)')
            continue
        atlas, rects = pack_atlas(images, width=512)
        for side, seq in frames.items():
            frames[side] = [list(rects[i]) + [ax, ay] for i, ax, ay in seq]
        buf = io.BytesIO()
        atlas.save(buf, 'WEBP', lossless=True)
        meta['projectiles'][g.file_name] = {'mode': mode, 'fdur': g.frame_duration or 0.05,
                                            'atlas': add_blob(buf.getvalue()), 'frames': frames}
        print(f'Projectile {g.file_name}: {len(images)} frames ({mode})')

    header = json.dumps(meta, separators=(',', ':')).encode()
    with open(args.out, 'wb') as fh:
        fh.write(MAGIC + struct.pack('<II', 1, len(header)) + header)
        for b in blobs:
            fh.write(b)
    print(f'Wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB, {len(meta["units"])} units)')


if __name__ == '__main__':
    main()
