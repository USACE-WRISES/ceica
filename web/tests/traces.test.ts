// The controller core (src/app/session.ts, reactive.ts and server.ts) against app.py's real server:
// each trace (web/parity/make_traces.py) is a scenario's client messages and every message the
// Python server sent after each. Replayed here through the TypeScript, the messages must come out
// the same, in the same order: the dialogs (whole), the notifications, the custom messages, and each
// flush's outputs (their markup by digest), page switches and errors.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { Clock } from '../src/app/reactive'
import { ceicaServer } from '../src/app/server'
import { type ClientMessage, type ServerMessage, Session } from '../src/app/session'
import { setProjectIds } from '../src/engine/model'
import { describe as describeFile } from '../src/files/describe'
import { FILES } from '../src/views/examples'
import { digest } from './helpers'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const TRACES = join(REPO, 'web', 'tests', 'fixtures', 'traces')

// make_traces.py's clock: time.monotonic() starts at T0, datetime.now() at START, the day is TODAY
const T0 = 1000
const START = new Date(2026, 9, 18, 9, 30, 0)
const TODAY = new Date(2026, 9, 18)
const FILES_URL = 'session/S/dynamic_route/report_files?nonce=N'

interface Step {
  step: string
  client: ClientMessage | { tick: number } | { download: string } | { reload: boolean }
  server: unknown[]
  file?: { disposition: string, text?: string, describe?: unknown }
}

/** The scenario's clock: the autosave effect's one-second timer fires on a tick step only. */
class FakeClock implements Clock {
  t = T0
  private timers: { fire: () => void }[] = []

  monotonic(): number {
    return this.t
  }

  now(): Date {
    return new Date(START.getTime() + (this.t - T0) * 1000)
  }

  later(_seconds: number, fire: () => void): () => void {
    const timer = { fire }
    this.timers.push(timer)
    return () => {
      const i = this.timers.indexOf(timer)
      if (i >= 0) this.timers.splice(i, 1)
    }
  }

  tick(): void {
    this.t += 1
    const due = this.timers
    this.timers = []
    for (const timer of due) timer.fire()
  }

  clear(): void {
    this.timers = []
  }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") on the scenario's clock. */
const savedAt = (d: Date): string =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}Z`

/** A message as make_traces.normalize keeps it. */
function normalize(msg: ServerMessage): unknown {
  if ('values' in msg) {
    const values = Object.fromEntries(Object.entries(msg.values as Record<string, unknown>).map(([k, v]) =>
      [k, v === null ? null : typeof v === 'object' ? digest((v as { html: string }).html) : v]))
    return { values, inputMessages: msg.inputMessages, errors: msg.errors }
  }
  if ('notification' in msg) {
    const n = msg.notification as { type: string, message?: Record<string, unknown> }
    if (n.type === 'show' && /^[0-9a-f]{16}$/.test(String(n.message!.id))) return { notification: { ...n, message: { ...n.message, id: 'random' } } }
    return msg
  }
  if ('custom' in msg) {
    const c = msg.custom as Record<string, Record<string, unknown>>
    if ('ce_autosave' in c) return { custom: { ce_autosave: { ...c.ce_autosave, json: digest(c.ce_autosave.json as string) } } }
  }
  return msg
}

function newSession(clock: FakeClock): Session {
  return new Session(clock, ceicaServer({
    today: () => TODAY,
    filesUrl: FILES_URL,
    readUpload: (datapath) => new Uint8Array(readFileSync(join(REPO, datapath.replace(/^repo:/, '')))),
    exampleText: (name) => FILES[name] ?? null,
    savedAt: () => savedAt(clock.now()),
  }))
}

const show = (x: unknown): string => JSON.stringify(x, null, 1)

afterAll(() => setProjectIds(null))

describe('server traces', () => {
  const names = readdirSync(TRACES).filter((f) => f.endsWith('.json')).sort()
  it('has the scenarios', () => {
    expect(names.length).toBeGreaterThanOrEqual(10)
  })
  for (const file of names) {
    it(file.replace(/\.json$/, ''), () => {
      const { trace } = JSON.parse(readFileSync(join(TRACES, file), 'utf-8')) as { trace: Step[] }
      let ids = 0
      setProjectIds(() => (++ids).toString(16).padStart(32, '0'))
      const clock = new FakeClock()
      let session = newSession(clock)
      trace.forEach((step, i) => {
        const c = step.client
        let got: ServerMessage[]
        const start = session.sentCount
        if ('tick' in c) {
          clock.tick()
          got = session.sentSince(start)
        } else if ('download' in c) {
          const f = session.requestDownload(c.download)
          got = session.sentSince(start)
          // text as it is; a workbook part by part (describe.py)
          const content = f && (typeof f.data === 'string' ? { text: f.data } : { describe: describeFile(f.data) })
          expect(f && { disposition: f.disposition, ...content }, `step ${i} (${step.step}): the file`).toEqual(step.file)
        } else if ('reload' in c) {
          session.close()
          clock.clear()
          session = newSession(clock)
          got = []
        } else {
          got = session.receive(c)
        }
        // (as make_traces.normalize, the binding progress messages are left out)
        const kept = got.filter((m) => !('progress' in m))
        expect(show(kept.map(normalize)), `step ${i} (${step.step}): ${show(c).slice(0, 300)}`).toBe(show(step.server))
      })
      session.close()
    })
  }
})
