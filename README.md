# Homestar HVAC — System Performance Verification Report

Turns a pair of TEC TrueFlow® PDF exports (before and after an upgrade) into a
branded, two-page, client-facing report showing the verified change in airflow
and static pressure, what it means for the homeowner, and optional before/after
photographs of the work.

The whole app is **`index.html`** — one static file, no build step, no backend.
It is served from GitHub Pages, so pushing to `main` deploys it.

PDFs are parsed in the browser with [pdf.js](https://mozilla.github.io/pdf.js/)
3.11.174 loaded from cdnjs. **Nothing is uploaded anywhere** — customer
measurements and photographs never leave the device; photos are decoded,
scaled and embedded entirely in the page. No `localStorage`, no cookies, no
analytics.

## Using it

1. Open the page, choose the before and after TrueFlow PDFs.
2. Optionally add a before photo and an after photo of the work.
3. The **Confirm & correct** panel appears. Check that the two columns are the
   right way round (⇄ Swap if not) and fix any value the parser got wrong.
   Values it could not find are highlighted — type them in.
4. Fill in client name, address and technician if you want them on the report.
5. **Generate report**, then **Print / Save as PDF**.

Print settings: **Scale 100%, Margins Default, Background graphics ON,
Headers/footers OFF.**

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

### pdf.js comes from a CDN

If cdnjs is unreachable the page now says so and disables the uploads instead of
appearing to work and doing nothing. That is a message, not a fix — the app
still needs the network on first load.

There is deliberately **no `integrity` hash** on the script tag: an incorrect
one takes the whole app down, and it has to be generated from the exact bytes
cdnjs serves. To add it from a machine that can reach the CDN:

```
curl -s https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

then put `integrity="sha384-<output>"` on the `<script>` tag and confirm the app
still loads. (Bundling pdf.js into the file instead would make it work offline
and drop the CDN entirely, at roughly +1.4MB.)

## Tests

```
cd tests
npm install          # playwright + pdfjs-dist
npx playwright install chromium
npm test             # the full suite
npm run print-check  # just the one-page check, with the numbers
```

Everything runs against `index.html` in real headless Chromium with real
pdf.js. The suite is hermetic — it serves the pdf.js build from `node_modules`
in place of the CDN, so it passes offline.

The suite covers parsing (ligature splits, the per-ton trap, thousands
separators), upload gating, before/after ordering and swapping, typed
overrides, metric directionality, benefit copy selection in both directions,
photo decode/downscale/removal, and the two-page print at several content
lengths.

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

Saved report history per client · multiple techs / login · emailing the report
from the app · cross-job analytics · custom domain (report.homestarhvac.ca) ·
bundling pdf.js for offline use · more than one photo pair per report.
