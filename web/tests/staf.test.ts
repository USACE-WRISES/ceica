// The STAF roll-up against the Python engine (annualize_ref.json), and tests/test_staf.py ported
// (Hypothesis becomes fast-check, with the same example counts). The tests that run the whole
// analysis are in analysis.test.ts.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { annualize, lineKey } from '../src/engine/annualize'
import { stafRollups } from '../src/engine/benefits'
import * as staf from '../src/engine/benefits/staf'
import { alternativeOf, noAction, siteOf, valuesFor } from '../src/engine/model'
import { loads } from '../src/engine/projectfile'
import { siteFunctionLift } from '../src/engine/stafLift'
import refJson from './fixtures/annualize_ref.json'
import { failures } from './helpers'
import { projectGoldens } from './projects'

const ref = refJson as unknown as {
  rollups: [(number | null)[], string, string[] | null, (number | null)[], number | null, number[], number[]][]
  coefficients: [string, string[] | null, [string, number[]][], number[]][]
  bands: [number, string | null, number | null][]
  functionBands: [number, string | null][]
}

describe('the STAF roll-up against the Python engine', () => {
  const ids = staf.functionIds()

  it('sub-indices, ECI, weighted sums and maxima, exactly', () => {
    expect(failures(ref.rollups, ([scores, variant, assessed, subs, eci, weighted, max]) => {
      const r = staf.rollup(new Map(ids.map((f, i) => [f, scores[i]])), variant, assessed)
      return JSON.stringify([staf.OUTCOMES.map((o) => r.sub_indices[o]), r.eci,
        staf.OUTCOMES.map((o) => r.weighted[o]), staf.OUTCOMES.map((o) => r.max[o])])
        === JSON.stringify([subs, eci, weighted, max])
    })).toEqual([])
  })

  it('coefficients and outcome maxima, exactly', () => {
    for (const [variant, assessed, rows, max] of ref.coefficients) {
      const c = staf.coefficients(variant, assessed)
      expect([...c].map(([f, v]) => [f, staf.OUTCOMES.map((o) => v[o])])).toEqual(rows)
      const mx = staf.outcomeMax(variant, assessed)
      expect(staf.OUTCOMES.map((o) => mx[o])).toEqual(max)
    }
  })

  it('bands and display rounding', () => {
    expect(failures(ref.bands, ([x, band, r2]) => staf.band(x) === band && staf.round2(x) === r2)).toEqual([])
    expect(failures(ref.functionBands, ([x, band]) => staf.functionBand(x) === band)).toEqual([])
  })
})

// --- tests/test_staf.py --------------------------------------------------------------------------

// SFARI's worked example (staf/apps/sfari/tests/test_scoring.py, from the SFARI technical report).
const SFARI_EXAMPLE: Record<string, number> = {
  'catchment-hydrology': 8, 'surface-water-storage': 15, 'reach-inflow': 7,
  'streamflow-regime': 12, 'low-flow-baseflow-dynamics': 4, 'high-flow-dynamics': 11,
  'floodplain-connectivity': 9, 'hyporheic-connectivity': 13, 'channel-evolution': 5,
  'channel-floodplain-dynamics': 10, 'sediment-continuity': 6,
  'bed-composition-bedform-dynamics': 5, 'light-thermal-regime': 12, 'carbon-processing': 13,
  'nutrient-cycling': 13, 'water-soil-quality': 10, 'habitat-provision': 2,
  'population-support': 3, 'community-dynamics': 4, 'watershed-connectivity': 1,
}
const example = () => new Map<string, number | null>(Object.entries(SFARI_EXAMPLE))

describe('tests/test_staf.py', () => {
  it('twenty functions in five categories', () => {
    const fs = staf.functions()
    expect(fs.length).toBe(20)
    expect([...new Set(fs.map((f) => f.category))]).toEqual([...staf.CATEGORIES])
  })

  it('SFARI\'s worked example, mapping B', () => {
    const r = staf.rollup(example(), 'B')
    expect(staf.OUTCOMES.map((o) => staf.round2(r.sub_indices[o]))).toEqual([0.55, 0.70, 0.30])
    expect(staf.round2(r.eci)).toBe(0.52)
    expect(r.max).toEqual({ physical: 160.5, chemical: 67.5, biological: 82.5 })
  })

  it('SFARI\'s worked example, mapping A', () => {
    const r = staf.rollup(example(), 'A')
    expect(staf.OUTCOMES.map((o) => staf.round2(r.sub_indices[o]))).toEqual([0.58, 0.73, 0.30])
    expect(staf.round2(r.eci)).toBe(0.54)
    expect(r.max).toEqual({ physical: 187.5, chemical: 81.0, biological: 84.0 })
  })

  it.each([[13, 0.87], [8, 0.53], [3, 0.20], [15, 1.0], [0, 0.0]])('uniform scores of %s', (score, eci) => {
    const r = staf.rollup(new Map(staf.functionIds().map((f) => [f, score])), 'A')
    expect(staf.round2(r.eci)).toBe(eci)
  })

  it('a missing score, and a function not assessed', () => {
    const scores = example()
    scores.delete('reach-inflow')
    expect(staf.rollup(scores, 'A').eci).toBeNull()
    const assessed = staf.functionIds().filter((f) => f !== 'reach-inflow')
    const r = staf.rollup(scores, 'A', assessed)
    expect(r.eci).not.toBeNull()
    expect(Math.abs(r.max.physical - (187.5 - 15))).toBeLessThanOrEqual(1e-12)
  })

  it('the ECI is linear in the scores', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 15, noNaN: true }), { minLength: 20, maxLength: 20 }),
      fc.constantFrom('A', 'B'), (values, variant) => {
        const scores = new Map(staf.functionIds().map((f, i) => [f, values[i]]))
        const coef = staf.coefficients(variant)
        let lin = 0
        let unit = 0
        for (const [f, c] of coef) {
          const t = staf.OUTCOMES.reduce((s, o) => s + c[o], 0)
          lin += t * scores.get(f)!
          unit += 15 * t
        }
        expect(Math.abs(lin - staf.rollup(scores, variant).eci!)).toBeLessThanOrEqual(1e-12)
        expect(Math.abs(unit - 1.0)).toBeLessThanOrEqual(1e-9)
      }), { numRuns: 100 })
  })

  it('bands', () => {
    expect(staf.band(0.39)).toBe('Non-Functioning')
    expect(staf.band(0.394)).toBe('Non-Functioning')
    expect(staf.band(0.40)).toBe('Functioning-at-Risk')
    expect(staf.band(0.70)).toBe('Functioning')
    expect(staf.functionBand(5)).toBe('Non-Functioning')
    expect(staf.functionBand(10.5)).toBe('Functioning')
  })

  const demo = projectGoldens().find((g) => g.name === 'staf-demo')!

  it('the STAF demonstration\'s existing condition is the SFARI example', () => {
    const p = loads(demo.input).project
    const site = siteOf(p, 'R1')!
    const year0 = stafRollups(p, site, noAction(site)!, 'condition')[0]
    expect(staf.round2(year0.eci)).toBe(0.54)  // mapping A
    expect(staf.round2(staf.rollup(example(), 'B').eci)).toBe(0.52)
    const scores = valuesFor(noAction(site)!, 'condition')!.scores
    expect(Object.fromEntries([...scores].map(([f, v]) => [f, v[0]]))).toEqual(SFARI_EXAMPLE)
  })

  it('the STAF demonstration\'s lift splits exactly', () => {
    const project = loads(demo.input).project
    const { benefits } = annualize(project)
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.abs(b)
    for (const s of project.sites) {
      for (const a of s.alternatives) {
        if (a.is_no_action) continue
        const fl = siteFunctionLift({ project }, s.id, a.id)!
        const lift = benefits.get(lineKey(s.id, a.id))!.lift!
        expect(near(fl.total, lift)).toBe(true)
        expect(near(staf.OUTCOMES.reduce((t, o) => t + fl.outcomes[o], 0), lift)).toBe(true)
        expect(near([...fl.functions.values()].reduce((t, v) => t + v, 0), lift)).toBe(true)
      }
    }
    expect(alternativeOf(siteOf(project, 'R3')!, 'A1')).not.toBeNull()
    expect(siteFunctionLift({ project }, 'R3', 'A1')!.functions.has('watershed-connectivity')).toBe(false)
  })
})
