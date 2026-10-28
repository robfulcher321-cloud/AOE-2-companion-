// Game data comes live from the open-source aoe2techtree project (MIT licence),
// the same data that powers aoe2techtree.net. It is cached on the device so the
// app works offline, and refreshed whenever that project publishes new data.

const REPO = 'SiegeEngineers/aoe2techtree';
const BRANCH = 'master';
export const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const CACHE = 'aoe2-data';
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000; // at most every 3 hours

const hasCaches = typeof caches !== 'undefined';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

async function getJson(path) {
  const url = RAW + path;
  if (hasCaches) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.json();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't download ${path} (error ${res.status}).`);
    await cache.put(url, res.clone());
    return res.json();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${path} (error ${res.status}).`);
  return res.json();
}

export const imageUrl = (type, pictureIndex) => `${RAW}img/${type}/${pictureIndex}.png`;

let core = null;
const trees = new Map();

/** data.json + English strings. */
export async function loadCore() {
  if (!core) {
    const [data, strings] = await Promise.all([
      getJson('data/data.json'),
      getJson('data/locales/en/strings.json'),
    ]);
    core = { data, strings };
  }
  return core;
}

/** Per-civ tree: which units, techs and buildings that civ gets. */
export async function loadTree(civKey) {
  const key = civKey.toUpperCase();
  if (!trees.has(key)) trees.set(key, getJson(`data/trees/${key}.json`));
  return trees.get(key);
}

export function lastDataDate() { return store.get('dataDate'); }

/**
 * Asks GitHub for the latest commit that touched the data folder.
 * If it differs from what's cached, the cache is cleared so fresh data loads.
 * Returns 'updated' | 'current' | 'skipped' | 'unknown'.
 */
export async function checkForUpdate({ force = false } = {}) {
  const lastCheck = Number(store.get('dataChecked') || 0);
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return 'skipped';
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits?path=data&sha=${BRANCH}&per_page=1`,
      { cache: 'no-store' });
    if (!res.ok) return 'unknown';
    const [commit] = await res.json();
    if (!commit) return 'unknown';
    store.set('dataChecked', String(Date.now()));
    store.set('dataDate', commit.commit.committer.date);
    const previous = store.get('dataSha');
    store.set('dataSha', commit.sha);
    if (previous && previous !== commit.sha) {
      if (hasCaches) await caches.delete(CACHE);
      core = null;
      trees.clear();
      return 'updated';
    }
    return 'current';
  } catch {
    return 'unknown'; // offline: keep using the cached copy
  }
}

/** Strip the game's inline markup from help text. */
export function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Single-line display name (some names contain line breaks for the in-game tree). */
export const nameText = (s) => (s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Armour/attack class names as used by the game's data file.
export const CLASS_NAMES = {
  1: 'Infantry', 2: 'Turtle Ships', 3: 'Pierce', 4: 'Melee', 5: 'War Elephants',
  8: 'Cavalry', 11: 'All Buildings', 13: 'Stone Defence', 15: 'Archers', 16: 'Ships',
  17: 'Rams', 19: 'Unique Units', 20: 'Siege Weapons', 21: 'Standard Buildings',
  22: 'Walls & Gates', 23: 'Gunpowder Units', 25: 'Monks', 26: 'Castles',
  27: 'Spearmen', 28: 'Cavalry Archers', 29: 'Eagle Warriors', 30: 'Camels',
  34: 'Fishing Ships', 35: 'Mamelukes', 36: 'Heroes & Kings', 38: 'Skirmishers',
};
export const className = (c) => CLASS_NAMES[c] || `Class ${c}`;
