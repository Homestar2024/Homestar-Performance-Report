# Homestar HVAC — System Performance Verification Report

Turns a pair of TEC TrueFlow® PDF exports (before and after an upgrade) into a
branded, two-page, client-facing report showing the verified change in airflow
and static pressure, what it means for the homeowner, and optional before/after
photographs of the work.

The app is **`index.html`** plus the files that make it installable and
offline-capable — no build step, no backend, no third-party origin. It is
served from GitHub Pages, so pushing to `main` deploys it.

```
index.html              markup, styles, embedded logo and icons
app/core.js             config, shared state, METRICS/FIELDS, helpers
app/parser.js           reading TEC TrueFlow PDFs
app/intake.js           uploader, confirm & correct panel, photographs
app/report.js           shared shell, airflow scoring and write-ups
app/capacity.js         chooser, capacity entry flow and report
app/ocr.js              reading a BTU/h figure off a Testo screenshot
app/history.js          IndexedDB storage, backup, print actions
app/pwa.js              connection notice, service-worker updates
sw.js                   service worker — offline shell
manifest.webmanifest    install metadata
vendor/                 pdf.js 3.11.174, served from this origin
vendor/tesseract/       OCR engine + English data, ~6.8MB, lazily loaded
icons/                  192/512/maskable launcher icons
.nojekyll               serve the files as-is, no Jekyll processing
tests/                  not deployed
```

The `app/*.js` files are **classic scripts, not ES modules**, loaded in the
order listed. They share one global scope, which is why the split changed no
behaviour at all — execution order is identical to when it was one inline
block. Adding a file means adding a `<script>` tag *and* an entry in `sw.js`'s
`SHELL`, then bumping its `VERSION`.

PDFs are parsed in the browser with [pdf.js](https://mozilla.github.io/pdf.js/)
3.11.174. **Nothing is uploaded anywhere and nothing is fetched from anywhere**
— customer measurements and photographs never leave the device; photos are
decoded, scaled and embedded entirely in the page. No `localStorage`, no
cookies, no analytics, no CDN.

## Three report types

The chooser is the first screen:

- **Airflow** — the TrueFlow before/after report. Ducted work. Two pages.
- **Capacity** — delivered capacity per indoor unit, from Testo probe readings.
  Ductless, or ducted where only capacity matters. One page for a single head,
  growing with heads and photographs.
- **Combination** — both in one document. The airflow half keeps its own pages,
  then a hard break, then capacity.

Client name, address and technician are shared by all three.

### Capacity report

Up to five indoor units, entered one at a time in an accordion so a five-head
system does not become an endless scroll. Each head takes an area, unit type,
model, serial and a before/after BTU/h reading — the report prints the area as
a heading with unit type, model and serial on their own lines beneath it; supporting readings (return and
supply temp/RH, airflow, Hz/V) sit behind a disclosure and feed the operating
conditions section.

**The BTU/h figure is carried, never recomputed.** Testo derives total delivered
capacity (sensible + latent) from humidity probes at the return and supply; the
report prints that number and labels it for what it is. A dry-bulb-only
fallback would be sensible-only and must always be labelled as such — never
folded into a total.

Probe serial numbers are used internally to map readings but **never appear on
the report** — a customer has no use for them.

**Mode is detected from supply against return dry-bulb**, which holds whatever
the conditions. With only a supply reading it falls back to a 65°F threshold.
Either way the technician can override it, and once they do, detection stops
arguing.

Photographs: multiple before down the left column, multiple after down the
right, since a job can have several indoor units plus the outdoor unit.

### Reading a Testo screenshot

Each BTU/h field has a **Read from screenshot** button. Tesseract runs entirely
in the page — no server, no API key, nothing leaves the device. The screenshot
is read and discarded: never stored, never on the report, which shows data only.

Two Testo screens are parsed, both by structure rather than by hunting for
loose numbers:

- **Cooling and Heating Output** — the useful one. It carries the capacity
  *and* both probes, so one screenshot fills a whole phase. The two probe cards
  sit side by side and OCR reads across them, so the caption line holds both
  labels and the line beneath holds both numbers, left column first.
- **Differential Temperature (ΔT)** — one card per probe, titled by serial. The
  `PROBES` table maps 651 to return and 877 to supply; that is what the table
  is for. This screen has no capacity and the parser correctly reports none.

Capacity is anchored on the literal `BTU/h`, which is what stops a probe serial
being read as a reading. That was a real bug: the ΔT screen used to offer 877,
651 and 198 as capacities. A loose number-scanning fallback still exists for a
screen the parser does not recognise, and it still offers those — which is
precisely why the structured parse runs first.

**Nothing is ever written automatically.** Everything found is shown in a review
panel and applied only when *Use these readings* is tapped. This is not caution
for its own sake. In testing against a real screenshot, Tesseract read
`55.0 %RH` back as `95.0` — a single-digit error on a value that would have gone
onto a customer's verification document. The fields stay editable afterwards, so
there are two chances to catch it.

`tests/run.mjs` holds the verbatim OCR text of both real screenshots, misreads
included, so the parser is guarded on every run without paying for OCR.

The engine is ~6.8MB and is **deliberately not in the service worker's precache
list** — making every first install pay for an optional feature would be the
wrong trade. It loads on first use and the worker's runtime cache keeps it, so
OCR needs a connection once and works offline after that. If it cannot load,
the panel says so and the field is still typeable. Typing always works.

One core build (`tesseract-core-simd-lstm.wasm.js`) is pinned rather than
pointing at the directory: given a directory, Tesseract feature-detects and
requests whichever variant the device prefers, which would mean vendoring every
one of them. SIMD has been universal in Chrome since 2021.

### Honesty rules in the capacity report

- A change inside ±2% reads as **holding steady**, not as a win. Routine
  maintenance often moves capacity very little and dressing that up would make
  every report worthless.
- A real capacity loss is flagged, not buried.
- The report prints the outdoor temperature the rated figure is quoted at, and
  says plainly that capacity moves with outdoor conditions and readings taken
  at different temperatures are not comparable. There is one outdoor
  temperature, not a before and after pair: what the summed indoor total is
  judged against is the outdoor unit's rating *at a stated temperature*.
- Measured above rated is normal and shown as positive; below rated is neutral,
  not a failure.
- The rated comparison carries its caveats: nominal indoor conditions, and
  multi-zone diversity making this a sound field indicator rather than a
  commissioning figure.

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

There are two kinds of metric here, and conflating them produced the worst bug
this report has had.

**Verdicts** — judged on their own, and the only ones that can come back red:

| Metric | Direction |
| --- | --- |
| Total Airflow (SCFM) | up is good |
| Total External Static Pressure | down is good |

Those two *are* the job. The purpose of these upgrades is to move more air
against less resistance; everything else is a component of that outcome.

**Component pressures** — Return Plenum, Filter Drop, Supply Plenum. Marked
`context: true` in `METRICS`, and **never shown as a failure**.

Pressure drop across any path rises with the air travelling through it. So a
duct upgrade that clears a restriction and adds 21% airflow can push all three
*up* while the system gets materially better. A real job: airflow +21.2%, total
external static −58.8%, return plenum +2.7%, supply plenum +142.9%. Under the
old "lower is better" rule the return plenum was flagged red as "moved the
wrong direction — worth a look" and the write-up told the homeowner "something
on the return path is restricting more than it was". That was not merely
alarming, it was **wrong**: a path carrying 21% more air for 2.7% more pressure
got substantially less restrictive.

How they are scored now (`statusOf`, when passed the system context):

- fell → green;
- rose by proportionally **less than airflow** → green, because it is carrying
  more air for less pressure per unit of flow;
- otherwise → **neutral**, never red or amber.

The write-ups follow the same four readings — fell / beat the airflow / rose
anyway / the job missed its goals — and the last of those stays factual and
claims nothing.

**This does not make the report incapable of bad news.** Airflow and TESP still
go red, still say "Airflow decreased — worth investigating" and "the blower is
working harder", and there is a test asserting exactly that on a job that
missed. Honesty lives in the two metrics that carry the verdict; the components
stopped pretending to be verdicts.

Do not "fix" a component metric back to plain lower-is-better. Tests will fail,
and so will the physics.

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

**The wording is chosen by arithmetic, not written on demand.** There is no
model call and nothing to reach over a network: the sentences are in the file,
and the app picks between them by comparing the measurements. So the write-ups
behave identically offline, including the ones whose wording depends on
comparing one metric against another. A test drives the hardest case with the
connection cut and checks the same sentences come out.

Keep the copy technically honest. Three traps worth knowing: more airflow does
**not** improve dehumidification (it raises the sensible heat ratio — if
anything it does the opposite); restored airflow returns a system to its
*rated* capacity, it does not exceed it; and a component pressure rising is not
evidence of a restriction when airflow rose with it.

### Photographs

Optional, one before and one after. They are decoded with EXIF orientation
applied, scaled to a 1600px long edge and re-encoded as JPEG before being
embedded, so a 5MB phone photo does not bloat the page and nothing prints
sideways. Frames are fixed height with `object-fit: contain`, so portrait and
landscape shots both sit in a consistent frame and neither gets cropped. If
only one photo is added it renders on its own; if neither is, the section does
not appear.

### Print: airflow is pinned, capacity grows

**The airflow report must stay exactly two Letter pages.** Capacity and
combination grow with the number of heads and photographs, and must paginate
cleanly at any size.

The two are kept apart structurally, not by discipline: every element in the
capacity report uses a `cap`-prefixed class, and the capacity print rules live
in their own `@media print` block that only matches those. A capacity change
cannot reach the airflow report's layout.

`tests/print-check.mjs` renders eleven shapes across all three report types. It
checks the page count **and** that nothing was cut across a break — the latter
against real pagination, by pulling the text of each printed page and asserting
each indoor unit's name and both its readings land on the same one. A page
count alone would not catch a half-cut card.

### The airflow report's own budget

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

It runs seven content shapes — no photos, portrait photos, every metric moved
the wrong way, the real job where all three components rose (their longest
write-ups), long client name — and fails if any is not exactly two pages.

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
icon validity, the chooser and capacity entry flow, mode detection and
override, capacity scoring and caveats, combination assembly, and pagination
across all three report types.

One audit test is worth knowing about: it walks every element carrying the
`hidden` attribute and fails if any of them still renders. An author `display`
rule outranks the browser's `[hidden]{display:none}`, which silently broke both
PWA notices and left them on screen permanently. `[hidden]{display:none
!important}` now guards it, and the audit catches the next one.

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
