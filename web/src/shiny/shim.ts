// The page's side of the stand-ins page/boot.js installs for www/ceica.js (window.Shiny and
// jQuery(document).on). Adapted from STAF's static app (src/app/shim.ts), whose stand-in this
// splits: boot.js installs it before ceica.js loads, and this module, loaded later, listens.
//
// ceica.js posts with Shiny.setInputValue(id, value, opts): onInput hears each post, those made
// before it was called too. It hears the server through handlers it registers by type: send()
// calls one. And it listens for jQuery events on the document: trigger() calls its handlers with an
// event object carrying the extra fields (shiny:value's `name`).

export type InputListener = (id: string, value: unknown, opts: { priority?: string }) => void
type Handler = (message: unknown) => void

interface Boot {
  listener: InputListener | null
  queued: [string, unknown, { priority?: string }][]
  handlers: Record<string, Handler>
  listeners: Record<string, ((e: unknown) => void)[]>
}

function boot(): Boot {
  const w = window as unknown as { ceicaBoot?: Boot }
  if (!w.ceicaBoot) throw new Error('page/boot.js has not run')
  return w.ceicaBoot
}

/** Hears every input the page's scripts post (those posted before this call too). */
export function onInput(fn: InputListener): void {
  const b = boot()
  b.listener = fn
  for (const [id, value, opts] of b.queued.splice(0)) fn(id, value, opts)
}

/** A custom message to ceica.js; false when no handler is registered for its type. */
export function send(type: string, message: unknown): boolean {
  const fn = boot().handlers[type]
  if (fn) fn(message)
  return !!fn
}

/** A jQuery event on the document, as ceica.js's jQuery(document).on(...) handlers receive it. */
export function trigger(type: string, fields: Record<string, unknown> = {}): void {
  const handlers = boot().listeners[type] ?? []
  const event = { type, target: document, ...fields, preventDefault() {}, isDefaultPrevented: () => false }
  for (const fn of handlers) fn(event)
}
