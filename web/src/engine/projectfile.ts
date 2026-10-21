// The .ceica project file: one JSON document holding a whole study (ceica/projectfile.py).
//
//     {"format": "ceica-project", "schemaVersion": 3, "appVersion": "0.1.0", "savedAt": "...",
//      "contentDigest": "<sha256 of the canonical project>", "project": {...}}
//
// Results are never stored: they are recomputed from the inputs on load. The content digest covers
// the project's inputs and decisions; its first 12 characters print in the report footer and the
// Excel calculator so a reviewer can match a report to a file. A digest mismatch (a hand-edited
// file) is reported as a warning, not an error. Older schema versions migrate forward in
// ``migrate``:
//
// * 1 -> 2: outputs became modules. A project-wide benefit mode with a list of components turns
//   into one module per component with that method (habitat units or index x quantity), the STAF
//   mode into one STAF module, and the annualized mode into one average-annual module. Every
//   alternative's component series, STAF scores or entered average move to its module values.
// * 2 -> 3: the study's District and Prepared by fold into the document's Prepared by (Document
//   settings), the one place it is set: the document's own value, else the study's, followed by
//   the district unless it already says it. Nothing that printed is lost.
//
// The text is Python's to the byte: json.dumps' layout, sorted keys and float spelling (pyjson.ts),
// and the same refusal messages, JSON's own errors included.
import { pyFloat } from '../py/pyfmt'
import { fromUtf8, sha256Hex, utf8Error } from '../py/bytes'
import { isMarkedFloat, JsonError, parseJson, pyClone, pyDumps, pyEntries } from '../py/pyjson'
import { dumpProject, parseProject, type Project, ValidationError } from './model'
import { APP_VERSION } from './version'

export const FORMAT = 'ceica-project'
export const FORMAT_VERSION = 3
export const FILE_SUFFIX = '.ceica'

/** A project file that cannot be opened; the message is shown to the user. */
export class ProjectFileError extends Error {}

/** json.dumps(..., allow_nan=False) refuses NaN and infinities. */
function refuseNan(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Out of range float values are not JSON compliant: ${pyFloat(value)}`)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const v of Array.isArray(value) ? value : Object.values(value)) refuseNan(v)
}

/** Stable JSON: sorted keys, no whitespace, floats in shortest round-trip form. */
export function canonicalJson(obj: unknown): string {
  refuseNan(obj)
  return pyDumps(obj, { sortKeys: true, separators: [',', ':'], ensureAscii: false })
}

export const projectPayload = (project: Project): Record<string, unknown> => dumpProject(project)

/** sha256 of the canonical project JSON (inputs and decisions). */
export const contentDigest = (project: Project): string => sha256Hex(canonicalJson(projectPayload(project)))

export const shortDigest = (project: Project): string => contentDigest(project).slice(0, 12)

/** Now, as Python's datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") writes it. */
export const utcNow = (): string => new Date().toISOString().slice(0, 19) + 'Z'

/** The project as .ceica text (pretty-printed, stable key order). */
export function dumps(project: Project, { savedAt }: { savedAt?: string | null } = {}): string {
  const doc = {
    format: FORMAT,
    schemaVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    savedAt: savedAt || utcNow(),
    contentDigest: contentDigest(project),
    project: projectPayload(project),
  }
  refuseNan(doc)
  return pyDumps(doc, { indent: 1, sortKeys: true, ensureAscii: false }) + '\n'
}

export interface Loaded {
  readonly project: Project
  readonly warnings: readonly string[]
  readonly saved_at: string | null
  readonly app_version: string | null
}

// --- migration -----------------------------------------------------------------------------------

type Doc = Record<string, any>

/** A Python dict's .get(key, default). */
function get(obj: unknown, key: string, dflt: unknown = null): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new MigrationError('AttributeError', `'${pyTypeName(obj)}' object has no attribute 'get'`)
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Doc)[key] : dflt
}

/** Python's truth value of a JSON value. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** ``x or default`` */
const or = <T>(x: unknown, dflt: T): any => (pyTruthy(x) ? x : dflt)

function pyTypeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'string') return 'str'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  return 'dict'
}

class MigrationError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message)
  }
}

/** obj[key] as Python indexes a dict, raising KeyError when it is missing. */
function item(obj: unknown, key: string): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new MigrationError('TypeError', `'${pyTypeName(obj)}' object is not subscriptable`)
  }
  if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new MigrationError('KeyError', `'${key}'`)
  return (obj as Doc)[key]
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v !== null && typeof v === 'object') return Object.keys(v as object)
  if (typeof v === 'string') return [...v]
  throw new MigrationError('TypeError', `'${pyTypeName(v)}' object is not iterable`)
}

/** dict.pop(key, default) */
function pop(obj: Doc, key: string, dflt: unknown = null): any {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return dflt
  const v = obj[key]
  delete obj[key]
  return v
}

/** A schema-1 project as schema 2 (outputs by module). */
function v1ToV2(project: Doc): Doc {
  const p = pyClone(project)
  const ben = or(get(p, 'benefits'), {})
  const mode = get(ben, 'mode', 'HU')
  const staf = or(get(ben, 'staf'), {})
  const comps = or(get(ben, 'components'), [{ id: 'total', name: 'Total' }])
  let modules: Doc[]
  if (mode === 'HU' || mode === 'INDEX_X_QUANTITY') {
    modules = asList(comps).map((c) => ({
      id: item(c, 'id'), name: item(c, 'name'), method: mode,
      quantity_units: mode === 'INDEX_X_QUANTITY' ? get(c, 'quantity_units', 'acres') : '',
    }))
  } else if (mode === 'STAF') {
    modules = [{ id: 'condition', name: 'Stream condition', method: 'STAF',
      quantity_units: get(staf, 'quantity_units', 'mi') }]
  } else {
    modules = [{ id: 'total', name: 'Total', method: 'AAHU', quantity_units: '' }]
  }
  p.benefits = { target_years: get(ben, 'target_years', [0.0, 2.0, 10.0, 50.0]), modules,
    staf_mapping: get(staf, 'mapping', 'A') }
  for (const site of asList(get(p, 'sites', []))) {
    const s = site as Doc
    const off = or(get(s, 'staf_not_assessed'), [])
    s.staf_not_assessed = mode === 'STAF' && pyTruthy(off) ? { condition: off } : {}
    const src = or(get(s, 'staf_source'), '')
    s.staf_source = mode === 'STAF' && pyTruthy(src) ? { condition: src } : {}
    for (const alt of asList(get(s, 'alternatives', []))) {
      const a = alt as Doc
      if (a === null || typeof a !== 'object' || Array.isArray(a)) {
        throw new MigrationError('AttributeError', `'${pyTypeName(a)}' object has no attribute 'pop'`)
      }
      const series = or(pop(a, 'benefits'), [])
      const aahu = pop(a, 'aahu')
      const scores = or(pop(a, 'staf'), {})
      if (mode === 'HU' || mode === 'INDEX_X_QUANTITY') {
        a.outputs = asList(series).map((b) => ({ module_id: item(b, 'component_id'),
          values: or(get(b, 'values'), []), quantity: or(get(b, 'quantity'), []) }))
      } else if (mode === 'STAF') {
        a.outputs = [{ module_id: 'condition', scores: or(get(scores, 'scores'), {}),
          quantity: or(get(scores, 'quantity'), []) }]
      } else {
        a.outputs = [{ module_id: 'total', aahu }]
      }
    }
  }
  p.schema_version = 'ceica-project/2'
  return p
}

/** Python's str() of a JSON value, for "or" fallbacks that become text. */
function pyStr(v: unknown): string {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return v
  return pyRepr(v)
}

/** A schema-2 project as schema 3 (one Prepared by, in the document settings). */
function v2ToV3(project: Doc): Doc {
  const p = pyClone(project)
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    throw new MigrationError('AttributeError', `'${pyTypeName(p)}' object has no attribute 'pop'`)
  }
  const district = pyStr(or(pop(p, 'district'), '')).trim()
  const studyBy = pyStr(or(pop(p, 'prepared_by'), '')).trim()
  const rep = p.report
  const report: Doc = rep !== null && typeof rep === 'object' && !Array.isArray(rep) ? { ...rep } : {}
  let by = pyStr(or(report.prepared_by, '')).trim() || studyBy
  if (district && !by.toLowerCase().includes(district.toLowerCase())) by = by ? `${by}, ${district}` : district
  if (by) {
    report.prepared_by = by
    p.report = report
  }
  p.schema_version = 'ceica-project/3'
  return p
}

/** Each older schema version and the step that brings a project to the next one. */
const STEPS: Record<number, (p: Doc) => Doc> = { 1: v1ToV2, 2: v2ToV3 }

/** Python's repr() of a JSON value, for messages that quote it. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : pyFloat(v)
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'"
    const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  return `{${pyEntries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`
}

/** A project document (the "project" member) brought from ``version`` to FORMAT_VERSION. */
export function migrateProject(project: unknown, version: number): Doc {
  let p = project as Doc
  while (STEPS[version]) {
    try {
      p = STEPS[version](p)
    } catch (exc) {
      const kind = exc instanceof MigrationError ? exc.kind : 'TypeError'
      throw new ProjectFileError(`This older project file could not be converted (${kind}: ${(exc as Error).message}).`)
    }
    version += 1
  }
  if (version !== FORMAT_VERSION) throw new ProjectFileError(`Unknown project file version: ${pyRepr(version)}.`)
  return p
}

/** Bring a whole .ceica document up to FORMAT_VERSION. */
export function migrate(doc: Doc): Doc {
  const raw = doc.schemaVersion
  // Python: 3 == 3.0, True is the int 1, and a number written 2.0 is a float, not an int
  if (raw === FORMAT_VERSION) return doc
  const float = typeof raw === 'number' && (isMarkedFloat(doc, 'schemaVersion') || !Number.isInteger(raw))
  const isInt = typeof raw === 'boolean' || (typeof raw === 'number' && !float)
  const version = raw === true ? 1 : raw === false ? 0 : (raw as number)
  if (isInt && version > FORMAT_VERSION) {
    throw new ProjectFileError('This project was saved by a newer version of CEICA. Update the app to open it.')
  }
  if (!isInt || !STEPS[version]) {
    throw new ProjectFileError(`Unknown project file version: ${float ? pyFloat(raw as number) : pyRepr(raw)}.`)
  }
  const out: Doc = { ...doc }
  out.project = migrateProject(Object.prototype.hasOwnProperty.call(doc, 'project') ? doc.project : {}, version)
  out.schemaVersion = FORMAT_VERSION
  return out
}

/** json.loads' error message: what went wrong, then the line, column and character. */
export function jsonErrorText(err: JsonError, text: string): string {
  const m = /^(.*) at (\d+)$/.exec(err.message)
  const words: Record<string, string> = {
    'Unterminated string': 'Unterminated string starting at',
    'Invalid control character': 'Invalid control character at',
  }
  const what = m ? (words[m[1]] ?? m[1]) : err.message
  const pos = m ? Number(m[2]) : 0
  const before = text.slice(0, pos)
  const line = (before.match(/\n/g)?.length ?? 0) + 1
  const col = pos - before.lastIndexOf('\n')
  return `${what}: line ${line} column ${col} (char ${pos})`
}

/** Parse .ceica text (or the file's bytes) into a Project. Throws ProjectFileError with a readable
 * message. */
export function loads(input: string | Uint8Array): Loaded {
  let text: string
  if (typeof input === 'string') text = input
  else {
    const bad = utf8Error(input)
    if (bad !== null) throw new ProjectFileError(`This file is not a CEICA project (not valid JSON: ${bad}).`)
    // json.loads of bytes reads a leading byte order mark as UTF-8's
    text = fromUtf8(input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? input.subarray(3) : input)
  }
  let doc: unknown
  try {
    doc = parseJson(text)
  } catch (exc) {
    if (exc instanceof JsonError) {
      throw new ProjectFileError(`This file is not a CEICA project (not valid JSON: ${jsonErrorText(exc, text)}).`)
    }
    throw exc
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || (doc as Doc).format !== FORMAT) {
    throw new ProjectFileError('This file is not a CEICA project.')
  }
  const d = doc as Doc
  // the digest covers the project as it was saved, before any migration
  const saved = sha256Hex(canonicalJson(Object.prototype.hasOwnProperty.call(d, 'project') ? d.project : {}))
  const migrated = migrate(d)
  let project: Project
  try {
    project = parseProject(Object.prototype.hasOwnProperty.call(migrated, 'project') ? migrated.project : {})
  } catch (exc) {
    if (exc instanceof ValidationError) {
      throw new ProjectFileError(`The project file has an invalid value at ${exc.loc.join('.')}: ${exc.msg}.`)
    }
    throw exc
  }
  const warnings: string[] = []
  const digest = migrated.contentDigest
  if (pyTruthy(digest) && digest !== saved && digest !== contentDigest(project)) {
    warnings.push('The file was edited outside CEICA (its content digest does not match).')
  }
  const savedAt = Object.prototype.hasOwnProperty.call(migrated, 'savedAt') ? migrated.savedAt : null
  const appVersion = Object.prototype.hasOwnProperty.call(migrated, 'appVersion') ? migrated.appVersion : null
  return { project, warnings, saved_at: savedAt, app_version: appVersion }
}
