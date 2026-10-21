// The workflow's four stages and their status, for the sidebar, the stage strip and readiness
// (ceica/run_state.py).
//
// Status values: "done" (a check), "attention" (an amber count), "locked" (nothing to show yet) and
// "" (in progress, nothing to flag). Every stage stays clickable; a locked stage explains why.
import type { AnalysisResults } from './analysis'
import { nStale, nSuggested } from './decisions'
import type { Project } from './model'

export const STAGES = ['inputs', 'sites', 'watershed', 'report'] as const
export type Stage = typeof STAGES[number]
export const LABELS: Readonly<Record<Stage, string>> = {
  inputs: 'Inputs', sites: 'Sites', watershed: 'Watershed', report: 'Report',
}
export const HELP: Readonly<Record<Stage, string>> = {
  inputs: 'Study settings, sites and alternatives, benefits over time and costs.',
  sites: 'Site-by-site CE/ICA: choose the alternative each site carries forward.',
  watershed: 'Combinations of the site actions, the final array and the tentatively selected plan.',
  report: 'Figures, tables and documents to download.',
}
export const INPUT_SECTIONS: readonly (readonly [string, string])[] = [
  ['study', 'Study'], ['sites', 'Sites and alternatives'], ['benefits', 'Benefits'], ['costs', 'Costs'],
  ['check', 'Check']]

export interface StageStatus {
  readonly key: string
  readonly status: string
  readonly count: number
  readonly note: string
}

const status = (key: string, s: string, count = 0, note = ''): StageStatus => ({ key, status: s, count, note })

export const oneSite = (project: Project): boolean => project.sites.filter((s) => s.alternatives.length > 1).length <= 1

export function stageLabel(key: Stage, project: Project | null = null): string {
  if (key === 'watershed' && project !== null && oneSite(project)) return 'Plans'
  return LABELS[key]
}

const INPUT_ERRORS = new Set(['E_INCOMPLETE', 'E_NO_SITES', 'E_SITE_EMPTY', 'E_NEG_COST', 'E_IWR_YEARS',
  'E_STAF_OUTCOME', 'E_NO_COST'])

/** Status of every stage from the analysis results (null when no project is open). */
export function derive(results: AnalysisResults | null): Map<Stage, StageStatus> {
  const out = new Map<Stage, StageStatus>()
  if (results === null) {
    for (const k of STAGES) out.set(k, status(k, 'locked', 0, 'Open or start a project.'))
    return out
  }
  const errors = results.issues.filter((i) => i.level === 'error' && INPUT_ERRORS.has(i.code))
  out.set('inputs', errors.length ? status('inputs', 'attention', errors.length, 'Inputs need attention.')
    : status('inputs', 'done'))
  const readySites = [...results.sites.values()].filter((s) => s.ready)
  if (!readySites.length) out.set('sites', status('sites', 'locked', 0, 'No site can be analyzed yet.'))
  else {
    const d = results.decisions
    const pending = nSuggested(d) + nStale(d)
    out.set('sites', pending ? status('sites', 'attention', pending, `${pending} site recommendations to confirm or review.`)
      : status('sites', 'done'))
  }
  const ws = results.watershed
  if (ws.table === null) out.set('watershed', status('watershed', 'locked', 0, ws.reasons.join(' ')))
  else {
    const d = results.decisions
    if (d.tsp_state === 'ok' && !d.watershed_stale) out.set('watershed', status('watershed', 'done'))
    else if (d.tsp_state === 'missing' || d.tsp_state === 'not_in_final' || d.watershed_stale) {
      out.set('watershed', status('watershed', 'attention', 1, 'Review the TSP.'))
    } else out.set('watershed', status('watershed', '', 0, 'Choose the final array and TSP.'))
  }
  const openItems = readiness(results).filter(([ok]) => !ok)
  out.set('report', !openItems.length ? status('report', 'done')
    : status('report', ws.table !== null ? 'attention' : 'locked', openItems.length))
  return out
}

/** Checklist before a final report: [ok, text, stage to go to]. */
export function readiness(results: AnalysisResults): [boolean, string, string][] {
  const items: [boolean, string, string][] = []
  const errs = results.issues.filter((i) => i.level === 'error')
  items.push([!errs.length, !errs.length ? 'Inputs have no problems' : `${errs.length} input problems to fix`, 'inputs'])
  const d = results.decisions
  const suggested = nSuggested(d)
  const stale = nStale(d)
  items.push([suggested === 0, !suggested ? 'Every site recommendation is the team\'s'
    : `${suggested} site recommendations are still suggestions`, 'sites'])
  items.push([stale === 0, !stale ? 'No recommendation needs review'
    : `${stale} recommendations need review after changes`, 'sites'])
  const ws = results.watershed
  if (ws.table !== null) {
    const ok = d.tsp_state === 'ok' && !d.watershed_stale
    items.push([ok, ok ? 'Tentatively selected plan chosen'
      : d.tsp_state === 'ok' ? 'Review the tentatively selected plan after changes'
        : 'Choose the tentatively selected plan', 'watershed'])
  }
  return items
}

/** Every readiness item is checked, so the report may be final. */
export const finalReady = (results: AnalysisResults): boolean => readiness(results).every(([ok]) => ok)

/** The status the report prints with: Final only while the checklist passes. */
export function reportStatus(results: AnalysisResults): string {
  return results.project.report.status === 'FINAL' && finalReady(results) ? 'FINAL' : 'DRAFT'
}
