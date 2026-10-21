// The whole analysis for a project: annualize, site-by-site CE/ICA, watershed plans, decisions
// (ceica/analysis.py).
//
// ``analyze(project)`` is pure and fast (milliseconds for Utoy), so the app simply calls it again
// after every edit. Nothing here is stored in the project file; results always come from the
// inputs.
//
// Site CE/ICA uses each alternative's lift (output above No Action) and its average annual cost
// above No Action, rounded the IWR way. Watershed plans combine the rounded site values, so a plan's
// output and cost are exact sums (IWR watershed semantics).
import { sha256Hex } from '../py/bytes'
import { pyDumps } from '../py/pyjson'
import { commaInt, pyMaxBy, pySum } from '../py/pynum'
import { annualize, type BenefitLine, type CostLine, lineKey } from './annualize'
import { type PlanPoints, planPoints, pointsFromValues } from './cea'
import { type DecisionState, effectiveRecommendations, evaluateDecisions } from './decisions'
import { type CEICAResult, flatNonzero, nBb, nCe, runCeica } from './ica'
import { dumpRule, noAction, type Project, type Site, type WatershedMode } from './model'
import { ratio, TooLargeError, unscale } from './numeric'
import { orderByOutputCost } from './order'
import {
  digitsOf, enumeratePlans, FULL_LIMIT, indexOfKey, IWR_PLAN_LIMIT, makeSpace, noActionIndex, planCount,
  planLabel, type PlanSpace, type PlanTable, tableComposition, tableIds, tableKey, tableLength,
} from './plans'
import { checkProject, issue, type Issue } from './validate'

/** sha256 of the compact sorted JSON, first 16 characters (a results fingerprint). */
function fp(obj: unknown): string {
  return sha256Hex(pyDumps(obj, { sortKeys: true, separators: [',', ':'] })).slice(0, 16)
}

// --- site level ----------------------------------------------------------------------------------

export interface AltRow {
  readonly alt_id: string
  readonly name: string
  readonly description: string
  readonly is_no_action: boolean
  readonly aahu: number | null
  readonly lift: number | null
  readonly annual: number
  /** Average annual cost above No Action (the CE/ICA cost). */
  readonly cost: number
  readonly construction: number
  readonly first_cost: number
  readonly unit_cost: number | null
  readonly ce: boolean
  readonly bb: boolean
  /** Best-buy step (0 = No Action) in IWR selection order; null if not a best buy. */
  readonly step: number | null
  /** Incremental cost per unit from the previous best buy (best buys only). */
  readonly inc_cost_per_unit: number | null
  readonly inc_output: number | null
  readonly inc_cost: number | null
  /** For a non-cost-effective alternative: which alternative beats it, and how. */
  readonly beaten_by: string | null
  readonly beaten_reason: number
}

export interface SiteResult {
  readonly site_id: string
  readonly ready: boolean
  readonly reasons: readonly string[]
  readonly rows: readonly AltRow[]
  readonly ceica: CEICAResult | null
  /** The largest best buy: the default recommendation until the team decides. */
  readonly suggested: string | null
  readonly fingerprint: string
}

export const siteRow = (sr: SiteResult, altId: string): AltRow | null => sr.rows.find((r) => r.alt_id === altId) ?? null

/** The site's best buys in step order. */
export function siteBestBuys(sr: SiteResult): AltRow[] {
  return sr.rows.filter((r) => r.bb).sort((a, b) => ((a.step ?? 0) - (b.step ?? 0)) || (a.alt_id < b.alt_id ? -1 : a.alt_id > b.alt_id ? 1 : 0))
}

export function constructionCost(project: Project, cl: CostLine): number {
  if (cl.first_costs.has('construction')) return cl.first_costs.get('construction')!
  return pySum(cl.first_costs.values())
}

export function sitePoints(project: Project, site: Site, benefits: ReadonlyMap<string, BenefitLine>,
  costs: ReadonlyMap<string, CostLine>): PlanPoints | null {
  const st = project.settings
  const lifts: number[] = []
  const cs: number[] = []
  const ids: string[] = []
  let naIndex: number | null = null
  for (const [i, a] of site.alternatives.entries()) {
    const b = benefits.get(lineKey(site.id, a.id))!
    if (b.lift === null) return null
    lifts.push(b.lift)
    cs.push(costs.get(lineKey(site.id, a.id))!.incremental!)
    ids.push(a.id)
    if (a.is_no_action) naIndex = i
  }
  return pointsFromValues(ids, cs, lifts, naIndex, { costDp: st.cost_decimals, outputDp: st.output_decimals })
}

/** A value past what CEICA holds exactly (numeric.ts), in words: a difference from the Python app,
 * whose integers go further (web/README.md). */
const tooLarge = (siteId: string): string =>
  `Site ${siteId} has a cost or output too large for CEICA to hold exactly at these decimals; `
  + 'use fewer decimals in the study settings.'

export function analyzeSite(project: Project, site: Site, benefits: ReadonlyMap<string, BenefitLine>,
  costs: ReadonlyMap<string, CostLine>): SiteResult {
  const reasons: string[] = []
  for (const a of site.alternatives) reasons.push(...benefits.get(lineKey(site.id, a.id))!.missing)
  if (!site.alternatives.length) reasons.push(`Site ${site.id} has no alternatives.`)
  let pts: PlanPoints | null = null
  if (!reasons.length) {
    try {
      pts = sitePoints(project, site, benefits, costs)
    } catch (exc) {
      if (!(exc instanceof TooLargeError)) throw exc
      reasons.push(tooLarge(site.id))
    }
  }
  if (pts === null && !reasons.length) reasons.push(`Site ${site.id} has incomplete outputs.`)
  const res = pts !== null ? runCeica(pts) : null

  const rows: AltRow[] = []
  const stepOf = new Map<number, number>()
  const incOf = new Map<number, [number, number, number]>()
  if (res !== null && pts !== null) {
    // No Action is step 0; best buys follow in IWR selection order
    let k = 1
    for (const i of res.walk) stepOf.set(i, k++)
    if (pts.no_action !== null) stepOf.set(pts.no_action, 0)
    for (const inc of res.bb_increments) incOf.set(inc.index, [inc.inc_cost_per_unit, inc.inc_output, inc.inc_cost])
    const q = pts.output
    const c = pts.cost
    // duplicates of a best-buy point share its step
    for (const i of flatNonzero(res.bb)) {
      if (!stepOf.has(i)) {
        for (const [j, s] of [...stepOf]) {
          if (q[j] === q[i] && c[j] === c[i]) {
            stepOf.set(i, s)
            break
          }
        }
      }
    }
  }
  site.alternatives.forEach((a, i) => {
    const b = benefits.get(lineKey(site.id, a.id))!
    const cl = costs.get(lineKey(site.id, a.id))!
    let ce = false
    let bb = false
    let beatenBy: string | null = null
    let reason = 0
    let step: number | null = null
    let inc: [number, number, number] | null = null
    let unit: number | null = null
    if (res !== null && pts !== null) {
      ce = res.ce[i] === 1
      bb = res.bb[i] === 1
      if (!res.ce_raw[i] && res.witness[i] >= 0) {
        beatenBy = pts.ids[res.witness[i]]
        reason = res.reason[i]
      }
      step = stepOf.get(i) ?? null
      inc = incOf.get(i) ?? null
      const qi = pts.output[i]
      const ci = pts.cost[i]
      unit = qi > 0 ? ratio(ci, qi, pts.cost_dp, pts.output_dp) : null
    }
    const incShown = inc !== null && bb && !a.is_no_action
    rows.push({
      alt_id: a.id, name: a.name || a.id, description: a.description, is_no_action: a.is_no_action,
      aahu: b.aahu, lift: b.lift, annual: cl.annual, cost: cl.incremental !== null ? cl.incremental : cl.annual,
      construction: constructionCost(project, cl), first_cost: pySum(cl.first_costs.values()), unit_cost: unit,
      ce, bb, step: bb ? step : null,
      inc_cost_per_unit: incShown ? inc![0] : null, inc_output: incShown ? inc![1] : null,
      inc_cost: incShown ? inc![2] : null, beaten_by: beatenBy, beaten_reason: reason,
    })
  })

  let suggested: string | null = null
  if (res !== null) {
    const cands = rows.filter((r) => r.bb && !r.is_no_action && r.lift !== null)
    if (cands.length) suggested = pyMaxBy(cands, (r) => [r.lift!, -(r.step ?? 0)])!.alt_id
    else {
      const na = noAction(site)
      suggested = na ? na.id : null
    }
  }
  const fingerprint = fp(rows.map((r, i) => [r.alt_id, pts === null ? null : pts.output[i],
    pts === null ? null : pts.cost[i], r.ce, r.bb]))
  return { site_id: site.id, ready: res !== null, reasons: [...new Set(reasons)], rows, ceica: res, suggested,
    fingerprint }
}

// --- watershed -----------------------------------------------------------------------------------

export interface PlanRow {
  readonly index: number
  readonly plan_id: string
  readonly key: string
  readonly composition: ReadonlyMap<string, string>
  readonly label: string
  readonly output: number
  readonly cost: number
  readonly construction: number
  readonly unit_cost: number | null
  readonly ce: boolean
  readonly bb: boolean
  readonly step: number | null
  readonly inc_cost_per_unit: number | null
  readonly inc_output: number | null
  readonly inc_cost: number | null
}

export interface WatershedResult {
  readonly ready: boolean
  readonly reasons: readonly string[]
  readonly mode: WatershedMode
  /** Sites in the plan space and the alternatives each carries. */
  readonly carried: ReadonlyMap<string, readonly string[]>
  /** "team" when the team chose the site's alternative, "suggested" when it is the default. */
  readonly sources: ReadonlyMap<string, string>
  /** Sites whose recommendation is No Action (not in the plans). */
  readonly not_carried: readonly string[]
  /** Sites left out because their inputs are incomplete. */
  readonly blocked: readonly string[]
  readonly space: PlanSpace | null
  readonly table: PlanTable | null
  readonly ceica: CEICAResult | null
  readonly fingerprint: string
}

export const wsPlans = (ws: WatershedResult): number => (ws.table !== null ? tableLength(ws.table) : 0)
export const wsCe = (ws: WatershedResult): number => (ws.ceica ? nCe(ws.ceica) : 0)
export const wsBb = (ws: WatershedResult): number => (ws.ceica ? nBb(ws.ceica) : 0)
export const wsIndexOfKey = (ws: WatershedResult, key: string): number | null =>
  (ws.table === null ? null : indexOfKey(ws.table, key))

const STEPS = new WeakMap<WatershedResult, { steps: Map<number, number>, incs: Map<number, CEICAResult['bb_increments'][number]> }>()

/** Plan ``i`` of the watershed, as the tables show it. */
export function planRow(ws: WatershedResult, i: number): PlanRow {
  const t = ws.table!
  const res = ws.ceica!
  const comp = tableComposition(t, i)
  const q = t.output[i]
  const c = t.cost[i]
  const pts = res.points
  let cached = STEPS.get(ws)
  if (!cached) {
    const steps = new Map<number, number>()
    res.walk.forEach((idx, k) => steps.set(idx, k + 1))
    if (pts.no_action !== null) steps.set(pts.no_action, 0)
    cached = { steps, incs: new Map(res.bb_increments.map((r) => [r.index, r])) }
    STEPS.set(ws, cached)
  }
  const inc = res.bb[i] && pts.no_action !== i ? cached.incs.get(i) ?? null : null
  return {
    index: i, plan_id: pts.ids[i], key: tableKey(t, i), composition: comp, label: planLabel(t.space, digitsOf(t, i)),
    output: unscale(q, pts.output_dp), cost: unscale(c, pts.cost_dp),
    construction: t.extra.has('construction') ? t.extra.get('construction')![i] : 0.0,
    unit_cost: q > 0 ? ratio(c, q, pts.cost_dp, pts.output_dp) : null,
    ce: res.ce[i] === 1, bb: res.bb[i] === 1, step: res.bb[i] ? cached.steps.get(i) ?? null : null,
    inc_cost_per_unit: inc ? inc.inc_cost_per_unit : null, inc_output: inc ? inc.inc_output : null,
    inc_cost: inc ? inc.inc_cost : null,
  }
}

/** Plan indices in order of output, then cost, then index: 'bb' best buys, 'ce' cost-effective,
 * 'all' every plan. */
export function planOrder(ws: WatershedResult, which: 'bb' | 'ce' | 'all' = 'bb'): number[] {
  if (ws.table === null || ws.ceica === null) return []
  const t = ws.table
  const res = ws.ceica
  const idx = which === 'bb' ? flatNonzero(res.bb) : which === 'ce' ? flatNonzero(res.ce)
    : Array.from({ length: tableLength(t) }, (_, i) => i)
  return Array.from(orderByOutputCost(t.output, t.cost, false, idx))
}

/** Rows in that order (see planOrder); with ``limit``, only the first ``limit`` are built. */
export function planRows(ws: WatershedResult, which: 'bb' | 'ce' | 'all' = 'bb', limit: number | null = null): PlanRow[] {
  let order = planOrder(ws, which)
  if (limit !== null) order = order.slice(0, limit)
  return order.map((i) => planRow(ws, i))
}

/** Carried alternatives per site, their sources, sites not carried, sites blocked. */
export function watershedSpace(project: Project, sites: ReadonlyMap<string, SiteResult>,
  decisionsRec: ReadonlyMap<string, [string | null, string]>):
  [Map<string, string[]>, Map<string, string>, string[], string[]] {
  const carried = new Map<string, string[]>()
  const sources = new Map<string, string>()
  const notCarried: string[] = []
  const blocked: string[] = []
  const ws = project.watershed
  for (const site of project.sites) {
    const sr = sites.get(site.id)!
    if (!sr.ready) {
      if (site.alternatives.length > 1) blocked.push(site.id)
      continue
    }
    const na = noAction(site)
    const [rec, source] = decisionsRec.get(site.id) ?? [sr.suggested, 'suggested']
    const valid = new Set(site.alternatives.filter((a) => !a.is_no_action).map((a) => a.id))
    let opts: string[]
    if (ws.mode === 'MULTI' && ws.carried.has(site.id)) opts = ws.carried.get(site.id)!.filter((a) => valid.has(a))
    else opts = rec && valid.has(rec) ? [rec] : []
    if (!opts.length || (na !== null && opts.length === 1 && opts[0] === na.id)) {
      notCarried.push(site.id)
      continue
    }
    carried.set(site.id, opts)
    sources.set(site.id, source)
  }
  return [carried, sources, notCarried, blocked]
}

export function analyzeWatershed(project: Project, sites: ReadonlyMap<string, SiteResult>,
  decisionsRec: ReadonlyMap<string, [string | null, string]>, limit: number = FULL_LIMIT): WatershedResult {
  const [carried, sources, notCarried, blocked] = watershedSpace(project, sites, decisionsRec)
  const reasons: string[] = []
  if (blocked.length) reasons.push(`Left out until their inputs are complete: ${blocked.join(', ')}.`)
  const order = project.sites.filter((s) => carried.has(s.id)).map((s) => s.id)
  const values = new Map<string, Map<string, readonly [number, number]>>()
  const construction = new Map<string, Map<string, number>>()
  for (const sid of order) {
    const sr = sites.get(sid)!
    const pts = sr.ceica!.points
    const pos = new Map(pts.ids.map((a, i) => [a, i]))
    values.set(sid, new Map(carried.get(sid)!.map((a) => [a, [pts.output[pos.get(a)!], pts.cost[pos.get(a)!]] as const])))
    construction.set(sid, new Map(carried.get(sid)!.map((a) => [a, sr.rows.find((r) => r.alt_id === a)!.construction])))
  }
  const space = makeSpace(order, order.map((s) => carried.get(s)!), values, new Map([['construction', construction]]),
    project.watershed.rules)
  const base = { mode: project.watershed.mode, carried, sources, not_carried: notCarried, blocked, space,
    table: null, ceica: null, fingerprint: '' }
  if (!order.length) {
    return { ...base, ready: false, reasons: [...reasons, 'No site carries an action, so there is nothing to combine.'] }
  }
  let table: PlanTable
  try {
    table = enumeratePlans(space, limit)
  } catch (exc) {
    if (exc instanceof TooLargeError) {
      return { ...base, ready: false, reasons: [...reasons, 'The watershed plans add up to costs or outputs too large '
        + 'for CEICA to hold exactly at these decimals; use fewer decimals in the study settings.'] }
    }
    if (exc instanceof RangeError) return { ...base, ready: false, reasons: [...reasons, exc.message] }
    throw exc
  }
  const st = project.settings
  const pts = planPoints(tableIds(table), table.cost, table.output, noActionIndex(table), st.cost_decimals,
    st.output_decimals)
  const res = runCeica(pts)
  const ceIdx = flatNonzero(res.ce)
  const fingerprint = fp({
    carried: Object.fromEntries(carried),
    rules: project.watershed.rules.map(dumpRule),
    ce: ceIdx.map((i) => [tableKey(table, i), table.output[i], table.cost[i], res.bb[i] === 1]),
  })
  return { ...base, ready: true, reasons, table, ceica: res, fingerprint }
}

// --- everything ----------------------------------------------------------------------------------

export interface AnalysisResults {
  readonly project: Project
  /** keyed by lineKey(site, alternative) */
  readonly benefits: ReadonlyMap<string, BenefitLine>
  readonly costs: ReadonlyMap<string, CostLine>
  readonly sites: ReadonlyMap<string, SiteResult>
  readonly watershed: WatershedResult
  readonly decisions: DecisionState
  readonly issues: readonly Issue[]
}

export const errorsOf = (res: AnalysisResults): Issue[] => res.issues.filter((i) => i.level === 'error')
export const warningsOf = (res: AnalysisResults): Issue[] => res.issues.filter((i) => i.level === 'warning')
export const planCountWarning = (res: AnalysisResults): boolean => wsPlans(res.watershed) > IWR_PLAN_LIMIT

export function analyze(project: Project, { planLimit = FULL_LIMIT }: { planLimit?: number } = {}): AnalysisResults {
  const issues: Issue[] = [...checkProject(project)]
  const { benefits, costs } = annualize(project)
  const sites = new Map(project.sites.map((s) => [s.id, analyzeSite(project, s, benefits, costs)]))
  for (const s of project.sites) {
    for (const reason of sites.get(s.id)!.reasons) issues.push(issue('error', 'E_INCOMPLETE', reason, 'benefits', s.id))
  }
  const recs = effectiveRecommendations(project, sites)
  const ws = analyzeWatershed(project, sites, recs, planLimit)
  if (ws.table !== null && ws.table.n_valid > BigInt(IWR_PLAN_LIMIT)) {
    issues.push(issue('warning', 'W_PLAN_COUNT_IWR',
      `${commaInt(ws.table.n_valid)} watershed plans is more than IWR Planning Suite II's limit of `
      + `${commaInt(IWR_PLAN_LIMIT)}, so it cannot re-run this set.`, 'watershed'))
  }
  if (ws.table !== null && ws.table.ce_only) {
    issues.push(issue('warning', 'W_CE_ONLY',
      `${commaInt(ws.table.n_valid)} plans is too many to list; only plans that can be cost-effective are shown.`,
      'watershed'))
  }
  const decisions = evaluateDecisions(project, sites, ws)
  issues.push(...decisions.issues)
  return { project, benefits, costs, sites, watershed: ws, decisions, issues }
}

export const spacePlanCount = (space: PlanSpace): bigint => planCount(space)
