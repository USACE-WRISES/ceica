// STAF template: the Stream Tiered Assessment Framework roll-up, functions to outcomes to ECI
// (ceica/benefits/staf.py).
//
// Twenty stream functions are scored 0 to 15. Each function drives the three Clean Water Act
// outcomes directly (D, weight 1.0), indirectly (i, weight 0.1) or not at all (-, weight 0). Each
// outcome's sub-index is the weighted score over its maximum; the Ecosystem Condition Index (ECI)
// is the mean of the three raw sub-indices. Rounding is for display only.
//
// Two mappings exist: "A" (the STAF documentation, EASI and DEEP) and "B" (the SFARI calculator).
// The tables are copies of ceica/benefits/staf_data (web/parity/sources.json).
//
// For CE/ICA a site's assessed functions stay fixed across its alternatives and years, so the ECI
// is linear in the scores: ECI = sum_f c_f * score_f. ``coefficients`` gives c_f, which splits any
// change in ECI exactly into per-function and per-outcome contributions.
import { pyRoundInt, pySum } from '../../py/pynum'
import functionsJson from './staf_data/functions.json'
import mappingA from './staf_data/mapping_a.json'
import mappingB from './staf_data/mapping_b.json'

export const FUNCTION_SCORE_MAX = 15.0
export const WEIGHTS: Readonly<Record<string, number>> = { D: 1.0, i: 0.1, '-': 0.0 }
export const OUTCOMES = ['physical', 'chemical', 'biological'] as const
export type Outcome = typeof OUTCOMES[number]
export const OUTCOME_LABELS: Readonly<Record<Outcome, string>> = {
  physical: 'Physical', chemical: 'Chemical', biological: 'Biological',
}
export const CATEGORIES = ['Hydrology', 'Hydraulics', 'Geomorphology', 'Physicochemistry', 'Biology'] as const
export const MAPPINGS = { A: 'mapping_a.json', B: 'mapping_b.json' } as const
export const MAPPING_LABELS = { A: 'STAF documentation, EASI and DEEP (A)', B: 'SFARI calculator (B)' } as const

/** Condition bands on the 0-1 indices: upper bound (inclusive) and label. */
export const INDEX_BANDS: readonly (readonly [number, string])[] = [
  [0.39, 'Non-Functioning'], [0.69, 'Functioning-at-Risk'], [Infinity, 'Functioning']]
/** Function-score bands on 0-15. */
export const FUNCTION_SCORE_BANDS: readonly (readonly [number, string])[] = [
  [5.0, 'Non-Functioning'], [10.0, 'Functioning-at-Risk'], [Infinity, 'Functioning']]
export const BAND_COLORS: Readonly<Record<string, string>> = {
  'Non-Functioning': '#f5b5b5', 'Functioning-at-Risk': '#f5e7a6', Functioning: '#c8d9f2',
}
export const OUTCOME_COLORS: Readonly<Record<Outcome, string>> = {
  physical: '#3b6d9c', chemical: '#9a7332', biological: '#327a50',
}

export interface StafFunction {
  readonly id: string
  readonly category: string
  readonly name: string
  readonly short_description: string
}

let FUNCTIONS: readonly StafFunction[] | null = null

export function functions(): readonly StafFunction[] {
  FUNCTIONS ??= Object.freeze((functionsJson as unknown as Record<string, string>[]).map((f) => Object.freeze({
    id: f.id, category: f.category, name: f.name, short_description: f.short_description ?? '',
  })))
  return FUNCTIONS
}

export const functionIds = (): string[] => functions().map((f) => f.id)

const MAPPING_CACHE = new Map<string, ReadonlyMap<string, Readonly<Record<Outcome, string>>>>()

/** Function id to {outcome: 'D' | 'i' | '-'}. */
export function mapping(variant = 'A'): ReadonlyMap<string, Readonly<Record<Outcome, string>>> {
  let m = MAPPING_CACHE.get(variant)
  if (!m) {
    const raw = (variant === 'A' ? mappingA : variant === 'B' ? mappingB : null) as
      Record<string, string>[] | null
    if (!raw) throw new RangeError(`unknown STAF mapping ${variant}`)
    m = new Map(raw.map((r) => [r.id, { physical: r.physical, chemical: r.chemical, biological: r.biological }]))
    MAPPING_CACHE.set(variant, m)
  }
  return m
}

function assessedOf(assessed: Iterable<string> | null | undefined): string[] {
  const ids = functionIds()
  if (assessed === null || assessed === undefined) return ids
  const keep = new Set(assessed)
  return ids.filter((f) => keep.has(f))
}

/** Sum of 15 x weight per outcome over the assessed functions. */
export function outcomeMax(variant = 'A', assessed: Iterable<string> | null = null): Record<Outcome, number> {
  const m = mapping(variant)
  const fs = assessedOf(assessed)
  const out = {} as Record<Outcome, number>
  for (const o of OUTCOMES) out[o] = pySum(fs.map((f) => FUNCTION_SCORE_MAX * WEIGHTS[m.get(f)![o]]))
  return out
}

export interface Rollup {
  /** Raw sub-index per outcome (null when no assessed function feeds the outcome). */
  readonly sub_indices: Readonly<Record<Outcome, number | null>>
  /** Mean of the three raw sub-indices (null if any is null or a score is missing). */
  readonly eci: number | null
  readonly weighted: Readonly<Record<Outcome, number>>
  readonly max: Readonly<Record<Outcome, number>>
}

/** Sub-indices and ECI for one set of function scores.
 *
 * Functions outside ``assessed`` are left out of both sums (the EASI/DEEP rule). A missing score
 * for an assessed function makes the ECI null: CE/ICA needs every assessed function scored. */
export function rollup(scores: ReadonlyMap<string, number | null>, variant = 'A',
  assessed: Iterable<string> | null = null): Rollup {
  const m = mapping(variant)
  const fs = assessedOf(assessed)
  const weighted = { physical: 0.0, chemical: 0.0, biological: 0.0 }
  const mx = outcomeMax(variant, fs)
  let missing = false
  for (const f of fs) {
    const s = scores.get(f)
    if (s === null || s === undefined) {
      missing = true
      continue
    }
    for (const o of OUTCOMES) weighted[o] += s * WEIGHTS[m.get(f)![o]]
  }
  const subs = {} as Record<Outcome, number | null>
  for (const o of OUTCOMES) subs[o] = mx[o] > 0 ? weighted[o] / mx[o] : null
  const vals = OUTCOMES.map((o) => subs[o])
  const eci = missing || vals.some((v) => v === null)
    ? null
    : pySum(vals.filter((v): v is number => v !== null)) / 3.0
  return { sub_indices: subs, eci, weighted, max: mx }
}

/** ECI per score point, split by outcome: {function: {outcome: c_fo}}.
 *
 * ECI = sum over f and o of c_fo * score_f, with c_fo = w_fo / (3 * max_o). Summing over outcomes
 * gives the function's total coefficient. */
export function coefficients(variant = 'A', assessed: Iterable<string> | null = null):
  Map<string, Record<Outcome, number>> {
  const m = mapping(variant)
  const fs = assessedOf(assessed)
  const mx = outcomeMax(variant, fs)
  const out = new Map<string, Record<Outcome, number>>()
  for (const f of fs) {
    const row = {} as Record<Outcome, number>
    for (const o of OUTCOMES) row[o] = mx[o] > 0 ? WEIGHTS[m.get(f)![o]] / (3.0 * mx[o]) : 0.0
    out.set(f, row)
  }
  return out
}

/** Condition band of a 0-1 index (sub-index or ECI), on the value rounded to 2 decimals. */
export function band(index: number | null): string | null {
  if (index === null) return null
  const v = pyRoundInt(index * 100) / 100
  for (const [upper, label] of INDEX_BANDS) if (v <= upper) return label
  return INDEX_BANDS[INDEX_BANDS.length - 1][1]
}

export function functionBand(score: number | null): string | null {
  if (score === null) return null
  for (const [upper, label] of FUNCTION_SCORE_BANDS) if (score <= upper) return label
  return FUNCTION_SCORE_BANDS[FUNCTION_SCORE_BANDS.length - 1][1]
}

/** STAF's display rounding (Python's round, so halves go to even). */
export function round2(v: number | null): number | null {
  return v === null ? null : pyRoundInt(v * 100) / 100
}
