// Stage 1, Inputs: study settings, sites and alternatives, benefits, costs and the check
// (views/inputs_page.py).
//
// How benefits are measured (the modules) is set up in Study; the Benefits section is only for
// entering each module's values.
import type { AnalysisResults } from '../engine/analysis'
import * as staf from '../engine/benefits/staf'
import { money, num } from '../engine/fmt'
import {
  alternativeOf, isStaf, type Labels, lowerFirst, moduleOf, type Module, type Project, siteOf, STAF_LABELS,
} from '../engine/model'
import { INPUT_SECTIONS } from '../engine/runState'
import { pyG } from '../py/pyfmt'
import { type Attrs, type Child, h, type Tag } from '../shiny/htm'
import { inputActionButton, inputRadioButtons, inputText, modal, modalButton, panelConditional } from '../shiny/shinyui'
import { empty, ev, issuesBox, pageHead, seg } from './components'
import { allowedMethods, METHODS } from './edits'
import {
  averageNote, benefitsGrid, costsGrid, type GridOpts, hasOutput, pickModule, recurringGrid, sitesGrid, stafGrid, TOTALS, totalsGrid,
} from './grids'

/** Methods that enter a quantity (and so have quantity units). */
export const QUANTITY_METHODS = ['INDEX_X_QUANTITY', 'STAF'] as const

const sameLabels = (a: Labels, b: Labels): boolean => a.output_name === b.output_name && a.output_short === b.output_short
  && a.annual_output_name === b.annual_output_name && a.annual_output_short === b.annual_output_short && a.lift_name === b.lift_name

/** The study's name for habitat units, even while a lone STAF module has the STAF labels. */
function hu(labels: Labels): string {
  return sameLabels(labels, STAF_LABELS) ? 'Habitat units' : labels.output_name
}

/** How a module's values are entered, as the modules table says it. */
export function methodName(method: string, labels: Labels): string {
  return ({ HU: `${hu(labels)} at each target year`, INDEX_X_QUANTITY: 'Index (0 to 1) x quantity', STAF: 'STAF function scores',
    AAHU: 'Average annual value' } as Record<string, string>)[method]
}

/** A method as a choice in the module and New project dialogs: its name and one plain line. */
export function methodChoice(method: string, labels: Labels): Tag {
  const u = hu(labels)
  const [title, line] = ({
    HU: [u, `Enter ${u.toLowerCase()} at each target year.`],
    INDEX_X_QUANTITY: ['Index x quantity', `Enter an index (0 to 1) and a quantity, such as acres, at each target year. ${u} are the index times the quantity.`],
    AAHU: ['Average annual value', `Enter the average annual ${u.toLowerCase()}, worked out elsewhere.`],
    STAF: ['STAF function scores', 'Score 20 stream functions (0 to 15) and a length at each target year. Condition units are the ECI times the length.'],
  } as Record<string, [string, string]>)[method]
  return h.span(h.span(title, { class: 'ce-choice-t' }), h.span(line, { class: 'ce-choice-s' }))
}

export function sectionTabs(section: string): Tag {
  return h.nav(...INPUT_SECTIONS.map(([key, label]) => h.button(label, { type: 'button', class: key === section ? 'is-on' : '',
    'aria-current': key === section ? 'page' : null }, ev('nav', { page: 'inputs', section: key }))),
  { class: 'ce-sections', 'aria-label': 'Inputs sections' })
}

function field(label: string, control: Tag, note: string | null = null, wide = false): Tag {
  const id = control.attrs.find(([k]) => k === 'id')?.[1]
  return h.div(h.label(label, { for: typeof id === 'string' ? id : null }), control, note ? h.div(note, { class: 'ce-note' }) : null,
    { class: 'ce-field' + (wide ? ' wide' : '') })
}

/** How benefits are measured: every module with Edit and (when there are several) Remove, and Add
 * module. Values are entered under Benefits. */
export function modulesBlock(p: Project): Tag {
  const mods = p.benefits.modules
  const rows = mods.map((m) => {
    const nid = `mod-name-${m.id}`
    const acts: Tag[] = [h.button('Edit', { type: 'button', class: 'ce-link', id: `mod-edit-${m.id}`, 'aria-describedby': nid },
      ev('module_edit', { module: m.id }))]
    if (mods.length > 1) {
      // no aria-label: the two-click confirm swaps the text, which must stay readable
      acts.push(h.button('Remove', { type: 'button', class: 'ce-link is-danger', 'aria-describedby': nid,
        'data-confirm': 'Remove it and its values?' }, ev('module_remove', { module: m.id })))
    }
    const units = (QUANTITY_METHODS as readonly string[]).includes(m.method) && m.quantity_units ? m.quantity_units : 'n/a'
    return h.tr(h.td(m.name, { id: nid, class: 'ce-mod-name' }), h.td(methodName(m.method, p.labels)),
      h.td(units, { class: units !== 'n/a' ? null : 'ce-muted' }), h.td(...acts, { class: 'ce-acts' }))
  })
  const table = h.table(
    h.thead(h.tr(h.th('Module'), h.th('Values entered as'), h.th('Quantity units'), h.th(h.span('Actions', { class: 'visually-hidden' })))),
    h.tbody(...rows), { class: 'ce-table ce-modules' })
  return h.div(
    h.div(h.h2('How benefits are measured', { class: 'ce-sec', id: 'study-modules', tabindex: '-1' }),
      h.button('Add module', { type: 'button', class: 'btn btn-sm btn-outline-secondary', title: 'Add a part of the benefit with its own values' },
        ev('module_add')),
      { class: 'ce-sec-row' }),
    h.div(table, { class: 'ce-table-wrap ce-modules-wrap' }),
    h.p(`An alternative's benefit is the sum of its modules, each in ${lowerFirst(p.labels.output_name)}. Enter their values under Benefits.`,
      { class: 'ce-note ce-modules-note' }))
}

/** The Add module dialog, or Edit for ``moduleId`` (null when that module no longer exists). Only the
 * methods that keep the study valid are offered. A new module starts with the last module's method
 * and units, the likeliest next one (Utoy: index x quantity in acres). */
export function moduleDialog(p: Project, moduleId: string | null = null): Tag | null {
  const m = moduleId ? moduleOf(p.benefits, moduleId) : null
  if (moduleId && m === null) return null
  const allowed = allowedMethods(p, m ? m.id : null)
  let method: string
  let units: string
  if (m !== null) [method, units] = [m.method, m.quantity_units]
  else {
    const last = p.benefits.modules[p.benefits.modules.length - 1]
    ;[method, units] = allowed.includes(last.method) ? [last.method, last.quantity_units] : [allowed[0], '']
  }
  const shown = '[' + QUANTITY_METHODS.map((k) => `'${k}'`).join(', ') + '].indexOf(input.mod_method) >= 0'
  return modal([
    inputText('mod_name', 'Name', m ? m.name : '', { placeholder: 'For example, Riparian, left bank', width: '100%' }),
    h.div(inputRadioButtons('mod_method', 'How values are entered', allowed.map((k) => [k, methodChoice(k, p.labels)]),
      { selected: method, width: '100%' }), { class: 'ce-choices' }),
    panelConditional(shown, inputText('mod_units', 'Quantity units', units, { placeholder: 'For example, acres, ft or mi' })),
    m !== null ? panelConditional(`input.mod_method !== '${m.method}'`,
      h.div("Changing how values are entered clears this module's values in every alternative. Undo brings them back.",
        { class: 'ce-issues', style: 'margin-bottom:10px' })) : null,
    allowed.length < METHODS.length ? h.p('STAF stays on its own: a study uses only STAF modules, or none.', { class: 'ce-note' }) : null,
  ], { title: m ? `Edit ${m.name}` : 'Add a module', easyClose: true,
    footer: h.div(modalButton('Cancel'), inputActionButton('mod_save', m ? 'Save' : 'Add module', { cls: 'btn-primary' }),
      { class: 'ce-modal-foot' }) })
}

export function studySection(res: AnalysisResults): Tag {
  const p = res.project
  const st = p.settings
  const lab = p.labels
  const text = (fid: string, fld: string, value: string, kw: Attrs = {}) =>
    h.input({ type: 'text', id: fid, class: 'ce-input', value }, ev('study', { field: fld }), kw)
  const sel = (fid: string, fld: string, value: string, options: readonly (readonly [string, string])[]) =>
    h.select(...options.map(([val, lbl]) => h.option(lbl, { value: val, selected: val === value || null })),
      { id: fid, class: 'form-select form-select-sm' }, ev('study', { field: fld }))
  const staffy = isStaf(p.benefits)
  return h.div(
    h.div(
      field('Study name', text('st-name', 'name', p.name), null, true),
      field('Description', h.textarea(p.description, { id: 'st-desc', rows: '3', class: 'ce-textarea' }, ev('study', { field: 'description' })),
        'Optional. Printed at the top of the document on the Report page.', true),
      { class: 'ce-form' }),
    h.h2('Economics', { class: 'ce-sec' }),
    h.div(
      field('Discount rate (percent)', text('st-rate', 'discount_rate', pyG(st.discount_rate * 100))),
      field('Period of analysis (years)', text('st-poa', 'period_of_analysis', String(st.period_of_analysis))),
      field('Price level', text('st-price', 'price_level', st.price_level, { placeholder: 'For example, FY2025' })),
      { class: 'ce-form cols-3' }),
    modulesBlock(p),
    h.div(
      field('Target years', text('st-years', 'target_years', p.benefits.target_years.map((y) => pyG(y)).join(', ')),
        `Comma separated, from 0 to ${st.period_of_analysis}.`),
      // the average annual words follow from these two (views/edits.study_field)
      field('Output units', text('st-oname', 'output_name', lab.output_name),
        `Averages print as ${lowerFirst(lab.annual_output_name)} (${lab.annual_output_short}).`),
      field('Abbreviation', text('st-oshort', 'output_short', lab.output_short)),
      staffy ? field('STAF outcome mapping', sel('st-staf-map', 'staf_mapping', p.benefits.staf_mapping, Object.entries(staf.MAPPING_LABELS)),
        'Which functions drive each outcome. Use the SFARI mapping to reproduce SFARI calculator results.', true) : null,
      { class: 'ce-form cols-3' }),
    staffy ? h.p('The Ecosystem Condition Index is not a certified or approved USACE planning model. STAF guidance treats it as a '
      + 'supplement to habitat units from approved models.', { class: 'ce-note' }) : null,
    h.details(
      h.summary('Conventions'),
      h.div(
        h.p('Outputs are averaged over the period by straight lines between target years. Interest during construction assumes even '
          + 'spending over the construction months. OMRRR is the present value of each recurring cost.', { class: 'ce-note' }),
        h.div(
          field('Average annual output', sel('st-aahu', 'aahu_method', st.aahu_method,
            [['TRAPEZOID', 'Straight lines between target years'], ['IWR_YEARLY_2DP', 'IWR Annualizer (yearly, 2 decimals)']])),
          field('Interest during construction', sel('st-idc', 'idc_method', st.idc_method,
            [['END', 'Spending at the end of each month'], ['MIDDLE', 'Middle of each month'], ['START', 'Start of each month']])),
          field('OMRRR discounting', sel('st-timing', 'recurring_timing', st.recurring_timing,
            [['END_OF_YEAR', 'End of year'], ['MID_YEAR', 'Middle of year (IWR Annualizer)']])),
          field('Rounding before CE/ICA', sel('st-round', 'rounding', st.cost_decimals === 2 && st.output_decimals === 3 ? 'IWR' : 'FULL',
            [['IWR', 'Like IWR Planning Suite II (cents, thousandths)'], ['FULL', 'Full precision (as ecorest)']])),
          { class: 'ce-form' }),
        { class: 'ce-details-body' }),
      { class: 'ce-details' }))
}

export function sitesSection(res: AnalysisResults): Tag {
  const [grid] = sitesGrid(res)
  return h.div(
    h.div(h.p('Each site has a No Action alternative and one or more restoration alternatives. Edit IDs, names and descriptions in place; '
      + 'IDs appear in tables and plan names.', { class: 'ce-note', style: 'margin:0' }),
    h.button('Add site', { type: 'button', class: 'btn btn-sm btn-primary' }, ev('add_site')), { class: 'ce-toolbar' }),
    grid)
}

/** A tab per module and Totals and lift, for a study with two or more modules. */
export function moduleTabs(p: Project, current: Module | null): Tag | null {
  const mods = p.benefits.modules
  if (mods.length < 2) return null
  const tab = (label: string, key: string, on: boolean, cls = '') =>
    h.button(label, { type: 'button', class: [cls, on ? 'is-on' : ''].filter((c) => c).join(' ') || null, 'aria-current': on ? 'true' : null,
      title: [...label].length > 24 ? label : null }, ev('grid_opt', { name: 'module', value: key }))
  return h.nav(...mods.map((m) => tab(m.name, m.id, current !== null && m.id === current.id)),
    h.span({ class: 'ce-subtabs-sep', 'aria-hidden': 'true' }),
    tab('Totals and lift', TOTALS, current === null, 'is-sum'),
    { class: 'ce-subtabs', 'aria-label': 'Modules' })
}

/** A computed view before anything can be worked out: what to enter, and where. */
function noOutputYet(p: Project, mod: Module): Tag {
  const what = p.labels.output_name.toLowerCase()
  const who = p.benefits.modules.length > 1 ? ` for ${mod.name}` : ''
  let text: string
  let go: [string, string][]
  if (mod.method === 'STAF') {
    text = `No ${what}${who} yet. Enter the function scores and the quantity at each target year.`
    go = [['scores', 'Function scores']]
  } else {
    const units = mod.quantity_units
    text = `No ${what}${who} yet. Enter the index and the quantity at each target year.`
    go = [['values', 'Index (0 to 1)'], ['quantity', units ? `Quantity (${units})` : 'Quantity']]
  }
  return h.div(h.p(text),
    h.div(...go.map(([val, label]) => h.button(label, { type: 'button', class: 'btn btn-sm btn-outline-secondary' },
      ev('grid_opt', { name: 'view', value: val }))), { class: 'ce-toolbar' }),
    { class: 'ce-empty-inline' })
}

/** Each module's values, one tab per module (none for a one-module study), then Totals and lift.
 * Modules themselves are set up in Study. */
export function benefitsSection(res: AnalysisResults, opts: GridOpts): Tag {
  const p = res.project
  if (!p.sites.some((s) => s.alternatives.length)) {
    return h.div(
      h.p('Add sites and their alternatives first; their benefits are entered here.', { class: 'ce-note' }),
      h.button('Go to Sites and alternatives', { type: 'button', class: 'btn btn-sm btn-outline-secondary' },
        ev('nav', { page: 'inputs', section: 'sites' })))
  }
  const [mod, view] = pickModule(p, opts)
  const tabs = moduleTabs(p, mod)
  const aunit = p.labels.annual_output_short
  if (mod === null) {
    const [grid] = totalsGrid(res)
    return h.div(tabs, h.p(`Each module's average (${aunit}) for every alternative. Total adds them up, and Lift is the Total minus the `
      + "site's No Action total. Hover a result to see how it was worked out.", { class: 'ce-note' }), grid)
  }
  const single = p.benefits.modules.length === 1
  const name = p.labels.output_name
  const units = mod.quantity_units
  const views: [string, string][] | undefined = ({
    INDEX_X_QUANTITY: [['values', 'Index (0 to 1)'], ['quantity', units ? `Quantity (${units})` : 'Quantity'], ['output', name]],
    STAF: [['scores', 'Function scores'], ['output', name]],
  } as Record<string, [string, string][]>)[mod.method]
  const tools = views ? h.div(seg(views, view, 'grid_opt', { name: 'view' }), { class: 'ce-toolbar' }) : null
  if (view === 'scores') return h.div(tabs, tools, stafSection(res, opts, mod))
  if (view === 'output' && !hasOutput(res, mod.id)) return h.div(tabs, tools, noOutputYet(p, mod))
  const total = single ? "Lift is the average minus the site's No Action average." : 'Totals and lift adds the modules up.'
  const hover = 'Hover a result to see how it was worked out.'
  const paste = 'Paste a block from Excel into any cell.'
  let parts: string[]
  if (view === 'values' && mod.method === 'HU') {
    parts = [`${name} (${p.labels.output_short}) at each target year.`, averageNote(p), total, hover, paste]
  } else if (view === 'values') {
    parts = [`The index (0 to 1) at each target year. ${name} are the index times the quantity.`, paste]
  } else if (view === 'quantity') {
    parts = [`The quantity (${units || 'area or length'}) at each target year. ${name} are the index times the quantity.`, paste]
  } else if (view === 'output') {
    const what = mod.method === 'STAF' ? 'the ECI' : 'the index'
    parts = [`${name} at each target year: ${what} times the quantity.`, averageNote(p), total, hover]
  } else {
    parts = [`The average annual value (${aunit}), entered directly, for example from a model run elsewhere. No Action is the baseline.`,
      total, paste]
  }
  const [grid] = benefitsGrid(res, mod.id, view)
  return h.div(tabs, tools, h.p(parts.join(' '), { class: 'ce-note' }), grid)
}

export function stafSection(res: AnalysisResults, opts: GridOpts, mod: Module): Tag {
  const p = res.project
  const sites = p.sites.filter((s) => s.alternatives.length)
  if (!sites.length) return h.p('Add sites and alternatives first.', { class: 'ce-note' })
  const site = (opts.staf_site ? siteOf(p, opts.staf_site) : null) ?? sites[0]
  const alt = alternativeOf(site, opts.staf_alt || '') ?? site.alternatives[0]
  const altTabs = seg(site.alternatives.map((a) => [a.id, a.is_no_action ? 'No Action' : (a.name || a.id)] as const), alt.id, 'grid_opt',
    { name: 'staf_alt' })
  const siteSel = h.select(...sites.map((s) => h.option(s.name !== s.id ? `${s.id}  ${s.name}` : s.id,
    { value: s.id, selected: s.id === site.id || null })),
  { class: 'form-select form-select-sm', style: 'width:auto', 'aria-label': 'Site' }, ev('grid_opt', { name: 'staf_site' }))
  const [grid] = stafGrid(res, mod.id, site.id, alt.id)
  const mapping = staf.MAPPING_LABELS[p.benefits.staf_mapping]
  return h.div(
    h.div(siteSel, altTabs,
      h.button('Import existing condition', { type: 'button', class: 'btn btn-sm btn-outline-secondary',
        title: 'Read function scores from a SFARI, EASI or DEEP export', onclick: "document.getElementById('staf_file').click()" }),
      h.button('Start from existing condition', { type: 'button', class: 'btn btn-sm btn-outline-secondary',
        title: "Copy No Action's year-0 scores and quantity into every empty cell of this alternative" },
      ev('staf_fill', { site: site.id, alt: alt.id, module: mod.id })),
      { class: 'ce-toolbar' }),
    h.p(`Function scores 0 to 15 at each target year and the quantity. Sub-indices and the ECI follow the ${mapping} mapping; `
      + `${p.labels.output_name.toLowerCase()} = ECI x quantity.`, { class: 'ce-note' }),
    grid)
}

export function costsSection(res: AnalysisResults, opts: GridOpts): Tag {
  const p = res.project
  const [grid] = costsGrid(res)
  const [items] = recurringGrid(res)
  const alts: [string, string][] = []
  for (const s of p.sites) for (const a of s.alternatives) if (!a.is_no_action) alts.push([s.id, a.id])
  const keys = alts.map(([s, a]) => `${s}|${a}`)
  const target = opts.omrrr && keys.includes(opts.omrrr) ? opts.omrrr : keys.length ? keys[0] : null
  let tools: Child[] = []
  if (target) {
    const [ts, ta] = target.split('|')
    tools = [
      h.select(...alts.map(([s, a]) => h.option(`${s} ${a}`, { value: `${s}|${a}`, selected: `${s}|${a}` === target || null })),
        { class: 'form-select form-select-sm', style: 'width:auto', 'aria-label': 'Alternative for new items' }, ev('grid_opt', { name: 'omrrr' })),
      h.button('Add item', { type: 'button', class: 'btn btn-sm btn-outline-secondary' }, ev('add_item', { site: ts, alt: ta })),
      h.button("Copy its items to the site's other alternatives", { type: 'button', class: 'btn btn-sm btn-outline-secondary',
        title: 'Replaces the recurring items of the other restoration alternatives at this site', 'data-confirm': 'Replace their items?' },
      ev('copy_items', { site: ts, alt: ta })),
    ]
  }
  return h.div(
    h.p('First costs in base-year dollars (* interest during construction applies), construction months, and an optional average annual '
      + 'cost that replaces the computation.', { class: 'ce-note' }),
    grid,
    h.h2('OMRRR: recurring costs', { class: 'ce-sec' }),
    h.div(...tools, { class: 'ce-toolbar' }),
    items)
}

export function checkSection(res: AnalysisResults): Tag {
  const p = res.project
  const unit = p.labels.annual_output_short
  const errs = res.issues.filter((i) => i.level === 'error')
  const warns = res.issues.filter((i) => i.level === 'warning')
  const status = errs.length || warns.length ? issuesBox([...errs, ...warns]) : h.div('Ready: no problems found.', { class: 'ce-ok-box' })
  const head = [h.th('Site'), h.th('Alternative'), h.th(`Outputs (${unit})`, { class: 'num' }), h.th(`Lift (${unit})`, { class: 'num' }),
    h.th('Construction cost', { class: 'num' }), h.th('Average annual cost', { class: 'num' }), h.th(`Unit cost ($/${unit})`, { class: 'num' })]
  const rows: Tag[] = []
  for (const s of p.sites) {
    const sr = res.sites.get(s.id)!
    for (const r of sr.rows) {
      rows.push(h.tr(h.td(s.id), h.td(r.is_no_action ? 'No Action' : r.alt_id), h.td(num(r.aahu, 2), { class: 'num' }),
        h.td(num(r.lift, 2), { class: 'num' }), h.td(money(r.construction), { class: 'num' }), h.td(money(r.annual), { class: 'num' }),
        h.td(r.unit_cost ? money(r.unit_cost) : 'n/a', { class: 'num' })))
    }
  }
  return h.div(status, h.div({ style: 'height:12px' }),
    h.div(h.table(h.caption('Summary of inputs to CE/ICA.'), h.thead(h.tr(...head)), h.tbody(...rows), { class: 'ce-table' }),
      { class: 'ce-table-wrap' }))
}

export function inputsPage(res: AnalysisResults | null, section: string, opts: GridOpts | null = null): Tag {
  if (res === null) return empty('No project open', 'Open a project or try the Utoy Creek example.')
  const o = opts ?? {}
  const head = pageHead('Inputs', 'Study settings, sites and alternatives, benefits at target years and costs. Results update as you edit.')
  const builders: Record<string, (r: AnalysisResults) => Tag> = {
    study: (r) => studySection(r), sites: (r) => sitesSection(r), benefits: (r) => benefitsSection(r, o),
    costs: (r) => costsSection(r, o), check: (r) => checkSection(r),
  }
  const body = (builders[section] ?? builders.study)(res)
  const manage = section === 'benefits' ? h.button('Manage modules', { type: 'button', class: 'ce-link ce-legend-link',
    title: 'Add, rename or remove modules in Study' }, ev('nav', { page: 'inputs', section: 'study', anchor: 'study-modules' })) : null
  const legend = ['benefits', 'costs', 'sites'].includes(section)
    ? h.div(h.span(h.i({ style: 'background:#fffaf5' }), 'Input'), h.span(h.i({ style: 'background:var(--ce-surface-soft)' }), 'Computed'),
      manage, { class: 'ce-legend-inputs' }) : null
  return h.div(head, sectionTabs(section), legend, body, { class: 'ce-page' })
}
