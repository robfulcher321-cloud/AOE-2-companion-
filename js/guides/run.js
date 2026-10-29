// The practice window: a full-screen, game-style view of a build order.
// Top: live resource bank and villagers per resource, like the in-game bar.
// Middle: the build scrolls past a "now" line - villagers to train and where
// they go, villagers to move, and what to build or research.
// Bottom: the current step in words and the controls.

import { ICON_BASE, ICON_LIVE } from './source.js';
import { tokens, fmtTime, RES_KEYS } from './econ.js';

const PX = 5.5;        // pixels per game second on the strip (about a minute ahead on a phone)
const NOW_X = 0.24;    // "now" line position, fraction of the strip width
const SPEEDS = [
  { value: 1.7, label: 'In-game clock' },
  { value: 1, label: 'Real seconds' },
];
const RES_ICON = {
  food: 'resource/Aoe2de_food.webp', wood: 'resource/Aoe2de_wood.webp', gold: 'resource/Aoe2de_gold.webp',
  stone: 'resource/Aoe2de_stone.webp', builder: 'resource/Aoe2de_hammer.webp',
};
const VILL_ICON = 'resource/MaleVillDE.webp';
const AGE_ICONS = { 1: 'age/DarkAgeIconDE.webp', 2: 'age/FeudalAgeIconDE.webp', 3: 'age/CastleAgeIconDE.webp', 4: 'age/ImperialAgeIconDE.webp' };
const AGE_NAMES = { 1: 'Dark', 2: 'Feudal', 3: 'Castle', 4: 'Imperial' };

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
};
function icon(path, cls = 'run-ic') {
  const img = el('img', { src: ICON_BASE + path, alt: '', className: cls, draggable: false });
  img.onerror = () => { if (!img.dataset.live) { img.dataset.live = '1'; img.src = ICON_LIVE + path; } };
  return img;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

function noteLine(note) {
  const p = el('p', { className: 'run-note' });
  for (const seg of String(note).split('|')) {
    const line = el('span', { className: 'run-seg' });
    for (const t of tokens(seg)) line.append(t.icon ? icon(t.icon, 'run-note-ic') : t.text);
    p.append(line);
  }
  return p;
}

/** Opens the practice window. Returns { close }. */
export function openRun(build, tl, { onClose } = {}) {
  let t = 0;
  let running = false;
  let last = 0;
  let speed = Number(store.get('bo-speed')) || 1.7;
  let raf = 0;
  let wake = null;
  let shownStep = -1;

  // ---------- HUD ----------
  const resBoxes = {};
  const hud = el('header', { className: 'run-hud' });
  for (const k of RES_KEYS) {
    const amount = el('b', { className: 'run-amt', textContent: '0' });
    const vills = el('span', { className: 'run-vills', textContent: '0' });
    resBoxes[k] = { amount, vills };
    hud.append(el('div', { className: `run-res run-${k}` }, icon(RES_ICON[k], 'run-res-ic'), amount, el('span', { className: 'run-vbadge' }, icon(VILL_ICON, 'run-vb-ic'), vills)));
  }
  const popNum = el('b', { className: 'run-amt', textContent: '3' });
  const builders = el('span', { className: 'run-vills', textContent: '0' });
  hud.append(el('div', { className: 'run-res run-pop' }, icon(VILL_ICON, 'run-res-ic'), popNum,
    el('span', { className: 'run-vbadge', title: 'Building' }, icon(RES_ICON.builder, 'run-vb-ic'), builders)));
  const ageImg = icon(AGE_ICONS[1], 'run-age-ic');
  const clock = el('div', { className: 'run-clock', textContent: '0:00' });
  const top = el('div', { className: 'run-top' },
    el('div', { className: 'run-title' }, ageImg, el('span', { className: 'run-name', textContent: build.name })),
    clock);

  // ---------- Strip ----------
  const track = el('div', { className: 'run-track' });
  const strip = el('div', { className: 'run-strip' },
    el('div', { className: 'run-lane-labels' },
      el('span', { textContent: 'Train villagers' }), el('span', { textContent: 'Move villagers' }), el('span', { textContent: 'Build & research' })),
    track,
    el('div', { className: 'run-now' }, el('span', { textContent: 'NOW' })));
  const items = [];
  const lanes = { train: 0, move: 1, build: 2 };
  // Lanes share the strip's height; items within a lane can use two rows.
  const laneTop = (lane, row) => `calc(${(lane * 100) / 3}% + ${22 + row * 40}px)`;
  const lastX = { train: [-1e9, -1e9], move: [-1e9, -1e9], build: [-1e9, -1e9] };
  const place = (lane, time, node, width = 44) => {
    const x = time * PX;
    const rows = lastX[lane];
    const row = x >= rows[0] + width ? 0 : x >= rows[1] + width ? 1 : (rows[0] <= rows[1] ? 0 : 1);
    rows[row] = Math.max(x, rows[row] + width);
    const left = rows[row];
    node.style.transform = `translateX(${left}px)`;
    node.style.top = laneTop(lanes[lane], row);
    track.append(node);
    items.push({ t: time, node });
  };
  // Step boundaries: villager targets
  tl.steps.forEach((st, i) => {
    const mark = el('div', { className: 'run-mark' }, el('span', { textContent: `${st.vills}` }), icon(VILL_ICON, 'run-mark-ic'));
    mark.style.transform = `translateX(${st.t * PX}px)`;
    mark.dataset.step = i;
    track.append(mark);
  });
  // Villagers: one tile each, with where it goes when it pops out
  for (const v of tl.villagers) {
    place('train', v.done, el('div', { className: 'run-item run-vill' }, icon(VILL_ICON), v.res ? icon(RES_ICON[v.res], 'run-badge-ic') : null));
  }
  // Villagers moving between resources
  for (const m of tl.moves) {
    place('move', m.t, el('div', { className: 'run-item run-move' },
      el('span', { className: 'run-count', textContent: `${m.n}` }), icon(RES_ICON[m.from], 'run-mv-ic'), el('span', { className: 'run-arrow', textContent: '→' }), icon(RES_ICON[m.to], 'run-mv-ic')), 92);
  }
  // Buildings, research, units, age-ups
  for (const e of tl.events) {
    if (e.what === 'villager') continue;
    const isAge = e.what.startsWith('age');
    const node = el('div', { className: `run-item run-buy${isAge ? ' run-ageup' : ''}` },
      icon(isAge ? e.icon : e.what),
      e.n > 1 ? el('span', { className: 'run-count', textContent: `×${e.n}` }) : null,
      isAge ? el('span', { className: 'run-cap', textContent: 'Click!' }) : null);
    place('build', e.t, node, isAge ? 56 : 44);
  }
  track.style.width = `${(tl.end + 60) * PX}px`;

  // ---------- Current step ----------
  const stepBox = el('section', { className: 'run-step' });

  // ---------- Controls ----------
  const playBtn = el('button', { type: 'button', className: 'run-play', textContent: 'Start' });
  const btn = (label, fn, cls = '') => { const b = el('button', { type: 'button', className: cls, textContent: label }); b.addEventListener('click', fn); return b; };
  const speedSel = el('select', { 'aria-label': 'Timer speed' }, SPEEDS.map((s) => el('option', { value: s.value, textContent: s.label, selected: s.value === speed })));
  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); store.set('bo-speed', String(speed)); });
  const jump = (dt) => { t = Math.max(0, Math.min(tl.end, t + dt)); draw(true); };
  const controls = el('footer', { className: 'run-controls' },
    btn('−10s', () => jump(-10)), playBtn, btn('+10s', () => jump(10)),
    btn('↺', () => { t = 0; setRunning(false); draw(true); }, 'run-reset'),
    speedSel);

  const closeBtn = btn('×', () => close(), 'run-close');
  closeBtn.setAttribute('aria-label', 'Close practice');
  const root = el('div', { className: 'run', role: 'dialog', 'aria-label': `Practise ${build.name}` },
    el('div', { className: 'run-head' }, top, closeBtn), hud, strip, stepBox, controls);
  document.body.append(root);
  document.body.classList.add('run-open');

  async function setRunning(on) {
    running = on;
    last = performance.now();
    playBtn.textContent = running ? 'Pause' : t > 0 ? 'Resume' : 'Start';
    if (running && 'wakeLock' in navigator) { try { wake = await navigator.wakeLock.request('screen'); } catch { wake = null; } }
    if (!running) { wake?.release?.(); wake = null; }
  }
  playBtn.addEventListener('click', () => setRunning(!running));

  function drawStep(i) {
    const st = tl.steps[i];
    const nxt = tl.steps[i + 1];
    stepBox.replaceChildren(
      el('div', { className: 'run-step-head' },
        el('span', { textContent: `Step ${i + 1}/${tl.steps.length}` }),
        el('span', { className: 'run-due' })),
      ...(st.notes || []).map(noteLine),
      nxt ? el('div', { className: 'run-next' }, el('span', { className: 'run-next-label', textContent: `Next (${fmtTime(nxt.t)})` }), ...(nxt.notes || []).map(noteLine)) : null,
    );
  }

  function draw(force = false) {
    const w = strip.clientWidth || 360;
    track.style.transform = `translateX(${Math.round(w * NOW_X - t * PX)}px)`;
    clock.textContent = fmtTime(t);
    // Live numbers
    const bank = tl.bankAt(t);
    const a = tl.alloc(t);
    for (const k of RES_KEYS) {
      resBoxes[k].amount.textContent = String(Math.max(0, Math.floor(bank[k])));
      resBoxes[k].vills.textContent = String(Math.round(a[k] || 0));
    }
    popNum.textContent = String(tl.villagersAt(t));
    builders.textContent = String(Math.round(a.builder || 0));
    const age = tl.ages.filter((g) => g.reach <= t).reduce((m, g) => Math.max(m, g.age), 1);
    const researching = tl.ages.find((g) => g.click <= t && t < g.reach);
    const ageSrc = ICON_BASE + AGE_ICONS[researching ? researching.age : age];
    if (!ageImg.src.endsWith(ageSrc)) ageImg.src = ageSrc;
    ageImg.classList.toggle('researching', Boolean(researching));
    ageImg.title = researching ? `Researching ${AGE_NAMES[researching.age]} Age` : `${AGE_NAMES[age]} Age`;
    // Items that have reached the line light up, then dim.
    for (const it of items) {
      const d = t - it.t;
      it.node.classList.toggle('soon', d < 0 && d > -6);
      it.node.classList.toggle('hit', d >= 0 && d < 2.5);
      it.node.classList.toggle('past', d >= 2.5);
    }
    const i = tl.stepAt(t);
    if (i !== shownStep || force) {
      if (shownStep !== -1 && i !== shownStep && running) navigator.vibrate?.(100);
      shownStep = i;
      drawStep(i);
    }
    const due = tl.steps[i].t - t;
    const dueEl = stepBox.querySelector('.run-due');
    if (dueEl) dueEl.textContent = due > 0 ? `${tl.steps[i].vills} villagers by ${fmtTime(tl.steps[i].t)} · ${fmtTime(due)} left` : `${tl.steps[i].vills} villagers`;
  }

  // Real elapsed time drives the clock, so it stays right if the screen sleeps.
  const frame = (now) => {
    if (running) {
      t = Math.min(tl.end, t + ((now - last) / 1000) * speed);
      last = now;
      if (t >= tl.end) setRunning(false);
    }
    draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === ' ') { e.preventDefault(); setRunning(!running); }
  };
  document.addEventListener('keydown', onKey);
  // Drag the strip to scrub through the build.
  let dragX = null;
  strip.addEventListener('pointerdown', (e) => { dragX = e.clientX; strip.setPointerCapture(e.pointerId); });
  strip.addEventListener('pointermove', (e) => {
    if (dragX === null) return;
    t = Math.max(0, Math.min(tl.end, t - (e.clientX - dragX) / PX));
    dragX = e.clientX;
    last = performance.now();
  });
  const endDrag = () => { dragX = null; };
  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);

  function close() {
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    wake?.release?.();
    root.remove();
    document.body.classList.remove('run-open');
    onClose?.();
  }
  draw(true);
  return { close };
}
