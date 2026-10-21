// Modules: how an alternative's values become its output at each target year
// (ceica/benefits/__init__.py).
//
// Every module has a method (ModuleMethod in model.ts):
//
// * HU: the output entered at each target year.
// * INDEX_X_QUANTITY: an index (0 to 1) and a quantity at each target year; output = index x
//   quantity (Utoy's riparian and instream modules, or HSI x acres).
// * STAF: STAF function scores at each target year roll up to the Ecosystem Condition Index
//   (staf.ts); output = ECI x quantity ("condition units").
// * AAHU: the average annual output entered directly; there is no yearly series.
//
// The alternative's output is the sum of its modules (annualize.ts).
import { pyG } from '../../py/pyfmt'
import { type Alternative, type Module, notAssessed, type Project, type Site, valuesFor } from '../model'
import { functionIds, rollup, type Rollup } from './staf'

function pad(vals: readonly (number | null)[], n: number): (number | null)[] {
  const out = vals.slice(0, n)
  while (out.length < n) out.push(null)
  return out
}

/** The STAF roll-up at each target year for one alternative and STAF module. */
export function stafRollups(project: Project, site: Site, alt: Alternative, moduleId: string): Rollup[] {
  const n = project.benefits.target_years.length
  const off = new Set(notAssessed(site, moduleId))
  const assessed = functionIds().filter((f) => !off.has(f))
  const mv = valuesFor(alt, moduleId)
  const scores = mv ? mv.scores : new Map<string, readonly (number | null)[]>()
  const out: Rollup[] = []
  for (let i = 0; i < n; i++) {
    const atYear = new Map(assessed.map((f) => [f, pad(scores.get(f) ?? [], n)[i]]))
    out.push(rollup(atYear, project.benefits.staf_mapping, assessed))
  }
  return out
}

/** One module's output at each target year (null for an average-annual module) and what is
 * missing, in words. */
export function moduleSeries(project: Project, site: Site, alt: Alternative, module: Module):
  [(number | null)[] | null, string[]] {
  const years = project.benefits.target_years
  const n = years.length
  const where = `${site.id}, ${alt.name || alt.id}`
  const mv = valuesFor(alt, module.id)
  const missing: string[] = []
  if (module.method === 'AAHU') {
    if (mv === null || mv.aahu === null) missing.push(`${where}: ${module.name} average annual value is empty`)
    return [null, missing]
  }
  const out: (number | null)[] = []
  if (module.method === 'STAF') {
    const rolls = stafRollups(project, site, alt, module.id)
    const qty = pad(mv ? mv.quantity : [], n)
    years.forEach((year, i) => {
      const r = rolls[i]
      const q = qty[i]
      if (r.eci === null) {
        missing.push(`${where}: ${module.name} function scores are incomplete for year ${pyG(year)}`)
        out.push(null)
      } else if (q === null) {
        missing.push(`${where}: ${module.name} quantity is empty for year ${pyG(year)}`)
        out.push(null)
      } else out.push(r.eci * q)
    })
    return [out, missing]
  }
  const values = pad(mv ? mv.values : [], n)
  if (module.method === 'INDEX_X_QUANTITY') {
    const qty = pad(mv ? mv.quantity : [], n)
    years.forEach((year, i) => {
      const v = values[i]
      const q = qty[i]
      if (v === null || q === null) {
        missing.push(`${where}: ${module.name} is empty for year ${pyG(year)}`)
        out.push(null)
      } else out.push(v * q)
    })
    return [out, missing]
  }
  years.forEach((year, i) => {
    if (values[i] === null) missing.push(`${where}: ${module.name} is empty for year ${pyG(year)}`)
  })
  return [values, missing]
}

/** Output at each target year for every module entered by year, and what is missing. */
export function alternativeSeries(project: Project, site: Site, alt: Alternative):
  [Map<string, (number | null)[]>, string[]] {
  const series = new Map<string, (number | null)[]>()
  const missing: string[] = []
  for (const module of project.benefits.modules) {
    const [s, miss] = moduleSeries(project, site, alt, module)
    if (s !== null) series.set(module.id, s)
    missing.push(...miss)
  }
  return [series, missing]
}
