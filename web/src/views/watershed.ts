// Stage 3, Watershed: combinations of the site actions, the final array and the TSP
// (views/watershed.py).
import { type AnalysisResults, planRow, planRows, wsBb, wsCe, wsIndexOfKey, wsPlans } from '../engine/analysis'
import * as staf from '../engine/benefits/staf'
import { stepKey } from '../engine/decisions'
import { densityNote, watershedCeIca } from '../engine/figures'
import { countText, money, num, sig3Money } from '../engine/fmt'
import { alternativeOf, isStaf, parseCompositionKey, siteOf } from '../engine/model'
import { IWR_PLAN_LIMIT, isBinary, planCount, tableKey } from '../engine/plans'
import { oneSite } from '../engine/runState'
import { planFunctionLift } from '../engine/stafLift'
import { commaInt } from '../py/pynum'
import { pyIsDigit, pyStrip } from '../py/pystr'
import { h, type Tag } from '../shiny/htm'
import { badge, empty, ev, figurePair, link, pageHead, rowsFor, sec, seg } from './components'

export const ALL_ROWS_LIMIT = 400

function altShort(altId: string): string {
  const rest = pyStrip(altId.slice(11))
  if (altId.toLowerCase().startsWith('alternative') && pyIsDigit(rest)) return `Alt ${rest}`
  return altId
}

export function carriedLine(res: AnalysisResults): Tag {
  const ws = res.watershed
  const chips: Tag[] = []
  for (const [sid, alts] of ws.carried) {
    const src = ws.sources.get(sid)
    const txt = `${sid} ` + alts.map(altShort).join(', ')
    chips.push(h.span(txt, src === 'suggested' ? badge('suggested', 'warn') : null,
      { class: 'ce-badge', style: 'font-size:var(--fs-1);padding:3px 9px;margin:0 6px 6px 0;font-weight:500' }))
  }
  const extra: Tag[] = []
  if (ws.not_carried.length) {
    extra.push(h.span('Not carried (No Action): ' + ws.not_carried.join(', '), { class: 'ce-note', style: 'margin-right:12px' }))
  }
  if (ws.blocked.length) {
    extra.push(h.span('Left out until inputs are complete: ' + ws.blocked.join(', '),
      { class: 'ce-note', style: 'color:var(--ce-err);margin-right:12px' }))
  }
  extra.push(link('Change on Sites', 'nav', { page: 'sites' }))
  return h.div(h.div(...chips), h.div(...extra), { style: 'margin:4px 0 10px' })
}

export function summarySentence(res: AnalysisResults): string {
  const ws = res.watershed
  const nSites = ws.carried.size
  if (ws.table === null) return ws.reasons.join(' ')
  let base = `${countText(nSites, 'site')} carried forward make ${countText(ws.table.n_valid, 'plan')}; `
    + `${commaInt(wsCe(ws))} are cost-effective and ${commaInt(wsBb(ws))} are best buys.`
  if (ws.table.ce_only) base += ' Only plans that can be cost-effective are listed.'
  return base
}

export function formationBlock(res: AnalysisResults): Tag {
  const p = res.project
  const ws = res.watershed
  const mode = p.watershed.mode
  const rules = p.watershed.rules
  const siteIds = p.sites.filter((s) => s.alternatives.length > 1).map((s) => s.id)
  const ruleRows = rules.map((r, k) => {
    const verb = r.kind === 'NOT_COMBINABLE' ? 'is not combinable with' : 'depends on'
    return h.li(`${r.site_id} ${verb} ${r.with_sites.join(' and ')}`,
      h.button('Remove', { type: 'button', class: 'ce-link', style: 'margin-left:10px' }, ev('rule_remove', { index: k })))
  })
  const opts = () => siteIds.map((s) => h.option(s, { value: s }))
  const add = h.div(
    h.select(...opts(), { id: 'rule-a', class: 'form-select form-select-sm', style: 'width:auto;display:inline-block', 'aria-label': 'Site' }),
    h.select(h.option('depends on', { value: 'DEPENDS_ON' }), h.option('is not combinable with', { value: 'NOT_COMBINABLE' }),
      { id: 'rule-kind', class: 'form-select form-select-sm', style: 'width:auto;display:inline-block;margin:0 6px', 'aria-label': 'Rule' }),
    h.select(...opts(), { id: 'rule-b', class: 'form-select form-select-sm', style: 'width:auto;display:inline-block', 'aria-label': 'Other site' }),
    h.button('Add rule', { type: 'button', class: 'btn btn-sm btn-outline-secondary', style: 'margin-left:8px',
      onclick: "var a=document.getElementById('rule-a').value,k=document.getElementById('rule-kind').value,"
        + "b=document.getElementById('rule-b').value;Shiny.setInputValue('ce_event',{type:'rule_add',site:a,kind:k,other:b,"
        + "n:Date.now()+Math.random()},{priority:'event'});" }),
    { style: 'margin-top:8px' })
  let count: Tag | null = null
  if (ws.space !== null && ws.space.site_ids.length) {
    try {
      const n = planCount(ws.space)
      count = h.p(`${commaInt(n)} plans with these settings`
        + (n > BigInt(IWR_PLAN_LIMIT) ? ` (more than IWR Planning Suite II's ${commaInt(IWR_PLAN_LIMIT)})` : '') + '.', { class: 'ce-note' })
    } catch {
      count = null
    }
  }
  return h.details(
    h.summary('Plan formation'),
    h.div(
      h.p('Each plan takes zero or one carried alternative at each site. Effects add up across sites.', { class: 'ce-note' }),
      seg([['RECOMMENDED', 'One alternative per site'], ['MULTI', 'Several alternatives per site']], mode, 'ws_mode'),
      h.p(mode === 'MULTI' ? "With several per site, tick 'Carry' for the alternatives on the Sites stage." : '',
        { class: 'ce-note', style: 'margin-top:6px' }),
      h.div(h.strong('Rules between sites', { style: 'font-size:var(--fs-2)' }),
        ruleRows.length ? h.ul(...ruleRows) : h.p('No rules.', { class: 'ce-note' }),
        add, { style: 'margin-top:10px' }),
      count, { class: 'ce-details-body' }),
    { class: 'ce-details', style: 'margin:0 0 14px' })
}

export function outcomesTable(res: AnalysisResults, view: string): Tag {
  const ws = res.watershed
  const p = res.project
  const unit = p.labels.annual_output_short
  const d = res.decisions
  const final = new Set(d.final_keys)
  const tsp = d.tsp_state === 'ok' ? d.tsp_key : null
  const sites = ws.space!.site_ids
  const multi = !isBinary(ws.space!)
  const counts: Record<string, number> = { bb: wsBb(ws), ce: wsCe(ws), all: wsPlans(ws) }
  const total = counts[view] ?? wsPlans(ws)
  // only the rows shown are built: every plan can mean millions of rows
  const which = (view === 'bb' || view === 'ce' || view === 'all' ? view : 'bb') as 'bb' | 'ce' | 'all'
  const shown = planRows(ws, which, view === 'all' ? ALL_ROWS_LIMIT : null)
  const head = [h.th('Final', { class: 'ctr' }), h.th('Plan'), ...sites.map((s) => h.th(s, { class: 'ctr' })),
    h.th(`Lift (${unit})`, { class: 'num' }), h.th('Average annual cost', { class: 'num' }), h.th('Construction cost', { class: 'num' }),
    h.th(`Unit cost ($/${unit})`, { class: 'num' }), h.th(`Incremental cost per ${unit}`, { class: 'num' })]
  const body = shown.map((r) => {
    const cells: Tag[] = [
      h.td(h.input({ type: 'checkbox', checked: final.has(r.key) || null, 'aria-label': `${r.plan_id} in the final array` },
        ev('final', { key: r.key })), { class: 'ctr' }),
      h.td(h.strong(r.plan_id), r.key === tsp ? badge('TSP', 'tsp') : null,
        r.bb ? badge('Best buy', 'bb') : r.ce ? badge('Cost-effective', 'ce') : null, { class: 'plan' })]
    for (const s of sites) {
      const a = r.composition.get(s)
      if (a === undefined) cells.push(h.td(h.span('0', { class: 'visually-hidden' }), { class: 'ctr' }))
      else if (multi) cells.push(h.td(altShort(a), { class: 'ctr' }))
      else cells.push(h.td(h.span({ class: 'ce-dot', 'aria-hidden': 'true' }), h.span('1', { class: 'visually-hidden' }), { class: 'ctr' }))
    }
    cells.push(h.td(num(r.output, 2), { class: 'num' }), h.td(money(r.cost), { class: 'num' }),
      h.td(money(r.construction), { class: 'num' }), h.td(r.unit_cost ? money(r.unit_cost) : 'n/a', { class: 'num' }),
      h.td(r.inc_cost_per_unit !== null ? money(r.inc_cost_per_unit) : '', { class: 'num' }))
    return h.tr(...cells, { 'data-key': r.plan_id, class: !r.ce ? 'is-dim' : null })
  })
  const note = shown.length < total ? `Showing ${commaInt(shown.length)} of ${commaInt(total)} plans in order of output.`
    : `${commaInt(total)} plans in order of output.`
  const toolbar = h.div(seg([['bb', `Best buys (${counts.bb})`], ['ce', `Cost-effective (${counts.ce})`],
    ['all', `All plans (${commaInt(counts.all)})`]], view, 'plans_view'),
  h.span(note, { class: 'ce-note' }), { class: 'ce-toolbar' })
  const caption = !multi ? 'Summary of watershed-scale CE/ICA outcomes. For each site, a dot marks the site included in the plan.'
    : 'Summary of watershed-scale CE/ICA outcomes. Each site column names the alternative included, blank when the site is not in the plan.'
  return h.div(toolbar, h.div(h.table(h.caption(caption), h.thead(h.tr(...head)), h.tbody(...body), { class: 'ce-table' }),
    { class: 'ce-table-wrap', style: 'max-height:480px' }))
}

function planWords(res: AnalysisResults, key: string): string {
  const comp = parseCompositionKey(key)
  if (!comp.size) return 'No Action'
  const multi = !isBinary(res.watershed.space!)
  const order = res.watershed.space!.site_ids
  const items = [...comp].map((kv, i) => ({ kv, i, k: order.includes(kv[0]) ? order.indexOf(kv[0]) : 99 }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i)).map((e) => e.kv)
  return items.map(([s, a]) => (multi ? `${s} (${altShort(a)})` : s)).join(' + ')
}

export function ladderBlock(res: AnalysisResults): Tag {
  const d = res.decisions
  const ws = res.watershed
  const unit = res.project.labels.annual_output_short
  const tsp = d.tsp_state === 'ok' ? d.tsp_key : null
  if (!d.final_keys.length) return h.p('Tick plans in the table to build the final array.', { class: 'ce-note' })
  const steps = new Map(d.ladder.map((s) => [s.to_key, s]))
  const rows = d.final_keys.map((key, i) => {
    const idx = wsIndexOfKey(ws, key)
    const pid = idx !== null ? ws.ceica!.points.ids[idx] : '?'
    const st = steps.get(key)
    let stepCell: Tag
    let worthCell: Tag
    let whyCell: Tag
    if (st === undefined) {
      stepCell = h.td(h.span('Start', { class: 'ce-step-what' }), h.div('No Action', { class: 'ce-step-delta' }))
      worthCell = h.td()
      whyCell = h.td()
    } else {
      const what: string[] = []
      if (st.adds.length) what.push('adds ' + st.adds.join(', '))
      if (st.drops.length) what.push('drops ' + st.drops.join(', '))
      const per = st.per_unit !== null ? money(st.per_unit) : 'n/a'
      stepCell = h.td(
        h.span(what.join('; ') || 'changes alternatives', { class: 'ce-step-what' }),
        h.div(`${st.d_output >= 0 ? '+' : ''}${num(st.d_output, 1)} ${unit}, ${st.d_cost >= 0 ? '+' : '-'}${money(Math.abs(st.d_cost))} per year, `
          + `${per} per ${unit}`, { class: 'ce-step-delta' }))
      const w = st.note ? st.note.worth_it : 'UNDECIDED'
      const name = `worth-${i}`
      const key2 = stepKey(st)
      worthCell = h.td(h.span(
        h.label(h.input({ type: 'radio', name, value: 'YES', checked: w === 'YES' || null }, ev('worth', { step: key2, value: 'YES' })), 'Yes'),
        h.label(h.input({ type: 'radio', name, value: 'NO', checked: w === 'NO' || null }, ev('worth', { step: key2, value: 'NO' })), 'No'),
        { class: 'ce-yesno' }))
      const whyText = st.note ? st.note.why : ''
      whyCell = h.td(h.textarea(whyText, { id: `why-${i}`, rows: String(rowsFor(whyText, 48)), class: 'ce-textarea',
        placeholder: 'Why the added output is or is not worth the added cost' }, ev('why', { step: key2 })), { style: 'min-width:260px' })
    }
    return h.tr(
      h.td(h.strong(pid), h.div(planWords(res, key), { class: 'ce-alt-desc' })),
      stepCell, worthCell, whyCell,
      h.td(h.input({ type: 'radio', name: 'tsp', value: key, checked: key === tsp || null, 'aria-label': `${pid} is the tentatively selected plan` },
        ev('tsp', { key })), { class: 'ctr' }),
      { 'data-key': pid, class: key === tsp ? 'is-rec' : null })
  })
  const table = h.table(
    h.caption('Final array of watershed-scale plans, in order of output. Each step: is the added output worth the added cost?'),
    h.thead(h.tr(h.th('Plan'), h.th('Step from the previous plan'), h.th('Worth it?'), h.th('Why'), h.th('TSP', { class: 'ctr' }))),
    h.tbody(...rows), { class: 'ce-table' })
  return h.div(table, { class: 'ce-table-wrap' })
}

export function excludedBlock(res: AnalysisResults): Tag | null {
  const d = res.decisions
  const ws = res.watershed
  const bbKeys: string[] = []
  for (let i = 0; i < ws.ceica!.bb.length; i++) if (ws.ceica!.bb[i]) bbKeys.push(tableKey(ws.table!, i))
  const finals = new Set(d.final_keys)
  const leftOut = bbKeys.filter((k) => !finals.has(k))
  const added = [...d.added]
  if (!leftOut.length && !added.length) return null
  const notes = res.project.decisions.watershed.final_array
  const items: Tag[] = []
  for (const k of [...leftOut, ...added]) {
    const idx = wsIndexOfKey(ws, k)
    const pid = idx !== null ? ws.ceica!.points.ids[idx] : '?'
    const kind = leftOut.includes(k) ? 'left out' : 'added'
    const tid = `final-note-${pid}`
    items.push(h.label(`${pid} (${kind})`, { for: tid }))
    const text = notes.has(k) ? notes.get(k)!.note : ''
    items.push(h.textarea(text, { id: tid, rows: String(rowsFor(text)),
      placeholder: kind === 'left out' ? 'Why this best buy is not in the final array' : 'Why this plan is added to the final array' },
    ev('final_note', { key: k })))
  }
  return h.div(sec('Changes to the final array'), h.div(...items, { class: 'ce-notes' }))
}

/** STAF projects: the plan's lift through each outcome. */
function outcomeFacts(res: AnalysisResults, comp: ReadonlyMap<string, string>, unit: string): Tag | null {
  if (!isStaf(res.project.benefits)) return null
  const fl = planFunctionLift(res, comp)
  if (fl === null) return null
  return h.div(
    ...staf.OUTCOMES.map((o) => h.div(h.div(h.i({ class: 'ce-sw fill', style: `color:${staf.OUTCOME_COLORS[o]}` }), ` ${num(fl.outcomes[o], 1)} ${unit}`,
      { class: 'ce-fact-v' }), h.div(`${staf.OUTCOME_LABELS[o]} outcome`, { class: 'ce-fact-k' }), { class: 'ce-fact' })),
    { class: 'ce-tsp-facts', 'aria-label': 'Lift by outcome' })
}

export function tspCard(res: AnalysisResults): Tag {
  const d = res.decisions
  const ws = res.watershed
  const p = res.project
  const unit = p.labels.annual_output_short
  const wd = p.decisions.watershed
  if (d.tsp_state !== 'ok') {
    const msg = ({ none: 'Choose the tentatively selected plan in the final array above.',
      missing: 'The plan chosen before no longer exists with the current site recommendations. Choose the TSP again.',
      not_in_final: 'The TSP must be in the final array.' } as Record<string, string>)[d.tsp_state]
    return h.div(msg, { class: 'ce-issues' + (d.tsp_state !== 'none' ? ' is-error' : '') })
  }
  const row = planRow(ws, wsIndexOfKey(ws, d.tsp_key!)!)
  const comp = row.composition
  const acts: Tag[] = []
  for (const sid of ws.space!.site_ids) {
    if (comp.has(sid)) {
      const site = siteOf(p, sid)
      const alt = site ? alternativeOf(site, comp.get(sid)!) : null
      acts.push(h.li(h.strong(sid), `: ${alt ? alt.name : comp.get(sid)}`,
        h.span(alt && alt.description ? `  ${alt.description}` : '', { class: 'ce-muted' })))
    }
  }
  const review = d.watershed_stale ? h.div(h.span(
    h.span(`Needs review: ${row.plan_id} was chosen before the results changed`),
    h.button('Keep this plan', { type: 'button', class: 'btn btn-sm btn-outline-secondary' }, ev('keep_tsp')),
    { class: 'ce-chip is-stale' }), { class: 'ce-tsp-review' }) : null
  return h.div(
    h.div(h.span(`Tentatively selected plan: ${row.plan_id}`, { class: 'ce-tsp-name' }), h.span(row.label, { class: 'ce-muted' }),
      { class: 'ce-tsp-head' }),
    review,
    h.div(
      h.div(h.div(`${num(row.output, 1)} ${unit}`, { class: 'ce-fact-v' }), h.div('Lift', { class: 'ce-fact-k' }), { class: 'ce-fact' }),
      h.div(h.div(sig3Money(row.cost), { class: 'ce-fact-v' }), h.div('Average annual cost', { class: 'ce-fact-k' }), { class: 'ce-fact' }),
      h.div(h.div(row.unit_cost ? money(row.unit_cost) : 'n/a', { class: 'ce-fact-v' }), h.div(`Per ${unit}`, { class: 'ce-fact-k' }), { class: 'ce-fact' }),
      h.div(h.div(sig3Money(row.construction), { class: 'ce-fact-v' }), h.div('Construction cost', { class: 'ce-fact-k' }), { class: 'ce-fact' }),
      { class: 'ce-tsp-facts' }),
    outcomeFacts(res, comp, unit),
    h.div(
      h.label('Plan type', { for: 'tsp-type', class: 'form-label' }),
      h.input({ type: 'text', id: 'tsp-type', class: 'ce-input', value: wd.tsp_plan_type }, ev('tsp_type')),
      { style: 'max-width:420px;margin-bottom:10px' }),
    h.label('Rationale', { for: 'tsp-rationale', class: 'form-label' }),
    h.textarea(wd.tsp_rationale, { id: 'tsp-rationale', rows: String(Math.max(3, rowsFor(wd.tsp_rationale))), class: 'ce-textarea',
      placeholder: 'Why this plan is the tentatively selected plan' }, ev('tsp_rationale')),
    h.details(h.summary(`Actions included (${acts.length})`), h.div(h.ul(...acts), { class: 'ce-details-body' }), { class: 'ce-details' }),
    { class: 'ce-tsp' })
}

export function watershedPage(res: AnalysisResults | null, view = 'bb'): Tag {
  if (res === null) return empty('No project open', 'Open a project or try the Utoy Creek example.')
  const p = res.project
  const title = oneSite(p) ? 'Plans' : 'Watershed-scale analysis'
  const head = pageHead(title, 'Every combination of the site actions carried forward, the best buys, the final array and the tentatively selected plan.')
  const ws = res.watershed
  if (ws.table === null) {
    return h.div(head, h.div(ws.reasons.join(' '), { class: 'ce-issues' }), link('Go to Sites', 'nav', { page: 'sites' }), { class: 'ce-page' })
  }
  const figs = watershedCeIca(res)!
  return h.div(
    head,
    h.p(summarySentence(res), { class: 'ce-lead' }),
    carriedLine(res),
    formationBlock(res),
    h.div(
      figurePair(figs[0], figs[1], { baseId: 'ws', headings: ['(A) Cost-effectiveness', '(B) Incremental cost'] }),
      h.p([`Cost-effectiveness (A) and incremental cost (B) of the ${oneSite(p) ? 'plans' : 'watershed plans'}.`, densityNote(figs[0])]
        .filter((x) => x).join(' '), { class: 'ce-note', style: 'margin:6px 2px 0' }),
      sec('Plans'),
      outcomesTable(res, view),
      sec('Final array'),
      ladderBlock(res),
      { 'data-link': 'ws' }),
    excludedBlock(res),
    sec('Tentatively selected plan'),
    tspCard(res),
    { class: 'ce-page' })
}
