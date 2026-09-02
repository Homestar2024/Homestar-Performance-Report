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
import { test, eq, ok, run, serve, launch, openApp, upload, pageCount, attachPhoto, attachBadPhoto, dataUrlSize, swReady, cachedPaths, pollEval, pickReport, setCapacity, addCapacityPhotos, pageTexts, ocrRead, ROOT } from './lib/harness.mjs';
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

/** Badge class for one row of the Summary Calculations table. */
const badgeFor = (page, name) => page.$$eval('.metric', (els, n) => {
  const m = els.find(e => e.querySelector('.mname').textContent.startsWith(n));
  return m ? (m.querySelector('.mbadge') || {}).className || '' : null;
}, name);

test('a component pressure that rose less than airflow reads as an improvement', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page);              // supply plenum +8.4% against airflow +38.2%
  const badge = await badgeFor(page, 'Supply Plenum');
  ok(/\bg\b/.test(badge), `carrying more air for less pressure is an improvement, got "${badge}"`);
  ok(/less than moving that much extra air through the same supply ducts normally costs/
    .test(await page.$eval('#sheet', e => e.textContent)), 'and the copy says why');
  await page.close();
});

test('no component pressure is ever shown as a failure', async ({ browser, origin }) => {
  // All three pushed up hard, well past the airflow gain.
  const page = await openApp(browser, origin);
  await report(page, {
    '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '0.900',
    '#rvrows input[data-key="filterDrop"][data-pos="a"]': '0.400',
    '#rvrows input[data-key="supplyPlenum"][data-pos="a"]': '0.950',
  });
  for (const name of ['Return Plenum', 'Filter Drop', 'Supply Plenum']) {
    const badge = await badgeFor(page, name);
    ok(/\bn\b/.test(badge), `${name} should be neutral, got "${badge}"`);
    ok(!/\b[bw]\b/.test(badge), `${name} must never be red or amber, got "${badge}"`);
  }
  ok(!/wrong direction|restricting more than it was|worth confirming/
    .test(await page.$eval('#sheet', e => e.textContent)), 'and none of the alarming copy survives');
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
  ok(/Airflow rose 38.2%/.test(txt), 'the actual percentage is quoted');
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

/** One line from the compact component panel on page two. */
const compactRow = (page, name) => page.$$eval('.bcomp .row', (els, n) => {
  const r = els.find(e => e.querySelector('.rk').textContent.startsWith(n));
  return r ? { cls: r.className, text: r.textContent.replace(/\s+/g, ' ') } : null;
}, name);

/* The job that prompted this rewrite: a big return-side restriction cleared,
   so airflow rose 21.2% and total external static fell 58.8% — while the
   return plenum rose 2.7% and the supply plenum rose 142.9%. The old wording
   called that "moved the wrong direction — worth a look", in front of the
   customer, on a job that had done exactly what it set out to do. */
const REAL_BEFORE = { ...BEFORE, date: '2026-08-25', totalFlow: '850', tesp: '0.850', returnPlenum: '0.370', filterDrop: '0.120', supplyPlenum: '0.140' };
const REAL_AFTER  = { ...AFTER,  date: '2026-08-28', totalFlow: '1030', tesp: '0.350', returnPlenum: '0.380', filterDrop: '0.090', supplyPlenum: '0.340' };

async function realJob(page) {
  await upload(page, 1, trueFlowPdf(REAL_BEFORE));
  await upload(page, 2, trueFlowPdf(REAL_AFTER));
  await page.click('#gen');
}

test('the real job: nothing on the report reads as a failure', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await realJob(page);
  eq(await page.$$eval('.mbadge.b, .mbadge.w, .hcell.b, .hcell.w, .ben.b, .bcomp .row.b', els => els.length), 0,
    'no red or amber anywhere on a job that did what it set out to do');
  ok(!/Review/.test(await page.$eval('.hero', e => e.textContent)), 'no "Review" verdict in the headline row');
  await page.close();
});

test('the real job: a return plenum up 2.7% against airflow up 21.2% reads as progress', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await realJob(page);
  ok(/\bg\b/.test(await badgeFor(page, 'Return Plenum')), 'scored as an improvement');
  const row = await compactRow(page, 'Return Plenum');
  ok(/Up 2.7%, against 21.2% more airflow/.test(row.text), 'both figures quoted together');
  ok(/improving, not restricting/.test(row.text), 'and the conclusion drawn for the reader');
  ok(!/worth confirming|restricting more than it was/.test(row.text), 'no trace of the old alarm');
  await page.close();
});

test('the real job: a supply plenum up 142.9% is explained against the total that fell', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await realJob(page);
  const row = await compactRow(page, 'Supply Plenum');
  ok(/\bn\b/.test(row.cls), 'neutral — a component, not a verdict');
  ok(/Up 142.9%/.test(row.text) && /21.2% more air/.test(row.text), 'the real numbers, not rounded away');
  ok(/fell 58.8%/.test(row.text), 'anchored to the total external static drop');
  ok(/not the result/.test(row.text), 'framed as a component of the outcome');
  await page.close();
});

test('a row label and the prose beside it quote the same number', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await realJob(page);
  const row = await compactRow(page, 'Return Plenum');
  ok(/↑ 2.7%/.test(row.text), `label should read 2.7%, not a rounded 3% — got "${row.text.slice(0, 60)}"`);
  await page.close();
});

test('a job that missed its goals still says so, through the metrics that judge it', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  await report(page, {
    '#rvrows input[data-key="totalFlow"][data-pos="a"]': '640',    // airflow fell
    '#rvrows input[data-key="tesp"][data-pos="a"]': '0.950',       // static rose
    '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '0.700',
  });
  eq(await page.$$eval('.metric .mbadge.b', els => els.length), 2, 'airflow and TESP both flag red');
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/Airflow decreased — worth investigating/.test(txt), 'the airflow loss is stated plainly');
  ok(/the blower is working harder/i.test(txt), 'so is the static rise');
  const row = await compactRow(page, 'Return Plenum');
  ok(/\bn\b/.test(row.cls), 'the component stays neutral');
  ok(/read alongside total airflow and total external static/.test(row.text),
    'and points at the metrics carrying the verdict rather than claiming a win');
  ok(!/improving, not restricting|carrying considerably more air/.test(row.text),
    'no success claimed on a job that did not succeed');
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

/**
 * "New comparison" calls location.reload(). Waiting for a selector afterwards
 * matches the OLD document before navigation even starts, so the next steps
 * race the reload. window.__printed is set by stubPrint and wiped by the
 * reload, which makes it a reliable "the new document is up" signal.
 */
async function resetApp(page) {
  await page.click('#resetBtn');
  await page.waitForFunction(
    () => window.__printed === undefined && !!document.getElementById('gen'),
    null, { timeout: 15000 });
  await pickReport(page);
}

/**
 * Names in the saved list, once it has settled on the expected count.
 * renderHistory() is async, so typing in the search box updates the DOM a tick
 * later — reading it straight after fill() races the re-render.
 */
async function histNames(page, expected) {
  await page.waitForFunction(n => document.querySelectorAll('.hname').length === n,
    expected, { timeout: 10000 });
  return page.$$eval('.hname', els => els.map(e => e.textContent));
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
  await resetApp(page);
  await stubPrint(page);
  await report(page, { '#cName': 'Wanda Klassen', '#cAddr': 'Cumberland' });
  await printReport(page);

  await page.click('#histToggle');
  eq((await histNames(page, 2)).length, 2, 'both listed');
  await page.fill('#histSearch', 'klass');
  eq(await histNames(page, 1), ['Wanda Klassen'], 'filtered by name');
  await page.fill('#histSearch', 'cumberland');
  eq(await histNames(page, 1), ['Wanda Klassen'], 'filtered by address');
  await page.fill('#histSearch', 'zzz');
  await page.waitForSelector('.hempty');
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
  // A first install must not bounce the page; if it did, this would be > 0.
  eq(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1, 'no reload on first install');
  const cached = await cachedPaths(page);
  for (const want of ['/index.html', '/vendor/pdf.min.js', '/vendor/pdf.worker.min.js',
                      '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
                      '/app/core.js', '/app/parser.js', '/app/intake.js',
                      '/app/report.js', '/app/history.js', '/app/pwa.js']) {
    ok(cached.some(p => p.endsWith(want)), `${want} is cached — got ${cached.join(', ')}`);
  }
  await page.close();
});

test('the app loads with the network cut', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  await page.appContext.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await pickReport(page);
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
  await pickReport(page);

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

/* The write-ups are picked by arithmetic over the measurements, not written by
   anything that has to be reached over a network. This drives the hardest case
   — where the wording depends on comparing one metric against another — with
   the connection cut, and checks the same sentences come out. */
test('the write-ups choose the right wording with the network cut', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  await page.appContext.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await pickReport(page);

  await realJob(page);

  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/Airflow rose 21.2%/.test(txt), 'the airflow write-up quotes the real figure');
  ok(/dropped 58.8%/.test(txt), 'so does the static-pressure one');

  // Needs return plenum (+2.7%) compared against airflow (+21.2%) to pick this.
  const ret = await compactRow(page, 'Return Plenum');
  ok(/\bg\b/.test(ret.cls), 'scored against the airflow gain, offline');
  ok(/improving, not restricting/.test(ret.text), 'and picked the right one of four variants');

  // Needs supply plenum (+142.9%) compared against airflow, then anchored to TESP.
  const sup = await compactRow(page, 'Supply Plenum');
  ok(/\bn\b/.test(sup.cls), 'neutral, offline');
  ok(/fell 58.8%/.test(sup.text), 'and still reaches across to the TESP drop');

  eq(await page.$$eval('.mbadge.b, .mbadge.w, .bcomp .row.b', els => els.length), 0,
    'nothing reads as a failure offline either');

  await page.appContext.setOffline(false);
  await page.close();
});

const shown = (page, sel) => page.$eval(sel, e => getComputedStyle(e).display !== 'none');

test('going offline is announced, and the notice clears when signal returns', async ({ browser, origin }) => {
  const page = await openApp(browser, origin);
  ok(!(await shown(page, '#offlineStrip')), 'nothing shown while online');
  await page.appContext.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  ok(await shown(page, '#offlineStrip'), 'the offline notice appears');
  ok(/still works/.test(await page.$eval('#offlineStrip', e => e.textContent)), 'and is reassuring, not alarming');
  await page.appContext.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok(!(await shown(page, '#offlineStrip')), 'and clears again');
  await page.close();
});

/* A `display` rule in the page's own stylesheet outranks the browser's
   [hidden]{display:none}, so setting .hidden silently stops working. That
   shipped once, leaving both PWA notices on screen permanently. This checks
   the whole document rather than the elements someone remembered to test. */
test('everything marked hidden is actually invisible', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: null });
  const showing = await page.evaluate(() =>
    [...document.querySelectorAll('[hidden]')]
      .filter(e => getComputedStyle(e).display !== 'none')
      .map(e => e.id || e.className || e.tagName));
  eq(showing, [], 'elements with the hidden attribute still rendering');
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

/* A released fix used to need two loads to appear: the app's own JS was served
   cache-first, so the first load after a deploy ran the previous version. That
   is how a shipped OCR change looked broken in the field. */
test('a deployed change to the app takes effect on the next load, not the one after', async ({ browser }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestar-fresh-'));
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['app', 'vendor', 'icons']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const { server, origin } = await serve(dir);
  try {
    const page = await openApp(browser, origin, { serviceWorker: true });
    await swReady(page);
    eq(await page.evaluate(() => window.__deployMarker), undefined, 'not there yet');

    // Ship a change to one of the app files.
    const f = path.join(dir, 'app', 'capacity.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\nwindow.__deployMarker = "shipped";\n');

    await page.reload({ waitUntil: 'load' });
    eq(await page.evaluate(() => window.__deployMarker), 'shipped',
      'the very next load runs the new code');
    await page.close();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the app still loads from cache when the network is gone', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { serviceWorker: true });
  await swReady(page);
  await page.appContext.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await pickReport(page, 'capacity');
  ok(await page.$('#capHeads'), 'revalidating app code must not cost offline support');
  await page.appContext.setOffline(false);
  await page.close();
});

test('a new version waits for the tech, then takes over on request', async ({ browser }) => {
  // Serve a throwaway copy so the deployed files can be mutated mid-test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestar-pwa-'));
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['app', 'vendor', 'icons']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  const { server, origin } = await serve(dir);
  try {
    const page = await openApp(browser, origin, { serviceWorker: true });
    await swReady(page);
    ok(await page.$eval('#updateStrip', e => e.hidden), 'a first install is not an "update"');

    // Ship a new release. Read the version out rather than assuming one, so
    // bumping sw.js for a real change cannot quietly neuter this test.
    const swSrc = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    const current = swSrc.match(/const VERSION = '([^']+)'/);
    ok(current, 'sw.js declares a VERSION');
    const bumped = swSrc.replace(current[0], "const VERSION = 'test-next'");
    ok(bumped !== swSrc, 'the new release really differs from the old one');
    fs.writeFileSync(path.join(dir, 'sw.js'), bumped);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });

    await page.waitForSelector('#updateStrip:not([hidden])', { timeout: 30000 });
    ok(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting),
      'the new version is waiting, not running');
    eq(await page.evaluate(() => caches.keys().then(k => k.sort())),
      [`homestar-${current[1]}`, 'homestar-test-next'].sort(),
      'the new cache is built while the old version keeps serving');

    await page.click('#updateNow');
    // The page reloads itself when the new worker takes control, so poll from
    // node across the navigation rather than from inside the page.
    await pollEval(page, () => caches.keys().then(k => k.sort().join()),
      names => names === 'homestar-test-next');
    await swReady(page);
    ok(await page.$('#gen'), 'the app came back up on the new version');
    await page.close();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- capacity report */

/** A believable ductless job: three heads, all improved, heating. */
const CAP_JOB = {
  heads: [
    {location:'Living Room', unitType:'Wall mount', model:'MSZ-FS15NA', serial:'A1122',
     before:{btuh:'8400', returnTemp:'68.4', returnRh:'41', supplyTemp:'103.8', airflow:'663'},
     after: {btuh:'9950', returnTemp:'68.9', returnRh:'40', supplyTemp:'112.2', airflow:'663'}},
    {location:'Master Bedroom', unitType:'Wall mount', model:'MSZ-FS09NA', serial:'B4471',
     before:{btuh:'5900', returnTemp:'67.1', supplyTemp:'99.4', airflow:'388'},
     after: {btuh:'6050', returnTemp:'67.4', supplyTemp:'101.0', airflow:'388'}},
    {location:'Basement', unitType:'Slim ducted', model:'SEZ-KD12NA', serial:'C9080',
     before:{btuh:'7100', returnTemp:'66.2', supplyTemp:'96.8', airflow:'420', airflowSource:'measured'},
     after: {btuh:'8600', returnTemp:'66.5', supplyTemp:'104.1', airflow:'455', airflowSource:'measured'}},
  ],
  outdoor: {model:'MXZ-3C30NAHZ', serial:'OD-55231', rated:'22000', ratedTemp: '35'},
};

const capPage = async (browser, origin, job = CAP_JOB) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, job);
  return page;
};

/* ---- chooser ---- */

test('the chooser offers three report types and routes to the right form', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: null });
  eq(await page.$$eval('#chooser [data-rt]', els => els.map(e => e.dataset.rt)),
    ['airflow', 'capacity', 'combination'], 'three ways in');
  ok(await page.$eval('#tool', e => e.hidden) && await page.$eval('#capCard', e => e.hidden),
    'neither form is shown until one is picked');

  await pickReport(page, 'capacity');
  ok(await page.$eval('#tool', e => e.hidden), 'the airflow uploader stays out of the way');
  ok(!(await page.$eval('#capCard', e => e.hidden)), 'the capacity form appears');
  ok(!(await page.$eval('#clientCard', e => e.hidden)), 'client details are available to every report type');

  await page.click('#rtBack');
  await pickReport(page, 'airflow');
  ok(!(await page.$eval('#tool', e => e.hidden)), 'and back to airflow');
  ok(await page.$eval('#capCard', e => e.hidden), 'capacity form hidden again');
  await page.close();
});

/* ---- entry flow ---- */

test('choosing a head count renders exactly that many units', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  eq(await page.$$eval('.caphd', els => els.length), 1, 'starts at one');
  await page.selectOption('#capCount', '3');
  eq(await page.$$eval('.caphd', els => els.length), 3, 'three heads, no spare blocks');
  await page.selectOption('#capCount', '5');
  eq(await page.$$eval('.caphd', els => els.length), 5, 'five');
  await page.close();
});

test('reducing the head count keeps what was already entered', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, CAP_JOB);
  await page.selectOption('#capCount', '2');
  eq(await page.evaluate(() => CAP.heads.map(h => h.location)), ['Living Room', 'Master Bedroom'],
    'the earlier heads survive');
  await page.close();
});

test('one head is open at a time and Done moves to the next', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '3');
  eq(await page.$$eval('.caphd.open', els => els.length), 1, 'exactly one expanded');
  await page.selectOption('.caphd.open select[data-key="location"]', 'Kitchen');
  await page.fill('.caphd.open input[data-key="model"]', 'MSZ-TEST');
  await page.fill('#capB-0-before', '7000');
  await page.fill('#capB-0-after', '7900');
  eq(await page.evaluate(() => [CAP.heads[0].location, CAP.heads[0].model, CAP.heads[0].after.btuh]),
    ['Kitchen', 'MSZ-TEST', '7900'], 'typed into the state');
  await page.click('.caphd.open [data-next]');
  eq(await page.evaluate(() => CAP.open), 1, 'moved on to unit 2');
  eq(await page.$$eval('.caphd.done', els => els.length), 1, 'unit 1 collapsed as complete');
  await page.close();
});

test('Generate stays disabled until every unit has an area and both readings', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '2');
  ok(await page.$eval('#gen', e => e.disabled), 'disabled while empty');
  await setCapacity(page, { heads: [CAP_JOB.heads[0], {location:'Den', before:{btuh:'5000'}, after:{btuh:''}}] });
  ok(await page.$eval('#gen', e => e.disabled), 'still disabled with one reading missing');
  await setCapacity(page, { heads: CAP_JOB.heads.slice(0, 2) });
  ok(!(await page.$eval('#gen', e => e.disabled)), 'enabled once both are complete');
  await page.close();
});

/* ---- mode ---- */

test('mode is detected from supply against return, either way', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'5000', returnTemp:'68', supplyTemp:'104'}, after:{btuh:'5500', returnTemp:'68', supplyTemp:'108'}}] });
  eq(await page.evaluate(() => CAP.mode), 'heating', 'supply warmer than return');
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'5000', returnTemp:'75', supplyTemp:'56'}, after:{btuh:'5500', returnTemp:'75', supplyTemp:'54'}}] });
  eq(await page.evaluate(() => CAP.mode), 'cooling', 'supply cooler than return');
  await page.close();
});

test('mode falls back to supply alone, and a manual choice stops the detection', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'5000', supplyTemp:'104'}, after:{btuh:'5500', supplyTemp:'108'}}] });
  eq(await page.evaluate(() => CAP.mode), 'heating', 'one probe is enough to guess');
  await page.click('#capModeSwitch');
  eq(await page.evaluate(() => [CAP.mode, CAP.modeManual]), ['cooling', true], 'overridden');
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'5000', returnTemp:'68', supplyTemp:'110'}, after:{btuh:'5500', returnTemp:'68', supplyTemp:'112'}}] });
  eq(await page.evaluate(() => CAP.mode), 'cooling', 'detection does not overrule the tech');
  await page.close();
});

/* ---- the report ---- */

test('an after-only photo set still sits in the right-hand column', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await addCapacityPhotos(page, 'after', 2);
  await page.click('#gen');
  eq(await page.$$eval('.capcol', els => els.map(e => e.className.replace('capcol ', ''))), ['after'], 'only the after column');
  eq(await page.$eval('.capcol.after', e => getComputedStyle(e).gridColumnStart), '2',
    'and it stays on the right rather than sliding left');
  await page.close();
});

test('the capacity report is titled System Capacity Report', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const h = await page.$eval('#sheet h2', e => e.textContent);
  ok(/System Capacity Report/.test(h), `got "${h}"`);
  ok(!/Maintenance Capacity/.test(h), 'the old name is gone');
  await page.close();
});

test('the technician defaults to Calvin Windsor', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  eq(await page.$eval('#cTech', e => e.value), 'Calvin Windsor', 'prefilled');
  await page.close();
});

/* The action row and the connection notices have both leaked onto paper by
   sitting outside .tool. Printing is now "the report and nothing else", and
   this checks the printed page itself rather than any one selector. */
test('no page controls reach the printed report, in any report type', async ({ browser, origin }) => {
  for (const type of ['airflow', 'capacity', 'combination']) {
    const page = await openApp(browser, origin, { reportType: type });
    if (type !== 'capacity') { await upload(page, 1, before); await upload(page, 2, after); }
    if (type !== 'airflow') await setCapacity(page, CAP_JOB);
    await page.click('#gen');
    const printed = (await pageTexts(await page.pdf(LETTER))).join(' ');
    for (const control of ['Generate report', 'Generate combined report', 'Change report type',
                           'Print / Save as PDF', 'Save to history', 'New comparison',
                           'Saved reports', 'Confirm & correct', 'Update available']) {
      ok(!printed.includes(control), `"${control}" printed on the ${type} report`);
    }
    await page.close();
  }
});

test('the entry form shows no probe serials and no electrical fields', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.evaluate(() => { CAP.open = 0; renderHeads(); });
  await page.click('.caphd.open details summary');
  // The disclosure holds a block per phase; one block is enough to check.
  const labels = await page.$eval('.caphd.open .capsub',
    el => [...el.querySelectorAll('label')].map(e => e.textContent.trim()));
  eq(labels, ['Return °F', 'Return %RH', 'Supply °F', 'Supply %RH', 'Airflow CFM', 'Airflow from'],
    'supporting readings, with no serials and no Hz/Volts');
  const allLabels = await page.$$eval('.caphd.open .capsub label', els => els.map(e => e.textContent).join(' '));
  ok(!/651|877|198|217/.test(allLabels), 'no probe serials anywhere in the form');
  eq(await page.$$eval('.caphd.open [data-key="hz"], .caphd.open [data-key="volts"]', els => els.length), 0,
    'the clamp-meter fields are gone');
  await page.close();
});

test('a screenshot fills the supporting readings in the form, not just the state', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '1');
  await page.evaluate(t => ocrReview(0, 'before', parseTesto(t)), TESTO_OUTPUT_TEXT);
  await page.click('[data-use="0:before"]');
  const fields = await page.$$eval('.caphd.open .capsub input',
    els => Object.fromEntries(els.filter(e => e.dataset.phase === 'before').map(e => [e.dataset.key, e.value])));
  eq([fields.returnTemp, fields.returnRh, fields.supplyTemp, fields.supplyRh],
    ['68.8', '95', '50.3', '81'], 'the boxes on screen show the readings, not just CAP');
  ok(await page.$eval('.caphd.open details', e => e.open), 'and the section is open so they are visible');
  await page.close();
});

test('the capacity report totals the heads and compares them with the rated figure', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/21,400/.test(txt) && /24,600/.test(txt), 'system total before and after');
  ok(/22,000/.test(txt), 'the outdoor rated figure');
  ok(/11.8%/.test(txt), 'measured against rated');
  eq(await page.$$eval('.capcard', els => els.length), 3, 'one card per indoor unit');
  ok(/Living Room/.test(txt) && /Slim ducted/.test(txt) && /SEZ-KD12NA/.test(txt), 'each unit is identified');
  await page.close();
});

test('capacity that barely moved is reported as holding steady, not as a win', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'6000', returnTemp:'68', supplyTemp:'104'}, after:{btuh:'6060', returnTemp:'68', supplyTemp:'104'}}],
    outdoor: {rated:'6000'} });
  await page.click('#gen');
  const card = await page.$eval('.capcard', e => ({ cls: e.querySelector('.capdelta').className, t: e.textContent }));
  ok(/\bn\b/.test(card.cls), `a 1% change is neutral, got "${card.cls}"`);
  ok(/holding steady/.test(card.t), 'and says so plainly');
  await page.close();
});

test('a real capacity loss is flagged rather than dressed up', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, { heads: [{location:'Den', before:{btuh:'8000', returnTemp:'68', supplyTemp:'104'}, after:{btuh:'6400', returnTemp:'68', supplyTemp:'96'}}] });
  await page.click('#gen');
  ok(/\bb\b/.test(await page.$eval('.capdelta', e => e.className)), 'scored as a loss');
  ok(/Review/.test(await page.$eval('.capcell', e => e.textContent)), 'and the headline says review');
  await page.close();
});

test('the report states the outdoor temperature the rating is quoted at', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/Outdoor temperature/.test(txt) && /35°F/.test(txt), 'the outdoor temperature is on the report');
  ok(/rated at 35°F/.test(txt), 'and the rated figure is tied to it');
  ok(/Capacity moves with outdoor conditions/.test(txt), 'with the conditions caveat');
  await page.close();
});

test('no probe serial numbers reach the report', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const txt = await page.$eval('#sheet', e => e.textContent);
  for (const serial of ['651', '877', '198', '217']) {
    ok(!new RegExp(`\\b${serial}\\b`).test(txt), `probe serial ${serial} should not be on a customer's report`);
  }
  await page.close();
});

test('each indoor unit lists its type, model and serial on their own lines', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const card = await page.$eval('.capcard', e => ({
    name: e.querySelector('.capcardn').textContent.trim(),
    lines: [...e.querySelectorAll('.capcardi')].map(x => x.textContent.trim()),
  }));
  eq(card.name, 'Living Room', 'area is the heading');
  eq(card.lines, ['Wall mount', 'MSZ-FS15NA', 'S/N A1122'], 'three lines beneath it');
  await page.close();
});

test('the rated comparison carries its diversity caveat', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.click('#gen');
  const txt = await page.$eval('#sheet', e => e.textContent);
  ok(/nominal indoor conditions/.test(txt), 'nominal-condition caveat');
  ok(/diversity/.test(txt) && /not a commissioning figure/.test(txt), 'diversity caveat');
  ok(/sensible \+ latent/.test(txt), 'the capacity figure is labelled for what it is');
  await page.close();
});

test('multiple before and after photos render as labelled galleries', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await addCapacityPhotos(page, 'before', 3);
  await addCapacityPhotos(page, 'after', 2);
  await page.click('#gen');
  eq(await page.$$eval('.capcol', els => els.map(e => e.querySelector('.capgt').textContent)),
    ['Before', 'After'], 'two columns');
  eq(await page.$$eval('.capcol.before .capshot img', els => els.length), 3, 'before photos on the left');
  eq(await page.$$eval('.capcol.after .capshot img', els => els.length), 2, 'after photos on the right');
  const cols = await page.$$eval('.capcol', els => els.map(e => getComputedStyle(e).gridColumnStart));
  eq(cols, ['1', '2'], 'before is column one, after is column two');
  await page.close();
});

test('a photo can be removed from a gallery', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await addCapacityPhotos(page, 'before', 3);
  await page.click('#capTb .capx');
  eq(await page.evaluate(() => CAP.photos.before.length), 2, 'one dropped');
  await page.click('#gen');
  eq(await page.$$eval('.capshot img', els => els.length), 2, 'and it is out of the report');
  await page.close();
});

/* ---- combination ---- */

async function combinationPage(browser, origin) {
  const page = await openApp(browser, origin, { reportType: 'combination' });
  await upload(page, 1, before);
  await upload(page, 2, after);
  await setCapacity(page, CAP_JOB);
  return page;
}

test('a combination report is one document with both halves', async ({ browser, origin }) => {
  const page = await combinationPage(browser, origin);
  await page.click('#gen');
  const heads = await page.$$eval('#sheet .sh', els => els.map(e => e.textContent));
  ok(heads.includes('Summary Calculations — Before vs After'), 'the airflow half is there');
  ok(heads.includes('Indoor Units — Before vs After'), 'so is the capacity half');
  eq(await page.$$eval('#sheet .rhead', els => els.length), 1, 'one header for the whole document');
  eq(await page.$$eval('#sheet .rfoot', els => els.length), 1, 'one footer');
  eq(await page.$$eval('#sheet .capbreak', els => els.length), 1, 'capacity starts on a fresh sheet');
  await page.close();
});

test('a combination report waits for both halves before it can be generated', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'combination' });
  await upload(page, 1, before);
  await upload(page, 2, after);
  ok(await page.$eval('#gen', e => e.disabled), 'airflow alone is not enough');
  ok(/Finish the indoor units/.test(await page.$eval('#status', e => e.textContent)), 'and says what is missing');
  await setCapacity(page, CAP_JOB);
  ok(!(await page.$eval('#gen', e => e.disabled)), 'enabled once capacity is in too');
  await page.close();
});

/* ---- print ---- */

test('the capacity report prints without cutting a unit across a page', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await setCapacity(page, {
    heads: [1, 2, 3, 4, 5].map(n => ({
      location: ['Living Room','Kitchen','Master Bedroom','Office','Basement'][n - 1],
      unitType: 'Wall mount', model: `MSZ-TEST${n}`, serial: `SN${n}0000`,
      before: {btuh: String(5000 + n * 400), returnTemp:'68', supplyTemp:'104', airflow:'400'},
      after:  {btuh: String(5800 + n * 400), returnTemp:'68', supplyTemp:'110', airflow:'400'},
    })),
    outdoor: {model:'MXZ-5C42NAHZ', rated:'36000', ratedTemp: '35'},
  });
  await addCapacityPhotos(page, 'before', 2);
  await addCapacityPhotos(page, 'after', 2);
  await page.click('#gen');

  const pages = await pageTexts(await page.pdf(LETTER));
  ok(pages.length >= 2, `a five-head job needs more than one page, got ${pages.length}`);
  // Real pagination: a unit's name and both of its readings must land together.
  for (let n = 1; n <= 5; n++) {
    const name = ['Living Room','Kitchen','Master Bedroom','Office','Basement'][n - 1];
    const b = (5000 + n * 400).toLocaleString('en-CA');
    const a = (5800 + n * 400).toLocaleString('en-CA');
    const whole = pages.filter(t => t.includes(name) && t.includes(b) && t.includes(a));
    eq(whole.length, 1, `${name} should sit whole on one page (found on ${whole.length})`);
  }
  await page.close();
});

test('a combination report keeps the airflow half on its own pages', async ({ browser, origin }) => {
  const page = await combinationPage(browser, origin);
  await page.click('#gen');
  const pages = await pageTexts(await page.pdf(LETTER));
  ok(pages.length >= 3, `airflow's two pages plus capacity, got ${pages.length}`);
  // Section headers are uppercased by CSS, so they come out of the PDF in caps.
  const airflowPage = pages.findIndex(t => /Summary Calculations/i.test(t));
  const capacityPage = pages.findIndex(t => /Indoor Units/i.test(t));
  ok(airflowPage > -1 && capacityPage > -1, `both halves printed (airflow ${airflowPage}, capacity ${capacityPage})`);
  ok(capacityPage > airflowPage, 'capacity comes after airflow');
  ok(!/Indoor Units/i.test(pages[airflowPage]), 'and does not share a page with it');
  await page.close();
});

/* ---- history ---- */

test('a capacity job saves and reopens with its heads and outdoor unit', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await addCapacityPhotos(page, 'before', 2);
  await page.fill('#cName', 'Wanda Klassen');
  await page.click('#gen');
  await stubPrint(page);
  await printReport(page);

  const recs = await records(page);
  eq(recs.length, 1, 'filed');
  eq(recs[0].type, 'capacity', 'stored as a capacity job');
  eq(recs[0].cap.heads.length, 3, 'with all three heads');
  eq(recs[0].capPhotos.before.length, 2, 'and its photos');

  await page.reload();
  await page.click('#histToggle');
  await openFromHistory(page);
  eq(await page.evaluate(() => CAP.heads.map(h => h.location)),
    ['Living Room', 'Master Bedroom', 'Basement'], 'heads restored');
  eq(await page.evaluate(() => CAP.outdoor.rated), '22000', 'outdoor unit restored');
  eq(await page.evaluate(() => CAP.photos.before.length), 2, 'photos restored');
  ok(/24,600/.test(await page.$eval('#sheet', e => e.textContent)), 'and the report re-rendered');
  await page.close();
});

test('the saved list describes a capacity job in its own terms', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await page.fill('#cName', 'Wanda Klassen');
  await page.click('#gen');
  await stubPrint(page);
  await printReport(page);
  await page.click('#histToggle');
  const meta = await page.$eval('.hmeta', e => e.textContent);
  ok(/3 units/.test(meta) && /heating/.test(meta), `expected units and mode, got "${meta}"`);
  ok(/capacity/.test(meta), 'and the capacity change');
  await page.close();
});

/* ---------------------------------------------- reading Testo screenshots */

/* The engine runs in the page — no server, no key, nothing leaves the device.
   Nothing is ever filled in automatically: a capacity figure misread by a
   digit would go onto a customer's verification document, so a human picks. */

test('a screenshot is read and its readings offered as choices', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '1');
  await ocrRead(page, 0, 'before', '9,950');
  const chips = await page.$$eval('#capO-0-before .capchip', els => els.map(e => e.textContent.trim()));
  ok(chips.some(c => /9,950/.test(c)), `expected 9,950 among the choices, got ${JSON.stringify(chips)}`);
  await page.close();
});

test('nothing is filled in until a reading is tapped', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '1');
  await ocrRead(page, 0, 'before', '9,950');
  eq(await page.$eval('#capB-0-before', e => e.value), '', 'the field is still empty after reading');
  eq(await page.evaluate(() => CAP.heads[0].before.btuh), '', 'and so is the state');

  await page.click('#capO-0-before .capchip');
  eq(await page.$eval('#capB-0-before', e => e.value), '9950', 'tapping fills it');
  eq(await page.evaluate(() => CAP.heads[0].before.btuhSource), 'ocr', 'and records where it came from');
  ok(/Check it against the probe/.test(await page.$eval('#capO-0-before', e => e.textContent)),
    'and asks for it to be checked');
  await page.close();
});

test('the screenshot itself is never kept or printed', async ({ browser, origin }) => {
  const page = await capPage(browser, origin);
  await ocrRead(page, 0, 'after', '9,950');
  await page.click('#capO-0-after .capchip');
  eq(await page.$eval('#ocrFile', e => e.files.length), 0, 'the file input is cleared');
  eq(await page.evaluate(() => JSON.stringify(CAP).length < 20000), true, 'no image data held in state');
  await page.click('#gen');
  eq(await page.$$eval('#sheet img', els => els.filter(e => !e.className.includes('logo')).length), 0,
    'and no screenshot reaches the report');
  await page.close();
});

/* Text captured by running the real Testo screenshots through the real engine.
   Keeping it verbatim — misreads and all — means the parser is guarded without
   paying for OCR on every run. Note "95.0 %RH" on the output screen: the real
   value was 55.0. That misread is why extracted values are reviewed, not
   silently applied. */
const TESTO_OUTPUT_TEXT = `10:36 @ 8 Yl 83%m
= Cooling and Heating Output $08
Live Table
0]00:00:00
Current Value 33,540 BTU/h

BTUH
testo 605i + 651 : testo 605i 877 :
Return Air Supply Air
Air Temperature Air Temperature
68.8 °F 50.3 °F
Relative Humidity Relative Humidity
95.0 %RH 81.0 %RH
Dew Point Dew Point
52.0 °F 44.7 °F
Wet Bulb Temperature Wet Bulb Temperature
58.6 °F 47.3 °F
Absolute Humidity Absolute Humidity
9.77 g/m? 7.70 g/m?
| @ <`;

const TESTO_DT_TEXT = `10:36 © 8 Fal 83%m
= Differential Temperature (AT) $08
Live Graphic Table

0100:00:00 :
Current Value 1 8.5 °F
AT
testo 605i - 877 :
Air Temperature 50.3 °F
Relative Humidity 81.0 %rH
Dew Point 44.7 °F
Wet Bulb Temperature 47.3 °F
Absolute Humidity 7.70 g/m?
testo 605i © 651 :
Air Temperature 68.8 °F
Relative Humidity 54.9 %RrH
Dew Point 51 9 °F
Wet Bulb Temperature 58.6 °F
Absolute Humidity 9.75 gm?

1 O <`;

const parse = (page, text) => page.evaluate(t => parseTesto(t), text);

test('a real Cooling and Heating Output screen parses in full', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  eq(await parse(page, TESTO_OUTPUT_TEXT),
    {btuh: 33540, returnTemp: 68.8, returnRh: 95, supplyTemp: 50.3, supplyRh: 81},
    'capacity and both probes, columns read left to right');
  await page.close();
});

test('a real Differential Temperature screen maps probes by serial', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  eq(await parse(page, TESTO_DT_TEXT),
    {btuh: null, returnTemp: 68.8, returnRh: 54.9, supplyTemp: 50.3, supplyRh: 81},
    '651 is the return probe, 877 the supply; that screen carries no capacity');
  await page.close();
});

test('probe serials are never mistaken for a capacity', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  // This was the reported bug: the ΔT screen offered 877, 651 and 198 as readings.
  eq((await parse(page, TESTO_DT_TEXT)).btuh, null, 'no capacity invented from a screen that has none');
  const chips = await page.evaluate(t => btuCandidates(t).map(c => c.value), TESTO_DT_TEXT);
  ok(chips.includes(651) || chips.includes(877), 'the loose fallback still would have offered them');
  await page.close();
});

test('a parsed screen fills the readings only after they are used', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '1');
  await page.evaluate(t => ocrReview(0, 'before', parseTesto(t)), TESTO_OUTPUT_TEXT);
  ok(/Check every value against the screen/.test(await page.$eval('#capO-0-before', e => e.textContent)),
    'the review panel asks for the values to be checked');
  eq(await page.evaluate(() => CAP.heads[0].before.btuh), '', 'nothing written yet');

  await page.click('[data-use="0:before"]');
  eq(await page.evaluate(() => {
    const b = CAP.heads[0].before;
    return [b.btuh, b.returnTemp, b.returnRh, b.supplyTemp, b.supplyRh, b.btuhSource];
  }), ['33540', '68.8', '95', '50.3', '81', 'ocr'], 'capacity and conditions all land');
  eq(await page.evaluate(() => CAP.mode), 'cooling', 'and the mode follows from supply being colder');
  await page.close();
});

test('parsed conditions reach the operating conditions section', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.selectOption('#capCount', '1');
  await page.evaluate(t => { ocrReview(0, 'before', parseTesto(t)); }, TESTO_OUTPUT_TEXT);
  await page.click('[data-use="0:before"]');
  await page.evaluate(t => { ocrReview(0, 'after', parseTesto(t)); }, TESTO_DT_TEXT);
  await page.click('[data-use="0:after"]');
  await page.evaluate(() => { CAP.heads[0].location = 'Living Room'; CAP.heads[0].after.btuh = '35000'; renderHeads(); setStatus(); });
  await page.click('#gen');
  const conds = await page.$eval('#sheet .captwo', e => e.textContent.replace(/\s+/g, ' '));
  ok(/RA 68.8°F \/ 95%/.test(conds), `before conditions printed, got "${conds}"`);
  ok(/SA 50.3°F \/ 81%/.test(conds), 'supply conditions printed');
  await page.close();
});

test('candidate readings are filtered to plausible capacities', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  const picked = await page.evaluate(() => btuCandidates(
    'Mode 3 Serial 12 Capacity 9,950 BTU/h Return 68.4 F 41 %rH Airflow 663 CFM Runtime 999999'
  ).map(c => [c.value, c.labelled]));
  const values = picked.map(p => p[0]);
  ok(values.includes(9950), 'the capacity figure is offered');
  ok(!values.includes(3) && !values.includes(12) && !values.includes(999999),
    `out-of-range numbers are dropped, got ${JSON.stringify(values)}`);
  eq(picked[0], [9950, true], 'the one labelled BTU comes first');
  await page.close();
});

test('an unreadable engine says so and leaves the field typeable', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  await page.route('**/vendor/tesseract/**', r => r.abort('failed'));
  await page.selectOption('#capCount', '1');
  await ocrRead(page, 0, 'before', '9,950');
  const msg = await page.$eval('#capO-0-before', e => e.textContent);
  ok(/type the values in/i.test(msg), `expected a fallback message, got "${msg}"`);
  await page.fill('#capB-0-before', '9950');
  eq(await page.evaluate(() => CAP.heads[0].before.btuh), '9950', 'typing still works');
  await page.close();
});

test('the read button opens a picker rather than doing nothing', async ({ browser, origin }) => {
  const page = await openApp(browser, origin, { reportType: 'capacity' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    page.click('[data-ocr="0:before"]'),
  ]);
  ok(chooser, 'the button must actually open the file picker');
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
