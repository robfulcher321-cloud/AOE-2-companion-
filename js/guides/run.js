// The practice window: a full-screen, game-style view of a build order, made
// to be read from a phone propped up under the monitor.
// Top: clock, age, villager count, and the live resource bank with how many
// villagers should be on each resource, in big type.
// Middle (most of the screen): the build scrolls up from the bottom towards a
// NOW line - villagers to send, villagers to move, and what to build or
// research - each tagged with the time to start it.
// Bottom: the current step in words, then the controls.

import { ICON_BASE, ICON_LIVE } from './source.js';
import { tokens, fmtTime, RES_KEYS } from './econ.js';

const PX = 3.6;        // pixels per game second (about two minutes ahead on a phone)
const NOW_Y = 0.15;    // NOW line position, fraction of the strip height from the top
const SPEEDS = [1.7, 1];
const SPEED_LABEL = { 1.7: 'Game clock', 1: 'Real time' };
const RES_ICON = {
  food: 'resource/Aoe2de_food.webp', wood: 'resource/Aoe2de_wood.webp', gold: 'resource/Aoe2de_gold.webp',
  stone: 'resource/Aoe2de_stone.webp', builder: 'resource/Aoe2de_hammer.webp',
};
const VILL_ICON = 'resource/MaleVillDE.webp';
const AGE_ICONS = { 1: 'age/DarkAgeIconDE.webp', 2: 'age/FeudalAgeIconDE.webp', 3: 'age/CastleAgeIconDE.webp', 4: 'age/ImperialAgeIconDE.webp' };
const AGE_NAMES = { 1: 'Dark', 2: 'Feudal', 3: 'Castle', 4: 'Imperial' };
const ITEM_H = 84;     // room one item takes in its lane, px

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

  // ---------- Top bar ----------
  const ageImg = icon(AGE_ICONS[1], 'run-age-ic');
  const clock = el('div', { className: 'run-clock', textContent: '0:00' });
  const popNum = el('b', { textContent: '3' });
  const builders = el('b', { textContent: '0' });
  const closeBtn = el('button', { type: 'button', className: 'run-close', textContent: '×', onclick: () => close() });
  closeBtn.setAttribute('aria-label', 'Close practice');
  const head = el('div', { className: 'run-head' },
    ageImg, clock,
    el('div', { className: 'run-pop', title: 'Villagers' }, icon(VILL_ICON, 'run-pop-ic'), popNum),
    el('div', { className: 'run-pop run-build', title: 'Building' }, icon(RES_ICON.builder, 'run-pop-ic'), builders),
    closeBtn);

  // ---------- Resources ----------
  const resBoxes = {};
  const hud = el('header', { className: 'run-hud' });
  for (const k of RES_KEYS) {
    const amount = el('b', { className: 'run-amt', textContent: '0' });
    const vills = el('b', { className: 'run-vills', textContent: '0' });
    resBoxes[k] = { amount, vills };
    hud.append(el('div', { className: `run-res run-${k}` },
      el('div', { className: 'run-res-top' }, icon(RES_ICON[k], 'run-res-ic'), amount),
      el('div', { className: 'run-res-vills' }, icon(VILL_ICON, 'run-vb-ic'), vills)));
  }

  // ---------- Scrolling strip ----------
  const track = el('div', { className: 'run-track' });
  const strip = el('div', { className: 'run-strip' },
    el('div', { className: 'run-lanes' }, el('div'), el('div'), el('div')),
    track,
    el('div', { className: 'run-now' }, el('span', { textContent: 'NOW' })),
    el('div', { className: 'run-lane-heads' }, el('span', { textContent: 'Send villagers' }), el('span', { textContent: 'Move villagers' }), el('span', { textContent: 'Build & research' })));
  const items = [];
  const LANE = { train: 0, move: 1, build: 2 };
  const nextFree = [-1e9, -1e9, -1e9];
  const place = (lane, time, content) => {
    const li = LANE[lane];
    const y = Math.max(time * PX, nextFree[li]);
    nextFree[li] = y + ITEM_H;
    const when = el('span', { className: 'run-when' }, el('b', { textContent: fmtTime(time) }), el('small', { className: 'run-in' }));
    const node = el('div', { className: `run-item run-${lane}` }, when, el('div', { className: 'run-body' }, content));
    node.style.left = `calc(${(li * 100) / 3}% + 4px)`;
    node.style.transform = `translateY(${y}px)`;
    track.append(node);
    items.push({ t: time, node, inEl: when.lastChild });
  };
  // Step boundaries: villager target for each step
  for (const st of tl.steps) {
    const mark = el('div', { className: 'run-mark' }, el('span', {}, el('b', { textContent: `${st.vills}` }), icon(VILL_ICON, 'run-mark-ic'), ` by ${fmtTime(st.t)}`));
    mark.style.transform = `translateY(${st.t * PX}px)`;
    track.append(mark);
  }
  // New villagers: when each comes out and where it goes
  for (const v of tl.villagers) {
    place('train', v.done, [icon(VILL_ICON, 'run-ic'), el('span', { className: 'run-arrow', textContent: '→' }), v.res ? icon(RES_ICON[v.res], 'run-ic') : el('span', { textContent: '?' })]);
  }
  // Villagers moving between resources
  for (const m of tl.moves) {
    place('move', m.t, [el('span', { className: 'run-count', textContent: `${m.n}` }), icon(RES_ICON[m.from], 'run-ic-s'), el('span', { className: 'run-arrow', textContent: '→' }), icon(RES_ICON[m.to], 'run-ic-s')]);
  }
  // Buildings, research, units and age-ups, at the time to start them
  for (const e of tl.events) {
    if (e.what === 'villager') continue;
    const isAge = e.what.startsWith('age');
    place('build', e.t, [icon(isAge ? e.icon : e.what, isAge ? 'run-ic run-ic-age' : 'run-ic'),
      e.n > 1 ? el('span', { className: 'run-count', textContent: `×${e.n}` }) : null,
      isAge ? el('span', { className: 'run-cap', textContent: 'Click up' }) : null]);
  }
  track.style.height = `${(tl.end + 120) * PX}px`;

  // ---------- Current step ----------
  const stepBox = el('section', { className: 'run-step' });

  // ---------- Controls ----------
  const playBtn = el('button', { type: 'button', className: 'run-play', textContent: 'Start' });
  const btn = (label, fn, cls = '') => el('button', { type: 'button', className: cls, textContent: label, onclick: fn });
  const speedBtn = btn(SPEED_LABEL[speed], () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    store.set('bo-speed', String(speed));
    speedBtn.textContent = SPEED_LABEL[speed];
  }, 'run-speed');
  speedBtn.title = 'Timer speed: the in-game clock runs 1.7× real time at Normal speed';
  const jump = (dt) => { t = Math.max(0, Math.min(tl.end, t + dt)); draw(true); };
  const controls = el('footer', { className: 'run-controls' },
    btn('−10s', () => jump(-10)), playBtn, btn('+10s', () => jump(10)),
    btn('↺', () => { t = 0; setRunning(false); draw(true); }, 'run-reset'), speedBtn);

  const root = el('div', { className: 'run', role: 'dialog', 'aria-label': `Practise ${build.name}` },
    head, hud, strip, stepBox, controls);
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
    stepBox.replaceChildren(
      el('div', { className: 'run-step-head' }, el('span', { textContent: `Step ${i + 1}/${tl.steps.length}` }), el('span', { className: 'run-due' })),
      ...(st.notes || []).map(noteLine));
  }

  function draw(force = false) {
    const h = strip.clientHeight || 400;
    track.style.transform = `translateY(${Math.round(h * NOW_Y - t * PX)}px)`;
    clock.textContent = fmtTime(t);
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
    // Countdown on what's about to happen; light up as it reaches NOW, then dim.
    for (const it of items) {
      const d = it.t - t;
      it.node.classList.toggle('soon', d > 0 && d <= 10);
      it.node.classList.toggle('hit', d <= 0 && d > -3);
      it.node.classList.toggle('past', d <= -3);
      const label = d > 0 && d <= 15 ? `in ${Math.ceil(d)}s` : '';
      if (it.inEl.textContent !== label) it.inEl.textContent = label;
    }
    const i = tl.stepAt(t);
    if (i !== shownStep || force) {
      if (shownStep !== -1 && i !== shownStep && running) navigator.vibrate?.(100);
      shownStep = i;
      drawStep(i);
    }
    const due = tl.steps[i].t - t;
    const dueEl = stepBox.querySelector('.run-due');
    if (dueEl) dueEl.textContent = due > 0 ? `${tl.steps[i].vills} villagers by ${fmtTime(tl.steps[i].t)} (${fmtTime(due)})` : `${tl.steps[i].vills} villagers`;
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
  // Drag the strip up or down to scrub through the build.
  let dragY = null;
  strip.addEventListener('pointerdown', (e) => { dragY = e.clientY; strip.setPointerCapture(e.pointerId); });
  strip.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    t = Math.max(0, Math.min(tl.end, t - (e.clientY - dragY) / PX));
    dragY = e.clientY;
    last = performance.now();
  });
  const endDrag = () => { dragY = null; };
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
