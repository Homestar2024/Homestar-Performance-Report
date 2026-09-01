/**
 * Homestar performance report — test suite.
 *
 * Everything runs against index.html in real headless Chromium with real
 * pdf.js, because the parser depends on how *browser* pdf.js tokenises text.
 * Never validate a parser change with pdfplumber: it position-sorts and
 * repairs ligatures, so it produces text the app will never see.
 *
 *   node tests/run.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok, run, serve, launch, openApp, upload, pageCount, attachPhoto, attachBadPhoto, dataUrlSize, swReady, cachedPaths, pollEval, ROOT } from './lib/harness.mjs';
import { trueFlowPdf, unrelatedPdf, BEFORE, AFTER } from './lib/make-pdf.mjs';

const LETTER = { format: 'Letter', printBackground: true, margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' } };

const before = trueFlowPdf(BEFORE);
const after = trueFlowPdf(AFTER);

/* ---------------------------------------------------------------- parsing */

test('parses every measurement out of ligature-split pdf.js text', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  const d = await page.evaluate(() => slots[1].data);
  eq(d.date, '2026-08-14', 'date');
  eq(d.totalFlow, 842, 'totalFlow');
  eq(d.returnDuct, -0.412, 'returnDuct');
  eq(d.afterFilter, -0.52, 'afterFilter');
  eq(d.supplyDuct, 0.395, 'supplyDuct');
  eq(d.tesp, 0.807, 'tesp');
  eq(d.returnPlenum, 0.412, 'returnPlenum');
  eq(d.filterDrop, 0.108, 'filterDrop');
  eq(d.supplyPlenum, 0.395, 'supplyPlenum');
  await page.close();
});

test('rejoins f-ligature splits in orientation, email and tech name', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  const d = await page.evaluate(() => slots[1].data);
  eq(d.orientation, 'Upflow', 'orientation (arrives as "Up fl ow")');
  eq(d.email, 'office@homestarhvac.ca', 'email (arrives as "o ffi ce@...")');
  eq(d.tech, 'Calvin Windsor', 'tech');
  eq(d.company, 'Homestar HVAC Solutions', 'company');
  await page.close();
});

test('total airflow ignores the per-ton SCFM value that precedes it', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);          // stream order is "281 SCFM /ton" then "842 SCFM"
  eq(await page.evaluate(() => slots[1].data.totalFlow), 842, 'totalFlow');
  await page.close();
});

test('thousands separators survive the airflow regex', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, after);           // "1,164 SCFM"
  eq(await page.evaluate(() => slots[1].data.totalFlow), 1164, 'totalFlow');
  await page.close();
});

test('extract() handles the documented mangled forms directly', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  const d = await page.evaluate(() =>
    extract('Date tested: 2026-01-02 Total air fl ow 1,010 SCFM 336 SCFM /ton After fi lter = -0.31 Orientation: Up fl ow Cooling Capacity: 3.0'));
  eq(d.date, '2026-01-02', 'date');
  eq(d.totalFlow, 1010, 'totalFlow');
  eq(d.afterFilter, -0.31, 'afterFilter');
  eq(d.orientation, 'Upflow', 'orientation');
  await page.close();
});

/* Real TEC exports dropped into tests/fixtures/pdfs/ are parsed the same way.
   Captured pdf.js text in tests/fixtures/text/*.txt is replayed through
   extract(). Both are no-ops until those folders have content. */

const realPdfs = fs.existsSync(path.join(ROOT, 'tests/fixtures/pdfs'))
  ? fs.readdirSync(path.join(ROOT, 'tests/fixtures/pdfs')).filter(f => f.toLowerCase().endsWith('.pdf'))
  : [];

for (const name of realPdfs) {
  test(`real export: ${name} yields the fields the report needs`, async ({ browser, origin }) => {
    const page = await openApp(browser, origin);
    await upload(page, 1, fs.readFileSync(path.join(ROOT, 'tests/fixtures/pdfs', name)), name);
    ok(await page.evaluate(() => slots[1].ok), 'file was readable');
    const d = await page.evaluate(() => slots[1].data);
    const missing = ['date', 'totalFlow', 'tesp', 'returnPlenum', 'filterDrop', 'supplyPlenum'].filter(k => d[k] == null);
    eq(missing, [], 'fields the parser could not find');
    await page.close();
  });
}

const textDir = path.join(ROOT, 'tests/fixtures/text');
const textFixtures = fs.existsSync(textDir) ? fs.readdirSync(textDir).filter(f => f.endsWith('.txt')) : [];

for (const name of textFixtures) {
  test(`captured text: ${name} parses`, async ({ browser, origin }) => {
    const page = await openApp(browser, origin);
    const text = fs.readFileSync(path.join(textDir, name), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(textDir, name.replace(/\.txt$/, '.json')), 'utf8'));
    const d = await page.evaluate(t => extract(t), text);
    for (const [k, v] of Object.entries(expected)) eq(d[k], v, k);
    await page.close();
  });
}

/* --------------------------------------------------------------- gating */

test('an unreadable file leaves Generate disabled', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, Buffer.from('this is not a pdf'), 'notes.txt');
  ok(await page.$eval('#d2', e => e.classList.contains('err')), 'slot 2 shows an error');
  ok(await page.$eval('#gen', e => e.disabled), 'Generate stays disabled');
  ok(await page.$eval('#status', e => e.classList.contains('bad')), 'status reads as a problem');
  await page.close();
});

test('Generate enables only once both files are read', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  ok(await page.$eval('#gen', e => e.disabled), 'disabled with nothing loaded');
  await upload(page, 1, before);
  ok(await page.$eval('#gen', e => e.disabled), 'disabled with one file');
  await upload(page, 2, after);
  ok(!(await page.$eval('#gen', e => e.disabled)), 'enabled with both');
  await page.close();
});

test('a readable PDF with no recognisable measurements is correctable, not fatal', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, unrelatedPdf(), 'invoice.pdf');
  await upload(page, 2, after);
  ok(!(await page.$eval('#review', e => e.hidden)), 'confirm panel is shown');
  ok(await page.$$eval('#rvrows input.miss', els => els.length >= 5), 'missing values are flagged');
  ok(!(await page.$eval('#gen', e => e.disabled)), 'the tech can still type them in and generate');
  ok(/didn.t come off the PDF/.test(await page.$eval('#status', e => e.textContent)), 'status names the problem');
  await page.close();
});

test('a missing pdf.js says so instead of failing silently', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { breakPdfjs: true });
  ok(!(await page.$eval('#loadWarn', e => e.hidden)), 'the warning banner is visible');
  ok(await page.$eval('#f1', e => e.disabled), 'uploads are disabled');
  eq(page.pageErrors, [], 'no uncaught script errors');
  await page.close();
});

/* -------------------------------------------------------------- ordering */

test('the later test date becomes After even when uploaded backwards', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, after, 'after.pdf');    // deliberately in the "before" slot
  await upload(page, 2, before, 'before.pdf');
  eq(await page.evaluate(() => order), [2, 1], 'order');
  eq(await page.$eval('#hb', e => e.textContent), 'before.pdf', 'before column');
  eq(await page.$eval('#ha', e => e.textContent), 'after.pdf', 'after column');
  await page.close();
});

test('a same-day pair falls back to upload order and says so', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, trueFlowPdf({ ...BEFORE, date: '2026-08-14' }));
  await upload(page, 2, trueFlowPdf({ ...AFTER, date: '2026-08-14' }));
  eq(await page.evaluate(() => order), [1, 2], 'order');
  ok(await page.$eval('#rvnote', e => e.classList.contains('flag')), 'the note is flagged');
  ok(/same test date/.test(await page.$eval('#rvnote', e => e.textContent)), 'the note explains why');
  await page.close();
});

test('a same-day pair with clock times orders by time', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, trueFlowPdf({ ...AFTER, date: '2026-08-14' }, { time: '2:40 PM' }));
  await upload(page, 2, trueFlowPdf({ ...BEFORE, date: '2026-08-14' }, { time: '9:15 AM' }));
  eq(await page.evaluate(() => order), [2, 1], 'morning test is the "before"');
  await page.close();
});

test('Swap reverses the columns and the generated report', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.click('#swap');
  eq(await page.evaluate(() => order), [2, 1], 'order after swap');
  await page.click('#gen');
  const flow = await page.$eval('.hcell', e => e.textContent);
  ok(/1,164/.test(flow) && flow.indexOf('1,164') < flow.indexOf('842'), 'the report reads after → before now');
  await page.close();
});

test('correcting a date reorders the columns once the edit is committed', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, trueFlowPdf({ ...BEFORE, date: '2026-08-14' }));
  await upload(page, 2, trueFlowPdf({ ...AFTER, date: '2026-08-14' }));
  eq(await page.evaluate(() => order), [1, 2], 'same-day pair keeps upload order');
  const box = '#rvrows input[data-key="date"][data-pos="b"]';
  await page.click(box);
  await page.fill(box, '2026-09-02');            // the "before" was actually tested later
  eq(await page.evaluate(() => order), [1, 2], 'no reorder while still focused');
  await page.locator(box).blur();
  eq(await page.evaluate(() => order), [2, 1], 'reordered once committed');
  await page.close();
});

/* --------------------------------------------------------------- overrides */

test('a typed correction overrides the parsed value in the report', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.fill('#rvrows input[data-key="totalFlow"][data-pos="a"]', '1300');
  await page.click('#gen');
  ok(/1,300/.test(await page.$eval('.hcell', e => e.textContent)), 'the report shows the typed value');
  await page.close();
});

test('a typed correction survives a swap', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.fill('#rvrows input[data-key="tesp"][data-pos="b"]', '0.900');
  await page.click('#swap');
  eq(await page.$eval('#rvrows input[data-key="tesp"][data-pos="a"]', e => e.value), '0.900', 'value followed its file');
  await page.close();
});

/* ---------------------------------------------------------------- report */

test('directionality: airflow up and pressures down read as improvements', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.click('#gen');
  const cls = await page.$$eval('.metric', els =>
    els.map(e => [e.querySelector('.mname').firstChild.textContent.trim(), (e.querySelector('.mbadge') || {}).className || '']));
  const by = Object.fromEntries(cls);
  ok(/\bg\b/.test(by['Total Airflow']), 'airflow up = good');
  ok(/\bg\b/.test(by['Total External Static Pressure']), 'TESP down = good');
  ok(/\bg\b/.test(by['Return Plenum']), 'return plenum down = good');
  ok(/\bg\b/.test(by['Filter Drop']), 'filter drop down = good');
  await page.close();
});

test('a supply-plenum rise is amber, never red', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);          // supply plenum rises 0.395 -> 0.428
  await page.click('#gen');
  const badge = await page.$$eval('.metric', els => {
    const m = els.find(e => e.querySelector('.mname').textContent.startsWith('Supply Plenum'));
    return m.querySelector('.mbadge').className;
  });
  ok(/\bw\b/.test(badge), `supply plenum badge should be amber, got "${badge}"`);
  ok(!/\bb\b/.test(badge), 'supply plenum must not be red');
  await page.close();
});

test('SCFM/ton and the Conditions section stay out of the report', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.click('#gen');
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(!/\/ton/i.test(txt), 'no per-ton figure');
  ok(!/Orientation|Cooling capacity|Elevation|Filter location/i.test(txt), 'no System & Conditions rows');
  await page.close();
});

test('report sections appear in the agreed order', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.click('#gen');
  eq(await page.$$eval('#sheet .sh', els => els.map(e => e.textContent)),
    ['Verified Results at a Glance', 'Summary Calculations — Before vs After', 'Air Measurements',
     'What This Means For Your Home'], 'sections');
  await page.close();
});

test('a filename containing markup is escaped, not rendered', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before, '<img src=x onerror=window.__x=1>.pdf');
  eq(await page.evaluate(() => window.__x), undefined, 'no injected element ran');
  eq(await page.$$eval('#fn1 img', els => els.length), 0, 'no element was created');
  await page.close();
});

test('changing an input retires the report so stale numbers cannot be printed', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.click('#gen');
  ok(await page.evaluate(() => document.body.classList.contains('has-report')), 'report is showing');
  await page.fill('#rvrows input[data-key="totalFlow"][data-pos="a"]', '1300');
  ok(!(await page.evaluate(() => document.body.classList.contains('has-report'))), 'edit retired the report');
  eq(await page.$eval('#sheet', e => e.innerHTML.trim()), '', 'stale markup is gone');
  await page.close();
});

test('a value that is not a number is flagged like a missing one', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.fill('#rvrows input[data-key="tesp"][data-pos="b"]', 'n/a');
  ok(await page.$eval('#rvrows input[data-key="tesp"][data-pos="b"]', e => e.classList.contains('miss')), 'flagged');
  await page.close();
});

/* -------------------------------------------------- benefits (page two) */

/** Load the standard pair and generate, optionally overriding panel values first. */
async function report(page, overrides = {}) {
  await upload(page, 1, before);
  await upload(page, 2, after);
  for (const [sel, val] of Object.entries(overrides)) await page.fill(sel, val);
  await page.click('#gen');
}

test('an airflow gain gets the capacity write-up', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/More air means more of the capacity you paid for/.test(txt), 'heading for the gain');
  ok(/Airflow rose 38%/.test(txt), 'the actual percentage is quoted');
  ok(/842 → 1,164 SCFM/.test(txt), 'the actual values are quoted');
  ok(!/Airflow decreased/.test(txt), 'the loss copy is not also present');
  await page.close();
});

test('an airflow loss gets the opposite write-up', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#rvrows input[data-key="totalFlow"][data-pos="a"]': '640' });
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/Airflow decreased — worth investigating/.test(txt), 'heading for the loss');
  ok(/ice up/.test(txt), 'names the real consequence');
  ok(!/capacity you paid for/.test(txt), 'the gain copy is gone');
  await page.close();
});

test('a static-pressure drop gets the blower write-up', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/no longer fighting the ductwork/.test(txt), 'heading');
  ok(/draws less power/.test(txt) && /quieter/.test(txt), 'covers energy and noise');
  await page.close();
});

test('a static-pressure rise gets the harder-working write-up', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#rvrows input[data-key="tesp"][data-pos="a"]': '0.950' });
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/the blower is working harder/i.test(txt), 'heading');
  ok(!/no longer fighting/.test(txt), 'the improvement copy is gone');
  await page.close();
});

test('a supply-plenum rise is explained as expected, not as a fault', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  const row = await page.$$eval('.bcomp .row', els => {
    const r = els.find(e => e.querySelector('.rk').textContent.startsWith('Supply Plenum'));
    return r ? { cls: r.className, text: r.textContent } : null;
  });
  ok(row, 'a supply plenum line exists');
  ok(/\bw\b/.test(row.cls), 'styled amber');
  ok(/expected/.test(row.text) && /not a fault/.test(row.text), 'says it is expected and not a fault');
  await page.close();
});

test('the three secondary metrics are one-liners, not full blocks', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  eq(await page.$$eval('.ben h4', els => els.length), 2, 'full write-ups');
  eq(await page.$$eval('.bcomp .row', els => els.length), 3, 'compact lines');
  await page.close();
});

test('a metric that did not move claims nothing', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#rvrows input[data-key="filterDrop"][data-pos="a"]': '0.108' });  // same as before
  const keys = await page.$$eval('.bcomp .row .rk', els => els.map(e => e.textContent));
  ok(!keys.some(k => k.startsWith('Filter Drop')), 'no line for an unchanged metric');
  await page.close();
});

test('a metric with a missing value claims nothing', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '' });
  const keys = await page.$$eval('.bcomp .row .rk', els => els.map(e => e.textContent));
  ok(!keys.some(k => k.startsWith('Return Plenum')), 'no line without both values');
  await page.close();
});

/* ----------------------------------------------------- the pickers open */

/* Every picker is a <label> wrapping a hidden file input. If anything else
   labelable (a <button>, say) ends up inside that label, it silently becomes
   the label's control and swallows the tap — the box goes dead with no error.
   That shipped once; these tests exist so it cannot ship again. */

test('each picker label is wired to its own file input', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  const wiring = await page.evaluate(() =>
    ['d1', 'd2', 'p1', 'p2'].map(id => {
      const c = document.getElementById(id).control;
      return [id, c ? c.id + ':' + c.tagName.toLowerCase() : 'none'];
    }));
  eq(wiring, [['d1', 'f1:input'], ['d2', 'f2:input'], ['p1', 'pf1:input'], ['p2', 'pf2:input']], 'label controls');
  await page.close();
});

test('tapping any of the four pickers opens a file chooser', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  for (const id of ['d1', 'd2', 'p1', 'p2']) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
      page.click('#' + id, { position: { x: 30, y: 30 } }),
    ]);
    ok(chooser, `#${id} did not open a file chooser`);
  }
  await page.close();
});

test('the photo pickers accept images and do not force the camera', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  // `capture` would send Android straight to the camera, blocking gallery picks.
  eq(await page.$$eval('#pf1, #pf2', els => els.map(e => [e.accept, e.hasAttribute('capture')])),
    [['image/*', false], ['image/*', false]], 'accept / capture');
  await page.close();
});

test('Remove sits outside the label and does not open a chooser', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await attachPhoto(page, 1);
  ok(await page.evaluate(() => !document.getElementById('p1').contains(document.getElementById('px1'))),
    'the button must not be a descendant of the label');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 2000 }).catch(() => null),
    page.click('#px1'),
  ]);
  ok(!chooser, 'Remove opened a file chooser');
  eq(await page.evaluate(() => photos[1]), null, 'photo cleared');
  await page.close();
});

test('the picker still opens after a photo has been chosen', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await attachPhoto(page, 1);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    page.click('#p1', { position: { x: 30, y: 70 } }),   // over the thumbnail
    ]);
  ok(chooser, 'replacing a chosen photo must still be possible');
  await page.close();
});

/* ------------------------------------------------------ photos (page two) */

test('both photos render in labelled before/after frames', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 1, { color: '#334455' });
  await attachPhoto(page, 2, { color: '#556677' });
  await page.click('#gen');
  eq(await page.$$eval('.shot img', els => els.length), 2, 'two frames');
  eq(await page.$$eval('.shot .pt', els => els.map(e => e.textContent)), ['Before', 'After'], 'labels');
  ok(await page.$eval('.shot img', e => e.src.startsWith('data:image/jpeg')), 'embedded, not linked');
  await page.close();
});

test('a single photo renders on its own without a gap', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 2);
  await page.click('#gen');
  eq(await page.$$eval('.shot img', els => els.length), 1, 'one frame');
  ok(await page.$eval('.shots', e => e.classList.contains('one')), 'laid out for one');
  eq(await page.$eval('.shot .pt', e => e.textContent), 'After', 'labelled correctly');
  await page.close();
});

test('no photos means no photo section at all', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  eq(await page.$$eval('.shot', els => els.length), 0, 'no frames');
  // (the report title also contains "Before & After", so check the headings)
  const heads = await page.$$eval('#sheet .sh', els => els.map(e => e.textContent));
  ok(!heads.includes('Before & After'), 'no photo section heading');
  await page.close();
});

test('a large phone-sized photo is scaled down before it is embedded', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await attachPhoto(page, 1, { w: 4032, h: 3024 });
  const url = await page.evaluate(() => photos[1]);
  const size = await dataUrlSize(page, url);
  eq(size, { w: 1600, h: 1200 }, 'scaled to a 1600px long edge, aspect kept');
  await page.close();
});

test('a portrait photo keeps its orientation through the downscale', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await attachPhoto(page, 1, { w: 3024, h: 4032 });
  const size = await dataUrlSize(page, await page.evaluate(() => photos[1]));
  eq(size, { w: 1200, h: 1600 }, 'still taller than wide');
  await page.close();
});

test('removing a photo takes it out of the report', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 1);
  await page.click('#px1');
  eq(await page.evaluate(() => photos[1]), null, 'cleared');
  ok(!(await page.$eval('#p1', e => e.classList.contains('set'))), 'picker reset');
  await page.click('#gen');
  eq(await page.$$eval('.shot', els => els.length), 0, 'not in the report');
  await page.close();
});

test('a file that is not an image is rejected without breaking the form', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachBadPhoto(page, 1);
  eq(await page.evaluate(() => photos[1]), null, 'nothing stored');
  ok(!(await page.$eval('#gen', e => e.disabled)), 'the report can still be generated');
  await page.close();
});

test('attaching a photo retires the report on screen', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  await attachPhoto(page, 1);
  ok(!(await page.evaluate(() => document.body.classList.contains('has-report'))), 'retired');
  await page.close();
});

/* --------------------------------------------------------------- history */

/** Replace window.print with a counter so the print path can be driven. */
async function stubPrint(page) {
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
}
const printed = page => page.evaluate(() => window.__printed);
const records = page => page.evaluate(() => dbAll());

async function printReport(page) {
  const was = await printed(page);
  await page.click('#printBtn');
  await page.waitForFunction(n => window.__printed > n, was, { timeout: 10000 });
}

/** Open a record and wait for the restore to finish, not just for the click. */
async function openFromHistory(page, selector = '[data-open]') {
  await page.click(selector);
  await page.waitForFunction(() => {
    const t = document.querySelector('.toast');
    return !!t && /^Opened/.test(t.textContent);
  }, null, { timeout: 10000 });
}

test('printing saves the report to history and still prints', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  const recs = await records(page);
  eq(recs.length, 1, 'one record');
  eq(recs[0].title, 'Todd Brown', 'titled with the customer name');
  eq(recs[0].before.totalFlow, 842, 'before measurements stored');
  eq(recs[0].after.totalFlow, 1164, 'after measurements stored');
  eq(await printed(page), 1, 'print was called');
  await page.close();
});

test('printing the same job twice updates one record, not two', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  await printReport(page);
  const recs = await records(page);
  eq(recs.length, 1, 'still one record');
  eq(await printed(page), 2, 'printed both times');
  ok(recs[0].updatedAt >= recs[0].savedAt, 'timestamps make sense');
  await page.close();
});

test('the same customer on a later date is a separate record', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  // Same customer, a return visit six months later.
  await page.fill('#rvrows input[data-key="date"][data-pos="a"]', '2027-02-11');
  await page.click('#gen');
  await printReport(page);
  const recs = await records(page);
  eq(recs.length, 2, 'two jobs, two records');
  await page.close();
});

test('a storage failure never blocks the print dialog', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await page.evaluate(() => {
    dbPromise = Promise.reject(new Error('storage unavailable'));
    dbPromise.catch(() => {});
  });
  await printReport(page);
  eq(await printed(page), 1, 'printed anyway');
  ok(/Couldn.t save to history/.test(await page.$eval('.toast', e => e.textContent)), 'and said so');
  await page.close();
});

test('a saved report reopens with its measurements, details and photos', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 1, { color: '#123456' });
  await attachPhoto(page, 2, { color: '#654321' });
  await page.fill('#cName', 'Todd Brown');
  await page.fill('#cAddr', '12 Anderton Rd, Comox');
  await page.fill('#cTech', 'Calvin Windsor');
  await page.click('#gen');
  await stubPrint(page);
  await printReport(page);

  await page.reload();
  await page.click('#histToggle');
  await openFromHistory(page);

  eq(await page.$eval('#cName', e => e.value), 'Todd Brown', 'client restored');
  eq(await page.$eval('#cAddr', e => e.value), '12 Anderton Rd, Comox', 'address restored');
  eq(await page.$eval('#cTech', e => e.value), 'Calvin Windsor', 'technician restored');
  eq(await page.$eval('#rvrows input[data-key="totalFlow"][data-pos="a"]', e => e.value), '1164', 'readings restored');
  eq(await page.$$eval('.shot img', els => els.length), 2, 'both photos restored');
  ok(await page.$eval('.shot img', e => e.src.startsWith('data:image/jpeg')), 'photos came back as images');
  ok(/1,164/.test(await page.$eval('.hcell', e => e.textContent)), 'the report re-rendered');
  await page.close();
});

test('a reopened report can be corrected and reprinted without duplicating', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);

  await page.click('#histToggle');
  await openFromHistory(page);
  await page.fill('#cAddr', '12 Anderton Rd, Comox');   // the correction
  await page.click('#gen');
  await printReport(page);

  const recs = await records(page);
  eq(recs.length, 1, 'still one record');
  eq(recs[0].addr, '12 Anderton Rd, Comox', 'the correction was kept');
  await page.close();
});

test('history titles fall back to address, then to a dated name', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cAddr': '12 Anderton Rd, Comox' });
  await stubPrint(page);
  await printReport(page);
  eq((await records(page))[0].title, '12 Anderton Rd, Comox', 'address used');

  const page2 = await openApp(browser, origin);
  await report(page2);
  await stubPrint(page2);
  await printReport(page2);
  const t = (await records(page2)).find(r => /^Report — /.test(r.title));
  ok(t, 'a dated fallback title was used when there is nothing else');
  await page2.close();
  await page.close();
});

test('a renamed report keeps its name through the next print', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  page.once('dialog', d => d.accept('Brown — furnace + duct seal'));
  await page.click('#histToggle');
  await page.click('[data-rename]');
  await page.waitForFunction(() => document.querySelector('.hname').textContent.startsWith('Brown —'));
  await printReport(page);
  const recs = await records(page);
  eq(recs.length, 1, 'one record');
  eq(recs[0].title, 'Brown — furnace + duct seal', 'the chosen name survived');
  await page.close();
});

test('deleting asks first, then removes the record', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  await page.click('#histToggle');

  page.once('dialog', d => d.dismiss());
  await page.click('[data-del]');
  eq((await records(page)).length, 1, 'a cancelled delete keeps the record');

  page.once('dialog', d => d.accept());
  await page.click('[data-del]');
  await page.waitForFunction(() => document.querySelectorAll('[data-del]').length === 0);
  eq((await records(page)).length, 0, 'confirmed delete removes it');
  await page.close();
});

test('search filters the saved list by name and address', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await stubPrint(page);
  await report(page, { '#cName': 'Todd Brown' });
  await printReport(page);
  await page.click('#resetBtn');
  await page.waitForSelector('#gen');
  await stubPrint(page);
  await report(page, { '#cName': 'Wanda Klassen', '#cAddr': 'Cumberland' });
  await printReport(page);

  await page.click('#histToggle');
  eq(await page.$$eval('.hname', els => els.length), 2, 'both listed');
  await page.fill('#histSearch', 'klass');
  eq(await page.$$eval('.hname', els => els.map(e => e.textContent)), ['Wanda Klassen'], 'filtered by name');
  await page.fill('#histSearch', 'cumberland');
  eq(await page.$$eval('.hname', els => els.map(e => e.textContent)), ['Wanda Klassen'], 'filtered by address');
  await page.fill('#histSearch', 'zzz');
  ok(/No report matches/.test(await page.$eval('#histList', e => e.textContent)), 'says so when nothing matches');
  await page.close();
});

test('history exports to a backup file and imports back into an empty device', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await attachPhoto(page, 1);
  await page.click('#gen');
  await stubPrint(page);
  await printReport(page);

  await page.click('#histToggle');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#histExport'),
  ]);
  const path = await download.path();
  const backup = JSON.parse(fs.readFileSync(path, 'utf8'));
  eq(backup.app, 'homestar-performance-report', 'tagged as ours');
  eq(backup.reports.length, 1, 'one report in the backup');
  ok(backup.reports[0].photoBefore.startsWith('data:image/jpeg'), 'photo travels with it');

  // A different device: fresh context, empty database.
  const fresh = await openApp(browser, origin);
  eq((await records(fresh)).length, 0, 'starts empty');
  await fresh.setInputFiles('#histImport', { name: 'backup.json', mimeType: 'application/json', buffer: fs.readFileSync(path) });
  await fresh.waitForFunction(() => document.querySelectorAll('.hname').length === 1, null, { timeout: 10000 });
  const restored = await records(fresh);
  eq(restored.length, 1, 'restored');
  eq(restored[0].title, 'Todd Brown', 'with its title');
  eq(restored[0].after.totalFlow, 1164, 'with its readings');
  await fresh.close();
  await page.close();
});

test('importing a file that is not a backup is refused, not swallowed', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await page.click('#histToggle').catch(() => {});
  await page.setInputFiles('#histImport', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await page.waitForSelector('.toast');
  ok(/isn.t a Homestar backup/.test(await page.$eval('.toast', e => e.textContent)), 'told the user');
  eq((await records(page)).length, 0, 'nothing was written');
  await page.close();
});

test('Save to history saves without printing', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await page.click('#saveBtn');
  await page.waitForSelector('.toast');
  eq((await records(page)).length, 1, 'saved');
  eq(await printed(page), 0, 'did not print');
  await page.close();
});

test('the next job does not inherit the last customer photos or details', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 1);
  await attachPhoto(page, 2);
  await page.fill('#cName', 'Todd Brown');
  await page.fill('#cAddr', '12 Anderton Rd, Comox');
  await page.fill('#cTech', 'Calvin Windsor');
  await page.click('#gen');
  await stubPrint(page);
  await printReport(page);

  // Straight on to the next job without reloading.
  await upload(page, 1, trueFlowPdf({ ...BEFORE, date: '2026-08-22' }));
  eq(await page.evaluate(() => [photos[1], photos[2]]), [null, null], 'photos cleared');
  eq(await page.$eval('#cName', e => e.value), '', 'client name cleared');
  eq(await page.$eval('#cAddr', e => e.value), '', 'address cleared');
  eq(await page.$eval('#cTech', e => e.value), 'Calvin Windsor', 'technician kept — same person all day');
  ok(!(await page.$eval('#p1', e => e.classList.contains('set'))), 'photo picker reset');

  await upload(page, 2, trueFlowPdf({ ...AFTER, date: '2026-08-22' }));
  await page.fill('#cName', 'Wanda Klassen');
  await page.click('#gen');
  await printReport(page);
  const recs = await records(page);
  eq(recs.length, 2, 'two jobs on file');
  const wanda = recs.find(r => r.title === 'Wanda Klassen');
  eq([wanda.photoBefore, wanda.photoAfter], [null, null], "the second customer has none of the first's photos");
  await page.close();
});

test('mid-setup uploads do not wipe work in progress', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await attachPhoto(page, 1);
  await page.fill('#cName', 'Todd Brown');
  await upload(page, 2, after);          // second PDF arrives after the photo and name
  ok(await page.evaluate(() => !!photos[1]), 'photo survived');
  eq(await page.$eval('#cName', e => e.value), 'Todd Brown', 'name survived');
  await page.close();
});

test('the history card stays off the printed page', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, { '#cName': 'Todd Brown' });
  await stubPrint(page);
  await printReport(page);
  await page.emulateMedia({ media: 'print' });
  eq(await page.$eval('#histCard', e => getComputedStyle(e).display), 'none', 'history hidden when printing');
  await page.close();
});

/* ----------------------------------------------------------------- print */

test('the report prints on exactly two Letter pages', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  await attachPhoto(page, 1, { w: 4032, h: 3024 });
  await attachPhoto(page, 2, { w: 3024, h: 4032 });   // one landscape, one portrait
  await page.click('#gen');
  eq(await pageCount(await page.pdf(LETTER)), 2, 'page count');
  await page.close();
});

test('two pages still holds with a long client name and address', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await upload(page, 1, before);
  await upload(page, 2, after);
  await attachPhoto(page, 1);
  await attachPhoto(page, 2);
  await page.fill('#cName', 'Christopher & Alexandra Vanderhoof-Williamson');
  await page.fill('#cAddr', '4471 Cumberland Road, Courtenay, British Columbia V9N 9X4');
  await page.fill('#cTech', 'Calvin Windsor');
  await page.click('#gen');
  eq(await pageCount(await page.pdf(LETTER)), 2, 'page count');
  await page.close();
});

test('two pages holds with no photos — benefits alone do not overflow', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  eq(await pageCount(await page.pdf(LETTER)), 2, 'page count');
  await page.close();
});

test('two pages holds when every metric moved the wrong way', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  // The "worth investigating" copy runs longer than the improvement copy.
  await report(page, {
    '#rvrows input[data-key="totalFlow"][data-pos="a"]': '640',
    '#rvrows input[data-key="tesp"][data-pos="a"]': '0.950',
    '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '0.600',
    '#rvrows input[data-key="filterDrop"][data-pos="a"]': '0.240',
    '#rvrows input[data-key="supplyPlenum"][data-pos="a"]': '0.500',
  });
  await attachPhoto(page, 1);
  await attachPhoto(page, 2);
  await page.click('#gen');
  eq(await pageCount(await page.pdf(LETTER)), 2, 'page count');
  await page.close();
});

test('the benefits and photos land on page two, not page one', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);
  await attachPhoto(page, 1);
  await page.click('#gen');
  const breaks = await page.$$eval('#sheet .page2', els => els.length);
  eq(breaks, 1, 'exactly one page break in the report');
  ok(await page.$eval('#sheet .page2 .sh', e => e.textContent === 'What This Means For Your Home'),
    'the break sits before the write-ups');
  await page.close();
});

test('printing before generating produces no phantom report page', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  eq(await page.$eval('#sheet', e => e.innerHTML.trim()), '', 'no report markup exists yet');
  ok(!(await page.evaluate(() => document.body.classList.contains('has-report'))), 'body is not marked ready');
  await page.close();
});

test('the print stylesheet targets Letter portrait at 0.5in', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  const css = await page.$eval('style', e => e.textContent);
  ok(/@page\{?\s*size:\s*letter portrait/i.test(css.replace(/\s+/g, ' ')), '@page size');
  ok(/margin:\s*0\.5in/i.test(css), '@page margin');
  await page.close();
});

/* ----------------------------------------------- installable offline app */

const readPng = file => {
  const b = fs.readFileSync(path.join(ROOT, file));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

test('the app ships nothing from a third-party origin', async ({ browser, origin }) => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const external = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
  eq(external, [], 'no remote scripts, styles or images');
  const page = await openApp(browser, origin);
  const remote = [];
  page.on('request', r => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) remote.push(r.url()); });
  await upload(page, 1, before);
  eq(remote, [], 'nothing was fetched off-origin, even while parsing a PDF');
  await page.close();
});

test('the vendored pdf.js is the version the parser was written against', async ({ browser, origin }) => {
  const js = fs.readFileSync(path.join(ROOT, 'vendor/pdf.min.js'), 'utf8');
  ok(js.includes('3.11.174'), 'pdf.min.js is 3.11.174');
  ok(fs.existsSync(path.join(ROOT, 'vendor/pdf.worker.min.js')), 'the worker ships too');
  ok(fs.existsSync(path.join(ROOT, 'vendor/LICENSE-pdfjs')), "pdf.js's licence travels with it");
  const page = await openApp(browser, origin);
  eq(await page.evaluate(() => pdfjsLib.version), '3.11.174', 'and that is what the page loaded');
  await page.close();
});

test('the manifest is valid and its icons are the sizes it claims', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  eq(m.display, 'standalone', 'installs as an app, not a browser tab');
  eq([m.start_url, m.scope, m.id], ['./', './', './'], 'relative — the site lives under a repo subpath');
  ok(m.name && m.short_name, 'named');
  for (const icon of m.icons) {
    const file = icon.src.replace(/^\.\//, '');
    ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    const { w, h } = readPng(file);
    eq(`${w}x${h}`, icon.sizes, `${file} really is ${icon.sizes}`);
  }
  ok(m.icons.some(i => i.purpose === 'maskable'), 'a maskable icon for Android launchers');
  ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'any'), 'a 512 for the install prompt');
});

test('the page links the manifest and declares a theme colour', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  eq(await page.$eval('link[rel="manifest"]', e => e.getAttribute('href')), './manifest.webmanifest', 'linked');
  eq(await page.$eval('meta[name="theme-color"]', e => e.content), '#1E6FB8', 'brand blue');
  await page.close();
});

test('the service worker installs and caches everything the app needs', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  const cached = await cachedPaths(page);
  for (const want of ['/index.html', '/vendor/pdf.min.js', '/vendor/pdf.worker.min.js',
                      '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']) {
    ok(cached.some(p => p.endsWith(want)), `${want} is cached — got ${cached.join(', ')}`);
  }
  await page.close();
});

test('the app loads with the network cut', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  await page.appContext.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  ok(await page.$('#gen'), 'the uploader is there');
  eq(await page.evaluate(() => typeof pdfjsLib), 'object', 'pdf.js loaded from cache');
  await page.appContext.setOffline(false);
  await page.close();
});

test('a report can be produced and filed with no signal at all', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  await page.appContext.setOffline(true);
  await page.reload({ waitUntil: 'load' });

  await upload(page, 1, before);
  await upload(page, 2, after);
  await page.fill('#cName', 'Todd Brown');
  await page.click('#gen');
  ok(/1,164/.test(await page.$eval('.hcell', e => e.textContent)), 'the report rendered offline');

  await stubPrint(page);
  await printReport(page);
  eq((await records(page)).length, 1, 'and it saved to history offline');
  await page.appContext.setOffline(false);
  await page.close();
});

test('going offline is announced, and the notice clears when signal returns', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  ok(await page.$eval('#offlineStrip', e => e.hidden), 'nothing shown while online');
  await page.appContext.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  ok(!(await page.$eval('#offlineStrip', e => e.hidden)), 'the offline notice appears');
  ok(/still works/.test(await page.$eval('#offlineStrip', e => e.textContent)), 'and is reassuring, not alarming');
  await page.appContext.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok(await page.$eval('#offlineStrip', e => e.hidden), 'and clears again');
  await page.close();
});

test('the worker never takes over on its own', async () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  // skipWaiting is legitimate inside the message handler; anywhere else it
  // would reload a technician out of a half-finished report.
  const calls = [...sw.matchAll(/self\.skipWaiting\(\)/g)].length;
  eq(calls, 1, 'exactly one skipWaiting');
  const handler = sw.slice(sw.indexOf("addEventListener('message'"));
  ok(handler.includes('self.skipWaiting()'), 'and it is the one behind SKIP_WAITING');
});

test('a new version waits for the tech, then takes over on request', async ({ browser }) => {
  // Serve a throwaway copy so the deployed files can be mutated mid-test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestar-pwa-'));
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['vendor', 'icons']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const { server, origin } = await serve(dir);
  try {
    const page = await openApp(browser, origin, { serviceWorker: true });
    await swReady(page);
    ok(await page.$eval('#updateStrip', e => e.hidden), 'a first install is not an "update"');

    // Ship a new release.
    fs.writeFileSync(path.join(dir, 'sw.js'),
      fs.readFileSync(path.join(dir, 'sw.js'), 'utf8').replace("const VERSION = 'v1'", "const VERSION = 'v2'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });

    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 30000 });
    ok(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting),
      'the new version is waiting, not running');
    eq(await page.evaluate(() => caches.keys().then(k => k.sort())), ['homestar-v1', 'homestar-v2'],
      'the new cache is built while the old version keeps serving');

    await page.click('#updateNow');
    // The page reloads itself when the new worker takes control, so poll from
    // node across the navigation rather than from inside the page.
    await pollEval(page, () => caches.keys().then(k => k.sort().join()),
      names => names === 'homestar-v2');
    await swReady(page);
    ok(await page.$('#gen'), 'the app came back up on the new version');
    await page.close();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ run */

run(async () => {
  const { server, origin } = await serve();
  const browser = await launch();
  return {
    browser,
    origin,
    teardown: async () => { await browser.close(); server.close(); },
  };
});
