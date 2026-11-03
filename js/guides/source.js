// Build orders from RTS Builds (github.com/CraftySalamander/rtsbuilds, GPL-3.0),
// the community library behind RTS Overlay. A copy ships with the app; when
// online, the app checks the live library for new and updated builds.

const LIVE = 'https://craftysalamander.github.io/rtsbuilds';
const LIVE_INDEX = `${LIVE}/builds/aoe2_builds.js`;
const liveBuild = (id) => `${LIVE}/api/builds/aoe2/${id}.json`;
const BUNDLED_INDEX = 'assets/builds/index.json';
const bundledBuild = (id) => `assets/builds/aoe2/${id}.json`;
export const ICON_BASE = 'img/bo/';
export const ICON_LIVE = 'https://craftysalamander.github.io/RTS_Overlay/assets/aoe2/';
const CACHE_KEY = 'bo-index-v1';
const BUILD_KEY = (id) => `bo-build-v1-${id}`;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

/** RTS Builds names its files by the build name, lowercased, letters and digits only. */
export const buildId = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function parseIndex(js) {
  const m = js.match(/const\s+aoe2_build_orders\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) throw new Error('Unexpected build list format');
  const text = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(text).map((b) => ({ ...b, id: buildId(b.name) }));
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// The app's own starter builds: an early-game build and a boom for every civ
// (tools/make_starter_builds.py). They ship with the app and are listed with
// the library's builds; their ids start with "app-".
const STARTER = 'assets/builds/starter.json';
let starterP = null;
const starter = () => (starterP ||= fetch(STARTER).then((r) => r.json()).catch(() => ({ list: [], builds: {} })));

/**
 * The list of build orders: the cached live list if there is one, else the
 * bundled one, plus the starter builds. `refresh()` checks the live library
 * and resolves to the new list if anything changed (or null).
 */
export async function loadIndex() {
  const cached = store.get(CACHE_KEY);
  let lib = cached?.list;
  if (!lib) lib = await (await fetch(BUNDLED_INDEX)).json();
  const own = (await starter()).list;
  return {
    list: [...own, ...lib],
    async refresh() {
      try {
        const live = parseIndex(await (await fetchWithTimeout(LIVE_INDEX)).text());
        const same = JSON.stringify(live) === JSON.stringify(lib);
        store.set(CACHE_KEY, { list: live, checked: Date.now() });
        lib = live;
        return same ? null : [...own, ...live];
      } catch {
        return null;
      }
    },
  };
}

/** One build order: live copy when reachable (cached for offline use), else the bundled one. */
export async function loadBuild(id) {
  if (id.startsWith('app-')) {
    const b = (await starter()).builds[id];
    if (!b) throw new Error('Build not found.');
    return b;
  }
  try {
    const live = await (await fetchWithTimeout(liveBuild(id), 6000)).json();
    store.set(BUILD_KEY(id), live);
    return live;
  } catch {
    const cached = store.get(BUILD_KEY(id));
    if (cached) return cached;
    const res = await fetch(bundledBuild(id));
    if (!res.ok) throw new Error('This build order isn\'t available offline yet. Connect once to download it.');
    return res.json();
  }
}
