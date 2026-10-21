// Project files round-trip; decisions survive iteration and flag what needs review:
// tests/test_projectfile_decisions.py, ported. Its edits through views/cells.py are made here on the
// model directly; keeping a TSP (views/edits.py) comes with the page's edits in Phase 2.
import { describe, expect, it } from 'vitest'
import { analyze, planRows, wsPlans } from '../src/engine/analysis'
import { nStale, nSuggested } from '../src/engine/decisions'
import {
  alternativeOf, copy, parseProject, parseSiteDecision, type Project, siteOf,
} from '../src/engine/model'
import { contentDigest, dumps, loads, ProjectFileError } from '../src/engine/projectfile'
import { readiness } from '../src/engine/runState'
import * as staf from '../src/engine/benefits/staf'
import { lineKey } from '../src/engine/annualize'
import utoyText from './fixtures/examples/utoy-creek.ceica?raw'

const utoy = (): Project => loads(utoyText).project

function withSiteDecision(project: Project, siteId: string, update: Record<string, unknown>): Project {
  const sites = new Map(project.decisions.sites)
  sites.set(siteId, copy(sites.get(siteId) ?? parseSiteDecision({}), update))
  return copy(project, { decisions: copy(project.decisions, { sites }) })
}

/** One alternative's first cost set (what the Inputs grid's cell does). */
function withFirstCost(project: Project, siteId: string, altId: string, category: string, value: number): Project {
  return copy(project, { sites: project.sites.map((s) => s.id !== siteId ? s : copy(s, {
    alternatives: s.alternatives.map((a) => a.id !== altId ? a : copy(a, { costs: copy(a.costs, {
      first_costs: new Map([...a.costs.first_costs, [category, value]]) }) })) })) })
}

describe('tests/test_projectfile_decisions.py', () => {
  it('a round trip', () => {
    const p = utoy()
    const text = dumps(p, { savedAt: '2026-01-01T00:00:00Z' })
    const back = loads(text)
    expect(contentDigest(back.project)).toBe(contentDigest(p))
    expect(back.warnings).toEqual([])
    expect(dumps(back.project, { savedAt: '2026-01-01T00:00:00Z' })).toBe(text)
  })

  it('a digest mismatch warns, and bad files explain', () => {
    const doc = JSON.parse(dumps(utoy()))
    doc.project.name = 'Edited by hand'
    const loaded = loads(JSON.stringify(doc))
    expect(loaded.warnings.length).toBeGreaterThan(0)
    expect(loaded.project.name).toBe('Edited by hand')
    expect(() => loads('{}')).toThrow(ProjectFileError)
    expect(() => loads('{}')).toThrow('not a CEICA project')
    expect(() => loads(JSON.stringify({ format: 'ceica-project', schemaVersion: 99, project: {} }))).toThrow('newer version')
    expect(() => loads(JSON.stringify({ format: 'ceica-project', schemaVersion: 1,
      project: { settings: { discount_rate: 'abc' } } }))).toThrow('invalid value')
    expect(contentDigest(utoy()).length).toBe(64)
  })

  it('suggestions stand in until the team decides', () => {
    const p0 = utoy()
    const p = copy(p0, { decisions: copy(p0.decisions, { sites: new Map() }) })
    const res = analyze(p)
    const st = res.decisions.sites
    expect([st.get('3E')!.source, st.get('3E')!.alt_id]).toEqual(['suggested', 'Alternative2'])
    expect(res.watershed.carried.has('3E')).toBe(true)  // the suggestion carries 3E forward
    expect(wsPlans(res.watershed)).toBe(256)
    expect(nSuggested(res.decisions)).toBe(8)
  })

  it('a stale site decision', () => {
    const fp = analyze(utoy()).sites.get('17B')!.fingerprint
    const p = withSiteDecision(utoy(), '17B', { basis: fp })
    expect(analyze(p).decisions.sites.get('17B')!.stale).toBe(false)
    const res = analyze(withFirstCost(p, '17B', 'Alternative2', 'construction', 500000.0))
    expect(res.decisions.sites.get('17B')!.stale).toBe(true)
    expect(res.issues.some((i) => i.code === 'W_REC_STALE')).toBe(true)
  })

  it('the example\'s decisions record their basis', () => {
    const p = utoy()
    const res = analyze(p)
    for (const [sid, d] of p.decisions.sites) expect(d.basis).toBe(res.sites.get(sid)!.fingerprint)
    expect(p.decisions.watershed.basis).toBe(res.watershed.fingerprint)
    expect(nStale(res.decisions)).toBe(0)
    expect(res.decisions.watershed_stale).toBe(false)
  })

  it('an edit that moves results flags the example\'s decisions', () => {
    const res = analyze(withFirstCost(utoy(), '2A', 'Alternative1', 'construction', 600000))
    const st = res.decisions
    expect([...st.sites].filter(([, s]) => s.stale).map(([sid]) => sid)).toEqual(['2A'])
    expect(st.watershed_stale).toBe(true)
    expect(st.tsp_state).toBe('ok')
    const codes = new Set(res.issues.map((i) => i.code))
    expect(codes.has('W_REC_STALE') && codes.has('W_WATERSHED_STALE')).toBe(true)
  })

  it('a TSP that needs review holds the checklist', () => {
    const res = analyze(withFirstCost(utoy(), '2A', 'Alternative1', 'construction', 600000))
    const tspItem = readiness(res).filter(([, , stage]) => stage === 'watershed').map(([ok, text]) => [ok, text])
    expect(tspItem).toEqual([[false, 'Review the tentatively selected plan after changes']])
  })

  it('the TSP goes missing when its composition disappears', () => {
    const res = analyze(withSiteDecision(utoy(), '3F', { recommended_alt_id: 'FWOP' }))
    expect(wsPlans(res.watershed)).toBe(64)
    expect(res.decisions.tsp_state).toBe('missing')
    expect(res.issues.some((i) => i.code === 'W_TSP_MISSING')).toBe(true)
  })

  it('a TSP outside the final array is an error', () => {
    const p0 = utoy()
    const ws = p0.decisions.watershed
    const p9 = planRows(analyze(p0).watershed, 'bb').find((r) => r.plan_id === 'P9')!.key
    const p = copy(p0, { decisions: copy(p0.decisions, { watershed: copy(ws, { tsp: p9, basis: null,
      tsp_plan_type: 'National Ecosystem Restoration (NER) plan', tsp_rationale: '' }) }) })
    const res = analyze(p)
    expect(res.decisions.tsp_state).toBe('not_in_final')
    expect(res.issues.some((i) => i.code === 'E_TSP_NOT_IN_FINAL')).toBe(true)
  })
})

describe('tests/test_staf.py: a STAF project analyzes', () => {
  it('lift, the No Action condition and a best buy', () => {
    const ids = staf.functionIds()
    const base = Object.fromEntries(ids.map((f) => [f, [8.0, 8.0, 8.0, 8.0]]))
    const better: Record<string, number[]> = Object.fromEntries(ids.map((f) => [f, [8.0, 10.0, 11.0, 12.0]]))
    better['habitat-provision'] = [8.0, 12.0, 13.0, 14.0]
    const alt = (aid: string, scores: unknown, qty: number, na = false, cost = 0.0) => ({
      id: aid, name: aid, is_no_action: na,
      outputs: [{ module_id: 'condition', scores, quantity: [qty, qty, qty, qty] }],
      costs: { first_costs: { construction: cost }, construction_months: 6 },
    })
    const p = parseProject({
      benefits: { target_years: [0.0, 2.0, 10.0, 50.0], staf_mapping: 'A',
        modules: [{ id: 'condition', name: 'Stream condition', method: 'STAF', quantity_units: 'mi' }] },
      sites: [{ id: 'R1', alternatives: [alt('FWOP', base, 0.5, true), alt('Alt1', better, 0.5, false, 400000.0)] }],
    })
    const res = analyze(p)
    const b = res.benefits.get(lineKey('R1', 'Alt1'))!
    expect(b.lift !== null && b.lift > 0).toBe(true)
    expect(Math.abs(res.benefits.get(lineKey('R1', 'FWOP'))!.aahu! - 0.5 * 8 / 15)).toBeLessThanOrEqual(1e-12)
    expect(res.sites.get('R1')!.ready).toBe(true)
    expect(res.sites.get('R1')!.rows.find((r) => r.alt_id === 'Alt1')!.bb).toBe(true)
    expect(alternativeOf(siteOf(p, 'R1')!, 'Alt1')).not.toBeNull()
  })
})
