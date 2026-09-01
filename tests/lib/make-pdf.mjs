/**
 * Builds minimal, real PDFs whose extracted text reproduces the two behaviours
 * that make TEC TrueFlow parsing fragile:
 *
 *   1. f-ligatures arrive as separate tokens ("Total air" "fl" "ow"), because
 *      each fragment is drawn in its own BT/ET block and pdf.js emits one text
 *      item per block. index.html joins items with a space, so the parser sees
 *      "Total air fl ow" exactly as it does in the browser with a real export.
 *   2. tokens come back in content-stream order, not position-sorted order —
 *      so a fragment written later in the stream is read later, wherever it
 *      sits on the page.
 *
 * These are hand-built stand-ins, not captured TEC exports. Real exports belong
 * in tests/fixtures/pdfs/ (see the README there); the suite picks them up
 * automatically and tests them the same way.
 */

const esc = t => String(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** One drawn fragment = one pdf.js text item. */
function block(text, x, y) {
  return `BT /F1 9 Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`;
}

/**
 * @param {string[]} lines  Each entry is one line; split a line into separate
 *                          pdf.js tokens by writing it as an array of strings.
 */
export function pdfFromTokens(lines) {
  let content = '';
  let y = 750;
  for (const line of lines) {
    const parts = Array.isArray(line) ? line : [line];
    let x = 40;
    for (const part of parts) {
      content += block(part, x, y);
      x += Math.max(12, part.length * 5); // rough advance; position is irrelevant to the parser
    }
    y -= 14;
    if (y < 40) y = 750; // wrap rather than run off the page
  }

  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}endstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Default measurements — a believable before/after pair for a duct upgrade. */
export const BEFORE = {
  date: '2026-08-14', totalFlow: '842', perTon: '281',
  returnDuct: '-0.412', afterFilter: '-0.520', supplyDuct: '0.395',
  tesp: '0.807', returnPlenum: '0.412', filterDrop: '0.108', supplyPlenum: '0.395',
};
export const AFTER = {
  date: '2026-08-20', totalFlow: '1,164', perTon: '388',
  returnDuct: '-0.196', afterFilter: '-0.241', supplyDuct: '0.428',
  tesp: '0.624', returnPlenum: '0.196', filterDrop: '0.045', supplyPlenum: '0.428',
};

/**
 * A TrueFlow-shaped report. `omit` drops fields to simulate a layout the
 * regexes don't cover; `time` adds a clock time after the test date.
 */
export function trueFlowPdf(v, { omit = [], time = null } = {}) {
  const has = k => !omit.includes(k);
  const lines = [
    ['TrueFlow', '®', ' System Air ', 'fl', 'ow and Static Pressure Analysis'],
    [`Date tested: ${v.date}${time ? ' ' + time : ''}`],
    ['Customer: N/A'],
    ['System Mode: Cooling  System Type: Heat  Cooling Climate: Dry'],
    ['Orientation: Up', 'fl', 'ow  Cooling Capacity: 3.0 ton'],
    ['Elevation: 25 ft  Return temp: 72 \u00B0 F  Filter Location: Return'],
    // Per-ton is drawn BEFORE the total, so the total-airflow regex has to
    // reject it via the (?!\s*\/) lookahead rather than by position.
    ['Air ', 'fl', 'ow per ton', `  ${v.perTon} SCFM /ton`],
    ['Total air ', 'fl', 'ow', has('totalFlow') ? `  ${v.totalFlow} SCFM` : '  -- SCFM'],
    ['Static pressures'],
    [`Return duct = ${v.returnDuct}`],
    ['After ', 'fi', `lter = ${v.afterFilter}`],
    [`Supply duct = ${v.supplyDuct}`],
    ['Summary Calculations'],
    ...(has('tesp') ? [[`TESP ${v.tesp}`]] : []),
    ...(has('returnPlenum') ? [[`Return Plenum ${v.returnPlenum}`]] : []),
    ...(has('filterDrop') ? [[`Filter Drop ${v.filterDrop}`]] : []),
    ...(has('supplyPlenum') ? [[`Supply Plenum ${v.supplyPlenum}`]] : []),
    ['Company info Name: Homestar HVAC Solutions Phone: 2505551234'],
    ['Email: o', 'ffi', 'ce@homestarhvac.ca'],
    ["Tech info Name: Calvin Windsor ID: 4471"],
  ];
  return pdfFromTokens(lines);
}

/** A valid PDF that is not a TrueFlow report at all. */
export function unrelatedPdf() {
  return pdfFromTokens([['Invoice #4471'], ['Thanks for your business.'], ['Total due: $2,480.00']]);
}
