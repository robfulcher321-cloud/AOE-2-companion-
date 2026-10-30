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
ATTRS = {0: 'hp', 5: 'speed', 8: 'armour', 9: 'attack', 10: 'reload', 11: 'accuracy', 12: 'range', 102: 'projectiles',
         # special abilities (UGC guide attribute list)
         22: 'blast width', 24: 'bonus damage resistance', 59: 'max charge', 60: 'recharge rate',
         61: 'charge event', 62: 'charge type', 63: 'combat ability', 109: 'regeneration',
         115: 'area damage', 118: 'damage reflection',
         # costs: 100 all resources, 103 food, 104 wood, 105 stone, 106 gold
         100: 'cost', 103: 'food cost', 104: 'wood cost', 105: 'stone cost', 106: 'gold cost'}
CASTLE = 82
AGE_OF = {101: 2, 102: 3, 103: 4}   # Feudal, Castle, Imperial age techs
# Techs the duel lets the player choose: Blacksmith lines (melee and archer),
# Bloodlines, Thumb Ring, Parthian Tactics, Chemistry, Squires, Husbandry
PLAYER_TECHS = [67, 68, 75, 74, 76, 77, 81, 82, 80, 199, 200, 201, 211, 212, 219,
                435, 437, 436, 47, 215, 39]
PROJECTILE_CLASS = 11
BALLISTICS = 93


def duel_eligible(u):
    """Land units that fight: infantry, cavalry, elephants, archers, camels and siege
    (rams and trebuchets too: AOSiege sends them at buildings); no ships."""
    classes = {a['Class'] for a in u['Armours']}
    if not u['Attack'] > 0 or classes & {16}:
        return False
    # 30: camels (incl. Mameluke) have their own class, not Cavalry. 1263 Flaming Camel, 440 Petard: suicide units.
    if u.get('ID') in (1263, 440):
        return False
    return bool(classes & {1, 5, 8, 15, 17, 20, 30})


def ranged_record(dat, uid):
    """How a ranged unit's projectiles fly: speed (tiles/s), sprite, count, spread and the
    extra projectiles' own attacks (e.g. the Chu Ko Nu's extra arrows)."""
    u = dat.civs[1].units[uid]
    t50 = u.type_50
    pid = t50.projectile_unit_id
    if pid < 0:
        return None
    p = dat.civs[1].units[pid]
    gid = p.standing_graphic[0]
    rec = {
        'speed': round(float(p.speed), 3),
        'arc': round(float(p.projectile.projectile_arc), 3),
        'sprite': dat.graphics[gid].file_name if gid >= 0 else None,
        'count': int(u.creatable.total_projectiles),
        'spread': round(float(t50.accuracy_dispersion), 3),
        'blast': round(float(t50.blast_width), 3),
        # Ballistics (tech 93) makes these projectiles lead moving targets
        'ballistics': any(c.c == 19 and c.a == pid for c in dat.effects[dat.techs[BALLISTICS].effect_id].effect_commands),
        # smart mode bit 2: a stray hit on another unit does full damage instead of half
        'fullStray': bool(int(p.projectile.smart_mode) & 2),
        # chakrams fly through and hit everything in their path
        'pierces': int(p.projectile.hit_mode) == 1 and int(p.projectile.vanish_mode) == 1,
    }
    sec = u.creatable.secondary_projectile_unit
    if rec['count'] > 1 and sec >= 0:
        s = dat.civs[1].units[sec]
        rec['secondary'] = {'id': sec, 'attacks': [[a.class_, a.amount] for a in s.type_50.attacks]}
    return rec


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


# Units that fight on as another unit when killed (help text: "fights on as
# Infantry when felled"); the game handles this in code, not in the data.
DISMOUNT = {1225: 1252, 1227: 1253}
# Charge types the duel models (UGC guide): 1 attack charge, 3 area attack
# charge, 4 agility (dodge projectiles), 5 ignore melee attacks, 6 charge
# projectiles, 7 charge projectile plus extra projectiles.
CHARGE_TYPES = {1, 3, 4, 5, 6, 7}


def projectile_record(dat, pid, count=1):
    p = dat.civs[1].units[pid]
    t50 = p.type_50
    gid = p.standing_graphic[0]
    return {
        'id': pid,
        'attacks': [[a.class_, a.amount] for a in t50.attacks],
        'speed': round(float(p.speed), 3),
        'arc': round(float(p.projectile.projectile_arc), 3),
        'sprite': dat.graphics[gid].file_name if gid >= 0 else None,
        'minRange': round(float(t50.min_range), 3),
        'accuracy': int(t50.accuracy_percent),
        'spread': round(float(t50.accuracy_dispersion), 3),
        'fullStray': bool(int(p.projectile.smart_mode) & 2),
        'count': count,
        # combat ability on the projectile itself: 1 = ignores armour (Fire Lancer, Hearth Troop)
        'combat': int(t50.break_off_combat),
    }


def special_record(dat, uid):
    """Charge abilities, area (trample) damage, armour-ignoring and the like for one unit."""
    u = dat.civs[1].units[uid]
    c = u.creatable
    t50 = u.type_50
    rec = {}
    if c.charge_type in CHARGE_TYPES and c.max_charge > 0 and c.recharge_rate < 1000:
        ch = {'type': int(c.charge_type), 'max': round(float(c.max_charge), 3),
              'rate': round(float(c.recharge_rate), 5), 'event': int(c.charge_event)}
        if c.charge_type in (6, 7) and c.charge_projectile_unit >= 0:
            ch['projectile'] = projectile_record(dat, c.charge_projectile_unit,
                                                 int(c.max_total_projectiles) if c.charge_type == 6 else 1)
            if c.charge_type == 7 and c.secondary_projectile_unit >= 0:
                ch['extra'] = projectile_record(dat, c.secondary_projectile_unit, int(c.max_total_projectiles) - 1)
        rec['charge'] = ch
    for task in u.bird.tasks:
        if task.action_type == 133:   # charge into battle (Samurai): speed boost between two distances
            rec['rush'] = {'from': round(float(task.work_value_1), 3), 'to': round(float(task.work_value_2), 3),
                           'speed': round(float(task.work_range), 3)}
    if t50.blast_width > 0 and not RANGED_ONLY(u):
        rec['blast'] = {'width': round(float(t50.blast_width), 3), 'level': int(t50.blast_attack_level),
                        'damage': round(float(t50.blast_damage), 3)}
    elif t50.blast_damage != 1.0:
        rec['blastDamage'] = round(float(t50.blast_damage), 3)   # used if a tech adds a blast later
    if t50.break_off_combat & 0b101:
        rec['combat'] = int(t50.break_off_combat)
    if t50.bonus_damage_resistance:
        rec['bonusResist'] = round(float(t50.bonus_damage_resistance), 3)
    if t50.damage_reflection:
        rec['reflect'] = round(float(t50.damage_reflection), 3)
    if uid in DISMOUNT:
        rec['dismount'] = DISMOUNT[uid]
    return rec


def RANGED_ONLY(u):
    return u.type_50.projectile_unit_id >= 0


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

    ranged = {uid: r for uid in unit_ids if (r := ranged_record(dat, uid))}
    unit_ids = sorted(set(unit_ids) | set(DISMOUNT.values()))
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
    # Upgrade techs (e.g. Elite Fire Lancer) can also change the new unit's
    # projectiles; keep their stat changes, keyed by the unit they upgrade to.
    upgrades = {}
    for ti, tech in enumerate(dat.techs):
        if not (0 <= tech.effect_id < len(dat.effects)):
            continue
        cmds = dat.effects[tech.effect_id].effect_commands
        targets = {c.b for c in cmds if c.type == 3 and c.b in units}
        rec = tech_record(dat, ti)
        if targets and rec['cmds']:
            for uid in targets:
                upgrades[uid] = rec

    with open(os.path.join(args.out, 'effects.js'), 'w') as fh:
        fh.write('// Civ bonuses, team bonuses and unique-tech stat effects, extracted from the\n')
        fh.write('// game data file by tools/extract_effects.py. Command: [type, unit, class, attribute, value]\n')
        fh.write('// type 0 = set, 4 = add, 5 = multiply; attribute 0 HP, 5 speed, 8 armour, 9 attack, 10 reload.\n')
        fh.write('export const UNIT_CLASS = ' + json.dumps({k: v['class'] for k, v in units.items()}, separators=(',', ':')) + ';\n')
        fh.write('export const PLAYER_TECHS = ' + json.dumps(player, separators=(',', ':')) + ';\n')
        fh.write('export const UNIT_UPGRADES = ' + json.dumps(upgrades, separators=(',', ':')) + ';\n')
        fh.write('export const CIV_EFFECTS = ' + json.dumps(civs, separators=(',', ':')) + ';\n')
    with open(os.path.join(args.out, 'radii.js'), 'w') as fh:
        fh.write('// Collision radius in tiles per unit ID, read from the game data file (empires2_x2_p1.dat)\n')
        fh.write('// by tools/extract_effects.py.\n')
        fh.write('export const RADII = ' + json.dumps({k: v['radius'] for k, v in units.items()}, separators=(',', ':')) + ';\n')
    extra_ids = set(unit_ids) | set(DISMOUNT.values())
    specials = {uid: r for uid in sorted(extra_ids) if (r := special_record(dat, uid))}
    with open(os.path.join(args.out, 'specials.js'), 'w') as fh:
        fh.write('// Special abilities per unit ID, read from the game data file by tools/extract_effects.py.\n')
        fh.write('// charge: type 1 attack charge, 3 area charge, 4 dodge projectiles, 5 block melee,\n')
        fh.write('//   6 charge projectiles, 7 charge projectile + extras; max/rate (per second)/event as in the data.\n')
        fh.write('// rush: speed boost when charging in from `from` to `to` tiles (Samurai).\n')
        fh.write('// blast: melee area damage (width tiles; damage >0 = share of the hit, <0 = fixed amount).\n')
        fh.write('// combat: 1 ignores armour, 4 strips 1 armour per hit. dismount: unit that fights on.\n')
        fh.write('export const SPECIALS = ' + json.dumps(specials, separators=(',', ':')) + ';\n')
    with open(os.path.join(args.out, 'ranged.js'), 'w') as fh:
        fh.write('// Projectile data per ranged unit ID, read from the game data file by tools/extract_effects.py.\n')
        fh.write('// speed in tiles per second; spread = miss distance per tile of range; count = projectiles per shot.\n')
        fh.write(f'export const PROJECTILE_CLASS = {PROJECTILE_CLASS};\n')
        fh.write('export const RANGED = ' + json.dumps(ranged, separators=(',', ':')) + ';\n')
    print(f'{len(civs)} civs, {len(units)} units ({len(ranged)} ranged) written')


if __name__ == '__main__':
    main()
