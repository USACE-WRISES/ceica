// Input checks. Every issue names the place and the fix in plain words (ceica/validate.py).
//
// Errors block only what they affect (usually one site); warnings never block. Decision checks
// (stale recommendations, the final array, the TSP) live in decisions.ts.
import { pyG } from '../py/pyfmt'
import { pySum } from '../py/pynum'
import { functionIds, outcomeMax, OUTCOMES } from './benefits/staf'
import { allAnnual, byYear, noAction, notAssessed, type Project } from './model'

export type Level = 'error' | 'warning'

export interface Issue {
  readonly level: Level
  readonly code: string
  readonly message: string
  /** Where it is: section ("study", "sites", "benefits", "costs", "watershed", "decisions"), plus
   * the site and alternative when they apply. */
  readonly section: string
  readonly site_id: string | null
  readonly alt_id: string | null
}

export function issue(level: Level, code: string, message: string, section = 'study',
  siteId: string | null = null, altId: string | null = null): Issue {
  return Object.freeze({ level, code, message, section, site_id: siteId, alt_id: altId })
}

/** Checks on the inputs alone (no results needed). */
export function checkProject(project: Project): Issue[] {
  const out: Issue[] = []
  const st = project.settings
  const spec = project.benefits
  const years = spec.target_years

  if (!project.sites.length) {
    out.push(issue('error', 'E_NO_SITES', 'Add at least one site with alternatives.', 'sites'))
  }
  if (!(st.discount_rate >= 0.005 && st.discount_rate <= 0.08)) {
    out.push(issue('warning', 'W_RATE_RANGE',
      `The discount rate is ${pyG(st.discount_rate * 100)} percent; the federal `
      + 'water resources rate is usually between 2 and 7 percent.', 'study'))
  }
  if (spec.modules.some(byYear)) {
    if (years[0] !== 0 || years[years.length - 1] !== st.period_of_analysis) {
      out.push(issue('warning', 'W_YEARS_SPAN',
        `Target years run from ${pyG(years[0])} to ${pyG(years[years.length - 1])}; outputs are `
        + `averaged over that span, but the period of analysis is ${st.period_of_analysis} years.`,
        'study'))
    }
    if (st.aahu_method === 'IWR_YEARLY_2DP' && (years.some((y) => y !== Math.trunc(y))
      || years[0] < 0 || years[years.length - 1] > st.period_of_analysis)) {
      out.push(issue('error', 'E_IWR_YEARS',
        'The IWR Annualizer method needs whole target years from 0 to the period of analysis.',
        'study'))
    }
  }
  const stafModules = spec.modules.filter((m) => m.method === 'STAF')
  if (stafModules.length) {
    for (const site of project.sites) {
      for (const m of stafModules) {
        const off = new Set(notAssessed(site, m.id))
        const assessed = functionIds().filter((f) => !off.has(f))
        const mx = outcomeMax(spec.staf_mapping, assessed)
        for (const o of OUTCOMES) {
          if (mx[o] <= 0) {
            out.push(issue('error', 'E_STAF_OUTCOME',
              `At ${site.id}, no assessed function in ${m.name} feeds the ${o} outcome, so the ECI `
              + 'cannot be computed.', 'benefits', site.id))
          }
        }
      }
    }
  }

  const seen = new Map<string, string>()
  for (const site of project.sites) {
    const key = site.id.toLowerCase()
    if (seen.has(key) && seen.get(key) !== site.id) {
      out.push(issue('error', 'E_SITE_CASE',
        `Sites ${seen.get(key)} and ${site.id} differ only in capital letters; rename one (Excel `
        + 'treats them as the same).', 'sites', site.id))
    }
    if (!seen.has(key)) seen.set(key, site.id)
  }
  for (const site of project.sites) {
    if (!site.alternatives.length) {
      out.push(issue('error', 'E_SITE_EMPTY', `Site ${site.id} has no alternatives.`, 'sites', site.id))
      continue
    }
    if (site.alternatives.length === 1) {
      out.push(issue('warning', 'W_SITE_ONLY_NA',
        `Site ${site.id} has only No Action; add alternatives to analyze it.`, 'sites', site.id))
    }
    const na = noAction(site)
    if (na !== null) {
      const fc = pySum([...na.costs.first_costs.values()].map(Math.abs))
      if (fc > 0 || na.costs.recurring.length || (na.costs.annual_override ?? 0) !== 0) {
        out.push(issue('warning', 'W_NA_COST',
          `No Action at ${site.id} has costs; CE/ICA uses each alternative's cost above No Action.`,
          'costs', site.id, na.id))
      }
    }
    for (const alt of site.alternatives) {
      const c = alt.costs
      for (const [key, v] of c.first_costs) {
        if (v < 0) {
          out.push(issue('error', 'E_NEG_COST', `${site.id}, ${alt.id}: ${key} cost is negative.`,
            'costs', site.id, alt.id))
        }
      }
      const idcBase = pySum(project.cost_categories.filter((cat) => cat.idc_applies)
        .map((cat) => c.first_costs.get(cat.id) ?? 0.0))
      if (!alt.is_no_action && idcBase > 0 && c.construction_months === 0
        && c.annual_override === null && st.discount_rate > 0) {
        out.push(issue('warning', 'W_IDC_NO_MONTHS',
          `${site.id}, ${alt.id}: construction has no duration, so no interest during construction `
          + 'is charged.', 'costs', site.id, alt.id))
      }
      if (allAnnual(spec) && c.annual_override === null && !alt.is_no_action && c.first_costs.size === 0) {
        out.push(issue('error', 'E_NO_COST', `${site.id}, ${alt.id}: enter an average annual cost.`,
          'costs', site.id, alt.id))
      }
    }
  }

  const siteIds = new Set(project.sites.map((s) => s.id))
  for (const rule of project.watershed.rules) {
    for (const sid of [rule.site_id, ...rule.with_sites]) {
      if (!siteIds.has(sid)) {
        out.push(issue('warning', 'W_RULE_SITE',
          `A plan formation rule names site ${sid}, which is not in the study.`, 'watershed', sid))
      }
    }
  }
  return out
}
