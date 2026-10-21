// Workbook building blocks (ceica/workbook/xl.py): styles, a sheet writer with defined names.
//
// Conventions follow the STAF calculators: orange input cells (unlocked), grey calculated cells,
// protected sheets with a guard-rail password, defined names for every scalar input and output. The
// bytes are made reproducible by the writer (files/xlsx/book.ts), which writes xl.repack's form.
import { type Cell, type CellValue, colLetter, type Workbook, type Worksheet } from '../../files/xlsx/book'
import { alignment, type Alignment, border, font, type Font, type PatternFill, protection, side, solidFill } from '../../files/xlsx/styles'

/** a guard rail against accidental edits, not a secret */
export const PASSWORD = 'ceica'

export const C_INPUT = 'F8CBAD'
export const C_CALC = 'EDEDED'
export const C_HEAD = '2F4B7C'
export const C_SUB = 'EEF3FB'
export const C_CHANGED = 'FFE08A'
export const C_OK = 'E9F6EE'
export const C_WARN = 'FFF6E2'
export const C_ERR = 'FDECEA'

export const solid = solidFill

export const FILL_INPUT = solid(C_INPUT)
export const FILL_CALC = solid(C_CALC)
export const FILL_HEAD = solid(C_HEAD)
export const FILL_SUB = solid(C_SUB)
export const FONT_BOLD = font({ bold: true })
export const FONT_HEAD = font({ bold: true, color: 'FFFFFF' })
export const FONT_TITLE = font({ bold: true, size: 14, color: C_HEAD })
export const FONT_NOTE = font({ italic: true, color: '555555', size: 9 })
export const THIN = side('thin', 'B7C3D6')
export const BOX = border({ left: THIN, right: THIN, top: THIN, bottom: THIN })
export const UNLOCKED = protection({ locked: false })
export const CENTER = alignment({ horizontal: 'center', vertical: 'center', wrapText: true })
export const LEFT = alignment({ horizontal: 'left', vertical: 'center', wrapText: false })
export const WRAP = alignment({ horizontal: 'left', vertical: 'top', wrapText: true })

export const FMT_USD = '"$"#,##0'
export const FMT_USD2 = '"$"#,##0.00'
export const FMT_NUM3 = '#,##0.000'
export const FMT_NUM2 = '#,##0.00'
export const FMT_INT = '#,##0'
export const FMT_PCT = '0.00%'
export const FMT_RATE = '0.000%'
export const FMT_FACTOR = '0.0000000000'

export const col = colLetter

export const a1 = (c: number, r: number, { absolute = false } = {}): string => (absolute ? `$${col(c)}$${r}` : `${col(c)}${r}`)

export const rng = (c1: number, r1: number, c2: number, r2: number, { absolute = true } = {}): string =>
  `${a1(c1, r1, { absolute })}:${a1(c2, r2, { absolute })}`

/** A sheet's name in a formula: quoted when it holds anything but letters, digits and _. */
export const qsheet = (name: string): string => (/[^A-Za-z0-9_]/.test(name) ? `'${name}'` : name)

/** Names and notes are text even when they start with "=" (openpyxl reads that as a formula). */
export function asText(cell: Cell, value: CellValue): void {
  if (typeof value === 'string' && value.startsWith('=')) cell.dataType = 's'
}

/** A worksheet with typed cell writers and defined names. */
export class Sheet {
  /** A1 addresses of input cells (for snapshot / change checks) */
  readonly inputs: string[] = []

  constructor(readonly wb: Workbook, readonly ws: Worksheet, readonly name: string) {}

  ref(c: number, r: number, { absolute = true } = {}): string {
    return `${qsheet(this.name)}!${a1(c, r, { absolute })}`
  }

  nameCell(name: string, c: number, r: number): string {
    this.wb.definedNames.set(name, this.ref(c, r))
    return name
  }

  nameRange(name: string, c1: number, r1: number, c2: number, r2: number): string {
    this.wb.definedNames.set(name, `${qsheet(this.name)}!${rng(c1, r1, c2, r2)}`)
    return name
  }

  put(c: number, r: number, value: CellValue = null, { fmt = null as string | null, fill = null as PatternFill | null,
    font: f = null as Font | null, align = null as Alignment | null, border: boxed = true } = {}): Cell {
    const cell = this.ws.cell(r, c, value)
    if (fmt) cell.numberFormat = fmt
    if (fill !== null) cell.fill = fill
    if (f !== null) cell.font = f
    if (align !== null) cell.alignment = align
    if (boxed) cell.border = BOX
    return cell
  }

  /** An orange, unlocked input cell. */
  inp(c: number, r: number, value: CellValue = null, { fmt = null as string | null } = {}): Cell {
    const cell = this.put(c, r, value, { fmt, fill: FILL_INPUT })
    asText(cell, value)
    cell.protection = UNLOCKED
    this.inputs.push(a1(c, r))
    return cell
  }

  /** A grey calculated cell (a formula, or a value the app computed). */
  calc(c: number, r: number, formula: CellValue, { fmt = null as string | null, bold = false } = {}): Cell {
    return this.put(c, r, formula, { fmt, fill: FILL_CALC, font: bold ? FONT_BOLD : null })
  }

  text(c: number, r: number, value: CellValue, { bold = false, border: boxed = true, fmt = null as string | null } = {}): Cell {
    const cell = this.put(c, r, value, { font: bold ? FONT_BOLD : null, border: boxed, fmt })
    asText(cell, value)
    return cell
  }

  head(c: number, r: number, value: CellValue, { width = null as number | null } = {}): Cell {
    const cell = this.put(c, r, value, { fill: FILL_HEAD, font: FONT_HEAD, align: CENTER })
    if (width) this.ws.column(c).width = width
    return cell
  }

  title(text: string, note: string | null = null): void {
    this.ws.cell(1, 1, text).font = FONT_TITLE
    if (note) {
      const c = this.ws.cell(2, 1, note)
      c.font = FONT_NOTE
      c.alignment = alignment({ wrapText: false })
    }
  }

  width(c: number, w: number): void {
    this.ws.column(c).width = w
  }

  protect(): void {
    this.ws.protection = { password: PASSWORD, formatColumns: false, formatRows: false, autoFilter: false, sort: false }
  }
}
