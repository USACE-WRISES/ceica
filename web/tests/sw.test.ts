// The two service workers run against stand-ins for the browser (a scope, Cache Storage, the network):
// the offline worker (sw/app-sw.js as appWorker.ts writes it) installs every file of its build, each
// asked for by its content and checked, takes over and keeps the build before, routes the app's
// requests, and never touches another app's caches; the download worker (page/download-sw.js) asks only
// CEICA's own pages, so another app's open page never holds a download up.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe as group, expect, it } from 'vitest'
import { TEMPLATE, workerScript } from '../appWorker'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const SCOPE = 'https://site.test/ceica/'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

interface Kept { bytes: Uint8Array, headers: [string, string][] }
type Req = string | { url: string, method?: string, mode?: string }
const urlOf = (r: Req): string => (typeof r === 'string' ? r : r.url)

class FakeCache {
  readonly entries = new Map<string, Kept>()
  async put(req: Req, res: Response): Promise<void> {
    this.entries.set(urlOf(req), { bytes: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] })
  }
  async match(req: Req, opts: { ignoreSearch?: boolean } = {}): Promise<Response | undefined> {
    const key = (u: string): string => (opts.ignoreSearch ? u.split('?')[0] : u)
    for (const [k, v] of this.entries) if (key(k) === key(urlOf(req))) return new Response(v.bytes as BodyInit, { headers: v.headers })
    return undefined
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>()
  async open(name: string): Promise<FakeCache> {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache())
    return this.stores.get(name)!
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()]
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name)
  }
  async match(req: Req, opts: { cacheName?: string, ignoreSearch?: boolean } = {}): Promise<Response | undefined> {
    if (opts.cacheName === undefined) throw new Error('the worker must name its cache: the origin is shared')
    return this.stores.get(opts.cacheName)?.match(req, opts)
  }
  async text(cache: string, key: string): Promise<string | null> {
    const r = await this.stores.get(cache)?.match(key)
    return r ? r.text() : null
  }
}

type Listener = (event: Record<string, unknown>) => void

/** A worker script run against the stand-ins; its listeners and what it called. */
function run(script: string, caches: FakeCaches, net: (url: string, mode: string) => string | null,
  windows: { url: string, postMessage: (msg: unknown, ports: MessagePort[]) => void }[] = [], scope = SCOPE) {
  const listeners = new Map<string, Listener>()
  const calls = { skipWaiting: 0, claim: 0, fetched: [] as string[] }
  const self = {
    registration: { scope },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: async () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++, matchAll: async () => windows },
  }
  const fetcher = async (req: Request | Req): Promise<Response> => {
    const url = urlOf(req as Req)
    const mode = req instanceof Request ? req.cache : 'default'
    calls.fetched.push(`${url} ${mode}`)
    const body = net(url, mode)
    return body === null ? new Response('missing', { status: 404 }) : new Response(body)
  }
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', script)(self, caches, fetcher)
  return { listeners, calls }
}

/** An event fired at a listener: what it waited for, and what it answered. */
async function fire(listener: Listener, extra: Record<string, unknown> = {}): Promise<Response | null> {
  let waited: Promise<unknown> | null = null
  let answered: Promise<Response> | null = null
  listener({ ...extra, waitUntil: (p: Promise<unknown>) => { waited = p }, respondWith: (p: Promise<Response>) => { answered = Promise.resolve(p) } })
  if (waited) await waited
  return answered ? await answered : null
}

const BODIES: Record<string, string> = { 'index.html': '<html>B', 'assets/app-b.js': 'js b', 'fonts/f.woff2': 'font' }
const FILES = Object.entries(BODIES).map(([f, body]) => [f, sha(body)] as [string, string])
const script = (): string => workerScript(readFileSync(TEMPLATE, 'utf-8'), 'b', FILES)
/** the site: each file by its address (its ?v= aside) */
const site = (bodies: Record<string, string>) => (url: string): string | null => bodies[url.replace(SCOPE, '').split('?')[0]] ?? null

group('the offline worker', () => {
  it('installs every file of its build, asked for by its content, then takes over', async () => {
    const caches = new FakeCaches()
    const w = run(script(), caches, site(BODIES))
    await fire(w.listeners.get('install')!)
    expect(w.calls.fetched).toEqual(expect.arrayContaining([
      `${SCOPE}index.html?v=${sha('<html>B').slice(0, 10)} default`, `${SCOPE}assets/app-b.js default`,
      `${SCOPE}fonts/f.woff2?v=${sha('font').slice(0, 10)} default`]))
    expect([...caches.stores.get('ceica-app-b')!.entries.keys()].sort()).toEqual(Object.keys(BODIES).map((f) => SCOPE + f).sort())
    expect(w.calls.skipWaiting).toBe(1)
  })

  it('asks again past the HTTP cache for a file that is not its own, and fails rather than keep it', async () => {
    const staleOnce = (url: string, mode: string): string | null =>
      url.includes('index.html') && mode === 'default' ? '<html>A' : site(BODIES)(url)
    const ok = run(script(), new FakeCaches(), staleOnce)
    await fire(ok.listeners.get('install')!)
    expect(ok.calls.fetched.filter((f) => f.includes('index.html')).map((f) => f.split(' ')[1])).toEqual(['default', 'reload'])
    const stale = run(script(), new FakeCaches(), site({ ...BODIES, 'index.html': '<html>A' }))
    await expect(fire(stale.listeners.get('install')!)).rejects.toThrow(/not this build's file/)
    expect(stale.calls.skipWaiting).toBe(0)
  })

  it("keeps the build before for the pages still on it, drops older ones, never touches another app's caches", async () => {
    const caches = new FakeCaches()
    for (const name of ['ceica-app-a', 'ceica-app-z', 'staf-app-1', 'staf-meta-1']) await caches.open(name)
    await (await caches.open('ceica-meta-1')).put('running', new Response('ceica-app-a'))
    const w = run(script(), caches, site(BODIES))
    await fire(w.listeners.get('activate')!)
    expect((await caches.keys()).sort()).toEqual(['ceica-app-a', 'ceica-meta-1', 'staf-app-1', 'staf-meta-1'])
    expect(await caches.text('ceica-meta-1', 'running')).toBe('ceica-app-b')
    expect(await caches.text('ceica-meta-1', 'previous')).toBe('ceica-app-a')
    expect(w.calls.claim).toBe(1)
  })

  it("answers the app's page and files from its copy, the build before's files from that one, the rest from the site", async () => {
    const caches = new FakeCaches()
    const w = run(script(), caches, site({ ...BODIES, 'other.js': 'net' }))
    await fire(w.listeners.get('install')!)
    await (await caches.open('ceica-app-a')).put(`${SCOPE}assets/app-a.js`, new Response('js a'))
    await (await caches.open('ceica-meta-1')).put('running', new Response('ceica-app-a'))
    await fire(w.listeners.get('activate')!)
    const fetchEvent = w.listeners.get('fetch')!
    const ask = async (url: string, more: Record<string, unknown> = {}): Promise<string | null> => {
      const res = await fire(fetchEvent, { request: { url, method: 'GET', mode: 'cors', ...more } })
      return res === null ? null : res.text()
    }
    expect(await ask(SCOPE, { mode: 'navigate' })).toBe('<html>B')
    expect(await ask(`${SCOPE}index.html?x=1`, { mode: 'navigate' })).toBe('<html>B')
    expect(await ask(`${SCOPE}other.html`, { mode: 'navigate' })).toBeNull()
    expect(await ask(`${SCOPE}fonts/f.woff2?v=anything`)).toBe('font')
    expect(await ask(`${SCOPE}assets/app-a.js`)).toBe('js a')
    expect(await ask(`${SCOPE}other.js`)).toBe('net')
    expect(await ask(`${SCOPE}download/tok/x.pdf`)).toBeNull()
    expect(await ask('https://site.test/staf/app/index.html')).toBeNull()
    expect(await ask(`${SCOPE}fonts/f.woff2`, { method: 'POST' })).toBeNull()
  })
})

group('the download worker', () => {
  it("asks only CEICA's own pages, so another app's page never holds a download up", async () => {
    const asked: string[] = []
    const windows = [
      { url: 'https://site.test/staf/app/', postMessage: () => void asked.push('staf') },
      { url: `${SCOPE}download/old/x.pdf`, postMessage: () => void asked.push('download tab') },
      { url: SCOPE, postMessage: (_m: unknown, ports: MessagePort[]) => { asked.push('ceica'); ports[0].postMessage({ has: false }) } },
    ]
    const w = run(readFileSync(join(WEB, 'page', 'download-sw.js'), 'utf-8'), new FakeCaches(), () => null, windows, `${SCOPE}download/`)
    const res = await Promise.race([
      fire(w.listeners.get('fetch')!, { request: { url: `${SCOPE}download/tok/file.pdf`, method: 'GET' } }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ])
    expect(res?.status).toBe(404)
    expect(asked).toEqual(['ceica'])
  })
})
