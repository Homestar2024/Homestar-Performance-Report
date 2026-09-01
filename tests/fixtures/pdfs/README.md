# Real TEC TrueFlow exports

Drop real `.pdf` exports in this folder. `node tests/run.mjs` picks up every PDF
here automatically and asserts the parser finds the six values the report is
built from (date, total airflow, TESP, return plenum, filter drop, supply
plenum). Nothing here is required for the suite to run.

**These are customer documents.** TEC exports show `Customer: N/A`, but they do
carry the technician's name, the company's email and phone, and the job's test
dates. Check what a file contains before committing it to a public repo — the
repo is public because it is served from GitHub Pages.

Worth collecting, since the parser has only ever been proven against two
exports from one job:

- both fuel types (gas furnace, heat pump / air handler)
- each system orientation (upflow, downflow, horizontal)
- a filter in a different location
- exports from an older and a newer version of the TrueFlow app
- anything that came out looking wrong in the field

If a real export fails, capture its text with
`node tests/capture-text.mjs <file.pdf>` and fix the regex against that text —
never against pdfplumber output, which silently repairs the ligature splits the
browser actually produces.
