// The shell: header, sidebar, stage strip, start page and the small dialogs (views/shell.py).
//
// The sidebar lists the stages with their children (Inputs sections, every site) and carries Undo,
// Redo and the autosave note at its foot. Narrow screens hide it and show the stage strip instead,
// which carries the same tools (www/ceica.css switches them at 900px).
import type { AnalysisResults } from '../engine/analysis'
import { alternativeOf, type Project, type Site } from '../engine/model'
import { INPUT_SECTIONS, type Stage, stageLabel, STAGES, type StageStatus } from '../engine/runState'
import { APP_NAME, APP_TAGLINE, APP_VERSION_LABEL, REPO_URL } from '../engine/version'
import { pyIsDigit, pySplitlines, pyStrip } from '../py/pystr'
import { type Attrs, type Child, h, HTML, type Tag, tag } from '../shiny/htm'
import { downloadLink } from '../shiny/shinyui'
import changelog from '../../../CHANGELOG.md?raw'
import { ev } from './components'
import * as examples from './examples'
import * as host from './host'

export { headerUi, MARK, panelFrame } from './frame'

export function stagebar(statuses: ReadonlyMap<Stage, StageStatus>, current: string, project: Project | null,
  { canUndo, canRedo, undoLabel, redoLabel, saved }: { canUndo: boolean, canRedo: boolean, undoLabel: string | null,
    redoLabel: string | null, saved: string }): Tag {
  const items: Tag[] = []
  for (const [k, key] of STAGES.entries()) {
    const st = statuses.get(key)
    const cls = ['ce-stage']
    if (st && st.status) cls.push(`st-${st.status}`)
    if (key === current) cls.push('active')
    const count = st && st.status === 'attention' && st.count ? h.span(String(st.count), { class: 'ce-count' }) : null
    items.push(h.button(h.span(String(k + 1), { class: 'ce-num' }), project ? stageLabel(key, project) : stageLabel(key), count,
      { type: 'button', class: cls.join(' '), 'aria-current': key === current ? 'step' : null, title: st && st.note ? st.note : null },
      ev('nav', { page: key })))
    if (k < STAGES.length - 1) items.push(h.span({ class: 'ce-stage-sep', 'aria-hidden': 'true' }))
  }
  const tools = historyTools({ canUndo, canRedo, undoLabel, redoLabel, saved })
  return h.div(h.nav(...items, { class: 'ce-stages', 'aria-label': 'Workflow' }), tools, { class: 'ce-stagebar' })
}

/** Undo, Redo and the autosave note: at the sidebar's foot, or in the strip on narrow screens. */
export function historyTools({ canUndo, canRedo, undoLabel, redoLabel, saved }: { canUndo: boolean, canRedo: boolean,
  undoLabel: string | null, redoLabel: string | null, saved: string }): Tag {
  return h.div(
    h.button('Undo', { type: 'button', class: 'ce-tool', disabled: !canUndo || null, title: undoLabel ? `Undo: ${undoLabel}` : 'Nothing to undo' },
      ev('undo')),
    h.button('Redo', { type: 'button', class: 'ce-tool', disabled: !canRedo || null, title: redoLabel ? `Redo: ${redoLabel}` : 'Nothing to redo' },
      ev('redo')),
    h.span(saved, { class: 'ce-saved', 'aria-live': 'polite' }),
    { class: 'ce-strip-tools' })
}

/** The sidebar's tree: each stage, with the Inputs sections and every site under them. The header
 * names the project, so the tree starts with the first stage. */
export function panel(res: AnalysisResults | null, page: string, site: string | null, section: string,
  statuses: ReadonlyMap<Stage, StageStatus>): Tag {
  if (res === null) return h.div()
  const p = res.project
  const rows: Tag[] = []
  for (const [k, key] of STAGES.entries()) {
    const st = statuses.get(key)
    const cls = ['ce-tree-row']
    if (st && st.status) cls.push(`st-${st.status}`)
    if (key === page) cls.push('is-current')
    const count = st && st.status === 'attention' && st.count ? h.span(String(st.count), { class: 'ce-count' }) : null
    rows.push(h.button(h.span(String(k + 1), { class: 'ce-num' }), h.span(stageLabel(key, p), { class: 'ce-tree-label' }), count,
      { type: 'button', class: cls.join(' '), 'aria-current': key === page ? 'step' : null, title: st && st.note ? st.note : null },
      ev('nav', { page: key })))
    const children: Tag[] = []
    if (key === 'inputs') {
      for (const [secKey, label] of INPUT_SECTIONS) {
        const cur = page === 'inputs' && section === secKey
        children.push(h.button(h.span(label, { class: 'ce-tree-label' }),
          { type: 'button', class: 'ce-tree-row is-child' + (cur ? ' is-current' : '') }, ev('nav', { page: 'inputs', section: secKey })))
      }
    } else if (key === 'sites') {
      for (const s of p.sites) {
        const dst = res.decisions.sites.get(s.id)
        let dot: string
        let meta: string
        if (!dst || dst.source === 'none') [dot, meta] = ['is-none', 'incomplete']
        else if (dst.stale) [dot, meta] = ['is-stale', 'review']
        else if (dst.source === 'team') [dot, meta] = ['is-team', short(dst.alt_id, s)]
        else [dot, meta] = ['is-suggested', 'suggested']
        const cur = page === 'sites' && site === s.id
        children.push(h.button(
          h.span({ class: `ce-tree-dot ${dot}`, 'aria-hidden': 'true' }),
          h.span(s.id, { class: 'ce-tree-label' }), h.span(meta, { class: 'ce-tree-meta' }),
          { type: 'button', class: 'ce-tree-row is-child' + (cur ? ' is-current' : '') }, ev('nav', { page: 'sites', site: s.id })))
      }
    }
    if (children.length) rows.push(h.div(...children, { class: 'ce-tree-children' }))
  }
  return h.div(...rows)
}

function short(altId: string | null, site: Site): string {
  if (!altId) return ''
  const a = alternativeOf(site, altId)
  if (a !== null && a.is_no_action) return 'No Action'
  const rest = pyStrip(altId.slice(11))
  if (altId.toLowerCase().startsWith('alternative') && pyIsDigit(rest)) return `Alt ${rest}`
  return altId
}

/** What's new: the newest four sections of the repo's CHANGELOG.md. */
export function whatsNewHtml(text: string = changelog): Tag {
  const items: { head: string, lis: Tag[] }[] = []
  let cur: { head: string, lis: Tag[] } | null = null
  for (const line of pySplitlines(text)) {
    if (line.startsWith('## ')) {
      cur = { head: pyStrip(line.slice(3)), lis: [] }
      items.push(cur)
    } else if (line.startsWith('- ') && cur !== null) {
      cur.lis.push(h.li(pyStrip(line.slice(2))))
    }
  }
  return h.div(...items.slice(0, 4).map((it) => h.div(h.h2(it.head), h.ul(...it.lis))), { class: 'ce-whatsnew' })
}

/** The start page's views: home (recent projects, what's new) and the example projects. */
export const START_VIEWS = ['home', 'examples'] as const

/** The Example projects tile's icon: four tiles, a gallery. */
export const EXAMPLES_ICON = new HTML(
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">'
  + '<rect x="1.5" y="1.5" width="5.6" height="5.6" rx="1.3"/>'
  + '<rect x="8.9" y="1.5" width="5.6" height="5.6" rx="1.3"/>'
  + '<rect x="1.5" y="8.9" width="5.6" height="5.6" rx="1.3"/>'
  + '<rect x="8.9" y="8.9" width="5.6" height="5.6" rx="1.3"/></svg>')

function tile(icon: Child, title: string, sub: string, { primary = false, active = null as boolean | null } = {}, attrs: Attrs = {}): Tag {
  const cls = 'ce-tile' + (primary ? ' is-primary' : '') + (active ? ' is-active' : '')
  return h.button(h.span(icon, { class: 'ce-tile-ic' }),
    h.span(h.span(title, { class: 'ce-tile-t' }), h.span(sub, { class: 'ce-tile-s' })),
    { type: 'button', class: cls, 'aria-pressed': active === null ? null : active ? 'true' : 'false' }, attrs)
}

/** Back to the home view, and the view's heading (Example projects). */
function viewHead(title: string): Tag {
  return h.div(h.button('‹ Back', { type: 'button', class: 'ce-link ce-start-back' }, ev('start_view', { view: 'home' })),
    h.h2(title, { class: 'ce-start-h' }), { class: 'ce-start-head' })
}

/** An autosave the Recent list names: its project id, name and when. */
export interface Recent {
  id?: string
  name?: string
  at?: string
}

function recentProjects(recents: readonly Recent[]): Tag {
  const rows = recents.slice(0, 6).map((r) => h.div(
    h.span(r.name || 'Untitled', { class: 'ce-recent-name' }),
    h.span(r.at ?? '', { class: 'ce-recent-when' }),
    h.span(h.button('Continue', { type: 'button', class: 'btn btn-sm btn-outline-secondary' }, ev('restore', { id: r.id ?? '' })),
      h.button('Forget', { type: 'button', class: 'ce-link', style: 'margin-left:8px' }, ev('forget', { id: r.id ?? '' }))),
    { class: 'ce-recent-row' }))
  return h.div(
    h.h2('Recent projects', { class: 'ce-start-h' }),
    rows.length ? h.div(...rows, { class: 'ce-recent' })
      : h.p('No recent projects yet. Start a new project, open a file, or explore an example project.', { class: 'ce-start-empty' }),
    h.p(host.START_NOTE, { class: 'ce-start-note' }),
    { class: 'ce-start-main' })
}

/** The start page, in one of START_VIEWS. The rail is the same in both: New project, Open a file and
 * Example projects, then the blank templates. Its size never changes (www/ceica.css). */
export function startPage(recents: readonly Recent[], view = 'home', picked: string | null = null): Tag {
  view = (START_VIEWS as readonly string[]).includes(view) ? view : 'home'
  const tiles = h.div(
    tile('+', 'New project', 'Start a study from scratch', { primary: true }, ev('new_project')),
    tile('↑', 'Open a file', 'A CEICA project (.ceica), calculator or template (.xlsx)', {},
      { onclick: "document.getElementById('open_file').click()" }),
    tile(EXAMPLES_ICON, 'Example projects', 'Open a finished study and explore it', { active: view === 'examples' },
      ev('start_view', { view: 'examples' })),
    { class: 'ce-tiles' })
  const rail = h.div(
    h.div(h.div(APP_NAME, { class: 'ce-start-mark' }), h.div(APP_TAGLINE + ' for ecosystem restoration planning', { class: 'ce-start-sub' }),
      h.span(APP_VERSION_LABEL, { class: 'ce-start-ver' })),
    tiles,
    h.div(h.strong('Blank Excel templates', { style: 'font-size:var(--fs-1)' }),
      downloadLink('dl_template_generic', 'Habitat units template'),
      downloadLink('dl_template_ixq', 'Index x quantity template'),
      downloadLink('dl_template_staf', 'STAF template'),
      { class: 'ce-start-links' }),
    { class: 'ce-start-rail' })
  let main: Tag
  let side: Tag
  if (view === 'examples') {
    main = h.div(viewHead('Example projects'), h.p('Finished studies to explore. Edits never change the original.', { class: 'ce-start-lead' }),
      examples.cards(picked), { class: 'ce-start-main' })
    side = h.div(examples.detail(picked), { class: 'ce-start-side' })
  } else {
    main = recentProjects(recents)
    side = h.div(h.h3("What's new"), whatsNewHtml(), { class: 'ce-start-side' })
  }
  return h.div(rail, main, side, { class: 'ce-start' })
}

export function aboutHtml(): Tag {
  return h.div(
    h.p(h.strong(`${APP_NAME} ${APP_VERSION_LABEL}`), `: ${APP_TAGLINE}.`),
    h.p('Cost-effectiveness and best buys follow the rules of IWR Planning Suite II, the certified USACE tool, including ties, '
      + 'duplicates and the No Action base. The Utoy Creek example reproduces the published analysis.'),
    h.p('CEICA is not a certified planning model. Keep the Excel calculator with the decision record; its IWR input sheet '
      + 'supports an independent re-run in IWR Planning Suite II.'),
    h.p(h.a('Source and issues', { href: REPO_URL, target: '_blank', rel: 'noopener' })))
}

export function helpHtml(): Tag {
  return h.div(
    h.h3('The four stages', { style: 'font-size:var(--fs-3)' }),
    tag('ol',
      h.li(h.strong('Inputs. '), 'Study settings, sites and alternatives, benefits at target years and costs. Under Study, How '
        + "benefits are measured lists the modules that add up to each alternative's benefit (for example, riparian and "
        + 'instream); their values are entered under Benefits. Everything recomputes as you type.'),
      h.li(h.strong('Sites. '), 'A plan is cost-effective when no other gives the same output for less, or more output for no '
        + 'more. Best buys have the lowest incremental cost per unit. Confirm the alternative each site carries forward.'),
      h.li(h.strong('Watershed. '), 'Every combination of the carried actions. Choose the final array (the best buys by '
        + 'default), say whether each step is worth it, and pick the tentatively selected plan.'),
      h.li(h.strong('Report. '), 'Download each figure (PNG, SVG) or table (Excel, CSV), the figures-and-tables document (Word, '
        + 'PDF) or everything in one .zip, with the Excel calculator. Document settings holds the document\'s title, Prepared '
        + 'by and date. The document stays a draft until every readiness item is checked.')),
    h.h3('Keys', { style: 'font-size:var(--fs-3)' }),
    h.p('Ctrl+Z undo, Ctrl+Y redo (outside text fields). Hover a plan to highlight it in the charts and tables; click a mark '
      + 'to pin the highlight; Esc clears it.'),
    h.h3('Saving your work', { style: 'font-size:var(--fs-3)' }),
    h.p(`${host.KEEPING_NOTE} ${host.PRIVACY_NOTE}`))
}

