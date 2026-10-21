// The event attributes every view's controls carry (views/components.py ev()), on their own so the
// page frame (frame.ts) and site.ts need nothing else.
import type { Attrs } from '../shiny/htm.ts'

/** Attributes that post an event through the one channel (www/ceica.js): ``ev(type, data)``, a
 * value written as Python's str() would (pass a float's text as a string), None as "". */
export function ev(type: string, data: Record<string, string | number | null | undefined> = {}): Attrs {
  const out: Attrs = { 'data-ev': type }
  for (const [k, v] of Object.entries(data)) out[`data-${k.replace(/_/g, '-')}`] = v === null || v === undefined ? '' : String(v)
  return out
}
