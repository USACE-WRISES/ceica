// Cost-effectiveness and best buys: tests/test_ceica_core.py, ported (the IWR oracle's property
// tests are in oracle.test.ts). Hypothesis becomes fast-check, with the same example counts.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { dominance, iwrBase, planPoints, pointsFromValues } from '../src/engine/cea'
import { flatNonzero, incrementalSeries, nBb, nCe, nCeOnly, runCeica } from '../src/engine/ica'
import { quantize } from '../src/engine/numeric'
import { codes } from './helpers'
import { cefinder } from './oracles/ecorest_ceica'

function ptsFrom(costs: number[], outputs: number[], na: number | null = 0, ids?: string[]) {
  return pointsFromValues(ids ?? costs.map((_, i) => `P${i + 1}`), costs, outputs, na)
}

describe('worked examples', () => {
  it('the ecorest documentation example', () => {
    // restben = c(0,10,5,20,20), restcost = c(0,100,100,200,150)
    const res = runCeica(ptsFrom([0, 100, 100, 200, 150], [0, 10, 5, 20, 20]))
    expect(codes(res)).toEqual([2, 1, 0, 0, 2])
    expect(res.bb_increments.map((r) => r.plan_id)).toEqual(['P1', 'P5'])
    expect(res.bb_increments[1].inc_cost_per_unit).toBe(7.5)
    expect(cefinder([0, 10, 5, 20, 20], [0, 100, 100, 200, 150])).toEqual([1, 1, 0, 0, 1])
  })

  it('collinear plans are all best buys', () => {
    const res = runCeica(ptsFrom([0, 100, 200, 400], [0, 10, 20, 30]))
    expect(codes(res)).toEqual([2, 2, 2, 2])
    expect(res.bb_increments.map((r) => r.inc_cost_per_unit)).toEqual([0, 10, 10, 20])
  })

  it('duplicates are both cost-effective and best buys', () => {
    const res = runCeica(ptsFrom([0, 100, 100, 300], [0, 10, 10, 20]))
    expect(codes(res)).toEqual([2, 2, 2, 2])
    // ecorest differs here: identical plans knock each other out
    expect(cefinder([0, 10, 10, 20], [0, 100, 100, 300])).toEqual([1, 0, 0, 1])
  })

  it('a duplicate of No Action is cost-effective, not a best buy', () => {
    expect(codes(runCeica(ptsFrom([0, 0, 100], [0, 0, 10])))).toEqual([2, 1, 2])
  })

  it('No Action beaten on its own output moves the base to the origin', () => {
    // Absolute basis: No Action costs 50 for output 0, plan 2 costs 10 for the same output.
    const pts = ptsFrom([50, 10, 110], [0, 0, 10])
    expect(iwrBase(pts)).toEqual({ cost: 0, output: 0, uses_no_action: false })
    const res = runCeica(pts)
    expect(codes(res)).toEqual([2, 1, 2])
    expect(res.ce_raw[0]).toBe(0)
  })

  it('names who beats a plan, and how', () => {
    const { ce, witness, reason } = dominance(ptsFrom([0, 100, 100, 200, 150], [0, 10, 5, 20, 20]))
    expect(Array.from(ce)).toEqual([1, 1, 0, 0, 1])
    expect([witness[2], reason[2]]).toEqual([1, 2])  // more output for no more cost
    expect([witness[3], reason[3]]).toEqual([4, 1])  // same output for less
  })

  it('a single plan, and an empty set', () => {
    expect(codes(runCeica(ptsFrom([0], [0])))).toEqual([2])
    const empty = runCeica(pointsFromValues([], [], [], null))
    expect(empty.points.ids.length).toBe(0)
    expect(empty.walk).toEqual([])
  })

  it('increments follow output and start at the origin', () => {
    const rows = incrementalSeries(ptsFrom([300, 0, 100], [30, 0, 10]), [0, 1, 2])
    expect(rows.map((r) => r.plan_id)).toEqual(['P2', 'P3', 'P1'])
    expect(rows.map((r) => r.inc_cost_per_unit)).toEqual([0, 10, 10])
    expect(rows[0].prev_plan_id).toBeNull()
    expect(rows[2].prev_plan_id).toBe('P3')
  })
})

describe('Utoy Creek watershed', () => {
  const lift = [6.752, 14.559, 15.017, 31.379, 24.493, 4.805, 19.933].map((x) => quantize(x, 3))
  const cost = [55100.40, 71762.03, 68167.40, 46343.21, 40055.44, 36045.07, 50452.94].map((x) => quantize(x, 2))

  it('has the cost-effective plans and best buys of the published report', () => {
    const n = lift.length
    const ids: string[] = []
    const q = new Float64Array(2 ** n)
    const c = new Float64Array(2 ** n)
    for (let k = 0; k < 2 ** n; k++) {
      ids.push(`P${k + 1}`)
      for (let j = 0; j < n; j++) {
        if ((k >> (n - 1 - j)) & 1) {
          q[k] += lift[j]
          c[k] += cost[j]
        }
      }
    }
    const res = runCeica(planPoints(ids, c, q, 0))
    expect(flatNonzero(res.ce).map((i) => res.points.ids[i])).toEqual(['P1', 'P3', 'P5', 'P9',
      'P11', 'P13', 'P14', 'P15', 'P16', 'P30', 'P32', 'P62', 'P64', 'P78', 'P94', 'P126', 'P128'])
    expect(res.bb_increments.map((r) => r.plan_id)).toEqual(['P1', 'P9', 'P13', 'P14', 'P30', 'P62',
      'P64', 'P128'])
    expect([nCe(res), nBb(res), nCeOnly(res)]).toEqual([17, 8, 9])
    // site costs here carry illustrative cents, so allow $1 (utoy.test.ts is exact)
    const inc = res.bb_increments.slice(1).map((r) => r.inc_cost_per_unit)
    const want = [1477, 1635, 2531, 4539, 4929, 7502, 8160]
    inc.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(1))
  })
})

describe('properties', () => {
  const small = fc.integer({ min: 0, max: 6 })

  it('the cost-effective set is the Pareto set', () => {
    fc.assert(fc.property(fc.array(fc.tuple(small, small), { minLength: 1, maxLength: 14 }), (pairs) => {
      const pts = ptsFrom(pairs.map(([c]) => c), pairs.map(([, q]) => q), null)
      const { ce } = dominance(pts)
      const q = pts.output
      const c = pts.cost
      for (let i = 0; i < q.length; i++) {
        let dominated = false
        for (let j = 0; j < q.length; j++) {
          if ((q[j] === q[i] && c[j] < c[i]) || (q[j] > q[i] && c[j] <= c[i])) dominated = true
        }
        expect(ce[i] === 1).toBe(!dominated)
      }
    }), { numRuns: 300 })
  })

  it('best-buy invariants', () => {
    const plan = fc.tuple(fc.double({ min: 0, max: 1e6, noNaN: true }),
      fc.double({ min: 0.001, max: 300, noNaN: true }))
    fc.assert(fc.property(fc.array(plan, { minLength: 1, maxLength: 30 }), (pairs) => {
      const res = runCeica(ptsFrom([0, ...pairs.map(([c]) => c)], [0, ...pairs.map(([, q]) => q)]))
      for (let i = 0; i < res.bb.length; i++) expect(res.bb[i] <= res.ce[i]).toBe(true)
      expect(res.bb[0]).toBe(1)
      // the largest-output cost-effective plan above the base is a best buy
      const q = res.points.output
      let top = -1
      for (let i = 0; i < q.length; i++) {
        if (res.ce_raw[i] && q[i] > res.base.output && (top < 0 || q[i] > q[top])) top = i
      }
      if (top >= 0) expect(res.bb[top]).toBe(1)
      // incremental cost per unit never decreases along distinct best-buy points
      const per = res.bb_increments.filter((r) => r.inc_output !== 0).map((r) => r.inc_cost_per_unit)
      for (let k = 2; k < per.length; k++) {
        expect(per[k] >= per[k - 1] - 1e-9 * Math.max(1, Math.abs(per[k - 1]))).toBe(true)
      }
    }), { numRuns: 300 })
  })
})
