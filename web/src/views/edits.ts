// Project edits from UI events (views/edits.py): pure functions, Project in, Project out
// (copy-then-set).
//
// Each function returns the new project; it throws EditError with a message for the user when a value
// cannot be accepted. A copy is made as model_copy makes it, without validating; models the Python
// builds with their constructors (a new site, a rule, a decision) are validated as they are.
import { analyze, type AnalysisResults } from '../engine/analysis'
import { functionIds, OUTCOME_LABELS, outcomeMax } from '../engine/benefits/staf'
import { carryBasis } from '../engine/decisions'
import {
  allAnnual, type Alternative, alternativeOf, averageAnnual, compositionKey, copy, dumpProject, isStaf, type Labels, type Module,
  moduleOf, type ModuleValues, noAction, notAssessed, parseAlternative, parseCompositionKey, parseCosts, parseFinalArrayChoice,
  parseLabels, parseModule, parseModuleValues, parseProject, parseRecurringItem, parseRule, parseSite, parseSiteDecision,
  parseStepNote, type Project, type Rule, type Site, type SiteDecision, siteOf, STAF_LABELS, ValidationError, valuesFor,
  type WatershedDecision,
} from '../engine/model'
import { tableKey } from '../engine/plans'
import { finalReady } from '../engine/runState'
import { applyExistingCondition, type StafImport, StafImportError } from '../engine/stafImport'
import { pyFloatText, PyValueError, pyStrip } from '../py/pystr'

export class EditError extends Error {}

function decisions(p: Project, kw: Partial<Project['decisions']>): Project {
  return copy(p, { decisions: copy(p.decisions, kw) })
}

function siteDec(p: Project, siteId: string, kw: Partial<SiteDecision>): Project {
  const sites = new Map(p.decisions.sites)
  sites.set(siteId, copy(sites.get(siteId) ?? parseSiteDecision({}), kw))
  return decisions(p, { sites })
}

function wsDec(p: Project, kw: Partial<WatershedDecision>): Project {
  return decisions(p, { watershed: copy(p.decisions.watershed, kw) })
}

export function recommend(p: Project, res: AnalysisResults, siteId: string, altId: string): Project {
  const site = siteOf(p, siteId)
  if (site === null || alternativeOf(site, altId) === null) throw new EditError('That alternative no longer exists.')
  return siteDec(p, siteId, { recommended_alt_id: altId, basis: res.sites.get(siteId)!.fingerprint })
}

export function keepRecommendation(p: Project, res: AnalysisResults, siteId: string): Project {
  return siteDec(p, siteId, { basis: res.sites.get(siteId)!.fingerprint })
}

export function altNote(p: Project, siteId: string, altId: string, text: string): Project {
  const dec = p.decisions.sites.get(siteId) ?? parseSiteDecision({})
  const notes = new Map(dec.alt_notes)
  if (pyStrip(text)) notes.set(altId, pyStrip(text))
  else notes.delete(altId)
  return siteDec(p, siteId, { alt_notes: notes })
}

export function siteRationale(p: Project, siteId: string, text: string): Project {
  return siteDec(p, siteId, { rationale: pyStrip(text) })
}

export function setFinal(p: Project, res: AnalysisResults, key: string, included: boolean): Project {
  const ws = res.watershed
  const bbKeys = new Set<string>()
  for (let i = 0; i < ws.ceica!.bb.length; i++) if (ws.ceica!.bb[i]) bbKeys.add(tableKey(ws.table!, i))
  const final = new Map(p.decisions.watershed.final_array)
  const old = final.get(key)
  const note = old ? old.note : ''
  if (included === bbKeys.has(key) && !note) final.delete(key)
  else final.set(key, parseFinalArrayChoice({ included, note }))
  return wsDec(p, { final_array: final })
}

export function finalNote(p: Project, res: AnalysisResults, key: string, text: string): Project {
  const final = new Map(p.decisions.watershed.final_array)
  const included = res.decisions.final_keys.includes(key)
  const old = final.get(key)
  final.set(key, parseFinalArrayChoice({ included: old ? old.included : included, note: pyStrip(text) }))
  return wsDec(p, { final_array: final })
}

export function stepWorth(p: Project, step: string, value: string): Project {
  const steps = new Map(p.decisions.watershed.steps)
  const old = steps.get(step) ?? parseStepNote({})
  steps.set(step, copy(old, { worth_it: value === 'YES' || value === 'NO' ? value : 'UNDECIDED' }))
  return wsDec(p, { steps })
}

export function stepWhy(p: Project, step: string, text: string): Project {
  const steps = new Map(p.decisions.watershed.steps)
  const old = steps.get(step) ?? parseStepNote({})
  steps.set(step, copy(old, { why: pyStrip(text) }))
  return wsDec(p, { steps })
}

export function setTsp(p: Project, res: AnalysisResults, key: string): Project {
  return wsDec(p, { tsp: key, basis: res.watershed.fingerprint })
}

/** The team reviewed the TSP after the results changed and keeps it. */
export function keepTsp(p: Project, res: AnalysisResults): Project {
  if (res.decisions.tsp_state !== 'ok') throw new EditError('Choose the tentatively selected plan first.')
  return wsDec(p, { basis: res.watershed.fingerprint })
}

export function tspText(p: Project, fld: string, text: string): Project {
  if (fld !== 'tsp_plan_type' && fld !== 'tsp_rationale') throw new EditError('Unknown field.')
  return wsDec(p, { [fld]: pyStrip(text) })
}

export function watershedMode(p: Project, res: AnalysisResults, mode: string): Project {
  if (mode !== 'RECOMMENDED' && mode !== 'MULTI') throw new EditError('Unknown plan formation mode.')
  const carried = new Map(p.watershed.carried)
  if (mode === 'MULTI' && !carried.size) {
    // start from what each site carries now
    for (const [sid, alts] of res.watershed.carried) carried.set(sid, [...alts])
  }
  return copy(p, { watershed: copy(p.watershed, { mode, carried }) })
}

/** Add or drop an alternative a site carries to the watershed plans (several per site). ``current`` is
 * what the site carries now; a site the team has not set yet carries its recommendation, so the
 * first tick starts from that rather than from nothing. */
export function carry(p: Project, siteId: string, altId: string, on: boolean, current: readonly string[] = []): Project {
  const carried = new Map(p.watershed.carried)
  const cur = [...(carried.get(siteId) ?? current)]
  if (on && !cur.includes(altId)) cur.push(altId)
  if (!on && cur.includes(altId)) cur.splice(cur.indexOf(altId), 1)
  const site = siteOf(p, siteId)
  const order = site ? site.alternatives.map((a) => a.id) : cur
  carried.set(siteId, order.filter((a) => cur.includes(a)))
  return copy(p, { watershed: copy(p.watershed, { carried }) })
}

const sameRule = (a: Rule, b: Rule): boolean => a.kind === b.kind && a.site_id === b.site_id
  && a.with_sites.length === b.with_sites.length && a.with_sites.every((s, i) => s === b.with_sites[i])

export function addRule(p: Project, siteId: string, kind: string, other: string): Project {
  if (siteId === other) throw new EditError('A rule needs two different sites.')
  if (kind !== 'NOT_COMBINABLE' && kind !== 'DEPENDS_ON') throw new EditError('Unknown rule.')
  const rule = parseRule({ kind, site_id: siteId, with_sites: [other] })
  if (p.watershed.rules.some((r) => sameRule(r, rule))) return p
  return copy(p, { watershed: copy(p.watershed, { rules: [...p.watershed.rules, rule] }) })
}

export function removeRule(p: Project, index: number): Project {
  const rules = [...p.watershed.rules]
  if (index >= 0 && index < rules.length) rules.splice(index, 1)
  return copy(p, { watershed: copy(p.watershed, { rules }) })
}

function number(text: string, what: string): number {
  try {
    return pyFloatText(pyStrip(String(text).replace(/,/g, '').replace(/\$/g, '').replace(/%/g, '')))
  } catch (exc) {
    if (exc instanceof PyValueError) throw new EditError(`${what} must be a number.`)
    throw exc
  }
}

/** Each Study field as an undo step names it ("Undo: edit the abbreviation"). */
export const STUDY_FIELDS: Readonly<Record<string, string>> = {
  name: 'the study name', description: 'the description', discount_rate: 'the discount rate',
  period_of_analysis: 'the period of analysis', price_level: 'the price level', target_years: 'the target years',
  output_name: 'the output units', output_short: 'the abbreviation', staf_mapping: 'the STAF outcome mapping',
  aahu_method: 'the average annual output', idc_method: 'interest during construction', recurring_timing: 'OMRRR discounting',
  rounding: 'the rounding before CE/ICA',
}

/** Python's \s for str patterns: the characters str.split() splits on. */
const SPLIT_YEARS = /[,;\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

export function studyField(p: Project, fld: string, value: string): Project {
  const v = pyStrip(value || '')
  if (fld === 'name' || fld === 'description') {
    if (fld === 'name' && !v) throw new EditError('The study needs a name.')
    return copy(p, { [fld]: v })
  }
  const st = p.settings
  if (fld === 'discount_rate') {
    const r = number(v, 'The discount rate') / 100.0
    if (!(r >= 0 && r <= 0.25)) throw new EditError('The discount rate must be between 0 and 25 percent.')
    return copy(p, { settings: copy(st, { discount_rate: r }) })
  }
  if (fld === 'period_of_analysis') {
    const n = number(v, 'The period of analysis')
    if (n !== Math.trunc(n) || !(n >= 1 && n <= 200)) throw new EditError('The period of analysis must be a whole number of years (1 to 200).')
    return copy(p, { settings: copy(st, { period_of_analysis: Math.trunc(n) }) })
  }
  if (fld === 'price_level') return copy(p, { settings: copy(st, { price_level: v }) })
  if (fld === 'aahu_method' || fld === 'idc_method' || fld === 'recurring_timing') return copy(p, { settings: copy(st, { [fld]: v }) })
  if (fld === 'rounding') {
    const [cd, od] = v === 'IWR' ? [2, 3] : [4, 6]
    return copy(p, { settings: copy(st, { cost_decimals: cd, output_decimals: od }) })
  }
  if (fld === 'target_years') {
    let years: number[]
    try {
      years = v.split(SPLIT_YEARS).filter((x) => x).map((x) => pyFloatText(x))
    } catch (exc) {
      if (exc instanceof PyValueError) throw new EditError('Target years must be numbers separated by commas.')
      throw exc
    }
    if (years.length < 2 || years.slice(1).some((b, i) => !(b > years[i]))) throw new EditError('Target years must increase, with at least two.')
    return changeYears(p, years)
  }
  if (fld === 'staf_mapping') {
    if (!isStaf(p.benefits)) throw new EditError('This setting applies to STAF projects.')
    if (v !== 'A' && v !== 'B') throw new EditError('Unknown STAF outcome mapping.')
    return copy(p, { benefits: copy(p.benefits, { staf_mapping: v }) })
  }
  if (fld === 'output_name' || fld === 'output_short') {
    if (!v) throw new EditError('The output units need a name and an abbreviation.')
    // the average annual words follow from the name and abbreviation
    const lab = copy(p.labels, { [fld]: v })
    return copy(p, { labels: copy(lab, averageAnnual(lab.output_name, lab.output_short)) })
  }
  throw new EditError(`Unknown field ${pyRepr(fld)}.`)
}

/** repr() of a str, for a message. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  return q + s + q
}

/** New target years: values move with their year; new years start empty. */
export function changeYears(p: Project, years: readonly number[]): Project {
  const old = p.benefits.target_years
  const remap = (vals: readonly (number | null)[]): (number | null)[] => {
    const byYear = new Map<number, number | null>()
    old.forEach((y, i) => byYear.set(y, i < vals.length ? vals[i] : null))
    return years.map((y) => (byYear.has(y) ? byYear.get(y)! : null))
  }
  // values, quantities and scores move with their year; an average-annual value stays
  const byYear = (mv: ModuleValues): ModuleValues => copy(mv, {
    values: mv.values.length ? remap(mv.values) : [],
    quantity: mv.quantity.length ? remap(mv.quantity) : [],
    scores: new Map([...mv.scores].map(([f, v]) => [f, remap(v)])),
  })
  const sites = p.sites.map((s) => copy(s, { alternatives: s.alternatives.map((a) => copy(a, { outputs: a.outputs.map(byYear) })) }))
  return copy(p, { benefits: copy(p.benefits, { target_years: [...years] }), sites })
}

/** Report settings chosen from a fixed list, and the values each accepts. */
const REPORT_CHOICES: Record<string, readonly string[]> = { status: ['DRAFT', 'FINAL'], contents: ['FULL', 'SUMMARY'] }

export function reportField(p: Project, res: AnalysisResults, fld: string, value: string): Project {
  if (!['title', 'prepared_by', 'date', 'status', 'contents'].includes(fld)) throw new EditError('Unknown report setting.')
  const v = pyStrip(value || '')
  if (fld in REPORT_CHOICES && !REPORT_CHOICES[fld].includes(v)) throw new EditError(`Unknown report ${fld}.`)
  if (fld === 'status' && v === 'FINAL' && !finalReady(res)) throw new EditError('The report can be final once every readiness item is checked.')
  return copy(p, { report: copy(p.report, { [fld]: v }) })
}

/** The document settings dialog, saved together (one undo step). A title equal to the study name is
 * stored empty, so the document follows a later rename of the study. */
export function reportSettings(p: Project, { title, prepared_by, date, contents }: { title: string | null, prepared_by: string | null,
  date: string | null, contents: string | null }): Project {
  const c = pyStrip(contents || '')
  if (!REPORT_CHOICES.contents.includes(c)) throw new EditError('Unknown report contents.')
  let t = pyStrip(title || '')
  if (t === pyStrip(p.name)) t = ''
  return copy(p, { report: copy(p.report, { title: t, prepared_by: pyStrip(prepared_by || ''), date: pyStrip(date || ''),
    contents: c as 'FULL' | 'SUMMARY' }) })
}

// --- structure: sites, alternatives, recurring items ---------------------------------------------

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/

function unique(prefix: string, taken: ReadonlySet<string>): string {
  let k = 1
  while (taken.has(`${prefix}${k}`)) k += 1
  return `${prefix}${k}`
}

/** Blank values for one module: None at every target year for the fields its method uses. In a study
 * where every module is an average annual value, No Action starts at 0. */
function emptyValues(p: Project, module: Module, isNoAction = false): ModuleValues {
  const n = p.benefits.target_years.length
  const m = module.method
  const zero = isNoAction && allAnnual(p.benefits)
  return parseModuleValues({ module_id: module.id, values: m === 'HU' || m === 'INDEX_X_QUANTITY' ? Array(n).fill(null) : [],
    quantity: m === 'INDEX_X_QUANTITY' || m === 'STAF' ? Array(n).fill(null) : [], aahu: m === 'AAHU' && zero ? 0.0 : null })
}

function emptyAlt(p: Project, altId: string, name: string, isNoAction = false): Alternative {
  const zero = isNoAction && allAnnual(p.benefits)
  return parseAlternative({ id: altId, name, is_no_action: isNoAction,
    outputs: p.benefits.modules.map((m) => dumpModuleValues(emptyValues(p, m, isNoAction))),
    costs: dumpCosts(parseCosts({ annual_override: zero ? 0.0 : null })) })
}

/** A built model back to the plain form the parsers take (the constructors take models). */
const dumpModuleValues = (mv: ModuleValues): Record<string, unknown> =>
  ({ module_id: mv.module_id, values: [...mv.values], quantity: [...mv.quantity], scores: Object.fromEntries(mv.scores), aahu: mv.aahu })
const dumpCosts = (c: ReturnType<typeof parseCosts>): Record<string, unknown> =>
  ({ first_costs: Object.fromEntries(c.first_costs), construction_months: c.construction_months, recurring: [], annual_override: c.annual_override })

// --- modules -------------------------------------------------------------------------------------

export const METHODS = ['HU', 'INDEX_X_QUANTITY', 'STAF', 'AAHU'] as const

/** The methods a new module (or ``moduleId``) may use: STAF stays on its own. */
export function allowedMethods(p: Project, moduleId: string | null = null): readonly string[] {
  const others = p.benefits.modules.filter((m) => m.id !== moduleId)
  if (!others.length) return METHODS
  if (others.every((m) => m.method === 'STAF')) return ['STAF']
  return ['HU', 'INDEX_X_QUANTITY', 'AAHU']
}

function checkModule(p: Project, name: string, method: string, units: string, moduleId: string | null): [string, string] {
  const n = pyStrip(name || '')
  if (!n) throw new EditError('The module needs a name.')
  if (p.benefits.modules.some((m) => pyStrip(m.name).toLowerCase() === n.toLowerCase() && m.id !== moduleId)) {
    throw new EditError(`There is already a module named ${n}.`)
  }
  if (!allowedMethods(p, moduleId).includes(method)) throw new EditError('STAF modules cannot be combined with other methods in one study.')
  return [n, method === 'INDEX_X_QUANTITY' || method === 'STAF' ? pyStrip(units || '') : '']
}

/** The project with new modules, each alternative's values passed through ``fn(alt)``, and the sites'
 * STAF entries passed through ``staf(map)``. The result is validated as a whole, since model_copy
 * skips the validators. */
function withModules(p: Project, modules: readonly Module[], fn: ((a: Alternative) => readonly ModuleValues[]) | null = null,
  staf: (<T>(d: ReadonlyMap<string, T>) => Map<string, T>) | null = null): Project {
  const sites = p.sites.map((s) => {
    const upd: { -readonly [K in keyof Site]?: Site[K] } = {}
    if (fn !== null) upd.alternatives = s.alternatives.map((a) => copy(a, { outputs: fn(a) }))
    if (staf !== null) {
      upd.staf_not_assessed = staf(s.staf_not_assessed)
      upd.staf_source = staf(s.staf_source)
    }
    return copy(s, upd)
  })
  const q = copy(p, { benefits: copy(p.benefits, { modules }), sites })
  try {
    return parseProject(dumpProject(q))
  } catch (exc) {
    if (exc instanceof ValidationError) {
      let msg = exc.msg
      if (msg.startsWith('Value error, ')) msg = msg.slice('Value error, '.length)
      throw new EditError(msg.slice(0, 1).toUpperCase() + msg.slice(1) + '.')
    }
    throw exc
  }
}

const sameLabels = (a: Labels, b: Labels): boolean => a.output_name === b.output_name && a.output_short === b.output_short
  && a.annual_output_name === b.annual_output_name && a.annual_output_short === b.annual_output_short && a.lift_name === b.lift_name

/** A lone module moving between STAF and the other methods takes the matching default labels, unless
 * the labels were changed by hand. */
function swapLabels(p: Project, method: string): Project {
  const toStaf = method === 'STAF'
  if (sameLabels(p.labels, toStaf ? parseLabels({}) : STAF_LABELS)) return copy(p, { labels: toStaf ? STAF_LABELS : parseLabels({}) })
  return p
}

export function addModule(p: Project, name: string, method: string, units = ''): Project {
  const [n, u] = checkModule(p, name, method, units, null)
  const mid = unique('M', new Set(p.benefits.modules.map((m) => m.id)))
  const module = parseModule({ id: mid, name: n, method, quantity_units: u })
  const blank = copy(p, { benefits: copy(p.benefits, { modules: [...p.benefits.modules, module] }) })
  return withModules(p, [...p.benefits.modules, module], (a) => [...a.outputs, emptyValues(blank, module, a.is_no_action)])
}

/** Rename a module, change its quantity units, or change its method. A new method starts with blank
 * values (the old ones would mean something else); Undo brings them back. */
export function editModule(p: Project, moduleId: string, name: string, method: string, units = ''): Project {
  const old = moduleOf(p.benefits, moduleId)
  if (old === null) throw new EditError('That module no longer exists.')
  const [n, u] = checkModule(p, name, method, units, moduleId)
  const nw = copy(old, { name: n, method: method as Module['method'], quantity_units: u })
  const modules = p.benefits.modules.map((m) => (m.id === moduleId ? nw : m))
  if (method === old.method) return withModules(p, modules)
  const blank = copy(p, { benefits: copy(p.benefits, { modules }) })
  let q = withModules(p, modules,
    (a) => a.outputs.map((v) => (v.module_id === moduleId ? emptyValues(blank, nw, a.is_no_action) : v)),
    (d) => new Map([...d].filter(([k]) => k !== moduleId)))
  if (modules.length === 1 && (method === 'STAF') !== (old.method === 'STAF')) q = swapLabels(q, method)
  return q
}

export function removeModule(p: Project, moduleId: string): Project {
  if (moduleOf(p.benefits, moduleId) === null) throw new EditError('That module no longer exists.')
  if (p.benefits.modules.length === 1) throw new EditError('A study needs at least one module.')
  return withModules(p, p.benefits.modules.filter((m) => m.id !== moduleId),
    (a) => a.outputs.filter((v) => v.module_id !== moduleId),
    (d) => new Map([...d].filter(([k]) => k !== moduleId)))
}

export function addSite(p: Project): Project {
  const sid = unique('S', new Set(p.sites.map((s) => s.id)))
  const site = parseSite({ id: sid, name: 'New site', alternatives: [dumpAlt(emptyAlt(p, 'FWOP', 'No Action', true)),
    dumpAlt(emptyAlt(p, 'Alternative1', 'Alternative 1'))] })
  return copy(p, { sites: [...p.sites, site] })
}

/** An alternative back to the plain form Site() takes. */
const dumpAlt = (a: Alternative): Record<string, unknown> => ({ id: a.id, name: a.name, description: a.description,
  is_no_action: a.is_no_action, outputs: a.outputs.map(dumpModuleValues), costs: dumpCosts(a.costs) })

export function addAlternative(p: Project, siteId: string): Project {
  const site = siteOf(p, siteId)
  if (site === null) throw new EditError('That site no longer exists.')
  const aid = unique('Alternative', new Set(site.alternatives.map((a) => a.id)))
  const alt = emptyAlt(p, aid, aid.replace('Alternative', 'Alternative '))
  const nw = copy(site, { alternatives: [...site.alternatives, alt] })
  return copy(p, { sites: p.sites.map((s) => (s.id === siteId ? nw : s)) })
}

export function removeSite(p: Project, siteId: string): Project {
  const sites = p.sites.filter((s) => s.id !== siteId)
  const decs = new Map([...p.decisions.sites].filter(([k]) => k !== siteId))
  const carried = new Map([...p.watershed.carried].filter(([k]) => k !== siteId))
  const rules = p.watershed.rules.filter((r) => r.site_id !== siteId && !r.with_sites.includes(siteId))
  return copy(p, { sites, decisions: copy(p.decisions, { sites: decs }), watershed: copy(p.watershed, { carried, rules }) })
}

export function removeAlternative(p: Project, siteId: string, altId: string): Project {
  const site = siteOf(p, siteId)
  if (site === null) throw new EditError('That site no longer exists.')
  const alt = alternativeOf(site, altId)
  if (alt === null || alt.is_no_action) throw new EditError('No Action cannot be removed.')
  const nw = copy(site, { alternatives: site.alternatives.filter((a) => a.id !== altId) })
  let q = copy(p, { sites: p.sites.map((s) => (s.id === siteId ? nw : s)) })
  const dec = q.decisions.sites.get(siteId)
  if (dec !== undefined && dec.recommended_alt_id === altId) q = siteDec(q, siteId, { recommended_alt_id: null, basis: null })
  if (q.watershed.carried.has(siteId)) {
    const carried = new Map(q.watershed.carried)
    carried.set(siteId, carried.get(siteId)!.filter((a) => a !== altId))
    q = copy(q, { watershed: copy(q.watershed, { carried }) })
  }
  return q
}

function withAlt(p: Project, siteId: string, altId: string, fn: (a: Alternative) => Alternative): Project {
  const site = siteOf(p, siteId)
  const alt = site ? alternativeOf(site, altId) : null
  if (alt === null) throw new EditError('That alternative no longer exists.')
  const nw = fn(alt)
  const nsite = copy(site!, { alternatives: site!.alternatives.map((a) => (a.id === altId ? nw : a)) })
  return copy(p, { sites: p.sites.map((s) => (s.id === siteId ? nsite : s)) })
}

export function addItem(p: Project, siteId: string, altId: string): Project {
  return withAlt(p, siteId, altId, (a) => {
    const iid = unique('item', new Set(a.costs.recurring.map((i) => i.id)))
    const item = parseRecurringItem({ id: iid, name: 'New item', amount: 0.0, every_years: 1 })
    return copy(a, { costs: copy(a.costs, { recurring: [...a.costs.recurring, item] }) })
  })
}

export function removeItem(p: Project, siteId: string, altId: string, itemId: string): Project {
  return withAlt(p, siteId, altId, (a) => copy(a, { costs: copy(a.costs, { recurring: a.costs.recurring.filter((i) => i.id !== itemId) }) }))
}

/** Copy one alternative's recurring items to every other restoration alternative at the site. */
export function copyItemsToSite(p: Project, siteId: string, altId: string): Project {
  const site = siteOf(p, siteId)
  const src = site ? alternativeOf(site, altId) : null
  if (src === null) throw new EditError('That alternative no longer exists.')
  for (const a of site!.alternatives) {
    if (a.id !== altId && !a.is_no_action) p = withAlt(p, siteId, a.id, (x) => copy(x, { costs: copy(x.costs, { recurring: src.costs.recurring }) }))
  }
  return p
}

function stafModule(p: Project, moduleId: string | null): Module {
  const m = p.benefits.modules.filter((x) => x.method === 'STAF').find((x) => moduleId === null || moduleId === x.id)
  if (!m) throw new EditError('This applies to STAF modules.')
  return m
}

/** Fill every empty STAF cell of an alternative with No Action's year-0 score and quantity. Projected
 * scores then start from the existing condition and only the functions that change need editing.
 * Cells that already hold a value, and functions not assessed at the site, are left alone. */
export function stafFill(p: Project, siteId: string, altId: string, moduleId: string | null = null): Project {
  const module = stafModule(p, moduleId)
  const site = siteOf(p, siteId)
  const na = site ? noAction(site) : null
  if (na === null) throw new EditError('This site needs a No Action alternative.')
  const base = valuesFor(na, module.id) ?? parseModuleValues({ module_id: module.id })
  const n = p.benefits.target_years.length
  const skip = new Set(notAssessed(site!, module.id))
  const src = new Map<string, number | null>()
  for (const f of functionIds()) {
    if (skip.has(f)) continue
    const sc = base.scores.get(f)
    src.set(f, sc && sc.length ? sc[0] : null)
  }
  const srcQ = base.quantity.length ? base.quantity[0] : null
  if ([...src.values()].every((v) => v === null) && srcQ === null) throw new EditError("Enter No Action's year-0 scores (the existing condition) first.")
  const filled = (vals: readonly (number | null)[], v: number | null): (number | null)[] => {
    const cut = [...vals.slice(0, n), ...Array(Math.max(0, n - vals.length)).fill(null)]
    return cut.map((x) => (x === null ? v : x))
  }
  return withAlt(p, siteId, altId, (a) => {
    const mv = valuesFor(a, module.id) ?? parseModuleValues({ module_id: module.id })
    const scores = new Map(mv.scores)
    for (const [f, v] of src) if (v !== null) scores.set(f, filled(scores.get(f) ?? [], v))
    const q = srcQ !== null ? filled(mv.quantity, srcQ) : mv.quantity
    const nw = copy(mv, { scores, quantity: q })
    let outputs = a.outputs.map((v) => (v.module_id === module.id ? nw : v))
    if (valuesFor(a, module.id) === null) outputs = [...outputs, nw]
    return copy(a, { outputs })
  })
}

/** Mark a STAF function assessed or not at a site for one STAF module (every alternative and year). A
 * function not assessed drops out of both sums of the roll-up, the EASI/DEEP rule. Its scores are
 * kept, so assessing it again brings them back. */
export function stafAssessed(p: Project, siteId: string, functionId: string, on: boolean, moduleId: string | null = null): Project {
  const module = stafModule(p, moduleId)
  const site = siteOf(p, siteId)
  if (site === null) throw new EditError('That site no longer exists.')
  if (!functionIds().includes(functionId)) throw new EditError('Unknown STAF function.')
  const off = new Set(notAssessed(site, module.id))
  if (on) off.delete(functionId)
  else off.add(functionId)
  const assessed = functionIds().filter((f) => !off.has(f))
  const empty = Object.entries(outcomeMax(p.benefits.staf_mapping, assessed)).filter(([, mx]) => mx <= 0)
    .map(([o]) => OUTCOME_LABELS[o as keyof typeof OUTCOME_LABELS].toLowerCase())
  if (empty.length) throw new EditError(`The ${empty.join(' and ')} outcome needs at least one assessed function that drives it.`)
  const table = new Map(site.staf_not_assessed)
  if (off.size) table.set(module.id, functionIds().filter((f) => off.has(f)))
  else table.delete(module.id)
  const nsite = copy(site, { staf_not_assessed: table })
  return copy(p, { sites: p.sites.map((x) => (x.id === siteId ? nsite : x)) })
}

function rekey(key: string, fn: (s: string, a: string) => [string, string]): string {
  return compositionKey(new Map([...parseCompositionKey(key)].map(([s, a]) => fn(s, a))))
}

function rekeyDecisions(p: Project, fn: (s: string, a: string) => [string, string]): Partial<WatershedDecision> {
  const w = p.decisions.watershed
  return {
    final_array: new Map([...w.final_array].map(([k, v]) => [rekey(k, fn), v])),
    steps: new Map([...w.steps].map(([k, v]) => [k.split(' > ').map((x) => rekey(x, fn)).join(' > '), v])),
    tsp: w.tsp !== null ? rekey(w.tsp, fn) : null,
  }
}

/** A rename moves no result, so decisions that were current in ``res`` stay current in ``q``. */
function keepCurrent(res: AnalysisResults | null, q: Project, renamed: ReadonlyMap<string, string> | null = null): Project {
  return res === null ? q : carryBasis(res, q, analyze(q), renamed)
}

export function renameSite(p: Project, res: AnalysisResults | null, old: string, nw: string): Project {
  const q = renameSiteOnly(p, old, nw)
  return q === p ? p : keepCurrent(res, q, new Map([[old, pyStrip(nw || '')]]))
}

export function renameAlternative(p: Project, res: AnalysisResults | null, siteId: string, old: string, nw: string): Project {
  const q = renameAlternativeOnly(p, siteId, old, nw)
  return q === p ? p : keepCurrent(res, q)
}

/** _safe_id: a site id from a reach id: letters, digits, dot, underscore, hyphen; unique; 32 max. */
function safeId(raw: string, taken: ReadonlySet<string>): string {
  let base = raw.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 28) || 'Reach'
  if (!/^[\p{L}\p{N}]/u.test(base)) base = 'R' + base
  let sid = base
  let k = 2
  while (taken.has(sid)) {
    sid = `${base}-${k}`
    k++
  }
  return sid
}

/** Existing conditions from a SFARI, EASI or DEEP import, into one STAF module. ``targets`` maps a reach's
 * index to a site id, or to "new" for a new site named after the reach (No Action plus one empty
 * alternative). Reaches without a target are skipped. */
export function importReaches(p: Project, imp: StafImport, targets: ReadonlyMap<number, string>, moduleId: string | null = null): Project {
  const module = stafModule(p, moduleId)
  for (let i = 0; i < imp.reaches.length; i++) {
    const reach = imp.reaches[i]
    let target = targets.get(i)
    if (!target) continue
    if (target === 'new') {
      p = addSite(p)
      const sid = safeId(reach.reach_id, new Set(p.sites.map((s) => s.id)))
      p = renameSiteOnly(p, p.sites[p.sites.length - 1].id, sid)
      p = copy(p, { sites: p.sites.map((s) => (s.id === sid ? copy(s, { name: reach.name }) : s)) })
      target = sid
    }
    try {
      p = applyExistingCondition(p, target, reach, imp, module.id)
    } catch (exc) {
      if (exc instanceof StafImportError) throw new EditError(exc.message)
      throw exc
    }
  }
  return p
}

function renameSiteOnly(p: Project, old: string, nw: string): Project {
  nw = pyStrip(nw || '')
  if (nw === old) return p
  if (!ID.test(nw)) throw new EditError('IDs use letters, digits, dot, underscore or hyphen (up to 32).')
  if (siteOf(p, nw) !== null) throw new EditError(`Site ${nw} already exists.`)
  const ren = (s: string, a: string): [string, string] => [s === old ? nw : s, a]
  const sites = p.sites.map((s) => (s.id === old ? copy(s, { id: nw }) : s))
  const decs = new Map([...p.decisions.sites].map(([k, v]) => [k === old ? nw : k, v]))
  const w = copy(p.decisions.watershed, rekeyDecisions(p, ren))
  const carried = new Map([...p.watershed.carried].map(([k, v]) => [k === old ? nw : k, v]))
  const rules = p.watershed.rules.map((r) => copy(r, { site_id: r.site_id === old ? nw : r.site_id, with_sites: r.with_sites.map((x) => (x === old ? nw : x)) }))
  return copy(p, { sites, decisions: copy(p.decisions, { sites: decs, watershed: w }), watershed: copy(p.watershed, { carried, rules }) })
}

function renameAlternativeOnly(p: Project, siteId: string, old: string, nw: string): Project {
  nw = pyStrip(nw || '')
  if (nw === old) return p
  if (!ID.test(nw)) throw new EditError('IDs use letters, digits, dot, underscore or hyphen (up to 32).')
  const site = siteOf(p, siteId)
  if (site === null || alternativeOf(site, nw) !== null) throw new EditError(`Alternative ${nw} already exists at ${siteId}.`)
  const ren = (s: string, a: string): [string, string] => [s, s === siteId && a === old ? nw : a]
  const nsite = copy(site, { alternatives: site.alternatives.map((a) => (a.id === old ? copy(a, { id: nw }) : a)) })
  const sites = p.sites.map((s) => (s.id === siteId ? nsite : s))
  const decs = new Map(p.decisions.sites)
  if (decs.has(siteId)) {
    const d = decs.get(siteId)!
    const notes = new Map([...d.alt_notes].map(([k, v]) => [k === old ? nw : k, v]))
    decs.set(siteId, copy(d, { recommended_alt_id: d.recommended_alt_id === old ? nw : d.recommended_alt_id, alt_notes: notes }))
  }
  const w = copy(p.decisions.watershed, rekeyDecisions(p, ren))
  const carried = new Map(p.watershed.carried)
  if (carried.has(siteId)) carried.set(siteId, carried.get(siteId)!.map((a) => (a === old ? nw : a)))
  return copy(p, { sites, decisions: copy(p.decisions, { sites: decs, watershed: w }), watershed: copy(p.watershed, { carried }) })
}
