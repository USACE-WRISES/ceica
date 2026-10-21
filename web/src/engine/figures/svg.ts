// Scenes as SVG: the app's charts and the figure downloads (ceica/figures/svg.py).
//
// Presentation attributes are inline (the same string works standalone); classes and data-key
// attributes let the app highlight a plan everywhere it appears. Every figure is role="img" with a
// title and description; tooltips are data-tip (app) and <title> (standalone). renderPanels puts a
// figure's panels side by side in one standalone file.
import { pyFixed } from '../../py/pyfmt'
import { pySum } from '../../py/pynum'
import * as P from './palette'
import type { Item, Scene } from './scene'

export const FONT_FAMILY = 'Instrument Sans, Segoe UI, Helvetica, Arial, sans-serif'
/** Space between panels, and the band above them that holds the "(A)" labels. */
export const PANEL_GAP = 16.0
export const PANEL_HEAD = 18.0

/** Python's html.escape(s, quote=True). */
export function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

/** A coordinate: f"{v:.1f}" without trailing zeros, or the whole number. */
export function f1(v: number): string {
  if (v === Math.trunc(v)) return Math.abs(v) < 1e21 ? String(Math.trunc(v) + 0) : BigInt(v).toString()
  return pyFixed(v, 1).replace(/0+$/, '').replace(/\.$/, '')
}

/** Attributes in order, None left out: class_ is class, data_key is data-key. */
function attrs(kw: [string, string | null | undefined][]): string {
  return kw.filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k.replace(/_+$/, '').replace(/_/g, '-')}="${escape(String(v))}"`).join(' ')
}

const tipText = (tip: readonly string[] | undefined): string => (tip && tip.length ? tip.join('\n') : '')

/** The marks. Without interaction, hit areas, data-key and data-tip are left out. */
function body(scene: Scene, interactive = true): string {
  const parts: string[] = []
  for (const it of scene.items) {
    if (!interactive && it.role === 'hit') continue
    const common: [string, string | null][] = [['class_', it.role ? `m-${it.role}` : null], ['data_key', interactive ? it.key : null]]
    const tip = interactive && 'tip' in it ? tipText(it.tip) : ''
    if (tip) common.push(['data_tip', tip])
    parts.push(mark(it, common, tip))
  }
  return parts.join('')
}

function mark(it: Item, common: [string, string | null][], tip: string): string {
  if (it.kind === 'circle') {
    const a = attrs([['cx', f1(it.cx)], ['cy', f1(it.cy)], ['r', f1(it.r)], ['stroke', it.stroke || 'none'],
      ['fill', it.fill || 'none'], ['stroke_width', it.stroke ? f1(it.width) : null], ...common])
    return tip && it.role === 'hit' ? `<circle ${a}><title>${escape(tip)}</title></circle>` : `<circle ${a}/>`
  }
  if (it.kind === 'rect') {
    const a = attrs([['x', f1(it.x)], ['y', f1(it.y)], ['width', f1(Math.max(it.w, 0))], ['height', f1(Math.max(it.h, 0))],
      ['fill', it.fill || 'none'], ['stroke', it.stroke || 'none'], ['stroke_width', it.stroke ? f1(it.width) : null],
      ['stroke_dasharray', it.dash], ...common])
    return tip && it.role === 'hit' ? `<rect ${a}><title>${escape(tip)}</title></rect>` : `<rect ${a}/>`
  }
  if (it.kind === 'line') {
    const pts = it.points.map(([x, y]) => `${f1(x)},${f1(y)}`).join(' ')
    const a = attrs([['points', pts], ['fill', 'none'], ['stroke', it.stroke], ['stroke_width', f1(it.width)],
      ['stroke_dasharray', it.dash], ['stroke_linejoin', 'round'], ...common])
    return `<polyline ${a}/>`
  }
  const tr = it.rotate ? `rotate(${f1(it.rotate)} ${f1(it.x)} ${f1(it.y)})` : null
  const a = attrs([['x', f1(it.x)], ['y', f1(it.y)], ['fill', it.color], ['font_size', f1(it.size)], ['text_anchor', it.anchor],
    ['font_weight', it.weight !== 'normal' ? it.weight : null], ['transform', tr], ...common])
  return `<text ${a}>${escape(it.text)}</text>`
}

export function render(scene: Scene, { id = null as string | null, cssClass = 'ce-chart', interactive = true } = {}): string {
  const tid = id ? `${id}-t` : null
  const did = id ? `${id}-d` : null
  const head = attrs([['xmlns', 'http://www.w3.org/2000/svg'], ['viewBox', `0 0 ${f1(scene.width)} ${f1(scene.height)}`],
    ['role', 'img'], ['class_', cssClass], ['id', id], ['aria_labelledby', id ? `${tid} ${did}` : null], ['font_family', FONT_FAMILY]])
  return `<svg ${head}>`
    + `<title${tid ? ` id="${tid}"` : ''}>${escape(scene.title)}</title>`
    + `<desc${did ? ` id="${did}"` : ''}>${escape(scene.desc)}</desc>`
    + `${body(scene, interactive)}</svg>`
}

/** (width, height, label band) of panels placed side by side, tops aligned. */
export function panelsSize(scenes: readonly Scene[], labels: readonly string[] = [], gap = PANEL_GAP): [number, number, number] {
  const head = scenes.length > 1 && labels.some((l) => l) ? PANEL_HEAD : 0.0
  const width = pySum(scenes.map((s) => s.width)) + gap * Math.max(scenes.length - 1, 0)
  const height = scenes.reduce((m, s) => (s.height > m ? s.height : m), 0.0) + head
  return [width, height, head]
}

/** One standalone SVG file: a white page with the panels side by side, tops aligned, each under its
 * "(A)" label. Width and height are set, so Office and browsers size it. */
export function renderPanels(scenes: readonly Scene[], labels: readonly string[] = [], { gap = PANEL_GAP,
  background = '#ffffff' } = {}): string {
  const [width, height, head] = panelsSize(scenes, labels, gap)
  const title = scenes.map((s) => s.title).join('; ')
  const desc = scenes.map((s) => s.desc).join(' ')
  const a = attrs([['xmlns', 'http://www.w3.org/2000/svg'], ['width', f1(width)], ['height', f1(height)],
    ['viewBox', `0 0 ${f1(width)} ${f1(height)}`], ['role', 'img'], ['font_family', FONT_FAMILY]])
  const parts = [`<svg ${a}>`, `<title>${escape(title)}</title>`, `<desc>${escape(desc)}</desc>`,
    `<rect x="0" y="0" width="${f1(width)}" height="${f1(height)}" fill="${background}"/>`]
  let x = 0.0
  for (const [k, sc] of scenes.entries()) {
    if (head && k < labels.length && labels[k]) {
      parts.push(`<text x="${f1(x + 4)}" y="13" font-size="11" font-weight="600" fill="${P.TEXT}">${escape(labels[k])}</text>`)
    }
    parts.push(`<svg x="${f1(x)}" y="${f1(head)}" width="${f1(sc.width)}" height="${f1(sc.height)}" `
      + `viewBox="0 0 ${f1(sc.width)} ${f1(sc.height)}">${body(sc, false)}</svg>`)
    x += sc.width + gap
  }
  parts.push('</svg>')
  return parts.join('')
}
