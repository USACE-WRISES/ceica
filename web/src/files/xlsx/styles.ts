// openpyxl 3.1.5's cell styles, as CEICA's workbooks use them: fonts, fills, borders, alignments,
// protections and number formats, numbered as openpyxl numbers them, and the stylesheet (xl/styles.xml)
// written as openpyxl writes it.
//
// openpyxl keeps each kind of style in an IndexedList, a list with a dict of its items: a style takes an
// earlier one's id only when it hashes and compares equal to it. A style's hash is over every raw field
// (an alignment's wrapText False and None hash apart, though both are written <alignment/>), so a style
// here is numbered by its raw fields, in the order the builders assign styles (an assignment later
// overwritten keeps its id). The cell formats (cellXfs) are numbered when the cells are written.
import { pyFormatG } from '../../py/pynum'
import { escAttr } from '../xml'

/** IndexedList: an item's id is its first equal's (equal: the same key). */
export class IndexedList<T> {
  readonly items: T[] = []
  private readonly ids = new Map<string, number>()

  constructor(private readonly key: (v: T) => string, initial: readonly T[] = []) {
    for (const v of initial) this.add(v)
  }

  add(v: T): number {
    const k = this.key(v)
    let id = this.ids.get(k)
    if (id === undefined) {
      id = this.items.length
      this.items.push(v)
      this.ids.set(k, id)
    }
    return id
  }

  get(id: number): T {
    return this.items[id]
  }

  get length(): number {
    return this.items.length
  }
}

// --- the styles' objects -----------------------------------------------------------------------------

/** openpyxl.styles.Color: an ARGB value or a theme color */
export interface Color { readonly rgb?: string, readonly theme?: number }

/** Color(rgb): a six-digit value gets openpyxl's "00" alpha. */
export const rgb = (hex: string): Color => ({ rgb: hex.length === 6 ? `00${hex}` : hex })
export const themeColor = (theme: number): Color => ({ theme })

const colorKey = (c: Color | null | undefined): string => (c ? (c.rgb !== undefined ? `rgb:${c.rgb}` : `theme:${c.theme}`) : 'none')

function colorXml(tag: string, c: Color): string {
  return c.rgb !== undefined ? `<${tag} rgb="${escAttr(c.rgb, true)}"/>` : `<${tag} theme="${c.theme}"/>`
}

export interface Font {
  readonly name?: string
  readonly family?: number
  readonly b?: boolean
  readonly i?: boolean
  readonly color?: Color
  readonly sz?: number
  readonly scheme?: string
}

/** Font(bold=, italic=, size=, color=, ...): b and i are False unless set (openpyxl's NestedBool). */
export function font(f: { bold?: boolean, italic?: boolean, size?: number, color?: string | Color, name?: string, family?: number,
  scheme?: string }): Font {
  return {
    name: f.name, family: f.family, b: f.bold ?? false, i: f.italic ?? false,
    color: typeof f.color === 'string' ? rgb(f.color) : f.color, sz: f.size, scheme: f.scheme,
  }
}

const fontKey = (f: Font): string => JSON.stringify([f.name ?? null, f.family ?? null, f.b ?? false, f.i ?? false, colorKey(f.color), f.sz ?? null,
  f.scheme ?? null])

/** A number as openpyxl's safe_string writes it: %.16g, and nothing for NaN or infinity */
export const num = (x: number): string => (Number.isFinite(x) ? pyFormatG(x, 16) : '')

function fontXml(f: Font): string {
  let s = '<font>'
  if (f.name !== undefined) s += `<name val="${escAttr(f.name, true)}"/>`
  if (f.family !== undefined) s += `<family val="${num(f.family)}"/>`
  if (f.b) s += '<b val="1"/>'
  if (f.i) s += '<i val="1"/>'
  if (f.color) s += colorXml('color', f.color)
  if (f.sz !== undefined) s += `<sz val="${num(f.sz)}"/>`
  if (f.scheme !== undefined) s += `<scheme val="${f.scheme}"/>`
  return s + '</font>'
}

/** openpyxl's DEFAULT_FONT */
export const DEFAULT_FONT: Font = { name: 'Calibri', family: 2, b: false, i: false, color: themeColor(1), sz: 11, scheme: 'minor' }

export interface PatternFill {
  readonly patternType: string | null
  readonly fgColor: Color | null
  readonly bgColor: Color | null
}

/** PatternFill("solid", start_color=hex, end_color=hex) */
export const solidFill = (hex: string): PatternFill => ({ patternType: 'solid', fgColor: rgb(hex), bgColor: rgb(hex) })
const EMPTY_FILL: PatternFill = { patternType: null, fgColor: null, bgColor: null }
const GRAY_FILL: PatternFill = { patternType: 'gray125', fgColor: null, bgColor: null }

const fillKey = (f: PatternFill): string => JSON.stringify([f.patternType, colorKey(f.fgColor), colorKey(f.bgColor)])

function fillXml(f: PatternFill): string {
  // a color equal to the default black Color() is left out
  const colors = (f.fgColor ? colorXml('fgColor', f.fgColor) : '') + (f.bgColor ? colorXml('bgColor', f.bgColor) : '')
  const type = f.patternType !== null ? ` patternType="${f.patternType}"` : ''
  return `<fill><patternFill${type}${colors ? `>${colors}</patternFill>` : '/>'}</fill>`
}

export interface Side { readonly style: string | null, readonly color: Color | null }
export const side = (style: string | null = null, color: string | null = null): Side => ({ style, color: color === null ? null : rgb(color) })

export interface Border {
  readonly left: Side | null
  readonly right: Side | null
  readonly top: Side | null
  readonly bottom: Side | null
  readonly diagonal: Side | null
}

/** Border(left=, right=, top=, bottom=, diagonal=): a side not given is None */
export const border = (b: Partial<Border> = {}): Border => ({
  left: b.left ?? null, right: b.right ?? null, top: b.top ?? null, bottom: b.bottom ?? null, diagonal: b.diagonal ?? null,
})
/** openpyxl's DEFAULT_BORDER: every side an empty Side() */
export const DEFAULT_BORDER: Border = border({ left: side(), right: side(), top: side(), bottom: side(), diagonal: side() })

const sideKey = (s: Side | null): string => (s === null ? 'none' : `${s.style}|${colorKey(s.color)}`)
const borderKey = (b: Border): string => [b.left, b.right, b.top, b.bottom, b.diagonal].map(sideKey).join('/')

function sideXml(tag: string, s: Side | null): string {
  if (s === null) return ''
  const style = s.style !== null ? ` style="${s.style}"` : ''
  return s.color ? `<${tag}${style}>${colorXml('color', s.color)}</${tag}>` : `<${tag}${style}/>`
}

const borderXml = (b: Border): string => `<border>${sideXml('left', b.left)}${sideXml('right', b.right)}${sideXml('top', b.top)}`
  + `${sideXml('bottom', b.bottom)}${sideXml('diagonal', b.diagonal)}</border>`

/** Border + Border (Serialisable.__add__): each side the first's, else the second's. */
export function addBorders(a: Border, b: Border): Border {
  const pick = (x: Side | null, y: Side | null): Side | null => {
    if (x && y) return { style: x.style ?? y.style, color: x.color ?? y.color }
    return x ?? y
  }
  return { left: pick(a.left, b.left), right: pick(a.right, b.right), top: pick(a.top, b.top), bottom: pick(a.bottom, b.bottom),
    diagonal: pick(a.diagonal, b.diagonal) }
}

export interface Alignment {
  readonly horizontal: string | null
  readonly vertical: string | null
  /** None or a flag (both written the same, numbered apart) */
  readonly wrapText: boolean | null
}

export const alignment = (a: { horizontal?: string, vertical?: string, wrapText?: boolean } = {}): Alignment => ({
  horizontal: a.horizontal ?? null, vertical: a.vertical ?? null, wrapText: a.wrapText ?? null,
})
const alignmentKey = (a: Alignment): string => JSON.stringify([a.horizontal, a.vertical, a.wrapText])

function alignmentXml(a: Alignment): string {
  // Alignment's own __iter__: only values that are neither None nor 0
  let s = '<alignment'
  if (a.horizontal) s += ` horizontal="${a.horizontal}"`
  if (a.vertical) s += ` vertical="${a.vertical}"`
  if (a.wrapText) s += ' wrapText="1"'
  return s + '/>'
}

export interface Protection { readonly locked: boolean, readonly hidden: boolean }
export const protection = (p: { locked?: boolean, hidden?: boolean } = {}): Protection => ({ locked: p.locked ?? true, hidden: p.hidden ?? false })
const protectionKey = (p: Protection): string => `${p.locked}/${p.hidden}`
const protectionXml = (p: Protection): string => `<protection locked="${p.locked ? 1 : 0}" hidden="${p.hidden ? 1 : 0}"/>`

/** openpyxl's BUILTIN_FORMATS */
export const BUILTIN_FORMATS: ReadonlyMap<number, string> = new Map([
  [0, 'General'], [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [5, '"$"#,##0_);("$"#,##0)'], [6, '"$"#,##0_);[Red]("$"#,##0)'],
  [7, '"$"#,##0.00_);("$"#,##0.00)'], [8, '"$"#,##0.00_);[Red]("$"#,##0.00)'], [9, '0%'], [10, '0.00%'], [11, '0.00E+00'], [12, '# ?/?'],
  [13, '# ??/??'], [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'], [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'm/d/yy h:mm'], [37, '#,##0_);(#,##0)'], [38, '#,##0_);[Red](#,##0)'], [39, '#,##0.00_);(#,##0.00)'],
  [40, '#,##0.00_);[Red](#,##0.00)'], [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'], [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_)_("$"* \\(#,##0.00\\)_("$"* "-"??_)_(@_)'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [48, '##0.0E+0'],
  [49, '@'],
])
/** BUILTIN_FORMATS_REVERSE */
export const BUILTIN_IDS: ReadonlyMap<string, number> = new Map([...BUILTIN_FORMATS].map(([id, code]) => [code, id]))
/** custom number formats are numbered from here */
export const BUILTIN_FORMATS_MAX_SIZE = 164

/** openpyxl's StyleArray: fontId, fillId, borderId, numFmtId, protectionId, alignmentId, pivotButton,
 * quotePrefix, xfId */
export type StyleArray = number[]
export const FONT = 0
export const FILL = 1
export const BORDER = 2
export const NUMFMT = 3
export const PROTECTION = 4
export const ALIGNMENT = 5
export const XFID = 8

export const newStyle = (): StyleArray => [0, 0, 0, 0, 0, 0, 0, 0, 0]

/** A named style (cellStyles and cellStyleXfs). */
interface NamedStyle {
  readonly name: string
  readonly builtinId: number
  readonly font: Font
  /** its StyleArray, once bound to the workbook */
  style: StyleArray
}

/** openpyxl's builtin "Hyperlink" style: only its font differs from Normal's */
const HYPERLINK_FONT: Font = { name: 'Calibri', family: 2, b: false, i: false, color: themeColor(10), sz: 12, scheme: 'minor' }

/** A differential style (a conditional format's): only a fill, as CEICA's are. */
export interface DifferentialStyle { readonly fill: PatternFill }

/** A workbook's style lists, in openpyxl's initial state. */
export class Styles {
  readonly fonts = new IndexedList<Font>(fontKey, [DEFAULT_FONT])
  readonly fills = new IndexedList<PatternFill>(fillKey, [EMPTY_FILL, GRAY_FILL])
  readonly borders = new IndexedList<Border>(borderKey, [DEFAULT_BORDER])
  readonly alignments = new IndexedList<Alignment>(alignmentKey, [alignment()])
  readonly protections = new IndexedList<Protection>(protectionKey, [protection()])
  readonly numberFormats = new IndexedList<string>((s) => s)
  readonly cellStyles = new IndexedList<StyleArray>((s) => s.join(','), [newStyle()])
  readonly dxfs = new IndexedList<DifferentialStyle>((d) => fillKey(d.fill))
  private readonly named: NamedStyle[] = [{ name: 'Normal', builtinId: 0, font: DEFAULT_FONT, style: newStyle() }]

  /** cell.number_format = code: a builtin's own id, else a custom one from 164 */
  numFmtId(code: string): number {
    const builtin = BUILTIN_IDS.get(code)
    return builtin !== undefined ? builtin : this.numberFormats.add(code) + BUILTIN_FORMATS_MAX_SIZE
  }

  /** cell.style = name: the named style's StyleArray (a builtin one bound at its first use) */
  namedStyle(name: string): StyleArray {
    let ns = this.named.find((n) => n.name === name)
    if (!ns) {
      if (name !== 'Hyperlink') throw new Error(`${name} is not a known style`)
      ns = { name, builtinId: 8, font: HYPERLINK_FONT, style: newStyle() }
      this.named.push(ns)
      ns.style[FONT] = this.fonts.add(ns.font)
      ns.style[XFID] = this.named.length - 1
    }
    return [...ns.style]
  }

  /** xl/styles.xml */
  xml(): string {
    let numFmts = ''
    this.numberFormats.items.forEach((code, k) => {
      numFmts += `<numFmt numFmtId="${k + BUILTIN_FORMATS_MAX_SIZE}" formatCode="${escAttr(code, true)}"/>`
    })
    const list = (tag: string, items: readonly string[]): string => `<${tag} count="${items.length}">${items.join('')}</${tag}>`
    const xfs = this.cellStyles.items.map((s) => {
      let attrs = `numFmtId="${s[NUMFMT]}" fontId="${s[FONT]}" fillId="${s[FILL]}" borderId="${s[BORDER]}"`
      let body = ''
      if (s[ALIGNMENT]) {
        attrs += ' applyAlignment="1"'
        body += alignmentXml(this.alignments.get(s[ALIGNMENT]))
      }
      if (s[PROTECTION]) {
        attrs += ' applyProtection="1"'
        body += protectionXml(this.protections.get(s[PROTECTION]))
      }
      attrs += ` pivotButton="${s[6] ? 1 : 0}" quotePrefix="${s[7] ? 1 : 0}" xfId="${s[XFID]}"`
      return body ? `<xf ${attrs}>${body}</xf>` : `<xf ${attrs}/>`
    })
    const styleXfs = this.named.map((n) => `<xf numFmtId="0" fontId="${n.style[FONT]}" fillId="0" borderId="0"/>`)
    const names = this.named.map((n, k) => `<cellStyle name="${n.name}" xfId="${k}" builtinId="${n.builtinId}" hidden="0"/>`)
    const dxfs = this.dxfs.length ? list('dxfs', this.dxfs.items.map((d) => `<dxf>${fillXml(d.fill)}</dxf>`)) : ''
    return '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (numFmts ? `<numFmts count="${this.numberFormats.length}">${numFmts}</numFmts>` : '<numFmts count="0"/>')
      + list('fonts', this.fonts.items.map(fontXml)) + list('fills', this.fills.items.map(fillXml))
      + list('borders', this.borders.items.map(borderXml)) + list('cellStyleXfs', styleXfs) + list('cellXfs', xfs)
      + list('cellStyles', names) + dxfs
      + '<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>'
      + `<colors><indexedColors>${COLOR_INDEX.map((c) => `<rgbColor rgb="${c}"/>`).join('')}</indexedColors></colors></styleSheet>`
  }
}

/** openpyxl's COLOR_INDEX (the stylesheet's indexedColors) */
const COLOR_INDEX = ('00000000 00FFFFFF 00FF0000 0000FF00 000000FF 00FFFF00 00FF00FF 0000FFFF 00000000 00FFFFFF 00FF0000 0000FF00 000000FF '
  + '00FFFF00 00FF00FF 0000FFFF 00800000 00008000 00000080 00808000 00800080 00008080 00C0C0C0 00808080 009999FF 00993366 00FFFFCC 00CCFFFF '
  + '00660066 00FF8080 000066CC 00CCCCFF 00000080 00FF00FF 00FFFF00 0000FFFF 00800080 00800000 00008080 000000FF 0000CCFF 00CCFFFF 00CCFFCC '
  + '00FFFF99 0099CCFF 00FF99CC 00CC99FF 00FFCC99 003366FF 0033CCCC 0099CC00 00FFCC00 00FF9900 00FF6600 00666699 00969696 00003366 00339966 '
  + '00003300 00333300 00993300 00993366 00333399 00333333').split(' ')
