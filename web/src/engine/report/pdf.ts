// The report as PDF (ceica/report/pdf.py, reportlab Platypus): vector figures, repeating table headers,
// page numbers. Letter portrait, with landscape pages for tables too wide to read upright; "Page X of Y"
// and the record line in the footer; a light DRAFT watermark on draft reports.
import { Canvas } from '../../files/pdf/canvas'
import { Color, HexColor, white } from '../../files/pdf/colors'
import { BaseDocTemplate, inch, landscape, letter, NextPageTemplate, PageTemplate } from '../../files/pdf/doctemplate'
import { CondPageBreak, type Flowable, KeepTogether, PageBreak, Spacer } from '../../files/pdf/flowables'
import { Frame } from '../../files/pdf/frames'
import { Paragraph } from '../../files/pdf/paragraph'
import type { TimeStamp } from '../../files/pdf/pdfdoc'
import { ParagraphStyle, TA_CENTER, TA_LEFT, TA_RIGHT } from '../../files/pdf/styles'
import { type CellValue, type Cmd, Table, TableStyle } from '../../files/pdf/tables'
import { pySum } from '../../py/pynum'
import { pyLen, pySplit } from '../../py/pystr'
import { toDrawing } from '../figures/pdf'
import type { FigureBlock, ReportDoc, TableBlock } from './model'

const NAVY = HexColor('#2f4b7c')
const INK = HexColor('#2a3344')
const TEXT = HexColor('#33415c')
const MUTED = HexColor('#646f80')
const RULE = HexColor('#d5deea')
const ZEBRA = HexColor('#fafbfd')
const OK = HexColor('#1a7f37')
const OK_SOFT = HexColor('#e9f6ee')

const MARGIN = 0.85 * inch

const S: Record<string, ParagraphStyle> = {
  title: new ParagraphStyle('title', { fontName: 'Helvetica-Bold', fontSize: 20, leading: 24, textColor: INK, spaceAfter: 4 }),
  sub: new ParagraphStyle('sub', { fontName: 'Helvetica', fontSize: 12, leading: 15, textColor: MUTED, spaceAfter: 10 }),
  meta: new ParagraphStyle('meta', { fontName: 'Helvetica', fontSize: 9, leading: 12, textColor: TEXT }),
  h1: new ParagraphStyle('h1', { fontName: 'Helvetica-Bold', fontSize: 14, leading: 18, textColor: INK, spaceBefore: 14, spaceAfter: 6,
    keepWithNext: 1 }),
  h2: new ParagraphStyle('h2', { fontName: 'Helvetica-Bold', fontSize: 11.5, leading: 15, textColor: INK, spaceBefore: 12, spaceAfter: 4,
    keepWithNext: 1 }),
  body: new ParagraphStyle('body', { fontName: 'Helvetica', fontSize: 9.8, leading: 13.5, textColor: TEXT, spaceAfter: 6 }),
  note: new ParagraphStyle('note', { fontName: 'Helvetica-Oblique', fontSize: 9.5, leading: 13, textColor: MUTED, spaceAfter: 6 }),
  callout: new ParagraphStyle('callout', { fontName: 'Helvetica', fontSize: 9.8, leading: 13.5, textColor: INK }),
  cap: new ParagraphStyle('cap', { fontName: 'Helvetica', fontSize: 8.6, leading: 11, textColor: TEXT, spaceBefore: 4, spaceAfter: 4 }),
  tnote: new ParagraphStyle('tnote', { fontName: 'Helvetica', fontSize: 8, leading: 10.5, textColor: MUTED, spaceBefore: 3 }),
  bullet: new ParagraphStyle('bullet', { fontName: 'Helvetica', fontSize: 9.6, leading: 13, textColor: TEXT, leftIndent: 12, bulletIndent: 2,
    spaceAfter: 3 }),
  cell: new ParagraphStyle('cell', { fontName: 'Helvetica', fontSize: 7.8, leading: 9.6, textColor: TEXT }),
  cell_r: new ParagraphStyle('cell_r', { fontName: 'Helvetica', fontSize: 7.8, leading: 9.6, textColor: TEXT, alignment: TA_RIGHT }),
  cell_c: new ParagraphStyle('cell_c', { fontName: 'Helvetica', fontSize: 7.8, leading: 9.6, textColor: TEXT, alignment: TA_CENTER }),
  head: new ParagraphStyle('head', { fontName: 'Helvetica-Bold', fontSize: 7.8, leading: 9.6, textColor: white, alignment: TA_LEFT }),
  panel: new ParagraphStyle('panel', { fontName: 'Helvetica-Bold', fontSize: 8.5, leading: 10, textColor: INK }),
}

/** xml.sax.saxutils.escape: & < > */
const escape = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('>', '&gt;').replaceAll('<', '&lt;')

/** _Numbered: two passes, so the footer can say "Page X of Y" (each page kept, then written at save). */
class Numbered extends Canvas {
  private pages: Record<string, unknown>[] = []
  /** _rec: the record line, set by the page's onPage */
  rec = ''

  protected snapshot(): Record<string, unknown> {
    return { ...super.snapshot(), rec: this.rec }
  }

  showPage(): void {
    this.pages.push(this.snapshot())
    this.startPage()
  }

  getpdfdata(): Uint8Array {
    const total = this.pages.length
    for (const state of this.pages) {
      this.restore(state)
      this.footer(total)
      super.showPage()
    }
    return super.getpdfdata()
  }

  private footer(total: number): void {
    const w = this.pagesize[0]
    this.setFont('Helvetica', 7.5)
    this.setFillColor(MUTED)
    this.drawString(MARGIN, 0.5 * inch, this.rec)
    this.drawRightString(w - MARGIN, 0.5 * inch, `Page ${this.pageNumber} of ${total}`)
  }
}

function decorate(doc: ReportDoc) {
  return (c: Canvas): void => {
    const [w, h] = c.pagesize
    ;(c as Numbered).rec = doc.footer
    c.saveState()
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(MARGIN, h - 0.55 * inch, w - MARGIN, h - 0.55 * inch)
    c.setFont('Helvetica', 7.5)
    c.setFillColor(MUTED)
    c.drawString(MARGIN, h - 0.5 * inch, doc.title)
    if (doc.status === 'DRAFT') {
      c.drawRightString(w - MARGIN, h - 0.5 * inch, 'DRAFT')
      c.setFont('Helvetica-Bold', 90)
      c.setFillColor(new Color(0.6, 0.4, 0.0, 0.06))
      c.translate(w / 2, h / 2)
      c.rotate(35)
      c.drawCentredString(0, 0, 'DRAFT')
    }
    c.restoreState()
  }
}

/** Widths from content: each column fits its longest header word and (up to a cap) its longest cell; long
 * text columns take what is left. */
export function columnWidths(b: TableBlock, width: number, charPt = 4.3): number[] {
  const n = b.columns.length
  const need: number[] = []
  for (let c = 0; c < n; c++) {
    const words = pySplit(b.columns[c])
    const headWord = words.length ? Math.max(...words.map(pyLen)) : 1
    const cells = b.rows.filter((r) => c < r.length).map((r) => pyLen(r[c]))
    const longest = cells.length ? Math.max(...cells) : 0
    need.push(Math.max(headWord + 1, Math.min(longest, 28)) * charPt + 10)
  }
  const total = pySum(need)
  if (total <= width) {
    const extra = width - total
    const align = b.align.length ? b.align : Array(n).fill('l')
    let grow = need.map((_, i) => i).filter((i) => align[i] === 'l')
    if (!grow.length) grow = need.map((_, i) => i)
    for (const i of grow) need[i] += extra / grow.length
    return need
  }
  return need.map((w) => (w * width) / total)
}

const ALIGN: Record<string, number> = { l: TA_LEFT, r: TA_RIGHT, c: TA_CENTER }

function table(b: TableBlock, width: number): Flowable[] {
  const al = b.align.length ? b.align : Array(b.columns.length).fill('l')
  const styleFor: Record<string, ParagraphStyle> = { l: S.cell, r: S.cell_r, c: S.cell_c }
  const n = Math.min(b.columns.length, al.length)
  const head: CellValue[] = []
  for (let k = 0; k < n; k++) head.push(new Paragraph(escape(b.columns[k]), new ParagraphStyle('h', { parent: S.head, alignment: ALIGN[al[k]] })))
  const data: CellValue[][] = [head]
  b.rows.forEach((r, i) => {
    const bold = b.total_last && i === b.rows.length - 1
    const row: CellValue[] = []
    for (let k = 0; k < Math.min(r.length, al.length); k++) {
      row.push(new Paragraph(bold ? `<b>${escape(r[k])}</b>` : escape(r[k]), styleFor[al[k]]))
    }
    data.push(row)
  })
  const cols = columnWidths(b, width)
  const t = new Table(data, { colWidths: cols, repeatRows: 1 })
  const ts: Cmd[] = [['BACKGROUND', [0, 0], [-1, 0], NAVY], ['VALIGN', [0, 0], [-1, -1], 'TOP'], ['LINEBELOW', [0, 1], [-1, -1], 0.4, RULE],
    ['TOPPADDING', [0, 0], [-1, -1], 3], ['BOTTOMPADDING', [0, 0], [-1, -1], 3], ['LEFTPADDING', [0, 0], [-1, -1], 4],
    ['RIGHTPADDING', [0, 0], [-1, -1], 4]] as Cmd[]
  for (let i = 2; i < data.length; i += 2) ts.push(['BACKGROUND', [0, i], [-1, i], ZEBRA] as Cmd)
  if (b.total_last) ts.push(['LINEABOVE', [0, -1], [-1, -1], 1.0, INK] as Cmd)
  t.setStyle(new TableStyle(ts))
  const cap = new Paragraph(`<b>Table ${escape(b.number)}.</b> ${escape(b.caption)}`, S.cap)
  const note = b.note ? [new Paragraph(escape(b.note), S.tnote)] : []
  return [new CondPageBreak(1.3 * inch), cap, t, ...note, new Spacer(1, 8)]
}

function figure(b: FigureBlock, width: number): Flowable[] {
  const n = b.scenes.length
  const gap = 8
  const w = (width - gap * (n - 1)) / n
  const cells: CellValue[] = []
  b.scenes.forEach((sc, k) => {
    const label = k < b.labels.length ? b.labels[k] : ''
    const inner: Flowable[] = label ? [new Paragraph(escape(label), S.panel)] : []
    inner.push(toDrawing(sc, w - 4))
    cells.push(inner)
  })
  const t = new Table([cells], { colWidths: Array(n).fill(w) })
  t.setStyle(new TableStyle([['VALIGN', [0, 0], [-1, -1], 'TOP'], ['LEFTPADDING', [0, 0], [-1, -1], 0], ['RIGHTPADDING', [0, 0], [-1, -1], 0]] as Cmd[]))
  const cap = new Paragraph(`<b>Figure ${b.number}.</b> ${escape(b.caption)}`, S.cap)
  return [new KeepTogether([t, cap]), new Spacer(1, 6)]
}

/** render_pdf: the document's bytes, dated ``timeStamp`` (SOURCE_DATE_EPOCH's, or now). */
export function renderPdf(doc: ReportDoc, timeStamp: TimeStamp | null = null): Uint8Array {
  const [pw, ph] = letter
  const [lw, lh] = landscape(letter)
  const frameP = new Frame(MARGIN, 0.75 * inch, pw - 2 * MARGIN, ph - 1.5 * inch, { id: 'p' })
  const frameL = new Frame(MARGIN, 0.75 * inch, lw - 2 * MARGIN, lh - 1.5 * inch, { id: 'l' })
  const meta = new Map(doc.meta.map(([k, v]) => [k, v]))
  const d = new BaseDocTemplate({ pagesize: letter, leftMargin: MARGIN, rightMargin: MARGIN, topMargin: 0.75 * inch, bottomMargin: 0.75 * inch,
    title: doc.title, author: meta.get('Prepared by') ?? '', subject: doc.subtitle, creator: 'CEICA', timeStamp })
  const deco = decorate(doc)
  d.addPageTemplates([new PageTemplate('portrait', [frameP], deco, letter), new PageTemplate('landscape', [frameL], deco, landscape(letter))])
  const widthP = pw - 2 * MARGIN
  const widthL = lw - 2 * MARGIN
  const story: Flowable[] = [new Paragraph(escape(doc.title), S.title), new Paragraph(escape(doc.subtitle), S.sub)]
  const metaTable = new Table(doc.meta.map(([k, v]) => [new Paragraph(`<font color='#646f80'>${escape(k)}</font>`, S.meta),
    new Paragraph(escape(v), S.meta)]), { colWidths: [1.2 * inch, widthP - 1.2 * inch] })
  metaTable.setStyle(new TableStyle([['LEFTPADDING', [0, 0], [-1, -1], 0], ['TOPPADDING', [0, 0], [-1, -1], 1], ['BOTTOMPADDING', [0, 0], [-1, -1], 1],
    ['LINEBELOW', [0, -1], [-1, -1], 2, NAVY]] as Cmd[]))
  story.push(metaTable, new Spacer(1, 10))
  for (const b of doc.blocks) {
    if (b.type === 'heading') story.push(new Paragraph(escape(b.text), S[b.level === 1 ? 'h1' : 'h2']))
    else if (b.type === 'para') {
      if (b.kind === 'callout') {
        const box = new Table([[new Paragraph(escape(b.text), S.callout)]], { colWidths: [widthP] })
        box.setStyle(new TableStyle([['BACKGROUND', [0, 0], [-1, -1], OK_SOFT], ['LINEBEFORE', [0, 0], [0, -1], 3, OK], ['LEFTPADDING', [0, 0], [-1, -1], 9],
          ['TOPPADDING', [0, 0], [-1, -1], 6], ['BOTTOMPADDING', [0, 0], [-1, -1], 6]] as Cmd[]))
        story.push(box, new Spacer(1, 8))
      } else story.push(new Paragraph(escape(b.text), S[b.kind === 'note' ? 'note' : 'body']))
    } else if (b.type === 'bullets') {
      for (const [lead, text] of b.items) story.push(new Paragraph(`<b>${escape(lead)}</b> ${escape(text)}`, S.bullet, null, false, '•'))
      story.push(new Spacer(1, 4))
    } else if (b.type === 'figure') story.push(...figure(b, widthP))
    else if (b.type === 'table') {
      if (b.landscape) {
        story.push(new NextPageTemplate('landscape'), new PageBreak())
        story.push(...table(b, widthL))
        story.push(new NextPageTemplate('portrait'), new PageBreak())
      } else story.push(...table(b, widthP))
    } else story.push(new PageBreak())
  }
  return d.buildWith(story, (pagesize, opts) => new Numbered(pagesize, opts))
}
