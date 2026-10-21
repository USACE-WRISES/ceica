// Incremental cost analysis: best buys and increments, exactly as IWR Planning Suite II does it
// (ceica/ica.py).
//
// IWR's best-buy search starts at the base point (see iwrBase), picks the cost-effective plan with the
// lowest incremental cost per unit of output among those with more output than the base, moves the
// base there and repeats. Ties go to the plan earlier in output order, so every plan on a straight
// (collinear) stretch of the frontier becomes a best buy, and every plan identical to a best buy is
// one too. That walk traces the lower convex hull of the cost-effective points from the base, which
// is how it is computed here: a monotone chain with exact integer cross products.
//
// The increments are then listed along any series sorted by output, starting from (0, 0), as IWR
// Planning Suite II lists them (docs/methods.md, sections 5 and 6).
import { type Base, dominance, iwrBase, type PlanPoints } from './cea'
import { ratio, unscale } from './numeric'

/** One row of an IWR incremental cost table. */
export interface Increment {
  readonly index: number
  readonly plan_id: string
  readonly cost: number
  readonly output: number
  readonly avg_cost: number
  readonly inc_cost: number
  readonly inc_output: number
  readonly inc_cost_per_unit: number
  readonly prev_plan_id: string | null
}

/** Cost-effectiveness and best-buy status for one planning set. */
export interface CEICAResult {
  readonly points: PlanPoints
  /** Cost-effective, as displayed (No Action always shows as cost-effective). */
  readonly ce: Uint8Array
  /** Best buy, as displayed (No Action always shows as a best buy). */
  readonly bb: Uint8Array
  /** Cost-effective under the dominance rules alone. */
  readonly ce_raw: Uint8Array
  /** A dominating plan's index for each non-cost-effective plan (-1 otherwise). */
  readonly witness: Int32Array
  /** Which rule made a plan non-cost-effective (the REASON_* codes of cea.ts). */
  readonly reason: Int8Array
  readonly base: Base
  /** Distinct best-buy points in IWR's selection order, as plan indices (first plan per point). */
  readonly walk: readonly number[]
  /** The IWR "Incremental Cost of Best Buy Plans" table. */
  readonly bb_increments: readonly Increment[]
}

const count = (mask: Uint8Array): number => mask.reduce((s, v) => s + v, 0)

export const nPlans = (res: CEICAResult): number => res.points.ids.length
/** Cost-effective plans, best buys included (the count people usually quote). */
export const nCe = (res: CEICAResult): number => count(res.ce)
export const nBb = (res: CEICAResult): number => count(res.bb)
/** Cost-effective plans that are not best buys (IWR's '#CE' attribute). */
export function nCeOnly(res: CEICAResult): number {
  let n = 0
  for (let i = 0; i < res.ce.length; i++) if (res.ce[i] && !res.bb[i]) n++
  return n
}

/** The indices where a mask is set (np.flatnonzero). */
export function flatNonzero(mask: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(i)
  return out
}

/** Cross product of (a - o) and (b - o) in (output, cost) coordinates, exactly: its sign. */
function crossSign(o: readonly [number, number], a: readonly [number, number],
  b: readonly [number, number]): number {
  const dq1 = a[0] - o[0]
  const dc1 = a[1] - o[1]
  const dq2 = b[0] - o[0]
  const dc2 = b[1] - o[1]
  const lim = 2 ** 26
  if (Math.abs(dq1) < lim && Math.abs(dc1) < lim && Math.abs(dq2) < lim && Math.abs(dc2) < lim) {
    return Math.sign(dq1 * dc2 - dc1 * dq2)
  }
  const v = BigInt(dq1) * BigInt(dc2) - BigInt(dc1) * BigInt(dq2)
  return v < 0n ? -1 : v > 0n ? 1 : 0
}

/** Best buys under IWR's rules (without the No Action display rule): the mask and the distinct
 * best-buy points in selection order. */
export function bestBuys(pts: PlanPoints, ceRaw: Uint8Array, base: Base): { bb: Uint8Array, walk: number[] } {
  const q = pts.output
  const c = pts.cost
  const n = pts.ids.length
  const cand = new Uint8Array(n)
  for (let i = 0; i < n; i++) cand[i] = ceRaw[i] && q[i] > base.output ? 1 : 0
  // the distinct candidate points, sorted by output, then cost
  const seen = new Set<string>()
  const points: [number, number][] = []
  for (let i = 0; i < n; i++) {
    if (!cand[i]) continue
    const key = `${q[i]},${c[i]}`
    if (!seen.has(key)) {
      seen.add(key)
      points.push([q[i], c[i]])
    }
  }
  points.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const hull: [number, number][] = [[base.output, base.cost]]
  for (const p of points) {
    // Pop only strict non-convex turns: collinear points stay (IWR's strict "<" tie rule).
    while (hull.length >= 2 && crossSign(hull[hull.length - 2], hull[hull.length - 1], p) < 0) hull.pop()
    hull.push(p)
  }
  const chosen = hull.slice(1)
  const bb = new Uint8Array(n)
  const walk: number[] = []
  if (chosen.length) {
    const key = new Map<string, number>()
    chosen.forEach((pt, k) => key.set(`${pt[0]},${pt[1]}`, k))
    const firstIndex = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      if (!cand[i]) continue
      const k = key.get(`${q[i]},${c[i]}`)
      if (k !== undefined) {
        bb[i] = 1
        if (!firstIndex.has(k)) firstIndex.set(k, i)
      }
    }
    for (let k = 0; k < chosen.length; k++) walk.push(firstIndex.get(k)!)
  }
  return { bb, walk }
}

/** IWR's increments over the given plans: sorted by output, previous starts at (0, 0).
 *
 * Ties in output keep the given order (LINQ OrderBy is stable). An increment of zero output reports
 * zero cost per unit, as IWR does. */
export function incrementalSeries(pts: PlanPoints, indices: Iterable<number>): Increment[] {
  const idx = Array.from(indices)
  idx.sort((a, b) => pts.output[a] - pts.output[b])  // stable
  const rows: Increment[] = []
  let prevQ = 0
  let prevC = 0
  let prevId: string | null = null
  const cdp = pts.cost_dp
  const qdp = pts.output_dp
  for (const i of idx) {
    const qi = pts.output[i]
    const ci = pts.cost[i]
    // both terms below 2**52 (numeric.ts), so their difference is exact
    const dq = qi - prevQ
    const dc = ci - prevC
    rows.push({
      index: i,
      plan_id: pts.ids[i],
      cost: unscale(ci, cdp),
      output: unscale(qi, qdp),
      avg_cost: ratio(ci, qi, cdp, qdp),
      inc_cost: unscale(dc, cdp),
      inc_output: unscale(dq, qdp),
      inc_cost_per_unit: ratio(dc, dq, cdp, qdp),
      prev_plan_id: prevId,
    })
    prevQ = qi
    prevC = ci
    prevId = pts.ids[i]
  }
  return rows
}

/** Cost-effectiveness and best buys for one planning set, with IWR's display rules. */
export function runCeica(pts: PlanPoints): CEICAResult {
  const { ce: ceRaw, witness, reason } = dominance(pts)
  const base = iwrBase(pts)
  const { bb: bbRaw, walk } = bestBuys(pts, ceRaw, base)
  const ce = ceRaw.slice()
  const bb = bbRaw.slice()
  if (pts.no_action !== null) {
    // IWR always shows No Action as a best buy.
    ce[pts.no_action] = 1
    bb[pts.no_action] = 1
  }
  const bbRows = incrementalSeries(pts, flatNonzero(bb))
  return { points: pts, ce, bb, ce_raw: ceRaw, witness, reason, base, walk, bb_increments: bbRows }
}
