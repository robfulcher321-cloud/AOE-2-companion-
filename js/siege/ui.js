// AOSiege tab: pick civs and difficulty, then play against the computer.

import { loadCore, loadTree, imageUrl, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { loadPack, onPackProgress } from '../duel/spritepack.js';
import { RANGED } from '../duel/ranged.js';
import { buildKit, MARKET, BUILDING_NAMES, AGES } from './kit.js';
import { World, Computer, DT, OVERTIME, START_GOLD, BLAST, LANE, GAME_SPEED } from './world.js';
import { SiegeView, COLOURS } from './view.js';
export { COLOURS };
import { COMMANDS, snapshot, applySnapshot } from './sync.js';
import { openLobby } from './lobby.js';
import { setOrientation, setImmersive } from '../orient.js';

// Player colours (AoE II's), for names, buildings and the minimap. Soldiers wear their team's blue or red.
const SNAP_MS = 100;   // Wi-Fi games: the host sends the game state this often
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

// Chat: one-tap emotes and phrases, or type a line (everyone sees it, allies and enemies).
const EMOTES = ['👍', '👎', '😂', '😮', '😡', '🙏', '🔥', '💀'];
const PHRASES = ['GG', 'Attack!', 'Help!', 'Hold on', 'Nice one', 'Well played', 'Sorry', 'Wow'];

// The civ's bonuses in the game's own words, sorted by whether they matter in Wonder Wars
// (soldiers, their costs and training count; villagers, ships, monks and buildings don't).
const MILITARY = /infantry|cavalry|archer|militia|spear|pike|halberd|skirmish|scout|knight|cavalier|paladin|camel|elephant|cannon|gunpowder|siege|trebuchet|mangonel|onager|scorpion|\bram|soldier|units?\b|mounted|swords|champion|hussar|attack|armou?r|\bhp\b|hit points|trains?|created|barracks|archery range|stable|blacksmith|bombard|lancer|steppe/i;
// Unit costs count (food, wood and gold all go into a building's price); tech and upgrade
// discounts don't (Wonder Wars prices those the same for every civ), nor terrain, ships or the economy.
const NOT_HERE = /villager|shepherd|farm|fish|lumber|forag|hunt|miner|mining|town cent|dock|ships?\b|warship|galley|galleon|monk|relic|trade|caravan|market|house|mill|tower|wall|gate|population|herd|feitoria|caravel|explore|line of sight|conver|university|krepost|donjon|fortif|outpost|settlement|start with|\bwork \+|elevation|^buildings\b|\bfree\b|(upgrades?|technolog\w*|techs?) (cost|research)|^(blacksmiths?|universities|archery ranges?|stables?|barracks|siege workshops?)( and [\w ]+)? cost/i;
const countsHere = (line) => MILITARY.test(line) && !NOT_HERE.test(line);
function parseCivHelp(html) {
  const lines = String(html || '').split(/<br\s*\/?>/i).map((l) => l.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const out = { tagline: '', bonuses: [], unique: [], uts: [], team: [] };
  let part = 'bonuses';
  for (const l of lines) {
    if (!l) continue;
    if (/^unique units?:?$/i.test(l)) { part = 'unique'; continue; }
    if (/^unique techs?:?$/i.test(l)) { part = 'uts'; continue; }
    if (/^team bonus(es)?:?$/i.test(l)) { part = 'team'; continue; }
    const text = l.replace(/^[•·-]\s*/, '');
    if (part === 'bonuses' && !out.tagline && !l.startsWith('•')) { out.tagline = text; continue; }
    // A bullet the game wrapped onto a second line ("…in Dark/Feudal/" + "Castle/Imperial Age")
    if (part === 'bonuses' && !l.startsWith('•') && out.bonuses.length) { out.bonuses[out.bonuses.length - 1] += ` ${text}`; continue; }
    out[part].push(text);
  }
  return out;
}

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
      el('p', { className: 'sg-note', textContent: 'Up to 6 players, 3 a team. Put the computer in any place, or leave places open for friends on the same Wi-Fi to join.' }),
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
        el('li', { textContent: 'Each team has a Wonder (a random civ\'s from that team) at its end of the lane. Destroy the enemy Wonder to win. Wonders shoot arrows like a Castle.' }),
        el('li', { textContent: 'Everyone starts in the Dark Age with just Militia. The age button (above the anvil) advances you for gold in a few seconds; each age opens its units, upgrades and Armory techs, as in the game. Locked ones are greyed with the age they need. Everyone sees who aged up.' }),
        el('li', { textContent: 'You don\'t control units. Tap anywhere in your base (the dashed area, in front of your Wonder or behind it) to build: pick a building, drag it where you want it, then press Build. It turns red if it\'s too close to another building. Soldiers walk through buildings, so nothing can be walled off.' }),
        el('li', { textContent: 'Buildings take about 8 to 12 seconds to go up, and are weak until they\'re finished. Each training building then sends out one unit on a timer; the units march down the lane and fight on their own. Unique units train at the building of their kind (Longbowmen at the Archery Range); Trebuchets at the Siege Workshop from the Castle Age.' }),
        el('li', { textContent: 'Towers, Bombard Towers and the Castle are defences: they shoot enemy soldiers that come near. Towers upgrade in place (Watch Tower → Guard Tower → Keep).' }),
        el('li', { textContent: 'Tap a building for its menu: tap the next unit in its line to upgrade (Militia → Man-at-Arms → … → Champion; the price is on it), pause it, or sell it for half of what you put in. Each building upgrades on its own.' }),
        el('li', { textContent: 'The red hand holds every building\'s next unit; GO sends them all out at once.' }),
        el('li', { textContent: 'The Armory (anvil, bottom left) has Blacksmith upgrades, Ballistics, Chemistry, Bloodlines and your civ\'s unique techs. One at a time; each one reaches all your units, even those already fighting.' }),
        el('li', { textContent: 'The middle of the map is split by a river into two lanes. Buildings above your Wonder send units down the top lane, those below it the bottom lane, those in line with it take turns. Arrows fly over the river; soldiers cross only near the bases.' }),
        el('li', { textContent: `One explosion each (the fire button): tap it, drag the circle, then Drop. It hurts every enemy soldier within ${BLAST.radius} tiles for ${Math.round(BLAST.share * 100)}% of their HP. It can only be dropped on your own end of the map (up to the dashed line, a little past your base): it's for defending against a deathball, not for pushing.` }),
        el('li', { textContent: 'Gold comes in every few seconds; Markets add more, and kills pay a bounty. In team games everyone gets two thirds of the 1v1 base income (your own Markets and mines still pay you in full).' }),
        el('li', { textContent: 'Four gold mines sit beside the lanes, two along each bank of the river. When your soldiers get past one, the first of them past it builds a Mining Camp in your colour on your side of it, which pays you every income tick (+5 gold in a 1v1, +3 in team games). If enemy soldiers get past it, they pull your camp down in about 5 seconds and build their own.' }),
        el('li', { textContent: 'Prices follow the game: a building costs what its unit costs (with your civ\'s discounts, like Goths\' cheap infantry), gold counting double, so gold-heavy units and their upgrades cost more. Each unit comes out at its real training time.' }),
        el('li', { textContent: 'Rams and Trebuchets only attack buildings. Trebuchets unpack to fire and pack up to move, so keep them behind your army.' }),
        el('li', { textContent: 'Counter what the computer builds: spearmen beat cavalry, skirmishers beat archers, cavalry and infantry beat archers.' }),
        el('li', { textContent: 'Drag the battlefield or tap the minimap to look around. The camera stays put; tap "To the fight" to jump to where the armies meet.' }),
        el('li', { textContent: `After ${OVERTIME / 60} game minutes (about ${Math.round(OVERTIME / 60 / 1.7)} real minutes) it's overtime: both Wonders crumble and buildings take more damage every minute, so games always end.` }))),
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
      const assets = await loadAssets(kits, (msg) => { status.textContent = msg; });
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
async function loadAssets(kits, onStatus = () => {}) {
  const stop = onPackProgress(({ active, done, total }) => {
    if (active && total) onStatus(`Downloading game graphics: ${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB (once only)`);
  });
  const pack = await loadPack();
  stop();
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
        if (RANGED[f.unitId]?.fire) shotNames.add(RANGED[f.unitId].fire);   // burning, after Chemistry
        const pic = line.tiers[t].picture;
        if (pic !== undefined && !unitIcons[f.unitId]) jobs.push(loadImg(imageUrl('Unit', pic)).then((img) => { unitIcons[f.unitId] = img; }));
      }
    }
    for (const d of kit.defences) shotNames.add(d.shot);
    for (const id of [82, 84, 103, 79, 234, 235, 236, 584, ...kit.lines.map((l) => l.building)]) {
      const pic = kit.buildingPicture(id);
      if (pic !== undefined && !buildingIcons[id]) { buildingIcons[id] = null; jobs.push(loadImg(imageUrl('Building', pic)).then((img) => { buildingIcons[id] = img; })); }
    }
  }
  // Unit and building colours are made during the game, as each one is needed.
  let sprites = null;
  if (pack) {
    sprites = { pack, grass: await pack.grass(), projectiles: {}, textures: {}, rubble: {}, trees: {} };
    shotNames.add('p_arrow_x1');   // the Wonder's arrows
    jobs.push(...[...shotNames].map(async (n) => { sprites.projectiles[n] = await pack.projectile(n); }));
    jobs.push(...['water', 'shallow', 'beach', 'wetbeach'].map(async (n) => { sprites.textures[n] = await pack.texture(n); }));
    jobs.push(...['barracks', 'archery', 'stable', 'castle', 'market', 'workshop', 'wonder', 'tower1', 'tower2', 'tower3', 'bombard', 'miningcamp'].map(async (n) => { sprites.rubble[n] = await pack.rubble(n); }));
    sprites.foundations = {};
    if (pack.foundation) jobs.push(...['barracks', 'archery', 'stable', 'castle', 'market', 'workshop', 'tower1', 'tower2', 'tower3', 'bombard'].map(async (n) => { sprites.foundations[n] = await pack.foundation(n); }));
    jobs.push(pack.trees().then((t) => { sprites.trees = t; }));
    if (pack.foam) jobs.push(pack.foam().then((f) => { sprites.foam = f; }));
    if (pack.nature) jobs.push(pack.nature('goldmine').then((g) => { sprites.goldmine = g; }));
    if (pack.foundation) jobs.push(pack.foundation('miningcamp').then((f) => { sprites.foundations.miningcamp = f; }));
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
  // The red hand: hold every building's next unit (GO, next to it, lets them all out)
  const stopBtn = el('button', { type: 'button', className: 'sg-stop', 'aria-label': 'Hold all units', textContent: '✋' });
  const closeBtn = el('button', { type: 'button', className: 'sg-btn sg-close', textContent: '×', 'aria-label': 'Quit game' });
  const canvas = el('canvas', { className: 'sg-canvas', 'aria-label': 'Battlefield: tap your base to build, tap a building for its menu' });
  const mini = el('canvas', { className: 'sg-mini', 'aria-label': 'Minimap: tap to look there' });
  const followBtn = el('button', { type: 'button', className: 'sg-follow', textContent: '⚔ To the fight' });
  const armoryBtn = el('button', { type: 'button', className: 'sg-armory-btn', 'aria-label': 'Armory' },
    el('img', { src: bldIcon(103), alt: '' }), el('span', { className: 'sg-armory-dot', hidden: true }));
  const ageIcon = (age) => {
    const pic = age === 1 ? undefined : kit.agePicture(age);
    return pic !== undefined ? imageUrl('Tech', pic) : bldIcon(109);
  };
  const ageBtn = el('button', { type: 'button', className: 'sg-age-btn', 'aria-label': 'Ages' },
    el('img', { src: '', alt: '' }), el('small', { className: 'sg-age-name' }), el('i', { className: 'sg-age-ring' }));
  const banner = el('div', { className: 'sg-banner', hidden: true });
  const notices = el('div', { className: 'sg-notices', 'aria-live': 'polite' });
  if (!assets.sprites) {   // never silently: say so if the in-game graphics didn't load
    banner.hidden = false; banner.textContent = 'In-game graphics didn\'t load: showing icons';
    setTimeout(() => { banner.hidden = true; }, 6000);
  }
  const blastBtn = el('button', { type: 'button', className: 'sg-blast-btn', 'aria-label': 'Explosion (once per game)' },
    el('span', { className: 'sg-blast-ic', textContent: '💥' }), el('small', { className: 'sg-blast-n', textContent: String(BLAST.per) }));
  // Aiming the explosion: drag the circle with your finger; Drop and Cancel sit at the bottom, out of the way.
  const dropBtn = el('button', { type: 'button', className: 'sg-drop', textContent: '💥 Drop' });
  const aimBar = el('div', { className: 'sg-aim', hidden: true }, dropBtn,
    el('button', { type: 'button', className: 'sg-btn', textContent: 'Cancel', onclick: () => setAim(false) }),
    el('small', { className: 'sg-aim-text', textContent: 'Drag to aim' }));
  const dock = el('section', { className: 'sg-dock' });
  // Placing a new building: drag it about, then Build (or Cancel); kept at the bottom, out of the way
  const placeBtn = el('button', { type: 'button', className: 'sg-drop sg-place-ok', textContent: '✓ Build' });
  const placeBar = el('div', { className: 'sg-aim sg-place', hidden: true }, placeBtn,
    el('button', { type: 'button', className: 'sg-btn', textContent: 'Cancel', onclick: () => setMode({ kind: 'hint' }) }),
    el('small', { className: 'sg-aim-text', textContent: 'Drag to move' }));
  // Your civ's flag: tap for what it's good and bad at
  const flagBtn = el('button', { type: 'button', className: 'sg-flag-btn', 'aria-label': `Your civ: ${players[ME].civName || ''}` },
    el('img', { className: 'sg-flag', src: players[ME].civ ? civIconUrl(players[ME].civ) : '', alt: '', style: `--pc:${players[ME].colour}` }));
  const chatBtn = el('button', { type: 'button', className: 'sg-chat-btn', 'aria-label': 'Chat and emotes' },
    el('span', { textContent: '💬' }), el('i', { className: 'sg-chat-dot', hidden: true }));
  const chatFeed = el('div', { className: 'sg-chat-feed', 'aria-live': 'polite' });
  const tipBox = el('div', { className: 'sg-tip', role: 'tooltip', hidden: true });
  // Screen: follow the phone, or keep it sideways or upright (remembered between games)
  const ORIENT = {
    auto: { icon: '⟳', say: 'Screen follows your phone' },
    landscape: { icon: '▭', say: 'Screen kept sideways' },
    portrait: { icon: '▯', say: 'Screen kept upright' },
  };
  let orient = ORIENT[store.get('sg-orient')] ? store.get('sg-orient') : 'auto';
  const rotBtn = el('button', { type: 'button', className: 'sg-rot-btn', 'aria-label': 'Screen orientation' });

  const screen = el('div', { className: 'sg-run', role: 'dialog', 'aria-label': 'Wonder Wars game' },
    el('header', { className: 'sg-head' },
      el('div', { className: 'sg-gold' },
        flagBtn,
        el('img', { className: 'sg-gold-ic', src: 'img/res/gold.webp', alt: 'Gold', width: 28, height: 28 }), goldNum, incomeTxt),
      clock, stopBtn, goBtn, pauseBtn, closeBtn,
      el('div', { className: 'sg-castles' }, castles[0].wrap, castles[1].wrap)),
    el('div', { className: 'sg-field' }, canvas, followBtn, rotBtn, ageBtn, armoryBtn, blastBtn, chatBtn, chatFeed, aimBar, placeBar, banner, notices),
    mini,
    dock,
    tipBox);
  document.body.append(screen);
  screen.world = world; // handy when debugging in the browser console
  document.body.classList.add('sg-open');

  // ---------- The dock: what you can do right now ----------
  // pmode: { kind: 'hint' } | { kind: 'build', at, key? } | { kind: 'building', id } | { kind: 'armory' } | age | chat | civ
  let pmode = { kind: 'hint' };
  let lastKey = '';
  const view = new SiegeView(canvas, mini, {
    tapGround: (x, y) => setMode({ kind: 'build', at: [x, y] }),
    tapBuilding: (b) => setMode({ kind: 'building', id: b.id }),
    holdBuilding: (b) => setMode({ kind: 'building', id: b.id }),
    placed: (pl) => { placeBtn.disabled = !pl.ok; placeBar.querySelector('.sg-aim-text').textContent = pl.ok ? 'Drag to move' : pl.high ? 'Too high: it would be cut off' : 'Too close to a building'; },
    tapEmpty: () => setMode({ kind: 'hint' }),
    aimAt: (x, y) => {
      // Kept inside your third of the map (it's for defending) and on the field
      const [z0, z1] = world.blastZone(myTeam);
      const inside = world.canBlastAt(myTeam, x);
      x = Math.max(z0, Math.min(z1, x));
      y = Math.max(-LANE.half, Math.min(LANE.half, y));
      view.aimPoint = [x, y];
      dropBtn.disabled = false;
      aimBar.querySelector('.sg-aim-text').textContent = inside ? 'Drag to aim' : 'Only your third';
    },
  });
  function setAim(on) {
    view.aiming = on && world.sides[ME].blasts > 0;
    view.aimPoint = null;
    dropBtn.disabled = true;
    aimBar.querySelector('.sg-aim-text').textContent = 'Drag to aim';
    aimBar.hidden = !view.aiming;
    if (view.aiming) {
      // Start on the biggest enemy clump in your third (else its middle), and look there
      const [z0, z1] = world.blastZone(myTeam);
      const spot = world.blastSpot(myTeam);
      view.aimPoint = spot ? [spot[0], spot[1]] : [(z0 + z1) / 2, 0];
      dropBtn.disabled = false;
      view.glideTo = view.aimPoint[0];
    }
    blastBtn.classList.toggle('on', view.aiming);
  }
  blastBtn.addEventListener('click', () => { if (view.placing) setMode({ kind: 'hint' }); setAim(!view.aiming); });
  placeBtn.addEventListener('click', () => {
    const pl = view.placing;
    if (!pl?.ok) return;
    if (act('build', { key: pl.key, at: [Math.round(pl.x * 100) / 100, Math.round(pl.y * 100) / 100] })) { navigator.vibrate?.(20); setMode({ kind: 'hint' }); }
  });
  dropBtn.addEventListener('click', () => {
    if (!view.aimPoint) return;
    act('blast', { x: view.aimPoint[0], y: view.aimPoint[1] });
    navigator.vibrate?.([40, 30, 80]);
    setAim(false);
  });
  view.setup(world, { ...assets, mySide: ME, colours: players.map((p) => p.colour), civs: players.map((p) => p.civ) });
  screen.view = view;
  view.resize();
  followBtn.addEventListener('click', () => view.jumpToFight());
  flagBtn.addEventListener('click', () => setMode(pmode.kind === 'civ' ? { kind: 'hint' } : { kind: 'civ', who: ME }));
  chatBtn.addEventListener('click', () => setMode(pmode.kind === 'chat' ? { kind: 'hint' } : { kind: 'chat' }));
  tip(flagBtn, `You: ${players[ME].civName || ''}`, 'Tap to see what your civ is good and bad at in Wonder Wars, and the other players\' civs.');
  tip(chatBtn, 'Chat', 'Emotes and messages. Everyone in the game sees them, allies and enemies.');
  tip(ageBtn, 'Ages', 'Advance to the next age for gold. Each age unlocks units, upgrades and Armory techs; everyone is told when you advance.');
  tip(armoryBtn, 'Armory', 'Blacksmith and unit techs. Each one reaches every unit it applies to, including those already fighting. One at a time.');
  tip(blastBtn, 'Explosion', `Once per game. Drag the circle onto enemies inside your own third of the field (up to the dashed line), then Drop. It hits enemies only.`);
  tip(followBtn, 'To the fight', 'Moves the view to where the fighting is. The view never moves on its own.');
  tip(goBtn, 'GO', 'Sends out every unit your buildings are holding, all at once.');
  tip(rotBtn, 'Screen', 'Tap to switch: follow your phone (⟳), keep it sideways (▭), or keep it upright (▯). Sideways gives the battle most of the screen.');
  // Sideways: hide the phone's status and navigation bars too (swipe from an edge to get them back)
  const wide = matchMedia('(orientation: landscape)');
  const onTurn = () => setImmersive(wide.matches);
  wide.addEventListener('change', onTurn);
  onTurn();
  const applyOrient = (announce) => {
    rotBtn.textContent = ORIENT[orient].icon;
    rotBtn.dataset.mode = orient;
    setOrientation(orient).then((ok) => {
      if (!announce) return;
      banner.hidden = false;
      banner.textContent = ok || orient === 'auto' ? ORIENT[orient].say : 'Turn your phone to rotate (this browser can\'t lock it)';
      clearTimeout(applyOrient.t);
      applyOrient.t = setTimeout(() => { banner.hidden = true; }, 1800);
    });
  };
  rotBtn.addEventListener('click', () => {
    orient = orient === 'auto' ? 'landscape' : orient === 'landscape' ? 'portrait' : 'auto';
    store.set('sg-orient', orient);
    applyOrient(true);
  });
  applyOrient(false);
  armoryBtn.addEventListener('click', () => setMode(pmode.kind === 'armory' ? { kind: 'hint' } : { kind: 'armory' }));
  ageBtn.addEventListener('click', () => setMode(pmode.kind === 'age' ? { kind: 'hint' } : { kind: 'age' }));
  goBtn.addEventListener('click', () => { act('go'); navigator.vibrate?.(30); refresh(true); });

  function setMode(m) {
    pmode = m;
    chatBtn.classList.toggle('on', m.kind === 'chat');
    flagBtn.classList.toggle('on', m.kind === 'civ');
    if (m.kind === 'chat') chatBtn.querySelector('.sg-chat-dot').hidden = true;
    view.selected = m.kind === 'building' ? m.id : null;
    view.buildAt = m.kind === 'build' ? m.at : null;
    // Chose a building: its ghost appears where you tapped, ready to drag
    if (m.kind === 'build' && m.key) {
      const fp = world.footprint(ME, m.key);
      const line = m.key === 'market' ? null : kit.line(m.key);
      const old = view.placing;
      view.placing = { key: m.key, building: line ? line.building : MARKET.building, r: fp.r, x: old ? old.x : m.at[0], y: old ? old.y : m.at[1], ok: false };
      view.movePlacing(view.placing.x, view.placing.y);
      placeBar.hidden = false;
      if (view.aiming) setAim(false);
    } else {
      view.placing = null;
      placeBar.hidden = true;
    }
    armoryBtn.classList.toggle('on', m.kind === 'armory');
    ageBtn.classList.toggle('on', m.kind === 'age');
    lastKey = '';
    refresh(true);
  }

  // ---------- Press and hold any button: a little pop-up saying what it does ----------
  function tip(node, title, ...lines) {
    node.setAttribute('data-tip', lines.filter(Boolean).join('\n'));
    node.setAttribute('data-tip-title', title);
    return node;
  }
  let tipTimer = 0;
  let tipHide = 0;
  let tipDown = null;
  let swallowClick = false;
  // Found by position, so disabled (unaffordable or locked) buttons explain themselves too.
  const tipAt = (x, y) => [...screen.querySelectorAll('[data-tip]')].reverse().find((n) => {
    if (!n.getClientRects().length) return false;
    const r = n.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  function showTip(n) {
    tipBox.replaceChildren(el('b', { textContent: n.dataset.tipTitle || '' }), ...n.dataset.tip.split('\n').map((l) => el('p', { textContent: l })));
    tipBox.hidden = false;
    const r = n.getBoundingClientRect();
    const w = tipBox.offsetWidth;
    const h = tipBox.offsetHeight;
    tipBox.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tipBox.style.top = `${r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)}px`;
    navigator.vibrate?.(12);
  }
  const hideTip = () => { clearTimeout(tipHide); tipBox.hidden = true; };
  screen.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    hideTip();
    const n = tipAt(e.clientX, e.clientY);
    if (!n) return;
    tipDown = { x: e.clientX, y: e.clientY };
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { showTip(n); swallowClick = true; }, 450);
  }, true);
  screen.addEventListener('pointermove', (e) => {
    if (tipDown && Math.hypot(e.clientX - tipDown.x, e.clientY - tipDown.y) > 12) { clearTimeout(tipTimer); tipDown = null; }
  }, true);
  const endPress = () => {
    clearTimeout(tipTimer);
    tipDown = null;
    if (!tipBox.hidden) { clearTimeout(tipHide); tipHide = setTimeout(hideTip, 4000); }
  };
  screen.addEventListener('pointerup', endPress, true);
  screen.addEventListener('pointercancel', endPress, true);
  // The press that showed a pop-up doesn't also buy the thing
  screen.addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
  screen.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-tip]') || !tipBox.hidden) e.preventDefault(); }, true);
  const statLine = (f) => {
    const r = (x) => Math.round(x * 10) / 10;
    const atk = f.projectile ? f.attacks.get(3) : f.attacks.get(4);
    return `${Math.floor(f.hp)} HP · ${r(atk ?? 0)} attack · ${r(f.armours.get(4) ?? 0)}/${r(f.armours.get(3) ?? 0)} armour${f.range > 1 ? ` · range ${r(f.range)}` : ''}`;
  };

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
        el('span', { className: 'sg-plots', textContent: `${world.buildings(ME).length} building${world.buildings(ME).length === 1 ? '' : 's'}` })),
      el('ul', { className: 'sg-hints' },
        el('li', {}, el('b', { textContent: 'Tap your base' }), ' (the dashed area) to build, then drag it into place.'),
        el('li', {}, el('b', { textContent: 'Tap a building' }), ' to upgrade it, pause it or sell it.'),
        el('li', {}, 'The ', el('b', { textContent: 'red hand' }), ' holds every unit; ', el('b', { textContent: 'GO' }), ' sends them all out.'),
        el('li', {}, 'The ', el('b', { textContent: 'anvil' }), ' opens the Armory for upgrades that reach your whole army.'),
        el('li', {}, el('b', { textContent: 'Press and hold any button' }), ' to see what it does. Your ', el('b', { textContent: 'flag' }), ' shows your civ\'s strengths.')),
      held ? el('p', { className: 'sg-note', textContent: s.stopAll ? 'Holding every unit (red hand).' : `${held} building${held > 1 ? 's' : ''} on hold.` }) : null,
    ];
  }

  /** What you can build where you tapped; picking one puts its ghost there to drag into place. */
  function buildView(at, chosen) {
    const s = world.sides[ME];
    const groups = new Map();
    for (const line of kit.lines) {
      if (!groups.has(line.building)) groups.set(line.building, []);
      groups.get(line.building).push(line);
    }
    const option = (key, label, sub, icon, price, blocked, note) => {
      const btn = priced(el('button', { type: 'button', className: `sg-opt${chosen === key ? ' chosen' : ''}`, onclick: () => setMode({ kind: 'build', at, key }) },
        el('img', { className: 'sg-opt-ic', src: icon, alt: '' }),
        el('span', { className: 'sg-opt-text' }, el('b', { textContent: label }), el('small', { textContent: note || sub })),
        priceTag(price)), price, blocked);
      return btn;
    };
    const out = [closeRow(chosen ? 'Drag it into place' : 'Build here')];
    for (const [building, lines] of groups) {
      out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(building), alt: '' }), BUILDING_NAMES[building] || 'Building'));
      out.push(el('div', { className: 'sg-opts' }, lines.map((line) => {
        const p = world.price(ME, 'build', line.key);
        const locked = line.age > s.age ? `${AGES[line.age].name}` : null;
        const needs = locked || (line.needs && !world.unlocked(ME, line) ? `Needs ${kit.techs.find((t) => t.id === line.needs)?.name || 'a tech'} (Armory)` : null);
        const steps = line.tiers.length > 1 ? `→ ${line.tiers.at(-1).name}` : 'no upgrades';
        const t0 = line.tiers[0];
        const btn = option(line.key, t0.name, `1 per ${Math.round(t0.every / GAME_SPEED)}s · ${steps}`, unitIcon(t0.unitId, t0.picture), kit.linePrice(line, s.age), p === null, needs);
        if (locked) btn.classList.add('locked');
        return tip(btn, `${t0.name} (${BUILDING_NAMES[line.building] || 'building'})`, t0.help,
          statLine(kit.fighter(line.key, 0, s.researched, s.researchKey, s.age)),
          `Trains 1 every ${Math.round(t0.every / GAME_SPEED)}s and sends it down your lane. Takes ${world.footprint(ME, line.key).build}s to build.`,
          line.tiers.length > 1 ? `Upgrades here: ${line.tiers.map((t) => t.name).join(' → ')}` : 'No upgrades for this one.',
          locked ? `Needs the ${AGES[line.age].name}.` : needs ? `${needs}.` : '');
      })));
    }
    // Defences
    if (kit.defences.length) {
      out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(79) || bldIcon(82), alt: '' }), 'Defences'));
      out.push(el('div', { className: 'sg-opts' }, kit.defences.map((d) => {
        const p = world.price(ME, 'build', d.key);
        const locked = d.age > s.age ? AGES[d.age].name : null;
        const needs = locked || (d.needs && !world.unlocked(ME, d) ? `Needs ${kit.techs.find((t) => t.id === d.needs)?.name || 'Chemistry'} (Armory)` : null);
        const st = world.defenceStats(d, 0);
        const atk = st.attacks.get(3) ?? 0;
        const btn = option(d.key, d.tiers[0].name, `${d.arrows > 1 ? `${d.arrows} arrows` : d.key === 'def:bombard' ? 'cannon' : 'arrows'} · range ${st.range}${d.tiers.length > 1 ? ` · → ${d.tiers.at(-1).name}` : ''}`, bldIcon(d.building), d.cost, p === null, needs);
        if (locked) btn.classList.add('locked');
        return tip(btn, d.tiers[0].name, `Shoots the nearest enemy soldier within ${st.range} tiles: ${atk} attack${d.arrows > 1 ? `, ${d.arrows} arrows at a time` : ''}, every ${st.reload}s. ${Math.round(st.hp)} HP.`,
          d.tiers.length > 1 ? `Upgrades in place: ${d.tiers.map((t) => t.name).join(' → ')}` : '',
          `Takes ${d.build}s to build, and is weak until it's finished.`, locked ? `Needs the ${AGES[d.age].name}.` : needs ? `${needs}.` : '');
      })));
    }
    const mp = world.price(ME, 'build', 'market');
    out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(84), alt: '' }), 'Economy'));
    const mkt = option('market', 'Market', `+${MARKET.income} gold every 4s · ${world.count(ME, 'market')}/${MARKET.max} built`, bldIcon(84), MARKET.cost, mp === null, s.age < MARKET.age ? AGES[MARKET.age].name : null);
    if (s.age < MARKET.age) mkt.classList.add('locked');
    tip(mkt, 'Market', `Earns you ${MARKET.income} more gold every 4 seconds once it's built, on top of your income. Up to ${MARKET.max}.`,
      'Selling it later gives back part of the price.', s.age < MARKET.age ? `Needs the ${AGES[MARKET.age].name}.` : '');
    out.push(el('div', { className: 'sg-opts' }, mkt));
    return out;
  }

  /** A building's menu: its upgrade steps (tap the next one to buy it), pause, sell. */
  function buildingView(id) {
    const b = world.building(id);
    if (!b || b.owner !== ME) { setTimeout(() => setMode({ kind: 'hint' })); return []; }
    const s = world.sides[ME];
    const sellBtn = tip(el('button', { type: 'button', className: 'sg-sell', onclick: () => { act('sell', { id: b.id }); setMode({ kind: 'hint' }); } },
      b.done ? 'Sell for ' : 'Cancel for ', goldImg(), String(world.sellValue(b.id))), b.done ? 'Sell' : 'Cancel',
    `Gives back ${world.sellValue(b.id)} gold (half of what you put in) and clears the spot.${b.done && !b.def && b.line !== 'market' ? ' Units already out keep fighting.' : ''}`);
    const building = b.done ? null : el('p', { className: 'sg-note sg-building-up', textContent: `Building… ${Math.max(0, Math.ceil((b.buildEnd - world.t) / GAME_SPEED))}s left. It's weak until it's finished.` });
    if (b.line === 'market') {
      return [closeRow('Market'), building, el('p', { className: 'sg-note', textContent: `Adds ${MARKET.income} gold every 4 seconds.` }), el('div', { className: 'sg-acts' }, sellBtn)];
    }
    const line = world.line(ME, b.line);
    const cur = line.tiers[b.tier];
    const upPrice = world.price(ME, 'upgrade', b.id);
    // The steps: done ones ticked, this one framed, the next one a button with its price
    const steps = el('div', { className: 'sg-steps' }, line.tiers.map((t, i) => {
      const icon = b.def ? bldIcon(t.building) : unitIcon(t.unitId, t.picture);
      if (i !== b.tier + 1) {
        return el('span', { className: `sg-step${i === b.tier ? ' now' : i < b.tier ? ' done' : ''}` },
          el('img', { src: icon, alt: '' }), el('small', { textContent: i > b.tier && t.age > s.age ? AGES[t.age].name : t.name }));
      }
      const locked = t.age > s.age;
      const btn = priced(el('button', { type: 'button', className: `sg-step sg-step-buy${locked ? ' locked' : ''}`, onclick: () => { act('upgrade', { id: b.id }); refresh(true); } },
        el('img', { src: icon, alt: '' }), el('small', { textContent: locked ? AGES[t.age].name : t.name }), priceTag(t.upgrade)), t.upgrade, upPrice === null);
      if (b.def) {
        const st = world.defenceStats(line, i);
        tip(btn, `Upgrade to ${t.name}`, `${Math.round(st.hp)} HP, ${st.attacks.get(3) ?? 0} attack (now ${Math.round(b.maxHp)} HP, ${b.f.attacks.get(3) ?? 0} attack).`, 'Upgrades in place.', locked ? `Needs the ${AGES[t.age].name}.` : !b.done ? 'Once it\'s built.' : '');
      } else {
        const f = kit.fighter(b.line, b.tier, s.researched, s.researchKey, s.age);
        const f2 = kit.fighter(b.line, i, s.researched, s.researchKey, Math.max(s.age, t.age));
        tip(btn, `Upgrade to ${t.name}`, `Now: ${statLine(f)}`, `After: ${statLine(f2)}`,
          `This building trains ${t.name}s from then on (1 every ${Math.round(t.every / GAME_SPEED)}s). Units already on the field keep their old stats.`,
          locked ? `Needs the ${AGES[t.age].name}.` : !b.done ? 'Once it\'s built.' : '');
      }
      return btn;
    }));
    let info;
    if (b.def) {
      const st = b.f;
      info = `${Math.floor(b.hp)}/${Math.floor(b.maxHp)} HP · ${st.attacks.get(3) ?? 0} attack${(st.arrows || 1) > 1 ? ` ×${st.arrows}` : ''} · range ${st.range} · every ${st.reload}s`;
    } else {
      const f = kit.fighter(b.line, b.tier, s.researched, s.researchKey, s.age);
      info = `${statLine(f)} · 1 every ${Math.round(b.every / GAME_SPEED)}s`;
    }
    const paused = b.hold || s.stopAll;
    const holdBtn = b.def ? null : tip(el('button', { type: 'button', className: `sg-hold${paused ? ' on' : ''}`, onclick: () => { if (s.stopAll && !b.hold) act('go'); else act('hold', { id: b.id }); refresh(true); },
      textContent: s.stopAll ? '▶ Resume all (GO)' : paused ? (b.waiting ? '▶ Release now' : '▶ Resume') : '❚❚ Pause' }),
    'Pause', 'Keeps this building\'s next unit inside once it\'s ready. Resume (or GO) sends it out. The red hand pauses all of them.');
    return [
      closeRow(`${BUILDING_NAMES[b.building] || BUILDING_NAMES[line.building] || cur.name}: ${cur.name}`),
      building,
      steps,
      el('p', { className: 'sg-note', textContent: info }),
      el('div', { className: 'sg-acts' }, holdBtn, sellBtn),
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
  // Advancing to the next age: how far along and real seconds left.
  const agingState = () => {
    const a = world.sides[ME].aging;
    if (!a) return null;
    const left = Math.max(0, a.endsAt - world.t);
    return { a, frac: 1 - left / a.time, secs: Math.ceil(left / GAME_SPEED) };
  };
  function agingBar() {
    const st = agingState();
    if (!st) return null;
    return el('button', { type: 'button', className: 'sg-research sg-aging', onclick: () => setMode({ kind: 'age' }) },
      el('img', { src: ageIcon(st.a.to), alt: '' }),
      el('span', { className: 'sg-rname' }, el('small', { textContent: 'Advancing to' }), el('b', { textContent: AGES[st.a.to].name })),
      el('span', { className: 'sg-rleft sg-aleft', textContent: `${st.secs}s` }),
      el('div', { className: 'sg-rbar sg-abar' }, el('i', { style: `width:${Math.round(st.frac * 100)}%` })));
  }
  /** The ages: where you are, what the next one costs and opens up. */
  function ageView() {
    const s = world.sides[ME];
    const out = [closeRow('Ages')];
    const unlocks = (age) => {
      const units = kit.lines.filter((l) => l.age === age).map((l) => l.tiers[0].name);
      const ups = kit.lines.flatMap((l) => l.tiers.filter((t, i) => i > 0 && t.age === age).map((t) => t.name));
      const techs = kit.techs.filter((t) => t.age === age).length;
      return [units.length ? `New: ${units.join(', ')}` : '', ups.length ? `Upgrades: ${ups.join(', ')}` : '', techs ? `${techs} Armory tech${techs > 1 ? 's' : ''}` : '', age === MARKET.age ? 'Markets' : '']
        .filter(Boolean).join(' · ');
    };
    for (let age = 1; age <= 4; age++) {
      const done = age <= s.age;
      const next = age === s.age + 1;
      const going = s.aging?.to === age;
      const p = next ? world.price(ME, 'age') : null;
      const a = AGES[age];
      const card = el('button', { type: 'button', className: `sg-opt sg-age-opt${done ? ' done' : ''}${going ? ' researching' : ''}`,
        onclick: () => { if (next) { act('age'); refresh(true); } } },
        going ? el('i', { className: 'sg-opt-fill sg-age-fill', style: `width:${Math.round((agingState()?.frac || 0) * 100)}%` }) : null,
        el('img', { className: 'sg-opt-ic', src: ageIcon(age), alt: '' }),
        el('span', { className: 'sg-opt-text' }, el('b', { textContent: a.name }),
          el('small', { textContent: done ? (age === s.age ? 'Your age now' : 'Done') : going ? 'Advancing…' : `${Math.round(a.time / GAME_SPEED)}s · ${unlocks(age)}` })),
        done ? el('span', { className: 'sg-tick', textContent: '✓' }) : a.cost ? priceTag(a.cost) : null);
      tip(card, a.name, unlocks(age) || 'Where everyone starts.', age > 1 ? `Takes ${Math.round(a.time / GAME_SPEED)}s; you can keep building meanwhile. Everyone is told when you get there.` : '');
      out.push(done || !next ? Object.assign(card, { disabled: !going && !done }) : priced(card, a.cost, p === null));
    }
    out.push(el('p', { className: 'sg-note', textContent: 'Everyone sees when a player advances. Ages are separate from the Armory, so you can do both at once.' }));
    return out;
  }
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
      // Each Blacksmith line takes one slot: Bodkin Arrow replaces Fletching once that's done, and so on.
      const list = kit.techs.filter((t) => t.group === group && (!t.track
        || t === (kit.techs.find((x) => x.track === t.track && !s.researched.has(x.id)) || kit.techs.filter((x) => x.track === t.track).at(-1))));
      if (!list.length) continue;
      out.push(el('h4', { className: 'sg-group', textContent: group }));
      out.push(el('div', { className: 'sg-opts' }, list.map((t) => {
        const done = s.researched.has(t.id);
        const p = world.price(ME, 'research', t.id);
        const ageLock = !done && t.age > s.age;
        const blocked = (t.after && !s.researched.has(t.after)) || ageLock;
        const now = s.research?.id === t.id;
        const note = done ? 'Researched' : now ? 'Researching…' : ageLock ? AGES[t.age].name : blocked ? `After ${kit.techs.find((x) => x.id === t.after)?.name}` : `${Math.round(t.time / GAME_SPEED)}s to research`;
        return priced(tip(el('button', { type: 'button', className: `sg-opt${done ? ' done' : ''}${now ? ' researching' : ''}${ageLock ? ' locked' : ''}`,
          onclick: () => { act('research', { id: t.id }); refresh(true); } },
          now ? el('i', { className: 'sg-opt-fill', style: `width:${Math.round((researchState()?.frac || 0) * 100)}%` }) : null,
          el('img', { className: 'sg-opt-ic', src: t.picture !== undefined ? imageUrl('Tech', t.picture) : '', alt: '' }),
          el('span', { className: 'sg-opt-text' }, el('b', { textContent: t.name }), el('small', { textContent: note })),
          done ? el('span', { className: 'sg-tick', textContent: '✓' }) : priceTag(t.cost)), t.name, t.help,
          'Reaches every unit of yours it applies to, including those already fighting.',
          `${Math.round(t.time / GAME_SPEED)}s to research; one Armory tech at a time.`, ageLock ? `Needs the ${AGES[t.age].name}.` : ''), t.cost, done || p === null);
      })));
    }
    return out;
  }

  // ---------- Chat ----------
  const say = (text) => { const t = String(text || '').trim(); if (t) act('chat', { text: t }); };
  const chatInput = el('input', { type: 'text', className: 'sg-chat-input', maxLength: 80, placeholder: 'Message everyone', enterKeyHint: 'send', autocomplete: 'off' });
  const chatForm = el('form', { className: 'sg-chat-form', onsubmit: (e) => { e.preventDefault(); say(chatInput.value); chatInput.value = ''; } },
    chatInput, el('button', { type: 'submit', className: 'sg-btn', textContent: 'Send' }));
  const chatLog = el('div', { className: 'sg-chat-log' }, el('p', { className: 'sg-note', textContent: 'Nothing said yet.' }));
  const chatEmotes = el('div', { className: 'sg-emotes' }, [...EMOTES, ...PHRASES].map((t) => el('button', { type: 'button', className: `sg-emote${EMOTES.includes(t) ? ' big' : ''}`, textContent: t, onclick: () => say(t) })));
  let chatN = 0;
  const who = (p) => (p === ME ? 'You' : players[p]?.name || 'Player');
  function showChat(e) {
    const colour = players[e.owner]?.colour || '#ffe9a8';
    const big = EMOTES.includes(e.text);
    // In the panel's log
    if (chatLog.querySelector('.sg-note')) chatLog.replaceChildren();
    chatLog.append(el('p', {}, el('b', { style: `color:${colour}`, textContent: who(e.owner) }), ' ', e.text));
    while (chatLog.children.length > 40) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
    // And over the field for a few seconds
    const bubble = el('div', { className: `sg-bubble${big ? ' big' : ''}`, style: `--pc:${colour}` }, el('b', { textContent: who(e.owner) }), el('span', { textContent: e.text }));
    chatFeed.append(bubble);
    while (chatFeed.children.length > 4) chatFeed.firstChild.remove();
    setTimeout(() => bubble.remove(), 6500);
    if (e.owner !== ME && pmode.kind !== 'chat') chatBtn.querySelector('.sg-chat-dot').hidden = false;
  }
  function chatView() {
    return [closeRow('Chat: everyone sees it'), chatEmotes, chatForm, chatLog];
  }

  // ---------- Civs: strengths and weaknesses in Wonder Wars ----------
  const summaries = new Map();
  function civView(p) {
    const pl = players[p];
    const k = kits[p];
    if (!summaries.has(p)) summaries.set(p, { sum: k.summary(), help: parseCivHelp(k.help) });
    const { sum, help } = summaries.get(p);
    const list = (title, items, cls = '') => (items.length ? [el('h4', { className: 'sg-group', textContent: title }),
      el('ul', { className: `sg-civ-list ${cls}` }, items.map((i) => (typeof i === 'string' ? el('li', { textContent: i }) : i)))] : []);
    const tagged = (line, here) => el('li', { className: here ? '' : 'off' }, line, el('small', { className: 'sg-tag', textContent: here ? 'counts here' : 'not in Wonder Wars' }));
    const utsHere = new Set(k.techs.filter((t) => t.group === 'Unique techs').map((t) => t.name.toLowerCase()));
    const out = [
      closeRow(p === ME ? `Your civ: ${pl.civName}` : pl.name && pl.name !== pl.civName ? `${pl.name}: ${pl.civName}` : pl.civName),
      players.length > 1 ? el('div', { className: 'sg-civ-chips' }, players.map((q, i) => el('button', {
        type: 'button', className: `sg-civ-chip${i === p ? ' on' : ''}`, style: `--pc:${q.colour}`, onclick: () => setMode({ kind: 'civ', who: i }),
      }, el('img', { src: q.civ ? civIconUrl(q.civ) : '', alt: '' }), el('span', { textContent: i === ME ? 'You' : q.name })))) : null,
      help.tagline ? el('p', { className: 'sg-civ-tag', textContent: help.tagline }) : null,
      ...list('Strong at', sum.strengths, 'good'),
      ...list('Weak at', sum.weaknesses, 'bad'),
      ...list('Civ bonuses', help.bonuses.map((b) => tagged(b, countsHere(b)))),
      ...list('Unique techs', help.uts.map((u) => tagged(u, [...utsHere].some((n) => u.toLowerCase().startsWith(n))))),
      ...list('Team bonus', help.team.map((b) => tagged(b, countsHere(b)))),
      el('p', { className: 'sg-note', textContent: 'Bonus text is the game\'s own. "Counts here" is sorted by what each bonus mentions, so treat it as a guide.' }),
    ];
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
    stopBtn.classList.toggle('on', Boolean(s.stopAll));
    stopBtn.setAttribute('aria-pressed', s.stopAll ? 'true' : 'false');
    armoryBtn.querySelector('.sg-armory-dot').hidden = !s.research;
    // Age button: your age, and a ring filling while you advance
    const shownAge = s.aging?.to ?? s.age;
    if (ageBtn.dataset.age !== `${shownAge}-${s.age}`) {
      ageBtn.dataset.age = `${shownAge}-${s.age}`;
      ageBtn.querySelector('img').src = ageIcon(shownAge);
      ageBtn.querySelector('.sg-age-name').textContent = AGES[s.age].name.replace(' Age', '');
    }
    ageBtn.classList.toggle('aging', Boolean(s.aging));
    ageBtn.classList.toggle('can', !s.aging && s.age < 4 && s.gold >= AGES[s.age + 1].cost);
    ageBtn.style.setProperty('--p', s.aging ? String(agingState()?.frac ?? 0) : '0');
    // Rebuild the dock only when something it shows has changed.
    const b = pmode.kind === 'building' ? world.building(pmode.id) : null;
    // Chat and civ panels don't depend on the game's state: left alone so typing isn't interrupted.
    const key = pmode.kind === 'chat' || pmode.kind === 'civ' ? [pmode.kind, pmode.who, s.research?.id, s.aging?.to].join('|')
      : [pmode.kind, pmode.at, pmode.key, pmode.id, world.buildings(ME).map((x) => `${x.id}${x.done ? '' : '…'}`).join(), s.markets, s.researched.size, s.research?.id, s.age, s.aging?.to,
        b ? `${b.tier}${b.hold}${b.waiting}${s.stopAll}${b.done ? '' : Math.ceil((b.buildEnd - world.t) / GAME_SPEED)}` : '', held.length, s.stopAll, world.winner].join('|');
    if (!force && key === lastKey) {
      // Same content: just keep prices and the research bar current.
      for (const btn of dock.querySelectorAll('[data-price]')) btn.disabled = btn.dataset.blocked === '1' || s.gold < Number(btn.dataset.price);
      const ag = agingState();
      if (ag) {
        const w2 = `${Math.round(ag.frac * 100)}%`;
        for (const bar of dock.querySelectorAll('.sg-abar i, .sg-age-fill')) bar.style.width = w2;
        const left = dock.querySelector('.sg-aleft');
        if (left) left.textContent = `${ag.secs}s`;
      }
      const st = researchState();
      if (st) {
        const w = `${Math.round(st.frac * 100)}%`;
        for (const bar of dock.querySelectorAll('.sg-rbar:not(.sg-abar) i, .sg-opt-fill:not(.sg-age-fill)')) bar.style.width = w;
        const left = dock.querySelector('.sg-rleft:not(.sg-aleft)');
        if (left) left.textContent = `${st.secs}s`;
      }
      return;
    }
    lastKey = key;
    const views = { build: () => buildView(pmode.at, pmode.key), building: () => buildingView(pmode.id), armory: armoryView, age: ageView, chat: chatView, civ: () => civView(pmode.who), hint: hintView };
    const content = (views[pmode.kind] || hintView)();
    // Same panel: keep where it was scrolled to; another panel starts at its beginning
    const panel = [pmode.kind, pmode.at, pmode.id, pmode.who].join('|');
    const same = panel === dock.dataset.panel;
    dock.dataset.panel = panel;
    const top = same ? dock.scrollTop : 0;
    const left = same ? dock.scrollLeft : 0;
    dock.replaceChildren(...[agingBar(), researchBar(), ...content].flat().filter(Boolean));
    dock.scrollTop = top;
    dock.scrollLeft = left;
  }

  // ---------- Loop ----------
  let running = true;
  const speed = 1;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let wake = null;
  let hudAt = 0;
  const seenAges = new Set();
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
      incomeTxt.classList.toggle('bonus', world.minesOf(ME) > 0);
      const left = world.sides[ME].blasts;
      blastBtn.disabled = left <= 0;
      blastBtn.querySelector('.sg-blast-n').textContent = String(left);
      const ot = world.overtime();
      // "Rob advanced to the Castle Age", for everyone, as in the game
      for (const e of world.events) {
        if (e.type === 'chat' && e.n > chatN) { chatN = e.n; showChat(e); continue; }
        if (e.type !== 'aged') continue;
        const k = `${e.owner}-${e.age}`;
        if (seenAges.has(k)) continue;
        seenAges.add(k);
        const who = e.owner === ME ? 'You' : players[e.owner].name;
        const n = el('div', { className: 'sg-notice', style: `--pc:${players[e.owner].colour}` },
          el('img', { src: ageIcon(e.age), alt: '' }), `${who} advanced to the ${AGES[e.age].name}`);
        notices.append(n);
        setTimeout(() => n.remove(), 4500);
      }
      if (ot > 1 && world.winner === null) { banner.hidden = false; banner.textContent = `Overtime: Wonders crumbling, buildings take +${Math.round((ot - 1) * 100)}% damage`; }
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
  stopBtn.addEventListener('click', () => { act('stop'); navigator.vibrate?.(25); refresh(true); });
  const onVis = () => { if (document.hidden && running && world.winner === null) setRunning(false); };
  document.addEventListener('visibilitychange', onVis);

  if (client) pauseBtn.hidden = true;
  function close() {
    view.dispose();
    cancelAnimationFrame(raf);
    for (const off of offs) off();
    if (net) net.onLeave?.();
    document.removeEventListener('visibilitychange', onVis);
    wide.removeEventListener('change', onTurn);
    setImmersive(false);
    setOrientation('auto');   // the rest of the app follows the phone
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
      el('p', { textContent: `${won ? 'Your team brought down the enemy Wonder' : 'The enemy brought down your Wonder'} after ${fmt(world.t / GAME_SPEED)} (${fmt(world.t)} game time).` }),
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
