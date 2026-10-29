"""Refresh the build orders bundled with the app (the app also downloads new
ones on its own when online).

Build orders come from RTS Builds (https://github.com/CraftySalamander/rtsbuilds,
GPL-3.0), the library used by RTS Overlay; their note icons come from RTS
Overlay (https://github.com/CraftySalamander/RTS_Overlay, GPL-3.0).

Usage:
  git clone --depth 1 https://github.com/CraftySalamander/rtsbuilds
  git clone --depth 1 https://github.com/CraftySalamander/RTS_Overlay
  python tools/update_build_orders.py --rtsbuilds rtsbuilds --overlay RTS_Overlay
"""
import argparse
import json
import os
import re
import shutil

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def build_id(name):
    """Same rule RTS Builds uses for its file names."""
    return re.sub(r'[^a-zA-Z0-9]', '', name.lower())


def read_index(path):
    content = open(path, encoding='utf-8').read()
    match = re.search(r'const\s+aoe2_build_orders\s*=\s*(\[.*?\])\s*;', content, re.DOTALL)
    text = re.sub(r'/\*.*?\*/', '', match.group(1), flags=re.DOTALL)
    text = re.sub(r',\s*([}\]])', r'\1', text)
    return json.loads(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rtsbuilds', required=True)
    ap.add_argument('--overlay', required=True)
    args = ap.parse_args()

    out = os.path.join(ROOT, 'assets', 'builds')
    os.makedirs(os.path.join(out, 'aoe2'), exist_ok=True)
    index = read_index(os.path.join(args.rtsbuilds, 'docs', 'builds', 'aoe2_builds.js'))
    kept = []
    for entry in index:
        bid = build_id(entry['name'])
        src = os.path.join(args.rtsbuilds, 'docs', 'api', 'builds', 'aoe2', bid + '.json')
        if not os.path.exists(src):
            print('missing', bid)
            continue
        shutil.copyfile(src, os.path.join(out, 'aoe2', bid + '.json'))
        kept.append({**entry, 'id': bid})
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(kept, fh, indent=1)

    img = os.path.join(ROOT, 'img', 'bo')
    if os.path.exists(img):
        shutil.rmtree(img)
    shutil.copytree(os.path.join(args.overlay, 'docs', 'assets', 'aoe2'), img)
    print(f'{len(kept)} build orders, icons copied to img/bo')


if __name__ == '__main__':
    main()
