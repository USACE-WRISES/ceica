// The Report page's catalog and file names against ceica/report (exhibits/<project>.json and
// names.json, make_exhibits_fixtures.py).
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { catalog, type Cell, exhibitLabel, PyInt, type TableData } from '../src/engine/report/exhibits'
import { exhibitFile, figureSvg, fileStem, resolve, safeName } from '../src/engine/report/files'
import { loads } from '../src/engine/projectfile'
import { pyFloat } from '../src/py/pyfmt'
import names from './fixtures/exhibits/names.json'
import { digest } from './helpers'
import { projectGoldens } from './projects'

const goldens = import.meta.glob<Record<string, any>>('./fixtures/exhibits/*.json', { import: 'default', eager: true })

/** The day the goldens are made on (make_traces.TODAY). */
const TODAY = new Date(2026, 9, 18)

function cell(v: Cell): [string, unknown] {
  if (v === null) return ['n', null]
  if (typeof v === 'boolean') return ['b', v]
  if (v instanceof PyInt) return ['i', v.value]
  if (typeof v === 'number') return ['f', pyFloat(v)]
  return ['s', v]
}

const tableJson = (t: TableData) => ({
  columns: t.columns.map((c) => [c.name, c.kind, c.decimals, c.align]), rows: t.rows.map((r) => r.map(cell)),
  total_last: t.total_last, landscape: t.landscape, note: t.note,
})

describe.each(projectGoldens())('exhibits of $name', ({ name, input }) => {
  const golden = goldens[`./fixtures/exhibits/${name}.json`]
  it('lists the catalog, every table and every figure as the Python does', () => {
    const p = loads(input).project
    const res = analyze(p)
    const exhibits = catalog(res)
    expect(fileStem(p, TODAY)).toBe(golden.stem)
    expect(safeName(p.name)).toBe(golden.safe)
    expect(exhibits.map((e) => ({ id: e.id, kind: e.kind, group: e.group, number: e.number, label: exhibitLabel(e), title: e.title,
      caption: e.caption, key: e.key, n_rows: e.n_rows, file: exhibitFile(e, exhibits) }))).toEqual(golden.catalog)
    for (const e of exhibits) {
      if (e.kind === 'table' && e.id !== 'plans-all') {
        expect(tableJson(e.build() as TableData), e.id).toEqual(golden.tables[e.id])
        if (e.id === 'plans-bb' || e.id === 'plans-final') {
          expect(tableJson(e.build({ actions: true }) as TableData), `${e.id} actions`).toEqual(golden.tables[`${e.id}/actions`])
        }
      } else if (e.kind === 'figure') {
        expect(digest(figureSvg(e)), e.id).toBe(golden.figures[e.id].svg)
        expect(resolve(res, e.id, 'svg', TODAY)!.filename).toBe(golden.figures[e.id].filename)
      }
    }
    expect(resolve(res, 'project', 'ceica', TODAY)!.filename).toBe(golden.project_file)
  })
})

describe('names', () => {
  it('safe_name and file_stem', () => {
    for (const n of names.names) {
      expect(safeName(n.text), JSON.stringify(n.text)).toBe(n.safe)
      expect(safeName(n.text, 20), JSON.stringify(n.text)).toBe(n.safe20)
    }
    expect(fileStem(null, TODAY)).toBe(names.stem_none)
  })
})
