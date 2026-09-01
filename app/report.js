/**
 * Rendering the airflow report — scoring, write-ups, page assembly.
 */

const fmt = (v,dp)=> v==null ? '—' : Number(v).toLocaleString('en-CA',{minimumFractionDigits:dp,maximumFractionDigits:dp});
const esc = s => (s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/**
 * What the job actually achieved. Airflow up and total external static down is
 * the whole point of these upgrades; everything else is a component of that
 * result, not a verdict of its own.
 */
function systemContext(before, after){
  const flow = statusOf(METRICS[0], before.totalFlow, after.totalFlow);
  const tesp = statusOf(METRICS[1], before.tesp, after.tesp);
  return {
    flowUp:   flow.dir > 0,
    flowPct:  flow.pct,
    tespDown: tesp.dir < 0,
    tespPct:  tesp.pct,
    improved: flow.dir > 0 && tesp.dir < 0,
  };
}

/**
 * @param {object} [sys] system context, required to score a context metric.
 *
 * Airflow and TESP are judged on their own and can come back red — the report
 * has to be able to say a job did not achieve what it set out to.
 *
 * The component pressures never do. Pressure drop across a path rises with the
 * air travelling through it, so a return plenum up 3% while airflow is up 21%
 * is a path carrying far more air for almost no extra pressure: an improvement
 * that a naive "lower is better" reading calls a failure. They score green when
 * they fell, or rose by proportionally less than airflow; otherwise neutral.
 */
function statusOf(m, before, after, sys){
  if (before==null || after==null) return {cls:'', arrow:'', pct:null, dir:0, beatsFlow:false};
  const d = after - before;
  const pct = before!==0 ? (d/before*100) : null;
  const arrow = d>0?'↑':(d<0?'↓':'→');
  const dir = Math.sign(d);

  // Rose, but by proportionally less than the extra air it is now moving.
  const beatsFlow = !!(sys && sys.flowUp && d > 0 && pct != null && sys.flowPct != null
    && Math.abs(pct) < Math.abs(sys.flowPct));

  let cls;
  if (Math.abs(d) < 1e-9) cls = '';
  else if (m.context){
    cls = (d < 0 || (sys && sys.improved && beatsFlow)) ? 'g' : 'n';
  } else {
    const improved = (m.dir==='up' && d>0) || (m.dir==='down' && d<0);
    cls = improved ? 'g' : 'b';
  }
  return {cls, arrow, pct, dir, d, beatsFlow};
}

function railFor(m, before, after, sys){
  const st = statusOf(m, before, after, sys);
  const max = Math.max(before||0, after||0) || 1;
  const wB = ((before||0)/max*100).toFixed(1);
  const wA = ((after||0)/max*100).toFixed(1);
  const badge = st.arrow==='' ? '' :
    `<span class="mbadge ${st.cls}">${st.arrow} ${st.pct==null ? fmt(Math.abs(st.d), m.dp) : Math.abs(st.pct).toFixed(1)+'%'}</span>`;
  let note = '';
  if (m.context){
    if (st.cls==='g') note = st.beatsFlow
      ? `Rose by proportionally less than the extra airflow — this path is carrying more air at nearly the same pressure.`
      : `Down while the system moves more air.`;
    else if (st.cls==='n') note = `A component pressure, not a verdict — it moves with the airflow through it. Total airflow and total external static are what judge the system.`;
  }
  else if (st.cls==='g') note = `Improved — ${m.dir==='up'?'higher is better here':'lower is better here'}.`;
  else if (st.cls==='b') note = `Moved the wrong direction — worth a look.`;
  return `
    <div class="metric">
      <div class="mtop">
        <div class="mname">${m.name}<span class="u">${m.unit}</span></div>
        ${badge}
      </div>
      <div class="bars">
        <div class="bl">Before</div>
        <div class="track"><div class="fill base" style="width:${wB}%"></div></div>
        <div class="bv">${fmt(before,m.dp)}</div>
        <div class="bl">After</div>
        <div class="track"><div class="fill ${st.cls||'base'}" style="width:${wA}%"></div></div>
        <div class="bv">${fmt(after,m.dp)}</div>
      </div>
      ${note?`<div class="mnote">${note}</div>`:''}
    </div>`;
}

function heroCell(m, before, after, sys){
  const st = statusOf(m, before, after, sys);
  let verdict;
  if (st.cls === 'g') verdict = 'Improved';
  else if (st.cls === 'b') verdict = 'Review';
  else if (st.cls === 'n') verdict = (sys && sys.flowUp) ? 'As expected' : 'For reference';
  else verdict = 'No change';
  return `
    <div class="hcell ${st.cls}">
      <div class="hl">${m.name}</div>
      <div class="ba"><b>${fmt(before,m.dp)}</b> → <b>${fmt(after,m.dp)}</b> ${m.unit}</div>
      <div class="hbig"><span class="ar">${st.arrow}</span><span class="pct">${st.pct==null?fmt(Math.abs(st.d ?? 0),m.dp):Math.abs(st.pct).toFixed(0)+'%'}</span></div>
      <div class="verdict">${verdict}</div>
    </div>`;
}

const measRows = d => [
  ['Total airflow', d.totalFlow!=null?fmt(d.totalFlow,0)+' SCFM':null],
  ['Return duct', d.returnDuct!=null?fmt(d.returnDuct,3)+' in H₂O':null],
  ['After filter', d.afterFilter!=null?fmt(d.afterFilter,3)+' in H₂O':null],
  ['Supply duct', d.supplyDuct!=null?fmt(d.supplyDuct,3)+' in H₂O':null],
  ['Total external static', d.tesp!=null?fmt(d.tesp,3)+' in H₂O':null],
].map(([k,v])=>`<div><span class="dk">${k}</span><span class="dv">${v??'—'}</span></div>`).join('');

/**
 * Plain-language write-ups, chosen by which way each metric actually moved.
 * tier 1 gets a heading and a paragraph; tier 2 is a single line in the
 * summary panel. Nothing renders for a metric that did not move or that has
 * a value missing — the report never claims a benefit it cannot show.
 *
 * `c` carries the formatted numbers: c.pct, c.b (before), c.a (after).
 */
const BENEFITS = {
  totalFlow: {
    tier: 1,
    up: c => ({
      head: 'More air means more of the capacity you paid for',
      body: `Airflow rose ${c.pct} (${c.b} → ${c.a} SCFM). Heating and cooling equipment is rated to move a specific volume of air — deliver less than that and it cannot transfer the heat it was built to transfer. With airflow restored, the system reaches more of its rated output for the same energy, temperatures even out from room to room, and the equipment runs less to do the same work.`,
    }),
    down: c => ({
      head: 'Airflow decreased — worth investigating',
      body: `Airflow fell ${c.pct} (${c.b} → ${c.a} SCFM). Less air across the coil and heat exchanger means less delivered capacity and longer run times, and in cooling it can drive the indoor coil cold enough to ice up. Filter, damper and register positions are worth confirming before the system sees a full season.`,
    }),
  },
  tesp: {
    tier: 1,
    down: c => ({
      head: 'The blower is no longer fighting the ductwork',
      body: `Total external static pressure dropped ${c.pct} (${c.b} → ${c.a} in H₂O). That figure is the resistance the blower works against every minute it runs. With less of it the motor draws less power to move more air, the system runs noticeably quieter — less rush at the registers, less noise carried through the ducts — and the blower sees far less strain over its service life.`,
    }),
    up: c => ({
      head: 'Static pressure rose — the blower is working harder',
      body: `Total external static climbed ${c.pct} (${c.b} → ${c.a} in H₂O). Higher resistance means the blower draws more power, runs louder, and works harder for every cubic foot it delivers. Most residential equipment is rated to around 0.5 in H₂O, so what is driving this up is worth reviewing.`,
    }),
  },
  /* The three component pressures. Which way they moved is not the story —
     what the system achieved is. Each has four readings:

       fell        pressure down while the system moves more air
       beatsFlow   rose, but by proportionally less than the extra airflow
       rose        rose by more than airflow alone accounts for
       (fallback)  the job did not achieve both goals; stay factual

     None of them is written as a failure. The honest verdict on a job lives in
     Total Airflow and Total External Static Pressure above, which can and do
     come back red. */
  returnPlenum: {
    tier: 2,
    line: (c, sys) => {
      if (!sys.improved) return `${c.dirWord} ${c.pct}. Return-side static is one component of what the blower works against — it is read alongside total airflow and total external static above, which are what judge the system.`;
      if (c.fell) return `Down ${c.pct} while the system moves ${c.flow} more air. Less pressure on the return side and more air travelling through it means the blower is drawing easier than it was — quieter returns, and less suction pulling unconditioned air in through any leaks on that side.`;
      if (c.beatsFlow) return `Up ${c.pct}, against ${c.flow} more airflow. Moving that much extra air through a return normally costs a good deal more pressure than this, so the return path is carrying considerably more air at nearly the same static. That is the return side improving, not restricting.`;
      return `Up ${c.pct} with ${c.flow} more air travelling through it. Static on the return side climbs with the air passing through — this is the airflow gain showing up, not a restriction. The measure of the system as a whole is total external static, which fell ${c.tesp}.`;
    },
  },
  filterDrop: {
    tier: 2,
    line: (c, sys) => {
      if (!sys.improved) return `${c.dirWord} ${c.pct}. Drop across the filter is one component of the total the blower works against — it is read alongside total airflow and total external static above.`;
      if (c.fell) return `Down ${c.pct} while airflow is up ${c.flow}. The filter is no longer the bottleneck: more of the system's capacity goes into conditioning the house, and the filter can load up between changes without strangling the system.`;
      if (c.beatsFlow) return `Up ${c.pct}, against ${c.flow} more airflow. Pushing that much more air through a filter normally costs far more than this — it is passing considerably more air at nearly the same pressure drop as before.`;
      return `Up ${c.pct} with ${c.flow} more air moving through it. Pressure drop across a filter rises with the air passing through it, and finer media rises faster — expected here, and comfortably paid for by a total external static that fell ${c.tesp}.`;
    },
  },
  supplyPlenum: {
    tier: 2,
    line: (c, sys) => {
      if (!sys.improved) return `${c.dirWord} ${c.pct}. Supply-side static is one component of the total the blower works against — it is read alongside total airflow and total external static above.`;
      if (c.fell) return `Down ${c.pct} while airflow is up ${c.flow} — less pressure on the supply side and more air out of the registers. Quieter registers, and less force driving conditioned air out through any leaks in the supply ducts.`;
      if (c.beatsFlow) return `Up ${c.pct}, against ${c.flow} more airflow — less than moving that much extra air through the same supply ducts normally costs, and a small price for the air it buys.`;
      return `Up ${c.pct} while the system moves ${c.flow} more air and the total the blower works against fell ${c.tesp}. Supply-side static rises when more air is pushed through the same ducts, and with the restriction cleared it now carries a larger share of a much smaller total. It is one component of the result, not the result.`;
    },
  },
};

const pctText = v => v == null ? null : `${Math.abs(v).toFixed(1).replace(/\.0$/,'')}%`;

function benefitCtx(m, b, a, st, sys){
  return {
    pct: st.pct==null ? `by ${fmt(Math.abs(st.d), m.dp)} ${m.unit}` : pctText(st.pct),
    b: fmt(b, m.dp),
    a: fmt(a, m.dp),
    dirWord: st.dir > 0 ? 'Up' : 'Down',
    fell: st.dir < 0,
    beatsFlow: st.beatsFlow,
    flow: pctText(sys.flowPct) || 'more',
    tesp: pctText(sys.tespPct) || '',
  };
}

function benefitsFor(before, after, sys){
  const full = [], compact = [];
  for (const m of METRICS){
    const spec = BENEFITS[m.key];
    const b = before[m.key], a = after[m.key];
    if (!spec || b==null || a==null) continue;
    const st = statusOf(m, b, a, sys);
    if (st.dir === 0) continue;                // no movement, nothing to claim
    const pick = spec.line || (st.dir > 0 ? spec.up : spec.down);
    if (!pick) continue;
    const c = benefitCtx(m, b, a, st, sys);
    // Same precision as the prose beside it — "↑ 3%" next to "Up 2.7%" reads
    // like two different measurements.
    const delta = `${st.arrow} ${st.pct==null ? fmt(Math.abs(st.d), m.dp) : pctText(st.pct)}`;
    if (spec.tier === 1){
      const {head, body} = pick(c, sys);
      full.push(`<div class="ben ${st.cls}">
        <div class="bl2">${m.name}<span class="d">${delta}</span></div>
        <h4>${head}</h4>
        <p>${body}</p>
      </div>`);
    } else {
      compact.push(`<div class="row ${st.cls}">
        <div class="rk">${m.name}<span class="d">${delta}</span></div>
        <div class="rv">${pick(c, sys)}</div>
      </div>`);
    }
  }
  if (!full.length && !compact.length) return '';
  return full.join('') + (compact.length ? `<div class="bcomp">${compact.join('')}</div>` : '');
}

function shotsFor(){
  const have = [1,2].filter(n=>photos[n]);
  if (!have.length) return '';
  const frame = n => `<div class="shot ${n===1?'before':'after'}">
      <div class="pt">${n===1?'Before':'After'}</div>
      <img src="${photos[n]}" alt="${n===1?'Before':'After'} the work">
    </div>`;
  return `<div class="shots${have.length===1?' one':''}">${have.map(frame).join('')}</div>`;
}

function buildReport(before, after){
  const clientName = document.getElementById('cName').value.trim();
  const clientAddr = document.getElementById('cAddr').value.trim();
  const co = after.company || before.company || 'Homestar HVAC Solutions';
  const tech = $('cTech').value.trim() || after.tech || before.tech || 'Calvin Windsor';
  const phone = after.phone || before.phone || '';
  const email = after.email || before.email || '';

  const sys = systemContext(before, after);

  const hero = ['totalFlow','tesp','filterDrop']
    .map(k=>{const m=METRICS.find(x=>x.key===k); return heroCell(m, before[k], after[k], sys);}).join('');

  const rails = METRICS.map(m=>railFor(m, before[m.key], after[m.key], sys)).join('');

  // Page two. Whichever of these exists comes first carries the page break.
  const page2 = [];
  const benefits = benefitsFor(before, after, sys);
  const shots = shotsFor();
  if (benefits) page2.push(`<section><div class="sh">What This Means For Your Home</div>${benefits}</section>`);
  if (shots) page2.push(`<section><div class="sh">Before &amp; After</div>${shots}</section>`);
  const secondPage = page2.join('').replace('<section>', '<section class="page2">');

  const logo = `<img class="logo" alt="Homestar HVAC Solutions" src="data:image/png;base64,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">`;

  const html = `
  <div class="rhead">
    <div class="brandrow">
      <div class="brand">${logo}</div>
      <div class="co">${phone?esc(phone):''}${email?'<br>'+esc(email):''}</div>
    </div>
    <div class="rtitle">
      <div class="k">Performance Verification</div>
      <h2>${clientName?esc(clientName)+' — ':''}Before &amp; After System Report</h2>
      <div class="verify">System airflow and static pressure were measured and verified with the TrueFlow® System Airflow and Static Pressure Analysis, before and after the upgrades performed by ${esc(co)}.</div>
    </div>
    <div class="metarow">
      ${clientAddr?`<div class="meta"><div class="l">Service address</div><div class="v">${esc(clientAddr)}</div></div>`:''}
      <div class="meta"><div class="l">Before tested</div><div class="v num">${before.date||'—'}</div></div>
      <div class="meta"><div class="l">After tested</div><div class="v num">${after.date||'—'}</div></div>
      <div class="meta"><div class="l">Technician</div><div class="v">${esc(tech)}</div></div>
    </div>
  </div>

  <section>
    <div class="sh">Verified Results at a Glance</div>
    <div class="hero">${hero}</div>
  </section>

  <section>
    <div class="sh">Summary Calculations — Before vs After</div>
    ${rails}
  </section>

  <section>
    <div class="sh">Air Measurements</div>
    <div class="two">
      <div class="panel before"><div class="pt">Before — ${before.date||''}</div><div class="dl">${measRows(before)}</div></div>
      <div class="panel after"><div class="pt">After — ${after.date||''}</div><div class="dl">${measRows(after)}</div></div>
    </div>
  </section>

  ${secondPage}

  <div class="rfoot">
    <div class="prep">Prepared by ${esc(tech)}<br><span>${esc(co)}</span></div>
    <div class="fl">Measurements captured with a calibrated TEC TrueFlow® flow grid and DG-8 pressure gauge. Values are field-measured operating parameters at the time of test.</div>
  </div>`;

  document.getElementById('sheet').innerHTML = html;
}
