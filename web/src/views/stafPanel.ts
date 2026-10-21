// STAF modules, Sites page: the functions and outcomes behind each alternative's lift
// (views/staf_panel.py).
//
// A collapsed panel under the site's CE/ICA table for each STAF module: the Ecosystem Condition Index
// over time on the STAF bands, lift split by outcome, and each function's contribution to the lift.
// The ECI is linear in the function scores for a fixed assessed set, so the contributions add up to
// the module's lift exactly.
import type { AnalysisResults } from '../engine/analysis'
import { stafRollups } from '../engine/benefits'
import * as staf from '../engine/benefits/staf'
import { siteStaf } from '../engine/figures'
import { num } from '../engine/fmt'
import { type Alternative, alternativeOf, isStaf, type Module, noAction, notAssessed, type Project, siteOf, valuesFor } from '../engine/model'
import { type FunctionLift, siteFunctionLift } from '../engine/stafLift'
import { pyFixed, pyG } from '../py/pyfmt'
import { h, type Tag, TagList } from '../shiny/htm'
import { figurePair } from './components'

const altLabel = (a: Alternative): string => (a.is_no_action ? 'No Action' : (a.name || a.id))

function stafModule(p: Project, moduleId: string | null): Module {
  const mods = p.benefits.modules.filter((m) => m.method === 'STAF')
  return mods.find((m) => m.id === moduleId) ?? mods[0]
}

/** Existing condition and where the alternative carried forward takes it. */
export function headline(res: AnalysisResults, siteId: string, moduleId: string | null = null): string {
  const p = res.project
  const mid = stafModule(p, moduleId).id
  const site = siteOf(p, siteId)!
  const last = p.benefits.target_years[p.benefits.target_years.length - 1]
  const na = noAction(site)!
  const nowRolls = stafRollups(p, site, na, mid)
  const now = nowRolls[0].eci
  const parts = now !== null ? [`Existing condition: ECI ${pyFixed(now, 2)} (${staf.band(now)}).`] : []
  const st = res.decisions.sites.get(siteId)
  const alt = st && st.alt_id ? alternativeOf(site, st.alt_id) : null
  if (alt !== null && !alt.is_no_action) {
    const rolls = stafRollups(p, site, alt, mid)
    const end = rolls[rolls.length - 1].eci
    if (end !== null) {
      const which = st!.source === 'team' ? 'recommended' : 'suggested'
      parts.push(`The ${which} alternative, ${altLabel(alt)}, reaches ECI ${pyFixed(end, 2)} (${staf.band(end)}) by year ${pyG(last)}.`)
    }
  }
  const fwop = nowRolls[nowRolls.length - 1].eci
  if (fwop !== null) parts.push(`No Action ends at ${pyFixed(fwop, 2)}.`)
  return parts.join(' ')
}

export function functionTable(res: AnalysisResults, siteId: string, moduleId: string | null = null): Tag {
  const p = res.project
  const mod = stafModule(p, moduleId)
  const site = siteOf(p, siteId)!
  const unit = p.labels.annual_output_short
  const alts = site.alternatives.filter((a) => !a.is_no_action)
  const lifts = new Map<string, FunctionLift | null>(alts.map((a) => [a.id, siteFunctionLift(res, siteId, a.id, mod.id)]))
  const base = valuesFor(noAction(site)!, mod.id)
  const now = new Map<string, number | null>()
  if (base) for (const [f, vals] of base.scores) now.set(f, vals.length ? vals[0] : null)
  const off = new Set(notAssessed(site, mod.id))
  const head = h.tr(h.th('Function'), h.th('Existing score', { class: 'num' }), ...alts.map((a) => h.th(`${altLabel(a)} (${unit})`, { class: 'num' })))
  const rows: Tag[] = []
  let cat: string | null = null
  for (const f of staf.functions()) {
    if (f.category !== cat) {
      cat = f.category
      rows.push(h.tr(h.td(cat, { colspan: String(2 + alts.length) }), { class: 'is-group' }))
    }
    if (off.has(f.id)) {
      rows.push(h.tr(h.td(f.name), h.td('Not assessed', { colspan: String(1 + alts.length), class: 'ce-muted' }), { class: 'is-dim' }))
      continue
    }
    const cells: Tag[] = [h.td(f.name, { title: f.short_description }), h.td(num(now.get(f.id) ?? null, 1), { class: 'num' })]
    for (const a of alts) {
      const fl = lifts.get(a.id)
      const v = fl ? fl.functions.get(f.id) ?? null : null
      cells.push(h.td(v !== null ? num(v, 1) : '', { class: 'num' + (v !== null && Math.abs(v) < 0.05 ? ' ce-muted' : '') }))
    }
    rows.push(h.tr(...cells))
  }
  for (const o of staf.OUTCOMES) {
    rows.push(h.tr(h.td(`Through the ${staf.OUTCOME_LABELS[o].toLowerCase()} outcome`), h.td(''),
      ...alts.map((a) => h.td(lifts.get(a.id) ? num(lifts.get(a.id)!.outcomes[o], 1) : '', { class: 'num' })), { class: 'is-sum' }))
  }
  rows.push(h.tr(h.td('Lift'), h.td(''), ...alts.map((a) => h.td(lifts.get(a.id) ? num(lifts.get(a.id)!.total, 1) : '', { class: 'num' })),
    { class: 'is-total' }))
  const several = p.benefits.modules.filter((m) => m.method === 'STAF').length > 1
  return h.div(h.table(
    h.caption(`Contribution of each function to the lift at site ${siteId}` + (several ? `, ${mod.name}` : '')
      + ` (${unit}). Contributions add up to the lift.`),
    h.thead(head), h.tbody(...rows), { class: 'ce-table ce-staf-table' }), { class: 'ce-table-wrap' })
}

/** One "Functions and outcomes" panel per STAF module (the module named when there are several). */
export function stafPanel(res: AnalysisResults, siteId: string): TagList | null {
  const p = res.project
  const sr = res.sites.get(siteId)
  if (!isStaf(p.benefits) || !sr || !sr.ready) return null
  const mods = p.benefits.modules
  const variant = p.benefits.staf_mapping
  const panels = mods.map((m, i) => {
    const [eci, out] = siteStaf(res, siteId, m.id)
    const key = mods.length === 1 ? siteId : `${siteId}-${i + 1}`
    return h.details(
      h.summary('Functions and outcomes' + (mods.length > 1 ? `: ${m.name}` : '')),
      h.div(
        h.p(headline(res, siteId, m.id), { class: 'ce-lead', style: 'margin:4px 0 12px' }),
        figurePair(eci, out, { baseId: `staf-${key}`, headings: ['(A) Ecosystem Condition Index', '(B) Lift by outcome'] }),
        h.div({ style: 'height:12px' }),
        functionTable(res, siteId, m.id),
        h.p(`Outcome mapping: ${staf.MAPPING_LABELS[variant]}. The ECI is not a certified or approved USACE planning model; STAF `
          + 'guidance treats it as a supplement to habitat units from approved models.', { class: 'ce-note' }),
        { class: 'ce-details-body' }),
      { class: 'ce-details', id: `staf-panel-${key}` })
  })
  return new TagList(...panels)
}
