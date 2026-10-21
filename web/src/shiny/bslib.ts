// bslib's <bslib-layout-columns> element (bslib 0.11's web-components.min.js, which the Shiny page
// loads): as it joins the page it marks itself a grid, then, a moment later, gives each column its
// grid classes (g-col-sm-6 and so on) from its col-widths-* attributes. CEICA lays out columns only
// with explicit widths (the New project dialog's 6 and 6), so the automatic widths (a null width) are
// not ported: such an element is left as it is, with a warning.

/** the breakpoints bslib reads first, in this order */
const BREAKPOINTS = ['sm', 'md', 'lg', 'xl', 'xxl']

interface Spec { width: number[], before: number[], after: number[] }

/** bslib's _readColWidths: each breakpoint's widths (null for automatic ones) */
function readColWidths(el: Element): Map<string, (number | null)[] | null> {
  const attrs = new Map(el.getAttributeNames().filter((n) => n.startsWith('col-widths-')).map((n) => [n, el.getAttribute(n)!]))
  const out = new Map<string, (number | null)[] | null>()
  const parse = (v: string): (number | null)[] | null => (['null', 'true', ''].includes(v) ? null : v.split(',').map(Number))
  for (const bp of BREAKPOINTS) {
    const name = `col-widths-${bp}`
    const v = attrs.get(name)
    if (v !== undefined) {
      out.set(bp, parse(v))
      attrs.delete(name)
    }
  }
  for (const [name, v] of attrs) out.set(name.replace('col-widths-', ''), parse(v))
  return out
}

/** bslib's Ye: widths as column spans, with the offsets before and after each */
function specOf(widths: Map<string, (number | null)[] | null>): Map<string, Spec> | null {
  const spec = new Map<string, Spec>()
  for (const [bp, w] of widths) {
    if (w === null || w.some((x) => x === null || isNaN(x))) return null
    const v = w as number[]
    if (v.some((x) => x === 0)) throw new Error('Column values must be greater than 0 to indicate width, or negative to indicate a column offset.')
    if (v.every((x) => x > 0)) {
      spec.set(bp, { width: v, before: Array(v.length).fill(0), after: Array(v.length).fill(0) })
      continue
    }
    const at = v.map((x, i) => (x > 0 ? i : -1)).filter((i) => i !== -1)
    const last = Math.max(...at)
    const before = Array(at.length).fill(0)
    const after = Array(at.length).fill(0)
    let k = 0
    for (let i = 0; i < v.length; i++) {
      if (v[i] > 0) k++
      else if (i > last) after[after.length - 1] += Math.abs(v[i])
      else before[k] += Math.abs(v[i])
    }
    spec.set(bp, { width: at.map((i) => v[i]), before, after })
  }
  return spec
}

const repeat = (xs: number[], n: number): number[] => Array.from({ length: n }, (_, i) => xs[i % xs.length])

/** bslib's mt: each column's grid classes, breakpoint by breakpoint */
function applySpec(spec: Map<string, Spec>, children: HTMLCollection, units = 12): void {
  const n = children.length
  for (const [bp, s] of spec) {
    const width = repeat(s.width, n)
    const before = repeat(s.before, n)
    const after = repeat(s.after, n)
    let h = 0
    const advance = (d: number, offset = false): void => {
      h = Math.abs(h)
      let f = h + d
      if (f === units) f = 0
      if (f > units) f = offset ? -1 * (f % units) : d
      h = f
    }
    for (let d = 0; d < n; d++) {
      let start = false
      const off = before[d] + (d > 0 ? after[d - 1] : 0)
      const span = Math.min(width[d], units)
      let room = units - h
      if (off > 0) {
        advance(off, true)
        if (h < 0) {
          h = Math.abs(h)
          if (width[d] > units - h) h = 0
          room = 0
        }
        start = room >= width[d] || h > 0
      }
      if (h > 0 && h + width[d] > units) {
        start = true
        h = 0
      }
      if (start) children[d].classList.add(bp === 'xs' ? `g-start-${h + 1}` : `g-start-${bp}-${h + 1}`)
      children[d].classList.add(bp === 'xs' ? `g-col-${span}` : `g-col-${bp}-${span}`)
      advance(span)
    }
  }
}

class LayoutColumns extends HTMLElement {
  connectedCallback(): void {
    this.classList.add('grid')
    const widths = readColWidths(this)
    setTimeout(() => {
      const spec = specOf(widths)
      if (spec === null) console.warn('bslib-layout-columns: automatic column widths are not in the web app')
      else applySpec(spec, this.children)
      this.removeAttribute('hidden-until-init')
    })
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('bslib-layout-columns')) {
  customElements.define('bslib-layout-columns', LayoutColumns)
}
