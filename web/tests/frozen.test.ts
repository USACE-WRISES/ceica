// The goldens are frozen (tests/fixtures/README.md): every file of tests/fixtures as FROZEN.sha256
// lists it. A golden changed on purpose shows as a change to that list (npm run freeze), with the
// reason in the README's log.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { LIST, listing } from '../tools/freeze.ts'

const entries = (text: string): Map<string, string> =>
  new Map(text.split('\n').filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]))

it('every golden is as it was frozen (tests/fixtures/FROZEN.sha256)', () => {
  const want = entries(readFileSync(LIST, 'utf-8'))
  const got = entries(listing())
  const changed = [...got].filter(([p, h]) => want.has(p) && want.get(p) !== h).map(([p]) => p)
  const added = [...got.keys()].filter((p) => !want.has(p))
  const removed = [...want.keys()].filter((p) => !got.has(p))
  expect({ changed, added, removed }).toEqual({ changed: [], added: [], removed: [] })
})
