// Annualization against the Python engine (annualize_ref.json), and tests/test_annualize.py ported
// (Hypothesis becomes fast-check, with the same example counts).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  crf, idcSchedule, idcUniform, iwrYearlyValues, pvFactor, recurringOccurrences, recurringPv, timeAverage,
} from '../src/engine/annualize'
import refJson from './fixtures/annualize_ref.json'
import { failures, nearPower, powerStats } from './helpers'

const ref = refJson as unknown as {
  crf: [number, number, number][]
  pv: [number, number, string, number][]
  idc: [number, number, number, number, string, number][]
  schedules: [number[], number, number, string, number][]
  occurrences: [number, number, number | null, number | null, number[]][]
  recurring: [number, number, number, number, number | null, number | null, string, number][]
  averages: [number[], number[], string, number | null, number][]
  yearly: [number[], number[], number, number[]][]
}


const approx = (got: number, want: number, rel = 1e-9, abs = 1e-12) =>
  Math.abs(got - want) <= Math.max(rel * Math.abs(want), abs)

describe('annualization against the Python engine', () => {
  it('capital recovery factors', () => {
    expect(failures(ref.crf, ([r, n, want]) => nearPower(crf(r, n), want))).toEqual([])
  })
  it('present value factors, both timings', () => {
    expect(failures(ref.pv, ([r, t, timing, want]) => nearPower(pvFactor(r, t, timing), want))).toEqual([])
  })
  it('interest during construction, every convention', () => {
    expect(failures(ref.idc, ([p, m, r, ppy, method, want]) =>
      nearPower(idcUniform(p, m, r, { periodsPerYear: ppy, method }), want))).toEqual([])
  })
  it('interest during construction on a schedule', () => {
    expect(failures(ref.schedules, ([costs, r, ppy, method, want]) =>
      nearPower(idcSchedule(costs, r, { periodsPerYear: ppy, method }), want))).toEqual([])
  })
  it('recurring cost years, exactly', () => {
    expect(failures(ref.occurrences, ([every, poa, first, last, want]) =>
      JSON.stringify(recurringOccurrences(every, poa, first, last)) === JSON.stringify(want))).toEqual([])
  })
  it('recurring cost present values', () => {
    expect(failures(ref.recurring, ([a, every, r, poa, first, last, timing, want]) =>
      nearPower(recurringPv(a, every, r, poa, { firstYear: first, lastYear: last, timing }), want))).toEqual([])
  })
  it('time averages, exactly', () => {
    expect(failures(ref.averages, ([years, values, method, poa, want]) =>
      Object.is(timeAverage(years, values, { method, poa }), want))).toEqual([])
  })
  it('IWR yearly values, exactly', () => {
    expect(failures(ref.yearly, ([years, values, poa, want]) =>
      JSON.stringify(iwrYearlyValues(years, values, poa)) === JSON.stringify(want))).toEqual([])
    console.info(`annualization: ${powerStats.inexact} values from a power are not bit for bit `
      + `Python's; the largest relative gap is ${powerStats.maxRel.toExponential(2)}`)
  })
})

// --- tests/test_annualize.py ---------------------------------------------------------------------

describe('tests/test_annualize.py', () => {
  it('crf', () => {
    expect(Math.abs(crf(0.03, 50) - 0.0388654944)).toBeLessThanOrEqual(1e-10)
    expect(approx(crf(0.0, 50), 1 / 50)).toBe(true)
  })

  /** EngrEcon::interest_during_construction (END, monthly compounding at the effective rate). */
  const engreconIdc = (rate: number, months: number, cost: number) => {
    let s = 0
    for (let m = 1; m <= months; m++) s += cost / months * ((1 + rate) ** ((months - m) / 12) - 1)
    return s
  }

  it.each(['END', 'MIDDLE', 'START'])('the IDC closed form equals IWR\'s loop (%s)', (method) => {
    fc.assert(fc.property(fc.double({ min: 1e3, max: 5e6, noNaN: true }), fc.integer({ min: 1, max: 60 }),
      fc.double({ min: 0.001, max: 0.12, noNaN: true }), (p, months, rate) => {
        const uniform = Array(months).fill(p / months)
        expect(approx(idcUniform(p, months, rate, { method }), idcSchedule(uniform, rate, { method }), 1e-11, 1e-8))
          .toBe(true)
      }), { numRuns: 60 })
  })

  it('IDC at the end of each period is EngrEcon\'s', () => {
    expect(approx(idcUniform(776047, 10, 0.03), engreconIdc(0.03, 10, 776047), 1e-12)).toBe(true)
    expect(Math.abs(idcUniform(776047, 10, 0.03) - 8669.62)).toBeLessThanOrEqual(0.005)
    expect(idcUniform(1000, 0, 0.03)).toBe(0)
  })

  it('the IDC conventions in order', () => {
    const end = idcUniform(1e6, 12, 0.05, { method: 'END' })
    const mid = idcUniform(1e6, 12, 0.05, { method: 'MIDDLE' })
    const start = idcUniform(1e6, 12, 0.05, { method: 'START' })
    expect(end < mid && mid < start).toBe(true)
  })

  /** EngrEcon::om_distribute: present value of c at years f, 2f, ... <= n. */
  const omDistribute = (i: number, n: number, f: number, c: number) => {
    let s = 0
    for (let t = f; t <= n; t += f) s += c / (1 + i) ** t
    return s
  }

  it('recurring present values in closed form', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1e5, noNaN: true }), fc.integer({ min: 1, max: 30 }),
      fc.double({ min: 0, max: 0.1, noNaN: true }), fc.integer({ min: 1, max: 100 }), (a, every, rate, poa) => {
        expect(approx(recurringPv(a, every, rate, poa), omDistribute(rate, poa, every, a), 1e-10, 1e-8)).toBe(true)
        const mid = recurringOccurrences(every, poa).reduce((s, t) => s + a * pvFactor(rate, t, 'MID_YEAR'), 0)
        expect(approx(recurringPv(a, every, rate, poa, { timing: 'MID_YEAR' }), mid, 1e-10, 1e-8)).toBe(true)
      }), { numRuns: 100 })
  })

  it('recurring costs\' first and last year', () => {
    expect(recurringOccurrences(5, 50, 3, 20)).toEqual([3, 8, 13, 18])
    expect(recurringOccurrences(25, 50)).toEqual([25, 50])
    expect(recurringOccurrences(10, 5)).toEqual([])
    const mid0 = recurringPv(100, 10, 0.05, 30, { firstYear: 0, timing: 'MID_YEAR' })
    const expect0 = [0, 10, 20, 30].reduce((s, t) => s + 100 * pvFactor(0.05, t, 'MID_YEAR'), 0)
    expect(approx(mid0, expect0)).toBe(true)
  })

  it('the time average matches ecorest\'s annualizer', () => {
    // ecorest example: annualizer(c(0,2,20,50), c(0,100,90,80)) = 87.2
    expect(approx(timeAverage([0, 2, 20, 50], [0, 100, 90, 80]), 87.2)).toBe(true)
    expect(approx(timeAverage([0, 50], [100, 100]), 100.0)).toBe(true)
  })

  it('IWR\'s yearly interpolation rounds the interpolated years', () => {
    const vals = iwrYearlyValues([0, 3, 10], [1.0, 2.0, 4.0], 10)
    expect([vals[0], vals[3], vals[10]]).toEqual([1.0, 2.0, 4.0])
    expect([vals[1], vals[2]]).toEqual([1.33, 1.67])  // rounded to 2 decimals
    const avg = timeAverage([0, 3, 10], [1.0, 2.0, 4.0], { method: 'IWR_YEARLY_2DP', poa: 10 })
    let s = 0
    for (let i = 1; i <= 10; i++) s += (vals[i] + vals[i - 1]) / 2
    expect(approx(avg, s / 10)).toBe(true)
    // close to the exact trapezoid, not identical
    expect(Math.abs(avg - timeAverage([0, 3, 10], [1.0, 2.0, 4.0]))).toBeLessThanOrEqual(0.01)
  })
})
