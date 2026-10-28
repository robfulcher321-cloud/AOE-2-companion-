// Offline support. App files: use the cached copy, refresh it in the background.
// Unit/tech icons and fonts: cache forever once downloaded.
// Game data JSON is cached by the app itself (js/data.js), so it's left alone here.

const SHELL = 'shell-v4';
const ASSETS = 'assets-v1';
const SHELL_FILES = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/data.js', 'js/techtree.js', 'js/picker.js',
  'js/duel/combat.js', 'js/duel/sim.js', 'js/duel/render.js', 'js/duel/ui.js',
  'js/duel/radii.js', 'js/duel/spritepack.js', 'js/duel/effects.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS, 'aoe2-data', 'aoe2-sprite-pack'].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  const isIcon = url.hostname === 'raw.githubusercontent.com' && url.pathname.includes('/img/');
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (isIcon || isFont) {
    e.respondWith(caches.open(ASSETS).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    }));
    return;
  }

  // The bundled sprite pack is large: download it once, then always use the cached copy.
  if (url.origin === self.location.origin && url.pathname.endsWith('.aoe2pack')) {
    e.respondWith(caches.open(ASSETS).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(request, { ignoreSearch: true });
      const fresh = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
