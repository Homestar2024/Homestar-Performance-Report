/**
 * The uploader: confirm & correct panel, before/after ordering, photographs.
 */

/* ---------- confirm & correct ---------- */

// Sortable "when was this tested" key. 12h times are normalised so 1:05 PM sorts after 11:00 AM.
function stampOf(n){
  const d = (values[n].date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = slots[n] && slots[n].data ? slots[n].data.time : null;
  if (!t) return d;
  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(A\.?M\.?|P\.?M\.?)?$/i);
  if (!m) return d;
  let h = parseInt(m[1],10);
  const ap = (m[3]||'').replace(/\./g,'').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return d + ' ' + String(h).padStart(2,'0') + ':' + m[2];
}

function deriveOrder(){
  if (userOrdered) return;
  const a = stampOf(1), b = stampOf(2);
  order = (a && b && a !== b && a > b) ? [2,1] : [1,2];
}

function orderNote(){
  const a = stampOf(1), b = stampOf(2);
  if (userOrdered) return {text:'Order set by hand. Check the two columns are the right way round before generating.', flag:true};
  if (!a || !b) return {text:'No test date on one of the reports, so before/after follows the upload slots. Check the two columns are the right way round.', flag:true};
  if (a === b) return {text:'Both reports carry the same test date and time, so before/after follows the upload slots. Check the two columns are the right way round.', flag:true};
  return {text:'Ordered by test date. Correct any value the parser got wrong — the report is built from what you see here.', flag:false};
}

function buildReviewRows(){
  const host = $('rvrows');
  host.innerHTML = FIELDS.map(f=>`
    <div class="rvrow">
      <div class="rvl">${f.label}${f.unit?` <span class="u">${f.unit}</span>`:''}</div>
      <input data-key="${f.key}" data-pos="b" inputmode="${f.text?'text':'decimal'}" placeholder="${f.hint||'—'}" aria-label="${f.label} before">
      <input data-key="${f.key}" data-pos="a" inputmode="${f.text?'text':'decimal'}" placeholder="${f.hint||'—'}" aria-label="${f.label} after">
    </div>`).join('');
  host.querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const slot = inp.dataset.pos === 'b' ? order[0] : order[1];
      values[slot][inp.dataset.key] = inp.value;
      clearReport();
      markMissing();
      setStatus();
    });
    // A corrected date can change which report is the "before" — but only once
    // the tech has finished typing it. Re-ordering mid-keystroke would move the
    // column they are typing into.
    if (inp.dataset.key === 'date'){
      inp.addEventListener('change', ()=>{ if (!userOrdered){ deriveOrder(); syncReview(); } });
    }
  });
}

function markMissing(){
  $('rvrows').querySelectorAll('input').forEach(inp=>{
    const f = FIELDS.find(x=>x.key===inp.dataset.key);
    const raw = inp.value.trim();
    const unusable = !raw || (!f.text && numOr(raw)===null);
    inp.classList.toggle('miss', !!f.need && unusable);
  });
}

function missingCount(){
  return $('rvrows').querySelectorAll('input.miss').length;
}

function syncReview(){
  const [bi, ai] = order;
  $('hb').textContent = slots[bi].fileName;
  $('ha').textContent = slots[ai].fileName;
  const sub = n => { const d = slots[n].data || {}; return [values[n].date || 'no date', d.time || ''].filter(Boolean).join(' · '); };
  $('hbs').textContent = sub(bi);
  $('has').textContent = sub(ai);
  const note = orderNote();
  $('rvnote').textContent = note.text;
  $('rvnote').classList.toggle('flag', note.flag);
  $('rvrows').querySelectorAll('input').forEach(inp=>{
    const slot = inp.dataset.pos === 'b' ? bi : ai;
    inp.value = values[slot][inp.dataset.key] ?? '';
  });
  markMissing();
  setStatus();
}

function setStatus(){
  const s = $('status'), gen = $('gen');

  // A capacity report has no PDFs to wait on — it gates on the head readings.
  if (reportType === 'capacity'){
    const ready = capReady();
    gen.disabled = !ready;
    s.classList.remove('bad');
    s.textContent = ready ? 'Ready. Check the readings, then generate.' : 'Every indoor unit needs an area and both readings.';
    return;
  }

  if (!PDFJS_READY){ s.classList.add('bad'); s.textContent = 'PDF reader unavailable.'; gen.disabled = true; return; }
  const bothRead = slots[1] && slots[1].ok && slots[2] && slots[2].ok;
  const anyFail  = (slots[1] && !slots[1].ok) || (slots[2] && !slots[2].ok);
  // Combination needs the capacity side finished too.
  const capOk = reportType !== 'combination' || capReady();
  gen.disabled = !bothRead || !capOk;
  s.classList.toggle('bad', !!anyFail);
  if (anyFail){ s.textContent = 'One report could not be read. Replace it to continue.'; return; }
  if (!bothRead){
    s.textContent = 'Waiting for ' + (!slots[1] && !slots[2] ? 'two reports' : 'one more report') + '.';
    return;
  }
  if (!capOk){ s.textContent = 'Airflow captured. Finish the indoor units below.'; return; }
  const miss = missingCount();
  s.textContent = miss
    ? 'Check the highlighted ' + (miss===1 ? 'value' : miss + ' values') + ' — they didn\'t come off the PDF.'
    : 'Ready. Check the columns, then generate.';
}

function slotSet(n){
  const drop = $('d'+n), fn = $('fn'+n), d = slots[n];
  if (!d) return;
  drop.classList.toggle('err', !d.ok);
  drop.classList.toggle('set', !!d.ok);
  if (!d.ok){
    fn.innerHTML = '<b>' + esc(d.error || 'Couldn\'t read this PDF.') + '</b>';
  } else {
    fn.innerHTML = '<b>' + esc(d.fileName) + '</b>' + (values[n].date ? ' · ' + esc(values[n].date) : '');
  }
  const bothRead = slots[1] && slots[1].ok && slots[2] && slots[2].ok;
  $('review').hidden = !bothRead;
  if (bothRead){ deriveOrder(); syncReview(); } else { setStatus(); }
}

[1,2].forEach(n=>{
  $('f'+n).addEventListener('change', async e=>{
    const file = e.target.files[0]; if(!file) return;
    clearReport();
    startNewJobIfFiled();
    $('fn'+n).textContent = 'Reading…';
    try{
      const text = await readPDF(file);
      const data = extract(text);
      slots[n] = {fileName:file.name, ok:true, data};
      values[n] = {};
      for (const f of FIELDS){
        const v = data[f.key];
        values[n][f.key] = v==null ? '' : String(v);
      }
      if (!$('cTech').value.trim() && data.tech) $('cTech').value = data.tech;
    }catch(err){
      console.error(err);
      const msg = /worker|fetch|network|dynamically imported/i.test(String(err && err.message))
        ? 'Couldn\'t start the PDF reader — check your connection.'
        : 'Couldn\'t read this PDF. Is it a TrueFlow report?';
      slots[n] = {fileName:file.name, ok:false, error:msg};
      values[n] = {};
    }
    userOrdered = false;
    slotSet(n);
  });
});

/* Any change to the inputs retires the report on screen, so nothing can be
   printed that no longer matches what is in the confirm panel. */
function clearReport(){
  document.body.classList.remove('has-report');
  $('report').style.display = 'none';
  $('sheet').innerHTML = '';
}

$('swap').addEventListener('click', ()=>{
  clearReport();
  order = [order[1], order[0]];
  userOrdered = true;
  syncReview();
});

/**
 * Photographs and client details belong to one job. Once a job has been
 * filed to history, the next PDF dropped in starts a different one — carry
 * them over and a customer ends up holding a report with someone else's
 * photos on it. The technician's name is not per job, so it stays.
 */
function startNewJobIfFiled(){
  if (!jobSaved) return;
  jobSaved = false;
  const hadPhotos = !!(photos[1] || photos[2]);
  for (const n of [1,2]){
    photos[n] = null;
    $('pf'+n).value = '';
    $('pn'+n).textContent = 'Tap to choose a photo';
    photoSet(n);
  }
  const hadDetails = !!($('cName').value.trim() || $('cAddr').value.trim());
  $('cName').value = '';
  $('cAddr').value = '';
  capReset();
  if (hadPhotos || hadDetails)
    toast('Starting a new job — photos and client details cleared. The last one is in your history.');
}

/* ---------- before / after photographs ---------- */

const photos = {1:null, 2:null};   // 1 = before, 2 = after; data URLs
const PHOTO_MAX = 1600;            // long edge, px — ~4x what the printed frame needs

/**
 * Phone photos run 3-5MB and often carry an EXIF rotation. Decode with the
 * orientation applied, scale the long edge down to PHOTO_MAX and re-encode as
 * JPEG, so the report stays a manageable size and nothing prints sideways.
 */
async function loadPhoto(file){
  let src;
  try {
    src = await createImageBitmap(file, {imageOrientation:'from-image'});
  } catch (e) {
    src = await new Promise((res, rej)=>{
      const img = new Image();
      img.onload = ()=>res(img);
      img.onerror = ()=>rej(new Error('not an image'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('not an image');
  const scale = Math.min(1, PHOTO_MAX / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  if (src.close) src.close();
  return cv.toDataURL('image/jpeg', 0.85);
}

function photoSet(n){
  const drop = $('p'+n), img = $('pi'+n);
  drop.classList.toggle('set', !!photos[n]);
  img.src = photos[n] || '';
}

[1,2].forEach(n=>{
  $('pf'+n).addEventListener('change', async e=>{
    const file = e.target.files[0]; if(!file) return;
    clearReport();
    $('pn'+n).textContent = 'Reading…';
    try{
      photos[n] = await loadPhoto(file);
      $('pn'+n).textContent = file.name;
    }catch(err){
      console.error(err);
      photos[n] = null;
      $('pn'+n).textContent = "Couldn't read that image. Try another.";
    }
    photoSet(n);
  });
});

document.querySelectorAll('.plink').forEach(btn=>{
  btn.addEventListener('click', e=>{
    e.preventDefault();
    const n = btn.dataset.clear;
    clearReport();
    photos[n] = null;
    $('pf'+n).value = '';
    $('pn'+n).textContent = 'Tap to choose a photo';
    photoSet(n);
  });
});

/* Report data = what the PDF gave us, overridden by whatever is in the confirm panel. */
function mergedData(n){
  const out = Object.assign({}, slots[n].data);
  for (const f of FIELDS){
    const raw = (values[n][f.key] ?? '').trim();
    out[f.key] = f.text ? (raw || null) : (raw === '' ? null : numOr(raw));
  }
  return out;
}

$('gen').addEventListener('click', ()=> generateReport());

if (!PDFJS_READY){
  $('loadWarn').hidden = false;
  [1,2].forEach(n=>{ $('f'+n).disabled = true; $('d'+n).style.opacity = .5; });
}
buildReviewRows();
setStatus();
