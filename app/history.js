/**
 * Saved reports: IndexedDB storage, backup export/import, print actions.
 */

/* ============================ Saved reports ============================
 *
 * History lives in IndexedDB, which means it is stored BY THIS BROWSER ON
 * THIS DEVICE. It is not a shared folder and it is not a backup: clearing
 * site data wipes it, and another device sees nothing. That is why Export
 * backup exists — it is the only copy that survives a lost phone.
 *
 * Nothing here may ever block printing. A tech standing in a customer's
 * hallway needs the print dialog whether or not the save worked.
 */

const DB_NAME = 'homestar-reports', DB_VER = 1, STORE = 'reports';
let dbPromise = null;

function db(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej)=>{
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { rej(e); return; }
    req.onupgradeneeded = ()=>{
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, {keyPath:'id'});
    };
    req.onsuccess = ()=>res(req.result);
    req.onerror = ()=>rej(req.error);
    req.onblocked = ()=>rej(new Error('database blocked'));
  });
  return dbPromise;
}

function dbRun(mode, fn){
  return db().then(d=>new Promise((res, rej)=>{
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.onerror = ()=>rej(t.error);
    t.onabort = ()=>rej(t.error || new Error('transaction aborted'));
    t.oncomplete = ()=>res(req ? req.result : undefined);
  }));
}

const dbAll = ()=> dbRun('readonly', st=>st.getAll()).then(r=>r||[]);
const dbGet = id=> dbRun('readonly', st=>st.get(id));
const dbPut = rec=> dbRun('readwrite', st=>st.put(rec));
const dbDel = id=> dbRun('readwrite', st=>st.delete(id));

const uid = ()=> (crypto.randomUUID ? crypto.randomUUID()
  : 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10));

/* Photos are held as Blobs in the database — base64 would cost a third more
   space for nothing — and converted back to data URLs to render. */
async function toBlob(dataUrl){
  if (!dataUrl) return null;
  return (await fetch(dataUrl)).blob();
}
function toDataUrl(blob){
  if (!blob) return Promise.resolve(null);
  if (typeof blob === 'string') return Promise.resolve(blob);   // already a data URL (imported)
  return new Promise((res, rej)=>{
    const fr = new FileReader();
    fr.onload = ()=>res(fr.result);
    fr.onerror = ()=>rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

let toastTimer = null;
function toast(msg, bad){
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  const old = document.querySelector('.toast');
  if (old) old.remove();
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.remove(), 4200);
}

/* One job = one record. Same customer on a later date is a new record, and
   re-printing the same job updates the one that is already there. */
const histKey = (name, bd, ad)=>
  [(name||'untitled').toLowerCase().replace(/\s+/g,' ').trim(), bd||'?', ad||'?'].join('|');

function currentTitle(client, addr, after){
  return client || addr || ('Report — ' + (after.date || new Date().toISOString().slice(0,10)));
}

async function saveCurrent(){
  const before = mergedData(order[0]), after = mergedData(order[1]);
  const client = $('cName').value.trim();
  const addr   = $('cAddr').value.trim();
  const tech   = $('cTech').value.trim();
  const key    = histKey(client || addr, before.date, after.date);
  const now    = new Date().toISOString();

  const existing = (await dbAll()).find(r=>r.key === key);
  const rec = {
    id: existing ? existing.id : uid(),
    key,
    title: existing && existing.renamed ? existing.title : currentTitle(client, addr, after),
    renamed: existing ? !!existing.renamed : false,
    client, addr, tech,
    before, after,
    photoBefore: await toBlob(photos[1]),
    photoAfter:  await toBlob(photos[2]),
    savedAt: existing ? existing.savedAt : now,
    updatedAt: now,
  };
  await dbPut(rec);
  jobSaved = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  return {rec, updated: !!existing};
}

async function saveAndReport(){
  const {rec, updated} = await saveCurrent();
  toast(`${updated ? 'Updated' : 'Saved'} in history as “${rec.title}”`);
  await renderHistory();
  return rec;
}

/* Reopening a record restores the full editable state, not a frozen picture,
   so a wrong address or a mistyped reading can be corrected and reprinted. */
async function openRecord(id){
  const rec = await dbGet(id);
  if (!rec){ toast('That report is no longer in history.', true); return; }
  for (const n of [1,2]){
    const src = n === 1 ? rec.before : rec.after;
    slots[n] = {fileName:'From history', ok:true, data:src};
    values[n] = {};
    for (const f of FIELDS) values[n][f.key] = src[f.key] == null ? '' : String(src[f.key]);
    const d = $('d'+n);
    d.classList.add('set'); d.classList.remove('err');
    $('fn'+n).innerHTML = '<b>From history</b>' + (values[n].date ? ' · ' + esc(values[n].date) : '');
  }
  order = [1,2];
  userOrdered = false;

  photos[1] = await toDataUrl(rec.photoBefore);
  photos[2] = await toDataUrl(rec.photoAfter);
  for (const n of [1,2]){
    $('pn'+n).textContent = photos[n] ? 'From history' : 'Tap to choose a photo';
    photoSet(n);
  }

  $('cName').value = rec.client || '';
  $('cAddr').value = rec.addr || '';
  $('cTech').value = rec.tech || '';
  $('review').hidden = false;
  syncReview();

  buildReport(mergedData(1), mergedData(2));
  document.body.classList.add('has-report');
  $('report').style.display = 'block';
  $('report').scrollIntoView({behavior:'smooth'});
  jobSaved = true;          // it is already in history; a new upload starts a fresh job
  toast(`Opened “${rec.title}”`);
}

function histSummary(rec){
  const bits = [];
  if (rec.before.date || rec.after.date) bits.push(`${rec.before.date||'?'} → ${rec.after.date||'?'}`);
  for (const key of ['totalFlow','tesp']){
    const m = METRICS.find(x=>x.key===key);
    const st = statusOf(m, rec.before[key], rec.after[key]);
    if (st.pct == null || !st.arrow) continue;
    bits.push(`<span class="${st.cls==='b'?'':'up'}">${st.arrow} ${Math.abs(st.pct).toFixed(0)}%</span> ${key==='totalFlow'?'airflow':'TESP'}`);
  }
  if (rec.photoBefore || rec.photoAfter) bits.push('photos');
  bits.push('saved ' + (rec.updatedAt || '').slice(0,10));
  return bits.join(' · ');
}

let histCache = [];

async function renderHistory(){
  try { histCache = await dbAll(); }
  catch (e) { console.error(e); $('histCard').hidden = true; return; }

  histCache.sort((a,b)=> (b.updatedAt||'').localeCompare(a.updatedAt||''));
  $('histCard').hidden = histCache.length === 0;   // no clutter until there is something in it
  $('histCount').textContent = histCache.length ? ` (${histCache.length})` : '';

  const q = $('histSearch').value.trim().toLowerCase();
  const rows = histCache.filter(r=> !q ||
    (r.title||'').toLowerCase().includes(q) || (r.addr||'').toLowerCase().includes(q));

  $('histList').innerHTML = rows.length ? rows.map(r=>`
    <div class="hrow">
      <div class="hmain">
        <div class="hname">${esc(r.title)}</div>
        <div class="hmeta">${histSummary(r)}</div>
      </div>
      <div class="hact">
        <button class="plink2" type="button" data-open="${r.id}">Open</button>
        <button class="plink2" type="button" data-rename="${r.id}">Rename</button>
        <button class="plink2 danger" type="button" data-del="${r.id}">Delete</button>
      </div>
    </div>`).join('')
    : `<div class="hempty">${histCache.length ? 'No report matches that search.' : 'No saved reports yet. Printing one saves it here.'}</div>`;

  if (navigator.storage && navigator.storage.estimate){
    try {
      const {usage} = await navigator.storage.estimate();
      const size = !usage ? '' : usage < 1048576
        ? `${Math.max(1, Math.round(usage/1024))} KB`
        : `${(usage/1048576).toFixed(1)} MB`;
      $('histUse').textContent = size ? `${size} used on this device` : '';
    } catch (e) { /* not worth reporting */ }
  }
}

$('histList').addEventListener('click', async e=>{
  const btn = e.target.closest('button'); if (!btn) return;
  const {open, rename, del} = btn.dataset;
  try {
    if (open) await openRecord(open);
    if (rename){
      const rec = await dbGet(rename); if (!rec) return;
      const name = prompt('Name for this report', rec.title);
      if (name == null || !name.trim()) return;
      rec.title = name.trim(); rec.renamed = true;
      await dbPut(rec); await renderHistory();
    }
    if (del){
      const rec = await dbGet(del); if (!rec) return;
      if (!confirm(`Delete “${rec.title}”? This cannot be undone.`)) return;
      await dbDel(del); await renderHistory();
      toast('Deleted from history.');
    }
  } catch (err) { console.error(err); toast('That did not work — see the console.', true); }
});

$('histToggle').addEventListener('click', ()=>{
  const body = $('histBody');
  body.hidden = !body.hidden;
  $('histToggle').textContent = body.hidden ? 'Show' : 'Hide';
  $('histToggle').setAttribute('aria-expanded', String(!body.hidden));
  if (!body.hidden){ $('histCard').hidden = false; renderHistory(); }
});
$('histSearch').addEventListener('input', renderHistory);

/* ---------- backup ---------- */

function download(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 30000);
}

$('histExport').addEventListener('click', async ()=>{
  try {
    const all = await dbAll();
    if (!all.length){ toast('Nothing to export yet.', true); return; }
    const reports = await Promise.all(all.map(async r=>Object.assign({}, r, {
      photoBefore: await toDataUrl(r.photoBefore),
      photoAfter:  await toDataUrl(r.photoAfter),
    })));
    download(
      new Blob([JSON.stringify({app:'homestar-performance-report', version:1, exported:new Date().toISOString(), reports}, null, 2)], {type:'application/json'}),
      `homestar-reports-${new Date().toISOString().slice(0,10)}.json`);
    toast(`Exported ${reports.length} report${reports.length===1?'':'s'}.`);
  } catch (e) { console.error(e); toast("Couldn't export the history.", true); }
});

$('histImportBtn').addEventListener('click', ()=> $('histImport').click());

$('histImport').addEventListener('change', async e=>{
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'homestar-performance-report' || !Array.isArray(data.reports))
      throw new Error('not a Homestar backup');
    const mine = await dbAll();
    let added = 0, refreshed = 0;
    for (const r of data.reports){
      if (!r || !r.id || !r.before || !r.after) continue;
      const existing = mine.find(x=>x.key === r.key);
      // A record already here wins unless the backup's copy is newer.
      if (existing && (existing.updatedAt||'') >= (r.updatedAt||'')) continue;
      await dbPut(Object.assign({}, r, {
        id: existing ? existing.id : r.id,
        photoBefore: await toBlob(r.photoBefore),
        photoAfter:  await toBlob(r.photoAfter),
      }));
      existing ? refreshed++ : added++;
    }
    await renderHistory();
    toast(`Imported — ${added} added, ${refreshed} updated.`);
  } catch (err) {
    console.error(err);
    toast("That file isn't a Homestar backup.", true);
  }
});

/* ---------- report actions ---------- */

$('printBtn').addEventListener('click', async ()=>{
  // Save first, but never let a storage problem stand between the tech and
  // the print dialog.
  try { await saveAndReport(); }
  catch (e) { console.error(e); toast("Couldn't save to history — printing anyway.", true); }
  window.print();
});

$('saveBtn').addEventListener('click', async ()=>{
  try { await saveAndReport(); }
  catch (e) { console.error(e); toast("Couldn't save to history.", true); }
});

$('resetBtn').addEventListener('click', ()=> location.reload());

renderHistory();
