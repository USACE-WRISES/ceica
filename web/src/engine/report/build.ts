// Each Report file made from the analysis, by its link's key and format (ceica/report/files.py's
// builders): what a download job asks for (src/app/files.ts runs the job off the page's thread).
import { timeStamp, type TimeStamp } from '../../files/pdf/pdfdoc'
import { localDateTime } from '../../files/zip'
import { utf8 } from '../../py/bytes'
import type { AnalysisResults } from '../analysis'
import { renderPngPanels, type PngMaker } from '../figures/raster'
import { buildCalculator } from '../workbook/export'
import { catalog, type Exhibit, type FigureData, type TableData } from './exhibits'
import type { FileKey } from './files'
import { renderHtml } from './html'
import { buildReport } from './model'
import { renderPdf } from './pdf'
import { tableCsv, tablesXlsx, tableXlsx } from './tables'
import { everythingZip, figuresZip, type ZipMakers } from './zips'

/** What a file's making needs besides the analysis: the job's clock, and what draws PNG figures. */
export interface FileContext {
  /** the day the files are dated (the download's) */
  readonly today: Date
  /** the moment of the download */
  readonly now: Date
  /** the page layer's canvas (app/canvasPng.ts), or the tests' stand-in */
  readonly png: PngMaker
  /** the PDF's time stamp, and the Everything zip's project file's savedAt: the moment's, unless the
   * tests fix them */
  readonly pdfStamp?: TimeStamp
  readonly savedAt?: string
}

/** Figure files: print resolution (files.FIGURE_DPI). */
export const FIGURE_DPI = 300

/** A figure's PNG at a dpi (files.figure_png). */
export function figurePng(ex: Exhibit, png: PngMaker, dpi = FIGURE_DPI): Promise<Uint8Array> {
  const data = ex.build() as FigureData
  return renderPngPanels(data.panels, data.labels, dpi, png)
}

/** The document as Word, PDF or HTML (report.render_report), dated the job's day. */
export async function documentFile(res: AnalysisResults, fmt: 'docx' | 'pdf' | 'html', ctx: FileContext): Promise<Uint8Array> {
  const doc = buildReport(res, { today: ctx.today })
  if (fmt === 'html') return utf8(renderHtml(doc))
  if (fmt === 'pdf') return renderPdf(doc, ctx.pdfStamp ?? timeStamp(false, ctx.now))
  // the Word file's code and constant parts load only now
  const { renderDocx } = await import('./docx')
  return renderDocx(doc, ctx.png, localDateTime(ctx.now))
}

/** "%Y-%m-%dT%H:%M:%SZ" of a moment */
const utcStamp = (d: Date): string => d.toISOString().slice(0, 19) + 'Z'

function zipMakers(res: AnalysisResults, ctx: FileContext): ZipMakers {
  return {
    figurePng: (ex) => figurePng(ex, ctx.png),
    document: (fmt) => documentFile(res, fmt, ctx),
    savedAt: ctx.savedAt ?? utcStamp(ctx.now),
  }
}

/** A file this app does not make: the page says so. */
export class NotInWebApp extends Error {
  constructor() {
    super('This download is not in the web app yet.')
    this.name = 'NotInWebApp'
  }
}

/** The file for a Report link (resolve's job), as bytes. */
export async function buildFile(res: AnalysisResults, key: FileKey, ctx: FileContext): Promise<Uint8Array> {
  const { f, fmt } = key
  if (f === 'doc' && (fmt === 'html' || fmt === 'pdf' || fmt === 'docx')) return documentFile(res, fmt, ctx)
  if (f === 'figures' && fmt === 'zip') return figuresZip(res, ctx.today, zipMakers(res, ctx))
  if (f === 'tables' && fmt === 'xlsx') return tablesXlsx(res)
  if (f === 'everything' && fmt === 'zip') return everythingZip(res, ctx.today, zipMakers(res, ctx))
  if (f === 'calculator' && fmt === 'xlsx') return buildCalculator(res.project, res)
  const ex = catalog(res).find((e) => e.id === f)
  if (ex && ex.kind === 'figure' && fmt === 'png') return figurePng(ex, ctx.png)
  if (ex && ex.kind === 'table' && fmt === 'csv') return tableCsv(ex.build() as TableData)
  if (ex && ex.kind === 'table' && fmt === 'xlsx') return tableXlsx(ex)
  throw new NotInWebApp()
}
