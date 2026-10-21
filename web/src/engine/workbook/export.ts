// The Excel calculator (ceica/workbook/export.py and values.py): the whole analysis as live formulas, for
// documentation and review.
//
// Every input the app used is an orange cell; every result is a formula. Change an input in Excel and the
// annualization, the site-by-site CE/ICA, the watershed plans, the best buys and the final array update. A
// hidden snapshot holds the values at export: changed inputs turn yellow and the Read me banner says how
// many changed, or confirms the workbook still matches the app. The project and a layout registry are kept
// in a hidden sheet so the importer can read the workbook back exactly.
//
// Ported line by line, every cell and style in the Python's order (openpyxl numbers styles as they are
// assigned), so the workbook's bytes are the Python's.
import { type Cell, type CellValue, DataValidation, Workbook } from '../../files/xlsx/book'
import { DECISION, MUTED, NAVY, reference, type Series, scatterChart } from '../../files/xlsx/chart'
import { alignment } from '../../files/xlsx/styles'
import { pyFloat, pyG } from '../../py/pyfmt'
import { pyDumps } from '../../py/pyjson'
import { commaInt } from '../../py/pynum'
import { pyLen, pyStrip, PyValueError } from '../../py/pystr'
import { type AnalysisResults, siteRow, wsIndexOfKey } from '../analysis'
import { lineKey } from '../annualize'
import * as staf from '../benefits/staf'
import { byYear, compositionKey, dumpProject, notAssessed, noAction, type Project, type Site, valuesFor } from '../model'
import { canonicalJson, FORMAT_VERSION as PROJECT_SCHEMA, shortDigest } from '../projectfile'
import { EXCEL_PLAN_ROWS, planTable } from '../report/exhibits'
import { oneSite } from '../runState'
import { APP_VERSION, ENGINE_VERSION } from '../version'
import {
  a1, C_CHANGED, CENTER, col, FILL_CALC, FILL_SUB, FMT_FACTOR, FMT_INT, FMT_NUM2, FMT_NUM3, FMT_PCT, FMT_RATE, FMT_USD, FMT_USD2, FONT_BOLD,
  FONT_NOTE, PASSWORD, qsheet, rng, Sheet, solid, WRAP,
} from './xl'

export const FORMAT = 'ceica-calculator'
export const FORMAT_VERSION = 2
/** Largest watershed plan table written as live formulas (2^10). */
export const LIVE_PLAN_LIMIT = 1024
/** Rows reserved in the best-buy and final-array tables. */
export const LIST_ROWS = 40
export const CHUNK = 30000

const BASIS_CODE: Readonly<Record<string, string>> = { FIXED: 'FIXED', PCT_OF_CATEGORY: 'PERCENT', RATE_X_QUANTITY: 'RATE' }

export const SH_README = 'Read me'
export const SH_PARAMS = 'Parameters'
export const SH_BENEFITS = 'Benefits'
export const SH_STAF = 'STAF scores'
export const SH_STAF_ROLL = 'STAF roll-up'
export const SH_COSTS = 'Costs'
export const SH_RECUR = 'OMRRR'
export const SH_SUMMARY = 'Summary'
export const SH_SITE = 'Site CE-ICA'
export const SH_SITES = 'Sites'
export const SH_PLANS = 'Watershed plans'
export const SH_WS = 'Watershed summary'
export const SH_IWR = 'IWR input'
export const SH_CHARTS = 'Charts'
export const SH_MANIFEST = 'manifest'

/** A path into the project: keys, indices, or {module_id} for a module's values */
type PathItem = string | number | { module_id: string }

/** Where each project input lives in the workbook (for import). */
interface LayoutCell { path: PathItem[], sheet: string, cell: string, kind: string, exported?: string }

const num = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v)

type Roles = Record<string, number>

/** a tuple as a map key (Python's dicts are keyed by tuples) */
const tkey = (...parts: (string | number)[]): string => JSON.stringify(parts)

/** Formulas for one plan row of a CE/ICA block spanning rows r1..r2 (ceica_formulas). ``c`` maps roles to
 * columns: na (No Action flag), ord (ordinal), q, cc (scaled integers), dom, ce, cand, lmax, rmin, bb, rank,
 * pq, pc. ``valid`` is an optional 1/0 column. */
export function ceicaFormulas(r: number, r1: number, r2: number, c: Roles, valid: string | null = null): Record<string, string> {
  const R = (role: string): string => `$${col(c[role])}$${r1}:$${col(c[role])}$${r2}`
  const C = (role: string): string => a1(c[role], r)
  const q = C('q')
  const cc = C('cc')
  const vq = R('q')
  const vc = R('cc')
  let dom = `(${vq}=${q})*(${vc}<${cc})+(${vq}>${q})*(${vc}<=${cc})`
  if (valid) dom = `${R(valid)}*(${dom})`
  const out: Record<string, string> = {}
  out.dom = `=SUMPRODUCT(${dom})`
  const ce = `IF(OR(${C('na')}=1,${C('dom')}=0),1,0)`
  out.ce = valid ? `=IF(${C(valid)}=0,0,${ce})` : `=${ce}`
  out.cand = `=IF(AND(${C('ce')}=1,${C('na')}=0,${q}>0),1,0)`
  const x = `(${R('cand')}*(${vq}<${q}))`
  out.lmax = `=IF(${C('cand')}=1,MAX(${cc}/${q},SUMPRODUCT(MAX(((${cc}-${vc})*${x})/((${q}-${vq})*${x}+1-${x})-(1-${x})*1E+300))),0)`
  const y = `(${R('cand')}*(${vq}>${q}))`
  out.rmin = `=IF(${C('cand')}=1,SUMPRODUCT(MIN((((${vc}-${cc})*${y})/((${vq}-${q})*${y}+1-${y})+(1-${y})*1E+300))),0)`
  const bb = `IF(${C('na')}=1,1,IF(AND(${C('cand')}=1,${C('lmax')}<=${C('rmin')}),1,0))`
  out.bb = valid ? `=IF(${C(valid)}=0,0,${bb})` : `=${bb}`
  out.rank = `=IF(${C('bb')}=1,1+SUMPRODUCT(${R('bb')}*((${vq}<${q})+(${vq}=${q})*(${R('ord')}<${C('ord')}))),0)`
  out.pq = `=IF(${C('rank')}<=1,0,SUMPRODUCT((${R('rank')}=${C('rank')}-1)*${vq}))`
  out.pc = `=IF(${C('rank')}<=1,0,SUMPRODUCT((${R('rank')}=${C('rank')}-1)*${vc}))`
  return out
}

const CEICA_ROLES = ['dom', 'ce', 'cand', 'lmax', 'rmin', 'bb', 'rank', 'pq', 'pc'] as const

export class CalculatorBuilder {
  readonly wb = new Workbook()
  readonly layout: LayoutCell[] = []
  readonly sheets = new Map<string, Sheet>()
  readonly years: number[]
  readonly ny: number
  readonly altRows: [string, string][]
  readonly summaryRow = new Map<string, number>()
  readonly costRow = new Map<string, number>()
  readonly siteBlock = new Map<string, [number, number]>()
  readonly siteAltRow = new Map<string, number>()
  readonly sitesRow = new Map<string, number>()
  liveWatershed = false
  /** OMRRR sheet data rows (fixed before the Costs sheet refers to them) */
  readonly recurRows: [number, number]
  /** Sites sheet data rows */
  readonly sitesRows: [number, number]
  /** (sheet, range) of inputs to watch */
  readonly snapRanges: [string, string][] = []
  /** (sheet, range, tolerance) */
  readonly resultChecks: [string, string, number][] = []
  private yearsRow = 0
  private stafW = new Map<string, string>()
  private stafMaskRow = new Map<string, number>()
  private stafRows: { sid: string, aid: string, mid: string, k: number, row: number }[] = []
  private stafRollRow = new Map<string, number>()
  private benefitsRange: [number, number, number] = [0, 0, 0]
  private catCol = new Map<string, number>()
  private catFirst = 0
  private catLast = 0
  private costsCols: Record<string, number> = {}
  private costsRange: [number, number] = [0, 0]
  private siteRowsRange: [number, number] = [0, 0]
  planRows: [number, number] = [0, 0]
  planCols: Roles = {}
  planBits: [number, number] | null = null
  planSites: string[] = []
  planRowKeys = new Map<number, string>()
  private tspCell: [number, number] = [0, 0]

  constructor(readonly p: Project, readonly res: AnalysisResults) {
    this.wb.remove(this.wb.sheets[this.wb.active])
    this.years = [...p.benefits.target_years]
    this.ny = this.years.length
    this.altRows = p.sites.flatMap((s) => s.alternatives.map((a): [string, string] => [s.id, a.id]))
    const nItems = p.sites.reduce((n, s) => n + s.alternatives.reduce((m, a) => m + a.costs.recurring.length, 0), 0)
    this.recurRows = [5, 4 + Math.max(nItems, 1)]
    this.sitesRows = [5, 4 + Math.max(p.sites.length, 1)]
  }

  // --- helpers ---------------------------------------------------------------------------------------

  sheet(name: string): Sheet {
    let sh = this.sheets.get(name)
    if (!sh) {
      const ws = this.wb.createSheet(name)
      ws.showGridLines = false
      sh = new Sheet(this.wb, ws, name)
      this.sheets.set(name, sh)
    }
    return sh
  }

  private add(path: PathItem[], sheet: string, c: number, r: number, kind = 'number', exported?: string): void {
    const entry: LayoutCell = { path, sheet, cell: a1(c, r), kind }
    if (exported !== undefined) entry.exported = exported
    this.layout.push(entry)
  }

  /** Row of a site on the Sites sheet (fixed: sites in project order from row 5). */
  private sitesRowOf(siteId: string): number {
    return this.sitesRows[0] + this.p.sites.findIndex((s) => s.id === siteId)
  }

  private watch(sheet: string, c1: number, r1: number, c2: number, r2: number): void {
    if (r2 >= r1 && c2 >= c1) this.snapRanges.push([sheet, rng(c1, r1, c2, r2, { absolute: false })])
  }

  yearRef(k: number): string {
    return `${qsheet(SH_PARAMS)}!${a1(2 + k, this.yearsRow, { absolute: true })}`
  }

  // --- sheets ----------------------------------------------------------------------------------------

  buildParameters(): void {
    const sh = this.sheet(SH_PARAMS)
    const st = this.p.settings
    sh.title('Parameters', 'Economics and conventions. Orange cells are inputs.')
    const rows: [string, CellValue, string | null, string, string[]][] = [
      ['Discount rate', st.discount_rate, FMT_RATE, 'in_rate', ['settings', 'discount_rate']],
      ['Period of analysis (years)', st.period_of_analysis, FMT_INT, 'in_poa', ['settings', 'period_of_analysis']],
      ['Interest during construction: periods per year', st.idc_periods_per_year, FMT_INT, 'in_ppy', ['settings', 'idc_periods_per_year']],
      ['Interest during construction: spending in each period (END, MIDDLE or START)', st.idc_method, null, 'in_idc_method',
        ['settings', 'idc_method']],
      ['OMRRR discounting (END_OF_YEAR or MID_YEAR)', st.recurring_timing, null, 'in_timing', ['settings', 'recurring_timing']],
      ['Cost decimals kept for CE/ICA', st.cost_decimals, FMT_INT, 'in_cost_dp', ['settings', 'cost_decimals']],
      ['Output decimals kept for CE/ICA', st.output_decimals, FMT_INT, 'in_out_dp', ['settings', 'output_decimals']],
    ]
    let r = 4
    sh.head(1, r - 1, 'Parameter', { width: 62 })
    sh.head(2, r - 1, 'Value', { width: 18 })
    for (const [label, value, fmt, name, path] of rows) {
      sh.text(1, r, label)
      sh.inp(2, r, value, { fmt })
      sh.nameCell(name, 2, r)
      this.add(path, SH_PARAMS, 2, r, typeof value === 'string' ? 'text' : 'number')
      r++
    }
    const dv = new DataValidation({ type: 'list', formula1: '"END,MIDDLE,START"', allowBlank: false })
    sh.ws.addValidation(dv)
    dv.add('B7')
    const dv2 = new DataValidation({ type: 'list', formula1: '"END_OF_YEAR,MID_YEAR"', allowBlank: false })
    sh.ws.addValidation(dv2)
    dv2.add('B8')
    sh.text(1, r, 'Capital recovery factor', { bold: true })
    sh.calc(2, r, '=IF(in_rate=0,1/in_poa,in_rate*(1+in_rate)^in_poa/((1+in_rate)^in_poa-1))', { fmt: FMT_FACTOR, bold: true })
    sh.nameCell('calc_crf', 2, r)
    this.watch(SH_PARAMS, 2, 4, 2, r - 1)
    r += 2
    sh.head(1, r, 'Target years')
    this.years.forEach((y, k) => {
      sh.head(2 + k, r, `Year ${k + 1}`)
      sh.inp(2 + k, r + 1, y, { fmt: '0.##' })
      this.add(['benefits', 'target_years', k], SH_PARAMS, 2 + k, r + 1)
    })
    sh.text(1, r + 1, 'Years (first to last)')
    this.yearsRow = r + 1
    this.watch(SH_PARAMS, 2, r + 1, 1 + this.ny, r + 1)
    sh.protect()
  }

  /** STAF modules: function scores in, sub-indices, ECI and condition units out. */
  buildStaf(): void {
    const mods = this.p.benefits.modules.filter((m) => m.method === 'STAF')
    if (!mods.length) return
    const p = this.p
    const variant = p.benefits.staf_mapping
    const funcs = staf.functions()
    const fids = funcs.map((f) => f.id)
    const mp = staf.mapping(variant)
    const sh = this.sheet(SH_STAF)
    sh.title('STAF scores: function scores (0 to 15) at each target year',
      `Outcome mapping ${staf.MAPPING_LABELS[variant as 'A' | 'B']}: weight 1 for a direct effect, 0.1 for an indirect one. A function `
      + 'marked 0 under Assessed is left out of both sums at that site.')
    const f0 = 7
    const f1 = f0 + fids.length - 1
    sh.head(2, 4, 'Weights', { width: 12 })
    funcs.forEach((fn, k) => sh.head(f0 + k, 4, fn.name, { width: 12 }))
    staf.OUTCOMES.forEach((o, i) => {
      const r = 5 + i
      sh.text(2, r, staf.OUTCOME_LABELS[o], { bold: true })
      fids.forEach((fid, k) => sh.calc(f0 + k, r, staf.WEIGHTS[mp.get(fid)![o]], { fmt: '0.0' }))
      this.stafW.set(o, rng(f0, r, f1, r))
    })
    const ra = 9
    sh.head(2, ra, 'Assessed (1) or not (0)')
    sh.head(4, ra, 'Module', { width: 22 })
    funcs.forEach((fn, k) => sh.head(f0 + k, ra, fn.name))
    const dvMask = new DataValidation({ type: 'list', formula1: '"0,1"', allowBlank: false })
    sh.ws.addValidation(dvMask)
    let r = ra + 1
    p.sites.forEach((site, si) => {
      for (const m of mods) {
        this.stafMaskRow.set(tkey(site.id, m.id), r)
        sh.text(2, r, site.id)
        sh.text(4, r, m.name)
        const off = new Set(notAssessed(site, m.id))
        fids.forEach((fid, k) => {
          sh.inp(f0 + k, r, off.has(fid) ? 0 : 1, { fmt: '0' })
          dvMask.add(a1(f0 + k, r))
          this.add(['@assessed', si, m.id, fid], SH_STAF, f0 + k, r, 'int')
        })
        r++
      }
    })
    const maskLast = Math.max(r - 1, ra + 1)
    this.watch(SH_STAF, f0, ra + 1, f1, maskLast)
    const hr = maskLast + 2
    ;([['Site', 12], ['Alternative', 14], ['Module', 22], ['Year', 8], ['Quantity', 12]] as const)
      .forEach(([text, w], k) => sh.head(2 + k, hr, text, { width: w }))
    funcs.forEach((fn, k) => sh.head(f0 + k, hr, fn.name))
    const dvScore = new DataValidation({ type: 'decimal', operator: 'between', formula1: '0', formula2: '15', allowBlank: true })
    dvScore.error = 'STAF function scores run from 0 to 15.'
    sh.ws.addValidation(dvScore)
    r = hr + 1
    const first = r
    for (const m of mods) {
      const label = m.quantity_units ? `${m.name} (${m.quantity_units})` : m.name
      p.sites.forEach((site, si) => {
        site.alternatives.forEach((alt, ai) => {
          const mv = valuesFor(alt, m.id)
          const path: PathItem[] = ['sites', si, 'alternatives', ai, 'outputs', { module_id: m.id }]
          for (let k = 0; k < this.ny; k++) {
            this.stafRows.push({ sid: site.id, aid: alt.id, mid: m.id, k, row: r })
            sh.text(2, r, site.id)
            sh.text(3, r, alt.id)
            sh.text(4, r, label)
            sh.calc(5, r, `=${this.yearRef(k)}`, { fmt: '0.##' })
            const q = mv && k < mv.quantity.length ? mv.quantity[k] : null
            sh.inp(6, r, num(q), { fmt: FMT_NUM3 })
            this.add([...path, 'quantity', k], SH_STAF, 6, r, 'optional')
            fids.forEach((fid, j) => {
              const vals = mv ? mv.scores.get(fid) ?? [] : []
              const v = k < vals.length ? vals[k] : null
              sh.inp(f0 + j, r, num(v), { fmt: '0.0#' })
              dvScore.add(a1(f0 + j, r))
              this.add([...path, 'scores', fid, k], SH_STAF, f0 + j, r, 'optional')
            })
            r++
          }
        })
      })
    }
    const last = r - 1
    this.watch(SH_STAF, 6, first, f1, last)
    sh.ws.freezePanes = sh.ws.cell(first, f0).coordinate
    sh.protect()

    const ro = this.sheet(SH_STAF_ROLL)
    ro.title('STAF roll-up: sub-indices, Ecosystem Condition Index and condition units',
      'Each row matches the same row of STAF scores. Output = ECI x quantity; the Benefits sheet averages it over the period.')
    const heads: [string, number][] = [['Site', 12], ['Alternative', 14], ['Module', 22], ['Year', 8], ['Physical', 11], ['Chemical', 11],
      ['Biological', 11], ['Blank scores', 11], ['ECI', 10], ['Condition', 20], ['Quantity', 12],
      [`${p.labels.output_name} (${p.labels.output_short})`, 16]]
    const rh = 4
    heads.forEach(([text, w], k) => ro.head(2 + k, rh, text, { width: w }))
    const src = qsheet(SH_STAF)
    let rr = rh + 1
    for (const { sid, aid, mid, k: year, row: sr } of this.stafRows) {
      this.stafRollRow.set(tkey(sid, aid, mid, year), rr)
      const mr = this.stafMaskRow.get(tkey(sid, mid))!
      const scores = `${src}!${rng(f0, sr, f1, sr, { absolute: false })}`
      const mask = `${src}!${rng(f0, mr, f1, mr)}`
      for (const c of [2, 3, 4]) ro.calc(c, rr, `=${src}!${a1(c, sr)}`)
      ro.calc(5, rr, `=${src}!${a1(5, sr)}`, { fmt: '0.##' })
      staf.OUTCOMES.forEach((o, k) => {
        const w = `${src}!${this.stafW.get(o)}`
        ro.calc(6 + k, rr, `=IF(SUMPRODUCT(${w},${mask})>0,SUMPRODUCT(${scores},${w},${mask})/(15*SUMPRODUCT(${w},${mask})),NA())`,
          { fmt: '0.0000' })
      })
      ro.calc(9, rr, `=SUMPRODUCT(${mask}*(1-ISNUMBER(${scores})))`, { fmt: '0' })
      ro.calc(10, rr, `=IF(${a1(9, rr)}>0,NA(),(${a1(6, rr)}+${a1(7, rr)}+${a1(8, rr)})/3)`, { fmt: '0.0000' })
      ro.calc(11, rr, `=IF(ISNUMBER(${a1(10, rr)}),IF(ROUND(${a1(10, rr)},2)<=0.39,"Non-Functioning",IF(ROUND(${a1(10, rr)},2)<=0.69,`
        + `"Functioning-at-Risk","Functioning")),"")`)
      ro.calc(12, rr, `=IF(ISNUMBER(${src}!${a1(6, sr)}),${src}!${a1(6, sr)},NA())`, { fmt: FMT_NUM3 })
      ro.calc(13, rr, `=${a1(10, rr)}*${a1(12, rr)}`, { fmt: FMT_NUM3 })
      rr++
    }
    ro.ws.freezePanes = ro.ws.cell(rh + 1, 6).coordinate
    ro.protect()
  }

  /** Every module's output at each target year and its average, one row per module, site and alternative. */
  buildBenefits(): void {
    const p = this.p
    const lab = p.labels
    const mods = [...p.benefits.modules]
    const ny = this.ny
    const live = p.settings.aahu_method === 'TRAPEZOID'
    const ixq = mods.some((m) => m.method === 'INDEX_X_QUANTITY')
    const yearly = mods.some(byYear)
    const sh = this.sheet(SH_BENEFITS)
    const how: Record<string, string> = {
      HU: `${lab.output_name.toLowerCase()} entered at each target year`, INDEX_X_QUANTITY: 'index x quantity at each target year',
      STAF: 'ECI x quantity from the STAF roll-up', AAHU: 'the average entered directly',
    }
    let note = 'One row per module, site and alternative; the Summary adds the modules\' averages. '
      + mods.map((m) => `${m.name}: ${how[m.method]}`).join('; ') + '.'
    if (yearly) {
      note += live ? ' Averages are the area under straight lines between target years.'
        : ' Averages use the IWR Annualizer method and are the app\'s values.'
    }
    sh.title(`Benefits: ${lab.output_name.toLowerCase()} by module`, note)
    const c0 = 6
    const blocks: [string, string][] = []
    if (ixq) blocks.push(['index', 'Index (0 to 1)'], ['quantity', 'Quantity'])
    if (yearly) blocks.push(['output', `${lab.output_name} (${lab.output_short})`])
    const hr = 4
    for (const [h, text, w] of [[1, 'Key', 4], [2, 'Site', 9], [3, 'Alternative', 14], [4, 'Module', 22], [5, 'Method', 18]] as const) {
      sh.head(h, hr, text, { width: w })
      sh.head(h, hr + 1, '')
    }
    const start: Record<string, number> = {}
    let c = c0
    for (const [key, text] of blocks) {
      start[key] = c
      sh.ws.mergeCells(hr, c, hr, c + ny - 1)
      sh.head(c, hr, text)
      for (let k = 0; k < ny; k++) {
        sh.put(c + k, hr + 1, `=${this.yearRef(k)}`, { fmt: '0.##', fill: FILL_SUB, font: FONT_BOLD, align: CENTER })
        sh.width(c + k, 11)
      }
      c += ny
    }
    const aahuC = c
    sh.head(aahuC, hr, `Average (${lab.annual_output_short})`, { width: 14 })
    sh.head(aahuC, hr + 1, '')
    sh.ws.column(1).hidden = true
    const methodText: Record<string, string> = { HU: lab.output_name, INDEX_X_QUANTITY: 'Index x quantity', STAF: 'STAF function scores',
      AAHU: 'Average annual value' }
    const roll = qsheet(SH_STAF_ROLL)
    let r = hr + 2
    const first = r
    for (const m of mods) {
      const gFirst = r
      p.sites.forEach((site, si) => {
        site.alternatives.forEach((alt, ai) => {
          const mv = valuesFor(alt, m.id)
          const path: PathItem[] = ['sites', si, 'alternatives', ai, 'outputs', { module_id: m.id }]
          sh.calc(1, r, `=B${r}&"|"&C${r}`)
          sh.text(2, r, site.id)
          sh.text(3, r, alt.id)
          sh.text(4, r, m.name)
          sh.text(5, r, methodText[m.method])
          const vals = mv ? [...mv.values] : []
          const qty = mv ? [...mv.quantity] : []
          if (m.method === 'INDEX_X_QUANTITY') {
            const o = start.output
            for (let k = 0; k < ny; k++) {
              const v = k < vals.length ? vals[k] : null
              const q = k < qty.length ? qty[k] : null
              sh.inp(start.index + k, r, num(v), { fmt: '0.0000' })
              sh.inp(start.quantity + k, r, num(q), { fmt: FMT_NUM3 })
              this.add([...path, 'values', k], SH_BENEFITS, start.index + k, r, 'optional')
              this.add([...path, 'quantity', k], SH_BENEFITS, start.quantity + k, r, 'optional')
              sh.calc(o + k, r, `=${a1(start.index + k, r)}*${a1(start.quantity + k, r)}`, { fmt: FMT_NUM3 })
            }
          } else if (m.method === 'HU') {
            const o = start.output
            for (let k = 0; k < ny; k++) {
              const v = k < vals.length ? vals[k] : null
              sh.inp(o + k, r, num(v), { fmt: FMT_NUM3 })
              this.add([...path, 'values', k], SH_BENEFITS, o + k, r, 'optional')
            }
          } else if (m.method === 'STAF') {
            const o = start.output
            for (let k = 0; k < ny; k++) {
              const rr = this.stafRollRow.get(tkey(site.id, alt.id, m.id, k))!
              sh.calc(o + k, r, `=${roll}!${a1(13, rr)}`, { fmt: FMT_NUM3 })
            }
          }
          if (m.method === 'AAHU') {
            sh.inp(aahuC, r, num(mv ? mv.aahu : null), { fmt: FMT_NUM3 })
            this.add([...path, 'aahu'], SH_BENEFITS, aahuC, r, 'optional')
          } else if (live) {
            const o = start.output
            const yHi = rng(o + 1, hr + 1, o + ny - 1, hr + 1)
            const yLo = rng(o, hr + 1, o + ny - 2, hr + 1)
            const vHi = `${a1(o + 1, r)}:${a1(o + ny - 1, r)}`
            const vLo = `${a1(o, r)}:${a1(o + ny - 2, r)}`
            sh.calc(aahuC, r, `=SUMPRODUCT(${yHi}-${yLo},(${vHi}+${vLo})/2)/(${a1(o + ny - 1, hr + 1, { absolute: true })}-`
              + `${a1(o, hr + 1, { absolute: true })})`, { fmt: FMT_NUM3 })
          } else {
            const v = this.res.benefits.get(lineKey(site.id, alt.id))!.aahu_by_module.get(m.id)
            sh.calc(aahuC, r, num(v), { fmt: FMT_NUM3 })
          }
          r++
        })
      })
      const gLast = r - 1
      if (gLast >= gFirst) {
        if (m.method === 'INDEX_X_QUANTITY') this.watch(SH_BENEFITS, start.index, gFirst, start.quantity + ny - 1, gLast)
        else if (m.method === 'HU') this.watch(SH_BENEFITS, start.output, gFirst, start.output + ny - 1, gLast)
        else if (m.method === 'AAHU') this.watch(SH_BENEFITS, aahuC, gFirst, aahuC, gLast)
      }
    }
    const last = Math.max(r - 1, first)
    this.benefitsRange = [first, last, aahuC]
    sh.ws.freezePanes = sh.ws.cell(first, c0).coordinate
    sh.protect()
  }

  buildCosts(): void {
    const sh = this.sheet(SH_COSTS)
    const cats = [...this.p.cost_categories]
    sh.title('Costs: first costs, interest during construction and OMRRR',
      'First costs are base-year lump sums. Interest during construction accrues on the categories marked *, spent evenly over the '
      + 'construction months.')
    const hr = 4
    sh.head(1, hr, 'Key', { width: 4 })
    sh.head(2, hr, 'Site', { width: 9 })
    sh.head(3, hr, 'Alternative', { width: 14 })
    let c = 4
    for (const cat of cats) {
      sh.head(c, hr, cat.name + (cat.idc_applies ? ' *' : ''), { width: 14 })
      sh.put(c, hr + 1, cat.id, { font: FONT_NOTE, align: CENTER })
      this.catCol.set(cat.id, c)
      c++
    }
    this.catFirst = 4
    this.catLast = c - 1
    const [monthsC, baseC, idcC, omC, totC, ovrC, annC] = [c, c + 1, c + 2, c + 3, c + 4, c + 5, c + 6]
    const heads: [number, string, number][] = [[monthsC, 'Construction months', 12], [baseC, 'IDC base', 14],
      [idcC, 'Interest during construction', 15], [omC, 'OMRRR present value', 15], [totC, 'Total present value', 15],
      [ovrC, 'Average annual cost entered', 15], [annC, 'Average annual cost', 15]]
    for (const [cc, text, w] of heads) {
      sh.head(cc, hr, text, { width: w })
      sh.put(cc, hr + 1, '', { font: FONT_NOTE })
    }
    const partC = annC + 1
    sh.ws.mergeCells(hr - 1, partC, hr - 1, partC + cats.length + 1)
    sh.head(partC, hr - 1, 'Average annual cost by part')
    cats.forEach((cat, k) => sh.head(partC + k, hr, cat.name, { width: 13 }))
    sh.head(partC + cats.length, hr, 'Interest during construction', { width: 13 })
    sh.head(partC + cats.length + 1, hr, 'OMRRR', { width: 13 })
    sh.ws.column(1).hidden = true
    this.costsCols = { months: monthsC, base: baseC, idc: idcC, om: omC, tot: totC, ovr: ovrC, ann: annC, parts: partC }
    let r = hr + 2
    const first = r
    const rec = qsheet(SH_RECUR)
    this.p.sites.forEach((site, si) => {
      site.alternatives.forEach((alt, ai) => {
        this.costRow.set(lineKey(site.id, alt.id), r)
        sh.calc(1, r, `=B${r}&"|"&C${r}`)
        sh.text(2, r, site.id)
        sh.text(3, r, alt.id)
        const path: PathItem[] = ['sites', si, 'alternatives', ai, 'costs']
        for (const cat of cats) {
          const cc = this.catCol.get(cat.id)!
          sh.inp(cc, r, num(alt.costs.first_costs.get(cat.id)), { fmt: FMT_USD })
          this.add([...path, 'first_costs', cat.id], SH_COSTS, cc, r)
        }
        sh.inp(monthsC, r, num(alt.costs.construction_months), { fmt: '0.##' })
        this.add([...path, 'construction_months'], SH_COSTS, monthsC, r)
        const idcCats = cats.filter((x) => x.idc_applies).map((x) => this.catCol.get(x.id)!)
        sh.calc(baseC, r, '=' + (idcCats.map((cc) => a1(cc, r)).join('+') || '0'), { fmt: FMT_USD })
        const m = a1(monthsC, r)
        const b = a1(baseC, r)
        const a = '((1+in_rate)^(1/in_ppy)-1)'
        const lead = `IF(in_idc_method="START",1+${a},IF(in_idc_method="MIDDLE",1+${a}/2,1))`
        sh.calc(idcC, r, `=IF(OR(${m}=0,in_rate=0,${b}=0),0,${b}/${m}*(${lead}*((1+in_rate)^(${m}/in_ppy)-1)/${a}-${m}))`, { fmt: FMT_USD2 })
        const [q1, q2] = this.recurRows
        sh.calc(omC, r, `=SUMIFS(${rec}!$S$${q1}:$S$${q2},${rec}!$A$${q1}:$A$${q2},A${r})`, { fmt: FMT_USD2 })
        const firsts = `SUM(${a1(this.catFirst, r)}:${a1(this.catLast, r)})`
        sh.calc(totC, r, `=${firsts}+${a1(idcC, r)}+${a1(omC, r)}`, { fmt: FMT_USD2 })
        sh.inp(ovrC, r, num(alt.costs.annual_override), { fmt: FMT_USD2 })
        this.add([...path, 'annual_override'], SH_COSTS, ovrC, r, 'optional')
        sh.calc(annC, r, `=IF(ISNUMBER(${a1(ovrC, r)}),${a1(ovrC, r)},calc_crf*${a1(totC, r)})`, { fmt: FMT_USD2 })
        cats.forEach((cat, k) => sh.calc(partC + k, r, `=calc_crf*${a1(this.catCol.get(cat.id)!, r)}`, { fmt: FMT_USD2 }))
        sh.calc(partC + cats.length, r, `=calc_crf*${a1(idcC, r)}`, { fmt: FMT_USD2 })
        sh.calc(partC + cats.length + 1, r, `=calc_crf*${a1(omC, r)}`, { fmt: FMT_USD2 })
        r++
      })
    })
    const last = r - 1
    this.costsRange = [first, last]
    this.watch(SH_COSTS, this.catFirst, first, monthsC, last)
    this.watch(SH_COSTS, ovrC, first, ovrC, last)
    sh.ws.freezePanes = sh.ws.cell(first, 4).coordinate
    sh.protect()
  }

  buildRecurring(): void {
    const sh = this.sheet(SH_RECUR)
    sh.title('OMRRR: recurring operation, maintenance, repair, replacement and rehabilitation',
      'Each item costs the amount per occurrence every N years from the first year to the last (blank: every N years through the period '
      + 'of analysis). Basis: FIXED amount, PERCENT of a first-cost category, or RATE x quantity.')
    const hr = 4
    const heads: [string, number][] = [['Key', 4], ['Site', 9], ['Alternative', 14], ['Item', 26], ['Basis', 9], ['Amount', 12],
      ['Percent', 9], ['Category', 13], ['Unit rate', 10], ['Quantity', 11], ['Every N years', 9], ['First year', 8], ['Last year', 8],
      ['Amount per occurrence', 13], ['First', 7], ['Last', 7], ['Occurrences', 11], ['Present value, end of year', 14],
      ['Present value', 14]]
    heads.forEach(([t, w], k) => sh.head(1 + k, hr, t, { width: w }))
    sh.ws.column(1).hidden = true
    let r = hr + 1
    const first = r
    const costs = qsheet(SH_COSTS)
    const [cFirst, cLast] = this.costsRange
    const catRng = `${costs}!${rng(this.catFirst, cFirst, this.catLast, cLast)}`
    const catIds = `${costs}!${rng(this.catFirst, 5, this.catLast, 5)}`
    const keyRng = `${costs}!${rng(1, cFirst, 1, cLast)}`
    this.p.sites.forEach((site, si) => {
      site.alternatives.forEach((alt, ai) => {
        alt.costs.recurring.forEach((item, mi) => {
          const path: PathItem[] = ['sites', si, 'alternatives', ai, 'costs', 'recurring', mi]
          sh.calc(1, r, `=B${r}&"|"&C${r}`)
          sh.text(2, r, site.id)
          sh.text(3, r, alt.id)
          sh.text(4, r, item.name)
          const code = BASIS_CODE[item.basis]
          sh.text(5, r, code)
          for (const [cc, fld, val, fmt] of [[6, 'amount', item.amount, FMT_USD2], [7, 'percent', item.percent, FMT_PCT],
            [9, 'unit_rate', item.unit_rate, FMT_USD2], [10, 'quantity', item.quantity, FMT_NUM2]] as const) {
            const relevant = (fld === 'amount' && code === 'FIXED') || (fld === 'percent' && code === 'PERCENT')
              || ((fld === 'unit_rate' || fld === 'quantity') && code === 'RATE')
            if (relevant) {
              sh.inp(cc, r, val, { fmt })
              this.add([...path, fld], SH_RECUR, cc, r)
            } else sh.put(cc, r, null, { fill: FILL_CALC })
          }
          sh.text(8, r, item.category_id || '')
          sh.inp(11, r, item.every_years, { fmt: FMT_INT })
          this.add([...path, 'every_years'], SH_RECUR, 11, r, 'int')
          sh.inp(12, r, item.first_year, { fmt: FMT_INT })
          this.add([...path, 'first_year'], SH_RECUR, 12, r, 'optional_int')
          sh.inp(13, r, item.last_year, { fmt: FMT_INT })
          this.add([...path, 'last_year'], SH_RECUR, 13, r, 'optional_int')
          const pct = `G${r}*IFERROR(INDEX(${catRng},MATCH(A${r},${keyRng},0),MATCH(H${r},${catIds},0)),0)`
          sh.calc(14, r, `=IF(E${r}="FIXED",F${r},IF(E${r}="PERCENT",${pct},I${r}*J${r}))`, { fmt: FMT_USD2 })
          sh.calc(15, r, `=IF(ISNUMBER(L${r}),L${r},K${r})`, { fmt: FMT_INT })
          sh.calc(16, r, `=IF(ISNUMBER(M${r}),MIN(M${r},in_poa),in_poa)`, { fmt: FMT_INT })
          sh.calc(17, r, `=IF(P${r}<O${r},0,INT((P${r}-O${r})/K${r})+1)`, { fmt: FMT_INT })
          sh.calc(18, r, `=IF(Q${r}=0,0,IF(in_rate=0,N${r}*Q${r},N${r}*(1+in_rate)^(-O${r})*(1-(1+in_rate)^(-K${r}*Q${r}))/`
            + `(1-(1+in_rate)^(-K${r}))))`, { fmt: FMT_USD2 })
          sh.calc(19, r, `=IF(in_timing="MID_YEAR",IF(O${r}=0,IF(Q${r}=0,0,N${r}+(R${r}-N${r})*(1+in_rate)^0.5),R${r}*(1+in_rate)^0.5),`
            + `R${r})`, { fmt: FMT_USD2 })
          r++
        })
      })
    })
    const last = r - 1
    if (last >= first) this.watch(SH_RECUR, 6, first, 13, last)
    sh.ws.freezePanes = sh.ws.cell(first, 5).coordinate
    sh.protect()
  }

  buildSummary(): void {
    const sh = this.sheet(SH_SUMMARY)
    const lab = this.p.labels
    sh.title('Summary of inputs to CE/ICA',
      `Lift is each alternative's ${lab.annual_output_short} above No Action; the CE/ICA cost is its average annual cost above No Action.`)
    const hr = 4
    const heads: [string, number][] = [['Key', 4], ['Site', 9], ['Alternative', 14], ['Name', 26], ['No Action', 8],
      [`Outputs (${lab.annual_output_short})`, 13], [`Lift (${lab.annual_output_short})`, 12], ['Construction cost', 14],
      ['First costs', 14], ['Interest during construction', 14], ['OMRRR present value', 14], ['Average annual cost', 14],
      ['Cost above No Action', 14], [`Unit cost ($/${lab.annual_output_short})`, 13]]
    heads.forEach(([t, w], k) => sh.head(1 + k, hr, t, { width: w }))
    sh.ws.column(1).hidden = true
    let r = hr + 1
    const first = r
    const costs = qsheet(SH_COSTS)
    const cc = this.costsCols
    const [bFirst, bLast, bAahu] = this.benefitsRange
    const ben = qsheet(SH_BENEFITS)
    const last = first + this.altRows.length - 1
    // each site's No Action row, referenced directly: IDs such as "2A" must never be used as SUMIFS
    // criteria, which Excel reads as times (2:00 AM)
    const naRow = new Map<string, number>()
    let rr = r
    for (const site of this.p.sites) {
      for (const alt of site.alternatives) {
        if (alt.is_no_action) naRow.set(site.id, rr)
        rr++
      }
    }
    for (const site of this.p.sites) {
      for (const alt of site.alternatives) {
        this.summaryRow.set(lineKey(site.id, alt.id), r)
        const crow = this.costRow.get(lineKey(site.id, alt.id))!
        sh.calc(1, r, `=B${r}&"|"&C${r}`)
        sh.text(2, r, site.id)
        sh.text(3, r, alt.id)
        sh.text(4, r, alt.name || alt.id)
        sh.text(5, r, alt.is_no_action ? 1 : 0)
        sh.calc(6, r, `=SUMIFS(${ben}!${rng(bAahu, bFirst, bAahu, bLast)},${ben}!${rng(1, bFirst, 1, bLast)},A${r})`, { fmt: FMT_NUM3 })
        const nr = naRow.get(site.id) ?? r
        sh.calc(7, r, `=F${r}-$F$${nr}`, { fmt: FMT_NUM3 })
        const con = this.catCol.has('construction') ? `${costs}!${a1(this.catCol.get('construction')!, crow)}`
          : `SUM(${costs}!${a1(this.catFirst, crow)}:${a1(this.catLast, crow)})`
        sh.calc(8, r, `=${con}`, { fmt: FMT_USD })
        sh.calc(9, r, `=SUM(${costs}!${a1(this.catFirst, crow)}:${a1(this.catLast, crow)})`, { fmt: FMT_USD })
        sh.calc(10, r, `=${costs}!${a1(cc.idc, crow)}`, { fmt: FMT_USD })
        sh.calc(11, r, `=${costs}!${a1(cc.om, crow)}`, { fmt: FMT_USD })
        sh.calc(12, r, `=${costs}!${a1(cc.ann, crow)}`, { fmt: FMT_USD2 })
        sh.calc(13, r, `=L${r}-$L$${nr}`, { fmt: FMT_USD2 })
        sh.calc(14, r, `=IF(G${r}>0,M${r}/G${r},"n/a")`, { fmt: FMT_USD })
        r++
      }
    }
    this.resultChecks.push([SH_SUMMARY, rng(7, first, 7, last, { absolute: false }), 1e-6])
    this.resultChecks.push([SH_SUMMARY, rng(12, first, 12, last, { absolute: false }), 1e-4])
    sh.ws.freezePanes = sh.ws.cell(first, 5).coordinate
    sh.protect()
  }

  buildSiteCeica(): void {
    const sh = this.sheet(SH_SITE)
    const lab = this.p.labels
    sh.title('Site-by-site CE/ICA',
      'Cost-effective: no alternative gives the same output for less, or more output for no more. Best buy: on the lower hull from No '
      + 'Action (IWR Planning Suite II rules).')
    const hr = 4
    const cols = ['Key', 'Site', 'Alternative', 'Name', 'No Action', 'Ordinal', `Lift (${lab.annual_output_short})`, 'Cost above No Action',
      'Lift (scaled)', 'Cost (scaled)', 'Dominated by', 'Cost-effective', 'Candidate', 'Slope in (max)', 'Slope out (min)', 'Best buy',
      'Best-buy step', 'Previous lift (scaled)', 'Previous cost (scaled)', 'Incremental output', 'Incremental cost',
      'Incremental cost per unit', 'Unit cost', 'Recommended']
    const widths = [4, 9, 14, 24, 8, 7, 11, 13, 11, 11, 8, 9, 8, 11, 11, 7, 8, 11, 11, 11, 13, 13, 11, 11]
    cols.forEach((t, k) => sh.head(1 + k, hr, t, { width: widths[k] }))
    const cmap: Roles = { key: 1, site: 2, alt: 3, name: 4, na: 5, ord: 6, lift: 7, cost: 8, q: 9, cc: 10, dom: 11, ce: 12, cand: 13,
      lmax: 14, rmin: 15, bb: 16, rank: 17, pq: 18, pc: 19, incq: 20, incc: 21, per: 22, unit: 23, rec: 24 }
    const summ = qsheet(SH_SUMMARY)
    const sitesSh = qsheet(SH_SITES)
    let r = hr + 1
    const allFirst = r
    for (const site of this.p.sites) {
      const sr = this.res.sites.get(site.id)!
      let title = pyStrip(`${site.id}  ${site.name}`)
      if (!sr.ready) title += '   (inputs incomplete in the app)'
      sh.put(1, r, null, { border: false })
      const cell = sh.ws.cell(r, 2, title)
      cell.font = FONT_BOLD
      r++
      const r1 = r
      const r2 = r + site.alternatives.length - 1
      this.siteBlock.set(site.id, [r1, r2])
      site.alternatives.forEach((alt, k) => {
        this.siteAltRow.set(lineKey(site.id, alt.id), r)
        const srow = this.summaryRow.get(lineKey(site.id, alt.id))!
        sh.calc(1, r, `=B${r}&"|"&C${r}`)
        sh.text(2, r, site.id)
        sh.text(3, r, alt.id)
        sh.text(4, r, alt.name || alt.id)
        sh.text(5, r, alt.is_no_action ? 1 : 0)
        sh.text(6, r, k + 1)
        sh.calc(7, r, `=${summ}!G${srow}`, { fmt: FMT_NUM3 })
        sh.calc(8, r, `=${summ}!M${srow}`, { fmt: FMT_USD2 })
        sh.calc(9, r, `=ROUND(G${r}*10^in_out_dp,0)`, { fmt: FMT_INT })
        sh.calc(10, r, `=ROUND(H${r}*10^in_cost_dp,0)`, { fmt: FMT_INT })
        const f = ceicaFormulas(r, r1, r2, cmap)
        for (const role of CEICA_ROLES) sh.calc(cmap[role], r, f[role], { fmt: role === 'lmax' || role === 'rmin' ? FMT_NUM2 : null })
        sh.calc(20, r, `=IF(Q${r}=0,"",(I${r}-R${r})/10^in_out_dp)`, { fmt: FMT_NUM3 })
        sh.calc(21, r, `=IF(Q${r}=0,"",(J${r}-S${r})/10^in_cost_dp)`, { fmt: FMT_USD2 })
        sh.calc(22, r, `=IF(Q${r}=0,"",IF(I${r}=R${r},0,U${r}/T${r}))`, { fmt: FMT_USD2 })
        sh.calc(23, r, `=IF(I${r}>0,(J${r}/10^in_cost_dp)/(I${r}/10^in_out_dp),"n/a")`, { fmt: FMT_USD2 })
        const sitesRow = this.sitesRowOf(site.id)
        sh.calc(24, r, `=IF(${sitesSh}!$C$${sitesRow}=C${r},1,0)`)
        r++
      })
      r++
    }
    this.siteRowsRange = [allFirst, r - 2]
    // results the Read me checks against the export
    for (const [r1, r2] of this.siteBlock.values()) {
      this.resultChecks.push([SH_SITE, rng(12, r1, 12, r2, { absolute: false }), 0])
      this.resultChecks.push([SH_SITE, rng(16, r1, 16, r2, { absolute: false }), 0])
    }
    for (const c of [1, 9, 10, 11, 13, 14, 15, 17, 18, 19]) sh.ws.column(c).hidden = true
    sh.ws.freezePanes = sh.ws.cell(hr + 1, 5).coordinate
    sh.protect()
  }

  buildSites(): void {
    const sh = this.sheet(SH_SITES)
    const lab = this.p.labels
    sh.title('Sites: the alternative carried to the watershed plans',
      'Choose each site\'s recommended alternative. No Action leaves the site out of every watershed plan.')
    const hr = 4
    const heads: [string, number][] = [['Site', 9], ['Name', 28], ['Recommended alternative', 16], ['No Action', 10], ['Carried', 8],
      [`Lift (${lab.annual_output_short})`, 12], ['Cost above No Action', 14], ['Construction cost', 14], ['Lift (scaled)', 10],
      ['Cost (scaled)', 10], ['Cost-effective', 9], ['Best buy', 8], ['Decided by', 12]]
    heads.forEach(([t, w], k) => sh.head(1 + k, hr, t, { width: w }))
    const siteSh = qsheet(SH_SITE)
    const summ = qsheet(SH_SUMMARY)
    const [sFirst, sLast] = this.siteRowsRange
    const keyRng = `${siteSh}!${rng(1, sFirst, 1, sLast)}`
    let r = hr + 1
    const first = r
    const dstate = this.res.decisions.sites
    for (const site of this.p.sites) {
      this.sitesRow.set(site.id, r)
      const na = noAction(site)
      const st = dstate.get(site.id)
      const rec = st && st.alt_id ? st.alt_id : na ? na.id : ''
      sh.text(1, r, site.id)
      sh.text(2, r, site.name)
      sh.inp(3, r, rec)
      // a suggestion written here only becomes a team decision if someone edits it
      this.add(['decisions', 'sites', site.id, 'recommended_alt_id'], SH_SITES, 3, r, 'rec', rec)
      const ids = site.alternatives.map((a) => a.id).join(',')
      if (pyLen(ids) < 250) {
        const dv = new DataValidation({ type: 'list', formula1: `"${ids}"`, allowBlank: false })
        sh.ws.addValidation(dv)
        dv.add(a1(3, r))
      }
      sh.text(4, r, na ? na.id : '')
      sh.calc(5, r, `=IF(C${r}<>D${r},1,0)`)
      const look = `MATCH(A${r}&"|"&C${r},${keyRng},0)`
      sh.calc(6, r, `=IFERROR(INDEX(${siteSh}!${rng(7, sFirst, 7, sLast)},${look}),0)`, { fmt: FMT_NUM3 })
      sh.calc(7, r, `=IFERROR(INDEX(${siteSh}!${rng(8, sFirst, 8, sLast)},${look}),0)`, { fmt: FMT_USD2 })
      const srows = site.alternatives.map((a) => this.summaryRow.get(lineKey(site.id, a.id))!)
      // min() of nothing: a site without alternatives stops the calculator, as in the Python
      if (!srows.length) throw new PyValueError('min() iterable argument is empty')
      const lo = Math.min(...srows)
      const hi = Math.max(...srows)
      sh.calc(8, r, `=IFERROR(INDEX(${summ}!$H$${lo}:$H$${hi},MATCH(C${r},${summ}!$C$${lo}:$C$${hi},0)),0)`, { fmt: FMT_USD })
      sh.calc(9, r, `=IF(E${r}=1,IFERROR(INDEX(${siteSh}!${rng(9, sFirst, 9, sLast)},${look}),0),0)`, { fmt: FMT_INT })
      sh.calc(10, r, `=IF(E${r}=1,IFERROR(INDEX(${siteSh}!${rng(10, sFirst, 10, sLast)},${look}),0),0)`, { fmt: FMT_INT })
      sh.calc(11, r, `=IFERROR(INDEX(${siteSh}!${rng(12, sFirst, 12, sLast)},${look}),0)`)
      sh.calc(12, r, `=IFERROR(INDEX(${siteSh}!${rng(16, sFirst, 16, sLast)},${look}),0)`)
      const src = st ? st.source : 'none'
      sh.text(13, r, ({ team: 'Team', suggested: 'Suggested' } as Record<string, string>)[src] ?? 'n/a')
      r++
    }
    this.watch(SH_SITES, 3, first, 3, r - 1)
    sh.protect()
  }

  /** The watershed plan table: live formulas in recommended mode, values otherwise. */
  buildPlans(): void {
    const mode = this.p.watershed.mode
    const candSites = this.p.sites.filter((s) => s.alternatives.length > 1)
    const n = 2 ** candSites.length
    this.liveWatershed = mode === 'RECOMMENDED' && n > 0 && n <= LIVE_PLAN_LIMIT && !this.p.watershed.rules.length
    if (this.liveWatershed) this.plansLive(candSites)
    else this.plansValues()
  }

  private plansLive(candSites: readonly Site[]): void {
    const sh = this.sheet(SH_PLANS)
    const lab = this.p.labels
    const S = candSites.length
    sh.title('Watershed plans: every combination of the recommended site actions',
      '1 and 0 mark a site included or excluded. Rows that include a site whose recommendation is No Action are not valid plans.')
    const sitesSh = qsheet(SH_SITES)
    const b0 = 4
    const labels = ['Site', 'Carried', 'Lift (scaled)', 'Cost (scaled)', 'Construction cost', 'Weight']
    const top = 4
    labels.forEach((t, k) => sh.text(3, top + k, t, { bold: true }))
    candSites.forEach((site, j) => {
      const c = b0 + j
      const srow = this.sitesRow.get(site.id)!
      sh.head(c, top, site.id, { width: 7 })
      sh.calc(c, top + 1, `=${sitesSh}!E${srow}`)
      sh.calc(c, top + 2, `=${sitesSh}!I${srow}`, { fmt: FMT_INT })
      sh.calc(c, top + 3, `=${sitesSh}!J${srow}`, { fmt: FMT_INT })
      sh.calc(c, top + 4, `=${sitesSh}!H${srow}`, { fmt: FMT_USD })
      if (j < S - 1) {
        const rest = `${a1(c + 1, top + 1)}:${a1(b0 + S - 1, top + 1, { absolute: true })}`
        sh.calc(c, top + 5, `=IF(${a1(c, top + 1)}=1,2^SUM(${rest}),0)`, { fmt: FMT_INT })
      } else sh.calc(c, top + 5, `=IF(${a1(c, top + 1)}=1,1,0)`, { fmt: FMT_INT })
    })
    const act = rng(b0, top + 1, b0 + S - 1, top + 1)
    const qRow = rng(b0, top + 2, b0 + S - 1, top + 2)
    const cRow = rng(b0, top + 3, b0 + S - 1, top + 3)
    const kRow = rng(b0, top + 4, b0 + S - 1, top + 4)
    const wRow = rng(b0, top + 5, b0 + S - 1, top + 5)
    const hr = top + 7
    const c = b0 + S
    const cmap: Roles = { row: 1, label: 2, valid: 3, pnum: c, q: c + 1, cc: c + 2, con: c + 3, lift: c + 4, cost: c + 5, na: c + 6, ord: 1,
      dom: c + 7, ce: c + 8, cand: c + 9, lmax: c + 10, rmin: c + 11, bb: c + 12, rank: c + 13, pq: c + 14, pc: c + 15, incq: c + 16,
      incc: c + 17, per: c + 18, unit: c + 19, final: c + 20, frank: c + 21 }
    const heads: [string, string, number][] = [['row', 'Row', 6], ['label', 'Plan', 34], ['valid', 'Valid', 6], ['pnum', 'Plan number', 8],
      ['q', 'Lift (scaled)', 10], ['cc', 'Cost (scaled)', 11], ['con', 'Construction cost', 13], ['lift', `Lift (${lab.annual_output_short})`, 11],
      ['cost', 'Average annual cost', 13], ['na', 'No Action', 6], ['dom', 'Dominated by', 8], ['ce', 'Cost-effective', 9],
      ['cand', 'Candidate', 8], ['lmax', 'Slope in (max)', 10], ['rmin', 'Slope out (min)', 10], ['bb', 'Best buy', 7],
      ['rank', 'Best-buy step', 8], ['pq', 'Previous lift (scaled)', 10], ['pc', 'Previous cost (scaled)', 10],
      ['incq', 'Incremental output', 11], ['incc', 'Incremental cost', 12], ['per', 'Incremental cost per unit', 12], ['unit', 'Unit cost', 11],
      ['final', 'Final array', 7], ['frank', 'Final array order', 8]]
    for (const [role, t, w] of heads) sh.head(cmap[role], hr, t, { width: w })
    candSites.forEach((site, j) => sh.head(b0 + j, hr, site.id))
    const n = 2 ** S
    const r1 = hr + 1
    const r2 = hr + n
    this.planRows = [r1, r2]
    this.planCols = cmap
    this.planBits = [b0, b0 + S - 1]
    this.planSites = candSites.map((s) => s.id)
    const finalKeys = new Set(this.res.decisions.final_keys)
    const recs = new Map(candSites.map((s) => [s.id, this.res.decisions.sites.get(s.id)?.alt_id ?? null]))
    for (let i = 0; i < n; i++) {
      const r = r1 + i
      const bits = candSites.map((_, j) => (i >> (S - 1 - j)) & 1)
      const comp = new Map<string, string>()
      candSites.forEach((s, j) => {
        const rec = recs.get(s.id)
        if (bits[j] && rec) comp.set(s.id, rec)
      })
      const key = compositionKey(comp)
      this.planRowKeys.set(r, key)
      sh.text(1, r, i + 1)
      const inc = candSites.filter((_, j) => bits[j]).map((s) => s.id)
      sh.text(2, r, inc.length ? inc.join(' + ') : 'No Action')
      const bitsR = rng(b0, r, b0 + S - 1, r, { absolute: false })
      sh.calc(3, r, `=IF(SUMPRODUCT(${bitsR},1-${act})=0,1,0)`)
      bits.forEach((b, j) => sh.text(b0 + j, r, b))
      const C = (role: string): string => a1(cmap[role], r)
      sh.calc(cmap.pnum, r, `=IF(${C('valid')}=1,1+SUMPRODUCT(${bitsR},${wRow}),"")`, { fmt: FMT_INT })
      sh.calc(cmap.q, r, `=SUMPRODUCT(${bitsR},${qRow})`, { fmt: FMT_INT })
      sh.calc(cmap.cc, r, `=SUMPRODUCT(${bitsR},${cRow})`, { fmt: FMT_INT })
      sh.calc(cmap.con, r, `=SUMPRODUCT(${bitsR},${kRow})`, { fmt: FMT_USD })
      sh.calc(cmap.lift, r, `=${C('q')}/10^in_out_dp`, { fmt: FMT_NUM3 })
      sh.calc(cmap.cost, r, `=${C('cc')}/10^in_cost_dp`, { fmt: FMT_USD2 })
      sh.calc(cmap.na, r, `=IF(SUM(${bitsR})=0,1,0)`)
      const f = ceicaFormulas(r, r1, r2, cmap, 'valid')
      for (const role of CEICA_ROLES) sh.calc(cmap[role], r, f[role], { fmt: role === 'lmax' || role === 'rmin' ? FMT_NUM2 : null })
      sh.calc(cmap.incq, r, `=IF(${C('rank')}=0,"",(${C('q')}-${C('pq')})/10^in_out_dp)`, { fmt: FMT_NUM3 })
      sh.calc(cmap.incc, r, `=IF(${C('rank')}=0,"",(${C('cc')}-${C('pc')})/10^in_cost_dp)`, { fmt: FMT_USD2 })
      sh.calc(cmap.per, r, `=IF(${C('rank')}=0,"",IF(${C('q')}=${C('pq')},0,${C('incc')}/${C('incq')}))`, { fmt: FMT_USD2 })
      sh.calc(cmap.unit, r, `=IF(AND(${C('valid')}=1,${C('q')}>0),${C('cost')}/${C('lift')},"n/a")`, { fmt: FMT_USD2 })
      sh.inp(cmap.final, r, finalKeys.has(key) ? 1 : 0)
      this.add(['@final', r], SH_PLANS, cmap.final, r, 'final')
      const vq = rng(cmap.q, r1, cmap.q, r2)
      const vv = rng(cmap.valid, r1, cmap.valid, r2)
      const vf = rng(cmap.final, r1, cmap.final, r2)
      const vo = rng(cmap.row, r1, cmap.row, r2)
      const vc = rng(cmap.cc, r1, cmap.cc, r2)
      sh.calc(cmap.frank, r, `=IF(AND(${C('valid')}=1,${C('final')}=1),1+SUMPRODUCT(${vv}*${vf}*((${vq}<${C('q')})+(${vq}=${C('q')})*`
        + `(${vc}<${C('cc')})+(${vq}=${C('q')})*(${vc}=${C('cc')})*(${vo}<${C('row')}))),0)`, { fmt: FMT_INT })
    }
    this.watch(SH_PLANS, cmap.final, r1, cmap.final, r2)
    this.resultChecks.push([SH_PLANS, rng(cmap.ce, r1, cmap.ce, r2, { absolute: false }), 0])
    this.resultChecks.push([SH_PLANS, rng(cmap.bb, r1, cmap.bb, r2, { absolute: false }), 0])
    const dv = new DataValidation({ type: 'list', formula1: '"0,1"', allowBlank: false })
    sh.ws.addValidation(dv)
    dv.add(rng(cmap.final, r1, cmap.final, r2, { absolute: false }))
    for (const role of ['q', 'cc', 'dom', 'cand', 'lmax', 'rmin', 'pq', 'pc', 'na', 'row']) sh.ws.column(cmap[role]).hidden = true
    sh.ws.freezePanes = sh.ws.cell(r1, b0).coordinate
    sh.protect()
  }

  /** Best-buy step and incremental cost per unit by plan id (best buys only), and the final array's ids. */
  private planMarks(): [Map<string, [number | null, number | null]>, Set<string>] {
    const ws = this.res.watershed
    const cr = ws.ceica
    if (ws.table === null || cr === null) return [new Map(), new Set()]
    const pts = cr.points
    const steps = new Map<number, number>()
    cr.walk.forEach((i, k) => steps.set(i, k + 1))
    if (pts.no_action !== null) steps.set(pts.no_action, 0)
    const incs = new Map(cr.bb_increments.map((inc) => [inc.index, inc]))
    const marks = new Map<string, [number | null, number | null]>()
    cr.bb.forEach((b, i) => {
      if (!b) return
      const inc = i !== pts.no_action ? incs.get(i) ?? null : null
      marks.set(pts.ids[i], [steps.get(i) ?? null, inc ? inc.inc_cost_per_unit : null])
    })
    const final = new Set<string>()
    for (const k of this.res.decisions.final_keys) {
      const i = wsIndexOfKey(ws, k)
      if (i !== null) final.add(pts.ids[i])
    }
    return [marks, final]
  }

  /** The app's plan values, for studies the live formulas cannot cover. */
  private plansValues(): void {
    const sh = this.sheet(SH_PLANS)
    const lab = this.p.labels
    const why = this.p.watershed.mode === 'MULTI' ? 'several alternatives per site'
      : this.p.watershed.rules.length ? 'plan formation rules' : `more than ${commaInt(LIVE_PLAN_LIMIT)} plans`
    const table = planTable(this.res, 'all', { limit: EXCEL_PLAN_ROWS, actions: true })
    let note = `This study uses ${why}, so the plan table holds the app's values rather than formulas. Site sheets stay live.`
    if (table.note) note += ` ${table.note} The Report page's table of all plans (CSV) lists every plan.`
    sh.title('Watershed plans (values from the app)', note)
    const hr = 4
    const heads = ['Plan number', 'Plan', `Lift (${lab.annual_output_short})`, 'Average annual cost', 'Construction cost', 'Unit cost',
      'Cost-effective', 'Best buy', 'Best-buy step', 'Incremental cost per unit', 'Final array']
    const widths = [9, 44, 11, 14, 14, 11, 9, 8, 8, 13, 8]
    heads.forEach((t, k) => sh.head(1 + k, hr, t, { width: widths[k] }))
    const [marks, final] = this.planMarks()
    let r = hr + 1
    for (const row of table.rows) {
      const [planId, label, lift, cost, construction, unit, ce, bb] = row as [string, string, number, number, number, number | null, boolean, boolean]
      const [step, per] = marks.get(planId) ?? [null, null]
      sh.text(1, r, Number(planId.slice(1)))
      sh.text(2, r, label)
      sh.calc(3, r, lift, { fmt: FMT_NUM3 })
      sh.calc(4, r, cost, { fmt: FMT_USD2 })
      sh.calc(5, r, construction, { fmt: FMT_USD })
      sh.calc(6, r, (unit !== null ? unit : 'n/a'), { fmt: FMT_USD2 })
      sh.calc(7, r, (ce ? 1 : 0))
      sh.calc(8, r, (bb ? 1 : 0))
      sh.calc(9, r, (step !== null ? step : ''))
      sh.calc(10, r, (per !== null ? per : ''), { fmt: FMT_USD2 })
      sh.calc(11, r, (final.has(planId) ? 1 : 0))
      r++
    }
    sh.ws.freezePanes = sh.ws.cell(hr + 1, 3).coordinate
    sh.protect()
  }

  buildWatershedSummary(): void {
    const sh = this.sheet(SH_WS)
    const lab = this.p.labels
    sh.title('Watershed summary: best buys, final array and the tentatively selected plan',
      'Tables read the watershed plans sheet. Choose the TSP from the final array.')
    if (!this.liveWatershed) {
      sh.text(1, 4, 'See the Watershed plans sheet (values from the app).', { border: false })
      sh.protect()
      return
    }
    const pl = qsheet(SH_PLANS)
    const cm = this.planCols
    const [r1, r2] = this.planRows
    const pr = (role: string): string => `${pl}!${rng(cm[role], r1, cm[role], r2)}`
    // best buys
    const top = 4
    sh.text(1, top, 'Best buys', { bold: true, border: false })
    const heads = ['Step', 'Plan number', 'Plan', `Lift (${lab.annual_output_short})`, 'Average annual cost', 'Construction cost', 'Unit cost',
      'Incremental cost per unit']
    const widths = [7, 10, 40, 12, 15, 15, 12, 14]
    heads.forEach((t, k) => sh.head(1 + k, top + 1, t, { width: widths[k] }))
    for (let i = 0; i < LIST_ROWS; i++) {
      const r = top + 2 + i
      const k = i + 1
      const m = `MATCH(${k},${pr('rank')},0)`
      sh.text(1, r, k)
      for (const [c, role, fmt] of [[2, 'pnum', FMT_INT], [3, 'label', null], [4, 'lift', FMT_NUM3], [5, 'cost', FMT_USD2], [6, 'con', FMT_USD],
        [7, 'unit', FMT_USD2], [8, 'per', FMT_USD2]] as const) {
        sh.calc(c, r, `=IFERROR(INDEX(${pr(role)},${m}),"")`, { fmt })
      }
    }
    // final array ladder
    const top2 = top + LIST_ROWS + 4
    sh.text(1, top2, 'Final array (in order of output) and \'Is it worth it?\'', { bold: true, border: false })
    const heads2 = ['Order', 'Plan number', 'Plan', `Lift (${lab.annual_output_short})`, 'Average annual cost', 'Construction cost',
      'Unit cost', 'Added output', 'Added cost', 'Added cost per unit', 'Worth it?', 'Why']
    const widths2 = [7, 10, 40, 12, 15, 15, 12, 12, 13, 14, 10, 50]
    heads2.forEach((t, k) => sh.head(1 + k, top2 + 1, t, { width: widths2[k] }))
    const steps = new Map(this.res.decisions.ladder.map((s) => [s.to_key, s]))
    const finalKeys = [...this.res.decisions.final_keys]
    const firstF = top2 + 2
    for (let i = 0; i < LIST_ROWS; i++) {
      const r = firstF + i
      const k = i + 1
      const m = `MATCH(${k},${pr('frank')},0)`
      sh.text(1, r, k)
      for (const [c, role, fmt] of [[2, 'pnum', FMT_INT], [3, 'label', null], [4, 'lift', FMT_NUM3], [5, 'cost', FMT_USD2], [6, 'con', FMT_USD],
        [7, 'unit', FMT_USD2]] as const) {
        sh.calc(c, r, `=IFERROR(INDEX(${pr(role)},${m}),"")`, { fmt })
      }
      if (i === 0) {
        for (const c of [8, 9, 10]) sh.calc(c, r, '')
      } else {
        sh.calc(8, r, `=IF(ISNUMBER(D${r}),D${r}-D${r - 1},"")`, { fmt: FMT_NUM3 })
        sh.calc(9, r, `=IF(ISNUMBER(E${r}),E${r}-E${r - 1},"")`, { fmt: FMT_USD2 })
        sh.calc(10, r, `=IF(AND(ISNUMBER(H${r}),H${r}<>0),I${r}/H${r},"")`, { fmt: FMT_USD2 })
      }
      const step = i > 0 && i < finalKeys.length ? steps.get(finalKeys[i]) ?? null : null
      const worth = step && step.note ? ({ YES: 'Yes', NO: 'No' } as Record<string, string>)[step.note.worth_it] ?? '' : ''
      sh.inp(11, r, worth)
      sh.inp(12, r, step && step.note ? step.note.why : '')
      this.add(['@worth', i], SH_WS, 11, r, 'text')
      this.add(['@why', i], SH_WS, 12, r, 'text')
      sh.ws.cell(r, 12).alignment = WRAP
    }
    const dv = new DataValidation({ type: 'list', formula1: '"Yes,No"', allowBlank: true })
    sh.ws.addValidation(dv)
    dv.add(`K${firstF + 1}:K${firstF + LIST_ROWS - 1}`)
    this.watch(SH_WS, 11, firstF, 12, firstF + LIST_ROWS - 1)
    // TSP
    const top3 = firstF + LIST_ROWS + 2
    sh.text(1, top3, 'Tentatively selected plan', { bold: true, border: false })
    sh.text(1, top3 + 1, 'Plan number')
    const ws = this.res.watershed
    let tspNum: number | null = null
    if (this.res.decisions.tsp_key !== null) {
      const i = wsIndexOfKey(ws, this.res.decisions.tsp_key)
      if (i !== null) tspNum = Number(ws.table!.plan_no[i])
    }
    sh.inp(2, top3 + 1, tspNum, { fmt: FMT_INT })
    this.add(['@tsp'], SH_WS, 2, top3 + 1, 'tsp')
    const dv2 = new DataValidation({ type: 'list', formula1: `=${qsheet(SH_WS)}!$B$${firstF}:$B$${firstF + LIST_ROWS - 1}`, allowBlank: true })
    sh.ws.addValidation(dv2)
    dv2.add(`B${top3 + 1}`)
    this.watch(SH_WS, 2, top3 + 1, 2, top3 + 1)
    const m = `MATCH($B$${top3 + 1},${pr('pnum')},0)`
    ;([['Plan', 'label', null], [`Lift (${lab.annual_output_short})`, 'lift', FMT_NUM3], ['Average annual cost', 'cost', FMT_USD2],
      ['Construction cost', 'con', FMT_USD], ['Unit cost', 'unit', FMT_USD2], ['In the final array', 'final', null]] as const)
      .forEach(([t, role, fmt], k) => {
        sh.text(1, top3 + 2 + k, t)
        sh.calc(2, top3 + 2 + k, `=IFERROR(INDEX(${pr(role)},${m}),"n/a")`, { fmt })
      })
    this.tspCell = [top3 + 1, 2]
    sh.protect()
  }

  buildIwr(): void {
    const sh = this.sheet(SH_IWR)
    const lab = this.p.labels
    sh.title('IWR Planning Suite II input',
      'Paste-ready plan, output and cost columns for an independent re-run in IWR Planning Suite II (user-entered planning set; No Action '
      + 'is the first plan).')
    const hr = 4
    sh.text(1, hr, 'Site planning sets', { bold: true, border: false })
    const heads = ['Site', 'Plan', `Output (${lab.annual_output_short} above No Action)`, 'Cost (average annual, above No Action)']
    heads.forEach((t, k) => sh.head(1 + k, hr + 1, t, { width: [9, 16, 20, 22][k] }))
    const siteSh = qsheet(SH_SITE)
    let r = hr + 2
    for (const site of this.p.sites) {
      for (const alt of site.alternatives) {
        const sr = this.siteAltRow.get(lineKey(site.id, alt.id))!
        sh.text(1, r, site.id)
        sh.text(2, r, alt.id)
        sh.calc(3, r, `=${siteSh}!I${sr}/10^in_out_dp`, { fmt: FMT_NUM3 })
        sh.calc(4, r, `=${siteSh}!J${sr}/10^in_cost_dp`, { fmt: FMT_USD2 })
        r++
      }
    }
    if (this.liveWatershed) {
      r++
      sh.text(1, r, 'Watershed planning set (valid plans)', { bold: true, border: false })
      r++
      ;['Plan number', 'Plan', 'Output', 'Cost'].forEach((t, k) => sh.head(1 + k, r, t))
      r++
      const pl = qsheet(SH_PLANS)
      const cm = this.planCols
      const [p1, p2] = this.planRows
      for (let pr = p1; pr <= p2; pr++) {
        sh.calc(1, r, `=${pl}!${a1(cm.pnum, pr)}`, { fmt: FMT_INT })
        sh.calc(2, r, `=${pl}!${a1(cm.label, pr)}`)
        sh.calc(3, r, `=IF(${pl}!${a1(cm.valid, pr)}=1,${pl}!${a1(cm.lift, pr)},"")`, { fmt: FMT_NUM3 })
        sh.calc(4, r, `=IF(${pl}!${a1(cm.valid, pr)}=1,${pl}!${a1(cm.cost, pr)},"")`, { fmt: FMT_USD2 })
        r++
      }
    }
    sh.protect()
  }

  buildCharts(): void {
    if (!this.liveWatershed) return
    const sh = this.sheet(SH_CHARTS)
    const lab = this.p.labels
    sh.title('Charts: watershed cost-effectiveness and incremental cost', 'Built from the watershed plans sheet; they update with the inputs.')
    const pl = qsheet(SH_PLANS)
    const cm = this.planCols
    const [p1, p2] = this.planRows
    const hr = 30
    ;['Other plans: lift', 'Other plans: cost', 'Frontier: lift', 'Frontier: cost', 'Best buys: lift', 'Best buys: cost', 'Step boxes: lift',
      'Step boxes: cost per unit'].forEach((t, k) => sh.head(1 + k, hr, t, { width: 13 }))
    sh.head(13, hr, 'TSP: lift', { width: 13 })
    sh.head(14, hr, 'TSP: cost', { width: 13 })
    const n = p2 - p1 + 1
    const ceRankCol = 10
    sh.head(ceRankCol + 1, hr, '(frontier order)', { width: 10 })
    for (let i = 0; i < n; i++) {
      const r = hr + 1 + i
      const src = p1 + i
      const other = `AND(${pl}!${a1(cm.valid, src)}=1,${pl}!${a1(cm.ce, src)}<>1)`
      sh.calc(1, r, `=IF(${other},${pl}!${a1(cm.lift, src)},NA())`, { fmt: FMT_NUM3 })
      sh.calc(2, r, `=IF(${other},${pl}!${a1(cm.cost, src)},NA())`, { fmt: FMT_USD })
      const vce = `${pl}!${rng(cm.ce, p1, cm.ce, p2)}`
      const vq = `${pl}!${rng(cm.q, p1, cm.q, p2)}`
      const vrow = `${pl}!${rng(cm.row, p1, cm.row, p2)}`
      const me = `${pl}!${a1(cm.q, src)}`
      sh.calc(ceRankCol + 1, r, `=IF(${pl}!${a1(cm.ce, src)}=1,1+SUMPRODUCT(${vce}*((${vq}<${me})+(${vq}=${me})*(${vrow}<${pl}!`
        + `${a1(cm.row, src)}))),0)`)
    }
    const rankRng = rng(ceRankCol + 1, hr + 1, ceRankCol + 1, hr + n)
    for (let i = 0; i < n; i++) {
      const r = hr + 1 + i
      const m = `MATCH(${i + 1},${rankRng},0)`
      sh.calc(3, r, `=IFERROR(INDEX(${pl}!${rng(cm.lift, p1, cm.lift, p2)},${m}),NA())`, { fmt: FMT_NUM3 })
      sh.calc(4, r, `=IFERROR(INDEX(${pl}!${rng(cm.cost, p1, cm.cost, p2)},${m}),NA())`, { fmt: FMT_USD })
      const mb = `MATCH(${i + 1},${pl}!${rng(cm.rank, p1, cm.rank, p2)},0)`
      sh.calc(5, r, `=IFERROR(INDEX(${pl}!${rng(cm.lift, p1, cm.lift, p2)},${mb}),NA())`, { fmt: FMT_NUM3 })
      sh.calc(6, r, `=IFERROR(INDEX(${pl}!${rng(cm.cost, p1, cm.cost, p2)},${mb}),NA())`, { fmt: FMT_USD })
    }
    // incremental cost as the app draws it: a box per best-buy step, outlined bottom left, top left, top
    // right, bottom right; steps that do not exist are #N/A
    const steps = Math.min(n, LIST_ROWS)
    const r0 = hr + 1
    for (let k = 1; k < steps; k++) {
      const base = r0 + (k - 1) * 4
      const prevL = `E${r0 + k - 1}`
      const curL = `E${r0 + k}`
      const per = `IFERROR(INDEX(${pl}!${rng(cm.per, p1, cm.per, p2)},MATCH(${k + 1},${pl}!${rng(cm.rank, p1, cm.rank, p2)},0)),NA())`
      const topCell = `H${base + 1}`
      const floor = `=IF(ISNUMBER(${topCell}),0,NA())`
      ;[[prevL, floor], [prevL, `=${per}`], [curL, `=${topCell}`], [curL, floor]].forEach(([x, y], j) => {
        sh.calc(7, base + j, `=${x}`, { fmt: FMT_NUM3 })
        sh.calc(8, base + j, y, { fmt: FMT_USD })
      })
    }
    // the tentatively selected plan, from its number on the watershed summary
    const tsp = `${qsheet(SH_WS)}!${a1(this.tspCell[1], this.tspCell[0], { absolute: true })}`
    const at = `MATCH(${tsp},${pl}!${rng(cm.pnum, p1, cm.pnum, p2)},0)`
    for (const [c, role, fmt] of [[13, 'lift', FMT_NUM3], [14, 'cost', FMT_USD]] as const) {
      sh.calc(c, r0, `=IFERROR(INDEX(${pl}!${rng(cm[role], p1, cm[role], p2)},${at}),NA())`, { fmt })
    }
    const last = hr + n
    const unit = lab.annual_output_short
    const xLabel = `${lab.lift_name} (${unit})`
    const noun = oneSite(this.p) ? 'plans' : 'watershed plans'
    const ref = (c: number, a: number, b: number): string => reference(SH_CHARTS, col(c), a, b)
    const marks = (size: number, stroke: string, width: number, fill: string | null) => ({ size, stroke, width, fill })
    const series: Series[] = [
      { name: 'Plan', x: ref(1, r0, last), y: ref(2, r0, last), line: null, marker: marks(5, MUTED, 0.75, 'FFFFFF') },
      { name: 'Cost-effective frontier', x: ref(3, r0, last), y: ref(4, r0, last), line: { color: NAVY, width: 2 }, marker: marks(5, NAVY, 0.75, NAVY) },
      { name: 'Best buy', x: ref(5, r0, last), y: ref(6, r0, last), line: null, marker: marks(10, NAVY, 1.75, null) },
      { name: 'Tentatively selected plan', x: ref(13, r0, r0), y: ref(14, r0, r0), line: null, marker: marks(14, DECISION, 1.75, null) },
    ]
    sh.ws.charts.push(scatterChart({ title: `Cost-effectiveness of ${noun}`, xLabel, yLabel: 'Average annual cost', yFormat: FMT_USD, series,
      anchor: 'A4' }))
    sh.ws.charts.push(scatterChart({ title: 'Incremental cost of best-buy plans', xLabel, yLabel: `Incremental cost per ${unit}`, yFormat: FMT_USD,
      series: [{ name: 'Best-buy step', x: ref(7, r0, r0 + 4 * steps), y: ref(8, r0, r0 + 4 * steps), line: { color: NAVY, width: 1.5 },
        marker: 'none' }], anchor: 'J4' }))
    sh.protect()
  }

  buildReadme(): void {
    const sh = this.sheet(SH_README)
    this.wb.moveSheet(sh.ws, -(this.wb.sheets.length - 1))
    const p = this.p
    sh.title(`${p.name}: CE/ICA calculator`, 'Cost-effectiveness and incremental cost analysis, as live formulas.')
    sh.width(1, 34)
    sh.width(2, 70)
    const info: [string, string][] = [
      ['Study', p.name],
      ['Generated by', `CEICA ${APP_VERSION} (engine ${ENGINE_VERSION})`],
      ['Project digest', shortDigest(p)],
      ['Discount rate', `${pyG(p.settings.discount_rate * 100)} percent`],
      ['Period of analysis', `${p.settings.period_of_analysis} years`],
    ]
    let r = 4
    for (const [k, v] of info) {
      sh.text(1, r, k, { bold: true })
      sh.text(2, r, v)
      r++
    }
    r++
    sh.text(1, r, 'Status', { bold: true })
    const changed = this.changedFormula()
    const mism = this.mismatchFormula()
    // the status reads the two count cells below, so the long sums appear once each
    sh.calc(2, r, `=IF(B${r + 1}=0,IF(B${r + 2}=0,"Unchanged: matches the CEICA export","ERROR: results differ from the export although no `
      + `input changed"),"Edited: "&B${r + 1}&" input cells changed since the export")`, { bold: true })
    sh.nameCell('out_status', 2, r)
    sh.text(1, r + 1, 'Inputs changed')
    sh.calc(2, r + 1, `=${changed}`, { fmt: FMT_INT })
    sh.nameCell('out_changed', 2, r + 1)
    sh.text(1, r + 2, 'Results that differ from the export')
    sh.calc(2, r + 2, `=${mism}`, { fmt: FMT_INT })
    sh.nameCell('out_mismatch', 2, r + 2)
    r += 4
    sh.text(1, r, 'How to use', { bold: true, border: false })
    const lines = [
      `Orange cells are inputs; grey cells are formulas. Sheets are protected (password '${PASSWORD}') only to prevent accidental edits.`,
      'Change any orange cell: annualization, site CE/ICA, the watershed plans and the summary update. Changed inputs turn yellow.',
      'To add sites, alternatives or years, make the change in CEICA and export again.',
      'Import this workbook in CEICA to bring your changes back into the project.',
    ]
    for (const line of lines) {
      r++
      const c = sh.ws.cell(r, 1, '- ' + line)
      c.alignment = alignment({ wrapText: false })
    }
    r += 2
    sh.text(1, r, 'Legend', { bold: true, border: false })
    sh.put(1, r + 1, 'Input', { fill: solid('F8CBAD') })
    sh.calc(1, r + 2, 'Formula')
    sh.put(1, r + 3, 'Changed since export', { fill: solid(C_CHANGED) })
    sh.protect()
  }

  private changedFormula(): string {
    const parts = this.snapRanges.map(([sheet, rg]) => `SUMPRODUCT(1*(${qsheet(sheet)}!${rg}<>${qsheet(`snap ${sheet}`)}!${rg}))`)
    return parts.length ? '(' + parts.join('+') + ')' : '0'
  }

  private mismatchFormula(): string {
    const parts = this.resultChecks.map(([sheet, rg, tol]) => {
      const s = qsheet(sheet)
      const t = qsheet(`snap ${sheet}`)
      return tol === 0 ? `SUMPRODUCT(1*(${s}!${rg}<>${t}!${rg}))` : `SUMPRODUCT(1*(ABS(${s}!${rg}-${t}!${rg})>${pyFloat(tol)}))`
    })
    return parts.length ? '(' + parts.join('+') + ')' : '0'
  }

  /** The app's values for the result cells the calculator checks against its snapshot (values.py). */
  private computedValues(): Map<string, CellValue> {
    const res = this.res
    const out = new Map<string, CellValue>()
    for (const [key, r] of this.summaryRow) {
      out.set(`${SH_SUMMARY}!${a1(7, r)}`, res.benefits.get(key)!.lift)
      out.set(`${SH_SUMMARY}!${a1(12, r)}`, res.costs.get(key)!.annual)
    }
    for (const site of this.p.sites) {
      for (const alt of site.alternatives) {
        const r = this.siteAltRow.get(lineKey(site.id, alt.id))!
        const row = siteRow(res.sites.get(site.id)!, alt.id)
        out.set(`${SH_SITE}!${a1(12, r)}`, row ? (row.ce ? 1 : 0) : 0)
        out.set(`${SH_SITE}!${a1(16, r)}`, row ? (row.bb ? 1 : 0) : 0)
      }
    }
    if (this.liveWatershed) {
      const ws = res.watershed
      const cm = this.planCols
      const [r1, r2] = this.planRows
      const recs = new Map(this.planSites.map((s) => [s, res.decisions.sites.get(s)?.alt_id ?? null]))
      const nSites = this.planSites.length
      for (let r = r1; r <= r2; r++) {
        const i = r - r1
        const bits = this.planSites.map((_, j) => (i >> (nSites - 1 - j)) & 1)
        const valid = this.planSites.every((s, j) => !bits[j] || ws.carried.has(s))
        let ce = 0
        let bb = 0
        if (valid && ws.table !== null) {
          const comp = new Map<string, string | null>()
          this.planSites.forEach((s, j) => {
            if (bits[j]) comp.set(s, recs.get(s) ?? null)
          })
          const idx = wsIndexOfKey(ws, compositionKey(comp as Map<string, string>))
          if (idx !== null) {
            ce = ws.ceica!.ce[idx]
            bb = ws.ceica!.bb[idx]
          }
        }
        out.set(`${SH_PLANS}!${a1(cm.ce, r)}`, ce)
        out.set(`${SH_PLANS}!${a1(cm.bb, r)}`, bb)
      }
    }
    return out
  }

  /** Very hidden copies of every watched input and checked result, as values. */
  buildSnapshots(): void {
    const bySheet = new Map<string, string[]>()
    for (const [sheet, rg] of this.snapRanges) {
      if (!bySheet.has(sheet)) bySheet.set(sheet, [])
      bySheet.get(sheet)!.push(rg)
    }
    for (const [sheet, rg] of this.resultChecks) {
      if (!bySheet.has(sheet)) bySheet.set(sheet, [])
      bySheet.get(sheet)!.push(rg)
    }
    const values = this.computedValues()
    for (const [sheet, ranges] of bySheet) {
      const src = this.sheets.get(sheet)!.ws
      const snap = this.wb.createSheet(`snap ${sheet}`)
      snap.state = 'veryHidden'
      for (const rg of ranges) {
        // ws[range]: every cell of it, made in the sheet when it is new
        const [a, b] = rg.split(':')
        const [r1, c1] = parseA1(a)
        const [r2, c2] = parseA1(b ?? a)
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const cell: Cell = src.cell(r, c)
            const key = `${sheet}!${cell.coordinate}`
            const v = values.has(key) ? values.get(key)! : cell.value
            snap.cell(r, c).set(v)
          }
        }
      }
      snap.protection = { password: PASSWORD, formatColumns: true, formatRows: true, autoFilter: true, sort: true }
    }
    // highlight changed inputs
    for (const [sheet, rg] of this.snapRanges) {
      const ws = this.sheets.get(sheet)!.ws
      const first = rg.split(':')[0]
      const t = qsheet(`snap ${sheet}`)
      ws.addConditional(rg, { formula: `${first}<>${t}!${first}`, dxf: { fill: solid(C_CHANGED) } })
    }
  }

  buildManifest(): void {
    const ws = this.wb.createSheet(SH_MANIFEST)
    ws.state = 'veryHidden'
    const payload = {
      format: FORMAT, formatVersion: FORMAT_VERSION, appVersion: APP_VERSION, schemaVersion: PROJECT_SCHEMA, engineVersion: ENGINE_VERSION,
      projectDigest: shortDigest(this.p), liveWatershed: this.liveWatershed,
      planRowKeys: Object.fromEntries([...this.planRowKeys].map(([k, v]) => [String(k), v])),
      planSites: this.planSites, planBits: this.planBits ? [...this.planBits] : [], layout: this.layout,
    }
    const textProj = canonicalJson(dumpProject(this.p))
    const textMeta = pyDumps(payload, { sortKeys: true, separators: [',', ':'] })
    ws.cell(1, 1, FORMAT)
    ws.cell(1, 2, FORMAT_VERSION)
    let r = 2
    for (const [label, text] of [['project', textProj], ['meta', textMeta]] as const) {
      const points = [...text]
      const chunks: string[] = []
      for (let i = 0; i < points.length; i += CHUNK) chunks.push(points.slice(i, i + CHUNK).join(''))
      if (!chunks.length) chunks.push('')
      ws.cell(r, 1, label)
      ws.cell(r, 2, chunks.length)
      chunks.forEach((ch, k) => ws.cell(r, 3 + k, ch))
      r++
    }
    ws.protection = { password: PASSWORD, formatColumns: true, formatRows: true, autoFilter: true, sort: true }
  }

  build(): Uint8Array {
    this.buildParameters()
    this.buildStaf()
    this.buildBenefits()
    this.buildCosts()
    this.buildRecurring()
    this.buildSummary()
    this.buildSiteCeica()
    this.buildSites()
    this.buildPlans()
    this.buildWatershedSummary()
    this.buildIwr()
    this.buildCharts()
    this.buildReadme()
    this.buildSnapshots()
    this.buildManifest()
    this.wb.active = 0
    return this.wb.save()
  }
}

/** "B4" or "$B$4" as [row, column] */
function parseA1(ref: string): [number, number] {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref)!
  let c = 0
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64
  return [Number(m[2]), c]
}

/** The live-formula Excel calculator for a project, as .xlsx bytes. */
export function buildCalculator(project: Project, results: AnalysisResults): Uint8Array {
  return new CalculatorBuilder(project, results).build()
}
