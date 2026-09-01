/**
 * The print check, on its own, with the numbers behind it.
 *
 *   node tests/print-check.mjs
 *
 * Renders the report through Chrome's real print engine at Letter / 0.5in
 * margins and reports the page count plus how much vertical room is left on
 * each page. Run this after any change that could add height to the report.
 *
 * The report is TWO pages by design: measurements on page one, the benefit
 * write-ups and before/after photographs on page two.
 */
import { serve, launch, openApp, upload, attachPhoto, pageCount } from './lib/harness.mjs';
import { trueFlowPdf, BEFORE, AFTER } from './lib/make-pdf.mjs';

// Letter at 96dpi is 816x1056px. With 0.5in margins the printable area is
// 720px wide and 960px tall — measure at that width or long lines won't wrap
// the way they will on paper.
const BUDGET = 960;
const PAPER_WIDTH = 720;
const EXPECTED = 2;

const LETTER = {
  format: 'Letter', printBackground: true,
  margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
};

const WRONG_WAY = {
  '#rvrows input[data-key="totalFlow"][data-pos="a"]': '640',
  '#rvrows input[data-key="tesp"][data-pos="a"]': '0.950',
  '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '0.600',
  '#rvrows input[data-key="filterDrop"][data-pos="a"]': '0.240',
  '#rvrows input[data-key="supplyPlenum"][data-pos="a"]': '0.500',
};

const CASES = [
  ['bare (no photos, no client details)', {}],
  ['typical (both photos, client named)', { photos: 2, name: 'Todd Brown', addr: 'Comox, BC' }],
  ['one photo only', { photos: 1 }],
  ['portrait photos', { photos: 2, portrait: true }],
  ['longest copy (every metric worse)', { photos: 2, fills: WRONG_WAY }],
  ['worst case (long name, address, photos)', {
    photos: 2, portrait: true, fills: WRONG_WAY,
    name: 'Christopher & Alexandra Vanderhoof-Williamson',
    addr: '4471 Cumberland Road, Courtenay, British Columbia V9N 9X4',
  }],
];

const { server, origin } = await serve();
const browser = await launch();
let bad = false;

for (const [label, o] of CASES) {
  const page = await openApp(browser, origin);
  await upload(page, 1, trueFlowPdf(BEFORE));
  await upload(page, 2, trueFlowPdf(AFTER));
  for (const [sel, val] of Object.entries(o.fills || {})) await page.fill(sel, val);
  if (o.name) await page.fill('#cName', o.name);
  if (o.addr) await page.fill('#cAddr', o.addr);
  const dims = o.portrait ? { w: 3024, h: 4032 } : { w: 4032, h: 3024 };
  for (let i = 1; i <= (o.photos || 0); i++) await attachPhoto(page, i, dims);
  await page.click('#gen');

  const pages = await pageCount(await page.pdf(LETTER));

  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: PAPER_WIDTH, height: BUDGET });
  // The .page2 section starts the second sheet, so its offset is page one's height.
  const h = await page.evaluate(() => {
    const sheet = document.getElementById('sheet');
    const total = Math.ceil(sheet.getBoundingClientRect().height);
    const brk = sheet.querySelector('.page2');
    if (!brk) return [total];
    const one = Math.ceil(brk.getBoundingClientRect().top - sheet.getBoundingClientRect().top);
    return [one, total - one];
  });

  const mark = pages === EXPECTED ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const per = h.map((v, i) => `p${i + 1} ${v}px (${BUDGET - v}px spare)`).join('  ');
  console.log(`${mark} ${label.padEnd(38)} ${pages} pages   ${per}`);
  if (pages !== EXPECTED) bad = true;
  await page.close();
}

await browser.close();
server.close();
if (bad) {
  console.log(`\nThe report is no longer ${EXPECTED} pages. Trim the @media print block before shipping.`);
  process.exitCode = 1;
}
