# AoE2 Companion

A personal Age of Empires II: Definitive Edition companion app for Android (and anything with a modern browser).

- **Tech tree:** every civilisation's units, techs and buildings, with stats and descriptions. Greyed-out entries aren't available to that civ.
- **Test:** pick 1–5 units a side (melee or ranged, no siege yet), their civs and upgrades, then watch them fight and see who wins, how fast, and with how much HP left. Battles with dice rolls for shots are run 100–200 times to give a win rate.
- **Guides:** build orders for every civ (from the community RTS Builds library, updated automatically), with an overview and a real-time practice mode: timer, current step, villagers per resource, what's coming up and an estimated resource bank.

## Game data stays up to date

All game data comes live from the open-source [aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree) project (MIT licence), the same data behind aoe2techtree.net. The app caches it for offline use and checks GitHub for new data every few hours, so when aoe2techtree updates for a game patch, the app follows.

## Android app (APK)

Every push to `main` builds an Android APK on GitHub (see `.github/workflows/android.yml`). Download it from the repo's **Releases** page on your phone and open it to install (allow installing from your browser when Android asks).

## Install it on your phone as a web app

1. On GitHub, open **Settings → Pages**, set the source to **Deploy from a branch**, pick `main` and `/ (root)`, then save.
2. After a minute the app is live at `https://robfulcher321-cloud.github.io/AOE-2-companion-/`.
3. Open that link in Chrome on Android, tap the menu, then **Add to Home screen** (or **Install app**).

On iPhone, open the same link in Safari and use **Share → Add to Home Screen**.

## Run it on a computer

Any static server works, for example:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## In-game graphics

The duel shows the game's own unit animations on the game's grass, from the sprite pack in `assets/`. To rebuild it after a game update, run the pack tool against an AoE2 DE install and replace `assets/AoE2-sprites.aoe2pack`. A different pack can also be imported on the Duel screen.

```
pip install genieutils-py numpy pillow
python tools/make_sprite_pack.py --game "D:/Steam/steamapps/common/AoE2DE" --out AoE2-sprites.aoe2pack
```

It takes about 20 minutes and makes a file of roughly 80 MB covering every melee and ranged unit plus their projectiles.

The sprite decoder (`tools/sld.py`) is written from the format notes in the [openage](https://github.com/SFTtech/openage) project's documentation.

## How the duel works

`js/duel/combat.js` holds the rules, `js/duel/sim.js` runs the fight in steps of 1/60 of a game second, and `js/duel/render.js` plays it back. Damage per hit is

```
max(1, Σ max(0, attack[class] − armour[class]))
```

over every attack class the defender has an armour entry for. Each blow lands `AttackDelaySeconds` into the unit's attack cycle, and attacks repeat every `ReloadTime`. A blow is cancelled if the attacker dies before it lands. Collision sizes come from the game's data file (`js/duel/radii.js`).

Not modelled yet: civ bonuses, unique techs (use the manual "extra" fields for now), charge attacks, trample, regeneration, ranged units, and elevation.

**Results haven't been checked against the real game yet.** The plan is to recreate a few benchmark duels in the Scenario Editor, record time-to-kill and HP left, and compare.

## Tests

```
node tests/combat.test.mjs
```

Downloads the live data file and checks the damage maths and simulation against hand-calculated values.

---

The paper texture, age shields and cross in `img/` come from the [aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree) project, and the Merriweather font (SIL Open Font License) in `fonts/` too.

Age of Empires II © Microsoft Corporation. This app uses data and images from aoe2techtree under Microsoft's Game Content Usage Rules. It is a non-commercial fan project, not endorsed by or affiliated with Microsoft.
