// Nice axis ticks and number labels (ceica/figures/ticks.py).
//
// Python's arithmetic is kept: the powers of ten as Python's 10 ** k gives them (correctly rounded),
// log10 correctly rounded (crLog10: Python's is at every value an axis turns on), round() half to
// even and round(x, 10) on the exact value.
import { pyFixedComma } from '../../py/pyfmt'
import { crLog10, pyRound, pyRoundInt } from '../../py/pynum'

/** 10 ** k for an int k, as Python gives it (an exact int, or the correctly rounded float). */
export const pow10 = (k: number): number => Number(`1e${k}`)

/** Python's min of a sequence: the first unless a later one is smaller (so min(0.0, -0.0) is 0.0). */
export function seqMin(xs: ArrayLike<number>): number {
  let m = xs[0]
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i]
  return m
}
/** Python's max of a sequence: the first unless a later one is larger. */
export function seqMax(xs: ArrayLike<number>): number {
  let m = xs[0]
  for (let i = 1; i < xs.length; i++) if (xs[i] > m) m = xs[i]
  return m
}
/** Python's min(a, b, ...) */
export const pyMin = (...xs: number[]): number => seqMin(xs)
/** Python's max(a, b, ...) */
export const pyMax = (...xs: number[]): number => seqMax(xs)

export function niceStep(span: number, target = 5): number {
  if (span <= 0 || !Number.isFinite(span)) return 1.0
  const raw = span / Math.max(target, 1)
  const mag = pow10(Math.floor(crLog10(raw)))
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag
  return 10 * mag
}

/** Axis limits and ticks covering [lo, hi] (and zero), with a little padding. */
export function niceRange(lo: number, hi: number, target = 5, { includeZero = true, pad = 0.04 } = {}): [number, number, number[]] {
  if (includeZero) {
    lo = pyMin(lo, 0.0)
    hi = pyMax(hi, 0.0)
  }
  if (hi === lo) hi = lo + 1.0
  const span = hi - lo
  const hiP = hi + span * pad
  const loP = lo < 0 ? lo - span * pad : lo
  const step = niceStep(hiP - loP, target)
  // math.floor and math.ceil give ints: -0.0 floors to 0
  const t0 = (Math.floor(loP / step) + 0) * step
  const t1 = (Math.ceil(hiP / step) + 0) * step
  const n = pyRoundInt((t1 - t0) / step)
  const ticks: number[] = []
  for (let k = 0; k <= n; k++) ticks.push(pyRound(t0 + k * step, 10))
  return [t0, t1, ticks]
}

/** Tick label: separators, no trailing noise; large dollar axes switch to millions. */
export function fmtNumber(v: number, step: number | null = null, { money = false } = {}): string {
  let s: string
  if (step !== null && step < 1) {
    const f = Math.floor(crLog10(step))
    const dec = Math.max(0, -f + (step * pow10(-f) === 1 ? 0 : 1))
    s = pyFixedComma(v, Math.min(dec, 3))
  } else {
    s = pyFixedComma(v, 0)
  }
  if (s === '-0' || s === '-0.0' || s === '-0.00') s = s.slice(1)
  return money && !s.startsWith('-') ? '$' + s : money ? '-$' + s.slice(1) : s
}

/** Divisor and suffix for a dollar axis: millions above $10M. */
export function moneyScale(hi: number): [number, string] {
  if (hi >= 1e7) return [1e6, ' million']
  return [1.0, '']
}
