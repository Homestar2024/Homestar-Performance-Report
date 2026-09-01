/**
 * Capture what BROWSER pdf.js actually reads out of a real TEC export, so it
 * can be replayed as a fast regression fixture.
 *
 *   node tests/capture-text.mjs ~/Downloads/trueflow-before.pdf [name]
 *
 * Writes tests/fixtures/text/<name>.txt (the extracted text) and
 * <name>.json (what the parser found in it). Read the .json before committing
 * it — it is a snapshot of current behaviour, not a statement of correctness.
 * Fix any wrong value by hand and the suite will hold the parser to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { serve, launch, openApp, ROOT } from './lib/harness.mjs';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tests/capture-text.mjs <file.pdf> [fixture-name]');
  process.exit(1);
}
const name = (process.argv[3] || path.basename(src).replace(/\.pdf$/i, '')).replace(/[^\w.-]+/g, '-');
const outDir = path.join(ROOT, 'tests/fixtures/text');
fs.mkdirSync(outDir, { recursive: true });

const { server, origin } = await serve();
const browser = await launch();
const page = await openApp(browser, origin);

const buf = fs.readFileSync(src);
await page.setInputFiles('#f1', { name: path.basename(src), mimeType: 'application/pdf', buffer: buf });
await page.waitForFunction(() => {
  const d = document.getElementById('d1');
  return d.classList.contains('set') || d.classList.contains('err');
}, null, { timeout: 30000 });

const { text, data, ok } = await page.evaluate(async () => {
  const file = document.getElementById('f1').files[0];
  const text = await readPDF(file);
  return { text, data: extract(text), ok: slots[1].ok };
});

fs.writeFileSync(path.join(outDir, name + '.txt'), text);
const keys = ['date', 'totalFlow', 'returnDuct', 'afterFilter', 'supplyDuct', 'tesp', 'returnPlenum', 'filterDrop', 'supplyPlenum', 'orientation', 'email', 'tech', 'company'];
const snap = Object.fromEntries(keys.map(k => [k, data[k]]));
fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(snap, null, 2) + '\n');

console.log(`\ncaptured ${text.length} chars -> tests/fixtures/text/${name}.txt`);
console.log(ok ? '' : 'WARNING: the app treated this file as unreadable.\n');
console.log('parsed:');
for (const [k, v] of Object.entries(snap)) {
  const flag = v == null ? '  \x1b[31m<- not found\x1b[0m' : '';
  console.log(`  ${k.padEnd(14)} ${v ?? '—'}${flag}`);
}
console.log('\nCheck those values against the PDF, correct the .json by hand if needed, then commit both files.');

await browser.close();
server.close();
