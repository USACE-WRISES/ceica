# CEICA

Cost-effectiveness and incremental cost analysis (CE/ICA) for ecosystem restoration planning, in the
browser.

**Open it:** https://usace-wrises.github.io/ceica/

CEICA takes a study from inputs to the Tentatively Selected Plan in four stages: **Inputs**,
**Sites** (site-by-site CE/ICA), **Watershed** (every combination of the site actions, the final
array and the TSP) and **Report**. Its cost-effectiveness and best-buy rules follow IWR Planning
Suite II, the certified USACE tool, and every result can be checked in a live-formula Excel
calculator.

## What it does

* **Inputs.** Study settings, sites and alternatives, benefits at target years and costs, in
  grids that take a block pasted from Excel. Study sets out how benefits are measured: one or
  more modules (for example, riparian and instream), each entered as habitat units, an index
  times a quantity, an average annual value, or STAF function scores; an alternative's benefit
  adds its modules up. Costs cover first costs, interest during construction and recurring
  OMRRR items.
* **Sites.** For each site, the cost-effectiveness and incremental cost figures, a table of the
  alternatives with best buys marked, a suggested recommendation (the largest best buy) that the
  team confirms or changes, and decision notes for the decision record.
* **Watershed.** Every combination of the site recommendations (or several alternatives per site,
  with not-combinable and depends-on rules), the cost-effectiveness and incremental cost figure of
  the plans, the table of plans with each site included (1) or not (0), the final array with an
  "Is it worth it?" answer for each step, and the TSP.
* **Report.** Every figure (PNG, SVG) and table (Excel, CSV) to download; a figures-and-tables
  document in Word, PDF and HTML with the same numbers and captions, a study settings table and
  the decision record; all tables in one workbook; the Excel calculator; the project file
  (.ceica); or everything in one .zip. The document stays a draft until every readiness item is
  checked.
* **STAF.** Studies that use the Stream Tiered Assessment Framework enter function scores; the
  Ecosystem Condition Index times the quantity gives condition units, and each alternative's lift
  splits exactly into functions and outcomes. The existing condition can be imported from SFARI,
  EASI or DEEP exports.

Every edit recomputes at once, with undo and redo. CEICA runs entirely in your browser, so nothing
you enter is sent anywhere; your work is saved in this browser as you go, and Save downloads the
project file, the durable copy. After the first visit CEICA works offline, Edge and Chrome can
install it as an app, and a new version installs itself.

## Examples

* **Utoy Creek Section 206** (Atlanta, Georgia): eight sites, reproducing every CE/ICA table of
  the published report.
* **STAF demonstration**: three illustrative reaches scored with STAF, one starting from the
  SFARI calculator's worked example.

Both open from Example projects on the start page.

## How results are checked

* **IWR Planning Suite II parity.** Property tests compare the engine with a reference written to
  IWR Planning Suite II's cost-effectiveness, best-buy and increment rules, on tie-heavy random
  data. The reference is kept outside this repository; `web/tests/oracle.test.ts` runs where it is
  present.
* **The goldens.** CEICA began as a Python app (Shiny for Python), and this app was proven equal to
  it, value for value and file for file: the TypeScript must equal the 429 golden files the Python
  wrote (`web/tests/fixtures`), now frozen.
* **Utoy Creek.** Every printed number in the report's CE/ICA tables, all 128 watershed plans, the
  final array and the TSP (`web/tests/utoy.test.ts`).
* **Excel calculator.** Every cell and formula equals the Python's calculator, which was
  recalculated in full and compared with the app's results, before and after edits.
* **STAF.** The SFARI worked example's sub-indices and ECI under both published mappings, and the
  exact split of lift into functions (`web/tests/staf.test.ts`).

`docs/methods.md` describes every rule and formula with its source.

## Run it locally

With Node 22.18 or later:

```bash
npm --prefix web ci
npm --prefix web run dev        # the app at http://localhost:5190
npm --prefix web test           # every test
npm --prefix web run build      # the site, in web/dist
```

`CONTRIBUTING.md` has the house rules and how a release is made; `web/README.md` explains how the
app is built and checked.

## Limits

* CEICA is not a certified planning model. The calculator's "IWR input" sheet lists plans,
  outputs and costs ready to rerun in IWR Planning Suite II.
* The Ecosystem Condition Index is not a certified or approved USACE planning model; STAF
  guidance treats it as a supplement to habitat units from approved models.
* Not in this version: uncertainty analysis, multi-criteria decision analysis, and IWR's
  non-additive plan interactions.

## Layout

```
web/            the app (TypeScript, Vite): src/ the engine, the pages and the files; tests/ and
                its goldens; tools/ the offline checks; page/ the files the site serves as they are
brand/          the icon family
docs/           methods.md: every rule and formula, with its source
```

## License

License terms are pending the organization's decision. The code and fonts CEICA bundles or was
ported from keep their own licenses: see `THIRD_PARTY_NOTICES.md`.

## Citing

See `CITATION.cff`.
