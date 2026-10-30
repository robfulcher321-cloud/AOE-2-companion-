// AOSiege tab: pick civs and difficulty, then play against the computer.

import { loadCore, loadTree, imageUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { loadPack } from '../duel/spritepack.js';
import { buildKit, MARKET, BUILDING_NAMES } from './kit.js';
import { World, Computer, DT, PLOTS, OVERTIME, START_GOLD } from './world.js';
import { SiegeView } from './view.js';

const GAME_SPEED = 1.7;
// game seconds per real second at Normal speed
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
        el('li', { textContent: `You don't control units. Tap an empty plot (up to ${PLOTS}) to build: each building trains one unit line on a timer, and the units march down the lane and fight on their own. Your civ gets every unit its Barracks, Archery Range, Stable and Castle can train.` }),
        el('li', { textContent: 'Press and hold a building to upgrade it to the next unit in its line (Militia → Man-at-Arms → … → Champion), or to sell it for half of what you put in. Each building upgrades on its own: lots of cheap units, or fewer strong ones?' }),
        el('li', { textContent: 'Tap a building to hold it: its bar turns blue and the unit waits when ready. Tap GO to send every waiting unit out at once.' }),
        el('li', { textContent: 'The Armory (anvil, bottom left) has Blacksmith upgrades, Ballistics, Chemistry, Bloodlines and your civ\'s unique techs. One at a time; each one reaches all your units, even those already fighting.' }),
        el('li', { textContent: 'Gold comes in every few seconds; Markets add more, and kills pay a bounty.' }),
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

function openGame({ data, kits, assets, level, civNames }) {
  const seed = Math.floor(Math.random() * 1e9);
  const world = new World(kits, data, { seed, income: [1, LEVELS[level].income] });
  const ai = new Computer(world, 1, { level });
  const ME = 0;
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
    const wrap = el('div', { className: `sg-castle sg-castle-${side ? 'red' : 'blue'}` }, el('span', { textContent: side ? civNames[1] : 'You' }), el('div', { className: 'sg-cbar' }, fill));
    return { wrap, fill };
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
  const dock = el('section', { className: 'sg-dock' });

  const screen = el('div', { className: 'sg-run', role: 'dialog', 'aria-label': 'AOSiege game' },
    el('header', { className: 'sg-head' },
      el('div', { className: 'sg-gold' }, el('img', { src: 'img/res/gold.webp', alt: 'Gold', width: 28, height: 28 }), goldNum, incomeTxt),
      clock, goBtn, speedBtn, pauseBtn, closeBtn,
      el('div', { className: 'sg-castles' }, castles[0].wrap, castles[1].wrap)),
    el('div', { className: 'sg-field' }, canvas, followBtn, armoryBtn, banner),
    mini,
    dock);
  document.body.append(screen);
  screen.world = world; // handy when debugging in the browser console
  document.body.classList.add('sg-open');

  // ---------- The dock: what you can do right now ----------
  // mode: { kind: 'hint' } | { kind: 'build', plot } | { kind: 'building', id } | { kind: 'armory' }
  let mode = { kind: 'hint' };
  let lastKey = '';
  const view = new SiegeView(canvas, mini, {
    tapPlot: (i) => setMode({ kind: 'build', plot: i }),
    tapBuilding: (b) => {
      if (b.line === 'market') { setMode({ kind: 'building', id: b.id }); return; }
      world.toggleHold(ME, b.id);
      navigator.vibrate?.(10);
      refresh(true);
    },
    holdBuilding: (b) => setMode({ kind: 'building', id: b.id }),
    tapEmpty: () => setMode({ kind: 'hint' }),
  });
  view.setup(world, { ...assets, mySide: ME });
  screen.view = view;
  view.resize();
  followBtn.addEventListener('click', () => { view.follow = true; });
  armoryBtn.addEventListener('click', () => setMode(mode.kind === 'armory' ? { kind: 'hint' } : { kind: 'armory' }));
  goBtn.addEventListener('click', () => { world.go(ME); navigator.vibrate?.(30); refresh(true); });

  function setMode(m) {
    mode = m;
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
        el('span', { className: 'sg-plots', textContent: `${s.plots.filter(Boolean).length}/${PLOTS} plots` })),
      el('ul', { className: 'sg-hints' },
        el('li', {}, el('b', { textContent: 'Tap an empty plot' }), ' to build.'),
        el('li', {}, el('b', { textContent: 'Tap a building' }), ' to hold its next unit (blue bar); ', el('b', { textContent: 'GO' }), ' sends all held units together.'),
        el('li', {}, el('b', { textContent: 'Press and hold a building' }), ' to upgrade or sell it.'),
        el('li', {}, 'The ', el('b', { textContent: 'anvil' }), ' opens the Armory for upgrades that reach your whole army.')),
      held ? el('p', { className: 'sg-note', textContent: `${held} building${held > 1 ? 's' : ''} on hold.` }) : null,
      s.research ? researchBar() : null,
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
          line.cost, () => { if (world.buy(ME, 'build', line.key, plot)) setMode({ kind: 'hint' }); },
          p === null, needs);
      })));
    }
    const mp = world.price(ME, 'market', null, plot);
    out.push(el('h4', { className: 'sg-group' }, el('img', { src: bldIcon(84), alt: '' }), 'Economy'));
    out.push(el('div', { className: 'sg-opts' }, option('Market', `+${MARKET.income} gold every 4s · ${s.markets}/${MARKET.max} built`, bldIcon(84), MARKET.cost,
      () => { if (world.buy(ME, 'market', null, plot)) setMode({ kind: 'hint' }); }, mp === null)));
    return out;
  }

  function buildingView(id) {
    const b = world.building(id);
    if (!b || b.side !== ME) { setTimeout(() => setMode({ kind: 'hint' })); return []; }
    const s = world.sides[ME];
    const sellBtn = el('button', { type: 'button', className: 'sg-sell', onclick: () => { world.sell(ME, b.id); setMode({ kind: 'hint' }); } },
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
        next ? priced(el('button', { type: 'button', className: 'sg-buy', onclick: () => { world.buy(ME, 'upgrade', b.id); refresh(true); } },
          el('span', { className: 'sg-buy-label', textContent: `Upgrade to ${next.name}` }), priceTag(next.upgrade)), next.upgrade, upPrice === null)
          : el('p', { className: 'sg-note', textContent: 'Fully upgraded.' }),
        el('button', { type: 'button', className: `sg-hold${b.hold ? ' on' : ''}`, onclick: () => { world.toggleHold(ME, b.id); refresh(true); },
          textContent: b.hold ? (b.waiting ? 'Release now' : 'Stop holding') : 'Hold next unit' }),
        sellBtn),
    ];
  }

  function researchBar() {
    const r = world.sides[ME].research;
    const t = kit.techs.find((x) => x.id === r.id);
    const frac = 1 - Math.max(0, r.endsAt - world.t) / r.time;
    return el('div', { className: 'sg-research' }, el('span', { textContent: `Researching ${t?.name}` }),
      el('div', { className: 'sg-rbar' }, el('i', { style: `width:${Math.round(frac * 100)}%` })));
  }

  function armoryView() {
    const s = world.sides[ME];
    const out = [closeRow('Armory')];
    if (s.research) out.push(researchBar());
    else out.push(el('p', { className: 'sg-note', textContent: 'One at a time. Each upgrade reaches all your units that it applies to, including those already fighting.' }));
    for (const group of ['Blacksmith', 'Unit upgrades', 'Unique techs']) {
      const list = kit.techs.filter((t) => t.group === group);
      if (!list.length) continue;
      out.push(el('h4', { className: 'sg-group', textContent: group }));
      out.push(el('div', { className: 'sg-opts' }, list.map((t) => {
        const done = s.researched.has(t.id);
        const p = world.price(ME, 'research', t.id);
        const blocked = t.after && !s.researched.has(t.after);
        const note = done ? 'Researched' : s.research?.id === t.id ? 'Researching…' : blocked ? `After ${kit.techs.find((x) => x.id === t.after)?.name}` : `${Math.round(t.time / GAME_SPEED)}s to research`;
        return priced(el('button', { type: 'button', className: `sg-opt${done ? ' done' : ''}`,
          onclick: () => { world.buy(ME, 'research', t.id); refresh(true); } },
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
    const b = mode.kind === 'building' ? world.building(mode.id) : null;
    const key = [mode.kind, mode.plot, mode.id, s.plots.join(), s.markets, s.researched.size, s.research?.id,
      b ? `${b.tier}${b.hold}${b.waiting}` : '', held.length, world.winner].join('|');
    if (!force && key === lastKey) {
      // Same content: just keep prices and the research bar current.
      for (const btn of dock.querySelectorAll('[data-price]')) btn.disabled = btn.dataset.blocked === '1' || s.gold < Number(btn.dataset.price);
      const bar = dock.querySelector('.sg-rbar i');
      if (bar && s.research) bar.style.width = `${Math.round((1 - Math.max(0, s.research.endsAt - world.t) / s.research.time) * 100)}%`;
      return;
    }
    lastKey = key;
    const content = mode.kind === 'build' ? buildView(mode.plot) : mode.kind === 'building' ? buildingView(mode.id) : mode.kind === 'armory' ? armoryView() : hintView();
    const scroll = dock.scrollTop;
    dock.replaceChildren(...content.flat().filter(Boolean));
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
    if (now - hudAt > 150) {
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
    pauseBtn.textContent = on ? '❚❚' : '▶';
    pauseBtn.setAttribute('aria-label', on ? 'Pause' : 'Resume');
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
          row('Techs researched', (i) => S[i].researched.size),
          row('Gold earned', (i) => Math.round(S[i].stats.earned)),
          row('Gold spent', (i) => Math.round(S[i].stats.spent)))),
      el('div', { className: 'sg-end-acts' },
        el('button', { type: 'button', className: 'fight', textContent: 'Play again', onclick: () => { close(); openGame({ data, kits, assets, level, civNames }); } }),
        el('button', { type: 'button', className: 'sg-btn', textContent: 'Back', onclick: close })));
    screen.append(box);
  }
  refresh(true);
}
