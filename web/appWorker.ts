// The offline worker's build step (Vite, after the build is written): the stylesheets now in the page
// leave the build (site.ts, INLINED), and sw/app-sw.js is written in as app-sw.js with the build's id
// and every file it keeps, each with its sha256. The id hashes the worker's code and every file's name
// and bytes, so the same sources give the same worker and a changed build is a new one. Adapted from
// STAF's static app (scripts/after-build.mjs).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { INLINED } from './site.ts'

/** The worker's code, its build and files to fill in */
export const TEMPLATE = fileURLToPath(new URL('./sw/app-sw.js', import.meta.url))
/** The workers are not part of the copy */
export const NOT_KEPT: ReadonlySet<string> = new Set(['app-sw.js', 'download-sw.js'])

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Every file of a build folder the copy keeps: paths with "/", sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const rel = relative(dir, path).split(sep).join('/')
        if (!NOT_KEPT.has(rel)) out.push(rel)
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** The build's id: the worker's code, then each file's name and bytes, hashed (16 hex digits). */
export function buildId(template: string, dir: string, files: readonly string[]): string {
  const hash = createHash('sha256').update(template).update('\0')
  for (const f of files) hash.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0')
  return hash.digest('hex').slice(0, 16)
}

/** The worker with its build and files written in. */
export function workerScript(template: string, build: string, files: readonly (readonly [string, string])[]): string {
  if (!template.includes("'__CEICA_BUILD__'") || !template.includes('__CEICA_FILES__')) throw new Error('the worker template lost a placeholder')
  return template.replace("'__CEICA_BUILD__'", JSON.stringify(build)).replace('__CEICA_FILES__', JSON.stringify(files))
}

/** Writes dist/app-sw.js for a build folder; its id, file count and size. */
export function writeAppWorker(dir: string, template = readFileSync(TEMPLATE, 'utf-8')): { build: string, files: number, bytes: number } {
  for (const path of INLINED) rmSync(join(dir, path), { force: true })
  const files = listFiles(dir)
  const build = buildId(template, dir, files)
  const kept = files.map((f) => [f, sha256(readFileSync(join(dir, f)))] as const)
  writeFileSync(join(dir, 'app-sw.js'), workerScript(template, build, kept))
  return { build, files: files.length, bytes: files.reduce((n, f) => n + statSync(join(dir, f)).size, 0) }
}

export function ceicaAppWorker(): Plugin {
  let outDir = ''
  return {
    name: 'ceica-app-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // after every file is written (Vite copies page/ before the bundle is rendered)
    writeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const { build, files, bytes } = writeAppWorker(outDir)
        this.info(`app-sw.js: build ${build}, ${files} files, ${bytes.toLocaleString('en-US')} bytes`)
      },
    },
  }
}
