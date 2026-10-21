// The Utoy Creek example reproduces the published report (UtoyDecisions index.html): tests/
// test_utoy_golden.py, ported. Golden tables come from tools/extract_utoy_golden.py (copied by
// web/parity/copy_sources.py). Each printed number must match the engine to half a unit of its last
// printed decimal; cost-effective and best-buy flags must match exactly.
import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyze, type AnalysisResults, planRows, siteBestBuys, siteRow, wsIndexOfKey, wsPlans,
} from '../src/engine/analysis'
import { lineKey } from '../src/engine/annualize'
import { copy } from '../src/engine/model'
import { loads } from '../src/engine/projectfile'
import golden from './fixtures/utoy_published.json'
import utoyText from './fixtures/examples/utoy-creek.ceica?raw'

const TABLES = (golden as unknown as { tables: Record<string, { caption: string, columns: string[], rows: string[][] }> }).tables
const SITES = ['17F2M', '17D2E', '17B', '2A', '2B', '3E', '3F', '19A']

function value(text: string): number | null {
  const t = text.replace(/,/g, '').trim()
  if (t === 'NaN' || t === '' || t === 'NA') return null
  return Number(t)
}

function decimals(text: string): number {
  const m = /\.(\d+)$/.exec(text.replace(/,/g, ''))
  return m ? m[1].length : 0
}

function close(printed: string, v: number | null | undefined): boolean {
  const want = value(printed)
  if (want === null) return v === null || v === undefined
  if (v === null || v === undefined) return false
  return Math.abs(v - want) <= 0.5 * 10 ** -decimals(printed) + 1e-9
}

let published: AnalysisResults

beforeAll(() => {
  published = analyze(loads(utoyText).project)
})

describe('the published Utoy Creek report', () => {
  it('Table 4: the inputs summary', () => {
    for (const [site, alt, outputs, lift, constr, annual, unit] of TABLES['Table 4'].rows) {
      const b = published.benefits.get(lineKey(site, alt))!
      const c = published.costs.get(lineKey(site, alt))!
      expect(close(outputs, b.aahu), `${site} ${alt} outputs`).toBe(true)
      expect(close(lift, b.lift), `${site} ${alt} lift`).toBe(true)
      expect(close(constr, c.first_costs.get('construction')), `${site} ${alt} construction`).toBe(true)
      expect(close(annual, c.annual), `${site} ${alt} annual`).toBe(true)
      expect(close(unit, siteRow(published.sites.get(site)!, alt)!.unit_cost), `${site} ${alt} unit`).toBe(true)
    }
  })

  it.each(SITES.map((s, k) => [k, s] as const))('the site tables of %s (%s)', (k, site) => {
    const inc = TABLES[`Table ${2 * (k + 1) + 3}`]
    const ce = TABLES[`Table ${2 * (k + 1) + 4}`]
    const sr = published.sites.get(site)!
    expect(ce.caption.endsWith(`Site ${site}.`)).toBe(true)
    for (const [alt, lift, annual, unit, constr, ceFlag, bbFlag] of ce.rows) {
      const row = siteRow(sr, alt)!
      expect(close(lift, row.lift) && close(annual, row.cost) && close(unit, row.unit_cost)
        && close(constr, row.construction), `${site} ${alt}`).toBe(true)
      expect([Number(ceFlag), Number(bbFlag)]).toEqual([Number(row.ce), Number(row.bb)])
    }
    const bbs = siteBestBuys(sr)
    expect(bbs.length).toBe(inc.rows.length)
    inc.rows.forEach(([label, lift, annual, incUnit, constr], i) => {
      const row = bbs[i]
      expect(label.endsWith(row.alt_id)).toBe(true)
      expect(close(lift, row.lift) && close(annual, row.cost) && close(incUnit, row.inc_cost_per_unit ?? 0)
        && close(constr, row.construction)).toBe(true)
    })
  })

  it('Appendix B: the components and costs', () => {
    for (const [site, alt, ripl, ripr, ins, total, lift] of TABLES['Table B01'].rows) {
      const b = published.benefits.get(lineKey(site, alt))!
      expect(close(ripl, b.aahu_by_module.get('RipL')) && close(ripr, b.aahu_by_module.get('RipR'))
        && close(ins, b.aahu_by_module.get('Ins')) && close(total, b.aahu) && close(lift, b.lift)).toBe(true)
    }
    for (const [site, alt, general, insp, inv, repair, total, pct] of TABLES['Table B02'].rows) {
      const c = published.costs.get(lineKey(site, alt))!
      const pv = c.recurring_pv
      expect(close(general, pv.get('general') ?? 0) && close(insp, pv.get('inspection') ?? 0)
        && close(inv, pv.get('invasives') ?? 0) && close(repair, pv.get('repair') ?? 0)
        && close(total, [...pv.values()].reduce((s, v) => s + v, 0))).toBe(true)
      if (value(pct) !== null) {
        expect(close(pct, c.annual_parts.get('omrrr')! / c.first_costs.get('construction')! * 100)).toBe(true)
      }
    }
    for (const [site, alt, , constr, mon, adm, omAnn, total] of TABLES['Table B03'].rows) {
      const c = published.costs.get(lineKey(site, alt))!
      expect(close(constr, c.first_costs.get('construction')) && close(mon, c.first_costs.get('monitoring'))
        && close(adm, c.first_costs.get('adaptive_management')) && close(omAnn, c.annual_parts.get('omrrr'))
        && close(total, c.annual)).toBe(true)
    }
  })

  it('17F2M Alternative 1\'s costs', () => {
    const c = published.costs.get(lineKey('17F2M', 'Alternative1'))!
    expect(Math.abs(c.idc - 8669.62)).toBeLessThanOrEqual(0.005)
    expect(Math.abs([...c.recurring_pv.values()].reduce((s, v) => s + v, 0) - 479530.91)).toBeLessThanOrEqual(0.005)
    expect(Math.abs(c.annual - 54483.69)).toBeLessThanOrEqual(0.005)
  })

  it('Table C01: every watershed plan', () => {
    const ws = published.watershed
    expect(wsPlans(ws)).toBe(128)
    expect([...ws.carried.keys()]).toEqual(['17F2M', '17D2E', '17B', '2A', '2B', '3F', '19A'])
    const rows = new Map(planRows(ws, 'all').map((r) => [r.plan_id, r]))
    const sites = TABLES['Table C01'].columns.slice(1, 8)
    for (const cells of TABLES['Table C01'].rows) {
      const pid = cells[0]
      const bitsOf = cells.slice(1, 8)
      const [lift, annual, first, unit, ce, bb] = cells.slice(8)
      const r = rows.get(pid)!
      expect(sites.filter((s, j) => bitsOf[j] === '1')).toEqual(sites.filter((s) => r.composition.has(s)))
      expect(close(lift, r.output) && close(annual, r.cost) && close(first, r.construction) && close(unit, r.unit_cost),
        pid).toBe(true)
      expect([Number(ce), Number(bb)]).toEqual([Number(r.ce), Number(r.bb)])
    }
  })

  it('Table 22: the watershed best buys', () => {
    const bbs = planRows(published.watershed, 'bb')
    const t = TABLES['Table 22'].rows
    expect(bbs.map((r) => r.plan_id)).toEqual(t.map((c) => c[0]))
    t.forEach((cells, i) => {
      const r = bbs[i]
      const [lift, annual, constr, unit, inc] = cells.slice(8)
      expect(close(lift, r.output) && close(annual, r.cost) && close(constr, r.construction)
        && close(unit, r.unit_cost) && close(inc, r.inc_cost_per_unit ?? 0)).toBe(true)
    })
  })

  it('Table 21: the site recommendations', () => {
    const carried = published.watershed.carried
    for (const [site, alt] of TABLES['Table 21'].rows) {
      if (alt === 'FWOP') expect(published.watershed.not_carried).toContain(site)
      else expect(carried.get(site)).toEqual([alt])
    }
  })

  it('Table 23: the final array and the TSP', () => {
    const ws = published.watershed
    const d = published.decisions
    const ids = d.final_keys.map((k) => ws.ceica!.points.ids[wsIndexOfKey(ws, k)!])
    expect(ids).toEqual(TABLES['Table 23'].rows.map((c) => c[0]))
    expect(d.tsp_state).toBe('ok')
    expect(ws.ceica!.points.ids[wsIndexOfKey(ws, d.tsp_key!)!]).toBe('P128')
    expect(d.ladder.map((s) => [s.from_id, s.to_id, s.adds, s.drops])).toEqual([
      ['P1', 'P14', ['2A', '2B', '19A'], []], ['P14', 'P16', ['3F'], []], ['P16', 'P30', ['17B'], ['3F']],
      ['P30', 'P62', ['17D2E'], []], ['P62', 'P128', ['17F2M', '3F'], []]])
    expect(published.issues.filter((i) => i.level === 'error')).toEqual([])
  })

  it('IWR\'s rounding keeps the flags and moves only a few dollars', () => {
    const p = published.project
    const iwr = analyze(copy(p, { settings: copy(p.settings, { cost_decimals: 2, output_decimals: 3 }) }))
    expect(planRows(iwr.watershed, 'ce').map((r) => r.plan_id))
      .toEqual(planRows(published.watershed, 'ce').map((r) => r.plan_id))
    const a = planRows(iwr.watershed, 'bb')
    const b = planRows(published.watershed, 'bb')
    a.forEach((r, i) => {
      expect(r.plan_id).toBe(b[i].plan_id)
      if (r.inc_cost_per_unit) expect(Math.abs(r.inc_cost_per_unit - b[i].inc_cost_per_unit!)).toBeLessThan(1)
    })
  })
})
