// @vitest-environment happy-dom
// The page's wiring, in a DOM without layout: the skeleton, page/boot.js's stand-ins, the real
// www/ceica.js (its page/ copy), the controller and client.ts. Clicks go through ceica.js's
// listeners to the controller and back: the start page draws, a gallery pick redraws it, an example
// opens, a page switch shows its page, and an edit commits. The server's messages themselves are
// held to app.py's by the traces (traces.test.ts); focus, paste and timing are checked in a browser
// (parity/capture.py).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { Client } from '../src/app/client'
import type { Clock } from '../src/app/reactive'
import { ceicaServer } from '../src/app/server'
import { Session } from '../src/app/session'
import { pageBody } from '../src/app/ui'
import { FILES } from '../src/views/examples'

// (happy-dom puts its own URL in the global scope: the path is worked out from the string)
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES_URL = 'files?nonce=1'

/** Runs a page script as the browser runs a classic one. */
function runScript(name: string): void {
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(join(WEB, 'page', name), 'utf-8'))
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits until ``ok`` holds (the controller answers two tasks later, then the queue draws). */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return
    await pause(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const html = (id: string): string => document.getElementById(id)?.innerHTML ?? ''

/** A click as a person makes it (the client holds the queue between pointerdown and click). */
function click(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true }))
  ;(el as HTMLElement).click()
}

describe('the page wiring', () => {
  beforeAll(async () => {
    document.documentElement.innerHTML = '<head><title>CEICA</title></head>' + pageBody('1').render(0)
    runScript('boot.js')
    runScript('ceica.js')
    delete (window as unknown as { jQuery?: unknown }).jQuery
    const clock: Clock = {
      monotonic: () => performance.now() / 1000,
      now: () => new Date(),
      later: (seconds, fire) => {
        const t = setTimeout(fire, seconds * 1000)
        return () => clearTimeout(t)
      },
    }
    const client = new Client({ filesUrl: FILES_URL })
    const session = new Session(clock, ceicaServer({
      today: () => new Date(), filesUrl: FILES_URL, readUpload: (p) => client.readUpload(p), exampleText: (n) => FILES[n] ?? null,
    }))
    await client.start(session)
  })

  it('registers ceica.js through the stand-ins, then leaves no jQuery', () => {
    const boot = (window as unknown as { ceicaBoot: { handlers: Record<string, unknown>, listeners: Record<string, unknown[]> } }).ceicaBoot
    expect(Object.keys(boot.handlers)).toEqual(expect.arrayContaining(['ce_title', 'ce_scroll_to', 'ce_focus', 'ce_cell_error']))
    expect(boot.listeners['shiny:value']?.length).toBe(2)
    expect((window as unknown as { jQuery?: unknown }).jQuery).toBeUndefined()
  })

  it('binds the skeleton as shiny.js does', () => {
    expect(document.getElementById('page')!.classList.contains('shiny-bound-input')).toBe(true)
    expect(document.getElementById('project_name')!.classList.contains('shiny-bound-output')).toBe(true)
    expect(document.getElementById('project_name')!.getAttribute('aria-live')).toBe('polite')
  })

  it('shows the start page at connect', async () => {
    await until(() => html('start_body').includes('ce-start'), 'the start page')
    expect(document.getElementById('shiny-modal')).not.toBeNull()
    await until(() => !document.getElementById('save_project')!.classList.contains('disabled'), 'the Save link enabled')
    expect(document.getElementById('save_project')!.getAttribute('href')).toBe('session/S/download/save_project?w=')
  })

  it('redraws the start page for a gallery view', async () => {
    const tile = document.querySelector('[data-ev="start_view"][data-view="examples"]')!
    click(tile)
    await until(() => html('start_body').includes('ce-ex-grid'), 'the gallery')
  })

  it('opens an example: dialog closed, title, notification, Sites page', async () => {
    click(document.querySelector('[data-ev="example"][data-name="utoy-creek"]')!)
    await until(() => document.title === 'Utoy Creek Section 206 - CEICA', 'the title')
    await until(() => !document.getElementById('shiny-modal-wrapper'), 'the dialog closed')
    expect(document.querySelector('.shiny-notification-content-text')?.textContent).toBe('Opened Utoy Creek Section 206 (example).')
    await until(() => html('page_sites').includes('Site-by-site analysis'), 'the Sites page')
  })

  it('switches pages through the hidden navset', async () => {
    click(document.querySelector('[data-ev="nav"][data-page="watershed"]')!)
    await until(() => document.querySelector('.tab-pane.active')?.getAttribute('data-value') === 'watershed', 'the Watershed pane')
    await until(() => html('page_watershed').includes('Watershed-scale analysis'), 'the Watershed page')
    expect(document.getElementById('page')!.getAttribute('aria-live')).toBe('polite')
  })

  it('commits a cell edit and offers Undo', async () => {
    click(document.querySelector('[data-ev="nav"][data-page="inputs"][data-section="costs"]')!)
    const path = 'c|17F2M|Alternative1|first|construction'
    const cell = (): HTMLInputElement | undefined =>
      Array.from(document.querySelectorAll<HTMLInputElement>('.ce-cell')).find((c) => c.getAttribute('data-path') === path)
    await until(() => cell() !== undefined, 'the Costs grid')
    expect(cell()!.classList.contains('shiny-bound-input')).toBe(true)
    cell()!.value = '800000'
    cell()!.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => document.querySelector('[data-ev="undo"]:not([disabled])') !== null, 'Undo')
    expect(cell()!.value).toBe('800000')
  })
})
