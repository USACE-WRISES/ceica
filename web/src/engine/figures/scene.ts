// Renderer-agnostic figures: each chart is laid out once, in pixels, as a list of primitives
// (ceica/figures/scene.py).
//
// A Scene holds circles, lines, rectangles and text already placed in a width x height box (origin
// at the top left). The SVG renderer (app and HTML report) only draws primitives, so every copy of a
// figure is the same figure. Marks carry a `key` (the plan or alternative they belong to) and
// tooltip lines; the app uses the key to cross-highlight marks, ICA boxes and table rows.
//
// The arithmetic is Python's, in its order: the same doubles come out. numpy's density layer is
// reproduced with Python's float floor division and a correctly rounded log1p (web/README.md).
import { pyFixedComma, pyG } from '../../py/pyfmt'
import { crLog1p, pyFloorDiv, pySum } from '../../py/pynum'
import * as P from './palette'
import { fmtNumber, moneyScale, niceRange, pyMax, pyMin, seqMax, seqMin } from './ticks'

export const FONT = 11.0
export const FONT_SMALL = 10.0
/** Charts draw one mark per plan up to this many plans. Above it, the plans that are not
 * cost-effective are binned into shaded cells (a density layer), which keeps the chart small. */
export const DENSITY_ABOVE = 4000
/** Side of a density cell, in chart units (pixels at the default size). */
export const DENSITY_CELL = 6.0

export interface Circle {
  kind: 'circle', cx: number, cy: number, r: number, stroke: string | null, fill: string | null, width: number, role: string,
  key: string | null, tip: readonly string[]
}
export interface Line {
  kind: 'line', points: readonly (readonly [number, number])[], stroke: string, width: number, dash: string | null, role: string,
  key: string | null
}
export interface Rect {
  kind: 'rect', x: number, y: number, w: number, h: number, fill: string | null, stroke: string | null, width: number,
  dash: string | null, role: string, key: string | null, tip: readonly string[]
}
export interface Text {
  kind: 'text', x: number, y: number, text: string, size: number, color: string, anchor: string, weight: string, rotate: number,
  role: string, key: string | null
}
export type Item = Circle | Line | Rect | Text

type Opt<T> = Partial<Omit<T, 'kind'>>

export const circle = (cx: number, cy: number, r: number, o: Opt<Circle> = {}): Circle =>
  ({ kind: 'circle', cx, cy, r, stroke: null, fill: null, width: 1.0, role: '', key: null, tip: [], ...o })
export const line = (points: readonly (readonly [number, number])[], stroke: string, width = 1.0, o: Opt<Line> = {}): Line =>
  ({ kind: 'line', points, stroke, width, dash: null, role: '', key: null, ...o })
export const rect = (x: number, y: number, w: number, h: number, o: Opt<Rect> = {}): Rect =>
  ({ kind: 'rect', x, y, w, h, fill: null, stroke: null, width: 1.0, dash: null, role: '', key: null, tip: [], ...o })
export const text = (x: number, y: number, t: string, size = FONT, color: string = P.TEXT, anchor = 'start', o: Opt<Text> = {}): Text =>
  ({ kind: 'text', x, y, text: t, size, color, anchor, weight: 'normal', rotate: 0.0, role: '', key: null, ...o })

/** Legend entry: (role, label, color, shape). */
export type LegendEntry = readonly [string, string, string, string]

export interface Scene {
  width: number
  height: number
  title: string
  desc: string
  items: readonly Item[]
  /** Legend entries for HTML legends. */
  legend: readonly LegendEntry[]
}

/** len(text): Python counts code points. */
const pyLen = (s: string): number => [...s].length

export function textWidth(t: string, size = FONT): number {
  return 0.56 * size * pyLen(t)
}

export const LEGEND_ROW = 16.0

/** Legend entries wrapped into rows that fit the width. */
export function legendRows(legend: readonly LegendEntry[], width: number): LegendEntry[][] {
  const rows: LegendEntry[][] = [[]]
  let used = 12.0
  for (const entry of legend) {
    const w = 30 + textWidth(entry[1], FONT_SMALL)
    if (rows[rows.length - 1].length && used + w > width - 12) {
      rows.push([])
      used = 12.0
    }
    rows[rows.length - 1].push(entry)
    used += w
  }
  return rows.filter((r) => r.length)
}

/** Top margin that leaves room for the legend rows above the plot. */
export function legendTop(legend: readonly LegendEntry[], width: number, minimum = 30.0): number {
  const n = legendRows(legend, width).length
  return n ? pyMax(minimum, 14.0 + LEGEND_ROW * n) : minimum
}

/** The scene with its legend drawn across the top, for the reports. */
export function withLegend(scene: Scene): Scene {
  if (!scene.legend.length || scene.items.some((i) => i.role === 'legend')) return scene
  const items: Item[] = [...scene.items]
  for (const [k, row] of legendRows(scene.legend, scene.width).entries()) {
    let x = 12.0
    const y = 8.0 + LEGEND_ROW * k
    for (const [, label, color, shape] of row) {
      const cy = y + 5
      if (shape === 'line') items.push(line([[x, cy], [x + 14, cy]], color, 2.0, { role: 'legend' }))
      else if (shape === 'open') items.push(circle(x + 7, cy, 3.2, { stroke: color, fill: '#ffffff', width: 1.0, role: 'legend' }))
      else if (shape === 'ring') items.push(circle(x + 7, cy, 5.0, { stroke: color, width: 2.0, role: 'legend' }))
      else if (shape === 'box') items.push(rect(x + 2, y, 10, 10, { fill: P.NAVY_SOFT, stroke: color, width: 1.2, role: 'legend' }))
      else if (shape === 'density') {
        for (const [k2, tint] of P.DENSITY.slice(1).entries()) items.push(rect(x + 1 + 4 * k2, y, 4, 10, { fill: tint, role: 'legend' }))
      } else items.push(rect(x + 2, y, 10, 10, { fill: color, role: 'legend' }))
      items.push(text(x + 18, y + 9, label, FONT_SMALL, P.TEXT, 'start', { role: 'legend' }))
      x += 30 + textWidth(label, FONT_SMALL)
    }
  }
  return { ...scene, items }
}

/** Plot box and data-to-pixel mapping. */
export class Frame {
  items: Item[] = []
  left: number
  top: number
  right: number
  bottom: number

  constructor(readonly width: number, readonly height: number, readonly xLo: number, readonly xHi: number,
    readonly yLo: number, readonly yHi: number, { left = 62.0, top = 30.0, right = 16.0, bottom = 44.0 } = {}) {
    this.left = left
    this.top = top
    this.right = right
    this.bottom = bottom
  }

  get x0(): number { return this.left }
  get x1(): number { return this.width - this.right }
  get y0(): number { return this.height - this.bottom }
  get y1(): number { return this.top }

  px(x: number): number {
    return this.x0 + (x - this.xLo) / (this.xHi - this.xLo) * (this.x1 - this.x0)
  }

  py(y: number): number {
    return this.y0 - (y - this.yLo) / (this.yHi - this.yLo) * (this.y0 - this.y1)
  }

  axes(xticks: readonly number[], yticks: readonly number[], xlabel: string, ylabel: string,
    { xMoney = false, yMoney = false, yDiv = 1.0 } = {}): void {
    const it = this.items
    const xstep = xticks.length > 1 ? xticks[1] - xticks[0] : null
    const ystep = yticks.length > 1 ? yticks[1] - yticks[0] : null
    for (const t of yticks) {
      const y = this.py(t)
      it.push(line([[this.x0, y], [this.x1, y]], P.GRID, 1.0, { role: 'grid' }))
      // ystep and ystep / y_div
      const s = ystep === null ? null : ystep === 0 ? ystep : ystep / yDiv
      it.push(text(this.x0 - 6, y + 3.5, fmtNumber(t / yDiv, s, { money: yMoney }), FONT_SMALL, P.TEXT_MUTED, 'end', { role: 'tick' }))
    }
    for (const t of xticks) {
      const x = this.px(t)
      it.push(line([[x, this.y0], [x, this.y0 + 4]], P.AXIS, 1.0, { role: 'axis' }))
      it.push(text(x, this.y0 + 16, fmtNumber(t, xstep, { money: xMoney }), FONT_SMALL, P.TEXT_MUTED, 'middle', { role: 'tick' }))
    }
    it.push(line([[this.x0, this.y0], [this.x1, this.y0]], P.AXIS, 1.0, { role: 'axis' }))
    it.push(line([[this.x0, this.y0], [this.x0, this.y1]], P.AXIS, 1.0, { role: 'axis' }))
    it.push(text((this.x0 + this.x1) / 2, this.height - 8, xlabel, FONT, P.TEXT, 'middle', { role: 'axis-title' }))
    it.push(text(14, (this.y0 + this.y1) / 2, ylabel, FONT, P.TEXT, 'middle', { rotate: -90, role: 'axis-title' }))
  }
}

export interface PlotPlan {
  key: string
  label: string
  /** output (lift) */
  x: number
  /** cost */
  y: number
  ce: boolean
  bb: boolean
  na: boolean
  /** "Recommended", "TSP" or null */
  decision: string | null
  tip: readonly string[]
}

export interface Step {
  key: string
  label: string
  x0: number
  x1: number
  height: number
  dim: boolean
  tip: readonly string[]
}

/** Points per cell of the plot box, as rows (top first) by columns. */
export function densityBins(f: Frame, xs: ArrayLike<number>, ys: ArrayLike<number>, cell = DENSITY_CELL): { counts: Int32Array, nx: number, ny: number } {
  const nx = Math.max(1, Math.ceil((f.x1 - f.x0) / cell))
  const ny = Math.max(1, Math.ceil((f.y0 - f.y1) / cell))
  const counts = new Int32Array(nx * ny)
  const clip = (v: number, hi: number) => Math.min(Math.max(Math.trunc(v), 0), hi)
  for (let k = 0; k < xs.length; k++) {
    const i = clip(pyFloorDiv(f.px(xs[k]) - f.x0, cell), nx - 1)
    const j = clip(pyFloorDiv(f.py(ys[k]) - f.y1, cell), ny - 1)
    counts[j * nx + i] += 1
  }
  return { counts, nx, ny }
}

/** Shaded cells for many points: four tints by count on a log scale, relative to the busiest cell,
 * with runs of one tint along a row merged into one rectangle. */
export function densityCells(f: Frame, xs: ArrayLike<number>, ys: ArrayLike<number>, cell = DENSITY_CELL): Rect[] {
  const { counts, nx, ny } = densityBins(f, xs, ys, cell)
  let top = 0
  for (const c of counts) if (c > top) top = c
  if (top === 0) return []
  const lt = crLog1p(top)
  const levels = new Int32Array(counts.length)
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] > 0) levels[k] = Math.min(Math.max(Math.ceil(4 * crLog1p(counts[k]) / lt), 1), 4)
  }
  const out: Rect[] = []
  for (let j = 0; j < ny; j++) {
    let k = 0
    while (k < nx) {
      const level = levels[j * nx + k]
      const start = k
      while (k < nx && levels[j * nx + k] === level) k++
      if (!level) continue
      // bleed a quarter unit on each side so neighboring cells leave no hairline seams
      const x0 = pyMax(f.x0, f.x0 + start * cell - 0.25)
      const x1 = pyMin(f.x1, f.x0 + k * cell + 0.25)
      const y0 = pyMax(f.y1, f.y1 + j * cell - 0.25)
      const y1 = pyMin(f.y0, f.y1 + (j + 1) * cell + 0.25)
      out.push(rect(x0, y0, x1 - x0, y1 - y0, { fill: P.DENSITY[level - 1], role: 'density' }))
    }
  }
  return out
}

export function xDomain(values: readonly number[]): [number, number, number[]] {
  const lo = values.length ? seqMin(values) : 0.0
  const hi = values.length ? seqMax(values) : 1.0
  return niceRange(lo, hi)
}

type Box = [number, number, number, number]

/** Put a label near (x, y) where it overlaps no earlier label (a few candidate spots). */
function placeLabel(items: Item[], taken: Box[], x: number, y: number, label: string, key: string | null, color: string,
  bold = false, bounds: Box | null = null): void {
  const w = textWidth(label, FONT_SMALL)
  const h = FONT_SMALL + 2
  // below-right first: nothing lies below and right of the cost-effective frontier
  const cands: [number, number][] = [[x + 9, y + 14], [x + 9, y - 8], [x - 8 - w, y - 8], [x - 8 - w, y + 14],
    [x - w / 2, y - 14], [x - w / 2, y + 22]]
  let chosen = cands[0]
  for (const [cx, cy] of cands) {
    const box: Box = [cx, cy - h, cx + w, cy + 2]
    if (bounds && (box[0] < bounds[0] || box[2] > bounds[2] || box[1] < bounds[1] || box[3] > bounds[3])) continue
    if (taken.every((t) => box[2] < t[0] || box[0] > t[2] || box[3] < t[1] || box[1] > t[3])) {
      chosen = [cx, cy]
      break
    }
  }
  taken.push([chosen[0], chosen[1] - h, chosen[0] + w, chosen[1] + 2])
  items.push(text(chosen[0], chosen[1], label, FONT_SMALL, color, 'start', { weight: bold ? 'bold' : 'normal', role: 'label', key }))
}

/** Python's sorted(xs, key=...): stable, by a tuple of numbers (false < true). */
function sortedBy<T>(xs: readonly T[], key: (x: T) => readonly (number | boolean)[]): T[] {
  return xs.map((x, i) => ({ x, i, k: key(x).map(Number) })).sort((a, b) => {
    for (let n = 0; n < a.k.length; n++) if (a.k[n] !== b.k[n]) return a.k[n] < b.k[n] ? -1 : 1
    return a.i - b.i
  }).map((e) => e.x)
}

/** Cost-effectiveness: every plan, the frontier, best-buy rings and the decision. ``density`` is
 * (outputs, costs) of plans that are not cost-effective, drawn as shaded cells instead of one mark
 * each (see DENSITY_ABOVE). */
export function ceScene(plans: readonly PlotPlan[], { xlabel, ylabel, title, desc, width = 480, height = 330, labelAll = false,
  xRange = null as [number, number, number[]] | null, tspX = null as number | null,
  density = null as [ArrayLike<number>, ArrayLike<number>] | null }: { xlabel: string, ylabel: string, title: string,
  desc: string, width?: number, height?: number, labelAll?: boolean, xRange?: [number, number, number[]] | null,
  tspX?: number | null, density?: [ArrayLike<number>, ArrayLike<number>] | null }): Scene {
  const xs = plans.length ? plans.map((p) => p.x) : [0.0]
  const ys = plans.length ? plans.map((p) => p.y) : [0.0]
  const dense = density !== null && density[0].length > 0
  if (dense) {
    xs.push(arrMin(density![0]), arrMax(density![0]))
    ys.push(arrMin(density![1]), arrMax(density![1]))
  }
  const legend: LegendEntry[] = []
  if (!dense || plans.some((p) => !p.ce)) legend.push(['plan', !labelAll ? 'Plan' : 'Alternative', P.MUTED, 'open'])
  if (dense) legend.push(['density', 'Not cost-effective', P.DENSITY[3], 'density'])
  legend.push(['frontier', 'Cost-effective frontier', P.NAVY, 'line'], ['bb', 'Best buy', P.NAVY, 'ring'])
  const decided = plans.find((p) => p.decision)
  if (decided) legend.push(['decision', decided.decision!, P.DECISION, 'ring'])
  const [xLo, xHi, xticks] = xRange ?? niceRange(seqMin(xs), seqMax(xs))
  const [div, suffix] = moneyScale(seqMax(ys))
  const [yLo, yHi, yticks] = niceRange(seqMin(ys), seqMax(ys))
  const f = new Frame(width, height, xLo, xHi, yLo, yHi, { left: div === 1 ? 66 : 58, top: legendTop(legend, width) })
  // under the grid, like the STAF condition bands
  if (dense) f.items.push(...densityCells(f, density![0], density![1]))
  f.axes(xticks, yticks, xlabel, ylabel + (suffix && ` ($${suffix.trim()})`), { yMoney: true, yDiv: div })
  const it = f.items
  const many = plans.length > DENSITY_ABOVE
  for (const p of plans) {
    if (!p.ce) {
      if (many) it.push(rect(f.px(p.x) - 1, f.py(p.y) - 1, 2, 2, { fill: P.MUTED, role: 'cloud' }))
      else it.push(circle(f.px(p.x), f.py(p.y), 3.2, { stroke: P.MUTED, fill: '#ffffff', width: 1.0, role: 'plan', key: p.key, tip: p.tip }))
    }
  }
  const front = sortedBy(plans.filter((p) => p.ce), (p) => [p.x, p.y])
  if (front.length > 1) {
    const pts = front.map((p) => [f.px(p.x), f.py(p.y)] as const)
    // a white casing keeps the frontier's contrast where it crosses the shaded cells
    if (dense) it.push(line(pts, '#ffffff', 4.6, { role: 'casing' }))
    if (tspX === null) it.push(line(pts, P.NAVY, 2.0, { role: 'frontier' }))
    else {
      const inside = front.filter((p) => p.x <= tspX + 1e-12).map((p) => [f.px(p.x), f.py(p.y)] as const)
      const beyond = front.filter((p) => p.x >= tspX - 1e-12).map((p) => [f.px(p.x), f.py(p.y)] as const)
      if (inside.length > 1) it.push(line(inside, P.NAVY, 2.0, { role: 'frontier' }))
      if (beyond.length > 1) it.push(line(beyond, P.FAINT, 1.6, { dash: '5 4', role: 'frontier-beyond' }))
    }
  }
  for (const p of front) it.push(circle(f.px(p.x), f.py(p.y), 3.4, { fill: P.NAVY, role: 'ce', key: p.key, tip: p.tip }))
  for (const p of plans) {
    if (p.bb) it.push(circle(f.px(p.x), f.py(p.y), 7.5, { stroke: P.NAVY, width: 2.2, role: 'bb', key: p.key, tip: p.tip }))
  }
  for (const p of plans) {
    if (p.decision) it.push(circle(f.px(p.x), f.py(p.y), 11.0, { stroke: P.DECISION, width: 2.2, role: 'decision', key: p.key, tip: p.tip }))
  }
  const taken: Box[] = []
  const bounds: Box = [f.x0, f.y1 - 4, f.x1 + 12, f.y0 + 4]
  for (const p of sortedBy(plans, (q) => [!q.decision, !q.bb, q.x])) {
    if (p.decision) placeLabel(it, taken, f.px(p.x), f.py(p.y), `${p.label} (${p.decision})`, p.key, P.DECISION, true, bounds)
    else if (p.bb || (labelAll && !many)) {
      placeLabel(it, taken, f.px(p.x), f.py(p.y), p.label, p.key, p.bb ? P.NAVY_DARK : P.TEXT_MUTED, false, bounds)
    }
  }
  // hover targets on top
  if (!many) {
    for (const p of plans) it.push(circle(f.px(p.x), f.py(p.y), 9.0, { fill: 'transparent', role: 'hit', key: p.key, tip: p.tip }))
  }
  return { width, height, title, desc, items: it, legend }
}

/** numpy's min and max of an array (no NaN here) */
const arrMin = seqMin
const arrMax = seqMax

/** Incremental cost: one box per best-buy step, width = added output, height = cost per unit. */
export function icaScene(steps: readonly Step[], { xlabel, ylabel, title, desc, width = 480, height = 330,
  xRange = null as [number, number, number[]] | null }: { xlabel: string, ylabel: string, title: string, desc: string,
  width?: number, height?: number, xRange?: [number, number, number[]] | null }): Scene {
  const hs = steps.length ? steps.map((s) => s.height) : [1.0]
  const xs = steps.length ? [...steps.map((s) => s.x0), ...steps.map((s) => s.x1)] : [0.0, 1.0]
  const [xLo, xHi, xticks] = xRange ?? niceRange(seqMin(xs), seqMax(xs))
  const [yLo, yHi, yticks] = niceRange(0.0, hs.length ? seqMax(hs) : 1.0)
  const f = new Frame(width, height, xLo, xHi, yLo, yHi, { left: 66 })
  f.axes(xticks, yticks, xlabel, ylabel, { yMoney: true })
  const it = f.items
  for (const s of steps) {
    const x0 = f.px(s.x0)
    const x1 = f.px(s.x1)
    const y = f.py(s.height)
    it.push(rect(x0, y, pyMax(x1 - x0, 0.5), f.y0 - y, {
      fill: s.dim ? P.FAINT_FILL : P.NAVY_SOFT, stroke: s.dim ? P.FAINT : P.NAVY, width: 1.4,
      dash: s.dim ? '4 3' : null, role: 'step', key: s.key, tip: s.tip,
    }))
  }
  const taken: Box[] = []
  for (const s of steps) {
    const x0 = f.px(s.x0)
    const x1 = f.px(s.x1)
    const y = f.py(s.height)
    const w = textWidth(s.label, FONT_SMALL)
    const color = s.dim ? P.FAINT : P.NAVY_DARK
    if (x1 - x0 >= w + 6 && f.y0 - y >= 16) {
      it.push(text((x0 + x1) / 2, y + 14, s.label, FONT_SMALL, color, 'middle', { role: 'label', key: s.key }))
    } else {
      placeLabel(it, taken, (x0 + x1) / 2 + w / 2 + 2, y + 2, s.label, s.key, color)
    }
  }
  for (const s of steps) {
    const x0 = f.px(s.x0)
    const x1 = f.px(s.x1)
    const y = f.py(s.height)
    it.push(rect(x0, y, pyMax(x1 - x0, 0.5), f.y0 - y, { fill: 'transparent', role: 'hit', key: s.key, tip: s.tip }))
  }
  return { width, height, title, desc, items: it, legend: [['step', 'Best-buy step', P.NAVY, 'box']] }
}

export interface Series {
  key: string
  label: string
  values: readonly (number | null)[]
  na: boolean
}

/** Baselines for labels at the ends of lines: in the lines' order, at least ``gap`` apart, kept
 * between ``lo`` and ``hi`` (pixels, top to bottom). */
export function endLabels(ys: readonly number[], lo: number, hi: number, gap = 12.0): number[] {
  const order = sortedBy(ys.map((_, i) => i), (i) => [ys[i]])
  const placed = new Map<number, number>()
  let prev: number | null = null
  for (const i of order) {
    const y: number = prev === null ? ys[i] : pyMax(ys[i], prev + gap)
    placed.set(i, y)
    prev = y
  }
  // (prev or lo) - hi
  const over = (prev || lo) - hi
  if (over > 0) for (const i of order) placed.set(i, pyMax(lo, placed.get(i)! - over))
  return ys.map((_, i) => placed.get(i)!)
}

/** Ticks with labels at least ``minPx`` apart (target years 0 and 1 would collide). */
export function spacedTicks(frame: Frame, ticks: readonly number[], minPx = 18.0): number[] {
  const out: number[] = []
  for (const t of ticks) {
    if (!out.length || frame.px(t) - frame.px(out[out.length - 1]) >= minPx) out.push(t)
    else if (t === ticks[ticks.length - 1]) out[out.length - 1] = t
  }
  return out
}

export function timeSeriesScene(years: readonly number[], series: readonly Series[], { ylabel, title, desc, width = 480,
  height = 300 }: { ylabel: string, title: string, desc: string, width?: number, height?: number }): Scene {
  let vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  if (!vals.length) vals = [0.0, 1.0]
  const xLo = seqMin(years)
  const xHi = seqMax(years)
  const [yLo, yHi, yticks] = niceRange(seqMin(vals), seqMax(vals))
  const f = new Frame(width, height, xLo, xHi, yLo, yHi, { left: 56, right: 92 })
  f.axes(spacedTicks(f, years), yticks, 'Year', ylabel)
  const it = f.items
  const ends: [number, number, string, string, string][] = []
  let k = 0
  for (const s of series) {
    const color = s.na ? P.TEXT : P.SERIES[k % P.SERIES.length]
    if (!s.na) k += 1
    const kept = years.map((y, i) => [y, s.values[i]] as const).filter(([, v]) => v !== null && v !== undefined) as [number, number][]
    const pts = kept.map(([y, v]) => [f.px(y), f.py(v)] as const)
    if (pts.length > 1) it.push(line(pts, color, 2.0, { dash: s.na ? '5 4' : null, role: 'series', key: s.key }))
    for (const [n, [x, y]] of pts.entries()) {
      const [yr, v] = kept[n]
      it.push(circle(x, y, 3.2, { fill: color, role: 'point', key: s.key, tip: [s.label, `Year ${pyG(yr)}: ${pyFixedComma(v, 2)}`] }))
    }
    if (pts.length) ends.push([pts[pts.length - 1][0], pts[pts.length - 1][1] + 4, s.label, color, s.key])
  }
  const ly = endLabels(ends.map((e) => e[1]), f.y1 + 8, f.y0 + 4)
  for (const [n, [x, , label, color, key]] of ends.entries()) {
    it.push(text(x + 6, ly[n], label, FONT_SMALL, color, 'start', { role: 'label', key }))
  }
  return { width, height, title, desc, items: it, legend: [] }
}

export interface Bar {
  key: string
  label: string
  /** (part id, part label, value) */
  parts: readonly (readonly [string, string, number])[]
}

/** Horizontal stacked bars (annualized cost by part), a total at each bar's end. */
export function stackScene(bars: readonly Bar[], { xlabel, title, desc, width = 480, height = null as number | null }:
  { xlabel: string, title: string, desc: string, width?: number, height?: number | null }): Scene {
  const n = Math.max(bars.length, 1)
  const colors = new Map<string, string>()
  let extra = 0
  const legend: LegendEntry[] = []
  for (const b of bars) {
    for (const [pid, plabel] of b.parts) {
      if (!colors.has(pid)) {
        let c = P.COST_PARTS.get(pid)
        if (c === undefined) {
          c = P.EXTRA_PARTS[extra % P.EXTRA_PARTS.length]
          extra += 1
        }
        colors.set(pid, c)
        legend.push([pid, plabel, c, 'fill'])
      }
    }
  }
  const top = legendTop(legend, width)
  const h = height || (top + 44 + 30 * n)
  const totals = bars.length ? bars.map((b) => pySum(b.parts.map(([, , v]) => v))) : [1.0]
  const [div, suffix] = moneyScale(pyMax(...totals))
  const [xLo, xHi, xticks] = niceRange(0.0, pyMax(...totals) * 1.12)
  const labelW = (bars.length ? pyMax(...bars.map((b) => textWidth(b.label, FONT_SMALL))) : 40) + 12
  const f = new Frame(width, h, xLo, xHi, 0, n, { left: pyMax(labelW, 60), top, bottom: 40, right: 36 })
  const it = f.items
  const xstep = xticks.length > 1 ? xticks[1] - xticks[0] : null
  for (const t of xticks) {
    const x = f.px(t)
    it.push(line([[x, f.y1], [x, f.y0]], P.GRID, 1.0, { role: 'grid' }))
    const s = xstep === null ? null : xstep === 0 ? xstep : xstep / div
    it.push(text(x, f.y0 + 16, fmtNumber(t / div, s, { money: true }), FONT_SMALL, P.TEXT_MUTED, 'middle', { role: 'tick' }))
  }
  it.push(text((f.x0 + f.x1) / 2, h - 8, xlabel + (suffix && ` ($ ${suffix.trim()})`), FONT, P.TEXT, 'middle', { role: 'axis-title' }))
  const band = (f.y0 - f.y1) / n
  for (const [i, b] of bars.entries()) {
    const y = f.y1 + band * i + band * 0.18
    const bh = band * 0.64
    let x = f.px(0)
    it.push(text(f.x0 - 8, y + bh / 2 + 3.5, b.label, FONT_SMALL, P.TEXT, 'end', { role: 'tick', key: b.key }))
    let total = 0.0
    for (const [pid, plabel, v] of b.parts) {
      if (v <= 0) continue
      const w = f.px(total + v) - f.px(total)
      it.push(rect(x, y, w, bh, { fill: colors.get(pid)!, stroke: '#ffffff', width: 1.0, role: 'segment', key: b.key,
        tip: [b.label, `${plabel}: $${pyFixedComma(v, 0)} per year`] }))
      x += w
      total += v
    }
    it.push(text(x + 5, y + bh / 2 + 3.5, `$${pyFixedComma(total, 0)}`, FONT_SMALL, P.TEXT, 'start', { role: 'label', key: b.key }))
  }
  return { width, height: h, title, desc, items: it, legend }
}
