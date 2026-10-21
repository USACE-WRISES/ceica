// Offline use, install and updates of the built app, checked in headless Edge (Phase 4), and the
// published site checked the same way (Phase 5). Ported from the Python tool (offline.py) when the
// Python retired; it runs on Node 22 alone, with no package beyond the app's own.
//
//     node tools/offline.ts                                  every scenario
//     node tools/offline.ts --scenario offline               some of them
//     node tools/offline.ts --throttle 150,4                 150 ms a file, 4 Mbit/s
//     node tools/offline.ts --serve [--port 5193]            a server for a person
//     node tools/offline.ts --live https://usace-wrises.github.io/ceica/    the published site
//
// (from web/; npm run offline and npm run live run the first and the last.)
//
// The tool builds the app twice into a temporary folder: build A as released, and build B with every
// hashed name changed (CEICA_TEST_BUILD=b), as a new release's would be. It serves them itself under
// /ceica/ on 127.0.0.1, as GitHub Pages serves the site (tools/pages.ts), beside a stand-in for STAF's
// app at /staf/app/ (the origin is shared). Stopping that server is the network going away; serving
// B in place of A is a release. Each scenario runs in a new browser profile.
//
// - repro: two builds of the same sources are the same, byte for byte (app-sw.js included).
// - install: the first visit, timed; the worker takes the page over with every file of its build
//   copied, and another app's caches stay; the page is installable, as the app id /ceica/; what it
//   stores, and whether that storage is persistent.
// - offline: with the server stopped the page reloads, Utoy opens, the Word document and a figure's
//   PNG download, Save saves, and Open opens a project file.
// - update_idle: B released with no project open: the page reloads into B by itself, no notice.
// - update_busy: B released with Utoy open and a cost edited: the notice shows and the page stays; it
//   still makes a Word document from build A's copy (the server has only B); Reload to update reopens
//   Utoy on B, the edit kept.
// - neighbors: with a STAF page open, a download the page no longer has is answered at once.
// - no_worker: the workers' scripts missing: the page works online and a table still downloads.
// - timing: first and repeat visits (three of each): time to the start page and bytes from the server
//   (with --throttle the server paces every answer, the worker's copying included).
//
// --serve keeps the server running for what only a person can check in Edge (installing, the app's
// own window): a = build A, b = build B, o = no network, q = quit.
//
// --live checks the published site against build A, built here from the same sources:
// - bytes: the site's app-sw.js is build A's, and every file it lists has its sha256 (so the site is
//   the build checked here; within 10 minutes of a release Pages' cache may still send the old files).
// - headers: each kind of file with its type, Cache-Control max-age=600, text gzipped.
// - install: as above, the app id the site's own address.
// - use: both examples open, every file of the Report page downloads whole, Save and Open, a project
//   the Shiny app saved opens and saves again as it should, and nothing goes to the console as an error.
// - timing: first and repeat visits, the bytes as the page counts them.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Edge, freePort, IDLE_JS, type Message, WATCH_JS, WHERE_JS } from './edge.ts'
import { Site, SITE } from './pages.ts'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const PROJECTS = join(WEB, 'tests', 'fixtures', 'projects')

interface Build {
  build: string
  files: string[]
}

interface Ctx {
  tmp: string
  a: string
  b: string
  A: Build
  B: Build | null
  site: Site
  throttle: string | null
  live: string | null
}

// --- the builds ----------------------------------------------------------------------------------

/** The build's id and files, from its worker. */
function readWorker(worker: string): Build {
  const build = /const BUILD = "([0-9a-f]+)"/.exec(worker)
  const files = /const FILES = (.*)\n/.exec(worker)
  if (!build || !files) throw new Error('app-sw.js names no build or files')
  return { build: build[1], files: (JSON.parse(files[1]) as [string, string][]).map(([f]) => f) }
}

/** A production build into out (tag: CEICA_TEST_BUILD); its worker's build id and files. */
function build(out: string, tag: string | null = null): Build {
  const env = { ...process.env }
  delete env.CEICA_TEST_BUILD
  if (tag) env.CEICA_TEST_BUILD = tag
  const vite = join(WEB, 'node_modules', 'vite', 'bin', 'vite.js')
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir'],
    { cwd: WEB, env, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`the build failed:\n${(r.stdout ?? '').slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`)
  return readWorker(readFileSync(join(out, 'app-sw.js'), 'utf-8'))
}

function walk(root: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Every file of a folder and its sha256, by its path in the folder. */
function tree(root: string): Map<string, string> {
  return new Map(walk(root).map((p) => [relative(root, p).split('\\').join('/'), sha256(readFileSync(p))]))
}

// --- the page ------------------------------------------------------------------------------------

const CACHES_JS = `(async () => {
  const out = {};
  for (const k of await caches.keys()) {
    out[k] = (await (await caches.open(k)).keys()).map((r) => r.url);
  }
  return out;
})()`
const REGS_JS = `navigator.serviceWorker.getRegistrations().then((rs) =>
  rs.map((r) => [r.scope, r.active ? r.active.scriptURL : null]))`
const UPDATE_JS = `navigator.serviceWorker.getRegistration().then((r) =>
  r ? r.update().then(() => true) : false)`
// a mark on this document, and a record (in this tab's sessionStorage) of an update notice it shows
const MARK_JS = `(() => {
  window.__ceicaMark = 1;
  new MutationObserver(() => {
    if (document.getElementById('shiny-notification-ceica-update')) {
      sessionStorage.setItem('test.noticed', '1');
    }
  }).observe(document.body, { subtree: true, childList: true });
  return true;
})()`
const ON_B_JS = '!window.__ceicaMark && !!document.querySelector(\'script[src*="/assets/index-b-"]\')'
const PLANT_JS = `caches.open('staf-app-test').then((c) =>
  c.put('/staf/app/x', new Response('x'))).then(() => true)`
const DOWNLOADS_UP_JS = `navigator.serviceWorker.getRegistrations().then((rs) =>
  rs.some((r) => r.scope.endsWith('download/') && r.active))`
const FRAME_JS = `((id, src) => {
  const f = document.createElement('iframe');
  f.id = id;
  f.src = src;
  document.body.appendChild(f);
  return true;
})`
const GONE_JS = `(() => {
  const doc = document.getElementById('gone').contentDocument;
  return !!doc && !!doc.body && doc.body.textContent.includes('no longer here');
})()`
// every link matching a selector marked data-capture="<k>", in page order; their count
const LINKS_JS = `((sel) => {
  const links = [...document.querySelectorAll(sel)];
  links.forEach((a, k) => a.setAttribute('data-capture', String(k)));
  return links.length;
})`
// the bytes this page and its files came with (a file from the worker's copy counts none)
const NET_BYTES_JS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  let bytes = nav ? nav.transferSize : 0;
  for (const r of performance.getEntriesByType('resource')) bytes += r.transferSize || 0;
  return bytes;
})()`
const NOTICE = 'shiny-notification-ceica-update'
const EXAMPLES = '[data-ev="start_view"][data-view="examples"]'
const UTOY = '[data-ev="example"][data-name="utoy-creek"]'
const START = '[data-ev="start"]'
const PICK_STAF = '[data-ev="start_pick"][data-name="staf-demo"]'
const STAF_DEMO = '[data-ev="example"][data-name="staf-demo"]'
const REPORT = '[data-ev="nav"][data-page="report"]'
const COSTS = '#ce-panel [data-ev="nav"][data-page="inputs"][data-section="costs"]'
const CELL = 'input.ce-cell[data-path="c|17F2M|Alternative1|first|construction"]'
const CELL_JS = `document.querySelector(${JSON.stringify(CELL)}).value`
const NAME_JS = "(document.querySelector('#project_name') || {}).textContent || ''"
const WORD = 'a[download][href*="f=doc&fmt=docx"]'
const PNG = 'a[download][href*="f=fig-plans&fmt=png"]'
const CSV = 'a[download][href*="f=settings&fmt=csv"]'
const REPORT_LINKS = 'a[download][href*="fmt="]'

/** An expression's value once it is truthy (a page being replaced counts as not yet). */
async function until<T = unknown>(edge: Edge, expr: string, limit = 60, step = 0.2): Promise<T> {
  const end = performance.now() + limit * 1000
  while (performance.now() < end) {
    let got: unknown = null
    try {
      got = await Promise.race([edge.js(expr), sleep(Math.max(end - performance.now(), 1), null)])
    } catch {
      got = null  // a page being replaced
    }
    if (got) return got as T
    await sleep(step * 1000)
  }
  throw new Error(`waited ${limit} s for ${JSON.stringify(expr.slice(0, 90))}`)
}

async function ready(edge: Edge, limit = 60): Promise<void> {
  await until(edge, IDLE_JS, limit)
}

/** A person's click on the element (scrolled into view first). */
async function click(edge: Edge, sel: string): Promise<void> {
  await until(edge, `${WHERE_JS}(${JSON.stringify(sel)})`, 30)
  await sleep(150)  // the scroll into view settles
  const [x, y] = await edge.js<[number, number]>(`${WHERE_JS}(${JSON.stringify(sel)})`)
  await edge.mouse('mouseMoved', x, y)
  await edge.mouse('mousePressed', x, y)
  await sleep(60)  // a person's click lasts a moment
  await edge.mouse('mouseReleased', x, y)
}

async function visit(edge: Edge, url: string): Promise<void> {
  await edge.call('Page.navigate', { url })
  await sleep(500)
  await ready(edge)
}

/** The page visited online, and its worker running with every file of the build copied. */
async function installed(edge: Edge, url: string, want: Build): Promise<void> {
  await visit(edge, url)
  await until(edge, '!!navigator.serviceWorker.controller', 90)
  const cache = JSON.stringify(`ceica-app-${want.build}`)
  await until(edge, `caches.has(${cache})`, 60)
  await until(edge, `caches.open(${cache}).then((c) => c.keys()).then((k) => k.length === ${want.files.length})`, 60)
}

/** Utoy opened from the start page's examples. */
async function opened(edge: Edge): Promise<void> {
  await click(edge, EXAMPLES)
  await click(edge, UTOY)
  await ready(edge)
}

/** The file a link's click saves (moved out of the browser's folder). */
async function saved(edge: Edge, folder: string, sel: string, limit = 120): Promise<string> {
  const before = new Set(readdirSync(folder))
  await click(edge, sel)
  const end = performance.now() + limit * 1000
  while (performance.now() < end) {
    const got = readdirSync(folder).filter((f) => !before.has(f) && !/\.(crdownload|tmp)$/.test(f))
    if (got.length) {
      await sleep(300)
      const keep = `${folder}-kept`
      mkdirSync(keep, { recursive: true })
      const dest = join(keep, got[0])
      for (let i = 0; ; i++) {
        try {
          renameSync(join(folder, got[0]), dest)
          break
        } catch (err) {
          if (i === 20) throw err
          await sleep(250)  // the browser still holds it
        }
      }
      await edge.call('Page.bringToFront')
      return dest
    }
    await sleep(250)
  }
  throw new Error(`${sel}: no file was saved`)
}

/** One scenario's checks: each line printed as it is made; any failure fails the tool. */
class Run {
  readonly name: string
  readonly failures: string[] = []

  constructor(name: string) {
    this.name = name
  }

  check(ok: boolean, what: string): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
    if (!ok) this.failures.push(what)
  }

  note(what: string): void {
    console.log(`       ${what}`)
  }
}

type InBrowser<T> = (edge: Edge, folder: string) => Promise<T>

/** fn run in a new browser profile, its downloads saved in a folder of their own. */
async function browser<T>(fn: InBrowser<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), 'ceica-offline-files-'))
  const edge = await Edge.open({ downloads: folder })
  try {
    await edge.call('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_JS })
    return await fn(edge, folder)
  } finally {
    await edge.close()
    rmSync(folder, { recursive: true, force: true })
    rmSync(`${folder}-kept`, { recursive: true, force: true })
  }
}

/** The files the built page asks for (its scripts, icons and manifest, and its stylesheets' fonts), as
 * paths in the build; Bootstrap 3's glyphicons, which the page never had, aside. */
function pageFiles(index: string): Set<string> {
  const refs = new Set<string>()
  for (const m of index.matchAll(/(?<![\w-])(?:src|href)="([^"]+)"/g)) refs.add(m[1])
  for (const m of index.matchAll(/url\("([^"]+)"\)/g)) refs.add(m[1])
  const out = new Set<string>()
  for (const ref of refs) {
    if (/^(data:|#|https?:)/.test(ref) || ref.includes('glyphicons')) continue
    let path = ref.split('?')[0]
    if (path.startsWith(SITE)) path = path.slice(SITE.length)
    out.add(path.replace(/^\/+/, ''))
  }
  return out
}

function n(x: number): string {
  return Math.round(x).toLocaleString('en-US')
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Whether two lists hold the same strings, in any order. */
function same(a: string[], b: string[]): boolean {
  const x = [...a].sort()
  const y = [...b].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

// --- the scenarios -------------------------------------------------------------------------------

async function sRepro(run: Run, ctx: Ctx): Promise<void> {
  const again = join(ctx.tmp, 'a2')
  build(again)
  const ta = tree(ctx.a)
  const tb = tree(again)
  const equal = ta.size === tb.size && [...ta].every(([k, v]) => tb.get(k) === v)
  run.check(equal, `two builds of the same sources are the same (${ta.size} files, worker build ${ctx.A.build})`)
}

/** The worker's install, as s_install checks it, at an address: the site's or the published one. The
 * bytes of the worker's own copying are counted only where the server counts them (copied: null). */
async function checkInstall(run: Run, edge: Edge, url: string, want: Build, count: () => Promise<number>,
  copied: (() => Promise<number>) | null): Promise<void> {
  const t0 = performance.now()
  await visit(edge, url)
  const first = (performance.now() - t0) / 1000
  run.note(`first visit: the start page in ${first.toFixed(2)} s, ${n(await count())} bytes from the site`)
  await edge.js(PLANT_JS)
  const t1 = performance.now()
  await installed(edge, url, want)
  run.note(`the worker copied the build ${((performance.now() - t1) / 1000).toFixed(1)} s after the start `
    + 'page (5 s of it the wait to register)'
    + (copied ? `, ${n(await copied())} bytes` : "; the worker's own downloads are not counted here"))
  const kept = await edge.js<Record<string, string[]>>(CACHES_JS)
  const mine = kept[`ceica-app-${want.build}`] ?? []
  run.check(same(mine, want.files.map((f) => url + f)),
    `its copy holds every file of the build and nothing else (${mine.length} files)`)
  run.check('staf-app-test' in kept, "another app's cache on the origin is untouched")
  const errors = ((await edge.call('Page.getInstallabilityErrors')).installabilityErrors ?? []) as unknown[]
  run.check(errors.length === 0, `installable: ${errors.length ? JSON.stringify(errors) : 'no errors'}`)
  const manifest = await edge.call('Page.getAppManifest') as { url?: string, errors?: unknown[] }
  run.check(!manifest.errors?.length, `the manifest parses (${manifest.url})`)
  try {
    const app = await edge.call('Page.getAppId') as { appId?: string }
    run.check(app.appId === url, `the app id: ${JSON.stringify(app)}`)
  } catch (err) {
    run.note(`the app id is not available headless: ${(err as Error).message}`)
  }
  const [used, quota] = await edge.js<[number, number]>('navigator.storage.estimate().then((e) => [e.usage, e.quota])')
  const persisted = await edge.js<boolean>('navigator.storage.persisted()')
  run.note(`storage: ${n(used)} bytes used of ${n(quota)}; persistent: ${persisted}`)
  const regs = await edge.js<[string, string | null][]>(REGS_JS)
  run.check(same(regs.map(([s]) => s), [url, `${url}download/`]),
    `two workers, the app's and the downloads': ${JSON.stringify(regs)}`)
}

async function sInstall(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  await browser(async (edge) => {
    site.take()
    await checkInstall(run, edge, site.url, ctx.A, async () => site.take(), async () => site.take())
    const used = pageFiles(readFileSync(join(ctx.a, 'index.html'), 'utf-8'))
    const missing = [...used].filter((f) => !ctx.A.files.includes(f)).sort()
    run.check(missing.length === 0, `every file the page asks for is in the copy (${used.size} files)`
      + (missing.length ? `: missing ${JSON.stringify(missing)}` : ''))
  })
}

async function sOffline(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  await browser(async (edge, folder) => {
    await installed(edge, site.url, ctx.A)
    await site.stop()
    try {
      await visit(edge, site.url)
      run.check(true, 'with no network the page reloads to the start page')
      await opened(edge)
      const name = await edge.js<string>(NAME_JS)
      run.check(name.includes('Utoy'), `Utoy opens (${name.trim()})`)
      await click(edge, REPORT)
      await ready(edge)
      const doc = await saved(edge, folder, WORD)
      run.check(readFileSync(doc).subarray(0, 2).toString('latin1') === 'PK',
        `the Word document downloads (${n(statSync(doc).size)} bytes)`)
      const png = await saved(edge, folder, PNG)
      run.check(readFileSync(png).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        `a figure's PNG downloads (${n(statSync(png).size)} bytes)`)
      const kept = await saved(edge, folder, '#save_project')
      run.check(readFileSync(kept, 'utf-8').includes('"format"'), `Save saves the project (${basename(kept)})`)
      await edge.setFiles('#open_file', [join(PROJECTS, 'mixed.ceica')])
      await until(edge, `(${NAME_JS}).includes('Mixed')`, 30)
      run.check(true, 'Open opens a project file')
    } finally {
      await site.serve(ctx.a)
    }
  })
}

async function sUpdateIdle(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  const B = ctx.B as Build
  await site.serve(ctx.a)
  await browser(async (edge) => {
    await installed(edge, site.url, ctx.A)
    await edge.js(MARK_JS)
    await site.serve(ctx.b)
    await edge.js(UPDATE_JS)
    await until(edge, ON_B_JS, 90)
    await ready(edge)
    run.check(true, 'with no project open the page reloads into build B by itself')
    const noticed = await edge.js<string | null>("sessionStorage.getItem('test.noticed')")
    run.check(noticed === null, 'no notice was shown')
    const kept = await edge.js<string[]>('caches.keys()')
    const both = [`ceica-app-${B.build}`, `ceica-app-${ctx.A.build}`]
    run.check(both.every((k) => kept.includes(k)), `B's copy is in, A's kept as the build before (${JSON.stringify(kept)})`)
    await site.serve(ctx.a)
  })
}

async function sUpdateBusy(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  await browser(async (edge, folder) => {
    await installed(edge, site.url, ctx.A)
    await opened(edge)
    await click(edge, COSTS)
    await ready(edge)
    await click(edge, CELL)
    await edge.call('Input.insertText', { text: '777777' })
    await edge.press('Enter')
    await ready(edge)
    const edited = await edge.js<string>(CELL_JS)
    run.note(`Utoy open, a construction cost edited to ${edited}`)
    await edge.js(MARK_JS)
    await site.serve(ctx.b)
    await edge.js(UPDATE_JS)
    await until(edge, `!!document.getElementById('${NOTICE}')`, 90)
    const text = await edge.js<string>(`document.getElementById('${NOTICE}').textContent`)
    run.check(text.includes('A new version of CEICA is ready.'), `the notice shows: ${JSON.stringify(text.trim())}`)
    run.check(Boolean(await edge.js('window.__ceicaMark === 1')), 'the page stays (no reload)')
    await click(edge, REPORT)
    await ready(edge)
    const doc = await saved(edge, folder, WORD)
    run.check(readFileSync(doc).subarray(0, 2).toString('latin1') === 'PK',
      `the page still makes a Word document from build A's copy (${n(statSync(doc).size)} bytes)`)
    await click(edge, 'button[data-ceica-update]')
    await until(edge, ON_B_JS, 60)
    await until(edge, `(${NAME_JS}).includes('Utoy')`, 60)
    await ready(edge)
    run.check(true, 'Reload to update reloads into build B and reopens Utoy')
    await click(edge, COSTS)
    await ready(edge)
    const again = await edge.js<string>(CELL_JS)
    run.check(again.replace(/\D/g, '') === edited.replace(/\D/g, ''), `the edit is kept (${again})`)
    await site.serve(ctx.a)
  })
}

async function sNeighbors(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  await browser(async (edge) => {
    await visit(edge, site.url)
    await until(edge, DOWNLOADS_UP_JS, 30)
    await edge.js(`${FRAME_JS}('staf', '/staf/app/')`)
    await sleep(1000)
    const t0 = performance.now()
    await edge.js(`${FRAME_JS}('gone', 'download/nothing-here/table.csv')`)
    await until(edge, GONE_JS, 30, 0.05)
    const took = (performance.now() - t0) / 1000
    run.check(took < 2, `with a STAF page open, a download no page has is answered in ${took.toFixed(2)} s`)
  })
}

async function sNoWorker(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  site.missing = new Set(['app-sw.js', 'download-sw.js'])
  try {
    await browser(async (edge, folder) => {
      await visit(edge, site.url)
      await sleep(7000)
      const regs = await edge.js<unknown[]>(REGS_JS)
      const controlled = await edge.js<boolean>('!!navigator.serviceWorker.controller')
      run.check(regs.length === 0 && !controlled, `no worker could register (${JSON.stringify(regs)})`)
      await opened(edge)
      run.check((await edge.js<string>(NAME_JS)).includes('Utoy'), 'the page works online without them')
      await click(edge, REPORT)
      await ready(edge)
      const csv = await saved(edge, folder, CSV)
      run.check(statSync(csv).size > 0, `a table downloads from a blank tab (${basename(csv)})`)
    })
  } finally {
    site.missing = new Set()
  }
}

/** First visits (three new profiles) and repeat visits (three in the last), their times and bytes. */
async function visits(run: Run, url: string, want: Build, bytes: (edge: Edge) => Promise<number>,
  pace: string): Promise<void> {
  const first: [number, number][] = []
  const repeat: [number, number][] = []
  for (let i = 0; i < 3; i++) {
    await browser(async (edge) => {
      await bytes(edge)
      const t0 = performance.now()
      await visit(edge, url)
      first.push([(performance.now() - t0) / 1000, await bytes(edge)])
      if (i === 2) {
        await installed(edge, url, want)
        await bytes(edge)
        for (let k = 0; k < 3; k++) {
          const t1 = performance.now()
          await visit(edge, url)
          repeat.push([(performance.now() - t1) / 1000, await bytes(edge)])
        }
      }
    })
  }
  for (const [label, rows] of [['first visit', first], ['repeat visit', repeat]] as const) {
    const times = rows.map(([t]) => t)
    run.note(`${label}${pace}: the start page in ${median(times).toFixed(2)} s (median of ${rows.length}: `
      + `${times.map((t) => t.toFixed(2)).join(', ')}), ${n(median(rows.map(([, b]) => b)))} bytes from the site`)
  }
  run.check(repeat.length > 0 && Math.max(...repeat.map(([, b]) => b)) < 50_000,
    "a repeat visit reads the page from the worker's copy")
}

async function sTiming(run: Run, ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  const pace = ctx.throttle ? ` at ${ctx.throttle} (ms, Mbit/s)` : ''
  await visits(run, site.url, ctx.A, async () => site.take(), pace)
}

const SCENARIOS: Record<string, (run: Run, ctx: Ctx) => Promise<void>> = {
  repro: sRepro, install: sInstall, offline: sOffline, update_idle: sUpdateIdle, update_busy: sUpdateBusy,
  neighbors: sNeighbors, no_worker: sNoWorker, timing: sTiming,
}

// --- the published site ----------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<{ status: number, body: Buffer, headers: Headers }> {
  const res = await fetch(url, { cache: 'no-store' })
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers }
}

/** The published build: its worker's id and files. */
async function liveBuild(url: string): Promise<Build> {
  const res = await fetchBytes(`${url}app-sw.js`)
  if (res.status !== 200) throw new Error(`${url}app-sw.js: ${res.status}`)
  return readWorker(res.body.toString('utf-8'))
}

async function lBytes(run: Run, ctx: Ctx): Promise<void> {
  const url = ctx.live as string
  for (const name of ['app-sw.js', 'download-sw.js']) {
    const got = await fetchBytes(`${url}${name}`)
    const local = readFileSync(join(ctx.a, name))
    run.check(got.status === 200 && got.body.equals(local),
      `the site's ${name} is build A's (${got.status}, ${n(got.body.length)} bytes, build ${ctx.A.build})`)
  }
  const worker = readFileSync(join(ctx.a, 'app-sw.js'), 'utf-8')
  const files = JSON.parse((/const FILES = (.*)\n/.exec(worker) as RegExpExecArray)[1]) as [string, string][]
  const wrong: string[] = []
  let total = 0
  for (const [path, hash] of files) {
    const got = await fetchBytes(path.startsWith('assets/') ? url + path : `${url}${path}?v=${hash.slice(0, 10)}`)
    total += got.body.length
    if (got.status !== 200 || sha256(got.body) !== hash) wrong.push(`${path} (${got.status})`)
  }
  run.check(wrong.length === 0, `every file the worker lists is the site's, byte for byte (${files.length} files, `
    + `${n(total)} bytes)` + (wrong.length ? `: differ ${JSON.stringify(wrong)}` : ''))
}

/** The type a file should come with: the start of its Content-Type (any of these). */
const LIVE_TYPES: Record<string, string[]> = {
  '.html': ['text/html'], '.js': ['application/javascript', 'text/javascript'], '.css': ['text/css'],
  '.webmanifest': ['application/manifest+json'], '.txt': ['text/plain'], '.png': ['image/png'],
  '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'], '.svg': ['image/svg+xml'], '.woff2': ['font/woff2'],
}

async function lHeaders(run: Run, ctx: Ctx): Promise<void> {
  const url = ctx.live as string
  const kinds = new Map<string, string>()
  for (const f of ['index.html', 'app-sw.js', 'download-sw.js', ...ctx.A.files]) {
    const ext = extname(f)
    if (!kinds.has(ext)) kinds.set(ext, f)
  }
  for (const [ext, f] of kinds) {
    const res = await fetch(url + (f === 'index.html' ? '' : f), { headers: { 'accept-encoding': 'gzip' } })
    await res.arrayBuffer()
    const type = res.headers.get('content-type') ?? ''
    const cache = res.headers.get('cache-control') ?? ''
    const encoding = res.headers.get('content-encoding') ?? ''
    const text = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg)/.test(type)
    const ok = res.status === 200 && (LIVE_TYPES[ext] ?? ['']).some((t) => type.startsWith(t))
      && cache.includes('max-age=600') && (!text || encoding === 'gzip')
    run.check(ok, `${f}: ${res.status}, ${type}, ${cache}${encoding ? `, ${encoding}` : ''}`)
  }
}

async function lInstall(run: Run, ctx: Ctx): Promise<void> {
  const url = ctx.live as string
  const want = await liveBuild(url)
  await browser(async (edge) => {
    await checkInstall(run, edge, url, want, () => edge.js<number>(NET_BYTES_JS), null)
  })
}

/** Whether a downloaded file is whole, by its kind. */
function whole(file: string): boolean {
  const data = readFileSync(file)
  const tail = data.subarray(Math.max(0, data.length - 1024)).toString('latin1')
  switch (extname(file).toLowerCase()) {
    case '.docx': case '.xlsx': case '.zip':
      return data.subarray(0, 2).toString('latin1') === 'PK' && tail.includes('PK\x05\x06')
    case '.pdf':
      return data.subarray(0, 5).toString('latin1') === '%PDF-' && tail.includes('%%EOF')
    case '.png':
      return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && tail.includes('IEND')
    case '.ceica': case '.json':
      try {
        JSON.parse(data.toString('utf-8'))
        return true
      } catch {
        return false
      }
    default:
      return data.length > 0 && !data.toString('utf-8').includes('\ufffd')
  }
}

/** The saved text of a project, its time and version aside. */
function plain(text: string): string {
  return text.replace(/"savedAt": "[^"]*"/, '"savedAt": ""').replace(/"appVersion": "[^"]*"/, '"appVersion": ""')
}

async function lUse(run: Run, ctx: Ctx): Promise<void> {
  const url = ctx.live as string
  await browser(async (edge, folder) => {
    const errors: string[] = []
    edge.on((m: Message) => {
      const p = m.params as Record<string, any> | undefined
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(String(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text))
      } else if (m.method === 'Runtime.consoleAPICalled' && p?.type === 'error') {
        errors.push((p.args as { value?: unknown, description?: string }[]).map((a) => a.value ?? a.description).join(' '))
      } else if (m.method === 'Log.entryAdded' && p?.entry?.level === 'error') {
        errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.trim())
      }
    })
    await edge.call('Runtime.enable')
    await edge.call('Log.enable')
    await visit(edge, url)
    await opened(edge)
    const utoy = await edge.js<string>(NAME_JS)
    run.check(utoy.includes('Utoy'), `Utoy opens (${utoy.trim()})`)
    await click(edge, START)
    await click(edge, EXAMPLES)
    await click(edge, PICK_STAF)
    await click(edge, STAF_DEMO)
    await ready(edge)
    const staf = await edge.js<string>(NAME_JS)
    run.check(staf.includes('STAF'), `the STAF demonstration opens (${staf.trim()})`)
    await click(edge, START)
    await click(edge, EXAMPLES)
    await click(edge, UTOY)
    await ready(edge)
    await click(edge, REPORT)
    await ready(edge)
    const count = await edge.js<number>(`${LINKS_JS}(${JSON.stringify(REPORT_LINKS)})`)
    const broken: string[] = []
    let bytes = 0
    let slowest = 0
    for (let i = 0; i < count; i++) {
      const t0 = performance.now()
      const file = await saved(edge, folder, `[data-capture="${i}"]`, 180)
      slowest = Math.max(slowest, (performance.now() - t0) / 1000)
      bytes += statSync(file).size
      if (!whole(file)) broken.push(basename(file))
      await ready(edge)
    }
    run.check(count > 0 && broken.length === 0, `every file of the Report page downloads whole (${count} files, `
      + `${n(bytes)} bytes, the slowest ${slowest.toFixed(1)} s)` + (broken.length ? `: broken ${JSON.stringify(broken)}` : ''))
    const kept = await saved(edge, folder, '#save_project')
    run.check(readFileSync(kept, 'utf-8').includes('"format"'), `Save saves the project (${basename(kept)})`)
    await edge.setFiles('#open_file', [join(PROJECTS, 'mixed.ceica')])
    await until(edge, `(${NAME_JS}).includes('Mixed')`, 30)
    run.check(true, 'Open opens a project file')
    await edge.setFiles('#open_file', [join(PROJECTS, 'v2-utoy-creek.ceica')])
    await until(edge, `(${NAME_JS}).includes('Utoy')`, 30)
    await ready(edge)
    const again = await saved(edge, folder, '#save_project')
    const golden = (JSON.parse(readFileSync(join(PROJECTS, 'v2-utoy-creek.json'), 'utf-8')) as { dumps: string }).dumps
    run.check(plain(readFileSync(again, 'utf-8')) === plain(golden),
      'a project the Shiny app saved (v2-utoy-creek.ceica) opens and saves as its golden says, time and version aside')
    run.check(errors.length === 0, `no errors in the console${errors.length ? `: ${JSON.stringify(errors.slice(0, 5))}` : ''}`)
  })
}

async function lTiming(run: Run, ctx: Ctx): Promise<void> {
  const url = ctx.live as string
  await visits(run, url, await liveBuild(url), (edge) => edge.js<number>(NET_BYTES_JS).catch(() => 0), '')
}

const LIVE: Record<string, (run: Run, ctx: Ctx) => Promise<void>> = {
  bytes: lBytes, headers: lHeaders, install: lInstall, use: lUse, timing: lTiming,
}

// --- the tool --------------------------------------------------------------------------------------

async function serveForever(ctx: Ctx): Promise<void> {
  const site = ctx.site
  await site.serve(ctx.a)
  console.log(`Serving build A at ${site.url} (a stand-in for STAF at /staf/app/).`)
  console.log('Enter: a = build A, b = build B, o = no network, q = quit.')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const what = (await rl.question('> ')).trim().toLowerCase()
      if (what === 'q') break
      if (what === 'o') {
        await site.stop()
        console.log('No network: the server is stopped.')
      } else if (what === 'a' || what === 'b') {
        await site.serve(what === 'a' ? ctx.a : ctx.b)
        const b = what === 'a' ? ctx.A : ctx.B as Build
        console.log(`Serving build ${what.toUpperCase()} (${b.build}).`)
      }
    }
  } finally {
    rl.close()
    await site.stop()
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', multiple: true },
      throttle: { type: 'string' },
      serve: { type: 'boolean', default: false },
      port: { type: 'string' },
      live: { type: 'string' },
    },
  })
  const live = values.live ? values.live.replace(/\/?$/, '/') : null
  const table = live ? LIVE : SCENARIOS
  const names = values.scenario ?? Object.keys(table)
  const unknown = names.filter((s) => !(s in table))
  if (unknown.length) {
    console.error(`unknown scenario: ${unknown.join(', ')} (choose from ${Object.keys(table).join(', ')})`)
    return 2
  }
  const tmp = mkdtempSync(join(tmpdir(), 'ceica-offline-'))
  const site = new Site(values.port ? Number(values.port) : await freePort())
  try {
    console.log(live ? 'building A ...' : 'building A and B ...')
    const ctx: Ctx = {
      tmp, a: join(tmp, 'a'), b: join(tmp, 'b'), A: { build: '', files: [] }, B: null, site,
      throttle: values.throttle ?? null, live,
    }
    ctx.A = build(ctx.a)
    if (!live) ctx.B = build(ctx.b, 'b')
    console.log(`A: build ${ctx.A.build}` + (ctx.B ? `, B: build ${ctx.B.build}` : '')
      + `, ${ctx.A.files.length} files` + (ctx.B ? ' each' : ''))
    if (values.throttle) {
      const [ms, mbps] = values.throttle.split(',').map(Number)
      site.pace = [ms / 1000, (mbps * 1e6) / 8]
    }
    if (values.serve) {
      await serveForever(ctx)
      return 0
    }
    if (live) console.log(`checking ${live}`)
    const failed: string[] = []
    for (const name of names) {
      console.log(`${name}:`)
      const run = new Run(name)
      try {
        await table[name](run, ctx)
      } catch (err) {
        run.check(false, `${(err as Error).name}: ${(err as Error).message}`)
      }
      if (run.failures.length) failed.push(name)
    }
    console.log(failed.length ? `failed: ${failed.join(', ')}` : 'every scenario passed')
    return failed.length ? 1 : 0
  } finally {
    await site.stop()
    rmSync(tmp, { recursive: true, force: true })
  }
}

process.exitCode = await main()
