// Cell addresses and edits for the input grids (views/cells.py).
//
// Every editable cell carries a path to the project field it edits. Paths are short strings:
//
//     b|site|alt|module|values|k     a module's output (habitat units) or index at target year k
//     b|site|alt|module|quantity|k   a module's quantity at target year k (index x quantity, STAF)
//     b|site|alt|module|aahu         a module's average annual value (entered directly)
//     f|site|alt|module|function|k   a STAF function score at target year k
//     c|site|alt|first|category      a first cost
//     c|site|alt|months              construction months
//     c|site|alt|override            average annual cost entered directly
//     r|site|alt|item|field          a recurring item field
//     t|site|field                   site text (name, description)
//     t|site|alt|field               alternative text (name, description)
//
// Sites, alternatives, modules and items are named by id, so a path stays valid when rows move.
// Edits go through the project's JSON form and are validated again, so a bad value never gets in:
// the form is the Python's model_dump(mode="json") with its dicts in Python's order (parsed back from
// its JSON), changed as the Python changes it, then validated with pydantic's rules and words.
import { dumpProject, parseProject, type Project, ValidationError } from '../engine/model'
import { parseJson, pyDumps } from '../py/pyjson'
import { pyFloatText, pyStrRepr, PyValueError, pyStrip } from '../py/pystr'

export class CellError extends Error {}

/** '1,234.5', '$1,234', '12.5%' (as 12.5), blank -> null. */
export function parseNumber(text: unknown): number | null {
  if (text === null || text === undefined) return null
  let s = pyStrip(String(text))
  if (s === '' || ['n/a', 'na', '-'].includes(s.toLowerCase())) return null
  s = pyStrip(s.replace(/,/g, '').replace(/\$/g, '').replace(/%/g, ''))
  if (/^\(.*\)$/s.test(s)) s = '-' + s.slice(1, -1)
  try {
    return pyFloatText(s)
  } catch (exc) {
    if (exc instanceof PyValueError) throw new CellError(`'${String(text)}' is not a number.`)
    throw exc
  }
}

type Doc = Record<string, any>

function find(items: Doc[], key: string, value: string): number {
  const i = items.findIndex((it) => it[key] === value)
  if (i < 0) throw new CellError('That row no longer exists.')
  return i
}

/** The list padded with None to ``n`` (never cut). */
function pad(lst: unknown[] | null | undefined, n: number): unknown[] {
  const out = [...(lst ?? [])]
  while (out.length < n) out.push(null)
  return out
}

/** The project from its JSON form, or the CellError the Python gives for the first problem. */
function validate(doc: Doc): Project {
  try {
    return parseProject(doc)
  } catch (exc) {
    if (exc instanceof ValidationError) {
      let msg = exc.msg
      if (msg.startsWith('Value error, ')) msg = msg.slice('Value error, '.length)
      throw new CellError(msg ? `That value is not valid here: ${msg}.` : 'That value is not valid here.')
    }
    throw exc
  }
}

const BASES: Record<string, string> = {
  fixed: 'FIXED', amount: 'FIXED', percent: 'PCT_OF_CATEGORY', pct_of_category: 'PCT_OF_CATEGORY',
  'percent of first cost': 'PCT_OF_CATEGORY', 'percent of a first cost': 'PCT_OF_CATEGORY',
  rate: 'RATE_X_QUANTITY', rate_x_quantity: 'RATE_X_QUANTITY', 'rate x quantity': 'RATE_X_QUANTITY',
}

/** A recurring item's basis from a code, a stored value or its label (pasted from Excel). */
function basis(raw: unknown): string {
  const key = pyStrip(String(raw || '')).toLowerCase()
  if (!(key in BASES)) throw new CellError(`'${String(raw)}' is not a basis (Amount, Percent of first cost or Rate x quantity).`)
  return BASES[key]
}

/** A first-cost category id from its id or its name. */
function category(doc: Doc, raw: unknown): string | null {
  const key = pyStrip(String(raw || '')).toLowerCase()
  if (!key) return null
  for (const cat of doc.cost_categories ?? []) if (key === cat.id.toLowerCase() || key === cat.name.toLowerCase()) return cat.id
  throw new CellError(`'${String(raw)}' is not a first-cost category.`)
}

/** The project's JSON form, its dicts in Python's order (so a key added goes last, as in Python). */
function docOf(project: Project): Doc {
  return parseJson(pyDumps(dumpProject(project)))
}

/** The project with the cell at ``path`` set to ``raw`` (text from the grid). */
export function apply(project: Project, path: string, raw: unknown): Project {
  const doc = docOf(project)
  set(doc, path, raw)
  return validate(doc)
}

/** The alternative's values for a module (created empty if missing). */
function moduleValues(doc: Doc, alt: Doc, moduleId: string): Doc {
  if (!doc.benefits.modules.some((m: Doc) => m.id === moduleId)) throw new CellError('That module no longer exists.')
  if (!alt.outputs) alt.outputs = []
  for (const mv of alt.outputs) {
    if (mv.module_id === moduleId) {
      if (!mv.scores) mv.scores = {}
      return mv
    }
  }
  const mv = { module_id: moduleId, values: [], quantity: [], scores: {}, aahu: null }
  alt.outputs.push(mv)
  return mv
}

/** int(x) for a float: toward zero (Python's int() of a float). */
const pyInt = (x: number): number => Math.trunc(x) + 0

/** list[index] = value, with Python's IndexError past the end (a negative index counts back). */
function setAt(list: unknown[], index: number, value: unknown): void {
  const i = index < 0 ? list.length + index : index
  if (!Number.isInteger(index) || i < 0 || i >= list.length) throw new RangeError('list assignment index out of range')
  list[i] = value
}

/** int(text) for a path's index; Python's ValueError otherwise. */
function intOf(text: string | undefined): number {
  if (text === undefined) throw new RangeError('list index out of range')
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new PyValueError(`invalid literal for int() with base 10: ${pyStrRepr(text)}`)
  return Number(text.trim())
}

/** Set the cell at ``path`` in the project document ``doc`` (in place). */
function set(doc: Doc, path: string, raw: unknown): void {
  const parts = path.split('|')
  const kind = parts[0]
  const nYears = doc.benefits.target_years.length
  const part = (i: number): string => {
    if (i >= parts.length) throw new RangeError('list index out of range')
    return parts[i]
  }
  try {
    if (kind === 't') {
      const site = doc.sites[find(doc.sites, 'id', part(1))]
      if (parts.length === 3) site[parts[2]] = pyStrip(String(raw || ''))
      else {
        const ai = find(site.alternatives, 'id', part(2))
        site.alternatives[ai][part(3)] = pyStrip(String(raw || ''))
      }
      return
    }
    const si = find(doc.sites, 'id', part(1))
    const alt = doc.sites[si].alternatives[find(doc.sites[si].alternatives, 'id', part(2))]
    if (kind === 'b' || kind === 'f') {
      const mv = moduleValues(doc, alt, part(3))
      if (kind === 'f') {
        const fid = part(4)
        const k = intOf(part(5))
        const vals = pad(mv.scores[fid], nYears)
        const v = parseNumber(raw)
        if (v !== null && !(v >= 0 && v <= 15)) throw new CellError('STAF function scores run from 0 to 15.')
        setAt(vals, k, v)
        mv.scores[fid] = vals
      } else if (part(4) === 'aahu') {
        mv.aahu = parseNumber(raw)
      } else if (parts[4] === 'values' || parts[4] === 'quantity') {
        const vals = pad(mv[parts[4]], nYears)
        setAt(vals, intOf(part(5)), parseNumber(raw))
        mv[parts[4]] = vals
      } else {
        throw new CellError('Unknown cell.')
      }
    } else if (kind === 'c') {
      const costs = alt.costs
      if (part(3) === 'first') {
        const v = parseNumber(raw)
        if (v === null) delete costs.first_costs[part(4)]
        else {
          if (v < 0) throw new CellError('Costs cannot be negative.')
          costs.first_costs[part(4)] = v
        }
      } else if (parts[3] === 'months') {
        const v = parseNumber(raw)
        costs.construction_months = v === null ? 0.0 : v
        if (costs.construction_months < 0) throw new CellError('Months cannot be negative.')
      } else if (parts[3] === 'override') {
        costs.annual_override = parseNumber(raw)
      }
    } else if (kind === 'r') {
      const items = alt.costs.recurring
      const it = items[find(items, 'id', part(3))]
      const fld = part(4)
      if (fld === 'name') it[fld] = pyStrip(String(raw || '')) || it[fld]
      else if (fld === 'basis') it.basis = basis(raw)
      else if (fld === 'category_id') it[fld] = category(doc, raw)
      else if (fld === 'every_years' || fld === 'first_year' || fld === 'last_year') {
        const v = parseNumber(raw)
        if (fld === 'every_years') {
          if (v === null || v < 1) throw new CellError('Every N years must be 1 or more.')
          it[fld] = pyInt(v)
        } else {
          it[fld] = v === null ? null : pyInt(v)
        }
      } else if (fld === 'percent') {
        const v = parseNumber(raw)
        it[fld] = v === null ? 0.0 : v / 100.0
      } else {
        const v = parseNumber(raw)
        it[fld] = v === null ? 0.0 : v
      }
    } else {
      throw new CellError('Unknown cell.')
    }
  } catch (exc) {
    // IndexError and KeyError: a row or column that is gone
    if (exc instanceof RangeError || exc instanceof TypeError) throw new CellError('That cell no longer exists.')
    throw exc
  }
}

/** Paste a rectangle of text into ``grid`` (rows of cell paths, null where not editable), starting at
 * (r0, c0). Returns the project and how many cells were pasted. The paste is all or nothing: one bad
 * value rejects the block and names the cell. */
export function applyBlock(project: Project, grid: readonly (readonly (string | null)[])[], r0: number, c0: number,
  block: readonly (readonly string[])[]): [Project, number] {
  const doc = docOf(project)
  let n = 0
  for (const [i, row] of block.entries()) {
    const r = r0 + i
    if (r >= grid.length) break
    for (const [j, text] of row.entries()) {
      const c = c0 + j
      if (c >= grid[r].length) break
      const path = grid[r][c]
      if (path === null) continue
      try {
        set(doc, path, text)
      } catch (exc) {
        if (exc instanceof CellError) throw new CellError(`Pasted row ${i + 1}, column ${j + 1}: ${exc.message}`)
        throw exc
      }
      n += 1
    }
  }
  return [n ? validate(doc) : project, n]
}
