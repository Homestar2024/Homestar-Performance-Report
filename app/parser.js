/**
 * Reading TEC TrueFlow PDFs.
 *
 * pdf.js hands back text in content-stream order with f-ligatures split
 * into separate tokens ("Total air fl ow"). Every regex here is written
 * against that. See the README before touching one.
 */

async function readPDF(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;
  let t = '';
  for (let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const c = await page.getTextContent();
    t += ' ' + c.items.map(o=>o.str).join(' ');
  }
  return t.replace(/\s+/g,' ').trim();
}

function extract(t){
  const stamp = t.match(/Date tested:?\s*(\d{4}-\d{2}-\d{2})(?:\s*(?:at|,)?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?\s?[Mm]\.?)?))?/i);
  return {
    date:         stamp ? stamp[1] : null,
    time:         stamp && stamp[2] ? stamp[2].replace(/\s+/g,'').toUpperCase() : null,
    totalFlow:    numOr(rx(t, /([\d,.]+)\s*SCFM(?!\s*\/)/i)),
    returnDuct:   numOr(rx(t, /Return duct\s*=\s*(-?[\d.]+)/i)),
    afterFilter:  numOr(rx(t, /After fi\s?lter\s*=\s*(-?[\d,.]+)/i)),
    supplyDuct:   numOr(rx(t, /Supply duct\s*=\s*(-?[\d.]+)/i)),
    tesp:         numOr(rx(t, /TESP\s+([\d.]+)/i)),
    returnPlenum: numOr(rx(t, /Return Plenum\s+([\d.]+)/i)),
    filterDrop:   numOr(rx(t, /Filter Drop\s+([\d.]+)/i)),
    supplyPlenum: numOr(rx(t, /Supply Plenum\s+([\d.]+)/i)),
    sysMode:      rx(t, /System Mode:\s*([A-Za-z]+)/i),
    climate:      rx(t, /Cooling Climate:\s*([A-Za-z]+)/i),
    elevation:    rx(t, /Elevation:\s*([\d.]+\s*ft)/i),
    returnTemp:   rx(t, /Return temp:\s*([\d.]+)\s*.?\s*F/i),
    sysType:      rx(t, /System Type:\s*([A-Za-z]+)/i),
    orientation:  tight(firstRx(t, [/Orientation:\s*([A-Za-z ]+?)\s*Cooling Capacity/i, /Orientation:\s*([A-Za-z]+)/i])),
    coolCap:      rx(t, /Cooling Capacity:\s*([\d.]+)/i),
    filterLoc:    rx(t, /Filter Location:\s*([A-Za-z]+)/i),
    company:      rx(t, /Company info\s*Name:\s*([^]*?)\s*Phone:/i),
    phone:        rx(t, /Phone:\s*([\d]+)/i),
    email:        tight(rx(t, /Email:\s*([A-Za-z0-9._ ]+@[A-Za-z0-9.\-]+)/i)),
    tech:         rx(t, /Tech info\s*Name:\s*([A-Za-z .'-]+?)\s*ID:/i),
  };
}
