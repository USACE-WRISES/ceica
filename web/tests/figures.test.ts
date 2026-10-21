// The figures against ceica/figures (figures/<project>.json and ticks_ref.json,
// make_figures_fixtures.py): every chart's SVG, byte for byte, and the tick arithmetic under it.
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import {
  siteCeIca, siteCostStack, siteStaf, siteTimeSeries, watershedCeIca,
} from '../src/engine/figures'
import type { Scene } from '../src/engine/figures/scene'
import { render, renderPanels } from '../src/engine/figures/svg'
import { fmtNumber, niceRange, niceStep } from '../src/engine/figures/ticks'
import { byYear, isStaf } from '../src/engine/model'
import { loads } from '../src/engine/projectfile'
import { crLog1p } from '../src/py/pynum'
import ticksRef from './fixtures/ticks_ref.json'
import { digest } from './helpers'
import { projectGoldens } from './projects'

const goldens = import.meta.glob<Record<string, string>>('./fixtures/figures/*.json', { import: 'default', eager: true })

/** Every figure of a project, named as the golden names them. */
function figures(input: string): Map<string, string> {
  const p = loads(input).project
  const res = analyze(p)
  const out = new Map<string, string>()
  const put = (key: string, scenes: Scene | Scene[], labels = ['(A)', '(B)']) => {
    const list = Array.isArray(scenes) ? scenes : [scenes]
    for (const [k, sc] of list.entries()) {
      out.set(`${key}/${k}`, render(sc, { id: `${key.replace(/\//g, '-')}-${k}` }))
      out.set(`${key}/${k}/plain`, render(sc, { interactive: false, cssClass: 'ce-fig' }))
    }
    out.set(`${key}/panels`, renderPanels(list, labels.slice(0, list.length)))
  }
  for (const s of p.sites) {
    const sr = res.sites.get(s.id)!
    if (!(sr.ready && s.alternatives.length >= 2)) continue
    put(`site/${s.id}/ce_ica`, siteCeIca(res, s.id))
    if (p.benefits.modules.some(byYear)) {
      put(`site/${s.id}/time`, siteTimeSeries(res, s.id))
      for (const m of p.benefits.modules) {
        if (byYear(m) && p.benefits.modules.length > 1) put(`site/${s.id}/time/${m.id}`, siteTimeSeries(res, s.id, m.id))
      }
    }
    put(`site/${s.id}/cost`, siteCostStack(res, s.id))
    if (isStaf(p.benefits) && s.alternatives.some((a) => a.is_no_action)) {
      for (const m of p.benefits.modules) put(`site/${s.id}/staf/${m.id}`, siteStaf(res, s.id, m.id))
    }
  }
  const ws = watershedCeIca(res)
  if (ws !== null) {
    put('watershed', ws)
    if (res.watershed.table !== null && res.watershed.table.output.length > 50) put('watershed/dense', watershedCeIca(res, { densityAbove: 50 })!)
  }
  return out
}

describe.each(projectGoldens())('figures of $name', ({ name, input }) => {
  const golden = goldens[`./fixtures/figures/${name}.json`]
  it('has a golden', () => expect(golden).toBeDefined())
  it('draws every figure as the Python does', () => {
    const got = figures(input)
    expect([...got.keys()].sort()).toEqual(Object.keys(golden).sort())
    for (const [key, svg] of got) {
      const want = golden[key]
      if (want.startsWith('sha256:')) expect(digest(svg), key).toBe(want)
      else expect(svg, key).toBe(want)
    }
  })
})

describe('ticks', () => {
  it('nice_range and fmt_number', () => {
    for (const r of ticksRef.ranges) {
      const [t0, t1, ticks] = niceRange(r.lo, r.hi)
      expect([t0, t1, ticks], `${r.lo}..${r.hi}`).toEqual(r.range)
      const step = ticks.length > 1 ? ticks[1] - ticks[0] : null
      expect([...ticks.map((t) => fmtNumber(t, step)), ...ticks.map((t) => fmtNumber(t, step, { money: true }))]).toEqual(r.labels)
    }
  })
  it('nice_step', () => {
    for (const s of ticksRef.steps) expect(niceStep(s.span), String(s.span)).toBe(s.step)
  })
  it('fmt_number', () => {
    for (const f of ticksRef.fmts) expect(fmtNumber(f.v, f.step, { money: f.money }), JSON.stringify(f)).toBe(f.text)
  })
  it("numpy's density levels", () => {
    const level = (c: number, top: number) => Math.min(Math.max(Math.ceil(4 * crLog1p(c) / crLog1p(top)), 1), 4)
    for (const [i, row] of ticksRef.levels.entries()) {
      const top = i + 1
      let got = ''
      for (let c = 1; c <= top; c++) got += String(level(c, top))
      expect(got, `top ${top}`).toBe(row)
    }
    for (const [c, top, lv] of ticksRef.exact) expect(level(c, top), `${c} of ${top}`).toBe(lv)
  })
})
