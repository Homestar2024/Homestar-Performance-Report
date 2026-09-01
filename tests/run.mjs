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
import path from 'node:path';
import { test, eq, ok, run, serve, launch, openApp, upload, pageCount, attachPhoto, attachBadPhoto, dataUrlSize, ROOT } from './lib/harness.mjs';
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

test('a blocked pdf.js CDN says so instead of failing silently', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { blockCdn: true });
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
  await page.click('#p1 .plink');
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
