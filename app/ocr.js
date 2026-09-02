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

const OCR = {lib: null, worker: null, target: null};

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
 * Numbers sitting next to "BTU" come first, because that is the label Testo
 * puts beside the figure. Everything else in range follows, largest first,
 * since delivered capacity is normally the biggest number on the screen.
 *
 * This ordering is a guess until it has been run against real screenshots —
 * which is exactly why the technician picks rather than the app deciding.
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

function ocrPanel(i, phase){ return $(`capO-${i}-${phase}`); }

/* The panels sit under both BTU fields rather than inside one of them, so
   each has to say which reading it belongs to. */
const phaseWord = phase => phase === 'before' ? 'Before' : 'After';

function ocrSay(i, phase, html){
  const el = ocrPanel(i, phase);
  if (el) el.innerHTML = html;
}

/** Offer what was found. Nothing is written until one is tapped. */
function ocrOffer(i, phase, list){
  if (!list.length){
    ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — no BTU/h figure found in that screenshot. Type it in instead.</div>`);
    return;
  }
  ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — tap the reading that matches the screenshot:</div>
    <div class="capocrpick">${list.map(c =>
      `<button type="button" class="capchip${c.labelled ? ' lab' : ''}" data-pick="${i}:${phase}:${c.value}">
         ${fmt(c.value, 0)}${c.labelled ? ' <span>BTU</span>' : ''}
       </button>`).join('')}</div>`);
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
      ? 'The screenshot reader could not load. Type the value in instead.'
      : "You're offline and the reader hasn't been downloaded yet. Type the value in, or connect once to fetch it."}</div>`);
    return;
  }
  try {
    ocrSay(i, phase, `<div class="capocrmsg"><b>${phaseWord(phase)}</b> — reading the screenshot…</div>`);
    const {data} = await worker.recognize(file);
    ocrOffer(i, phase, btuCandidates(data && data.text));
  } catch (err) {
    console.error(err);
    ocrSay(i, phase, `<div class="capocrmsg bad">That screenshot could not be read. Type the value in instead.</div>`);
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
