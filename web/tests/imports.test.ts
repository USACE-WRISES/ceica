// Opening a workbook against openpyxl and the Python importer (imports/<case>.json,
// make_import_fixtures.py): what the reader reads from each workbook, and what the import makes of it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe as group, expect, it } from 'vitest'
import { templateProject } from '../src/app/server'
import { analyze } from '../src/engine/analysis'
import { copy, dumpProject, PydanticError } from '../src/engine/model'
import { canonicalJson, loads } from '../src/engine/projectfile'
import { buildCalculator } from '../src/engine/workbook/export'
import { JsonDecodeError, KeyLookupError, OverflowError, readWorkbook, WorkbookError } from '../src/engine/workbook/importer'
import { buildTemplate } from '../src/engine/workbook/template'
import { digest } from '../src/files/describe'
import { KeyError, loadWorkbook, pyReprOf, pyTypeOf, WorkbookReadError } from '../src/files/xlsx/read'
import { BadZipFile, ZipKeyError } from '../src/files/zip'
import { utf8 } from '../src/py/bytes'
import { PyTypeError, PyValueError } from '../src/py/pystr'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, any>>('./fixtures/imports/*.json', { import: 'default', eager: true })
const inputs = new Map(fileProjects().map((p) => [p.name, p.input]))
const LIMIT = 4096

const short = (text: string): string => (utf8(text).length <= LIMIT ? text : digest(utf8(text)))

/** the Python exception's name for what the port throws */
function pyType(exc: unknown): string {
  if (exc instanceof WorkbookError) return 'WorkbookError'
  if (exc instanceof PydanticError) return 'ValidationError'
  if (exc instanceof PyValueError) return 'ValueError'
  if (exc instanceof PyTypeError) return 'TypeError'
  if (exc instanceof OverflowError) return 'OverflowError'
  if (exc instanceof KeyLookupError) return 'KeyError'
  if (exc instanceof JsonDecodeError) return 'JSONDecodeError'
  if (exc instanceof WorkbookReadError) return exc.pyName
  if (exc instanceof BadZipFile) return 'BadZipFile'
  if (exc instanceof ZipKeyError || exc instanceof KeyError) return 'KeyError'
  return (exc as Error).name
}

function readDescription(data: Uint8Array): Record<string, unknown> {
  let wb
  try {
    wb = loadWorkbook(data)
  } catch (exc) {
    return { error: `${pyType(exc)}: ${(exc as Error).message}` }
  }
  return {
    sheets: wb.sheets.map((ws) => ({
      title: ws.title, state: ws.state, max_row: ws.maxRow, max_column: ws.maxColumn,
      cells: short(ws.entries().map(([r, c, cell]) => `${r},${c}\t${cell.dataType}\t${pyTypeOf(cell.value)}\t${pyReprOf(cell.value)}`).join('\n')),
    })),
  }
}

function importResult(data: Uint8Array): Record<string, unknown> {
  let imp
  try {
    imp = readWorkbook(data)
  } catch (exc) {
    return { error: `${pyType(exc)}: ${(exc as Error).message}` }
  }
  let p = imp.project
  if (imp.source === 'template') p = copy(p, { project_id: 'template' })
  const text = canonicalJson(dumpProject(p))
  const out = { source: imp.source, changes: imp.changes.map((c) => `${c.where}: ${c.before} to ${c.after}`), warnings: [...imp.warnings],
    project: short(text) }
  return out
}

function inputOf(input: string | Record<string, string>): Uint8Array {
  if (typeof input === 'string') return new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'imports', 'inputs', input)))
  if (input.calculator) {
    const p = loads(inputs.get(input.calculator)!).project
    return buildCalculator(p, analyze(p))
  }
  if (input.template) return buildTemplate(loads(inputs.get(input.template)!).project)
  return buildTemplate(templateProject(input.blank))
}

const cases = Object.keys(goldens).sort().map((path) => ({ name: path.replace(/^.*\/(.*)\.json$/, '$1'), golden: goldens[path] }))

group.each(cases)('opening $name', ({ name, golden }) => {
  let data: Uint8Array | null = null
  const bytes = () => (data ??= inputOf(golden.input))
  it('reads as openpyxl reads it', () => expect(readDescription(bytes())).toEqual(golden.read))
  it('imports as the Python imports it', () => expect(importResult(bytes())).toEqual(golden.result))
})
