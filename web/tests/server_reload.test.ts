// The web app's reload for an update (server.ts's ce_reload effect, not in app.py): the controller says
// whether a project is open, and when the page is about to reload it saves the project first, past
// autosave's quiet period (ce_autosave, then ce_reload, in that order).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe as group, expect, it } from 'vitest'
import type { Clock } from '../src/app/reactive'
import { ceicaServer } from '../src/app/server'
import { type ClientMessage, type ServerMessage, Session } from '../src/app/session'
import { setProjectIds } from '../src/engine/model'
import { FILES } from '../src/views/examples'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const clock: Clock = { monotonic: () => 1000, now: () => new Date(2026, 9, 18, 9, 30, 0), later: () => () => {} }

function session(): Session {
  return new Session(clock, ceicaServer({
    today: () => new Date(2026, 9, 18), filesUrl: 'files?nonce=1', readUpload: () => new Uint8Array(0),
    exampleText: (name) => FILES[name] ?? null,
  }))
}

/** The custom messages sent, in order: [type, message]. */
function customs(sent: ServerMessage[]): [string, Record<string, unknown>][] {
  return sent.flatMap((m) => ('custom' in m ? Object.entries(m.custom as Record<string, Record<string, unknown>>) : []))
}

/** example_edit's first steps: connect, then the Utoy example opened (index 3: the example event). */
const steps = (JSON.parse(readFileSync(join(REPO, 'web', 'tests', 'fixtures', 'traces', 'example_edit.json'), 'utf-8')) as
  { trace: { client: ClientMessage }[] }).trace.map((s) => s.client)

afterAll(() => setProjectIds(null))

group('the reload for an update', () => {
  it('says no project is open at the start, and saves nothing', () => {
    const s = session()
    for (const c of steps.slice(0, 3)) s.receive(c)
    const got = customs(s.receive({ method: 'update', data: { ce_reload: { save: true, n: 1 } } } as ClientMessage))
    expect(got).toEqual([['ce_reload', { id: null, save: true }]])
    s.close()
  })

  it('saves the open project first when the page is about to reload', () => {
    let ids = 0
    setProjectIds(() => (++ids).toString(16).padStart(32, '0'))
    const s = session()
    for (const c of steps.slice(0, 4)) s.receive(c)
    const asked = customs(s.receive({ method: 'update', data: { ce_reload: { save: false, n: 1 } } } as ClientMessage))
    expect(asked.map(([t]) => t)).toEqual(['ce_reload'])
    const id = asked[0][1].id
    expect(typeof id).toBe('string')
    const saved = customs(s.receive({ method: 'update', data: { ce_reload: { save: true, n: 2 } } } as ClientMessage))
    expect(saved.map(([t]) => t)).toEqual(['ce_autosave', 'ce_reload'])
    expect(saved[0][1].id).toBe(id)
    expect(saved[1][1]).toEqual({ id, save: true })
    s.close()
  })
})
