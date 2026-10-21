# CEICA web app

CEICA as a static web app, served by GitHub Pages at `https://usace-wrises.github.io/ceica/`: it runs
entirely in the browser, works offline after one visit, and installs as an app.

It began as a TypeScript clone of CEICA's Shiny for Python app and was proven equal to it, value for
value, page for page and file for file, before it replaced it (version 1.0.0, 2026-10-20). The
comments that name Python files (`ceica/`, `views/`, `app.py`, `tests/test_*.py`, `parity/make_*.py`)
refer to that app and the tools that wrote the goldens; they record where each piece came from.

## Commands

```bash
npm --prefix web ci                 # the tools (Node 22.18 or later)
npm --prefix web run dev            # the page at http://localhost:5190/
npm --prefix web run build          # the site, into web/dist
npm --prefix web run preview        # the built site at http://localhost:5191/ceica/
npm --prefix web test               # Vitest: every test in tests/
npm --prefix web run typecheck      # the app, then tools/
npm --prefix web run bench          # the engine's timings
npm --prefix web run offline        # offline use, install and updates, in headless Edge
npm --prefix web run offline -- --serve --port 5193   # builds A and B served for a person
npm --prefix web run live           # the published site, checked against the same build
npm --prefix web run freeze         # the goldens' list written again (tests/fixtures/README.md)
```

Two PowerShell scripts check the files in Office: `tools/office_check.ps1 -Dir <folder>` opens every
Word file and workbook and reports any that needs repair, and `tools/export_charts.ps1` saves a
calculator's charts as Excel draws them.

## Layout

| Path | What it holds |
|---|---|
| `index.html`, `site.ts` | The page: `site.ts` (a Vite plugin) writes its head in the Shiny page's order, its stylesheets written in, and its body from `src/app/ui.ts`, as py-shiny served it. |
| `appWorker.ts`, `sw/` | The offline worker: `sw/app-sw.js`, which the build writes into `dist` as `app-sw.js` with the build's id and files (`appWorker.ts`, a Vite plugin). |
| `page/` | Files served as they are: CEICA's stylesheet, script, fonts and icons, py-shiny's Bootstrap and fill stylesheets and fonts, `boot.js`, the download worker, the web app manifest and its icons (`icons/`), and `licenses.txt`, the third-party notices. The stylesheets are written into the page, so the build leaves them out. |
| `src/app/` | The page's program: `main.ts` (boot), `session.ts`, `reactive.ts` and `server.ts` (the controller, below), `client.ts` (shiny.js's part), `storage.ts` (autosave), `ui.ts` (the skeleton); the downloads' jobs (`files.ts`), the worker that runs them (`filesWorker.ts`) and the canvas the PNG figures are drawn on (`canvasPng.ts`); the offline copy and its updates (`offline.ts`). |
| `src/shiny/` | htmltools and Shiny's markup (`htm.ts`, `shinyui.ts`), the stand-ins `ceica.js` talks to (`shim.ts`), notifications, downloads and bslib's column grid. |
| `src/views/` | Every page and dialog, the edits and the grid cells, one file per module of the Python app's `views/`. |
| `src/engine/` | The engine, one file per module of the Python engine, in the same order and with the same names. Functions are camelCase; models and results keep the Python field names. It holds the analysis, the figures (SVG, and PNG and PDF drawings), the report and its documents and zips, the calculator, the templates and the importer (`workbook/`), and the STAF import. |
| `src/files/` | The file formats as Python's libraries write and read them, for CEICA's files only: `zip.ts` (zipfile; pako 2.2.0 deflates as zlib 1.3.1 does), csv, XML, CPython's set order, `describe.ts`; `xlsx/` (openpyxl 3.1.5's writer and reader), `pdf/` (STAF's port of reportlab 4.5.1, completed) and `docx/` (python-docx 1.2.0). |
| `src/content/` | The bundled examples, reportlab's font metrics, openpyxl's theme part and the Word file's constant parts (see "Copies"). |
| `src/py/` | Python behavior. `pyfmt.ts`, `pyjson.ts` and `bytes.ts` are STAF's. `pynum.ts`: `.15g`, `round`, compensated `sum`, exact ratios, the correctly rounded power `crPow` and log `crLog1p`. `pystr.ts` holds `str` methods and `float()` of a text. |
| `tests/` | One test file per golden; the Python engine's own tests, ported (Hypothesis became fast-check, with the same example counts); `differences.test.ts`; the page's wiring in happy-dom (`wiring.test.ts`); the repository's rules (`repo_rules.test.ts`); the pinned release identity (`identity.ts`, `identity.test.ts`) and the frozen goldens (`frozen.test.ts`). |
| `tests/fixtures/` | The goldens, frozen (their `README.md`), with the copies of the examples, the v1 and v2 files and Utoy's published tables. |
| `tests/oracles/` | The ecorest reference, and the IWR Planning Suite II reference where it is kept (see "The references"). |
| `tools/` | Node tools (TypeScript run as it is): the offline checks (`offline.ts`, with `edge.ts`, headless Edge over the DevTools protocol, and `pages.ts`, a stand-in for GitHub Pages), the goldens' list (`freeze.ts`), and the two Office scripts. |
| `bench/` | `timings.test.ts`, which `npm run bench` runs on its own config. |

The repository's `.github/workflows/pages.yml` tests and builds every push and deploys `main` to Pages.

## The page

The Shiny page was plain htmltools markup, one event channel (`page/ceica.js` posts every click and
change to `ce_event`) and a server that redraws outputs. This page is the same page with the server
inside it:

- **The controller** (no DOM) is `app.py`'s server, ported line by line (`server.ts`) onto a port of py-shiny's reactive core (`reactive.ts`: values with Python's identity rule, calcs, effects with priority and suspension, events, `invalidate_later`, the flush order) and of its session (`session.ts`: inputs, outputs suspended while hidden, downloads, and the messages in py-shiny's order).
- **shiny.js's part** (`client.ts`): the bindings (classes, `aria-live`, download links enabled, a value already sent drawn at bind; each input's events heard on the document, before `ceica.js` hears them, as an input's own listeners are), the input chain (a 250 ms pause while typing, no resend of an unchanged value, event inputs sent at once), each output's visibility from the layout (after a bind, and 100 ms after its resize or intersection observer sees a change), the message handlers in shiny.js's order, dialogs, notifications, conditional panels and the page switch.
- **`page/ceica.js` runs unchanged.** `page/boot.js` installs the two globals it expects (`Shiny` and `jQuery(document).on`); the jQuery stand-in leaves once `ceica.js` has loaded.
- **Timing.** A message reaches the controller two tasks after it is sent, so `ceica.js`'s zero-delay focus check runs first, as it does before a server's answer. While a pointer is down nothing reaches the controller until its click has fired, so a change sent as a field is left never redraws the button being clicked.
- **Storage.** Autosave keeps each project and the Recent list in IndexedDB (database `ceica`), in one transaction; `ceica.js`'s localStorage handlers are answered by the page instead. After the first autosave this browser keeps, the page asks for persistent storage, once a visit and quietly. It covers the whole origin (`usace-wrises.github.io`), STAF's app and its read cache included. Edge grants it or not without asking (an installed app, or a site used often, is granted); Firefox asks.
- **The head.** The stylesheets are written into it as `<style data-ceica-src>` elements, in the Shiny page's order (Bootstrap's import of `font.css` replaced by `font.css` itself, every address made relative to the page with its `?v=`): under the USACE network's browser isolation, a linked stylesheet did not apply in STAF's app. The tabset id is drawn from the page itself, so the same sources build the same page, byte for byte, and an unchanged build is no update. The page says `noindex`: search engines leave the site out.

## Offline, install and updates

- **The worker.** `sw/app-sw.js`, written into the build as `app-sw.js` with the build's id (a hash of the worker and every file's name and bytes) and its files, each with its sha256 (`appWorker.ts`). Its scope is the app's folder, beside the download worker's `download/`, which it leaves alone.
  - **Install:** every file of the build, a file whose name has no hash asked for by its content (`?v=`, as the page asks), each checked against its sha256 and asked for once more past the HTTP cache when it is not this build's; a second wrong answer fails the install, and the running build stays until the next check. GitHub Pages' cache ignores the query, so `?v=` refreshes only the browser's own cache: for up to 10 minutes after a release Pages may still send old files, and an install in that window fails and is tried again later.
  - **Caches:** `ceica-app-<build>`, and `ceica-meta-1`, which names the running build and the one before it. Every name starts with `ceica-`; the origin is shared with STAF's app, whose caches are never read or deleted.
  - **Answers:** the app's page (any query) from the running build's copy; every other file of the app from that copy, else from the build before's (a page left open across a release reads its own lazy files from it), else from the site.
- **Registration** (`src/app/offline.ts`): production builds only, 5 s after the page loads, always past the HTTP cache; a page a worker already runs asks for a new build at once, then every hour. `?sw=0` removes the worker and its copies from this browser (for troubleshooting; autosaves stay).
- **Updates,** as STAF's app takes them: a new build takes over as soon as its files are in. The page asks the controller whether a project is open (`ce_reload`). With none, and no dialog but the start page, it reloads at once. Otherwise it shows "A new version of CEICA is ready." with **Reload to update**, which saves the project at once (past autosave's 2.5 s quiet period), reloads and reopens it through the start page's Continue (`ceica.reopen`, in this tab's sessionStorage). Undo history and the page's place do not survive, as with Continue. If the project could not be kept, the page stays and says so.
- **Install:** `page/manifest.webmanifest` (`id` `/ceica/`, since a manifest's id resolves against the origin, where `./` would be the root shared with other apps), standalone, the header's color `#243a61`, icons at 192 and 512 px and a maskable 512 (from `brand/png/`).
- **Downloads** keep their own worker (`page/download-sw.js`), which asks only CEICA's pages for a file: a STAF page open on the origin never answers, and made a missing download wait 180 s.
- **To take the offline copy away from everyone,** publish a build whose `app-sw.js` deletes the `ceica-app-` caches and `ceica-meta-1` and unregisters itself; `?sw=0` does it for one browser.
- **Checks:** `tools/offline.ts` builds the app twice (build B with every hashed name changed, as a new release's are) and serves them itself as Pages would (`tools/pages.ts`: `max-age=600`, ETags, each file's type, text gzipped), beside a stand-in for STAF's app. In headless Edge every scenario passes: two builds are identical; the first visit copies every file of the build (29 files, 3.9 MB) and leaves another app's caches alone; the page is installable, as `/ceica/`; with the server stopped the page reloads, Utoy opens, the Word document and a PNG download, Save saves and Open opens; a release with nothing open reloads the page into it; a release with Utoy open and a cost edited shows the notice, the old page still makes a Word document from its own build's copy, and Reload to update reopens Utoy on the new build with the edit kept; with a STAF page open, a missing download is answered in 0.08 s; without workers the page works online and downloads from a blank tab. `--live <url>` checks a published site against the same build: its files byte for byte, the headers, install, both examples, every Report download, Save and Open, a project the Shiny app saved, the console, and the visits. Installing in headed Edge and the app's own window are a person's checks (`--serve`).

## How it was proven equal to the Python app

- **Goldens.** The Python app's makers wrote them, and Vitest compares this app with them. They are frozen now: nothing writes them, none is edited by hand, `tests/fixtures/FROZEN.sha256` lists them all, and `tests/fixtures/README.md` says what a deliberate change in results takes (CONTRIBUTING.md rule 11).
- **The release identity they were made with** (version 1.0.0, the repo, that day's changelog: `tests/fixtures/identity/`) is what every test sees, in place of the real one (`tests/identity.ts`), so a release changes no golden. `repo_rules.test.ts` checks the real files against each other.
- **Every value is held exactly,** with one exception: values computed from a power, which are held within 1e-9 relative (see "Differences by design").
  - Exact values include integers, flags, sets, orders and ids.
  - Every text is exact too: messages, labels, formatted numbers, and file text to the byte.

What the goldens hold:

| Golden | What it holds |
|---|---|
| `py_ref.json` | Format specs, `round`, `sum`, ratios and quantize, on random values and ties |
| `pow_ref.json` | Powers on the engine's bases and exponents: the correctly rounded value and Python's `**` |
| `ceica_ref.json` | 629 planning sets in the property tests' shapes, with IWR's codes and increments from the IWR reference |
| `plans_ref.json` | 70 plan spaces with and without rules, 24 Pareto merges, and one space past 2**53 combinations |
| `annualize_ref.json` | Annualizing and the STAF roll-up, function by function |
| `fmt_ref.json` | Number formatting |
| `projects/` | 22 projects, each a `.ceica` input and what the Python made of it (see below) |
| `invalid_ref.json` | 66 documents the Python refused, each with its exact message |

**The 22 projects** are both examples, the v1 and v2 files, the test builders and the bench projects,
and edited copies that touch every check and option. For each, the golden holds the file the Python
saved, to the byte; the digest and the warnings; the input checks; the annualized lines; and the whole
analysis: site rows and CE/ICA, the plan table by digest with its best-buy and cost-effective rows,
decisions, issues and stage status.

**The page's goldens.** A page or figure over 10 KB is held as its digest (`sha256:<first 16 hex>:<length>`); the views of the examples are kept whole up to 30 KB, so a diff can be read.

| Golden | What it holds |
|---|---|
| `traces/` | 12 scenarios played into `app.py`'s real server: every client message and every message it sent back, in order (dialogs whole, outputs by digest). `traces.test.ts` replays them through the controller. The files a scenario uploads are in `traces/uploads/` and the import goldens. |
| `views/` | 373 views: every page and section of the four projects in several states (stale, a module added), the full factorial, the shell (header, stage strip, sidebar, start page, About, Help, What's new) and the page skeleton |
| `figures/` | 2,367 SVG figures of the 22 projects, by digest (five projects whole) |
| `ticks_ref.json` | Axis ranges, steps and labels, and numpy's density levels for every count up to 300 |
| `exhibits/` | The Report page's catalog for the 22 projects (ids, numbers, titles, captions, row counts), each table's cells, and the files' names |
| `edits_ref.json` | 197 edits on four projects, each the project's digest after it or the exact refusal, and 49 texts through `parse_number` and `float()` |
| `history_ref.json` | Undo and redo scripted with times |
| `htm_ref.json`, `shinyui_ref.json` | htmltools' rendering (28 cases) and py-shiny's markup for every widget call CEICA makes (24) |

**The files' goldens.** Each file is held as `describe()` gives it (`src/files/describe.ts`, as the Python's twin gave it): a zip's records and each member in turn, a text up to 4 KB whole, anything longer as its digest, and a PNG by its pixel size and dpi.

| Golden | What it holds |
|---|---|
| `files_base_ref.json` | The foundations: zips (seekable and streamed), deflate, csv writing and reading, CPython's set order, XML escaping, `describe()` |
| `files/text/`, `files/tables/` | Every table's CSV and workbook, the README and the HTML document of 25 projects: the 22, and three made from the examples (Final with the summary contents; names in other alphabets, with XML's special characters, "=" and "#N/A"; ten sites, so tables print landscape) |
| `files/templates.json`, `files/calculator/` | The three blank templates and four filled ones; the calculator of the 25 projects and 4 blank studies, or the error that stops it |
| `files/pdf/` | The PDF document of 7 projects, dated by `SOURCE_DATE_EPOCH`: equal byte for byte |
| `files/docx/` | The Word document of 4 projects, saved at a fixed time: every part, its pictures by pixel size and dpi |
| `files/zip/` | The figures zip and the Everything zip of 2 projects, with every clock inside fixed (the PDF's, the Word file's, the project file's `savedAt`) |
| `raster/` | Every figure of Utoy and the STAF demo: matplotlib's draw calls in paint order (paths, colors, widths, dashes, caps, joins, clip boxes; texts with their anchor, alignment, rotation, size and weight), and the canvas size and dpi at 300 and 130 dpi |
| `imports/` | 89 workbooks opened (every calculator and template, edited ones, refusals, broken files, three saved by Excel): what openpyxl read, and the project and change list the importer made, or its refusal |
| `staf_import/` | 37 STAF files (every format, both SFARI sheet names, STAF's own SFARI example), what each gives or its refusal, and the projects after Import |

**Browser parity.** Until the Shiny app retired, a tool played 20 scenarios in headless Edge on both apps, with real mouse and keyboard input, and compared 67 snapshots: the page's markup (normalized: attributes in name order, session ids and routes, clock times), what markup does not show (focus and selection, field values, scroll, the dialog), every notification shown, the screenshots, and every file downloaded (workbooks, Word files and zips member by member, PDFs with their dates and `/ID` aside, project files with `savedAt` aside, PNGs by their pixels). On the production build of 1.0.0, 66 of the 67 snapshots were equal in markup and state; in the other the Shiny app lost the click that follows a note edit ("No lost click", below). Every file was the same but for the PNG pixels. The captures are archived with the Python app.

**The static wording.** The app says where work is kept in its own words (`src/views/host.ts`): it runs in the browser and sends nothing anywhere. The goldens were made with these words in place of the Shiny app's.

**Office.** Word opens the app's Word files without repair (Utoy: 16 pages, 17 pictures, 12 tables), Excel opens its calculators, table workbooks and templates without repair, and Excel's exports of the two calculators' charts were the same images as the Shiny app's.

## The exactness rules

The engine reproduces these Python behaviors on purpose:

- **Sums.** Python 3.12's `sum()` is compensated (Neumaier). `pySum` does the same, in the same order. Plain `+=` loops stay plain.
- **Rounding.**
  - `round()` rounds half to even on the exact binary value.
  - `quantize` rounds half away from zero on the 15 significant digits. `pyFormatG` writes them exactly; JavaScript's `toPrecision` rounds ties up.
- **Integers.**
  - Scaled outputs and costs, and plan sums, are JavaScript numbers below 2**52, so their sums and differences stay exact.
  - Cross products and ratios use BigInt.
  - Plan numbers in a space past 2**53 combinations are BigInts.
- **Order.**
  - Sorts are stable on the Python keys; `orderByOutputCost` is numpy's lexsort.
  - `max()` keeps the first maximum.
  - Dicts are `Map`s, because JavaScript objects move integer-like keys ("17") to the front.
- **Text.**
  - Fingerprints and digests are the sha256 of `json.dumps` as Python writes it.
  - Saved files keep Python's int and float spelling (`50.0`).
  - Refusals use pydantic's and json's words.
- **Powers.** `crPow` is the correctly rounded power, so every browser gives the same numbers:
  - whole and half exponents are exact in BigInt;
  - others use exp and log in BigInt fixed point, to enough bits that the rounding is certain.
- **Reactivity (the page).** py-shiny redraws on identity, not equality: a value invalidates unless the new value *is* the old one. Each set in `server.ts` says whether `app.py` passed a literal or a fresh object, and a fresh value counts as the same only where CPython caches it (None, booleans, small ints, the empty and one-character Latin-1 strings). Dependents are invalidated in the order their contexts were made, effects run by priority and then in the order queued, and an output waits while the browser reports it hidden.
- **The page's markup.** Every view's markup equals the Python's to the byte before binding, and the bound page equaled the Shiny page's after it (browser parity, above), whitespace included: the page is served as py-shiny served it, a whole document inside the body (see "Behaviors kept from the Shiny app").
- **Files.** Each writer is the Python library's behavior for the files CEICA makes:
  - **Workbooks:** openpyxl numbers fonts, fills, borders and number formats when they are assigned, and cell formats as it writes (sheets in order, then rows, then columns); merged cells come out in CPython's set order; numbers are written as `%.16g`; the zip is `repack`'s, dated 1980-01-01.
  - **Word:** python-docx's elements with their properties in schema order, lxml's escaping, the relationship ids and picture ids it allots, a section break's copy of the page settings without its rsid attributes, and picture extents with Python's rounding.
  - **PDF:** reportlab's operators and numbers, its page templates and `CondPageBreak`, "Page X of Y" by replaying every page at save; the time stamp is passed in.
  - **PNG:** matplotlib's layout: the canvas `int(inches x dpi)` pixels, the draw order by zorder, dashes scaled by the line width, its caps and joins, clip boxes on whole pixels, and Pillow's pixels per meter.
  - **Zips:** zipfile's records (a stream with data descriptors for the Report page's zips), deflated by pako as zlib deflates.
  - **Reading:** openpyxl's values (ints and floats as written, dates by number format, shared formulas translated by its tokenizer), and pydantic's and json's words in a refusal.
- **Logs.** The figures' density layer takes numpy's levels, `ceil(4 log1p(c) / log1p(top))`, with a correctly rounded `log1p`: numpy's is a unit off on about 1 in 18,000 integers, and the levels equal numpy's for every count up to 300 and at every whole ratio.

## Differences by design

Where the app differs from the Shiny app it replaced. Each engine difference is pinned by `tests/differences.test.ts`.

- **Very large values.** A scaled cost or output of 2**52 or more stops its site, with an issue that asks for fewer decimals. Plan sums that large stop the watershed. Python's int64 went on to 2**63.
  - This takes, for example, a $4.5 billion annual cost at 6 cost decimals.
- **Plan numbers past 2**63 combinations** stay exact here, where Python's int64 plan numbers wrapped.
- **Powers are correctly rounded here.** Python's `**` (the Windows C library's pow) is a unit off in about 6 of 10,000 of the engine's powers. A subtraction after a power can magnify that unit, so values computed from a power are held within 1e-9 relative of the goldens:
  - the subtraction is `(1 + r)^(1/ppy) - 1`, the interest rate per construction period;
  - in practice the largest gap measured is 1.2e-14;
  - every cost line of the 22 golden projects equals the Python's bit for bit;
  - cents, and every CE/ICA comparison, are exact.

**The page:**

- **The Report page's files** have a fixed address (`files?nonce=1`) where Shiny had a session route, and the page answers their links itself. Its thumbnails are blob addresses of the figures' SVG files, given as the page is drawn.
- **Autosave is kept in IndexedDB,** not localStorage: the project and the Recent list in one transaction. The Recent list is read from it at connect and after Forget, as Shiny read `ceica.js`'s.
- **No server.** No busy indicators (`busy-indicators.css` and the page's `data-shiny-busy-*` attributes are left out), no recalculating fade, no reconnect overlay. An output still carries Shiny's `recalculating` mark until its first value and from each invalidation until its next value, as shiny.js marks it.
- **No lost click.** In Shiny, a change sent as a field is left (a note typed, then a button clicked) could redraw the page before the click was released, and the click was then lost. Here the redraw waits until the click has fired, so the click counts.
- **Save** is made in the page and opened in its own tab through the download worker (`page/download-sw.js`), as STAF's downloads are, so a managed network's preview never replaces the page.
- **Upload progress.** The hidden file input's progress bar is set straight to its end state ("Upload complete"); Shiny stepped it through the upload.

**The files:**

- **Every download is made in a worker** (or in the page where there is none) from the project's text, taken at the click, and opens in its own tab, as Save does. An error shows in that tab and in a notification, where Shiny's download broke.
- **PNG figures are drawn by the browser** on a canvas, from matplotlib's draw calls (pinned by `raster/`): the same size, dpi and drawing, with the browser's anti-aliasing and text rendering. About 1.1 to 1.4 percent of a 300 dpi figure's pixels differ from matplotlib's by more than 16 levels of 255, mostly in text. The file has no "Software" tag. A text with two dollar signs, which matplotlib would read as math, is drawn as typed.
- **The PDF's dates and `/ID`** are the moment of the download; with the same time stamp the file is reportlab's byte for byte.
- **The Word file's zip entries** are dated when it is made, as python-docx dates them, and its pictures are the browser's PNG files. Every other byte of its parts is python-docx's.
- **The zips** hold the files above, so their PDF, Word file and figures differ the same ways.

**Offline, install and updates,** which the Shiny app did not have:

- **The wording** about where work is kept is the static app's (above, "The static wording").
- **The head** holds the stylesheets as style elements, not links, the tabset id is the page's own, not random, and the page says `noindex`.
- **A reload for an update** (`ce_reload`, `src/app/offline.ts`): the controller says whether a project is open and, before the page reloads, saves it past autosave's quiet period; after the reload the page reopens it.
- **`?sw=0`** removes the offline worker and its copies.

## Behaviors kept from the Shiny app

To be proven equal, the page copied the Shiny page's flaws. Each can now be fixed, with the goldens it
changes (`tests/fixtures/README.md`):

- **The served page holds a whole document in its body.** py-shiny served `ui.page_fillable`'s own `<html>`, `<head>` and `<title>` inside the page's `<body>`: the browser keeps the `<title>` in the body and moves the inner body's class and style to the page's body.
- **Picking the same section or site again redraws the page** (identity, above), and every autosave redraws the stage strip and the sidebar's foot.
- **The Recent list is read at connect and after Forget only,** so a project autosaved in this visit appears after a reload.
- **New project:** a period of analysis of 0 becomes 50, and target years of `nan` pass its checks, so Create then fails on the undo history's JSON, which refuses NaN (in Shiny the session ended; here the error stops in the console).
- **A page shown waits for its visibility report.** After a page switch the new page is drawn once the browser reports it shown (shiny.js's observers wait 100 ms), so the old content shows for a moment.
- **Every grid cell is a Shiny text input,** bound and sending its value to the controller, which ignores it.
- **shiny.js queues an empty update** for each input it batches (its "send enqueued" flag is never set); the page sends one, which the controller answers the same way.
- **The body keeps `overflow: hidden`** after a dialog that replaced another closes (Bootstrap saves the first dialog's overflow as the page's).
- **A dialog that closes easily swallows Escape** before the page's own keys see it.

**The files:**

- **The calculator fails** for a site with no alternatives (`min()` of nothing), and so does the Everything zip, which holds it.
- **The workbooks and the Word file fail** on a control character in a name (lxml's and openpyxl's refusal), and the Word file on a title of more than 255 characters (python-docx's limit for its properties).
- **The calculator:** its chart patch never applies (`repack` looks for `</c:chart>`), no data validation rejects input, and text starting with "=" in the snapshot and manifest sheets becomes a formula.
- **The Everything zip's project file** carries the moment it was made.
- **Opening a workbook:** a bad template shows pydantic's raw text, and the dialog says "1 changes".
- **The STAF import:** a CSV titled like "SFARIX" fails with a key error, a site named "new" collides with "New site", and a JSON file with a byte order mark is read as CSV.

## The references

`tests/oracle.test.ts` compares the engine with a reference written to IWR Planning Suite II's CE/ICA
rules (`tests/oracles/iwr_ceica.ts`, which uses `tests/decimal.ts` for IWR's 28-digit decimal
arithmetic).

- **Kept outside this repository.** `oracle.test.ts` looks for it when the tests run (not through `import.meta.glob`, which Vitest's transform cache would remember) and skips when it is absent, as it is on GitHub.
- **When present,** it must:
  - give the answers `ceica_ref.json` records;
  - match the engine on 600 tie-heavy, 200 realistic and 200 negative fast-check cases (CONTRIBUTING.md rule 1).

`tests/oracles/ecorest_ceica.ts` ports ecorest's CEfinder and BBfinder, on the Python engine's own cases.

## Copies

These files were copied while the Python app was here and are this app's own now
(`THIRD_PARTY_NOTICES.md` has their licenses):

- STAF's Python-behavior helpers and its page code, copied as a starting point and adapted (`htm.ts`, `shim.ts`, `shinyui.ts`, `notify.ts`, `download.ts`, the download worker), from STAF's static app (`USACE-WRISES/staf`, `apps/staf-web`);
- the Python app's STAF function tables, examples, old project files and the Utoy report's tables;
- the page's files: the Shiny app's stylesheet, script, fonts and icons, and py-shiny's Bootstrap stylesheet, its fonts cut to the latin faces, and htmltools' `fill.css`;
- the install icons, `brand/png/`'s 192 and 512 px tiles and its maskable 512, in `page/icons/`;
- for the files: STAF's port of reportlab 4.5.1 (its font metrics, its tests and the six files extended here), its zip writer, csv helpers and pako's types; openpyxl's theme part; the Word file's parts that no report changes, as python-docx's template saves them (styles with CEICA's Normal style, settings, numbering, theme, fonts and the thumbnail); and STAF's SFARI calculator example, without its contacts.

## Speed

`npm run bench`, measured on 2026-10-18 on a workstation beside the Python engine. Timings vary from
run to run by up to about half.

| Case | TypeScript | Python |
|---|---|---|
| Utoy example (128 plans) | 2.1 ms | 4.8 ms |
| Utoy full factorial (49,152 plans) | 36 ms | 41 ms |
| Synthetic 8 x 3 (65,536 plans) | 30 ms | 53 ms |
| Synthetic 6 x 6 (117,649 plans) | 52 ms | 90 ms |
| Synthetic 30 x 3 (Pareto merge, 500 candidates) | 26 ms | 34 ms |

**The page** (2026-10-19): a cell edited on Inputs, Costs, timed from the change to the page drawn again, in headless Edge (median and slowest of 9 edits):

| Project | Dev server | Production build | The Shiny app (local server) |
|---|---|---|---|
| Utoy example (128 plans) | 49 ms (70) | 42 ms (59) | 759 ms |
| Utoy full factorial (49,152 plans) | 75 ms (107) | 71 ms (81) | 873 ms |

The targets were under 100 ms for Utoy and under 1 s for the full factorial. The first timings were 126 to 196 ms for Utoy; three changes brought them down without changing a byte of markup:

- **The bound inputs' events are heard once, on the document** (in the capture phase, so still before `ceica.js` hears them), where shiny.js puts three listeners on each input: the Costs page's 638 cells were bound, and let go of, at every redraw.
- **Conditional panels are looked for only after markup that can hold one** (shiny.js looks over the whole page after every message), and a debounce for typing is made at an input's first change.
- **htmltools' escaping is one pass** over a text that needs it, and none over one that does not.

What is left is about 20 ms in the controller (the cell applied through Python's JSON round trip, the undo snapshot, the analysis and the page's markup) and, mostly, the browser parsing the Costs page's 320 KB of markup, which the Shiny page parsed too.

**The files** (2026-10-19): each download in headless Edge, timed from the click to the file saved (a download takes at least about 0.5 s in either app); this app's production build against the Shiny app on a local server:

| File | Utoy, here | Utoy, Shiny | Full factorial, here | Full factorial, Shiny |
|---|---|---|---|---|
| Word document | 1.3 s | 6.7 s | 1.3 s | 6.7 s |
| PDF document | 1.1 s | 1.8 s | 1.1 s | 1.3 s |
| Figures zip | 1.6 s | 5.6 s | 1.6 s | 5.9 s |
| A figure's PNG | 0.6 s | 1.0 s | 0.5 s | 1.3 s |
| All tables (.xlsx) | 0.5 s | 0.7 s | 0.8 s | 0.7 s |
| Excel calculator | 1.1 s | 1.8 s | 0.8 s | 1.2 s |
| Everything zip | 3.1 s | 17.6 s | 3.9 s | 14.4 s |

The files are made in a worker, so the page stays responsive while they build. The browser's PNG files are about a third larger than matplotlib's (Utoy's Everything zip is 5.0 MB here and was 3.6 MB from Shiny).

**Visits** (`tools/offline.ts`'s `timing`, 2026-10-20, headless Edge, its stand-in for Pages sending text gzipped): the time from the address to the start page, idle for 0.7 s, median of three:

| Visit | Bytes from the site | Time |
|---|---|---|
| First | 325 kB | 1.21 s |
| Repeat | none | 1.16 s |

After the first visit the worker copies the rest of the build in the background, from 5 s after the page loads. With every answer paced at 150 ms and 4 Mbit/s (`--throttle 150,4`), the first visit took 3.64 s and a repeat 1.16 s (2026-10-19, files sent plain).

**The build** (`npm run build`, 2026-10-19): `index.html` is 468 kB (67 kB gzipped) with the stylesheets written in. The page's script is 613 kB (169 kB gzipped), up from 451 kB (115 kB) before the files came, because opening a workbook, the STAF import and the templates run in the page, as they ran in Shiny's server. The Report files' code stays out of it: the files worker is 1.25 MB, loaded at the first download, and the page's own copy for a browser without workers (182 kB, the Word file's constant parts 841 kB more) loads only then.
