"""Decoder for Age of Empires II: DE ".sld" sprite files.

Written from the format description in the openage project's documentation
(doc/media/sld-files.md). Layers are stored as 4x4 blocks compressed with
BC1 (colour) or BC4 (single channel), drawn via a skip/draw command list.
Frames can reuse blocks from the previous frame, so decoding is sequential.
"""
import struct
import numpy as np

MAIN, SHADOW, OUTLINE, DAMAGE, PCOLOR = 1, 2, 4, 8, 16
ORDER = [MAIN, SHADOW, OUTLINE, DAMAGE, PCOLOR]


def _bc1(blocks):
    """blocks: (n, 8) uint8 -> (n, 4, 4, 4) uint8 RGBA."""
    n = len(blocks)
    c = blocks[:, :4].copy().view('<u2').reshape(n, 2).astype(np.int32)
    bits = blocks[:, 4:].copy().view('<u4').reshape(n).astype(np.uint32)

    def rgb(v):
        return np.stack([((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31], -1)

    p0, p1 = rgb(c[:, 0]), rgb(c[:, 1])
    four = (c[:, 0] > c[:, 1])[:, None]
    p2 = np.where(four, (2 * p0 + p1) // 3, (p0 + p1) // 2)
    p3 = np.where(four, (p0 + 2 * p1) // 3, 0)
    pal = np.stack([p0, p1, p2, p3], 1)                       # n,4,3
    alpha = np.full((n, 4), 255)
    alpha[:, 3] = np.where(four[:, 0], 255, 0)
    pal = np.concatenate([pal, alpha[..., None]], -1)         # n,4,4
    idx = (bits[:, None] >> (2 * np.arange(16, dtype=np.uint32))) & 3   # n,16
    out = np.take_along_axis(pal, idx[..., None].astype(np.int64).repeat(4, -1), 1)
    return out.reshape(n, 4, 4, 4).astype(np.uint8)


def _bc4(blocks):
    """blocks: (n, 8) uint8 -> (n, 4, 4) uint8."""
    n = len(blocks)
    a0 = blocks[:, 0].astype(np.int32)
    a1 = blocks[:, 1].astype(np.int32)
    bits = np.zeros(n, dtype=np.uint64)
    for i in range(6):
        bits |= blocks[:, 2 + i].astype(np.uint64) << np.uint64(8 * i)
    eight = (a0 > a1)[:, None]
    i7 = np.arange(1, 7)
    pal8 = ((7 - i7) * a0[:, None] + i7 * a1[:, None]) // 7
    i5 = np.arange(1, 5)
    pal6 = np.concatenate([((5 - i5) * a0[:, None] + i5 * a1[:, None]) // 5,
                           np.zeros((n, 1), int), np.full((n, 1), 255)], 1)
    pal = np.concatenate([a0[:, None], a1[:, None], np.where(eight, pal8, pal6)], 1)
    idx = ((bits[:, None] >> (np.uint64(3) * np.arange(16, dtype=np.uint64))) & np.uint64(7)).astype(np.int64)
    return np.take_along_axis(pal, idx, 1).reshape(n, 4, 4).astype(np.uint8)


class Layer:
    __slots__ = ('x1', 'y1', 'w', 'h', 'img')

    def __init__(self, x1, y1, w, h, img):
        self.x1, self.y1, self.w, self.h, self.img = x1, y1, w, h, img


class SLD:
    def __init__(self, path):
        self.data = data = open(path, 'rb').read()
        sig, _version, nframes, _, header_size, _ = struct.unpack_from('<4s5H', data)
        if sig != b'SLDX':
            raise ValueError(f'{path}: not an SLD file')
        self.frames = []
        off = header_size
        for _ in range(nframes):
            cw, ch, hx, hy, ftype, _, findex = struct.unpack_from('<4H2BH', data, off)
            off += 12
            frame = {'canvas': (cw, ch), 'hotspot': (hx, hy), 'index': findex, 'layers': {}}
            geom = None
            for lt in ORDER:
                if not ftype & lt:
                    continue
                length, = struct.unpack_from('<I', data, off)
                start = off
                off += 4
                if lt in (MAIN, SHADOW):
                    x1, y1, x2, y2, f0, _ = struct.unpack_from('<4H2B', data, off)
                    off += 10
                    g = (x1, y1, max(0, x2 - x1), max(0, y2 - y1))
                    if lt == MAIN:
                        geom = g
                elif lt == OUTLINE:
                    off = start + length
                    off += (4 - (off - header_size)) % 4
                    continue
                else:
                    f0, _ = struct.unpack_from('<2B', data, off)
                    off += 2
                    g = geom
                ncmd, = struct.unpack_from('<H', data, off)
                off += 2
                frame['layers'][lt] = (g, bool(f0 & 0x80) and findex > 0, off, ncmd)
                off = start + length
                off += (4 - (off - header_size)) % 4
            self.frames.append(frame)
        self._cache = {}

    def _decode_layer(self, fi, lt):
        key = (fi, lt)
        if key in self._cache:
            return self._cache[key]
        frame = self.frames[fi]
        if lt not in frame['layers']:
            return None
        (x1, y1, w, h), reuse, off, ncmd = frame['layers'][lt]
        prev = self._decode_layer(fi - 1, lt) if reuse and fi > 0 else None
        data = self.data
        cmds = np.frombuffer(data, np.uint8, 2 * ncmd, off).reshape(ncmd, 2).astype(int)
        nblocks = int(cmds[:, 1].sum())
        raw = np.frombuffer(data, np.uint8, 8 * nblocks, off + 2 * ncmd).reshape(nblocks, 8)
        color = lt in (MAIN, DAMAGE)
        dec = _bc1(raw) if color else _bc4(raw)
        bw, bh = (w + 3) // 4, (h + 3) // 4
        shape = (bh * 4, bw * 4, 4) if color else (bh * 4, bw * 4)
        img = np.zeros(shape, np.uint8)
        if prev is not None:
            # skipped blocks keep the previous frame's pixels at the same canvas position
            px, py = x1 - prev.x1, y1 - prev.y1
            sy0, sx0 = max(0, -py), max(0, -px)
            sy1, sx1 = min(img.shape[0], prev.img.shape[0] - py), min(img.shape[1], prev.img.shape[1] - px)
            if sy1 > sy0 and sx1 > sx0:
                img[sy0:sy1, sx0:sx1] = prev.img[sy0 + py:sy1 + py, sx0 + px:sx1 + px]
        pos = 0
        k = 0
        for skip, draw in cmds:
            pos += skip
            for _ in range(draw):
                by, bx = divmod(pos, bw)
                img[by * 4:by * 4 + 4, bx * 4:bx * 4 + 4] = dec[k]
                k += 1
                pos += 1
        layer = Layer(x1, y1, w, h, img)
        self._cache[key] = layer
        return layer

    def frame(self, fi):
        """Returns dict with canvas, hotspot and decoded MAIN/SHADOW/PCOLOR layers."""
        f = self.frames[fi]
        out = {'canvas': f['canvas'], 'hotspot': f['hotspot']}
        for lt in (MAIN, SHADOW, PCOLOR):
            out[lt] = self._decode_layer(fi, lt)
        return out
