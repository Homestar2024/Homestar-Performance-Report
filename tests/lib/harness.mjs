import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const require = createRequire(pathToFileURL(path.join(here, '../')));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.wasm': 'application/wasm', '.gz': 'application/gzip',
};

/**
 * Serve the app over http://127.0.0.1, which counts as a secure origin, so
 * service workers register exactly as they do on the deployed site.
 * pdf.js is served from ./vendor like it is in production — there is no CDN
 * left to stub.
 */
export async function serve(root = ROOT) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    let file = path.join(base, rel);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(base) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Open the app in its own browser context, so each test gets a clean
 * IndexedDB, cache storage and service-worker registration.
 *
 * @param {object} opts
 * @param {boolean} [opts.serviceWorker] Allow the worker to register. Off by
 *   default: an active worker would serve requests from its cache and make
 *   every other test's routing and timing nondeterministic.
 * @param {boolean} [opts.breakPdfjs] Serve a 404 for the vendored pdf.js, to
 *   exercise the "part of the app is missing" path.
 * @param {string|null} [opts.reportType] Which report to pick on the chooser.
 *   Defaults to the airflow flow, which is what most tests are about; pass
 *   null to land on the chooser itself.
 */
export async function openApp(browser, origin,
    { serviceWorker = false, breakPdfjs = false, reportType = 'airflow' } = {}) {
  const context = await browser.newContext({
    serviceWorkers: serviceWorker ? 'allow' : 'block',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.once('close', () => context.close().catch(() => {}));
  page.appContext = context;

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  if (breakPdfjs) await page.route('**/vendor/pdf.min.js', route => route.abort('failed'));

  await page.goto(origin + '/index.html', { waitUntil: 'load' });
  if (reportType) {
    await page.click(`[data-rt="${reportType}"]`);
    await page.waitForSelector('#actions:not([hidden])');
  }
  page.pageErrors = errors;
  return page;
}

/**
 * Poll a page-side async function from node until it satisfies `done`.
 *
 * page.waitForFunction does NOT await a promise returned by its predicate — it
 * sees the Promise object, calls it truthy and resolves immediately. Anything
 * asking the service worker a question has to be polled from here instead.
 * Navigations destroy the execution context mid-poll, which is expected while
 * a worker takes over, so those errors are swallowed and retried.
 */
export async function pollEval(page, fn, done, { timeout = 30000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await page.evaluate(fn);
      if (done(last)) return last;
    } catch (e) {
      if (!/context was destroyed|Execution context|Target closed|navigation/i.test(String(e))) throw e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting; last saw ${JSON.stringify(last)}`);
    await new Promise(r => setTimeout(r, every));
  }
}

/**
 * Wait until a service worker is activated AND controlling the page. Activation
 * only happens after the install handler's waitUntil settles, so by this point
 * the shell is cached.
 */
export async function swReady(page, timeout = 30000) {
  await pollEval(page, async () => {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    return {
      active: !!(reg && reg.active && reg.active.state === 'activated'),
      controlling: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    };
  }, r => r && r.active && r.controlling, { timeout });
}

/** Names of everything the worker has cached, relative to the origin. */
export function cachedPaths(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = [];
    for (const n of names) {
      const keys = await (await caches.open(n)).keys();
      for (const r of keys) out.push(new URL(r.url).pathname);
    }
    return out.sort();
  });
}

/**
 * Prefer the Chromium that Playwright downloaded. Some sandboxes ship a
 * pre-installed build under PLAYWRIGHT_BROWSERS_PATH whose revision doesn't
 * match this Playwright version — fall back to that rather than failing.
 * CHROME_PATH overrides both.
 */
function resolveChromium() {
  const candidates = [process.env.CHROME_PATH];
  try { candidates.push(chromium.executablePath()); } catch {}
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pool && fs.existsSync(pool)) {
    for (const dir of fs.readdirSync(pool).filter(d => d.startsWith('chromium')).sort().reverse()) {
      candidates.push(path.join(pool, dir, 'chrome-linux', 'chrome'));
      candidates.push(path.join(pool, dir, 'chrome-linux', 'headless_shell'));
    }
  }
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) throw new Error('No Chromium found. Run: npx playwright install chromium');
  return found;
}

export async function launch() {
  return chromium.launch({ executablePath: resolveChromium() });
}

/** Choose a report type on the chooser (also needed again after a reload). */
export async function pickReport(page, type = 'airflow') {
  await page.click(`[data-rt="${type}"]`);
  await page.waitForSelector('#actions:not([hidden])');
}

/** Feed a generated PDF into one of the two upload slots and wait for the result. */
export async function upload(page, slot, buffer, name = `slot${slot}.pdf`) {
  await page.setInputFiles(`#f${slot}`, { name, mimeType: 'application/pdf', buffer });
  await page.waitForFunction(
    n => {
      const d = document.getElementById('d' + n);
      return d.classList.contains('set') || d.classList.contains('err');
    },
    slot,
    { timeout: 15000 },
  );
}

let _pdfjs;
/** pdf.js in node warns about missing canvas polyfills it never needs here. */
function nodePdfjs() {
  if (!_pdfjs) {
    const warn = console.warn, log = console.log;
    console.warn = console.log = () => {};
    try { _pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
    finally { console.warn = warn; console.log = log; }
  }
  return _pdfjs;
}

/**
 * Attach a generated image to one of the photo slots. Built in the page with
 * a canvas and handed to the real input, so the app's own change handler,
 * decode and downscale all run.
 */
export async function attachPhoto(page, slot, { w = 800, h = 600, color = '#8899aa' } = {}) {
  await page.evaluate(async ({ slot, w, h, color }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.fillStyle = '#fff'; x.fillRect(w * 0.1, h * 0.1, w * 0.3, h * 0.2);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], `photo${slot}.png`, { type: 'image/png' }));
    const inp = document.getElementById('pf' + slot);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { slot, w, h, color });
  await page.waitForFunction(s => document.getElementById('p' + s).classList.contains('set'), slot, { timeout: 15000 });
}

/** Attach a file that is not a decodable image. */
export async function attachBadPhoto(page, slot) {
  await page.evaluate(s => {
    const dt = new DataTransfer();
    dt.items.add(new File(['not an image'], 'notes.txt', { type: 'text/plain' }));
    const inp = document.getElementById('pf' + s);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, slot);
  await page.waitForFunction(s => /Couldn/.test(document.getElementById('pn' + s).textContent), slot, { timeout: 15000 });
}

/** Natural size of an image held in a data URL, measured in the page. */
export async function dataUrlSize(page, url) {
  return page.evaluate(u => new Promise(res => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.src = u;
  }), url);
}

/** Fill the capacity side directly, for tests that are about the report. */
export async function setCapacity(page, spec) {
  await page.evaluate(s => {
    setHeadCount(s.heads.length);
    s.heads.forEach((h, i) => {
      const head = CAP.heads[i];
      head.location = h.location || '';
      head.locationOther = h.locationOther || '';
      head.unitType = h.unitType || 'Wall mount';
      head.model = h.model || '';
      head.serial = h.serial || '';
      Object.assign(head.before, h.before || {});
      Object.assign(head.after, h.after || {});
    });
    Object.assign(CAP.outdoor, s.outdoor || {});
    for (const el of document.getElementById('capOut').querySelectorAll('[data-out]')) {
      el.value = CAP.outdoor[el.dataset.out] || '';
    }
    CAP.open = -1;
    renderHeads();
    setStatus();
  }, spec);
}

/** Attach generated images to a capacity photo gallery. */
export async function addCapacityPhotos(page, phase, count, dims = { w: 800, h: 600 }) {
  await page.evaluate(async ({ phase, count, dims }) => {
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas');
      c.width = dims.w; c.height = dims.h;
      const x = c.getContext('2d');
      x.fillStyle = `hsl(${i * 60}, 30%, 55%)`;
      x.fillRect(0, 0, c.width, c.height);
      CAP.photos[phase].push(c.toDataURL('image/jpeg', 0.85));
    }
    capPhotoThumbs(phase);
  }, { phase, count, dims });
}

/**
 * Text of each printed page, from the real paginated PDF. Lets a test assert
 * that a block did not get cut across a break — which a page count alone
 * cannot catch.
 */
export async function pageTexts(buffer) {
  const pdfjs = nodePdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out.push(c.items.map(o => o.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * Draw a stand-in Testo screen and push it through the real OCR path.
 * Resolves once the panel shows either candidates or a failure message.
 */
export async function ocrRead(page, i, phase, value = '9,950', extra = 'Return 68.4 F  41 %rH') {
  // The panel lives inside the head's body, so the head has to be expanded.
  await page.evaluate(n => { if (CAP.open !== n) { CAP.open = n; renderHeads(); } }, i);
  await page.evaluate(async ({ i, phase, value, extra }) => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 420;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#111';
    x.font = 'bold 84px Arial'; x.fillText(value, 40, 190);
    x.font = 'bold 40px Arial'; x.fillText('BTU/h', 400, 190);
    x.font = '30px Arial'; x.fillText(extra, 40, 290);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'testo.png', { type: 'image/png' }));
    OCR.target = { i, phase };
    const inp = document.getElementById('ocrFile');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, { i, phase, value, extra });
  await page.waitForSelector(`#capO-${i}-${phase} .capocrpick, #capO-${i}-${phase} .capocrmsg.bad`,
    { timeout: 90000 });
}

/**
 * How many images each printed page carries, from the paint operators of the
 * real paginated PDF. Page text alone cannot tell you where a photograph
 * landed, which is what a stranded caption is about.
 */
export async function pageImages(buffer) {
  const pdfjs = nodePdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const paints = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject,
                          pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintJpegXObject]
                         .filter(v => v !== undefined));
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const ops = await (await doc.getPage(i)).getOperatorList();
    out.push(ops.fnArray.filter(fn => paints.has(fn)).length);
  }
  return out;
}

/** Page count of a rendered PDF buffer, read with pdf.js in node. */
export async function pageCount(buffer) {
  const pdfjs = nodePdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  return doc.numPages;
}

/* ---------- tiny assertion harness (keeps the dependency list to two) ---------- */

const results = [];

export function test(name, fn) { results.push({ name, fn }); }

export function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what || 'value'}: expected ${e}, got ${a}`);
}
export function ok(cond, what) { if (!cond) throw new Error(what || 'expected truthy'); }

export async function run(setup) {
  const ctx = await setup();
  let pass = 0;
  const failures = [];
  for (const t of results) {
    try {
      await t.fn(ctx);
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (e) {
      failures.push(t.name);
      console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`    ${String(e.message || e).split('\n').join('\n    ')}`);
    }
  }
  await ctx.teardown?.();
  console.log(`\n${pass}/${results.length} passed`);
  if (failures.length) process.exitCode = 1;
}
