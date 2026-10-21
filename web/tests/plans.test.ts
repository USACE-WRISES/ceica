// Watershed plans: against the Python engine (plans_ref.json, web/parity/make_plans_fixtures.py), and
// tests/test_plans.py ported (Hypothesis becomes fast-check, with the same example counts).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { planPoints } from '../src/engine/cea'
import { flatNonzero, runCeica } from '../src/engine/ica'
import type { Rule } from '../src/engine/model'
import {
  digitsOf, enumeratePlans, indexOfKey, makeSpace, noActionIndex, paretoMerge, planCount, planLabel,
  type PlanSpace, type PlanTable, spaceSize, tableIds, tableKey, tableLength,
} from '../src/engine/plans'
import refJson from './fixtures/plans_ref.json'

interface SpaceJson {
  sites: string[]
  options: string[][]
  q: number[][]
  c: number[][]
  construction: number[][] | null
  rules: Rule[]
}
interface TableJson {
  digits: string[]
  planNo: (number | string)[]
  output: number[]
  cost: number[]
  construction: number[] | null
  ceOnly: boolean
  nValid: number | string
  noAction: number | null
  keys: string[]
  labels: string[]
  labelsAlts: string[]
  labelsBare: string[]
  probe: [string, number | null][]
}
const ref = refJson as unknown as {
  spaces: { space: SpaceJson, size: number | string, count: number | string, table: TableJson }[]
  merges: { space: SpaceJson, limit: number | null, table: TableJson }[]
  bigMerge: { space: SpaceJson, limit: null, table: TableJson }
  refusal: string
}

function spaceOf(j: SpaceJson): PlanSpace {
  const values = new Map(j.sites.map((s, k) => [s, new Map(j.options[k].map((a, i) =>
    [a, [j.q[k][i], j.c[k][i]] as const]))]))
  const extra = j.construction
    ? new Map([['construction', new Map(j.sites.map((s, k) => [s, new Map(j.options[k].map((a, i) =>
      [a, j.construction![k][i]]))]))]])
    : null
  return makeSpace(j.sites, j.options, values, extra, j.rules)
}

/** What a table holds, as the golden writes it. */
function tableAsJson(t: PlanTable, probe: string[]): TableJson {
  const n = tableLength(t)
  const rows = Array.from({ length: n }, (_, i) => i)
  return {
    digits: rows.map((i) => Array.from(digitsOf(t, i)).join('')),
    planNo: Array.from(t.plan_no as ArrayLike<number | bigint>, (v) =>
      (typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v)),
    output: Array.from(t.output),
    cost: Array.from(t.cost),
    construction: t.extra.has('construction') ? Array.from(t.extra.get('construction')!) : null,
    ceOnly: t.ce_only,
    nValid: t.n_valid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t.n_valid) : t.n_valid.toString(),
    noAction: noActionIndex(t),
    keys: rows.map((i) => tableKey(t, i)),
    labels: rows.slice(0, 40).map((i) => planLabel(t.space, digitsOf(t, i))),
    labelsAlts: rows.slice(0, 10).map((i) => planLabel(t.space, digitsOf(t, i), { withAlts: true })),
    labelsBare: rows.slice(0, 10).map((i) =>
      planLabel(t.space, digitsOf(t, i), { withAlts: false, noAction: 'FWOP' })),
    probe: probe.map((k) => [k, indexOfKey(t, k)]),
  }
}

const bigText = (v: bigint): number | string =>
  (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString())

describe('watershed plans against the Python engine', () => {
  it(`enumerates ${ref.spaces.length} spaces, rules included, as Python does`, () => {
    for (const k of ref.spaces) {
      const sp = spaceOf(k.space)
      expect(bigText(spaceSize(sp))).toBe(k.size)
      expect(bigText(planCount(sp))).toBe(k.count)
      expect(tableAsJson(enumeratePlans(sp), k.table.probe.map(([key]) => key))).toEqual(k.table)
    }
  })

  it(`merges ${ref.merges.length} rule-free spaces as Python does`, () => {
    for (const k of ref.merges) {
      const sp = spaceOf(k.space)
      const t = k.limit === null ? paretoMerge(sp) : enumeratePlans(sp, k.limit)
      expect(tableAsJson(t, [])).toEqual(k.table)
    }
  })

  it('merges a space past 2**53 combinations, plan numbers exact', () => {
    const t = paretoMerge(spaceOf(ref.bigMerge.space))
    expect(tableAsJson(t, [])).toEqual(ref.bigMerge.table)
  })

  it('refuses rules on a space too large to enumerate, in Python\'s words', () => {
    const values = new Map(['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map((s) =>
      [s, new Map(['a', 'b', 'c'].map((a) => [a, [1, 1] as const]))]))
    const sp = makeSpace([...values.keys()], Array(6).fill(['a', 'b', 'c']), values, null,
      [{ kind: 'DEPENDS_ON', site_id: 'S0', with_sites: ['S1'] }])
    expect(() => enumeratePlans(sp, 100)).toThrow(ref.refusal)
  })
})

// --- tests/test_plans.py -----------------------------------------------------------------------

/** A space of sites S0, S1, ... with made-up values (tests/test_plans.py's space_of). */
function spaceFrom(options: string[][], rules: Rule[] = [], seed = 0): PlanSpace {
  const sites = options.map((_, j) => `S${j}`)
  let s = seed + 1
  const next = (lo: number, hi: number) => {
    s = (s * 1103515245 + 12345) % 2147483648
    return lo + (s % (hi - lo))
  }
  const values = new Map(sites.map((sid, j) => [sid, new Map(options[j].map((a) =>
    [a, [next(1, 50), next(100, 5000)] as const]))]))
  return makeSpace(sites, options, values, null, rules)
}

function bruteForceOk(sites: string[], digits: number[], rules: Rule[]): boolean {
  const present = new Map(sites.map((s, j) => [s, digits[j] > 0]))
  const has = (s: string) => present.get(s) ?? false
  for (const r of rules) {
    if (r.kind === 'NOT_COMBINABLE' && has(r.site_id) && r.with_sites.every(has)) return false
  }
  const bySite = new Map<string, Rule[]>()
  for (const r of rules) {
    if (r.kind === 'DEPENDS_ON') bySite.set(r.site_id, [...(bySite.get(r.site_id) ?? []), r])
  }
  for (const [s, rs] of bySite) {
    if (has(s) && !rs.some((r) => r.with_sites.every(has))) return false
  }
  return true
}

function* product(radices: number[]): Generator<number[]> {
  if (!radices.length) {
    yield []
    return
  }
  for (const head of Array.from({ length: radices[0] }, (_, i) => i)) {
    for (const rest of product(radices.slice(1))) yield [head, ...rest]
  }
}

describe('tests/test_plans.py', () => {
  it('binary numbering is Utoy\'s', () => {
    const t = enumeratePlans(spaceFrom(Array(7).fill(['A'])))
    expect(tableLength(t)).toBe(128)
    for (let i = 0; i < 128; i++) {
      const bits = Array.from(digitsOf(t, i))
      expect(t.plan_no[i]).toBe(1 + bits.reduce((sum, b, j) => sum + b * 2 ** (6 - j), 0))
    }
  })

  it('mixed radix numbering', () => {
    const sp = spaceFrom([['a', 'b'], ['c'], ['d', 'e', 'f']])
    const t = enumeratePlans(sp)
    expect(tableLength(t)).toBe(3 * 2 * 4)
    for (let i = 0; i < tableLength(t); i++) {
      const [d0, d1, d2] = Array.from(digitsOf(t, i))
      expect(t.plan_no[i]).toBe(1 + d0 * 8 + d1 * 4 + d2)
    }
    expect(planLabel(sp, [0, 0, 0])).toBe('No Action')
    expect(planLabel(sp, [2, 1, 0])).toBe('S0 (b) + S1 (c)')
  })

  it('rules match a brute force, and the count', () => {
    const ruleSets = fc.integer({ min: 2, max: 5 }).chain((n) => {
      const sites = Array.from({ length: n }, (_, j) => `S${j}`)
      const rule = fc.constantFrom(...sites).chain((x) => fc.record({
        kind: fc.constantFrom('NOT_COMBINABLE' as const, 'DEPENDS_ON' as const),
        site_id: fc.constant(x),
        with_sites: fc.uniqueArray(fc.constantFrom(...sites.filter((s) => s !== x)),
          { minLength: 1, maxLength: n - 1 }),
      }))
      return fc.tuple(fc.constant(sites), fc.array(rule, { maxLength: 4 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: n, maxLength: n }))
    })
    fc.assert(fc.property(ruleSets, ([sites, rules, rad]) => {
      const options = rad.map((r) => Array.from({ length: r }, (_, k) => `a${k}`))
      const sp = spaceFrom(options, rules)
      const t = enumeratePlans(sp)
      const expected = [...product(rad.map((r) => r + 1))].filter((d) => bruteForceOk(sites, d, rules))
      const got = Array.from({ length: tableLength(t) }, (_, i) => Array.from(digitsOf(t, i)).join(','))
      expect(got.sort()).toEqual(expected.map((d) => d.join(',')).sort())
      expect(planCount(sp)).toBe(BigInt(expected.length))
      expect(t.n_valid).toBe(BigInt(expected.length))
    }), { numRuns: 150 })
  })

  it('the Pareto merge finds the same cost-effective plans', () => {
    const ceKeys = (t: PlanTable) => {
      const res = runCeica(planPoints(tableIds(t), t.cost, t.output, noActionIndex(t)))
      return [flatNonzero(res.ce).map((i) => tableKey(t, i)).sort(),
        flatNonzero(res.bb).map((i) => tableKey(t, i)).sort()]
    }
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })),
        { minLength: 24, maxLength: 24 }), (rad, grid) => {
        const sites = rad.map((_, j) => `S${j}`)
        const options = rad.map((r) => Array.from({ length: r }, (_, k) => `a${k}`))
        // small grids make ties and duplicates common
        let g = 0
        const values = new Map(sites.map((s, j) => [s, new Map(options[j].map((a) =>
          [a, grid[g++ % grid.length]] as const))]))
        const sp = makeSpace(sites, options, values)
        const merged = paretoMerge(sp)
        expect(ceKeys(merged)).toEqual(ceKeys(enumeratePlans(sp)))
        expect(merged.ce_only).toBe(true)
        expect(noActionIndex(merged)).not.toBeNull()
      }), { numRuns: 80 })
  })

  it('enumeration falls back to the merge above the limit', () => {
    const t = enumeratePlans(spaceFrom(Array(6).fill(['a', 'b', 'c'])), 100)
    expect(t.ce_only).toBe(true)
    expect(t.n_valid).toBe(4n ** 6n)
    expect(() => enumeratePlans(spaceFrom(Array(6).fill(['a', 'b', 'c']),
      [{ kind: 'DEPENDS_ON', site_id: 'S0', with_sites: ['S1'] }]), 100)).toThrow(RangeError)
  })
})
