// The example projects: the start page's gallery and the detail of the one picked
// (views/examples.py).
//
// Each bundled example (src/content/examples/<name>.ceica, copies of ceica/examples) has a catalog
// entry here with the words its card and its detail show, kept to a line each. Its title, size and
// chart come from the file itself, worked out once.
import { analyze, wsBb, wsPlans } from '../engine/analysis'
import { watershedCeIca } from '../engine/figures'
import { render } from '../engine/figures/svg'
import { countText } from '../engine/fmt'
import { loads } from '../engine/projectfile'
import { h, HTML, type Tag } from '../shiny/htm'
import stafDemo from '../content/examples/staf-demo.ceica?raw'
import utoyCreek from '../content/examples/utoy-creek.ceica?raw'
import { ev } from './components'

/** The bundled files, by name. */
export const FILES: Readonly<Record<string, string>> = { 'utoy-creek': utoyCreek, 'staf-demo': stafDemo }

/** A bundled example: its file name (without .ceica), the line on its card and the one sentence its
 * detail adds. */
export interface Example {
  readonly name: string
  readonly summary: string
  readonly about: string
  readonly tags: readonly string[]
}

/** The examples, in the order the gallery shows them; the first is picked by default. */
export const EXAMPLES: readonly Example[] = [
  { name: 'utoy-creek', summary: 'Eight sites in Atlanta, as published',
    about: 'A published study, reproduced with every decision made (McKay and others, 2024).', tags: ['Published study', 'Index x quantity'] },
  { name: 'staf-demo', summary: 'Three reaches scored with STAF function scores',
    about: 'An invented study that shows STAF scoring; its decisions are left for you.', tags: ['Illustrative', 'STAF scores'] },
]

/** The catalog entry for ``name``, or null. */
export function example(name: string | null | undefined): Example | null {
  return EXAMPLES.find((e) => e.name === name) ?? null
}

/** What an example's file says about itself. */
export interface Study {
  readonly title: string
  /** Its size in one line, for example "8 sites, 128 plans, 8 best buys". */
  readonly facts: string
  /** The watershed cost-effectiveness chart as SVG markup ("" when there are no plans). */
  readonly chart: string
}

const STUDIES = new Map<string, Study>()

export function study(name: string): Study {
  let st = STUDIES.get(name)
  if (!st) {
    const res = analyze(loads(FILES[name]).project)
    const p = res.project
    const ws = res.watershed
    const facts = [countText(p.sites.length, 'site')]
    if (ws.table !== null && ws.ceica !== null) facts.push(countText(wsPlans(ws), 'plan'), countText(wsBb(ws), 'best buy'))
    const scenes = watershedCeIca(res)
    const chart = scenes ? render(scenes[0], { interactive: false, cssClass: 'ce-ex-chart' }) : ''
    st = { title: p.name, facts: facts.join(', '), chart }
    STUDIES.set(name, st)
  }
  return st
}

export function pickedOrFirst(name: string | null): Example {
  return example(name) ?? EXAMPLES[0]
}

/** The gallery: a card per example; a click picks it. */
export function cards(picked: string | null): Tag {
  const sel = pickedOrFirst(picked)
  const out = EXAMPLES.map((ex) => {
    const st = study(ex.name)
    const on = ex === sel
    return h.button(
      h.span(new HTML(st.chart), { class: 'ce-ex-thumb', 'aria-hidden': 'true' }),
      h.span(h.span(st.title, { class: 'ce-ex-title' }), h.span(ex.summary, { class: 'ce-ex-sum' }),
        h.span(...ex.tags.map((t) => h.span(t, { class: 'ce-ex-tag' })), { class: 'ce-ex-tags' }), { class: 'ce-ex-body' }),
      { type: 'button', class: 'ce-ex-card' + (on ? ' is-sel' : ''), 'aria-pressed': on ? 'true' : 'false' },
      ev('start_pick', { name: ex.name }))
  })
  return h.div(...out, { class: 'ce-ex-grid' })
}

/** The picked example (the first by default): its chart, size, one sentence, and Open. */
export function detail(picked: string | null): Tag {
  const ex = pickedOrFirst(picked)
  const st = study(ex.name)
  return h.div(
    st.chart ? h.div(new HTML(st.chart), { class: 'ce-ex-hero' }) : null,
    h.h3(st.title, { class: 'ce-ex-dtitle' }),
    h.p(st.facts, { class: 'ce-ex-facts' }),
    h.p(ex.about, { class: 'ce-ex-desc' }),
    h.div(h.button('Open example', { type: 'button', class: 'btn btn-primary' }, ev('example', { name: ex.name })), { class: 'ce-ex-actions' }),
    { class: 'ce-ex-detail' })
}
