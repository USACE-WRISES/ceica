// shiny.js on CEICA's page, with the server in the page: py-shiny 1.6.3's www/shared/shiny.js, the
// parts this page uses, in its order and with its quirks.
//
// The Shiny page talks to its server over a websocket: inputs go out in batches, and each message
// that comes back is handled in turn. Here the server is the controller (session.ts, server.ts) and
// this module does what shiny.js does:
//
// - binding: after each draw, the inputs and outputs inside it are bound as shiny.js binds them
//   (its classes and aria-live, the download links enabled, a value already sent drawn at once), and
//   each new input's value is sent;
// - inputs: Shiny.setInputValue and the bound inputs' changes go through shiny.js's chain (a pause
//   of 250 ms while typing, no resend of an unchanged value, an "event" input sent at once with what
//   waits, the others batched on the message queue, each batch queued on its own);
// - visibility: each output reports whether it is hidden (shiny.js's isVisible, from the layout)
//   after a bind or an unbind, and 100 ms after its resize or intersection observer sees a change;
// - messages, one at a time: values, then errors, then input messages (the page switch), then
//   notifications, dialogs and custom messages (www/ceica.js's), and the conditional panels after.
//
// Two things stand in for the round trip to a server. A message reaches the controller two tasks
// after it is sent, so ceica.js's zero-delay focus check runs first, as it does before a server's
// answer. And while a pointer is down nothing reaches the controller until its click has fired: a
// change sent as the pointer went down (a field left for a button) must not redraw the button
// before the click lands on it.
//
// The autosave handlers keep projects in IndexedDB (storage.ts) in place of ceica.js's localStorage:
// ce_autosave, ce_restore and ce_forget are answered here, and the Recent list ceica.js posts at
// connect is replaced by IndexedDB's.
import Modal from 'bootstrap/js/dist/modal'
import Tab from 'bootstrap/js/dist/tab'
import '../shiny/bslib'
import type { Download } from '../engine/report/files'
import { follow, registerDownload } from '../shiny/download'
import { notify, removeNotification, showNotification } from '../shiny/notify'
import { onInput, send as sendCustom, trigger } from '../shiny/shim'
import { FileMaker } from './fileMaker'
import type { ClientMessage, ServerMessage, Session } from './session'
import * as storage from './storage'

type Priority = 'immediate' | 'deferred' | 'event'
interface Opts { priority?: Priority }

/** shiny.js's Debouncer */
class Debouncer<A extends unknown[]> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private args: A | null = null

  constructor(private readonly fn: (...args: A) => void, private readonly delay: number) {}

  normalCall(...args: A): void {
    this.clear()
    this.args = args
    this.timer = setTimeout(() => {
      if (this.timer === null) return
      this.clear()
      this.invoke()
    }, this.delay)
  }

  immediateCall(...args: A): void {
    this.clear()
    this.args = args
    this.invoke()
  }

  cancel(): void {
    this.clear()
    this.args = null
  }

  isPending(): boolean {
    return this.timer !== null
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private invoke(): void {
    const args = this.args ?? ([] as unknown as A)
    this.fn(...args)
    this.args = null
  }
}

type SetInput = (nameType: string, value: unknown, opts: Opts) => void

/** shiny.js's Invoker: a call goes through at once. */
class Invoker {
  constructor(private readonly fn: SetInput) {}
  normalCall(nameType: string, value: unknown, opts: Opts): void {
    this.fn(nameType, value, opts)
  }

  immediateCall(nameType: string, value: unknown, opts: Opts): void {
    this.fn(nameType, value, opts)
  }
}

/** shiny.js's AsyncQueue and action loop: one task at a time, never inside enqueue(). */
class TaskQueue {
  private tasks: (() => unknown)[] = []
  private running = false

  enqueue(task: () => unknown): void {
    this.tasks.push(task)
    if (this.running) return
    this.running = true
    queueMicrotask(() => void this.run())
  }

  private async run(): Promise<void> {
    while (this.tasks.length) {
      const task = this.tasks.shift()!
      try {
        await task()
      } catch (err) {
        console.error(err)
      }
    }
    this.running = false
  }
}

// --- bindings --------------------------------------------------------------------------------------

type Scope = Element | Document
type Callback = (priority?: boolean) => void

/** What an event on a bound input means: the input, the event, its value-change callback. */
type Handler = (el: Element, e: Event, cb: Callback, client: Client) => void

interface InputBinding {
  find(scope: Scope): Element[]
  getId(el: Element): string
  getType(el: Element): string | null
  getValue(el: Element): unknown
  /** the events it hears on its element (bubbling ones from inside it too), as shiny.js subscribes;
   * the page hears them once, on the document, before ceica.js does (inputEvents) */
  events: Record<string, Handler>
  /** a typing pause (debounce), or none */
  rate: number | null
  receiveMessage?(el: Element, data: Record<string, unknown>): void
}

const elements = (scope: Scope, selector: string): Element[] => Array.from(scope.querySelectorAll(selector))
const baseId = (el: Element): string => el.getAttribute('data-input-id') || el.id

/** shiny.js's text binding: a pause while typing ("change", the default), or on leaving ("blur") */
const updateOn = (el: Element): string => el.getAttribute('data-update-on') || 'change'
const TEXT_EVENTS: Record<string, Handler> = {
  keyup: (el, _e, cb) => {
    if (updateOn(el) === 'change') cb(true)
  },
  input: (el, _e, cb) => {
    if (updateOn(el) === 'change') cb(true)
  },
  blur: (el, _e, cb) => {
    if (updateOn(el) === 'blur') cb(false)
  },
  keydown: (el, e, cb) => {
    if (updateOn(el) !== 'blur') return
    const k = e as KeyboardEvent
    if (k.key !== 'Enter') return
    if (el.tagName === 'TEXTAREA' && !(k.ctrlKey || k.metaKey)) return
    cb(false)
  },
  change: (el, _e, cb) => {
    if (updateOn(el) === 'blur' && document.activeElement === el) return
    cb(false)
  },
}

const TEXT: InputBinding = {
  find: (scope) => elements(scope, 'input[type="text"], input[type="search"], input[type="url"], input[type="email"]')
    .filter((el) => !(el.getAttribute('type') === 'text' && el.id.endsWith('-selectized'))),
  getId: (el) => baseId(el) || (el as HTMLInputElement).name,
  getType: () => null,
  getValue: (el) => (el as HTMLInputElement).value,
  events: TEXT_EVENTS,
  rate: 250,
}

const TEXTAREA: InputBinding = { ...TEXT, find: (scope) => elements(scope, 'textarea') }

const PASSWORD: InputBinding = { ...TEXT, find: (scope) => elements(scope, 'input[type="password"]'), getType: () => 'shiny.password' }

const NUMBER: InputBinding = {
  ...TEXT,
  find: (scope) => elements(scope, 'input[type="number"]'),
  getType: () => 'shiny.number',
  getValue: (el) => {
    const text = (el as HTMLInputElement).value
    if (/^\s*$/.test(text)) return null
    const n = Number(text)
    return isNaN(n) ? text : n
  },
}

const CHECKBOX: InputBinding = {
  find: (scope) => elements(scope, 'input[type="checkbox"]'),
  getId: baseId,
  getType: () => null,
  getValue: (el) => (el as HTMLInputElement).checked,
  events: { change: (_el, _e, cb) => cb(true) },
  rate: null,
}

const RADIO: InputBinding = {
  find: (scope) => elements(scope, '.shiny-input-radiogroup'),
  getId: baseId,
  getType: () => null,
  getValue: (el) => {
    const checked = document.querySelector<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.id)}"]:checked`)
    return checked ? checked.value : null
  },
  events: { change: (_el, _e, cb) => cb(false) },
  rate: null,
}

/** jQuery's .val() of a select */
function selectValue(el: HTMLSelectElement): unknown {
  if (el.multiple) return Array.from(el.selectedOptions, (o) => o.value)
  return el.selectedIndex < 0 ? null : el.options[el.selectedIndex].value
}

const SELECT: InputBinding = {
  find: (scope) => elements(scope, 'select'),
  getId: (el) => baseId(el) || (el as HTMLSelectElement).name,
  getType: (el) => (el.classList.contains('symbol') ? ((el as HTMLSelectElement).multiple ? 'shiny.symbolList' : 'shiny.symbol') : null),
  getValue: (el) => selectValue(el as HTMLSelectElement),
  events: { change: (_el, _e, cb) => cb(false) },
  rate: null,
}

const clicks = new WeakMap<Element, number>()

const ACTION: InputBinding = {
  find: (scope) => elements(scope, '.action-button'),
  getId: baseId,
  getType: () => 'shiny.action',
  getValue: (el) => clicks.get(el) || 0,
  events: {
    click: (el, _e, cb) => {
      clicks.set(el, (clicks.get(el) || 0) + 1)
      cb(false)
    },
  },
  rate: null,
}

/** a tab's name: its data-value, or its text */
const tabName = (a: Element): string => a.getAttribute('data-value') || (a.textContent ?? '')
const tabLinks = (el: Element): Element[] => elements(el, '.nav-link:not(.dropdown-toggle), .dropdown-menu .dropdown-item')

const TABS: InputBinding = {
  find: (scope) => elements(scope, 'ul.nav.shiny-tab-input'),
  getId: baseId,
  getType: () => null,
  getValue: (el) => {
    const active = elements(el, '.nav-link:not(.dropdown-toggle).active, .dropdown-menu .dropdown-item.active')
    return active.length === 1 ? tabName(active[0]) : null
  },
  events: { 'change': (_el, _e, cb) => cb(false), 'shown.bs.tab': (_el, _e, cb) => cb(false) },
  rate: null,
  receiveMessage: (el, data) => {
    if (data.value !== undefined && data.value !== null) {
      let found = false
      if (data.value) {
        for (const a of tabLinks(el)) {
          if (tabName(a) === data.value) {
            Tab.getOrCreateInstance(a).show()
            found = true
            break
          }
        }
      }
      if (!found) el.dispatchEvent(new Event('change'))
    }
    el.dispatchEvent(new Event('change'))
  },
}

const FILE: InputBinding = {
  find: (scope) => elements(scope, 'input[type="file"]'),
  getId: (el) => baseId(el) || (el as HTMLInputElement).name,
  getType: () => 'shiny.file',
  getValue: () => null,
  events: { change: (el, _e, _cb, client) => void client.uploadFiles(el as HTMLInputElement) },
  rate: null,
}

/** shiny.js's input bindings, in its order (those CEICA's markup holds) */
const INPUT_BINDINGS = [TEXT, TEXTAREA, PASSWORD, NUMBER, CHECKBOX, RADIO, SELECT, ACTION, TABS, FILE]

/** every event an input binding hears */
const INPUT_EVENTS = [...new Set(INPUT_BINDINGS.flatMap((b) => Object.keys(b.events)))]

interface OutputBinding {
  readonly selector: string
  renderValue(el: HTMLElement, data: unknown, client: Client): Promise<void> | void
  renderError(el: HTMLElement, err: OutputError, client: Client): void
  /** shiny.js's showProgress: an output not drawn yet is marked recalculating (a download link is not) */
  showsProgress: boolean
}

interface OutputError { message: string, type: string | string[] | null }

function clearError(el: HTMLElement): void {
  const cls = el.getAttribute('class') ?? ''
  const clean = cls.replace(/(^|\s)shiny-output-error\S*/g, '')
  if (clean !== cls) el.setAttribute('class', clean)
}

function renderError(el: HTMLElement, err: OutputError): void {
  clearError(el)
  if (err.message === '') {
    el.replaceChildren()
    return
  }
  let cls = 'shiny-output-error'
  if (err.type !== null) cls += ' ' + [err.type].flat().map((t) => `shiny-output-error-${t}`).join(' ')
  el.classList.add(...cls.split(' '))
  el.textContent = err.message
}

const DOWNLOAD_LINK: OutputBinding = {
  selector: 'a.shiny-download-link',
  renderValue: (el, data) => {
    el.setAttribute('href', String(data))
    if (!el.hasAttribute('data-shiny-disable-auto-enable') && !el.classList.contains('shinyjs-disabled')) {
      el.classList.remove('disabled')
      el.removeAttribute('aria-disabled')
      el.removeAttribute('tabindex')
    }
  },
  renderError: (el, err) => renderError(el, err),
  showsProgress: false,
}

const HTML_OUTPUT: OutputBinding = {
  selector: '.shiny-html-output',
  renderValue: (el, data, client) => client.renderContent(el, data),
  renderError: (el, err, client) => {
    client.unbindAll(el)
    renderError(el, err)
  },
  showsProgress: true,
}

/** shiny.js's output bindings, in its order (those CEICA's markup holds) */
const OUTPUT_BINDINGS = [DOWNLOAD_LINK, HTML_OUTPUT]

interface BoundOutput {
  readonly id: string
  readonly el: HTMLElement
  readonly binding: OutputBinding
}

interface ObserverCallback {
  (): void
  flush(): void
  cancel(): void
}

interface Observed {
  resize: ResizeObserver
  intersect: IntersectionObserver
  callbacks: ObserverCallback[]
}

/** shiny.js's isVisible: a box of its own, or no display:none up to the root. */
function isVisible(el: Element): boolean {
  const h = el as HTMLElement
  if (h.offsetWidth !== 0 || h.offsetHeight !== 0) return true
  if (getComputedStyle(el).getPropertyValue('display') === 'none') return false
  return el.parentElement ? isVisible(el.parentElement) : true
}

/** An output drawn as display: contents has no box: the observers watch its nearest ancestor that is
 * not one (shiny.js's resolveObservableTarget). */
function observableTarget(el: Element): Element {
  if (!el.classList.contains('shiny-html-output')) return el
  for (let c = el.parentElement; c; c = c.parentElement) {
    if (!c.classList.contains('shiny-html-output')) return c
    if (c === document.documentElement) break
  }
  return el
}

/** shiny.js's scopeExprToFunc: a conditional panel's condition, run with the inputs and outputs. */
function conditionFunction(expr: string): (scope: unknown) => unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`with (this) {
        try {
          return (${expr});
        } catch (e) {
          console.error('Error evaluating expression: ' + ${JSON.stringify(expr)});
          throw e;
        }
      }`) as (this: unknown) => unknown
  return (scope) => fn.call(scope)
}

/** ceica.js's nonce */
const nonce = (): number => Date.now() + Math.random()

export interface ClientOptions {
  /** The Report page's files address (ServerOptions.filesUrl) */
  filesUrl: string
  /** after each autosave: whether this browser kept it (offline.ts asks for persistent storage) */
  onKept?: (kept: boolean) => void
  /** the controller's answer to ce_reload, once any save it made is kept (offline.ts) */
  onReload?: (reply: { id: string | null, save: boolean, kept: boolean }) => void
}

/** A file the Report page's files route answers (report/files.ts's resolve). */
interface RouteAnswer {
  item?: Download | null
  inline?: boolean
  /** a job's project file text and day (the route's answer at the click) */
  project?: string
  today?: string
  failed?: string
}

export class Client {
  /** download jobs' files, made in the files worker */
  private readonly files = new FileMaker()
  /** the last autosave: whether this browser kept it */
  private kept: Promise<boolean> = Promise.resolve(true)
  private session: Session | null = null
  private readonly queue = new TaskQueue()

  // shinyapp: what the server sent, and the bound outputs
  private readonly values = new Map<string, unknown>()
  private readonly errors = new Map<string, unknown>()
  private readonly bound = new Map<string, BoundOutput>()
  private readonly outputOf = new WeakMap<Element, BoundOutput>()
  private inputValues: Record<string, unknown> = {}
  // shiny.js's OutputProgressReporter, as far as a server in the page needs it (no recalculating
  // messages come here): an output is recalculating until its first value or error, and again from
  // its invalidation (a binding progress message) until its next one
  private readonly drawn = new Set<string>()
  private progressChanged: string[] = []

  // the input chain
  private readonly inputOf = new WeakMap<Element, InputBinding>()
  private readonly rates = new Map<string, Debouncer<[string, unknown, Opts]> | Invoker>()
  /** each input's typing pause from its binding (its Debouncer is made at its first change) */
  private readonly rateDelays = new Map<string, number>()
  private lastSent = new Map<string, { json: string, type: string }>()
  private pending: Record<string, unknown> = {}
  private reentrant = false
  private readonly lastChance: (() => void)[] = []

  // visibility (sendOutputInfo)
  private readonly visible = new Set<string>()
  private readonly observed = new WeakMap<Element, Observed>()
  private readonly pendingObservers = new Set<ObserverCallback>()
  private readonly outputInfo = new Debouncer<[]>(() => this.doSendOutputInfo(false), 0)
  private initialValues: Record<string, unknown> | null = null

  // the round trip
  private readonly outbox: ClientMessage[] = []
  private due = 0
  private pointerHeld = false

  // uploads, by the datapath the controller reads them by
  private readonly uploads = new Map<string, Uint8Array>()
  private uploadCount = 0

  // the Report page's thumbnails (blob addresses), by output, and what each stands for
  private readonly thumbs = new Map<string, string[]>()
  readonly thumbQueries = new Map<string, string>()

  private readonly conditions = new WeakMap<Element, (scope: unknown) => unknown>()
  /** whether the page may hold a conditional panel (markup with data-display-if came in since the
   * last look found none): the look over the whole page is skipped when it cannot */
  private conditionalsMaybe = true

  constructor(private readonly opts: ClientOptions) {
    this.lastChance.push(() => {
      for (const cb of [...this.pendingObservers]) cb.flush()
      if (this.outputInfo.isPending()) this.outputInfo.immediateCall()
    })
  }

  // --- start -----------------------------------------------------------------------------------------

  /** shiny.js's initShiny and connect: bind the page, send its inputs, start taking messages. */
  async start(session: Session): Promise<void> {
    this.session = session
    session.onMessage((msg) => this.queue.enqueue(() => this.dispatch(msg)))
    this.holdForPointer()
    this.interceptLinks()
    // the bound inputs' events, heard on the document before they reach the input itself, so before
    // ceica.js's listeners as an input's own listeners are
    for (const type of INPUT_EVENTS) document.addEventListener(type, (e) => this.inputEvent(e), true)
    for (const id of ['save_project', 'dl_template_generic', 'dl_template_ixq', 'dl_template_staf']) registerDownload(id, this.download(id))
    onInput((id, value, opts) => {
      // ceica.js's Recent list comes from localStorage: the page sends IndexedDB's instead
      if (id === 'ce_recents') {
        this.sendRecents()
        return
      }
      this.setInputValue(id, value, opts as Opts)
    })
    const items = await this.bindAllItems(document.documentElement)
    const initial: Record<string, unknown> = {}
    for (const [name, item] of items) initial[name] = item.value
    this.initialValues = initial
    this.doSendOutputInfo(true)
    this.initialValues = null
    initial['.clientdata_pixelratio'] = window.devicePixelRatio || 1
    initial['.clientdata_url_protocol'] = location.protocol
    initial['.clientdata_url_hostname'] = location.hostname
    initial['.clientdata_url_port'] = location.port
    initial['.clientdata_url_pathname'] = location.pathname
    initial['.clientdata_url_search'] = location.search
    initial['.clientdata_url_hash_initial'] = location.hash
    initial['.clientdata_url_hash'] = location.hash
    initial['.clientdata_singletons'] = ''
    this.resetSent(initial)
    this.inputValues = { ...initial }
    trigger('shiny:connected')
    this.transmit({ method: 'init', data: initial })
  }

  // --- the round trip --------------------------------------------------------------------------------

  /** A message to the controller, delivered two tasks from now (and not while a pointer is down). */
  private transmit(msg: ClientMessage): void {
    this.outbox.push(msg)
    setTimeout(() => setTimeout(() => {
      this.due++
      this.pump()
    }, 0), 0)
  }

  private pump(): void {
    if (this.pointerHeld) return
    while (this.due > 0 && this.outbox.length) {
      this.due--
      const msg = this.outbox.shift()!
      // empty updates (shiny.js queues one per batched input) change nothing after the first
      if (msg.method === 'update' && !Object.keys(msg.data).length && this.outbox[0]?.method === 'update'
        && !Object.keys(this.outbox[0].data).length) continue
      this.session!.receive(msg)
    }
  }

  private holdForPointer(): void {
    const release = (): void => {
      if (!this.pointerHeld) return
      this.pointerHeld = false
      setTimeout(() => this.pump(), 0)
    }
    document.addEventListener('pointerdown', (e) => {
      if (e.isPrimary) this.pointerHeld = true
    }, true)
    document.addEventListener('click', release, true)
    // no click follows (a drag, or the pointer left the element): let go once the click would have fired
    document.addEventListener('pointerup', () => setTimeout(release, 0), true)
    document.addEventListener('pointercancel', release, true)
  }

  // --- inputs ----------------------------------------------------------------------------------------

  /** The web app's reload for an update (offline.ts): asks the controller whether a project is open,
   * saving it first when ``save``. */
  askReload(save: boolean): void {
    this.setInputValue('ce_reload', { save, n: nonce() }, { priority: 'event' })
  }

  /** Continue on a kept project, as the start page's button does (offline.ts, after an update). */
  restore(id: string): void {
    this.setInputValue('ce_event', { type: 'restore', n: nonce(), id }, { priority: 'event' })
  }

  /** The files worker started now (offline.ts: its script read while this build's copy is kept). */
  warmFiles(): void {
    this.files.warm()
  }

  /** Shiny.setInputValue(name, value, opts) */
  setInputValue(nameType: string, value: unknown, opts: Opts = {}): void {
    const priority = opts.priority ?? 'immediate'
    if (!nameType) throw "Can't set input with empty name."
    if (!['immediate', 'deferred', 'event'].includes(priority)) throw new Error(`Unexpected input value mode: '${priority}'`)
    const name = nameType.split(':')[0]
    let rate = this.rates.get(name)
    if (!rate) {
      const set: SetInput = (n, v, o) => this.noResend(n, v, o)
      const delay = this.rateDelays.get(name)
      rate = delay === undefined ? new Invoker(set) : new Debouncer<[string, unknown, Opts]>(set, delay)
      this.rates.set(name, rate)
    }
    if (priority !== 'deferred') rate.immediateCall(nameType, value, { priority })
    else rate.normalCall(nameType, value, { priority })
  }

  /** InputRateDecorator.setRatePolicy: a new policy for the input (a call still waiting on the old one
   * goes ahead on its own, as in shiny.js); made at the input's first change */
  private setRatePolicy(nameType: string, delay: number): void {
    const name = nameType.split(':')[0]
    this.rateDelays.set(name, delay)
    this.rates.delete(name)
  }

  /** InputNoResendDecorator: an unchanged value is not sent again (an "event" input always is). */
  private noResend(nameType: string, value: unknown, opts: Opts): void {
    const [name, type = ''] = nameType.split(':')
    const json = JSON.stringify(value)
    const last = this.lastSent.get(name)
    if (opts.priority !== 'event' && last && last.json === json && last.type === type) return
    this.lastSent.set(name, { json, type })
    this.batch(nameType, value, opts)
  }

  private resetSent(values: Record<string, unknown>): void {
    this.lastSent = new Map(Object.entries(values).map(([nameType, v]) => {
      const [name, type = ''] = nameType.split(':')
      return [name, { json: JSON.stringify(v), type }]
    }))
  }

  /** InputBatchSender: an "event" input goes at once with what waits; any other queues a send. */
  private batch(nameType: string, value: unknown, opts: Opts): void {
    this.pending[nameType] = value
    if (this.reentrant) return
    if (opts.priority === 'event') this.sendNow()
    else this.queue.enqueue(() => this.sendNow())
  }

  private sendNow(): void {
    this.reentrant = true
    try {
      for (const fn of this.lastChance) fn()
      const data = this.pending
      this.pending = {}
      this.transmit({ method: 'update', data })
      Object.assign(this.inputValues, data)
      this.updateConditionals()
    } finally {
      this.reentrant = false
    }
  }

  /** ceica.js's sendRecents, from IndexedDB */
  private sendRecents(): void {
    void storage.recents().then((items) => this.setInputValue('ce_recents', { items, n: nonce() }))
  }

  // --- binding ---------------------------------------------------------------------------------------

  private async bindOutputs(scope: Element): Promise<void> {
    for (const binding of OUTPUT_BINDINGS) {
      for (const el of elements(scope, binding.selector) as HTMLElement[]) {
        const id = baseId(el)
        if (!id) continue
        if (!document.documentElement.contains(el)) continue
        if (el.classList.contains('shiny-bound-output')) continue
        const out: BoundOutput = { id, el, binding }
        this.bound.set(id, out)
        if (this.values.get(id) !== undefined) await this.onValueChange(out, this.values.get(id))
        else if (this.errors.get(id) !== undefined) binding.renderError(el, this.errors.get(id) as OutputError, this)
        this.outputOf.set(el, out)
        el.classList.add('shiny-bound-output')
        if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite')
        if (!this.drawn.has(id) && binding.showsProgress) el.classList.add('recalculating')
      }
    }
    setTimeout(() => this.outputInfo.normalCall(), 0)
  }

  private bindInputs(scope: Element): Map<string, { value: unknown }> {
    const items = new Map<string, { value: unknown }>()
    for (const binding of INPUT_BINDINGS) {
      for (const el of binding.find(scope)) {
        if (el.hasAttribute('data-shiny-no-bind-input')) continue
        const id = binding.getId(el)
        if (!id || el.classList.contains('shiny-bound-input')) continue
        const type = binding.getType(el)
        const nameType = type ? `${id}:${type}` : id
        items.set(nameType, { value: binding.getValue(el) })
        this.inputOf.set(el, binding)
        el.classList.add('shiny-bound-input')
        if (binding.rate !== null) this.setRatePolicy(nameType, binding.rate)
      }
    }
    return items
  }

  /** a bound input changed (shiny.js's valueChangeCallback) */
  private valueChanged(binding: InputBinding, el: Element, priority?: boolean): void {
    const id = binding.getId(el)
    if (!id) return
    const type = binding.getType(el)
    this.setInputValue(type ? `${id}:${type}` : id, binding.getValue(el), { priority: priority === true ? 'deferred' : 'immediate' })
  }

  /** An event a bound input hears (shiny.js's subscribe): the bound inputs it reaches, innermost
   * first; an event that does not bubble reaches its target alone. */
  private inputEvent(e: Event): void {
    const target = e.target
    if (!(target instanceof Element)) return
    for (let el: Element | null = target; el; el = e.bubbles ? el.parentElement : null) {
      const binding = this.inputOf.get(el)
      const handler = binding?.events[e.type]
      if (binding && handler && el.classList.contains('shiny-bound-input')) {
        const bound = el
        handler(bound, e, (priority) => this.valueChanged(binding, bound, priority), this)
      }
    }
  }

  private async bindAllItems(scope: Element): Promise<Map<string, { value: unknown }>> {
    await this.bindOutputs(scope)
    return this.bindInputs(scope)
  }

  /** shiny.js's bindAll: bind, then send each new input's value */
  private async bindAll(scope: Element): Promise<void> {
    const items = await this.bindAllItems(scope)
    for (const [name, item] of items) this.setInputValue(name, item.value)
  }

  /** shiny.js's unbindAll (the scope itself left bound). Every caller replaces or removes the scope's
   * content next, so its inputs need nothing: they hear no events once off the page, and their marks
   * go with them. Its outputs are let go of (their ids and visibility observers). */
  unbindAll(scope: Element): void {
    for (const el of elements(scope, '.shiny-bound-output')) {
      const out = this.outputOf.get(el)
      if (!out) continue
      if (this.bound.get(out.id) === out) this.bound.delete(out.id)
      el.classList.remove('shiny-bound-output')
      this.outputOf.delete(el)
      const obs = this.observed.get(el)
      if (obs) {
        obs.resize.disconnect()
        obs.intersect.disconnect()
        for (const cb of obs.callbacks) cb.cancel()
        this.observed.delete(el)
      }
    }
    setTimeout(() => this.outputInfo.normalCall(), 0)
  }

  /** renderContentAsync: the old content unbound, the new one inserted and bound. */
  async renderContent(el: HTMLElement, content: unknown): Promise<void> {
    this.unbindAll(el)
    const html = content === null || content === undefined ? '' : typeof content === 'string' ? content : (content as { html: string }).html
    this.insert(el, html)
    await this.bindAll(el)
  }

  /** jQuery's .html(): the markup as it is (a dialog's own script is Shiny's show, done in showModal);
   * the Report page's thumbnails are given their files at once (blob addresses), so the page never
   * asks the files address for them. */
  private insert(el: HTMLElement, html: string): void {
    if (html.includes('data-display-if')) this.conditionalsMaybe = true
    const out = this.outputOf.get(el)
    if (out) for (const url of this.thumbs.get(out.id) ?? []) {
      URL.revokeObjectURL(url)
      this.thumbQueries.delete(url)
    }
    if (!html.includes(this.opts.filesUrl)) {
      el.innerHTML = html
      return
    }
    const t = document.createElement('template')
    t.innerHTML = html
    const made: string[] = []
    for (const img of Array.from(t.content.querySelectorAll('img[src]'))) {
      const src = img.getAttribute('src')!
      if (!src.startsWith(this.opts.filesUrl)) continue
      const url = this.fileUrl(src)
      if (url === null) continue
      img.setAttribute('src', url)
      made.push(url)
      this.thumbQueries.set(url, src)
    }
    if (out) this.thumbs.set(out.id, made)
    el.replaceChildren(t.content)
  }

  // --- visibility ------------------------------------------------------------------------------------

  private observerCallback(fn: () => void): ObserverCallback {
    const debouncer = new Debouncer<[]>(() => {
      this.pendingObservers.delete(cb)
      fn()
    }, 100)
    const cb = Object.assign(() => {
      this.pendingObservers.add(cb)
      debouncer.normalCall()
    }, {
      cancel: () => {
        this.pendingObservers.delete(cb)
        debouncer.cancel()
      },
      flush: () => {
        this.pendingObservers.delete(cb)
        if (debouncer.isPending()) debouncer.immediateCall()
      },
    }) as ObserverCallback
    return cb
  }

  private ensureObservers(el: HTMLElement): void {
    if (this.observed.has(el) || typeof ResizeObserver === 'undefined' || typeof IntersectionObserver === 'undefined') return
    const onResize = this.observerCallback(() => this.sendHiddenState(el, false))
    const onIntersect = this.observerCallback(() => this.sendHiddenState(el, false))
    const resize = new ResizeObserver(() => onResize())
    resize.observe(el)
    const intersect = new IntersectionObserver(() => onIntersect())
    intersect.observe(observableTarget(el))
    this.observed.set(el, { resize, intersect, callbacks: [onResize, onIntersect] })
  }

  private sendHiddenState(el: HTMLElement, initial: boolean): void {
    const out = this.outputOf.get(el)
    if (!out) return
    const hidden = !isVisible(el)
    if (hidden) this.visible.delete(out.id)
    else this.visible.add(out.id)
    this.setClientInput(`.clientdata_output_${out.id}_hidden`, hidden, initial)
  }

  private setClientInput(name: string, value: unknown, initial: boolean): void {
    if (initial && this.initialValues) this.initialValues[name] = value
    else this.setInputValue(name, value)
  }

  private doSendOutputInfo(initial: boolean): void {
    const ids = new Set<string>()
    for (const el of elements(document, '.shiny-bound-output') as HTMLElement[]) {
      const out = this.outputOf.get(el)
      if (out) ids.add(out.id)
      this.ensureObservers(el)
      this.sendHiddenState(el, initial)
    }
    for (const id of [...this.visible]) {
      if (ids.has(id)) continue
      this.visible.delete(id)
      this.setClientInput(`.clientdata_output_${id}_hidden`, true, initial)
    }
  }

  // --- messages --------------------------------------------------------------------------------------

  private async dispatch(msg: ServerMessage): Promise<void> {
    if ('values' in msg && 'errors' in msg) {
      // a flush: each output given a value or an error is no longer recalculating
      for (const name of [...Object.keys(msg.values as object), ...Object.keys(msg.errors as object)]) {
        if (!this.drawn.has(name)) {
          this.drawn.add(name)
          this.progressChanged.push(name)
        }
      }
    }
    if ('progress' in msg) {
      const pr = msg.progress as { type: string, message: { id: string } }
      if (pr.type === 'binding' && this.drawn.delete(pr.message.id)) this.progressChanged.push(pr.message.id)
    }
    if ('values' in msg) await this.onValues(msg.values as Record<string, unknown>)
    if ('errors' in msg) this.onErrors(msg.errors as Record<string, OutputError>)
    if ('inputMessages' in msg) this.onInputMessages(msg.inputMessages as { id: string, message: Record<string, unknown> }[])
    if ('progress' in msg) this.updateProgress()
    if ('notification' in msg) this.onNotification(msg.notification as { type: string, message?: Record<string, unknown>, id?: string })
    if ('modal' in msg) await this.onModal(msg.modal as { type: string, html?: string })
    if ('custom' in msg) this.onCustom(msg.custom as Record<string, Record<string, unknown>>)
    this.updateConditionals()
  }

  /** _updateProgress: each output whose progress changed, marked as it now is */
  private updateProgress(): void {
    for (const name of this.progressChanged.splice(0)) {
      const out = this.bound.get(name)
      if (out?.binding.showsProgress) out.el.classList.toggle('recalculating', !this.drawn.has(name))
    }
  }

  private async onValues(values: Record<string, unknown>): Promise<void> {
    this.updateProgress()
    for (const [name, value] of Object.entries(values)) await this.receiveOutput(name, value)
  }

  private async receiveOutput(name: string, value: unknown): Promise<void> {
    const out = this.bound.get(name)
    if (this.values.get(name) === value) {
      trigger('shiny:value', { name, value, binding: out })
      return
    }
    this.values.set(name, value)
    this.errors.delete(name)
    trigger('shiny:value', { name, value, binding: out })
    if (out) await this.onValueChange(out, value)
  }

  private async onValueChange(out: BoundOutput, value: unknown): Promise<void> {
    clearError(out.el)
    await out.binding.renderValue(out.el, value, this)
  }

  private onErrors(errors: Record<string, OutputError>): void {
    for (const [name, err] of Object.entries(errors)) {
      if (this.errors.get(name) === err) continue
      this.errors.set(name, err)
      this.values.delete(name)
      const out = this.bound.get(name)
      if (out) out.binding.renderError(out.el, err, this)
    }
  }

  private onInputMessages(messages: { id: string, message: Record<string, unknown> }[]): void {
    for (const { id, message } of messages) {
      const el = document.querySelector(`.shiny-bound-input#${CSS.escape(id)}`)
      if (!el) continue
      if (!el.getAttribute('aria-live')) el.setAttribute('aria-live', 'polite')
      try {
        this.inputOf.get(el)?.receiveMessage?.(el, message)
      } catch (error) {
        console.error('[shiny] Error in inputBinding.receiveMessage()', { error, message })
      }
    }
  }

  private onNotification(n: { type: string, message?: Record<string, unknown>, id?: string }): void {
    if (n.type === 'show') {
      const m = n.message ?? {}
      showNotification({ html: String(m.html ?? ''), action: String(m.action ?? ''), duration: m.duration as number | null | undefined,
        id: (m.id as string | null) ?? null, closeButton: m.closeButton as boolean | undefined, type: (m.type as string | null) ?? null })
    } else if (n.type === 'remove') {
      removeNotification(n.id!)
    }
  }

  /** shiny.js's modal show and remove */
  private async onModal(m: { type: string, html?: string }): Promise<void> {
    if (m.type === 'show') await this.showModal(m.html ?? '')
    else if (m.type === 'remove') this.removeModal()
  }

  private readonly modalKeydown = (e: KeyboardEvent): void => {
    // a dialog that closes easily: Escape closes it and goes no further (a dialog that does not: Bootstrap ignores it)
    if (document.getElementById('shiny-modal')?.getAttribute('data-keyboard') === 'false') return
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
    }
  }

  private async showModal(html: string): Promise<void> {
    document.querySelectorAll('.modal-backdrop').forEach((b) => b.remove())
    let wrapper = document.getElementById('shiny-modal-wrapper')
    if (!wrapper) {
      const w = document.createElement('div')
      w.id = 'shiny-modal-wrapper'
      document.body.appendChild(w)
      w.addEventListener('hidden.bs.modal', (e) => {
        if (e.target === document.getElementById('shiny-modal')) {
          this.unbindAll(w)
          w.remove()
        }
      })
      wrapper = w
    }
    wrapper.addEventListener('keydown', this.modalKeydown)
    this.unbindAll(wrapper)
    this.insert(wrapper, html)
    // the dialog's own script (shinyui.ts's SHOW_JS), as jQuery would run it on insertion
    const el = document.getElementById('shiny-modal')
    if (el) new Modal(el).show()
    await this.bindAll(wrapper)
  }

  private removeModal(): void {
    const wrapper = document.getElementById('shiny-modal-wrapper')
    if (!wrapper) return
    wrapper.removeEventListener('keydown', this.modalKeydown)
    const bs = wrapper.querySelector<HTMLElement>('.modal')
    if (bs) {
      const modal = Modal.getOrCreateInstance(bs)
      // a dialog still opening closes once it is open
      bs.addEventListener('shown.bs.modal', () => modal.hide())
      modal.hide()
    } else {
      this.unbindAll(wrapper)
      wrapper.remove()
    }
  }

  private onCustom(custom: Record<string, Record<string, unknown>>): void {
    for (const [type, m] of Object.entries(custom)) {
      if (type === 'ce_autosave') {
        const kept = storage.save(String(m.id), String(m.name), String(m.at), String(m.json))
        this.kept = kept
        void kept.then((ok) => this.opts.onKept?.(ok))
      } else if (type === 'ce_reload') {
        // messages come in order: an autosave the reload asked for is the last one
        const id = typeof m.id === 'string' ? m.id : null
        void this.kept.then((ok) => this.opts.onReload?.({ id, save: m.save === true, kept: ok }))
      } else if (type === 'ce_restore') {
        void storage.load(String(m.id)).then((json) => this.setInputValue('ce_restore_json', { json, n: nonce() }, { priority: 'event' }))
      } else if (type === 'ce_forget') {
        void storage.forget(String(m.id)).then(() => this.sendRecents())
      } else {
        sendCustom(type, m)
      }
    }
  }

  /** $updateConditionals: each conditional panel shown or hidden by its condition. */
  private updateConditionals(): void {
    if (!this.conditionalsMaybe) return
    const inputs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(this.inputValues)) inputs[k.replace(/:.*/, '')] = v
    const scope = { input: inputs, output: Object.fromEntries(this.values) }
    const panels = elements(document, '[data-display-if]')
    if (!panels.length) this.conditionalsMaybe = false
    for (const el of panels) {
      let fn = this.conditions.get(el)
      if (!fn) {
        fn = conditionFunction(el.getAttribute('data-display-if')!)
        this.conditions.set(el, fn)
      }
      let show = false
      try {
        show = Boolean(fn(scope))
      } catch {
        continue
      }
      el.classList.toggle('shiny-conditional--shown', show)
    }
  }

  // --- files -----------------------------------------------------------------------------------------

  /** A file chosen in a file input: its bytes kept for the controller, the input set as Shiny's
   * upload ends (the server sets it), and the field cleared so the same file can be chosen again. */
  async uploadFiles(el: HTMLInputElement): Promise<void> {
    const files = Array.from(el.files ?? [])
    if (!files.length) return
    const id = FILE.getId(el)
    const infos = []
    for (const f of files) {
      const datapath = `upload/${++this.uploadCount}/${f.name}`
      this.uploads.set(datapath, new Uint8Array(await f.arrayBuffer()))
      infos.push({ name: f.name, size: f.size, type: f.type, datapath })
    }
    const text = el.closest('div.input-group')?.querySelector<HTMLInputElement>('input[type=text]')
    if (text) text.value = files.length === 1 ? files[0].name : `${files.length} files`
    this.transmit({ method: 'update', data: { [id]: infos } })
    // the upload's progress bar as shiny.js's FileUploader leaves it once the server has the file
    const progress = document.getElementById(`${id}_progress`)
    const bar = progress?.querySelector<HTMLElement>('.progress-bar')
    if (progress && bar) {
      progress.style.visibility = 'visible'
      progress.classList.remove('active')
      bar.style.width = '100%'
      bar.textContent = 'Upload complete'
    }
    el.value = ''
  }

  /** ServerOptions.readUpload */
  readUpload(datapath: string): Uint8Array {
    const data = this.uploads.get(datapath)
    if (!data) throw new Error(`[Errno 2] No such file or directory: '${datapath}'`)
    this.uploads.delete(datapath)
    return data
  }

  /** A download link's file, as the controller's download handler makes it. */
  private download(id: string): { filename: () => string, mime: string, build: () => string | Uint8Array } {
    let made: { filename: string, data: string | Uint8Array } | null = null
    return {
      filename: () => {
        made = this.session!.requestDownload(id)
        return made ? made.filename : id
      },
      mime: 'application/octet-stream',
      build: () => {
        const data = made?.data ?? ''
        made = null
        return data
      },
    }
  }

  /** The files route's answer for an address on the Report page. */
  private route(src: string): RouteAnswer {
    const q = new URLSearchParams(src.slice(src.indexOf('?') + 1))
    return (this.session?.request('report_files', q) ?? {}) as RouteAnswer
  }

  /** A blob address for a thumbnail's file (null when it is not one the web app makes yet). */
  private fileUrl(src: string): string | null {
    try {
      const a = this.route(src)
      if (!a.item?.build) return null
      const data = a.item.build()
      return URL.createObjectURL(new Blob([data as BlobPart], { type: a.item.media_type }))
    } catch {
      return null
    }
  }

  /** The Report page's links go to its files address: the page answers them itself. */
  private interceptLinks(): void {
    document.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!(a instanceof HTMLAnchorElement)) return
      const href = a.getAttribute('href')!
      const thumb = this.thumbQueries.get(href)
      if (!href.startsWith(this.opts.filesUrl) && thumb === undefined) return
      const answer = this.route(thumb ?? href)
      if (answer.failed) {
        e.preventDefault()
        notify(answer.failed, { type: 'error', seconds: 8 })
        return
      }
      const item = answer.item
      if (!item) {
        e.preventDefault()
        notify('This download is not in the web app yet.', { seconds: 4 })
        return
      }
      // a small file is built at once; any other is made from the project, off the page's thread
      const job = item.job
      const build = item.build ?? ((): Promise<Uint8Array> => this.files.make({
        project: answer.project!, f: job!.f, fmt: job!.fmt, today: answer.today!, now: Date.now(),
      }))
      follow(a, e, href, { filename: item.filename, mime: item.media_type, build, inline: answer.inline })
    })
  }
}
