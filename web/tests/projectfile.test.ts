// Opening and saving .ceica files, and the input checks, against the Python engine
// (projects/*.json and invalid_ref.json, web/parity/make_project_fixtures.py).
import { describe, expect, it } from 'vitest'
import { contentDigest, dumps, loads, ProjectFileError } from '../src/engine/projectfile'
import { checkProject } from '../src/engine/validate'
import invalidJson from './fixtures/invalid_ref.json'
import { projectGoldens, SAVED_AT } from './projects'

const invalid = invalidJson as unknown as { cases: { name: string, text: string, error: string, prefixOnly: boolean }[] }

describe.each(projectGoldens())('$name', ({ input, expected }) => {
  const loaded = loads(input)

  it('opens with Python\'s warnings, date and version', () => {
    expect([...loaded.warnings]).toEqual(expected.warnings)
    expect(loaded.saved_at).toBe(expected.savedAt)
    expect(loaded.app_version).toBe(expected.appVersion)
  })

  it('saves to Python\'s bytes, with Python\'s digest', () => {
    expect(dumps(loaded.project, { savedAt: SAVED_AT })).toBe(expected.dumps ?? input)
    expect(contentDigest(loaded.project)).toBe(expected.digest)
  })

  it('raises Python\'s input checks', () => {
    const issues = checkProject(loaded.project).map((i) => [i.level, i.code, i.message, i.section,
      i.site_id, i.alt_id])
    expect(issues).toEqual(expected.issues)
  })

  it('opens again what it saved', () => {
    const again = loads(dumps(loaded.project, { savedAt: SAVED_AT }))
    expect(again.warnings).toEqual([])
    expect(contentDigest(again.project)).toBe(expected.digest)
  })
})

describe('refusals, in Python\'s words', () => {
  it.each(invalid.cases)('$name', ({ text, error, prefixOnly }) => {
    let message = ''
    try {
      loads(text)
    } catch (exc) {
      expect(exc).toBeInstanceOf(ProjectFileError)
      message = (exc as Error).message
    }
    if (prefixOnly) expect(message.slice(0, 52)).toBe(error.slice(0, 52))
    else expect(message).toBe(error)
  })
})
