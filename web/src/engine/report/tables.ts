// The Report page's tables as files (ceica/report/files.py): CSV for analysis, and Excel workbooks (one
// table, or every table with a Contents sheet), numbers kept as numbers.
import { csvRow } from '../../files/csv'
import { type CellValue, Workbook, type Worksheet } from '../../files/xlsx/book'
import { alignment, font } from '../../files/xlsx/styles'
import { utf8 } from '../../py/bytes'
import { pyFixed } from '../../py/pyfmt'
import { pyLen } from '../../py/pystr'
import type { AnalysisResults } from '../analysis'
import { NA } from '../fmt'
import { shortDigest } from '../projectfile'
import { APP_NAME, APP_VERSION, ENGINE_VERSION } from '../version'
import { asText, C_HEAD, CENTER, FILL_HEAD, FMT_INT, FMT_USD, FMT_USD2, FONT_HEAD, FONT_NOTE, WRAP } from '../workbook/xl'
import {
  type Cell, catalog, cellText, type Column, columnSide, EXCEL_PLAN_ROWS, type Exhibit, exhibitLabel, PyInt, type TableData,
} from './exhibits'

/** CSV rows per block (the Python streams a table in blocks; joined, the bytes are the same). */
export const CSV_BLOCK = 5_000

function csvNumber(v: number): string {
  const s = pyFixed(v, 10).replace(/0+$/, '').replace(/\.+$/, '')
  return s === '' || s === '-0' ? '0' : s
}

/** A cell for analysis: numbers unformatted, TRUE or FALSE, blank when missing (csv_value). */
export function csvValue(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof PyInt) return String(v.value)
  if (typeof v === 'number') return Number.isNaN(v) ? '' : csvNumber(v)
  return v
}

/** The table as UTF-8 CSV with a byte order mark (Excel then reads the encoding right). */
export function tableCsv(t: TableData): Uint8Array {
  const blocks: Uint8Array[] = [utf8('﻿' + csvRow(t.columns.map((c) => c.name)))]
  const n = t.rows.length
  for (let start = 0; start < n; start += CSV_BLOCK) {
    const parts: string[] = []
    for (let k = start; k < Math.min(n, start + CSV_BLOCK); k++) parts.push(csvRow(t.rows[k].map(csvValue)))
    blocks.push(utf8(parts.join('')))
  }
  let size = 0
  for (const b of blocks) size += b.length
  const out = new Uint8Array(size)
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.length
  }
  return out
}

// --- tables: Excel ---------------------------------------------------------------------------------

function xlFormat(c: Column): string | null {
  if (c.kind === 'money') return c.decimals === 2 ? FMT_USD2 : FMT_USD
  if (c.kind === 'number') return '#,##0' + (c.decimals ? '.' + '0'.repeat(c.decimals) : '')
  if (c.kind === 'count') return FMT_INT
  return null
}

function xlValue(v: Cell): CellValue {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return NA
  if (v === '') return null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (v instanceof PyInt) return v.value
  return v
}

/** One table on a sheet: "Table n. caption" in A1, a note under it, then the header row (the same look as
 * the calculator) and the rows, numbers kept as numbers (write_table). */
export function writeTable(ws: Worksheet, ex: Exhibit, t: TableData): void {
  const head = 3
  const title = ws.cell(1, 1, `${exhibitLabel(ex)}. ${ex.caption}`)
  title.font = font({ bold: true, size: 11, color: C_HEAD })
  asText(title, title.value)
  if (t.note) {
    const note = ws.cell(2, 1, t.note)
    note.font = FONT_NOTE
    asText(note, t.note)
  }
  const widths = t.columns.map((c) => pyLen(c.name))
  t.columns.forEach((c, k) => {
    const cell = ws.cell(head, k + 1, c.name)
    cell.fill = FILL_HEAD
    cell.font = FONT_HEAD
    cell.alignment = CENTER
    asText(cell, c.name)
  })
  const fmts = t.columns.map(xlFormat)
  const n = t.rows.length
  const last = n - 1
  for (let i = 0; i < n; i++) {
    const row = t.rows[i]
    const r = head + 1 + i
    const bold = t.total_last && i === last
    for (let k = 0; k < Math.min(row.length, t.columns.length); k++) {
      const v = row[k]
      const c = t.columns[k]
      const fmt = fmts[k]
      const val = xlValue(v)
      const cell = ws.cell(r, k + 1, val)
      if (typeof val === 'string') asText(cell, val)
      else if (fmt && val !== null) cell.numberFormat = fmt
      if (columnSide(c) === 'c' || val === NA) cell.alignment = alignment({ horizontal: 'center' })
      if (bold) cell.font = font({ bold: true })
      if (i < 300) widths[k] = Math.max(widths[k], pyLen(cellText(v, c)))
    }
  }
  widths.forEach((w, k) => {
    ws.column(k + 1).width = Math.min(Math.max(w + 2, 8), 60)
    if (w > 58) for (let r = head + 1; r < head + 2 + last; r++) ws.cell(r, k + 1).alignment = WRAP
  })
  ws.freezePanes = ws.cell(head + 1, 1).coordinate
}

/** One table as a workbook (its plan rows capped at EXCEL_PLAN_ROWS). */
export function tableXlsx(ex: Exhibit): Uint8Array {
  const wb = new Workbook()
  const ws = wb.sheets[wb.active]
  ws.title = `Table ${ex.number}`
  writeTable(ws, ex, ex.build({ limit: EXCEL_PLAN_ROWS }) as TableData)
  return wb.save()
}

/** Every table in one workbook: a Contents sheet with links, then a sheet per table. */
export function tablesXlsx(res: AnalysisResults, exhibits: readonly Exhibit[] | null = null): Uint8Array {
  const all = exhibits ?? catalog(res)
  const p = res.project
  const wb = new Workbook()
  const contents = wb.sheets[wb.active]
  contents.title = 'Contents'
  const top = contents.cell(1, 1, `${p.report.title || p.name}: tables`)
  top.font = font({ bold: true, size: 14, color: C_HEAD })
  asText(top, top.value)
  contents.cell(2, 1, `${APP_NAME} ${APP_VERSION}, engine ${ENGINE_VERSION}; project digest ${shortDigest(p)}`).font = FONT_NOTE
  ;([['Table', 10], ['Title', 30], ['Caption', 90], ['Rows', 8]] as const).forEach(([name, width], k) => {
    const cell = contents.cell(4, k + 1, name)
    cell.fill = FILL_HEAD
    cell.font = FONT_HEAD
    cell.alignment = CENTER
    contents.column(k + 1).width = width
  })
  let r = 5
  for (const ex of all) {
    if (ex.kind !== 'table') continue
    const sheet = `Table ${ex.number}`
    const t = ex.build({ limit: EXCEL_PLAN_ROWS }) as TableData
    writeTable(wb.createSheet(sheet), ex, t)
    const link = contents.cell(r, 1, exhibitLabel(ex))
    link.hyperlink = `'${sheet}'!A1`
    link.named = 'Hyperlink'
    for (const [k, value] of [[2, ex.title], [3, ex.caption]] as const) {
      const cell = contents.cell(r, k, value)
      asText(cell, value)
      cell.alignment = WRAP
    }
    contents.cell(r, 4, t.rows.length).numberFormat = FMT_INT
    r++
  }
  contents.freezePanes = contents.cell(5, 1).coordinate
  return wb.save()
}
