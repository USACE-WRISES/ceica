// The STAF import against ceica/staf_import.py (staf_import/<case>.json, make_staf_import_fixtures.py):
// what each SFARI, EASI or DEEP export reads as, or the error, and the project after Import.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe as group, expect, it } from 'vitest'
import { dumpProject, parseProject } from '../src/engine/model'
import { canonicalJson } from '../src/engine/projectfile'
import {
  AttributeError, importMapping, JsonDecodeError, PyKeyError, readStafFile, sourceLabel, type StafImport, StafImportError, UnicodeDecodeError,
} from '../src/engine/stafImport'
import { digest } from '../src/files/describe'
import { KeyError, WorkbookReadError } from '../src/files/xlsx/read'
import { BadZipFile, ZipKeyError } from '../src/files/zip'
import { utf8 } from '../src/py/bytes'
import { parseJson } from '../src/py/pyjson'
import { PyTypeError, PyValueError } from '../src/py/pystr'
import { EditError, importReaches } from '../src/views/edits'
import projects from './fixtures/staf_import/projects.json'

const goldens = import.meta.glob<Record<string, any>>('./fixtures/staf_import/*.json', { import: 'default', eager: true })
const LIMIT = 4096

/** the Python exception's name for what the port throws */
function pyType(exc: unknown): string {
  if (exc instanceof StafImportError) return 'StafImportError'
  if (exc instanceof EditError) return 'EditError'
  if (exc instanceof AttributeError) return 'AttributeError'
  if (exc instanceof PyKeyError || exc instanceof KeyError || exc instanceof ZipKeyError) return 'KeyError'
  if (exc instanceof JsonDecodeError) return 'JSONDecodeError'
  if (exc instanceof UnicodeDecodeError) return 'UnicodeDecodeError'
  if (exc instanceof PyValueError) return 'ValueError'
  if (exc instanceof PyTypeError) return 'TypeError'
  if (exc instanceof BadZipFile) return 'BadZipFile'
  if (exc instanceof WorkbookReadError) return exc.pyName
  return (exc as Error).name
}

const error = (exc: unknown) => ({ error: `${pyType(exc)}: ${(exc as Error).message}` })

function describeImport(imp: StafImport): Record<string, unknown> {
  let mapping: string
  try {
    mapping = importMapping(imp)
  } catch (exc) {
    mapping = `KeyError: ${(exc as Error).message}`
  }
  return {
    tool: imp.tool, kind: imp.kind, filename: imp.filename, sha256: imp.sha256, mapping, warnings: [...imp.warnings],
    reaches: imp.reaches.map((r) => ({
      reach_id: r.reach_id, name: r.name, scores: Object.fromEntries(r.scores), not_assessed: [...r.not_assessed], length_ft: r.length_ft,
      notes: [...r.notes], source: sourceLabel(imp, r),
    })),
  }
}

const short = (text: string): string => (utf8(text).length <= LIMIT ? text : digest(utf8(text)))
const base = (name: string) => parseProject(parseJson((projects as Record<string, string>)[name]))

const cases = Object.keys(goldens).filter((p) => !p.endsWith('/projects.json')).sort()
  .map((path) => ({ name: path.replace(/^.*\/(.*)\.json$/, '$1'), golden: goldens[path] }))

group.each(cases)('the STAF import of $name', ({ golden }) => {
  const data = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'staf_import', 'inputs', golden.input)))
  let imp: StafImport | null = null
  it('reads as the Python reads it', () => {
    let got: Record<string, unknown>
    try {
      imp = readStafFile(data, golden.name)
      got = describeImport(imp)
    } catch (exc) {
      got = error(exc)
    }
    expect(got).toEqual(golden.read)
  })
  if (golden.applied) {
    it('lands in the project as the Python puts it', () => {
      imp ??= readStafFile(data, golden.name)
      for (const run of golden.applied) {
        let got: Record<string, unknown>
        try {
          const q = importReaches(base(run.base), imp, new Map((run.targets as string[]).map((t, i) => [i, t])), run.module)
          got = { project: short(canonicalJson(dumpProject(q))) }
        } catch (exc) {
          got = error(exc)
        }
        expect({ base: run.base, targets: run.targets, module: run.module, ...got }).toEqual(run)
      }
    })
  }
})
