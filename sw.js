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
const VERSION = 'v5';
const CACHE = `homestar-${VERSION}`;
const NAV_TIMEOUT_MS = 3000;
const ASSET_TIMEOUT_MS = 3000;

/* Files that change whenever the app is deployed. */
const APP_CODE = /(^|\/)(app\/[^/]+\.js|index\.html|manifest\.webmanifest)$/;

/* The Tesseract engine under vendor/tesseract/ is deliberately NOT precached:
   it is ~8.7MB and OCR is optional, so making every first install pay for it
   would be the wrong trade. The fetch handler below caches it the first time
   it is used, after which screenshot reading works offline too. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app/core.js',
  './app/parser.js',
  './app/intake.js',
  './app/report.js',
  './app/capacity.js',
  './app/ocr.js',
  './app/history.js',
  './app/pwa.js',
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

  // The app's own code changes on every deploy, so it is revalidated the same
  // way navigations are. Serving it cache-first meant a released fix did not
  // appear until the SECOND load — which is exactly how a shipped OCR change
  // looked broken in the field. Libraries and icons never change without a
  // filename change, so those stay cache-first.
  if (APP_CODE.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        const fresh = await networkWithTimeout(req, ASSET_TIMEOUT_MS);
        if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return (await caches.match(req, {ignoreSearch: true})) || Response.error();
      }
    })());
    return;
  }

  // Everything else is immutable for the life of its filename: cache first,
  // refresh quietly behind.
  event.respondWith((async () => {
    const cached = await caches.match(req, {ignoreSearch: true});
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
