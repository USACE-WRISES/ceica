// Watershed plans: every combination of zero or one carried alternative per site (ceica/plans.py).
//
// A plan space lists the sites carried forward, in significance order, and the alternatives each
// carries (digit 0 is No Action, digit k the k-th carried alternative). Plans are numbered in mixed
// radix with the first site most significant, so with one alternative per site the number is
// Utoy's P = 1 + sum(bit_j * 2^(n - j)): P1 is No Action and P(2^n) holds every site.
//
// Effects add up (IWR watershed semantics): a plan's output and cost are sums of the sites' already
// rounded values, held as integers. IWR's relationship rules filter the combinations:
//
// * NOT_COMBINABLE (X, {Y...}): a plan holding X and every Y is rejected.
// * DEPENDS_ON (X, {Y...}): a plan holding X must hold every Y; several rows for X are alternatives.
//
// Up to FULL_LIMIT plans are enumerated. Beyond that, without rules, paretoMerge keeps only partial
// plans that can still be cost-effective (a dominated partial plan stays dominated whatever is added
// to it), which finds the same cost-effective set and best buys exactly. docs/methods.md, section 7,
// gives the rules as IWR Planning Suite II applies them.
//
// Plan numbers are JavaScript numbers while the space has at most 2**53 combinations and BigInts
// past that; Python's int64 plan numbers wrap past 2**63 (web/README.md, differences by design).
import { dominance, planPoints } from './cea'
import { flatNonzero } from './ica'
import { type Composition, compositionKey, parseCompositionKey, type Rule } from './model'
import { EXACT_LIMIT, TooLargeError } from './numeric'
import { orderByOutputCost } from './order'
import { commaInt } from '../py/pynum'

/** IWR Planning Suite's largest planning set for CE/ICA. */
export const IWR_PLAN_LIMIT = 175_000
/** Largest plan space CEICA enumerates in full. */
export const FULL_LIMIT = 2_000_000

export interface PlanSpace {
  readonly site_ids: readonly string[]
  /** Carried alternatives per site (No Action excluded); digit k picks options[j][k - 1]. */
  readonly options: readonly (readonly string[])[]
  /** Integer-scaled output and cost per digit (index 0 is No Action, always 0). */
  readonly q: readonly Float64Array[]
  readonly c: readonly Float64Array[]
  /** Other additive values per digit, as floats (for example construction cost). */
  readonly extra: ReadonlyMap<string, readonly Float64Array[]>
  readonly rules: readonly Rule[]
}

export const radices = (space: PlanSpace): number[] => space.options.map((o) => o.length + 1)

/** Number of combinations before rules. */
export function spaceSize(space: PlanSpace): bigint {
  let n = 1n
  for (const r of radices(space)) n *= BigInt(r)
  return n
}

export const isBinary = (space: PlanSpace): boolean => space.options.every((o) => o.length === 1)

/** Build a space. ``values.get(site).get(alt)`` = [output int, cost int];
 * ``extra.get(name).get(site).get(alt)`` a float. */
export function makeSpace(siteIds: readonly string[], options: readonly (readonly string[])[],
  values: ReadonlyMap<string, ReadonlyMap<string, readonly [number, number]>>,
  extra: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>> | null = null,
  rules: readonly Rule[] = []): PlanSpace {
  const qs: Float64Array[] = []
  const cs: Float64Array[] = []
  const ex = new Map<string, Float64Array[]>()
  for (const name of extra?.keys() ?? []) ex.set(name, [])
  siteIds.forEach((sid, j) => {
    const opts = options[j]
    qs.push(Float64Array.from([0, ...opts.map((a) => values.get(sid)!.get(a)![0])]))
    cs.push(Float64Array.from([0, ...opts.map((a) => values.get(sid)!.get(a)![1])]))
    for (const [name, perSite] of extra ?? []) {
      ex.get(name)!.push(Float64Array.from([0, ...opts.map((a) => perSite.get(sid)!.get(a)!)]))
    }
  })
  return { site_ids: [...siteIds], options: options.map((o) => [...o]), q: qs, c: cs, extra: ex,
    rules: [...rules] }
}

/** Enumerated plans (valid under the rules only). */
export interface PlanTable {
  readonly space: PlanSpace
  /** (plans x sites) digits, row by row */
  readonly digits: Uint8Array
  /** 1-based plan numbers: numbers, or BigInts in a space of more than 2**53 combinations */
  readonly plan_no: Float64Array | readonly bigint[]
  /** scaled sums */
  readonly output: Float64Array
  readonly cost: Float64Array
  readonly extra: ReadonlyMap<string, Float64Array>
  /** True when only candidate (possibly cost-effective) plans are listed (Pareto merge). */
  readonly ce_only: boolean
  /** Plans in the space that pass the rules (all of them, even when ce_only). */
  readonly n_valid: bigint
}

export const tableLength = (t: PlanTable): number => t.output.length

/** The digits of plan ``i``. */
export function digitsOf(t: PlanTable, i: number): Uint8Array {
  const s = t.space.site_ids.length
  return t.digits.subarray(i * s, (i + 1) * s)
}

export const planNumber = (t: PlanTable, i: number): number | bigint => t.plan_no[i]

/** "P" and the plan number, for every plan. */
export function tableIds(t: PlanTable): string[] {
  return Array.from({ length: tableLength(t) }, (_, i) => `P${t.plan_no[i]}`)
}

export const tableComposition = (t: PlanTable, i: number): Map<string, string> =>
  compositionOf(t.space, digitsOf(t, i))

export const tableKey = (t: PlanTable, i: number): string => compositionKey(tableComposition(t, i))

export function noActionIndex(t: PlanTable): number | null {
  const s = t.space.site_ids.length
  for (let i = 0; i < tableLength(t); i++) {
    let any = false
    for (let j = 0; j < s; j++) if (t.digits[i * s + j]) any = true
    if (!any) return i
  }
  return null
}

/** How a table finds a plan number: by binary search when its numbers ascend (an enumeration),
 * else through a map (a Pareto merge, ordered by output). */
const FINDER = new WeakMap<PlanTable, (num: bigint) => number | null>()

function finder(t: PlanTable): (num: bigint) => number | null {
  let find = FINDER.get(t)
  if (find) return find
  const n = tableLength(t)
  const pn = t.plan_no
  let ascending = pn instanceof Float64Array
  for (let i = 1; ascending && i < n; i++) if (!(pn[i - 1] < pn[i])) ascending = false
  if (ascending) {
    const nums = pn as Float64Array
    find = (num) => {
      if (num > BigInt(Number.MAX_SAFE_INTEGER)) return null
      const v = Number(num)
      let lo = 0
      let hi = n
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (nums[mid] < v) lo = mid + 1
        else hi = mid
      }
      return lo < n && nums[lo] === v ? lo : null
    }
  } else {
    const rows = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const k = String(pn[i])
      if (!rows.has(k)) rows.set(k, i)
    }
    find = (num) => rows.get(num.toString()) ?? null
  }
  FINDER.set(t, find)
  return find
}

/** Row of the plan with this composition key, or null if it is not in the table. */
export function indexOfKey(t: PlanTable, key: string): number | null {
  const comp = parseCompositionKey(key)
  for (const s of comp.keys()) if (!t.space.site_ids.includes(s)) return null
  const digits: number[] = []
  for (let j = 0; j < t.space.site_ids.length; j++) {
    const alt = comp.get(t.space.site_ids[j])
    const opts = t.space.options[j]
    if (alt === undefined) digits.push(0)
    else if (opts.includes(alt)) digits.push(opts.indexOf(alt) + 1)
    else return null
  }
  let num = 0n
  radices(t.space).forEach((r, j) => {
    num = num * BigInt(r) + BigInt(digits[j])
  })
  return finder(t)(num + 1n)
}

export function compositionOf(space: PlanSpace, digits: ArrayLike<number>): Map<string, string> {
  const out = new Map<string, string>()
  space.site_ids.forEach((sid, j) => {
    const d = digits[j]
    if (d > 0) out.set(sid, space.options[j][d - 1])
  })
  return out
}

/** Rows in a digits array (a space of no sites has one plan, No Action, and no digits). */
const rowsOf = (space: PlanSpace, digits: Uint8Array): number =>
  space.site_ids.length ? digits.length / space.site_ids.length : 0

/** 1 for plans that pass every rule (``rows`` rows of digits). Sites not in the space count as
 * absent. */
export function ruleMask(space: PlanSpace, digits: Uint8Array, rows = rowsOf(space, digits)): Uint8Array {
  const s = space.site_ids.length
  const n = rows
  const ok = new Uint8Array(n).fill(1)
  if (!space.rules.length || n === 0) return ok
  const col = new Map(space.site_ids.map((sid, j) => [sid, j]))
  const present = (sid: string, i: number): boolean => {
    const j = col.get(sid)
    return j !== undefined && digits[i * s + j] > 0
  }
  // DEPENDS_ON rows grouped by their site, in order of first appearance (Python's dict)
  const depends = new Map<string, Rule[]>()
  for (const rule of space.rules) {
    if (rule.kind !== 'NOT_COMBINABLE') {
      if (!depends.has(rule.site_id)) depends.set(rule.site_id, [])
      depends.get(rule.site_id)!.push(rule)
    }
  }
  for (let i = 0; i < n; i++) {
    for (const rule of space.rules) {
      if (rule.kind === 'NOT_COMBINABLE' && present(rule.site_id, i)
        && rule.with_sites.every((y) => present(y, i))) ok[i] = 0
    }
    for (const [sid, alts] of depends) {
      if (present(sid, i) && !alts.some((r) => r.with_sites.every((y) => present(y, i)))) ok[i] = 0
    }
  }
  return ok
}

/** The digits of plans 0 .. size - 1 (mixed radix, the first site most significant). */
function digitsFor(space: PlanSpace, size: number): Uint8Array {
  const rad = radices(space)
  const s = rad.length
  const digits = new Uint8Array(size * s)
  // count in mixed radix: each plan is the previous one plus one in the last digit, carried
  const cur = new Uint8Array(s)
  for (let i = 0; i < size; i++) {
    digits.set(cur, i * s)
    for (let j = s - 1; j >= 0; j--) {
      if (++cur[j] < rad[j]) break
      cur[j] = 0
    }
  }
  return digits
}

/** 1-based plan numbers for ``digits`` rows: numbers while the space allows, else BigInts. */
export function planNumbers(space: PlanSpace, digits: Uint8Array,
  rows = rowsOf(space, digits)): Float64Array | bigint[] {
  const rad = radices(space)
  const s = rad.length
  const n = rows
  if (spaceSize(space) <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let num = 0
      for (let j = 0; j < s; j++) num = num * rad[j] + digits[i * s + j]
      out[i] = num + 1
    }
    return out
  }
  const out: bigint[] = []
  for (let i = 0; i < n; i++) {
    let num = 0n
    for (let j = 0; j < s; j++) num = num * BigInt(rad[j]) + BigInt(digits[i * s + j])
    out.push(num + 1n)
  }
  return out
}

/** The largest |output| and |cost| any plan of the space can sum to must stay exact. */
function checkSums(space: PlanSpace): void {
  let q = 0
  let c = 0
  space.site_ids.forEach((_, j) => {
    q += Math.max(...Array.from(space.q[j], Math.abs))
    c += Math.max(...Array.from(space.c[j], Math.abs))
  })
  if (q >= EXACT_LIMIT || c >= EXACT_LIMIT) {
    throw new TooLargeError('The watershed plans add up to values too large to hold exactly')
  }
}

function sums(space: PlanSpace, digits: Uint8Array, rows: number): { q: Float64Array,
  c: Float64Array, ex: Map<string, Float64Array> } {
  const s = space.site_ids.length
  const n = rows
  const q = new Float64Array(n)
  const c = new Float64Array(n)
  const ex = new Map<string, Float64Array>()
  for (const k of space.extra.keys()) ex.set(k, new Float64Array(n))
  for (let j = 0; j < s; j++) {
    const qj = space.q[j]
    const cj = space.c[j]
    for (let i = 0; i < n; i++) {
      const d = digits[i * s + j]
      q[i] += qj[d]
      c[i] += cj[d]
    }
    for (const [k, per] of space.extra) {
      const e = ex.get(k)!
      for (let i = 0; i < n; i++) e[i] += per[j][digits[i * s + j]]
    }
  }
  return { q, c, ex }
}

/** Plans that pass the rules (IWR: sum over rule-passing site subsets of the product of their
 * option counts). */
export function planCount(space: PlanSpace): bigint {
  if (!space.rules.length) return spaceSize(space)
  const n = space.site_ids.length
  if (n > 24) throw new RangeError('too many sites to count plans with rules')
  const pres = new Uint8Array(2 ** n * n)
  for (let mask = 0; mask < 2 ** n; mask++) {
    for (let j = 0; j < n; j++) pres[mask * n + j] = (mask >> (n - 1 - j)) & 1
  }
  const ok = ruleMask(space, pres, 2 ** n)
  let total = 0n
  for (let mask = 0; mask < 2 ** n; mask++) {
    if (!ok[mask]) continue
    let per = 1n
    for (let j = 0; j < n; j++) if (pres[mask * n + j]) per *= BigInt(space.options[j].length)
    total += per
  }
  return total
}

/** Every valid plan, or the cost-effective candidates when the space is too large. */
export function enumeratePlans(space: PlanSpace, limit: number = FULL_LIMIT): PlanTable {
  const size = spaceSize(space)
  checkSums(space)
  if (size > BigInt(limit)) {
    if (space.rules.length) {
      throw new RangeError(`${commaInt(size)} plan combinations with rules is more than CEICA can `
        + `enumerate (${commaInt(limit)}). Carry fewer alternatives or sites.`)
    }
    return paretoMerge(space)
  }
  const n = Number(size)
  const all = digitsFor(space, n)
  const s = space.site_ids.length
  let digits = all
  let planNo: Float64Array
  if (space.rules.length) {
    const keep = flatNonzero(ruleMask(space, all, n))
    digits = new Uint8Array(keep.length * s)
    keep.forEach((i, k) => digits.set(all.subarray(i * s, (i + 1) * s), k * s))
    planNo = Float64Array.from(keep, (i) => i + 1)
  } else planNo = Float64Array.from({ length: n }, (_, i) => i + 1)
  const rows = planNo.length
  const { q, c, ex } = sums(space, digits, rows)
  return { space, digits, plan_no: planNo, output: q, cost: c, extra: ex, ce_only: false,
    n_valid: BigInt(rows) }
}

/** Indices of points not dominated under IWR's relation (duplicates kept). */
function prune(q: Float64Array, c: Float64Array): number[] {
  const { ce } = dominance(planPoints(new Array<string>(q.length).fill(''), c, q))
  return flatNonzero(ce)
}

/** Cost-effective candidates of a rule-free space, site by site (exact for additive effects). */
export function paretoMerge(space: PlanSpace): PlanTable {
  const nSites = space.site_ids.length
  const rad = radices(space)
  let rows: Uint8Array[] = [new Uint8Array(0)]
  let q = new Float64Array(1)
  let c = new Float64Array(1)
  for (let j = 0; j < nSites; j++) {
    const r = rad[j]
    const m = q.length * r
    const nq = new Float64Array(m)
    const nc = new Float64Array(m)
    const nrows: Uint8Array[] = []
    for (let b = 0; b < q.length; b++) {
      for (let d = 0; d < r; d++) {
        const k = b * r + d
        nq[k] = q[b] + space.q[j][d]
        nc[k] = c[b] + space.c[j][d]
        const row = new Uint8Array(j + 1)
        row.set(rows[b])
        row[j] = d
        nrows.push(row)
      }
    }
    const keep = prune(nq, nc)
    rows = keep.map((k) => nrows[k])
    q = Float64Array.from(keep, (k) => nq[k])
    c = Float64Array.from(keep, (k) => nc[k])
  }
  // IWR always lists No Action: add it back if it was pruned.
  if (!rows.some((row) => row.every((d) => d === 0))) {
    rows = [new Uint8Array(nSites), ...rows]
    q = Float64Array.from([0, ...q])
    c = Float64Array.from([0, ...c])
  }
  const order = orderByOutputCost(q, c, false)
  const digits = new Uint8Array(rows.length * nSites)
  order.forEach((i, k) => digits.set(rows[i], k * nSites))
  const { q: q2, c: c2, ex } = sums(space, digits, rows.length)
  return { space, digits, plan_no: planNumbers(space, digits, rows.length), output: q2, cost: c2,
    extra: ex,
    ce_only: true, n_valid: spaceSize(space) }
}

/** Readable composition, for example "2A + 2B + 19A" (alternative codes in multi mode). */
export function planLabel(space: PlanSpace, digits: ArrayLike<number>,
  { withAlts = null, noAction = 'No Action' }: { withAlts?: boolean | null, noAction?: string } = {}): string {
  const comp: Composition = compositionOf(space, digits)
  if (comp.size === 0) return noAction
  const show = withAlts === null ? !isBinary(space) : withAlts
  return [...comp].map(([s, a]) => (show ? `${s} (${a})` : s)).join(' + ')
}
