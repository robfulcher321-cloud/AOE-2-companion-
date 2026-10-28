# AoE2 Companion

A personal Age of Empires II: Definitive Edition companion app for Android (and anything with a modern browser).

- **Tech tree:** every civilisation's units, techs and buildings, with stats and descriptions. Greyed-out entries aren't available to that civ.
- **Duel:** pick two melee units, their civs and Blacksmith upgrades, then watch them fight and see who wins, how fast, and with how much HP left.

## Game data stays up to date

All game data comes live from the open-source [aoe2techtree](https://github.com/SiegeEngineers/aoe2techtree) project (MIT licence), the same data behind aoe2techtree.net. The app caches it for offline use and checks GitHub for new data every few hours, so when aoe2techtree updates for a game patch, the app follows.

## Install it on your phone

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

## How the duel works

`js/duel/combat.js` holds the rules, `js/duel/sim.js` runs the fight in steps of 1/60 of a game second, and `js/duel/render.js` plays it back. Damage per hit is

```
max(1, Σ max(0, attack[class] − armour[class]))
```

over every attack class the defender has an armour entry for. Each blow lands `AttackDelaySeconds` into the unit's attack cycle, and attacks repeat every `ReloadTime`. A blow is cancelled if the attacker dies before it lands.

Not modelled yet: civ bonuses, unique techs (use the manual "extra" fields for now), charge attacks, trample, regeneration, ranged units, and elevation. Unit collision sizes are approximate.

**Results haven't been checked against the real game yet.** The plan is to recreate a few benchmark duels in the Scenario Editor, record time-to-kill and HP left, and compare.

## Tests

```
node tests/combat.test.mjs
```

Downloads the live data file and checks the damage maths and simulation against hand-calculated values.

---

Age of Empires II © Microsoft Corporation. This app uses data and images from aoe2techtree under Microsoft's Game Content Usage Rules. It is a non-commercial fan project, not endorsed by or affiliated with Microsoft.
