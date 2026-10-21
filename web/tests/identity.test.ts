// The tests see the release identity the goldens were made with (tests/identity.ts): the guard that
// the pinning is on, so no golden test meets a release's own version or changelog by mistake.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as version from '../src/engine/version'
import { type Child, TagList } from '../src/shiny/htm'
import { whatsNewHtml } from '../src/views/shell'
import { IDENTITY, pinned } from './identity'

const html = (tag: Child): string => new TagList(tag).render()

describe('the pinned release identity', () => {
  it('every test sees the version and repo the goldens were made with', () => {
    const { APP_VERSION, REPO } = pinned()
    expect((version as unknown as Record<string, unknown>).FROZEN_IDENTITY).toBe(true)
    expect(version.APP_VERSION).toBe(APP_VERSION)
    expect(version.APP_VERSION_LABEL).toBe(`v${APP_VERSION}`)
    expect(version.REPO_URL).toBe(`https://github.com/${REPO}`)
    expect(version.ISSUES_URL).toBe(`https://github.com/${REPO}/issues`)
  })
  it("What's new reads the pinned changelog", () => {
    expect(html(whatsNewHtml())).toBe(html(whatsNewHtml(readFileSync(`${IDENTITY}CHANGELOG.md`, 'utf-8'))))
  })
  it('the engine version is the real one', () => {
    const real = readFileSync(new URL('../src/engine/version.ts', import.meta.url), 'utf-8')
    expect(real).toContain(`export const ENGINE_VERSION = '${version.ENGINE_VERSION}'`)
  })
})
