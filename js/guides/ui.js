// Guides tab: pick a civ, pick a build order, read its overview, then practise
// it against a running clock.

import { loadCore, civIconUrl, nameText } from '../data.js';
import { Picker } from '../picker.js';
import { civOptions } from '../techtree.js';
import { loadIndex, loadBuild, ICON_BASE, ICON_LIVE } from './source.js';
import { overview, timeline, tokens, fmtTime, RES_KEYS } from './econ.js';
import { openRun } from './run.js';

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
};
/** replaceChildren that accepts nested arrays and skips empty values */
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// A general build to suggest when a civ has none of its own, by what the civ is known for.
function suggestGeneric(specialty) {
  const s = specialty.toLowerCase();
  if (/^(foot )?archer/.test(s)) return { id: 'archers20pop1range', why: 'an archer civilisation' };
  if (/^(cavalry|camel|elephant)/.test(s)) return { id: 'scoutsrush18pop', why: 'a cavalry civilisation' };
  if (/^infantry/.test(s)) return { id: '19popfeudaldrush', why: 'an infantry civilisation' };
  return { id: 'arenafastcastleboom', why: `a ${s.replace(/ civilization$/, '').toLowerCase()} civilisation that wants to reach Castle Age` };
}

function icon(path, alt = '') {
  const img = el('img', { src: ICON_BASE + path, alt, className: 'bo-icon', loading: 'lazy' });
  img.onerror = () => { if (!img.dataset.live) { img.dataset.live = '1'; img.src = ICON_LIVE + path; } };
  return img;
}
const RES_ICON = { food: 'resource/Aoe2de_food.webp', wood: 'resource/Aoe2de_wood.webp', gold: 'resource/Aoe2de_gold.webp', stone: 'resource/Aoe2de_stone.webp', builder: 'resource/Aoe2de_hammer.webp' };

/** A build-order note with its icons. */
function noteView(note) {
  const p = el('p', { className: 'bo-note' });
  for (const seg of String(note).split('|')) {
    const line = el('span', { className: 'bo-seg' });
    for (const t of tokens(seg)) line.append(t.icon ? icon(t.icon) : t.text);
    p.append(line);
  }
  return p;
}

function allocView(res, prev) {
  const wrap = el('div', { className: 'bo-alloc' });
  for (const k of [...RES_KEYS, 'builder']) {
    const n = Math.round(res?.[k] || 0);
    if (k === 'builder' && !n) continue;
    const d = prev ? n - Math.round(prev[k] || 0) : 0;
    wrap.append(el('div', { className: `bo-res bo-res-${k}` }, icon(RES_ICON[k], k),
      el('b', { textContent: String(n) }),
      d ? el('small', { className: d > 0 ? 'up' : 'down', textContent: d > 0 ? `+${d}` : String(d) }) : null));
  }
  return wrap;
}

export async function initGuides(root) {
  const { data, strings } = await loadCore();
  const civName = (k) => nameText(strings[data.civs[k].name_string_id] || k);
  const specialty = (k) => nameText(strings[data.civs[k].help_string_id] || '').split(/[.\n]/)[0] || '';
  const index = await loadIndex();
  let list = index.list;

  const civPicker = new Picker({ label: 'Civilisation', onChange: (c) => { store.set('guide-civ', c); showList(); } });
  const startCiv = store.get('guide-civ') || store.get('civ') || 'Britons';
  civPicker.setOptions(civOptions(data, strings), data.civs[startCiv] ? startCiv : 'Britons');
  const status = el('p', { className: 'bo-status' });
  const main = el('div', { className: 'bo-main' });
  root.replaceChildren(
    el('div', { className: 'field' }, el('span', { textContent: 'Civilisation' }), civPicker.button),
    main,
    status,
    el('p', { className: 'bo-credit' }, 'Build orders from ',
      el('a', { href: 'https://github.com/CraftySalamander/rtsbuilds', target: '_blank', rel: 'noopener', textContent: 'RTS Builds' }),
      ' (the RTS Overlay community library, GPL-3.0), by the authors named on each build. New builds are picked up automatically.'),
  );

  let player = null;
  const stopPlayer = () => { player?.close(); player = null; };

  function buildCard(b, note) {
    const btn = el('button', { type: 'button', className: 'bo-card' },
      el('span', { className: 'bo-card-name', textContent: b.name }),
      el('span', { className: 'bo-card-meta', textContent: `by ${b.author}${note ? ` · ${note}` : ''}` }));
    btn.addEventListener('click', () => showBuild(b));
    return btn;
  }

  // A starter build: "Early game" or "Boom" tag, then what it is.
  function roleCard(b, role) {
    const btn = el('button', { type: 'button', className: `bo-card bo-card-${b.role}` },
      el('span', { className: 'bo-role', textContent: role }),
      el('span', { className: 'bo-card-name', textContent: b.name }),
      el('span', { className: 'bo-card-meta', textContent: 'App build, adapted from Cicero\'s build order reference' }));
    btn.addEventListener('click', () => showBuild(b));
    return btn;
  }

  function showList() {
    stopPlayer();
    const civ = civPicker.value;
    const name = civName(civ);
    const own = list.filter((b) => b.faction === civ);
    const starters = ['early', 'boom'].map((r) => own.find((b) => b.role === r)).filter(Boolean);
    const community = own.filter((b) => !b.role);
    const generic = list.filter((b) => b.faction === 'Generic');
    const sug = own.length ? null : suggestGeneric(specialty(civ));
    const sugBuild = sug && generic.find((b) => b.id === sug.id);
    const ROLE = { early: 'Early game', boom: 'Boom' };
    fill(main,
      el('h2', { className: 'bo-h' }, el('img', { src: civIconUrl(civ), alt: '', className: 'bo-civ' }), `Build orders for ${name}`),
      starters.length ? [
        el('h3', { className: 'bo-sub', textContent: 'Starter builds' }),
        el('div', { className: 'bo-list' }, starters.map((b) => roleCard(b, ROLE[b.role]))),
      ] : null,
      community.length ? [
        el('h3', { className: 'bo-sub', textContent: `From the community (${community.length})` }),
        el('div', { className: 'bo-list' }, community.map((b) => buildCard(b))),
      ] : null,
      !own.length ? el('div', {},
        el('p', { className: 'subtle', textContent: `No ${name}-specific build in the library yet. Suggested general build, since ${name} is ${sug.why}:` }),
        sugBuild ? el('div', { className: 'bo-list' }, buildCard(sugBuild, 'suggested')) : null) : null,
      el('details', { className: 'bo-more' }, el('summary', { textContent: `General builds for any civ (${generic.length})` }),
        el('div', { className: 'bo-list' }, generic.filter((b) => b !== sugBuild).map((b) => buildCard(b)))),
    );
  }

  async function showBuild(entry) {
    stopPlayer();
    fill(main, el('p', { className: 'status', textContent: 'Loading build order…' }));
    let bo;
    try { bo = await loadBuild(entry.id); } catch (err) { fill(main, el('p', { className: 'status error', textContent: err.message })); return; }
    const ov = overview(bo, data);
    const back = el('button', { type: 'button', className: 'bo-back', textContent: '‹ All builds' });
    back.addEventListener('click', showList);
    const start = el('button', { type: 'button', className: 'fight', textContent: 'Start practice' });
    start.addEventListener('click', () => showPlayer(bo));
    const ageName = { 2: 'Feudal', 3: 'Castle', 4: 'Imperial' };
    const iconRow = (paths) => (paths.length ? el('div', { className: 'bo-icons' }, paths.map((p) => icon(p))) : el('span', { className: 'subtle', textContent: 'None' }));
    fill(main, 
      back,
      el('h2', { className: 'bo-h', textContent: bo.name }),
      el('p', { className: 'subtle' }, `By ${bo.author}`, bo.source ? [' · ', el('a', { href: bo.source, target: '_blank', rel: 'noopener', textContent: 'source' })] : null),
      bo.description ? el('p', { className: 'bo-desc', textContent: bo.description }) : null,
      ov.tl.estimated ? el('p', { className: 'bo-hint', textContent: 'This build doesn\'t give times, so the app works them out from the villager counts (25 s per villager, plus age-up research). Treat them as a guide.' }) : null,
      el('h3', { textContent: 'Timeline' }),
      el('ul', { className: 'bo-milestones' },
        ov.ages.map((a) => el('li', {}, el('b', { textContent: `${ageName[a.age]} Age: ` }),
          `click at about ${fmtTime(a.click)} (${a.pop} pop), arrive about ${fmtTime(a.reach)}`)),
        el('li', {}, el('b', { textContent: 'Build ends: ' }), `${fmtTime(ov.finalTime)} with ${ov.finalVills} villagers`)),
      el('h3', { textContent: 'Villagers at the end' }),
      allocView(ov.finalAlloc),
      el('h3', { textContent: 'Buildings' }), iconRow(ov.buildings),
      el('h3', { textContent: 'Units' }), iconRow(ov.units),
      el('h3', { textContent: 'Upgrades' }), iconRow(ov.techs),
      el('h3', { textContent: `Steps (${ov.tl.steps.length})` }),
      stepList(ov.tl),
      start,
    );
    window.scrollTo(0, 0);
  }

  function stepList(tl, onPick) {
    const ol = el('ol', { className: 'bo-steps' });
    tl.steps.forEach((st, i) => {
      const li = el('li', { className: 'bo-step' },
        el('div', { className: 'bo-step-head' }, el('b', { textContent: fmtTime(st.t) }), ` · ${st.vills} villagers`),
        (st.notes || []).map(noteView));
      if (onPick) { li.tabIndex = 0; li.addEventListener('click', () => onPick(i)); }
      ol.append(li);
    });
    return ol;
  }

  function showPlayer(bo) {
    stopPlayer();
    player = openRun(bo, timeline(bo, data), { onClose: () => { player = null; } });
  }

  showList();
  index.refresh().then((fresh) => {
    if (!fresh) return;
    list = fresh;
    status.textContent = 'Build orders updated.';
    if (main.querySelector('.bo-list')) showList();
  });
}
