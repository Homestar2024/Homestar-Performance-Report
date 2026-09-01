/**
 * Homestar performance report — offline service worker.
 *
 * The app is used in mechanical rooms and crawlspaces where there is often no
 * signal, so everything it needs is cached on first visit: the page itself,
 * pdf.js and its worker (served from this origin, no CDN), and the icons.
 *
 * Two rules keep a bad deploy from becoming permanent:
 *
 *   1. Navigations are network-first (with a short timeout), so a fresh
 *      index.html always wins when there is any usable connection. A broken
 *      release can be fixed by pushing another one.
 *   2. This worker never calls skipWaiting() on its own. A new version waits
 *      until the page offers the technician a Reload — nobody gets yanked out
 *      of a half-finished report.
 *
 * Bump VERSION on every change to this file or the shell list.
 */
const VERSION = 'v1';
const CACHE = `homestar-${VERSION}`;
const NAV_TIMEOUT_MS = 3000;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, so one 404 cannot leave the app with no offline copy at all.
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] could not cache', url, e); }
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('homestar-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Network, but not for longer than a technician will wait on one bar. */
function networkWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(r => { clearTimeout(timer); resolve(r); },
                        e => { clearTimeout(timer); reject(e); });
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // nothing else is ours to serve

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await networkWithTimeout(req, NAV_TIMEOUT_MS);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match('./index.html', {ignoreSearch: true});
        return cached || Response.error();
      }
    })());
    return;
  }

  // Everything else is a versioned static asset: serve from cache, refresh behind.
  event.respondWith((async () => {
    const cached = await caches.match(req, {ignoreSearch: true});
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
