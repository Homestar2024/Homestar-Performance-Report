import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const require = createRequire(pathToFileURL(path.join(here, '../')));

/**
 * The app loads pdf.js from cdnjs. Tests serve the byte-identical 3.11.174
 * build from node_modules instead, so the suite is hermetic and does not
 * depend on the CDN being reachable. Everything else — the parser, the DOM,
 * the print engine — is the real thing.
 */
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const LOCAL = {
  'pdf.min.js': require.resolve('pdfjs-dist/build/pdf.min.js'),
  'pdf.worker.min.js': require.resolve('pdfjs-dist/build/pdf.worker.min.js'),
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.pdf': 'application/pdf' };

export async function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.blockCdn] Simulate an unreachable CDN instead of
 *                                  serving the local pdf.js build.
 */
export async function openApp(browser, origin, { blockCdn = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route(CDN + '*', route => {
    if (blockCdn) return route.abort('failed');
    const local = LOCAL[route.request().url().slice(CDN.length)];
    if (!local) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(local) });
  });
  await page.goto(origin + '/index.html', { waitUntil: 'load' });
  page.pageErrors = errors;
  return page;
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
