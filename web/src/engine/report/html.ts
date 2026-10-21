// The report as one self-contained HTML page: inline SVG figures, print CSS, no scripts
// (ceica/report/html.py). It is the accessible copy of the report (headings, figure and table captions,
// header cells), and the browser's Print to PDF makes a tagged PDF from it.
//
// The Python fills a Jinja2 template with autoescape on: text is escaped as markupsafe escapes it
// (& < > " ' as &amp; &lt; &gt; &#34; &#39;), the style sheet and the body go in as they are, and the
// template's final line break is dropped (Jinja's keep_trailing_newline is off).
import { render } from '../figures/svg'
import type { Block, ReportDoc } from './model'

export const CSS = `
@page { size: letter; margin: 0.9in 0.85in; }
:root { --navy:#2f4b7c; --ink:#2a3344; --text:#33415c; --muted:#646f80; --rule:#d5deea;
  --soft:#f6f8fb; }
* { box-sizing: border-box; }
body { font-family: "Instrument Sans", "Segoe UI", Helvetica, Arial, sans-serif; color: var(--text);
  font-size: 10.5pt; line-height: 1.45; margin: 0; background: #fff; }
.page { max-width: 8.5in; margin: 0 auto; padding: 0.6in 0.7in 0.8in; }
header.title { border-bottom: 3px solid var(--navy); padding-bottom: 14px; margin-bottom: 18px; }
header.title h1 { font-family: "Space Grotesk", "Segoe UI", sans-serif; color: var(--ink);
  font-size: 22pt; margin: 0 0 4px; line-height: 1.15; }
header.title .sub { color: var(--muted); font-size: 12pt; margin-bottom: 10px; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; font-size: 9.5pt; }
.meta dt { color: var(--muted); } .meta dd { margin: 0; color: var(--ink); }
.draft { display: inline-block; margin-top: 8px; padding: 2px 10px; border: 1.5px solid #9a6700;
  color: #9a6700; font-weight: 700; letter-spacing: .08em; font-size: 9pt; border-radius: 4px; }
h2 { font-family: "Space Grotesk", "Segoe UI", sans-serif; color: var(--ink); font-size: 15pt;
  margin: 22px 0 8px; break-after: avoid; }
h3 { font-family: "Space Grotesk", "Segoe UI", sans-serif; color: var(--ink); font-size: 12pt;
  margin: 18px 0 6px; break-after: avoid; }
p { margin: 6px 0 8px; }
p.callout { border-left: 4px solid #1a7f37; background: #e9f6ee; padding: 8px 12px;
  color: var(--ink); }
p.note { color: var(--muted); font-style: italic; }
ul.bullets { margin: 4px 0 10px; padding-left: 20px; } ul.bullets li { margin: 3px 0; }
figure { margin: 12px 0 14px; break-inside: avoid; }
.panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.panels.one { grid-template-columns: 1fr; }
.panel-label { font-weight: 600; font-size: 9pt; color: var(--ink); margin: 0 0 2px 4px; }
figure svg { width: 100%; height: auto; display: block; }
figcaption, caption { font-size: 9pt; color: var(--text); text-align: left; }
figcaption { margin-top: 4px; } figcaption b, caption b { color: var(--ink); }
table { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 8.8pt;
  break-inside: auto; }
caption { caption-side: top; padding-bottom: 5px; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: var(--navy); color: #fff; font-weight: 600; padding: 5px 6px; text-align: left;
  vertical-align: bottom; }
td { padding: 4px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tbody tr:nth-child(even) td { background: #fafbfd; }
td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
td.c, th.c { text-align: center; }
tr.total td { font-weight: 700; border-top: 1.5px solid var(--ink); background: #fff; }
p.tnote { font-size: 8.6pt; color: var(--muted); margin: -8px 0 14px; }
.pb { break-before: page; height: 0; }
footer.rec { margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: 8.5pt; }
@media screen { body { background: #eef1f6; } .page { background: #fff; margin: 18px auto;
  box-shadow: 0 2px 14px rgba(15,23,42,.12); } }
@media print { .pb { display: block; } }
`

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }

/** markupsafe.escape */
export const escape = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch])

const ALIGN: Record<string, string> = { l: '', r: 'r', c: 'c' }

function block(b: Block): string[] {
  switch (b.type) {
    case 'heading': {
      const tag = b.level === 1 ? 'h2' : 'h3'
      return [`<${tag}>${escape(b.text)}</${tag}>`]
    }
    case 'para':
      return [`<p class="${b.kind}">${escape(b.text)}</p>`]
    case 'bullets':
      return [`<ul class="bullets">${b.items.map(([lead, t]) => `<li><b>${escape(lead)}</b> ${escape(t)}</li>`).join('')}</ul>`]
    case 'figure': {
      const panels = b.scenes.map((sc, k) => {
        const label = k < b.labels.length ? b.labels[k] : ''
        const head = label ? `<div class="panel-label">${escape(label)}</div>` : ''
        return `<div>${head}${render(sc, { id: `f${b.number}-${k}`, cssClass: 'fig' })}</div>`
      })
      const cls = b.scenes.length > 1 ? 'panels' : 'panels one'
      return [`<figure><div class="${cls}">${panels.join('')}</div><figcaption><b>Figure ${b.number}.</b> ${escape(b.caption)}`
        + '</figcaption></figure>']
    }
    case 'table': {
      const al = b.align.length ? b.align : b.columns.map(() => 'l')
      const n = Math.min(b.columns.length, al.length)
      let head = ''
      for (let k = 0; k < n; k++) head += `<th scope="col" class="${ALIGN[al[k]] ?? ''}">${escape(b.columns[k])}</th>`
      const rows = b.rows.map((r, i) => {
        const cls = b.total_last && i === b.rows.length - 1 ? ' class="total"' : ''
        let cells = ''
        for (let k = 0; k < Math.min(r.length, al.length); k++) cells += `<td class="${ALIGN[al[k]] ?? ''}">${escape(r[k])}</td>`
        return `<tr${cls}>${cells}</tr>`
      })
      const out = [`<table><caption><b>Table ${b.number}.</b> ${escape(b.caption)}</caption><thead><tr>${head}</tr></thead>`
        + `<tbody>${rows.join('')}</tbody></table>`]
      if (b.note) out.push(`<p class="tnote">${escape(b.note)}</p>`)
      return out
    }
    case 'pagebreak':
      return ['<div class="pb"></div>']
  }
}

/** The page's text (render_html). */
export function renderHtml(doc: ReportDoc): string {
  const body = doc.blocks.flatMap(block).join('\n')
  const meta = doc.meta.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')
  const draft = doc.status === 'DRAFT' ? '<div class="draft" role="note">DRAFT</div>' : ''
  return '<!DOCTYPE html>\n'
    + '<html lang="en"><head><meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escape(doc.title)}</title><style>${CSS}</style></head>\n`
    + '<body><main class="page">\n'
    + `<header class="title"><h1>${escape(doc.title)}</h1><div class="sub">${escape(doc.subtitle)}</div>\n`
    + `<dl class="meta">${meta}</dl>\n`
    + `${draft}</header>\n`
    + `${body}\n`
    + `<footer class="rec">${escape(doc.footer)}</footer>\n`
    + '</main></body></html>'
}
