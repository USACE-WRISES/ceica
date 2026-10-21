// The project schema (ceica/model.py): study settings, sites and alternatives, benefits, costs and
// decisions.
//
// One Project is everything a .ceica file holds. Results are never stored here; they are recomputed
// from these inputs (see analysis.ts). Models are frozen: change a project by copying it with the
// new value (``copy``), never by changing it in place.
//
// Identifiers are short codes people read in tables ("17F2M", "Alternative1"). Names and
// descriptions are free text. Decisions refer to sites and alternatives by id and to watershed plans
// by their composition (which alternative at which site), never by plan number, which moves when
// sites change.
//
// Outputs are built from **modules**. Each module has a method for how its values are entered
// (habitat units, an index times a quantity, STAF function scores, or an average annual value);
// every alternative holds its values per module, and the output is the sum of the modules.
//
// Validation is pydantic's, as the Python app runs it on a file it opens (Project.model_validate):
// the same lax conversions (a whole float for an int, a number written as text, "yes" for true),
// fields checked in their declared order, then extra keys, then the model's own checks, and the
// first error's place and words. Dicts become Maps in the file's order, as a Python dict keeps it.
import { pyFloat } from '../py/pyfmt'
import { isMarkedFloat, markFloat, pyEntries } from '../py/pyjson'
import { pyStrRepr } from '../py/pystr'
import { functionIds } from './benefits/staf'

export const SCHEMA_VERSION = 'ceica-project/3'

/** A short code: letters, digits, dot, underscore, hyphen; up to 32 characters. */
export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'

/** How a module's values are entered.
 * HU: the output (habitat units) at each target year.
 * INDEX_X_QUANTITY: an index (0 to 1) and a quantity at each target year; output = their product.
 * STAF: STAF function scores (0 to 15) and a quantity at each target year; output = ECI x quantity.
 * AAHU: the average annual output entered directly, with no yearly values. */
export type ModuleMethod = 'HU' | 'INDEX_X_QUANTITY' | 'STAF' | 'AAHU'
export type IdcMethod = 'END' | 'MIDDLE' | 'START'
export type RecurringTiming = 'END_OF_YEAR' | 'MID_YEAR'
export type AahuMethod = 'TRAPEZOID' | 'IWR_YEARLY_2DP'
export type WatershedMode = 'RECOMMENDED' | 'MULTI'
export type RuleKind = 'NOT_COMBINABLE' | 'DEPENDS_ON'
export type WorthIt = 'YES' | 'NO' | 'UNDECIDED'

// --- the models ----------------------------------------------------------------------------------

/** Economics and computation conventions. */
export interface Settings {
  /** Federal water resources discount rate, as a fraction (0.03 is 3 percent). */
  readonly discount_rate: number
  /** Period of analysis in years. */
  readonly period_of_analysis: number
  /** Price level of the costs, for example "FY2025". Informational. */
  readonly price_level: string
  readonly idc_method: IdcMethod
  readonly idc_periods_per_year: number
  readonly recurring_timing: RecurringTiming
  readonly aahu_method: AahuMethod
  /** IWR rounds CURRENCY to 2 decimals and DECIMAL to 3 before CE/ICA. */
  readonly cost_decimals: number
  readonly output_decimals: number
}

/** Words for the output measure, used in tables, axes, captions and the workbook. */
export interface Labels {
  readonly output_name: string
  readonly output_short: string
  readonly annual_output_name: string
  readonly annual_output_short: string
  readonly lift_name: string
}

/** One part of the output: a name and how its values are entered (see ModuleMethod). */
export interface Module {
  readonly id: string
  readonly name: string
  readonly method: ModuleMethod
  /** Units of the quantity for index-by-quantity and STAF modules ("acres", "ft", "mi"). */
  readonly quantity_units: string
}

export interface BenefitSpec {
  readonly target_years: readonly number[]
  /** The modules the output is built from; the output is their sum. */
  readonly modules: readonly Module[]
  /** STAF outcome mapping for STAF modules: "A" (STAF docs, EASI, DEEP) or "B" (SFARI). */
  readonly staf_mapping: 'A' | 'B'
}

/** One module's values for one alternative; the fields in use depend on the method. */
export interface ModuleValues {
  readonly module_id: string
  /** Habitat units (HU) or the index (INDEX_X_QUANTITY) at each target year. */
  readonly values: readonly (number | null)[]
  /** The quantity at each target year (INDEX_X_QUANTITY and STAF). */
  readonly quantity: readonly (number | null)[]
  /** STAF function scores (0 to 15) at each target year, by function id (STAF). */
  readonly scores: ReadonlyMap<string, readonly (number | null)[]>
  /** The average annual output entered directly (AAHU). */
  readonly aahu: number | null
}

/** A first-cost column (construction, monitoring, adaptive management, ...). */
export interface CostCategory {
  readonly id: string
  readonly name: string
  /** Interest during construction accrues on this category. */
  readonly idc_applies: boolean
}

/** A recurring OMRRR cost: an amount every N years over the period of analysis. */
export interface RecurringItem {
  readonly id: string
  readonly name: string
  /** FIXED: ``amount`` per occurrence. PCT_OF_CATEGORY: ``percent`` of a first-cost category.
   * RATE_X_QUANTITY: ``unit_rate`` times ``quantity`` per occurrence. */
  readonly basis: 'FIXED' | 'PCT_OF_CATEGORY' | 'RATE_X_QUANTITY'
  readonly amount: number
  readonly percent: number
  readonly category_id: string | null
  readonly unit_rate: number
  readonly quantity: number
  readonly quantity_units: string
  readonly every_years: number
  readonly first_year: number | null
  readonly last_year: number | null
}

export interface Costs {
  readonly first_costs: ReadonlyMap<string, number>
  /** Construction duration in months (interest during construction). */
  readonly construction_months: number
  readonly recurring: readonly RecurringItem[]
  /** Average annual cost entered directly (annualized mode); overrides the computation. */
  readonly annual_override: number | null
}

export interface Alternative {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly is_no_action: boolean
  /** The alternative's values for each module. */
  readonly outputs: readonly ModuleValues[]
  readonly costs: Costs
}

export interface Site {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly alternatives: readonly Alternative[]
  /** STAF modules: functions not assessed at this site, by module (left out of both sums for every
   * alternative and year). */
  readonly staf_not_assessed: ReadonlyMap<string, readonly string[]>
  /** STAF modules: where the existing condition came from, by module, for the record. */
  readonly staf_source: ReadonlyMap<string, string>
}

/** IWR relationship rule between sites.
 *
 * NOT_COMBINABLE: a plan holding ``site_id`` and every site in ``with_sites`` is rejected.
 * DEPENDS_ON: a plan holding ``site_id`` must hold every site in ``with_sites``; several DEPENDS_ON
 * rules for one site are alternatives (any one satisfied is enough). */
export interface Rule {
  readonly kind: RuleKind
  readonly site_id: string
  readonly with_sites: readonly string[]
}

export interface WatershedSpec {
  /** RECOMMENDED: each site's recommended alternative, included or not (2^N plans).
   * MULTI: several carried alternatives per site, zero or one of them in a plan. */
  readonly mode: WatershedMode
  readonly carried: ReadonlyMap<string, readonly string[]>
  readonly rules: readonly Rule[]
}

export interface SiteDecision {
  /** The team's recommended alternative; null means the suggestion stands (not yet decided). */
  readonly recommended_alt_id: string | null
  readonly rationale: string
  readonly alt_notes: ReadonlyMap<string, string>
  /** Fingerprint of the site's results when the decision was made (see decisions.ts). */
  readonly basis: string | null
}

export interface FinalArrayChoice {
  readonly included: boolean
  readonly note: string
}

export interface StepNote {
  readonly worth_it: WorthIt
  readonly why: string
}

export interface WatershedDecision {
  /** Overrides of the default final array (the best buys), keyed by composition key. */
  readonly final_array: ReadonlyMap<string, FinalArrayChoice>
  /** "Is it worth it?" notes, keyed by "<from key> > <to key>". */
  readonly steps: ReadonlyMap<string, StepNote>
  readonly tsp: string | null
  readonly tsp_plan_type: string
  readonly tsp_rationale: string
  readonly basis: string | null
}

export interface Decisions {
  readonly sites: ReadonlyMap<string, SiteDecision>
  readonly watershed: WatershedDecision
}

export interface ReportSettings {
  readonly title: string
  /** Who prepared the study, a name or an office; the study's only Prepared by. */
  readonly prepared_by: string
  readonly date: string
  readonly status: 'DRAFT' | 'FINAL'
  readonly contents: 'FULL' | 'SUMMARY'
}

export interface Project {
  readonly schema_version: 'ceica-project/3'
  readonly project_id: string
  readonly name: string
  readonly description: string
  readonly settings: Settings
  readonly labels: Labels
  readonly benefits: BenefitSpec
  readonly cost_categories: readonly CostCategory[]
  readonly sites: readonly Site[]
  readonly watershed: WatershedSpec
  readonly decisions: Decisions
  readonly report: ReportSettings
  readonly provenance: ReadonlyMap<string, string>
}

// --- what the models know about themselves (the Python properties and methods) ------------------

/** Values are entered at each target year (every method but AAHU). */
export const byYear = (m: Module): boolean => m.method !== 'AAHU'

export const moduleOf = (spec: BenefitSpec, moduleId: string): Module | null =>
  spec.modules.find((m) => m.id === moduleId) ?? null

/** Every module uses STAF function scores (the modules cannot mix with others). */
export const isStaf = (spec: BenefitSpec): boolean => spec.modules[0].method === 'STAF'

/** Every module is an average annual value (a fully annualized study). */
export const allAnnual = (spec: BenefitSpec): boolean => spec.modules.every((m) => m.method === 'AAHU')

export const valuesFor = (alt: Alternative, moduleId: string): ModuleValues | null =>
  alt.outputs.find((v) => v.module_id === moduleId) ?? null

export const notAssessed = (site: Site, moduleId: string): readonly string[] =>
  site.staf_not_assessed.get(moduleId) ?? []

export const noAction = (site: Site): Alternative | null =>
  site.alternatives.find((a) => a.is_no_action) ?? null

export const alternativeOf = (site: Site, altId: string): Alternative | null =>
  site.alternatives.find((a) => a.id === altId) ?? null

export const siteOf = (project: Project, siteId: string): Site | null =>
  project.sites.find((s) => s.id === siteId) ?? null

/** A copy of a model with some fields replaced (Python's model_copy(update=...), which does not
 * validate again). */
export function copy<T extends object>(model: T, update: Partial<T>): T {
  return Object.freeze({ ...model, ...update })
}

/** Python's == on models: fields equal, a tuple's items in order, a dict's items in any order, numbers
 * by value (1 == 1.0). app.py commits an edit only when the project changed. */
export function modelEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !modelEquals(v, b.get(k))) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => modelEquals(v, b[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && modelEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// --- the schema ----------------------------------------------------------------------------------

type Ty =
  | { k: 'float', ge?: number, le?: number }
  | { k: 'int', ge?: number, le?: number }
  | { k: 'str', pattern?: string }
  | { k: 'bool' }
  | { k: 'lit', values: readonly string[] }
  | { k: 'opt', of: Ty }
  | { k: 'tuple', of: Ty }
  | { k: 'dict', of: Ty }
  | { k: 'model', def: () => ModelDef }

interface FieldDef {
  name: string
  ty: Ty
  /** the default when the key is missing (none: the field is required) */
  def?: () => unknown
  /** a field validator: throws ValueError */
  check?: (v: any) => void
}

interface ModelDef {
  name: string
  fields: FieldDef[]
  /** a model validator (mode "after"): throws ValueError */
  check?: (v: any) => void
}

/** What a model or field check throws; pydantic reports it as "Value error, <message>". */
export class ValueError extends Error {}

/** The first error pydantic would report: its type, place and words. */
export class ValidationError extends Error {
  constructor(readonly type: string, readonly loc: readonly (string | number)[], readonly msg: string) {
    super(msg)
  }
}

const float = (ge?: number, le?: number): Ty => ({ k: 'float', ge, le })
const int = (ge?: number, le?: number): Ty => ({ k: 'int', ge, le })
const str: Ty = { k: 'str' }
const id: Ty = { k: 'str', pattern: ID_PATTERN }
const bool: Ty = { k: 'bool' }
const lit = (...values: string[]): Ty => ({ k: 'lit', values })
const opt = (of: Ty): Ty => ({ k: 'opt', of })
const tuple = (of: Ty): Ty => ({ k: 'tuple', of })
const dict = (of: Ty): Ty => ({ k: 'dict', of })
const model = (def: () => ModelDef): Ty => ({ k: 'model', def })

function checkStafIds(ids: Iterable<string>): void {
  const known = new Set(functionIds())
  const unknown = [...new Set(ids)].filter((f) => !known.has(f)).sort()
  if (unknown.length) throw new ValueError(`unknown STAF function ${unknown.join(', ')}`)
}

const SETTINGS: ModelDef = {
  name: 'Settings',
  fields: [
    { name: 'discount_rate', ty: float(0.0, 0.25), def: () => 0.03 },
    { name: 'period_of_analysis', ty: int(1, 200), def: () => 50 },
    { name: 'price_level', ty: str, def: () => '' },
    { name: 'idc_method', ty: lit('END', 'MIDDLE', 'START'), def: () => 'END' },
    { name: 'idc_periods_per_year', ty: int(1, 365), def: () => 12 },
    { name: 'recurring_timing', ty: lit('END_OF_YEAR', 'MID_YEAR'), def: () => 'END_OF_YEAR' },
    { name: 'aahu_method', ty: lit('TRAPEZOID', 'IWR_YEARLY_2DP'), def: () => 'TRAPEZOID' },
    { name: 'cost_decimals', ty: int(0, 6), def: () => 2 },
    { name: 'output_decimals', ty: int(0, 6), def: () => 3 },
  ],
}

const LABELS: ModelDef = {
  name: 'Labels',
  fields: [
    { name: 'output_name', ty: str, def: () => 'Habitat units' },
    { name: 'output_short', ty: str, def: () => 'HU' },
    { name: 'annual_output_name', ty: str, def: () => 'Average annual habitat units' },
    { name: 'annual_output_short', ty: str, def: () => 'AAHU' },
    { name: 'lift_name', ty: str, def: () => 'Ecological lift' },
  ],
}

const MODULE: ModelDef = {
  name: 'Module',
  fields: [
    { name: 'id', ty: id },
    { name: 'name', ty: str },
    { name: 'method', ty: lit('HU', 'INDEX_X_QUANTITY', 'STAF', 'AAHU'), def: () => 'HU' },
    { name: 'quantity_units', ty: str, def: () => '' },
  ],
}

const BENEFIT_SPEC: ModelDef = {
  name: 'BenefitSpec',
  fields: [
    {
      name: 'target_years', ty: tuple(float()), def: () => Object.freeze([0.0, 2.0, 10.0, 50.0]),
      check: (v: readonly number[]) => {
        if (v.length < 2) throw new ValueError('at least two target years are needed')
        if (v.some((b, i) => i > 0 && b <= v[i - 1])) throw new ValueError('target years must increase')
      },
    },
    {
      name: 'modules', ty: tuple(model(() => MODULE)),
      def: () => Object.freeze([parseModel(MODULE, { id: 'M1', name: 'Habitat' })]),
      check: (v: readonly Module[]) => {
        if (!v.length) throw new ValueError('a project needs at least one module')
        const ids = v.map((m) => m.id)
        if (new Set(ids).size !== ids.length) throw new ValueError('module ids must be unique')
        const names = v.map((m) => m.name.trim().toLowerCase())
        if (new Set(names).size !== names.length) throw new ValueError('module names must be unique')
        const staf = v.map((m) => m.method === 'STAF')
        if (staf.some(Boolean) && !staf.every(Boolean)) {
          throw new ValueError('STAF modules cannot be combined with other methods')
        }
      },
    },
    { name: 'staf_mapping', ty: lit('A', 'B'), def: () => 'A' },
  ],
}

const MODULE_VALUES: ModelDef = {
  name: 'ModuleValues',
  fields: [
    { name: 'module_id', ty: id },
    { name: 'values', ty: tuple(opt(float())), def: () => Object.freeze([]) },
    { name: 'quantity', ty: tuple(opt(float())), def: () => Object.freeze([]) },
    {
      name: 'scores', ty: dict(tuple(opt(float()))), def: () => new Map(),
      check: (v: ReadonlyMap<string, unknown>) => checkStafIds(v.keys()),
    },
    { name: 'aahu', ty: opt(float()), def: () => null },
  ],
}

const COST_CATEGORY: ModelDef = {
  name: 'CostCategory',
  fields: [
    { name: 'id', ty: id },
    { name: 'name', ty: str },
    { name: 'idc_applies', ty: bool, def: () => false },
  ],
}

const RECURRING_ITEM: ModelDef = {
  name: 'RecurringItem',
  fields: [
    { name: 'id', ty: id },
    { name: 'name', ty: str },
    { name: 'basis', ty: lit('FIXED', 'PCT_OF_CATEGORY', 'RATE_X_QUANTITY'), def: () => 'FIXED' },
    { name: 'amount', ty: float(), def: () => 0.0 },
    { name: 'percent', ty: float(), def: () => 0.0 },
    { name: 'category_id', ty: opt(id), def: () => null },
    { name: 'unit_rate', ty: float(), def: () => 0.0 },
    { name: 'quantity', ty: float(), def: () => 0.0 },
    { name: 'quantity_units', ty: str, def: () => '' },
    { name: 'every_years', ty: int(1), def: () => 1 },
    { name: 'first_year', ty: opt(int()), def: () => null },
    { name: 'last_year', ty: opt(int()), def: () => null },
  ],
}

const COSTS: ModelDef = {
  name: 'Costs',
  fields: [
    { name: 'first_costs', ty: dict(float()), def: () => new Map() },
    { name: 'construction_months', ty: float(0.0), def: () => 0.0 },
    { name: 'recurring', ty: tuple(model(() => RECURRING_ITEM)), def: () => Object.freeze([]) },
    { name: 'annual_override', ty: opt(float()), def: () => null },
  ],
}

const ALTERNATIVE: ModelDef = {
  name: 'Alternative',
  fields: [
    { name: 'id', ty: id },
    { name: 'name', ty: str, def: () => '' },
    { name: 'description', ty: str, def: () => '' },
    { name: 'is_no_action', ty: bool, def: () => false },
    { name: 'outputs', ty: tuple(model(() => MODULE_VALUES)), def: () => Object.freeze([]) },
    { name: 'costs', ty: model(() => COSTS), def: () => parseModel(COSTS, {}) },
  ],
}

const SITE: ModelDef = {
  name: 'Site',
  fields: [
    { name: 'id', ty: id },
    { name: 'name', ty: str, def: () => '' },
    { name: 'description', ty: str, def: () => '' },
    { name: 'alternatives', ty: tuple(model(() => ALTERNATIVE)), def: () => Object.freeze([]) },
    {
      name: 'staf_not_assessed', ty: dict(tuple(str)), def: () => new Map(),
      check: (v: ReadonlyMap<string, readonly string[]>) => {
        for (const functions of v.values()) checkStafIds(functions)
      },
    },
    { name: 'staf_source', ty: dict(str), def: () => new Map() },
  ],
  check: (site: Site) => {
    const n = site.alternatives.filter((a) => a.is_no_action).length
    if (site.alternatives.length && n !== 1) {
      throw new ValueError(`site ${site.id} needs exactly one No Action alternative (has ${n})`)
    }
    const ids = site.alternatives.map((a) => a.id)
    if (new Set(ids).size !== ids.length) throw new ValueError(`site ${site.id} has duplicate alternative ids`)
  },
}

const RULE: ModelDef = {
  name: 'Rule',
  fields: [
    { name: 'kind', ty: lit('NOT_COMBINABLE', 'DEPENDS_ON') },
    { name: 'site_id', ty: id },
    { name: 'with_sites', ty: tuple(id) },
  ],
}

const WATERSHED_SPEC: ModelDef = {
  name: 'WatershedSpec',
  fields: [
    { name: 'mode', ty: lit('RECOMMENDED', 'MULTI'), def: () => 'RECOMMENDED' },
    { name: 'carried', ty: dict(tuple(str)), def: () => new Map() },
    { name: 'rules', ty: tuple(model(() => RULE)), def: () => Object.freeze([]) },
  ],
}

const SITE_DECISION: ModelDef = {
  name: 'SiteDecision',
  fields: [
    { name: 'recommended_alt_id', ty: opt(id), def: () => null },
    { name: 'rationale', ty: str, def: () => '' },
    { name: 'alt_notes', ty: dict(str), def: () => new Map() },
    { name: 'basis', ty: opt(str), def: () => null },
  ],
}

const FINAL_ARRAY_CHOICE: ModelDef = {
  name: 'FinalArrayChoice',
  fields: [
    { name: 'included', ty: bool },
    { name: 'note', ty: str, def: () => '' },
  ],
}

const STEP_NOTE: ModelDef = {
  name: 'StepNote',
  fields: [
    { name: 'worth_it', ty: lit('YES', 'NO', 'UNDECIDED'), def: () => 'UNDECIDED' },
    { name: 'why', ty: str, def: () => '' },
  ],
}

const WATERSHED_DECISION: ModelDef = {
  name: 'WatershedDecision',
  fields: [
    { name: 'final_array', ty: dict(model(() => FINAL_ARRAY_CHOICE)), def: () => new Map() },
    { name: 'steps', ty: dict(model(() => STEP_NOTE)), def: () => new Map() },
    { name: 'tsp', ty: opt(str), def: () => null },
    { name: 'tsp_plan_type', ty: str, def: () => 'National Ecosystem Restoration (NER) plan' },
    { name: 'tsp_rationale', ty: str, def: () => '' },
    { name: 'basis', ty: opt(str), def: () => null },
  ],
}

const DECISIONS: ModelDef = {
  name: 'Decisions',
  fields: [
    { name: 'sites', ty: dict(model(() => SITE_DECISION)), def: () => new Map() },
    { name: 'watershed', ty: model(() => WATERSHED_DECISION), def: () => parseModel(WATERSHED_DECISION, {}) },
  ],
}

const REPORT_SETTINGS: ModelDef = {
  name: 'ReportSettings',
  fields: [
    { name: 'title', ty: str, def: () => '' },
    { name: 'prepared_by', ty: str, def: () => '' },
    { name: 'date', ty: str, def: () => '' },
    { name: 'status', ty: lit('DRAFT', 'FINAL'), def: () => 'DRAFT' },
    { name: 'contents', ty: lit('FULL', 'SUMMARY'), def: () => 'FULL' },
  ],
}

const PROJECT: ModelDef = {
  name: 'Project',
  fields: [
    { name: 'schema_version', ty: lit(SCHEMA_VERSION), def: () => SCHEMA_VERSION },
    { name: 'project_id', ty: str, def: () => newProjectId() },
    { name: 'name', ty: str, def: () => 'Untitled study' },
    { name: 'description', ty: str, def: () => '' },
    { name: 'settings', ty: model(() => SETTINGS), def: () => parseModel(SETTINGS, {}) },
    { name: 'labels', ty: model(() => LABELS), def: () => parseModel(LABELS, {}) },
    { name: 'benefits', ty: model(() => BENEFIT_SPEC), def: () => parseModel(BENEFIT_SPEC, {}) },
    { name: 'cost_categories', ty: tuple(model(() => COST_CATEGORY)), def: () => DEFAULT_COST_CATEGORIES },
    { name: 'sites', ty: tuple(model(() => SITE)), def: () => Object.freeze([]) },
    { name: 'watershed', ty: model(() => WATERSHED_SPEC), def: () => parseModel(WATERSHED_SPEC, {}) },
    { name: 'decisions', ty: model(() => DECISIONS), def: () => parseModel(DECISIONS, {}) },
    { name: 'report', ty: model(() => REPORT_SETTINGS), def: () => parseModel(REPORT_SETTINGS, {}) },
    { name: 'provenance', ty: dict(str), def: () => new Map() },
  ],
  check: (p: Project) => {
    const ids = p.sites.map((s) => s.id)
    if (new Set(ids).size !== ids.length) throw new ValueError('duplicate site ids')
    const known = new Set(p.benefits.modules.map((m) => m.id))
    const staf = new Set(p.benefits.modules.filter((m) => m.method === 'STAF').map((m) => m.id))
    for (const site of p.sites) {
      if ([...site.staf_not_assessed.keys(), ...site.staf_source.keys()].some((k) => !staf.has(k))) {
        throw new ValueError(`site ${site.id} has STAF entries for a module that is not STAF`)
      }
      for (const alt of site.alternatives) {
        const mids = alt.outputs.map((v) => v.module_id)
        if (mids.some((m) => !known.has(m)) || new Set(mids).size !== mids.length) {
          throw new ValueError(`${site.id}, ${alt.id}: values for an unknown or repeated module`)
        }
      }
    }
  },
}

let projectIds: (() => string) | null = null

/** A fixed source of new projects' ids (the server traces' uuid4), or null for random ones. */
export function setProjectIds(source: (() => string) | null): void {
  projectIds = source
}

/** uuid.uuid4().hex */
function newProjectId(): string {
  return projectIds ? projectIds() : crypto.randomUUID().replace(/-/g, '')
}

// --- validation, as pydantic's lax mode ----------------------------------------------------------

type Loc = (string | number)[]

function fail(type: string, loc: Loc, msg: string): never {
  throw new ValidationError(type, loc, msg)
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Map)

/** str.strip(): Python's whitespace. */
const pyStrip = (s: string): string => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, '')

const FLOAT_TEXT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i
const INT_TEXT = /^[+-]?\d(?:_?\d)*(?:\.0*)?$/
const BOOL_TEXT: Record<string, boolean> = {
  0: false, off: false, f: false, false: false, n: false, no: false,
  1: true, on: true, t: true, true: true, y: true, yes: true,
}
const I64_MAX = 2 ** 63

function toFloat(x: unknown, loc: Loc): number {
  if (typeof x === 'number') return x
  if (typeof x === 'boolean') return x ? 1.0 : 0.0
  if (typeof x === 'string') {
    const s = pyStrip(x)
    const sp = SPECIAL_FLOAT.exec(s)
    if (sp) {
      const v = sp[2].toLowerCase() === 'nan' ? NaN : Infinity
      return sp[1] === '-' ? -v : v
    }
    if (FLOAT_TEXT.test(s)) return Number(s.replace(/_/g, ''))
    fail('float_parsing', loc, 'Input should be a valid number, unable to parse string as a number')
  }
  return fail('float_type', loc, 'Input should be a valid number')
}

function toInt(x: unknown, loc: Loc): number {
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) fail('finite_number', loc, 'Input should be a finite number')
    if (!Number.isInteger(x)) {
      fail('int_from_float', loc, 'Input should be a valid integer, got a number with a fractional part')
    }
    if (Math.abs(x) >= I64_MAX) {
      fail('int_parsing_size', loc, 'Unable to parse input string as an integer, exceeded maximum size')
    }
    return x + 0
  }
  if (typeof x === 'string') {
    const s = pyStrip(x)
    if (INT_TEXT.test(s)) {
      const v = Number(s.replace(/_/g, '').replace(/\.0*$/, ''))
      if (Math.abs(v) >= I64_MAX) {
        fail('int_parsing_size', loc, 'Unable to parse input string as an integer, exceeded maximum size')
      }
      return v + 0
    }
    fail('int_parsing', loc, 'Input should be a valid integer, unable to parse string as an integer')
  }
  return fail('int_type', loc, 'Input should be a valid integer')
}

function toBool(x: unknown, loc: Loc): boolean {
  if (typeof x === 'boolean') return x
  if (typeof x === 'number') {
    if (x === 0 || x === 1) return x === 1
    if (Number.isInteger(x)) fail('bool_parsing', loc, 'Input should be a valid boolean, unable to interpret input')
    fail('bool_type', loc, 'Input should be a valid boolean')
  }
  if (typeof x === 'string') {
    const v = BOOL_TEXT[x.toLowerCase()]
    if (v !== undefined && Object.prototype.hasOwnProperty.call(BOOL_TEXT, x.toLowerCase())) return v
    fail('bool_parsing', loc, 'Input should be a valid boolean, unable to interpret input')
  }
  return fail('bool_type', loc, 'Input should be a valid boolean')
}

/** pydantic's list of literal values: 'A', 'B' or 'C'. */
function literalWords(values: readonly string[]): string {
  const q = values.map((v) => `'${v}'`)
  return q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`
}

/** A constraint's number as pydantic writes it (0.0 is "0"). */
const constraint = (v: number): string => String(v)

function constrain(v: number, ty: { ge?: number, le?: number }, loc: Loc): void {
  if (ty.le !== undefined && !(v <= ty.le)) {
    fail('less_than_equal', loc, `Input should be less than or equal to ${constraint(ty.le)}`)
  }
  if (ty.ge !== undefined && !(v >= ty.ge)) {
    fail('greater_than_equal', loc, `Input should be greater than or equal to ${constraint(ty.ge)}`)
  }
}

function runCheck(check: () => void, loc: Loc): void {
  try {
    check()
  } catch (exc) {
    if (exc instanceof ValueError) fail('value_error', loc, `Value error, ${exc.message}`)
    throw exc
  }
}

function validate(ty: Ty, x: unknown, loc: Loc): unknown {
  switch (ty.k) {
    case 'float': {
      const v = toFloat(x, loc)
      constrain(v, ty, loc)
      return v
    }
    case 'int': {
      const v = toInt(x, loc)
      constrain(v, ty, loc)
      return v
    }
    case 'str':
      if (typeof x !== 'string') fail('string_type', loc, 'Input should be a valid string')
      if (ty.pattern && !new RegExp(ty.pattern).test(x)) {
        fail('string_pattern_mismatch', loc, `String should match pattern '${ty.pattern}'`)
      }
      return x
    case 'bool':
      return toBool(x, loc)
    case 'lit':
      if (typeof x === 'string' && ty.values.includes(x)) return x
      return fail('literal_error', loc, `Input should be ${literalWords(ty.values)}`)
    case 'opt':
      return x === null ? null : validate(ty.of, x, loc)
    case 'tuple':
      if (!Array.isArray(x)) fail('tuple_type', loc, 'Input should be a valid tuple')
      return Object.freeze(x.map((v, i) => validate(ty.of, v, [...loc, i])))
    case 'dict': {
      // a mapping: a JSON object, or a Map the Python builds as a dict
      if (!isPlainObject(x) && !(x instanceof Map)) fail('dict_type', loc, 'Input should be a valid dictionary')
      const out = new Map<string, unknown>()
      const entries = x instanceof Map ? [...x] as [string, unknown][] : pyEntries(x as Record<string, unknown>)
      for (const [k, v] of entries) out.set(k, validate(ty.of, v, [...loc, k]))
      return out
    }
    case 'model':
      // a model instance is taken as it is (pydantic's revalidate_instances="never")
      if (x !== null && typeof x === 'object' && INSTANCES.get(x) === ty.def()) return x
      return validateModel(ty.def(), x, loc)
  }
}

/** The models made by validation or construction, and their definitions */
const INSTANCES = new WeakMap<object, ModelDef>()

function validateModel(def: ModelDef, x: unknown, loc: Loc): object {
  if (!isPlainObject(x)) fail('model_type', loc, `Input should be a valid dictionary or instance of ${def.name}`)
  const obj: Record<string, unknown> = {}
  for (const f of def.fields) {
    if (!Object.prototype.hasOwnProperty.call(x, f.name)) {
      if (!f.def) fail('missing', [...loc, f.name], 'Field required')
      obj[f.name] = f.def()
      continue
    }
    const v = validate(f.ty, x[f.name], [...loc, f.name])
    if (f.check) runCheck(() => f.check!(v), [...loc, f.name])
    obj[f.name] = v
  }
  const names = new Set(def.fields.map((f) => f.name))
  for (const [k] of pyEntries(x)) {
    if (!names.has(k)) fail('extra_forbidden', [...loc, k], 'Extra inputs are not permitted')
  }
  if (def.check) runCheck(() => def.check!(obj), loc)
  const made = Object.freeze(obj)
  INSTANCES.set(made, def)
  return made
}

function parseModel<T>(def: ModelDef, x: unknown): T {
  return validateModel(def, x, []) as T
}

/** Project.model_validate(data): the project, or the first ValidationError pydantic would raise. */
export const parseProject = (data: unknown): Project => parseModel<Project>(PROJECT, data)
export const parseSettings = (data: unknown): Settings => parseModel<Settings>(SETTINGS, data)
export const parseLabels = (data: unknown): Labels => parseModel<Labels>(LABELS, data)
export const parseModule = (data: unknown): Module => parseModel<Module>(MODULE, data)
export const parseBenefitSpec = (data: unknown): BenefitSpec => parseModel<BenefitSpec>(BENEFIT_SPEC, data)
export const parseModuleValues = (data: unknown): ModuleValues => parseModel<ModuleValues>(MODULE_VALUES, data)
export const parseCostCategory = (data: unknown): CostCategory => parseModel<CostCategory>(COST_CATEGORY, data)
export const parseRecurringItem = (data: unknown): RecurringItem => parseModel<RecurringItem>(RECURRING_ITEM, data)
export const parseCosts = (data: unknown): Costs => parseModel<Costs>(COSTS, data)
export const parseAlternative = (data: unknown): Alternative => parseModel<Alternative>(ALTERNATIVE, data)
export const parseSite = (data: unknown): Site => parseModel<Site>(SITE, data)
export const parseRule = (data: unknown): Rule => parseModel<Rule>(RULE, data)
export const parseWatershedSpec = (data: unknown): WatershedSpec => parseModel<WatershedSpec>(WATERSHED_SPEC, data)
export const parseSiteDecision = (data: unknown): SiteDecision => parseModel<SiteDecision>(SITE_DECISION, data)
export const parseFinalArrayChoice = (data: unknown): FinalArrayChoice => parseModel<FinalArrayChoice>(FINAL_ARRAY_CHOICE, data)
export const parseStepNote = (data: unknown): StepNote => parseModel<StepNote>(STEP_NOTE, data)
export const parseDecisions = (data: unknown): Decisions => parseModel<Decisions>(DECISIONS, data)
export const parseReportSettings = (data: unknown): ReportSettings => parseModel<ReportSettings>(REPORT_SETTINGS, data)

// --- Model(**kwargs), and pydantic's text when it fails ------------------------------------------------

/** One error of a ValidationError as str() lists it. */
export interface ErrorDetail {
  readonly loc: readonly (string | number)[]
  readonly msg: string
  readonly type: string
  /** the input's Python repr, before truncation */
  readonly input: string
  readonly inputType: string
}

/** pydantic 2.13 shortens a long input: past 50 bytes (UTF-8), the first 25 and the last 24 bytes, each
 * cut back to whole characters. */
function truncateInput(s: string): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= 50) return s
  let head = 25
  while (head > 0 && (bytes[head] & 0xc0) === 0x80) head--
  let tail = bytes.length - 24
  while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++
  const dec = new TextDecoder()
  return `${dec.decode(bytes.subarray(0, head))}...${dec.decode(bytes.subarray(tail))}`
}

/** str(ValidationError): "1 validation error for Site", then each error with its place, words, type and
 * input. */
export function validationText(title: string, errors: readonly ErrorDetail[]): string {
  let out = `${errors.length} validation error${errors.length === 1 ? '' : 's'} for ${title}`
  for (const e of errors) {
    if (e.loc.length) out += `\n${e.loc.join('.')}`
    out += `\n  ${e.msg} [type=${e.type}, input_value=${truncateInput(e.input)}, input_type=${e.inputType}]`
    out += `\n    For further information visit https://errors.pydantic.dev/2.13/v/${e.type}`
  }
  return out
}

/** What a model's constructor raises: pydantic's ValidationError (a ValueError), its str() pydantic's. */
export class PydanticError extends Error {
  constructor(readonly title: string, readonly errors: readonly ErrorDetail[]) {
    super(validationText(title, errors))
  }
}

const reprStr = pyStrRepr

/** A value's Python repr as the field's type holds it (a float field's number as a float). */
function reprTyped(ty: Ty, v: unknown): string {
  if (v === null || v === undefined) return 'None'
  switch (ty.k) {
    case 'float':
      return typeof v === 'number' ? pyFloat(v) : reprTyped({ k: 'str' }, v)
    case 'int':
      return String(v)
    case 'bool':
      return v ? 'True' : 'False'
    case 'str':
    case 'lit':
      return typeof v === 'string' ? reprStr(v) : String(v)
    case 'opt':
      return reprTyped(ty.of, v)
    case 'tuple': {
      const items = (v as readonly unknown[]).map((x) => reprTyped(ty.of, x))
      return items.length === 1 ? `(${items[0]},)` : `(${items.join(', ')})`
    }
    case 'dict': {
      const entries = v instanceof Map ? [...v] as [string, unknown][] : pyEntries(v as Record<string, unknown>)
      return `{${entries.map(([k, x]) => `${reprStr(k)}: ${reprTyped(ty.of, x)}`).join(', ')}}`
    }
    case 'model': {
      const def = ty.def()
      const o = v as Record<string, unknown>
      return `${def.name}(${def.fields.map((f) => `${f.name}=${reprTyped(f.ty, o[f.name])}`).join(', ')})`
    }
  }
}

/** Python's type name of an input of this field type */
function typeName(ty: Ty, v: unknown): string {
  if (v === null || v === undefined) return 'NoneType'
  switch (ty.k) {
    case 'opt':
      return typeName(ty.of, v)
    case 'model':
      return ty.def().name
    case 'lit':
      return 'str'
    default:
      return ty.k
  }
}

/** repr() of a value json.loads gave (its floats as the text wrote them) */
function reprJson(v: unknown, float: boolean): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return float || !Number.isInteger(v) ? pyFloat(v) : String(v)
  if (typeof v === 'string') return reprStr(v)
  if (Array.isArray(v)) return `[${v.map((x, i) => reprJson(x, isMarkedFloat(v, i))).join(', ')}]`
  const o = v as Record<string, unknown>
  return `{${pyEntries(o).map(([k, x]) => `${reprStr(k)}: ${reprJson(x, isMarkedFloat(o, k))}`).join(', ')}}`
}

const jsonType = (v: unknown, float: boolean): string => (v === null || v === undefined ? 'NoneType' : typeof v === 'boolean' ? 'bool'
  : typeof v === 'number' ? (float || !Number.isInteger(v) ? 'float' : 'int') : typeof v === 'string' ? 'str' : Array.isArray(v) ? 'list' : 'dict')

/** str() of the ValidationError pydantic raises for ``data`` that fails as ``exc`` reports (its first error
 * only), with the input at the error's place as json.loads gave it. */
export function validationErrorText(exc: ValidationError, data: unknown, title = 'Project'): string {
  const loc = exc.type === 'missing' ? exc.loc.slice(0, -1) : exc.loc
  let at: unknown = data
  let container: object | null = null
  let key: string | number = ''
  for (const step of loc) {
    if (at === null || typeof at !== 'object') break
    container = at as object
    key = step
    at = Array.isArray(at) ? at[step as number] : (at as Record<string, unknown>)[String(step)]
  }
  const float = container !== null && isMarkedFloat(container, key)
  return validationText(title, [{ loc: exc.loc, msg: exc.msg, type: exc.type, input: reprJson(at, float), inputType: jsonType(at, float) }])
}

const MODELS: Record<string, ModelDef> = {
  Settings: SETTINGS, Labels: LABELS, Module: MODULE, BenefitSpec: BENEFIT_SPEC, ModuleValues: MODULE_VALUES, CostCategory: COST_CATEGORY,
  RecurringItem: RECURRING_ITEM, Costs: COSTS, Alternative: ALTERNATIVE, Site: SITE, Project: PROJECT,
}

/** Model(**kwargs) as pydantic builds it from values of the fields' own types: every field is checked
 * and each failing field reported, then (when all pass) the model's own check, whose input is the
 * keyword arguments. Throws PydanticError. */
export function construct<T>(name: keyof typeof MODELS, kwargs: Record<string, unknown>): T {
  const def = MODELS[name]
  const errors: ErrorDetail[] = []
  const obj: Record<string, unknown> = {}
  for (const f of def.fields) {
    if (!Object.prototype.hasOwnProperty.call(kwargs, f.name)) {
      obj[f.name] = f.def!()
      continue
    }
    const x = kwargs[f.name]
    try {
      const v = validate(f.ty, x, [f.name])
      if (f.check) runCheck(() => f.check!(v), [f.name])
      obj[f.name] = v
    } catch (exc) {
      if (!(exc instanceof ValidationError)) throw exc
      // the input at the error's place: the field's, or an item inside it
      let ty = f.ty
      let at: unknown = x
      for (const step of exc.loc.slice(1)) {
        while (ty.k === 'opt') ty = ty.of
        if (ty.k === 'tuple' && typeof step === 'number') {
          at = (at as readonly unknown[])[step]
          ty = ty.of
        } else if (ty.k === 'dict') {
          at = at instanceof Map ? at.get(String(step)) : (at as Record<string, unknown>)[String(step)]
          ty = ty.of
        } else if (ty.k === 'model') {
          const fd = ty.def().fields.find((g) => g.name === step)!
          at = (at as Record<string, unknown>)[String(step)]
          ty = fd.ty
        }
      }
      errors.push({ loc: exc.loc, msg: exc.msg, type: exc.type, input: reprTyped(ty, at), inputType: typeName(ty, at) })
    }
  }
  if (!errors.length && def.check) {
    try {
      def.check(obj)
    } catch (exc) {
      if (!(exc instanceof ValueError)) throw exc
      const fields = new Map(def.fields.map((f) => [f.name, f.ty]))
      const input = `{${Object.keys(kwargs).map((k) => `${reprStr(k)}: ${reprTyped(fields.get(k)!, kwargs[k])}`).join(', ')}}`
      errors.push({ loc: [], msg: `Value error, ${exc.message}`, type: 'value_error', input, inputType: 'dict' })
    }
  }
  if (errors.length) throw new PydanticError(def.name, errors)
  const made = Object.freeze(obj)
  INSTANCES.set(made, def)
  return made as T
}

// --- model_dump(mode="json") ---------------------------------------------------------------------

/** One value as JSON, its floats marked in ``container`` at ``key`` so pyDumps writes them as
 * Python floats (50.0, not 50). */
function dumpValue(ty: Ty, v: unknown, container: object, key: string | number): unknown {
  switch (ty.k) {
    case 'float':
      markFloat(container, key)
      return v
    case 'opt':
      return v === null ? null : dumpValue(ty.of, v, container, key)
    case 'tuple': {
      const arr: unknown[] = []
      ;(v as readonly unknown[]).forEach((item, i) => {
        arr.push(dumpValue(ty.of, item, arr, i))
      })
      return arr
    }
    case 'dict': {
      const out: Record<string, unknown> = {}
      for (const [k, item] of v as ReadonlyMap<string, unknown>) {
        Object.defineProperty(out, k, { value: dumpValue(ty.of, item, out, k), writable: true,
          enumerable: true, configurable: true })
      }
      return out
    }
    case 'model':
      return dumpModel(ty.def(), v as Record<string, unknown>)
    default:
      return v
  }
}

function dumpModel(def: ModelDef, obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of def.fields) out[f.name] = dumpValue(f.ty, obj[f.name], out, f.name)
  return out
}

/** project.model_dump(mode="json"): plain JSON, floats marked for pyDumps. */
export const dumpProject = (p: Project): Record<string, unknown> =>
  dumpModel(PROJECT, p as unknown as Record<string, unknown>)

/** rule.model_dump() (the watershed fingerprint takes the rules this way). */
export const dumpRule = (r: Rule): Record<string, unknown> =>
  dumpModel(RULE, r as unknown as Record<string, unknown>)

// --- defaults and words --------------------------------------------------------------------------

export const DEFAULT_COST_CATEGORIES: readonly CostCategory[] = Object.freeze([
  parseCostCategory({ id: 'construction', name: 'Construction', idc_applies: true }),
  parseCostCategory({ id: 'monitoring', name: 'Monitoring' }),
  parseCostCategory({ id: 'adaptive_management', name: 'Adaptive management' }),
])

/** STAF outputs are condition units (ECI x quantity), not habitat units. */
export const STAF_LABELS: Labels = parseLabels({
  output_name: 'Condition units', output_short: 'CU',
  annual_output_name: 'Average annual condition units', annual_output_short: 'AACU',
  lift_name: 'Condition lift',
})

/** The words for a new project's output measure, from its first module's method. */
export function defaultLabels(method: string): Labels {
  return method === 'STAF' ? STAF_LABELS : parseLabels({})
}

const isLower = (c: string): boolean => c !== c.toUpperCase() && c === c.toLowerCase()

/** ``text`` as it reads inside a sentence: "Habitat units" becomes "habitat units". A word that
 * starts like an acronym or a symbol ("SVU", "pH units", "H2O units", "X") stays as it is. */
export function lowerFirst(text: string): string {
  if (text.length > 1 && isLower(text[1])) return text[0].toLowerCase() + text.slice(1)
  return text
}

/** The average annual words that follow from an output's name and abbreviation, as a Labels
 * update: "Habitat units" and "HU" give "Average annual habitat units" and "AAHU". */
export function averageAnnual(outputName: string, outputShort: string): Pick<Labels, 'annual_output_name' | 'annual_output_short'> {
  return { annual_output_name: `Average annual ${lowerFirst(outputName)}`, annual_output_short: `AA${outputShort}` }
}

// --- composition keys ----------------------------------------------------------------------------

/** Which alternative each site in a plan carries, in the space's site order. */
export type Composition = ReadonlyMap<string, string>

/** Canonical key for a watershed plan: "site=alt" pairs sorted by site id, joined by ';'.
 *
 * The No Action plan (every site at No Action) is the empty string. */
export function compositionKey(composition: Composition | null | undefined): string {
  if (!composition || composition.size === 0) return ''
  return [...composition.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([s, a]) => `${s}=${a}`).join(';')
}

export function parseCompositionKey(key: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!key) return out
  for (const part of key.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) out.set(part, '')
    else out.set(part.slice(0, i), part.slice(i + 1))
  }
  return out
}
