// Cost-effectiveness screening, exactly as IWR Planning Suite II does it (ceica/cea.py).
//
// A planning set is a list of plans, each with one cost and one output value. IWR marks a plan
// **not cost-effective** when another plan gives
//
// * the same output at strictly lower cost (IWR's "ineffective" step), or
// * strictly more output at the same or lower cost (IWR's "inefficient" step).
//
// Two plans with identical cost and output are both cost-effective. Values are compared as integers
// (see numeric.ts), so ties are exact.
//
// The incremental cost analysis starts from a base point: the No Action plan, unless another plan
// gives No Action's output for less (then IWR drops No Action from the list and starts at (0, 0)).
// docs/methods.md, sections 4 and 5, gives the rules as IWR Planning Suite II applies them.
import { COST_DP, OUTPUT_DP, quantizeArray } from './numeric'
import { orderByOutputCost } from './order'

/** Why a plan is not cost-effective. */
export const REASON_NONE = 0
export const REASON_SAME_OUTPUT_LOWER_COST = 1
export const REASON_MORE_OUTPUT_NO_MORE_COST = 2

/** One CE/ICA planning set: stable plan ids with integer-scaled cost and output. */
export interface PlanPoints {
  readonly ids: readonly string[]
  /** Cost in 10**-cost_dp units (cents by default), whole numbers. */
  readonly cost: Float64Array
  /** Output in 10**-output_dp units (thousandths by default), whole numbers. */
  readonly output: Float64Array
  /** Index of the No Action plan, or null when the set has none. */
  readonly no_action: number | null
  readonly cost_dp: number
  readonly output_dp: number
}

export function planPoints(ids: readonly string[], cost: Float64Array, output: Float64Array,
  noAction: number | null = null, costDp = COST_DP, outputDp = OUTPUT_DP): PlanPoints {
  return { ids, cost, output, no_action: noAction, cost_dp: costDp, output_dp: outputDp }
}

/** Round float costs and outputs the IWR way and hold them as integers (PlanPoints.from_values). */
export function pointsFromValues(ids: readonly string[], costs: ArrayLike<number>,
  outputs: ArrayLike<number>, noAction: number | null = null,
  { costDp = COST_DP, outputDp = OUTPUT_DP }: { costDp?: number, outputDp?: number } = {}): PlanPoints {
  if (!(ids.length === costs.length && costs.length === outputs.length)) {
    throw new RangeError('ids, costs and outputs must have the same length')
  }
  return planPoints(ids, quantizeArray(costs, costDp), quantizeArray(outputs, outputDp), noAction,
    costDp, outputDp)
}

/** Where the incremental cost analysis starts. */
export interface Base {
  readonly cost: number
  readonly output: number
  /** True when the base is the No Action plan; false when it is the origin (0, 0). */
  readonly uses_no_action: boolean
}

export interface Dominance {
  /** 1 for cost-effective plans */
  ce: Uint8Array
  /** the index of one plan that dominates each non-cost-effective plan (-1 when cost-effective) */
  witness: Int32Array
  /** which rule applied (the REASON_* constants) */
  reason: Int8Array
}

/** Cost-effectiveness under IWR's relation, in O(n log n) (cea.dominance). */
export function dominance(pts: PlanPoints): Dominance {
  const n = pts.ids.length
  const q = pts.output
  const c = pts.cost
  const ce = new Uint8Array(n).fill(1)
  const witness = new Int32Array(n).fill(-1)
  const reason = new Int8Array(n)
  if (n === 0) return { ce, witness, reason }

  // Output descending, then cost ascending: each output group starts with its cheapest plan.
  const order = orderByOutputCost(q, c, true)
  // the groups: the cheapest plan of each (gfirst) and its cost (gmin); gid per sorted position
  const gid = new Int32Array(n)
  const gfirst: number[] = []
  const gmin: number[] = []
  for (let k = 0; k < n; k++) {
    const i = order[k]
    if (k === 0 || q[i] !== q[order[k - 1]]) {
      gfirst.push(i)
      gmin.push(c[i])
    }
    gid[k] = gfirst.length - 1
  }
  // Cheapest cost among plans with strictly greater output, and which plan that is (the earliest
  // one to set the running minimum).
  const g = gfirst.length
  const better = new Float64Array(g)
  const betterArg = new Int32Array(g)
  let runMin = Infinity
  let runArg = -1
  for (let k = 0; k < g; k++) {
    if (k > 0 && gmin[k - 1] < runMin) {
      runMin = gmin[k - 1]
      runArg = gfirst[k - 1]
    }
    better[k] = runMin
    betterArg[k] = runMin < Infinity ? runArg : -1
  }
  for (let k = 0; k < n; k++) {
    const i = order[k]
    const grp = gid[k]
    const sameOutCheaper = gmin[grp] < c[i]
    const moreOutNoMore = better[grp] <= c[i]
    if (sameOutCheaper) {
      ce[i] = 0
      witness[i] = gfirst[grp]
      reason[i] = REASON_SAME_OUTPUT_LOWER_COST
    } else if (moreOutNoMore) {
      ce[i] = 0
      witness[i] = betterArg[grp]
      reason[i] = REASON_MORE_OUTPUT_NO_MORE_COST
    }
  }
  return { ce, witness, reason }
}

/** IWR's starting point for the incremental cost analysis.
 *
 * No Action is the base unless another plan has No Action's output at a lower cost; IWR then drops
 * No Action from the analysis list and starts from (0, 0). */
export function iwrBase(pts: PlanPoints): Base {
  const na = pts.no_action
  if (na === null) return { cost: 0, output: 0, uses_no_action: false }
  const qNa = pts.output[na]
  const cNa = pts.cost[na]
  for (let i = 0; i < pts.ids.length; i++) {
    if (pts.output[i] === qNa && pts.cost[i] < cNa) return { cost: 0, output: 0, uses_no_action: false }
  }
  return { cost: cNa, output: qNa, uses_no_action: true }
}
