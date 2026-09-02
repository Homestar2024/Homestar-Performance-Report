/**
 * Reading a BTU/h figure off a Testo screenshot.
 *
 * Tesseract runs entirely in the page — no server, no API key, nothing sent
 * anywhere. The screenshot is read and discarded; it is never stored and never
 * appears on the report, which shows data only.
 *
 * The engine is ~8.7MB, so it is NOT in the service worker's precache list —
 * that would make a first install crawl for a feature that is optional. It
 * loads on first use and the worker's runtime cache keeps it, so OCR needs a
 * connection once and works offline after that. Typing the number always works.
 *
 * Nothing is ever filled in automatically. Tesseract returns candidates, the
 * technician taps the right one. A capacity figure misread by one digit would
 * go onto a customer's verification document, so a human picks it — always.
 */

const OCR = {lib: null, worker: null, target: null, found: {}};

/* A plausible delivered-capacity reading. Anything outside this is not a
   BTU/h figure and only adds noise to the choices. */
const OCR_MIN_BTUH = 300;
const OCR_MAX_BTUH = 300000;

function loadScript(src){
  return new Promise((res, rej)=>{
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => res();
    el.onerror = () => rej(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
}

async function ocrWorker(onProgress){
  if (OCR.worker) return OCR.worker;
  if (!OCR.lib) OCR.lib = loadScript('./vendor/tesseract/tesseract.min.js');
  await OCR.lib;
  if (typeof Tesseract === 'undefined') throw new Error('reader unavailable');
  OCR.worker = await Tesseract.createWorker('eng', 1, {
    workerPath: './vendor/tesseract/worker.min.js',
    // Pinned to one core build rather than a directory: given a directory,
    // tesseract feature-detects and asks for whichever variant the device
    // prefers, which would mean shipping every one of them. SIMD has been
    // universal in Chrome since 2021; without it this fails cleanly and the
    // technician types the number.
    corePath:   './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    langPath:   './vendor/tesseract/',
    gzip: true,
    logger: m => { if (onProgress && m.status) onProgress(m); },
  });
  return OCR.worker;
}

/**
 * Pull plausible BTU/h readings out of recognised text.
 *
 * Only used when the structured parse below finds no capacity — for a
 * screenshot of a screen we do not recognise. Probe serials (651, 877) sit in
 * this range, which is exactly why the structured parse is tried first.
 */
function btuCandidates(text){
  const flat = String(text || '').replace(/\s+/g, ' ');
  const seen = new Map();
  const re = /(\d{1,3}(?:[.,]\d{3})+|\d{3,6})(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(flat)) !== null){
    const value = parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (!Number.isFinite(value) || value < OCR_MIN_BTUH || value > OCR_MAX_BTUH) continue;
    const around = flat.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
    const labelled = /btu/i.test(around);
    const prev = seen.get(value);
    if (!prev || (labelled && !prev.labelled)) seen.set(value, {value, labelled, around: around.trim()});
  }
  return [...seen.values()].sort((a, b) =>
    (b.labelled - a.labelled) || (b.value - a.value)).slice(0, 6);
}

/* ---------------------------- reading a Testo screen ---------------------- */

const numsOn = line => (String(line).match(/-?\d+(?:[.,]\d+)?/g) || [])
  .map(t => parseFloat(t.replace(',', '.')));

/**
 * Values from a "Cooling and Heating Output" screen, where the two probes sit
 * side by side and OCR reads across: the label line carries both captions and
 * the line under it carries both numbers, left column first.
 */
function parseTwoColumn(lines){
  const head = lines.findIndex(l => /Return\s*Air/i.test(l) && /Supply\s*Air/i.test(l));
  if (head < 0) return null;
  // Whichever caption comes first owns the left-hand number.
  const returnFirst = lines[head].search(/Return\s*Air/i) < lines[head].search(/Supply\s*Air/i);

  const pairUnder = re => {
    for (let i = head; i < lines.length - 1; i++){
      const hits = lines[i].match(re);
      if (hits && hits.length >= 2){
        const v = numsOn(lines[i + 1]);
        if (v.length >= 2) return v;
      }
    }
    return null;
  };
  const temps = pairUnder(/Air\s*Temperature/gi);
  const rh    = pairUnder(/Relative\s*Humidity/gi);
  if (!temps && !rh) return null;

  const pick = (arr, side) => !arr ? null : arr[(side === 'return') === returnFirst ? 0 : 1];
  return {
    returnTemp: pick(temps, 'return'), supplyTemp: pick(temps, 'supply'),
    returnRh:   pick(rh, 'return'),    supplyRh:   pick(rh, 'supply'),
  };
}

/**
 * Values from a screen that stacks one card per probe (the ΔT screen). The
 * cards are titled by probe serial, which the PROBES table maps to a role —
 * this is what that table is for.
 */
function parseProbeCards(lines){
  const roleOf = serial =>
    serial === PROBES.returnAir.serial ? 'return' :
    serial === PROBES.supplyAir.serial ? 'supply' : null;

  const out = {};
  let role = null;
  for (const line of lines){
    const head = line.match(/605i\s*\D{0,3}\s*(\d{3})/i);
    if (head){ role = roleOf(head[1]); continue; }
    if (!role) continue;
    if (/Air\s*Temperature/i.test(line)){
      const v = numsOn(line.replace(/605i/gi, ''));
      if (v.length) out[role + 'Temp'] = v[v.length - 1];
    } else if (/Relative\s*Humidity/i.test(line)){
      const v = numsOn(line);
      if (v.length) out[role + 'Rh'] = v[v.length - 1];
    }
  }
  return Object.keys(out).length ? out : null;
}

const plausible = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi) ? v : null;

/**
 * Everything a Testo screenshot can give us for one phase. Anything the layout
 * does not contain simply comes back null; nothing here guesses.
 */
function parseTesto(text){
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const found = {btuh: null, returnTemp: null, returnRh: null, supplyTemp: null, supplyRh: null};

  // Anchored on the unit, so probe serials cannot be mistaken for a capacity.
  const cap = String(text).match(/([\d][\d.,]*)\s*BTU\s*\/?\s*[Hh]/);
  if (cap){
    const v = parseInt(cap[1].replace(/[.,]/g, ''), 10);
    found.btuh = plausible(v, OCR_MIN_BTUH, OCR_MAX_BTUH);
  }

  const conds = parseTwoColumn(lines) || parseProbeCards(lines) || {};
  found.returnTemp = plausible(conds.returnTemp, -40, 200);
  found.supplyTemp = plausible(conds.supplyTemp, -40, 200);
  found.returnRh   = plausible(conds.returnRh, 0, 100);
  found.supplyRh   = plausible(conds.supplyRh, 0, 100);
  return found;
}

function ocrPanel(i, phase){ return $(`capO-${i}-${phase}`); }

/* The panels sit under both BTU fields rather than inside one of them, so
   each has to say which reading it belongs to. */
const phaseWord = phase => phase === 'before' ? 'Before' : 'After';

function ocrSay(i, phase, html){
  const el = ocrPanel(i, phase);
  if (el) el.innerHTML = html;
}

/** Chips, for a screen we could not parse but which held plausible numbers. */
function ocrOffer(i, phase, list){
  if (!list.length){
    ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — nothing readable in that screenshot. Type the values in instead.</div>`);
    return;
  }
  ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — tap the reading that matches the screenshot:</div>
    <div class="capocrpick">${list.map(c =>
      `<button type="button" class="capchip${c.labelled ? ' lab' : ''}" data-pick="${i}:${phase}:${c.value}">
         ${fmt(c.value, 0)}${c.labelled ? ' <span>BTU</span>' : ''}
       </button>`).join('')}</div>`);
}

const OCR_ROWS = [
  {label: 'Capacity',   parts: [['btuh', v => `${fmt(v, 0)} BTU/h`]]},
  {label: 'Return air', parts: [['returnTemp', v => `${v} °F`], ['returnRh', v => `${v} %RH`]]},
  {label: 'Supply air', parts: [['supplyTemp', v => `${v} °F`], ['supplyRh', v => `${v} %RH`]]},
];

/**
 * Show everything the screenshot gave up and wait. Nothing is written until
 * "Use these" is tapped — a real screenshot in testing had 55.0 %RH read back
 * as 95.0, so these have to be looked at before they go anywhere near a
 * customer's report.
 */
function ocrReview(i, phase, found){
  const rows = OCR_ROWS
    .map(r => [r.label, r.parts.filter(([k]) => found[k] != null).map(([k, f]) => f(found[k])).join(' · ')])
    .filter(([, v]) => v);
  if (!rows.length) return false;

  OCR.found[`${i}:${phase}`] = found;
  ocrSay(i, phase, `
    <div class="capocrmsg"><b>${phaseWord(phase)}</b> — read from the screenshot. <b>Check every value against the screen</b> before using it; the reader can misread a digit.</div>
    <div class="capocrrows">${rows.map(([k, v]) =>
      `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <button type="button" class="capbtn small" data-use="${i}:${phase}">Use these readings</button>`);
  return true;
}

function ocrApply(i, phase){
  const found = OCR.found[`${i}:${phase}`];
  if (!found) return;
  const ph = CAP.heads[i][phase];
  if (found.btuh != null){ ph.btuh = String(found.btuh); ph.btuhSource = 'ocr'; }
  for (const k of ['returnTemp', 'returnRh', 'supplyTemp', 'supplyRh']){
    if (found[k] != null) ph[k] = String(found[k]);
  }
  clearReport();
  refreshMode();
  renderHeads();          // reopens the supporting readings so the values show
  ocrSay(i, phase, `<div class="capocrmsg ok"><b>${phaseWord(phase)}</b> — readings filled in below. Correct anything the reader got wrong before generating.</div>`);
  capStatusLine();
  setStatus();
}

function ocrAccept(i, phase, value){
  const head = CAP.heads[i];
  head[phase].btuh = String(value);
  head[phase].btuhSource = 'ocr';
  clearReport();
  const input = $(`capB-${i}-${phase}`);
  if (input) input.value = String(value);
  ocrSay(i, phase, `<div class="capocrmsg ok"><b>${phaseWord(phase)}</b> — read ${fmt(value, 0)} BTU/h from the screenshot. Check it against the probe before generating.</div>`);
  capStatusLine();
  setStatus();
}

async function runOcr(i, phase, file){
  ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — loading the reader…</div>`);
  let worker;
  try {
    worker = await ocrWorker(m => {
      const pct = m.progress ? ` ${Math.round(m.progress * 100)}%` : '';
      ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — ${esc(m.status)}${pct}…</div>`);
    });
  } catch (err) {
    console.error(err);
    ocrSay(i, phase, `<div class="capocrmsg bad">${navigator.onLine
      ? 'The screenshot reader could not load. Type the values in instead.'
      : "You're offline and the reader hasn't been downloaded yet. Type the values in, or connect once to fetch it."}</div>`);
    return;
  }
  try {
    ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — reading the screenshot…</div>`);
    const {data} = await worker.recognize(file);
    const text = data && data.text;
    // Structured first: it is anchored on labels, so probe serials cannot be
    // mistaken for a capacity. Chips are the fallback for an unknown screen.
    if (!ocrReview(i, phase, parseTesto(text))) ocrOffer(i, phase, btuCandidates(text));
  } catch (err) {
    console.error(err);
    ocrSay(i, phase, `<div class="capocrmsg bad">That screenshot could not be read. Type the values in instead.</div>`);
  }
}

/** Called from the head card's "Read from screenshot" button. */
function startOcr(i, phase){
  OCR.target = {i, phase};
  $('ocrFile').click();
}

$('ocrFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';                       // the screenshot is never kept
  if (!file || !OCR.target) return;
  const {i, phase} = OCR.target;
  await runOcr(i, phase, file);
});
