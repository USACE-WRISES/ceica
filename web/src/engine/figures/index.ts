// Figures built from analysis results: the scenes every renderer draws (ceica/figures/__init__.py).
//
//     siteCeIca(results, siteId)       -> [CE scene, ICA scene]
//     watershedCeIca(results)          -> [CE scene, ICA scene] or null
//     siteTimeSeries(results, siteId)  -> scene of outputs over time
//     siteCostStack(results, siteId)   -> scene of annualized cost by part
//     siteStaf(results, siteId)        -> [ECI scene, outcome scene]
import { commaInt, pySum } from '../../py/pynum'
import {
  type AltRow, type AnalysisResults, planRow, planRows, type PlanRow, siteBestBuys, siteRow, wsBb, wsCe, wsIndexOfKey,
} from '../analysis'
import { lineKey } from '../annualize'
import { stafRollups } from '../benefits'
import { money, num } from '../fmt'
import { siteOf } from '../model'
import { tableLength } from '../plans'
import { oneSite } from '../runState'
import { siteFunctionLift } from '../stafLift'
import {
  type Bar, ceScene, DENSITY_ABOVE, icaScene, type PlotPlan, type Scene, type Series, stackScene, type Step, timeSeriesScene,
} from './scene'
import { eciScene, type OutcomeBar, outcomeScene } from './staf'
import { niceRange, pow10, seqMax, seqMin } from './ticks'

/** The caption sentence under a chart with a density layer. */
export const DENSITY_NOTE = 'Plans that are not cost-effective are shaded: the darker the area, the more plans.'

function sharedX(xs: number[]): [number, number, number[]] {
  return niceRange(seqMin([...xs, 0.0]), seqMax([...xs, 0.0]))
}

/** 'Alt 1' for 'Alternative1', otherwise the id. */
function short(row: AltRow): string {
  const a = row.alt_id
  const rest = a.slice(11).trim()
  if (a.toLowerCase().startsWith('alternative') && /^\d+$/.test(rest)) return `Alt ${rest}`
  return a
}

export function siteCeIca(res: AnalysisResults, siteId: string, { width = 480, height = 330 } = {}): [Scene, Scene] {
  const p = res.project
  const lab = p.labels
  const sr = res.sites.get(siteId)!
  const dec = res.decisions.sites.get(siteId)
  const rec = dec && dec.source === 'team' ? dec.alt_id : null
  const unit = lab.annual_output_short
  const plans: PlotPlan[] = []
  for (const row of sr.rows) {
    if (row.lift === null) continue
    const tip = [row.name + (row.name === row.alt_id ? '' : ` (${row.alt_id})`), `Lift ${num(row.lift, 2)} ${unit}`,
      `${money(row.cost)} per year`,
      `Unit cost ${row.unit_cost !== null ? money(row.unit_cost) : 'n/a'} per ${unit}`,
      row.bb ? 'Best buy' : row.ce ? 'Cost-effective' : 'Not cost-effective']
    plans.push({ key: row.alt_id, label: row.is_no_action ? 'No Action' : short(row), x: row.lift, y: row.cost, ce: row.ce, bb: row.bb,
      na: row.is_no_action, decision: rec === row.alt_id && !row.is_no_action ? 'Recommended' : null, tip })
  }
  const xr = sharedX(plans.map((pl) => pl.x))
  const nCe = sr.rows.filter((r) => r.ce).length
  const bbs = siteBestBuys(sr).filter((r) => !r.is_no_action)
  const desc = `${plans.length} alternatives at site ${siteId}; ${nCe} cost-effective; best buys: `
    + (bbs.map((r) => r.alt_id).join(', ') || 'none besides No Action') + '.'
  const ce = ceScene(plans, { xlabel: `${lab.lift_name} (${unit})`, ylabel: 'Average annual cost', title: `Cost-effectiveness, site ${siteId}`,
    desc, width, height, labelAll: true, xRange: xr })
  const steps: Step[] = []
  let prevX = 0.0
  for (const r of siteBestBuys(sr)) {
    if (r.is_no_action || r.inc_cost_per_unit === null || r.lift === null) continue
    steps.push({ key: r.alt_id, label: short(r), x0: prevX, x1: r.lift, height: r.inc_cost_per_unit, dim: false,
      tip: [`${r.name}`, `+${num(r.inc_output || 0, 2)} ${unit}, +${money(r.inc_cost || 0)} per year`,
        `${money(r.inc_cost_per_unit)} per ${unit}`] })
    prevX = r.lift
  }
  const ica = icaScene(steps, { xlabel: `${lab.lift_name} (${unit})`, ylabel: `Incremental cost per ${unit}`,
    title: `Incremental cost, site ${siteId}`,
    desc: steps.length ? `${steps.length} best-buy steps: ` + steps.map((s) => `${s.label} at ${money(s.height)} per ${unit}`).join('; ') + '.'
      : 'No best buy beyond No Action.',
    width, height, xRange: xr })
  return [ce, ica]
}

/** Above ``densityAbove`` plans, the plans that are not cost-effective are shaded cells; the
 * cost-effective plans, the final array and the TSP keep their own marks. */
export function watershedCeIca(res: AnalysisResults, { width = 480, height = 330, densityAbove = DENSITY_ABOVE } = {}): [Scene, Scene] | null {
  const ws = res.watershed
  if (ws.table === null || ws.ceica === null) return null
  const p = res.project
  const lab = p.labels
  const unit = lab.annual_output_short
  const t = ws.table
  const pts = ws.ceica.points
  const tsp = res.decisions.tsp_state === 'ok' ? res.decisions.tsp_key : null
  const tspI = tsp ? wsIndexOfKey(ws, tsp) : null
  let density: [Float64Array, Float64Array] | null = null
  let rows: PlanRow[]
  const n = tableLength(t)
  if (n > densityAbove && !t.ce_only) {
    const keep = Uint8Array.from(ws.ceica.ce, (v) => (v ? 1 : 0))
    for (const i of [...res.decisions.final_keys.map((k) => wsIndexOfKey(ws, k)), tspI]) if (i !== null) keep[i] = 1
    const kept: number[] = []
    for (let i = 0; i < n; i++) if (keep[i]) kept.push(i)
    // sorted by (output, cost, index): the scaled integers
    kept.sort((a, b) => (t.output[a] - t.output[b]) || (t.cost[a] - t.cost[b]) || (a - b))
    rows = kept.map((i) => planRow(ws, i))
    const od = pow10(pts.output_dp)
    const cd = pow10(pts.cost_dp)
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < n; i++) {
      if (!keep[i]) {
        xs.push(t.output[i] / od)
        ys.push(t.cost[i] / cd)
      }
    }
    density = [Float64Array.from(xs), Float64Array.from(ys)]
  } else {
    rows = planRows(ws, 'all')
  }
  const plans: PlotPlan[] = rows.map((r) => ({
    key: r.plan_id, label: r.plan_id, x: r.output, y: r.cost, ce: r.ce, bb: r.bb, na: r.index === pts.no_action,
    decision: r.index === tspI ? 'TSP' : null,
    tip: [`${r.plan_id}: ${r.label}`, `Lift ${num(r.output, 1)} ${unit}`, `${money(r.cost)} per year`,
      `Unit cost ${r.unit_cost ? money(r.unit_cost) : 'n/a'} per ${unit}`,
      r.bb ? 'Best buy' : r.ce ? 'Cost-effective' : 'Not cost-effective'],
  }))
  const xs = plans.map((pl) => pl.x)
  if (density !== null && density[0].length) xs.push(seqMin(density[0]), seqMax(density[0]))
  const xr = sharedX(xs)
  const tspX = plans.find((pl) => pl.decision)?.x ?? null
  const bbRows = planRows(ws, 'bb')
  let desc = `${commaInt(t.n_valid)} plans; ${wsCe(ws)} cost-effective; ${wsBb(ws)} best buys: `
    + bbRows.map((r) => r.plan_id).join(', ') + '.'
  if (density !== null) {
    desc += ` The other ${commaInt(density[0].length)} plans, none of them cost-effective, are shaded by how many fall in each area.`
  } else if (t.ce_only) {
    desc += ` Only the ${commaInt(n)} plans that can be cost-effective are drawn.`
  }
  const noun = oneSite(p) ? 'plans' : 'watershed plans'
  const ce = ceScene(plans, { xlabel: `${lab.lift_name} (${unit})`, ylabel: 'Average annual cost', title: `Cost-effectiveness of ${noun}`,
    desc, width, height, xRange: xr, tspX, density })
  const steps: Step[] = []
  let prev: PlanRow | null = null
  for (const r of bbRows) {
    if (r.inc_cost_per_unit === null) {
      prev = r
      continue
    }
    const added = [...r.composition.keys()].filter((s) => !prev || !prev.composition.has(s))
    steps.push({ key: r.plan_id, label: r.plan_id, x0: prev ? prev.output : 0.0, x1: r.output, height: r.inc_cost_per_unit,
      dim: tspX !== null && r.output > tspX + 1e-9,
      tip: [`${r.plan_id}: ${r.label}`, added.length ? 'adds ' + added.join(', ') : '',
        `+${num(r.inc_output || 0, 1)} ${unit}, +${money(r.inc_cost || 0)} per year`, `${money(r.inc_cost_per_unit)} per ${unit}`] })
    prev = r
  }
  const ica = icaScene(steps, { xlabel: `${lab.lift_name} (${unit})`, ylabel: `Incremental cost per ${unit}`,
    title: 'Incremental cost of best-buy plans', desc: `${steps.length} steps between best buys.`, width, height, xRange: xr })
  return [ce, ica]
}

/** The caption sentence for a chart with a density layer, or "" for one without. */
export function densityNote(scene: Scene | null): string {
  if (scene === null || !scene.items.some((i) => i.role === 'density')) return ''
  return DENSITY_NOTE
}

/** Names of the modules entered as an average, which have no values by year to plot. */
export function leftOutOfTimeSeries(project: AnalysisResults['project']): string[] {
  return project.benefits.modules.filter((m) => m.method === 'AAHU').map((m) => m.name)
}

/** Each alternative's output at the target years: one module, or the sum of every module entered by
 * year (a module entered as an average has no yearly values and is left out). */
export function siteTimeSeries(res: AnalysisResults, siteId: string, module: string | null = null,
  { width = 480, height = 290 } = {}): Scene {
  const p = res.project
  const site = siteOf(p, siteId)!
  const ids = module ? [module] : p.benefits.modules.filter((m) => m.method !== 'AAHU').map((m) => m.id)
  const series: Series[] = []
  for (const a of site.alternatives) {
    const bl = res.benefits.get(lineKey(siteId, a.id))
    const parts = bl ? ids.filter((m) => bl.series.has(m)).map((m) => bl.series.get(m)!) : []
    if (!parts.length) continue
    const vals = parts[0].map((_, i) => (parts.some((c) => c[i] === null) ? null : pySum(parts.map((c) => c[i] as number))))
    const sr = res.sites.get(siteId)
    const row = sr ? siteRow(sr, a.id) : null
    const label = a.is_no_action ? 'No Action' : row ? short(row) : a.id
    series.push({ key: a.id, label, values: vals, na: a.is_no_action })
  }
  const lab = p.labels
  const left = module ? [] : leftOutOfTimeSeries(p)
  const note = left.length ? ` ${left.join(', ')} (entered as an average) is not included.` : ''
  return timeSeriesScene([...p.benefits.target_years], series, {
    ylabel: `${lab.output_name} (${lab.output_short})`, title: `${lab.output_name} over time, site ${siteId}`,
    desc: `${lab.output_name} at each target year for each alternative at site ${siteId}; straight lines between target years.${note}`,
    width, height })
}

export function siteCostStack(res: AnalysisResults, siteId: string, { width = 480 } = {}): Scene {
  const p = res.project
  const site = siteOf(p, siteId)!
  const names = new Map(p.cost_categories.map((c) => [c.id, c.name]))
  names.set('idc', 'Interest during construction')
  names.set('omrrr', 'OMRRR')
  names.set('entered', 'Average annual cost (entered)')
  const bars: Bar[] = []
  for (const a of site.alternatives) {
    if (a.is_no_action) continue
    const cl = res.costs.get(lineKey(siteId, a.id))!
    bars.push({ key: a.id, label: a.name || a.id, parts: [...cl.annual_parts].map(([k, v]) => [k, names.get(k) ?? k, v] as const) })
  }
  return stackScene(bars, { xlabel: 'Average annual cost', title: `Annualized cost, site ${siteId}`,
    desc: 'Average annual cost of each alternative by part.', width })
}

/** STAF site figures for one STAF module (the first by default): the ECI over time for every
 * alternative, and lift split by outcome. */
export function siteStaf(res: AnalysisResults, siteId: string, moduleId: string | null = null, { width = 480, height = 300 } = {}): [Scene, Scene] {
  const p = res.project
  const site = siteOf(p, siteId)!
  const mods = p.benefits.modules.filter((m) => m.method === 'STAF')
  const mod = mods.find((m) => m.id === moduleId) ?? mods[0]
  const where = `site ${siteId}` + (mods.length > 1 ? `, ${mod.name}` : '')
  const series: Series[] = []
  const bars: OutcomeBar[] = []
  for (const a of site.alternatives) {
    const sr = res.sites.get(siteId)
    const row = sr ? siteRow(sr, a.id) : null
    const label = a.is_no_action ? 'No Action' : row ? short(row) : a.id
    series.push({ key: a.id, label, values: stafRollups(p, site, a, mod.id).map((r) => r.eci), na: a.is_no_action })
    if (!a.is_no_action) {
      const fl = siteFunctionLift(res, siteId, a.id, mod.id)
      if (fl !== null) bars.push({ key: a.id, label: a.name || a.id, parts: fl.outcomes })
    }
  }
  const unit = p.labels.annual_output_short
  const eci = eciScene([...p.benefits.target_years], series, { title: `Ecosystem Condition Index over time, ${where}`,
    desc: `ECI at each target year for each alternative at ${where}, over the STAF condition bands.`, width, height })
  const out = outcomeScene(bars, { unit, title: `Lift by outcome, ${where}`,
    desc: "Each alternative's lift split into the physical, chemical and biological outcomes.", width })
  return [eci, out]
}

export { render, renderPanels } from './svg'
