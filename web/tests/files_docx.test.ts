// The Word document against python-docx (files/docx/<project>.json, make_file_fixtures.py): saved at the
// same local time, so every part and record is equal; the pictures by pixel size and dpi (the browser
// draws them; here a stand-in of the same size does).
import { describe as group, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { renderDocx } from '../src/engine/report/docx'
import { buildReport } from '../src/engine/report/model'
import { expectFile } from './fileCheck'
import { stubPng } from './pngStub'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, unknown>>('./fixtures/files/docx/*.json', { import: 'default', eager: true })
/** make_traces.TODAY and make_file_fixtures.DOCX_TIME */
const TODAY = new Date(2026, 9, 18)
const SAVED = { year: 2026, month: 10, day: 18, hour: 12, minute: 0, second: 0 }

const cases = fileProjects().filter(({ name }) => goldens[`./fixtures/files/docx/${name}.json`])

group('the Word document', () => {
  for (const { name, input } of cases) {
    it(`of ${name}`, async () => {
      const res = analyze(loads(input).project)
      expectFile(await renderDocx(buildReport(res, { today: TODAY }), stubPng, SAVED), goldens[`./fixtures/files/docx/${name}.json`],
        `${name}.docx`)
    })
  }
})
