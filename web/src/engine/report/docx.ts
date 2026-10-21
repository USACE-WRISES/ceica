// The document as Word (ceica/report/docx.py), ready to paste into a feasibility report.
//
// Heading styles build Word's navigation pane; captions carry SEQ fields, so Word can insert a list of
// figures and tables; table header rows repeat across pages; wide tables sit in landscape sections.
// Each figure is one PNG of its panels (the same scenes as the PDF and HTML) with alt text, so it
// copies into another document as one picture. The file is python-docx's (files/docx/writer.ts); its
// constant parts load with this module, only when a Word file is made.
import APP from '../../content/docx/app.xml?raw'
import FONT_TABLE from '../../content/docx/fontTable.xml?raw'
import ITEM1 from '../../content/docx/item1.xml?raw'
import ITEM1_RELS from '../../content/docx/item1.xml.rels?raw'
import ITEM_PROPS1 from '../../content/docx/itemProps1.xml?raw'
import NUMBERING from '../../content/docx/numbering.xml?raw'
import PACKAGE_RELS from '../../content/docx/package.rels?raw'
import SETTINGS from '../../content/docx/settings.xml?raw'
import STYLES from '../../content/docx/styles.xml?raw'
import STYLES_WITH_EFFECTS from '../../content/docx/stylesWithEffects.xml?raw'
import THEME from '../../content/docx/theme1.xml?raw'
import THUMBNAIL from '../../content/docx/thumbnail.jpeg.b64?raw'
import WEB_SETTINGS from '../../content/docx/webSettings.xml?raw'
import { addField, inches, pngDpi, pt, twips, WordDocument, type ConstantParts, type Paragraph } from '../../files/docx/writer'
import type { DateTime } from '../../files/zip'
import { pyIsDigit } from '../../py/pystr'
import { pngInfo, renderPngPanels, type PngMaker } from '../figures/raster'
import type { ReportDoc } from './model'

const INK = '2A3344'
const MUTED = '646F80'
const WHITE = 'FFFFFF'
const ALIGN: Readonly<Record<string, string>> = { l: 'left', r: 'right', c: 'center' }

function align(a: string): string {
  const v = ALIGN[a]
  if (v === undefined) throw new Error(`KeyError: '${a}'`)
  return v
}

function constants(): ConstantParts {
  return {
    styles: STYLES, stylesWithEffects: STYLES_WITH_EFFECTS, settings: SETTINGS, webSettings: WEB_SETTINGS, fontTable: FONT_TABLE,
    theme: THEME, numbering: NUMBERING, item1: ITEM1, item1Rels: ITEM1_RELS, itemProps1: ITEM_PROPS1, app: APP, packageRels: PACKAGE_RELS,
    thumbnail: Uint8Array.from(atob(THUMBNAIL.trim()), (c) => c.charCodeAt(0)),
  }
}

const shade = (hex: string): string => `<w:shd w:val="clear" w:color="auto" w:fill="${hex}"/>`

function caption(doc: WordDocument, kind: 'Figure' | 'Table', number: number | string, text: string): void {
  const par = doc.addParagraph('', 'Caption')
  par.addRun(`${kind} `).bold = true
  if (kind === 'Table' && !pyIsDigit(String(number))) {
    par.addRun(String(number)).bold = true
  } else {
    addField(par, `SEQ ${kind} \\* ARABIC`, String(number))
    for (const run of par.runs) run.bold = true
  }
  par.addRun(`. ${text}`).bold = false
  for (const run of par.runs) run.font(pt(9), INK)
  par.keepNext = kind === 'Table'
}

/** a new section, landscape or portrait (docx._section) */
function section(doc: WordDocument, landscape: boolean): void {
  const sec = doc.addSection()
  const [w, h] = [sec.width, sec.height]
  if ((landscape && w < h) || (!landscape && w > h)) [sec.width, sec.height] = [h, w]
  sec.orient = landscape ? 'landscape' : null
}

function muted(par: Paragraph, size: number): void {
  for (const run of par.runs) run.font(pt(size), MUTED)
}

/** The Word file of a document; figures drawn by ``png`` at 130 dpi, the zip dated ``now``. */
export async function renderDocx(m: ReportDoc, png: PngMaker, now: DateTime): Promise<Uint8Array> {
  const doc = new WordDocument()
  // the Normal style's Calibri 10.5 is in the copied styles.xml
  const one = twips(inches(1))
  const top = twips(inches(0.9))
  doc.section.margins = { top, right: one, bottom: top, left: one }
  // header and footer
  doc.addHeaderFooter()
  doc.header.addRun(m.title + (m.status === 'DRAFT' ? '    DRAFT' : ''))
  muted(doc.header, 8)
  const fp = doc.footer
  fp.addRun(`${m.footer}    Page `)
  addField(fp, 'PAGE')
  fp.addRun(' of ')
  addField(fp, 'NUMPAGES')
  muted(fp, 8)

  const title = doc.addParagraph().addRun(m.title)
  title.bold = true
  title.font(pt(22), INK)
  doc.addParagraph().addRun(m.subtitle).font(pt(12), MUTED)
  for (const [k, v] of m.meta) {
    const par = doc.addParagraph()
    par.addRun(`${k}: `).font(pt(9.5), MUTED)
    par.addRun(v).font(pt(9.5))
    par.spaceAfter = 0
  }
  if (m.status === 'DRAFT') {
    const r = doc.addParagraph().addRun('DRAFT')
    r.bold = true
    r.color = '9A6700'
  }

  const usable = inches(6.5)
  for (const b of m.blocks) {
    if (b.type === 'heading') {
      if (!(b.level >= 0 && b.level <= 9)) throw new Error(`ValueError: level must be in range 0-9, got ${b.level}`)
      doc.addParagraph(b.text, b.level === 0 ? 'Title' : `Heading${b.level}`)
    } else if (b.type === 'para') {
      if (b.kind === 'callout') {
        const cell = doc.addTable(1, 1).rows[0].cells[0]
        cell.shading.push(shade('E9F6EE'))
        cell.paragraph.addRun(b.text).color = INK
        doc.addParagraph()
      } else {
        const par = doc.addParagraph(b.text)
        if (b.kind === 'note') {
          for (const run of par.runs) {
            run.italic = true
            run.color = MUTED
          }
        }
      }
    } else if (b.type === 'bullets') {
      for (const [lead, text] of b.items) {
        const par = doc.addParagraph('', 'ListBullet')
        par.addRun(`${lead} `).bold = true
        par.addRun(text)
      }
    } else if (b.type === 'figure') {
      // 130 dpi on the scene's 96 px per inch: about 200 dpi once Word fits the figure to the text width
      const image = await renderPngPanels(b.scenes, b.labels, 130, png)
      const info = pngInfo(image)
      const par = doc.addParagraph()
      par.jc = 'center'
      par.keepNext = true
      doc.addPicture(par.addRun(), image, { width: info.width, height: info.height, dpi: pngDpi(info.ppm) },
        b.scenes.length > 1 ? usable : Math.trunc(usable * 0.62), `Figure ${b.number}. ` + b.scenes.map((s) => s.desc).join(' '))
      caption(doc, 'Figure', b.number, b.caption)
    } else if (b.type === 'table') {
      if (b.landscape) section(doc, true)
      caption(doc, 'Table', b.number, b.caption)
      const al = b.align.length ? b.align : b.columns.map(() => 'l')
      const t = doc.addTable(1, b.columns.length)
      t.style = 'TableGrid'
      const hdr = t.rows[0]
      hdr.trPr.push('<w:tblHeader w:val="true"/>')
      for (let c = 0; c < Math.min(b.columns.length, al.length); c++) {
        const cell = hdr.cells[c]
        cell.shading.push(shade('2F4B7C'))
        cell.paragraph.jc = align(al[c])
        const run = cell.paragraph.addRun(b.columns[c])
        run.bold = true
        run.font(pt(8), WHITE)
      }
      b.rows.forEach((row, i) => {
        const cells = t.addRow()
        cells.trPr.push('<w:cantSplit w:val="true"/>')
        const bold = b.total_last && i === b.rows.length - 1
        for (let c = 0; c < Math.min(row.length, al.length); c++) {
          const par = cells.cells[c].paragraph
          par.jc = align(al[c])
          const run = par.addRun(row[c])
          run.font(pt(8))
          run.bold = bold
        }
      })
      if (b.note) doc.addParagraph().addRun(b.note).font(pt(8), MUTED)
      doc.addParagraph()
      if (b.landscape) section(doc, false)
    } else {
      doc.addParagraph().addRun().append('<w:br w:type="page"/>')
    }
  }
  doc.title = m.title
  doc.subject = m.subtitle
  doc.author = m.meta.reduce((a, [k, v]) => (k === 'Prepared by' ? v : a), '')
  return doc.save(constants(), now)
}
