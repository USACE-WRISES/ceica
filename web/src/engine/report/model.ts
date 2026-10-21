// The figures-and-tables document as one list of blocks: every format prints the same exhibits
// (ceica/report/model.py).
//
// buildReport(results) returns a ReportDoc built from the exhibit catalog: a title block, every figure
// and table in the catalog's order, numbering and captions, and a short methods note. HTML (html.ts),
// PDF (pdf.ts) and Word (docx.ts) only lay the blocks out, so numbers and captions agree across formats
// by construction. The day the document is dated when its settings leave the date blank is passed in
// (the Python reads date.today()).
import { type Scene, withLegend } from '../figures/scene'
import { longDate } from '../fmt'
import { isStaf } from '../model'
import { shortDigest } from '../projectfile'
import { reportStatus } from '../runState'
import { APP_NAME, APP_VERSION, ENGINE_VERSION } from '../version'
import type { AnalysisResults } from '../analysis'
import {
  ACTIONS_ABOVE_SITES, catalog, cellText, columnSide, DOC_PLAN_ROWS, type Exhibit, type FigureData, GROUPS, groupTitle, roundingText,
  type TableData,
} from './exhibits'

export const SUBTITLE = 'Cost-effectiveness and incremental cost analysis: figures and tables'
export const KEY_SUBTITLE = 'Cost-effectiveness and incremental cost analysis: key figures and tables'

export interface Heading { readonly type: 'heading', readonly level: number, readonly text: string }
/** kind: body, lead, note or callout */
export interface Para { readonly type: 'para', readonly text: string, readonly kind: string }
/** (bold lead, text) items */
export interface Bullets { readonly type: 'bullets', readonly items: readonly (readonly [string, string])[] }
export interface FigureBlock {
  readonly type: 'figure'
  /** the panels, each with its legend drawn in (the reports have no HTML legend around the figure) */
  readonly scenes: readonly Scene[]
  readonly caption: string
  readonly number: number
  readonly labels: readonly string[]
}
export interface TableBlock {
  readonly type: 'table'
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly caption: string
  readonly number: string
  /** "l", "r" or "c" per column */
  readonly align: readonly string[]
  readonly landscape: boolean
  readonly total_last: boolean
  readonly note: string
}
export interface PageBreak { readonly type: 'pagebreak' }

export type Block = Heading | Para | Bullets | FigureBlock | TableBlock | PageBreak

export interface ReportDoc {
  readonly title: string
  readonly subtitle: string
  readonly meta: readonly (readonly [string, string])[]
  /** DRAFT or FINAL */
  readonly status: string
  readonly blocks: Block[]
  readonly footer: string
}

const heading = (level: number, text: string): Heading => ({ type: 'heading', level, text })
const para = (text: string, kind = 'body'): Para => ({ type: 'para', text, kind })

/** str.title() of a status word */
const titled = (s: string): string => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

function figureBlock(scenes: readonly Scene[], caption: string, number: number, labels: readonly string[]): FigureBlock {
  return { type: 'figure', scenes: scenes.map(withLegend), caption, number, labels }
}

/** An exhibit as a document block: a figure's panels, or a table's cells as printed text. Plan tables
 * print at most DOC_PLAN_ROWS plans and, with ``actions``, one Actions column in place of a column per
 * site. */
export function exhibitBlock(ex: Exhibit, number: number | null = null, actions = false): FigureBlock | TableBlock {
  const n = number === null ? ex.number : number
  if (ex.kind === 'figure') {
    const data = ex.build() as FigureData
    return figureBlock(data.panels, ex.caption, n, data.labels)
  }
  const data = ex.build({ limit: DOC_PLAN_ROWS, actions }) as TableData
  const cols = data.columns
  const rows: string[][] = []
  for (const r of data.rows) {
    const cells: string[] = []
    for (let k = 0; k < Math.min(r.length, cols.length); k++) cells.push(cellText(r[k], cols[k]))
    rows.push(cells)
  }
  return {
    type: 'table', columns: cols.map((c) => c.name), rows, caption: ex.caption, number: String(n), align: cols.map(columnSide),
    landscape: data.landscape, total_last: data.total_last, note: data.note,
  }
}

/** The rules behind every number, in a few lines (docs/methods.md has the full account). */
export function methodsBullets(res: AnalysisResults): Bullets {
  const p = res.project
  const items: [string, string][] = [
    ['Cost-effectiveness.', 'A plan is not cost-effective when another gives the same output at lower cost, or more output at the same '
      + 'or lower cost. Identical plans are both cost-effective.'],
    ['Best buys.', 'From No Action, the cost-effective plan with the lowest incremental cost per unit of output, repeated from each best '
      + 'buy; ties go to the smaller plan, so every plan on a straight stretch of the frontier is a best buy. No Action is always shown '
      + 'as a best buy.'],
    ['Incremental cost.', 'Between consecutive best buys, the added cost divided by the added output.'],
    ['Comparisons.', `${roundingText(p.settings)}; every comparison is exact.`],
    ['Watershed plans.', 'Each plan takes zero or one carried alternative at each site; outputs and costs add across sites.'],
    ['Sources.', 'The rules follow IWR Planning Suite II.'],
  ]
  if (isStaf(p.benefits)) {
    items.push(['STAF.', 'The Ecosystem Condition Index is not a certified or approved USACE planning model; STAF guidance treats it as '
      + 'a supplement to habitat units from approved models.'])
  }
  items.push(['Record.', `Generated by ${APP_NAME} ${APP_VERSION} (engine ${ENGINE_VERSION}) from the project file, digest `
    + `${shortDigest(p)}. Keep the file and the Excel calculator with this document.`])
  return { type: 'bullets', items }
}

/** The document for ``res``: ``contents`` FULL or SUMMARY (the settings' when not given); ``today`` the
 * day it is dated when the settings leave the date blank. */
export function buildReport(res: AnalysisResults, { contents = null, today }: { contents?: string | null, today: Date }): ReportDoc {
  const p = res.project
  const keyOnly = (contents || p.report.contents) === 'SUMMARY'
  // Final only while the readiness checklist passes; otherwise the document is a draft
  const status = reportStatus(res)
  const doc: ReportDoc = {
    title: p.report.title || p.name,
    subtitle: keyOnly ? KEY_SUBTITLE : SUBTITLE,
    meta: [['Study', p.name], ['Prepared by', p.report.prepared_by || 'n/a'], ['Date', p.report.date || longDate(today)],
      ['Status', titled(status)]],
    status,
    blocks: [],
    footer: `${APP_NAME} ${APP_VERSION} (engine ${ENGINE_VERSION}) | inputs ${shortDigest(p)}`,
  }
  const B = doc.blocks
  if (p.description) B.push(para(p.description))
  const ws = res.watershed
  const actions = ws.space !== null && ws.space.site_ids.length > ACTIONS_ABOVE_SITES
  const exhibits = catalog(res).filter((e) => e.key || !keyOnly)
  let nf = 0
  let nt = 0
  let first = true
  for (const group of GROUPS) {
    const items = exhibits.filter((e) => e.group === group)
    if (!items.length && !(group === 'plans' && ws.table === null && ws.reasons.length)) continue
    if (!first && !keyOnly) B.push({ type: 'pagebreak' })
    first = false
    B.push(heading(1, groupTitle(group, p)))
    if (!items.length) B.push(para(ws.reasons.join(' '), 'note'))
    for (const e of items) {
      const n = e.kind === 'figure' ? ++nf : ++nt
      B.push(exhibitBlock(e, keyOnly ? n : e.number, actions))
    }
  }
  if (!keyOnly) {
    B.push(heading(1, 'Methods'))
    B.push(methodsBullets(res))
  }
  return doc
}
