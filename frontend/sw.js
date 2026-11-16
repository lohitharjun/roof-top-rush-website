// Rooftop Rift service worker: lets the game open offline once it has been loaded.
// Bump CACHE when you deploy new files so players get them.
const CACHE = 'rooftop-rift-v1';
const SHELL = ['./', 'index.html', 'style.css', 'game.js', 'config.js', 'ads.js', 'privacy.html',
  'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;     // never touch the leaderboard API, ads or fonts
  e.respondWith(
    fetch(req).then((res) => {                                            // online: newest files, and refresh the cache
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))   // offline: use the cache
  );
});
