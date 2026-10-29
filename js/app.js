import { loadCore, checkForUpdate, lastDataDate } from './data.js';
import { civOptions, renderTree } from './techtree.js';
import { Picker } from './picker.js';
import { initDuel } from './duel/ui.js';
import { initGuides } from './guides/ui.js';
import { checkForAppUpdate } from './updater.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------- Tabs ----------
let duelReady = null;
let guidesReady = null;
function showView(name) {
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.toggleAttribute('aria-current', btn.dataset.view === name);
    if (btn.dataset.view === name) btn.setAttribute('aria-current', 'page');
  }
  $('view-tree').hidden = name !== 'tree';
  $('view-duel').hidden = name !== 'duel';
  $('view-guides').hidden = name !== 'guides';
  if (name === 'duel' && !duelReady) duelReady = initDuel().catch(showError($('side-a')));
  if (name === 'guides' && !guidesReady) guidesReady = initGuides($('guides-body')).catch(showError($('guides-body')));
  store.set('view', name);
  window.scrollTo(0, 0);
}
for (const btn of document.querySelectorAll('.tabs button')) btn.addEventListener('click', () => showView(btn.dataset.view));

// ---------- Detail sheet ----------
const sheet = $('sheet');
let lastFocus = null;
function openSheet(content) {
  lastFocus = document.activeElement;
  $('sheet-content').replaceChildren(content);
  sheet.hidden = false;
  sheet.querySelector('.sheet-close').focus();
}
function closeSheet() {
  sheet.hidden = true;
  lastFocus?.focus();
}
sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

// ---------- Toast ----------
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

const showError = (container) => (err) => {
  console.error(err);
  const p = document.createElement('p');
  p.className = 'status error';
  p.textContent = `${err.message || err} Check your connection, then reopen the app.`;
  container.replaceChildren(p);
};

function updateFooter() {
  const date = lastDataDate();
  const note = $('data-note');
  const when = date ? new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  note.innerHTML = '';
  note.append(`Game data from `);
  const a = Object.assign(document.createElement('a'), { href: 'https://aoe2techtree.net', textContent: 'aoe2techtree.net', target: '_blank', rel: 'noopener' });
  note.append(a, when ? `, last updated ${when}.` : '.');
}

// ---------- Tech tree ----------
async function startTree() {
  const { data, strings } = await loadCore();
  const saved = store.get('civ');
  const civ = saved && data.civs[saved] ? saved : 'Britons';
  const ctx = { body: $('tree-body'), blurb: $('civ-blurb'), openSheet };
  const draw = (c) => renderTree(c, ctx).catch(showError(ctx.body));
  if (!startTree.picker) {
    startTree.picker = new Picker({ label: 'Civilisation', onChange: (c) => { store.set('civ', c); draw(c); } });
    $('tree-civ').append(startTree.picker.button);
  }
  startTree.picker.setOptions(civOptions(data, strings), civ);
  await draw(civ);
}

async function boot() {
  await startTree().catch(showError($('tree-body')));
  updateFooter();
  showView(['duel', 'guides'].includes(store.get('view')) ? store.get('view') : 'tree');

  const status = await checkForUpdate();
  updateFooter();
  if (status === 'updated') {
    toast('New game data downloaded.');
    duelReady = null;
    await startTree().catch(showError($('tree-body')));
    if (!$('view-duel').hidden) duelReady = initDuel().catch(showError($('side-a')));
  }
}

boot();
checkForAppUpdate();

const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
if ('serviceWorker' in navigator) {
  if (isNativeApp) {
    // The Android app ships its files inside the APK; a service worker would keep serving old ones after an update.
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  } else {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}
