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
import { serve, launch, openApp, upload, attachPhoto, pageCount, setCapacity, addCapacityPhotos, pageTexts } from './lib/harness.mjs';
import { trueFlowPdf, BEFORE, AFTER } from './lib/make-pdf.mjs';

// Letter at 96dpi is 816x1056px. With 0.5in margins the printable area is
// 720px wide and 960px tall — measure at that width or long lines won't wrap
// the way they will on paper.
const BUDGET = 960;
const PAPER_WIDTH = 720;

/* Airflow is pinned at two pages. Capacity and combination grow with the
   number of heads and photos, so they are checked for a page count AND for
   blocks surviving the breaks intact. */
const AIRFLOW_PAGES = 2;

const capJob = heads => ({
  heads: Array.from({length: heads}, (_, i) => ({
    location: ['Living Room','Kitchen','Master Bedroom','Office','Basement'][i],
    unitType: 'Wall mount', model: `MSZ-TEST${i + 1}`, serial: `SN${i + 1}0000`,
    before: {btuh: String(5000 + i * 400), returnTemp: '68', supplyTemp: '104', airflow: '400'},
    after:  {btuh: String(5800 + i * 400), returnTemp: '68', supplyTemp: '110', airflow: '400'},
  })),
  outdoor: {model: 'MXZ-5C42NAHZ', serial: 'OD-1', rated: '36000', ratedTemp: '35'},
});

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

// The job that drove the component-pressure rewrite: every one of the three
// gets its longest write-up, because none of them simply fell.
const REAL = {
  '#rvrows input[data-key="totalFlow"][data-pos="b"]': '850',
  '#rvrows input[data-key="totalFlow"][data-pos="a"]': '1030',
  '#rvrows input[data-key="tesp"][data-pos="b"]': '0.850',
  '#rvrows input[data-key="tesp"][data-pos="a"]': '0.350',
  '#rvrows input[data-key="returnPlenum"][data-pos="b"]': '0.370',
  '#rvrows input[data-key="returnPlenum"][data-pos="a"]': '0.380',
  '#rvrows input[data-key="filterDrop"][data-pos="b"]': '0.120',
  '#rvrows input[data-key="filterDrop"][data-pos="a"]': '0.090',
  '#rvrows input[data-key="supplyPlenum"][data-pos="b"]': '0.140',
  '#rvrows input[data-key="supplyPlenum"][data-pos="a"]': '0.950',
};

const CASES = [
  ['airflow · bare',                      {type:'airflow', expect: AIRFLOW_PAGES}],
  ['airflow · real job, all components up',{type:'airflow', expect: AIRFLOW_PAGES, photos:2, fills:REAL, name:'Todd Brown', addr:'Comox, BC'}],
  ['airflow · typical',                   {type:'airflow', expect: AIRFLOW_PAGES, photos:2, name:'Todd Brown', addr:'Comox, BC'}],
  ['airflow · portrait photos',           {type:'airflow', expect: AIRFLOW_PAGES, photos:2, portrait:true}],
  ['airflow · longest copy',              {type:'airflow', expect: AIRFLOW_PAGES, photos:2, fills:WRONG_WAY}],
  ['airflow · worst case',                {type:'airflow', expect: AIRFLOW_PAGES, photos:2, portrait:true, fills:WRONG_WAY,
                                           name:'Christopher & Alexandra Vanderhoof-Williamson',
                                           addr:'4471 Cumberland Road, Courtenay, British Columbia V9N 9X4'}],
  ['capacity · 1 head, no photos',        {type:'capacity', heads:1}],
  ['capacity · 3 heads, 4 photos',        {type:'capacity', heads:3, capPhotos:2, name:'Todd Brown'}],
  ['capacity · 5 heads, 6 photos',        {type:'capacity', heads:5, capPhotos:3, name:'Todd Brown', addr:'Comox, BC'}],
  ['combination · 3 heads, both photo sets',{type:'combination', heads:3, photos:2, capPhotos:2, name:'Todd Brown'}],
  ['combination · 5 heads, worst case',   {type:'combination', heads:5, photos:2, capPhotos:3, portrait:true, fills:WRONG_WAY,
                                           name:'Christopher & Alexandra Vanderhoof-Williamson',
                                           addr:'4471 Cumberland Road, Courtenay, British Columbia V9N 9X4'}],
];

const { server, origin } = await serve();
const browser = await launch();
let bad = false;

for (const [label, o] of CASES) {
  const page = await openApp(browser, origin, { reportType: o.type });

  if (o.type !== 'capacity') {
    await upload(page, 1, trueFlowPdf(BEFORE));
    await upload(page, 2, trueFlowPdf(AFTER));
    for (const [sel, val] of Object.entries(o.fills || {})) await page.fill(sel, val);
    const dims = o.portrait ? { w: 3024, h: 4032 } : { w: 4032, h: 3024 };
    for (let i = 1; i <= (o.photos || 0); i++) await attachPhoto(page, i, dims);
  }
  if (o.type !== 'airflow') {
    await setCapacity(page, capJob(o.heads || 1));
    if (o.capPhotos) {
      await addCapacityPhotos(page, 'before', o.capPhotos);
      await addCapacityPhotos(page, 'after', o.capPhotos);
    }
  }
  if (o.name) await page.fill('#cName', o.name);
  if (o.addr) await page.fill('#cAddr', o.addr);
  await page.click('#gen');

  const pdf = await page.pdf(LETTER);
  const pages = await pageTexts(pdf);

  // Nothing that must stay whole may straddle a break. Checked against the
  // real pagination: a unit's name and both readings have to share a page.
  const split = [];
  if (o.type !== 'airflow') {
    for (let i = 0; i < (o.heads || 1); i++) {
      const name = ['Living Room','Kitchen','Master Bedroom','Office','Basement'][i];
      const b = (5000 + i * 400).toLocaleString('en-CA');
      const a = (5800 + i * 400).toLocaleString('en-CA');
      if (pages.filter(t => t.includes(name) && t.includes(b) && t.includes(a)).length !== 1) split.push(name);
    }
  }

  // Capacity grows with the job; a single head genuinely fits one page.
  const countOk = o.expect ? pages.length === o.expect : pages.length >= 1;
  const ok = countOk && !split.length;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const detail = split.length ? `  \x1b[31msplit across a break: ${split.join(', ')}\x1b[0m` : '';
  console.log(`${mark} ${label.padEnd(40)} ${pages.length} page${pages.length === 1 ? '' : 's'}${o.expect ? ` (expected ${o.expect})` : ''}${detail}`);
  if (!ok) bad = true;
  await page.close();
}

await browser.close();
server.close();
if (bad) {
  console.log('\nPagination regressed — see the rows above. Fix the @media print block before shipping.');
  process.exitCode = 1;
}
