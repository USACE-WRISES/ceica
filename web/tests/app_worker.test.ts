// The offline worker's build step (appWorker.ts): the files a build keeps, its id (the same for the same
// files, a new one for any change), the worker with them written in, and the stylesheets now in the
// page left out.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe as group, expect, it } from 'vitest'
import { buildId, listFiles, TEMPLATE, workerScript, writeAppWorker } from '../appWorker'
import { INLINED } from '../site'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ceica-build-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const FILES = { 'index.html': '<html>', 'assets/index-abc.js': 'js', 'fonts/x.woff2': 'font', 'app-sw.js': 'old', 'download-sw.js': 'dl' }
const template = readFileSync(TEMPLATE, 'utf-8')

group('the offline worker build', () => {
  it('keeps every file but the workers, sorted, with "/" paths', () => {
    expect(listFiles(folder(FILES))).toEqual(['assets/index-abc.js', 'fonts/x.woff2', 'index.html'])
  })

  it('names a build by its files and the worker', () => {
    const a = folder(FILES)
    const files = listFiles(a)
    const id = buildId(template, a, files)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(buildId(template, folder(FILES), files)).toBe(id)
    expect(buildId(template, folder({ ...FILES, 'fonts/x.woff2': 'fonT' }), files)).not.toBe(id)
    const renamed = folder({ 'index.html': '<html>', 'assets/index-abd.js': 'js', 'fonts/x.woff2': 'font' })
    expect(buildId(template, renamed, listFiles(renamed))).not.toBe(id)
    expect(buildId(`${template}\n`, a, files)).not.toBe(id)
  })

  it('writes the build and its files into the worker', () => {
    const script = workerScript(template, 'abc', [['index.html', 'f00']])
    expect(script).toContain("const BUILD = \"abc\"")
    expect(script).toContain('const FILES = [["index.html","f00"]]')
    expect(() => new Function(script)).not.toThrow()
    expect(() => workerScript('nothing to fill', 'abc', [])).toThrow()
  })

  it('leaves the inlined stylesheets out and writes app-sw.js with each file and its sha256', () => {
    const dir = folder({ ...FILES, ...Object.fromEntries(INLINED.map((p) => [p, 'css'])), 'shiny/fonts/y.woff2': 'y' })
    const out = writeAppWorker(dir, template)
    for (const p of INLINED) expect(existsSync(join(dir, p)), p).toBe(false)
    const worker = readFileSync(join(dir, 'app-sw.js'), 'utf-8')
    const files = JSON.parse(worker.match(/const FILES = (.*)\n/)![1]) as [string, string][]
    expect(files.map(([f]) => f)).toEqual(['assets/index-abc.js', 'fonts/x.woff2', 'index.html', 'shiny/fonts/y.woff2'])
    for (const [f, sha] of files) expect(sha).toBe(createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'))
    expect(out.files).toBe(4)
    expect(worker).toContain(`const BUILD = "${out.build}"`)
  })
})
