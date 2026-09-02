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

const OCR = {lib: null, worker: null, target: null, found: {}, context: {}};

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
/* Probe serials (651, 877) sit squarely in the BTU/h range, and offering
   "877" as a capacity is how this feature lost its credibility the first time.
   Judge each number by what sits either side of it rather than by its line: a
   line can carry a capacity AND a humidity, and throwing the line away would
   take the capacity with it. */
const SERIAL_BEFORE = /605i\s*\D{0,3}$|testo\s*$/i;      // "testo 605i - 877"
const MODEL_AFTER = /^i/i;                              // the "605" of 605i
const OTHER_UNIT_AFTER = /^\s*(°\s*[FC]|%|r?H\b|g\s*\/\s*m)/i;   // a temperature or a humidity

function notACapacity(before, after){
  if (SERIAL_BEFORE.test(before)) return true;
  if (MODEL_AFTER.test(after) || OTHER_UNIT_AFTER.test(after)) return true;
  return /[:.]\s*$/.test(before) && /^\s*:/.test(after);   // part of a clock
}

function btuCandidates(text){
  const seen = new Map();
  for (const line of String(text || '').split('\n')){
    const re = /(\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d{3,6})(?:[.,]\d+)?/g;
    let m;
    while ((m = re.exec(line)) !== null){
      const before = line.slice(0, m.index), after = line.slice(m.index + m[0].length);
      if (notACapacity(before, after)) continue;
      const value = btuValue(m[1]);
      if (!Number.isFinite(value) || value < OCR_MIN_BTUH || value > OCR_MAX_BTUH) continue;
      const around = line.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
      const labelled = /btu/i.test(around);
      const prev = seen.get(value);
      if (!prev || (labelled && !prev.labelled)) seen.set(value, {value, labelled, around: around.trim()});
    }
  }
  return [...seen.values()].sort((a, b) =>
    (b.labelled - a.labelled) || (b.value - a.value)).slice(0, 6);
}

/* ---------------------------- reading a Testo screen ---------------------- */

/**
 * The BTU/h unit as OCR actually renders it.
 *
 * The slash is the character it gets wrong most often — it comes back as a 1,
 * a lowercase l, a capital I or a pipe depending on the screenshot — and the
 * graph's own axis label is printed "BTUH" with no slash at all. Requiring a
 * literal "BTU/h" meant one mangled character between the number and the unit
 * threw the whole capacity away and left the technician with temperatures and
 * no output, which is exactly what happened on a real after-screenshot.
 */
const BTU_UNIT = 'B\\s*T\\s*U\\s*[/\\\\|1lI]?\\s*[Hh]';

/**
 * A capacity as written on screen, turned into a number.
 *
 * Group separators are dropped; a separator followed by one or two digits is a
 * decimal tail and goes with them. OCR also splits the thousands separator
 * into a space often enough to be worth allowing ("33 540").
 */
function btuValue(raw){
  const s = String(raw).replace(/[\u00a0\s]/g, '');
  const dec = s.match(/^(.*)[.,](\d{1,2})$/);
  const digits = (dec ? dec[1] : s).replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : null;
}

/**
 * The delivered capacity, anchored on the unit so a probe serial can never be
 * mistaken for one. Where a screen carries more than one BTU figure, the one
 * on the "Current Value" row wins — that is the live reading, the others are
 * axis labels and graph bounds.
 */
function capacityFrom(text){
  const flat = String(text || '');
  const re = new RegExp('([\\d][\\d.,\u00a0 ]{0,9})\\s*' + BTU_UNIT, 'g');
  let m, best = null;
  while ((m = re.exec(flat)) !== null){
    const v = plausible(btuValue(m[1]), OCR_MIN_BTUH, OCR_MAX_BTUH);
    if (v == null) continue;
    const line = flat.slice(flat.lastIndexOf('\n', m.index) + 1, m.index + m[0].length);
    const live = /current\s*value|output/i.test(line);
    if (!best || (live && !best.live)) best = {value: v, live};
  }
  return best ? best.value : null;
}

/** Is this the ΔT screen? It carries no output figure at all — worth saying so
    rather than reporting a failed read on a screenshot that never had one. */
function isDeltaTScreen(text){
  return /Differential\s*Temperature/i.test(String(text || ''));
}

/* "g/m³" as OCR renders it — the superscript comes back as ?, °, or nothing. */
const AH_UNIT = /g\s*[\/\u2044|]?\s*m\s*[\u00b3\u00b2?\u00b0]?/gi;

const numsOn = line => (String(line).match(/-?\d+(?:[.,]\d+)?/g) || [])
  .map(t => parseFloat(t.replace(',', '.')));

/**
 * A value only counts when the line yields exactly one number. OCR sometimes
 * splits a decimal — "51.9" came back as "51 9" on a real screenshot — and
 * guessing between the halves is worse than having no reading.
 */
function oneNum(line, labelRe){
  const v = numsOn(String(line).replace(labelRe, ' '));
  return v.length === 1 ? v[0] : null;
}

/* How far a read humidity may sit from the one the dew point implies before
   the dew point is believed instead. */
const RH_TOLERANCE_PCT = 3;

/* ---------------------------- psychrometrics ------------------------------
 *
 * Testo puts four readings of the same air on screen — dry bulb, relative
 * humidity, dew point and absolute humidity — and any two of them imply the
 * other two. That redundancy is the only thing standing between an OCR digit
 * error and a figure on a customer's report, so it is used in every direction
 * rather than only to check the humidity.
 *
 * Magnus throughout, which agrees with a psychrometric chart to well inside
 * the precision Testo displays.
 */
const cOf = f => (f - 32) * 5 / 9;
const fOf = c => c * 9 / 5 + 32;
const esOf = c => 6.112 * Math.exp(17.62 * c / (243.12 + c));          // hPa
const cOfEs = es => { const l = Math.log(es / 6.112); return 243.12 * l / (17.62 - l); };
const AH_K = 216.7;                                       // g·K / (m³·hPa)

const ahOf     = (tF, rh) => AH_K * (rh / 100) * esOf(cOf(tF)) / (cOf(tF) + 273.15);
const rhOfAh   = (tF, ah) => 100 * (ah * (cOf(tF) + 273.15) / AH_K) / esOf(cOf(tF));
const dewOf    = (tF, rh) => fOf(cOfEs(rh / 100 * esOf(cOf(tF))));
const tempOfRhDew = (rh, dewF) => fOf(cOfEs(100 * esOf(cOf(dewF)) / rh));
const tempOfDewAh = (dewF, ah) => AH_K * esOf(cOf(dewF)) / ah - 273.15 > -273
  ? fOf(AH_K * esOf(cOf(dewF)) / ah - 273.15) : null;

/** Absolute humidity rises monotonically with temperature at a fixed RH, so a
    bisection is exact enough and cannot diverge. */
function tempOfRhAh(rh, ah){
  let lo = -60, hi = 90;
  for (let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    (AH_K * (rh / 100) * esOf(mid) / (mid + 273.15) < ah ? lo = mid : hi = mid);
  }
  return fOf((lo + hi) / 2);
}

/**
 * Relative humidity implied by dry bulb and dew point.
 *
 * At 68.8°F with a 52.0°F dew point the humidity is 55%, so a reading of 95%
 * is a misread and not a measurement.
 */
function rhFromDewPoint(tempF, dewF){
  if (typeof tempF !== 'number' || typeof dewF !== 'number') return null;
  if (dewF > tempF + 0.5) return null;             // impossible; one is misread
  const rh = 100 * esOf(cOf(dewF)) / esOf(cOf(tempF));
  return (rh >= 0 && rh <= 100.5) ? Math.round(rh * 10) / 10 : null;
}

const PSY_FIELDS = ['temp', 'rh', 'dew', 'ah'];
const round1 = v => Math.round(v * 10) / 10;

/* How far a reading may sit from what the others imply before it is treated as
   a misread. Absolute humidity is proportional: it is a derived figure, and a
   tenth of a gram means more at 7 g/m³ than at 30. */
const PSY_TOL = {temp: 1.5, rh: RH_TOLERANCE_PCT, dew: 1.5};
const AH_TOL_FRACTION = 0.02;

const psyAgrees = (field, read, implied) => Number.isFinite(implied) && (field === 'ah'
  ? Math.abs(read - implied) <= Math.max(0.05, Math.abs(implied) * AH_TOL_FRACTION)
  : Math.abs(read - implied) <= PSY_TOL[field]);

/** The whole state of the air, from any two of its four readings. */
function completeState(r){
  const has = k => typeof r[k] === 'number';
  let temp = null, rh = null;
  if (has('temp') && has('rh'))       { temp = r.temp; rh = r.rh; }
  else if (has('temp') && has('dew')) { temp = r.temp; rh = rhFromDewPoint(r.temp, r.dew); }
  else if (has('temp') && has('ah'))  { temp = r.temp; rh = rhOfAh(r.temp, r.ah); }
  else if (has('rh') && has('dew'))   { rh = r.rh; temp = tempOfRhDew(r.rh, r.dew); }
  else if (has('rh') && has('ah'))    { rh = r.rh; temp = tempOfRhAh(r.rh, r.ah); }
  else if (has('dew') && has('ah'))   { temp = tempOfDewAh(r.dew, r.ah); rh = temp == null ? null : rhFromDewPoint(temp, r.dew); }
  if (!Number.isFinite(temp) || !Number.isFinite(rh) || rh <= 0 || rh > 100.5) return null;
  return {temp, rh, dew: dewOf(temp, rh), ah: ahOf(temp, rh)};
}

/* A misread digit usually leaves the rest of the number alone: 52.9 read back
   as 92.9 is one character out of three. Used only to break a tie between
   hypotheses that are otherwise equally consistent — never on its own. */
function oneDigitApart(read, implied){
  const a = String(Math.round(read)), b = String(Math.round(implied));
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  return diffs === 1;
}

/**
 * Decide which of a probe's readings, if any, was misread.
 *
 * One reading is assumed wrong at a time and the rest have to agree with each
 * other before that assumption is acted on. Three readings can show that
 * something is wrong but not which one — any of the three could be the odd one
 * out — so unless a single-digit substitution picks out exactly one candidate,
 * the disagreement is reported rather than silently resolved. Guessing here
 * would put an invented number on a customer's document.
 */
function reconcilePsy(read){
  const present = PSY_FIELDS.filter(f => typeof read[f] === 'number');
  if (present.length < 2) return {values: read, fixed: null, conflict: false};

  const asRead = completeState(read);
  if (asRead && present.every(f => psyAgrees(f, read[f], asRead[f])))
    return {values: read, fixed: null, conflict: false};
  if (present.length < 3) return {values: read, fixed: null, conflict: true};

  let candidates = [];
  for (const blamed of present){
    const others = {};
    for (const f of present) if (f !== blamed) others[f] = read[f];
    const state = completeState(others);
    if (!state) continue;
    if (present.every(f => f === blamed || psyAgrees(f, read[f], state[f])))
      candidates.push({blamed, now: round1(state[blamed])});
  }
  if (candidates.length > 1){
    const digit = candidates.filter(c => oneDigitApart(read[c.blamed], c.now));
    if (digit.length === 1) candidates = digit;
  }
  if (candidates.length !== 1) return {values: read, fixed: null, conflict: true};

  const {blamed, now} = candidates[0];
  return {
    values: Object.assign({}, read, {[blamed]: now}),
    fixed: {field: blamed, was: read[blamed], now},
    conflict: false,
  };
}

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

  const pairUnder = (re, unit) => {
    for (let i = head; i < lines.length - 1; i++){
      const hits = lines[i].match(re);
      if (hits && hits.length >= 2){
        const v = numsOn(unit ? lines[i + 1].replace(unit, ' ') : lines[i + 1]);
        if (v.length >= 2) return v;
      }
    }
    return null;
  };
  const temps = pairUnder(/Air\s*Temperature/gi);
  const rh    = pairUnder(/Relative\s*Humidity/gi);
  const dew   = pairUnder(/Dew\s*Point/gi);
  const ah    = pairUnder(/Absolute\s*Humidity/gi, AH_UNIT);
  if (!temps && !rh) return null;

  const pick = (arr, side) => !arr ? null : arr[(side === 'return') === returnFirst ? 0 : 1];
  return {
    returnTemp: pick(temps, 'return'), supplyTemp: pick(temps, 'supply'),
    returnRh:   pick(rh, 'return'),    supplyRh:   pick(rh, 'supply'),
    returnDew:  pick(dew, 'return'),   supplyDew:  pick(dew, 'supply'),
    returnAh:   pick(ah, 'return'),    supplyAh:   pick(ah, 'supply'),
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
      const v = oneNum(line, /Air\s*Temperature|605i|°?\s*F/gi);
      if (v != null) out[role + 'Temp'] = v;
    } else if (/Relative\s*Humidity/i.test(line)){
      const v = oneNum(line, /Relative\s*Humidity|%\s*r?H/gi);
      if (v != null) out[role + 'Rh'] = v;
    } else if (/Dew\s*Point/i.test(line)){
      const v = oneNum(line, /Dew\s*Point|°?\s*F/gi);
      if (v != null) out[role + 'Dew'] = v;
    } else if (/Absolute\s*Humidity/i.test(line)){
      const v = oneNum(line, new RegExp('Absolute\\s*Humidity|' + AH_UNIT.source, 'gi'));
      if (v != null) out[role + 'Ah'] = v;
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

  found.btuh = capacityFrom(text);

  const conds = parseTwoColumn(lines) || parseProbeCards(lines) || {};
  found.returnTemp = plausible(conds.returnTemp, -40, 200);
  found.supplyTemp = plausible(conds.supplyTemp, -40, 200);
  found.returnRh   = plausible(conds.returnRh, 0, 100);
  found.supplyRh   = plausible(conds.supplyRh, 0, 100);

  // Cross-check each probe's readings against each other. Four readings of the
  // same air, any two of which imply the other two, is what turns a misread
  // 95 %RH back into 55, and a supply temperature read as 92.9 back into 52.9.
  const FIELD = {temp: 'Temp', rh: 'Rh'};
  for (const side of ['return', 'supply']){
    const read = {
      temp: found[side + 'Temp'],
      rh:   found[side + 'Rh'],
      dew:  plausible(conds[side + 'Dew'], -60, 200),
      ah:   plausible(conds[side + 'Ah'], 0, 60),
    };
    for (const f of PSY_FIELDS) if (read[f] == null) delete read[f];

    const {fixed, conflict} = reconcilePsy(read);
    // Only the two readings the report carries are worth correcting on screen;
    // a misread dew point that never leaves this function is not news.
    if (fixed && FIELD[fixed.field]){
      found[side + FIELD[fixed.field]] = fixed.now;
      found[side + FIELD[fixed.field] + 'Was'] = fixed.was;   // disclosed in the panel
    }
    // Something on this probe is wrong and the screen does not say what. Say
    // so: a flagged reading gets checked, a silently wrong one gets printed.
    if (conflict) found[side + 'Conflict'] = true;
  }
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
function ocrReview(i, phase, found, context){
  const rows = OCR_ROWS
    .map(r => [r.label, r.parts.filter(([k]) => found[k] != null).map(([k, f]) => f(found[k])).join(' · ')])
    .filter(([, v]) => v);
  // With nothing recognised there is nothing to review: the caller falls back
  // to bare chips, which commit on a single tap. This panel is for a screen we
  // did read, where a chip is one value among several and has to wait for the
  // same confirmation as the rest.
  if (!rows.length) return false;
  const {candidates = [], deltaT = false} = context || {};
  // A capacity we could not anchor is still worth offering: the technician
  // reads it off the screen in front of them and taps it. Dropping it left a
  // screenshot that gave up its temperatures looking like it held no output.
  const chips = found.btuh == null ? candidates : [];

  const CORRECTABLE = [['Temp', 'temperature', '°F'], ['Rh', 'humidity', '%']];
  const fixes = [];
  const conflicts = [];
  for (const side of ['return', 'supply']){
    for (const [key, word, unit] of CORRECTABLE){
      if (found[side + key + 'Was'] == null) continue;
      fixes.push(`${side} ${word} read as ${found[side + key + 'Was']}${unit}, corrected to ${found[side + key]}${unit}`);
    }
    if (found[side + 'Conflict']) conflicts.push(side);
  }

  const missing = found.btuh == null
    ? (deltaT
        ? 'No output on this screen — the Differential Temperature screen does not carry one. For the capacity, screenshot the Cooling and Heating Output screen.'
        : chips.length
          ? 'The output figure could not be read with certainty. Tap the one that matches the screen, or type it in below.'
          : 'No output figure found on this screen. Type it in below.')
    : '';

  OCR.found[`${i}:${phase}`] = found;
  ocrSay(i, phase, `
    <div class="capocrmsg"><b>${phaseWord(phase)}</b> — read from the screenshot. <b>Check every value against the screen</b> before using it; the reader can misread a digit.</div>
    <div class="capocrrows">${rows.map(([k, v]) =>
      `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    ${missing ? `<div class="capocrmsg${chips.length ? '' : ' bad'}">${esc(missing)}</div>` : ''}
    ${chips.length ? `<div class="capocrpick">${chips.map(c =>
      `<button type="button" class="capchip${c.labelled ? ' lab' : ''}" data-cap="${i}:${phase}:${c.value}">
         ${fmt(c.value, 0)}${c.labelled ? ' <span>BTU</span>' : ''}
       </button>`).join('')}</div>` : ''}
    ${fixes.length ? `<div class="capocrmsg">Cross-checked against the other readings on screen: ${esc(fixes.join('; '))}.</div>` : ''}
    ${conflicts.length ? `<div class="capocrmsg bad">The ${esc(conflicts.join(' and '))} readings on this screenshot do not agree with each other, so one of them was misread — and there is not enough on the screen to say which. Check ${conflicts.length > 1 ? 'those rows' : 'that row'} against the probe and correct ${conflicts.length > 1 ? 'them' : 'it'} below.</div>` : ''}
    <button type="button" class="capbtn small" data-use="${i}:${phase}">Use these readings</button>`);
  return true;
}

/**
 * Choosing a capacity from the chips folds it into the same review panel
 * rather than filling it in on the spot, so one "Use these readings" still
 * commits the whole screenshot and the temperatures are not lost on the way.
 */
function ocrPickCapacity(i, phase, value, context){
  const found = OCR.found[`${i}:${phase}`];
  if (!found) return;
  found.btuh = value;
  ocrReview(i, phase, found, context);
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
    // mistaken for a capacity. Chips are the fallback — for a screen we do not
    // recognise at all, and for one we do whose capacity would not anchor.
    const context = {candidates: btuCandidates(text), deltaT: isDeltaTScreen(text)};
    OCR.context[`${i}:${phase}`] = context;
    if (!ocrReview(i, phase, parseTesto(text), context)) ocrOffer(i, phase, context.candidates);
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
