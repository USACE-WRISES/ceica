// Decisions: site recommendations, the final array, "Is it worth it?" steps and the TSP
// (ceica/decisions.py).
//
// The app suggests; people decide. Until the team picks a site's alternative, the site carries its
// suggestion (the largest best buy) so the watershed analysis never waits, and the report stays a
// draft. Every decision stores a fingerprint of the results it was made on; when later edits move
// those results, the decision reads "Needs review" instead of silently pointing at something else.
//
// Watershed plans are identified by composition key (compositionKey in model.ts), never by plan
// number. The final array defaults to the best buys; the team adds cost-effective plans or removes
// best buys (with a reason). The ladder steps through the final array in order of output, and the
// TSP is chosen from it.
import type { AltRow, SiteResult, WatershedResult } from './analysis'
import { flatNonzero } from './ica'
import { copy, parseCompositionKey, parseSiteDecision, type Project, type SiteDecision, type StepNote,
  type WatershedDecision } from './model'
import { indexOfKey, tableKey } from './plans'
import { issue, type Issue } from './validate'

export interface SiteDecisionState {
  readonly site_id: string
  /** The alternative carried forward (the team's choice, or the suggestion). */
  readonly alt_id: string | null
  /** "team" (decided), "suggested" (default, not yet decided) or "none" (site not ready). */
  readonly source: string
  readonly suggested: string | null
  /** The decision was made on results that have since changed. */
  readonly stale: boolean
  readonly rationale: string
}

export interface LadderStep {
  readonly from_key: string
  readonly to_key: string
  readonly from_id: string
  readonly to_id: string
  readonly adds: readonly string[]
  readonly drops: readonly string[]
  readonly d_output: number
  readonly d_cost: number
  readonly per_unit: number | null
  readonly note: StepNote | null
}

export const stepKey = (s: LadderStep): string => `${s.from_key} > ${s.to_key}`

export interface DecisionState {
  readonly sites: ReadonlyMap<string, SiteDecisionState>
  /** Final array plan keys in order of output (the No Action plan first). */
  readonly final_keys: readonly string[]
  /** Final array entries the team added (cost-effective plans that are not best buys). */
  readonly added: readonly string[]
  /** Best buys the team removed, with their notes. */
  readonly removed: ReadonlyMap<string, string>
  readonly ladder: readonly LadderStep[]
  readonly tsp_key: string | null
  /** "none", "ok", "missing" (the plan no longer exists) or "not_in_final". */
  readonly tsp_state: string
  readonly watershed_stale: boolean
  readonly issues: readonly Issue[]
}

export const nSuggested = (d: DecisionState): number => [...d.sites.values()].filter((s) => s.source === 'suggested').length
export const nStale = (d: DecisionState): number => [...d.sites.values()].filter((s) => s.stale).length

function decisionState(sites: Map<string, SiteDecisionState>, rest: Partial<DecisionState> = {}): DecisionState {
  return { sites, final_keys: [], added: [], removed: new Map(), ladder: [], tsp_key: null,
    tsp_state: 'none', watershed_stale: false, issues: [], ...rest }
}

/** Per site: [alternative carried, source] with source "team" or "suggested". */
export function effectiveRecommendations(project: Project, sites: ReadonlyMap<string, SiteResult>):
  Map<string, [string | null, string]> {
  const out = new Map<string, [string | null, string]>()
  for (const site of project.sites) {
    const sr = sites.get(site.id)
    const dec = project.decisions.sites.get(site.id)
    const valid = new Set(site.alternatives.map((a) => a.id))
    if (dec !== undefined && dec.recommended_alt_id !== null && valid.has(dec.recommended_alt_id)) {
      out.set(site.id, [dec.recommended_alt_id, 'team'])
    } else out.set(site.id, [sr ? sr.suggested : null, 'suggested'])
  }
  return out
}

const rowOf = (sr: SiteResult, altId: string): AltRow | null => sr.rows.find((r) => r.alt_id === altId) ?? null

export function evaluateDecisions(project: Project, sites: ReadonlyMap<string, SiteResult>,
  ws: WatershedResult): DecisionState {
  const issues: Issue[] = []
  const recs = effectiveRecommendations(project, sites)
  const siteStates = new Map<string, SiteDecisionState>()
  for (const site of project.sites) {
    const sr = sites.get(site.id)!
    const [alt, source] = recs.get(site.id)!
    const dec = project.decisions.sites.get(site.id)
    if (!sr.ready) {
      siteStates.set(site.id, { site_id: site.id, alt_id: null, source: 'none', suggested: null,
        stale: false, rationale: '' })
      continue
    }
    const stale = Boolean(dec && dec.basis && source === 'team' && dec.basis !== sr.fingerprint)
    siteStates.set(site.id, { site_id: site.id, alt_id: alt, source, suggested: sr.suggested, stale,
      rationale: dec ? dec.rationale : '' })
    if (stale) {
      issues.push(issue('warning', 'W_REC_STALE',
        `${site.id}: results changed since the recommendation was made; review it.`, 'decisions', site.id, alt))
    }
    const row = alt ? rowOf(sr, alt) : null
    if (source === 'team' && row !== null && !row.is_no_action && !row.ce) {
      issues.push(issue('warning', 'W_REC_NOT_CE',
        `${site.id}: the recommended alternative (${row.name}) is not cost-effective.`, 'decisions', site.id, alt))
    }
  }

  if (ws.table === null || ws.ceica === null) return decisionState(siteStates, { issues })

  const wdec = project.decisions.watershed
  const res = ws.ceica
  const table = ws.table
  const bbKeys = new Set(flatNonzero(res.bb).map((i) => tableKey(table, i)))
  const cache = new Map<string, number | null>()
  const rowFor = (key: string): number | null => {
    if (!cache.has(key)) cache.set(key, indexOfKey(table, key))
    return cache.get(key)!
  }
  const final = new Set(bbKeys)
  const added: string[] = []
  const removed = new Map<string, string>()
  for (const [key, choice] of wdec.final_array) {
    if (rowFor(key) === null) continue
    if (choice.included && !final.has(key)) {
      final.add(key)
      added.push(key)
    } else if (!choice.included && final.has(key)) {
      final.delete(key)
      removed.set(key, choice.note)
    }
  }
  const naKey = ''
  if (rowFor(naKey) !== null) final.add(naKey)
  const order = [...final].sort((a, b) => {
    const ia = rowFor(a)!
    const ib = rowFor(b)!
    return (table.output[ia] - table.output[ib]) || (table.cost[ia] - table.cost[ib]) || (a < b ? -1 : a > b ? 1 : 0)
  })

  const pts = res.points
  const ladder: LadderStep[] = []
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k]
    const b = order[k + 1]
    const ia = rowFor(a)!
    const ib = rowFor(b)!
    const ca = parseCompositionKey(a)
    const cb = parseCompositionKey(b)
    const adds = ws.space!.site_ids.filter((s) => cb.has(s) && cb.get(s) !== ca.get(s))
    const drops = ws.space!.site_ids.filter((s) => ca.has(s) && !cb.has(s))
    const dq = table.output[ib] - table.output[ia]
    const dc = table.cost[ib] - table.cost[ia]
    const qs = 10 ** pts.output_dp
    const cs = 10 ** pts.cost_dp
    const per = dq !== 0 ? (dc / cs) / (dq / qs) : null
    const note = wdec.steps.get(`${a} > ${b}`) ?? null
    ladder.push({ from_key: a, to_key: b, from_id: pts.ids[ia], to_id: pts.ids[ib], adds, drops,
      d_output: dq / qs, d_cost: dc / cs, per_unit: per, note })
  }

  for (const key of [...bbKeys].filter((k) => !final.has(k)).sort()) {
    if (!removed.get(key)) {
      issues.push(issue('warning', 'W_BB_EXCLUDED_NO_NOTE',
        `Best buy ${pts.ids[rowFor(key)!]} is left out of the final array without a reason.`, 'decisions'))
    }
  }
  for (const key of added) {
    if (!res.ce[rowFor(key)!]) {
      issues.push(issue('warning', 'W_FINAL_NOT_CE',
        `${pts.ids[rowFor(key)!]} is in the final array but is not cost-effective.`, 'decisions'))
    }
  }

  const tspKey = wdec.tsp
  let tspState: string
  if (tspKey === null) tspState = 'none'
  else if (rowFor(tspKey) === null) {
    tspState = 'missing'
    issues.push(issue('warning', 'W_TSP_MISSING',
      'The tentatively selected plan no longer exists with the current site recommendations. '
      + 'Choose the TSP again.', 'decisions'))
  } else if (!final.has(tspKey)) {
    tspState = 'not_in_final'
    issues.push(issue('error', 'E_TSP_NOT_IN_FINAL',
      `The TSP (${pts.ids[rowFor(tspKey)!]}) is not in the final array.`, 'decisions'))
  } else tspState = 'ok'
  const wsStale = Boolean(wdec.basis && wdec.basis !== ws.fingerprint && tspKey !== null)
  if (wsStale) {
    issues.push(issue('warning', 'W_WATERSHED_STALE',
      'Watershed results changed since the final array and TSP were chosen; review them.', 'decisions'))
  }
  return decisionState(siteStates, { final_keys: order, added, removed, ladder, tsp_key: tspKey,
    tsp_state: tspState, watershed_stale: wsStale, issues })
}

function withDecisions(project: Project, sites: ReadonlyMap<string, SiteDecision>, watershed: WatershedDecision): Project {
  return copy(project, { decisions: copy(project.decisions, { sites, watershed }) })
}

/** What stamping and carrying decisions need of the analysis results. */
interface Fingerprints {
  readonly sites: ReadonlyMap<string, SiteResult>
  readonly watershed: WatershedResult
}

/** Every decision stamped with the results in ``res`` (the analysis of ``project``), as if the team
 * had just made it. The example builders write their decisions this way. */
export function stampBasis(project: Project, res: Fingerprints): Project {
  const sites = new Map<string, SiteDecision>()
  for (const [sid, dec] of project.decisions.sites) {
    const sr = res.sites.get(sid)
    sites.set(sid, dec.recommended_alt_id !== null && sr !== undefined && sr.ready
      ? copy(dec, { basis: sr.fingerprint }) : dec)
  }
  let ws = project.decisions.watershed
  if (ws.tsp !== null && res.watershed.table !== null) ws = copy(ws, { basis: res.watershed.fingerprint })
  return withDecisions(project, sites, ws)
}

/** Decisions that were current before a change that moves no result (a rename) stay current.
 *
 * ``before`` and ``after`` are the results before and after the change, and ``renamed`` maps old
 * site ids to new ones. A decision whose basis matched ``before`` takes the new fingerprint from
 * ``after``; one with no basis, or one that already needed review, keeps its basis. */
export function carryBasis(before: Fingerprints, project: Project, after: Fingerprints,
  renamed: ReadonlyMap<string, string> | null = null): Project {
  const back = new Map([...(renamed ?? new Map<string, string>())].map(([o, n]) => [n, o]))
  const sites = new Map<string, SiteDecision>()
  for (const [sid, dec] of project.decisions.sites) {
    const old = before.sites.get(back.get(sid) ?? sid)
    const now = after.sites.get(sid)
    sites.set(sid, dec.basis && old !== undefined && now !== undefined && dec.basis === old.fingerprint
      ? copy(dec, { basis: now.fingerprint }) : dec)
  }
  let ws = project.decisions.watershed
  if (ws.basis && ws.basis === before.watershed.fingerprint) ws = copy(ws, { basis: after.watershed.fingerprint })
  return withDecisions(project, sites, ws)
}

/** A blank site decision (SiteDecision()), for edits that start one. */
export const blankSiteDecision = (): SiteDecision => parseSiteDecision({})
