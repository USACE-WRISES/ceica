// py-shiny's reactive core (shiny/reactive/_core.py and _reactives.py, py-shiny 1.6.3), as the page's
// controller needs it: contexts, values, calcs, effects, event, isolate, invalidate_later and the
// flush.
//
// It runs synchronously: nothing in CEICA's server awaits anything but sending a message, which here
// only queues it. The order of everything is py-shiny's: a context's dependents are invalidated in
// the order the contexts were made, pending effects run by priority and then in the order they were
// queued, and an effect made suspended waits until it is resumed.
//
// A value invalidates its dependents unless the new value *is* the old one (Value._set's identity
// test). JavaScript cannot see Python's object identity, so each set says where its value came
// from: a Python literal (an interned constant: the same object as the same literal elsewhere) or a
// fresh object (built at run time, such as a string read from the browser's JSON). A fresh value is
// still the same object where CPython caches it: None, True and False, small ints, and the empty and
// one-character strings. The server traces (web/parity/make_traces.py) check every set app.py makes.

/** What stops a reactive function without an error (a missing input, req(False)). */
export class SilentException extends Error {}

let nextId = 0

export class Context {
  readonly id = nextId++
  private invalidated = false
  private invalidateCallbacks: (() => void)[] = []
  private flushCallbacks: (() => void)[] = []

  invalidate(): void {
    if (this.invalidated) return
    this.invalidated = true
    const cbs = this.invalidateCallbacks
    this.invalidateCallbacks = []
    for (const cb of cbs) cb()
  }

  onInvalidate(fn: () => void): void {
    if (this.invalidated) fn()
    else this.invalidateCallbacks.push(fn)
  }

  addPendingFlush(priority: number): void {
    env.addPendingFlush(this, priority)
  }

  onFlush(fn: () => void): void {
    this.flushCallbacks.push(fn)
  }

  executeFlushCallbacks(): void {
    const cbs = this.flushCallbacks
    this.flushCallbacks = []
    for (const cb of cbs) cb()
  }
}

class Dependents {
  private deps = new Map<number, Context>()

  register(): void {
    const ctx = env.current()
    if (this.deps.has(ctx.id)) return
    this.deps.set(ctx.id, ctx)
    ctx.onInvalidate(() => this.deps.delete(ctx.id))
  }

  invalidate(): void {
    const ids = [...this.deps.keys()].sort((a, b) => a - b)
    for (const ctx of ids.map((id) => this.deps.get(id)!)) ctx.invalidate()
  }
}

/** The environment: the current context, the pending flushes and the flushed callbacks. */
class Environment {
  private stack: (Context | null)[] = [null]
  private queue: { priority: number, n: number, ctx: Context }[] = []
  private counter = 0
  private flushed: (() => void)[] = []

  current(): Context {
    const ctx = this.stack[this.stack.length - 1]
    if (ctx === null) throw new Error('No current reactive context')
    return ctx
  }

  hasContext(): boolean {
    return this.stack[this.stack.length - 1] !== null
  }

  use<T>(ctx: Context | null, fn: () => T): T {
    this.stack.push(ctx)
    try {
      return fn()
    } finally {
      this.stack.pop()
    }
  }

  addPendingFlush(ctx: Context, priority: number): void {
    this.queue.push({ priority, n: ++this.counter, ctx })
  }

  /** The next pending context: the highest priority, the first queued. */
  private next(): Context | null {
    if (!this.queue.length) return null
    let best = 0
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]
      const b = this.queue[best]
      if (a.priority > b.priority || (a.priority === b.priority && a.n < b.n)) best = i
    }
    return this.queue.splice(best, 1)[0].ctx
  }

  onFlushed(fn: () => void): () => void {
    this.flushed.push(fn)
    return () => {
      const i = this.flushed.indexOf(fn)
      if (i >= 0) this.flushed.splice(i, 1)
    }
  }

  flush(): void {
    for (let ctx = this.next(); ctx !== null; ctx = this.next()) ctx.executeFlushCallbacks()
    for (const fn of [...this.flushed]) fn()
  }
}

const env = new Environment()

/** Run ``fn`` reading values without depending on them (``with isolate():``). */
export function isolate<T>(fn: () => T): T {
  return env.use(new Context(), fn)
}

/** reactive.flush(): run every pending effect, then the flushed callbacks (the session's flush). */
export const flush = (): void => env.flush()

export const onFlushed = (fn: () => void): (() => void) => env.onFlushed(fn)

/** Where a value set comes from (see the module's note): a Python literal, a fresh object, or a fresh
 * float (CPython caches no float, so it is never the object already there). */
export type Origin = 'literal' | 'fresh' | 'float'

const MISSING = Symbol('missing')

/** Whether CPython hands back the cached object for a fresh value: None, booleans, small ints, the
 * empty string and the one-character Latin-1 strings. */
function cached(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isInteger(v) && v >= -5 && v <= 256
  if (typeof v === 'string') return v.length === 0 || (v.length === 1 && v.charCodeAt(0) < 256)
  return false
}

export class Value<T> {
  private value: T | typeof MISSING
  private origin: Origin
  private readonly valueDependents = new Dependents()
  private readonly isSetDependents = new Dependents()

  constructor(value: T | typeof MISSING = MISSING, origin: Origin = 'literal') {
    this.value = value
    this.origin = origin
  }

  static missing<T>(): Value<T> {
    return new Value<T>(MISSING)
  }

  get(): T {
    this.valueDependents.register()
    if (this.value === MISSING) throw new SilentException()
    return this.value
  }

  /** A read outside any reactive context (app.py reads values in helpers called from effects). */
  peek(): T | undefined {
    return this.value === MISSING ? undefined : this.value
  }

  isSet(): boolean {
    this.isSetDependents.register()
    return this.value !== MISSING
  }

  /** Python's ``self._value is value``. */
  private same(value: T, origin: Origin): boolean {
    const old = this.value
    if (old === MISSING) return false
    if (typeof value === 'object' && value !== null) return old === value
    if (old !== value) return false
    if (origin === 'float' || this.origin === 'float') return false
    if (cached(value)) return true
    return origin === 'literal' && this.origin === 'literal'
  }

  /** value.set(v): invalidates unless the new value is the old one; returns whether it changed. */
  set(value: T, origin: Origin = 'fresh', { force = false } = {}): boolean {
    if (!force && this.same(value, origin)) return false
    if (this.value === MISSING) this.isSetDependents.invalidate()
    this.value = value
    this.origin = origin
    this.valueDependents.invalidate()
    return true
  }
}

export class Calc<T> {
  private dependents = new Dependents()
  private invalidated = true
  private running = false
  private ctx: Context | null = null
  private result: { value: T } | { error: unknown } | null = null

  constructor(private readonly fn: () => T) {}

  get(): T {
    this.dependents.register()
    if (this.invalidated || this.running) this.update()
    const r = this.result!
    if ('error' in r) throw r.error
    return r.value
  }

  private update(): void {
    const ctx = new Context()
    this.ctx = ctx
    ctx.onInvalidate(() => {
      this.invalidated = true
      this.result = null
      this.dependents.invalidate()
      this.ctx = null
    })
    this.invalidated = false
    const wasRunning = this.running
    this.running = true
    try {
      env.use(ctx, () => {
        try {
          this.result = { value: this.fn() }
        } catch (err) {
          this.result = { error: err }
        }
      })
    } finally {
      this.running = wasRunning
    }
  }
}

export class Effect {
  private suspended: boolean
  private onResume: () => void = () => {}
  private invalidateCallbacks: (() => void)[] = []
  private destroyed = false
  private ctx: Context | null = null

  private readonly priority: number
  private readonly onError: ((err: unknown) => void) | null

  constructor(private readonly fn: () => void, { suspended = false, priority = 0, onError = null as ((err: unknown) => void) | null } = {}) {
    this.suspended = suspended
    this.priority = priority
    this.onError = onError
    // the first run waits for the flush
    this.createContext().invalidate()
  }

  private createContext(): Context {
    const ctx = new Context()
    this.ctx = ctx
    ctx.onInvalidate(() => {
      this.ctx = null
      for (const cb of this.invalidateCallbacks) cb()
      if (this.destroyed) return
      const go = () => ctx.addPendingFlush(this.priority)
      if (this.suspended) this.onResume = go
      else go()
    })
    ctx.onFlush(() => {
      if (!this.destroyed) this.run()
    })
    return ctx
  }

  private run(): void {
    const ctx = this.createContext()
    try {
      env.use(ctx, () => this.fn())
    } catch (err) {
      if (err instanceof SilentException) return
      if (this.onError) this.onError(err)
      else throw err
    }
  }

  onInvalidate(cb: () => void): void {
    this.invalidateCallbacks.push(cb)
  }

  destroy(): void {
    this.destroyed = true
    if (this.ctx !== null) this.ctx.invalidate()
  }

  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    if (this.suspended) {
      this.suspended = false
      const go = this.onResume
      this.onResume = () => {}
      go()
    }
  }
}

/** A Python None or ActionButtonValue 0: what @reactive.event ignores by default. */
export interface ActionButton { readonly action: number }
const isNoneEvent = (v: unknown): boolean => v === null || v === undefined
  || (typeof v === 'object' && v !== null && 'action' in v && (v as ActionButton).action === 0)

/** @reactive.event(*sources): ``fn`` runs (isolated) only when a source changes, and not when every
 * source is None or an action button at 0 (ignore_none). */
export function event<T>(sources: (() => unknown)[], fn: () => T, { ignoreNone = true, ignoreInit = false } = {}): () => T {
  let initialized = false
  return () => {
    const vals = sources.map((s) => s())
    if (ignoreInit && !initialized) {
      initialized = true
      throw new SilentException()
    }
    if (ignoreNone && vals.every(isNoneEvent)) throw new SilentException()
    return isolate(fn)
  }
}

/** A clock and timers the controller runs on: the page's, or a test's. */
export interface Clock {
  /** time.monotonic(), in seconds */
  monotonic(): number
  /** datetime.now() */
  now(): Date
  /** reactive.invalidate_later(seconds): call ``fire`` then, unless canceled */
  later(seconds: number, fire: () => void): () => void
}

/** reactive.invalidate_later(seconds): the current context is invalidated after ``seconds`` and the
 * environment flushed. */
export function invalidateLater(clock: Clock, seconds: number): void {
  const ctx = env.current()
  let cancellable = true
  const cancel = clock.later(seconds, () => {
    cancellable = false
    ctx.invalidate()
    flush()
  })
  ctx.onInvalidate(() => {
    if (cancellable) cancel()
  })
}
