"""Extract civ bonuses, team bonuses and unique-tech stat effects from the
AoE2 DE data file into js/duel/effects.js, plus each duel unit's class and
collision size (js/duel/radii.js).

Usage:
  pip install genieutils-py
  python tools/extract_effects.py --game "D:/Steam/steamapps/common/AoE2DE"

Effect commands kept: attribute set (0), add (4) and multiply (5) on the
attributes the duel uses. Armour/attack values pack class*256 + amount.
"""
import argparse
import json
import os
import urllib.request

TECHTREE_URL = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/data.json'
# dat civ names that differ from aoe2techtree's civ keys
CIV_ALIASES = {'British': 'Britons', 'French': 'Franks', 'Byzantine': 'Byzantines', 'Mayan': 'Mayans'}
ATTRS = {0: 'hp', 5: 'speed', 8: 'armour', 9: 'attack', 10: 'reload'}
CASTLE = 82
AGE_OF = {101: 2, 102: 3, 103: 4}   # Feudal, Castle, Imperial age techs
# Techs the duel lets the player choose: Blacksmith lines and Bloodlines
PLAYER_TECHS = [67, 68, 75, 74, 76, 77, 81, 82, 80, 435]


def duel_eligible(u):
    classes = {a['Class'] for a in u['Armours']}
    if not u['Attack'] > 0 or u['Range'] >= 1 or classes & {16, 17, 20}:
        return False
    return bool(classes & {1, 5, 8})


def commands(dat, effect_id):
    """Stat changes [type, unit, class, attribute, value] and techs this one disables."""
    cmds, disables = [], []
    if 0 <= effect_id < len(dat.effects):
        for c in dat.effects[effect_id].effect_commands:
            if c.type in (0, 4, 5) and c.c in ATTRS:
                cmds.append([c.type, c.a, c.b, c.c, round(float(c.d), 4)])
            elif c.type == 102:
                disables.append(int(c.d))
    return cmds, disables


def tech_record(dat, ti):
    tech = dat.techs[ti]
    cmds, disables = commands(dat, tech.effect_id)
    req = [r for r in tech.required_techs if r >= 0]
    age = max([AGE_OF[r] for r in req if r in AGE_OF] or [1])
    rec = {'id': ti, 'age': age, 'req': req, 'count': tech.required_tech_count, 'cmds': cmds}
    if disables:
        rec['disables'] = disables
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True)
    ap.add_argument('--techtree', default='')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'js', 'duel'))
    args = ap.parse_args()

    from genieutils.datfile import DatFile
    dat = DatFile.parse(os.path.join(args.game, 'resources', '_common', 'dat', 'empires2_x2_p1.dat'))
    tt = json.load(open(args.techtree)) if args.techtree else json.load(urllib.request.urlopen(TECHTREE_URL))
    unit_ids = sorted(int(k) for k, u in tt['data']['Unit'].items() if duel_eligible(u))

    units = {uid: {'class': dat.civs[1].units[uid].class_, 'radius': round(float(dat.civs[1].units[uid].collision_size_x), 3)}
             for uid in unit_ids}

    civs = {}
    for ci, civ in enumerate(dat.civs):
        key = CIV_ALIASES.get(civ.name, civ.name)
        if key not in tt['civs']:
            continue
        bonuses, uts = [], []
        for ti, tech in enumerate(dat.techs):
            if tech.civ != ci:
                continue
            costs = [r for r in tech.resource_costs if r.amount > 0 and r.type in (0, 1, 2, 3)]
            at_castle = any(r.location_id == CASTLE for r in tech.research_locations)
            if tech.name.startswith('C-Bonus'):
                rec = tech_record(dat, ti)
                if rec['cmds'] or rec.get('disables'):
                    rec['name'] = tech.name.split(',', 1)[-1].strip()
                    bonuses.append(rec)
            elif at_castle and costs and not tech.name.startswith('Elite '):
                uts.append(tech_record(dat, ti))
        team, _ = commands(dat, civ.team_bonus_id)
        civs[key] = {'bonuses': bonuses, 'team': team, 'uts': uts}

    player = {t: tech_record(dat, t) for t in PLAYER_TECHS}

    with open(os.path.join(args.out, 'effects.js'), 'w') as fh:
        fh.write('// Civ bonuses, team bonuses and unique-tech stat effects, extracted from the\n')
        fh.write('// game data file by tools/extract_effects.py. Command: [type, unit, class, attribute, value]\n')
        fh.write('// type 0 = set, 4 = add, 5 = multiply; attribute 0 HP, 5 speed, 8 armour, 9 attack, 10 reload.\n')
        fh.write('export const UNIT_CLASS = ' + json.dumps({k: v['class'] for k, v in units.items()}, separators=(',', ':')) + ';\n')
        fh.write('export const PLAYER_TECHS = ' + json.dumps(player, separators=(',', ':')) + ';\n')
        fh.write('export const CIV_EFFECTS = ' + json.dumps(civs, separators=(',', ':')) + ';\n')
    with open(os.path.join(args.out, 'radii.js'), 'w') as fh:
        fh.write('// Collision radius in tiles per unit ID, read from the game data file (empires2_x2_p1.dat)\n')
        fh.write('// by tools/extract_effects.py.\n')
        fh.write('export const RADII = ' + json.dumps({k: v['radius'] for k, v in units.items()}, separators=(',', ':')) + ';\n')
    print(f'{len(civs)} civs, {len(units)} units written')


if __name__ == '__main__':
    main()
