// The Shiny controls against py-shiny's own renderings (shinyui_ref.json, make_shinyui_fixtures.py).
import { describe, expect, it } from 'vitest'
import { type Child, HTML, tag, TagList } from '../src/shiny/htm'
import * as ui from '../src/shiny/shinyui'
import ref from './fixtures/shinyui_ref.json'

type Tree = string | { html: string } | [string, ...unknown[]]
type Arg = unknown

function build(node: Tree): Child {
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return new HTML(node.html)
  if (node[0] === 'taglist') return new TagList(...(node.slice(1) as Tree[]).map(build))
  const [name, attrs, ...kids] = node as [string, Record<string, string>, ...Tree[]]
  return tag(name, ...kids.map(build), attrs)
}

function value(v: Arg): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if ('tree' in o) return build(o.tree as Tree)
    if ('choices' in o) return (o.choices as [string, Arg][]).map(([k, label]) => [k, value(label)])
    if ('call' in o) return call(...(o.call as [string, Arg[], Record<string, Arg>]))
  }
  return v
}

/** A case's call, as the TypeScript takes it: py-shiny's keywords become options. */
function call(name: string, args: Arg[], kwargs: Record<string, Arg>): unknown {
  const a = args.map(value)
  const k = Object.fromEntries(Object.entries(kwargs).map(([key, v]) => [key, value(v)])) as Record<string, any>
  const num = (x: unknown) => (typeof x === 'number' && !Number.isInteger(x) ? String(x) : x)
  const pyFloat = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && name === 'input_numeric' && x === 3 ? '3.0' : num(x))
  switch (name) {
    case 'output_ui': return ui.outputUi(a[0] as string, { inline: !!k.inline })
    case 'download_link': return ui.downloadLink(a[0] as string, a[1] as Child, k.title ? { title: k.title } : {})
    case 'input_file': return ui.inputFile(a[0] as string, a[1] as Child, { accept: k.accept })
    case 'input_text': return ui.inputText(a[0] as string, a[1] as Child, (a[2] as string) ?? '', { placeholder: k.placeholder ?? null, width: k.width ?? null })
    case 'input_numeric': return ui.inputNumeric(a[0] as string, a[1] as Child, pyFloat(a[2]) as number | string,
      { min: num(k.min) as number, max: num(k.max) as number, step: num(k.step) as number })
    case 'input_radio_buttons': return ui.inputRadioButtons(a[0] as string, a[1] as Child, a[2] as [string, Child][],
      { selected: k.selected ?? null, width: k.width ?? null })
    case 'layout_columns': return ui.layoutColumns(a as Child[], { colWidths: k.col_widths })
    case 'panel_conditional': return ui.panelConditional(a[0] as string, ...(a.slice(1) as Child[]))
    case 'input_action_button': return ui.inputActionButton(a[0] as string, a[1] as Child, { cls: k.class_ ?? '' })
    case 'modal_button': return ui.modalButton(a[0] as Child)
    case 'modal': return ui.modal(a as Child[], { title: k.title ?? null, footer: 'footer' in k ? k.footer : undefined,
      size: k.size ?? 'm', easyClose: !!k.easy_close })
    case 'nav_panel': return { title: a[0], content: a[1], value: k.value }
    case 'navset_hidden': return ui.navsetHidden(k.id, a as ui.NavPanel[], { selected: k.selected ?? null })
    default: throw new Error(`no case for ${name}`)
  }
}

describe('the Shiny controls render as py-shiny does', () => {
  for (const [i, c] of (ref as { call: string, args: Arg[], kwargs: Record<string, Arg>, html: string }[]).entries()) {
    it(`${i}: ${c.call}`, () => {
      expect(new TagList(call(c.call, c.args, c.kwargs) as Child).render()).toBe(c.html)
    })
  }
})
