// The page's boot: the controller (app.py's server, in the page) and shiny.js's part (client.ts),
// started once the page skeleton, www/ceica.js and the stand-ins page/boot.js installs are in place;
// then the offline copy and its updates (offline.ts), and a project an update's reload left reopened.
import { FILES } from '../views/examples'
import { Client } from './client'
import { startOffline, Updates } from './offline'
import type { Clock } from './reactive'
import { ceicaServer } from './server'
import { Session } from './session'

/** The Report page's files address: a fixed one (the Shiny app's is a session route). */
const FILES_URL = 'files?nonce=1'

const clock: Clock = {
  monotonic: () => performance.now() / 1000,
  now: () => new Date(),
  later: (seconds, fire) => {
    const t = setTimeout(fire, seconds * 1000)
    return () => clearTimeout(t)
  },
}

/** the worker that ran the page when it loaded (offline.ts tells a later switch from the first install) */
const controller = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null

let updates: Updates | null = null
const client = new Client({
  filesUrl: FILES_URL,
  onKept: (ok) => updates?.kept(ok),
  onReload: (reply) => updates?.answer(reply),
})
updates = new Updates(client)
const session = new Session(clock, ceicaServer({
  today: () => new Date(),
  filesUrl: FILES_URL,
  readUpload: (datapath) => client.readUpload(datapath),
  exampleText: (name) => FILES[name] ?? null,
}))

// bslib's components script (components.min.js, which the Shiny page loads) adds its icon gradient to
// the page once it is parsed; the page adds the same element, so the two pages are the same
const GRADIENT = `
  <svg aria-hidden="true" focusable="false" style="width:0;height:0;position:absolute;">
    <!-- ref: https://fvsch.com/svg-gradient-fill -->
    <linearGradient id='bslib---icon-gradient' x1='0' y1='0' x2='1.6' y2='2.4'>
      <stop offset='0%' stop-color='var(--bslib-icon-gradient-0, #007bc2)' />
      <stop offset='14.29%' stop-color='var(--bslib-icon-gradient-1, #0770c9)' />
      <stop offset='28.57%' stop-color='var(--bslib-icon-gradient-2, #0d63da)' />
      <stop offset='42.86%' stop-color='var(--bslib-icon-gradient-3, #2b4af9)' />
      <stop offset='57.14%' stop-color='var(--bslib-icon-gradient-4, #5e29f7)' />
      <stop offset='71.43%' stop-color='var(--bslib-icon-gradient-5, #7217d7)' />
      <stop offset='100%' stop-color='var(--bslib-icon-gradient-6, #74149c)' />
    </linearGradient>
  </svg>`
function iconGradient(): void {
  const div = document.createElement('div')
  div.innerHTML = GRADIENT
  document.body.appendChild(div.children[0])
}
if (document.readyState === 'complete') iconGradient()
else document.addEventListener('DOMContentLoaded', iconGradient)

// the Report page's thumbnails are blob addresses: what each stands for (its files address), for a
// check that compares the page's markup (the browser parity captures compared it with the Shiny app's)
;(window as unknown as { ceicaThumbs: () => Record<string, string> }).ceicaThumbs = () => Object.fromEntries(client.thumbQueries)

void client.start(session).then(() => {
  updates!.reopen()
  startOffline(updates!, controller)
})
