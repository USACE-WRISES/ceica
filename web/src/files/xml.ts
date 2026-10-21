// XML text as lxml (libxml2) writes it, for the files whose Python writers go through lxml: openpyxl's
// workbook parts (written ASCII: every other character as one decimal reference) and python-docx's
// Word parts (written UTF-8).
//
// Text: & < > escaped, and a carriage return as &#13;. An attribute: & < > " escaped, and a tab, line
// feed or carriage return as &#9; &#10; &#13;.

const TEXT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' }
const ATTR: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' }

function escape(s: string, table: Record<string, string>, ascii: boolean): string {
  let out = ''
  for (const ch of s) {
    const e = table[ch]
    if (e !== undefined) out += e
    else if (ascii && ch.codePointAt(0)! > 0x7f) out += `&#${ch.codePointAt(0)};`
    else out += ch
  }
  return out
}

/** A text node's content as lxml writes it (``ascii``: the ASCII encoding openpyxl's parts use). */
export const escText = (s: string, ascii = false): string => escape(s, TEXT, ascii)

/** An attribute's value as lxml writes it, without its quotes. */
export const escAttr = (s: string, ascii = false): string => escape(s, ATTR, ascii)

// --- reading --------------------------------------------------------------------------------------

/** An element as lxml gives it: its namespace and local name, its attributes (a namespaced one keyed
 * "{uri}name", as ElementTree keys it), the text before its first child, and its children. */
export interface XmlElement {
  readonly ns: string
  readonly name: string
  readonly attrs: Map<string, string>
  text: string | null
  readonly children: XmlElement[]
}

/** A document that is not well-formed XML. */
export class XmlError extends Error {}

const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME_END = /[\s/>=]/
const SPACE = /\s/

function reference(ref: string): string {
  if (ref[0] === '#') {
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) throw new XmlError(`invalid character reference &${ref};`)
    return String.fromCodePoint(code)
  }
  const v = PREDEFINED[ref]
  if (v === undefined) throw new XmlError(`undefined entity &${ref};`)
  return v
}

/** Character data with its references resolved; in an attribute, literal tabs and line ends read as
 * spaces (attribute value normalization). */
function decode(s: string, attribute: boolean): string {
  if (!s.includes('&') && !(attribute && /[\t\n]/.test(s))) return s
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '&') {
      const end = s.indexOf(';', i)
      if (end < 0) throw new XmlError('unterminated reference')
      out += reference(s.slice(i + 1, end))
      i = end + 1
    } else {
      out += attribute && (ch === '\t' || ch === '\n') ? ' ' : ch
      i++
    }
  }
  return out
}

/** One XML document's root element. Line ends read as \n; the declaration, comments, processing
 * instructions and a document type are skipped; CDATA is text. */
export function parseXml(source: string): XmlElement {
  const s = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const stack: { el: XmlElement, ns: Map<string, string> }[] = []
  const doc: { root: XmlElement | null } = { root: null }
  let i = 0
  const addText = (text: string): void => {
    const top = stack[stack.length - 1]
    if (!top) {
      if (text.trim()) throw new XmlError('text outside the root element')
      return
    }
    // lxml's .text: the text before the first child (later text is a child's tail)
    if (!top.el.children.length) top.el.text = (top.el.text ?? '') + text
  }
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      addText(decode(s.slice(i), false))
      break
    }
    if (lt > i) addText(decode(s.slice(i, lt), false))
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2)
      if (end < 0) throw new XmlError('unterminated processing instruction')
      i = end + 2
    } else if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4)
      if (end < 0) throw new XmlError('unterminated comment')
      i = end + 3
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9)
      if (end < 0) throw new XmlError('unterminated CDATA section')
      addText(s.slice(lt + 9, end))
      i = end + 3
    } else if (s.startsWith('<!', lt)) {
      // a document type, its internal subset in brackets
      let depth = 0
      let j = lt + 2
      for (; j < s.length; j++) {
        if (s[j] === '[') depth++
        else if (s[j] === ']') depth--
        else if (s[j] === '>' && depth <= 0) break
      }
      i = j + 1
    } else if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt)
      if (end < 0) throw new XmlError('unterminated end tag')
      const qname = s.slice(lt + 2, end).trim()
      const top = stack.pop()
      if (!top) throw new XmlError(`unexpected end tag ${qname}`)
      const local = qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname
      if (local !== top.el.name) throw new XmlError(`mismatched end tag ${qname}`)
      i = end + 1
    } else {
      i = startTag(s, lt, stack, (el) => {
        if (doc.root) throw new XmlError('more than one root element')
        doc.root = el
      })
    }
  }
  if (stack.length) throw new XmlError(`unclosed element ${stack[stack.length - 1].el.name}`)
  if (!doc.root) throw new XmlError('no root element')
  return doc.root
}

/** A start tag at ``lt``: its element added to its parent (or as the root) and opened unless empty;
 * returns the index after the tag. */
function startTag(s: string, lt: number, stack: { el: XmlElement, ns: Map<string, string> }[],
  setRoot: (el: XmlElement) => void): number {
  let j = lt + 1
  while (j < s.length && !NAME_END.test(s[j])) j++
  const qname = s.slice(lt + 1, j)
  if (!qname) throw new XmlError('empty element name')
  const raw: [string, string][] = []
  let empty = false
  for (;;) {
    while (j < s.length && SPACE.test(s[j])) j++
    if (j >= s.length) throw new XmlError('unterminated start tag')
    if (s[j] === '>') {
      j++
      break
    }
    if (s[j] === '/' && s[j + 1] === '>') {
      empty = true
      j += 2
      break
    }
    const a0 = j
    while (j < s.length && !NAME_END.test(s[j])) j++
    const aname = s.slice(a0, j)
    while (j < s.length && SPACE.test(s[j])) j++
    if (s[j] !== '=') throw new XmlError(`attribute ${aname} without a value`)
    j++
    while (j < s.length && SPACE.test(s[j])) j++
    const q = s[j]
    if (q !== '"' && q !== "'") throw new XmlError(`attribute ${aname} not quoted`)
    const vend = s.indexOf(q, j + 1)
    if (vend < 0) throw new XmlError('unterminated attribute value')
    raw.push([aname, decode(s.slice(j + 1, vend), true)])
    j = vend + 1
  }
  const parentNs = stack.length ? stack[stack.length - 1].ns : new Map([['xml', XML_NS]])
  let ns = parentNs
  for (const [k, v] of raw) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) {
      if (ns === parentNs) ns = new Map(parentNs)
      ns.set(k === 'xmlns' ? '' : k.slice(6), v)
    }
  }
  const resolve = (q: string, attribute: boolean): [string, string] => {
    const c = q.indexOf(':')
    if (c < 0) return [attribute ? '' : ns.get('') ?? '', q]
    const uri = ns.get(q.slice(0, c))
    if (uri === undefined) throw new XmlError(`undeclared namespace prefix in ${q}`)
    return [uri, q.slice(c + 1)]
  }
  const [uri, local] = resolve(qname, false)
  const attrs = new Map<string, string>()
  for (const [k, v] of raw) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) continue
    const [au, al] = resolve(k, true)
    attrs.set(au ? `{${au}}${al}` : al, v)
  }
  const el: XmlElement = { ns: uri, name: local, attrs, text: null, children: [] }
  if (stack.length) stack[stack.length - 1].el.children.push(el)
  else setRoot(el)
  if (!empty) stack.push({ el, ns })
  return j
}

/** The element's children with this local name. */
export const childrenNamed = (el: XmlElement, name: string): XmlElement[] => el.children.filter((c) => c.name === name)

/** The element's first child with this local name, or null. */
export const childNamed = (el: XmlElement, name: string): XmlElement | null => el.children.find((c) => c.name === name) ?? null
