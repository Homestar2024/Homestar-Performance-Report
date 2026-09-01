/**
 * The one-page print check, on its own, with the numbers behind it.
 *
 *   node tests/print-check.mjs
 *
 * Renders a report through Chrome's real print engine at Letter / 0.5in
 * margins and reports both the page count and how much vertical room is left.
 * Run this after any change that could add height to the report.
 */
import { serve, launch, openApp, upload, pageCount } from './lib/harness.mjs';
import { trueFlowPdf, BEFORE, AFTER } from './lib/make-pdf.mjs';

// Letter at 96dpi is 816x1056px. With 0.5in margins the printable area is
// 720px wide and 960px tall — measure at that width or long lines won't wrap
// the way they will on paper.
const BUDGET = 960;
const PAPER_WIDTH = 720;

const { server, origin } = await serve();
const browser = await launch();
let bad = false;

for (const [label, fill] of [
  ['minimal (no client name or address)', async () => {}],
  ['typical', async p => { await p.fill('#cName', 'Todd Brown'); await p.fill('#cAddr', 'Comox, BC'); }],
  ['worst case (long name and address)', async p => {
    await p.fill('#cName', 'Christopher & Alexandra Vanderhoof-Williamson');
    await p.fill('#cAddr', '4471 Cumberland Road, Courtenay, British Columbia V9N 9X4');
  }],
]) {
  const page = await openApp(browser, origin);
  await upload(page, 1, trueFlowPdf(BEFORE));
  await upload(page, 2, trueFlowPdf(AFTER));
  await fill(page);
  await page.click('#gen');

  const pdf = await page.pdf({
    format: 'Letter', printBackground: true,
    margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
  });
  const pages = await pageCount(pdf);

  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: PAPER_WIDTH, height: BUDGET });
  const h = await page.evaluate(() => Math.ceil(document.getElementById('sheet').getBoundingClientRect().height));

  const okMark = pages === 1 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${okMark} ${label.padEnd(38)} ${pages} page${pages === 1 ? '' : 's'}  ${h}px of ${BUDGET}px  (${BUDGET - h}px spare)`);
  if (pages !== 1) bad = true;
  await page.close();
}

await browser.close();
server.close();
if (bad) {
  console.log('\nThe report no longer fits on one page. Trim the @media print block before shipping.');
  process.exitCode = 1;
}
