// The pages against the Python's (views/<project>.json and others.json, make_views_fixtures.py):
// every Sites, Watershed, Inputs and Report page of each project and state, the module and
// document settings dialogs. A large page is compared by its digest.
import { describe, expect, it } from 'vitest'
import { analyze, type AnalysisResults } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { type Child, TagList } from '../src/shiny/htm'
import { inputsPage, moduleDialog } from '../src/views/inputsPage'
import { reportPage, settingsDialog } from '../src/views/reportPage'
import { sitesPage } from '../src/views/sites'
import { watershedPage } from '../src/views/watershed'
import { digest } from './helpers'
import { projectGoldens } from './projects'

const goldens = import.meta.glob<{ projects: Record<string, string>, cases: Case[] }>('./fixtures/views/*.json', { import: 'default', eager: true })
interface Case { view: string, args: Record<string, any>, html: string }

/** The day the goldens are made on (make_traces.TODAY). */
const TODAY = new Date(2026, 9, 18)
const inputs = new Map(projectGoldens().map((g) => [g.name, g.input]))
const results = new Map<string, AnalysisResults>()

function load(name: string, extra: Record<string, string>): AnalysisResults {
  let res = results.get(name)
  if (!res) {
    res = analyze(loads(extra[name] ?? inputs.get(name)!).project)
    results.set(name, res)
  }
  return res
}

const html = (tag: Child): string => new TagList(tag).render()

function render(c: Case, extra: Record<string, string>): string {
  const a = c.args
  const res = a.project === null ? null : load(a.project, extra)
  switch (c.view) {
    case 'sites': return html(sitesPage(res, a.site))
    case 'watershed': return html(watershedPage(res, a.view))
    case 'inputs': return html(inputsPage(res, a.section, a.opts))
    case 'module_dialog': {
      const d = moduleDialog(res!.project, a.module)
      return d === null ? 'None' : html(d)
    }
    case 'report': return html(reportPage(res, a.files))
    case 'settings_dialog': return html(settingsDialog(res!, TODAY))
    default: throw new Error(`no view ${c.view}`)
  }
}

for (const [path, golden] of Object.entries(goldens)) {
  if (path.endsWith('/shell.json')) continue
  describe(path.replace(/^.*\//, ''), () => {
    for (const [i, c] of golden.cases.entries()) {
      it(`${i} ${c.view} ${JSON.stringify(c.args)}`, () => {
        const got = render(c, golden.projects)
        if (c.html.startsWith('sha256:') && !got.startsWith('sha256:')) expect(digest(got)).toBe(c.html)
        else expect(got).toBe(c.html)
      })
    }
  })
}
