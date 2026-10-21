// The PDF document against reportlab (files/pdf/<project>.json, make_file_fixtures.py): both dated by the
// same SOURCE_DATE_EPOCH, so the files are equal byte for byte (a file that differs is left in the temp
// folder to compare).
import { describe as group, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { buildReport } from '../src/engine/report/model'
import { renderPdf } from '../src/engine/report/pdf'
import { epochTimeStamp } from '../src/files/pdf/pdfdoc'
import { expectFile } from './fileCheck'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, unknown>>('./fixtures/files/pdf/*.json', { import: 'default', eager: true })
/** make_traces.TODAY and make_file_fixtures.PDF_EPOCH */
const TODAY = new Date(2026, 9, 18)
const EPOCH = 1792324800

const cases = fileProjects().filter(({ name }) => goldens[`./fixtures/files/pdf/${name}.json`])

group('the PDF document', () => {
  for (const { name, input } of cases) {
    it(`of ${name}`, () => {
      const res = analyze(loads(input).project)
      expectFile(renderPdf(buildReport(res, { today: TODAY }), epochTimeStamp(EPOCH)), goldens[`./fixtures/files/pdf/${name}.json`], `${name}.pdf`)
    })
  }
})
