// Where the app runs: the one module that knows it is a web app (views/host.py).
//
// Everything that depends on the host (where autosave keeps the project, what the privacy notice
// says, the words for saving and for an update) lives here. The static app's words (Phase 4): it runs
// in the browser and sends nothing anywhere, and it keeps its autosaves in this browser's IndexedDB
// (src/app/storage.ts). The goldens hold these words in place of the Shiny app's (views/host.py,
// unchanged): web/parity/common.py's STATIC_HOST. tests/ui_rules.test.ts ("the host seam") fails if
// host wording shows up anywhere else.

/** "static" in the web app (the Shiny app says "web"). */
export const KIND = 'static'

/** Help: where work is kept as the user goes, and what happens to study data. */
export const KEEPING_NOTE = "Your work is saved in this browser as you go, on this computer only. Clearing the browser's site "
  + 'data deletes it, so use Save to download the project file, the durable copy.'
export const PRIVACY_NOTE = 'CEICA runs entirely in this browser, so nothing you enter is sent anywhere.'
/** The start page's one line under Recent projects: the two notes above, short. */
export const START_NOTE = 'Kept in this browser only; Save downloads the project file. Nothing you enter is sent anywhere.'

/** The status line after an autosave, for example 'Autosaved in this browser 10:42'. */
export function autosaved(clock: string): string {
  return `Autosaved in this browser ${clock}`
}

/** The autosave the user picked is gone (cleared site data, another browser). */
export const AUTOSAVE_GONE = 'That autosave is no longer in this browser.'

/** A new version has taken over while a project is open (src/app/offline.ts): its notice and action. */
export const UPDATE_READY = 'A new version of CEICA is ready.'
export const UPDATE_ACTION = 'Reload to update'
/** Reload to update could not keep the project first, so the page stays. */
export const UPDATE_NOT_KEPT = 'CEICA could not keep the project in this browser, so it did not reload. Use Save to download the '
  + 'project file, then reload the page.'
