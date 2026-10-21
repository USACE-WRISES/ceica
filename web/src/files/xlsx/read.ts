// Reading a workbook as openpyxl 3.1.5's load_workbook(data, data_only=False) gives it to CEICA (the
// calculator importer and the template reader): the sheets in order with their states, and each cell's
// value as openpyxl gives it.
//
// - A number is an int unless its text has ".", "E" or "e" (then a float); a cell whose number format
//   is a date or time format holds a datetime, a time or a timedelta instead.
// - Text comes from the shared strings (runs joined, "x005F_" dropped) or the cell (inline or "str").
// - A formula reads as "=" and its text; a shared formula's later cells get the first cell's formula
//   with its references moved (formula.ts).
// - Booleans read as booleans and error codes as their text.
//
// Every <c> element makes a cell, as do merged ranges, hyperlinks and comments; reading a cell that is
// not there makes it (ws.cell(), ws["B4"]); max_row and max_column count them all.
import { pyRoundInt } from '../../py/pynum'
import { fromUtf8 } from '../../py/bytes'
import { pyFloat } from '../../py/pyfmt'
import { pyFloatText, pyStrRepr, PyTypeError, PyValueError } from '../../py/pystr'
import { readZip, type ZipArchive } from '../zip'
import { childNamed, childrenNamed, parseXml, type XmlElement } from '../xml'
import { colLetter } from './book'
import { Translator } from './formula'
import { BUILTIN_FORMATS } from './styles'

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const SHARED_STRINGS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
const XLTX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'
const XLTM = 'application/vnd.ms-excel.template.macroEnabled.main+xml'

// --- Python's values ----------------------------------------------------------------------------------

/** A Python float (a JavaScript number is a Python int here). */
export class PyFloat {
  constructor(readonly value: number) {}
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** A datetime, a time or a timedelta, as openpyxl reads a date-formatted number. */
export class XlDate {
  private constructor(readonly kind: 'datetime' | 'time' | 'timedelta', readonly f: readonly number[]) {}

  static datetime(y: number, mo: number, d: number, h: number, mi: number, s: number, us: number): XlDate {
    return new XlDate('datetime', [y, mo, d, h, mi, s, us])
  }

  static time(h: number, mi: number, s: number, us: number): XlDate {
    return new XlDate('time', [h, mi, s, us])
  }

  /** normalized as Python keeps it: 0 <= seconds < 86400, 0 <= microseconds < 10**6 */
  static timedelta(days: number, seconds: number, us: number): XlDate {
    return new XlDate('timedelta', [days, seconds, us])
  }

  /** the type's name in Python's messages */
  get typeName(): string {
    return `datetime.${this.kind}`
  }

  str(): string {
    const f = this.f
    const frac = (us: number): string => (us ? `.${pad(us, 6)}` : '')
    if (this.kind === 'datetime') return `${pad(f[0], 4)}-${pad(f[1])}-${pad(f[2])} ${pad(f[3])}:${pad(f[4])}:${pad(f[5])}${frac(f[6])}`
    if (this.kind === 'time') return `${pad(f[0])}:${pad(f[1])}:${pad(f[2])}${frac(f[3])}`
    const [days, secs, us] = f
    const hms = `${Math.floor(secs / 3600)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}${frac(us)}`
    return days ? `${days} day${Math.abs(days) !== 1 ? 's' : ''}, ${hms}` : hms
  }

  repr(): string {
    const f = this.f
    const tail = (s: number, us: number): string => (us ? `, ${s}, ${us}` : s ? `, ${s}` : '')
    if (this.kind === 'datetime') return `datetime.datetime(${f[0]}, ${f[1]}, ${f[2]}, ${f[3]}, ${f[4]}${tail(f[5], f[6])})`
    if (this.kind === 'time') return `datetime.time(${f[0]}, ${f[1]}${tail(f[2], f[3])})`
    const parts = [['days', f[0]], ['seconds', f[1]], ['microseconds', f[2]]].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`)
    return `datetime.timedelta(${parts.length ? parts.join(', ') : '0'})`
  }
}

/** A cell's value as openpyxl gives it: None, a bool, an int (a number, or a bigint past 2**53), a
 * float, text, or a date. */
export type XlValue = null | boolean | number | bigint | PyFloat | string | XlDate

/** str(value) */
export function pyStrOf(v: XlValue): string {
  if (v === null) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (v instanceof PyFloat) return pyFloat(v.value)
  if (v instanceof XlDate) return v.str()
  return v
}

/** repr(value) */
export function pyReprOf(v: XlValue): string {
  if (typeof v === 'string') return pyStrRepr(v)
  if (v instanceof XlDate) return v.repr()
  return pyStrOf(v)
}

/** bool(value) */
export function pyTruthyOf(v: XlValue): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'bigint') return v !== 0n
  if (v instanceof PyFloat) return v.value !== 0
  if (v instanceof XlDate) return v.kind !== 'timedelta' || v.f.some((x) => x !== 0)
  return v !== ''
}

/** float(value): Python's ValueError for text that is not a number, its TypeError for anything else
 * that is not one. */
export function pyFloatOf(v: XlValue): number {
  if (typeof v === 'boolean') return v ? 1.0 : 0.0
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof PyFloat) return v.value
  if (typeof v === 'string') return pyFloatText(v)
  const type = v === null ? 'NoneType' : v.typeName
  throw new PyTypeError(`float() argument must be a string or a real number, not '${type}'`)
}

/** Python's type name of a value (for messages such as pydantic's input_type) */
export function pyTypeOf(v: XlValue): string {
  if (v === null) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number' || typeof v === 'bigint') return 'int'
  if (v instanceof PyFloat) return 'float'
  if (v instanceof XlDate) return v.kind
  return 'str'
}

// --- dates ----------------------------------------------------------------------------------------------

/** proleptic Gregorian ordinals (0001-01-01 is 1) of 1970-01-01 and the two epochs */
const ORD_1970 = 719163
const WINDOWS_EPOCH = 693594 // 1899-12-30
const MAC_EPOCH = 695056 // 1904-01-01

function ymd(ordinal: number): [number, number, number] | null {
  const d = new Date((ordinal - ORD_1970) * 86400000)
  const y = d.getUTCFullYear()
  if (y < 1 || y > 9999) return null
  return [y, d.getUTCMonth() + 1, d.getUTCDate()]
}

/** round(): half to even */
const roundHalfEven = (x: number): number => pyRoundInt(x)

/** timedelta(days=value), normalized: [days, seconds, microseconds] */
function timedeltaDays(value: number): [number, number, number] {
  let d: number
  let s = 0
  let frac = 0
  if (Number.isInteger(value)) d = value
  else {
    // timedelta's own float arithmetic: modf of the days, then of the day's seconds
    d = Math.trunc(value)
    const dayFrac = value - d
    const secs = dayFrac * 86400.0
    s = Math.trunc(secs)
    frac = secs - s
  }
  let us = roundHalfEven(frac * 1e6)
  s += Math.floor(us / 1e6)
  us = ((us % 1e6) + 1e6) % 1e6
  d += Math.floor(s / 86400)
  s = ((s % 86400) + 86400) % 86400
  return [d, s, us]
}

/** from_excel(value, epoch, timedelta): a date-formatted cell's serial number as openpyxl reads it, or
 * null where it is outside the dates Python holds (the cell then reads as "#VALUE!"). */
function fromExcel(value: number, epoch: number, delta: boolean): XlDate | null {
  if (delta) {
    const [d, s, us] = timedeltaDays(value)
    if (!us) return XlDate.timedelta(d, s, us)
    // to millisecond precision: timedelta(seconds=total_seconds() // 1, microseconds=round(us, -3))
    let secs = Math.floor(d * 86400 + s + us / 1e6)
    let micro = roundHalfEven(us / 1000) * 1000
    if (micro >= 1e6) {
      secs += 1
      micro -= 1e6
    }
    const days = Math.floor(secs / 86400)
    return XlDate.timedelta(days, secs - days * 86400, micro)
  }
  let day = Math.floor(value)
  const fraction = value - day
  // timedelta(milliseconds=round(fraction * SECS_PER_DAY * 1000))
  const ms = roundHalfEven(fraction * 86400 * 1000)
  const diffDays = Math.floor(ms / 86400000)
  const diffMs = ms - diffDays * 86400000
  if (value >= 0 && value < 1 && diffDays === 0) {
    const secs = Math.floor(diffMs / 1000)
    return XlDate.time(Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60, (diffMs % 1000) * 1000)
  }
  if (value > 0 && value < 60 && epoch === WINDOWS_EPOCH) day += 1
  const date = ymd(epoch + day + diffDays)
  if (date === null) return null
  const secs = Math.floor(diffMs / 1000)
  return XlDate.datetime(date[0], date[1], date[2], Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60, (diffMs % 1000) * 1000)
}

/** from_ISO8601 for a cell typed "d" */
function fromIso(text: string): XlDate | null {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2}))?T?(?:(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?Z?/.exec(text)
  if (!m || !m.slice(1).some((x) => x !== undefined)) return null
  const us = m[7] ? Math.round(Number(m[7]) * 1e6) : 0
  const [h, mi, s] = [m[4], m[5], m[6]].map((x) => (x ? Number(x) : 0))
  if (!m[1]) return XlDate.time(h, mi, s, us)
  return XlDate.datetime(Number(m[1]), Number(m[2]), Number(m[3]), h, mi, s, us)
}

// --- number formats -------------------------------------------------------------------------------------

const STRIP_RE = /".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g
const DATE_RE = /(?<![_\\])[dmhysDMHYS]/
const TIMEDELTA_RE = /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/i

function isDateFormat(fmt: string | undefined): boolean {
  if (fmt === undefined) return false
  return DATE_RE.test(fmt.split(';')[0].replace(STRIP_RE, ''))
}

function isTimedeltaFormat(fmt: string | undefined): boolean {
  if (fmt === undefined) return false
  return TIMEDELTA_RE.test(fmt.split(';')[0])
}

// --- the workbook -------------------------------------------------------------------------------------------

/** A cell as read: its value and openpyxl's data type ("n", "s", "b", "e", "f", "d"). */
export interface ReadCell {
  value: XlValue
  dataType: string
}

export class ReadSheet {
  state = 'visible'
  private readonly cells = new Map<number, ReadCell>()
  private rows = 0
  private cols = 0

  constructor(readonly title: string) {}

  private static key(row: number, col: number): number {
    return row * 16384 + col
  }

  /** set a cell as the reader binds it */
  put(row: number, col: number, cell: ReadCell): void {
    this.cells.set(ReadSheet.key(row, col), cell)
    if (row > this.rows) this.rows = row
    if (col > this.cols) this.cols = col
  }

  has(row: number, col: number): boolean {
    return this.cells.has(ReadSheet.key(row, col))
  }

  /** ws.cell(row, column): the cell, made empty if it is not there */
  cell(row: number, col: number): ReadCell {
    const c = this.cells.get(ReadSheet.key(row, col))
    if (c) return c
    const made: ReadCell = { value: null, dataType: 'n' }
    this.put(row, col, made)
    return made
  }

  /** ws["B4"] */
  at(coord: string): ReadCell {
    const [row, col] = cellTuple(coord)
    return this.cell(row, col)
  }

  /** every cell, by row then column: [row, column, cell] */
  entries(): [number, number, ReadCell][] {
    return [...this.cells].sort((a, b) => a[0] - b[0]).map(([k, c]) => [Math.floor(k / 16384), k % 16384, c])
  }

  get maxRow(): number {
    return Math.max(this.rows, 1)
  }

  get maxColumn(): number {
    return Math.max(this.cols, 1)
  }
}

export class ReadBook {
  readonly sheets: ReadSheet[] = []

  get sheetnames(): string[] {
    return this.sheets.map((s) => s.title)
  }

  /** wb[name] */
  sheet(name: string): ReadSheet {
    const ws = this.sheets.find((s) => s.title === name)
    if (!ws) throw new KeyError(`Worksheet ${name} does not exist.`)
    return ws
  }
}

/** Python's KeyError: its str() is the repr of its argument. */
export class KeyError extends Error {
  constructor(readonly key: string) {
    super(pyStrRepr(key))
  }
}

/** What openpyxl raises for a file it cannot read: ``message`` is str() of the Python exception. */
export class WorkbookReadError extends Error {
  /** the Python exception's name: OSError, or ValueError where openpyxl names the step it failed at */
  constructor(message: string, readonly pyName: 'OSError' | 'ValueError') {
    super(message)
  }
}

function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n
}

/** coordinate_to_tuple: "B4" as [row, column] */
function cellTuple(coord: string): [number, number] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(coord)
  if (!m || Number(m[2]) < 1) throw new PyValueError(`Invalid cell coordinates (${coord})`)
  return [Number(m[2]), columnIndex(m[1])]
}

/** range_boundaries: [min_row, min_col, max_row, max_col] */
function rangeTuple(ref: string): [number, number, number, number] {
  const [a, b] = ref.split(':')
  const [r1, c1] = cellTuple(a)
  const [r2, c2] = b === undefined ? [r1, c1] : cellTuple(b)
  return [r1, c1, r2, c2]
}

/** posixpath.normpath of a relative zip path */
function normpath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else out.push('..')
    } else out.push(part)
  }
  return out.join('/')
}

const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** get_rels_path */
const relsPath = (path: string): string => {
  const folder = dirname(path)
  const name = path.slice(folder ? folder.length + 1 : 0)
  return (folder ? `${folder}/` : '') + `_rels/${name}.rels`
}

interface Rel { readonly id: string, readonly type: string, readonly target: string }

/** get_dependents: a part's relationships, their targets as zip paths */
function dependents(zip: ZipArchive, path: string): Rel[] {
  const root = xml(zip, path)
  const folder = dirname(path)
  const parent = dirname(folder)
  return childrenNamed(root, 'Relationship').map((r) => {
    let target = r.attrs.get('Target') ?? ''
    if (r.attrs.get('TargetMode') !== 'External') {
      target = target.startsWith('/') ? target.slice(1) : normpath(parent ? `${parent}/${target}` : target)
    }
    return { id: r.attrs.get('Id') ?? '', type: r.attrs.get('Type') ?? '', target }
  })
}

function xml(zip: ZipArchive, path: string): XmlElement {
  return parseXml(fromUtf8(zip.read(path)))
}

/** Text.from_tree(node).content: the plain text and the runs' texts */
function content(node: XmlElement): string {
  let out = ''
  const t = childNamed(node, 't')
  if (t && t.text !== null) out += t.text
  for (const r of childrenNamed(node, 'r')) {
    const rt = childNamed(r, 't')
    if (rt && rt.text !== null) out += rt.text
  }
  return out
}

/** The Bool descriptor: "false", "f" and "0" are False, any other text True */
const boolAttr = (v: string | undefined): boolean => v !== undefined && !['false', 'f', '0'].includes(v)

/** int(text) */
function pyInt(text: string): number | bigint {
  const s = text.trim()
  if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new PyValueError(`invalid literal for int() with base 10: ${pyStrRepr(text)}`)
  const n = Number(s.replace(/_/g, ''))
  return Number.isSafeInteger(n) ? n : BigInt(s.replace(/_/g, ''))
}

/** _cast_number */
function castNumber(text: string): number | bigint | PyFloat {
  if (text.includes('.') || text.includes('E') || text.includes('e')) return new PyFloat(pyFloatText(text))
  return pyInt(text)
}

interface Styles { dates: Set<number>, deltas: Set<number> }

/** apply_stylesheet's date and timedelta formats by cell style index */
function readStyles(zip: ZipArchive): Styles {
  const dates = new Set<number>()
  const deltas = new Set<number>()
  if (!zip.has('xl/styles.xml')) return { dates, deltas }
  const root = xml(zip, 'xl/styles.xml')
  const custom = new Map<number, string>()
  const numFmts = childNamed(root, 'numFmts')
  if (numFmts) for (const n of childrenNamed(numFmts, 'numFmt')) custom.set(Number(n.attrs.get('numFmtId')), n.attrs.get('formatCode') ?? '')
  const xfs = childNamed(root, 'cellXfs')
  ;(xfs ? childrenNamed(xfs, 'xf') : []).forEach((xf, idx) => {
    const id = Number(xf.attrs.get('numFmtId') ?? 0)
    const fmt = custom.has(id) ? custom.get(id) : BUILTIN_FORMATS.get(id)
    if (isDateFormat(fmt)) dates.add(idx)
    if (isTimedeltaFormat(fmt)) deltas.add(idx)
  })
  return { dates, deltas }
}

/** Read one worksheet's cells into ``ws`` (WorksheetReader.bind_cells, bind_merged_cells, bind_hyperlinks). */
function readSheet(ws: ReadSheet, root: XmlElement, strings: readonly string[], styles: Styles, epoch: number, dataOnly: boolean): void {
  const shared = new Map<string, Translator>()
  const data = childNamed(root, 'sheetData')
  let rowCounter = 0
  for (const row of data ? childrenNamed(data, 'row') : []) {
    const r = row.attrs.get('r')
    if (r !== undefined) {
      const n = Number(r)
      if (!Number.isInteger(n)) throw new PyValueError(`${r} is not a valid row number`)
      rowCounter = n
    } else rowCounter += 1
    let colCounter = 0
    for (const c of row.children) {
      let dataType = c.attrs.get('t') ?? 'n'
      const coord = c.attrs.get('r')
      const styleId = Number(c.attrs.get('s') ?? 0)
      let value: XlValue = null
      if (dataType !== 'inlineStr') value = childNamed(c, 'v')?.text || null
      let row0: number
      let col0: number
      if (coord) {
        ;[row0, col0] = cellTuple(coord)
        colCounter = col0
      } else {
        colCounter += 1
        row0 = rowCounter
        col0 = colCounter
      }
      // data_only: a formula's cell holds the value Excel saved with it
      const f = dataOnly ? null : childNamed(c, 'f')
      if (f !== null) {
        dataType = 'f'
        let formula = '=' + (f.text ?? '')
        if (f.attrs.get('t') === 'shared') {
          const si = f.attrs.get('si') ?? ''
          const tr = shared.get(si)
          if (tr) formula = tr.translate(coord ?? null)
          else if (formula !== '=') shared.set(si, new Translator(formula, coord ?? ''))
        }
        value = formula
      } else if (value !== null) {
        const text = value as string
        if (dataType === 'n') {
          const num = castNumber(text)
          value = num
          if (styles.dates.has(styleId)) {
            dataType = 'd'
            const date = fromExcel(num instanceof PyFloat ? num.value : Number(num), epoch, styles.deltas.has(styleId))
            if (date === null) {
              dataType = 'e'
              value = '#VALUE!'
            } else value = date
          }
        } else if (dataType === 's') {
          const k = Number(text)
          if (!(k >= 0 && k < strings.length)) throw new Error('list index out of range')
          value = strings[k]
        } else if (dataType === 'b') value = Number(pyInt(text)) !== 0
        else if (dataType === 'str') dataType = 's'
        else if (dataType === 'd') value = fromIso(text)
      } else if (dataType === 'inlineStr') {
        const is = childNamed(c, 'is')
        if (is) {
          dataType = 's'
          value = content(is)
        }
      }
      ws.put(row0, col0, { value, dataType })
    }
  }
  // merged ranges: the top-left cell stays (made if new), the others become empty merged cells
  const merges = childNamed(root, 'mergeCells')
  for (const m of merges ? childrenNamed(merges, 'mergeCell') : []) {
    const [r1, c1, r2, c2] = rangeTuple(m.attrs.get('ref') ?? '')
    ws.cell(r1, c1)
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) ws.put(r, c, { value: null, dataType: 'n' })
    }
  }
  const links = childNamed(root, 'hyperlinks')
  for (const h of links ? childrenNamed(links, 'hyperlink') : []) {
    const [r1, c1, r2, c2] = rangeTuple(h.attrs.get('ref') ?? '')
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ws.cell(r, c)
  }
}

/** load_workbook(BytesIO(data), data_only=) as far as CEICA reads a workbook. Raises what openpyxl
 * raises for a file it cannot read (BadZipFile, KeyError, OSError), with Python's message. */
export function loadWorkbook(data: Uint8Array, { dataOnly = false } = {}): ReadBook {
  const zip = readZip(data)
  const stage = { action: 'read manifest' }
  try {
    return readBook(zip, stage, dataOnly)
  } catch (exc) {
    // ExcelReader.read: a ValueError becomes one that names the step
    if (exc instanceof PyValueError) {
      throw new WorkbookReadError(`Unable to read workbook: could not ${stage.action} from None.\nThis is most probably because the `
        + 'workbook source files contain some invalid XML.\nPlease see the exception for more details.', 'ValueError')
    }
    throw exc
  }
}

function readBook(zip: ZipArchive, stage: { action: string }, dataOnly: boolean): ReadBook {
  const types = xml(zip, '[Content_Types].xml')
  const overrides = childrenNamed(types, 'Override').map((o) => [o.attrs.get('PartName') ?? '', o.attrs.get('ContentType') ?? ''] as const)
  const defaults = new Set(childrenNamed(types, 'Default').map((d) => d.attrs.get('ContentType') ?? ''))
  const find = (ct: string): string | null => overrides.find(([, t]) => t === ct)?.[0] ?? null
  stage.action = 'read strings'
  const strings: string[] = []
  const sst = find(SHARED_STRINGS)
  if (sst !== null) {
    for (const si of childrenNamed(xml(zip, sst.slice(1)), 'si')) strings.push(content(si).replaceAll('x005F_', ''))
  }
  stage.action = 'read workbook'
  let part: string | null = null
  for (const ct of [XLTM, XLTX, XLSM, XLSX]) {
    part = find(ct)
    if (part) break
  }
  if (!part && [XLTM, XLTX, XLSM, XLSX].some((ct) => defaults.has(ct))) part = '/xl/workbook.xml'
  if (!part) throw new WorkbookReadError('File contains no valid workbook part', 'OSError')
  const wbPath = part.slice(1)
  const wbRoot = xml(zip, wbPath)
  const pr = childNamed(wbRoot, 'workbookPr')
  const epoch = pr && boolAttr(pr.attrs.get('date1904')) ? MAC_EPOCH : WINDOWS_EPOCH
  const sheetsEl = childNamed(wbRoot, 'sheets')
  const sheets = sheetsEl ? childrenNamed(sheetsEl, 'sheet') : []
  stage.action = 'read stylesheet'
  const styles = readStyles(zip)
  stage.action = 'read worksheets'
  const book = new ReadBook()
  let rels: Map<string, Rel> | null = null
  for (const s of sheets) {
    const id = s.attrs.get(`{${R_NS}}id`)
    if (!id) continue
    rels ??= new Map(dependents(zip, relsPath(wbPath)).map((r) => [r.id, r]))
    const rel = rels.get(id)
    if (!rel) throw new KeyError(id)
    if (!zip.has(rel.target)) continue
    const ws = new ReadSheet(s.attrs.get('name') ?? '')
    book.sheets.push(ws)
    if (!rel.type.includes('chartsheet')) {
      readSheet(ws, xml(zip, rel.target), strings, styles, epoch, dataOnly)
      // comments: ws[ref].comment makes the cell
      const sheetRels = relsPath(rel.target)
      if (zip.has(sheetRels)) {
        for (const r of dependents(zip, sheetRels)) {
          if (r.type !== COMMENTS) continue
          const list = childNamed(xml(zip, r.target), 'commentList')
          for (const c of list ? childrenNamed(list, 'comment') : []) ws.at(c.attrs.get('ref') ?? '')
        }
      }
    }
    ws.state = s.attrs.get('state') ?? 'visible'
  }
  return book
}

export { colLetter }
