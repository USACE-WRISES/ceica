// The page's frame: the header and the sidebar's frame (views/shell.py header_ui and panel_frame),
// which the page skeleton (src/app/ui.ts) holds. site.ts renders the skeleton when it builds the
// page, so this module and what it imports name their files in full (Vite's config loader).
import { APP_NAME, APP_SUBTITLE, APP_VERSION_LABEL } from '../engine/version.ts'
import { h, HTML, type Tag } from '../shiny/htm.ts'
import { downloadLink, outputUi } from '../shiny/shinyui.ts'
import { ev } from './ev.ts'

export const MARK = new HTML(
  '<svg class="ce-brand-mark" viewBox="0 0 32 32" aria-hidden="true">'
  + '<rect x="1" y="1" width="30" height="30" rx="8" fill="#41669f"/>'
  + '<polyline points="6,25 11,21 16,20 21,14 26,7" fill="none" stroke="#fff" stroke-width="2.4" '
  + 'stroke-linecap="round" stroke-linejoin="round"/>'
  + '<circle cx="16" cy="20" r="3.2" fill="none" stroke="#ff9500" stroke-width="2"/>'
  + '</svg>')

export function headerUi(): Tag {
  return h.header(
    h.div(
      h.span(MARK, APP_NAME, h.small(APP_SUBTITLE), { class: 'ce-brand' }),
      h.button(APP_VERSION_LABEL, { type: 'button', class: 'ce-version', title: "What's new" }, ev('whatsnew')),
      h.span({ class: 'ce-sep' }),
      outputUi('project_name', { inline: true }),
      { class: 'ce-header-left' }),
    h.nav(
      h.button('Projects', { type: 'button' }, ev('start')),
      downloadLink('save_project', 'Save', { title: 'Download the project file (.ceica)' }),
      h.span({ class: 'ce-sep', style: 'margin:0' }),
      h.button('Help', { type: 'button' }, ev('help')),
      h.button('About', { type: 'button' }, ev('about')),
      { class: 'ce-nav', 'aria-label': 'Project' }),
    { class: 'ce-header' })
}

/** The sidebar: the tree (`panel`) above a foot with Undo, Redo and the autosave note. */
export function panelFrame(): Tag {
  return h.aside(
    h.nav(outputUi('panel_body'), { class: 'ce-panel-body', 'aria-label': 'Workflow' }),
    h.div(outputUi('panel_foot'), { class: 'ce-panel-foot' }),
    { id: 'ce-panel', class: 'ce-panel' })
}
