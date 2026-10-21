# Contributing to CEICA

CEICA is a static web app (TypeScript and Vite, in `web/`) published on GitHub Pages. `web/README.md`
explains how it is built and checked; `docs/methods.md` gives every rule and formula with its
source.

## Commands

With Node 22.18 or later:

```bash
npm --prefix web ci              # the tools
npm --prefix web run dev         # the app at http://localhost:5190
npm --prefix web test            # every test (Vitest)
npm --prefix web run typecheck   # the app and web/tools
npm --prefix web run build       # the site, in web/dist
npm --prefix web run preview     # the built site at http://localhost:5191/ceica/
npm --prefix web run offline     # offline use, install and updates, in headless Edge
npm --prefix web run live        # the published site, checked against the same build
npm --prefix web run bench       # the engine's timings
```

## Rules

1. **IWR Planning Suite II parity is non-negotiable.** Cost-effectiveness, best buys, ties,
   duplicates, the No Action base and increments follow IWR Planning Suite II's rules
   (`docs/methods.md`). `web/tests/oracle.test.ts` compares the engine with a reference written to
   those rules, on tie-heavy random data, where the reference is present (it is kept outside this
   repository). Never change `web/src/engine/cea.ts` or `ica.ts` without it passing.
2. **The Utoy example reproduces the published report.** `web/tests/utoy.test.ts` checks every
   printed number in the report's CE/ICA tables. The examples (`web/src/content/examples`) are the
   goldens' own copies (`web/tests/fixtures/examples`) and change only with them (rule 11).
3. **Results are never stored.** Project files hold inputs and decisions; everything else is
   recomputed by `analyze` (`web/src/engine/analysis.ts`).
4. **Decisions are keyed by composition, not plan number.** Plan numbers move when sites change.
5. **Projects are values.** Never change a project or any part of it in place: an edit makes a new
   project (as `web/src/views/edits.ts` does), so undo, redo and the decisions keep what they saw.
6. **Copy rules:** no em or en dashes in what people read, US spelling, `n/a` for missing values,
   plain words ("best buy", never "BB" in the app). `web/tests/repo_rules.test.ts` checks the
   files, `web/tests/ui_rules.test.ts` every page and report the app draws.
7. **Version lockstep:** the top section of `CHANGELOG.md` = `APP_VERSION` in
   `web/src/engine/version.ts` = `web/package.json` and its lock = `CITATION.cff` (version and
   date-released). A release has at most 10 bullets, each one line of at most 80 characters; lump
   small changes together (they show in What's new on the start page).
8. **The repository reads as its authors' work.** No file or commit message names an AI tool or
   carries a co-author trailer, and no personal data or machine paths are committed
   (`web/tests/repo_rules.test.ts`). IWR Planning Suite II is cited by its behavior, never by its
   code.
9. **Host seam:** only `web/src/views/host.ts` and the page layer (`web/src/app`) know the app runs
   in a browser (autosave, the privacy notice); the engine never imports the page
   (`web/tests/ui_rules.test.ts`).
10. **Message handlers take exactly one argument.** The page's stand-in for shiny.js
    (`web/page/boot.js`) refuses any other, as shiny.js does; once, a bad handler silently dropped
    every handler registered after it.
11. **The goldens are frozen.** `web/tests/fixtures` holds what CEICA's earlier Python engine wrote,
    and the TypeScript must equal it; nothing writes the goldens now, and none is edited by hand. A
    deliberate change in results follows `web/tests/fixtures/README.md`. `web/README.md` lists the
    exactness rules and the differences by design.

## Releasing

1. Add a section at the top of `CHANGELOG.md` (rule 7) and move the version with it:
   `web/src/engine/version.ts`, `npm --prefix web version X.Y.Z --no-git-tag-version`, and
   `CITATION.cff` (version and date-released).
2. Run `npm --prefix web run typecheck`, `npm --prefix web test` and `npm --prefix web run offline`.
3. Push to `main`. The Pages workflow (`.github/workflows/pages.yml`) tests, builds and deploys.
   Open copies of the app update themselves; GitHub Pages' cache may serve the old files for up to
   10 minutes.
4. Run `npm --prefix web run live`: the published site against the same build, file by file.
5. Tag `vX.Y.Z` and publish a GitHub Release with the CHANGELOG section.
