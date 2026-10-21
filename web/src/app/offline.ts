// The web app's offline copy and its updates, in the page. The worker is sw/app-sw.js, which the build
// writes into dist as app-sw.js (appWorker.ts); its scope is the app's folder, beside the download
// worker's download/.
//
// Production builds only; ?sw=0 turns it off and removes the worker and its copies (for
// troubleshooting; autosaves stay). The page registers the worker 5 s after it loads, so the first
// visit's reads have the network to themselves, and always past the HTTP cache (Pages may serve a copy
// up to 10 minutes old). It asks for a new build at once when a worker already runs this one, then
// every hour.
//
// A new build takes over as soon as its copy is in (the owner, 2026-10-19). The page then asks the
// controller whether a project is open (ce_reload). With none, and no dialog but the start page, it
// reloads at once. Otherwise it shows "A new version of CEICA is ready." with Reload to update, which
// saves the project (at once, past autosave's quiet period), reloads, and reopens it through the start
// page's Continue (a one-shot key in this tab's sessionStorage). Undo history and the page's place do
// not survive the reload, as with Continue.
//
// After the first autosave this browser keeps, the page asks for persistent storage, once a visit and
// quietly: it covers the whole site's origin, STAF's app included (web/README.md).
import { h, TagList, type Child } from '../shiny/htm'
import { removeNotification, showNotification } from '../shiny/notify'
import * as host from '../views/host'
import type { Client } from './client'

const HOURLY_MS = 60 * 60 * 1000
const REGISTER_AFTER_MS = 5000
const WORKER = 'app-sw.js'
const CACHE_PREFIX = 'ceica-app-'
const META = 'ceica-meta-1'
/** the project to reopen after an update's reload (this tab only) */
export const REOPEN_KEY = 'ceica.reopen'
export const NOTICE_ID = 'ceica-update'
const NOT_KEPT_ID = 'ceica-update-not-kept'

/** The controller's answer to ce_reload (client.ts's onReload). */
export interface ReloadReply {
  /** the open project's id, or null */
  readonly id: string | null
  /** whether the page asked for a save before reloading (Reload to update) */
  readonly save: boolean
  /** whether this browser kept the last autosave */
  readonly kept: boolean
}

export type Decision = 'reload' | 'notice' | 'warn'

/** What the page does with the controller's answer: after a switch (no save asked), reload when nothing
 * is open and no dialog but the start page shows, else the notice; after Reload to update, reload unless
 * the project could not be kept. */
export function decide(reply: ReloadReply, otherDialog: boolean): Decision {
  if (!reply.save) return reply.id === null && !otherDialog ? 'reload' : 'notice'
  return reply.id !== null && !reply.kept ? 'warn' : 'reload'
}

/** Whether a dialog other than the start page is open (a half-filled New project, an import). */
export function otherDialogOpen(doc: Document = document): boolean {
  const modal = doc.getElementById('shiny-modal')
  return modal !== null && modal.querySelector('.ce-start-rail') === null
}

/** What the page does that a test stands in for. */
export interface PageHooks {
  reload(): void
  session(): Storage | null
}

const browser: PageHooks = {
  reload: () => location.reload(),
  session: () => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  },
}

const markup = (child: Child): string => new TagList(child).render()

export class Updates {
  private reloading = false
  private persistAsked = false

  constructor(private readonly client: Client, private readonly hooks: PageHooks = browser) {
    document.addEventListener('click', (e) => {
      const button = e.target instanceof Element ? e.target.closest('[data-ceica-update]') : null
      if (!button) return
      e.preventDefault()
      removeNotification(NOT_KEPT_ID)
      this.client.askReload(true)
    })
  }

  /** The new build took over (controllerchange). */
  switched(): void {
    if (!this.reloading) this.client.askReload(false)
  }

  /** ClientOptions.onReload */
  answer(reply: ReloadReply): void {
    if (this.reloading) return
    const what = decide(reply, otherDialogOpen())
    if (what === 'notice') {
      showNotification({ id: NOTICE_ID, type: 'message', duration: null, html: markup(host.UPDATE_READY),
        action: markup(h.button(host.UPDATE_ACTION, { type: 'button', class: 'btn btn-sm btn-primary', 'data-ceica-update': '' })) })
      // the files worker's script is read now, while this build's copy is still kept
      this.client.warmFiles()
      return
    }
    if (what === 'warn') {
      showNotification({ id: NOT_KEPT_ID, type: 'warning', duration: null, html: markup(host.UPDATE_NOT_KEPT) })
      return
    }
    if (reply.save && reply.id !== null) {
      try {
        this.hooks.session()?.setItem(REOPEN_KEY, reply.id)
      } catch {
        // storage refused: Recent projects on the start page still has the project
      }
    }
    this.reloading = true
    this.hooks.reload()
  }

  /** The project an update's reload left, reopened (once), as the start page's Continue does. */
  reopen(): void {
    let id: string | null = null
    try {
      const store = this.hooks.session()
      id = store?.getItem(REOPEN_KEY) ?? null
      if (id !== null) store!.removeItem(REOPEN_KEY)
    } catch {
      return
    }
    if (id) this.client.restore(id)
  }

  /** ClientOptions.onKept: after the first autosave kept this visit, persistent storage asked for. */
  kept(ok: boolean): void {
    if (!ok || this.persistAsked) return
    this.persistAsked = true
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.persist) return
    void storage.persisted().then((yes) => (yes ? true : storage.persist())).catch(() => false)
  }
}

/** The worker and its copies removed (?sw=0); the download worker and autosaves stay. */
async function removeWorker(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations()
  const scope = new URL('./', location.href).href
  for (const reg of registrations) if (reg.scope === scope) await reg.unregister()
  for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) || name === META) await caches.delete(name)
}

/** Registers the worker (production only) and hands its switches to ``updates``. ``controller`` is the
 * worker that controlled the page when it loaded (main.ts reads it first). */
export function startOffline(updates: Updates, controller: ServiceWorker | null): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  if (new URLSearchParams(location.search).get('sw') === '0') {
    void removeWorker().catch(() => {})
    return
  }
  let current = controller
  sw.addEventListener('controllerchange', () => {
    const replaced = current
    current = sw.controller
    // the first install takes no page over: nothing to switch from
    if (replaced) updates.switched()
  })
  // a build that took over while the page was starting
  if (controller && sw.controller && sw.controller !== controller) updates.switched()
  const register = (): void => {
    sw.register(WORKER, { scope: './', updateViaCache: 'none' }).then((reg) => {
      if (sw.controller) void reg.update().catch(() => {})
      setInterval(() => void reg.update().catch(() => {}), HOURLY_MS)
    }, () => {
      // no worker (refused, or a managed browser): the page works online as before
    })
  }
  const later = (): void => void setTimeout(register, REGISTER_AFTER_MS)
  if (document.readyState === 'complete') later()
  else window.addEventListener('load', later, { once: true })
}
