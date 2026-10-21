// The Report page's table workbooks against openpyxl (files/tables/<project>.json, make_file_fixtures.py):
// each table as a workbook and every table in one, part by part.
import { describe as group, it } from 'vitest'
import { analyze, type AnalysisResults } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { catalog, type Exhibit } from '../src/engine/report/exhibits'
import { tablesXlsx, tableXlsx } from '../src/engine/report/tables'
import { expectFile } from './fileCheck'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, any>>('./fixtures/files/tables/*.json', { import: 'default', eager: true })

group.each(fileProjects())('table workbooks of $name', ({ name, input }) => {
  const golden = goldens[`./fixtures/files/tables/${name}.json`]
  let made: { res: AnalysisResults, exhibits: readonly Exhibit[] } | null = null
  const study = () => {
    if (made === null) {
      const res = analyze(loads(input).project)
      made = { res, exhibits: catalog(res) }
    }
    return made
  }
  it('each table as a workbook', () => {
    for (const e of study().exhibits) if (e.kind === 'table') expectFile(tableXlsx(e), golden.xlsx[e.id], `${name}-${e.id}.xlsx`)
  })
  it('every table in one workbook', () => expectFile(tablesXlsx(study().res, study().exhibits), golden.all, `${name}-tables.xlsx`))
})
