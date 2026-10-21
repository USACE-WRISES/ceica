// The Report page's zips (ceica/report/files.py): the figures zip and the Everything zip, with its README.
//
// A zip is written as Python streams it (zip_chunks): one member at a time into a sink zipfile cannot
// seek (so each member is followed by a data descriptor), each dated the day at midnight, stored when
// its format is already compressed and deflated otherwise. How the figures' PNG files and the documents
// are made is report/build.ts's (ZipMakers).
import { newInfo, ZIP_DEFLATED, ZIP_STORED, ZipWriter } from '../../files/zip'
import { commaInt } from '../../py/pynum'
import type { AnalysisResults } from '../analysis'
import { longDate, NA } from '../fmt'
import { dumps, shortDigest } from '../projectfile'
import { reportStatus } from '../runState'
import { APP_NAME, APP_VERSION, ENGINE_VERSION } from '../version'
import { buildCalculator } from '../workbook/export'
import { catalog, type Exhibit, exhibitLabel, type TableData, ZIP_PLAN_ROWS } from './exhibits'
import { DOC_NAME, exhibitFile, figureSvg, fileStem, safeName } from './files'
import { tableCsv, tablesXlsx } from './tables'

/** Formats stored as they are: already compressed (files._PACKED). */
const PACKED = ['.png', '.xlsx', '.docx', '.zip']

/** A member: its name in the zip, and how its bytes are made (when its turn comes). */
type Member = readonly [string, () => Uint8Array | string | Promise<Uint8Array | string>]

/** How the zips' figure files and documents are made (report/build.ts), and the project file's savedAt. */
export interface ZipMakers {
  figurePng(ex: Exhibit): Promise<Uint8Array>
  document(fmt: 'docx' | 'pdf' | 'html'): Promise<Uint8Array>
  readonly savedAt: string
}

/** zip_chunks: the members in order, dated the day, with 0o644 attributes. */
export async function zipOf(members: readonly Member[], today: Date): Promise<Uint8Array> {
  const z = new ZipWriter({ seekable: false })
  const stamp = { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }
  for (const [name, make] of members) {
    const lower = name.toLowerCase()
    const method = PACKED.some((ext) => lower.endsWith(ext)) ? ZIP_STORED : ZIP_DEFLATED
    z.writestr(newInfo(name, stamp, method, 0o644 << 16), await make())
  }
  return z.finish()
}

/** Each figure as PNG and SVG, in a folder (files._figure_members). */
function figureMembers(exhibits: readonly Exhibit[], folder: string, makers: ZipMakers): Member[] {
  const out: Member[] = []
  for (const ex of exhibits) {
    if (ex.kind !== 'figure') continue
    const base = `${folder}${exhibitFile(ex, exhibits)}`
    out.push([`${base}.png`, () => makers.figurePng(ex)], [`${base}.svg`, () => figureSvg(ex)])
  }
  return out
}

/** The figures zip: every figure as PNG and SVG. */
export function figuresZip(res: AnalysisResults, today: Date, makers: ZipMakers): Promise<Uint8Array> {
  const exhibits = catalog(res)
  return zipOf(figureMembers(exhibits, `${fileStem(res.project, today)} figures/`, makers), today)
}

/** The whole study in one zip: the README, the tables, the figures, the document in three formats, the
 * calculator and the project file (slowest last, as Python streams them). */
export function everythingZip(res: AnalysisResults, today: Date, makers: ZipMakers): Promise<Uint8Array> {
  const p = res.project
  const exhibits = catalog(res)
  const top = `${fileStem(p, today)}/`
  const study = safeName(p.name) || APP_NAME
  const members: Member[] = [[`${top}README.txt`, () => readmeText(res, today, exhibits)]]
  for (const ex of exhibits) {
    if (ex.kind === 'table') {
      members.push([`${top}Tables/${exhibitFile(ex, exhibits)}.csv`, () => tableCsv(ex.build({ limit: ZIP_PLAN_ROWS }) as TableData)])
    }
  }
  members.push([`${top}Tables/All tables.xlsx`, () => tablesXlsx(res, exhibits)])
  members.push(...figureMembers(exhibits, `${top}Figures/`, makers))
  for (const fmt of ['docx', 'pdf', 'html'] as const) members.push([`${top}${DOC_NAME}.${fmt}`, () => makers.document(fmt)])
  members.push([`${top}${study} calculator.xlsx`, () => buildCalculator(p, res)])
  members.push([`${top}${study}.ceica`, () => dumps(p, { savedAt: makers.savedAt })])
  return zipOf(members, today)
}

/** str.title() of a status word */
const titled = (s: string): string => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

/** What the Everything zip holds, with every caption, and how to read the data files. */
export function readmeText(res: AnalysisResults, today: Date, exhibits: readonly Exhibit[] | null = null): string {
  const p = res.project
  const all = exhibits ?? catalog(res)
  const study = safeName(p.name) || APP_NAME
  const lines = [p.report.title || p.name,
    'Cost-effectiveness and incremental cost analysis: figures and tables', '',
    `Study: ${p.name}`,
    `Prepared by: ${p.report.prepared_by || NA}`,
    `Date: ${p.report.date || longDate(today)}`,
    `Status: ${titled(reportStatus(res))}`,
    `Made by ${APP_NAME} ${APP_VERSION} (engine ${ENGINE_VERSION}); project digest ${shortDigest(p)}`, '',
    'In this folder',
    `  ${DOC_NAME}.docx, .pdf and .html: every figure and table with its number and caption, and the methods.`,
    '  Figures: each figure as PNG (300 dpi, for documents and slides) and SVG (to edit).',
    '  Tables: each table as CSV, and All tables.xlsx with a sheet per table.',
    `  ${study} calculator.xlsx: every input and result as live formulas.`,
    `  ${study}.ceica: the project file. Open it in ${APP_NAME} to continue the study.`,
    '', 'Figures']
  for (const ex of all) {
    if (ex.kind !== 'figure') continue
    lines.push(`  ${exhibitLabel(ex)}. ${ex.caption}`)
    lines.push(`    Figures/${exhibitFile(ex, all)}.png and .svg`)
  }
  lines.push('', 'Tables')
  const capped: Exhibit[] = []
  for (const ex of all) {
    if (ex.kind !== 'table') continue
    lines.push(`  ${exhibitLabel(ex)}. ${ex.caption}`)
    lines.push(`    Tables/${exhibitFile(ex, all)}.csv`)
    if (ex.n_rows && ex.n_rows > ZIP_PLAN_ROWS) capped.push(ex)
  }
  lines.push('', 'Reading the data files',
    '  CSV files hold plain numbers: lift and cost are the rounded values the analysis compared, so sorting reproduces its ties. '
    + 'TRUE and FALSE mark cost-effective plans and best buys. A blank cell has no value; in a plan table, a blank site column '
    + 'means the site is not in the plan.',
    `  In All tables.xlsx, numbers keep their full precision under the display format, and a missing value reads ${NA}.`)
  for (const ex of capped) {
    lines.push(`  ${exhibitLabel(ex)} lists only the cost-effective plans here: the study has ${commaInt(ex.n_rows!)}. `
      + 'Download the table as CSV from the Report page for every plan.')
  }
  return lines.join('\n') + '\n'
}
