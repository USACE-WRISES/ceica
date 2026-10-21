// The py-shiny 1.6.3 controls CEICA's pages and dialogs use, as py-shiny renders them (before
// shiny.js binds them), and ui.modal's markup (modal.ts shows it). Adapted from STAF's static app
// (src/shared/shinyui.ts). shinyui_ref.json (parity/make_shinyui_fixtures.py) holds py-shiny's own
// renderings of each call CEICA makes; tests/shinyui.test.ts holds these to them.
//
// Numbers in attributes are written as Python's str() writes them: a float's text is passed as text
// ("3.0"), an int as a number.
import { type Child, h, HTML, type Tag, tag, TagList } from './htm.ts'

type Num = number | string | null | undefined

function numText(v: Num): string | null {
  if (v === null || v === undefined) return null
  return typeof v === 'string' ? v : String(v)
}

/** htmltools.css(width=...) */
function widthCss(width: string | null | undefined): string | null {
  return width ? `width:${width};` : null
}

/** shiny_input_label */
function inputLabel(id: string, label: Child): Tag {
  const empty = label === null || label === undefined || label === false || label === ''
  return h.label(label, { class: 'control-label' + (empty ? ' shiny-label-null' : ''), id: `${id}-label`, for: id })
}

/** ui.output_ui */
export function outputUi(id: string, { inline = false } = {}): Tag {
  return tag(inline ? 'span' : 'div', { class: 'shiny-html-output', id })
}

/** ui.download_link, as py-shiny renders it: disabled until the server gives its address (bind() in
 * client.ts enables it, as shiny.js does when that address arrives). */
export function downloadLink(id: string, label: Child, attrs: Record<string, string | null> = {}): Tag {
  return h.a(label, { class: 'shiny-download-link disabled', style: null, id, href: '', target: '_blank', download: true,
    'aria-disabled': 'true', tabindex: '-1' }, attrs)
}

/** ui.input_file (one file, no button label: CEICA's are hidden and opened from the page) */
export function inputFile(id: string, label: Child, { accept = [] as string[] } = {}): Tag {
  return h.div(
    inputLabel(id, label),
    h.div(
      h.label(h.span('Browse...', h.input({ id, name: id, type: 'file', accept: accept.length ? accept.join(',') : null,
        style: 'position: absolute !important; top: -99999px !important; left: -99999px !important;', class: 'shiny-input-file' }),
      { class: 'btn btn-default btn-file' }), { class: 'input-group-btn input-group-prepend' }),
      h.input({ type: 'text', class: 'form-control', placeholder: 'No file selected', readonly: 'readonly' }),
      { class: 'input-group' }),
    h.div(h.div({ class: 'progress-bar' }), { id: `${id}_progress`, class: 'progress active shiny-file-input-progress' }),
    { class: 'form-group shiny-input-container' })
}

/** ui.input_text */
export function inputText(id: string, label: Child, value = '', { placeholder = null as string | null,
  width = null as string | null } = {}): Tag {
  return h.div(
    inputLabel(id, label),
    h.input({ id, type: 'text', class: 'shiny-input-text form-control', value, placeholder, autocomplete: 'off',
      'data-update-on': 'change' }),
    { class: 'form-group shiny-input-container', style: widthCss(width) })
}

/** ui.input_numeric (value, min, max and step as their Python text: pass a float's as a string) */
export function inputNumeric(id: string, label: Child, value: Num, { min = null as Num, max = null as Num,
  step = null as Num, width = null as string | null } = {}): Tag {
  return h.div(
    inputLabel(id, label),
    h.input({ id, type: 'number', class: 'shiny-input-number form-control', value: numText(value), min: numText(min),
      max: numText(max), step: numText(step), 'data-update-on': 'change' }),
    { class: 'form-group shiny-input-container', style: widthCss(width) })
}

/** ui.input_radio_buttons: ``choices`` as [value, label] in order; the first is selected by default. */
export function inputRadioButtons(id: string, label: Child, choices: [string, Child][], { selected = null as string | null,
  width = null as string | null } = {}): Tag {
  const sel = selected ?? (choices.length ? choices[0][0] : null)
  const label_ = inputLabel(id, label)
  const options = h.div(choices.map(([value, text]) => h.div(
    h.label(h.input({ type: 'radio', name: id, value, checked: value === sel ? 'checked' : null }), ' ', h.span(text)),
    { class: 'radio' })), { class: 'shiny-options-group' })
  return h.div(label_, options, { id, style: widthCss(width), class: 'form-group shiny-input-radiogroup shiny-input-container',
    role: 'radiogroup', 'aria-labelledby': `${id}-label` })
}

/** ui.layout_columns(*items, col_widths=(6, 6)): bslib's grid element, as py-shiny renders it (bslib's
 * script fills in its classes on the page: bind() in client.ts). */
/** ui.input_select(id, label, choices, selected=, width=): py-shiny 1.6's plain select (not selectize);
 * the first choice is selected when none is given. */
export function inputSelect(id: string, label: Child, choices: readonly (readonly [string, Child])[], { selected = null as string | null,
  width = null as string | null } = {}): Tag {
  const sel = selected ?? (choices.length ? choices[0][0] : null)
  return h.div(
    h.label(label, { class: 'control-label' + (label ? '' : ' shiny-label-null'), id: `${id}-label`, for: id }),
    h.div(h.select(...choices.map(([k, v]) => h.option(v, { value: k, selected: k === sel ? '' : null })),
      { class: 'shiny-input-select form-select', id })),
    { class: 'form-group shiny-input-container', style: width ? `width:${width};` : null })
}

export function layoutColumns(items: Child[], { colWidths = [6, 6] } = {}): Tag {
  return tag('bslib-layout-columns',
    ...items.map((item) => h.div(item, { class: 'bslib-gap-spacing bslib-grid-item html-fill-container' })),
    { class: 'bslib-grid grid bslib-mb-spacing  html-fill-item', 'col-widths-sm': colWidths.join(','), style: '' })
}

/** ui.panel_conditional */
export function panelConditional(condition: string, ...children: Child[]): Tag {
  return h.div(...children, { class: 'shiny-panel-conditional', 'data-display-if': condition, 'data-ns-prefix': '' })
}

/** ui.input_action_button */
export function inputActionButton(id: string, label: Child, { cls = '' } = {}): Tag {
  return h.button(h.span(label, { class: 'action-label' }),
    { class: `btn btn-default action-button${cls ? ' ' + cls : ''}`, id, type: 'button', _add_ws: true })
}

/** ui.modal_button */
export function modalButton(label: Child): Tag {
  return h.button(label, { class: 'btn btn-default', type: 'button', 'data-dismiss': 'modal', 'data-bs-dismiss': 'modal' })
}

const SIZE: Record<string, string> = { s: ' modal-sm', l: ' modal-lg', xl: ' modal-xl' }
/** py-shiny's show script, kept in the markup as Shiny has it (inserted as HTML, it never runs:
 * modal.ts shows the dialog) */
const SHOW_JS = String.raw`if (window.bootstrap && !window.bootstrap.Modal.VERSION.match(/^4\. /)) {
  var modal=new bootstrap.Modal(document.getElementById('shiny-modal'))
  modal.show()
} else {
  $('#shiny-modal').modal().focus()
}`

/** ui.modal(*body, title=, footer=, size=, easy_close=): ``footer`` undefined is py-shiny's default (a
 * Dismiss button), null none. */
export function modal(body: Child[], { title = null as Child, footer = undefined as Child | undefined, size = 'm',
  easyClose = false } = {}): Tag {
  const titleDiv = title ? h.div(h.h4(title, { class: 'modal-title' }), { class: 'modal-header' }) : null
  const foot = footer === undefined ? modalButton('Dismiss') : footer
  const dialog = h.div(
    h.div(titleDiv, h.div({ class: 'modal-body' }, ...body), foot === null ? null : h.div(foot, { class: 'modal-footer' }),
      { class: 'modal-content' }),
    { class: 'modal-dialog' + (SIZE[size] ?? '') })
  return h.div(dialog, h.script(new HTML(SHOW_JS)), {
    id: 'shiny-modal', class: 'modal fade', tabindex: '-1',
    'data-backdrop': easyClose ? null : 'static', 'data-bs-backdrop': easyClose ? null : 'static',
    'data-keyboard': easyClose ? null : 'false', 'data-bs-keyboard': easyClose ? null : 'false',
  })
}

export interface NavPanel { title: string, value: string, content: Child }

/** ui.navset_hidden(*nav_panels, id=, selected=): ``tabset`` is the id py-shiny draws at random. */
export function navsetHidden(id: string, panels: NavPanel[], { selected = null as string | null, tabset = '0' } = {}): TagList {
  const active = selected ?? (panels.length ? panels[0].value : null)
  const items = panels.map((p, i) => h.li(h.a(p.title, { 'data-bs-toggle': 'tab', 'data-toggle': 'tab', 'data-value': p.value,
    role: 'tab', class: 'nav-link' + (p.value === active ? ' active' : ''), href: `#tab-${tabset}-${i}` }), { class: 'nav-item' }))
  const ul = h.ul(...items, { class: 'nav nav-hidden shiny-tab-input', id, 'data-tabsetid': tabset })
  const content = h.div(...panels.map((p, i) => h.div(p.content, { class: 'tab-pane' + (p.value === active ? ' active' : ''),
    role: 'tabpanel', 'data-value': p.value, id: `tab-${tabset}-${i}` })), { class: 'tab-content', 'data-tabsetid': tabset })
  return new TagList(ul, content)
}
