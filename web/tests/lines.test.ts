// Each project's annualized benefit and cost lines, and the STAF lift split by function, against
// the Python engine (projects/*.json, web/parity/make_project_fixtures.py).
import { describe, expect, it } from 'vitest'
import { annualize } from '../src/engine/annualize'
import { loads } from '../src/engine/projectfile'
import { siteFunctionLift } from '../src/engine/stafLift'
import { pairsOf, powerStats, treeDiff } from './helpers'
import { projectGoldens } from './projects'

/** Cost values computed from powers (the capital recovery factor, IDC, present values). */
const powered = (path: string) =>
  /\.(idc|total_pv|annual|incremental)$|\.(recurring_pv|annual_parts)\.\d+\.1$/.test(path)

describe.each(projectGoldens())('$name', ({ input, expected }) => {
  const project = loads(input).project
  const { benefits, costs } = annualize(project)

  it('benefit lines equal Python\'s exactly', () => {
    const got = [...benefits.values()].map((b) => [b.site_id, b.alt_id, {
      series: pairsOf(b.series), aahu_by_module: pairsOf(b.aahu_by_module), aahu: b.aahu,
      lift_by_module: pairsOf(b.lift_by_module), lift: b.lift, missing: b.missing,
    }])
    expect(treeDiff(got, expected.benefits).diffs).toEqual([])
  })

  it('cost lines equal Python\'s (the last bits of a power aside)', () => {
    const got = [...costs.values()].map((c) => [c.site_id, c.alt_id, {
      first_costs: pairsOf(c.first_costs), idc_base: c.idc_base, idc: c.idc,
      recurring_amounts: pairsOf(c.recurring_amounts), recurring_pv: pairsOf(c.recurring_pv),
      total_pv: c.total_pv, annual: c.annual, annual_parts: pairsOf(c.annual_parts),
      overridden: c.overridden, incremental: c.incremental,
    }])
    expect(treeDiff(got, expected.costs, powered).diffs).toEqual([])
  })

  it.skipIf(!expected.stafLift)('the STAF lift splits by function as Python\'s', () => {
    const got = project.sites.flatMap((s) => s.alternatives.map((a) => {
      const fl = siteFunctionLift({ project }, s.id, a.id)
      return [s.id, a.id, fl === null ? null : {
        functions: pairsOf(fl.functions), outcomes: Object.entries(fl.outcomes), total: fl.total,
      }]
    }))
    expect(treeDiff(got, expected.stafLift).diffs).toEqual([])
  })
})

it('reports how many cost values differ in the last bits', () => {
  console.info(`cost lines: ${powerStats.inexact} values from a power are not bit for bit Python's; `
    + `the largest relative gap is ${powerStats.maxRel.toExponential(2)}`)
})
