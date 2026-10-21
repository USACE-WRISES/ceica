// Small HTML builders shared by the pages (views/components.py): htmltools tags, no Shiny inputs.
import type { Issue } from '../engine/validate'
import type { Scene } from '../engine/figures/scene'
import { render } from '../engine/figures/svg'
import { pyLen, pySplitlines } from '../py/pystr'
import { type Child, h, HTML, type Tag } from '../shiny/htm'
import { ev } from './ev'

export { ev } from './ev'

export function pageHead(title: string, sub: string | null = null, actions: Child = null): Tag {
  return h.div(
    h.div(h.h1(title, { class: 'ce-page-title' }), sub ? h.div(sub, { class: 'ce-page-sub' }) : null, { class: 'ce-page-head-text' }),
    actions ? h.div(actions, { class: 'ce-page-actions' }) : null,
    { class: 'ce-page-head' })
}

export function sec(title: string, ...extra: Child[]): Tag {
  return h.h2(title, ...extra, { class: 'ce-sec' })
}

export function figure(scene: Scene, { figId, caption = null, heading = null }: { figId: string, caption?: string | null,
  heading?: string | null }): Tag {
  const legend: Tag[] = []
  for (const [, label, color, shape] of scene.legend) {
    legend.push(h.span(h.i({ class: `ce-sw ${shape}`, style: `color:${color};` + (shape === 'line' ? `background:${color};` : '') }), label))
  }
  return h.figure(
    heading ? h.div(heading, { class: 'ce-fig-title' }) : null,
    legend.length ? h.div(...legend, { class: 'ce-legend' }) : null,
    new HTML(render(scene, { id: figId })),
    caption ? h.figcaption(caption) : null,
    { class: 'ce-fig' })
}

export function figurePair(a: Scene, b: Scene, { baseId, headings = ['(A) Cost-effectiveness', '(B) Incremental cost'] }:
  { baseId: string, headings?: readonly string[] }): Tag {
  return h.div(figure(a, { figId: `${baseId}-a`, heading: headings[0] }), figure(b, { figId: `${baseId}-b`, heading: headings[1] }),
    { class: 'ce-fig-pair' })
}

export function badge(text: string, kind = ''): Tag {
  return h.span(text, { class: `ce-badge ${kind ? 'is-' + kind : ''}`.trim() })
}

export function issuesBox(issues: readonly Issue[], { title = null as string | null } = {}): Tag | null {
  if (!issues.length) return null
  const errors = issues.filter((i) => i.level === 'error')
  const items: Tag[] = issues.slice(0, 12).map((i) => h.li(i.message))
  const more = issues.length - 12
  if (more > 0) items.push(h.li(`and ${more} more`))
  const head = title || (errors.length ? `${errors.length} problems to fix` : `${issues.length} things to check`)
  return h.div(h.div(head, { class: 'ce-issues-h' }), h.ul(...items),
    { class: 'ce-issues' + (errors.length ? ' is-error' : ''), role: 'status' })
}

export function empty(title: string, text: string, action: Child = null): Tag {
  return h.div(h.div(h.div(title, { class: 'ce-empty-title' }), h.p(text), action), { class: 'ce-empty' })
}

export function link(text: string, type: string, data: Record<string, string | number | null> = {}): Tag {
  return h.button(text, { type: 'button', class: 'ce-link' }, ev(type, data))
}

/** Rows for a textarea so its text shows without scrolling (grows with the text). */
export function rowsFor(text: string | null, perLine = 70, most = 6): number {
  if (!text) return 1
  const parts = pySplitlines(String(text))
  let lines = 0
  for (const part of parts.length ? parts : ['']) lines += Math.max(1, Math.ceil(pyLen(part) / perLine))
  return Math.max(1, Math.min(most, lines))
}

export function seg(options: readonly (readonly [string, string])[], current: string, type: string,
  data: Record<string, string | number | null> = {}): Tag {
  return h.div(...options.map(([value, label]) => h.button(label, { type: 'button', class: value === current ? 'is-on' : '',
    'aria-pressed': value === current ? 'true' : 'false' }, ev(type, { value, ...data }))), { class: 'ce-seg', role: 'group' })
}
