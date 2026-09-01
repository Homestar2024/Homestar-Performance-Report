# Homestar HVAC — System Performance Verification Report

Turns a pair of TEC TrueFlow® PDF exports (before and after an upgrade) into a
branded, two-page, client-facing report showing the verified change in airflow
and static pressure, what it means for the homeowner, and optional before/after
photographs of the work.

The app is **`index.html`** plus the files that make it installable and
offline-capable — no build step, no backend, no third-party origin. It is
served from GitHub Pages, so pushing to `main` deploys it.

```
index.html              the whole app: parser, report, history
sw.js                   service worker — offline shell
manifest.webmanifest    install metadata
vendor/                 pdf.js 3.11.174, served from this origin
icons/                  192/512/maskable launcher icons
.nojekyll               serve the files as-is, no Jekyll processing
tests/                  not deployed
```

PDFs are parsed in the browser with [pdf.js](https://mozilla.github.io/pdf.js/)
3.11.174. **Nothing is uploaded anywhere and nothing is fetched from anywhere**
— customer measurements and photographs never leave the device; photos are
decoded, scaled and embedded entirely in the page. No `localStorage`, no
cookies, no analytics, no CDN.

## Install it on the phone

Open the site in Chrome on Android and use **Add to home screen** (Chrome
usually offers it by itself). It then launches like an app, without browser
chrome, and works with no signal — everything it needs was cached on the first
visit. iOS is the same via Share → Add to Home Screen.

Offline, the app tells you it is offline and keeps working: PDFs still parse,
reports still generate, history still saves. Only the first visit needs a
connection.

## Using it

1. Open the page, choose the before and after TrueFlow PDFs.
2. Optionally add a before photo and an after photo of the work.
3. The **Confirm & correct** panel appears. Check that the two columns are the
   right way round (⇄ Swap if not) and fix any value the parser got wrong.
   Values it could not find are highlighted — type them in.
4. Fill in client name, address and technician if you want them on the report.
5. **Generate report**, then **Print / Save as PDF** — which files the report to
   history on the way to the print dialog.

Print settings: **Scale 100%, Margins Default, Background graphics ON,
Headers/footers OFF.**

## Saved reports

**Print / Save as PDF** files the report to history and then opens the print
dialog. Printing the same job again updates that record rather than adding a
second one; the same customer on a different test date is a separate job and
gets its own record. **Save to history** does the same without printing.

Records are titled with the client name, falling back to the service address,
then to `Report — <date>`. Any of them can be renamed, and a renamed record
keeps its name through later prints. Opening a record restores the full
editable state — readings, client details, photos — so a mistyped address can
be corrected and reprinted, not just viewed.

### It is device storage, not a folder

History lives in **IndexedDB — in that browser, on that device**. It is not a
shared drive and it is not a backup:

- a report saved on the phone is not on the laptop;
- clearing site data erases it;
- browsers may evict storage under pressure (the app calls
  `navigator.storage.persist()` to reduce the odds, which is a request, not a
  guarantee).

**Export backup** writes the whole history to one JSON file, photos included,
which can then be kept in Drive or anywhere else. **Import backup** merges a
file back in, keeping whichever copy of a job is newer. That file is the only
copy that survives a lost phone — nothing else about this design does. A real
shared history would need a backend, which would also move customer data off
the device for the first time.

The File System Access API can write to an actual folder, but it is
Chrome-desktop only — not available on the Android phones this is used from —
so it is not an option here.

### Never let storage block printing

A technician standing in a customer's hallway needs the print dialog whether or
not the save worked. `#printBtn` saves inside a `try`, reports a failure in a
toast, and calls `window.print()` either way. There is a test for it. Keep it
that way.

### One job's photos must never reach another job's report

Photographs and client details belong to a single job, but the page persists
across jobs when the technician does not reload. Once a report has been filed
(`jobSaved`), the next PDF dropped in clears photos, client name and address —
technician stays, since that is the same person all day. Without it, back-to-back
jobs on one phone put one customer's photos on another customer's report. This
happened during development and only surfaced because a screenshot showed a
"photos" tag on a job that had none.

## Things that will bite you if you change the code

### The parser reads mangled text, on purpose

`readPDF()` joins pdf.js text items with spaces in **content-stream order**.
pdf.js splits f-ligatures into separate items, so the parser sees `Total air fl
ow`, `After fi lter`, `Up fl ow`, `o ffi ce@…`. Three defences exist and must
not be regressed:

- Total airflow anchors on the number before `SCFM`, excluding the per-ton
  value: `/([\d,.]+)\s*SCFM(?!\s*\/)/i`. It never matches the `Total air fl ow`
  label, which is exactly why it survives.
- After filter: `/After fi\s?lter\s*=\s*(-?[\d,.]+)/i`.
- Orientation and email are captured loosely, then whitespace-stripped.

**Validate parser changes against real browser pdf.js output only.** Python
extractors like pdfplumber sort by position and silently repair ligatures, so
they show you text the app will never see, and a regex tuned against them will
be wrong in production. `node tests/run.mjs` runs everything through real
headless Chromium for this reason.

### Never put a `<button>` inside a picker `<label>`

All four file pickers are a `<label>` wrapping a hidden `<input type="file">`.
A label with no `for` binds to the **first labelable descendant in tree
order** — and `<button>` is labelable. Put a button inside one and it silently
becomes the label's control, so every tap on the box activates the button and
the file dialog never opens. No error, no console warning; the box is simply
dead.

This shipped once, in the photo pickers' Remove button. The fix has two
independent guards: the Remove button is a positioned **sibling** of the label,
and the file input is the **first** child inside it. `tests/run.mjs` asserts
both — that each label's `.control` is its own input, and that clicking each
picker really does open a file chooser.

The general lesson for this repo: a test that pokes state directly
(`input.files = …`) proves the handler works, not that a human can reach it.
Anything a technician taps needs a test that taps it.

### Report rules that are deliberate

| Metric | Direction | Notes |
| --- | --- | --- |
| Total Airflow (SCFM) | up is good | |
| Total External Static Pressure | down is good | |
| Return Plenum | down is good | |
| Filter Drop | down is good | |
| Supply Plenum | down is good | **a rise is amber, not red** — supply static naturally rises with airflow, and must never be presented as a failure |

SCFM/ton and the System & Conditions section were removed on purpose. Don't add
them back.

Section order — page one: Header → Verified Results at a Glance → Summary
Calculations → Air Measurements. Page two: What This Means For Your Home →
Before & After (photos) → Footer.

### The benefit write-ups

Page two explains each measurement in plain language, and the copy is chosen by
**which way the number actually moved** — an airflow gain and an airflow loss
get different write-ups, as do a static-pressure drop and a rise. All of it
lives in the `BENEFITS` table in `index.html`, keyed by metric then `up`/`down`.
Each entry is a function handed the formatted numbers (`c.pct`, `c.b`, `c.a`)
so the copy quotes the job's real figures instead of reading like a template.

Two tiers:

- **Total Airflow** and **Total External Static Pressure** get a heading and a
  paragraph. These are the two the customer is paying for.
- **Return Plenum**, **Filter Drop** and **Supply Plenum** get one line each in
  a compact panel. Supply plenum matters most of the three: it is the metric
  that can legitimately go *up*, and its amber badge on page one invites the
  question "is that bad?" — the line answers it before the customer asks.

Nothing renders for a metric that did not move, or that is missing a before or
after value. The report never claims a benefit it cannot show a number for.

Keep the copy technically honest. Two traps worth knowing: more airflow does
**not** improve dehumidification (it raises the sensible heat ratio — if
anything it does the opposite), and restored airflow returns a system to its
*rated* capacity, it does not exceed it.

### Photographs

Optional, one before and one after. They are decoded with EXIF orientation
applied, scaled to a 1600px long edge and re-encoded as JPEG before being
embedded, so a 5MB phone photo does not bloat the page and nothing prints
sideways. Frames are fixed height with `object-fit: contain`, so portrait and
landscape shots both sit in a consistent frame and neither gets cropped. If
only one photo is added it renders on its own; if neither is, the section does
not appear.

### The report must fit exactly two Letter pages

`@media print` compresses spacing, hides the per-metric notes, sets
`@page { size: letter portrait; margin: 0.5in }`, and puts a hard page break
before the page-two content via `.page2`. The budget is 960px per page,
measured at true paper width (720px):

| | page 1 | page 2 |
| --- | --- | --- |
| typical | 879px (81px spare) | 812px (148px spare) |
| longest copy, both photos | 879px | 781px (179px spare) |

Anything that adds vertical height needs re-checking with a real print render,
not an eyeball:

```
node tests/print-check.mjs
```

It runs six content shapes — no photos, portrait photos, every metric moved the
wrong way (the longest copy), long client name — and fails if any of them is
not exactly two pages.

Note this only constrains the **report**. The uploader, photo pickers and the
Confirm & correct panel are hidden when printing, so they cost nothing on
paper.

### pdf.js ships with the app

`vendor/pdf.min.js` and `vendor/pdf.worker.min.js` are the pdf.js 3.11.174
build, committed to the repo and served from this origin. There is no CDN, so
there is nothing to be blocked, nothing to go stale, and no subresource
integrity hash to maintain. Replacing them means replacing both files together
and re-running the suite — the parser's regexes are tuned to how *this* version
tokenises text.

If pdf.js fails to load at all, the page says so and disables the uploads
rather than appearing to work and doing nothing.

### The service worker, and how not to brick the app

`sw.js` caches the shell on first visit. Two rules keep a bad release from
becoming permanent, and both matter more than they look:

1. **Navigations are network-first** (3s timeout, then cache). A fresh
   `index.html` always wins when there is any usable connection, so a broken
   release is fixed by pushing another one — not by asking a technician to
   clear site data in a crawlspace.
2. **The worker never calls `skipWaiting()` on its own.** A new version
   installs, then waits. The page shows "Update available — reload when you're
   between jobs" and only takes over when it is clicked. Nobody gets reloaded
   out of a half-finished report. A test asserts `skipWaiting` appears exactly
   once in `sw.js` and only inside the `SKIP_WAITING` message handler.

**Bump `VERSION` in `sw.js` whenever that file or the shell list changes.**
Old caches are deleted on activate by name prefix.

`.nojekyll` matters: without it GitHub Pages runs the files through Jekyll,
whose exclude rules can silently drop paths — `vendor/` among the candidates —
and a missing pdf.js would break the app with no build error anywhere.

The launcher icons are upscaled from the 180×180 mark embedded in the page, so
the 512 is slightly soft. A native 512×512 export of the "H" mark dropped into
`icons/` (same filenames) would sharpen it.

## Tests

```
cd tests
npm install          # playwright + pdfjs-dist
npx playwright install chromium
npm test             # the full suite
npm run print-check  # just the one-page check, with the numbers
```

Everything runs against `index.html` in real headless Chromium with real
pdf.js, served over `http://127.0.0.1` — a secure origin, so service workers
register exactly as they do in production. The suite is hermetic and needs no
network.

Service workers are **blocked by default** in tests: an active worker serving
from cache makes routing and timing nondeterministic. The PWA tests opt in with
`openApp(browser, origin, { serviceWorker: true })`.

One trap worth knowing: `page.waitForFunction` does **not** await a promise
returned by its predicate — it sees the Promise object, calls it truthy, and
resolves immediately. Anything that has to ask the service worker a question
must be polled from node with `pollEval`, where `page.evaluate` does await.

The suite covers parsing (ligature splits, the per-ton trap, thousands
separators), upload gating, before/after ordering and swapping, typed
overrides, metric directionality, benefit copy selection in both directions,
photo decode/downscale/removal, history save/reopen/rename/delete/search,
backup export and import, storage-failure fallback, cross-job carry-over,
offline operation end to end, the service-worker update handshake, manifest and
icon validity, and the two-page print at several content lengths.

### The corpus is the weak spot

The parser has only ever been proven against **two real exports from one job**.
Field layout and ligature behaviour may vary by fuel type, orientation,
equipment and TrueFlow app version. The synthetic PDFs in `tests/lib/make-pdf.mjs`
reproduce the *mechanism* faithfully — they are real PDFs, read by real pdf.js,
with real ligature splitting — but they cannot anticipate a layout nobody has
seen.

Closing that gap means collecting real exports:

- Drop `.pdf` files into `tests/fixtures/pdfs/` — the suite parses each one and
  asserts the six values the report needs. (Read that folder's README first:
  exports carry technician and company details, and this repo is public.)
- Or capture just the text, which is safe to commit and runs in milliseconds:

  ```
  node tests/capture-text.mjs ~/Downloads/some-export.pdf
  ```

  It prints what the parser found, flags anything it missed, and writes a
  fixture pair into `tests/fixtures/text/`.

## Ideas not yet built

Multiple techs / login · emailing the report from the app · cross-job
analytics off the stored history · custom domain (report.homestarhvac.ca) ·
more than one photo pair per report · pre-filling the address when a customer
name matches an existing record · shared history across devices, which needs a
backend.
