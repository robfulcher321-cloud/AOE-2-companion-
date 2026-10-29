#!/usr/bin/env python3
"""Make the app's starter build orders: an early-game build and a boom for every civ.

The RTS Builds library only has builds for some civs, so the app ships its own
pair for each one. They are adapted from Cicero's build order reference
(https://johsaoe2debuildorderreference.site44.com/):

  - 22 pop Scouts, 22 pop Archers, 22 pop Men-at-Arms into Archers (early game)
  - 27+2 Fast Castle Boom (boom)

Each civ gets the opener that suits it, plus changes for how the civ starts
and plays: Chinese start with 6 villagers, Huns build no houses, Settlements
replace the mill and camps for the South American civs, Khitans farm with
Pastures, Bengalis get 2 free villagers on age-up, Wei get one per economy
upgrade, Malay and Persians age up faster, and so on.

Times are what you get with non-stop villager production (25 s each, faster
for Persians), which is the "A" grade in Cicero's benchmarks.

  python3 tools/make_starter_builds.py   ->  assets/builds/starter.json
"""
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_BASE = 'https://johsaoe2debuildorderreference.site44.com/'

# ---- icons -----------------------------------------------------------------
I = {
    'v': '@resource/MaleVillDE.webp@', 'sheep': '@animal/Sheep_aoe2DE.webp@', 'boar': '@animal/Boar_aoe2DE.webp@',
    'deer': '@animal/Deer_aoe2DE.webp@', 'berries': '@resource/BerryBushDE.webp@',
    'wood': '@resource/Aoe2de_wood.webp@', 'gold': '@resource/Aoe2de_gold.webp@', 'stone': '@resource/Aoe2de_stone.webp@',
    'food': '@resource/Aoe2de_food.webp@',
    'house': '@other/House_aoe2DE.webp@', 'lc': '@lumber_camp/Lumber_camp_aoe2de.webp@', 'mill': '@mill/Mill_aoe2de.webp@',
    'mine': '@mining_camp/Mining_camp_aoe2de.webp@', 'farm': '@mill/FarmDE.webp@',
    'settlement': '@other/Settlement.webp@', 'folwark': '@mill/Aoe2-icon--folwark.webp@', 'pasture': '@mill/Pasture.webp@',
    'barracks': '@barracks/Barracks_aoe2DE.webp@', 'range': '@archery_range/Archery_range_aoe2DE.webp@',
    'stable': '@stable/Stable_aoe2DE.webp@', 'smith': '@blacksmith/Blacksmith_aoe2de.webp@', 'market': '@market/Market_aoe2DE.webp@',
    'tc': '@town_center/Towncenter_aoe2DE.webp@',
    'loom': '@town_center/LoomDE.webp@', 'wb': '@town_center/WheelbarrowDE.webp@', 'dba': '@lumber_camp/DoubleBitAxe_aoe2DE.webp@',
    'bowsaw': '@lumber_camp/BowSawDE.webp@', 'hc': '@mill/HorseCollarDE.webp@', 'fletch': '@blacksmith/FletchingDE.webp@',
    'maa': '@barracks/ManAtArmsUpgDE.webp@', 'militia': '@barracks/MilitiaDE.webp@', 'archer': '@archery_range/Archer_aoe2DE.webp@',
    'scoutcav': '@stable/Scoutcavalry_aoe2DE.webp@', 'eagle': '@barracks/Eaglescout_aoe2DE.webp@', 'champi': '@barracks/Champi_Scout.webp@',
    'knight': '@stable/Knight_aoe2DE.webp@', 'xbow': '@archery_range/Crossbowman_aoe2DE.webp@',
    'feudal': '@age/FeudalAgeIconDE.webp@', 'castle': '@age/CastleAgeIconDE.webp@',
}
ECO_TECHS = ('dba', 'hc', 'wb', 'bowsaw')  # Wei: a free villager for each


# ---- what each civ plays and how it starts ------------------------------------
SCOUTS = {'Berbers', 'Bengalis', 'Burgundians', 'Cumans', 'Franks', 'Georgians', 'Gurjaras', 'Hindustanis', 'Huns',
          'Jurchens', 'Khitans', 'Khmer', 'Lithuanians', 'Magyars', 'Mongols', 'Persians', 'Poles', 'Romans', 'Sicilians',
          'Spanish', 'Tatars', 'Turks', 'Varangians', 'Wei'}
ARCHERS = {'Britons', 'Byzantines', 'Chinese', 'Ethiopians', 'Incas', 'Italians', 'Koreans', 'Mapuche', 'Mayans', 'Muisca',
           'Portuguese', 'Saracens', 'Shu', 'Tupi', 'Vietnamese'}
MAA = {'Armenians', 'Aztecs', 'Bohemians', 'Bulgarians', 'Burmese', 'Celts', 'Danes', 'Dravidians', 'Goths', 'Japanese',
       'Malay', 'Malians', 'Saxons', 'Slavs', 'Teutons', 'Vikings', 'Wu'}
SETTLEMENT = {'Incas', 'Mapuche', 'Muisca', 'Tupi'}   # Settlements replace the mill and camps
MESO_EAGLE = {'Aztecs', 'Mayans'}                      # start with an Eagle Scout

START = {  # villagers and changes to the 200 food / 200 wood / 100 gold / 200 stone start
    'Chinese': {'villagers': 6, 'bank': {'food': -200, 'wood': -50}},
    'Mayans': {'villagers': 4, 'bank': {'food': -50}},
    'Huns': {'bank': {'wood': -100}},
    'Persians': {'bank': {'food': 50, 'wood': 50}},
    'Lithuanians': {'bank': {'food': 100}},
    'Aztecs': {'bank': {'gold': 50}},
    'Sicilians': {'bank': {'stone': 100}},
    'Tupi': {'bank': {'food': 25, 'wood': 25, 'gold': 25, 'stone': 25}},
}
# Upgrades a civ gets for free: left out of the notes (with a word that they're free).
FREE = {'Bulgarians': {'maa'}, 'Franks': {'hc'}, 'Burmese': {'dba', 'bowsaw'}, 'Vikings': {'wb'}}

TIPS = {
    'Armenians': 'Long Swordsman and Pikeman unlock in Feudal Age, an age early.',
    'Aztecs': 'You start with +50 gold, villagers carry +3 and military trains 15% faster.',
    'Bengalis': 'Your Town Center spawns 2 villagers each time you reach an age (counted here).',
    'Berbers': 'Villagers move 5% faster in Dark Age and 10% faster from Feudal Age.',
    'Bohemians': 'Mining camp upgrades are free and the Blacksmith costs 100 less wood.',
    'Britons': 'Shepherds work 25% faster, so stay on sheep as long as they last.',
    'Bulgarians': 'Militia-line upgrades are free, so Man-at-Arms needs no research.',
    'Burgundians': 'Economy upgrades come an age early and cost 40% less food: Double-Bit Axe and Horse Collar in Dark Age.',
    'Burmese': 'Lumber camp upgrades are free, and infantry has +1 attack in Feudal Age.',
    'Byzantines': 'Spearmen, Skirmishers and Camels cost 25% less, so counters are cheap.',
    'Celts': 'Lumberjacks work 15% faster.',
    'Chinese': 'You start with 6 villagers but no food and 150 wood: everyone on sheep first.',
    'Cumans': 'You can build a 2nd Town Center in Feudal Age (see the community CUM 2TC build).',
    'Danes': 'Villagers drop off 5% more food.',
    'Dravidians': 'You get +200 wood each time you reach an age.',
    'Ethiopians': 'You get +100 food and +100 gold each time you reach an age; foot archers fire 18% faster.',
    'Franks': 'Foragers work 15% faster and mill upgrades are free (Horse Collar is automatic).',
    'Georgians': 'You start with a Mule Cart: use it as a moving drop site.',
    'Goths': 'Loom is instant and hunters carry +15.',
    'Gurjaras': 'You start with 2 forage bushes, and sheep garrisoned in a mill make food.',
    'Hindustanis': 'Villagers cost 8% less in Dark Age and 13% less in Feudal Age.',
    'Huns': 'No houses needed, but you start with 100 less wood.',
    'Incas': 'Houses give 10 pop, so 2 houses get you to Feudal. Settlements replace the mill and camps.',
    'Italians': 'Age-ups cost 15% less.',
    'Japanese': 'Mills and camps cost half.',
    'Jurchens': 'Meat from hunt and sheep doesn\'t decay.',
    'Khitans': 'Pastures replace farms; each takes up to 2 villagers.',
    'Khmer': 'No buildings needed to age up, and farmers can drop food anywhere.',
    'Koreans': 'Archers and infantry cost 50% less wood.',
    'Lithuanians': 'You start with +100 food.',
    'Magyars': 'Villagers kill wolves in one hit and scouts cost 15% less.',
    'Malay': 'Age-ups research 66% faster (counted here).',
    'Malians': 'Buildings cost 15% less wood and villagers drop off 10% more gold.',
    'Mapuche': 'Foragers drop off 25% more food. Settlements replace the mill and camps.',
    'Mayans': 'You start with 4 villagers and 50 less food; resources last 15% longer.',
    'Mongols': 'Hunters work 40% faster: push deer to your Town Center with the scout.',
    'Muisca': 'Age-ups cost 50% less gold. Settlements replace the mill and camps.',
    'Persians': 'You start with +50 food and wood, and the Town Center works faster (counted here).',
    'Poles': 'A Folwark replaces the mill.',
    'Portuguese': 'Foragers also collect wood, and units cost 20% less gold.',
    'Romans': 'Villagers gather and build 5% faster.',
    'Saracens': 'The Market costs 100 less wood and trades with a 5% fee.',
    'Saxons': 'Mills and camps give +35 food and +10 stone when built.',
    'Shu': 'Lumberjacks collect food as well as wood.',
    'Sicilians': 'You start with +100 stone, and Town Centers build twice as fast.',
    'Slavs': 'Farmers work 15% faster.',
    'Spanish': 'Builders work 30% faster, and every tech gives +20 gold.',
    'Tatars': 'Sheep last 50% longer.',
    'Teutons': 'Farms cost 40% less.',
    'Tupi': 'You start with +25 of each resource. Settlements replace the mill and camps.',
    'Turks': 'Gold miners work 25% faster and scout upgrades are free.',
    'Varangians': 'Shepherds and hunters collect gold as well as food.',
    'Vietnamese': 'Economy upgrades cost no wood and research twice as fast.',
    'Vikings': 'Wheelbarrow and Hand Cart are free.',
    'Wei': 'Each economy upgrade gives a free villager (counted here).',
    'Wu': 'Barracks, ranges, stables and docks give +55 food when built.',
}

FEUDAL_TIME, CASTLE_TIME = 130, 160


class Civ:
    def __init__(self, name):
        self.name = name
        self.settle = name in SETTLEMENT
        self.free = FREE.get(name, set())

    def scout(self):
        if self.settle:
            return I['champi']
        return I['eagle'] if self.name in MESO_EAGLE else I['scoutcav']

    # Drop sites, by civ
    def lc(self, nth=1):
        if self.settle:
            return f'build {"a 2nd " if nth > 1 else ""}{I["settlement"]} {"at a new woodline" if nth > 1 else "between the wood and the berries"}'
        return f'build {"2nd " if nth > 1 else ""}{I["lc"]}'

    def mill(self):
        if self.settle:
            return f'gather near the {I["settlement"]}'
        return f'build {I["folwark"] if self.name == "Poles" else I["mill"]}'

    def mine(self, what='gold'):
        if self.settle:
            return f'build {I["settlement"]} at the {what}'
        return f'build {I["mine"]}'

    def farms(self, n):
        if self.name == 'Khitans':
            return f'{math.ceil(n / 2)} {I["pasture"]}'
        return f'{n} {I["farm"]}'

    def farm_word(self):
        return I['pasture'] if self.name == 'Khitans' else I['farm']

    def house(self, n=1, dark_extra=False):
        """'Build n houses', or nothing for Huns. dark_extra marks the 3rd/4th Dark Age house,
        which Incas (10-pop houses) and Settlement civs (+5 pop each) can skip."""
        if self.name == 'Huns':
            return None
        if dark_extra and self.settle:
            return None
        return f'Build {n} {I["house"]}' if n > 1 else f'Build {I["house"]}'

    def tech(self, key):
        """A tech icon, or a note that it's free for this civ."""
        if key in self.free:
            return None
        return I[key]


def seg(*parts):
    return ' | '.join(p for p in parts if p)


def techs(civ, *keys, verb='Research'):
    got = [civ.tech(k) for k in keys]
    got = [g for g in got if g]
    if not got:
        return None
    return f'{verb} ' + ' and '.join(got)


# ---- templates: each step is (villagers, {res}, age, [notes], extra) ------------
# extra: loom / wb = TC busy researching; click = this step ends with clicking up;
# tcs = Town Centers making villagers from this step on.

def opening(civ, berries, boar2_note=True):
    """The shared Dark Age start: 6 sheep, then wood, boar, berries."""
    return [
        (6, {'food': 6}, 1, [seg(civ.house(2), f'First 6 {I["v"]} to {I["sheep"]}', f'Scout with your {civ.scout()}')], {}),
    ]


def scouts(civ):
    c = civ
    return [
        (6, {'food': 6}, 1, [seg(c.house(2), f'First 6 {I["v"]} to {I["sheep"]}', f'Scout with your {c.scout()}, find {I["boar"]} and {I["deer"]}')], {}),
        (9, {'wood': 3, 'food': 6}, 1, [f'Next 3 {I["v"]} to {I["wood"]} ({c.lc()})'], {}),
        (11, {'wood': 3, 'food': 8}, 1, [seg(f'Next {I["v"]} lures 1st {I["boar"]}', f'Next {I["v"]} to {I["sheep"]}', c.house(dark_extra=True))], {}),
        (15, {'wood': 3, 'food': 12}, 1, [f'Next 4 {I["v"]} to {I["berries"]} ({c.mill()})'], {}),
        (17, {'wood': 3, 'food': 14}, 1, [seg(f'Next 2 {I["v"]} to {I["boar"]}, lure 2nd {I["boar"]}', c.house(dark_extra=True)),
                                           f'As {I["sheep"]} run out, move 2 {I["v"]} to {c.farm_word()} (build {c.farms(2)})'], {}),
        (21, {'wood': 7, 'food': 14}, 1, [seg(f'Next 4 {I["v"]} to {I["wood"]} ({c.lc(2)})', f'Research {I["loom"]}', f'Click up to {I["feudal"]} at 22 pop')], {'loom': True, 'click': 2}),
        (21, {'wood': 9, 'food': 11, 'builder': 1}, 2, [seg(f'While going up: move 3 {I["v"]} from {I["food"]} to {I["wood"]}', f'1 of them builds {I["barracks"]}')], {}),
        (24, {'wood': 10, 'food': 14}, 2, [seg(f'In {I["feudal"]}', f'Build {I["stable"]} and make {I["scoutcav"]} non-stop', techs(c, 'dba', 'hc')),
                                           f'Next 3 {I["v"]} to {c.farm_word()} (build {c.farms(3)})'], {}),
        (28, {'wood': 10, 'food': 18}, 2, [seg(f'Next 4 {I["v"]} to {c.farm_word()} (build {c.farms(4)})', 'Raid with the scouts: hit villagers, avoid spearmen')], {}),
        (33, {'wood': 10, 'food': 18, 'gold': 5}, 2, [seg(f'Next 5 {I["v"]} to {I["gold"]} ({c.mine()})', techs(c, 'wb'), f'Build {I["smith"]}')], {'wb': True}),
        (33, {'wood': 10, 'food': 18, 'gold': 5}, 2, [seg(f'Click up to {I["castle"]} (800 {I["food"]}, 200 {I["gold"]})', 'Keep a few scouts at home')], {'click': 3}),
        (33, {'wood': 12, 'food': 16, 'gold': 5}, 3, [seg(f'In {I["castle"]}: build a 2nd {I["tc"]} (or a 2nd stable)', f'Add {I["knight"]} and keep making {I["v"]}')], {}),
    ]


def archers(civ):
    c = civ
    return [
        (6, {'food': 6}, 1, [seg(c.house(2), f'First 6 {I["v"]} to {I["sheep"]}', f'Scout with your {c.scout()}, find {I["boar"]}')], {}),
        (10, {'wood': 4, 'food': 6}, 1, [f'Next 4 {I["v"]} to {I["wood"]} ({c.lc()})'], {}),
        (11, {'wood': 4, 'food': 7}, 1, [seg(f'Next {I["v"]} lures 1st {I["boar"]}', c.house(dark_extra=True))], {}),
        (15, {'wood': 4, 'food': 11}, 1, [f'Next 4 {I["v"]} to {I["berries"]} ({c.mill()})'], {}),
        (17, {'wood': 4, 'food': 13}, 1, [seg(f'Next 2 {I["v"]} to {I["boar"]}, lure 2nd {I["boar"]}', c.house(dark_extra=True))], {}),
        (21, {'wood': 8, 'food': 13}, 1, [seg(f'Next 4 {I["v"]} to {I["wood"]} ({c.lc(2)})', f'Research {I["loom"]}', f'Click up to {I["feudal"]} at 22 pop')], {'loom': True, 'click': 2}),
        (21, {'wood': 10, 'food': 7, 'gold': 3, 'builder': 1}, 2, [seg(f'While going up: move 3 {I["v"]} from {I["sheep"]} to {I["gold"]} ({c.mine()})',
                                                                        f'Move 3 {I["v"]} from {I["sheep"]} to {I["wood"]}; 1 builds {I["barracks"]}')], {}),
        (26, {'wood': 11, 'food': 7, 'gold': 8}, 2, [seg(f'In {I["feudal"]}', f'Build 2 {I["range"]} and make {I["archer"]} non-stop', techs(c, 'dba')),
                                                     f'Next 5 {I["v"]} to {I["gold"]}, then 1 to {I["wood"]}'], {}),
        (30, {'wood': 11, 'food': 11, 'gold': 8}, 2, [seg(f'Next 4 {I["v"]} to {c.farm_word()} (build {c.farms(4)})', f'Build {I["smith"]}, research {I["fletch"]}')], {}),
        (38, {'wood': 14, 'food': 16, 'gold': 8}, 2, [seg(techs(c, 'wb'), f'Next 3 {I["v"]} to {I["wood"]}, 5 to {c.farm_word()} (build {c.farms(5)})', techs(c, 'hc'))], {'wb': True}),
        (38, {'wood': 14, 'food': 16, 'gold': 8}, 2, [seg(f'Click up to {I["castle"]} with about 20 archers', 'Keep the archers on the enemy wood or gold')], {'click': 3}),
        (38, {'wood': 15, 'food': 15, 'gold': 8}, 3, [seg(f'In {I["castle"]}: upgrade to {I["xbow"]}', f'Build a 2nd {I["tc"]}')], {}),
    ]


def maa_archers(civ):
    c = civ
    return [
        (6, {'food': 6}, 1, [seg(c.house(2), f'First 6 {I["v"]} to {I["sheep"]}', f'Scout with your {c.scout()}, find {I["boar"]}')], {}),
        (10, {'wood': 4, 'food': 6}, 1, [f'Next 4 {I["v"]} to {I["wood"]} ({c.lc()})'], {}),
        (11, {'wood': 4, 'food': 7}, 1, [seg(f'Next {I["v"]} lures 1st {I["boar"]}', c.house(dark_extra=True))], {}),
        (15, {'wood': 4, 'food': 11}, 1, [f'Next 4 {I["v"]} to {I["berries"]} ({c.mill()})'], {}),
        (17, {'wood': 4, 'food': 13}, 1, [seg(f'Next 2 {I["v"]} to {I["boar"]}, lure 2nd {I["boar"]}', c.house(dark_extra=True))], {}),
        (18, {'wood': 4, 'food': 13, 'builder': 1}, 1, [f'Next {I["v"]} builds {I["barracks"]}, then goes to {I["wood"]}'], {}),
        (20, {'wood': 5, 'food': 13, 'gold': 2}, 1, [f'Next 2 {I["v"]} to {I["gold"]} ({c.mine()})'], {}),
        (21, {'wood': 8, 'food': 11, 'gold': 2}, 1, [seg(f'Next {I["v"]} and 2 from {I["sheep"]} to {I["wood"]} ({c.lc(2)})', f'Research {I["loom"]}', f'Click up to {I["feudal"]}')], {'loom': True, 'click': 2}),
        (21, {'wood': 8, 'food': 11, 'gold': 2}, 2, [seg(f'While going up: make 3 {I["militia"]}', f'Build {c.farms(2)} as {I["sheep"]} run out')], {}),
        (25, {'wood': 10, 'food': 10, 'gold': 5}, 2, [seg(f'In {I["feudal"]}', techs(c, 'maa', 'dba') or f'Research {I["dba"]} (Man-at-Arms is free)', 'Send the 3 Man-at-Arms to the enemy wood line'),
                                                    seg(f'Build {I["range"]} and make {I["archer"]} non-stop', f'Next 3 {I["v"]} to {I["gold"]}, 1 to {I["wood"]}')], {}),
        (31, {'wood': 10, 'food': 16, 'gold': 5}, 2, [seg(f'Next 6 {I["v"]} to {c.farm_word()} (build {c.farms(6)})', f'Build {I["smith"]}, research {I["fletch"]}')], {}),
        (36, {'wood': 12, 'food': 16, 'gold': 8}, 2, [seg(techs(c, 'wb'), f'Next 3 {I["v"]} to {I["gold"]}, 2 to {I["wood"]}', f'Build 2nd {I["range"]}')], {'wb': True}),
        (36, {'wood': 12, 'food': 16, 'gold': 8}, 2, [f'Click up to {I["castle"]} with about 10 archers'], {'click': 3}),
        (36, {'wood': 13, 'food': 15, 'gold': 8}, 3, [seg(techs(c, 'hc'), f'In {I["castle"]}: upgrade to {I["xbow"]}, then add a 2nd {I["tc"]}')], {}),
    ]


def fc_boom(civ):
    c = civ
    return [
        (6, {'food': 6}, 1, [seg(c.house(2), f'First 6 {I["v"]} to {I["sheep"]}', f'Scout with your {c.scout()}, find {I["boar"]}')], {}),
        (10, {'wood': 4, 'food': 6}, 1, [f'Next 4 {I["v"]} to {I["wood"]} ({c.lc()})'], {}),
        (11, {'wood': 4, 'food': 7}, 1, [seg(f'Next {I["v"]} lures 1st {I["boar"]}', c.house(dark_extra=True))], {}),
        (16, {'wood': 4, 'food': 12}, 1, [f'Next 5 {I["v"]} to {I["berries"]} ({c.mill()})'], {}),
        (18, {'wood': 4, 'food': 14}, 1, [seg(f'Next 2 {I["v"]} to {I["boar"]}, lure 2nd {I["boar"]}', c.house(dark_extra=True)),
                                          f'As {I["sheep"]} run out, build {c.farms(2)}'], {}),
        (23, {'wood': 9, 'food': 14}, 1, [seg(f'Next 5 {I["v"]} to {I["wood"]} ({c.lc(2)})', c.house(dark_extra=True))], {}),
        (26, {'wood': 9, 'food': 14, 'gold': 3}, 1, [seg(f'Next 3 {I["v"]} to {I["gold"]} ({c.mine()})', f'Research {I["loom"]}', f'Click up to {I["feudal"]} at 27 pop')], {'loom': True, 'click': 2}),
        (26, {'wood': 9, 'food': 14, 'gold': 3}, 2, [f'While going up: move food villagers to {c.farm_word()} as {I["sheep"]} and {I["boar"]} run out (build {c.farms(6)})'], {}),
        (28, {'wood': 9, 'food': 14, 'gold': 3, 'builder': 2}, 2, [seg(f'In {I["feudal"]}', f'2 {I["v"]} from {I["wood"]} build {I["market"]} and {I["smith"]}'),
                                                                    seg(f'Next 2 {I["v"]} to {I["wood"]}', f'Click up to {I["castle"]} at 27+2 pop')], {'click': 3}),
        (28, {'wood': 14, 'food': 11, 'gold': 3}, 3, [seg(f'While going up: research {" and ".join(x for x in (c.tech("dba"), c.tech("hc")) if x) or "nothing (your eco upgrades are free)"}',
                                                          f'Move 3 {I["v"]} from {I["food"]} to {I["wood"]}, keep building {c.farm_word()}')], {}),
        (31, {'wood': 9, 'food': 11, 'gold': 3, 'builder': 8}, 3, [seg(f'In {I["castle"]}', f'Build 2 {I["tc"]} with 4 {I["v"]} each', techs(c, 'bowsaw')),
                                                                     f'Next 3 {I["v"]} to {I["wood"]}'], {}),
        (44, {'wood': 20, 'food': 20, 'gold': 4}, 3, [seg('All 3 Town Centers make villagers non-stop', f'Add about {c.farms(18)} as wood allows', techs(c, 'wb'))], {'tcs': 3, 'wb': True}),
        (52, {'wood': 22, 'food': 22, 'gold': 4, 'stone': 4}, 3, [seg(f'Next 4 {I["v"]} to {I["stone"]} ({c.mine("stone")})', f'Build a 4th {I["tc"]} when you have 100 {I["stone"]}')], {'tcs': 3}),
        (60, {'wood': 24, 'food': 26, 'gold': 6, 'stone': 4}, 3, [seg('Boom done: add a stable or range and start your army', f'Get {I["knight"]} or crossbows out before you push')], {'tcs': 4}),
    ]


EARLY = {
    'scouts': (scouts, '22 Pop Scouts', '22-pop-scouts.html',
               'Feudal Age scouts to raid and take map control, then Castle Age.'),
    'archers': (archers, '22 Pop Archers', '22-pop-archers.html',
                'Two archery ranges of Feudal Age archers with early Fletching, then Castle Age.'),
    'maa': (maa_archers, '22 Pop Men-at-Arms into Archers', '22-pop-men-at-arms-archers.html',
            'Three Men-at-Arms harass the enemy wood line while you add archers behind them.'),
}
BOOM = (fc_boom, '27+2 Fast Castle Boom', '27+2-fc-boom.html',
        'Skip Feudal fighting, reach Castle Age fast and build 2 more Town Centers, then a 4th. Best on closed maps; on open maps wall and keep a few units.')


def finish(civ, steps):
    """Apply civ changes, work out the times, and write it in the RTS Builds format."""
    # Bengalis: +2 villagers when each age is reached. Wei: +1 per economy upgrade.
    out = []
    extra = 0
    extra_by = {}
    prev_age = 1
    for v, res, age, notes, ex in steps:
        free = 0
        if civ.name == 'Bengalis' and age > prev_age:
            free = 2
            notes = notes + [f'Your Town Center spawns 2 free {I["v"]}: send them to {I["wood"] if age == 2 else I["food"]}']
        if civ.name == 'Wei':
            text = ' '.join(notes)
            free = sum(1 for k in ECO_TECHS if I[k] in text)
            if free:
                notes = notes + [f'Each upgrade gives a free {I["v"]} ({free} here): send to {I["wood"]}']
        extra += free
        if free:
            key = 'wood' if civ.name == 'Wei' or age == 2 else 'food'
            extra_by[key] = extra_by.get(key, 0) + free
        res = dict(res)
        for key, n in extra_by.items():
            res[key] = res.get(key, 0) + n
        out.append([v + extra, res, age, notes, ex, free])
        prev_age = age

    start = START.get(civ.name, {})
    v0 = start.get('villagers', 3)
    persian = civ.name == 'Persians'
    vt = {1: 25 / 1.05, 2: 25 / 1.10, 3: 25 / 1.15} if persian else {1: 25, 2: 25, 3: 25}
    research = {2: FEUDAL_TIME, 3: CASTLE_TIME}
    if civ.name == 'Malay':
        research = {2: round(FEUDAL_TIME / 1.66), 3: round(CASTLE_TIME / 1.66)}
    if persian:
        research = {2: round(FEUDAL_TIME / 1.05), 3: round(CASTLE_TIME / 1.10)}

    t = 20.0 if civ.name == 'Chinese' else 0.0   # Chinese wait for sheep food to queue
    v = v0
    tcs = 1
    pending_reach = None
    rows = []
    for vills, res, age, notes, ex, free in out:
        if pending_reach is not None:
            t = pending_reach
            pending_reach = None
        tcs = ex.get('tcs', tcs)
        made = max(0, vills - v - free)
        t += made * vt[min(age, 3)] / tcs
        if ex.get('loom') and civ.name != 'Goths':
            t += 25
        v = vills
        r = {k: res.get(k, 0) for k in ('wood', 'food', 'gold', 'stone')}
        if res.get('builder'):
            r['builder'] = res['builder']
        assert sum(r.values()) == vills, (civ.name, vills, r)
        row = {'villager_count': vills, 'age': age, 'resources': r, 'notes': [n for n in notes if n], 'time': fmt(t)}
        if free:
            row['free_villagers'] = free
        rows.append(row)
        if ex.get('wb'):  # the Town Center researches Wheelbarrow after this step's villagers
            t += 75 / tcs
        if ex.get('click'):
            pending_reach = t + research[ex['click']]
    build = {'build_order': rows}
    if start:
        build['start'] = start
    if persian:
        build['villager_time'] = round(vt[1], 1)
    if research[2] != FEUDAL_TIME or research[3] != CASTLE_TIME:
        build['age_research'] = {'2': research[2], '3': research[3]}
    return build


def fmt(t):
    s = int(round(t))
    return f'{s // 60}:{s % 60:02d}'


def strip_tags(text):
    return re.sub(r'@[^@]*@', '', text)


def main():
    civs = sorted(SCOUTS | ARCHERS | MAA)
    assert len(civs) == len(SCOUTS) + len(ARCHERS) + len(MAA), 'a civ is in two opener lists'
    builds, index = {}, []
    for name in civs:
        civ = Civ(name)
        kind = 'scouts' if name in SCOUTS else 'archers' if name in ARCHERS else 'maa'
        for role, (fn, title, page, desc) in (('early', EARLY[kind]), ('boom', BOOM)):
            bid = f'app-{name.lower()}-{role}'
            b = finish(civ, fn(civ))
            b.update({
                'name': title,
                'civilization': name,
                'author': 'Cicero, adapted for this civ by the app',
                'source': SRC_BASE + page,
                'description': f'{desc} Civ bonus: {TIPS[name]} Times assume non-stop villager production (Cicero\'s "A" benchmark).',
                'role': role,
            })
            # the tip as the first line too, so it shows in the practice view
            b['build_order'][0]['notes'].insert(0, f'Civ bonus: {TIPS[name]}')
            builds[bid] = b
            index.append({'name': b['name'], 'faction': name, 'author': 'App starter build', 'id': bid, 'role': role})
    out = os.path.join(ROOT, 'assets', 'builds', 'starter.json')
    with open(out, 'w') as f:
        json.dump({'list': index, 'builds': builds}, f, separators=(',', ':'))
    print(f'{len(builds)} builds for {len(civs)} civs -> {out} ({os.path.getsize(out) // 1024} KB)')


if __name__ == '__main__':
    main()
