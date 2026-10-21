// python-docx 1.2.0's Word files, for the documents ceica/report/docx.py makes: its XML as lxml writes
// it, its parts, relationships and content types, and the zip it saves.
//
// A document starts from python-docx's template (default.docx). The parts no report changes are the
// ones python-docx writes for it (src/content/docx/, copied by parity/copy_sources.py); the body, the
// header and footer, the core properties, the relationships and the content types are written here,
// each element as python-docx builds it (properties in their schema order, a section break's copy of
// the page settings without its rsid attributes, a new table's even column widths).
import { pyStrip } from '../../py/pystr'
import { pyRoundInt } from '../../py/pynum'
import { newInfo, ZIP_DEFLATED, ZipWriter, type DateTime } from '../zip'

// ---------------------------------------------------------------- lxml's text

/** lxml's refusal of a string it cannot write (a ValueError). */
export class XmlValueError extends Error {
  constructor(message = 'All strings must be XML compatible: Unicode or ASCII, no NULL bytes or control characters') {
    super(message)
    this.name = 'ValueError'
  }
}

/** lxml's check of text and attribute values: no control character but tab, newline and carriage
 * return, no U+FFFE or U+FFFF; a lone surrogate never reaches it (Python cannot encode one). */
export function xmlCompatible(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) throw new XmlValueError()
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1)
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        i++
        continue
      }
      throw new XmlValueError(`'utf-8' codec can't encode character '\\u${c.toString(16)}' in position ${i}: surrogates not allowed`)
    }
  }
  return s
}

/** Text content as libxml2 writes it. */
export const escText = (s: string): string =>
  xmlCompatible(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;')

/** An attribute value as libxml2 writes it. */
export const escAttr = (s: string): string =>
  xmlCompatible(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

/** An element with its text: <tag>text</tag>, empty text kept open as lxml keeps it. */
const textElement = (tag: string, text: string | null, attrs = ''): string =>
  text === null ? `<${tag}${attrs}/>` : `<${tag}${attrs}>${escText(text)}</${tag}>`

export const XML_HEAD = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"

// ---------------------------------------------------------------- lengths

export const EMU_PER_INCH = 914400
const EMU_PER_TWIP = 635
const EMU_PER_PT = 12700

/** Inches(x): EMU, truncated */
export const inches = (x: number): number => Math.trunc(x * EMU_PER_INCH)
/** Pt(x): EMU, truncated */
export const pt = (x: number): number => Math.trunc(x * EMU_PER_PT)
/** Length.twips: rounded half to even */
export const twips = (emu: number): number => pyRoundInt(emu / EMU_PER_TWIP)
/** a run's size in half points (ST_HpsMeasure) */
const halfPoints = (emu: number): number => Math.trunc((emu / EMU_PER_PT) * 2)

// ---------------------------------------------------------------- runs and paragraphs

/** A `w:r`: its properties (rPr children in schema order) and its content. */
export class Run {
  bold: boolean | null = null
  italic: boolean | null = null
  /** RRGGBB */
  color: string | null = null
  /** EMU */
  size: number | null = null
  private content: string[] = []

  /** Paragraph.add_run(text): the text only when there is some. */
  constructor(text = '') {
    if (text) this.setText(text)
  }

  /** Run.text = text: a w:t per stretch of text, w:tab for a tab, w:br for a line break (\n or \r). */
  setText(text: string): void {
    this.content = []
    let buf = ''
    const flush = (): void => {
      if (buf) this.content.push(textElement('w:t', buf, pyStrip(buf) !== buf ? ' xml:space="preserve"' : ''))
      buf = ''
    }
    for (const ch of text) {
      if (ch === '\t') {
        flush()
        this.content.push('<w:tab/>')
      } else if (ch === '\n' || ch === '\r') {
        flush()
        this.content.push('<w:br/>')
      } else buf += ch
    }
    flush()
  }

  /** run._r.append(element) */
  append(xml: string): void {
    this.content.push(xml)
  }

  /** run.font.size = Pt(x) and run.font.color.rgb = RGBColor(...) together. */
  font(size: number | null, color: string | null = null): this {
    if (size !== null) this.size = size
    if (color !== null) this.color = color
    return this
  }

  private rPr(): string {
    const parts: string[] = []
    const bool = (tag: string, v: boolean | null): void => {
      if (v !== null) parts.push(v ? `<${tag}/>` : `<${tag} w:val="0"/>`)
    }
    bool('w:b', this.bold)
    bool('w:i', this.italic)
    if (this.color !== null) parts.push(`<w:color w:val="${this.color}"/>`)
    if (this.size !== null) parts.push(`<w:sz w:val="${halfPoints(this.size)}"/>`)
    return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
  }

  xml(): string {
    const inner = this.rPr() + this.content.join('')
    return inner ? `<w:r>${inner}</w:r>` : '<w:r/>'
  }
}

/** A `w:p`: its properties (pPr children in schema order) and its runs. */
export class Paragraph {
  /** the style id */
  style: string | null = null
  keepNext: boolean | null = null
  /** twips */
  spaceAfter: number | null = null
  jc: string | null = null
  /** a section break: the section's settings */
  sectPr: string | null = null
  readonly runs: Run[] = []

  /** Paragraph.add_run */
  addRun(text = ''): Run {
    const r = new Run(text)
    this.runs.push(r)
    return r
  }

  xml(): string {
    const props: string[] = []
    if (this.style !== null) props.push(`<w:pStyle w:val="${escAttr(this.style)}"/>`)
    if (this.keepNext !== null) props.push(this.keepNext ? '<w:keepNext/>' : '<w:keepNext w:val="0"/>')
    if (this.spaceAfter !== null) props.push(`<w:spacing w:after="${this.spaceAfter}"/>`)
    if (this.jc !== null) props.push(`<w:jc w:val="${this.jc}"/>`)
    if (this.sectPr !== null) props.push(this.sectPr)
    const inner = (props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '') + this.runs.map((r) => r.xml()).join('')
    return inner ? `<w:p>${inner}</w:p>` : '<w:p/>'
  }
}

/** A Word field (SEQ, PAGE, NUMPAGES) with a cached value (docx._field): five runs. */
export function addField(par: Paragraph, instr: string, placeholder = '1'): void {
  par.addRun().append('<w:fldChar w:fldCharType="begin"/>')
  par.addRun().append(`<w:instrText xml:space="preserve">${escText(` ${instr} `)}</w:instrText>`)
  par.addRun().append('<w:fldChar w:fldCharType="separate"/>')
  par.addRun(placeholder)
  par.addRun().append('<w:fldChar w:fldCharType="end"/>')
}

// ---------------------------------------------------------------- tables

export class Cell {
  readonly shading: string[] = []
  readonly paragraph = new Paragraph()
  constructor(readonly width: number) {}

  xml(): string {
    return `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${this.width}"/>${this.shading.join('')}</w:tcPr>${this.paragraph.xml()}</w:tc>`
  }
}

export class Row {
  readonly trPr: string[] = []
  constructor(readonly cells: Cell[]) {}

  xml(): string {
    const inner = (this.trPr.length ? `<w:trPr>${this.trPr.join('')}</w:trPr>` : '') + this.cells.map((c) => c.xml()).join('')
    return inner ? `<w:tr>${inner}</w:tr>` : '<w:tr/>'
  }
}

/** A `w:tbl` as CT_Tbl.new_tbl makes it: the block's width shared evenly by the columns. */
export class Table {
  style: string | null = null
  readonly rows: Row[] = []
  readonly colWidth: number

  constructor(rows: number, readonly cols: number, blockWidth: number) {
    this.colWidth = twips(cols > 0 ? Math.floor(blockWidth / cols) : 0)
    for (let i = 0; i < rows; i++) this.addRow()
  }

  /** Table.add_row: a cell per grid column, each its column's width */
  addRow(): Row {
    const row = new Row(Array.from({ length: this.cols }, () => new Cell(this.colWidth)))
    this.rows.push(row)
    return row
  }

  xml(): string {
    const grid = this.cols ? `<w:tblGrid>${`<w:gridCol w:w="${this.colWidth}"/>`.repeat(this.cols)}</w:tblGrid>` : '<w:tblGrid/>'
    return '<w:tbl><w:tblPr>' + (this.style !== null ? `<w:tblStyle w:val="${escAttr(this.style)}"/>` : '')
      + '<w:tblW w:type="auto" w:w="0"/><w:tblLook w:firstColumn="1" w:firstRow="1" w:lastColumn="0" w:lastRow="0" w:noHBand="0" '
      + 'w:noVBand="1" w:val="04A0"/></w:tblPr>' + grid + this.rows.map((r) => r.xml()).join('') + '</w:tbl>'
  }
}

// ---------------------------------------------------------------- sections

/** A `w:sectPr`: the template's page settings (twips), with the margins and sizes a document sets. */
export class Section {
  rsids = true
  header: string | null = null
  footer: string | null = null
  orient: 'landscape' | null = null
  constructor(public width = 12240, public height = 15840, public margins = { top: 1440, right: 1800, bottom: 1440, left: 1800 }) {}

  /** CT_SectPr.clone: the same settings, without the root's rsid attributes */
  clone(): Section {
    const s = new Section(this.width, this.height, { ...this.margins })
    s.rsids = false
    s.header = this.header
    s.footer = this.footer
    s.orient = this.orient
    return s
  }

  /** the width between the margins, in EMU (Document._block_width) */
  blockWidth(): number {
    return this.width * EMU_PER_TWIP - this.margins.left * EMU_PER_TWIP - this.margins.right * EMU_PER_TWIP
  }

  xml(): string {
    const m = this.margins
    return (this.rsids ? '<w:sectPr w:rsidR="00FC693F" w:rsidRPr="0006063C" w:rsidSect="00034616">' : '<w:sectPr>')
      + (this.header !== null ? `<w:headerReference w:type="default" r:id="${this.header}"/>` : '')
      + (this.footer !== null ? `<w:footerReference w:type="default" r:id="${this.footer}"/>` : '')
      + `<w:pgSz w:w="${this.width}" w:h="${this.height}"${this.orient ? ` w:orient="${this.orient}"` : ''}/>`
      + `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="720" w:footer="720" w:gutter="0"/>`
      + '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>'
  }
}

// ---------------------------------------------------------------- the document

const NS_DOCUMENT = '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
  + 'xmlns:mv="urn:schemas-microsoft-com:mac:vml" xmlns:o="urn:schemas-microsoft-com:office:office" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" '
  + 'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
  + 'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
  + 'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" '
  + 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14">'

/** default-header.xml's and default-footer.xml's namespaces */
const NS_HDRFTR = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
  + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main" '
  + 'xmlns:mv="urn:schemas-microsoft-com:mac:vml" xmlns:o="urn:schemas-microsoft-com:office:office" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" '
  + 'xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" '
  + 'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
  + 'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" '
  + 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 wp14"'

const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
/** the template's document relationships, in its order */
const DOCUMENT_RELS: readonly (readonly [string, string, string])[] = [
  ['rId3', `${RT}/styles`, 'styles.xml'],
  ['rId4', 'http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects', 'stylesWithEffects.xml'],
  ['rId5', `${RT}/settings`, 'settings.xml'],
  ['rId6', `${RT}/webSettings`, 'webSettings.xml'],
  ['rId7', `${RT}/fontTable`, 'fontTable.xml'],
  ['rId8', `${RT}/theme`, 'theme/theme1.xml'],
  ['rId1', `${RT}/customXml`, '../customXml/item1.xml'],
  ['rId2', `${RT}/numbering`, 'numbering.xml'],
]

const CT = 'application/vnd.openxmlformats-officedocument'
/** the parts with a content type of their own (Override), by part name */
const OVERRIDES: Readonly<Record<string, string>> = {
  '/customXml/itemProps1.xml': `${CT}.customXmlProperties+xml`,
  '/docProps/app.xml': `${CT}.extended-properties+xml`,
  '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
  '/word/document.xml': `${CT}.wordprocessingml.document.main+xml`,
  '/word/fontTable.xml': `${CT}.wordprocessingml.fontTable+xml`,
  '/word/footer1.xml': `${CT}.wordprocessingml.footer+xml`,
  '/word/header1.xml': `${CT}.wordprocessingml.header+xml`,
  '/word/numbering.xml': `${CT}.wordprocessingml.numbering+xml`,
  '/word/settings.xml': `${CT}.wordprocessingml.settings+xml`,
  '/word/styles.xml': `${CT}.wordprocessingml.styles+xml`,
  '/word/stylesWithEffects.xml': 'application/vnd.ms-word.stylesWithEffects+xml',
  '/word/theme/theme1.xml': `${CT}.theme+xml`,
  '/word/webSettings.xml': `${CT}.wordprocessingml.webSettings+xml`,
}

/** The parts every report holds as python-docx writes them (src/content/docx/). */
export interface ConstantParts {
  styles: string
  stylesWithEffects: string
  settings: string
  webSettings: string
  fontTable: string
  theme: string
  numbering: string
  item1: string
  item1Rels: string
  itemProps1: string
  app: string
  packageRels: string
  thumbnail: Uint8Array
}

/** A picture's pixel size and dpi, as python-docx's PNG reader takes them. */
export interface PictureInfo { readonly width: number, readonly height: number, readonly dpi: number }

/** The document being built: python-docx's Document() on its template, with CEICA's margins. */
export class WordDocument {
  /** the body's blocks, as XML or as paragraphs and tables still taking runs */
  private readonly body: (Paragraph | Table | string)[] = []
  /** the last section's settings (the body's own sectPr) */
  readonly section = new Section()
  readonly header = new Paragraph()
  readonly footer = new Paragraph()
  /** image parts: bytes, in the order added */
  private readonly images: Uint8Array[] = []
  private readonly rels: [string, string, string][] = DOCUMENT_RELS.map(([a, b, c]) => [a, b, c])
  private nextShapeId = 1
  title = ''
  subject = ''
  author = ''

  constructor() {
    this.header.style = 'Header'
    this.footer.style = 'Footer'
  }

  /** a relationship from the document, with the next free rId (_Relationships._next_rId) */
  private relate(type: string, target: string): string {
    const taken = new Set(this.rels.map(([id]) => id))
    let n = 1
    while (taken.has(`rId${n}`)) n++
    const id = `rId${n}`
    this.rels.push([id, type, target])
    return id
  }

  /** sec.header and sec.footer: their parts, referenced from the first section */
  addHeaderFooter(): void {
    this.section.header = this.relate(`${RT}/header`, 'header1.xml')
    this.section.footer = this.relate(`${RT}/footer`, 'footer1.xml')
  }

  /** Document.add_paragraph(text, style) */
  addParagraph(text = '', style: string | null = null): Paragraph {
    const p = new Paragraph()
    if (text) p.addRun(text)
    if (style !== null) p.style = style
    this.body.push(p)
    return p
  }

  /** Document.add_table(rows, cols): the last section's width between its margins */
  addTable(rows: number, cols: number): Table {
    const t = new Table(rows, cols, this.section.blockWidth())
    this.body.push(t)
    return t
  }

  /** Document.add_section(): the current settings end a section in a paragraph of their own (no
   * rsids); the new last section keeps them, less the header and footer references. */
  addSection(): Section {
    const p = new Paragraph()
    p.sectPr = this.section.clone().xml()
    this.body.push(p)
    this.section.header = null
    this.section.footer = null
    return this.section
  }

  /** Run.add_picture(png, width): an inline picture scaled to the width (EMU), its image part shared
   * by equal pictures; ``descr`` its alt text. */
  addPicture(run: Run, png: Uint8Array, info: PictureInfo, width: number, descr: string): void {
    let k = this.images.findIndex((b) => b.length === png.length && b.every((v, i) => v === png[i]))
    if (k < 0) {
      this.images.push(png)
      k = this.images.length - 1
      this.relate(`${RT}/image`, `media/image${k + 1}.png`)
    }
    const rId = this.rels.find(([, , target]) => target === `media/image${k + 1}.png`)![0]
    // Image.width: Inches(px / dpi); the height scaled as the width is
    const nativeW = Math.trunc((info.width / info.dpi) * EMU_PER_INCH)
    const nativeH = Math.trunc((info.height / info.dpi) * EMU_PER_INCH)
    const cy = pyRoundInt(nativeH * (width / nativeW))
    const id = this.nextShapeId++
    run.append('<w:drawing><wp:inline xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + `<wp:extent cx="${width}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${escAttr(descr)}"/>`
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>'
      + '<pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>'
      + `<a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>`
      + `<a:ext cx="${width}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic>`
      + '</wp:inline></w:drawing>')
  }

  private documentXml(): string {
    const body = this.body.map((b) => (typeof b === 'string' ? b : b.xml())).join('') + this.section.xml()
    return `${XML_HEAD}${NS_DOCUMENT}<w:body>${body}</w:body></w:document>`
  }

  private coreXml(): string {
    // CoreProperties._set_element_text, property by property: the length, then lxml's check
    const prop = (tag: string, v: string): string => {
      if ([...v].length > 255) throw new XmlValueError(`exceeded 255 char limit for property, got:\n\n'${v}'`)
      return textElement(tag, v)
    }
    const props = prop('dc:title', this.title) + prop('dc:subject', this.subject) + prop('dc:creator', this.author)
    return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
      + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + props
      + '<cp:keywords/><dc:description>generated by python-docx</dc:description><cp:lastModifiedBy/><cp:revision>1</cp:revision>'
      + '<dcterms:created xsi:type="dcterms:W3CDTF">2013-12-23T23:15:00Z</dcterms:created>'
      + '<dcterms:modified xsi:type="dcterms:W3CDTF">2013-12-23T23:15:00Z</dcterms:modified><cp:category/></cp:coreProperties>'
  }

  private relsXml(): string {
    return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + this.rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') + '</Relationships>'
  }

  private contentTypesXml(): string {
    const defaults: [string, string][] = [['jpeg', 'image/jpeg'], ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
      ['xml', 'application/xml']]
    if (this.images.length) defaults.push(['png', 'image/png'])
    defaults.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const names = Object.keys(OVERRIDES).sort()
    return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('')
      + names.map((n) => `<Override PartName="${n}" ContentType="${OVERRIDES[n]}"/>`).join('') + '</Types>'
  }

  private hdrFtrXml(tag: string, p: Paragraph): string {
    return `${XML_HEAD}<${tag} ${NS_HDRFTR}>${p.xml()}</${tag}>`
  }

  /** Document.save: the parts in python-docx's order (each part, then its relationships, then the
   * parts it relates to), deflated and dated ``now`` as zipfile.writestr dates them. */
  save(c: ConstantParts, now: DateTime): Uint8Array {
    const z = new ZipWriter()
    const put = (name: string, data: string | Uint8Array): void => z.writestr(newInfo(name, now, ZIP_DEFLATED), data)
    put('[Content_Types].xml', this.contentTypesXml())
    put('_rels/.rels', c.packageRels)
    put('docProps/core.xml', this.coreXml())
    put('docProps/app.xml', c.app)
    put('word/document.xml', this.documentXml())
    put('word/_rels/document.xml.rels', this.relsXml())
    put('word/styles.xml', c.styles)
    put('word/stylesWithEffects.xml', c.stylesWithEffects)
    put('word/settings.xml', c.settings)
    put('word/webSettings.xml', c.webSettings)
    put('word/fontTable.xml', c.fontTable)
    put('word/theme/theme1.xml', c.theme)
    put('customXml/item1.xml', c.item1)
    put('customXml/_rels/item1.xml.rels', c.item1Rels)
    put('customXml/itemProps1.xml', c.itemProps1)
    put('word/numbering.xml', c.numbering)
    put('word/header1.xml', this.hdrFtrXml('w:hdr', this.header))
    put('word/footer1.xml', this.hdrFtrXml('w:ftr', this.footer))
    this.images.forEach((png, k) => put(`word/media/image${k + 1}.png`, png))
    put('docProps/thumbnail.jpeg', c.thumbnail)
    return z.finish()
  }
}

/** a PNG's dpi as python-docx reads it from pHYs (72 without one) */
export function pngDpi(ppm: number | null): number {
  return ppm ? pyRoundInt(ppm * 0.0254) : 72
}
