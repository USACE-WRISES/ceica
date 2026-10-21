# The goldens

Every file here is a golden: what CEICA's earlier Python engine and Shiny app produced for the same
inputs. Their makers wrote them until the tag `shiny-final` (2026-10-20), when the Python retired. The
TypeScript must equal them (CONTRIBUTING.md rule 11); `web/README.md` gives the exactness rules (which
values are compared exactly, which within a tolerance).

- **Nothing writes them now, and none is edited by hand.** `FROZEN.sha256` lists every file here with
  its sha256 (this README and the list aside), and `tests/frozen.test.ts` compares the folder with it.
- **They keep the release identity they were made with:** version 1.0.0, the repo, and that day's
  `CHANGELOG.md`, all in `identity/`. Every test sees it in place of the real one
  (`tests/identity.ts`), so a release changes no golden.
- **A deliberate change in results** (a fix, a new rule) takes:
  1. the CE/ICA property tests against the IWR Planning Suite II reference passing, where that reference
     is kept (it is not in this repository; `tests/oracle.test.ts` skips without it);
  2. `ENGINE_VERSION` raised, when a result can change for the same inputs;
  3. the changed goldens written by a small writer run through Vitest (so it sees the pinned identity),
     never by hand;
  4. `npm run freeze`, and a line in the log below saying what changed and why.

## Log

- 2026-10-20: frozen at `shiny-final`, the last goldens the Python wrote (version 1.0.0).
