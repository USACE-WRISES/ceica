// The engine against IWR Planning Suite II's rules (CONTRIBUTING.md rule 1). A reference written to
// IWR Planning Suite II's CE/ICA rules (oracles/iwr_ceica.ts) must give the answers ceica_ref.json
// records, and fast-check draws tie-heavy plan sets, large magnitudes and negative values on which
// every displayed status (0 non-cost-effective, 1 cost-effective, 2 best buy) must match the
// reference's.
//
// The reference is kept outside this repository; without it these tests skip.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pointsFromValues } from '../src/engine/cea'
import { flatNonzero, runCeica } from '../src/engine/ica'
import type { CeicaCase } from './ceica.test'
import { type Dec, decParse, decScaled, eq } from './decimal'
import refJson from './fixtures/ceica_ref.json'
import { codes } from './helpers'

interface IwrOracle {
  iwrCodes(costs: readonly Dec[], outputs: readonly Dec[], naIndex: number | null): number[]
  /** the increments between consecutive best buys: [index, added cost, added output, cost per unit] */
  increments(costs: readonly Dec[], outputs: readonly Dec[],
    indices: readonly number[]): [number, Dec, Dec, Dec][]
}
// looked for when the tests run, not when this file is transformed: Vitest keeps transformed files in
// a cache, which would otherwise remember whether the reference was there
const REFERENCE = fileURLToPath(new URL('./oracles/iwr_ceica.ts', import.meta.url))
const iwr: IwrOracle | undefined = existsSync(REFERENCE)
  ? (await import(/* @vite-ignore */ REFERENCE)) as IwrOracle
  : undefined
const ref = refJson as unknown as { oracle: boolean, cases: CeicaCase[] }

function engineVsOracle(oracle: IwrOracle, costs: number[], outputs: number[], na: number | null) {
  const pts = pointsFromValues(costs.map((_, i) => `P${i}`), costs, outputs, na)
  const res = runCeica(pts)
  const dc = Array.from(pts.cost, (v) => decScaled(v, 2))
  const dq = Array.from(pts.output, (v) => decScaled(v, 3))
  expect(codes(res)).toEqual(oracle.iwrCodes(dc, dq, na))
  // the increments over the best buys agree with the reference's
  const rows = oracle.increments(dc, dq, flatNonzero(res.bb))
  res.bb_increments.forEach((row, k) => {
    const [i, dcost, dout, per] = rows[k]
    expect(row.index).toBe(i)
    expect(Math.abs(row.inc_cost - dcost.toNumber())).toBeLessThanOrEqual(1e-9)
    expect(Math.abs(row.inc_output - dout.toNumber())).toBeLessThanOrEqual(1e-12)
    expect(Math.abs(row.inc_cost_per_unit - per.toNumber()))
      .toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(per.toNumber())))
  })
}

describe.skipIf(!iwr)('the IWR oracle', () => {
  it.skipIf(!ref.oracle)('the reference gives the answers ceica_ref.json records', () => {
    for (const k of ref.cases) {
      const ids = k.costs.map((_, i) => i)
      const dc = ids.map((i) => decScaled(k.c[i], k.cdp))
      const dq = ids.map((i) => decScaled(k.q[i], k.qdp))
      expect(iwr!.iwrCodes(dc, dq, k.na).join(''), k.name).toBe(k.iwr)
      const rows = iwr!.increments(dc, dq, flatNonzero(Array.from(k.bb, Number)))
      expect(rows.length).toBe(k.iwrInc!.length)
      rows.forEach(([i, a, b, p], r) => {
        const [wi, wa, wb, wp] = k.iwrInc![r]
        expect(i).toBe(wi)
        expect(eq(a, decParse(wa)) && eq(b, decParse(wb)) && eq(p, decParse(wp)),
          `${k.name} row ${r}: ${a} ${b} ${p} against ${wa} ${wb} ${wp}`).toBe(true)
      })
    }
  })

  const small = fc.integer({ min: 0, max: 6 })

  it('matches the engine on tie-heavy sets', () => {
    fc.assert(fc.property(fc.array(fc.tuple(small, small), { minLength: 1, maxLength: 12 }),
      fc.constantFrom(null, 0), fc.boolean(), (pairs, na, naAtOrigin) => {
        const costs = pairs.map(([c]) => c)
        const outputs = pairs.map(([, q]) => q)
        if (na !== null && naAtOrigin) costs[0] = outputs[0] = 0
        engineVsOracle(iwr!, costs, outputs, na)
      }), { numRuns: 600 })
  })

  it('matches the engine on realistic magnitudes', () => {
    const plan = fc.tuple(fc.double({ min: 0, max: 5e6, noNaN: true }),
      fc.double({ min: 0, max: 500, noNaN: true }))
    fc.assert(fc.property(fc.array(plan, { minLength: 1, maxLength: 40 }), (pairs) => {
      engineVsOracle(iwr!, [0, ...pairs.map(([c]) => c)], [0, ...pairs.map(([, q]) => q)], 0)
    }), { numRuns: 200 })
  })

  it('matches the engine with negative values', () => {
    const v = fc.integer({ min: -3, max: 8 })
    fc.assert(fc.property(fc.array(fc.tuple(v, v), { minLength: 2, maxLength: 10 }), (pairs) => {
      engineVsOracle(iwr!, pairs.map(([c]) => c), pairs.map(([, q]) => q), 0)
    }), { numRuns: 200 })
  })
})
