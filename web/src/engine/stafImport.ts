// Reading a reach's existing condition from a SFARI, EASI or DEEP export (ceica/staf_import.py).
//
// The STAF apps score the same 20 functions (0 to 15). What they export differs:
//
// - SFARI (rapid): the saved assessment, the report CSV and GeoJSON, and the calculator workbook. One
//   reach. An unscored function counts as 0 in SFARI's roll-up, so it is imported as 0 (with a note).
//   The saved assessment is STAF's shared assessment file ("format": "staf-assessment"), the Existing
//   Conditions scenario imported; sessions saved before, with the scores at the top level, still
//   import. The completed calculator calls the existing condition's sheet "Existing Conditions",
//   older ones "SFARI Score".
// - EASI (screening): the batch download (easi_batch.zip or its batch-results.json, many reaches) and
//   the single-site report CSV. A function EASI could not rate is imported as not assessed.
// - DEEP (detailed): the report CSV and GeoJSON. One reach. Functions outside the assessment bundle
//   are not assessed; a range ECI adds a note.
//
// JSON and GeoJSON key functions by id; the CSVs use display names, matched after normalizing. Reach
// length is in feet in every format. Values keep Python's types (a JSON float, a workbook's int), so
// ids and messages read as the Python writes them.
import { csvRows } from '../files/csvreader'
import { loadWorkbook, PyFloat, pyStrOf, type ReadSheet, XlDate, type XlValue } from '../files/xlsx/read'
import { readZip } from '../files/zip'
import { fromUtf8, sha256Hex, utf8Error } from '../py/bytes'
import { pyFloat, pyG } from '../py/pyfmt'
import { isMarkedFloat, JsonError, parseJson, pyEntries } from '../py/pyjson'
import { pyFloatText, pyStrip, pyStrRepr, PyTypeError, PyValueError } from '../py/pystr'
import * as staf from './benefits/staf'
import { copy, type Module, type ModuleValues, noAction, parseModuleValues, type Project, siteOf, valuesFor } from './model'
import { jsonErrorText } from './projectfile'

export const TOOL_MAPPING: Readonly<Record<string, string>> = { SFARI: 'B', EASI: 'A', DEEP: 'A' }

/** Display names in the STAF apps' exports that differ from ceica's functions.json. */
const EXTRA_NAMES: Readonly<Record<string, string>> = {
  'bed composition and bedform dynamics': 'bed-composition-bedform-dynamics',
  'bed composition and large wood': 'bed-composition-bedform-dynamics',
  'light and thermal regime': 'light-thermal-regime',
  'water and soil quality': 'water-soil-quality',
  'low flow and baseflow': 'low-flow-baseflow-dynamics',
}

/** A file that cannot be imported; the message is shown to the user. */
export class StafImportError extends Error {}

/** Python's AttributeError and KeyError, in their words (str() of the exception). */
export class AttributeError extends Error {}
export class PyKeyError extends Error {
  constructor(key: string) {
    super(pyStrRepr(key))
  }
}

export interface ImportedReach {
  readonly reach_id: string
  readonly name: string
  /** Scores of the functions assessed (0 to 15). */
  readonly scores: ReadonlyMap<string, number>
  /** Functions the source left out of its sums. */
  readonly not_assessed: readonly string[]
  readonly length_ft: number | null
  readonly notes: readonly string[]
}

export interface StafImport {
  readonly tool: string
  readonly kind: string
  readonly filename: string
  readonly sha256: string
  readonly reaches: readonly ImportedReach[]
  readonly warnings: readonly string[]
}

/** The outcome mapping the source tool uses (KeyError for a tool the Python does not know). */
export function importMapping(imp: StafImport): string {
  const m = TOOL_MAPPING[imp.tool]
  if (m === undefined) throw new PyKeyError(imp.tool)
  return m
}

export const sourceLabel = (imp: StafImport, reach: ImportedReach): string =>
  `${imp.tool} ${imp.kind} ${imp.filename} (sha256 ${imp.sha256.slice(0, 12)}), reach ${reach.reach_id}`

// --- Python's values ------------------------------------------------------------------------------------

/** A value as Python holds it: JSON's (floats as PyFloat, objects as Maps in the file's order) or a
 * workbook cell's. */
type Py = XlValue | Py[] | Map<string, Py>

/** json.loads' value with Python's types */
function fromJson(v: unknown, float: boolean): Py {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return float || !Number.isInteger(v) ? new PyFloat(v) : v
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map((x, i) => fromJson(x, isMarkedFloat(v, i)))
  const o = v as Record<string, unknown>
  return new Map(pyEntries(o).map(([k, x]) => [k, fromJson(x, isMarkedFloat(o, k))]))
}

function typeName(v: Py): string {
  if (v === null) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number' || typeof v === 'bigint') return 'int'
  if (typeof v === 'string') return 'str'
  if (v instanceof PyFloat) return 'float'
  if (v instanceof XlDate) return v.kind
  return Array.isArray(v) ? 'list' : 'dict'
}

const isDict = (v: Py): v is Map<string, Py> => v instanceof Map

/** obj.get(key): AttributeError for anything but a dict */
function get(obj: Py, key: string): Py {
  if (!isDict(obj)) throw new AttributeError(`'${typeName(obj)}' object has no attribute 'get'`)
  return obj.has(key) ? obj.get(key)! : null
}

/** ``for x in obj``: a list's items, a dict's keys, a string's characters */
function iterate(obj: Py): Py[] {
  if (Array.isArray(obj)) return obj
  if (isDict(obj)) return [...obj.keys()]
  if (typeof obj === 'string') return [...obj]
  throw new PyTypeError(`'${typeName(obj)}' object is not iterable`)
}

/** obj.items() of a dict */
function items(obj: Py): [string, Py][] {
  if (!isDict(obj)) throw new AttributeError(`'${typeName(obj)}' object has no attribute 'items'`)
  return [...obj]
}

function truthy(v: Py): boolean {
  if (v === null || v === false || v === 0 || v === 0n || v === '') return false
  if (v instanceof PyFloat) return v.value !== 0
  if (Array.isArray(v)) return v.length > 0
  if (isDict(v)) return v.size > 0
  return true
}

/** ``a or b`` */
const or = (...vals: Py[]): Py => vals.find((v) => truthy(v)) ?? vals[vals.length - 1]

function repr(v: Py): string {
  if (typeof v === 'string') return pyStrRepr(v)
  if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`
  if (isDict(v)) return `{${[...v].map(([k, x]) => `${pyStrRepr(k)}: ${repr(x)}`).join(', ')}}`
  if (v instanceof XlDate) return v.repr()
  return pyStrOf(v)
}

function str(v: Py): string {
  if (Array.isArray(v) || isDict(v)) return repr(v)
  return pyStrOf(v as XlValue)
}

/** float(v): ValueError for text that is not a number, TypeError for other types */
function floatOf(v: Py): number {
  if (typeof v === 'boolean') return v ? 1.0 : 0.0
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof PyFloat) return v.value
  if (typeof v === 'string') return pyFloatText(v)
  throw new PyTypeError(`float() argument must be a string or a real number, not '${typeName(v)}'`)
}

// --- names and values -------------------------------------------------------------------------------------

function norm(text: string): string {
  const t = text.toLowerCase().replaceAll('&amp;', 'and').replaceAll('&', 'and')
  return t.replace(/[^a-z0-9]+/g, ' ').trim()
}

function nameIndex(): Map<string, string> {
  const idx = new Map<string, string>()
  for (const f of staf.functions()) {
    idx.set(norm(f.name), f.id)
    idx.set(norm(f.id.replaceAll('-', ' ')), f.id)
  }
  for (const [k, v] of Object.entries(EXTRA_NAMES)) idx.set(norm(k), v)
  return idx
}

/** The function id for an id or any app's display name. */
export function functionId(name: string): string | null {
  if (staf.functionIds().includes(name)) return name
  return nameIndex().get(norm(name)) ?? null
}

const fmtG = (x: number): string => (Number.isNaN(x) ? 'nan' : pyG(x))

function score(v: Py): number | null {
  if (v === null) return null
  if (typeof v === 'string') {
    v = pyStrip(v)
    if (v === '' || ['na', 'n/a', 'none', 'null'].includes(v.toLowerCase())) return null
  }
  let x: number
  try {
    x = floatOf(v)
  } catch (exc) {
    if (exc instanceof PyValueError || exc instanceof PyTypeError) return null
    throw exc
  }
  if (!(x >= 0 && x <= 15)) throw new StafImportError(`A function score of ${fmtG(x)} is outside 0 to 15.`)
  return x
}

function lengthOf(v: Py): number | null {
  let x: number
  try {
    x = pyFloatText(pyStrip(str(v).replaceAll(',', '')))
  } catch (exc) {
    if (exc instanceof PyValueError) return null
    throw exc
  }
  return x > 0 ? x : null
}

function reach(reachId: Py, name: Py, found: ReadonlyMap<string, number | null>, missingAsZero: boolean, length: Py,
  notesIn: readonly string[] = []): ImportedReach {
  const scores = new Map<string, number>()
  const off: string[] = []
  const zeros: string[] = []
  for (const fid of staf.functionIds()) {
    const v = found.get(fid) ?? null
    if (v === null) {
      if (missingAsZero) {
        scores.set(fid, 0.0)
        zeros.push(fid)
      } else off.push(fid)
    } else scores.set(fid, v)
  }
  const notes = [...notesIn]
  if (zeros.length) {
    notes.push(`${zeros.length} function(s) had no score and were imported as 0, as SFARI scores them. Mark them not assessed if that fits `
      + 'the assessment better.')
  }
  if (!scores.size || staf.functionIds().every((fid) => off.includes(fid))) throw new StafImportError('The file holds no function scores.')
  return { reach_id: str(or(reachId, 'reach')), name: str(or(name, reachId, 'Reach')), scores, not_assessed: off, length_ft: lengthOf(length),
    notes }
}

// --- SFARI -------------------------------------------------------------------------------------------------

function sfariSession(doc: Py): ImportedReach[] {
  const fs = or(get(doc, 'function_scores'), new Map())
  const found = new Map<string, number | null>()
  for (const [key, entry] of items(fs)) {
    const fid = functionId(key)
    if (fid) found.set(fid, score(isDict(entry) ? get(entry, 'score') : entry))
  }
  const del = or(get(doc, 'delineation'), new Map())
  const d = or(get(del, 'delineation'), new Map())
  const rid = or(get(d, 'nhdplus_id'), get(d, 'comid'), 'reach')
  const length = or(get(d, 'reach_length_ft'), get(or(get(or(get(doc, 'delineation'), new Map()), 'input'), new Map()), 'reach_length_ft'))
  return [reach(rid, or(get(d, 'gnis_name'), rid), found, true, length)]
}

/** The existing condition's sheet in SFARI's calculator: the completed calculator's name, then the older
 * template's (the cells are the same). */
export const SFARI_SHEETS = ['Existing Conditions', 'SFARI Score']

/** A cell's value without making the cell (a read-only workbook's rows) */
function peek(ws: ReadSheet, row: number, col: number): XlValue {
  return ws.has(row, col) ? ws.cell(row, col).value : null
}

function sfariWorkbook(data: Uint8Array): ImportedReach[] {
  const wb = loadWorkbook(data, { dataOnly: true })
  const sheet = SFARI_SHEETS.find((s) => wb.sheetnames.includes(s))
  if (sheet === undefined) throw new StafImportError("This workbook has no 'Existing Conditions' or 'SFARI Score' sheet.")
  const ws = wb.sheet(sheet)
  const found = new Map<string, number | null>()
  let rid: Py = null
  let length: Py = null
  for (let r = 1; r <= 120; r++) {
    if (r === 2) {
      rid = peek(ws, 2, 2)
      length = peek(ws, 2, 7)
    }
    const name = peek(ws, r, 6)
    if (truthy(name) && r > 6) {
      const fid = functionId(str(name))
      if (fid) found.set(fid, score(peek(ws, r, 8)))
    }
  }
  return [reach(rid, rid, found, true, length)]
}

// --- STAF assessment files ---------------------------------------------------------------------------------

export const ASSESSMENT_FORMAT = 'staf-assessment'
export const ASSESSMENT_VERSION = 1
/** The scenario STAF keeps the existing condition in. */
const EXISTING = 'existing'

function assessment(doc: Map<string, Py>, name: string, digest: string): StafImport {
  const version = get(doc, 'formatVersion')
  // an int (not a float, not a bool) of at least 1
  if (!(typeof version === 'number' || typeof version === 'bigint') || version < 1) {
    throw new StafImportError('This STAF assessment file has no valid format version.')
  }
  if (version > ASSESSMENT_VERSION) {
    throw new StafImportError('This STAF assessment file was saved by a newer version of STAF. Download its report CSV or GeoJSON and import that.')
  }
  const tool = get(doc, 'tool')
  if (tool === 'DEEP') {
    throw new StafImportError('A DEEP saved assessment holds measurements, not function scores. Download DEEP\'s report CSV or GeoJSON and import that.')
  }
  if (tool === 'EASI') {
    throw new StafImportError('An EASI saved assessment holds metric ratings, not function scores. Download EASI\'s report CSV or batch ZIP and '
      + 'import that.')
  }
  if (tool !== 'SFARI') throw new StafImportError('This JSON is not a SFARI session, an EASI batch or a report GeoJSON.')
  const block = get(doc, 'scenarios')
  const raw = isDict(block) ? get(block, 'items') : null
  const list = Array.isArray(raw) ? raw.filter(isDict) : []
  const item = list.find((it) => get(it, 'id') === EXISTING) ?? (list.length ? list[0] : new Map<string, Py>())
  const state = isDict(get(item, 'state')) ? get(item, 'state') : new Map()
  const delineation = isDict(get(doc, 'delineation')) ? get(doc, 'delineation') : new Map()
  const session = new Map<string, Py>([['function_scores', or(get(state, 'function_scores'), new Map())], ['delineation', delineation]])
  return { tool: 'SFARI', kind: 'assessment', filename: name, sha256: digest, reaches: sfariSession(session), warnings: [] }
}

// --- GeoJSON (SFARI and DEEP reports) ----------------------------------------------------------------------

function rangeNote(claim: string): string {
  return 'DEEP reports an ECI range for this assessment' + (claim ? ` (${claim})` : '') + ': its bundle does not cover all 20 functions. CEICA '
    + 'scores the assessed functions only, so read the ECI as a relative measure for comparing alternatives, not as a condition claim.'
}

function geojson(doc: Map<string, Py>): [string, ImportedReach[], string[]] {
  const feats = iterate(or(get(doc, 'features'), [])).filter((f) => get(or(get(f, 'properties'), new Map()), 'type') === 'analysis_point')
  const props = feats.length ? get(feats[0], 'properties') : new Map<string, Py>()
  if (!isDict(props)) throw new PyTypeError(`'${typeName(props)}' object is not subscriptable`)
  const found = new Map<string, number | null>()
  for (const fid of staf.functionIds()) if (props.has(fid)) found.set(fid, score(props.get(fid)!))
  if (!found.size) {
    throw new StafImportError('This GeoJSON holds no function scores. EASI\'s report GeoJSON has metric ratings only: use the EASI report CSV '
      + 'or batch ZIP.')
  }
  const deep = props.has('content_digest') || props.has('condition_claim')
  const tool = deep ? 'DEEP' : 'SFARI'
  const rid = or(get(props, 'nhdplus_id'), get(props, 'comid'), 'reach')
  const notes: string[] = []
  if (deep && get(props, 'ecosystem_condition_index') === null && truthy(get(props, 'ecosystem_condition_index_bounds'))) {
    const claim = or(get(props, 'condition_claim'), '')
    notes.push(rangeNote(truthy(claim) ? str(claim) : ''))
  }
  const r = reach(rid, or(get(props, 'stream'), rid), found, !deep, get(props, 'reach_length_ft'), notes)
  return [tool, [r], r.length_ft ? [] : ['The GeoJSON has no reach length; enter the quantity.']]
}

// --- CSV reports -----------------------------------------------------------------------------------------------

/** data.decode("utf-8-sig", errors="replace") */
const decodeSig = (data: Uint8Array): string => new TextDecoder('utf-8').decode(data)

function kv(rows: readonly string[][]): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    // the Python checks the key unstripped and stores it stripped
    if (row.length >= 2 && row[0] && !out.has(row[0])) out.set(pyStrip(row[0]), pyStrip(row[1]))
  }
  return out
}

/** The first header row holding ``column`` and the rows under it, up to a blank row. */
function table(rows: readonly string[][], column: string): [string[], string[][]] {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => pyStrip(c))
    if (cells.includes(column)) {
      const body: string[][] = []
      for (const r of rows.slice(i + 1)) {
        if (!r.some((c) => pyStrip(c))) break
        body.push(r)
      }
      return [cells, body]
    }
  }
  return [[], []]
}

/** list.index(value): ValueError when it is not there */
function index(list: readonly string[], value: string): number {
  const i = list.indexOf(value)
  if (i < 0) throw new PyValueError(`${pyStrRepr(value)} is not in list`)
  return i
}

function csv(data: Uint8Array): [string, string, ImportedReach[], string[]] {
  const rows = csvRows(decodeSig(data))
  const title = rows.length && rows[0].length ? pyStrip(rows[0][0]) : ''
  const pairs = kv(rows)
  const warn: string[] = []
  if (['SFARI', 'EASI', 'DEEP'].some((t) => title.startsWith(t))) {
    const tool = title.split(/\s+/u)[0]
    const col = tool === 'EASI' ? 'FunctionScore' : 'Function score (0-15)'
    const [head, body] = table(rows, col)
    if (!head.length) throw new StafImportError(`The ${tool} report's function scores were not found.`)
    const fi = index(head, 'Function')
    const si = index(head, col)
    const found = new Map<string, number | null>()
    for (const r of body) {
      const fid = r.length > fi ? functionId(r[fi]) : null
      if (fid && r.length > si && (found.get(fid) ?? null) === null) found.set(fid, score(r[si]))
    }
    const notes: string[] = []
    const claim = pairs.get('Condition claim') ?? ''
    if (tool === 'DEEP' && !pairs.get('Ecosystem Condition Index') && claim.includes(' to ')) notes.push(rangeNote(claim))
    const rid = pairs.get('COMID') || pairs.get('Stream') || 'reach'
    const r = reach(rid, pairs.get('Stream') || rid, found, tool === 'SFARI', pairs.get('Reach length (ft)') ?? null, notes)
    if (r.length_ft === null) warn.push('The report has no reach length; enter the quantity.')
    return [tool, 'report CSV', [r], warn]
  }
  throw new StafImportError('This CSV is not a SFARI, EASI or DEEP report.')
}

// --- EASI batch -----------------------------------------------------------------------------------------------

function easiBatch(doc: Map<string, Py>): ImportedReach[] {
  const out: ImportedReach[] = []
  const ids = new Set(staf.functionIds())
  for (const s of iterate(or(get(doc, 'sites'), []))) {
    const found = new Map<string, number | null>()
    for (const [fid, v] of items(or(get(s, 'function_scores'), new Map()))) if (ids.has(fid)) found.set(fid, score(v))
    if (!found.size) continue
    const d = or(get(s, 'delineation'), new Map())
    const length = or(get(d, 'reach_length_ft'), get(or(get(s, 'input'), new Map()), 'reach_length_ft'))
    out.push(reach(get(s, 'site_id'), or(get(d, 'gnis_name'), get(s, 'site_id')), found, false, length))
  }
  if (!out.length) throw new StafImportError('The EASI batch has no scored sites.')
  return out
}

// --- entry point ---------------------------------------------------------------------------------------------

/** json.loads of text, Python's JSONDecodeError message on failure */
function loadsText(text: string): Py {
  if (text.startsWith('﻿')) throw new JsonDecodeError('Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)')
  try {
    return fromJson(parseJson(text), false)
  } catch (exc) {
    if (exc instanceof JsonError) throw new JsonDecodeError(jsonErrorText(exc, text))
    throw exc
  }
}

/** json.loads' JSONDecodeError (a ValueError) */
export class JsonDecodeError extends Error {}

/** Python's UnicodeDecodeError (a ValueError) */
export class UnicodeDecodeError extends Error {}

/** bytes.lstrip(): ASCII whitespace */
function lstripBytes(data: Uint8Array): Uint8Array {
  let i = 0
  while (i < data.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(data[i])) i++
  return data.subarray(i)
}

/** read_staf_file: a SFARI, EASI or DEEP export as reaches with their function scores. */
export function readStafFile(data: Uint8Array, filename: string): StafImport {
  const digest = sha256Hex(data)
  const name = filename.split('/').pop()!.split('\\').pop()!
  const low = name.toLowerCase()
  if (data[0] === 0x50 && data[1] === 0x4b && !low.endsWith('.xlsx')) {
    const z = readZip(data)
    const member = z.names().find((n) => n.endsWith('batch-results.json'))
    if (member === undefined) throw new StafImportError('This ZIP is not an EASI batch download (no batch-results.json).')
    const bytes = z.read(member)
    const bad = utf8Error(bytes)
    if (bad !== null) throw new UnicodeDecodeError(bad)
    const doc = loadsText(fromUtf8(bytes))
    if (!isDict(doc)) throw new AttributeError(`'${typeName(doc)}' object has no attribute 'get'`)
    return { tool: 'EASI', kind: 'batch', filename: name, sha256: digest, reaches: easiBatch(doc), warnings: [] }
  }
  if (low.endsWith('.xlsx')) return { tool: 'SFARI', kind: 'calculator workbook', filename: name, sha256: digest, reaches: sfariWorkbook(data), warnings: [] }
  const text = lstripBytes(data)
  if (text[0] === 0x7b || text[0] === 0x5b) {
    let doc: Py
    try {
      // data.decode("utf-8-sig"): a byte order mark dropped, invalid UTF-8 refused
      if (utf8Error(data) !== null) throw new JsonDecodeError('invalid UTF-8')
      const s = fromUtf8(data)
      doc = loadsText(s.startsWith('﻿') ? s.slice(1) : s)
    } catch (exc) {
      if (exc instanceof JsonDecodeError) throw new StafImportError('This file is not valid JSON.')
      throw exc
    }
    if (isDict(doc) && get(doc, 'format') === ASSESSMENT_FORMAT) return assessment(doc, name, digest)
    if (isDict(doc) && get(doc, 'method') === 'SFARI') {
      return { tool: 'SFARI', kind: 'session', filename: name, sha256: digest, reaches: sfariSession(doc), warnings: [] }
    }
    if (isDict(doc) && get(doc, 'method') === 'DEEP') {
      throw new StafImportError('A DEEP saved session holds measurements, not function scores. Download DEEP\'s report CSV or GeoJSON and import '
        + 'that.')
    }
    if (isDict(doc) && get(doc, 'type') === 'FeatureCollection') {
      const [tool, reaches, warn] = geojson(doc)
      return { tool, kind: 'report GeoJSON', filename: name, sha256: digest, reaches, warnings: warn }
    }
    if (isDict(doc) && Array.isArray(get(doc, 'sites'))) {
      return { tool: 'EASI', kind: 'batch', filename: name, sha256: digest, reaches: easiBatch(doc), warnings: [] }
    }
    throw new StafImportError('This JSON is not a SFARI session, an EASI batch or a report GeoJSON.')
  }
  const [tool, kind, reaches, warn] = csv(data)
  return { tool, kind, filename: name, sha256: digest, reaches, warnings: warn }
}

// --- project edits -------------------------------------------------------------------------------------------

const FT_PER: Readonly<Record<string, number>> = { ft: 1.0, feet: 1.0, mi: 5280.0, miles: 5280.0, m: 1 / 0.3048, km: 1000 / 0.3048 }

/** Reach length in the project's quantity units, or null when the units are not a length. */
export function quantityFromFeet(lengthFt: number | null, units: string): number | null {
  const k = FT_PER[pyStrip(units || '').toLowerCase()]
  return lengthFt === null || k === undefined ? null : lengthFt / k
}

/** apply_existing_condition: a site's No Action year-0 scores, quantity and assessed functions from a
 * reach, in one STAF module (the first when ``moduleId`` is not given). */
export function applyExistingCondition(project: Project, siteId: string, r: ImportedReach, imp: StafImport,
  moduleId: string | null = null): Project {
  const mods = project.benefits.modules.filter((m) => m.method === 'STAF')
  const module: Module | undefined = mods.find((m) => moduleId === null || moduleId === m.id)
  if (module === undefined) throw new StafImportError('Function scores go into a STAF module; this project has none.')
  const site = siteOf(project, siteId)
  const na = site ? noAction(site) : null
  if (site === null || na === null) throw new StafImportError('That site needs a No Action alternative first.')
  const n = project.benefits.target_years.length
  const mv: ModuleValues = valuesFor(na, module.id) ?? parseModuleValues({ module_id: module.id })
  const scores = new Map(mv.scores)
  for (const [fid, v] of r.scores) {
    const vals = [...(scores.get(fid) ?? []), ...Array(n).fill(null)].slice(0, n)
    vals[0] = v
    scores.set(fid, Object.freeze(vals))
  }
  const qty = [...mv.quantity, ...Array(n).fill(null)].slice(0, n)
  const q = quantityFromFeet(r.length_ft, module.quantity_units)
  if (q !== null) qty[0] = q
  const newMv = copy(mv, { scores, quantity: Object.freeze(qty) })
  let outputs = na.outputs.map((v) => (v.module_id === module.id ? newMv : v))
  if (valuesFor(na, module.id) === null) outputs = [...outputs, newMv]
  const newNa = copy(na, { outputs: Object.freeze(outputs) })
  const off = new Map(site.staf_not_assessed)
  if (r.not_assessed.length) off.set(module.id, Object.freeze([...r.not_assessed]))
  else off.delete(module.id)
  const source = new Map(site.staf_source)
  source.set(module.id, sourceLabel(imp, r))
  const newSite = copy(site, {
    alternatives: Object.freeze(site.alternatives.map((a) => (a.id === na.id ? newNa : a))), staf_not_assessed: off, staf_source: source,
  })
  return copy(project, { sites: Object.freeze(project.sites.map((s) => (s.id === siteId ? newSite : s))) })
}

export { pyFloat }
