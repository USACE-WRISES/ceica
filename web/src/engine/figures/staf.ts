// STAF figures: the Ecosystem Condition Index over time, and lift split by outcome
// (ceica/figures/staf.py).
//
// The ECI chart sits on the STAF condition bands; the outcome chart uses the STAF outcome colors and
// puts a negative contribution (an outcome an alternative makes worse) left of zero.
import { pyFixed, pyFixedComma, pyG } from '../../py/pyfmt'
import { pySum } from '../../py/pynum'
import * as staf from '../benefits/staf'
import * as P from './palette'
import {
  circle, endLabels, FONT, FONT_SMALL, Frame, type LegendEntry, legendTop, line, rect, type Scene, type Series, spacedTicks, text,
  textWidth,
} from './scene'
import { fmtNumber, niceRange, pyMax, pyMin } from './ticks'

/** ECI at each target year per alternative, over the Non-Functioning, Functioning-at-Risk and
 * Functioning bands (0 to 0.39, to 0.69, to 1). Lines are labeled at their ends; the bands are in the
 * legend. */
export function eciScene(years: readonly number[], series: readonly Series[], { title, desc, width = 480, height = 300 }:
  { title: string, desc: string, width?: number, height?: number }): Scene {
  const xLo = pyMin(...years)
  const xHi = pyMax(...years)
  const legend: LegendEntry[] = staf.INDEX_BANDS.map(([, label]) => [`band-${label}`, label, P.STAF_BAND_TINTS[label], 'fill'])
  const right = (series.length ? pyMax(...series.map((s) => textWidth(s.label, FONT_SMALL))) : 40) + 14
  const f = new Frame(width, height, xLo, xHi, 0.0, 1.0, { left: 56, right: pyMax(56.0, right), top: legendTop(legend, width) })
  const it = f.items
  let lo = 0.0
  for (const [upper, label] of staf.INDEX_BANDS) {
    const hi = pyMin(upper, 1.0)
    const yTop = f.py(hi)
    const yBot = f.py(lo)
    it.push(rect(f.x0, yTop, f.x1 - f.x0, yBot - yTop, { fill: P.STAF_BAND_TINTS[label], role: 'band',
      tip: [label, `ECI ${pyFixed(lo, 2)} to ${pyFixed(hi, 2)}`] }))
    lo = hi
  }
  f.axes(spacedTicks(f, years), [0.0, 0.2, 0.4, 0.6, 0.8, 1.0], 'Year', 'Ecosystem Condition Index')
  const ends: [number, number, string, string, string][] = []
  let k = 0
  for (const s of series) {
    const color = s.na ? P.TEXT : P.SERIES[k % P.SERIES.length]
    if (!s.na) k += 1
    const pts = years.map((y, i) => [y, s.values[i]] as const).filter(([, v]) => v !== null && v !== undefined)
      .map(([y, v]) => [f.px(y), f.py(v as number), y, v as number] as const)
    if (pts.length > 1) it.push(line(pts.map(([x, y]) => [x, y] as const), color, 2.0, { dash: s.na ? '5 4' : null, role: 'series', key: s.key }))
    for (const [x, y, yr, v] of pts) {
      it.push(circle(x, y, 3.2, { fill: color, role: 'point', key: s.key,
        tip: [s.label, `Year ${pyG(yr)}: ECI ${pyFixed(v, 2)} (${staf.band(v)})`] }))
    }
    if (pts.length) ends.push([pts[pts.length - 1][0], pts[pts.length - 1][1] + 4, s.label, color, s.key])
  }
  const ly = endLabels(ends.map((e) => e[1]), f.y1 + 8, f.y0 + 4)
  for (const [n, [x, , label, color, key]] of ends.entries()) {
    it.push(text(x + 6, ly[n], label, FONT_SMALL, color, 'start', { role: 'label', key }))
  }
  return { width, height, title, desc, items: it, legend }
}

export interface OutcomeBar {
  key: string
  label: string
  /** Lift through each outcome (physical, chemical, biological), in output units. */
  parts: Readonly<Record<string, number>>
}

/** Lift split by outcome, one diverging stacked bar per alternative, total at the end. */
export function outcomeScene(bars: readonly OutcomeBar[], { unit, title, desc, width = 480 }:
  { unit: string, title: string, desc: string, width?: number }): Scene {
  const n = Math.max(bars.length, 1)
  const legend: LegendEntry[] = staf.OUTCOMES.map((o) => [o, staf.OUTCOME_LABELS[o], staf.OUTCOME_COLORS[o], 'fill'])
  const top = legendTop(legend, width)
  const height = top + 44 + 30 * n
  const values = (b: OutcomeBar) => Object.values(b.parts)
  const pos = bars.length ? bars.map((b) => pySum(values(b).filter((v) => v > 0))) : [1.0]
  const neg = bars.length ? bars.map((b) => pySum(values(b).filter((v) => v < 0))) : [0.0]
  const [xLo, xHi, xticks] = niceRange(pyMin(0.0, pyMin(...neg)), pyMax(...pos) * 1.15 || 1.0)
  const labelW = (bars.length ? pyMax(...bars.map((b) => textWidth(b.label, FONT_SMALL))) : 40) + 12
  const f = new Frame(width, height, xLo, xHi, 0, n, { left: pyMax(labelW, 60), top, bottom: 40, right: 44 })
  const it = f.items
  const step = xticks.length > 1 ? xticks[1] - xticks[0] : null
  for (const t of xticks) {
    const x = f.px(t)
    it.push(line([[x, f.y1], [x, f.y0]], t === 0 ? P.AXIS : P.GRID, 1.0, { role: t === 0 ? 'axis' : 'grid' }))
    it.push(text(x, f.y0 + 16, fmtNumber(t, step), FONT_SMALL, P.TEXT_MUTED, 'middle', { role: 'tick' }))
  }
  it.push(text((f.x0 + f.x1) / 2, height - 8, `Lift (${unit})`, FONT, P.TEXT, 'middle', { role: 'axis-title' }))
  const band = (f.y0 - f.y1) / n
  for (const [i, b] of bars.entries()) {
    const y = f.y1 + band * i + band * 0.18
    const h = band * 0.64
    it.push(text(f.x0 - 8, y + h / 2 + 3.5, b.label, FONT_SMALL, P.TEXT, 'end', { role: 'tick', key: b.key }))
    let right = 0.0
    let left = 0.0
    for (const o of staf.OUTCOMES) {
      const v = b.parts[o] ?? 0.0
      if (v === 0) continue
      let x0: number
      let x1: number
      if (v > 0) {
        x0 = f.px(right)
        x1 = f.px(right + v)
        right += v
      } else {
        x0 = f.px(left + v)
        x1 = f.px(left)
        left += v
      }
      it.push(rect(x0, y, x1 - x0, h, { fill: staf.OUTCOME_COLORS[o], stroke: '#ffffff', width: 1.0, role: 'segment', key: b.key,
        tip: [b.label, `${staf.OUTCOME_LABELS[o]}: ${pyFixedComma(v, 2)} ${unit}`] }))
    }
    const total = pySum(values(b))
    it.push(text(f.px(pyMax(right, 0.0)) + 5, y + h / 2 + 3.5, pyFixedComma(total, 1), FONT_SMALL, P.TEXT, 'start',
      { role: 'label', key: b.key }))
  }
  return { width, height, title, desc, items: it, legend }
}
