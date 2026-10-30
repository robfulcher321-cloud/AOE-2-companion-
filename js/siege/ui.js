// AOSiege tab: pick civs and difficulty, then play against the computer.

import { loadCore, loadTree, imageUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { loadPack } from '../duel/spritepack.js';
import { buildKit, MARKET, TIER_NAMES } from './kit.js';
import { World, Computer, DT, PLOTS, OVERTIME, START_GOLD } from './world.js';
import { SiegeView } from './view.js';

const GAME_SPEED = 1.7;
const UNIQUE_TIERS = ['Castle', 'Elite', 'Elite + unique techs'];   // game seconds per real second at Normal speed
const LEVELS = { easy: { income: 0.8, label: 'Easy' }, normal: { income: 1, label: 'Normal' }, hard: { income: 1.25, label: 'Hard' } };

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
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

export async function initSiege(root) {
  const { data, strings } = await loadCore();
  const civs = civOptions(data, strings);
  const mine = new Picker({ label: 'Your civilisation', onChange: (c) => store.set('sg-civ', c) });
  mine.setOptions(civs, data.civs[store.get('sg-civ')] ? store.get('sg-civ') : 'Franks');
  const theirs = new Picker({ label: 'Computer\'s civilisation', onChange: (c) => { store.set('sg-ai', c); randomBox.checked = false; } });
  theirs.setOptions(civs, data.civs[store.get('sg-ai')] ? store.get('sg-ai') : 'Britons');
  const randomBox = el('input', { type: 'checkbox', checked: store.get('sg-random') !== '0' });
  randomBox.addEventListener('change', () => store.set('sg-random', randomBox.checked ? '1' : '0'));
  let level = LEVELS[store.get('sg-level')] ? store.get('sg-level') : 'normal';
  const levelBtns = Object.entries(LEVELS).map(([k, v]) => {
    const b = el('button', { type: 'button', textContent: v.label });
    b.setAttribute('aria-pressed', String(k === level));
    b.addEventListener('click', () => { level = k; store.set('sg-level', k); for (const o of levelBtns) o.setAttribute('aria-pressed', String(o === b)); });
    return b;
  });
  const start = el('button', { type: 'button', className: 'fight', textContent: 'Start game' });
  const status = el('p', { className: 'status', hidden: true });
  root.replaceChildren(
    el('div', { className: 'field' }, el('span', { textContent: 'Your civilisation' }), mine.button),
    el('div', { className: 'field' }, el('span', { textContent: 'Computer' }), theirs.button),
    el('label', { className: 'toggle' }, randomBox, el('span', { textContent: 'Random civ for the computer' })),
    el('div', { className: 'field' }, el('span', { textContent: 'Difficulty' }), el('div', { className: 'sg-levels' }, levelBtns)),
    start, status,
    el('details', { className: 'sg-how', open: !store.get('sg-played') },
      el('summary', { textContent: 'How to play' }),
      el('ul', {},
        el('li', { textContent: 'Each side has a Castle at the end of one lane. Destroy the enemy Castle to win.' }),
        el('li', { textContent: `You don't control units. Spend gold on buildings (up to ${PLOTS}); each one trains its unit on a timer, and units march down the lane and fight on their own.` }),
        el('li', { textContent: 'Upgrade a unit line to its Castle and Imperial Age versions. Upgrades reach units already on the field.' }),
        el('li', { textContent: 'Gold comes in every few seconds; Markets add more, and kills pay a bounty.' }),
        el('li', { textContent: 'Blacksmith upgrades raise attack and armour for your whole army.' }),
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
      const aiCiv = randomBox.checked ? keys[Math.floor(Math.random() * keys.length)] : theirs.value;
      const kits = await Promise.all([mine.value, aiCiv].map(async (civ) => buildKit({ data, strings, tree: await loadTree(civ), civ })));
      const assets = await loadAssets(kits);
      store.set('sg-played', '1');
      status.hidden = true;
      openGame({ data, strings, kits, assets, level, civNames: [mine.value, aiCiv].map((c) => nameText(strings[data.civs[c].name_string_id] || c)) });
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
      for (let t = 0; t < 3; t++) {
        const f = kit.fighter(line.key, t);
        unitIds.add(f.unitId);
        if (f.projectile?.sprite) shotNames.add(f.projectile.sprite);
        const pic = line.tiers[t].picture;
        if (pic !== undefined && !unitIcons[f.unitId]) jobs.push(loadImg(imageUrl('Unit', pic)).then((img) => { unitIcons[f.unitId] = img; }));
      }
    }
    for (const id of [82, 84, ...kit.lines.map((l) => l.building)]) {
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

function openGame({ data, kits, assets, level, civNames }) {
  const seed = Math.floor(Math.random() * 1e9);
  const world = new World(kits, data, { seed, income: [1, LEVELS[level].income] });
  const ai = new Computer(world, 1, { level });
  const ME = 0;

  // ---------- Layout ----------
  const goldNum = el('b', { className: 'sg-gold-num', textContent: String(START_GOLD) });
  const incomeTxt = el('small', { className: 'sg-income' });
  const clock = el('span', { className: 'sg-clock', textContent: '0:00' });
  const castleBar = (side) => {
    const fill = el('i');
    const wrap = el('div', { className: `sg-castle sg-castle-${side ? 'red' : 'blue'}` }, el('span', { textContent: side ? civNames[1] : 'You' }), el('div', { className: 'sg-cbar' }, fill));
    return { wrap, fill };
  };
  const castles = [castleBar(0), castleBar(1)];
  const pauseBtn = el('button', { type: 'button', className: 'sg-btn', textContent: 'Pause' });
  const speedBtn = el('button', { type: 'button', className: 'sg-btn', textContent: '1×' });
  const closeBtn = el('button', { type: 'button', className: 'sg-btn sg-close', textContent: '×', 'aria-label': 'Quit game' });
  const canvas = el('canvas', { className: 'sg-canvas', 'aria-label': 'Battlefield' });
  const mini = el('canvas', { className: 'sg-mini', 'aria-label': 'Minimap: tap to look there' });
  const followBtn = el('button', { type: 'button', className: 'sg-follow', textContent: 'Follow fight', hidden: true });
  const banner = el('div', { className: 'sg-banner', hidden: true });
  const panel = el('section', { className: 'sg-panel' });
  const plotsTxt = el('span', { className: 'sg-plots' });

  const screen = el('div', { className: 'sg-run', role: 'dialog', 'aria-label': 'AOSiege game' },
    el('header', { className: 'sg-head' },
      el('div', { className: 'sg-gold' }, el('img', { src: 'img/res/gold.webp', alt: 'Gold', width: 28, height: 28 }), goldNum, incomeTxt),
      clock, speedBtn, pauseBtn, closeBtn,
      el('div', { className: 'sg-castles' }, castles[0].wrap, castles[1].wrap)),
    el('div', { className: 'sg-field' }, canvas, followBtn, banner),
    mini,
    panel);
  document.body.append(screen);
  screen.world = world; // handy when debugging in the browser console
  document.body.classList.add('sg-open');

  const view = new SiegeView(canvas, mini);
  view.setup(world, { ...assets, mySide: ME });
  view.resize();
  followBtn.addEventListener('click', () => { view.follow = true; });

  // ---------- Build panel ----------
  const cards = [];
  const kit = kits[ME];
  const iconOf = (line, tier) => {
    const pic = line.tiers[tier].picture;
    return pic !== undefined ? imageUrl('Unit', pic) : '';
  };
  const buyBtn = (label, onClick) => {
    const b = el('button', { type: 'button', className: 'sg-buy' }, el('span', { className: 'sg-buy-label', textContent: label }),
      el('span', { className: 'sg-price' }, el('img', { src: 'img/res/gold.webp', alt: '', width: 16, height: 16 }), el('b')));
    b.addEventListener('click', onClick);
    return b;
  };
  for (const line of kit.lines) {
    const img = el('img', { className: 'sg-card-ic', alt: '', src: iconOf(line, 0) });
    const name = el('b', { className: 'sg-card-name' });
    const meta = el('small', { className: 'sg-card-meta' });
    const next = el('small', { className: 'sg-card-next' });
    const build = buyBtn('Build', () => { world.buy(ME, 'build', line.key); refresh(true); });
    const up = buyBtn('Upgrade', () => { world.buy(ME, 'upgrade', line.key); refresh(true); });
    const sell = el('button', { type: 'button', className: 'sg-sell', textContent: 'Sell', title: 'Sell one building for half its price' });
    sell.addEventListener('click', () => {
      const mine = world.structures.filter((b) => b.side === ME && b.line === line.key && b.hp > 0).sort((a, b) => b.builtAt - a.builtAt)[0];
      if (mine) world.sell(ME, mine.id);
      refresh(true);
    });
    const card = el('div', { className: `sg-card${line.unique ? ' sg-card-unique' : ''}` },
      el('div', { className: 'sg-card-top' }, img, el('div', {}, name, meta, next), sell),
      el('div', { className: 'sg-card-acts' }, build, up));
    cards.push({ line, card, img, name, meta, next, build, up, sell, kind: 'line' });
  }
  const market = (() => {
    const meta = el('small', { className: 'sg-card-meta' });
    const build = buyBtn('Build', () => { world.buy(ME, 'market'); refresh(true); });
    const pic = kit.buildingPicture(84);
    const card = el('div', { className: 'sg-card' },
      el('div', { className: 'sg-card-top' }, el('img', { className: 'sg-card-ic', alt: '', src: pic !== undefined ? imageUrl('Building', pic) : '' }),
        el('div', {}, el('b', { className: 'sg-card-name', textContent: 'Market' }), meta)),
      el('div', { className: 'sg-card-acts' }, build));
    return { card, meta, build, kind: 'market' };
  })();
  const smith = ['attack', 'armour'].map((k) => {
    const meta = el('small', { className: 'sg-card-meta' });
    const build = buyBtn(k === 'attack' ? 'Attack +1' : 'Armour +1', () => { world.buy(ME, k); refresh(true); });
    const pic = kit.buildingPicture(103);
    const card = el('div', { className: 'sg-card' },
      el('div', { className: 'sg-card-top' }, el('img', { className: 'sg-card-ic', alt: '', src: pic !== undefined ? imageUrl('Building', pic) : '' }),
        el('div', {}, el('b', { className: 'sg-card-name', textContent: k === 'attack' ? 'Blacksmith: attack' : 'Blacksmith: armour' }), meta)),
      el('div', { className: 'sg-card-acts' }, build));
    return { card, meta, build, key: k };
  });
  panel.append(
    el('div', { className: 'sg-panel-head' }, el('b', { textContent: 'Build and upgrade' }), plotsTxt),
    el('div', { className: 'sg-cards' }, cards.map((c) => c.card), market.card, smith.map((s) => s.card)));

  const setPrice = (btn, price) => {
    btn.hidden = price === null;
    if (price === null) return;
    btn.querySelector('b').textContent = String(price);
    btn.disabled = world.sides[ME].gold < price;
  };
  let lastKey = '';
  function refresh(force = false) {
    const s = world.sides[ME];
    const key = `${Math.floor(s.gold)}|${world.structures.length}|${JSON.stringify(s.tiers)}|${s.markets}|${s.smith.attack}${s.smith.armour}|${world.winner}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    goldNum.textContent = String(Math.floor(s.gold));
    incomeTxt.textContent = `+${world.income(ME)} every 4s`;
    plotsTxt.textContent = `${s.plots.filter(Boolean).length}/${PLOTS} plots used`;
    for (const c of cards) {
      const tier = world.tier(ME, c.line.key);
      const n = world.count(ME, c.line.key);
      const unit = c.line.tiers[tier];
      c.name.textContent = unit.name;
      c.img.src = iconOf(c.line, tier);
      c.meta.textContent = `${(c.line.unique ? UNIQUE_TIERS : TIER_NAMES)[tier]} · ${n ? `${n} built` : 'none built'} · 1 per ${Math.round(c.line.every[tier] / GAME_SPEED)}s`;
      setPrice(c.build, world.price(ME, 'build', c.line.key));
      const upPrice = world.price(ME, 'upgrade', c.line.key);
      setPrice(c.up, upPrice);
      c.next.textContent = upPrice !== null ? `Upgrade to ${c.line.tiers[tier + 1].name}` : 'Fully upgraded';
      c.sell.hidden = n === 0;
      c.card.classList.toggle('owned', n > 0);
    }
    market.meta.textContent = `${s.markets}/${MARKET.max} · +${MARKET.income} gold per tick each`;
    setPrice(market.build, world.price(ME, 'market'));
    for (const sm of smith) {
      sm.meta.textContent = `Level ${s.smith[sm.key]}/3, all units`;
      setPrice(sm.build, world.price(ME, sm.key));
    }
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

  const frame = (now) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (running && world.winner === null) {
      acc += dt * GAME_SPEED * speed;
      let n = 0;
      while (acc >= DT && n < 40) { ai.think(); world.step(); acc -= DT; n++; }
      if (n === 40) acc = 0;
    }
    view.draw(running ? Math.min(1, acc / DT) : 1);
    if (now - hudAt > 120) {
      hudAt = now;
      clock.textContent = fmt(world.t / GAME_SPEED);
      for (const s of [0, 1]) {
        const c = world.sides[s].castle;
        castles[s].fill.style.width = `${Math.max(0, (c.hp / c.maxHp) * 100)}%`;
      }
      followBtn.hidden = view.follow;
      const ot = world.overtime();
      if (ot > 1 && world.winner === null) { banner.hidden = false; banner.textContent = `Overtime: castles crumbling, buildings take +${Math.round((ot - 1) * 100)}% damage`; }
      refresh();
    }
    if (world.winner !== null && !ended) { ended = true; setTimeout(showEnd, 1200); }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const setRunning = (on) => {
    running = on;
    pauseBtn.textContent = on ? 'Pause' : 'Resume';
    screen.classList.toggle('paused', !on);
    if (on) lockScreen(); else { wake?.release?.(); wake = null; }
  };
  pauseBtn.addEventListener('click', () => setRunning(!running));
  speedBtn.addEventListener('click', () => { speed = speed === 1 ? 2 : 1; speedBtn.textContent = `${speed}×`; });
  const onVis = () => { if (document.hidden && running && world.winner === null) setRunning(false); };
  document.addEventListener('visibilitychange', onVis);

  function close() {
    cancelAnimationFrame(raf);
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
    const won = world.winner === ME;
    const S = world.sides;
    const row = (label, f) => el('tr', {}, el('th', { scope: 'row', textContent: label }), el('td', { textContent: f(0) }), el('td', { textContent: f(1) }));
    const box = el('div', { className: `sg-end ${won ? 'won' : 'lost'}` },
      el('h2', { textContent: won ? 'Victory!' : 'Defeat' }),
      el('p', { textContent: `${won ? `You knocked down the ${civNames[1]} castle` : `The ${civNames[1]} took your castle`} after ${fmt(world.t / GAME_SPEED)} (${fmt(world.t)} game time).` }),
      el('table', { className: 'result-table' },
        el('thead', {}, el('tr', {}, el('th'), el('th', { textContent: `You (${civNames[0]})` }), el('th', { textContent: civNames[1] }))),
        el('tbody', {},
          row('Units trained', (i) => S[i].stats.trained),
          row('Enemies killed', (i) => S[i].stats.kills),
          row('Gold earned', (i) => Math.round(S[i].stats.earned)),
          row('Gold spent', (i) => Math.round(S[i].stats.spent)))),
      el('div', { className: 'sg-end-acts' },
        el('button', { type: 'button', className: 'fight', textContent: 'Play again', onclick: () => { close(); openGame({ data, kits, assets, level, civNames }); } }),
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Back', onclick: close })));
    screen.append(box);
  }
  refresh(true);
}
