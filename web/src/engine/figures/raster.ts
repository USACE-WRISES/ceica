// Scenes as PNG, drawn as ceica/figures/raster.py has matplotlib (Agg) draw them: the figure
// downloads at 300 dpi and the Word document's pictures at 130 dpi.
//
// rasterOps lays a figure's panels out as matplotlib does and lists Agg's draw calls in paint order
// (the tests compare them with matplotlib's own: web/parity/make_raster_fixtures.py). paint draws them
// on a canvas as Agg would (vertices snapped to pixels, clip boxes on whole pixels, the y axis flipped
// at the canvas's whole-pixel height for paths and at the figure's height for text); the page layer
// gives the canvas (app/canvasPng.ts) and withDpi gives its PNG the figure's dpi.
import { pySplit, pyFloatText } from '../../py/pystr'
import { pyMod } from '../../py/pynum'
import { crc32 } from '../../files/zip'
import * as P from './palette'
import type { Scene } from './scene'
import { PANEL_GAP, panelsSize } from './svg'

/** A path: a rect's four corners, a circle's center then radii, or a line's points, in display pixels
 * (y up); the line width and dashes in points; colors as #rrggbbaa; the clip box (x0, y0, x1, y1). */
export interface PathOp {
  readonly k: 'rect' | 'circle' | 'line'
  readonly p: readonly (readonly [number, number])[]
  readonly lw: number
  readonly ec: string
  readonly fc: string | null
  readonly dash: readonly [number, readonly number[]] | null
  readonly cap: 'butt' | 'projecting'
  readonly join: 'miter' | 'round'
  readonly clip: readonly [number, number, number, number] | null
}

/** A text, baseline-anchored at `at` (display pixels, y up), rotated about it by `rot` degrees
 * counterclockwise; its size in points. */
export interface TextOp {
  readonly k: 'text'
  readonly s: string
  readonly at: readonly [number, number]
  readonly ha: 'left' | 'center' | 'right'
  readonly rot: number
  readonly size: number
  readonly bold: boolean
  readonly color: string
}

export type RasterOp = PathOp | TextOp

export interface Raster {
  /** the figure in display pixels (its size in inches times the dpi) */
  readonly width: number
  readonly height: number
  /** the canvas: whole pixels, as Agg truncates */
  readonly pixels: readonly [number, number]
  readonly dpi: number
  readonly ops: readonly RasterOp[]
}

/** raster._FONTS, as a CSS font family */
export const FONTS = '"Segoe UI", "DejaVu Sans", Arial, sans-serif'
const ANCHOR: Record<string, TextOp['ha']> = { start: 'left', middle: 'center', end: 'right' }
/** 72 / 96: scene pixels to points */
const PT = 72.0 / 96.0

const hex2 = (v: number): string => v.toString(16).padStart(2, '0')

/** matplotlib's to_hex(to_rgba(c), keep_alpha=True), for the colors scenes use. */
export function rgbaHex(c: string): string {
  const s = c.toLowerCase()
  if (s === 'none' || s === 'transparent') return '#00000000'
  if (s === 'white') return '#ffffffff'
  if (s === 'black') return '#000000ff'
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s)
  if (m) return `#${m[1]}${m[2] ?? 'ff'}`
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(s)
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}${m[4] ? m[4] + m[4] : 'ff'}`
  throw new Error(`ValueError: Invalid RGBA argument: '${c}'`)
}

const transparent = (hex: string): boolean => hex.endsWith('00')

/** raster._dash: the dash numbers, or null for a solid line */
function dashNums(d: string | null): number[] | null {
  if (!d) return null
  return pySplit(d.replaceAll(',', ' ')).map((x) => pyFloatText(x))
}

/** lines._get_dash_pattern then _scale_dashes: the pattern in points for a line width */
function dashPattern(nums: number[] | null, lw: number): [number, number[]] | null {
  if (nums === null) return null
  let offset = 0
  const dsum = nums.reduce((a, b) => a + b, 0)
  if (dsum) offset = pyMod(offset, dsum)
  return [offset * lw, nums.map((x) => x * lw)]
}

/** An axes' data transform (xlim 0..width, ylim height..0 into the axes box): x' = a x + e, y' = d y + f */
interface Affine { a: number, d: number, e: number, f: number }

function dataTransform(box: readonly [number, number, number, number], sw: number, sh: number): Affine {
  // BboxTransformTo(axes box) after BboxTransformFrom(view limits), multiplied as numpy does
  const [outl, outb] = box
  const outw = box[2] - box[0]
  const outh = box[3] - box[1]
  const invW = 1.0 / (sw - 0.0)
  const invH = 1.0 / (0.0 - sh)
  const tx = -0.0 * invW
  const ty = -sh * invH
  return { a: outw * invW, d: outh * invH, e: outw * tx + 0.0 * ty + outl, f: 0.0 * tx + outh * ty + outb }
}

const at = (t: Affine, x: number, y: number): [number, number] => [t.a * x + t.e, t.d * y + t.f]

/** One panel's ops, as Axes.draw orders them: by zorder, then as added. */
function panelOps(sc: Scene, box: readonly [number, number, number, number]): RasterOp[] {
  const t = dataTransform(box, sc.width, sc.height)
  const clip = box
  const ops: { z: number, op: RasterOp | null }[] = []
  for (const it of sc.items) {
    if (it.role === 'hit') continue
    if (it.kind === 'circle' || it.kind === 'rect') {
      const fill = it.fill === null || it.fill === 'none' || it.fill === 'transparent' ? null : rgbaHex(it.fill)
      const ec = rgbaHex(it.stroke || 'none')
      const lw = it.stroke ? it.width * PT : 0
      const common = { lw: transparent(ec) ? 0.0 : lw, ec, fc: fill !== null && !transparent(fill) ? fill : null, cap: 'butt' as const,
        join: 'miter' as const, clip }
      if (it.kind === 'circle') {
        const c = at(t, it.cx, it.cy)
        ops.push({ z: 3, op: { k: 'circle', p: [c, [t.a * it.r, t.d * it.r]], dash: null, ...common } })
      } else {
        const x1 = it.x + it.w
        const y1 = it.y + it.h
        ops.push({ z: 2, op: { k: 'rect', p: [at(t, it.x, it.y), at(t, x1, it.y), at(t, x1, y1), at(t, it.x, y1)],
          dash: dashPattern(dashNums(it.dash), lw), ...common } })
      }
    } else if (it.kind === 'line') {
      const lw = it.width * PT
      const dash = dashPattern(dashNums(it.dash), lw)
      ops.push({ z: it.role === 'grid' || it.role === 'axis' ? 2 : 3, op: it.points.length ? {
        k: 'line', p: it.points.map(([x, y]) => at(t, x, y)), lw, ec: rgbaHex(it.stroke), fc: null, dash,
        cap: dash ? 'butt' : 'projecting', join: 'round', clip } : null })
    } else {
      ops.push({ z: 4, op: it.text === '' ? null : {
        k: 'text', s: it.text, at: at(t, it.x, it.y), ha: ANCHOR[it.anchor] ?? 'left',
        rot: it.rotate ? pyMod(-it.rotate, 360) : 0.0, size: it.size * PT, bold: it.weight === 'bold', color: rgbaHex(it.color) } })
    }
  }
  // Array.prototype.sort is stable
  return ops.sort((p, q) => p.z - q.z).flatMap(({ op }) => (op ? [op] : []))
}

/** render_png_panels' figure: the panels side by side, tops aligned, each under its "(A)" label. */
export function rasterOps(scenes: readonly Scene[], labels: readonly string[] = [], dpi = 300, gap = PANEL_GAP): Raster {
  const [width, height, head] = panelsSize(scenes, labels, gap)
  const W = (width / 96.0) * dpi
  const H = (height / 96.0) * dpi
  const ops: RasterOp[] = [{ k: 'rect', p: [[0, 0], [W, 0], [W, H], [0, H]], lw: 0.0, ec: '#ffffffff', fc: '#ffffffff', dash: null,
    cap: 'butt', join: 'miter', clip: null }]
  const texts: TextOp[] = []
  let x = 0.0
  for (const [k, sc] of scenes.entries()) {
    // fig.add_axes((left, bottom, width, height)) in figure fractions, then to pixels
    const left = x / width
    const bottom = (height - head - sc.height) / height
    const box = [left * W, bottom * H, (left + sc.width / width) * W, (bottom + sc.height / height) * H] as const
    ops.push(...panelOps(sc, box))
    if (head && k < labels.length && labels[k]) {
      texts.push({ k: 'text', s: labels[k], at: [((x + 4) / width) * W, (1 - 13 / height) * H], ha: 'left', rot: 0.0, size: 11 * PT,
        bold: true, color: rgbaHex(P.TEXT) })
    }
    x += sc.width + gap
  }
  // the figure draws its axes (zorder 0) before its texts (zorder 3)
  ops.push(...texts)
  return { width: W, height: H, pixels: [Math.trunc(W), Math.trunc(H)], dpi, ops }
}

// ---------------------------------------------------------------- painting

/** matplotlib's unit circle: eight cubic Bezier arcs (Path.circle) */
const UNIT_CIRCLE: readonly (readonly [number, number])[] = (() => {
  const MAGIC = 0.2652031
  const SQRTHALF = Math.sqrt(0.5)
  const MAGIC45 = SQRTHALF * MAGIC
  return [[0.0, -1.0],
    [MAGIC, -1.0], [SQRTHALF - MAGIC45, -SQRTHALF - MAGIC45], [SQRTHALF, -SQRTHALF],
    [SQRTHALF + MAGIC45, -SQRTHALF + MAGIC45], [1.0, -MAGIC], [1.0, 0.0],
    [1.0, MAGIC], [SQRTHALF + MAGIC45, SQRTHALF - MAGIC45], [SQRTHALF, SQRTHALF],
    [SQRTHALF - MAGIC45, SQRTHALF + MAGIC45], [MAGIC, 1.0], [0.0, 1.0],
    [-MAGIC, 1.0], [-SQRTHALF + MAGIC45, SQRTHALF + MAGIC45], [-SQRTHALF, SQRTHALF],
    [-SQRTHALF - MAGIC45, SQRTHALF - MAGIC45], [-1.0, MAGIC], [-1.0, 0.0],
    [-1.0, -MAGIC], [-SQRTHALF - MAGIC45, -SQRTHALF + MAGIC45], [-SQRTHALF, -SQRTHALF],
    [-SQRTHALF + MAGIC45, -SQRTHALF - MAGIC45], [-MAGIC, -1.0], [0.0, -1.0]]
})()

/** The 2D context paint needs (a canvas's or an offscreen canvas's). */
export type Context2D = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'bezierCurveTo'
  | 'closePath' | 'rect' | 'clip' | 'fill' | 'stroke' | 'setLineDash' | 'fillText' | 'translate' | 'rotate' | 'fillStyle'
  | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'lineDashOffset' | 'font' | 'textAlign' | 'textBaseline'>

/** mpl_round: half away from zero */
const mplRound = (v: number): number => Math.trunc(v + (v >= 0 ? 0.5 : -0.5))

/** Draw the ops on a canvas of r.pixels, as Agg draws them. */
export function paint(ctx: Context2D, r: Raster): void {
  const [wpx, hpx] = r.pixels
  const px = (pt: number): number => (pt * r.dpi) / 72.0
  for (const op of r.ops) {
    ctx.save()
    if (op.k === 'text') {
      // Text.draw flips y at the renderer's height before rounding: the figure's, not the canvas's
      ctx.translate(op.at[0], r.height - op.at[1])
      if (op.rot) ctx.rotate((-op.rot * Math.PI) / 180)
      ctx.font = `${op.bold ? 'bold ' : ''}${px(op.size)}px ${FONTS}`
      ctx.textAlign = op.ha
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = op.color
      ctx.fillText(op.s, 0, 0)
      ctx.restore()
      continue
    }
    if (op.clip) {
      // RendererAgg::set_clipbox: whole pixels
      const x0 = Math.max(Math.floor(op.clip[0] + 0.5), 0)
      const x1 = Math.min(Math.floor(op.clip[2] + 0.5), wpx)
      const ya = Math.max(Math.floor(hpx - op.clip[1] + 0.5), 0)
      const yb = Math.min(Math.floor(hpx - op.clip[3] + 0.5), hpx)
      ctx.beginPath()
      ctx.rect(Math.min(x0, x1), Math.min(ya, yb), Math.abs(x1 - x0), Math.abs(yb - ya))
      ctx.clip()
    }
    const lw = px(op.lw)
    ctx.beginPath()
    if (op.k === 'circle') {
      const [[cx, cy], [rx, ry]] = op.p
      const v = UNIT_CIRCLE.map(([u, w]) => [cx + rx * u, hpx - (cy + ry * w)] as const)
      ctx.moveTo(v[0][0], v[0][1])
      for (let i = 1; i + 2 < v.length; i += 3) ctx.bezierCurveTo(v[i][0], v[i][1], v[i + 1][0], v[i + 1][1], v[i + 2][0], v[i + 2][1])
      ctx.closePath()
    } else {
      let v = op.p.map(([x, y]) => [x, hpx - y] as const)
      // PathSnapper: straight horizontal and vertical segments snap to pixel centers (odd widths) or edges
      const rectilinear = v.length <= 1024 && v.every((p, i) => i === 0
        || Math.abs(p[0] - v[i - 1][0]) < 1e-4 || Math.abs(p[1] - v[i - 1][1]) < 1e-4)
      if (rectilinear) {
        const snap = transparent(op.ec) ? 0 : mplRound(lw) % 2 ? 0.5 : 0.0
        v = v.map(([x, y]) => [Math.floor(x + 0.5) + snap, Math.floor(y + 0.5) + snap] as const)
      }
      ctx.moveTo(v[0][0], v[0][1])
      for (const [x, y] of v.slice(1)) ctx.lineTo(x, y)
      if (op.k === 'rect') ctx.closePath()
    }
    if (op.fc !== null) {
      ctx.fillStyle = op.fc
      ctx.fill()
    }
    if (op.lw !== 0) {
      ctx.strokeStyle = op.ec
      ctx.lineWidth = lw
      ctx.lineCap = op.cap === 'projecting' ? 'square' : 'butt'
      ctx.lineJoin = op.join
      if (op.dash) {
        ctx.setLineDash(op.dash[1].map(px))
        ctx.lineDashOffset = px(op.dash[0])
      }
      ctx.stroke()
    }
    ctx.restore()
  }
}

// ---------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A PNG's chunks: [type, data]. */
export function pngChunks(png: Uint8Array): [string, Uint8Array][] {
  if (!PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error('not a PNG file')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: [string, Uint8Array][] = []
  let pos = 8
  while (pos + 8 <= png.length) {
    const n = view.getUint32(pos)
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8))
    out.push([type, png.subarray(pos + 8, pos + 8 + n)])
    pos += 12 + n
  }
  return out
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** The PNG with only IHDR, a pHYs of the dpi (Pillow's pixels per meter), IDAT and IEND, as
 * matplotlib's PNG has them (less its Software text). */
export function withDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.trunc(dpi / 0.0254 + 0.5)
  const phys = new Uint8Array(9)
  const view = new DataView(phys.buffer)
  view.setUint32(0, ppm)
  view.setUint32(4, ppm)
  phys[8] = 1
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIGNATURE)]
  for (const [type, data] of pngChunks(png)) {
    if (type === 'IHDR') parts.push(chunk(type, data), chunk('pHYs', phys))
    else if (type === 'IDAT' || type === 'IEND') parts.push(chunk(type, data))
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}

/** A PNG's pixel size and pixels per meter (IHDR and pHYs), as python-docx reads them. */
export function pngInfo(png: Uint8Array): { width: number, height: number, ppm: number | null } {
  const chunks = new Map(pngChunks(png).reverse())
  const ihdr = chunks.get('IHDR')
  if (!ihdr) throw new Error('no IHDR chunk')
  const head = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
  const phys = chunks.get('pHYs')
  const ppm = phys && phys[8] === 1 ? new DataView(phys.buffer, phys.byteOffset, 9).getUint32(0) : null
  return { width: head.getUint32(0), height: head.getUint32(4), ppm }
}

/** Makes a figure's PNG from its draw calls: a canvas in the page layer, a stand-in in the tests. */
export type PngMaker = (r: Raster) => Promise<Uint8Array>

/** render_png_panels: the figure's PNG at a dpi. */
export function renderPngPanels(scenes: readonly Scene[], labels: readonly string[], dpi: number, png: PngMaker): Promise<Uint8Array> {
  return png(rasterOps(scenes, labels, dpi))
}
