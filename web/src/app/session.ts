// A py-shiny session as the page's controller has one (shiny/session/_session.py, py-shiny 1.6.3): the
// inputs the browser reports, the outputs (each an effect, suspended while the browser says it is
// hidden), and the messages sent back, in py-shiny's order.
//
// receive() takes one client message as shiny.js sends it ({method: "init" | "update", data}) and
// returns what the server sent before it would read the next: dialogs, notifications and custom
// messages as they happen, then one flush message with the outputs' values, the input messages (the
// page switch) and the errors. Messages are written as web/parity/make_traces.py normalizes the
// Python's (no busy or progress messages, no HTML dependencies), so a trace compares as it is.
import { type Child, TagList } from '../shiny/htm'
import { Effect, flush, isolate, onFlushed, SilentException, Value, type Clock } from './reactive'

export type ServerMessage = Record<string, unknown>

export interface ClientMessage {
  method: 'init' | 'update'
  data: Record<string, unknown>
}

interface Output {
  effect: Effect
  suspendWhenHidden: boolean
}

export interface DownloadHandler {
  filename: () => string
  /** the file: its text, or its bytes (the handler's chunks joined) */
  build: () => string | Uint8Array
}

/** A session route's handler (session.dynamic_route): what a request with ``query`` answers. */
export type RouteHandler = (query: URLSearchParams) => unknown

/** urllib.parse.quote(text) (safe "/"): every byte but the unreserved ones and "/" percent-encoded. */
export function pyQuoteUrl(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%2F/g, '/')
}

/** A random hex id (shiny's rand_hex(8)): 16 hex digits. */
export function randHex(bytes = 8): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export class Session {
  /** The session id in the paths the server writes ("session/S/..."): the traces' normalized id. */
  readonly id = 'S'
  private messages: ServerMessage[] = []
  private readonly inputs = new Map<string, Value<unknown>>()
  private readonly outputs = new Map<string, Output>()
  private values = new Map<string, unknown>()
  private inputMessages: { id: string, message: Record<string, unknown> }[] = []
  private errors = new Map<string, unknown>()
  private readonly downloads = new Map<string, DownloadHandler>()
  private readonly routes = new Map<string, RouteHandler>()
  private unregister: (() => void) | null = null
  private listener: ((msg: ServerMessage) => void) | null = null

  constructor(readonly clock: Clock, private readonly server: (session: Session) => void) {}

  /** One client message; returns what the server sent in answer. The message goes through JSON as
   * it would over the websocket: every value is a new object, and NaN and Infinity arrive as null. */
  receive(msg: ClientMessage): ServerMessage[] {
    const start = this.messages.length
    const data = JSON.parse(JSON.stringify(msg.data)) as Record<string, unknown>
    if (msg.method === 'init') {
      this.unregister = onFlushed(() => this.flushOut())
      this.manageInputs(data)
      this.server(this)
      flush()
    } else {
      this.manageInputs(data)
    }
    flush()
    return this.messages.slice(start)
  }

  /** Hears each message as it is sent (the page: a timer's flush happens outside receive()). */
  onMessage(fn: (msg: ServerMessage) => void): void {
    this.listener = fn
  }

  /** The messages sent since ``start`` (a timer's flush happens outside receive()). */
  sentSince(start: number): ServerMessage[] {
    return this.messages.slice(start)
  }

  get sentCount(): number {
    return this.messages.length
  }

  close(): void {
    this.unregister?.()
    for (const o of this.outputs.values()) o.effect.destroy()
  }

  // --- inputs ------------------------------------------------------------------------------------

  /** input[id]: the value the browser last reported (missing until it does). */
  input<T = unknown>(id: string): Value<T> {
    let v = this.inputs.get(id)
    if (!v) {
      v = Value.missing<unknown>()
      this.inputs.set(id, v)
    }
    return v as Value<T>
  }

  private manageInputs(data: Record<string, unknown>): void {
    for (const [key, raw] of Object.entries(data)) {
      const keys = key.split(':')
      if (keys.length > 2) throw new Error(`Input name+type is not allowed to contain more than one ':' -- ${key}`)
      let val = raw
      if (keys.length === 2 && (keys[1] === 'shiny.action' || keys[1] === 'bslib.toolbar.button')) val = { action: raw as number }
      // the browser's value is new each time, whatever it holds (force: shiny's dedupe=FALSE)
      this.input(keys[0]).set(val, 'fresh', { force: true })
    }
    this.manageHidden()
  }

  /** Whether the browser reports output ``name`` hidden (true until it reports it). */
  isHidden(name: string): boolean {
    const v = this.inputs.get(`.clientdata_output_${name}_hidden`)
    if (!v) return true
    return isolate(() => (v.isSet() ? Boolean(v.get()) : true))
  }

  private manageHidden(): void {
    for (const [name, o] of this.outputs) {
      if (o.suspendWhenHidden && this.isHidden(name)) o.effect.suspend()
      else o.effect.resume()
    }
  }

  // --- outputs -----------------------------------------------------------------------------------

  /** @render.ui (and @output(suspend_when_hidden=...)): ``render`` gives the markup, or null. The value
   * sent is {html} (Shiny's {html, deps}; the page needs no dependencies). */
  outputUi(name: string, render: () => Child, { suspendWhenHidden = true } = {}): void {
    this.output(name, () => {
      const ui = render()
      return ui === null || ui === undefined ? null : { html: new TagList(ui).render() }
    }, suspendWhenHidden)
  }

  private output(name: string, render: () => unknown, suspendWhenHidden: boolean): void {
    this.outputs.get(name)?.effect.destroy()
    const effect = new Effect(() => {
      let value: unknown
      try {
        value = render()
      } catch (err) {
        if (!(err instanceof SilentException)) {
          // OutBoundMessageQueues.set_error: the error replaces any value queued for the output
          this.values.delete(name)
          this.errors.set(name, { message: err instanceof Error ? err.message : String(err), call: null, type: null })
          return
        }
        value = null
      }
      // set_value: the value replaces any error queued for the output
      this.values.set(name, value)
      this.errors.delete(name)
    }, { suspended: suspendWhenHidden && this.isHidden(name) })
    // the output is stale until it draws again: shiny.js marks it recalculating (py-shiny's
    // output_obs.on_invalidate; the traces leave these out, as they do Shiny's)
    effect.onInvalidate(() => this.send({ progress: { type: 'binding', message: { id: name } } }))
    this.outputs.set(name, { effect, suspendWhenHidden })
  }

  /** @render.download: the link's address, and the handler a click on it runs. */
  download(name: string, handler: DownloadHandler): void {
    this.downloads.set(name, handler)
    this.output(name, () => `session/${pyQuoteUrl(this.id)}/download/${pyQuoteUrl(name)}?w=`, true)
  }

  /** session.dynamic_route(name, handler): the handler a request to the route runs. */
  route(name: string, handler: RouteHandler): void {
    this.routes.set(name, handler)
  }

  /** A request to a route, run as Shiny runs one: inside the session, isolated. */
  request(name: string, query: URLSearchParams): unknown {
    const handler = this.routes.get(name)
    return handler ? isolate(() => handler(query)) : null
  }

  /** A download link followed: the file's name (its Content-Disposition, as Shiny writes it) and its
   * text. Shiny runs the handler outside any flush; what it changes shows at the next one. */
  requestDownload(name: string): { filename: string, disposition: string, data: string | Uint8Array } | null {
    const d = this.downloads.get(name)
    if (!d) return null
    return isolate(() => {
      const filename = d.filename()
      const quoted = pyQuoteUrl(filename)
      const disposition = quoted !== filename ? `attachment; filename*=utf-8''${quoted}` : `attachment; filename="${filename}"`
      return { filename, disposition, data: d.build() }
    })
  }

  // --- what the server sends ---------------------------------------------------------------------

  send(msg: ServerMessage): void {
    this.messages.push(msg)
    this.listener?.(msg)
  }

  sendCustomMessage(type: string, message: unknown): void {
    this.send({ custom: { [type]: message } })
  }

  /** ui.update_navset(id, selected=...): goes with the next flush. */
  updateNavset(id: string, selected: string): void {
    this.inputMessages.push({ id, message: { value: selected } })
  }

  modalShow(modal: Child): void {
    this.send({ modal: { type: 'show', html: new TagList(modal).render() } })
  }

  modalRemove(): void {
    this.send({ modal: { type: 'remove' } })
  }

  /** ui.notification_show(ui, action=, duration=, close_button=, id=, type=): returns its id. */
  notificationShow(ui: Child, { action = null as Child, duration = 5 as number | null, closeButton = true, id = null as string | null,
    type = 'default' } = {}): string {
    const nid = id || randHex(8)
    const msg: Record<string, unknown> = { html: new TagList(ui).render(), action: new TagList(action).render(), closeButton, id: nid, type }
    if (duration === null) msg.duration = null
    else if (duration) msg.duration = duration * 1000
    this.send({ notification: { type: 'show', message: msg } })
    return nid
  }

  notificationRemove(id: string): void {
    this.send({ notification: { type: 'remove', id } })
  }

  /** session._flush: the outputs' values, the input messages and the errors, in one message. */
  private flushOut(): void {
    if (this.values.size || this.inputMessages.length || this.errors.size) {
      this.send({ values: Object.fromEntries(this.values), inputMessages: this.inputMessages, errors: Object.fromEntries(this.errors) })
    }
    this.values = new Map()
    this.inputMessages = []
    this.errors = new Map()
  }
}
