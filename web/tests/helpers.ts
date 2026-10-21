// Helpers shared by the golden tests.
import type { CEICAResult } from '../src/engine/ica'
import { sha256Hex } from '../src/py/bytes'
import { binary } from '../src/py/pynum'

/** IWR's displayed status per plan: 0 non-cost-effective, 1 cost-effective, 2 best buy. */
export function codes(res: CEICAResult): number[] {
  return Array.from(res.ce, (c, i) => (res.bb[i] ? 2 : c ? 1 : 0))
}

/** One unit in the last place of a nonzero finite double. */
export function ulp(x: number): number {
  if (x === 0) return 5e-324
  return 2 ** binary(x).e
}

/** How many doubles apart two finite doubles of the same sign are (0 when equal). */
export function ulpsApart(a: number, b: number): number {
  if (Object.is(a, b) || a === b) return 0
  const view = new DataView(new ArrayBuffer(16))
  view.setFloat64(0, a)
  view.setFloat64(8, b)
  return Math.abs(Number(view.getBigInt64(0) - view.getBigInt64(8)))
}

/** A Map as the goldens write a Python dict: [key, value] pairs in order. */
export const pairsOf = <V>(m: ReadonlyMap<string, V>): [string, V][] => [...m.entries()]

/** How far apart values from a power may be: Python's ** (the Windows C library) is a unit off the
 * correctly rounded power in about 0.06% of the engine's cases (pow.test.ts), and a subtraction
 * after it can magnify that unit: the interest rate per period, (1 + r)^(1/ppy) - 1, by 1/a. */
export const POWER_REL = 1e-9

/** Values from a power that are not bit for bit Python's, and the largest relative gap, over a run. */
export const powerStats = { inexact: 0, maxRel: 0 }

/** Whether a value from a power is within POWER_REL of Python's (counting it in powerStats). */
export function nearPower(got: number, want: number): boolean {
  if (Object.is(got, want) || got === want) return true
  if (!Number.isFinite(got) || !Number.isFinite(want)) return false
  const rel = Math.abs(got - want) / Math.max(Math.abs(want), Math.abs(got))
  if (rel > POWER_REL) return false
  powerStats.inexact++
  powerStats.maxRel = Math.max(powerStats.maxRel, rel)
  return true
}

/** How two JSON-like trees differ: the paths of the values that are not equal. Numbers must be
 * identical, except where ``tolerant(path)`` says the value comes from a power: there nearPower
 * decides. */
export function treeDiff(got: unknown, want: unknown, tolerant: (path: string) => boolean = () => false):
  { diffs: string[] } {
  const diffs: string[] = []
  const walk = (g: unknown, w: unknown, path: string) => {
    if (typeof w === 'number' && typeof g === 'number') {
      if (Object.is(g, w) || g === w) return
      if (tolerant(path) && nearPower(g, w)) return
      diffs.push(`${path}: ${g} against ${w}`)
      return
    }
    if (Array.isArray(w) && Array.isArray(g)) {
      if (g.length !== w.length) diffs.push(`${path}: ${g.length} items against ${w.length}`)
      else w.forEach((x, i) => walk(g[i], x, `${path}.${i}`))
      return
    }
    if (w !== null && typeof w === 'object' && g !== null && typeof g === 'object') {
      const keys = new Set([...Object.keys(w), ...Object.keys(g)])
      for (const k of keys) walk((g as Record<string, unknown>)[k], (w as Record<string, unknown>)[k], `${path}.${k}`)
      return
    }
    if (g !== w) diffs.push(`${path}: ${JSON.stringify(g)} against ${JSON.stringify(w)}`)
  }
  walk(got, want, '')
  return { diffs }
}

/** The first few items that fail ``ok``, for a test that checks a whole golden list at once. */
export function failures<T>(items: readonly T[], ok: (item: T) => boolean, show = 5): T[] {
  const bad: T[] = []
  for (const item of items) {
    if (!ok(item)) {
      bad.push(item)
      if (bad.length >= show) break
    }
  }
  return bad
}

/** make_traces.digest: sha256 (first 16 hex digits) and length in code points. */
export function digest(text: string): string {
  return `sha256:${sha256Hex(text).slice(0, 16)}:${[...text].length}`
}
