// Files the Report page offers (ceica/report/files.py): their names, and how each is made.
//
// resolve(results, f, fmt, today) names a download and says how to make it, as the Python does for the
// page's links. A small file (a figure's SVG, the project file) is built at once; every other is a job,
// {f, fmt}, which report/build.ts makes from the project, off the page's thread (src/app/files.ts).
import { pyIsAlnum, pySlice, pySplit, pyStrip } from '../../py/pystr'
import type { AnalysisResults } from '../analysis'
import { renderPanels } from '../figures/svg'
import type { Project } from '../model'
import { dumps } from '../projectfile'
import { APP_NAME } from '../version'
import { catalog, type Exhibit, type FigureData } from './exhibits'

export const MEDIA: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  zip: 'application/zip',
  ceica: 'application/json',
}
export const DOC_NAME = 'Figures and tables'

export interface Download {
  readonly filename: string
  readonly media_type: string
  /** a small file, built at once */
  readonly build?: () => string | Uint8Array
  /** a file made from the project, off the page's thread: the link's key and format */
  readonly job?: FileKey
}

/** A Report link's file: ``f`` a file key or an exhibit id, ``fmt`` its format. */
export interface FileKey { readonly f: string, readonly fmt: string }

// --- names ---------------------------------------------------------------------------------------

/** Letters (any alphabet), digits, spaces and - _ . , kept; anything else becomes _. */
export function safeName(text: string | null, limit = 80): string {
  const keep = [...pyStrip(text || '')].map((ch) => (pyIsAlnum(ch) || ' -_.,'.includes(ch) ? ch : '_')).join('')
  return pyStrip(pySlice(pySplit(keep).join(' '), 0, limit))
}

/** A date as Python's %Y-%m-%d. */
export const isoDay = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 'Utoy Creek Section 206 CE-ICA 2026-10-17': the study, the analysis and the day. */
export function fileStem(project: Project | null, today: Date): string {
  const name = safeName(project !== null ? project.name : '') || APP_NAME
  return `${name} CE-ICA ${isoDay(today)}`
}

/** 'Figure 01 Watershed plans': numbers padded to the count, so files sort in order. */
export function exhibitFile(ex: Exhibit, exhibits: readonly Exhibit[]): string {
  const width = Math.max(2, String(exhibits.filter((e) => e.kind === ex.kind).length).length)
  const word = ex.kind === 'figure' ? 'Figure' : 'Table'
  return `${word} ${String(ex.number).padStart(width, '0')} ${safeName(ex.title)}`
}

// --- figures -------------------------------------------------------------------------------------

/** A figure's SVG file (its panels side by side, each under its label). */
export function figureSvg(ex: Exhibit): string {
  const data = ex.build() as FigureData
  return renderPanels(data.panels, data.labels)
}

// --- one entry point for the page ----------------------------------------------------------------

/** The download for a link on the Report page (``f`` an exhibit id or a file key), or null.
 *
 * Keys: doc (docx, pdf, html), figures (zip), tables (xlsx), everything (zip), calculator (xlsx), project
 * (ceica); an exhibit id with png or svg (figures), csv or xlsx (tables). */
export function resolve(res: AnalysisResults | null, f: string, fmt: string, today: Date): Download | null {
  if (res === null) return null
  const p = res.project
  const stem = fileStem(p, today)
  const job = (filename: string, media: string): Download => ({ filename, media_type: media, job: { f, fmt } })
  if (f === 'doc' && (fmt === 'docx' || fmt === 'pdf' || fmt === 'html')) return job(`${stem} figures and tables.${fmt}`, MEDIA[fmt])
  if (f === 'figures' && fmt === 'zip') return job(`${stem} figures.zip`, MEDIA.zip)
  if (f === 'tables' && fmt === 'xlsx') return job(`${stem} tables.xlsx`, MEDIA.xlsx)
  if (f === 'everything' && fmt === 'zip') return job(`${stem}.zip`, MEDIA.zip)
  if (f === 'calculator' && fmt === 'xlsx') return job(`${stem} calculator.xlsx`, MEDIA.xlsx)
  if (f === 'project' && fmt === 'ceica') return { filename: `${stem}.ceica`, media_type: MEDIA.ceica, build: () => dumps(p) }
  const exhibits = catalog(res)
  const ex = exhibits.find((e) => e.id === f)
  if (!ex) return null
  const name = `${safeName(p.name) || APP_NAME} ${exhibitFile(ex, exhibits)}`
  if (ex.kind === 'figure' && fmt === 'png') return job(`${name}.png`, MEDIA.png)
  if (ex.kind === 'figure' && fmt === 'svg') return { filename: `${name}.svg`, media_type: MEDIA.svg, build: () => figureSvg(ex) }
  if (ex.kind === 'table' && fmt === 'csv') return job(`${name}.csv`, MEDIA.csv)
  if (ex.kind === 'table' && fmt === 'xlsx') return job(`${name}.xlsx`, MEDIA.xlsx)
  return null
}
