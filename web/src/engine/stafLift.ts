// STAF lift decomposition: how much of an alternative's lift each function and outcome carries
// (ceica/staf_lift.py).
//
// For a fixed assessed set the ECI is linear in the scores, ECI = sum_f sum_o c_fo * s_f, so the
// time-averaged condition units split exactly: lift = sum_f sum_o c_fo * A(q * (s_f - s_f,NA)),
// where A is the time average and q the quantity at each year. The pieces sum to the lift.
import { pySum } from '../py/pynum'
import { timeAverage } from './annualize'
import { coefficients, functionIds, OUTCOMES, type Outcome } from './benefits/staf'
import {
  type Alternative, alternativeOf, type Module, noAction, notAssessed, type ModuleValues, type Project,
  type Site, siteOf, valuesFor,
} from './model'

export interface FunctionLift {
  /** Lift contributed by each function (condition units, time-averaged). */
  readonly functions: ReadonlyMap<string, number>
  /** Lift contributed through each outcome. */
  readonly outcomes: Readonly<Record<Outcome, number>>
  readonly total: number
}

/** What the decomposition needs of the analysis results. */
export interface HasProject {
  readonly project: Project
}

function moduleLift(res: HasProject, site: Site, alt: Alternative, na: Alternative, module: Module): FunctionLift | null {
  const p = res.project
  const years = [...p.benefits.target_years]
  const off = new Set(notAssessed(site, module.id))
  const assessed = functionIds().filter((f) => !off.has(f))
  const coef = coefficients(p.benefits.staf_mapping, assessed)
  const st = p.settings
  const va = valuesFor(alt, module.id)
  const vn = valuesFor(na, module.id)
  if (va === null || vn === null) return null

  const series = (mv: ModuleValues, f: string): number[] | null => {
    const sc = mv.scores.get(f) ?? []
    const q = mv.quantity
    const vals: number[] = []
    for (let i = 0; i < years.length; i++) {
      const s = i < sc.length ? sc[i] : null
      const qq = i < q.length ? q[i] : null
      if (s === null || qq === null) return null
      vals.push(s * qq)
    }
    return vals
  }

  const funcs = new Map<string, number>()
  const outs = { physical: 0.0, chemical: 0.0, biological: 0.0 }
  for (const f of assessed) {
    const aS = series(va, f)
    const nS = series(vn, f)
    if (aS === null || nS === null) return null
    const diff = aS.map((x, i) => x - nS[i])
    const avg = timeAverage(years, diff, { method: st.aahu_method, poa: st.period_of_analysis })
    const c = coef.get(f)!
    funcs.set(f, pySum(OUTCOMES.map((o) => c[o])) * avg)
    for (const o of OUTCOMES) outs[o] += c[o] * avg
  }
  return { functions: funcs, outcomes: outs, total: pySum(funcs.values()) }
}

function combine(parts: readonly FunctionLift[]): FunctionLift {
  const funcs = new Map<string, number>()
  const outs = { physical: 0.0, chemical: 0.0, biological: 0.0 }
  for (const fl of parts) {
    for (const [f, v] of fl.functions) funcs.set(f, (funcs.get(f) ?? 0.0) + v)
    for (const o of OUTCOMES) outs[o] += fl.outcomes[o]
  }
  return { functions: funcs, outcomes: outs, total: pySum(funcs.values()) }
}

/** Lift of one alternative split by function and outcome, for one STAF module or (without
 * ``moduleId``) added up over every STAF module. */
export function siteFunctionLift(res: HasProject, siteId: string, altId: string,
  moduleId: string | null = null): FunctionLift | null {
  const p = res.project
  const mods = p.benefits.modules.filter((m) => m.method === 'STAF' && (moduleId === null || m.id === moduleId))
  const site = siteOf(p, siteId)
  if (!mods.length || site === null) return null
  const alt = alternativeOf(site, altId)
  const na = noAction(site)
  if (alt === null || na === null) return null
  const parts = mods.map((m) => moduleLift(res, site, alt, na, m))
  if (parts.some((x) => x === null)) return null
  return combine(parts as FunctionLift[])
}

/** Function and outcome lift of a watershed plan: the sum over its site actions. */
export function planFunctionLift(res: HasProject, composition: ReadonlyMap<string, string>): FunctionLift | null {
  const parts: FunctionLift[] = []
  for (const [sid, aid] of composition) {
    const fl = siteFunctionLift(res, sid, aid)
    if (fl === null) return null
    parts.push(fl)
  }
  return combine(parts)
}
