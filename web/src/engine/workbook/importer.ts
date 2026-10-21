// Reading an Excel workbook back into a project (ceica/workbook/importer.py).
//
// A CEICA calculator carries its project and a layout registry in a hidden sheet. Import starts from that
// project, applies every input cell that differs (listing each change), then maps the final array flags
// and the TSP back to plan compositions using the imported recommendations.
//
// Layout paths point into the project as it was exported. A path element {"module_id": id} picks a
// module's values by id, never by position. A calculator exported before modules existed (project
// schema 1) has its edits applied to that older project first, which is then migrated.
//
// A blank template (template.ts) is read by its table headers instead.
//
// Values keep Python's types throughout (the reader's ints and floats, the project's floats as the
// manifest wrote them), so each change reads as str() writes it ("300000.0 to 500000.0").
import { pyFloat } from '../../py/pyfmt'
import { isMarkedFloat, JsonError, markFloat, parseJson, pyClone, pyEntries, pySet } from '../../py/pyjson'
import { pyRoundInt } from '../../py/pynum'
import { pyStrip, PyTypeError, PyValueError } from '../../py/pystr'
import { type ReadBook, loadWorkbook, PyFloat, pyFloatOf, pyReprOf, pyStrOf, pyTruthyOf, type XlValue, XlDate } from '../../files/xlsx/read'
import { analyze, wsIndexOfKey } from '../analysis'
import {
  compositionKey, copy, parseFinalArrayChoice, parseProject, parseStepNote, type Project, ValidationError, validationErrorText,
} from '../model'
import { planNumber, tableKey, tableLength } from '../plans'
import { jsonErrorText, migrateProject, ProjectFileError } from '../projectfile'
import { readTemplate } from './template'

/** A workbook that cannot be imported; the message is shown to the user. */
export class WorkbookError extends Error {}

/** One change the import applied, its values as str() writes them. */
export interface Change {
  readonly where: string
  readonly before: string
  readonly after: string
}

export interface ImportResult {
  readonly project: Project
  readonly changes: readonly Change[]
  readonly warnings: readonly string[]
  readonly source: 'calculator' | 'template'
}

const SH_STAF_NAME = 'STAF scores'

type Doc = any
type PathItem = string | number | Record<string, unknown>

/** A number as Python holds it after the import's float() and int(round()): an int or a float */
interface PyNum { readonly n: number, readonly float: boolean }
/** what _coerce returns: None, text, or a number */
type Coerced = null | string | PyNum

const strOfCoerced = (v: Coerced): string => (v === null ? 'None' : typeof v === 'string' ? v : v.float ? pyFloat(v.n) : String(v.n))

/** str() of a value read from the project's JSON (its floats as the manifest wrote them) */
function strOfJson(v: unknown, float: boolean): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return float || !Number.isInteger(v) ? pyFloat(v) : String(v)
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** _find: the record in ``items`` whose field matches the one-entry ``key`` ({"module_id": "RipL"}) */
function find(items: unknown, key: Record<string, unknown>): Doc | null {
  const [[k, v]] = Object.entries(key)
  if (!Array.isArray(items)) return null
  return items.find((x) => x !== null && typeof x === 'object' && !Array.isArray(x) && x[k] === v) ?? null
}

const isDict = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

/** _get: the value at ``path`` (or null), and whether the JSON wrote it as a float */
function getPath(obj: unknown, path: readonly PathItem[]): { value: unknown, float: boolean } {
  let container: object | null = null
  let last: string | number = ''
  for (const p of path) {
    if (isDict(p)) {
      obj = Array.isArray(obj) ? find(obj, p) : null
      container = null
    } else if (isDict(obj)) {
      container = obj
      last = String(p)
      obj = Object.prototype.hasOwnProperty.call(obj, String(p)) ? obj[String(p)] : null
    } else if (Array.isArray(obj)) {
      container = obj
      last = p as number
      obj = typeof p === 'number' && p < obj.length ? obj[p] : null
    } else return { value: null, float: false }
    if (obj === null || obj === undefined) return { value: null, float: false }
  }
  return { value: obj, float: container !== null && isMarkedFloat(container, last) }
}

/** A coerced value as JSON: a number (marked as a float where Python's was) or text */
function asJson(v: Coerced): unknown {
  return v === null ? null : typeof v === 'string' ? v : v.n
}

/** _set: put ``value`` at ``path``, making the containers on the way */
function setPath(obj: Doc, path: readonly PathItem[], value: Coerced): void {
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]
    const next = path[i + 1]
    const empty = (): unknown => (typeof next === 'number' || isDict(next) ? [] : {})
    if (isDict(p)) {
      let item = find(obj, p)
      if (item === null) {
        item = { ...p }
        obj.push(item)
      }
      obj = item
    } else if (isDict(obj)) {
      if (obj[p] === null || obj[p] === undefined) pySet(obj, String(p), empty())
      obj = obj[p]
    } else {
      while (obj.length <= (p as number)) obj.push(null)
      if (obj[p as number] === null) obj[p as number] = empty()
      obj = obj[p as number]
    }
  }
  const last = path[path.length - 1]
  const float = value !== null && typeof value !== 'string' && value.float
  if (isDict(obj)) pySet(obj, String(last), asJson(value), float)
  else {
    while (obj.length <= (last as number)) obj.push(null)
    obj[last as number] = asJson(value)
    if (float) markFloat(obj, last as number)
  }
}

/** int(round(f)): banker's rounding, and Python's errors for infinity and NaN */
function intRound(f: number): number {
  if (Number.isNaN(f)) throw new PyValueError('cannot convert float NaN to integer')
  if (!Number.isFinite(f)) throw new OverflowError('cannot convert float infinity to integer')
  return pyRoundInt(f)
}

/** Python's OverflowError */
export class OverflowError extends Error {}

/** _coerce: a cell's value as the layout's kind wants it */
function coerce(value: XlValue, kind: string): Coerced {
  if (kind === 'text') return value === null ? '' : pyStrip(pyStrOf(value))
  if (value === null || (typeof value === 'string' && pyStrip(value) === '')) return null
  let v: XlValue = value
  if (typeof v === 'string') v = pyStrip(v.replaceAll(',', '').replaceAll('$', ''))
  let f: number
  try {
    f = pyFloatOf(v)
  } catch (exc) {
    if (exc instanceof PyValueError || exc instanceof PyTypeError) throw new WorkbookError(`Expected a number but found ${pyReprOf(v)}.`)
    throw exc
  }
  if (kind === 'int' || kind === 'optional_int') return { n: intRound(f), float: false }
  return { n: f, float: true }
}

const isNum = (v: unknown): v is number => typeof v === 'number' || typeof v === 'boolean'
const numOf = (v: unknown): number => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as number))

/** _same: equal for import purposes (blank and zero are the same number, except for "optional"
 * values, where a blank means not entered), floats to 1e-12 */
function same(old: unknown, nw: Coerced, kind: string): boolean {
  const newVal: unknown = nw === null ? null : typeof nw === 'string' ? nw : nw.n
  if (kind === 'text') return (pyOr(old) ?? '') === (pyOr(newVal) ?? '')
  const zeroOld = old === null || old === undefined || (isNum(old) && numOf(old) === 0)
  const zeroNew = newVal === null || (isNum(newVal) && numOf(newVal) === 0)
  if ((kind === 'number' || kind === 'int') && zeroOld && zeroNew) return true
  if (isNum(old) && isNum(newVal)) return Math.abs(numOf(old) - numOf(newVal)) <= 1e-12 * Math.max(1.0, Math.abs(numOf(old)))
  return (old ?? null) === newVal
}

/** ``x or None``: a falsy value as null */
const pyOr = (v: unknown): unknown => (v === null || v === undefined || v === '' || v === 0 || v === false ? null : v)

/** _label: the path's names, " > " between */
function label(path: readonly PathItem[]): string {
  return path.filter((p) => typeof p !== 'number').map((p) => (isDict(p) ? String(Object.values(p)[0]) : String(p))).join(' > ')
}

/** read_manifest: the calculator's project and layout, or null for another workbook */
export function readManifest(wb: ReadBook): [Doc, Doc] | null {
  if (!wb.sheetnames.includes('manifest')) return null
  const ws = wb.sheet('manifest')
  if (ws.at('A1').value !== 'ceica-calculator') return null
  const texts = new Map<string, string>()
  let r = 2
  while (pyTruthyOf(ws.cell(r, 1).value)) {
    const lab = pyStrOf(ws.cell(r, 1).value)
    const raw = ws.cell(r, 2).value
    const n = pyTruthyOf(raw) ? pyIntOf(raw) : 0
    let text = ''
    for (let k = 0; k < n; k++) {
      const v = ws.cell(r, 3 + k).value
      text += pyTruthyOf(v) ? pyStrOf(v) : ''
    }
    texts.set(lab, text)
    r++
  }
  // json.loads(texts["project"]), then the same for "meta"
  const load = (key: string): Doc => {
    if (!texts.has(key)) throw new KeyLookupError(key)
    const text = texts.get(key)!
    try {
      return parseJson(text)
    } catch (exc) {
      if (exc instanceof JsonError) throw new JsonDecodeError(jsonErrorText(exc, text))
      throw exc
    }
  }
  const project = load('project')
  return [project, load('meta')]
}

/** json.loads' JSONDecodeError, in its words */
export class JsonDecodeError extends Error {}

/** Python's KeyError of a missing key: str() is the key's repr */
export class KeyLookupError extends Error {
  constructor(key: string) {
    super(`'${key}'`)
  }
}

/** int(value) of a cell's value */
function pyIntOf(v: XlValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof PyFloat) return Math.trunc(v.value)
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    const s = pyStrip(v)
    if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new PyValueError(`invalid literal for int() with base 10: '${v}'`)
    return Number(s.replace(/_/g, ''))
  }
  throw new PyTypeError(`int() argument must be a string, a bytes-like object or a real number, not '${v instanceof XlDate ? v.typeName : 'NoneType'}'`)
}

/** read_workbook: the project in a calculator or a template, with the changes made in Excel. */
export function readWorkbook(data: Uint8Array): ImportResult {
  let wb: ReadBook
  try {
    wb = loadWorkbook(data)
  } catch (exc) {
    throw new WorkbookError(`This file could not be read as an Excel workbook (${(exc as Error).message}).`)
  }
  const manifest = readManifest(wb)
  if (manifest === null) return readTemplate(wb)
  const [doc, meta] = manifest
  const version = Math.trunc(Number(meta.schemaVersion ?? 1))
  let base: Project
  try {
    base = parseProject(migrateProject(pyClone(doc), version))
  } catch (exc) {
    if (exc instanceof ProjectFileError) throw new WorkbookError(`The project inside this calculator could not be read (${exc.message}).`)
    if (exc instanceof ValidationError) {
      const text = validationErrorText(exc, migrateProject(pyClone(doc), version))
      throw new WorkbookError(`The project inside this calculator could not be read (${text}).`)
    }
    throw exc
  }
  const work: Doc = pyClone(doc)
  const changes: Change[] = []
  const warnings: string[] = []
  const finals = new Map<number, number>()
  const worth = new Map<number, string>()
  const why = new Map<number, string>()
  let tspValue: number | null = null
  // (site index, module or null) -> function -> 1 or 0
  const assessed = new Map<string, { si: number, mid: string | null, flags: Map<string, number> }>()
  if (!Object.prototype.hasOwnProperty.call(meta, 'layout')) throw new KeyLookupError('layout')
  for (const entry of meta.layout as Doc[]) {
    const { sheet, cell, kind } = entry as { sheet: string, cell: string, kind: string }
    const path = entry.path as PathItem[]
    if (!wb.sheetnames.includes(sheet)) throw new WorkbookError(`The workbook is missing the '${sheet}' sheet.`)
    const raw = wb.sheet(sheet).at(cell).value
    if (typeof raw === 'string' && raw.startsWith('=')) throw new WorkbookError(`${sheet}!${cell} holds a formula; enter a value instead.`)
    const head = path.length ? path[0] : null
    if (head === '@final') {
      const v = coerce(raw, 'int') as PyNum | null
      finals.set(Number(path[1]), v ? v.n : 0)
      continue
    }
    if (head === '@assessed') {
      // schema 1: ["@assessed", site, function]; 2: ["@assessed", site, module, function]
      const si = Number(path[1])
      const mid = path.length === 4 ? String(path[2]) : null
      const key = JSON.stringify([si, mid])
      if (!assessed.has(key)) assessed.set(key, { si, mid, flags: new Map() })
      const v = coerce(raw, 'int') as PyNum | null
      assessed.get(key)!.flags.set(String(path[path.length - 1]), v ? v.n : 0)
      continue
    }
    if (head === '@tsp') {
      const v = coerce(raw, 'optional_int') as PyNum | null
      tspValue = v ? v.n : null
      continue
    }
    if (head === '@worth' || head === '@why') {
      ;(head === '@worth' ? worth : why).set(Number(path[1]), coerce(raw, 'text') as string)
      continue
    }
    if (kind === 'rec') {
      const value = coerce(raw, 'text') as string
      if (value === (entry.exported || '')) continue
      const old = getPath(work, path)
      if (value === (old.value || '')) continue
      if (!value) throw new WorkbookError(`${sheet}!${cell}: choose an alternative.`)
      setPath(work, path, value)
      changes.push({ where: `${sheet}!${cell} (${label(path)})`, before: strOfJson(old.value, old.float), after: value })
      continue
    }
    let value: Coerced
    try {
      value = coerce(raw, kind)
    } catch (exc) {
      if (exc instanceof WorkbookError) throw new WorkbookError(`${sheet}!${cell}: ${exc.message}`)
      throw exc
    }
    const old = getPath(work, path)
    if (same(old.value, value, kind)) continue
    setPath(work, path, value)
    changes.push({ where: `${sheet}!${cell} (${label(path)})`, before: strOfJson(old.value, old.float), after: strOfCoerced(value) })
  }
  for (const { si, mid, flags } of assessed.values()) {
    const site = work.sites[si]
    const nw = [...flags].filter(([, on]) => on === 0).map(([f]) => f)
    const current = site.staf_not_assessed
    let old: string[]
    if (mid === null) old = [...(pyTruthyJson(current) ? current : [])]
    else old = [...((pyTruthyJson(current) ? current : {})[mid] || [])]
    const sorted = (xs: string[]): string => JSON.stringify([...xs].sort())
    if (sorted(old) === sorted(nw)) continue
    if (mid === null) site.staf_not_assessed = nw
    else {
      const off: Record<string, unknown> = {}
      for (const [k, v] of pyEntries((pyTruthyJson(current) ? current : {}) as Record<string, unknown>)) off[k] = v
      if (nw.length) off[mid] = nw
      else delete off[mid]
      site.staf_not_assessed = off
    }
    changes.push({ where: `${SH_STAF_NAME} (${site.id}: functions assessed)`, before: old.join(', ') || 'all assessed', after: nw.join(', ') || 'all assessed' })
  }
  let migrated: Doc
  try {
    migrated = migrateProject(work, version)
  } catch (exc) {
    if (exc instanceof ProjectFileError) throw new WorkbookError(exc.message)
    throw exc
  }
  let project: Project
  try {
    project = parseProject(migrated)
  } catch (exc) {
    if (exc instanceof ValidationError) throw new WorkbookError(`An imported value is not valid at ${exc.loc.join('.')}: ${exc.msg}.`)
    throw exc
  }
  if (meta.liveWatershed) project = importDecisions(base, project, meta, finals, tspValue, worth, why, changes, warnings)
  return { project, changes, warnings, source: 'calculator' }
}

/** bool() of a JSON value */
const pyTruthyJson = (v: unknown): boolean => {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

const rowBits = (i: number, n: number): number[] => Array.from({ length: n }, (_, j) => Math.floor(i / 2 ** (n - 1 - j)) % 2)

/** _import_decisions: only the decision cells the user edited, mapped through the new recommendations */
function importDecisions(base: Project, project: Project, meta: Doc, finals: Map<number, number>, tspValue: number | null,
  worth: Map<number, string>, why: Map<number, string>, changes: Change[], warnings: string[]): Project {
  const baseRes = analyze(base)
  const res = analyze(project)
  const ws = res.watershed
  if (ws.ceica === null || baseRes.watershed.ceica === null) return project
  const table = ws.table!
  const sites = meta.planSites as string[]
  const rowKeys = new Map<number, string>(pyEntries((meta.planRowKeys ?? {}) as Record<string, string>).map(([k, v]) => [Number(k), v]))
  const baseFinal = new Set(baseRes.decisions.final_keys)
  const recs = new Map(sites.map((s) => [s, res.decisions.sites.get(s)?.alt_id ?? null]))
  const r1 = finals.size ? Math.min(...finals.keys()) : 0
  let wdec = project.decisions.watershed
  const overrides = new Map(wdec.final_array)
  const bbKeys = new Set<string>()
  ws.ceica.bb.forEach((b, i) => {
    if (b) bbKeys.add(tableKey(table, i))
  })
  let edited = false
  for (const [r, flag] of [...finals].sort((a, b) => a[0] - b[0])) {
    const exported = baseFinal.has(rowKeys.get(r) as string) ? 1 : 0
    if (flag === exported) continue
    const bits = rowBits(r - r1, sites.length)
    if (sites.some((s, j) => bits[j] && !ws.carried.has(s))) {
      warnings.push(`Watershed plans row ${r}: the final-array flag is on a plan that is not valid with the imported recommendations.`)
      continue
    }
    const comp = new Map<string, string>()
    sites.forEach((s, j) => {
      if (bits[j]) comp.set(s, recs.get(s) as string)
    })
    const key = compositionKey(comp)
    const note = overrides.get(key)?.note ?? ''
    if ((flag !== 0) === bbKeys.has(key) && !note) overrides.delete(key)
    else overrides.set(key, parseFinalArrayChoice({ included: flag !== 0, note }))
    edited = true
  }
  if (edited) {
    changes.push({ where: 'Watershed plans (final array)', before: '', after: 'edited' })
    wdec = copy(wdec, { final_array: overrides })
  }
  // TSP: only when the cell changed from its exported plan number
  const baseWs = baseRes.watershed
  let exportedTsp: number | null = null
  if (baseRes.decisions.tsp_key !== null) {
    const i = wsIndexOfKey(baseWs, baseRes.decisions.tsp_key)
    exportedTsp = i !== null ? Number(planNumber(baseWs.table!, i)) : null
  }
  if (tspValue !== exportedTsp) {
    let newTsp: string | null = null
    if (tspValue !== null) {
      let hit = -1
      for (let i = 0; i < tableLength(table); i++) {
        if (Number(planNumber(table, i)) === tspValue) {
          hit = i
          break
        }
      }
      newTsp = hit >= 0 ? tableKey(table, hit) : null
      if (hit < 0) warnings.push(`The TSP plan number ${tspValue} is not a valid plan.`)
    }
    changes.push({ where: 'Watershed summary (TSP)', before: wdec.tsp ?? 'None', after: newTsp ?? 'None' })
    wdec = copy(wdec, { tsp: newTsp })
  }
  project = copy(project, { decisions: copy(project.decisions, { watershed: wdec }) })
  // "Is it worth it?": rows follow the final array in order of output
  const baseSteps = new Map(baseRes.decisions.ladder.map((st, i) => [i + 1, st]))
  const fk = [...analyze(project).decisions.final_keys]
  const steps = new Map(wdec.steps)
  let changedSteps = false
  const words: Record<string, string> = { YES: 'Yes', NO: 'No' }
  for (let i = 1; i < Math.max(fk.length, 1); i++) {
    const b = baseSteps.get(i)
    const bW = b && b.note ? words[b.note.worth_it] ?? '' : ''
    const bY = b && b.note ? b.note.why : ''
    const wIn = worth.get(i) || ''
    const yIn = why.get(i) || ''
    if (wIn === bW && yIn === bY) continue
    const key = `${fk[i - 1]} > ${fk[i]}`
    const w = ({ yes: 'YES', no: 'NO' } as Record<string, string>)[pyStrip(wIn).toLowerCase()] ?? 'UNDECIDED'
    steps.set(key, parseStepNote({ worth_it: w, why: yIn }))
    changes.push({ where: `Watershed summary (step ${i})`, before: bW, after: wIn })
    changedSteps = true
  }
  if (changedSteps) {
    project = copy(project, { decisions: copy(project.decisions, { watershed: copy(project.decisions.watershed, { steps }) }) })
  }
  return project
}
