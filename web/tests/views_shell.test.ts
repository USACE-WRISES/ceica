// The shell's views against the Python's (views/shell.json, make_views_fixtures.py): the page
// skeleton, the header, the stage strip, the sidebar tree, the history tools, the start page, the
// gallery, About, Help and What's new. A view over 10 KB is compared by its digest.
import { describe, expect, it } from 'vitest'
import { pageBody } from '../src/app/ui'
import { analyze, type AnalysisResults } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import { derive } from '../src/engine/runState'
import { type Child, TagList } from '../src/shiny/htm'
import * as examples from '../src/views/examples'
import {
  aboutHtml, headerUi, helpHtml, historyTools, panel, type Recent, stagebar, startPage, whatsNewHtml,
} from '../src/views/shell'
import shell from './fixtures/views/shell.json'
import { digest } from './helpers'
import { projectGoldens } from './projects'

const inputs = new Map(projectGoldens().map((g) => [g.name, g.input]))
const results = new Map<string, AnalysisResults>()
function load(name: string): AnalysisResults {
  let res = results.get(name)
  if (!res) {
    res = analyze(loads(inputs.get(name)!).project)
    results.set(name, res)
  }
  return res
}

/** What Shiny inserts for a view: htmltools' TagList rendering. */
const html = (tag: Child): string => new TagList(tag).render()

const TOOLS = [
  { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, saved: '' },
  { canUndo: true, canRedo: false, undoLabel: 'edit a value', redoLabel: null, saved: 'Autosaved in this browser 09:31' },
  { canUndo: true, canRedo: true, undoLabel: 'rename a site & "more"', redoLabel: 'paste 12 cells', saved: 'Downloaded 09:40' },
]

function render(view: string, a: Record<string, any> = {}): string {
  switch (view) {
    case 'skeleton': return pageBody().render(1).slice(2)
    case 'header': return html(headerUi())
    case 'about': return html(aboutHtml())
    case 'help': return html(helpHtml())
    case 'whats_new': return html(whatsNewHtml())
    case 'history_tools': return html(historyTools(TOOLS[a.tools]))
    case 'stagebar': {
      const res = a.project === null ? null : load(a.project)
      return html(stagebar(derive(res), a.page, res ? res.project : null, TOOLS[a.tools]))
    }
    case 'panel': {
      const res = a.project === null ? null : load(a.project)
      return html(panel(res, a.page, a.site, a.section, derive(res)))
    }
    case 'start': return html(startPage(shell.recents[a.recents] as Recent[], a.view, a.picked))
    case 'cards': return html(examples.cards(a.picked))
    case 'detail': return html(examples.detail(a.picked))
    default: throw new Error(`no view ${view}`)
  }
}

describe('the shell renders as views/shell.py does', () => {
  for (const [i, c] of (shell.cases as { view: string, args?: Record<string, unknown>, html: string }[]).entries()) {
    it(`${i} ${c.view} ${JSON.stringify(c.args ?? {})}`, () => {
      const got = render(c.view, c.args)
      // a view over 10 KB is kept as its digest
      if (c.html.startsWith('sha256:')) expect(digest(got)).toBe(c.html)
      else expect(got).toBe(c.html)
    })
  }
})
