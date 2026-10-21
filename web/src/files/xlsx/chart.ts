// The calculator's scatter charts, as openpyxl 3.1.5 writes them from workbook/export.py's _chart, _series
// and _marks: a scatter chart with straight lines, a title and axis titles in the app's colors, light
// gridlines on the cost axis, muted axes, the legend above the plot. Every setting the export makes
// explicitly is written as openpyxl writes it (both axes keep openpyxl's default position, "l").
import { escAttr, escText } from '../xml'
import type { Chart } from './book'

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

/** colors of ceica/figures/palette.py the charts use */
export const NAVY = '2F4B7C'
export const MUTED = '7A8699'
export const DECISION = '1A7F37'
const TEXT = '33415C'
const TEXT_MUTED = '646F80'
const GRID = 'E5E8EE'
const AXIS = '98A1B3'

const solid = (hex: string): string => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`

/** CharacterProperties(sz=round(size * 100), b=bold, solidFill=color) */
const chars = (tag: string, size: number, color: string, bold: boolean): string =>
  `<a:${tag} sz="${Math.round(size * 100)}" b="${bold ? 1 : 0}">${solid(color)}</a:${tag}>`

/** LineProperties(solidFill=color, w=round(width_pt * 12700)) */
const stroke = (color: string, widthPt: number): string =>
  `<a:ln ${A} w="${Math.round(widthPt * 12700)}">${solid(color)}<a:prstDash val="solid"/></a:ln>`

function title(text: string, size: number, color: string, bold: boolean): string {
  return `<title><tx><rich><a:bodyPr ${A}/><a:p ${A}><a:pPr>${chars('defRPr', size, color, bold)}</a:pPr><a:r>${chars('rPr', size, color, bold)}`
    + `<a:t>${escText(text, true)}</a:t></a:r></a:p></rich></tx><overlay val="0"/></title>`
}

/** _rich: a text body for the axes' tick labels and the legend */
const rich = (size: number, color: string): string => `<txPr><a:bodyPr ${A}/><a:p ${A}><a:pPr>${chars('defRPr', size, color, false)}</a:pPr>`
  + `<a:r><a:t></a:t></a:r>${chars('endParaRPr', size, color, false)}</a:p></txPr>`

/** Circles (_marks): filled with ``fill``, or rings when it is null; or no marker at all. */
export type Marker = { size: number, stroke: string, width: number, fill: string | null } | 'none'

export interface Series {
  readonly name: string
  /** the x and y references ('Sheet'!$A$1:$A$9) */
  readonly x: string
  readonly y: string
  /** the series' line, or none (noFill) */
  readonly line: { color: string, width: number } | null
  readonly marker: Marker
}

function seriesXml(s: Series, k: number): string {
  const line = s.line ? stroke(s.line.color, s.line.width) : `<a:ln ${A}><a:noFill/><a:prstDash val="solid"/></a:ln>`
  const m = s.marker
  const marker = m === 'none' ? `<marker><symbol val="none"/><spPr><a:ln ${A}><a:prstDash val="solid"/></a:ln></spPr></marker>`
    : `<marker><symbol val="circle"/><size val="${m.size}"/><spPr>${m.fill ? `<a:solidFill ${A}><a:srgbClr val="${m.fill}"/></a:solidFill>` : `<a:noFill ${A}/>`}`
      + `${stroke(m.stroke, m.width)}</spPr></marker>`
  return `<ser><idx val="${k}"/><order val="${k}"/><tx><v>${escText(s.name, true)}</v></tx><spPr>${line}</spPr>${marker}`
    + `<xVal><numRef><f>${escText(s.x, true)}</f></numRef></xVal><yVal><numRef><f>${escText(s.y, true)}</f></numRef></yVal><smooth val="0"/></ser>`
}

function axis(id: number, cross: number, label: string, format: string, gridlines: boolean): string {
  return `<valAx><axId val="${id}"/><scaling><orientation val="minMax"/></scaling><delete val="0"/><axPos val="l"/>`
    + (gridlines ? `<majorGridlines><spPr>${stroke(GRID, 0.75)}</spPr></majorGridlines>` : '')
    + `${title(label, 9, TEXT_MUTED, false)}<numFmt formatCode="${escAttr(format, true)}" sourceLinked="0"/><majorTickMark val="out"/>`
    + `<minorTickMark val="none"/><spPr>${stroke(AXIS, 0.75)}</spPr>${rich(8, TEXT_MUTED)}<crossAx val="${cross}"/></valAx>`
}

/** A scatter chart in the app's look (_chart), its series, anchored at a cell: 16 x 9.5 cm. */
export function scatterChart(o: { title: string, xLabel: string, yLabel: string, yFormat: string, series: readonly Series[], anchor: string }): Chart {
  return {
    anchor: o.anchor,
    cx: 16 * 360000,
    cy: 9.5 * 360000,
    xml: () => '<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"><roundedCorners val="0"/><chart>'
      + `${title(o.title, 11, TEXT, true)}<plotArea><scatterChart><scatterStyle val="lineMarker"/><varyColors val="0"/>`
      + `${o.series.map(seriesXml).join('')}<axId val="10"/><axId val="20"/></scatterChart>`
      + `${axis(10, 20, o.xLabel, 'General', false)}${axis(20, 10, o.yLabel, o.yFormat, true)}</plotArea>`
      + `<legend><legendPos val="t"/><overlay val="0"/>${rich(8, TEXT)}</legend><plotVisOnly val="1"/><dispBlanksAs val="gap"/></chart>`
      + `<spPr>${stroke(GRID, 0.75)}</spPr></chartSpace>`,
  }
}

/** openpyxl's Reference: the sheet quoted, the cells absolute */
export function reference(sheet: string, col: string, r1: number, r2: number): string {
  return r1 === r2 ? `'${sheet}'!$${col}$${r1}` : `'${sheet}'!$${col}$${r1}:$${col}$${r2}`
}
