// Stage 4, Report: figures, tables and documents to download (views/report_page.py).
//
// One scrolling page: what is left before the document can be final, the document itself (Word,
// PDF, web page), every figure (PNG, SVG) and every table (Excel, CSV), then the other files. The
// list comes from the exhibit catalog (src/engine/report/exhibits.ts), so the page, the document and
// the files always agree. Every link goes to one files route (in the Shiny app a session route; here
// the page answers its clicks, src/app/client.ts); the document settings live in a dialog with its
// own Save.
import type { AnalysisResults } from '../engine/analysis'
import { countText, longDate } from '../engine/fmt'
import { shortDigest } from '../engine/projectfile'
import { catalog, type Exhibit, exhibitLabel, GROUPS, groupTitle } from '../engine/report/exhibits'
import { finalReady, readiness, reportStatus } from '../engine/runState'
import { commaInt } from '../py/pynum'
import { h, type Tag } from '../shiny/htm'
import { inputActionButton, inputRadioButtons, inputText, modal, modalButton } from '../shiny/shinyui'
import { empty, ev, link, pageHead, sec } from './components'

/** urllib.parse.quote(text, safe=''): every byte but the unreserved ones percent-encoded. */
export function pyQuote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** A link to the files route: which file (``f``), which format, and the project's digest, so the
 * link changes whenever the project does (thumbnails then refresh). */
export function fileLink(base: string, digest: string, f: string, fmt: string, { view = false } = {}): string {
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}f=${pyQuote(f)}&fmt=${fmt}&v=${digest}` + (view ? '&view=1' : '')
}

type Href = (f: string, fmt: string, opts?: { view?: boolean }) => string

/** The open readiness items, each with Go, or one line once everything is checked. */
export function readinessNote(res: AnalysisResults): Tag {
  const open = readiness(res).filter(([ok]) => !ok).map(([, text, stage]) => [text, stage] as const)
  if (!open.length) {
    return h.div(h.span({ class: 'ce-check-ic ok', 'aria-hidden': 'true' }),
      h.span('Every readiness item is checked: the document can be final.'), { class: 'ce-ready is-ok', role: 'status' })
  }
  const head = `Draft: ${countText(open.length, 'thing')} to finish before the document can be final`
  return h.div(
    h.div(h.span({ class: 'ce-check-ic no', 'aria-hidden': 'true' }), h.strong(head), { class: 'ce-ready-head' }),
    h.ul(...open.map(([text, stage]) => h.li(h.span(text), ' ', h.button('Go', { type: 'button', class: 'ce-link' }, ev('nav', { page: stage }))))),
    { class: 'ce-ready is-open', role: 'status' })
}

function radio(name: string, fld: string, value: string, label: string, checked: boolean, { disabled = false } = {}): Tag {
  // the value attribute is what www/ceica.js sends on change
  return h.label(
    h.input({ type: 'radio', name, value, checked: checked || null, disabled: disabled || null }, ev('report_field', { field: fld, value })),
    ` ${label}`, { class: 'ce-radio' + (disabled ? ' is-disabled' : '') })
}

/** Draft or Final. Final is offered once every readiness item is checked; a stored Final whose
 * checklist reopened prints as a draft, and says so. */
export function statusControl(res: AnalysisResults): Tag {
  const r = res.project.report
  const ready = finalReady(res)
  const status = reportStatus(res)
  let note: Tag | null
  if (ready) note = null
  else if (r.status === 'FINAL') {
    note = h.div('Set to final: it prints as a draft until every readiness item is checked. ',
      link('Keep it a draft', 'report_field', { field: 'status', value: 'DRAFT' }), { class: 'ce-note' })
  } else note = h.div('Final is available once every readiness item is checked.', { class: 'ce-note' })
  return h.div(
    h.div(h.span('Status', { class: 'ce-doc-label' }),
      radio('rep-status', 'status', 'DRAFT', 'Draft', status === 'DRAFT'),
      radio('rep-status', 'status', 'FINAL', 'Final', status === 'FINAL', { disabled: !ready }),
      { class: 'ce-doc-radios', role: 'radiogroup', 'aria-label': 'Status' }),
    note, { class: 'ce-doc-status' })
}

export function documentBlock(res: AnalysisResults, exhibits: readonly Exhibit[], href: Href): Tag {
  const p = res.project
  const key = p.report.contents === 'SUMMARY'
  const shown = exhibits.filter((e) => e.key || !key)
  const nFig = shown.filter((e) => e.kind === 'figure').length
  const nTab = shown.length - nFig
  return h.div(
    h.div(
      h.div(key ? 'Key figures and tables' : 'Figures and tables', { class: 'ce-doc-title' }),
      h.div(`${p.report.title || p.name}. ${countText(nFig, 'figure')} and ${countText(nTab, 'table')}, numbered and captioned, with the study `
        + 'settings and the decision record.', { class: 'ce-note' }),
      { class: 'ce-doc-main' }),
    h.div(
      h.a('Word', { href: href('doc', 'docx'), download: '', class: 'btn btn-primary' }),
      h.a('PDF', { href: href('doc', 'pdf'), download: '', class: 'btn btn-outline-secondary' }),
      h.a('Web page', { href: href('doc', 'html', { view: true }), target: '_blank', rel: 'noopener', class: 'ce-doc-link' }),
      { class: 'ce-doc-actions' }),
    h.div(statusControl(res), link('Document settings', 'report_settings'), { class: 'ce-doc-foot' }),
    { class: 'ce-doc' })
}

function figureCard(e: Exhibit, href: Href): Tag {
  const full = href(e.id, 'svg', { view: true })
  const label = exhibitLabel(e)
  return h.div(
    h.a(h.img({ src: full, alt: `${label}: ${e.title}`, loading: 'lazy' }), { href: full, target: '_blank', rel: 'noopener', class: 'ce-xthumb' }),
    h.div(h.span(label, { class: 'ce-xnum' }), h.span(e.title, { class: 'ce-xtitle' }), { class: 'ce-xmeta' }),
    h.div(h.a('PNG', { href: href(e.id, 'png'), download: '', class: 'ce-dl', 'aria-label': `${label} as PNG` }),
      h.a('SVG', { href: href(e.id, 'svg'), download: '', class: 'ce-dl', 'aria-label': `${label} as SVG` }), { class: 'ce-xlinks' }),
    { class: 'ce-xcard', title: e.caption })
}

export function figuresBlock(res: AnalysisResults, exhibits: readonly Exhibit[], href: Href): Tag {
  const p = res.project
  const figs = exhibits.filter((e) => e.kind === 'figure')
  const parts: Tag[] = [h.div(sec('Figures'),
    figs.length ? h.a('All figures (.zip)', { href: href('figures', 'zip'), download: '', class: 'ce-dl-all' }) : null,
    { class: 'ce-sec-row' })]
  const ws = res.watershed
  if (ws.table === null && ws.reasons.length) parts.push(h.p(`${groupTitle('plans', p)}: ${ws.reasons.join(' ')}`, { class: 'ce-note' }))
  if (!figs.length) parts.push(h.p("No figures yet: they appear once a site's inputs are complete.", { class: 'ce-note' }))
  for (const g of GROUPS) {
    const items = figs.filter((e) => e.group === g)
    if (items.length) {
      parts.push(h.h3(groupTitle(g, p), { class: 'ce-xgroup' }))
      parts.push(h.div(...items.map((e) => figureCard(e, href)), { class: 'ce-xgrid' }))
    }
  }
  return h.div(...parts, { class: 'ce-xsection' })
}

export function tablesBlock(res: AnalysisResults, exhibits: readonly Exhibit[], href: Href): Tag {
  const p = res.project
  const rows: Tag[] = []
  for (const g of GROUPS) {
    const items = exhibits.filter((e) => e.kind === 'table' && e.group === g)
    if (!items.length) continue
    rows.push(h.tr(h.th(groupTitle(g, p), { colspan: '4', scope: 'colgroup' }), { class: 'ce-xgroup-row' }))
    for (const e of items) {
      const label = exhibitLabel(e)
      rows.push(h.tr(
        h.td(label, { class: 'ce-xnum' }),
        h.td(h.div(e.title, { class: 'ce-xtitle' }), h.div(e.caption, { class: 'ce-note' })),
        h.td(commaInt(e.n_rows ?? 0), { class: 'num' }),
        h.td(h.a('Excel', { href: href(e.id, 'xlsx'), download: '', class: 'ce-dl', 'aria-label': `${label} as Excel` }),
          h.a('CSV', { href: href(e.id, 'csv'), download: '', class: 'ce-dl', 'aria-label': `${label} as CSV` }), { class: 'ce-xlinks' })))
    }
  }
  const table = h.table(
    h.thead(h.tr(h.th('Table', { scope: 'col' }), h.th('Title', { scope: 'col' }), h.th('Rows', { scope: 'col', class: 'num' }),
      h.th('Download', { scope: 'col' }))),
    h.tbody(...rows), { class: 'ce-table ce-xtable' })
  return h.div(
    h.div(sec('Tables'), h.a('All tables (.xlsx)', { href: href('tables', 'xlsx'), download: '', class: 'ce-dl-all' }), { class: 'ce-sec-row' }),
    h.div(table, { class: 'ce-table-wrap' }), { class: 'ce-xsection' })
}

export function filesBlock(href: Href): Tag {
  const row = (name: string, note: string, f: string, fmt: string) => h.div(
    h.div(h.div(name, { class: 'ce-file-name' }), h.div(note, { class: 'ce-note' })),
    h.a('Download', { href: href(f, fmt), download: '', class: 'btn btn-outline-secondary btn-sm', 'aria-label': `Download ${name}` }),
    { class: 'ce-file' })
  return h.div(
    sec('Other files'),
    h.div(
      row('Excel calculator', 'Every input and result as live formulas, to check the analysis or try changes.', 'calculator', 'xlsx'),
      row('Project file (.ceica)', 'Open it in CEICA to continue or share the study.', 'project', 'ceica'),
      row('Everything (.zip)', 'The document, every figure and table, the calculator and the project file, in one folder.', 'everything', 'zip'),
      { class: 'ce-files' }),
    { class: 'ce-xsection' })
}

export function reportPage(res: AnalysisResults | null, filesUrl: string): Tag {
  const head = pageHead('Report', 'Figures, tables and documents for your study report.')
  if (res === null) return h.div(head, empty('No project open', 'Open a project or try the Utoy Creek example.'), { class: 'ce-page' })
  const exhibits = catalog(res)
  const digest = shortDigest(res.project)
  const href: Href = (f, fmt, { view = false } = {}) => fileLink(filesUrl, digest, f, fmt, { view })
  return h.div(head, readinessNote(res), sec('Document'),
    documentBlock(res, exhibits, href), figuresBlock(res, exhibits, href), tablesBlock(res, exhibits, href), filesBlock(href),
    { class: 'ce-page ce-report' })
}


/** Title, prepared by, date and contents, saved together (one undo step). ``today`` is the page's
 * date (the Python reads date.today()). */
export function settingsDialog(res: AnalysisResults, today: Date): Tag {
  const p = res.project
  const r = p.report
  return modal([
    inputText('rep_title', 'Title', r.title || p.name, { width: '100%' }),
    inputText('rep_by', 'Prepared by', r.prepared_by, { width: '100%', placeholder: 'A name or an office' }),
    inputText('rep_date', 'Date', r.date, { width: '100%', placeholder: `Blank prints the day of download (${longDate(today)})` }),
    h.div(inputRadioButtons('rep_contents', 'Contents', [['FULL', 'Every figure and table, with the methods'],
      ['SUMMARY', 'Key figures and tables: the plans, the recommendations and the decisions']], { selected: r.contents, width: '100%' }),
    { class: 'ce-choices' }),
  ], { title: 'Document settings', easyClose: true,
    footer: h.div(modalButton('Cancel'), inputActionButton('rep_save', 'Save', { cls: 'btn-primary' })) })
}
