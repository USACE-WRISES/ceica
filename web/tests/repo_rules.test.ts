// The repository's own rules, ported from the Python app's tests when the Python retired (Phase 5):
// the copy rules over every file people or the tests read (no em or en dashes, US spelling), the
// changelog and the version moving together, the page loading nothing from other sites, and the
// public repo's hygiene: no AI tool named, no personal data or machine paths, and IWR Planning Suite II
// cited by its behavior only. CONTRIBUTING.md has the rules these check.
//
// It reads the real files as text: every other test sees the release identity the goldens were made
// with (tests/identity.ts), and What's new is rendered here from the real CHANGELOG.md. The words it
// looks for are put together from pieces, so this file never matches itself.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readZip } from '../src/files/zip'
import { type Child, TagList } from '../src/shiny/htm'
import { whatsNewHtml } from '../src/views/shell'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)]
const piece = (...parts: string[]): string => parts.join('')
/** Folders never walked: tools' and builds' own, and the reference material kept on this computer. */
const SKIP = new Set(['.venv', piece('Reference', 'Only'), '.git', '__pycache__', '.pytest_cache', '.ruff_cache',
  '.hypothesis', 'node_modules', 'dist', 'captures'])

/** The public history began (Phase 5, Stage 3): from then on commit messages are checked too, and the
 * files kept on this computer must not be tracked at all. */
const RESTARTED = true

const tool = piece('cla', 'ude')
/** What stays on this computer, never in the repository: the notes, the tool's files, the oracle. */
const LOCAL_ONLY = ['notes/', `.${tool}/`, `${tool.toUpperCase()}.md`, piece('AGENTS', '.md'),
  'web/tests/oracles/iwr_ceica.ts', `${piece('Reference', 'Only')}/`]

const rel = (p: string): string => relative(REPO, p).split('\\').join('/')
const html = (tag: Child): string => new TagList(tag).render()

/** Every file under the repo with one of these extensions (the folders in SKIP left out). */
function walk(exts: readonly string[], dir = REPO): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(exts, join(dir, e.name))
    return e.isFile() && exts.includes(extname(e.name).toLowerCase()) ? [join(dir, e.name)] : []
  })
}

describe('copy rules (CONTRIBUTING.md rule 6)', () => {
  it('no em or en dashes in the web assets', () => {
    const bad = walk(['.js', '.css', '.ts', '.webmanifest'])
      .filter((p) => DASHES.some((d) => readFileSync(p, 'utf-8').includes(d))).map(rel)
    expect(bad).toEqual([])
  })
  it('no em or en dashes in the documents people read', () => {
    const bad: string[] = []
    for (const name of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs/methods.md']) {
      readFileSync(join(REPO, name), 'utf-8').split('\n').forEach((line, i) => {
        if (DASHES.some((d) => line.includes(d))) bad.push(`${name}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
  it('US spelling everywhere', () => {
    const british = new RegExp(`\\b(${[piece('col', 'our\\w*'), piece('behavi', 'our\\w*'), piece('fav', 'our\\w*'),
      piece('hon', 'our\\w*'), piece('lab', 'our\\w*'), piece('analy', 's(e|ed|es|ing)'), piece('organ', 'is(e|ed|es|ing|ation)\\w*'),
      piece('cen', 'tre\\w*'), piece('me', 'tre\\w*'), piece('model', 'ling'), piece('label', 'led'), piece('label', 'ling'),
      piece('cancel', 'led'), piece('travel', 'led'), piece('program', 'mes?'), piece('lic', 'ence\\w*'),
      piece('catal', 'ogue\\w*'), piece('def', 'ence\\w*'), piece('arte', 'fact\\w*'), piece('optim', 'is\\w*'),
      piece('summar', 'is\\w*'), piece('recogn', 'is\\w*'), piece('normal', 'is\\w*'), piece('util', 'is\\w*'),
      piece('visual', 'is\\w*'), piece('priorit', 'is\\w*')].join('|')})\\b`, 'i')
    // a library's own keyword, quoted, as the file writers compare with it: ReportLab's alignment
    const library = new RegExp(`'${piece('CEN', 'TRE')}'`, 'g')
    const hits: string[] = []
    for (const p of walk(['.js', '.ts', '.css', '.md', '.html', '.txt', '.cff', '.yml', '.webmanifest', '.ps1'])) {
      if (p === SELF) continue
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
        const m = british.exec(line.replace(library, ''))
        if (m) hits.push(`${rel(p)}:${i + 1}: ${m[0]}`)
      })
    }
    expect(hits).toEqual([])
  })
})

describe('the changelog and the version move together (CONTRIBUTING.md rule 7)', () => {
  const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf-8')
  const section = /^## v(\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/gm
  const sections = [...changelog.matchAll(section)].map((m) => ({ version: m[1], date: m[2] }))
  const top = sections[0]
  const versionTs = readFileSync(join(WEB, 'src', 'engine', 'version.ts'), 'utf-8')
  const appVersion = /^export const APP_VERSION = '([^']*)'$/m.exec(versionTs)?.[1]
  const repo = /^export const REPO = '([^']*)'$/m.exec(versionTs)?.[1]

  it('sections are well formed, newest first', () => {
    expect(changelog.startsWith('# Changelog\n')).toBe(true)
    expect(sections.length).toBeGreaterThan(0)
    expect((changelog.match(/^## /gm) ?? []).length).toBe(sections.length)
    for (const s of sections) expect(Number.isNaN(Date.parse(`${s.date}T00:00:00Z`))).toBe(false)
    const key = (v: string) => v.split('.').map((x) => x.padStart(6, '0')).join('.')
    const keys = sections.map((s) => key(s.version))
    expect(keys).toEqual([...new Set(keys)].sort().reverse())
  })
  it('each bullet is one line of at most 80 characters, and a release has 1 to 10', () => {
    for (const line of changelog.split('\n')) {
      if (line.startsWith('- ')) expect(line.length - 2, line).toBeLessThanOrEqual(80)
      else if (line.trim()) expect(line.startsWith('#'), `prose or a wrapped bullet: ${line}`).toBe(true)
    }
    for (const part of changelog.split(/^## /m).slice(1)) {
      const bullets = part.split('\n').filter((l) => l.startsWith('- ')).length
      expect(bullets, part.split('\n')[0]).toBeGreaterThan(0)
      expect(bullets, part.split('\n')[0]).toBeLessThanOrEqual(10)
    }
  })
  it('the top section is the app version, in version.ts, package.json and its lock, and CITATION.cff', () => {
    expect(appVersion).toBe(top.version)
    const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf-8')) as { version: string }
    expect(pkg.version).toBe(top.version)
    const lock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf-8')) as { version: string, packages: Record<string, { version?: string }> }
    expect([lock.version, lock.packages[''].version]).toEqual([top.version, top.version])
    const cff = readFileSync(join(REPO, 'CITATION.cff'), 'utf-8')
    expect(cff).toMatch(new RegExp(`^version: ${top.version.replace(/\./g, '\\.')}$`, 'm'))
    expect(cff).toContain(`date-released: ${top.date}`)
    expect(cff).toContain(`repository-code: "https://github.com/${repo}"`)
  })
  it("What's new shows the top section, in plain words", () => {
    const shown = html(whatsNewHtml(changelog))
    expect(shown).toContain(`v${top.version}`)
    const first = changelog.split('\n').find((l) => l.startsWith('- '))!.slice(2)
    expect(shown).toContain(first.split(':')[0])
    expect(DASHES.some((d) => shown.includes(d))).toBe(false)
    const visible = shown.replace(/<[^>]+>/g, ' ')
    expect(visible).not.toMatch(/\b(BB|BBs|None|nan|NaN)\b/)
  })
  it('the version is written in version.ts only', () => {
    const src = join(WEB, 'src')
    const bad = walk(['.ts', '.js'], src).filter((p) => !p.endsWith(join('engine', 'version.ts'))
      && !rel(p).startsWith('web/src/content/') && readFileSync(p, 'utf-8').includes(`'${appVersion}'`)).map(rel)
    expect(bad).toEqual([])
  })
})

describe('the page loads nothing from other sites', () => {
  const page = join(WEB, 'page')
  it("every stylesheet's url() is a file of the page", () => {
    const bad: string[] = []
    for (const css of ['ceica.css', 'shiny/bootstrap.min.css', 'shiny/font.css', 'shiny/fill.css']) {
      const path = join(page, css)
      for (const m of readFileSync(path, 'utf-8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const u = m[1]
        // Bootstrap 3's glyphicons, which the page never had, aside
        if (u.startsWith('data:') || u.startsWith('#') || u.includes('glyphicons')) continue
        if (/^[a-z]+:|^\/\//i.test(u) || u.startsWith('/') || !existsSync(resolve(dirname(path), u.split(/[?#]/)[0]))) bad.push(`${css}: ${u}`)
      }
    }
    expect(bad).toEqual([])
    expect(readFileSync(join(page, 'ceica.css'), 'utf-8')).not.toContain('@import')
  })
  it('the fonts are WOFF2 files, with their licenses', () => {
    const fonts = walk(['.woff2'], page)
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(readFileSync(f).subarray(0, 4).toString('latin1'), rel(f)).toBe('wOF2')
    for (const f of readdirSync(join(page, 'fonts')).filter((n) => n.startsWith('OFL-'))) {
      expect(readFileSync(join(page, 'fonts', f), 'utf-8').toUpperCase()).toContain('OPEN FONT LICENSE')
    }
    const notices = readFileSync(join(page, 'licenses.txt'), 'utf-8')
    for (const family of ['Open Sans', 'Source Code Pro', 'Instrument Sans', 'Space Grotesk']) expect(notices).toContain(family)
  })
  it('THIRD_PARTY_NOTICES.md carries the notices the site serves (page/licenses.txt)', () => {
    const md = readFileSync(join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf-8')
    const fenced = /```text\n([\s\S]*?)```/.exec(md)?.[1]
    expect(fenced).toBe(readFileSync(join(page, 'licenses.txt'), 'utf-8'))
  })
})

// --- the public repository ------------------------------------------------------------------------

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf-8', maxBuffer: 1 << 28 })
  return r.status === 0 ? r.stdout : null
}

const inGit = git(['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'
const BINARY = new Set(['.png', '.ico', '.woff2', '.pdf'])
const ZIPPED = new Set(['.xlsx', '.docx', '.zip'])
const TEXT_MEMBER = /\.(xml|rels|vml|txt|csv|json|ceica|md|html|svg)$/i

/** The public files, and their text (a workbook or zip: its text members): the tracked ones, and the new
 * ones a commit would take (not ignored), so a file is checked before it is committed. */
function publicTexts(): [string, string][] {
  const tracked = (git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']) ?? '').split('\0').filter(Boolean)
  const out: [string, string][] = []
  for (const path of tracked) {
    if (LOCAL_ONLY.some((l) => path === l || path.startsWith(l))) continue
    const full = join(REPO, path)
    if (!existsSync(full)) continue  // deleted, not yet committed
    const ext = extname(path).toLowerCase()
    if (BINARY.has(ext)) continue
    if (ZIPPED.has(ext)) {
      let zip
      try {
        zip = readZip(new Uint8Array(readFileSync(full)))
      } catch {
        continue  // a test's broken file
      }
      for (const name of zip.names().filter((n) => TEXT_MEMBER.test(n))) {
        out.push([`${path}::${name}`, new TextDecoder().decode(zip.read(name))])
      }
    } else if (full !== SELF) {
      out.push([path, readFileSync(full, 'utf-8')])
    }
  }
  return out
}

describe.skipIf(!inGit)('the public repository (CONTRIBUTING.md rule 8)', () => {
  const texts = publicTexts()
  const AI = [tool, piece('anthro', 'pic'), piece('chat', 'gpt'), piece('open', 'ai'), piece('co', 'pilot'),
    piece('co', 'dex'), piece('gem', 'ini'), piece('co-author', 'ed-by'), piece('agents', '.md')]

  it('no file names an AI tool or vendor, or carries a co-author line', () => {
    const hits = texts.flatMap(([path, text]) => AI.filter((n) => text.toLowerCase().includes(n)).map((n) => `${path}: ${n}`))
    expect(hits).toEqual([])
  })
  it.runIf(RESTARTED)('no commit message names one, and the local files are not tracked', () => {
    const messages = (git(['log', '--format=%B%x00']) ?? '').split('\0')
    const hits = messages.flatMap((m) => AI.filter((n) => m.toLowerCase().includes(n)).map((n) => `${n}: ${m.trim().split('\n')[0]}`))
    expect(hits).toEqual([])
    const tracked = (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean)
    expect(tracked.filter((p) => LOCAL_ONLY.some((l) => p === l || p.startsWith(l)))).toEqual([])
  })
  it("no email address, and no path on a person's machine", () => {
    // bounded, so long runs of letters (the goldens' base64) are not tried again from every place
    const email = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/
    const machine = new RegExp(`${piece('C', ':')}[\\\\/]+${piece('Us', 'ers')}\\b|${piece('D', ':')}[\\\\/]+${piece('Co', 'de')}\\b`, 'i')
    const hits = texts.flatMap(([path, text]) => [text.includes('@') ? email.exec(text)?.[0] : undefined, machine.exec(text)?.[0]]
      .filter((x): x is string => x !== undefined).map((x) => `${path}: ${x}`))
    expect(hits).toEqual([])
  })
  it('IWR Planning Suite II is cited by its behavior only', () => {
    const needles = [new RegExp(piece('IWRPlan', '2013')), new RegExp(piece('\\.c', 's:\\d')), new RegExp(piece('decom', 'pil'), 'i'),
      new RegExp(piece('Reference', 'Only')),
      new RegExp(`\\b(${[piece('Create', 'CEICARows'), piece('Find', 'CostEffective'), piece('Find', 'BestBuy'),
        piece('Add', 'IncrementalCost'), piece('Calculate', 'IDC'), piece('GetPresent', 'ValueFactor'),
        piece('Calculate', 'InterpolationOutput')].join('|')})\\b`)]
    const hits = texts.flatMap(([path, text]) => needles.map((n) => n.exec(text)?.[0])
      .filter((x): x is string => x !== undefined).map((x) => `${path}: ${x}`))
    expect(hits).toEqual([])
  })
})
