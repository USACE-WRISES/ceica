// Older project files open in the current schema: tests/test_migration.py, ported.
//
// Schema 1 (a project-wide benefit mode with components) became schema 2 (modules); schema 3
// folds the study's District and Prepared by into the document's Prepared by. The fixtures in
// fixtures/v1 and v2 were saved by CEICA before each change, the v1 ones with their results.
// Opening them must give the same numbers, keep every decision current, and, once their decisions
// are stamped with those results, equal what the example builders now write.
import { describe, expect, it } from 'vitest'
import { analyze, planRow, wsPlans } from '../src/engine/analysis'
import { lineKey } from '../src/engine/annualize'
import { nStale, stampBasis } from '../src/engine/decisions'
import { alternativeOf, notAssessed, siteOf, valuesFor } from '../src/engine/model'
import { contentDigest, FORMAT_VERSION, loads, ProjectFileError } from '../src/engine/projectfile'
import stafExample from './fixtures/examples/staf-demo.ceica?raw'
import utoyExample from './fixtures/examples/utoy-creek.ceica?raw'
import resultsJson from './fixtures/v1/results.json'
import stafV1 from './fixtures/v1/staf-demo.ceica?raw'
import utoyV1 from './fixtures/v1/utoy-creek.ceica?raw'
import utoyV2 from './fixtures/v2/utoy-creek.ceica?raw'

interface V1Results {
  alternatives: Record<string, { aahu: number, lift: number, annual: number, by_module: Record<string, number> }>
  plans: Record<string, [boolean, boolean]>
  final: string[]
  tsp_state: string
}
const RESULTS = resultsJson as unknown as Record<string, V1Results>
const V1: Record<string, string> = { 'utoy-creek': utoyV1, 'staf-demo': stafV1 }
const EXAMPLES: Record<string, string> = { 'utoy-creek': utoyExample, 'staf-demo': stafExample }

const approx = (got: number | null, want: number, rel = 1e-12, abs = 0) =>
  got !== null && Math.abs(got - want) <= Math.max(rel * Math.abs(want), abs)

describe('tests/test_migration.py', () => {
  it.each(['utoy-creek', 'staf-demo'])('v1 files give the same results (%s)', (name) => {
    const loaded = loads(V1[name])
    expect(loaded.warnings).toEqual([])  // the digest is checked against the file as saved
    const res = analyze(loaded.project)
    const want = RESULTS[name]
    for (const [key, v] of Object.entries(want.alternatives)) {
      const [sid, aid] = key.split('|')
      const b = res.benefits.get(lineKey(sid, aid))!
      const c = res.costs.get(lineKey(sid, aid))!
      expect(approx(b.aahu, v.aahu, 1e-12, 1e-12) && approx(b.lift, v.lift, 1e-12, 1e-12)
        && approx(c.annual, v.annual), key).toBe(true)
      for (const [mid, avg] of Object.entries(v.by_module)) {
        if (name === 'staf-demo' && mid !== 'condition') continue
        expect(approx(b.aahu_by_module.get(mid) ?? null, avg, 1e-12, 1e-12), `${key} ${mid}`).toBe(true)
      }
    }
    const ws = res.watershed
    const flags: Record<string, [boolean, boolean]> = {}
    for (let i = 0; i < wsPlans(ws); i++) {
      const r = planRow(ws, i)
      flags[r.key] = [r.ce, r.bb]
    }
    expect(flags).toEqual(want.plans)
    expect(res.decisions.final_keys).toEqual(want.final)
    expect(nStale(res.decisions)).toBe(0)
    expect(res.decisions.tsp_state).toBe(want.tsp_state)
  })

  it.each(['utoy-creek', 'staf-demo'])('a migrated v1 file equals the rebuilt example (%s)', (name) => {
    const old = loads(V1[name]).project
    const now = loads(EXAMPLES[name]).project
    expect(contentDigest(stampBasis(old, analyze(old)))).toBe(contentDigest(now))
  })

  it('migration maps modes to modules', () => {
    const utoy = loads(utoyV1).project
    expect(utoy.benefits.modules.map((m) => [m.id, m.method, m.quantity_units])).toEqual([
      ['RipL', 'INDEX_X_QUANTITY', 'acres'], ['RipR', 'INDEX_X_QUANTITY', 'acres'], ['Ins', 'INDEX_X_QUANTITY', 'acres']])
    const staf = loads(stafV1).project
    expect(staf.benefits.modules.map((m) => [m.id, m.method, m.quantity_units])).toEqual([['condition', 'STAF', 'ft']])
    expect(notAssessed(siteOf(staf, 'R3')!, 'condition')).toEqual(['watershed-connectivity'])
    const annual = { format: 'ceica-project', schemaVersion: 1, project: {
      benefits: { mode: 'AAHU_DIRECT', target_years: [0, 50], components: [{ id: 'total', name: 'Total' }] },
      sites: [{ id: 'A', alternatives: [
        { id: 'FWOP', is_no_action: true, aahu: 0.0 },
        { id: 'A1', aahu: 12.5, benefits: [{ component_id: 'total', values: [1, 2] }] },
      ] }] } }
    const p = loads(JSON.stringify(annual)).project
    expect(p.benefits.modules.length).toBe(1)
    const m = p.benefits.modules[0]
    const a1 = alternativeOf(siteOf(p, 'A')!, 'A1')!
    expect(m.method).toBe('AAHU')
    expect(valuesFor(a1, m.id)!.aahu).toBe(12.5)
    expect(valuesFor(a1, m.id)!.values).toEqual([])  // v1 ignored them too
  })

  it('v2 files open as v3', () => {
    const loaded = loads(utoyV2)
    expect(loaded.warnings).toEqual([])  // the digest is checked against the file as saved
    expect(contentDigest(loaded.project)).toBe(contentDigest(loads(utoyExample).project))
    // the document's Prepared by, then the district that printed in the settings table
    expect(loaded.project.report.prepared_by).toBe('CEICA example, Mobile District')
  })

  const v2 = (project: Record<string, unknown>) => JSON.stringify({ format: 'ceica-project', schemaVersion: 2,
    project: { schema_version: 'ceica-project/2', name: 'Folded', ...project } })

  it.each([
    [{ district: 'Mobile District', prepared_by: 'A. Planner' }, 'A. Planner, Mobile District'],
    [{ district: 'Mobile District', prepared_by: 'A. Planner', report: { prepared_by: 'Team' } }, 'Team, Mobile District'],
    [{ prepared_by: 'Study page', report: { prepared_by: 'Document' } }, 'Document'],
    [{ district: 'Mobile District', report: {} }, 'Mobile District'],
    [{ district: 'mobile district', prepared_by: 'Jane Doe, Mobile District' }, 'Jane Doe, Mobile District'],
    [{ district: '', prepared_by: '', report: { prepared_by: '' } }, ''],
    [{ district: 'Mobile District', report: null }, 'Mobile District'],
  ])('v2 study fields fold into Prepared by (%j)', (project, want) => {
    const p = loads(v2(project)).project
    expect(p.report.prepared_by).toBe(want)
    expect(p.schema_version).toBe('ceica-project/3')
    expect('district' in p).toBe(false)
  })

  it('damaged old files fail with a message', () => {
    const fails = (doc: unknown, words: string) => {
      expect(() => loads(JSON.stringify(doc))).toThrow(ProjectFileError)
      expect(() => loads(JSON.stringify(doc))).toThrow(words)
    }
    fails({ format: 'ceica-project', schemaVersion: 1, project: { benefits: 'oops' } }, 'could not be converted')
    fails({ format: 'ceica-project', schemaVersion: 2, project: 'oops' }, 'could not be converted')
    fails({ format: 'ceica-project', schemaVersion: [2], project: {} }, 'Unknown project file version')
    fails({ format: 'ceica-project', schemaVersion: FORMAT_VERSION + 1, project: {} }, 'newer version')
  })
})
