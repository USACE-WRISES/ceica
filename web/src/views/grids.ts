// Editable input grids (views/grids.py). Each builder returns [markup, matrix of cell paths in
// display order].
//
// Cells are plain inputs (.ce-cell) with data-ev="cell" and their path; the matrix lets a pasted
// block from Excel land on exactly the cells shown. Computed columns are read-only and update after
// every edit. Rows carry the site and alternative in their first columns so pasted rows line up the
// way they do in Excel.
import type { AnalysisResults } from '../engine/analysis'
import { lineKey } from '../engine/annualize'
import { stafRollups } from '../engine/benefits'
import * as staf from '../engine/benefits/staf'
import { money, num } from '../engine/fmt'
import {
  alternativeOf, byYear, moduleOf, noAction, notAssessed, type Project, siteOf, valuesFor, type Alternative, type Module,
} from '../engine/model'
import { pyFixed, pyFixedComma, pyFloat, pyG } from '../py/pyfmt'
import { parseDecimal, pyRound, pySum } from '../py/pynum'
import { h, type Tag } from '../shiny/htm'
import { ev } from './components'

/** Cell text: the shortest text that reads back as the same number, never in exponent form
 * (format(Decimal(repr(float(x))), "f"), trailing zeros dropped). */
export function v(x: number | null | undefined, dp: number | null = null): string {
  if (x === null || x === undefined) return ''
  if (dp !== null) return pyFixed(x, dp)
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity'
  const d = parseDecimal(pyFloat(x))
  const digits = d.coef.toString()
  let s: string
  if (d.exp >= 0) s = digits + '0'.repeat(d.exp)
  else {
    const padded = digits.padStart(-d.exp + 1, '0')
    s = padded.slice(0, padded.length + d.exp) + '.' + padded.slice(padded.length + d.exp)
  }
  if (d.neg) s = '-' + s
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

/** Cell text rounded for reading (at most ``dp`` decimals, no trailing zeros). */
export function show(x: number | null | undefined, dp = 4): string {
  if (x === null || x === undefined) return ''
  const s = pyFixed(pyRound(x, dp), dp).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' || s === '' ? '0' : s
}

/** One editable cell. A required cell left blank is marked so gaps stand out in big grids. ``exact`` is
 * the full value when the cell shows it rounded (it appears on hover and is kept unless the cell is
 * edited). */
export function cell(path: string, value: string, grid: string, r: number, c: number, label: string,
  { text = false, derived = false, required = false, exact = null as string | null } = {}): Tag {
  const missing = required && (value === null || value === '')
  const cls = 'ce-cell' + (text ? ' txt' : '') + (derived ? ' is-derived' : '') + (missing ? ' is-missing' : '')
  const tip = missing ? 'Needed for the analysis' : exact && exact !== value ? `Exact value ${exact}` : null
  return h.input({ type: 'text', value, id: `cell-${grid}-${r}-${c}`, class: cls, inputmode: text ? null : 'decimal', 'aria-label': label,
    'aria-required': required ? 'true' : null, title: tip, 'data-grid': grid, 'data-r': String(r), 'data-c': String(c) },
  ev('cell', { path }))
}

/** How an average annual output is taken, in one sentence. */
export function averageNote(p: Project): string {
  const years = p.benefits.target_years
  if (p.settings.aahu_method === 'IWR_YEARLY_2DP') {
    return `The average (${p.labels.annual_output_short}) fills in every year between the target years, rounds those to 2 decimals `
      + `and averages them over the ${p.settings.period_of_analysis}-year period (IWR Annualizer).`
  }
  return `The average (${p.labels.annual_output_short}) is the area under straight lines between the target years, divided by `
    + `the ${pyG(years[years.length - 1] - years[0])} years.`
}

/** Hover text for an average: the yearly values it comes from and how they are averaged. */
function avgTip(p: Project, what: string, series: readonly (number | null)[] | null | undefined, avg: number | null): string {
  const years = p.benefits.target_years
  const name = p.labels.output_name.toLowerCase()
  if (!series || !series.length || series.some((x) => x === null)) return `${what}: some years have no value yet, so there is no average.`
  const n = Math.min(years.length, series.length)
  const pts = years.slice(0, n).map((y, i) => `${pyFixedComma(series[i] as number, 3)} in year ${pyG(y)}`).join(', ')
  const how = p.settings.aahu_method === 'IWR_YEARLY_2DP'
    ? `filled in for every year, rounded to 2 decimals and averaged over ${p.settings.period_of_analysis} years`
    : `the area under straight lines between them, divided by ${pyG(years[years.length - 1] - years[0])} years`
  return `${what}: ${name} ${pts}; ${how} = ${pyFixedComma(avg as number, 3)}.`
}

const altLabel = (a: Alternative): string => (a.is_no_action ? 'No Action' : a.id)

/** The views of a module tab, by method: entered values first, then what is worked out from them. */
export const VIEWS: Readonly<Record<string, readonly string[]>> = {
  HU: ['values'], INDEX_X_QUANTITY: ['values', 'quantity', 'output'], STAF: ['scores', 'output'], AAHU: ['aahu'],
}
/** The Totals and lift tab, beside the module tabs. */
export const TOTALS = '_totals'

/** The grid options the page keeps (Inputs: the module tab, its view, the STAF site and
 * alternative). */
export type GridOpts = Readonly<Record<string, string | null | undefined>>

/** The module tab and view on screen: [module, view], or [null, "totals"] for Totals and lift, which
 * only a study with two or more modules has. A module or view that no longer applies falls back to
 * the first one. */
export function pickModule(p: Project, opts: GridOpts): [Module | null, string] {
  if (opts.module === TOTALS && p.benefits.modules.length > 1) return [null, 'totals']
  const mod = moduleOf(p.benefits, opts.module || '') ?? p.benefits.modules[0]
  const views = VIEWS[mod.method]
  const view = opts.view
  return [mod, view && views.includes(view) ? view : views[0]]
}

/** Whether any alternative has an output worked out for the module yet (its computed view would
 * otherwise be all n/a). */
export function hasOutput(res: AnalysisResults, moduleId: string): boolean {
  for (const bl of res.benefits.values()) for (const x of bl.series.get(moduleId) ?? []) if (x !== null) return true
  return false
}

/** One module's outputs, one row per site and alternative (see views/grids.py benefits_grid). */
export function benefitsGrid(res: AnalysisResults, moduleId: string | null, view: string | null = null): [Tag, (string | null)[][]] {
  const p = res.project
  const spec = p.benefits
  const mod = moduleOf(spec, moduleId || '') ?? spec.modules[0]
  const views = VIEWS[mod.method]
  view = view && views.includes(view) && view !== 'scores' ? view : views.find((x) => x !== 'scores')!
  const years = spec.target_years
  const single = spec.modules.length === 1
  const unit = p.labels.output_short
  const aunit = p.labels.annual_output_short
  const name = mod.name
  const grid = 'benefits'
  const isByYear = view === 'values' || view === 'quantity' || view === 'output'
  const showAvg = view === 'output' || view === 'aahu' || (view === 'values' && mod.method === 'HU')
  const head: Tag[] = [h.th('Site'), h.th('Alternative')]
  if (isByYear) head.push(...years.map((y) => h.th(`Year ${pyG(y)}`, { class: 'num' })))
  if (showAvg) {
    head.push(h.th(single ? `Average (${aunit})` : `${name} average (${aunit})`, { class: 'num' }))
    if (single) head.push(h.th(`No Action average (${aunit})`, { class: 'num' }), h.th(`Lift (${aunit})`, { class: 'num' }))
  }
  const what = view === 'values' ? (mod.method === 'INDEX_X_QUANTITY' ? 'index' : unit) : view === 'quantity' ? 'quantity' : ''
  const rows: Tag[] = []
  const matrix: (string | null)[][] = []
  for (const s of p.sites) {
    const na = noAction(s)
    const naBl = na ? res.benefits.get(lineKey(s.id, na.id)) ?? null : null
    for (const a of s.alternatives) {
      const r = matrix.length
      const mv = valuesFor(a, mod.id)
      const bl = res.benefits.get(lineKey(s.id, a.id)) ?? null
      const series = bl ? bl.series.get(mod.id) ?? null : null
      const who = `${s.id}, ${altLabel(a)}`
      const where = `${s.id} ${altLabel(a)}`
      const cells: Tag[] = [h.td(s.id, { class: 'lbl site' }), h.td(altLabel(a), { class: 'lbl' })]
      const paths: string[] = []
      if (view === 'output') {
        for (let k = 0; k < years.length; k++) cells.push(h.td(num(series && k < series.length ? series[k] : null, 3), { class: 'calc' }))
      } else if (isByYear) {
        const vals = mv ? [...(view === 'values' ? mv.values : mv.quantity)] : []
        for (const [k, y] of years.entries()) {
          const x = k < vals.length ? vals[k] : null
          const path = `b|${s.id}|${a.id}|${mod.id}|${view}|${k}`
          paths.push(path)
          cells.push(h.td(cell(path, show(x), grid, r, k, `${who}, year ${pyG(y)}, ${name} ${what}`, { required: true, exact: v(x) })))
        }
      }
      if (view === 'aahu') {
        const path = `b|${s.id}|${a.id}|${mod.id}|aahu`
        paths.push(path)
        cells.push(h.td(cell(path, v(mv ? mv.aahu : null), grid, r, 0, `${who}, ${name} average`, { required: true })))
      } else if (showAvg) {
        const avg = bl ? bl.aahu_by_module.get(mod.id) ?? null : null
        cells.push(h.td(num(avg, 3), { class: 'calc', title: avgTip(p, single ? where : `${where}, ${name}`, series, avg) }))
      }
      if (showAvg && single) cells.push(...liftCells(where, bl, naBl))
      rows.push(h.tr(...cells, { class: a.is_no_action ? 'is-na' : null }))
      matrix.push(paths)
    }
  }
  const table = h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-grid', 'aria-label': `${name} outputs` })
  return [h.div(table, { class: 'ce-grid-wrap' }), matrix]
}

interface Line { aahu: number | null, lift: number | null }

/** No Action's total and the lift, each with the arithmetic on hover. */
function liftCells(where: string, bl: Line | null, naBl: Line | null): Tag[] {
  const total = bl ? bl.aahu : null
  const naTotal = naBl ? naBl.aahu : null
  const lift = bl ? bl.lift : null
  const known = lift !== null && total !== null && naTotal !== null
  return [h.td(num(naTotal, 3), { class: 'calc', title: "The site's No Action total, the baseline for lift." }),
    h.td(num(lift, 3), { class: 'calc', title: known
      ? `${where}: ${pyFixedComma(total!, 3)} minus No Action's ${pyFixedComma(naTotal!, 3)} = ${pyFixedComma(lift!, 3)}.` : null })]
}

/** Every alternative's result: each module's average, their sum and the lift over the site's No
 * Action total, with each step on screen. */
export function totalsGrid(res: AnalysisResults): [Tag, (string | null)[][]] {
  const p = res.project
  const mods = p.benefits.modules
  const aunit = p.labels.annual_output_short
  const head: Tag[] = [h.th('Site'), h.th('Alternative'), ...mods.map((m) => h.th(`${m.name} (${aunit})`, { class: 'num' })),
    h.th(`Total (${aunit})`, { class: 'num' }), h.th(`No Action total (${aunit})`, { class: 'num' }), h.th(`Lift (${aunit})`, { class: 'num' })]
  const rows: Tag[] = []
  for (const s of p.sites) {
    const na = noAction(s)
    const naBl = na ? res.benefits.get(lineKey(s.id, na.id)) ?? null : null
    for (const a of s.alternatives) {
      const bl = res.benefits.get(lineKey(s.id, a.id)) ?? null
      const where = `${s.id} ${altLabel(a)}`
      const cells: Tag[] = [h.td(s.id, { class: 'lbl site' }), h.td(altLabel(a), { class: 'lbl' })]
      const parts: string[] = []
      for (const m of mods) {
        const avg = bl ? bl.aahu_by_module.get(m.id) ?? null : null
        if (avg !== null) parts.push(pyFixedComma(avg, 3))
        let tip: string
        if (byYear(m)) tip = avgTip(p, `${where}, ${m.name}`, bl ? bl.series.get(m.id) : null, avg)
        else tip = avg !== null ? `${where}, ${m.name}: entered as an average, ${pyFixedComma(avg, 3)}.` : `${where}, ${m.name}: not entered yet.`
        cells.push(h.td(num(avg, 3), { class: 'calc', title: tip }))
      }
      const total = bl ? bl.aahu : null
      cells.push(h.td(num(total, 3), { class: 'calc is-strong',
        title: total !== null && parts.length === mods.length ? `${where}: ${parts.join(' + ')} = ${pyFixedComma(total, 3)}.` : null }))
      cells.push(...liftCells(where, bl, naBl))
      rows.push(h.tr(...cells, { class: a.is_no_action ? 'is-na' : null }))
    }
  }
  const table = h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-grid', 'aria-label': 'Totals and lift' })
  return [h.div(table, { class: 'ce-grid-wrap' }), []]
}

export function costsGrid(res: AnalysisResults): [Tag, (string | null)[][]] {
  const p = res.project
  const cats = p.cost_categories
  const grid = 'costs'
  const head: Tag[] = [h.th('Site'), h.th('Alternative'), ...cats.map((c) => h.th(c.name + (c.idc_applies ? ' *' : ''), { class: 'num' })),
    h.th('Construction months', { class: 'num' }), h.th('Average annual cost entered', { class: 'num' }),
    h.th('Interest during construction', { class: 'num' }), h.th('OMRRR present value', { class: 'num' }),
    h.th('Average annual cost', { class: 'num' })]
  const rows: Tag[] = []
  const matrix: (string | null)[][] = []
  for (const s of p.sites) {
    for (const a of s.alternatives) {
      const r = matrix.length
      const paths: string[] = []
      const cells: Tag[] = [h.td(s.id, { class: 'lbl site' }), h.td(altLabel(a), { class: 'lbl' })]
      let c = 0
      for (const cat of cats) {
        const path = `c|${s.id}|${a.id}|first|${cat.id}`
        paths.push(path)
        cells.push(h.td(cell(path, v(a.costs.first_costs.get(cat.id) ?? null), grid, r, c, `${s.id}, ${altLabel(a)}, ${cat.name}`)))
        c += 1
      }
      let path = `c|${s.id}|${a.id}|months`
      paths.push(path)
      cells.push(h.td(cell(path, v(a.costs.construction_months), grid, r, c, `${s.id}, ${altLabel(a)}, construction months`)))
      c += 1
      path = `c|${s.id}|${a.id}|override`
      paths.push(path)
      cells.push(h.td(cell(path, v(a.costs.annual_override), grid, r, c, `${s.id}, ${altLabel(a)}, average annual cost entered`)))
      const cl = res.costs.get(lineKey(s.id, a.id)) ?? null
      cells.push(h.td(money(cl ? cl.idc : null), { class: 'calc' }),
        h.td(money(cl ? pySum(cl.recurring_pv.values()) : null), { class: 'calc' }),
        h.td(money(cl ? cl.annual : null), { class: 'calc' }))
      rows.push(h.tr(...cells))
      matrix.push(paths)
    }
  }
  return [h.div(h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-grid', 'aria-label': 'First costs' }),
    { class: 'ce-grid-wrap' }), matrix]
}

export const BASIS_LABELS = [['FIXED', 'Amount'], ['PERCENT', 'Percent of first cost'], ['RATE', 'Rate x quantity']] as const
export const BASIS_CODE: Readonly<Record<string, string>> = { FIXED: 'FIXED', PCT_OF_CATEGORY: 'PERCENT', RATE_X_QUANTITY: 'RATE' }

/** OMRRR items. The paste matrix follows the visible columns, the two selects included, so a block
 * copied from Excel lands where it looks like it will. Fields the basis does not use are shown blank
 * and cannot be typed in; a pasted value there is kept for a later basis change. */
export function recurringGrid(res: AnalysisResults): [Tag, (string | null)[][]] {
  const p = res.project
  const grid = 'omrrr'
  const cats = p.cost_categories
  const head: Tag[] = [h.th('Site'), h.th('Alternative'), h.th('Item'), h.th('Basis'), h.th('Amount', { class: 'num' }),
    h.th('Percent', { class: 'num' }), h.th('Of'), h.th('Unit rate', { class: 'num' }), h.th('Quantity', { class: 'num' }),
    h.th('Every N years', { class: 'num' }), h.th('First year', { class: 'num' }), h.th('Last year', { class: 'num' }),
    h.th('Amount per time', { class: 'num' }), h.th('Present value', { class: 'num' }), h.th('')]
  const rows: Tag[] = []
  const matrix: (string | null)[][] = []
  const order = ['name', 'basis', 'amount', 'percent', 'category_id', 'unit_rate', 'quantity', 'every_years', 'first_year', 'last_year']
  for (const s of p.sites) {
    for (const a of s.alternatives) {
      const cl = res.costs.get(lineKey(s.id, a.id)) ?? null
      for (const it of a.costs.recurring) {
        const r = matrix.length
        const base = `r|${s.id}|${a.id}|${it.id}`
        const code = BASIS_CODE[it.basis]
        const who = `${s.id}, ${altLabel(a)}, ${it.name}`
        const uses: Record<string, boolean> = { amount: code === 'FIXED', percent: code === 'PERCENT', category_id: code === 'PERCENT',
          unit_rate: code === 'RATE', quantity: code === 'RATE' }
        const values: Record<string, string> = {
          name: it.name, amount: v(it.amount), percent: v(it.percent * 100), unit_rate: v(it.unit_rate), quantity: v(it.quantity),
          every_years: String(it.every_years), first_year: it.first_year === null ? '' : String(it.first_year),
          last_year: it.last_year === null ? '' : String(it.last_year),
        }
        const tds: Tag[] = []
        for (const [c, f] of order.entries()) {
          const path = `${base}|${f}`
          if (f === 'basis') {
            tds.push(h.td(h.select(...BASIS_LABELS.map(([val, lbl]) => h.option(lbl, { value: val, selected: val === code || null })),
              { class: 'form-select form-select-sm', 'aria-label': `${who}, basis` }, ev('cell', { path })), { style: 'min-width:170px;padding:2px' }))
          } else if (!(uses[f] ?? true)) {
            tds.push(h.td('', { class: 'calc', title: 'Not used by this basis' }))
          } else if (f === 'category_id') {
            tds.push(h.td(h.select(...cats.map((ct) => h.option(ct.name, { value: ct.id, selected: ct.id === it.category_id || null })),
              { class: 'form-select form-select-sm', 'aria-label': `${who}, first cost` }, ev('cell', { path })), { style: 'min-width:170px;padding:2px' }))
          } else {
            tds.push(h.td(cell(path, values[f], grid, r, c, `${who}, ${f.replace(/_/g, ' ')}`, { text: f === 'name' }),
              { style: f === 'name' ? 'min-width:210px' : null }))
          }
        }
        const amt = cl ? cl.recurring_amounts.get(it.id) ?? null : null
        const pv = cl ? cl.recurring_pv.get(it.id) ?? null : null
        rows.push(h.tr(h.td(s.id, { class: 'lbl site' }), h.td(altLabel(a), { class: 'lbl' }), ...tds,
          h.td(money(amt), { class: 'calc' }), h.td(money(pv), { class: 'calc' }),
          h.td(h.button('Remove', { type: 'button', class: 'ce-link', style: 'padding:0 8px' },
            ev('remove_item', { site: s.id, alt: a.id, item: it.id })))))
        matrix.push(order.map((f) => `${base}|${f}`))
      }
    }
  }
  const body = rows.length ? h.tbody(...rows)
    : h.tbody(h.tr(h.td('No recurring items yet.', { colspan: '15', class: 'lbl', style: 'color:var(--ce-text-muted)' })))
  return [h.div(h.table(h.thead(h.tr(...head)), body, { class: 'ce-grid', 'aria-label': 'OMRRR items' }), { class: 'ce-grid-wrap' }), matrix]
}

export function sitesGrid(res: AnalysisResults): [Tag, (string | null)[][]] {
  const p = res.project
  const grid = 'sites'
  const head: Tag[] = [h.th('Site'), h.th('Alternative'), h.th('Name'), h.th('Description'), h.th('')]
  const rows: Tag[] = []
  const matrix: (string | null)[][] = []
  for (const s of p.sites) {
    let r = matrix.length
    rows.push(h.tr(
      h.td(cell(`id|${s.id}`, s.id, grid, r, 90, `Site ID ${s.id}`, { text: true }), { style: 'min-width:110px' }),
      h.td('', { class: 'lbl' }),
      h.td(cell(`t|${s.id}|name`, s.name, grid, r, 0, `Site ${s.id} name`, { text: true }), { style: 'min-width:240px' }),
      h.td(cell(`t|${s.id}|description`, s.description, grid, r, 1, `Site ${s.id} description`, { text: true }), { style: 'min-width:360px' }),
      h.td(h.button('Add alternative', { type: 'button', class: 'ce-link', style: 'padding:0 8px' }, ev('add_alt', { site: s.id })),
        h.button('Remove site', { type: 'button', class: 'ce-link', style: 'padding:0 8px;color:var(--ce-err)', 'data-confirm': 'Remove the site?' },
          ev('remove_site', { site: s.id }))),
      { class: 'is-site' }))
    matrix.push([`t|${s.id}|name`, `t|${s.id}|description`])
    for (const a of s.alternatives) {
      r = matrix.length
      rows.push(h.tr(
        h.td('', { class: 'lbl' }),
        h.td(cell(`id|${s.id}|${a.id}`, a.id, grid, r, 91, `Alternative ID ${a.id} at ${s.id}`, { text: true }), { style: 'min-width:130px' }),
        h.td(cell(`t|${s.id}|${a.id}|name`, a.name, grid, r, 0, `${s.id} ${a.id} name`, { text: true }), { style: 'min-width:240px' }),
        h.td(cell(`t|${s.id}|${a.id}|description`, a.description, grid, r, 1, `${s.id} ${a.id} description`, { text: true })),
        h.td(a.is_no_action ? null : h.button('Remove', { type: 'button', class: 'ce-link', style: 'padding:0 8px', 'data-confirm': 'Remove?' },
          ev('remove_alt', { site: s.id, alt: a.id })))))
      matrix.push([`t|${s.id}|${a.id}|name`, `t|${s.id}|${a.id}|description`])
    }
  }
  return [h.div(h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-grid', style: 'width:100%', 'aria-label': 'Sites and alternatives' }),
    { class: 'ce-grid-wrap' }), matrix]
}

/** STAF function scores and the quantity of one STAF module, for one site and alternative, with the
 * sub-indices and the ECI worked out below. Functions not assessed at the site keep their scores but
 * cannot be edited, and a pasted block skips them. */
export function stafGrid(res: AnalysisResults, moduleId: string | null, siteId: string | null, altId: string | null): [Tag, (string | null)[][]] {
  const p = res.project
  const years = p.benefits.target_years
  const grid = 'staf'
  const mods = p.benefits.modules.filter((m) => m.method === 'STAF')
  const mod = mods.find((m) => m.id === moduleId) ?? (mods.length ? mods[0] : null)
  if (mod === null) return [h.p('This study has no STAF module.', { class: 'ce-note' }), []]
  const site = siteId ? siteOf(p, siteId) : (p.sites.length ? p.sites[0] : null)
  if (site === null) return [h.p('Add a site first.', { class: 'ce-note' }), []]
  let alt = altId ? alternativeOf(site, altId) : null
  alt = alt ?? (site.alternatives.length ? site.alternatives[0] : null)
  if (alt === null) return [h.p('Add alternatives first.', { class: 'ce-note' }), []]
  const rolls = stafRollups(p, site, alt, mod.id)
  const off = new Set(notAssessed(site, mod.id))
  const mv = valuesFor(alt, mod.id)
  const head: Tag[] = [h.th('Function'), ...years.map((y) => h.th(`Year ${pyG(y)}`, { class: 'num' }))]
  const rows: Tag[] = []
  const matrix: (string | null)[][] = []
  let cat: string | null = null
  const scores = mv ? mv.scores : new Map<string, readonly (number | null)[]>()
  for (const f of staf.functions()) {
    if (f.category !== cat) {
      cat = f.category
      rows.push(h.tr(h.td(cat, { colspan: String(years.length + 1), class: 'lbl site' }), { class: 'is-site' }))
    }
    const r = matrix.length
    const vals = scores.get(f.id) ?? []
    const on = !off.has(f.id)
    const check = h.input({ type: 'checkbox', checked: on || null, class: 'ce-assessed', 'aria-label': `${f.name} assessed at ${site.id}`,
      title: 'Assessed at this site (applies to every alternative)' }, ev('staf_assessed', { site: site.id, fn: f.id, module: mod.id }))
    const cells: Tag[] = [h.td(h.label(check, ' ', f.name, { class: 'ce-fn' }), !on ? h.span(' not assessed', { class: 'ce-muted' }) : null,
      { class: 'lbl', title: f.short_description })]
    const paths: (string | null)[] = []
    for (const [k, y] of years.entries()) {
      const x = k < vals.length ? vals[k] : null
      const path = `f|${site.id}|${alt.id}|${mod.id}|${f.id}|${k}`
      if (on) {
        paths.push(path)
        cells.push(h.td(cell(path, v(x), grid, r, k, `${f.name}, year ${pyG(y)}`, { required: true })))
      } else {
        paths.push(null)
        cells.push(h.td(v(x), { class: 'calc', title: 'Not assessed at this site' }))
      }
    }
    rows.push(h.tr(...cells, { class: on ? null : 'is-off' }))
    matrix.push(paths)
  }
  const r = matrix.length
  const q = mv ? mv.quantity : []
  const qpaths = years.map((_, k) => `b|${site.id}|${alt!.id}|${mod.id}|quantity|${k}`)
  const units = mod.quantity_units
  rows.push(h.tr(h.td(units ? `Quantity (${units})` : 'Quantity', { class: 'lbl site' }),
    ...qpaths.map((qp, k) => h.td(cell(qp, v(k < q.length ? q[k] : null), grid, r, k, `Quantity, year ${pyG(years[k])}`, { required: true }))),
    { class: 'is-site' }))
  matrix.push(qpaths)
  const lines: [string, (ro: staf.Rollup) => number | null][] = [
    ['Physical', (ro) => ro.sub_indices.physical], ['Chemical', (ro) => ro.sub_indices.chemical],
    ['Biological', (ro) => ro.sub_indices.biological], ['Ecosystem Condition Index', (ro) => ro.eci]]
  for (const [label, get] of lines) {
    rows.push(h.tr(h.td(label, { class: 'lbl', style: 'font-weight:600' }), ...rolls.map((ro) => h.td(num(get(ro), 2), { class: 'calc' }))))
  }
  const table = h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-grid', 'aria-label': `${mod.name}: STAF function scores` })
  return [h.div(table, { class: 'ce-grid-wrap', style: 'max-height:none' }), matrix]
}
