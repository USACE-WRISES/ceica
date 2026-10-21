// The file goldens' check (files_*.test.ts): describe() of the file this app makes must be the golden's.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { describe as describeFile } from '../src/files/describe'

/** describe() of the file this app makes, which must be the golden's; a file that differs is kept in the
 * temp folder to compare with the Python's. */
export function expectFile(bytes: Uint8Array, golden: unknown, label: string): void {
  const got = describeFile(bytes)
  if (JSON.stringify(got) !== JSON.stringify(golden)) writeFileSync(join(tmpdir(), `ceica-${label.replace(/[^\w.-]+/g, '_')}`), bytes)
  expect(got, label).toEqual(golden)
}
