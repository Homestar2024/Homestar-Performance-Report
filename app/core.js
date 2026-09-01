/**
 * Shared configuration, state and helpers.
 *
 * Loaded first. Everything below lives in one global scope on purpose:
 * these are classic scripts, not modules, so the split is purely about
 * file size and nothing about execution changed when it was made.
 */

const PDF_WORKER = './vendor/pdf.worker.min.js';
const PDFJS_READY = typeof pdfjsLib !== 'undefined' && typeof pdfjsLib.getDocument === 'function';
if (PDFJS_READY) pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

/* slots[n] = {fileName, ok, data} — ok:false means the file could not be read at all */
const slots  = {1:null, 2:null};
/* values[n][key] = string shown in the confirm panel (parsed value, or whatever the tech typed) */
const values = {1:{},   2:{}};
let order = [1,2];        // order[0] = the "before" slot, order[1] = the "after" slot
let userOrdered = false;  // true once the tech has hit Swap — stop re-deriving from dates
let jobSaved = false;     // this job has been printed or saved; the next upload starts a new one
let reportType = 'airflow';  // airflow | capacity | combination — set by the chooser

const METRICS = [
  {key:'totalFlow',    name:'Total Airflow',                    unit:'SCFM',       dir:'up',   dp:0},
  {key:'tesp',         name:'Total External Static Pressure',   unit:'in H₂O',     dir:'down', dp:3},
  // Component pressures. These are NOT verdicts on their own: pressure drop
  // across any path rises with the air moving through it, so a duct upgrade
  // that adds airflow can raise all three while the system as a whole gets
  // materially better. They are scored against what the system achieved
  // (see statusOf) and are never shown as a failure.
  {key:'returnPlenum', name:'Return Plenum',                    unit:'in H₂O',     dir:'down', dp:3, context:true},
  {key:'filterDrop',   name:'Filter Drop',                      unit:'in H₂O',     dir:'down', dp:3, context:true},
  {key:'supplyPlenum', name:'Supply Plenum',                    unit:'in H₂O',     dir:'down', dp:3, context:true},
];

/* Everything the report can show, in the order it reads best on screen.
   `need` marks the values the report is actually built from. */
const FIELDS = [
  {key:'date',         label:'Date tested',   hint:'YYYY-MM-DD', text:true},
  {key:'totalFlow',    label:'Total airflow', unit:'SCFM',   need:true},
  {key:'tesp',         label:'Total external static', unit:'in H₂O', need:true},
  {key:'returnPlenum', label:'Return plenum', unit:'in H₂O', need:true},
  {key:'filterDrop',   label:'Filter drop',   unit:'in H₂O', need:true},
  {key:'supplyPlenum', label:'Supply plenum', unit:'in H₂O', need:true},
  {key:'returnDuct',   label:'Return duct',   unit:'in H₂O'},
  {key:'afterFilter',  label:'After filter',  unit:'in H₂O'},
  {key:'supplyDuct',   label:'Supply duct',   unit:'in H₂O'},
];

const rx = (t, re) => { const m = t.match(re); return m ? m[1].trim() : null; };
const firstRx = (t, arr) => { for (const re of arr){ const m = t.match(re); if (m) return m[1].trim(); } return null; };
const numOr = (v) => { if (v==null) return null; const n = parseFloat(String(v).replace(/,/g,'')); return Number.isFinite(n) ? n : null; };
const tight = (v) => v ? v.replace(/\s+/g,'') : null;
const $ = id => document.getElementById(id);
