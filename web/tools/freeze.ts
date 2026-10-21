// The goldens' list (tests/fixtures/FROZEN.sha256): every file of tests/fixtures with its sha256, but
// the list itself and the folder's README. tests/frozen.test.ts compares the folder with it, so a
// golden changed on purpose shows as a change to this list in the same commit, with the reason in the
// README's log (tests/fixtures/README.md, CONTRIBUTING.md rule 11).
//
//     npm run freeze    the list written again from the folder
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES = fileURLToPath(new URL('../tests/fixtures/', import.meta.url))
export const LIST = join(FIXTURES, 'FROZEN.sha256')
const LEFT_OUT = new Set(['FROZEN.sha256', 'README.md'])

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : []
  })
}

/** The list as the folder stands: one line a file, "<sha256>  <path>", in path order. */
export function listing(): string {
  return walk(FIXTURES)
    .map((p) => relative(FIXTURES, p).split('\\').join('/'))
    .filter((p) => !LEFT_OUT.has(p))
    .sort()
    .map((p) => `${createHash('sha256').update(readFileSync(join(FIXTURES, p))).digest('hex')}  ${p}\n`)
    .join('')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(LIST, listing())
  console.log(`wrote ${relative(process.cwd(), LIST)}`)
}
