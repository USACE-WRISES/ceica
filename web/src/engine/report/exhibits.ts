// Every figure and table of a study, in document order: the catalog behind the Report page, the
// figures-and-tables document and every file the page offers (ceica/report/exhibits.py).
//
// catalog(results) is cheap. It lists titles, captions and row counts and builds nothing large
// (never the table of every plan, never a figure). An exhibit's build() makes its figure panels or
// table rows on demand. Table cells are typed, so numbers stay numbers in CSV and Excel, and
// cellText formats them for documents. Lift and cost are the rounded values CE/ICA compared, so a
// data file reproduces ties and a plan's site rows add up to the plan.
//
// The table of every plan (planTable) builds its rows as they are read: a study can hold millions
// of plans.
import { pyFixed, pyFloat, pyG } from '../../py/pyfmt'
import { commaInt, pySum } from '../../py/pynum'
import { pyCapitalize, pyStrip } from '../../py/pystr'
import {
  type AnalysisResults, planOrder, type PlanRow, planRow, planRows, type SiteResult, siteRow, wsBb, wsCe, wsIndexOfKey,
} from '../analysis'
import { lineKey } from '../annualize'
import { stafRollups } from '../benefits'
import * as staf from '../benefits/staf'
import {
  DENSITY_NOTE, leftOutOfTimeSeries, siteCeIca, siteCostStack, siteStaf, siteTimeSeries, watershedCeIca,
} from '../figures'
import { DENSITY_ABOVE, type Scene, withLegend } from '../figures/scene'
import { countText, money, NA, num } from '../fmt'
import {
  alternativeOf, byYear, isStaf, noAction, type Project, type Rule, type Settings, type Site, siteOf,
} from '../model'
import { POW10, ratio, unscale } from '../numeric'
import { digitsOf, isBinary, planLabel, tableLength } from '../plans'
import { shortDigest } from '../projectfile'
import { oneSite } from '../runState'
import { type FunctionLift, planFunctionLift, siteFunctionLift } from '../stafLift'
import { APP_NAME, APP_VERSION, ENGINE_VERSION } from '../version'

/** Plans a document prints before it lists only the cost-effective ones. */
export const DOC_PLAN_ROWS = 512
/** Plans an Excel sheet holds before it lists only the cost-effective ones. */
export const EXCEL_PLAN_ROWS = 10_000
/** Plans the CSV in the Everything zip holds before it lists only the cost-effective ones. */
export const ZIP_PLAN_ROWS = 100_000
/** Above this many sites, documents name a plan's actions in one column, not one per site. */
export const ACTIONS_ABOVE_SITES = 12

/** Groups in document order (results first, then the decisions and the inputs behind them). */
export const GROUPS = ['study', 'plans', 'sites', 'staf', 'decisions', 'inputs'] as const
const GROUP_TITLES: Record<string, string> = {
  study: 'Study', plans: 'Watershed plans', sites: 'Sites', staf: 'STAF functions and outcomes', decisions: 'Decisions',
  inputs: 'Benefits and costs',
}

export const CE_PANELS = ['(A) Cost-effectiveness', '(B) Incremental cost'] as const
export const STAF_PANELS = ['(A) Ecosystem Condition Index', '(B) Lift by outcome'] as const

export type Kind = 'text' | 'money' | 'number' | 'count' | 'flag'

export interface Column {
  readonly name: string
  readonly kind: Kind
  /** Decimals a document shows (number and money columns). */
  readonly decimals: number
  /** "l", "r" or "c"; by default text is left, flags centered and numbers right. */
  readonly align: string
}

export const column = (name: string, kind: Kind = 'text', decimals = 0, align = ''): Column => ({ name, kind, decimals, align })
export const columnSide = (c: Column): string => c.align || (c.kind === 'text' ? 'l' : c.kind === 'flag' ? 'c' : 'r')

/** A Python int in a table cell (a CSV writes it without a decimal point). */
export class PyInt {
  constructor(readonly value: number) {}
}

/** A table cell, typed as the Python's: text, a float, an int, a flag or None. */
export type Cell = string | number | PyInt | boolean | null

export interface TableData {
  readonly columns: readonly Column[]
  readonly rows: readonly (readonly Cell[])[]
  readonly total_last: boolean
  /** Too wide to read upright: documents print it on a landscape page. */
  readonly landscape: boolean
  /** A sentence printed under the table: which rows are left out, and why. */
  readonly note: string
}

const table = (columns: readonly Column[], rows: readonly (readonly Cell[])[], { totalLast = false, landscape = false, note = '' } = {}):
  TableData => ({ columns, rows, total_last: totalLast, landscape, note })

export interface FigureData {
  /** The panels, with their legends drawn in. */
  readonly panels: readonly Scene[]
  /** "(A) ..." labels, one per panel, when there is more than one panel. */
  readonly labels: readonly string[]
}

export interface BuildOptions {
  limit?: number | null
  actions?: boolean
}

export interface Exhibit {
  readonly id: string
  readonly kind: 'figure' | 'table'
  readonly group: string
  /** Figure n or Table n, in the full document's order. */
  readonly number: number
  /** A few words for the page and for file names. */
  readonly title: string
  readonly caption: string
  /** In the key figures and tables (the short document). */
  readonly key: boolean
  /** Rows of a table (null for a figure). */
  readonly n_rows: number | null
  readonly build: (opts?: BuildOptions) => FigureData | TableData
}

export const exhibitLabel = (e: Exhibit): string => `${e.kind === 'figure' ? 'Figure' : 'Table'} ${e.number}`

interface Spec {
  id: string
  kind: 'figure' | 'table'
  group: string
  title: string
  caption: string
  key: boolean
  build: (opts?: BuildOptions) => FigureData | TableData
  n_rows?: number | null
}

export function groupTitle(group: string, project: Project | null): string {
  if (group === 'plans' && project !== null && oneSite(project)) return 'Plans'
  return GROUP_TITLES[group]
}

/** Build once per set of options (catalog counts the rows, the document prints them). */
function memo<T>(fn: (opts: BuildOptions) => T): (opts?: BuildOptions) => T {
  const cache = new Map<string, T>()
  return (opts: BuildOptions = {}) => {
    const k = JSON.stringify(Object.entries(opts).filter(([, v]) => v !== undefined).sort())
    if (!cache.has(k)) cache.set(k, fn(opts))
    return cache.get(k)!
  }
}

/** A cell as a document prints it: money, numbers with their decimals, Yes or No, n/a. */
export function cellText(value: Cell, col: Column): string {
  if (value === null) return NA
  if (typeof value === 'string') return value
  if (col.kind === 'flag') return (value instanceof PyInt ? value.value : value) ? 'Yes' : 'No'
  const v = value instanceof PyInt ? value.value : typeof value === 'boolean' ? Number(value) : value
  if (col.kind === 'money') return money(v, col.decimals)
  if (col.kind === 'number') return num(v, col.decimals)
  if (col.kind === 'count') return commaInt(Math.trunc(v))
  return value instanceof PyInt ? String(value.value) : typeof value === 'boolean' ? (value ? 'True' : 'False') : pyFloat(value)
}

function altName(site: Site | null, altId: string | null): string | null {
  if (altId === null) return null
  const a = site ? alternativeOf(site, altId) : null
  if (a === null) return altId
  return a.is_no_action ? 'No Action' : (a.name || a.id)
}

/** (lift, cost) per alternative as CE/ICA compared them: the rounded integers, unscaled. */
function siteValues(sr: SiteResult | undefined): Map<string, [number, number]> {
  if (!sr || sr.ceica === null) return new Map()
  const pts = sr.ceica.points
  return new Map(pts.ids.map((a, i) => [a, [unscale(pts.output[i], pts.output_dp), unscale(pts.cost[i], pts.cost_dp)]]))
}

function siteWhere(site: Site): string {
  return `site ${site.id}` + (site.name && site.name !== site.id ? ` (${site.name})` : '')
}

function figure(scenes: readonly (Scene | null)[] | null, labels: readonly string[] = []): FigureData {
  const list = (scenes ?? []).filter((s): s is Scene => s !== null)
  return { panels: list.map(withLegend), labels: list.length > 1 ? labels.slice(0, list.length) : [] }
}

/** Confirmed, Suggested, Needs review or Inputs incomplete. */
export function siteStatus(res: AnalysisResults, siteId: string): string {
  const st = res.decisions.sites.get(siteId)
  const sr = res.sites.get(siteId)
  if (!st || !sr || !sr.ready || st.source === 'none') return 'Inputs incomplete'
  if (st.stale) return 'Needs review'
  return st.source === 'team' ? 'Confirmed' : 'Suggested'
}

// --- STAF helpers (lift of the recommended alternatives and of the TSP) --------------------------

/** (site, alternative) for every site whose recommendation is a restoration alternative. */
export function stafCarried(res: AnalysisResults): [string, string][] {
  const out: [string, string][] = []
  for (const s of res.project.sites) {
    const dst = res.decisions.sites.get(s.id)
    if (!dst || !dst.alt_id) continue
    const a = alternativeOf(s, dst.alt_id)
    if (a !== null && !a.is_no_action) out.push([s.id, a.id])
  }
  return out
}

/** (plan id, lift by function and outcome) of the tentatively selected plan. */
export function tspFunctionLift(res: AnalysisResults): [string, FunctionLift] | null {
  const d = res.decisions
  const ws = res.watershed
  if (d.tsp_state !== 'ok' || ws.table === null) return null
  const row = planRow(ws, wsIndexOfKey(ws, d.tsp_key!)!)
  const fl = planFunctionLift(res, row.composition)
  return fl === null ? null : [row.plan_id, fl]
}

// --- plan tables ---------------------------------------------------------------------------------

const noun = (project: Project): string => (oneSite(project) ? 'plans' : 'watershed plans')

function siteColumns(res: AnalysisResults, actions: boolean): Column[] {
  const ws = res.watershed
  if (actions) return [column('Actions')]
  const kind: Kind = isBinary(ws.space!) ? 'count' : 'text'
  return ws.space!.site_ids.map((s) => column(s, kind, 0, 'c'))
}

function siteCells(res: AnalysisResults, comp: ReadonlyMap<string, string>, label: string, actions: boolean): Cell[] {
  const ws = res.watershed
  if (actions) return [label]
  if (isBinary(ws.space!)) return ws.space!.site_ids.map((s) => new PyInt(comp.has(s) ? 1 : 0))
  return ws.space!.site_ids.map((s) => comp.get(s) ?? '')
}

const wide = (res: AnalysisResults, actions: boolean): boolean => !actions && res.watershed.space!.site_ids.length > 9

/** Best-buy plans (last "inc") or the final array (last "flags") from plan rows. */
function planRowsTable(res: AnalysisResults, rows: readonly PlanRow[], actions: boolean, last: 'inc' | 'flags'): TableData {
  const unit = res.project.labels.annual_output_short
  const cols = [column('Plan'), ...siteColumns(res, actions), column(`Lift (${unit})`, 'number', 2), column('Average annual cost', 'money'),
    column('Construction cost', 'money'), column(`Unit cost ($/${unit})`, 'money'),
    ...(last === 'inc' ? [column(`Incremental cost per ${unit}`, 'money')]
      : [column('Cost-effective', 'flag'), column('Best buy', 'flag')])]
  const out = rows.map((r) => {
    const cells: Cell[] = [r.plan_id, ...siteCells(res, r.composition, r.label, actions), r.output, r.cost, r.construction, r.unit_cost]
    if (last === 'inc') cells.push(r.inc_cost_per_unit !== null ? r.inc_cost_per_unit : 0.0)
    else cells.push(r.ce, r.bb)
    return cells
  })
  return table(cols, out, { landscape: wide(res, actions) })
}

/** Rows made as they are read (exhibits.py's _Rows): an array to its readers, each row built when it is
 * indexed or iterated, so the table of every plan needs no object per plan until a file writes it. */
export function lazyRows(n: number, row: (k: number) => Cell[]): readonly (readonly Cell[])[] {
  const index = (prop: string | symbol): number => (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop) ? Number(prop) : -1)
  return new Proxy([] as Cell[][], {
    get(target, prop, receiver) {
      if (prop === 'length') return n
      const k = index(prop)
      if (k >= 0) return k < n ? row(k) : undefined
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      const k = index(prop)
      return k >= 0 ? k < n : Reflect.has(target, prop)
    },
  })
}

/** Watershed plans in order of output: "all" or "ce" (the cost-effective ones). Above ``limit`` rows only
 * the cost-effective plans are listed (and at most ``limit`` of them), with a note that says so. */
export function planTable(res: AnalysisResults, which: 'all' | 'ce' = 'all', { limit = null, actions = false }: BuildOptions = {}): TableData {
  const ws = res.watershed
  const p = res.project
  const unit = p.labels.annual_output_short
  const t = ws.table
  const cr = ws.ceica
  if (t === null || cr === null) return table([column('Plan')], [])
  const pts = cr.points
  const nAll = tableLength(t)
  let order = planOrder(ws, which === 'all' ? 'all' : 'ce')
  let note = ''
  if (limit !== null && order.length > limit) {
    order = planOrder(ws, 'ce')
    note = `Only the ${commaInt(order.length)} cost-effective plans are listed, of ${commaInt(t.ce_only ? t.n_valid : nAll)}.`
  }
  if (limit !== null && order.length > limit) {
    order = order.slice(0, limit)
    note += ` The first ${commaInt(limit)} in order of output are listed.`
  }
  const space = t.space
  const binary = isBinary(space)
  const names = space.options.map((opts) => ['', ...opts])
  const construction = t.extra.get('construction') ?? null
  const odp = pts.output_dp
  const cdp = pts.cost_dp
  const row = (k: number): Cell[] => {
    const i = order[k]
    const q = t.output[i]
    const c = t.cost[i]
    const digits = digitsOf(t, i)
    const cells: Cell[] = [pts.ids[i]]
    if (actions) cells.push(planLabel(space, digits))
    else if (binary) for (const d of digits) cells.push(new PyInt(d > 0 ? 1 : 0))
    else digits.forEach((d, j) => cells.push(names[j][d]))
    // unit cost as the engine's ratio(): one division of the exact scaled integers, which a double holds
    // exactly below 2**53; larger values take ratio() itself
    let unitCost: number | null = null
    if (q > 0) {
      const top = c * POW10[odp]
      const bottom = q * POW10[cdp]
      unitCost = Math.abs(top) >= 2 ** 53 || bottom >= 2 ** 53 ? ratio(c, q, cdp, odp) : top / bottom
      if (Number.isNaN(unitCost)) unitCost = null
    }
    cells.push(unscale(q, odp), unscale(c, cdp), construction !== null ? construction[i] : 0.0, unitCost, cr.ce[i] !== 0, cr.bb[i] !== 0)
    return cells
  }
  const cols = [column('Plan'), ...siteColumns(res, actions), column(`Lift (${unit})`, 'number', 2), column('Average annual cost', 'money'),
    column('Construction cost', 'money'), column(`Unit cost ($/${unit})`, 'money'), column('Cost-effective', 'flag'), column('Best buy', 'flag')]
  return table(cols, lazyRows(order.length, row), { landscape: wide(res, actions), note: pyStrip(note) })
}

function tspTable(res: AnalysisResults): TableData {
  const p = res.project
  const ws = res.watershed
  const d = res.decisions
  const unit = p.labels.annual_output_short
  const row = planRow(ws, wsIndexOfKey(ws, d.tsp_key!)!)
  const rows: Cell[][] = []
  for (const sid of ws.space!.site_ids) {
    const aid = row.composition.get(sid)
    if (aid === undefined) continue
    const site = siteOf(p, sid)!
    const sr = res.sites.get(sid)!
    const ar = siteRow(sr, aid)!
    const [lift, cost] = siteValues(sr).get(aid) ?? [ar.lift, ar.cost]
    const alt = alternativeOf(site, aid)
    rows.push([sid, altName(site, aid), alt ? alt.description : '', lift, ar.construction, cost, ar.unit_cost])
  }
  rows.push(['All sites', '', '', row.output, row.construction, row.cost, row.unit_cost])
  const cols = [column('Site'), column('Alternative'), column('Description'), column(`Lift (${unit})`, 'number', 2),
    column('Construction cost', 'money'), column('Average annual cost', 'money'), column(`Unit cost ($/${unit})`, 'money')]
  return table(cols, rows, { totalLast: true })
}

// --- the study table -----------------------------------------------------------------------------

const METHOD_WORDS: Record<string, string> = {
  HU: 'values at each target year',
  INDEX_X_QUANTITY: 'an index (0 to 1) times {q} at each target year',
  STAF: 'the STAF Ecosystem Condition Index times {q} at each target year',
  AAHU: 'an average annual value entered directly',
}
export const TIMING_WORD: Record<string, string> = { END_OF_YEAR: 'end', MID_YEAR: 'middle' }
const IDC_WORD: Record<string, string> = { END: 'end', MIDDLE: 'middle', START: 'start' }

export function roundingText(settings: Settings): string {
  const cd = settings.cost_decimals
  const od = settings.output_decimals
  if (cd === 2 && od === 3) {
    return 'Cost rounded to cents and output to thousandths before comparing, as IWR Planning Suite II stores them'
  }
  return `Cost rounded to ${cd} and output to ${od} decimals before comparing`
}

function ruleText(rule: Rule): string {
  const others = rule.with_sites.join(' and ')
  if (rule.kind === 'NOT_COMBINABLE') return `${rule.site_id} is not combinable with ${others}`
  return `${rule.site_id} depends on ${others}`
}

function tspWords(res: AnalysisResults): string {
  const d = res.decisions
  const ws = res.watershed
  const wdec = res.project.decisions.watershed
  if (d.tsp_state === 'none' || ws.table === null || ws.ceica === null) return 'Not chosen yet'
  const i = d.tsp_key === null ? null : wsIndexOfKey(ws, d.tsp_key)
  if (d.tsp_state === 'missing' || i === null) return 'The chosen plan no longer exists; choose it again'
  const pid = ws.ceica.points.ids[i]
  if (d.tsp_state === 'not_in_final') return `${pid}, which is not in the final array`
  const text = `${pid} (${wdec.tsp_plan_type || 'plan type not stated'})`
  return text + (d.watershed_stale ? ', to review after changes' : '')
}

function settingsTable(res: AnalysisResults): TableData {
  const p = res.project
  const st = p.settings
  const lab = p.labels
  const ws = res.watershed
  const d = res.decisions
  const rows: [string, string][] = [['Study', p.name]]
  if (p.report.prepared_by) rows.push(['Prepared by', p.report.prepared_by])
  const nAlts = p.sites.reduce((n, s) => n + s.alternatives.length, 0)
  rows.push(['Sites', `${countText(p.sites.length, 'site')} with ${countText(nAlts, 'alternative')}, No Action included`])
  rows.push(['Output', `${lab.annual_output_name} (${lab.annual_output_short}); lift is the output above No Action`])
  const mods = p.benefits.modules
  rows.push([mods.length > 1 ? 'Benefit modules' : 'Benefit module',
    mods.map((m) => `${m.name}: ` + METHOD_WORDS[m.method].replace('{q}', m.quantity_units || 'a quantity')).join('; ')])
  if (mods.some(byYear)) rows.push(['Target years', p.benefits.target_years.map((y) => pyG(y)).join(', ')])
  rows.push(['Period of analysis', `${st.period_of_analysis} years`])
  rows.push(['Discount rate', `${pyG(st.discount_rate * 100)} percent`])
  if (st.price_level) rows.push(['Price level', st.price_level])
  rows.push(['Average annual output', st.aahu_method === 'TRAPEZOID'
    ? 'Straight lines between target years, averaged over the span of the years'
    : 'IWR Annualizer: yearly values by interpolation, rounded to 2 decimals, averaged over the period'])
  const per = st.idc_periods_per_year === 12 ? 'month' : 'period'
  rows.push(['Average annual cost', 'Capital recovery factor times the first costs, interest during construction and '
    + 'the present value of OMRRR; interest during construction from even spending '
    + `(${IDC_WORD[st.idc_method]} of each ${per}); OMRRR discounted from the `
    + `${TIMING_WORD[st.recurring_timing]} of each year`])
  rows.push(['Comparisons', roundingText(st)])
  if (isStaf(p.benefits)) rows.push(['STAF outcome mapping', staf.MAPPING_LABELS[p.benefits.staf_mapping]])
  if (p.watershed.mode === 'MULTI') {
    const carried = [...ws.carried].map(([sid, alts]) => `${sid}: ${alts.join(', ')}`).join('; ')
    rows.push(['Plan formation', 'Several alternatives per site' + (carried ? ` (${carried})` : '')])
  } else {
    rows.push(['Plan formation', "One alternative per site: each site's recommendation"])
  }
  if (p.watershed.rules.length) rows.push(['Rules', p.watershed.rules.map(ruleText).join('; ')])
  if (ws.not_carried.length) rows.push(['Not carried', `${ws.not_carried.join(', ')} (No Action recommended)`])
  if (ws.blocked.length) rows.push(['Left out', `${ws.blocked.join(', ')} (inputs incomplete)`])
  const t = ws.table
  if (t === null || ws.ceica === null) {
    rows.push(['Plans', ws.reasons.join(' ') || 'No plans yet'])
  } else {
    const plans = t.ce_only
      ? `${commaInt(t.n_valid)} plans, too many to list in full; the ${commaInt(tableLength(t))} that can be `
        + `cost-effective were kept: ${commaInt(wsCe(ws))} are cost-effective and ${commaInt(wsBb(ws))} are best buys`
      : `${countText(t.n_valid, 'plan')}: ${commaInt(wsCe(ws))} cost-effective and ${commaInt(wsBb(ws))} best buys`
    rows.push(['Plans', plans])
    const ids = d.final_keys.map((k) => wsIndexOfKey(ws, k)).filter((i): i is number => i !== null).map((i) => ws.ceica!.points.ids[i])
    rows.push(['Final array', `${countText(ids.length, 'plan')}: ${ids.join(', ')}`])
  }
  rows.push(['Tentatively selected plan', tspWords(res)])
  rows.push(['Record', `${APP_NAME} ${APP_VERSION}, engine ${ENGINE_VERSION}; project digest ${shortDigest(p)}`])
  return table([column('Setting'), column('Value')], rows)
}

// --- sites ---------------------------------------------------------------------------------------

function sitesTable(res: AnalysisResults): TableData {
  const p = res.project
  const unit = p.labels.annual_output_short
  const rows: Cell[][] = []
  const left: string[] = []
  for (const s of p.sites) {
    const sr = res.sites.get(s.id)!
    if (!sr.ready) {
      left.push(s.id)
      continue
    }
    const vals = siteValues(sr)
    for (const r of sr.rows) {
      const [lift, cost] = vals.get(r.alt_id) ?? [r.lift, r.cost]
      const inc: Cell = r.bb ? (r.is_no_action ? 0.0 : r.inc_cost_per_unit) : ''
      rows.push([s.id, altName(s, r.alt_id), lift, cost, r.unit_cost, inc, r.construction, r.ce, r.bb])
    }
  }
  const cols = [column('Site'), column('Alternative'), column(`Lift (${unit})`, 'number', 2), column('Average annual cost', 'money'),
    column(`Unit cost ($/${unit})`, 'money'), column(`Incremental cost per ${unit}`, 'money'), column('Construction cost', 'money'),
    column('Cost-effective', 'flag'), column('Best buy', 'flag')]
  const note = left.length ? `Not shown: ${left.join(', ')}, whose inputs are incomplete.` : ''
  return table(cols, rows, { note })
}

function recsTable(res: AnalysisResults): TableData {
  const p = res.project
  const ws = res.watershed
  const d = res.decisions
  const unit = p.labels.annual_output_short
  const rows: Cell[][] = []
  for (const s of p.sites) {
    const sr = res.sites.get(s.id)!
    const st = d.sites.get(s.id)
    const status = siteStatus(res, s.id)
    const carried = p.watershed.mode === 'MULTI' ? ((ws.carried.get(s.id) ?? []).join(', ') || 'No')
      : ws.carried.has(s.id) ? 'Yes' : 'No'
    if (status === 'Inputs incomplete' || !st || !st.alt_id) {
      rows.push([s.id, null, null, null, null, null, carried, status])
      continue
    }
    const r = siteRow(sr, st.alt_id)!
    const [lift, cost] = siteValues(sr).get(st.alt_id) ?? [r.lift, r.cost]
    rows.push([s.id, altName(s, st.alt_id), lift, cost, r.unit_cost, r.construction, carried, status])
  }
  const cols = [column('Site'), column('Recommended alternative'), column(`Lift (${unit})`, 'number', 2),
    column('Average annual cost', 'money'), column(`Unit cost ($/${unit})`, 'money'), column('Construction cost', 'money'),
    column('Carried to plans'), column('Status')]
  return table(cols, rows)
}

// --- STAF ----------------------------------------------------------------------------------------

function stafOutcomesTable(res: AnalysisResults): TableData {
  const p = res.project
  const unit = p.labels.annual_output_short
  const rows: Cell[][] = []
  for (const [sid, aid] of stafCarried(res)) {
    const fl = siteFunctionLift(res, sid, aid)
    if (fl === null) continue
    const a = alternativeOf(siteOf(p, sid)!, aid)!
    rows.push([sid, a.name || a.id, fl.outcomes.physical, fl.outcomes.chemical, fl.outcomes.biological, fl.total])
  }
  const tsp = tspFunctionLift(res)
  if (tsp !== null) {
    const [planId, fl] = tsp
    rows.push([`TSP (${planId})`, 'All actions in the plan', fl.outcomes.physical, fl.outcomes.chemical, fl.outcomes.biological, fl.total])
  }
  const cols = [column('Site'), column('Alternative'), column(`Physical (${unit})`, 'number', 2), column(`Chemical (${unit})`, 'number', 2),
    column(`Biological (${unit})`, 'number', 2), column(`Lift (${unit})`, 'number', 2)]
  return table(cols, rows)
}

function stafFunctionsTable(res: AnalysisResults): TableData {
  const unit = res.project.labels.annual_output_short
  const tsp = tspFunctionLift(res)
  let rows: Cell[][] = []
  if (tsp !== null) {
    const fl = tsp[1]
    rows = staf.functions().filter((f) => fl.functions.has(f.id)).map((f) => [f.category, f.name, fl.functions.get(f.id)!])
  }
  return table([column('Category'), column('Function'), column(`Contribution (${unit})`, 'number', 2)], rows)
}

// --- decisions -----------------------------------------------------------------------------------

const WORTH: Record<string, string> = { YES: 'Worth it', NO: 'Not worth it', UNDECIDED: 'Not decided' }
const NO_REASON = 'No reason recorded.'

/** What the team decided and why, from the live decisions only (notes for alternatives that no
 * longer exist are left out). */
function decisionsTable(res: AnalysisResults): TableData {
  const p = res.project
  const d = res.decisions
  const ws = res.watershed
  const rows: [string, string, string][] = []
  for (const s of p.sites) {
    const st = d.sites.get(s.id)
    if (!st || st.source === 'none' || !st.alt_id) continue
    const state = st.stale ? 'needs review after changes' : st.source === 'team' ? 'confirmed' : 'suggested, not yet confirmed'
    const dec = p.decisions.sites.get(s.id)
    rows.push([`Site ${s.id}`, `${altName(s, st.alt_id)}, ${state}`,
      dec && pyStrip(dec.rationale) ? pyStrip(dec.rationale) : NO_REASON])
    const notes = dec ? dec.alt_notes : new Map<string, string>()
    for (const a of s.alternatives) {
      const note = pyStrip(notes.get(a.id) || '')
      if (note) rows.push([`Site ${s.id}, ${altName(s, a.id)}`, a.id === st.alt_id ? 'Recommended' : 'Not recommended', note])
    }
  }
  if (ws.table !== null && ws.ceica !== null) {
    const ids = ws.ceica.points.ids
    const wdec = p.decisions.watershed
    for (const key of d.added) {
      const ch = wdec.final_array.get(key)
      rows.push([`Final array, ${ids[wsIndexOfKey(ws, key)!]}`, 'Added', ch && pyStrip(ch.note) ? pyStrip(ch.note) : NO_REASON])
    }
    for (const [key, note] of d.removed) {
      rows.push([`Final array, ${ids[wsIndexOfKey(ws, key)!]}`, 'Removed', pyStrip(note) || NO_REASON])
    }
    for (const step of d.ladder) {
      const n = step.note
      if (n === null || (n.worth_it === 'UNDECIDED' && !pyStrip(n.why))) continue
      rows.push([`Step from ${step.from_id} to ${step.to_id}`, WORTH[n.worth_it], pyStrip(n.why) || NO_REASON])
    }
    const chosen = d.tsp_state !== 'none'
    rows.push(['Tentatively selected plan', tspWords(res), pyStrip(wdec.tsp_rationale) || (chosen ? NO_REASON : '')])
  }
  return table([column('Subject'), column('Decision'), column('Reason')], rows)
}

// --- benefits and costs --------------------------------------------------------------------------

function inputsTable(res: AnalysisResults): TableData {
  const p = res.project
  const unit = p.labels.annual_output_short
  const rows: Cell[][] = []
  for (const s of p.sites) {
    const sr = res.sites.get(s.id)!
    const vals = siteValues(sr)
    for (const r of sr.rows) {
      const lift = vals.has(r.alt_id) ? vals.get(r.alt_id)![0] : r.lift
      rows.push([s.id, altName(s, r.alt_id), r.aahu, lift, r.construction, r.annual, r.unit_cost])
    }
  }
  const cols = [column('Site'), column('Alternative'), column(`Output (${unit})`, 'number', 2), column(`Lift (${unit})`, 'number', 2),
    column('Construction cost', 'money'), column('Annualized cost', 'money'), column(`Unit cost ($/${unit})`, 'money')]
  return table(cols, rows)
}

function modulesTable(res: AnalysisResults): TableData {
  const p = res.project
  const unit = p.labels.annual_output_short
  const mods = p.benefits.modules
  const rows: Cell[][] = []
  for (const s of p.sites) {
    const na = noAction(s)
    const nab = na ? res.benefits.get(lineKey(s.id, na.id)) ?? null : null
    for (const a of s.alternatives) {
      const b = res.benefits.get(lineKey(s.id, a.id))!
      rows.push([s.id, altName(s, a.id), ...mods.map((m) => b.aahu_by_module.get(m.id) ?? null), b.aahu, nab ? nab.aahu : null, b.lift])
    }
  }
  const cols = [column('Site'), column('Alternative'), ...mods.map((m) => column(`${m.name} (${unit})`, 'number', 2)),
    column(`Total (${unit})`, 'number', 2), column(`No Action total (${unit})`, 'number', 2), column(`Lift (${unit})`, 'number', 2)]
  return table(cols, rows, { landscape: mods.length > 4 })
}

function omrrrItems(project: Project): Map<string, string> {
  const items = new Map<string, string>()
  for (const s of project.sites) {
    for (const a of s.alternatives) for (const it of a.costs.recurring) if (!items.has(it.id)) items.set(it.id, it.name)
  }
  return items
}

function omrrrTable(res: AnalysisResults): TableData {
  const p = res.project
  const items = omrrrItems(p)
  const rows: Cell[][] = []
  for (const s of p.sites) {
    for (const a of s.alternatives) {
      const c = res.costs.get(lineKey(s.id, a.id))!
      const pv = [...c.recurring_pv.values()]
      // sum() of no values is the int 0
      rows.push([s.id, altName(s, a.id), ...[...items.keys()].map((i) => c.recurring_pv.get(i) ?? 0.0),
        pv.length ? pySum(pv) : new PyInt(0)])
    }
  }
  const cols = [column('Site'), column('Alternative'), ...[...items.values()].map((n) => column(n, 'money')), column('Total OMRRR', 'money')]
  return table(cols, rows, { landscape: items.size > 5 })
}

function costsTable(res: AnalysisResults): TableData {
  const p = res.project
  const cats = p.cost_categories
  const rows: Cell[][] = []
  const entered: string[] = []
  for (const s of p.sites) {
    for (const a of s.alternatives) {
      const c = res.costs.get(lineKey(s.id, a.id))!
      const name = altName(s, a.id)
      if (c.overridden) entered.push(`${s.id} ${name}`)
      rows.push([s.id, name, a.costs.construction_months, ...cats.map((cc) => c.first_costs.get(cc.id) ?? 0.0), c.idc,
        c.overridden ? '' : c.annual_parts.get('omrrr') ?? 0.0, c.annual])
    }
  }
  const cols = [column('Site'), column('Alternative'), column('Months', 'number', 1), ...cats.map((cc) => column(cc.name, 'money')),
    column('Interest during construction', 'money'), column('OMRRR annual cost', 'money'), column('Annualized cost', 'money')]
  const note = entered.length ? `Annualized cost entered directly for ${entered.join(', ')}: it replaces the `
    + 'computed cost, so the parts in its row do not add up to it.' : ''
  return table(cols, rows, { landscape: cats.length > 4, note })
}

// --- the catalog ---------------------------------------------------------------------------------

type Add = (s: Spec) => void

function study(res: AnalysisResults, add: Add): void {
  add({ id: 'settings', kind: 'table', group: 'study', title: 'Study settings', caption: 'Study settings and the record of this analysis.',
    key: true, build: memo(() => settingsTable(res)) })
}

function plans(res: AnalysisResults, add: Add): void {
  const p = res.project
  const ws = res.watershed
  const d = res.decisions
  const t = ws.table
  if (t === null || ws.ceica === null) return
  const nn = noun(p)
  const n = tableLength(t)
  if (n > 2) {
    let cap = `Cost-effectiveness (A) and incremental cost (B) of the ${nn}.`
    if (n > DENSITY_ABOVE && !t.ce_only) cap += ' ' + DENSITY_NOTE
    else if (t.ce_only) cap += ` Only the ${commaInt(n)} plans that can be cost-effective are drawn.`
    add({ id: 'fig-plans', kind: 'figure', group: 'plans', title: pyCapitalize(nn), caption: cap, key: true,
      build: memo(() => figure(watershedCeIca(res), CE_PANELS)) })
  }
  const cols = isBinary(ws.space!) ? ' Site columns: 1 when the plan includes the site, 0 when not.'
    : ' Each site column names the alternative in the plan, blank when the site is not in it.'
  add({ id: 'plans-bb', kind: 'table', group: 'plans', title: 'Best-buy plans', caption: `Best-buy ${nn} and their incremental costs.` + cols,
    key: true, build: memo(({ actions = false }) => planRowsTable(res, planRows(ws, 'bb'), actions, 'inc')) })
  add({ id: 'plans-final', kind: 'table', group: 'plans', title: 'Final array', caption: `Final array of ${nn}.` + cols, key: true,
    build: memo(({ actions = false }) => planRowsTable(res, d.final_keys.map((k) => planRow(ws, wsIndexOfKey(ws, k)!)), actions, 'flags')) })
  if (d.tsp_state === 'ok') {
    const pid = ws.ceica.points.ids[wsIndexOfKey(ws, d.tsp_key!)!]
    add({ id: 'tsp', kind: 'table', group: 'plans', title: 'Tentatively selected plan', caption: `Actions in the tentatively selected plan, ${pid}.`,
      key: true, build: memo(() => tspTable(res)) })
  }
  let title: string
  let cap: string
  if (t.ce_only) {
    title = 'Plans that can be cost-effective'
    cap = `The ${nn} that can be cost-effective (${commaInt(n)} of ${commaInt(t.n_valid)}): lift, cost and status.`
  } else {
    title = 'All plans'
    cap = `The ${nn}: lift, cost and status (${commaInt(n)} plans).`
  }
  add({ id: 'plans-all', kind: 'table', group: 'plans', title, caption: cap + cols, key: false,
    build: (opts = {}) => planTable(res, 'all', opts), n_rows: n })
}

function sites(res: AnalysisResults, add: Add): void {
  const p = res.project
  for (const s of p.sites) {
    if (res.sites.get(s.id)!.ready && s.alternatives.length >= 2) {
      add({ id: `fig-site-${s.id}`, kind: 'figure', group: 'sites', title: `Site ${s.id}`,
        caption: `Cost-effectiveness (A) and incremental cost (B) of the alternatives at ${siteWhere(s)}.`, key: false,
        build: memo(() => figure(siteCeIca(res, s.id), CE_PANELS)) })
    }
  }
  add({ id: 'sites-alts', kind: 'table', group: 'sites', title: 'Alternatives at every site',
    caption: 'Cost-effectiveness and incremental cost of every alternative at every site. Incremental cost applies to best buys.',
    key: false, build: memo(() => sitesTable(res)) })
  add({ id: 'site-recs', kind: 'table', group: 'sites', title: 'Site recommendations',
    caption: 'The alternative each site carries forward, and the status of that decision.', key: true, build: memo(() => recsTable(res)) })
}

function stafPart(res: AnalysisResults, add: Add): void {
  const p = res.project
  if (!isStaf(p.benefits)) return
  const mods = p.benefits.modules.filter((m) => m.method === 'STAF')
  const last = p.benefits.target_years[p.benefits.target_years.length - 1]
  for (const [sid, aid] of stafCarried(res)) {
    const site = siteOf(p, sid)!
    const alt = alternativeOf(site, aid)!
    const na = noAction(site)
    if (na === null) continue
    for (const m of mods) {
      const now = stafRollups(p, site, na, m.id)[0].eci
      const rolls = stafRollups(p, site, alt, m.id)
      const end = rolls[rolls.length - 1].eci
      if (now === null || end === null) continue
      const where = `site ${sid}` + (mods.length > 1 ? `, ${m.name}` : '')
      const cap = `Ecosystem Condition Index over time (A) and lift by outcome (B) at ${where}. `
        + `The existing condition is ${pyFixed(now, 2)} (${staf.band(now)}); `
        + `${alt.name || alt.id} reaches ${pyFixed(end, 2)} (${staf.band(end)}) by year ${pyG(last)}.`
      add({ id: `fig-staf-${sid}-${m.id}`, kind: 'figure', group: 'staf',
        title: `STAF, site ${sid}` + (mods.length > 1 ? `, ${m.name}` : ''), caption: cap, key: false,
        build: memo(() => figure(siteStaf(res, sid, m.id), STAF_PANELS)) })
    }
  }
  const tsp = tspFunctionLift(res)
  add({ id: 'staf-outcomes', kind: 'table', group: 'staf', title: 'Lift by outcome',
    caption: 'Lift of the recommended alternatives' + (tsp ? ' and the tentatively selected plan' : '') + ' by outcome.', key: false,
    build: memo(() => stafOutcomesTable(res)) })
  if (tsp !== null) {
    add({ id: 'staf-functions', kind: 'table', group: 'staf', title: 'Function contributions',
      caption: `Contribution of each function to the lift of the tentatively selected plan (${tsp[0]}).`, key: false,
      build: memo(() => stafFunctionsTable(res)) })
  }
}

function decisions(res: AnalysisResults, add: Add): void {
  add({ id: 'decisions', kind: 'table', group: 'decisions', title: 'Decision record', caption: 'Decisions and the reasons recorded for them.',
    key: true, build: memo(() => decisionsTable(res)) })
}

function inputs(res: AnalysisResults, add: Add): void {
  const p = res.project
  const lab = p.labels
  const unit = lab.annual_output_short
  const anyByYear = p.benefits.modules.some(byYear)
  const left = leftOutOfTimeSeries(p)
  for (const s of p.sites) {
    if (!(res.sites.get(s.id)!.ready && s.alternatives.length >= 2)) continue
    let cap: string
    let build: (opts?: BuildOptions) => FigureData
    if (anyByYear) {
      cap = `${lab.output_name} over time (A) and average annual cost by part (B) of the alternatives at ${siteWhere(s)}.`
      if (left.length) cap += ` ${left.join(', ')}, entered as an average, ${left.length === 1 ? 'is' : 'are'} not in panel A.`
      build = memo(() => figure([siteTimeSeries(res, s.id), siteCostStack(res, s.id)],
        [`(A) ${lab.output_name} over time`, '(B) Average annual cost by part']))
    } else {
      cap = `Average annual cost by part of the alternatives at ${siteWhere(s)}.`
      build = memo(() => figure([siteCostStack(res, s.id)]))
    }
    add({ id: `fig-bc-${s.id}`, kind: 'figure', group: 'inputs', title: `Benefits and costs, site ${s.id}`, caption: cap, key: false, build })
  }
  add({ id: 'inputs', kind: 'table', group: 'inputs', title: 'Benefit and cost inputs',
    caption: 'Average annual output, lift, construction cost and annualized cost of every alternative. '
      + 'The CE/ICA tables measure cost above No Action.', key: false, build: memo(() => inputsTable(res)) })
  if (p.benefits.modules.length > 1) {
    add({ id: 'outputs-by-module', kind: 'table', group: 'inputs', title: 'Output by module',
      caption: `Average annual output by module, the total and the lift over No Action (all in ${unit}).`, key: false,
      build: memo(() => modulesTable(res)) })
  }
  if (omrrrItems(p).size) {
    add({ id: 'omrrr', kind: 'table', group: 'inputs', title: 'OMRRR present value',
      caption: 'Present value of operations, maintenance, repair, replacement and rehabilitation (OMRRR) costs by item.', key: false,
      build: memo(() => omrrrTable(res)) })
  }
  add({ id: 'costs', kind: 'table', group: 'inputs', title: 'Cost by category',
    caption: 'First costs by category, interest during construction, OMRRR and annualized cost of every alternative.', key: false,
    build: memo(() => costsTable(res)) })
}

const CATALOGS = new WeakMap<AnalysisResults, readonly Exhibit[]>()

/** Every figure and table, numbered in document order. Tables with no rows are left out. */
export function catalog(res: AnalysisResults | null): readonly Exhibit[] {
  if (res === null) return []
  const hit = CATALOGS.get(res)
  if (hit) return hit
  const specs: Spec[] = []
  for (const part of [study, plans, sites, stafPart, decisions, inputs]) part(res, (s) => specs.push(s))
  const out: Exhibit[] = []
  let nf = 0
  let nt = 0
  for (const s of specs) {
    let nRows: number | null = null
    let number: number
    if (s.kind === 'table') {
      nRows = s.n_rows !== undefined && s.n_rows !== null ? s.n_rows : (s.build() as TableData).rows.length
      if (!nRows) continue
      nt += 1
      number = nt
    } else {
      nf += 1
      number = nf
    }
    out.push({ id: s.id, kind: s.kind, group: s.group, number, title: s.title, caption: s.caption, key: s.key, n_rows: nRows, build: s.build })
  }
  CATALOGS.set(res, out)
  return out
}

export function find(res: AnalysisResults | null, exhibitId: string): Exhibit | null {
  return catalog(res).find((e) => e.id === exhibitId) ?? null
}
