// The figures zip and the Everything zip against Python's (files/zip/<project>.json, make_file_fixtures.py):
// every clock inside fixed as the maker fixes it, so each record and member is equal; the pictures by
// pixel size and dpi (a stand-in draws them here).
import { describe as group, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { buildFile, type FileContext } from '../src/engine/report/build'
import { epochTimeStamp } from '../src/files/pdf/pdfdoc'
import { expectFile } from './fileCheck'
import { stubPng } from './pngStub'
import { fileProjects } from './projects'

const goldens = import.meta.glob<Record<string, unknown>>('./fixtures/files/zip/*.json', { import: 'default', eager: true })
/** make_traces.TODAY, make_file_fixtures.DOCX_TIME, PDF_EPOCH and SAVED_AT */
const CTX: FileContext = {
  today: new Date(2026, 9, 18), now: new Date(2026, 9, 18, 12, 0, 0), png: stubPng, pdfStamp: epochTimeStamp(1792324800),
  savedAt: '2026-10-18T12:00:00Z',
}

const cases = fileProjects().filter(({ name }) => goldens[`./fixtures/files/zip/${name}.json`])

group('the zips', () => {
  for (const { name, input } of cases) {
    for (const f of ['figures', 'everything']) {
      it(`${f} of ${name}`, async () => {
        const res = analyze(loads(input).project)
        expectFile(await buildFile(res, { f, fmt: 'zip' }, CTX), goldens[`./fixtures/files/zip/${name}.json`][f], `${name}-${f}.zip`)
      })
    }
  }
})
