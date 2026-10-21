// The input template (ceica/workbook/template.py): a plain workbook for entering a study in Excel, read
// back by headers (the reading comes with the importer).
//
// Sheets: Study (setting, value), Modules (name, method, quantity units), Alternatives (one row per site
// alternative), Benefits (one row per alternative and module), STAF scores and STAF assessed for STAF
// modules, Costs (first-cost categories, construction months, optional average annual cost) and OMRRR
// (recurring items).
import { type CellValue, DataValidation, Workbook } from '../../files/xlsx/book'
import { PyFloat, pyFloatOf, pyStrOf, pyTruthyOf, type ReadBook, type ReadSheet, type XlValue } from '../../files/xlsx/read'
import { pyG } from '../../py/pyfmt'
import { pyStrip, pyStrRepr, PyValueError } from '../../py/pystr'
import * as staf from '../benefits/staf'
import {
  type Alternative, averageAnnual, byYear, construct, copy, type CostCategory, type Costs, DEFAULT_COST_CATEGORIES, defaultLabels,
  type Labels, type Module, type ModuleValues, notAssessed, type Project, type RecurringItem, type Settings, type Site, type BenefitSpec,
  PydanticError, valuesFor,
} from '../model'
import { type ImportResult, OverflowError, WorkbookError } from './importer'
import { FMT_RATE, Sheet } from './xl'

export const SH_STUDY = 'Study'
export const SH_MODS = 'Modules'
export const SH_ALTS = 'Alternatives'
export const SH_BEN = 'Benefits'
export const SH_COSTS = 'Costs'
export const SH_OM = 'OMRRR'
export const SH_STAF = 'STAF scores'
export const SH_ASSESSED = 'STAF assessed'

/** Method codes and the words a person may type for them. */
export const METHOD_OUT: Readonly<Record<string, string>> = {
  HU: 'Habitat units', INDEX_X_QUANTITY: 'Index x quantity', STAF: 'STAF function scores', AAHU: 'Average annual value',
}
export const BASIS_OUT: Readonly<Record<string, string>> = { FIXED: 'FIXED', PCT_OF_CATEGORY: 'PERCENT', RATE_X_QUANTITY: 'RATE' }

const blank = (mid: string): ModuleValues => ({ module_id: mid, values: [], quantity: [], scores: new Map(), aahu: null })

/** A template workbook holding the project's inputs (blank sheets for an empty project). */
export function buildTemplate(project: Project): Uint8Array {
  const wb = new Workbook()
  wb.remove(wb.sheets[wb.active])
  const spec = project.benefits
  const mods = [...spec.modules]
  const years = [...spec.target_years]

  const st = new Sheet(wb, wb.createSheet(SH_STUDY), SH_STUDY)
  st.title('CEICA input template', 'Fill the sheets, then open this file in CEICA (Open a file). Keep the header rows.')
  st.head(1, 4, 'Setting', { width: 34 })
  st.head(2, 4, 'Value', { width: 40 })
  const rows: [string, CellValue][] = [['Study name', project.name], ['Description', project.description],
    ['Discount rate', project.settings.discount_rate],
    ['Period of analysis (years)', project.settings.period_of_analysis],
    ['Price level', project.settings.price_level],
    ['Target years (comma separated)', years.map((y) => pyG(y)).join(', ')],
    ['Output name', project.labels.output_name],
    ['Output abbreviation', project.labels.output_short],
    ['STAF mapping (A or B)', spec.staf_mapping]]
  rows.forEach(([label, value], k) => {
    st.text(1, 5 + k, label)
    st.inp(2, 5 + k, value, { fmt: label === 'Discount rate' ? FMT_RATE : null })
  })

  const mo = new Sheet(wb, wb.createSheet(SH_MODS), SH_MODS)
  mo.title('Modules', 'The parts the output is built from; the output is their sum. Method: Habitat units, Index x quantity, STAF '
    + 'function scores or Average annual value (STAF modules cannot be mixed with the others).')
  ;([['Name', 28], ['Method', 24], ['Quantity units', 16], ['Id', 14]] as const).forEach(([t, w], k) => mo.head(1 + k, 4, t, { width: w }))
  mods.forEach((m, k) => {
    ;[m.name, METHOD_OUT[m.method], m.quantity_units, m.id].forEach((v, c) => mo.inp(c + 1, 5 + k, v))
  })
  const dvm = new DataValidation({ type: 'list', formula1: '"' + Object.values(METHOD_OUT).join(',') + '"', allowBlank: true })
  mo.ws.addValidation(dvm)
  dvm.add('B5:B200')

  const al = new Sheet(wb, wb.createSheet(SH_ALTS), SH_ALTS)
  al.title('Alternatives', 'One row per alternative, including one No Action row per site.')
  ;([['Site', 10], ['Site name', 28], ['Alternative', 14], ['Alternative name', 22], ['Description', 50], ['No Action', 10]] as const)
    .forEach(([t, w], k) => al.head(1 + k, 4, t, { width: w }))
  let r = 5
  for (const s of project.sites) {
    for (const a of s.alternatives) {
      ;[s.id, s.name, a.id, a.name, a.description, a.is_no_action ? 'Yes' : 'No'].forEach((v, c) => al.inp(1 + c, r, v))
      r++
    }
  }
  const dv = new DataValidation({ type: 'list', formula1: '"Yes,No"', allowBlank: true })
  al.ws.addValidation(dv)
  dv.add('F5:F2000')

  const plain = mods.filter((m) => m.method !== 'STAF')
  if (plain.length) {
    const yearly = plain.some(byYear)
    const ixq = plain.some((m) => m.method === 'INDEX_X_QUANTITY')
    const annual = plain.some((m) => m.method === 'AAHU')
    const be = new Sheet(wb, wb.createSheet(SH_BEN), SH_BEN)
    be.title('Benefits', 'One row per alternative and module. Year columns: the output (habitat-unit modules) or the index '
      + '(index-x-quantity modules); Quantity columns: the quantity; Average: the average annual value (average-annual modules).')
    const heads = ['Site', 'Alternative', 'Module']
    if (yearly) heads.push(...years.map((y) => pyG(y)))
    if (ixq) heads.push(...years.map((y) => `Quantity ${pyG(y)}`))
    if (annual) heads.push('Average')
    heads.forEach((t, k) => be.head(1 + k, 4, t, { width: k > 2 ? 12 : 14 }))
    r = 5
    for (const s of project.sites) {
      for (const a of s.alternatives) {
        for (const m of plain) {
          const mv = valuesFor(a, m.id) ?? blank(m.id)
          const vals: CellValue[] = [s.id, a.id, m.name]
          if (yearly) vals.push(...years.map((_, k) => (k < mv.values.length ? mv.values[k] : null)))
          if (ixq) vals.push(...years.map((_, k) => (k < mv.quantity.length ? mv.quantity[k] : null)))
          if (annual) vals.push(mv.aahu)
          vals.forEach((v, c) => be.inp(1 + c, r, v))
          r++
        }
      }
    }
  }
  const stafMods = mods.filter((m) => m.method === 'STAF')
  if (stafMods.length) {
    const sf = new Sheet(wb, wb.createSheet(SH_STAF), SH_STAF)
    sf.title('STAF scores', 'One row per alternative, module and target year: function scores 0 to 15 and the quantity (stream length '
      + 'or area).')
    const fids = staf.functionIds()
    const heads = ['Site', 'Alternative', 'Module', 'Year', 'Quantity', ...staf.functions().map((f) => f.name)]
    heads.forEach((t, k) => sf.head(1 + k, 4, t, { width: k > 4 ? 10 : 12 }))
    fids.forEach((fid, k) => sf.put(6 + k, 3, fid))
    r = 5
    for (const s of project.sites) {
      for (const a of s.alternatives) {
        for (const m of stafMods) {
          const mv = valuesFor(a, m.id) ?? blank(m.id)
          years.forEach((y, yi) => {
            const q = yi < mv.quantity.length ? mv.quantity[yi] : null
            const vals: CellValue[] = [s.id, a.id, m.name, y, q]
            for (const fid of fids) {
              const sc = mv.scores.get(fid) ?? []
              vals.push(yi < sc.length ? sc[yi] : null)
            }
            vals.forEach((v, c) => sf.inp(1 + c, r, v))
            r++
          })
        }
      }
    }
    const sa = new Sheet(wb, wb.createSheet(SH_ASSESSED), SH_ASSESSED)
    sa.title('STAF assessed', '1 where the function was assessed at the site, 0 where it was not (left out of both sums).')
    const aheads = ['Site', 'Module', ...staf.functions().map((f) => f.name)]
    aheads.forEach((t, k) => sa.head(1 + k, 4, t, { width: k > 1 ? 10 : 14 }))
    r = 5
    for (const s of project.sites) {
      for (const m of stafMods) {
        const off = new Set(notAssessed(s, m.id))
        ;[s.id, m.name, ...fids.map((fid) => (off.has(fid) ? 0 : 1))].forEach((v, c) => sa.inp(c + 1, r, v))
        r++
      }
    }
  }

  const co = new Sheet(wb, wb.createSheet(SH_COSTS), SH_COSTS)
  co.title('Costs', 'First costs by category (base-year dollars), construction months, and an optional average annual cost that '
    + 'replaces the computation.')
  const cats = [...project.cost_categories]
  const cheads = ['Site', 'Alternative', ...cats.map((c) => c.name), 'Construction months', 'Average annual cost entered']
  cheads.forEach((t, k) => co.head(1 + k, 4, t, { width: 15 }))
  cats.forEach((c, k) => co.put(3 + k, 3, c.id))
  r = 5
  for (const s of project.sites) {
    for (const a of s.alternatives) {
      const vals: CellValue[] = [s.id, a.id, ...cats.map((c) => a.costs.first_costs.get(c.id) ?? null)]
      vals.push(a.costs.construction_months, a.costs.annual_override)
      vals.forEach((v, c) => co.inp(1 + c, r, v))
      r++
    }
  }

  const om = new Sheet(wb, wb.createSheet(SH_OM), SH_OM)
  om.title('OMRRR', 'Recurring costs. Basis: FIXED (Amount), PERCENT (Percent of a Category\'s first cost) or RATE (Unit rate x '
    + 'Quantity). Blank first year: every N years.')
  ;([['Site', 10], ['Alternative', 14], ['Item', 28], ['Basis', 10], ['Amount', 12], ['Percent', 10], ['Category', 16], ['Unit rate', 10],
    ['Quantity', 12], ['Every N years', 10], ['First year', 10], ['Last year', 10]] as const)
    .forEach(([t, w], k) => om.head(1 + k, 4, t, { width: w }))
  r = 5
  for (const s of project.sites) {
    for (const a of s.alternatives) {
      for (const it of a.costs.recurring) {
        const vals: CellValue[] = [s.id, a.id, it.name, BASIS_OUT[it.basis], it.amount || null, it.percent || null, it.category_id,
          it.unit_rate || null, it.quantity || null, it.every_years, it.first_year, it.last_year]
        vals.forEach((v, c) => om.inp(1 + c, r, v))
        r++
      }
    }
  }
  const dv2 = new DataValidation({ type: 'list', formula1: '"FIXED,PERCENT,RATE"', allowBlank: true })
  om.ws.addValidation(dv2)
  dv2.add('D5:D5000')
  return wb.save()
}

// --- reading ---------------------------------------------------------------------------------------------
//
// The sheets are read by their column headers, matched without regard to case, spacing or punctuation,
// with the Utoy CSV names (ReachID, SiteAction, Project_First, Duration_mo, Monitoring, AdMan) as aliases.
// Templates saved before modules existed (a Study "Benefit mode" row and a Component column) still read.
// Every value keeps the type openpyxl gave it, and every error is the Python's.

/** Method codes from the words a person may type for them. */
const METHOD_IN: Readonly<Record<string, string>> = {
  hu: 'HU', habitatunits: 'HU', output: 'HU', indexxquantity: 'INDEX_X_QUANTITY', indexbyquantity: 'INDEX_X_QUANTITY',
  index: 'INDEX_X_QUANTITY', staf: 'STAF', staffunctionscores: 'STAF', aahu: 'AAHU', averageannualvalue: 'AAHU', averageannual: 'AAHU',
  annual: 'AAHU', aahudirect: 'AAHU',
}
const BASIS_IN: Readonly<Record<string, string>> = {
  FIXED: 'FIXED', AMOUNT: 'FIXED', PERCENT: 'PCT_OF_CATEGORY', PCT: 'PCT_OF_CATEGORY', PCT_OF_CATEGORY: 'PCT_OF_CATEGORY',
  RATE: 'RATE_X_QUANTITY', RATE_X_QUANTITY: 'RATE_X_QUANTITY',
}
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  site: ['site', 'reachid', 'siteid', 'reach'], sitename: ['sitename'],
  alternative: ['alternative', 'siteaction', 'alt', 'alternativeid', 'action'], alternativename: ['alternativename', 'name'],
  description: ['description'], noaction: ['noaction', 'isnoaction', 'fwop'], module: ['module', 'component'],
  method: ['method', 'howoutputsareentered'], units: ['quantityunits', 'units'], id: ['id', 'moduleid'],
  average: ['average', 'averageannualvalue'], modulename: ['name', 'modulename', 'module'],
  months: ['constructionmonths', 'durationmo', 'months', 'duration'], annual: ['averageannualcostentered', 'averageannualcost', 'annualcost'],
  item: ['item'], basis: ['basis'], amount: ['amount'], percent: ['percent'], category: ['category'], unitrate: ['unitrate'],
  quantity: ['quantity'], every: ['everynyears', 'every', 'frequency'], first: ['firstyear'], last: ['lastyear'], year: ['year'],
  aahu: ['aahu', 'averageannualoutput'],
}
const COST_ALIASES: Readonly<Record<string, readonly string[]>> = {
  construction: ['construction', 'projectfirst', 'constructioncost'], monitoring: ['monitoring', 'monitoringcost'],
  adaptive_management: ['adaptivemanagement', 'adman', 'adaptivemanagementcost'],
}
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/

/** norm(text): lowercase letters and digits only (str(text or "")) */
export function norm(v: XlValue): string {
  return (pyTruthyOf(v) ? pyStrOf(v) : '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** _s: text, a whole float as an int ("5", not "5.0") */
function sv(v: XlValue): string {
  if (v === null) return ''
  if (v instanceof PyFloat && Number.isInteger(v.value)) return BigInt(v.value).toString()
  return pyStrip(pyStrOf(v))
}

/** _f: a number, or None for a blank (",", "$" and "%" dropped from text) */
function fv(v: XlValue): number | null {
  if (v === null || (typeof v === 'string' && !pyStrip(v))) return null
  if (typeof v === 'string') v = pyStrip(v.replaceAll(',', '').replaceAll('$', '').replaceAll('%', ''))
  return pyFloatOf(v)
}

/** int(x) of a float: toward zero, and Python's errors for NaN and infinity */
function intOf(x: number): number {
  if (Number.isNaN(x)) throw new PyValueError('cannot convert float NaN to integer')
  if (!Number.isFinite(x)) throw new OverflowError('cannot convert float infinity to integer')
  return Math.trunc(x) + 0
}

/** _opt_int */
function optInt(v: XlValue): number | null {
  const x = fv(v)
  return x === null ? null : intOf(x)
}

/** Python's truth of a float (NaN is true) */
const truthy = (x: number | null): x is number => x !== null && x !== 0

/** ``x or y`` for a number that may be None or 0 */
const orNum = (x: number | null, y: number): number => (truthy(x) ? x : y)

/** _module_id: an id from a module's name, unique, at most 32 characters */
function moduleId(name: string, taken: ReadonlySet<string>): string {
  let base = name.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 28) || 'M'
  if (!/^[\p{L}\p{N}]/u.test(base)) base = 'M' + base
  let mid = base
  let k = 2
  while (taken.has(mid)) {
    mid = `${base}-${k}`
    k++
  }
  return mid
}

/** a sheet's table: its header row and the columns by normalized header */
class Table {
  readonly headerRow: number
  readonly cols = new Map<string, number>()
  readonly raw = new Map<number, string>()

  constructor(readonly ws: ReadSheet) {
    this.headerRow = this.findHeader()
    for (let c = 1; c <= ws.maxColumn; c++) {
      const v = ws.cell(this.headerRow, c).value
      if (v !== null && pyStrip(pyStrOf(v))) {
        const n = norm(v)
        if (!this.cols.has(n)) this.cols.set(n, c)
        this.raw.set(c, pyStrip(pyStrOf(v)))
      }
    }
  }

  private findHeader(): number {
    const last = Math.min(this.ws.maxRow, 30)
    for (let r = 1; r <= last; r++) {
      const vals: string[] = []
      for (let c = 1; c < 8; c++) vals.push(norm(this.ws.cell(r, c).value))
      if (vals.some((v) => ['site', 'reachid', 'setting', 'name', 'method'].includes(v))) return r
    }
    return 1
  }

  col(role: string): number | null {
    for (const name of ALIASES[role] ?? [role]) if (this.cols.has(name)) return this.cols.get(name)!
    return null
  }

  /** the rows below the header that hold anything, with their values */
  * rows(): Generator<[number, XlValue[]]> {
    const last = this.ws.maxRow
    for (let r = this.headerRow + 1; r <= last; r++) {
      const vals: XlValue[] = []
      for (let c = 1; c <= this.ws.maxColumn; c++) vals.push(this.ws.cell(r, c).value)
      if (vals.every((v) => v === null || pyStrip(pyStrOf(v)) === '')) continue
      yield [r, vals]
    }
  }

  get(vals: readonly XlValue[], role: string): XlValue {
    const c = this.col(role)
    return c && c - 1 < vals.length ? vals[c - 1] : null
  }
}

interface AltRecord {
  name: string
  description: string
  na: boolean
  values: Map<string, ModuleRecord>
  first: Map<string, number>
  months: number
  annual: number | null
  aahu: number | null
  recurring: RecurringItem[]
}
interface ModuleRecord { values: (number | null)[], quantity: (number | null)[], scores: Map<string, (number | null)[]>, aahu: number | null }

/** read_template: a template's sheets as a project. */
export function readTemplate(wb: ReadBook): ImportResult {
  const names = new Map<string, string>()
  for (const n of wb.sheetnames) names.set(norm(n), n)
  if (!names.has('alternatives')) {
    throw new WorkbookError('This workbook is neither a CEICA calculator nor a CEICA template (no Alternatives sheet).')
  }
  const sheet = (key: string): ReadSheet => wb.sheet(names.get(key)!)
  const warnings: string[] = []
  const study = new Map<string, XlValue>()
  if (names.has('study')) {
    const t = new Table(sheet('study'))
    for (const [, vals] of t.rows()) {
      if (vals.length && pyTruthyOf(vals[0])) study.set(norm(vals[0]), vals.length > 1 ? vals[1] : null)
    }
  }
  const setting = (prefix: string, dflt: XlValue = null): XlValue => {
    for (const [k, v] of study) if (k.startsWith(norm(prefix)) && v !== null && v !== '') return v
    return dflt
  }
  const yearsText = pyStrOf(setting('Target years', '0, 50'))
  const years = pyStrip(yearsText).split(/[,;\s]+/u).filter((x) => x).map((x) => pyFloatOf(x))
  let rate = fv(setting('Discount rate', new PyFloat(0.03)))
  if (rate !== null && rate > 1) rate = rate / 100.0

  // alternatives
  let t = new Table(sheet('alternatives'))
  const sites = new Map<string, { name: string, alts: Map<string, AltRecord> }>()
  for (const [r, vals] of t.rows()) {
    const sid = sv(t.get(vals, 'site'))
    const aid = sv(t.get(vals, 'alternative'))
    if (!sid || !aid) throw new WorkbookError(`Alternatives row ${r}: Site and Alternative are required.`)
    if (!sites.has(sid)) sites.set(sid, { name: sv(t.get(vals, 'sitename')), alts: new Map() })
    const s = sites.get(sid)!
    const na = ['yes', 'y', 'true', '1', 'x'].includes(norm(t.get(vals, 'noaction'))) || ['FWOP', 'NOACTION', 'NA'].includes(aid.toUpperCase())
    s.alts.set(aid, { name: sv(t.get(vals, 'alternativename')), description: sv(t.get(vals, 'description')), na, values: new Map(),
      first: new Map(), months: 0.0, annual: null, aahu: null, recurring: [] })
  }
  const alt = (sid: string, aid: string, where: string): AltRecord => {
    const a = sites.get(sid)?.alts.get(aid)
    if (!a) throw new WorkbookError(`${where}: ${sid} / ${aid} is not on the Alternatives sheet.`)
    return a
  }

  const n = years.length
  // modules: the Modules sheet, or (templates from before modules) the Study sheet's mode
  const modules = new Map<string, Module>() // by lower-case name
  let legacy: string | null = null
  if (names.has('modules')) {
    t = new Table(sheet('modules'))
    const taken = new Set<string>()
    for (const [r, vals] of t.rows()) {
      const name = sv(t.get(vals, 'modulename'))
      if (!name) continue
      const code = METHOD_IN[norm(t.get(vals, 'method')) || 'hu']
      if (code === undefined) throw new WorkbookError(`Modules row ${r}: the method must be one of ${Object.values(METHOD_OUT).join(', ')}.`)
      if (modules.has(name.toLowerCase())) throw new WorkbookError(`Modules row ${r}: ${name} is listed twice.`)
      let mid = sv(t.get(vals, 'id'))
      if (!ID_RE.test(mid) || taken.has(mid)) mid = moduleId(name, taken)
      taken.add(mid)
      modules.set(name.toLowerCase(), construct<Module>('Module', { id: mid, name, method: code, quantity_units: sv(t.get(vals, 'units')) }))
    }
    if (!modules.size) throw new WorkbookError('The Modules sheet lists no modules.')
  } else {
    legacy = pyStrip(pyStrOf(setting('Benefit mode', 'HU'))).toUpperCase()
    if (!['HU', 'INDEX_X_QUANTITY', 'AAHU_DIRECT', 'STAF'].includes(legacy)) {
      throw new WorkbookError(`Unknown benefit mode ${pyStrRepr(legacy)} on the Study sheet.`)
    }
    if (legacy === 'STAF') {
      modules.set('stream condition', construct<Module>('Module', { id: 'condition', name: 'Stream condition', method: 'STAF', quantity_units: 'mi' }))
    } else if (legacy === 'AAHU_DIRECT') modules.set('total', construct<Module>('Module', { id: 'total', name: 'Total', method: 'AAHU' }))
  }

  const moduleFor = (name: string, where: string, isStaf: boolean): Module => {
    let m: Module
    if (name && modules.has(name.toLowerCase())) m = modules.get(name.toLowerCase())!
    else if ((legacy === 'HU' || legacy === 'INDEX_X_QUANTITY') && !isStaf) {
      name = name || 'Total'
      const mid = name.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 32) || 'total' // older templates
      const made = construct<Module>('Module', { id: mid, name, method: legacy, quantity_units: legacy === 'INDEX_X_QUANTITY' ? 'acres' : '' })
      if (!modules.has(name.toLowerCase())) modules.set(name.toLowerCase(), made)
      m = modules.get(name.toLowerCase())!
    } else {
      const fits = [...modules.values()].filter((x) => (x.method === 'STAF') === isStaf)
      if (name || fits.length !== 1) throw new WorkbookError(`${where}: module ${name || '(blank)'} is not on the Modules sheet.`)
      m = fits[0]
    }
    if ((m.method === 'STAF') !== isStaf) {
      throw new WorkbookError(`${where}: ${m.name} is ` + (!isStaf ? 'a STAF module; its scores go on the STAF scores sheet.' : 'not a STAF module.'))
    }
    return m
  }
  const record = (a: AltRecord, m: Module): ModuleRecord => {
    if (!a.values.has(m.id)) a.values.set(m.id, { values: Array(n).fill(null), quantity: Array(n).fill(null), scores: new Map(), aahu: null })
    return a.values.get(m.id)!
  }

  if (names.has('benefits')) {
    t = new Table(sheet('benefits'))
    const ycols = new Map<string, number>()
    for (const [c, raw] of t.raw) {
      const mt = /^(index|quantity)?\s*(-?\p{Nd}+(\.\p{Nd}+)?)$/iu.exec(pyStrip(raw))
      if (mt) ycols.set(`${(mt[1] ?? '').toLowerCase()}|${pyFloatOf(mt[2])}`, c)
    }
    for (const [r, vals] of t.rows()) {
      const a = alt(sv(t.get(vals, 'site')), sv(t.get(vals, 'alternative')), `Benefits row ${r}`)
      const m = moduleFor(sv(t.get(vals, 'module')), `Benefits row ${r}`, false)
      const rec = record(a, m)
      years.forEach((y, yi) => {
        const cv = ycols.get(`|${y}`) || ycols.get(`index|${y}`)
        if (cv) rec.values[yi] = fv(vals[cv - 1])
        const cq = ycols.get(`quantity|${y}`)
        if (cq) rec.quantity[yi] = fv(vals[cq - 1])
      })
      if (m.method === 'AAHU') rec.aahu = fv(t.get(vals, 'average'))
    }
  }
  if (names.has('stafscores')) {
    t = new Table(sheet('stafscores'))
    const fidByCol = new Map<number, string>()
    const byName = new Map(staf.functions().map((fn) => [norm(fn.name), fn.id]))
    const ids = new Set(staf.functionIds())
    for (const [c, raw] of t.raw) {
      const fid = byName.get(norm(raw)) || (ids.has(raw) ? raw : null)
      if (fid) fidByCol.set(c, fid)
    }
    for (const [r, vals] of t.rows()) {
      const a = alt(sv(t.get(vals, 'site')), sv(t.get(vals, 'alternative')), `STAF scores row ${r}`)
      const m = moduleFor(sv(t.get(vals, 'module')), `STAF scores row ${r}`, true)
      const y = fv(t.get(vals, 'year'))
      if (y === null || !years.includes(y)) {
        throw new WorkbookError(`STAF scores row ${r}: year ${y === null ? 'None' : pyStrOf(new PyFloat(y))} is not a target year.`)
      }
      const yi = years.indexOf(y)
      const rec = record(a, m)
      rec.quantity[yi] = fv(t.get(vals, 'quantity'))
      for (const [c, fid] of fidByCol) {
        if (!rec.scores.has(fid)) rec.scores.set(fid, Array(n).fill(null))
        rec.scores.get(fid)![yi] = fv(vals[c - 1])
      }
    }
  }

  const notAssessedBySite = new Map<string, Map<string, string[]>>()
  if (names.has('stafassessed')) {
    t = new Table(sheet('stafassessed'))
    const byName = new Map(staf.functions().map((fn) => [norm(fn.name), fn.id]))
    const cols = new Map<number, string>()
    for (const [c, raw] of t.raw) if (byName.has(norm(raw))) cols.set(c, byName.get(norm(raw))!)
    for (const [r, vals] of t.rows()) {
      const sid = sv(t.get(vals, 'site'))
      if (!sites.has(sid)) throw new WorkbookError(`STAF assessed row ${r}: ${sid} is not on the Alternatives sheet.`)
      const m = moduleFor(sv(t.get(vals, 'module')), `STAF assessed row ${r}`, true)
      const off = [...cols].filter(([c]) => fv(vals[c - 1]) === 0).map(([, fid]) => fid)
      if (off.length) {
        if (!notAssessedBySite.has(sid)) notAssessedBySite.set(sid, new Map())
        notAssessedBySite.get(sid)!.set(m.id, off)
      }
    }
  }

  const cats: CostCategory[] = [...DEFAULT_COST_CATEGORIES]
  if (names.has('costs')) {
    t = new Table(sheet('costs'))
    const known = new Map(cats.map((c) => [norm(c.name), c.id]))
    for (const [cid, al] of Object.entries(COST_ALIASES)) for (const a of al) if (!known.has(a)) known.set(a, cid)
    const catCols = new Map<string, number>()
    const reserved = new Set(['site', 'alternative', 'months', 'annual', 'aahu'].flatMap((role) => ALIASES[role]))
    for (const [c, raw] of t.raw) {
      const nm = norm(raw)
      if (reserved.has(nm)) continue
      let cid = known.get(nm)
      if (cid === undefined) {
        cid = [...raw.replace(/[^A-Za-z0-9_.-]/gu, '_')].slice(0, 32).join('')
        cats.push(construct<CostCategory>('CostCategory', { id: cid, name: raw }))
        known.set(nm, cid)
      }
      catCols.set(cid, c)
    }
    for (const [r, vals] of t.rows()) {
      const a = alt(sv(t.get(vals, 'site')), sv(t.get(vals, 'alternative')), `Costs row ${r}`)
      for (const [cid, c] of catCols) {
        const v = fv(vals[c - 1])
        if (v !== null) a.first.set(cid, v)
      }
      a.months = orNum(fv(t.get(vals, 'months')), 0.0)
      a.annual = fv(t.get(vals, 'annual'))
      a.aahu = fv(t.get(vals, 'aahu'))
    }
  }
  if (names.has('omrrr')) {
    t = new Table(sheet('omrrr'))
    for (const [r, vals] of t.rows()) {
      const a = alt(sv(t.get(vals, 'site')), sv(t.get(vals, 'alternative')), `OMRRR row ${r}`)
      const basis = BASIS_IN[sv(t.get(vals, 'basis')).toUpperCase() || 'FIXED']
      if (basis === undefined) throw new WorkbookError(`OMRRR row ${r}: basis must be FIXED, PERCENT or RATE.`)
      const name = sv(t.get(vals, 'item')) || `Item ${a.recurring.length + 1}`
      const itemId = [...name.replace(/[^A-Za-z0-9_.-]/gu, '_')].slice(0, 32).join('') || 'item'
      // the keyword arguments in the Python's order, each evaluated in turn
      const kw: Record<string, unknown> = { id: itemId, name, basis }
      kw.amount = orNum(fv(t.get(vals, 'amount')), 0.0)
      kw.percent = orNum(fv(t.get(vals, 'percent')), 0.0)
      kw.category_id = sv(t.get(vals, 'category')) || null
      kw.unit_rate = orNum(fv(t.get(vals, 'unitrate')), 0.0)
      kw.quantity = orNum(fv(t.get(vals, 'quantity')), 0.0)
      const every = fv(t.get(vals, 'every'))
      kw.every_years = truthy(every) ? intOf(every) : 1
      kw.first_year = optInt(t.get(vals, 'first'))
      kw.last_year = optInt(t.get(vals, 'last'))
      a.recurring.push(construct<RecurringItem>('RecurringItem', kw))
    }
  }

  const mods: Module[] = modules.size ? [...modules.values()] : [construct<Module>('Module', { id: 'M1', name: 'Habitat' })]
  const siteObjs: Site[] = []
  for (const [sid, s] of sites) {
    const alts: Alternative[] = []
    for (const [aid, a] of s.alts) {
      const outputs: ModuleValues[] = []
      for (const m of mods) {
        const rec = a.values.get(m.id) ?? { values: [], quantity: [], scores: new Map(), aahu: null }
        let aahu = rec.aahu
        if (m.method === 'AAHU' && legacy === 'AAHU_DIRECT') aahu = a.aahu // the Costs sheet's AAHU column, older templates
        outputs.push(construct<ModuleValues>('ModuleValues', {
          module_id: m.id,
          values: m.method === 'HU' || m.method === 'INDEX_X_QUANTITY' ? [...rec.values] : [],
          quantity: m.method === 'INDEX_X_QUANTITY' || m.method === 'STAF' ? [...rec.quantity] : [],
          scores: m.method === 'STAF' ? new Map([...rec.scores].map(([fid, v]) => [fid, [...v]])) : new Map(),
          aahu: m.method === 'AAHU' ? aahu : null,
        }))
      }
      const costs = construct<Costs>('Costs', { first_costs: new Map(a.first), construction_months: a.months, recurring: [...a.recurring],
        annual_override: a.annual })
      alts.push(construct<Alternative>('Alternative', { id: aid, name: a.name || aid, description: a.description, is_no_action: a.na,
        outputs, costs }))
    }
    const off = notAssessedBySite.get(sid) ?? new Map<string, string[]>()
    siteObjs.push(construct<Site>('Site', { id: sid, name: s.name || sid, alternatives: alts,
      staf_not_assessed: new Map([...off].map(([k, v]) => [k, [...v]])) }))
  }
  let project: Project
  try {
    const name = sv(setting('Study name', 'Imported study'))
    const description = sv(setting('Description', ''))
    const discount = rate !== null ? rate : 0.03
    const period = fv(setting('Period of analysis', 50))
    const settings = construct<Settings>('Settings', { discount_rate: discount, period_of_analysis: truthy(period) ? intOf(period) : 50,
      price_level: sv(setting('Price level', '')) })
    const benefits = construct<BenefitSpec>('BenefitSpec', { target_years: years, modules: mods,
      staf_mapping: sv(setting('STAF mapping', 'A')).toUpperCase() || 'A' })
    project = construct<Project>('Project', { name, description, settings, benefits, cost_categories: cats, sites: siteObjs })
  } catch (exc) {
    // except ValueError: pydantic's errors and float()'s
    if (exc instanceof PydanticError || exc instanceof PyValueError) throw new WorkbookError(`The template could not be read: ${exc.message}`)
    throw exc
  }
  // The output's words: the first module's defaults, then the sheet's. The average annual words follow
  // from the name and abbreviation, unless an older template spells them out.
  const base = defaultLabels(mods[0].method)
  const name = sv(setting('Output name', '')) || base.output_name
  const short = sv(setting('Output abbreviation', '')) || base.output_short
  let labels: Labels = copy(base, { output_name: name, output_short: short, ...averageAnnual(name, short) })
  for (const [key, fld] of [['Average annual output name', 'annual_output_name'], ['Average annual output abbreviation', 'annual_output_short']] as const) {
    const v = setting(key)
    if (pyTruthyOf(v)) labels = copy(labels, { [fld]: sv(v) })
  }
  project = copy(project, { labels })
  return { project, changes: [], warnings, source: 'template' }
}
