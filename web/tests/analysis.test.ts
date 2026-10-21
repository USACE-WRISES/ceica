// The whole analysis of every golden project against the Python engine (projects/*.json, made by
// web/parity/make_project_fixtures.py): site rows and CE/ICA, the watershed (its whole plan table
// by digest, the best-buy and cost-effective rows in full), decisions, issues and stage status.
import { describe, expect, it } from 'vitest'
import { pyFloat } from '../src/py/pyfmt'
import { sha256Hex } from '../src/py/bytes'
import {
  analyze, type AnalysisResults, planCountWarning, type PlanRow, planOrder, planRow, planRows, siteBestBuys,
  type WatershedResult, wsBb, wsCe, wsPlans,
} from '../src/engine/analysis'
import { carryBasis, nStale, nSuggested, stampBasis, stepKey } from '../src/engine/decisions'
import type { CEICAResult, Increment } from '../src/engine/ica'
import { copy, type Project } from '../src/engine/model'
import { digitsOf, tableLength } from '../src/engine/plans'
import { contentDigest, loads } from '../src/engine/projectfile'
import { derive, finalReady, oneSite, readiness, reportStatus, STAGES, stageLabel } from '../src/engine/runState'
import { pairsOf, treeDiff } from './helpers'
import { projectGoldens } from './projects'

const bits = (mask: ArrayLike<number>): string => Array.from(mask, (v) => (v ? '1' : '0')).join('')
const big = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString())

const incRows = (rows: readonly Increment[]) => rows.map((r) => [r.index, r.plan_id, r.cost, r.output, r.avg_cost,
  r.inc_cost, r.inc_output, r.inc_cost_per_unit, r.prev_plan_id])

function siteCeica(r: CEICAResult | null) {
  if (r === null) return null
  const pts = r.points
  return { ids: pts.ids, c: Array.from(pts.cost), q: Array.from(pts.output), na: pts.no_action, cdp: pts.cost_dp,
    qdp: pts.output_dp, ce: bits(r.ce), bb: bits(r.bb), ceRaw: bits(r.ce_raw), witness: Array.from(r.witness),
    reason: Array.from(r.reason).join(''), base: [r.base.cost, r.base.output, r.base.uses_no_action],
    walk: r.walk, inc: incRows(r.bb_increments) }
}

const planRowJson = (r: PlanRow) => [r.index, r.plan_id, r.key, pairsOf(r.composition), r.label, r.output, r.cost,
  r.construction, r.unit_cost, r.ce, r.bb, r.step, r.inc_cost_per_unit, r.inc_output, r.inc_cost]

/** sha256 of the whole plan table, one line per plan (as make_project_fixtures.table_digest). */
function tableDigest(ws: WatershedResult): string {
  const t = ws.table!
  const r = ws.ceica!
  const cons = t.extra.get('construction')!
  const lines: string[] = []
  for (let i = 0; i < tableLength(t); i++) {
    lines.push(`${t.plan_no[i]},${digitsOf(t, i).join('')},${t.output[i]},${t.cost[i]},${pyFloat(cons[i])},`
      + `${r.ce[i]},${r.bb[i]}`)
  }
  return sha256Hex(lines.join('\n'))
}

/** The first site renamed: an edit that moves no result (as make_project_fixtures._renamed). */
function renamed(p: Project): Project {
  if (!p.sites.length) return p
  return copy(p, { sites: [copy(p.sites[0], { name: 'Renamed site' }), ...p.sites.slice(1)] })
}

function exportAnalysis(p: Project, res: AnalysisResults) {
  const ws = res.watershed
  const w: Record<string, unknown> = {
    ready: ws.ready, reasons: ws.reasons, mode: ws.mode, carried: pairsOf(ws.carried), sources: pairsOf(ws.sources),
    notCarried: ws.not_carried, blocked: ws.blocked, fingerprint: ws.fingerprint, nPlans: wsPlans(ws),
    nCe: wsCe(ws), nBb: wsBb(ws), space: ws.space === null ? null : [ws.space.site_ids, ws.space.options],
  }
  if (ws.table !== null) {
    const order = planOrder(ws, 'all')
    Object.assign(w, {
      nValid: big(ws.table.n_valid), ceOnly: ws.table.ce_only, digest: tableDigest(ws), na: ws.ceica!.points.no_action,
      base: [ws.ceica!.base.cost, ws.ceica!.base.output, ws.ceica!.base.uses_no_action], walk: ws.ceica!.walk,
      inc: incRows(ws.ceica!.bb_increments), bbRows: planRows(ws, 'bb').map(planRowJson),
      ceRows: planRows(ws, 'ce').map(planRowJson), allHead: planRows(ws, 'all', 30).map(planRowJson),
      allTail: order.slice(-10).map((i) => planRowJson(planRow(ws, i))),
    })
  }
  const d = res.decisions
  return {
    sites: [...res.sites].map(([sid, sr]) => [sid, sr.ready, sr.reasons, sr.rows.map((r) => [r.alt_id, r.name,
      r.description, r.is_no_action, r.aahu, r.lift, r.annual, r.cost, r.construction, r.first_cost, r.unit_cost,
      r.ce, r.bb, r.step, r.inc_cost_per_unit, r.inc_output, r.inc_cost, r.beaten_by, r.beaten_reason]),
    sr.suggested, sr.fingerprint, siteCeica(sr.ceica), siteBestBuys(sr).map((r) => r.alt_id)]),
    watershed: w,
    decisions: {
      sites: [...d.sites].map(([sid, s]) => [sid, s.alt_id, s.source, s.suggested, s.stale, s.rationale]),
      finalKeys: d.final_keys, added: d.added, removed: pairsOf(d.removed),
      ladder: d.ladder.map((s) => [s.from_key, s.to_key, s.from_id, s.to_id, s.adds, s.drops, s.d_output, s.d_cost,
        s.per_unit, s.note === null ? null : [s.note.worth_it, s.note.why], stepKey(s)]),
      tspKey: d.tsp_key, tspState: d.tsp_state, watershedStale: d.watershed_stale, nSuggested: nSuggested(d),
      nStale: nStale(d),
    },
    issues: res.issues.map((i) => [i.level, i.code, i.message, i.section, i.site_id, i.alt_id]),
    runState: {
      derive: [...derive(res)].map(([k, s]) => [k, s.status, s.count, s.note]), readiness: readiness(res),
      finalReady: finalReady(res), reportStatus: reportStatus(res), oneSite: oneSite(p),
      labels: STAGES.map((k) => stageLabel(k, p)),
    },
    stamped: contentDigest(stampBasis(p, res)),
    carried: contentDigest(carryBasis(res, renamed(p), analyze(renamed(p)))),
    planCountWarning: planCountWarning(res),
  }
}

/** Alternative rows' annual and CE/ICA costs come from powers (the capital recovery factor). */
const powered = (path: string) => /^\.sites\.\d+\.3\.\d+\.(6|7)$/.test(path)

describe.each(projectGoldens())('$name', ({ input, expected }) => {
  it('analyzes as the Python engine does', () => {
    const p = loads(input).project
    const got = exportAnalysis(p, analyze(p))
    expect(treeDiff(got, expected.analysis, powered).diffs.slice(0, 10)).toEqual([])
  })
})
