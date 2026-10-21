// The release identity the goldens were made with, seen by every test in place of the real one, so a
// release (a new version, a re-dated changelog) changes no golden. The Python engine wrote the goldens
// at the tag shiny-final, with version 1.0.0, the repo USACE-WRISES/ceica and that day's CHANGELOG.md
// (fixtures/identity/); nothing can write them again, so they keep that identity for good
// (fixtures/README.md, CONTRIBUTING.md rule 11). Only the names a release changes are pinned, the
// version and the repo; ENGINE_VERSION and the rest come from the real version.ts.
//
// vite.config.ts adds this plugin when Vitest runs. Every import of src/engine/version.ts gets a
// module that re-exports the real file with the pinned names over it (and FROZEN_IDENTITY, which
// identity.test.ts looks for), and CHANGELOG.md?raw gets the pinned copy. The real files are read as
// text by repo_rules.test.ts, which checks them against each other.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const slash = (path: string): string => path.split('\\').join('/')

const WEB = slash(fileURLToPath(new URL('..', import.meta.url)))
export const IDENTITY = `${WEB}tests/fixtures/identity/`
const VERSION = `${WEB}src/engine/version.ts`
const CHANGELOG = slash(fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url)))
const FROZEN = '\0ceica-frozen-version'

/** A path as the plugin compares it (Windows paths come in either case and either slash). */
const key = (path: string): string => slash(path).toLowerCase()

/** The pinned names: the version and the repo the goldens were made with. */
export function pinned(): { APP_VERSION: string, REPO: string } {
  return JSON.parse(readFileSync(`${IDENTITY}identity.json`, 'utf-8')) as { APP_VERSION: string, REPO: string }
}

export function frozenIdentity(): Plugin {
  const { APP_VERSION, REPO } = pinned()
  return {
    name: 'ceica-frozen-identity',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const found = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!found) return null
      const [path, query] = found.id.split('?', 2)
      // ?real: the pinned module's own import of the real file, let through
      if (key(path) === key(VERSION) && query !== 'real') return FROZEN
      if (key(path) === key(CHANGELOG)) return `${IDENTITY}CHANGELOG.md${query ? `?${query}` : ''}`
      return null
    },
    load(id) {
      if (id !== FROZEN) return null
      return [
        `export * from ${JSON.stringify(`${VERSION}?real`)}`,
        `export const APP_VERSION = ${JSON.stringify(APP_VERSION)}`,
        'export const APP_VERSION_LABEL = `v${APP_VERSION}`',
        `export const REPO = ${JSON.stringify(REPO)}`,
        'export const REPO_URL = `https://github.com/${REPO}`',
        'export const ISSUES_URL = `${REPO_URL}/issues`',
        'export const FROZEN_IDENTITY = true',
        '',
      ].join('\n')
    },
  }
}
