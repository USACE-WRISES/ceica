// The rules every page keeps, ported from the Python's tests: color contrast (tests/test_contrast.py)
// on the copied stylesheet and the figures' palette, the host seam (tests/test_host_seam.py), the
// copy rules on every page the TypeScript draws (tests/test_copy_rules.py), and a few of
// tests/test_pages.py's checks of what the pages send.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyze, type AnalysisResults, planOrder } from '../src/engine/analysis'
import * as staf from '../src/engine/benefits/staf'
import * as P from '../src/engine/figures/palette'
import { isStaf } from '../src/engine/model'
import { loads } from '../src/engine/projectfile'
import { catalog, type TableData } from '../src/engine/report/exhibits'
import { renderHtml } from '../src/engine/report/html'
import { buildReport } from '../src/engine/report/model'
import { readmeText } from '../src/engine/report/zips'
import { type Child, TagList } from '../src/shiny/htm'
import { addModule } from '../src/views/edits'
import { VIEWS, TOTALS } from '../src/views/grids'
import { inputsPage, moduleDialog } from '../src/views/inputsPage'
import { reportPage, settingsDialog } from '../src/views/reportPage'
import { aboutHtml, helpHtml, startPage, whatsNewHtml } from '../src/views/shell'
import { sitesPage } from '../src/views/sites'
import { ALL_ROWS_LIMIT, watershedPage } from '../src/views/watershed'
import { projectGoldens } from './projects'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const CSS = readFileSync(join(WEB, 'page', 'ceica.css'), 'utf-8')
const TOKENS = new Map([...CSS.matchAll(/(--ce-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]))

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function ratio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (la + 0.05) / (lb + 0.05)
}
const tok = (name: string): string => (name.startsWith('--') ? TOKENS.get(name)! : name)

describe('contrast (WCAG 2.1)', () => {
  it('text tokens meet AA', () => {
    for (const [fg, bg] of [['--ce-text', '#ffffff'], ['--ce-text-muted', '#ffffff'], ['--ce-text-muted', '--ce-surface-soft'],
      ['--ce-text', '--ce-surface-soft'], ['--ce-accent', '#ffffff'], ['--ce-warn', '--ce-warn-soft'], ['--ce-err', '--ce-err-soft'],
      ['--ce-ok', '--ce-ok-soft'], ['--ce-text', '--ce-warn-soft']]) {
      expect(ratio(tok(fg), tok(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('no text color below AA', () => {
    for (const m of CSS.matchAll(/(?<![-\w])color:\s*var\((--ce-[a-z-]+)\)/g)) {
      const name = m[1]
      if (!TOKENS.has(name)) continue
      const bg = name.startsWith('--ce-on-') ? TOKENS.get('--ce-accent')! : '#ffffff'
      expect(ratio(TOKENS.get(name)!, bg), name).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('chart marks meet 3:1 on white', () => {
    for (const c of [...P.SERIES, P.NAVY, P.DECISION, P.HIGHLIGHT, P.TEXT, ...Object.values(staf.OUTCOME_COLORS), ...P.COST_PARTS.values()]) {
      expect(ratio(c, '#ffffff'), c).toBeGreaterThanOrEqual(3.0)
    }
  })
  it('ECI lines stay readable on the band tints', () => {
    for (const bg of Object.values(P.STAF_BAND_TINTS)) for (const c of [...P.SERIES, P.TEXT]) expect(ratio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3.0)
  })
  it('marks stay readable on the density tints', () => {
    for (const bg of P.DENSITY) for (const c of [P.NAVY, P.DECISION, P.HIGHLIGHT]) expect(ratio(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3.0)
  })
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('the host seam', () => {
  const HOST_WORDS = /this browser|on the server|localStorage|Posit Connect|this computer|sent anywhere/i
  it('host wording lives in views/host.ts only (the page layer, src/app, is the seam itself)', () => {
    const hits: string[] = []
    for (const p of [...files(join(WEB, 'src', 'engine')), ...files(join(WEB, 'src', 'views')), ...files(join(WEB, 'src', 'py'))]) {
      if (p.endsWith('host.ts')) continue
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
        if (HOST_WORDS.test(line)) hits.push(`${relative(WEB, p)}:${i + 1}: ${line.trim().slice(0, 90)}`)
      })
    }
    expect(hits).toEqual([])
  })
  it('the engine never imports the page', () => {
    const hits = files(join(WEB, 'src', 'engine')).filter((p) => /from '\.\.\/(\.\.\/)?(views|shiny|app)\//.test(readFileSync(p, 'utf-8')))
    expect(hits.map((p) => relative(WEB, p))).toEqual([])
  })
})

const inputs = new Map(projectGoldens().map((g) => [g.name, g.input]))
const html = (tag: Child): string => new TagList(tag).render()
const TODAY = new Date(2026, 9, 18)

/** Every page the TypeScript draws for the four projects the Python's copy rules read. */
function rendered(): Map<string, string> {
  const out = new Map<string, string>([['start', html(startPage([]))],
    ['start/recent', html(startPage([{ id: 'x', name: 'My study', at: 'Oct 18, 10:42' }]))],
    ['start/examples', html(startPage([], 'examples'))], ['start/staf', html(startPage([], 'examples', 'staf-demo'))],
    ['about', html(aboutHtml())], ['help', html(helpHtml())], ['whatsnew', html(whatsNewHtml())]])
  for (const name of ['utoy-creek', 'staf-demo', 'mixed', 'two-staf']) {
    const res = analyze(loads(inputs.get(name)!).project)
    const p = res.project
    for (const s of p.sites) out.set(`${name}/sites/${s.id}`, html(sitesPage(res, s.id)))
    for (const view of ['bb', 'ce', 'all']) out.set(`${name}/watershed/${view}`, html(watershedPage(res, view)))
    for (const section of ['study', 'sites', 'benefits', 'costs', 'check']) out.set(`${name}/inputs/${section}`, html(inputsPage(res, section, {})))
    for (const m of p.benefits.modules) {
      for (const view of VIEWS[m.method]) out.set(`${name}/benefits/${m.id}/${view}`, html(inputsPage(res, 'benefits', { module: m.id, view })))
      out.set(`${name}/dialog/${m.id}`, html(moduleDialog(p, m.id)))
    }
    out.set(`${name}/benefits/totals`, html(inputsPage(res, 'benefits', { module: TOTALS })))
    out.set(`${name}/dialog/add`, html(moduleDialog(p)))
    // a module with nothing worked out yet
    const fresh = addModule(p, 'New module', isStaf(p.benefits) ? 'STAF' : 'INDEX_X_QUANTITY', 'acres')
    const mid = fresh.benefits.modules[fresh.benefits.modules.length - 1].id
    out.set(`${name}/benefits/new`, html(inputsPage(analyze(fresh), 'benefits', { module: mid, view: 'output' })))
    out.set(`${name}/report-page`, html(reportPage(res, 'files?nonce=1')) + html(settingsDialog(res, TODAY)))
    out.set(`${name}/report`, renderHtml(buildReport(res, { today: TODAY })))
    // the files: the Everything zip's README, and every table's column names
    out.set(`${name}/readme`, readmeText(res, new Date(2026, 9, 17)))
    out.set(`${name}/columns`, catalog(res).filter((e) => e.kind === 'table')
      .flatMap((e) => (e.build() as TableData).columns.map((c) => c.name)).join(' | '))
  }
  // decisions that need review after an edit
  const stale = analyze(loads(inputs.get('utoy-stale')!).project)
  out.set('stale/watershed', html(watershedPage(stale, 'bb')))
  out.set('stale/sites/2A', html(sitesPage(stale, '2A')))
  out.set('stale/report-page', html(reportPage(stale, 'files?nonce=1')))
  // a chart with a density layer (49,152 plans)
  const full = analyze(loads(inputs.get('utoy-full-factorial')!).project)
  out.set('full/watershed', html(watershedPage(full, 'bb')))
  out.set('full/report', renderHtml(buildReport(full, { today: TODAY })))
  return out
}

const visible = (markup: string): string => markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('copy rules on every page the TypeScript draws', () => {
  const pages = rendered()
  it('no em or en dashes', () => {
    expect([...pages].filter(([, m]) => m.includes(String.fromCharCode(0x2014)) || m.includes(String.fromCharCode(0x2013))).map(([k]) => k)).toEqual([])
  })
  it("plain words: 'best buy', never BB", () => {
    const bad = [...pages].flatMap(([k, m]) => [...visible(m).matchAll(/\b(BB|BBs)\b/g)].map(() => k))
    expect(bad).toEqual([])
  })
  it('a missing value reads n/a, never None or nan', () => {
    const bad = [...pages].flatMap(([k, m]) => [...visible(m).matchAll(/\b(None|nan|NaN)\b/g)].map(() => k))
    expect(bad).toEqual([])
  })
})

/** The radio inputs that post an event, as attribute maps. */
function radios(markup: string): Record<string, string>[] {
  return [...markup.matchAll(/<input ([^>]*)\/?>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
    .filter((a) => a.type === 'radio' && 'data-ev' in a)
}

describe('what the pages send (tests/test_pages.py)', () => {
  for (const name of ['utoy-creek', 'staf-demo']) {
    it(`every radio sends its own value: ${name}`, () => {
      const res = analyze(loads(inputs.get(name)!).project)
      const pages = [reportPage(res, 'files?nonce=1'), watershedPage(res, 'bb'), ...res.project.sites.map((s) => sitesPage(res, s.id))]
      const found = pages.flatMap((pg) => radios(html(pg)))
      const evs = new Set(found.map((r) => r['data-ev']))
      expect(evs.has('report_field') && evs.has('recommend')).toBe(true)
      for (const r of found) {
        expect(r.value).toBeDefined()
        if ('data-value' in r) expect(r.value).toBe(r['data-value'])
        if ('data-key' in r) expect(r.value).toBe(r['data-key'])
      }
    })
  }
  it('the all plans view shows the first rows only, in order of output', () => {
    const res: AnalysisResults = analyze(loads(inputs.get('utoy-full-factorial')!).project)
    const markup = html(watershedPage(res, 'all'))
    expect(markup).toContain(`Showing ${ALL_ROWS_LIMIT} of 49,152 plans in order of output.`)
    const ws = res.watershed
    const first = planOrder(ws, 'all').slice(0, 3).map((i) => ws.ceica!.points.ids[i])
    expect([...markup.matchAll(/<tr data-key="(P\d+)"/g)].slice(0, 3).map((m) => m[1])).toEqual(first)
  })
})
