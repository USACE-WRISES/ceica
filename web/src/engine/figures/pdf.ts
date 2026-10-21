// Scenes as reportlab vector drawings, for the PDF report (ceica/figures/pdf.py).
import { Color, HexColor } from '../../files/pdf/colors'
import { Circle, Drawing, Group, PolyLine, Rect, StringShape } from '../../files/pdf/graphics'
import { pyFloatText, pySplit } from '../../py/pystr'
import type { Scene } from './scene'

/** reportlab's transparent: black with alpha 0 */
const TRANSPARENT = new Color(0, 0, 0, 0)

function c(v: string | null): Color | null {
  if (v === null || v === 'none') return null
  if (v === 'transparent') return TRANSPARENT
  return HexColor(v)
}

function dash(d: string | null): number[] | null {
  if (!d) return null
  return pySplit(d.replaceAll(',', ' ')).map((x) => pyFloatText(x))
}

/** The scene scaled to ``widthPt`` points wide (y flipped: reportlab's origin is bottom left). */
export function toDrawing(scene: Scene, widthPt: number): Drawing {
  const s = widthPt / scene.width
  const H = scene.height
  const d = new Drawing(scene.width * s, H * s)
  const g = new Group()
  for (const it of scene.items) {
    if (it.role === 'hit') continue
    if (it.kind === 'circle') {
      const fill = c(it.fill)
      g.add(new Circle(it.cx, H - it.cy, it.r, { fillColor: fill !== null ? fill : null, strokeColor: c(it.stroke),
        strokeWidth: it.stroke ? it.width : 0 }))
    } else if (it.kind === 'rect') {
      g.add(new Rect(it.x, H - it.y - it.h, it.w, it.h, { fillColor: c(it.fill), strokeColor: c(it.stroke), strokeWidth: it.stroke ? it.width : 0,
        strokeDashArray: dash(it.dash) }))
    } else if (it.kind === 'line') {
      const pts: number[] = []
      for (const [x, y] of it.points) pts.push(x, H - y)
      g.add(new PolyLine(pts, { strokeColor: c(it.stroke), strokeWidth: it.width, strokeDashArray: dash(it.dash), strokeLineJoin: 1 }))
    } else {
      const font = it.weight === 'bold' ? 'Helvetica-Bold' : 'Helvetica'
      const kw = { fontName: font, fontSize: it.size, fillColor: c(it.color), textAnchor: anchor(it.anchor) }
      if (it.rotate) {
        const sub = new Group(new StringShape(0, 0, it.text, kw))
        sub.translate(it.x, H - it.y)
        sub.rotate(-it.rotate)
        g.add(sub)
      } else g.add(new StringShape(it.x, H - it.y, it.text, kw))
    }
  }
  g.scale(s, s)
  d.add(g)
  return d
}

function anchor(a: string): string {
  if (a !== 'start' && a !== 'middle' && a !== 'end') throw new Error(`KeyError: '${a}'`)
  return a
}
