// openpyxl 3.1.5's Workbook, Worksheet and Cell, as CEICA's workbooks use them, written to the bytes
// openpyxl writes (with lxml) and xl.repack repacks: every part in openpyxl's order, its XML as openpyxl's
// serializers write it, the zip's entries dated 1980-01-01 and deflated, the core properties' times pinned.
//
// What openpyxl does that the bytes show, copied here:
// - a cell's type from its value: text starting with "=" (longer than "=") is a formula, the seven error
//   texts are errors, text is cut to 32,767 characters, and control characters are refused;
// - a cell exists once it is touched (ws.cell), and counts toward the sheet's dimension even if empty;
// - merged ranges are kept in a set and written in CPython's set order; merging makes the covered cells
//   merged cells, gives the edges the top-left cell's borders and every cell its protection;
// - cell formats are numbered as the cells are written, sheet by sheet, row by row;
// - a validation's ranges are written sorted by column, then row; conditional formats in the order added,
//   their priorities counted per sheet, their dxfs numbered as they are written.
import { pyStrip } from '../../py/pystr'
import { PySet, tupleHash } from '../pyset'
import { escAttr, escText } from '../xml'
import { newInfo, ZIP_DEFLATED, ZipWriter } from '../zip'
import THEME from '../../content/xlsx/theme1.xml?raw'
import {
  addBorders, ALIGNMENT, type Alignment, BORDER, type Border, type DifferentialStyle, FILL, FONT, type Font, newStyle, NUMFMT, num,
  type PatternFill, PROTECTION, type Protection, type StyleArray, Styles,
} from './styles'

export type CellValue = string | number | boolean | null
export type DataType = 'n' | 's' | 'f' | 'b' | 'e'

/** openpyxl's ERROR_CODES: text that is written as an error */
const ERROR_CODES = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'])
/** openpyxl's ILLEGAL_CHARACTERS_RE */
const ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

/** openpyxl.utils.exceptions.IllegalCharacterError */
export class IllegalCharacterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalCharacterError'
  }
}

/** get_column_letter */
export function colLetter(n: number): string {
  let s = ''
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s
  return s
}

/** column_index_from_string */
export function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export const coordinate = (row: number, col: number): string => `${colLetter(col)}${row}`

/** "B4" as [row, column] */
export function parseCell(ref: string): [number, number] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref)
  if (!m) throw new Error(`${ref} is not a cell`)
  return [Number(m[2]), colIndex(m[1])]
}

/** A range's bounds [minRow, minCol, maxRow, maxCol] ("B4" or "B4:D9") */
export function rangeBounds(ref: string): [number, number, number, number] {
  const [a, b] = ref.split(':')
  const [r1, c1] = parseCell(a)
  const [r2, c2] = b === undefined ? [r1, c1] : parseCell(b)
  return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)]
}

/** CellRange.coord */
export function rangeCoord([r1, c1, r2, c2]: readonly number[]): string {
  return r1 === r2 && c1 === c2 ? coordinate(r1, c1) : `${coordinate(r1, c1)}:${coordinate(r2, c2)}`
}


export class Cell {
  value: CellValue = null
  dataType: DataType = 'n'
  /** openpyxl's StyleArray, once a style is set (or a merge sets the protection) */
  style: StyleArray | null = null
  /** a hyperlink's location (another sheet's cell) */
  hyperlink: string | null = null

  constructor(readonly sheet: Worksheet, readonly row: number, readonly column: number, readonly merged = false) {}

  get coordinate(): string {
    return coordinate(this.row, this.column)
  }

  private get styles(): Styles {
    return this.sheet.book.styles
  }

  private ensure(): StyleArray {
    if (this.style === null) this.style = newStyle()
    return this.style
  }

  /** cell.value = v (openpyxl's _bind_value) */
  set(v: CellValue): void {
    if (this.merged) throw new Error("'MergedCell' object attribute 'value' is read-only")
    this.dataType = 'n'
    if (typeof v === 'boolean') this.dataType = 'b'
    else if (typeof v === 'string') {
      // check_string: at most 32,767 characters, no control characters
      let text = v
      if (text.length > 32767) text = [...text].slice(0, 32767).join('')
      if (ILLEGAL.test(text)) throw new IllegalCharacterError(`${text} cannot be used in worksheets.`)
      v = text
      this.dataType = [...text].length > 1 && text.startsWith('=') ? 'f' : ERROR_CODES.has(text) ? 'e' : 's'
    }
    this.value = v
  }

  set font(f: Font) {
    this.ensure()[FONT] = this.styles.fonts.add(f)
  }

  get fontStyle(): Font {
    return this.styles.fonts.get(this.style ? this.style[FONT] : 0)
  }

  set fill(f: PatternFill) {
    this.ensure()[FILL] = this.styles.fills.add(f)
  }

  set border(b: Border) {
    this.ensure()[BORDER] = this.styles.borders.add(b)
  }

  get border(): Border {
    return this.styles.borders.get(this.style ? this.style[BORDER] : 0)
  }

  set alignment(a: Alignment) {
    this.ensure()[ALIGNMENT] = this.styles.alignments.add(a)
  }

  set protection(p: Protection) {
    this.ensure()[PROTECTION] = this.styles.protections.add(p)
  }

  get protection(): Protection {
    return this.styles.protections.get(this.style ? this.style[PROTECTION] : 0)
  }

  set numberFormat(code: string) {
    this.ensure()[NUMFMT] = this.styles.numFmtId(code)
  }

  /** cell.style = "Hyperlink" (a named style) */
  set named(name: string) {
    this.style = this.styles.namedStyle(name)
  }

  get hasStyle(): boolean {
    return this.style !== null && this.style.some((v) => v !== 0)
  }
}

/** A data validation (worksheet/datavalidation.py), as CEICA makes them. */
export class DataValidation {
  private readonly ranges: [number, number, number, number][] = []
  error: string | null = null

  constructor(readonly opts: { type: string, formula1?: string, formula2?: string, operator?: string, allowBlank?: boolean }) {}

  /** dv.add(cell or range): a range already inside one of its ranges adds nothing */
  add(ref: string): void {
    const b = rangeBounds(ref)
    if (this.ranges.some((r) => r[0] <= b[0] && r[1] <= b[1] && r[2] >= b[2] && r[3] >= b[3])) return
    this.ranges.push(b)
  }

  get empty(): boolean {
    return !this.ranges.length
  }

  /** its sqref: the ranges sorted by (min_col, min_row, max_col, max_row) */
  sqref(): string {
    const sorted = [...this.ranges].sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2])
    return sorted.map(rangeCoord).join(' ')
  }

  xml(): string {
    const o = this.opts
    let s = `<dataValidation sqref="${this.sqref()}" showDropDown="0" showInputMessage="0" showErrorMessage="0" allowBlank="${o.allowBlank ? 1 : 0}"`
    if (this.error !== null) s += ` error="${escAttr(this.error, true)}"`
    s += ` type="${o.type}"`
    if (o.operator) s += ` operator="${o.operator}"`
    s += '>'
    if (o.formula1 !== undefined) s += `<formula1>${escText(o.formula1, true)}</formula1>`
    if (o.formula2 !== undefined) s += `<formula2>${escText(o.formula2, true)}</formula2>`
    return s + '</dataValidation>'
  }
}

/** A conditional format's rule: FormulaRule(formula=[...], fill=...), as CEICA makes them. */
export interface FormulaRule { readonly formula: string, readonly dxf: DifferentialStyle }

interface Rule extends FormulaRule { readonly priority: number }

/** A chart drawn on a sheet: its anchor cell and the chart's own XML (charts.ts). */
export interface Chart {
  /** the chart part's XML */
  xml(): string
  /** the top-left cell (a one-cell anchor) and the size in EMU */
  readonly anchor: string
  readonly cx: number
  readonly cy: number
}

/** SheetProtection with a password, as CEICA protects its sheets. */
export interface SheetProtection {
  password: string
  formatColumns: boolean
  formatRows: boolean
  autoFilter: boolean
  sort: boolean
}

/** Excel's legacy password hash (openpyxl's hash_password) */
export function hashPassword(text: string): string {
  let h = 0
  ;[...text].forEach((ch, k) => {
    let value = ch.codePointAt(0)! << (k + 1)
    const rotated = value >> 15
    value &= 0x7fff
    h ^= value | rotated
  })
  h ^= [...text].length
  h ^= 0xce4b
  return h.toString(16).toUpperCase()
}

export class Worksheet {
  state: 'visible' | 'hidden' | 'veryHidden' = 'visible'
  showGridLines = true
  /** the top-left cell of the unfrozen pane (freeze_panes) */
  freezePanes: string | null = null
  protection: SheetProtection | null = null
  readonly cells = new Map<number, Cell>()
  /** column dimensions by column number: a width and whether hidden */
  readonly columns = new Map<number, { width: number, hidden: boolean }>()
  readonly merged = new PySet<readonly number[]>(tupleHash, (a, b) => a.every((x, k) => x === b[k]))
  readonly validations: DataValidation[] = []
  readonly conditional: { sqref: string, rules: Rule[] }[] = []
  readonly charts: Chart[] = []
  private priority = 0

  constructor(readonly book: Workbook, public title: string) {}

  private static key(row: number, col: number): number {
    return row * 16384 + col
  }

  /** ws.cell(row, column, value): the cell, made if it is new; a value given is set */
  cell(row: number, column: number, value: CellValue = null): Cell {
    if (row < 1 || column < 1) throw new Error('Row or column values must be at least 1')
    const k = Worksheet.key(row, column)
    let c = this.cells.get(k)
    if (!c) {
      c = new Cell(this, row, column)
      this.cells.set(k, c)
    }
    if (value !== null) c.set(value)
    return c
  }

  /** ws.column_dimensions[letter]: made with openpyxl's default width (13) when first touched */
  column(col: number): { width: number, hidden: boolean } {
    let d = this.columns.get(col)
    if (!d) {
      d = { width: 13, hidden: false }
      this.columns.set(col, d)
    }
    return d
  }

  /** ws.merge_cells(start_row=, start_column=, end_row=, end_column=) */
  mergeCells(r1: number, c1: number, r2: number, c2: number): void {
    const bounds = [r1, c1, r2, c2]
    this.merged.add(bounds)
    // _get_borders: the top-left cell, made if new, takes the bottom-right one's right and bottom borders
    const start = this.cell(r1, c1)
    const end = this.cells.get(Worksheet.key(r2, c2))
    if (end) start.border = addBorders(start.border, { left: null, right: end.border.right, top: null, bottom: end.border.bottom, diagonal: null })
    // _clean_merge_range: every other cell becomes a merged cell
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue
        this.cells.set(Worksheet.key(r, c), new Cell(this, r, c, true))
      }
    }
    // format(): the edges take the top-left cell's sides; every cell its protection
    const edges: [keyof Border, number[][]][] = [
      ['top', range(c1, c2).map((c) => [r1, c])], ['left', range(r1, r2).map((r) => [r, c1])],
      ['right', range(r1, r2).map((r) => [r, c2])], ['bottom', range(c1, c2).map((c) => [r2, c])],
    ]
    for (const [name, coords] of edges) {
      const s = start.border[name]
      if (s && s.style === null) continue
      for (const [r, c] of coords) {
        const cell = this.cells.get(Worksheet.key(r, c)) ?? this.addMerged(r, c)
        cell.border = addBorders(cell.border, { left: null, right: null, top: null, bottom: null, diagonal: null, [name]: s })
      }
    }
    const prot = start.protection
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) (this.cells.get(Worksheet.key(r, c)) ?? this.addMerged(r, c)).protection = prot
    }
  }

  private addMerged(r: number, c: number): Cell {
    const cell = new Cell(this, r, c, true)
    this.cells.set(Worksheet.key(r, c), cell)
    return cell
  }

  addValidation(dv: DataValidation): void {
    this.validations.push(dv)
  }

  /** ws.conditional_formatting.add(range, rule): priorities count up per sheet; rules on one range are
   * kept together, the range as a MultiCellRange writes it ("B4" for B4:B4) */
  addConditional(range: string, rule: FormulaRule): void {
    const sqref = rangeCoord(rangeBounds(range))
    const r: Rule = { ...rule, priority: ++this.priority }
    const cf = this.conditional.find((c) => c.sqref === sqref)
    if (cf) cf.rules.push(r)
    else this.conditional.push({ sqref, rules: [r] })
  }

  /** calculate_dimension */
  dimension(): string {
    if (!this.cells.size) return 'A1:A1'
    let r1 = Infinity
    let c1 = Infinity
    let r2 = -Infinity
    let c2 = -Infinity
    for (const c of this.cells.values()) {
      r1 = Math.min(r1, c.row)
      c1 = Math.min(c1, c.column)
      r2 = Math.max(r2, c.row)
      c2 = Math.max(c2, c.column)
    }
    return `${coordinate(r1, c1)}:${coordinate(r2, c2)}`
  }

  private viewsXml(): string {
    let view = '<sheetView'
    if (!this.showGridLines) view += ' showGridLines="0"'
    view += ' workbookViewId="0">'
    const top = this.freezePanes
    if (top === null || top === 'A1') return `<sheetViews>${view}<selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>`
    const [row, col] = parseCell(top)
    let pane = '<pane'
    if (col > 1) pane += ` xSplit="${col - 1}"`
    if (row > 1) pane += ` ySplit="${row - 1}"`
    const active = row > 1 && col > 1 ? 'bottomRight' : row > 1 ? 'bottomLeft' : 'topRight'
    pane += ` topLeftCell="${top}" activePane="${active}" state="frozen"/>`
    const sel = row > 1 && col > 1 ? '<selection pane="topRight"/><selection pane="bottomLeft"/>' : ''
    return `<sheetViews>${view}${pane}${sel}<selection pane="${active}" activeCell="A1" sqref="A1"/></sheetView></sheetViews>`
  }

  private cellXml(c: Cell): string {
    const styles = this.book.styles
    let attrs = `r="${c.coordinate}"`
    if (c.hasStyle) attrs += ` s="${styles.cellStyles.add(c.style!)}"`
    if (c.dataType === 's') attrs += ' t="inlineStr"'
    else if (c.dataType !== 'f') attrs += ` t="${c.dataType}"`
    // _set_attributes registers a cell's link before it looks at the value
    if (c.hyperlink !== null) this.links.push(c)
    const v = c.value
    if (v === null || v === '') return `<c ${attrs}></c>`
    if (c.dataType === 'f') return `<c ${attrs}><f>${escText((v as string).slice(1), true)}</f><v></v></c>`
    if (c.dataType === 's') {
      const text = v as string
      // lxml's writer keeps the spaces of text that str.strip() would change
      const space = text !== pyStrip(text) ? ' xml:space="preserve"' : ''
      return `<c ${attrs}><is><t${space}>${escText(text, true)}</t></is></c>`
    }
    const shown = typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? num(v) : escText(v, true)
    return `<c ${attrs}><v>${shown}</v></c>`
  }

  private links: Cell[] = []

  /** The sheet's XML; the drawing's relationship id when it has charts. */
  xml(): string {
    this.links = []
    let s = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/>'
      + `<pageSetUpPr/></sheetPr><dimension ref="${this.dimension()}"/>${this.viewsXml()}<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>`
    if (this.columns.size) {
      s += '<cols>'
      for (const [col, d] of [...this.columns].sort((a, b) => a[0] - b[0])) {
        s += `<col${d.hidden ? ' hidden="1"' : ''}${d.width ? ` width="${num(d.width)}" customWidth="1"` : ''} min="${col}" max="${col}"/>`
      }
      s += '</cols>'
    }
    // rows in order, each row's cells by column
    const rows = new Map<number, Cell[]>()
    for (const c of [...this.cells.values()].sort((a, b) => a.row - b.row || a.column - b.column)) {
      let row = rows.get(c.row)
      if (!row) {
        row = []
        rows.set(c.row, row)
      }
      row.push(c)
    }
    const parts: string[] = [s, '<sheetData>']
    for (const [r, cells] of rows) {
      let row = `<row r="${r}">`
      for (const c of cells) {
        if (c.value === null && !c.hasStyle) continue
        row += this.cellXml(c)
      }
      parts.push(row + '</row>')
    }
    parts.push('</sheetData>')
    const p = this.protection
    if (p) {
      parts.push('<sheetProtection selectLockedCells="0" selectUnlockedCells="0" sheet="1" objects="0" insertRows="1" insertHyperlinks="1" '
        + `autoFilter="${p.autoFilter ? 1 : 0}" scenarios="0" formatColumns="${p.formatColumns ? 1 : 0}" deleteColumns="1" insertColumns="1" `
        + `pivotTables="1" deleteRows="1" formatCells="1" formatRows="${p.formatRows ? 1 : 0}" sort="${p.sort ? 1 : 0}" `
        + `password="${hashPassword(p.password)}"/>`)
    }
    const merged = [...this.merged]
    if (merged.length) parts.push(`<mergeCells count="${merged.length}">${merged.map((m) => `<mergeCell ref="${rangeCoord(m)}"/>`).join('')}</mergeCells>`)
    for (const cf of this.conditional) {
      let x = `<conditionalFormatting sqref="${cf.sqref}">`
      for (const rule of cf.rules) {
        const dxfId = this.book.styles.dxfs.add(rule.dxf)
        x += `<cfRule type="expression" priority="${rule.priority}" dxfId="${dxfId}" stopIfTrue="0">`
          + `<formula>${escText(rule.formula, true)}</formula></cfRule>`
      }
      parts.push(x + '</conditionalFormatting>')
    }
    if (this.validations.length) {
      // a validation with no cells is left out (DataValidationList.to_tree), and from the count
      const dvs = this.validations.filter((dv) => !dv.empty)
      parts.push(dvs.length ? `<dataValidations count="${dvs.length}">${dvs.map((dv) => dv.xml()).join('')}</dataValidations>`
        : '<dataValidations count="0"/>')
    }
    if (this.links.length) {
      parts.push(`<hyperlinks>${this.links.map((c) => `<hyperlink ref="${c.coordinate}" location="${escAttr(c.hyperlink!, true)}"/>`).join('')}</hyperlinks>`)
    }
    parts.push('<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>')
    if (this.charts.length) parts.push('<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>')
    parts.push('</worksheet>')
    return parts.join('')
  }
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k)

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const T_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const T_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const T_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'

/** xl.repack's STAMP: the core properties' times, so the same workbook gives the same bytes */
export const STAMP = '2026-01-01T00:00:00Z'

const rels = (items: readonly [string, string, string][]): string => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + items.map(([type, target, id]) => `<Relationship Type="${type}" Target="${target}" Id="${id}"/>`).join('') + '</Relationships>'

export class Workbook {
  readonly styles = new Styles()
  sheets: Worksheet[]
  /** the active sheet's index */
  active = 0
  /** defined names in the order first set: name -> its formula text */
  readonly definedNames = new Map<string, string>()

  constructor() {
    this.sheets = [new Worksheet(this, 'Sheet')]
  }

  /** wb.create_sheet(title) */
  createSheet(title: string): Worksheet {
    const ws = new Worksheet(this, title)
    this.sheets.push(ws)
    return ws
  }

  /** wb.remove(ws) */
  remove(ws: Worksheet): void {
    this.sheets.splice(this.sheets.indexOf(ws), 1)
  }

  /** wb.move_sheet(ws, offset) */
  moveSheet(ws: Worksheet, offset: number): void {
    const idx = this.sheets.indexOf(ws)
    this.sheets.splice(idx, 1)
    this.sheets.splice(idx + offset, 0, ws)
  }

  get sheetnames(): string[] {
    return this.sheets.map((s) => s.title)
  }

  sheet(title: string): Worksheet {
    const ws = this.sheets.find((s) => s.title === title)
    if (!ws) throw new Error(`Worksheet ${title} does not exist.`)
    return ws
  }

  /** wb.save(...) then xl.repack: the workbook's bytes */
  save(): Uint8Array {
    const parts: [string, string][] = []
    parts.push(['docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
      + '<Application>Microsoft Excel Compatible / Openpyxl 3.1.5</Application><AppVersion>3.1</AppVersion></Properties>'])
    const time = (tag: string): string => `<dcterms:${tag} xmlns:dcterms="http://purl.org/dc/terms/" `
      + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="dcterms:W3CDTF">${STAMP}</dcterms:${tag}>`
    parts.push(['docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">'
      + `<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">openpyxl</dc:creator>${time('created')}${time('modified')}</cp:coreProperties>`])
    parts.push(['xl/theme/theme1.xml', THEME])
    const overrides: [string, string][] = []
    const charts: Chart[] = []
    let drawings = 0
    this.sheets.forEach((ws, k) => {
      const path = `xl/worksheets/sheet${k + 1}.xml`
      parts.push([path, ws.xml()])
      overrides.push([`/${path}`, T_SHEET])
      if (ws.charts.length) {
        drawings++
        const dpath = `xl/drawings/drawing${drawings}.xml`
        const anchors = ws.charts.map((ch, j) => {
          charts.push(ch)
          return anchorXml(ch, charts.length, j + 1)
        })
        parts.push([dpath, `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">${anchors.join('')}</wsDr>`])
        const first = charts.length - ws.charts.length
        parts.push([`xl/drawings/_rels/drawing${drawings}.xml.rels`,
          rels(ws.charts.map((_, j) => [`${REL}/chart`, `/xl/charts/chart${first + j + 1}.xml`, `rId${j + 1}`]))])
        overrides.push([`/${dpath}`, T_DRAWING])
        parts.push([`xl/worksheets/_rels/sheet${k + 1}.xml.rels`, rels([[`${REL}/drawing`, `/${dpath}`, 'rId1']])])
      }
    })
    charts.forEach((ch, k) => {
      parts.push([`xl/charts/chart${k + 1}.xml`, ch.xml()])
      overrides.push([`/xl/charts/chart${k + 1}.xml`, T_CHART])
    })
    parts.push(['xl/styles.xml', this.styles.xml()])
    parts.push(['_rels/.rels', rels([[`${REL}/officeDocument`, 'xl/workbook.xml', 'rId1'],
      ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml', 'rId2'],
      [`${REL}/extended-properties`, 'docProps/app.xml', 'rId3']])])
    const sheets = this.sheets.map((ws, k) => `<sheet xmlns:r="${NS_R}" name="${escAttr(ws.title, true)}" sheetId="${k + 1}" state="${ws.state}" `
      + `r:id="rId${k + 1}"/>`).join('')
    const names = [...this.definedNames].map(([n, text]) => `<definedName name="${escAttr(n, true)}">${escText(text, true)}</definedName>`).join('')
    parts.push(['xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><workbookPr/><workbookProtection/>'
      + '<bookViews><workbookView visibility="visible" minimized="0" showHorizontalScroll="1" showVerticalScroll="1" showSheetTabs="1" '
      + `tabRatio="600" firstSheet="0" activeTab="${this.active}" autoFilterDateGrouping="1"/></bookViews><sheets>${sheets}</sheets>`
      + `${names ? `<definedNames>${names}</definedNames>` : '<definedNames/>'}<calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`])
    const n = this.sheets.length
    parts.push(['xl/_rels/workbook.xml.rels', rels([...this.sheets.map((_, k): [string, string, string] => [`${REL}/worksheet`,
      `/xl/worksheets/sheet${k + 1}.xml`, `rId${k + 1}`]), [`${REL}/styles`, 'styles.xml', `rId${n + 1}`],
    [`${REL}/theme`, 'theme/theme1.xml', `rId${n + 2}`]])])
    const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
    parts.push(['[Content_Types].xml', types])
    const zip = new ZipWriter()
    for (const [name, text] of parts) zip.writestr(newInfo(name, undefined, ZIP_DEFLATED), text)
    return zip.finish()
  }
}

/** A chart's one-cell anchor in the sheet's drawing */
function anchorXml(ch: Chart, id: number, rel: number): string {
  const [row, col] = parseCell(ch.anchor)
  return `<oneCellAnchor><from><col>${col - 1}</col><colOff>0</colOff><row>${row - 1}</row><rowOff>0</rowOff></from>`
    + `<ext cx="${ch.cx}" cy="${ch.cy}"/><graphicFrame><nvGraphicFramePr><cNvPr id="${id}" name="Chart ${id}"/><cNvGraphicFramePr/>`
    + '</nvGraphicFramePr><xfrm/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
    + `xmlns:r="${NS_R}" r:id="rId${rel}"/></a:graphicData></a:graphic></graphicFrame><clientData/></oneCellAnchor>`
}
