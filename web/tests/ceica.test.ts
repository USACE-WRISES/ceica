// Cost-effectiveness and best buys against the Python engine (ceica_ref.json, made by
// web/parity/make_ceica_fixtures.py), and the ecorest oracle on its cases.
import { describe, expect, it } from 'vitest'
import { dominance, iwrBase, pointsFromValues } from '../src/engine/cea'
import { bestBuys, runCeica } from '../src/engine/ica'
import refJson from './fixtures/ceica_ref.json'
import { bbfinder, cefinder } from './oracles/ecorest_ceica'

type IncRow = [number, number, number, number, number, number, number, string | null]
export interface CeicaCase {
  name: string
  costs: number[]
  outputs: number[]
  na: number | null
  cdp: number
  qdp: number
  c: number[]
  q: number[]
  ceRaw: string
  witness: number[]
  reason: string
  base: [number, number, boolean]
  bbRaw: string
  walk: number[]
  ce: string
  bb: string
  inc: IncRow[]
  iwr?: string
  iwrInc?: [number, string, string, string][]
}
interface EcorestCase {
  b: number[]
  c: number[]
  ce: string
  bb: string
  ecoCe: string
  ecoBb: string
  ecoTable: number[][]
}
const ref = refJson as unknown as { cases: CeicaCase[], ecorest: EcorestCase[] }

const bits = (mask: ArrayLike<number>): string => Array.from(mask, (v) => (v ? '1' : '0')).join('')

/** Every field of one case that differs from the golden, by name. */
function differences(k: CeicaCase): string[] {
  const ids = k.costs.map((_, i) => `P${i}`)
  const pts = pointsFromValues(ids, k.costs, k.outputs, k.na, { costDp: k.cdp, outputDp: k.qdp })
  const d = dominance(pts)
  const base = iwrBase(pts)
  const raw = bestBuys(pts, d.ce, base)
  const res = runCeica(pts)
  const got: Record<string, unknown> = {
    c: Array.from(pts.cost), q: Array.from(pts.output), ceRaw: bits(d.ce),
    witness: Array.from(d.witness), reason: Array.from(d.reason).join(''),
    base: [base.cost, base.output, base.uses_no_action], bbRaw: bits(raw.bb), walk: raw.walk,
    ce: bits(res.ce), bb: bits(res.bb),
    inc: res.bb_increments.map((r) => [r.index, r.cost, r.output, r.avg_cost, r.inc_cost,
      r.inc_output, r.inc_cost_per_unit, r.prev_plan_id]),
  }
  const want = k as unknown as Record<string, unknown>
  return Object.keys(got).filter((f) => JSON.stringify(got[f]) !== JSON.stringify(want[f]))
}

describe('CE/ICA against the Python engine', () => {
  it(`every case equals Python's, increments to the last bit (${ref.cases.length} cases)`, () => {
    const bad: string[] = []
    ref.cases.forEach((k, n) => {
      const diff = differences(k)
      if (diff.length) bad.push(`case ${n} (${k.name}): ${diff.join(', ')}`)
    })
    expect(bad.slice(0, 10)).toEqual([])
  })
})

describe('ecorest (its literal port) on tests/test_ceica_core.py\'s cases', () => {
  it('the port gives the Python port\'s flags and table', () => {
    for (const k of ref.ecorest) {
      const ce = cefinder(k.b, k.c)
      const [bb, table] = bbfinder(k.b, k.c, ce)
      expect(bits(ce)).toBe(k.ecoCe)
      expect(bits(bb)).toBe(k.ecoBb)
      expect(table).toEqual(k.ecoTable)
    }
  })

  it('agrees with the engine when no plans tie', () => {
    for (const k of ref.ecorest) {
      const res = runCeica(pointsFromValues(k.c.map((_, i) => `P${i + 1}`), k.c, k.b, 0))
      expect(bits(res.ce)).toBe(k.ce)
      expect(bits(res.bb)).toBe(k.bb)
      expect(k.ecoCe).toBe(k.ce)
      expect(k.ecoBb).toBe(k.bb)
    }
  })
})
