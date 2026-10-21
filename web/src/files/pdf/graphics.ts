// reportlab's graphics as the report's figures use them (graphics/shapes.py, transform.py, renderbase.py,
// renderPDF.py): a Drawing (a flowable) holding Groups with transforms, and Circles, Rects, PolyLines and
// Strings, drawn onto the canvas as renderPDF draws them.
//
// The operators' order is reportlab's: a shape's state changes come in the order its attributes were set
// (its __dict__), the renderer starts from STATE_DEFAULTS (Times-Roman 10, so that font is always in the
// file), and every node is drawn inside its own q ... Q.
import { type Canvas } from './canvas'
import { Color } from './colors'
import { stringWidth } from './fonts'
import { Flowable } from './flowables'

export type Transform = readonly [number, number, number, number, number, number]
type Value = unknown

const radians = (angle: number): number => angle * (Math.PI / 180)

export const nullTransform = (): Transform => [1, 0, 0, 1, 0, 0]
export const translate = (dx: number, dy = 0): Transform => [1, 0, 0, 1, dx, dy]
export const scale = (sx: number, sy = 1): Transform => [sx, 0, 0, sy, 0, 0]
export function rotate(angle: number, cx = 0, cy = 0): Transform {
  const a = radians(angle)
  const sina = Math.sin(a)
  const cosa = Math.cos(a)
  return [cosa, sina, -sina, cosa, cx, cy]
}

/** mmult: A postmultiplied by B */
export function mmult(A: Transform, B: Transform): Transform {
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]]
}

const BLACK = new Color(0, 0, 0)

/** STATE_DEFAULTS, in reportlab's order */
const STATE_DEFAULTS: [string, Value][] = [
  ['transform', [1, 0, 0, 1, 0, 0]], ['strokeColor', BLACK], ['strokeWidth', 1], ['strokeLineCap', 0], ['strokeLineJoin', 0],
  ['strokeMiterLimit', 10], ['strokeDashArray', null], ['strokeOpacity', null], ['fillOpacity', null], ['fillOverprint', false],
  ['strokeOverprint', false], ['overprintMask', 0], ['fillColor', BLACK], ['fillMode', 0], ['fontSize', 10], ['fontName', 'Times-Roman'],
  ['textAnchor', 'start'],
]
const STATE_KEYS = new Set(STATE_DEFAULTS.map(([k]) => k))

/** A node: its public attributes in the order they were set (shapes.py keeps them in __dict__). */
export abstract class Shape {
  readonly props = new Map<string, Value>()

  /** setProperties: an attribute already there keeps its place */
  setProperties(kw: Record<string, Value>): void {
    for (const [k, v] of Object.entries(kw)) this.props.set(k, v)
  }

  get(k: string): any {
    return this.props.get(k)
  }
}

/** LineShape.__init__ */
function lineShape(s: Shape): void {
  s.props.set('strokeColor', BLACK)
  s.props.set('strokeWidth', 1)
  s.props.set('strokeLineCap', 0)
  s.props.set('strokeLineJoin', 0)
  s.props.set('strokeMiterLimit', 0)
  s.props.set('strokeDashArray', null)
  s.props.set('strokeOpacity', null)
}

/** SolidShape.__init__ */
function solidShape(s: Shape): void {
  s.props.set('fillColor', BLACK)
  s.props.set('fillOpacity', null)
  lineShape(s)
}

export class Group extends Shape {
  constructor(...elements: Shape[]) {
    super()
    this.props.set('contents', [])
    this.props.set('transform', nullTransform())
    for (const e of elements) this.add(e)
  }

  get contents(): Shape[] {
    return this.props.get('contents') as Shape[]
  }

  add(node: Shape | null): void {
    if (node !== null) this.contents.push(node)
  }

  private apply(t: Transform): void {
    this.props.set('transform', mmult(this.props.get('transform') as Transform, t))
  }

  rotate(theta: number, cx = 0, cy = 0): void {
    this.apply(rotate(theta, cx, cy))
  }

  translate(dx: number, dy = 0): void {
    this.apply(translate(dx, dy))
  }

  scale(sx: number, sy = 1): void {
    this.apply(scale(sx, sy))
  }
}

export class Rect extends Shape {
  constructor(x: number, y: number, width: number, height: number, kw: Record<string, Value> = {}) {
    super()
    solidShape(this)
    this.setProperties(kw)
    for (const [k, v] of [['x', x], ['y', y], ['width', width], ['height', height], ['rx', 0], ['ry', 0]] as const) this.props.set(k, v)
  }
}

export class Circle extends Shape {
  constructor(cx: number, cy: number, r: number, kw: Record<string, Value> = {}) {
    super()
    solidShape(this)
    this.setProperties(kw)
    this.props.set('cx', cx)
    this.props.set('cy', cy)
    this.props.set('r', r)
  }
}

export class PolyLine extends Shape {
  constructor(points: number[], kw: Record<string, Value> = {}) {
    super()
    lineShape(this)
    this.setProperties(kw)
    if (points.length % 2) throw new Error('Point list must have even number of elements!')
    this.props.set('points', points)
  }
}

export class StringShape extends Shape {
  constructor(x: number, y: number, text: string, kw: Record<string, Value> = {}) {
    super()
    for (const [k, v] of [['x', x], ['y', y], ['text', text], ['textAnchor', 'start'], ['fontName', 'Times-Roman'], ['fontSize', 10],
      ['fillColor', BLACK]] as const) this.props.set(k, v)
    this.setProperties(kw)
  }
}

/** Drawing: the outermost group, a flowable of its own size. */
export class Drawing extends Flowable {
  readonly group: Group

  constructor(width: number, height: number) {
    super()
    // background, then Group.__init__ (contents, transform), then the size and alignment
    this.group = new Group()
    this.width = width
    this.height = height
    this.hAlign = 'LEFT'
  }

  add(node: Shape): void {
    this.group.add(node)
  }

  wrap(): [number, number] {
    return [this.width, this.height]
  }

  draw(): void {
    new PDFRenderer().draw(this, this.canv!, 0, 0)
  }
}

/** StateTracker: the combined state at each depth */
class StateTracker {
  private combined: Map<string, Value>[] = []

  constructor() {
    const defaults = new Map<string, Value>(STATE_DEFAULTS.map(([k, v]) => [k, v]))
    defaults.set('ctm', defaults.get('transform'))
    this.combined.push(defaults)
  }

  get top(): Map<string, Value> {
    return this.combined[this.combined.length - 1]
  }

  push(delta: Map<string, Value>): void {
    const next = new Map(this.top)
    for (const [k, v] of delta) {
      if (k === 'transform') {
        next.set('transform', v)
        next.set('ctm', mmult(this.top.get('ctm') as Transform, v as Transform))
      } else next.set(k, v)
    }
    this.combined.push(next)
  }

  pop(): void {
    this.combined.pop()
  }
}

/** getStateDelta: the node's attributes that are graphics state, in its order */
function stateDelta(node: Shape | Drawing): Map<string, Value> {
  const props = node instanceof Drawing ? node.group.props : node.props
  const delta = new Map<string, Value>()
  for (const [k, v] of props) if (STATE_KEYS.has(k)) delta.set(k, v)
  return delta
}

/** renderPDF._PDFRenderer */
class PDFRenderer {
  private stroke = 0
  private fill = 0
  private tracker!: StateTracker
  private canvas!: Canvas

  draw(drawing: Drawing, canvas: Canvas, x: number, y: number): void {
    this.tracker = new StateTracker()
    this.canvas = canvas
    canvas.saveState()
    // initState: the defaults, the transform moved to (x, y), pushed and applied
    const deltas = this.tracker.top
    deltas.set('transform', [...(deltas.get('transform') as Transform).slice(0, 4), x, y] as unknown as Transform)
    this.tracker.push(deltas)
    this.applyStateChanges(deltas)
    this.drawNode(drawing)
    this.tracker.pop()
    canvas.restoreState()
  }

  private drawNode(node: Shape | Drawing): void {
    this.canvas.saveState()
    const deltas = stateDelta(node)
    this.tracker.push(deltas)
    this.applyStateChanges(deltas)
    this.dispatch(node)
    this.tracker.pop()
    this.canvas.restoreState()
  }

  private dispatch(node: Shape | Drawing): void {
    if (node instanceof StringShape) this.drawString(node)
    else if (node instanceof Drawing) this.drawGroup(node.group)
    else if (node instanceof Group) this.drawGroup(node)
    else if (node instanceof Rect) this.drawRect(node)
    else if (node instanceof Circle) this.drawCircle(node)
    else if (node instanceof PolyLine) this.drawPolyLine(node)
    else throw new Error('DrawingError: unexpected element')
  }

  private drawGroup(group: Group): void {
    for (const node of group.contents) this.drawNode(node)
  }

  private drawRect(rect: Rect): void {
    if (rect.get('rx') === 0 && rect.get('ry') === 0) {
      this.canvas.rect(rect.get('x'), rect.get('y'), rect.get('width'), rect.get('height'), this.stroke, this.fill)
    } else throw new Error('round rectangles are not ported')
  }

  private drawCircle(circle: Circle): void {
    this.canvas.circle(circle.get('cx'), circle.get('cy'), circle.get('r'), this.stroke, this.fill)
  }

  private drawPolyLine(polyline: PolyLine): void {
    if (!this.stroke) return
    const points = polyline.get('points') as number[]
    if (points.length < 2) throw new Error('Polyline must have 2 or more points')
    const path = this.canvas.beginPath()
    path.moveTo(points[0], points[1])
    for (let i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1])
    this.canvas.drawPath(path)
  }

  private drawString(s: StringShape): void {
    // text render mode 0: filled
    if (!this.fill) return
    const S = this.tracker.top
    const anchor = S.get('textAnchor') as string
    let x = s.get('x') as number
    const text = s.get('text') as string
    if (anchor !== 'start' && anchor !== 'inherited') {
      const textLen = stringWidth(text, S.get('fontName') as string, S.get('fontSize') as number)
      if (anchor === 'end') x -= textLen
      else if (anchor === 'middle') x -= textLen * 0.5
      else throw new Error(`bad value for textAnchor ${anchor}`)
    }
    this.canvas.drawString(x, s.get('y'), text)
  }

  /** applyStateChanges: the operators each changed attribute needs, in the delta's order */
  private applyStateChanges(delta: Map<string, Value>): void {
    const c = this.canvas
    for (const [key, value] of delta) {
      if (key === 'transform') {
        const t = value as Transform
        c.transform(t[0], t[1], t[2], t[3], t[4], t[5])
      } else if (key === 'strokeColor') {
        if (value === null) this.stroke = 0
        else {
          this.stroke = 1
          c.setStrokeColor(value as Color)
        }
      } else if (key === 'strokeWidth') c.setLineWidth(value as number)
      else if (key === 'strokeLineCap') c.setLineCap(value as number)
      else if (key === 'strokeLineJoin') c.setLineJoin(value as number)
      else if (key === 'strokeDashArray') {
        if (value && (value as number[]).length) c.setDash(value as number[], 0)
        else c.setDash()
      } else if (key === 'fillColor') {
        if (value === null) this.fill = 0
        else {
          this.fill = 1
          c.setFillColor(value as Color)
        }
      } else if (key === 'fontSize' || key === 'fontName') {
        const name = delta.has('fontName') ? delta.get('fontName') as string : c.fontname
        const size = delta.has('fontSize') ? delta.get('fontSize') as number : c.fontsize
        c.setFont(name, size)
      } else if (key === 'fillOpacity' || key === 'strokeOpacity') {
        if (value !== null) c.setAlpha(key === 'fillOpacity' ? 'fill' : 'stroke', value as number)
      } else if (key === 'fillOverprint' || key === 'strokeOverprint' || key === 'overprintMask') {
        // their defaults (off) change no graphics state
        if (value) throw new Error('overprinting is not ported')
      } else if (key === 'fillMode') c.fillMode = value as number
    }
  }
}
