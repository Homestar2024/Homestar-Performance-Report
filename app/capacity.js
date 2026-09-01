/**
 * Capacity verification — chooser, entry flow and report.
 *
 * Measures what the equipment actually delivers, before and after maintenance,
 * from Testo Smart Probe readings. Ductless work is capacity-only; ducted work
 * is usually airflow, often both.
 *
 * The report NEVER recomputes capacity. Testo derives total delivered capacity
 * (sensible + latent) from humidity probes at return and supply; this carries
 * that figure through untouched. A dry-bulb-only fallback exists and is always
 * labelled "sensible only" so it can never be mistaken for a total.
 *
 * Every class here is cap-prefixed so the capacity print rules cannot reach
 * the airflow report's, which is a stated constraint rather than a preference.
 */

const AREAS = ['Living Room', 'Kitchen', 'Master Bedroom', 'Bedroom', 'Office',
               'Den', 'Basement', 'Hallway', 'Other'];
const UNIT_TYPES = ['Wall mount', 'Floor mount', 'Slim ducted', 'Ceiling cassette', 'Air handler'];

/* Testo probe serials, kept as a table rather than hardcoded in labels. */
const PROBES = {
  returnAir:  {serial: '651', label: 'Return air'},
  supplyAir:  {serial: '877', label: 'Supply air'},
  outdoorAir: {serial: '198', label: 'Outdoor air'},
  clamp:      {serial: '217', label: 'Clamp meter'},
};

/* Supply warmer than return means heating. The single-probe fallback only
   applies when there is no return reading to compare against. */
const MODE_SUPPLY_THRESHOLD_F = 65;

/* Below this, a before/after difference is not a claim worth making. Routine
   maintenance often moves capacity very little, and that is an honest result. */
const CAP_TOLERANCE_PCT = 2;

const blankPhase = () => ({
  btuh: '', btuhSource: 'manual',
  returnTemp: '', returnRh: '', supplyTemp: '', supplyRh: '',
  airflow: '', airflowSource: 'rated', hz: '', volts: '',
});
const blankHead = () => ({
  location: '', locationOther: '', unitType: UNIT_TYPES[0], model: '', serial: '',
  before: blankPhase(), after: blankPhase(),
});

const CAP = {
  mode: null,            // heating | cooling — null until detected or chosen
  modeManual: false,     // true once overridden; detection stops fighting it
  heads: [blankHead()],
  outdoor: {model: '', serial: '', rated: '', tempBefore: '', tempAfter: ''},
  photos: {before: [], after: []},
  open: 0,               // index of the expanded head
};

const capNum = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const headName = h => (h.location === 'Other' ? (h.locationOther || 'Other') : h.location) || '';

/* ------------------------------------------------------------ mode detect */

/**
 * Supply vs return dry-bulb, which holds regardless of conditions. Falls back
 * to supply alone only when there is nothing to compare it against.
 */
function detectMode(){
  for (const phase of ['after', 'before']){
    for (const h of CAP.heads){
      const s = capNum(h[phase].supplyTemp), r = capNum(h[phase].returnTemp);
      if (s != null && r != null && s !== r) return s > r ? 'heating' : 'cooling';
    }
  }
  for (const phase of ['after', 'before']){
    for (const h of CAP.heads){
      const s = capNum(h[phase].supplyTemp);
      if (s != null) return s > MODE_SUPPLY_THRESHOLD_F ? 'heating' : 'cooling';
    }
  }
  return null;
}

function refreshMode(){
  if (!CAP.modeManual){
    const found = detectMode();
    if (found) CAP.mode = found;
  }
  const chip = $('capModeChip');
  if (!chip) return;
  const known = !!CAP.mode;
  chip.textContent = known
    ? (CAP.mode === 'heating' ? '🔥 Heating' : '❄ Cooling') + (CAP.modeManual ? ' · set by hand' : ' · detected')
    : 'Mode not detected yet';
  chip.classList.toggle('unknown', !known);
  $('capModeSwitch').textContent = CAP.mode === 'heating' ? 'Switch to cooling' : 'Switch to heating';
}

/* ------------------------------------------------------------- capacity maths */

/** Total delivered capacity per phase, summed across the heads. */
function systemTotal(phase){
  let sum = null;
  for (const h of CAP.heads){
    const v = capNum(h[phase].btuh);
    if (v != null) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * Scores a before→after capacity change. A change inside the tolerance band is
 * neutral, not a win — routine maintenance frequently moves very little and
 * dressing that up would make every report worthless.
 */
function capStatus(before, after){
  if (before == null || after == null || before === 0) return {cls: '', arrow: '', pct: null};
  const pct = (after - before) / before * 100;
  if (Math.abs(pct) <= CAP_TOLERANCE_PCT) return {cls: 'n', arrow: '→', pct, steady: true};
  return {cls: pct > 0 ? 'g' : 'b', arrow: pct > 0 ? '↑' : '↓', pct};
}

/** Measured against the outdoor unit's rated figure. Below rated is not a fault. */
function ratedStatus(measured, rated){
  if (measured == null || rated == null || rated === 0) return {cls: '', arrow: '', pct: null};
  const pct = (measured - rated) / rated * 100;
  return {cls: pct >= 0 ? 'g' : 'n', arrow: pct >= 0 ? '↑' : '↓', pct};
}

const capPct = v => v == null ? '—' : `${Math.abs(v).toFixed(1).replace(/\.0$/, '')}%`;
const btu = v => v == null ? '—' : fmt(v, 0);

/* ------------------------------------------------------------------ entry UI */

const areaOptions = sel => ['<option value="">Choose…</option>']
  .concat(AREAS.map(a => `<option${a === sel ? ' selected' : ''}>${a}</option>`)).join('');
const typeOptions = sel => UNIT_TYPES.map(t => `<option${t === sel ? ' selected' : ''}>${t}</option>`).join('');

/**
 * The BTU/h field is deliberately shaped as a value plus a confirmation line,
 * even though the value is typed today. Screenshot reading will fill the same
 * field and set btuhSource, and a read number must always be confirmed rather
 * than trusted — so the affordance exists from the start and the card does not
 * need redesigning around it later.
 */
function btuhField(i, phase, ph){
  const id = `capB-${i}-${phase}`;
  return `<div class="capfld">
    <label for="${id}">${phase === 'before' ? 'Before' : 'After'} BTU/h</label>
    <input id="${id}" data-head="${i}" data-phase="${phase}" data-key="btuh"
           inputmode="numeric" placeholder="—" value="${esc(ph.btuh)}">
  </div>`;
}

function phaseReadings(i, phase, ph){
  const f = (key, label, hint) => `<div class="capfld">
      <label>${label}</label>
      <input data-head="${i}" data-phase="${phase}" data-key="${key}"
             inputmode="decimal" placeholder="${hint}" value="${esc(ph[key])}">
    </div>`;
  return `<div class="capsub">
    <div class="capsubh">${phase === 'before' ? 'Before' : 'After'} — supporting readings</div>
    <div class="captwo">
      ${f('returnTemp', `Return °F <span class="pr">${PROBES.returnAir.serial}</span>`, '—')}
      ${f('returnRh', 'Return %RH', '—')}
      ${f('supplyTemp', `Supply °F <span class="pr">${PROBES.supplyAir.serial}</span>`, '—')}
      ${f('supplyRh', 'Supply %RH', '—')}
      ${f('airflow', 'Airflow CFM', '—')}
      <div class="capfld"><label>Airflow from</label>
        <select data-head="${i}" data-phase="${phase}" data-key="airflowSource">
          <option value="rated"${ph.airflowSource === 'rated' ? ' selected' : ''}>Rated (high fan)</option>
          <option value="measured"${ph.airflowSource === 'measured' ? ' selected' : ''}>Measured</option>
        </select></div>
      ${f('hz', `Hz <span class="pr">${PROBES.clamp.serial}</span>`, '—')}
      ${f('volts', 'Volts AC', '—')}
    </div>
  </div>`;
}

function headCard(h, i){
  const open = CAP.open === i;
  const name = headName(h);
  const b = capNum(h.before.btuh), a = capNum(h.after.btuh);
  const st = capStatus(b, a);
  const complete = name && b != null && a != null;
  const summary = complete
    ? `${btu(b)} → ${btu(a)} BTU/h · <b class="${st.cls}">${st.arrow} ${capPct(st.pct)}</b>`
    : (name ? 'Started' : 'Not started');

  return `<div class="caphd ${open ? 'open' : complete ? 'done' : 'pending'}" data-card="${i}">
    <div class="caphbar" data-toggle="${i}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="capnum">${complete && !open ? '✓' : i + 1}</div>
      <div class="caphmain">
        <div class="caphname">${name ? esc(name) : `Indoor Unit ${i + 1}`}${name && h.unitType ? ' — ' + esc(h.unitType) : ''}</div>
        <div class="caphsub">${summary}</div>
      </div>
      <div class="capchev">${open ? '▴' : '▾'}</div>
    </div>
    ${open ? `<div class="caphbody">
      <div class="capfld"><label>Area served</label>
        <select data-head="${i}" data-key="location">${areaOptions(h.location)}</select></div>
      ${h.location === 'Other' ? `<div class="capfld"><label>Name this area</label>
        <input data-head="${i}" data-key="locationOther" value="${esc(h.locationOther)}" placeholder="e.g. Bonus room"></div>` : ''}
      <div class="capfld"><label>Unit type</label>
        <select data-head="${i}" data-key="unitType">${typeOptions(h.unitType)}</select></div>
      <div class="capfld"><label>Model</label>
        <input data-head="${i}" data-key="model" value="${esc(h.model)}" placeholder="Paste or type"></div>
      <div class="capfld"><label>Serial</label>
        <input data-head="${i}" data-key="serial" value="${esc(h.serial)}" placeholder="Paste or type"></div>
      <div class="captwo">
        ${btuhField(i, 'before', h.before)}
        ${btuhField(i, 'after', h.after)}
      </div>
      <details class="capmore"${h.before.returnTemp || h.after.returnTemp ? ' open' : ''}>
        <summary>Supporting readings — temps, RH, airflow, electrical</summary>
        ${phaseReadings(i, 'before', h.before)}
        ${phaseReadings(i, 'after', h.after)}
      </details>
      ${i < CAP.heads.length - 1
        ? `<button class="capbtn" type="button" data-next="${i}">Done — next unit</button>`
        : `<button class="capbtn" type="button" data-next="-1">Done</button>`}
    </div>` : ''}
  </div>`;
}

function renderHeads(){
  $('capHeads').innerHTML = CAP.heads.map(headCard).join('');
  refreshMode();
  capStatusLine();
}

function capStatusLine(){
  const missing = CAP.heads.filter(h => !headName(h) || capNum(h.before.btuh) == null || capNum(h.after.btuh) == null).length;
  const el = $('capStatus');
  if (!el) return;
  el.textContent = missing
    ? `${missing} of ${CAP.heads.length} indoor unit${CAP.heads.length === 1 ? '' : 's'} still needs an area and both readings.`
    : 'All indoor units captured.';
  el.classList.toggle('bad', missing > 0);
}

function setHeadCount(n){
  n = Math.max(1, Math.min(5, n | 0));
  while (CAP.heads.length < n) CAP.heads.push(blankHead());
  CAP.heads.length = n;                       // trimming keeps the earlier heads
  if (CAP.open >= n) CAP.open = n - 1;
  renderHeads();
}

/* ------------------------------------------------------------- report sections */

function headRow(h, i){
  const b = capNum(h.before.btuh), a = capNum(h.after.btuh);
  const st = capStatus(b, a);
  const max = Math.max(b || 0, a || 0) || 1;
  const ident = [h.unitType, h.model && `Model ${h.model}`, h.serial && `S/N ${h.serial}`]
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="capcard">
    <div class="capcardh">
      <div class="capcardn">${esc(headName(h) || `Indoor Unit ${i + 1}`)}</div>
      ${ident ? `<div class="capcardi">${ident}</div>` : ''}
    </div>
    <div class="capbars">
      <div class="capbl">Before</div>
      <div class="captrack"><div class="capfill base" style="width:${((b || 0) / max * 100).toFixed(1)}%"></div></div>
      <div class="capval">${btu(b)}</div>
      <div class="capbl">After</div>
      <div class="captrack"><div class="capfill ${st.cls || 'base'}" style="width:${((a || 0) / max * 100).toFixed(1)}%"></div></div>
      <div class="capval">${btu(a)}</div>
    </div>
    ${st.arrow ? `<div class="capdelta ${st.cls}">${st.arrow} ${capPct(st.pct)}${st.steady ? ' — holding steady' : ''}</div>` : ''}
  </div>`;
}

function conditionsPanel(phase){
  const outdoor = CAP.outdoor[phase === 'before' ? 'tempBefore' : 'tempAfter'];
  const rows = CAP.heads.map((h, i) => {
    const p = h[phase];
    const rt = capNum(p.returnTemp), stp = capNum(p.supplyTemp);
    const dt = (rt != null && stp != null) ? Math.abs(stp - rt).toFixed(1) + '°F' : '—';
    const bits = [
      rt != null ? `RA ${rt}°F${p.returnRh ? ` / ${p.returnRh}%` : ''}` : null,
      stp != null ? `SA ${stp}°F${p.supplyRh ? ` / ${p.supplyRh}%` : ''}` : null,
      dt !== '—' ? `ΔT ${dt}` : null,
      p.airflow ? `${p.airflow} CFM (${p.airflowSource})` : null,
      p.hz ? `${p.hz} Hz` : null,
      p.volts ? `${p.volts} V` : null,
    ].filter(Boolean).map(esc).join(' · ');
    return `<div class="caprow"><span class="caprk">${esc(headName(h) || `Unit ${i + 1}`)}</span><span class="caprv">${bits || '—'}</span></div>`;
  }).join('');
  return `<div class="cappanel ${phase}">
    <div class="cappt">${phase === 'before' ? 'Before' : 'After'}${outdoor ? ` — outdoor ${esc(outdoor)}°F` : ''}</div>
    <div class="capdl">${rows}</div>
  </div>`;
}

function capShots(){
  const gallery = (list, label) => !list.length ? '' : `
    <div class="capgal">
      <div class="capgt">${label}</div>
      <div class="capgrid">${list.map(src => `<div class="capshot"><img src="${src}" alt="${label}"></div>`).join('')}</div>
    </div>`;
  const out = gallery(CAP.photos.before, 'Before') + gallery(CAP.photos.after, 'After');
  return out ? `<section><div class="sh">Before &amp; After</div>${out}</section>` : '';
}

/** @param {boolean} breakFirst start on a fresh sheet (combination reports). */
function capacitySections(breakFirst){
  const tb = systemTotal('before'), ta = systemTotal('after');
  const sys = capStatus(tb, ta);
  const rated = capNum(CAP.outdoor.rated);
  const vs = ratedStatus(ta, rated);
  const tempsDiffer = capNum(CAP.outdoor.tempBefore) != null && capNum(CAP.outdoor.tempAfter) != null
    && capNum(CAP.outdoor.tempBefore) !== capNum(CAP.outdoor.tempAfter);

  const hero = `
    <div class="capcell ${sys.cls}">
      <div class="hl">System Capacity</div>
      <div class="ba"><b>${btu(tb)}</b> → <b>${btu(ta)}</b> BTU/h</div>
      <div class="hbig"><span class="ar">${sys.arrow}</span><span class="pct">${sys.pct == null ? '—' : capPct(sys.pct)}</span></div>
      <div class="verdict">${sys.cls === 'g' ? 'Improved' : sys.cls === 'b' ? 'Review' : sys.cls === 'n' ? 'Holding steady' : 'Not measured'}</div>
    </div>
    <div class="capcell ${vs.cls}">
      <div class="hl">Measured vs Rated</div>
      <div class="ba"><b>${btu(ta)}</b> measured · <b>${btu(rated)}</b> rated</div>
      <div class="hbig"><span class="ar">${vs.arrow}</span><span class="pct">${vs.pct == null ? '—' : capPct(vs.pct)}</span></div>
      <div class="verdict">${vs.cls === 'g' ? 'At or above rated' : vs.cls === 'n' ? 'Below rated' : 'Not compared'}</div>
    </div>`;

  const outdoorIdent = [CAP.outdoor.model && `Model ${CAP.outdoor.model}`, CAP.outdoor.serial && `S/N ${CAP.outdoor.serial}`]
    .filter(Boolean).map(esc).join(' · ');

  return `
  <section class="${breakFirst ? 'capbreak' : ''}">
    <div class="sh">Verified Results at a Glance</div>
    <div class="caphero">${hero}</div>
    ${tempsDiffer ? `<div class="capnote">Outdoor temperature differed between the two tests (${esc(CAP.outdoor.tempBefore)}°F before, ${esc(CAP.outdoor.tempAfter)}°F after). Capacity moves with outdoor conditions, so some of any difference is weather rather than work.</div>` : ''}
  </section>

  <section>
    <div class="sh">Indoor Units — Before vs After</div>
    ${CAP.heads.map(headRow).join('')}
  </section>

  <section>
    <div class="sh">System Total vs Outdoor Rated</div>
    <div class="capvs">
      <div class="capvsr"><span>Measured indoor total, after</span><b>${btu(ta)} BTU/h</b></div>
      <div class="capvsr"><span>Outdoor unit rated${CAP.outdoor.tempAfter ? ` at ${esc(CAP.outdoor.tempAfter)}°F, ${esc(CAP.mode || '')}` : ''}</span><b>${btu(rated)} BTU/h</b></div>
      <div class="capvsr total"><span>Difference</span><b class="${vs.cls}">${vs.arrow} ${vs.pct == null ? '—' : capPct(vs.pct)}</b></div>
    </div>
    ${outdoorIdent ? `<div class="capnote">Outdoor unit: ${outdoorIdent}</div>` : ''}
    <div class="capnote">Rated capacity assumes the manufacturer's nominal indoor conditions. On a multi-zone system the rated figure allows for diversity — heads rarely all run at full load at once — so this comparison is a sound field indicator, not a commissioning figure.</div>
  </section>

  <section>
    <div class="sh">Operating Conditions</div>
    <div class="captwo">${conditionsPanel('before')}${conditionsPanel('after')}</div>
  </section>

  ${capShots()}`;
}

const CAPACITY_FOOTNOTE = 'Total delivered capacity (sensible + latent), measured with Testo Smart Probes. Values are single-point field readings at the conditions recorded above and carry normal instrument tolerance.';

function capacityShell(){
  const modeLabel = CAP.mode ? CAP.mode[0].toUpperCase() + CAP.mode.slice(1) : '';
  const temps = [CAP.outdoor.tempBefore, CAP.outdoor.tempAfter].filter(Boolean);
  return reportShell({
    title: 'Maintenance Capacity Report',
    verify: 'Delivered heating and cooling capacity was measured with Testo Smart Probes at the return and supply of each indoor unit, before and after the maintenance performed by Homestar HVAC Solutions.',
    meta: [
      {l: 'Date', v: new Date().toISOString().slice(0, 10)},
      {l: 'Mode', v: modeLabel},
      {l: `Outdoor ${PROBES.outdoorAir.serial}`, v: temps.length === 2 ? `${temps[0]}°F → ${temps[1]}°F` : (temps[0] ? temps[0] + '°F' : '')},
      {l: 'Technician', v: $('cTech').value.trim() || 'Calvin Windsor'},
    ],
    footNote: CAPACITY_FOOTNOTE,
  });
}

/* ------------------------------------------------------------ report routing */

const RT = ['airflow', 'capacity', 'combination'];

function combinedShell(before, after){
  const temps = [CAP.outdoor.tempBefore, CAP.outdoor.tempAfter].filter(Boolean);
  return reportShell({
    title: 'Performance & Capacity Report',
    verify: 'Airflow and static pressure were measured with the TrueFlow® analysis, and delivered capacity with Testo Smart Probes, before and after the work performed by Homestar HVAC Solutions.',
    meta: [
      {l: 'Before tested', v: before.date || ''},
      {l: 'After tested',  v: after.date  || ''},
      {l: 'Mode',          v: CAP.mode ? CAP.mode[0].toUpperCase() + CAP.mode.slice(1) : ''},
      {l: `Outdoor ${PROBES.outdoorAir.serial}`, v: temps.length === 2 ? `${temps[0]}°F → ${temps[1]}°F` : (temps[0] ? temps[0] + '°F' : '')},
      {l: 'Technician',    v: $('cTech').value.trim() || after.tech || before.tech || 'Calvin Windsor'},
    ],
    footNote: AIRFLOW_FOOTNOTE + ' ' + CAPACITY_FOOTNOTE,
    company: after.company || before.company,
    tech: after.tech || before.tech,
    phone: after.phone || before.phone,
    email: after.email || before.email,
  });
}

/** Every head needs an area and both readings before a report means anything. */
function capReady(){
  return CAP.heads.length > 0 && CAP.heads.every(h =>
    headName(h) && capNum(h.before.btuh) != null && capNum(h.after.btuh) != null);
}

function generateReport(){
  const type = reportType || 'airflow';
  if (type === 'airflow'){
    buildReport(mergedData(order[0]), mergedData(order[1]));
  } else if (type === 'capacity'){
    const shell = capacityShell();
    $('sheet').innerHTML = shell.head + capacitySections(false) + shell.foot;
  } else {
    const b = mergedData(order[0]), a = mergedData(order[1]);
    const shell = combinedShell(b, a);
    // The airflow pages stay whole; capacity starts on a fresh sheet.
    $('sheet').innerHTML = shell.head + airflowSections(b, a) + capacitySections(true) + shell.foot;
  }
  document.body.classList.add('has-report');
  $('report').style.display = 'block';
  $('report').scrollIntoView({behavior: 'smooth'});
}

function chooseReport(type){
  if (!RT.includes(type)) return;
  reportType = type;
  document.body.classList.remove(...RT.map(t => 'rt-' + t));
  document.body.classList.add('rt-' + type);
  $('chooser').hidden = true;
  $('tool').hidden    = type === 'capacity';
  $('capCard').hidden = type === 'airflow';
  $('clientCard').hidden = false;
  $('actions').hidden = false;
  $('gen').textContent = type === 'combination' ? 'Generate combined report' : 'Generate report';
  clearReport();
  renderHeads();
  setStatus();
}

/* ------------------------------------------------------------------ wiring */

function capPhotoThumbs(phase){
  const host = $('capT' + (phase === 'before' ? 'b' : 'a'));
  const list = CAP.photos[phase];
  host.innerHTML = list.map((src, i) => `<div class="capthumb">
      <img src="${src}" alt="${phase} ${i + 1}">
      <button class="capx" type="button" data-drop="${phase}" data-i="${i}" aria-label="Remove photo ${i + 1}">×</button>
    </div>`).join('');
  $('capN' + (phase === 'before' ? 'b' : 'a')).textContent = list.length ? `(${list.length})` : '';
}

function capInit(){
  $('chooser').addEventListener('click', e => {
    const b = e.target.closest('[data-rt]');
    if (b) chooseReport(b.dataset.rt);
  });
  $('rtBack').addEventListener('click', () => {
    $('chooser').hidden = false;
    $('tool').hidden = $('capCard').hidden = $('clientCard').hidden = $('actions').hidden = true;
    clearReport();
  });

  $('capCount').addEventListener('change', e => setHeadCount(parseInt(e.target.value, 10)));

  $('capModeSwitch').addEventListener('click', () => {
    CAP.modeManual = true;
    CAP.mode = CAP.mode === 'heating' ? 'cooling' : 'heating';
    clearReport();
    refreshMode();
  });

  // One delegated listener for every head field; the accordion re-renders often.
  $('capHeads').addEventListener('input', e => {
    const el = e.target, i = el.dataset.head;
    if (i == null) return;
    const h = CAP.heads[+i];
    if (el.dataset.phase) h[el.dataset.phase][el.dataset.key] = el.value;
    else h[el.dataset.key] = el.value;
    clearReport();
    if (/Temp$/.test(el.dataset.key || '')) refreshMode();
    capStatusLine();
    setStatus();
  });
  $('capHeads').addEventListener('change', e => {
    const el = e.target, i = el.dataset.head;
    if (i == null) return;
    const h = CAP.heads[+i];
    if (el.dataset.phase) h[el.dataset.phase][el.dataset.key] = el.value;
    else h[el.dataset.key] = el.value;
    clearReport();
    // Area and type feed the card's own header, so redraw it.
    if (el.dataset.key === 'location' || el.dataset.key === 'unitType') renderHeads();
    else { refreshMode(); capStatusLine(); setStatus(); }
  });
  $('capHeads').addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]'), n = e.target.closest('[data-next]');
    if (n){
      const i = +n.dataset.next;
      CAP.open = i < 0 ? -1 : i + 1;
      renderHeads();
      return;
    }
    if (t){
      const i = +t.dataset.toggle;
      CAP.open = CAP.open === i ? -1 : i;
      renderHeads();
    }
  });

  $('capOut').addEventListener('input', e => {
    if (!e.target.dataset.out) return;
    CAP.outdoor[e.target.dataset.out] = e.target.value;
    clearReport();
  });

  for (const phase of ['before', 'after']){
    const input = $('capF' + (phase === 'before' ? 'b' : 'a'));
    input.addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      clearReport();
      for (const f of files){
        try { CAP.photos[phase].push(await loadPhoto(f)); }
        catch (err) { console.error(err); toast("Couldn't read one of those images.", true); }
      }
      capPhotoThumbs(phase);
    });
  }
  for (const id of ['capTb', 'capTa']){
    $(id).addEventListener('click', e => {
      const b = e.target.closest('[data-drop]');
      if (!b) return;
      clearReport();
      CAP.photos[b.dataset.drop].splice(+b.dataset.i, 1);
      capPhotoThumbs(b.dataset.drop);
    });
  }

  renderHeads();
}

capInit();

/* ---------------------------------------------------------- history support */

/** Plain snapshot of the capacity side, safe to store and re-read. */
function capSnapshot(){
  return JSON.parse(JSON.stringify({
    mode: CAP.mode, modeManual: CAP.modeManual, heads: CAP.heads, outdoor: CAP.outdoor,
  }));
}

function capRestore(snap){
  if (!snap) return;
  CAP.mode = snap.mode || null;
  CAP.modeManual = !!snap.modeManual;
  CAP.heads = (snap.heads && snap.heads.length ? snap.heads : [blankHead()])
    .map(h => Object.assign(blankHead(), h, {
      before: Object.assign(blankPhase(), h.before),
      after:  Object.assign(blankPhase(), h.after),
    }));
  CAP.outdoor = Object.assign({model:'', serial:'', rated:'', tempBefore:'', tempAfter:''}, snap.outdoor);
  CAP.open = -1;
  $('capCount').value = String(CAP.heads.length);
  for (const el of $('capOut').querySelectorAll('[data-out]')) el.value = CAP.outdoor[el.dataset.out] || '';
  renderHeads();
}

/** Wipe the capacity side when the technician moves on to the next job. */
function capReset(){
  CAP.mode = null; CAP.modeManual = false;
  CAP.heads = [blankHead()];
  CAP.outdoor = {model:'', serial:'', rated:'', tempBefore:'', tempAfter:''};
  CAP.photos = {before: [], after: []};
  CAP.open = 0;
  $('capCount').value = '1';
  for (const el of $('capOut').querySelectorAll('[data-out]')) el.value = '';
  capPhotoThumbs('before'); capPhotoThumbs('after');
  renderHeads();
}

function capSetPhotos(before, after){
  CAP.photos.before = before || [];
  CAP.photos.after = after || [];
  capPhotoThumbs('before'); capPhotoThumbs('after');
}

/** A one-line description of a capacity job for the saved-reports list. */
function capSummary(rec){
  const cap = rec.cap || {};
  const heads = (cap.heads || []).length;
  const tot = p => (cap.heads || []).reduce((s, h) => {
    const v = capNum(h[p] && h[p].btuh); return v == null ? s : (s ?? 0) + v;
  }, null);
  const b = tot('before'), a = tot('after');
  const st = capStatus(b, a);
  const bits = [`${heads} unit${heads === 1 ? '' : 's'}`];
  if (cap.mode) bits.push(cap.mode);
  if (st.arrow) bits.push(`<span class="up">${st.arrow} ${capPct(st.pct)}</span> capacity`);
  return bits.join(' · ');
}
