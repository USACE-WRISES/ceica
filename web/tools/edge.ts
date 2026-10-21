// Headless Edge driven through the DevTools protocol, for tools/offline.ts: a new profile each time,
// the page and the browser reached over their own sockets (Node's WebSocket), every download saved
// into a folder. Ported from the Python parity tools' Edge (capture.py), which was adapted from STAF's
// static app; the page scripts below are theirs.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** The browser: Edge where Windows installs it (CEICA_EDGE names another). */
export const EDGE = process.env.CEICA_EDGE
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const WIDTH = 1440
export const HEIGHT = 900

/** How long the page must stay unchanged to count as idle. */
const QUIET_MS = 700

/** An element and its descendants with their attributes in name order. */
export const SORT_ATTRS_JS = `const sortAttrs = (root) => {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const attrs = [...el.attributes].map((a) => [a.name, a.value])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [n] of attrs) el.removeAttribute(n);
    for (const [n, v] of attrs) el.setAttribute(n, v);
  }
};`

/** From the start of each document: every change to the page timed, and every notification logged
 * as it last stood (its markup, attributes in name order), however briefly it showed. */
export const WATCH_JS = `(() => {
  ${SORT_ATTRS_JS}
  window.__ceicaChanged = performance.now();
  const log = window.__ceicaNoteLog = [];
  const at = new WeakMap();
  new MutationObserver(() => {
    window.__ceicaChanged = performance.now();
    for (const n of document.querySelectorAll('.shiny-notification')) {
      if (!n.querySelector('.shiny-notification-content-text')) continue;
      if (!at.has(n)) {
        at.set(n, log.length);
        log.push('');
      }
      const c = n.cloneNode(true);
      c.removeAttribute('style');
      sortAttrs(c);
      log[at.get(n)] = c.outerHTML;
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`

/** The page idle: drawn (its first answer in), not busy, and unchanged for a while (an output never
 * drawn stays marked recalculating: only the busy page and the page's changes count). */
export const IDLE_JS = `(() => {
  const html = document.documentElement;
  if (!document.body || html.classList.contains('shiny-busy')) return false;
  // connected: the server's first answer drawn
  if (!document.querySelector('#project_name > *')) return false;
  return performance.now() - (window.__ceicaChanged || 0) > ${QUIET_MS};
})()`

/** An element's center on the screen, once scrolled into view (null when there is none). */
export const WHERE_JS = `((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
})`

const KEYS: Record<string, [string, number, string]> = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9, ''], Escape: ['Escape', 27, ''],
}
const MODS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** A port no one listens on. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** Any browser process still running on this profile, stopped (a headless Edge can outlive the
 * process that launched it, and a later run would then reach it on its port). */
function stopProfile(prof: string): void {
  const script = 'Get-CimInstance Win32_Process -Filter "Name = \'msedge.exe\'" | '
    + `Where-Object { $_.CommandLine -like '*${basename(prof)}*' } | `
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
}

/** A message from the protocol: a command's answer (id) or an event (method). */
export interface Message {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface Waiting {
  method: string
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
}

/** One connection to the protocol: commands answered by their id, events handed to listeners. */
class Socket {
  private readonly ws: WebSocket
  private n = 0
  private readonly waiting = new Map<number, Waiting>()
  private readonly listeners = new Set<(msg: Message) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as Message
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id)
        if (!w) return
        this.waiting.delete(msg.id)
        if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else w.resolve(msg.result ?? {})
      } else {
        for (const fn of this.listeners) fn(msg)
      }
    })
    ws.addEventListener('close', () => {
      for (const [, w] of this.waiting) w.reject(new Error(`${w.method}: the browser closed`))
      this.waiting.clear()
    })
  }

  static open(url: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Socket(ws)), { once: true })
      ws.addEventListener('error', () => reject(new Error(`could not reach ${url}`)), { once: true })
    })
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.n
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { method, resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Every event from now on handed to fn; the function returned stops it. */
  on(fn: (msg: Message) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close(): void {
    this.ws.close()
  }
}

async function json(url: string): Promise<unknown> {
  return (await fetch(url)).json()
}

/** A headless Edge on a new profile: call sends a command to the page, js runs an expression in it
 * (awaiting a promise), and the browser's own commands go through browserCall. */
export class Edge {
  private readonly prof: string
  private readonly proc: ChildProcess
  private readonly browser: Socket
  private readonly page: Socket

  private constructor(prof: string, proc: ChildProcess, browser: Socket, page: Socket) {
    this.prof = prof
    this.proc = proc
    this.browser = browser
    this.page = page
  }

  static async open({ width = WIDTH, height = HEIGHT, downloads }: {
    width?: number, height?: number, downloads?: string } = {}): Promise<Edge> {
    const prof = mkdtempSync(join(tmpdir(), 'ceica-capture-'))
    const port = await freePort()
    const proc = spawn(EDGE, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
      `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check',
      'about:blank'], { stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    let pages: { type?: string, webSocketDebuggerUrl?: string }[] = []
    for (let i = 0; i < 100 && pages.length === 0; i++) {
      try {
        pages = ((await json(`${base}/json`)) as typeof pages).filter((t) => t.type === 'page')
      } catch {
        // not listening yet
      }
      if (pages.length === 0) await sleep(200)
    }
    if (pages.length === 0) {
      proc.kill()
      stopProfile(prof)
      throw new Error(`Edge did not start (${EDGE})`)
    }
    const version = (await json(`${base}/json/version`)) as { webSocketDebuggerUrl: string }
    const browser = await Socket.open(version.webSocketDebuggerUrl)
    const page = await Socket.open(pages[0].webSocketDebuggerUrl as string)
    const edge = new Edge(prof, proc, browser, page)
    if (downloads !== undefined) {
      // every download of the browser (a link's own tab too) saved into the folder
      await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    }
    await edge.resize(width, height)
    await edge.call('Page.enable')
    return edge
  }

  async close(): Promise<void> {
    try {
      // closed through the protocol: the process started may only have launched it
      void this.browser.send('Browser.close').catch(() => undefined)
      await sleep(200)
      this.page.close()
      this.browser.close()
    } catch {
      // the browser may be gone already
    }
    if (this.proc.exitCode === null) {
      this.proc.kill()
      const exited = new Promise((resolve) => this.proc.once('exit', resolve))
      await Promise.race([exited, sleep(10_000)])
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL')
    }
    stopProfile(this.prof)
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.prof, { recursive: true, force: true })
        break
      } catch {
        await sleep(500)  // a file the browser was still holding
      }
    }
  }

  /** A command to the page. */
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.page.send(method, params)
  }

  /** A command to the browser. */
  browserCall(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.browser.send(method, params)
  }

  /** The page's events from now on (call the function returned to stop). */
  on(fn: (msg: Message) => void): () => void {
    return this.page.on(fn)
  }

  /** An expression's value in the page (a promise awaited); a script that throws fails. */
  async js<T = unknown>(expr: string): Promise<T> {
    const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails as { text?: string, exception?: { description?: string } }
      throw new Error(`page script failed: ${d.exception?.description ?? d.text}`)
    }
    return ((r.result as { value?: unknown } | undefined)?.value) as T
  }

  async resize(width: number, height: number): Promise<void> {
    await this.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  }

  async mouse(type: string, x: number, y: number): Promise<void> {
    await this.call('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'mouse',
    })
  }

  async press(name: string, mods: string[] = []): Promise<void> {
    const [code, vk, text] = KEYS[name]
    const modifiers = mods.reduce((sum, m) => sum + MODS[m], 0)
    const keys = { key: name, code, windowsVirtualKeyCode: vk, modifiers }
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', ...keys, ...(text && !modifiers ? { text } : {}) })
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...keys })
  }

  /** A file input given these files, as a person picks them in its dialog. */
  async setFiles(selector: string, paths: string[]): Promise<void> {
    const doc = await this.call('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } }
    const node = await this.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector }) as { nodeId: number }
    await this.call('DOM.setFileInputFiles', { files: paths, nodeId: node.nodeId })
  }
}
