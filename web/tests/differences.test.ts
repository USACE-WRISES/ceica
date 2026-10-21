// The differences from the Python engine that are by design (web/README.md). No golden covers them:
// the Python engine gives other answers here, on purpose.
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { parseProject } from '../src/engine/model'
import { makeSpace, paretoMerge } from '../src/engine/plans'
import { crPow } from '../src/py/pynum'

/** A project of fully annualized sites: [name, annual cost of A1] per site. */
function annualProject(sites: [string, number][], costDecimals: number) {
  return parseProject({
    settings: { cost_decimals: costDecimals },
    benefits: { modules: [{ id: 'total', name: 'Total', method: 'AAHU' }] },
    sites: sites.map(([id, cost]) => ({ id, alternatives: [
      { id: 'NA', is_no_action: true, outputs: [{ module_id: 'total', aahu: 0.0 }], costs: { annual_override: 0.0 } },
      { id: 'A1', outputs: [{ module_id: 'total', aahu: 10.0 }], costs: { annual_override: cost } },
    ] })),
  })
}

describe('differences by design', () => {
  it('a value past 2**52 scaled units stops its site, in words (Python\'s int64 goes on)', () => {
    const res = analyze(annualProject([['S1', 1e10]], 6))
    expect(res.sites.get('S1')!.ready).toBe(false)
    const issue = res.issues.find((i) => i.code === 'E_INCOMPLETE')!
    expect(issue.message).toBe('Site S1 has a cost or output too large for CEICA to hold exactly at these '
      + 'decimals; use fewer decimals in the study settings.')
  })

  it('watershed sums past 2**52 stop the watershed, in words', () => {
    const res = analyze(annualProject([['S1', 3e9], ['S2', 3e9]], 6))
    expect(res.sites.get('S1')!.ready && res.sites.get('S2')!.ready).toBe(true)
    expect(res.watershed.ready).toBe(false)
    expect(res.watershed.reasons).toEqual(['The watershed plans add up to costs or outputs too large for '
      + 'CEICA to hold exactly at these decimals; use fewer decimals in the study settings.'])
  })

  it('plan numbers past 2**63 combinations stay exact (Python\'s int64 wraps)', () => {
    const sites = Array.from({ length: 40 }, (_, j) => `S${j}`)
    const opts = ['A1', 'A2', 'A3']
    // varied values, as real sites have (equal ones would keep every tie as a candidate)
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const values = new Map(sites.map((s) => [s, new Map(opts.map((a, k) =>
      [a, [1000 + 400 * k + rand(400), 20000 + 30000 * k + rand(30000)] as const]))]))
    const t = paretoMerge(makeSpace(sites, sites.map(() => opts), values))
    // the plan of every site's third alternative has the most output, so it is a candidate
    expect((t.plan_no as readonly bigint[]).includes(4n ** 40n)).toBe(true)
  })

  it('powers are correctly rounded, where the C library may be a unit off', () => {
    // Python's (1.06329) ** 0.5 is 1.0311595414871553; the square root is 1.031159541487155...
    expect(crPow(1.06329, 0.5)).toBe(1.031159541487155)
    expect(crPow(1.06329, 0.5)).toBe(Math.sqrt(1.06329))
  })
})
