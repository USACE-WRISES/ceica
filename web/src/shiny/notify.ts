// Shiny's notifications (ui.notification_show and ui.notification_remove), as shiny.js 1.6.3 draws
// them (srcts/src/shiny/notifications.ts): a panel at the page's bottom right holding one box per
// notification id, its text and its action (markup from the server, as is), a close button, and
// removal after its duration with a 250 ms fade. Adapted from STAF's static app (src/app/notify.ts),
// which drew text only.

const FADE_MS = 250
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export interface Notification {
  /** the message's markup (the server's: text is escaped there) */
  html: string
  /** an action's markup ("" for none) */
  action?: string
  /** milliseconds before it goes; null keeps it until closed (shiny.js's default is 5000) */
  duration?: number | null
  id?: string | null
  closeButton?: boolean
  type?: string | null
}

function panel(): HTMLElement | null {
  return document.getElementById('shiny-notification-panel')
}

function find(id: string): HTMLElement | null {
  return panel()?.querySelector<HTMLElement>(`#shiny-notification-${CSS.escape(id)}`) ?? null
}

function create(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = `shiny-notification-${id}`
  el.className = 'shiny-notification'
  el.innerHTML = '<div class="shiny-notification-close">&times;</div><div class="shiny-notification-content"></div>'
  el.querySelector('.shiny-notification-close')!.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    removeNotification(id)
  })
  panel()!.appendChild(el)
  return el
}

function randomId(): string {
  return Math.floor(0x100000000 + Math.random() * 0xf00000000).toString(16)
}

/** ui.notification_show, as shiny.js shows the server's message; returns its id. */
export function showNotification(n: Notification): string {
  const id = n.id || randomId()
  if (!panel()) {
    const p = document.createElement('div')
    p.id = 'shiny-notification-panel'
    document.body.appendChild(p)
  }
  const el = find(id) ?? create(id)
  el.querySelector('.shiny-notification-content')!.innerHTML =
    `<div class="shiny-notification-content-text">${n.html}</div><div class="shiny-notification-content-action">${n.action ?? ''}</div>`
  for (const cls of [...el.classList]) if (/^shiny-notification-/.test(cls)) el.classList.remove(cls)
  if (n.type && n.type !== 'default') el.classList.add(`shiny-notification-${n.type}`)
  const close = el.querySelector('.shiny-notification-close')
  const closeButton = n.closeButton ?? true
  if (closeButton && !close) el.insertAdjacentHTML('beforeend', '<div class="shiny-notification-close">&times;</div>')
  else if (!closeButton && close) close.remove()
  const old = timers.get(id)
  if (old) clearTimeout(old)
  timers.delete(id)
  const duration = n.duration === undefined ? 5000 : n.duration
  if (duration) timers.set(id, setTimeout(() => removeNotification(id), duration))
  return id
}

/** ui.notification_remove: the box fades out and goes; the panel goes with the last one. */
export function removeNotification(id: string): void {
  const el = find(id)
  if (!el) return
  el.style.transition = `opacity ${FADE_MS}ms`
  el.style.opacity = '0'
  setTimeout(() => {
    el.remove()
    const p = panel()
    if (p && !p.querySelector('.shiny-notification')) p.remove()
  }, FADE_MS)
}

/** A notification shown from the page itself (text, escaped): the downloads' "not yet" notes. */
export function notify(text: string, opts: { type?: 'message' | 'warning' | 'error', seconds?: number, id?: string } = {}): string {
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return showNotification({ html, type: opts.type ?? null, duration: (opts.seconds ?? 5) * 1000, id: opts.id ?? null })
}
