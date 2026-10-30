// AOSiege tab: pick civs and difficulty, then play against the computer.

import { loadCore, loadTree, imageUrl, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { loadPack } from '../duel/spritepack.js';
import { buildKit, MARKET, BUILDING_NAMES } from './kit.js';
import { World, Computer, DT, PLOTS, OVERTIME, START_GOLD, BLAST } from './world.js';
import { SiegeView, COLOURS } from './view.js';
export { COLOURS };
import { COMMANDS, snapshot, applySnapshot } from './sync.js';
import { openLobby } from './lobby.js';

const GAME_SPEED = 1.7;
// Player colours (AoE II's), for names, buildings and the minimap. Soldiers wear their team's blue or red.
const SNAP_MS = 100;   // Wi-Fi games: the host sends the game state this often
// game seconds per real second at Normal speed
const LEVELS = { easy: { income: 0.8, label: 'Easy' }, normal: { income: 1, label: 'Normal' }, hard: { income: 1.25, label: 'Hard' } };

const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('aria-') || k.startsWith('data-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const loadImg = (src) => new Promise((res) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = img.onerror = () => res(img);
  img.src = src;
});

export { loadAssets, openGame, LEVELS };

export async function initSiege(root) {
  const { data, strings } = await loadCore();
  const civs = civOptions(data, strings);
  const mine = new Picker({ label: 'Your civilisation', onChange: (c) => { store.set('sg-civ', c); if (randomMe) { randomMe.checked = false; store.set('sg-random-me', '0'); } } });
  mine.setOptions(civs, data.civs[store.get('sg-civ')] ? store.get('sg-civ') : 'Franks');
  const theirs = new Picker({ label: 'Computer\'s civilisation', onChange: (c) => { store.set('sg-ai', c); randomBox.checked = false; store.set('sg-random', '0'); } });
  theirs.setOptions(civs, data.civs[store.get('sg-ai')] ? store.get('sg-ai') : 'Britons');
  const randomBox = el('input', { type: 'checkbox', checked: store.get('sg-random') !== '0' });
  randomBox.addEventListener('change', () => store.set('sg-random', randomBox.checked ? '1' : '0'));
  const randomMe = el('input', { type: 'checkbox', checked: store.get('sg-random-me') === '1' });
  randomMe.addEventListener('change', () => store.set('sg-random-me', randomMe.checked ? '1' : '0'));
  let level = LEVELS[store.get('sg-level')] ? store.get('sg-level') : 'normal';
  const levelBtns = Object.entries(LEVELS).map(([k, v]) => {
    const b = el('button', { type: 'button', textContent: v.label });
    b.setAttribute('aria-pressed', String(k === level));
    b.addEventListener('click', () => { level = k; store.set('sg-level', k); for (const o of levelBtns) o.setAttribute('aria-pressed', String(o === b)); });
    return b;
  });
  const start = el('button', { type: 'button', className: 'fight', textContent: 'Start game' });
  const status = el('p', { className: 'status', hidden: true });
  const nameIn = el('input', { type: 'text', className: 'sg-name', maxLength: 16, value: store.get('sg-name') || '', placeholder: 'Your name', autocomplete: 'nickname', 'aria-label': 'Your name' });
  const lobby = (action) => () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); nameIn.classList.add('need'); return; }
    nameIn.classList.remove('need');
    store.set('sg-name', name);
    openLobby({ data, strings, action, name });
  };
  root.replaceChildren(
    el('div', { className: 'sg-create' },
      el('h3', { textContent: 'Custom game' }),
      el('p', { className: 'sg-note', textContent: 'Up to 4 players, 2 a team. Put the computer in any place, or leave places open for friends on the same Wi-Fi to join.' }),
      el('label', { className: 'field' }, el('span', { textContent: 'Your name' }), nameIn),
      el('div', { className: 'sg-create-acts' },
        el('button', { type: 'button', className: 'fight', textContent: 'Create game', onclick: lobby('create') }),
        el('button', { type: 'button', className: 'sg-btn sg-big', textContent: 'Join a game', onclick: lobby('join') }))),
    el('h3', { className: 'sg-quick-h', textContent: 'Quick game: you vs one computer' }),
    el('div', { className: 'field' }, el('span', { textContent: 'Your civilisation' }), mine.button),
    el('label', { className: 'toggle' }, randomMe, el('span', { textContent: 'Random civ for me' })),
    el('div', { className: 'field' }, el('span', { textContent: 'Computer' }), theirs.button),
    el('label', { className: 'toggle' }, randomBox, el('span', { textContent: 'Random civ for the computer' })),
    el('div', { className: 'field' }, el('span', { textContent: 'Difficulty' }), el('div', { className: 'sg-levels' }, levelBtns)),
    start, status,
    el('details', { className: 'sg-how', open: !store.get('sg-played') },
      el('summary', { textContent: 'How to play' }),
      el('ul', {},
        el('li', { textContent: 'Each side has a Castle at the end of one lane. Destroy the enemy Castle to win.' }),
        el('li', { textContent: `You don't control units. Tap an empty plot (up to ${PLOTS}; 12 each in a 2v2) to build: each building trains one unit line on a timer, and the units march down the lane and fight on their own. Your civ gets every unit its Barracks, Archery Range, Stable and Castle can train.` }),
        el('li', { textContent: 'Press and hold a building to upgrade it to the next unit in its line (Militia → Man-at-Arms → … → Champion), or to sell it for half of what you put in. Each building upgrades on its own: lots of cheap units, or fewer strong ones?' }),
        el('li', { textContent: 'Tap a building to hold it: its bar turns blue and the unit waits when ready. Tap GO to send every waiting unit out at once.' }),
        el('li', { textContent: 'The Armory (anvil, bottom left) has Blacksmith upgrades, Ballistics, Chemistry, Bloodlines and your civ\'s unique techs. One at a time; each one reaches all your units, even those already fighting.' }),
        el('li', { textContent: 'The middle of the map is split by a river into two lanes. Buildings in your top row send units down the top lane, the bottom row the bottom lane, the middle row takes turns. Arrows fly over the river; soldiers cross only near the bases.' }),
        el('li', { textContent: `One explosion each (the fire button): tap it, tap where, then Drop. It hurts every enemy soldier within ${BLAST.radius} tiles for ${Math.round(BLAST.share * 100)}% of their HP. It can only be dropped on your own third of the map: it's for defending against a deathball, not for pushing.` }),
        el('li', { textContent: 'Gold comes in every few seconds; Markets add more, and kills pay a bounty. In team games the base income is split between teammates, so a 2v2 team earns what one player does in a 1v1 (your own Markets still pay you in full).' }),
        el('li', { textContent: 'Buildings cost more the stronger the unit: spears and skirmishers are cheapest, then infantry, archers and scouts, then cavalry, then elephants. Castle (unique unit) buildings cost 40% more.' }),
        el('li', { textContent: 'Counter what the computer builds: spearmen beat cavalry, skirmishers beat archers, cavalry and infantry beat archers.' }),
        el('li', { textContent: 'Drag the battlefield or tap the minimap to look around; it follows the fighting again after a few seconds.' }),
        el('li', { textContent: `After ${OVERTIME / 60} game minutes (about ${Math.round(OVERTIME / 60 / 1.7)} real minutes) it's overtime: both castles crumble and buildings take more damage every minute, so games always end.` }))),
  );

  start.addEventListener('click', async () => {
    start.disabled = true;
    status.hidden = false;
    status.textContent = 'Getting the armies ready…';
    try {
      const keys = Object.keys(data.civs);
      const pick = () => keys[Math.floor(Math.random() * keys.length)];
      const myCiv = randomMe.checked ? pick() : mine.value;
      const aiCiv = randomBox.checked ? pick() : theirs.value;
      const kits = await Promise.all([myCiv, aiCiv].map(async (civ) => buildKit({ data, strings, tree: await loadTree(civ), civ })));
      const assets = await loadAssets(kits);
      store.set('sg-played', '1');
      status.hidden = true;
      const civName = (c) => nameText(strings[data.civs[c].name_string_id] || c);
      openGame({
        data, kits, assets, me: 0, mode: 'solo',
        players: [
          { name: 'You', civ: myCiv, civName: civName(myCiv), colour: COLOURS[0].hex, team: 0, kind: 'human' },
          { name: civName(aiCiv), civ: aiCiv, civName: civName(aiCiv), colour: COLOURS[1].hex, team: 1, kind: 'ai', level },
        ],
      });
    } catch (err) {
      console.error(err);
      status.textContent = `Couldn't start: ${err.message}`;
    } finally {
      start.disabled = false;
    }
  });
}

/** Sprites for every unit either side can make, unit icons, and building icons. */
async function loadAssets(kits) {
  const pack = await loadPack();
  const unitIds = new Set();
  const shotNames = new Set();
  const unitIcons = {};
  const buildingIcons = {};
  const jobs = [];
  for (const kit of kits) {
    for (const line of kit.lines) {
      for (let t = 0; t < line.tiers.length; t++) {
        const f = kit.fighter(line.key, t);
        unitIds.add(f.unitId);
        if (f.projectile?.sprite) shotNames.add(f.projectile.sprite);
        const pic = line.tiers[t].picture;
        if (pic !== undefined && !unitIcons[f.unitId]) jobs.push(loadImg(imageUrl('Unit', pic)).then((img) => { unitIcons[f.unitId] = img; }));
      }
    }
    for (const id of [82, 84, 103, ...kit.lines.map((l) => l.building)]) {
      const pic = kit.buildingPicture(id);
      if (pic !== undefined && !buildingIcons[id]) { buildingIcons[id] = null; jobs.push(loadImg(imageUrl('Building', pic)).then((img) => { buildingIcons[id] = img; })); }
    }
  }
  let sprites = null;
  if (pack) {
    sprites = { grass: await pack.grass(), units: {}, projectiles: {} };
    jobs.push(...[...unitIds].filter((id) => pack.has(id)).map(async (id) => { sprites.units[id] = await pack.unit(id); }));
    jobs.push(...[...shotNames].map(async (n) => { sprites.projectiles[n] = await pack.projectile(n); }));
  }
  await Promise.all(jobs);
  return { sprites, unitIcons, buildingIcons };
}

/**
 * players: [{ name, civName, colour, team, kind: 'human'|'ai', level }] in player order.
 * me: which player this phone is. mode: 'solo' (vs computer), 'host' or 'client' (Wi-Fi).
 * net (Wi-Fi): { lan, peers: Map(player -> peer id), onLeave() }.
 */
function openGame({ data, kits, assets, players, me, mode = 'solo', net = null, seed = Math.floor(Math.random() * 1e9) }) {
  const world = new World(kits, data, {
    seed, teams: players.map((p) => p.team),
    income: players.map((p) => (p.kind === 'ai' ? LEVELS[p.level || 'normal'].income : 1)),
  });
  const ME = me;
  const myTeam = players[ME].team;
  const client = mode === 'client';
  const ais = client ? [] : players.map((p, i) => (p.kind === 'ai' ? new Computer(world, i, { level: p.level || 'normal' }) : null)).filter(Boolean);
  const teamName = (t) => players.filter((p) => p.team === t).map((p) => (players.indexOf(p) === ME ? 'You' : p.name)).join(' + ');
  const civNames = [teamName(0), teamName(1)];
  // Every action goes through here: run it (solo, or on the host), or send it to the host.
  const act = (cmd, args = {}) => {
    if (!client) return COMMANDS[cmd](world, ME, args);
    net.lan.send(JSON.stringify({ t: 'cmd', cmd, args }));
    return true;
  };
  const kit = kits[ME];
  const unitIcon = (id, pic) => (pic !== undefined ? imageUrl('Unit', pic) : assets.unitIcons[id]?.src || '');
  const bldIcon = (id) => { const pic = kit.buildingPicture(id); return pic !== undefined ? imageUrl('Building', pic) : ''; };
  const goldImg = () => el('img', { src: 'img/res/gold.webp', alt: 'gold', width: 16, height: 16 });

  // ---------- Layout ----------
  const goldNum = el('b', { className: 'sg-gold-num', textContent: String(START_GOLD) });
  const incomeTxt = el('small', { className: 'sg-income' });
  const clock = el('span', { className: 'sg-clock', textContent: '0:00' });
  const castleBar = (side) => {
    const fill = el('i');
    const count = el('b', { className: 'sg-count', textContent: '0' });
    const wrap = el('div', { className: `sg-castle sg-castle-${side ? 'red' : 'blue'}` },
      el('span', {}, civNames[side]), el('span', { className: 'sg-units', title: 'Soldiers on the map' }, '⚔ ', count),
      el('div', { className: 'sg-cbar' }, fill));
    return { wrap, fill, count };
  };
  const castles = [castleBar(0), castleBar(1)];
  const goBtn = el('button', { type: 'button', className: 'sg-go', textContent: 'GO', disabled: true, title: 'Send out every held unit at once' });
  const pauseBtn = el('button', { type: 'button', className: 'sg-btn', textContent: '❚❚', 'aria-label': 'Pause' });
  const speedBtn = el('button', { type: 'button', className: 'sg-btn', textContent: '1×' });
  const closeBtn = el('button', { type: 'button', className: 'sg-btn sg-close', textContent: '×', 'aria-label': 'Quit game' });
  const canvas = el('canvas', { className: 'sg-canvas', 'aria-label': 'Battlefield: tap a plot to build, tap a building to hold it, press and hold a building for upgrades' });
  const mini = el('canvas', { className: 'sg-mini', 'aria-label': 'Minimap: tap to look there' });
  const followBtn = el('button', { type: 'button', className: 'sg-follow', textContent: 'Follow fight', hidden: true });
  const armoryBtn = el('button', { type: 'button', className: 'sg-armory-btn', 'aria-label': 'Armory' },
    el('img', { src: bldIcon(103), alt: '' }), el('span', { className: 'sg-armory-dot', hidden: true }));
  const banner = el('div', { className: 'sg-banner', hidden: true });
  if (!assets.sprites) {   // never silently: say so if the in-game graphics didn't load
    banner.hidden = false; banner.textContent = 'In-game graphics didn\'t load: showing icons';
    setTimeout(() => { banner.hidden = true; }, 6000);
  }
  const blastBtn = el('button', { type: 'button', className: 'sg-blast-btn', 'aria-label': 'Explosion (once per game)' },
    el('span', { className: 'sg-blast-ic', textContent: '💥' }), el('small', { className: 'sg-blast-n', textContent: String(BLAST.per) }));
  const dropBtn = el('button', { type: 'button', className: 'sg-drop', textContent: 'Drop here' });
  const aimBar = el('div', { className: 'sg-aim', hidden: true }, el('span', { className: 'sg-aim-text', textContent: 'Tap your third of the map to aim' }), dropBtn,
    el('button', { type: 'button', className: 'sg-btn', textContent: 'Cancel', onclick: () => setAim(false) }));
  const dock = el('section', { className: 'sg-dock' });

  const screen = el('div', { className: 'sg-run', role: 'dialog', 'aria-label': 'AOSiege game' },
    el('header', { className: 'sg-head' },
      el('div', { className: 'sg-gold' },
        el('img', { className: 'sg-flag', src: players[ME].civ ? civIconUrl(players[ME].civ) : '', alt: players[ME].civName || '', title: `You: ${players[ME].civName || ''}`, style: `--pc:${players[ME].colour}` }),
        el('img', { className: 'sg-gold-ic', src: 'img/res/gold.webp', alt: 'Gold', width: 28, height: 28 }), goldNum, incomeTxt),
      clock, goBtn, speedBtn, pauseBtn, closeBtn,
      el('div', { className: 'sg-castles' }, castles[0].wrap, castles[1].wrap)),
    el('div', { className: 'sg-field' }, canvas, followBtn, armoryBtn, blastBtn, aimBar, banner),
    mini,
    dock);
  document.body.append(screen);
  screen.world = world; // handy when debugging in the browser console
  document.body.classList.add('sg-open');

  // ---------- The dock: what you can do right now ----------
  // pmode: { kind: 'hint' } | { kind: 'build', plot } | { kind: 'building', id } | { kind: 'armory' }
  let pmode = { kind: 'hint' };
  let lastKey = '';
  const view = new SiegeView(canvas, mini, {
    tapPlot: (i) => setMode({ kind: 'build', plot: i }),
    tapBuilding: (b) => {
      if (b.line === 'market') { setMode({ kind: 'building', id: b.id }); return; }
      act('hold', { id: b.id });
      navigator.vibrate?.(10);
      refresh(true);
    },
    holdBuilding: (b) => setMode({ kind: 'building', id: b.id }),
    tapEmpty: () => setMode({ kind: 'hint' }),
    aimAt: (x, y) => {
      if (!world.canBlastAt(myTeam, x)) {
        view.aimPoint = null; dropBtn.disabled = true;
        aimBar.querySelector('.sg-aim-text').textContent = 'Only on your third of the map';
        navigator.vibrate?.(20);
        return;
      }
      view.aimPoint = [x, y]; dropBtn.disabled = false; aimBar.querySelector('.sg-aim-text').textContent = 'Tap to move it, or';
    },
  });
  function setAim(on) {
    view.aiming = on && world.sides[ME].blasts > 0;
    view.aimPoint = null;
    dropBtn.disabled = true;
    aimBar.querySelector('.sg-aim-text').textContent = 'Tap your third of the map to aim';
    aimBar.hidden = !view.aiming;
    blastBtn.classList.toggle('on', view.aiming);
  }
  blastBtn.addEventListener('click', () => setAim(!view.aiming));
  dropBtn.addEventListener('click', () => {
    if (!view.aimPoint) return;
    act('blast', { x: view.aimPoint[0], y: view.aimPoint[1] });
    navigator.vibrate?.([40, 30, 80]);
    setAim(false);
  });
  view.setup(world, { ...assets, mySide: ME, colours: players.map((p) => p.colour) });
  screen.view = view;
  view.resize();
  followBtn.addEventListener('click', () => { view.follow = true; });
  armoryBtn.addEventListener('click', () => setMode(pmode.kind === 'armory' ? { kind: 'hint' } : { kind: 'armory' }));
  goBtn.addEventListener('click', () => { act('go'); navigator.vibrate?.(30); refresh(true); });

  function setMode(m) {
    pmode = m;
    view.selected = m.kind === 'building' ? m.id : null;
    view.selectedPlot = m.kind === 'build' ? m.plot : null;
    armoryBtn.classList.toggle('on', m.kind === 'armory');
    lastKey = '';
    refresh(true);
  }

  // Buttons that cost gold: enabled/disabled in place as gold changes, without rebuilding the dock.
  const priced = (btn, price, blocked) => { btn.dataset.price = String(price); btn.dataset.blocked = blocked ? '1' : ''; btn.disabled = blocked || world.sides[ME].gold < price; return btn; };
  const priceTag = (p) => el('span', { className: 'sg-price' }, goldImg(), el('b', { textContent: String(p) }));
  const closeRow = (title) => el('div', { className: 'sg-dock-head' }, el('b', { textContent: title }),
    el('button', { type: 'button', className: 'sg-x', textContent: '×', 'aria-label': 'Close', onclick: () => setMode({ kind: 'hint' }) }));

  function hintView() {
    const s = world.sides[ME];
    const held = world.held(ME).length;
    return [
      el('div', { className: 'sg-dock-head' }, el('b', { textContent: 'Your base' }),
        el('span', { className: 'sg-plots', textContent: `${s.plots.filter(Boolean).length}/${world.plotCount(ME)} plots` })),
      el('ul', { className: 'sg-hints' },
        el('li', {}, el('b', { textContent: 'Tap an empty plot' }), ' to build.'),
        el('li', {}, el('b', { textContent: 'Tap a building' }), ' to hold its next unit (blue bar); ', el('b', { textContent: 'GO' }), ' sends all held units together.'),
        el('li', {}, el('b', { textContent: 'Press and hold a building' }), ' to upgrade or sell it.'),
        el('li', {}, 'The ', el('b', { textContent: 'anvil' }), ' opens the Armory for upgrades that reach your whole army.')),
      held ? el('p', { className: 'sg-note', textContent: `${held} building${held > 1 ? 's' : ''} on hold.` }) : null,
    ];
  }

  function buildView(plot) {
    const s = world.sides[ME];
    if (s.plots[plot]) { setTimeout(() => setMode({ kind: 'hint' })); return []; }
    const groups = new Map();
    for (const line of kit.lines) {
      if (!groups.has(line.building)) groups.set(line.building, []);
      groups.get(line.building).push(line);
    }
    const option = (label, sub, icon, price, onclick, blocked, note) => priced(el('button', { type: 'button', className: 'sg-opt', onclick },
      el('img', { className: 'sg-opt-ic', src: icon, alt: '' }),
      el('span', { className: 'sg-opt-text' }, el('b', { textContent: label }), el('small', { textContent: note || sub })),
      priceTag(price)), price, blocked);
    const out = [closeRow('Build here')];
    for (const [building, lines] of groups) {
      out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(building), alt: '' }), BUILDING_NAMES[building] || 'Building'));
      out.push(el('div', { className: 'sg-opts' }, lines.map((line) => {
        const p = world.price(ME, 'build', line.key, plot);
        const needs = line.needs && !world.unlocked(ME, line) ? `Needs ${kit.techs.find((t) => t.id === line.needs)?.name || 'a tech'} (Armory)` : null;
        const steps = line.tiers.length > 1 ? `→ ${line.tiers.at(-1).name}` : 'no upgrades';
        return option(line.tiers[0].name, `1 per ${Math.round(line.tiers[0].every / GAME_SPEED)}s · ${steps}`, unitIcon(line.tiers[0].unitId, line.tiers[0].picture),
          line.cost, () => { if (world.canBuy(ME, 'build', line.key, plot) && act('build', { key: line.key, plot })) setMode({ kind: 'hint' }); },
          p === null, needs);
      })));
    }
    const mp = world.price(ME, 'market', null, plot);
    out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(84), alt: '' }), 'Economy'));
    out.push(el('div', { className: 'sg-opts' }, option('Market', `+${MARKET.income} gold every 4s · ${s.markets}/${MARKET.max} built`, bldIcon(84), MARKET.cost,
      () => { if (world.canBuy(ME, 'market', null, plot) && act('market', { plot })) setMode({ kind: 'hint' }); }, mp === null)));
    return out;
  }

  function buildingView(id) {
    const b = world.building(id);
    if (!b || b.side !== ME) { setTimeout(() => setMode({ kind: 'hint' })); return []; }
    const s = world.sides[ME];
    const sellBtn = el('button', { type: 'button', className: 'sg-sell', onclick: () => { act('sell', { id: b.id }); setMode({ kind: 'hint' }); } },
      'Sell for ', goldImg(), String(world.sellValue(b.id)));
    if (b.line === 'market') {
      return [closeRow('Market'), el('p', { className: 'sg-note', textContent: `Adds ${MARKET.income} gold every 4 seconds.` }), sellBtn];
    }
    const line = world.line(ME, b.line);
    const cur = line.tiers[b.tier];
    const next = line.tiers[b.tier + 1];
    const f = kit.fighter(b.line, b.tier, s.researched, s.researchKey);
    const stat = (x) => Math.round(x * 10) / 10;
    const atk = f.projectile ? f.attacks.get(3) : f.attacks.get(4);
    const steps = el('div', { className: 'sg-steps' }, line.tiers.map((t, i) => el('span', { className: `sg-step${i === b.tier ? ' now' : i < b.tier ? ' done' : ''}` },
      el('img', { src: unitIcon(t.unitId, t.picture), alt: '' }), el('small', { textContent: t.name }))));
    const upPrice = world.price(ME, 'upgrade', b.id);
    return [
      closeRow(`${BUILDING_NAMES[line.building]}: ${cur.name}`),
      steps,
      el('p', { className: 'sg-note', textContent: `${Math.floor(f.hp)} HP · ${stat(atk ?? 0)} attack · ${stat(f.armours.get(4) ?? 0)}/${stat(f.armours.get(3) ?? 0)} armour · 1 every ${Math.round(b.every / GAME_SPEED)}s` }),
      el('div', { className: 'sg-acts' },
        next ? priced(el('button', { type: 'button', className: 'sg-buy', onclick: () => { act('upgrade', { id: b.id }); refresh(true); } },
          el('span', { className: 'sg-buy-label', textContent: `Upgrade to ${next.name}` }), priceTag(next.upgrade)), next.upgrade, upPrice === null)
          : el('p', { className: 'sg-note', textContent: 'Fully upgraded.' }),
        el('button', { type: 'button', className: `sg-hold${b.hold ? ' on' : ''}`, onclick: () => { act('hold', { id: b.id }); refresh(true); },
          textContent: b.hold ? (b.waiting ? 'Release now' : 'Stop holding') : 'Hold next unit' }),
        sellBtn),
    ];
  }

  // The Armory tech under way: how far along (0..1) and real seconds left.
  const researchState = () => {
    const r = world.sides[ME].research;
    if (!r) return null;
    const left = Math.max(0, r.endsAt - world.t);
    return { r, frac: 1 - left / r.time, secs: Math.ceil(left / GAME_SPEED) };
  };
  /** Strip at the top of the panel, whatever it's showing, while a tech is being researched. */
  function researchBar() {
    const st = researchState();
    if (!st) return null;
    const t = kit.techs.find((x) => x.id === st.r.id);
    return el('button', { type: 'button', className: 'sg-research', onclick: () => setMode({ kind: 'armory' }) },
      el('img', { src: t?.picture !== undefined ? imageUrl('Tech', t.picture) : bldIcon(103), alt: '' }),
      el('span', { className: 'sg-rname' }, el('small', { textContent: 'Researching' }), el('b', { textContent: t?.name || 'Upgrade' })),
      el('span', { className: 'sg-rleft', textContent: `${st.secs}s` }),
      el('div', { className: 'sg-rbar' }, el('i', { style: `width:${Math.round(st.frac * 100)}%` })));
  }

  function armoryView() {
    const s = world.sides[ME];
    const out = [closeRow('Armory')];
    if (!s.research) out.push(el('p', { className: 'sg-note', textContent: 'One at a time. Each upgrade reaches all your units that it applies to, including those already fighting.' }));
    for (const group of ['Blacksmith', 'Unit upgrades', 'Unique techs']) {
      const list = kit.techs.filter((t) => t.group === group);
      if (!list.length) continue;
      out.push(el('h4', { className: 'sg-group', textContent: group }));
      out.push(el('div', { className: 'sg-opts' }, list.map((t) => {
        const done = s.researched.has(t.id);
        const p = world.price(ME, 'research', t.id);
        const blocked = t.after && !s.researched.has(t.after);
        const now = s.research?.id === t.id;
        const note = done ? 'Researched' : now ? 'Researching…' : blocked ? `After ${kit.techs.find((x) => x.id === t.after)?.name}` : `${Math.round(t.time / GAME_SPEED)}s to research`;
        return priced(el('button', { type: 'button', className: `sg-opt${done ? ' done' : ''}${now ? ' researching' : ''}`,
          onclick: () => { act('research', { id: t.id }); refresh(true); } },
          now ? el('i', { className: 'sg-opt-fill', style: `width:${Math.round((researchState()?.frac || 0) * 100)}%` }) : null,
          el('img', { className: 'sg-opt-ic', src: t.picture !== undefined ? imageUrl('Tech', t.picture) : '', alt: '' }),
          el('span', { className: 'sg-opt-text' }, el('b', { textContent: t.name }), el('small', { textContent: note })),
          done ? el('span', { className: 'sg-tick', textContent: '✓' }) : priceTag(t.cost)), t.cost, done || p === null);
      })));
    }
    return out;
  }

  function refresh(force = false) {
    const s = world.sides[ME];
    goldNum.textContent = String(Math.floor(s.gold));
    incomeTxt.textContent = `+${world.income(ME)} every 4s`;
    const held = world.held(ME);
    const waiting = held.filter((b) => b.waiting).length;
    goBtn.disabled = held.length === 0;
    goBtn.replaceChildren('GO', held.length ? el('small', { textContent: `${waiting}/${held.length}` }) : '');
    goBtn.classList.toggle('ready', waiting > 0);
    armoryBtn.querySelector('.sg-armory-dot').hidden = !s.research;
    // Rebuild the dock only when something it shows has changed.
    const b = pmode.kind === 'building' ? world.building(pmode.id) : null;
    const key = [pmode.kind, pmode.plot, pmode.id, s.plots.join(), s.markets, s.researched.size, s.research?.id,
      b ? `${b.tier}${b.hold}${b.waiting}` : '', held.length, world.winner].join('|');
    if (!force && key === lastKey) {
      // Same content: just keep prices and the research bar current.
      for (const btn of dock.querySelectorAll('[data-price]')) btn.disabled = btn.dataset.blocked === '1' || s.gold < Number(btn.dataset.price);
      const st = researchState();
      if (st) {
        const w = `${Math.round(st.frac * 100)}%`;
        for (const bar of dock.querySelectorAll('.sg-rbar i, .sg-opt-fill')) bar.style.width = w;
        const left = dock.querySelector('.sg-rleft');
        if (left) left.textContent = `${st.secs}s`;
      }
      return;
    }
    lastKey = key;
    const content = pmode.kind === 'build' ? buildView(pmode.plot) : pmode.kind === 'building' ? buildingView(pmode.id) : pmode.kind === 'armory' ? armoryView() : hintView();
    const scroll = dock.scrollTop;
    dock.replaceChildren(...[researchBar(), ...content].flat().filter(Boolean));
    dock.scrollTop = scroll;
  }

  // ---------- Loop ----------
  let running = true;
  let speed = 1;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let wake = null;
  let hudAt = 0;
  let ended = false;
  const lockScreen = async () => { if ('wakeLock' in navigator) { try { wake = await navigator.wakeLock.request('screen'); } catch { wake = null; } } };
  lockScreen();

  // Wi-Fi: the host sends snapshots and runs joined players' commands; a joined phone draws the snapshots.
  let snapAt = 0;
  let snapT = 0;
  let sentT = 0;
  let lastSnap = 0;
  const offs = [];
  if (mode === 'host') {
    offs.push(net.lan.on('message', (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      const p = [...net.peers].find(([, peer]) => peer === m.peer)?.[0];
      if (p === undefined || msg.t !== 'cmd' || !COMMANDS[msg.cmd]) return;
      COMMANDS[msg.cmd](world, p, msg.args || {});
    }));
    offs.push(net.lan.on('peer', (e) => {
      if (e.state !== 'leave') return;
      // A player who drops out is replaced by the computer.
      for (const [p, peer] of net.peers) {
        if (peer !== e.peer) continue;
        net.peers.delete(p);
        players[p].kind = 'ai';
        ais.push(new Computer(world, p, { level: 'normal' }));
        banner.hidden = false; banner.textContent = `${players[p].name} left; the computer plays for them`;
        setTimeout(() => { banner.hidden = true; }, 4000);
      }
    }));
  }
  if (client) {
    offs.push(net.lan.on('message', (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.t === 'snap') {
        applySnapshot(world, msg.s);
        snapAt = performance.now(); snapT = msg.s.t;
        if (msg.paused !== !running) setRunning(!msg.paused, true);
      }
    }));
    offs.push(net.lan.on('closed', () => {
      if (world.winner !== null) return;
      banner.hidden = false; banner.textContent = 'Lost the connection to the host';
    }));
  }

  const frame = (now) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!client && running && world.winner === null) {
      acc += dt * GAME_SPEED * speed;
      let n = 0;
      while (acc >= DT && n < 40) { for (const a of ais) a.think(); world.step(); acc -= DT; n++; }
      if (n === 40) acc = 0;
    }
    if (mode === 'host' && (now - lastSnap >= SNAP_MS || (world.winner !== null && !ended))) {
      lastSnap = now;
      net.lan.broadcast(JSON.stringify({ t: 'snap', s: snapshot(world, sentT), paused: !running }));
      sentT = world.t;
    }
    if (client) {
      // Slide soldiers between snapshots, and keep animations ticking.
      const since = (now - snapAt) / 1000;
      if (snapAt && running) world.t = snapT + Math.min(0.2, since) * GAME_SPEED;
      const a = snapAt ? Math.min(1, since / (SNAP_MS / 1000)) : 1;
      view.draw(a, snapT - (1 - a) * (SNAP_MS / 1000) * GAME_SPEED);
    } else {
      // Soldiers are drawn between the last two steps; draw everything else at that same moment.
      const a = running ? Math.min(1, acc / DT) : 1;
      view.draw(a, world.t - (1 - a) * DT);
    }
    if (now - hudAt > 150) {
      hudAt = now;
      clock.textContent = fmt(world.t / GAME_SPEED);
      for (const s of [0, 1]) {
        const c = world.teams[s].castle;
        if (c) castles[s].fill.style.width = `${Math.max(0, (c.hp / c.maxHp) * 100)}%`;
        castles[s].count.textContent = String(world.alive[s]);
      }
      incomeTxt.classList.toggle('bonus', world.territory[myTeam]);
      const left = world.sides[ME].blasts;
      blastBtn.disabled = left <= 0;
      blastBtn.querySelector('.sg-blast-n').textContent = String(left);
      followBtn.hidden = view.follow;
      const ot = world.overtime();
      if (ot > 1 && world.winner === null) { banner.hidden = false; banner.textContent = `Overtime: castles crumbling, buildings take +${Math.round((ot - 1) * 100)}% damage`; }
      refresh();
    }
    if (world.winner !== null && !ended) { ended = true; setTimeout(showEnd, 1200); }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const setRunning = (on, fromHost = false) => {
    if (client && !fromHost) return;   // only the host can pause a Wi-Fi game
    running = on;
    pauseBtn.textContent = on ? '❚❚' : '▶';
    pauseBtn.setAttribute('aria-label', on ? 'Pause' : 'Resume');
    screen.classList.toggle('paused', !on);
    if (on) lockScreen(); else { wake?.release?.(); wake = null; }
  };
  pauseBtn.addEventListener('click', () => setRunning(!running));
  speedBtn.addEventListener('click', () => { speed = speed === 1 ? 2 : 1; speedBtn.textContent = `${speed}×`; });
  const onVis = () => { if (document.hidden && running && world.winner === null) setRunning(false); };
  document.addEventListener('visibilitychange', onVis);

  if (client) { pauseBtn.hidden = true; speedBtn.hidden = true; }
  function close() {
    view.dispose();
    cancelAnimationFrame(raf);
    for (const off of offs) off();
    if (net) net.onLeave?.();
    document.removeEventListener('visibilitychange', onVis);
    wake?.release?.();
    screen.remove();
    document.body.classList.remove('sg-open');
  }
  closeBtn.addEventListener('click', () => {
    if (world.winner === null && world.t > 30) {
      setRunning(false);
      confirmQuit();
    } else close();
  });
  function confirmQuit() {
    const box = el('div', { className: 'sg-end' },
      el('h2', { textContent: 'Leave this game?' }),
      el('div', { className: 'sg-end-acts' },
        el('button', { type: 'button', className: 'fight', textContent: 'Keep playing', onclick: () => { box.remove(); setRunning(true); } }),
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Quit', onclick: close })));
    screen.append(box);
  }

  function showEnd() {
    const won = world.winner === myTeam;
    // Totals per team (one player each in a 1v1)
    const team = (t) => world.sides.filter((s) => s.team === t);
    const S = [0, 1].map((t) => ({
      stats: Object.fromEntries(['trained', 'kills', 'earned', 'spent'].map((k) => [k, team(t).reduce((a, s) => a + (s.stats[k] || 0), 0)])),
      researched: { size: team(t).reduce((a, s) => a + s.researched.size, 0) },
      blasts: team(t).reduce((a, s) => a + s.blasts, 0),
    }));
    const row = (label, f) => el('tr', {}, el('th', { scope: 'row', textContent: label }), el('td', { textContent: f(0) }), el('td', { textContent: f(1) }));
    const box = el('div', { className: `sg-end ${won ? 'won' : 'lost'}` },
      el('h2', { textContent: won ? 'Victory!' : 'Defeat' }),
      el('p', { textContent: `${won ? 'Your team knocked down the enemy castle' : 'The enemy took your castle'} after ${fmt(world.t / GAME_SPEED)} (${fmt(world.t)} game time).` }),
      el('table', { className: 'result-table' },
        el('thead', {}, el('tr', {}, el('th'), el('th', { textContent: `Blue: ${civNames[0]}` }), el('th', { textContent: `Red: ${civNames[1]}` }))),
        el('tbody', {},
          row('Units trained', (i) => S[i].stats.trained),
          row('Enemies killed', (i) => S[i].stats.kills),
          row('Techs researched', (i) => S[i].researched.size),
          row('Explosions left', (i) => S[i].blasts),
          row('Gold earned', (i) => Math.round(S[i].stats.earned)),
          row('Gold spent', (i) => Math.round(S[i].stats.spent)))),
      el('div', { className: 'sg-end-acts' },
        mode === 'solo' ? el('button', { type: 'button', className: 'fight', textContent: 'Play again', onclick: () => { close(); openGame({ data, kits, assets, players, me, mode }); } }) : null,
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Back', onclick: close })));
    screen.append(box);
  }
  refresh(true);
}
