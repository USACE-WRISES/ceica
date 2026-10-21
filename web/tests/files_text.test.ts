// The Report page's text files against ceica/report (files/text/<project>.json, make_file_fixtures.py):
// each table's CSV, the Everything zip's README and the HTML document, for make_project_fixtures'
// projects and the edge projects.
import { describe as group, it } from 'vitest'
import { analyze, type AnalysisResults } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { catalog, type Exhibit, type TableData } from '../src/engine/report/exhibits'
import { renderHtml } from '../src/engine/report/html'
import { buildReport } from '../src/engine/report/model'
import { tableCsv } from '../src/engine/report/tables'
import { readmeText } from '../src/engine/report/zips'
import { utf8 } from '../src/py/bytes'
import { expectFile } from './fileCheck'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, any>>('./fixtures/files/text/*.json', { import: 'default', eager: true })

/** The day the goldens are made on (make_traces.TODAY). */
const TODAY = new Date(2026, 9, 18)

group.each(fileProjects())('text files of $name', ({ name, input }) => {
  const golden = goldens[`./fixtures/files/text/${name}.json`]
  let made: { res: AnalysisResults, exhibits: readonly Exhibit[] } | null = null
  const study = () => {
    if (made === null) {
      const res = analyze(loads(input).project)
      made = { res, exhibits: catalog(res) }
    }
    return made
  }
  it('each table as CSV', () => {
    for (const e of study().exhibits) {
      if (e.kind === 'table') expectFile(tableCsv(e.build() as TableData), golden.csv[e.id], `${name}-${e.id}.csv`)
    }
  })
  it('the README', () => expectFile(utf8(readmeText(study().res, TODAY, study().exhibits)), golden.readme, `${name}-README.txt`))
  it('the HTML document', () => expectFile(utf8(renderHtml(buildReport(study().res, { today: TODAY }))), golden.html, `${name}.html`))
})
