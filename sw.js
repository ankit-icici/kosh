/* Kosh service worker — caches the app shell so the app opens instantly.
   Data always comes from the network (Apps Script); cached model lives in
   localStorage inside the app itself. Bump VERSION on every deploy. */
const VERSION = 'kosh-v17';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];

self.addEventListener('install', (e) => {
  // cache:'reload' — GitHub Pages sends max-age=600, so a plain fetch could fill
  // the new version's cache with the previous build's files
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                    // writes go straight out

  // Same-origin app shell: NETWORK-FIRST, so a fresh deploy shows up on the very
  // next open instead of after two. Cache is the offline fallback, not the source.
  // cache:'no-cache' revalidates with the server (a cheap 304) instead of trusting
  // the HTTP cache, which GitHub Pages lets hold a file for 10 minutes.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  // Fonts never change: cache-first is right for them.
  if (url.host.includes('fonts.')) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
      )
    );
  }
});
