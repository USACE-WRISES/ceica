// Annualization: average annual outputs and average annual costs (ceica/annualize.py).
//
// Outputs: the output at each target year is time-averaged over the period by linear
// interpolation (the trapezoid rule, ecorest::annualizer). IWR Planning Suite's Annualizer
// variant, which interpolates every integer year and rounds interpolated years to 2 decimals, is
// an option.
//
// Costs: first costs (construction, monitoring, adaptive management, ...) and interest during
// construction (IDC) are base-year lump sums; recurring OMRRR items are discounted to present
// value; the total is spread over the period with the capital recovery factor (CRF):
//
//     average annual cost = CRF x (first costs + IDC + PV of OMRRR)
//
// IDC uses uniform spending over the construction months. The closed forms below equal IWR Planning
// Suite II's period-by-period sum with START, MIDDLE or END conventions; END with monthly periods is
// EngrEcon's interest_during_construction, which the Utoy analysis used.
//
// Every power is crPow (correctly rounded, the same in every browser); every Python sum() is the
// compensated pySum.
import { pyFixed } from '../py/pyfmt'
import { crPow, pySum } from '../py/pynum'
import { alternativeSeries } from './benefits'
import { type Alternative, noAction, type Project, type RecurringItem, type Site, valuesFor } from './model'

// --- primitives ----------------------------------------------------------------------------------

/** Capital recovery factor r(1+r)^n / ((1+r)^n - 1); 1/n at a zero rate. */
export function crf(rate: number, n: number): number {
  if (n <= 0) throw new RangeError('period must be positive')
  if (rate === 0) return 1.0 / n
  const g = crPow(1.0 + rate, n)
  return rate * g / (g - 1.0)
}

/** Present value factor for a cost in ``year``. MID_YEAR discounts as IWR Planning Suite II does. */
export function pvFactor(rate: number, year: number, timing = 'END_OF_YEAR'): number {
  if (year === 0 || rate === 0) return 1.0
  if (timing === 'MID_YEAR') {
    const n = year > 0 ? year - 0.5 : year + 0.5
    return crPow(1.0 + rate, -n)
  }
  return crPow(1.0 + rate, -year)
}

function idcLead(a: number, method: string): number {
  if (method === 'END') return 1.0
  if (method === 'START') return 1.0 + a
  if (method === 'MIDDLE') return 1.0 + a / 2.0
  throw new RangeError(`unknown IDC method '${method}'`)
}

/** Interest during construction for ``firstCost`` spent evenly over ``months`` periods.
 *
 * IDC = P/M * (lead * ((1+a)^M - 1)/a - M), a = (1+r)^(1/ppy) - 1, lead = 1 (END), 1+a (START)
 * or 1+a/2 (MIDDLE, IWR's half period). */
export function idcUniform(firstCost: number, months: number, rate: number,
  { periodsPerYear = 12, method = 'END' }: { periodsPerYear?: number, method?: string } = {}): number {
  const m = months
  if (m <= 0 || rate === 0 || firstCost === 0) return 0.0
  const a = crPow(1.0 + rate, 1.0 / periodsPerYear) - 1.0
  const lead = idcLead(a, method)
  if (m === Math.trunc(m)) {
    // IWR's per-period sum (exact; the closed form loses digits to cancellation)
    const per = firstCost / m
    const terms: number[] = []
    for (let k = 1; k <= m; k++) terms.push(per * (lead * crPow(1.0 + a, m - k) - 1.0))
    return pySum(terms)
  }
  const s = (crPow(1.0 + a, m) - 1.0) / a
  return firstCost / m * (lead * s - m)
}

/** IDC as IWR Planning Suite II sums it, for an explicit spending schedule (period 1 is the first). */
export function idcSchedule(costsByPeriod: readonly number[], rate: number,
  { periodsPerYear = 12, method = 'END' }: { periodsPerYear?: number, method?: string } = {}): number {
  const a = crPow(1.0 + rate, 1.0 / periodsPerYear) - 1.0
  const factored = ({ START: a, MIDDLE: a / 2.0, END: 0.0 } as Record<string, number>)[method]
  if (factored === undefined) throw new RangeError(`unknown IDC method '${method}'`)
  const total = costsByPeriod.length
  let idc = 0.0
  costsByPeriod.forEach((cost, i) => {
    const period = total + 1 - (i + 1)
    idc += ((1.0 + factored) * crPow(1.0 + a, period - 1) - 1.0) * cost
  })
  return idc
}

/** Years a recurring cost occurs: firstYear (default ``every``), then every ``every`` years. */
export function recurringOccurrences(every: number, poa: number, firstYear: number | null = null,
  lastYear: number | null = null): number[] {
  const f = firstYear === null ? every : firstYear
  const last = lastYear === null ? poa : Math.min(lastYear, poa)
  if (every < 1 || last < f) return []
  const out: number[] = []
  for (let t = f; t <= last; t += every) out.push(t)
  return out
}

/** Present value of ``amount`` every ``every`` years: the sum of amount x PV factor per
 * occurrence.
 *
 * END_OF_YEAR is EngrEcon's om_distribute; MID_YEAR discounts each occurrence after year 0 half a
 * year less (IWR Annualizer). The Excel calculator writes the equal closed form
 * A (1+r)^-F (1 - w^K) / (1 - w), w = (1+r)^-N. */
export function recurringPv(amount: number, every: number, rate: number, poa: number,
  { firstYear = null, lastYear = null, timing = 'END_OF_YEAR' }:
  { firstYear?: number | null, lastYear?: number | null, timing?: string } = {}): number {
  if (amount === 0) return 0.0
  return pySum(recurringOccurrences(every, poa, firstYear, lastYear).map((t) => amount * pvFactor(rate, t, timing)))
}

/** Time-averaged output over the span of ``years``.
 *
 * TRAPEZOID: area under the straight lines between target years over (last - first), which is
 * ecorest::annualizer. IWR_YEARLY_2DP: IWR Annualizer; values at every integer year from 0 to
 * ``poa``, interpolated years rounded to 2 decimals (half to even), trapezoid average over
 * ``poa``. */
export function timeAverage(years: readonly number[], values: readonly number[],
  { method = 'TRAPEZOID', poa = null }: { method?: string, poa?: number | null } = {}): number {
  if (years.length !== values.length || years.length < 2) {
    throw new RangeError('need matching years and values, at least two')
  }
  if (method === 'IWR_YEARLY_2DP') {
    const yearly = iwrYearlyValues(years, values, poa !== null ? poa : Math.trunc(years[years.length - 1]))
    const n = yearly.length - 1
    const terms: number[] = []
    for (let i = 1; i <= n; i++) terms.push((yearly[i] + yearly[i - 1]) / 2.0)
    return pySum(terms) / n
  }
  let area = 0.0
  for (let i = 0; i + 1 < years.length; i++) {
    area += (years[i + 1] - years[i]) * (values[i] + values[i + 1]) / 2.0
  }
  return area / (years[years.length - 1] - years[0])
}

/** IWR Planning Suite II's annualizer: integer years 0..poa, starting from (0, 0).
 *
 * Target years are control points (kept exact); years between are linearly interpolated from the
 * previous control point and rounded to 2 decimals (Math.Round, half to even). */
export function iwrYearlyValues(years: readonly number[], values: readonly number[], poa: number): number[] {
  const control = new Map<number, number>()
  years.forEach((t, i) => control.set(Math.trunc(t), values[i]))
  const out = new Array<number>(poa + 1).fill(0.0)
  // a Python list index: negative counts from the end
  const at = (i: number): number => {
    const k = i < 0 ? out.length + i : i
    if (k < 0 || k >= out.length) throw new RangeError('list assignment index out of range')
    return k
  }
  let cur = 0.0
  let prevYear = 0
  for (const t of [...control.keys()].sort((a, b) => a - b)) {
    if (t > poa) break
    const v = control.get(t)!
    if (t > prevYear) {
      const inc = (v - cur) / (t - prevYear)
      let base = cur
      for (let i = prevYear + 1; i < t; i++) {
        base += inc
        out[at(i)] = Number(pyFixed(base, 2))
      }
    }
    out[at(t)] = v
    cur = v
    prevYear = t
  }
  return out
}

// --- project level -------------------------------------------------------------------------------

/** Outputs of one alternative: yearly series, time averages and lift over No Action. */
export interface BenefitLine {
  readonly site_id: string
  readonly alt_id: string
  /** Output (HU or condition units) at each target year, per module entered by year. */
  readonly series: ReadonlyMap<string, readonly (number | null)[]>
  /** Average annual output per module (the entered value for an average-annual module). */
  readonly aahu_by_module: ReadonlyMap<string, number | null>
  /** The sum of the modules. */
  readonly aahu: number | null
  readonly lift_by_module: ReadonlyMap<string, number | null>
  readonly lift: number | null
  /** Why a value is missing, in words (empty when complete). */
  readonly missing: readonly string[]
}

/** Costs of one alternative, from first costs to the average annual cost. */
export interface CostLine {
  readonly site_id: string
  readonly alt_id: string
  readonly first_costs: ReadonlyMap<string, number>
  readonly idc_base: number
  readonly idc: number
  /** Amount per occurrence and present value of each recurring item. */
  readonly recurring_amounts: ReadonlyMap<string, number>
  readonly recurring_pv: ReadonlyMap<string, number>
  readonly total_pv: number
  readonly annual: number
  /** Annual cost split for the cost chart: one entry per first-cost category, "idc", "omrrr". */
  readonly annual_parts: ReadonlyMap<string, number>
  readonly overridden: boolean
  /** Average annual cost relative to No Action (what CE/ICA uses). */
  readonly incremental: number | null
}

/** The key of a site's alternative in the benefit and cost maps (ids cannot hold "|"). */
export const lineKey = (siteId: string, altId: string): string => `${siteId}|${altId}`

export function recurringAmount(item: RecurringItem, firstCosts: ReadonlyMap<string, number>): number {
  if (item.basis === 'PCT_OF_CATEGORY') return item.percent * (firstCosts.get(item.category_id || '') ?? 0.0)
  if (item.basis === 'RATE_X_QUANTITY') return item.unit_rate * item.quantity
  return item.amount
}

export function costLine(project: Project, site: Site, alt: Alternative): CostLine {
  const st = project.settings
  const rate = st.discount_rate
  const poa = st.period_of_analysis
  const c = alt.costs
  const first = new Map<string, number>()
  for (const cat of project.cost_categories) first.set(cat.id, c.first_costs.get(cat.id) ?? 0.0)
  const idcBase = pySum(project.cost_categories.filter((cat) => cat.idc_applies).map((cat) => first.get(cat.id)!))
  const idc = idcUniform(idcBase, c.construction_months, rate,
    { periodsPerYear: st.idc_periods_per_year, method: st.idc_method })
  const amounts = new Map<string, number>()
  const pvs = new Map<string, number>()
  for (const item of c.recurring) {
    const a = recurringAmount(item, first)
    amounts.set(item.id, a)
    pvs.set(item.id, recurringPv(a, item.every_years, rate, poa,
      { firstYear: item.first_year, lastYear: item.last_year, timing: st.recurring_timing }))
  }
  const totalPv = pySum(first.values()) + idc + pySum(pvs.values())
  const k = crf(rate, poa)
  const parts = new Map<string, number>()
  for (const [cid, v] of first) parts.set(cid, k * v)
  parts.set('idc', k * idc)
  parts.set('omrrr', k * pySum(pvs.values()))
  const line = { site_id: site.id, alt_id: alt.id, first_costs: first, idc_base: idcBase, idc,
    recurring_amounts: amounts, recurring_pv: pvs, total_pv: totalPv }
  if (c.annual_override !== null) {
    return { ...line, annual: c.annual_override, annual_parts: new Map([['entered', c.annual_override]]),
      overridden: true, incremental: null }
  }
  return { ...line, annual: k * totalPv, annual_parts: parts, overridden: false, incremental: null }
}

/** Each module's average annual output and their sum for one alternative. */
export function benefitLine(project: Project, site: Site, alt: Alternative): BenefitLine {
  const spec = project.benefits
  const st = project.settings
  const [series, missing] = alternativeSeries(project, site, alt)
  const byModule = new Map<string, number | null>()
  for (const m of spec.modules) {
    if (m.method === 'AAHU') {
      const mv = valuesFor(alt, m.id)
      byModule.set(m.id, mv === null || mv.aahu === null ? null : mv.aahu)
      continue
    }
    const vals = series.get(m.id)!
    if (vals.some((v) => v === null)) byModule.set(m.id, null)
    else {
      byModule.set(m.id, timeAverage(spec.target_years, vals as number[],
        { method: st.aahu_method, poa: st.period_of_analysis }))
    }
  }
  const all = [...byModule.values()]
  const total = all.some((v) => v === null) ? null : pySum(all as number[])
  return { site_id: site.id, alt_id: alt.id, series, aahu_by_module: byModule, aahu: total,
    lift_by_module: new Map(), lift: null, missing }
}

/** Benefit and cost lines for every alternative, with lift and incremental cost filled in. */
export function annualize(project: Project): { benefits: Map<string, BenefitLine>, costs: Map<string, CostLine> } {
  const benefits = new Map<string, BenefitLine>()
  const costs = new Map<string, CostLine>()
  for (const site of project.sites) {
    const na = noAction(site)
    const linesB = new Map(site.alternatives.map((a) => [a.id, benefitLine(project, site, a)]))
    const linesC = new Map(site.alternatives.map((a) => [a.id, costLine(project, site, a)]))
    const naB = na ? linesB.get(na.id) ?? null : null
    const naC = na ? linesC.get(na.id) ?? null : null
    for (const a of site.alternatives) {
      const b = linesB.get(a.id)!
      const lift = naB && b.aahu !== null && naB.aahu !== null ? b.aahu - naB.aahu : null
      const liftM = new Map<string, number | null>()
      for (const [mid, v] of b.aahu_by_module) {
        const base = naB ? naB.aahu_by_module.get(mid) ?? null : null
        liftM.set(mid, v !== null && base !== null ? v - base : null)
      }
      benefits.set(lineKey(site.id, a.id), { ...b, lift_by_module: liftM, lift })
      const cl = linesC.get(a.id)!
      const inc = naC !== null ? cl.annual - naC.annual : cl.annual
      costs.set(lineKey(site.id, a.id), { ...cl, incremental: inc })
    }
  }
  return { benefits, costs }
}
