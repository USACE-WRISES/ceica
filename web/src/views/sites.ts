// Stage 2, Sites: site-by-site CE/ICA and the alternative each site carries forward
// (views/sites.py).
import { type AltRow, type AnalysisResults, siteBestBuys, siteRow } from '../engine/analysis'
import { lineKey } from '../engine/annualize'
import { REASON_MORE_OUTPUT_NO_MORE_COST, REASON_SAME_OUTPUT_LOWER_COST } from '../engine/cea'
import { leftOutOfTimeSeries, siteCeIca, siteCostStack, siteTimeSeries } from '../engine/figures'
import { money, num } from '../engine/fmt'
import { byYear, siteOf } from '../engine/model'
import { pySum } from '../py/pynum'
import { h, type Tag } from '../shiny/htm'
import { badge, empty, ev, figure, figurePair, link, pageHead, rowsFor, sec } from './components'
import { stafPanel } from './stafPanel'

const altLabel = (row: AltRow): string => (row.is_no_action ? 'No Action' : (row.name || row.alt_id))

export function decisionChip(res: AnalysisResults, siteId: string): Tag {
  const st = res.decisions.sites.get(siteId)
  const sr = res.sites.get(siteId)!
  if (!st || !sr.ready) return h.span('Inputs incomplete', { class: 'ce-chip is-none' })
  const row = st.alt_id ? siteRow(sr, st.alt_id) : null
  const name = row ? altLabel(row) : (st.alt_id || 'n/a')
  if (st.stale) {
    return h.span(
      h.span(`Needs review: ${name} was recommended before the results changed`),
      h.button('Keep recommendation', { type: 'button', class: 'btn btn-sm btn-outline-secondary' }, ev('keep_rec', { site: siteId })),
      { class: 'ce-chip is-stale' })
  }
  if (st.source === 'team') {
    if (row !== null && row.is_no_action) return h.span('No Action recommended: the site is not carried forward', { class: 'ce-chip is-team' })
    return h.span(`Recommended: ${name}`, { class: 'ce-chip is-team' })
  }
  const sugg = st.suggested ? siteRow(sr, st.suggested) : null
  const why = sugg && !sugg.is_no_action ? 'the largest best buy' : 'no best buy beyond No Action'
  return h.span(h.span(`Suggested: ${name}, ${why}`),
    h.button('Confirm', { type: 'button', class: 'btn btn-sm btn-primary' }, ev('recommend', { site: siteId, alt: st.alt_id || '' })),
    { class: 'ce-chip is-suggested' })
}

export function summarySentence(res: AnalysisResults, siteId: string): string {
  const sr = res.sites.get(siteId)!
  const unit = res.project.labels.annual_output_short
  const n = sr.rows.length
  const nCe = sr.rows.filter((r) => r.ce).length
  const bbs = siteBestBuys(sr).filter((r) => !r.is_no_action)
  const ceTxt = nCe === n ? 'all cost-effective' : `${nCe} cost-effective`
  if (!bbs.length) return `${n} alternatives, ${ceTxt}. No best buy beyond No Action.`
  const parts = bbs.map((r) => `${altLabel(r)} (${money(r.inc_cost_per_unit)} per ${unit})`).join(', ')
  return `${n} alternatives, ${ceTxt}. Best buys after No Action: ${parts}.`
}

function whyNot(row: AltRow, res: AnalysisResults, siteId: string): string | null {
  if (row.ce || row.beaten_by === null) return null
  const other = siteRow(res.sites.get(siteId)!, row.beaten_by)
  const who = other ? altLabel(other) : row.beaten_by
  if (row.beaten_reason === REASON_SAME_OUTPUT_LOWER_COST) return `${who} gives the same output for less`
  if (row.beaten_reason === REASON_MORE_OUTPUT_NO_MORE_COST) return `${who} gives more output for no more cost`
  return null
}

export function alternativesTable(res: AnalysisResults, siteId: string): Tag {
  const sr = res.sites.get(siteId)!
  const unit = res.project.labels.annual_output_short
  const st = res.decisions.sites.get(siteId)
  const chosen = st ? st.alt_id : null
  const multi = res.project.watershed.mode === 'MULTI'
  const carried = new Set(res.watershed.carried.get(siteId) ?? [])
  const head = h.tr(
    h.th('Recommend', { class: 'ctr' }),
    multi ? h.th('Carry', { class: 'ctr', title: 'Carry to the watershed plans' }) : null,
    h.th('Alternative'),
    h.th(`Lift (${unit})`, { class: 'num' }), h.th('Average annual cost', { class: 'num' }),
    h.th(`Unit cost ($/${unit})`, { class: 'num' }), h.th(`Incremental cost per ${unit}`, { class: 'num' }),
    h.th('Construction cost', { class: 'num' }))
  const rows = sr.rows.map((r) => {
    const badges: Tag[] = []
    if (r.bb) badges.push(badge('Best buy', 'bb'))
    else if (r.ce) badges.push(badge('Cost-effective', 'ce'))
    const why = whyNot(r, res, siteId)
    const radio = h.input({ type: 'radio', name: `rec-${siteId}`, value: r.alt_id, checked: chosen === r.alt_id || null,
      'aria-label': `Recommend ${altLabel(r)}` }, ev('recommend', { site: siteId, alt: r.alt_id }))
    const carry = multi ? h.td(r.is_no_action ? null : h.input({ type: 'checkbox', checked: carried.has(r.alt_id) || null,
      'aria-label': `Carry ${altLabel(r)} to the watershed plans` }, ev('carry', { site: siteId, alt: r.alt_id })), { class: 'ctr' }) : null
    return h.tr(
      h.td(radio, { class: 'ctr' }),
      carry,
      h.td(h.span(altLabel(r), { class: 'ce-alt-name' }), ...badges,
        r.description && !r.is_no_action ? h.div(r.description, { class: 'ce-alt-desc' }) : null,
        why ? h.div(`Not cost-effective: ${why}.`, { class: 'ce-alt-desc' }) : null),
      h.td(num(r.lift, 2), { class: 'num' }),
      h.td(money(r.cost), { class: 'num' }),
      h.td(r.unit_cost !== null ? money(r.unit_cost) : 'n/a', { class: 'num' }),
      h.td(r.inc_cost_per_unit !== null ? money(r.inc_cost_per_unit) : '', { class: 'num' }),
      h.td(money(r.construction), { class: 'num' }),
      { 'data-key': r.alt_id, class: [chosen === r.alt_id ? 'is-rec' : '', !r.ce ? 'is-dim' : ''].filter((c) => c).join(' ') || null })
  })
  let caption = `Alternatives at site ${siteId}. Costs are average annual costs above No Action.`
  if (multi) caption += ' Carry marks the alternatives the watershed plans may include.'
  return h.div(h.table(h.caption(caption), h.thead(head), h.tbody(...rows), { class: 'ce-table' }), { class: 'ce-table-wrap' })
}

export function notesBlock(res: AnalysisResults, siteId: string): Tag {
  const p = res.project
  const site = siteOf(p, siteId)!
  const dec = p.decisions.sites.get(siteId)
  const notes = dec ? dec.alt_notes : new Map<string, string>()
  const items: Tag[] = []
  for (const a of site.alternatives) {
    const tid = `note-${siteId}-${a.id}`
    items.push(h.label(a.is_no_action ? 'No Action' : (a.name || a.id), { for: tid }))
    items.push(h.textarea(notes.get(a.id) ?? '', { id: tid, rows: String(rowsFor(notes.get(a.id) ?? '')),
      placeholder: 'Why this alternative is or is not recommended' }, ev('alt_note', { site: siteId, alt: a.id })))
  }
  const rid = `rationale-${siteId}`
  items.push(h.label('Recommendation', { for: rid }))
  items.push(h.textarea(dec ? dec.rationale : '', { id: rid, rows: String(Math.max(2, rowsFor(dec ? dec.rationale : ''))),
    placeholder: 'The decision logic for this site, for the report' }, ev('site_rationale', { site: siteId })))
  return h.div(...items, { class: 'ce-notes' })
}

export function detailsBlock(res: AnalysisResults, siteId: string): Tag {
  const p = res.project
  const site = siteOf(p, siteId)!
  const unit = p.labels.annual_output_short
  const parts: Tag[] = []
  if (p.benefits.modules.some(byYear)) {
    const left = leftOutOfTimeSeries(p)
    parts.push(figure(siteTimeSeries(res, siteId), { figId: `ts-${siteId}`, heading: `${p.labels.output_name} over time`,
      caption: left.length ? `Without ${left.join(', ')}, entered as an average.` : null }))
  }
  parts.push(figure(siteCostStack(res, siteId), { figId: `cost-${siteId}`, heading: 'Average annual cost by part' }))
  const comps = p.benefits.modules.length > 1 ? p.benefits.modules : []
  const head = [h.th('Alternative'), ...comps.map((c) => h.th(`${c.name} (${unit})`, { class: 'num' })),
    h.th(`Total (${unit})`, { class: 'num' }), h.th(`Lift (${unit})`, { class: 'num' }), h.th('First costs', { class: 'num' }),
    h.th('Interest during construction', { class: 'num' }), h.th('OMRRR present value', { class: 'num' }),
    h.th('Average annual cost', { class: 'num' })]
  const rows = site.alternatives.map((a) => {
    const b = res.benefits.get(lineKey(siteId, a.id))!
    const c = res.costs.get(lineKey(siteId, a.id))!
    return h.tr(h.td(a.is_no_action ? 'No Action' : (a.name || a.id)),
      ...comps.map((cc) => h.td(num(b.aahu_by_module.get(cc.id) ?? null, 2), { class: 'num' })),
      h.td(num(b.aahu, 2), { class: 'num' }), h.td(num(b.lift, 2), { class: 'num' }),
      h.td(money(pySum(c.first_costs.values())), { class: 'num' }), h.td(money(c.idc), { class: 'num' }),
      h.td(money(pySum(c.recurring_pv.values())), { class: 'num' }), h.td(money(c.annual), { class: 'num' }),
      { 'data-key': a.id })
  })
  const table = h.div(h.table(h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-table' }), { class: 'ce-table-wrap' })
  return h.details(h.summary('Benefit and cost details'),
    h.div(h.div(...parts, { class: 'ce-fig-pair' }), h.div({ style: 'height:12px' }), table, { class: 'ce-details-body' }),
    { class: 'ce-details' })
}

export function siteNav(res: AnalysisResults, siteId: string): Tag {
  const sites = res.project.sites
  const ids = sites.map((s) => s.id)
  const i = ids.includes(siteId) ? ids.indexOf(siteId) : 0
  const prevId = i > 0 ? ids[i - 1] : null
  const nextId = i < ids.length - 1 ? ids[i + 1] : null
  const options = sites.map((s) => h.option(s.name && s.name !== s.id ? `${s.id}  ${s.name}` : s.id,
    { value: s.id, selected: s.id === siteId || null }))
  return h.div(
    h.button('Previous', { type: 'button', class: 'ce-tool', disabled: prevId === null || null }, ev('site', { site: prevId || '' })),
    h.select(...options, { class: 'form-select form-select-sm ce-site-select', id: 'site-select', 'aria-label': 'Site' }, ev('site_select')),
    h.button('Next', { type: 'button', class: 'ce-tool', disabled: nextId === null || null }, ev('site', { site: nextId || '' })),
    h.span(`${i + 1} of ${ids.length}`, { class: 'ce-note' }),
    { class: 'ce-site-nav' })
}

export function sitesPage(res: AnalysisResults | null, siteId: string | null): Tag {
  if (res === null) return empty('No project open', 'Open a project or try the Utoy Creek example.')
  const p = res.project
  if (!p.sites.length) return empty('No sites yet', 'Add sites and alternatives on the Inputs stage.', link('Go to Inputs', 'nav', { page: 'inputs' }))
  if (siteId === null || !p.sites.some((s) => s.id === siteId)) siteId = p.sites[0].id
  const site = siteOf(p, siteId)!
  const sr = res.sites.get(siteId)!
  const head = pageHead('Site-by-site analysis',
    'Choose the alternative each site carries to the watershed plans. The app suggests the largest best buy; the team decides.',
    siteNav(res, siteId))
  const extra = site.name && site.name !== site.id ? `  ${site.name}` : ''
  const card = h.div(
    h.div(h.h2(`${site.id}`, h.span(extra, { class: 'ce-muted', style: 'font-weight:500' }), { style: 'font-size:var(--fs-4);margin:0 0 4px' }),
      site.description ? h.div(site.description, { class: 'ce-page-sub' }) : null,
      { style: 'flex:1 1 auto;min-width:0' }),
    h.div(decisionChip(res, siteId), { class: 'ce-sitebar-chip' }),
    { class: 'ce-card ce-sitebar', style: 'margin-bottom:14px' })
  if (!sr.ready) {
    return h.div(head, card, h.div(
      h.div('This site cannot be analyzed yet.', { class: 'ce-issues-h' }),
      h.ul(...sr.reasons.slice(0, 10).map((r) => h.li(r))),
      link('Go to Inputs', 'nav', { page: 'inputs' }), { class: 'ce-issues is-error' }),
    { class: 'ce-page' })
  }
  const [ce, ica] = siteCeIca(res, siteId)
  return h.div(
    head, card,
    h.div(
      figurePair(ce, ica, { baseId: `site-${siteId}` }),
      h.p(summarySentence(res, siteId), { class: 'ce-lead', style: 'margin-top:12px' }),
      alternativesTable(res, siteId),
      { 'data-link': 'site' }),
    sec('Decision notes'),
    notesBlock(res, siteId),
    stafPanel(res, siteId),
    detailsBlock(res, siteId),
    { class: 'ce-page' })
}
