// Exact numerics for CE/ICA (ceica/numeric.py).
//
// IWR Planning Suite II stores every plan value rounded by its variable type (CURRENCY to 2
// decimals, DECIMAL to 3, half away from zero) and then compares System.Decimal values exactly.
// CEICA does the same: each cost and output is rounded once and held as an integer count of cents or
// thousandths, so every cost-effectiveness and best-buy comparison is exact integer arithmetic.
//
// Rounding goes through format(x, ".15g") first: the 15 significant digits a double shows are the
// digits Excel's ROUND and .NET's decimal conversion of a double both see (2.675 rounds to 2.68).
//
// The integers are JavaScript numbers. They stay exact, and so do their sums and differences, below
// EXACT_LIMIT (2**52); Python's int64 goes further. A value past it throws TooLargeError, which the
// analysis reports (web/README.md, differences by design).
import { pyFloat } from '../py/pyfmt'
import { parseDecimal, pyFormatG, ratioToFloat } from '../py/pynum'

/** IWR CURRENCY variables: cents. */
export const COST_DP = 2
/** IWR DECIMAL variables: thousandths. */
export const OUTPUT_DP = 3

/** Scaled values and plan sums must stay below this to be held exactly (see the file comment). */
export const EXACT_LIMIT = 2 ** 52

/** A scaled value too large to hold exactly in a JavaScript number. */
export class TooLargeError extends RangeError {}

/** 10**k as a double, exact for k up to 22 */
export const POW10: readonly number[] = Array.from({ length: 23 }, (_, k) => 10 ** k)

/** The decimal value a person (or Excel) reads for a double: 15 significant digits. */
export function toDecimal(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${pyFloat(x)}`)
  return pyFormatG(x, 15)
}

/** ``x`` rounded to ``dp`` decimals, half away from zero, as an integer count of 10**-dp units. */
export function quantize(x: number, dp: number): number {
  const { neg, coef, exp } = parseDecimal(toDecimal(x))
  const e = exp + dp
  let q: bigint
  if (e >= 0) q = coef * 10n ** BigInt(e)
  else {
    const div = 10n ** BigInt(-e)
    q = coef / div
    if ((coef % div) * 2n >= div) q += 1n
  }
  if (q >= BigInt(EXACT_LIMIT)) {
    throw new TooLargeError(`${toDecimal(x)} at ${dp} decimals is too large to hold exactly`)
  }
  return q === 0n ? 0 : neg ? -Number(q) : Number(q)
}

/** ``quantize`` over a sequence. */
export function quantizeArray(xs: ArrayLike<number>, dp: number): Float64Array {
  const out = new Float64Array(xs.length)
  for (let i = 0; i < xs.length; i++) out[i] = quantize(xs[i], dp)
  return out
}

/** ``x`` rounded to ``dp`` decimals, half away from zero (IWR's MidpointRounding.AwayFromZero). */
export function roundHalfUp(x: number, dp: number): number {
  return quantize(x, dp) / POW10[dp]
}

/** An integer count of 10**-dp units back to a float. */
export function unscale(n: number | bigint, dp: number): number {
  if (typeof n === 'bigint') return ratioToFloat(n, 10n ** BigInt(dp))
  return n / POW10[dp]
}

/** (num * 10**-num_dp) / (den * 10**-den_dp), computed exactly, then rounded once to a float.
 * Returns 0.0 when ``den`` is 0 (IWR reports a zero increment as zero, not as infinity). */
export function ratio(num: number | bigint, den: number | bigint, numDp: number, denDp: number): number {
  if (den === 0 || den === 0n) return 0
  if (num === 0 || num === 0n) return 0
  if (typeof num === 'number' && typeof den === 'number') {
    // both scaled terms exact in doubles: IEEE division is then the correctly rounded quotient
    const a = num * POW10[denDp]
    const b = den * POW10[numDp]
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a / b
  }
  return ratioToFloat(BigInt(num) * 10n ** BigInt(denDp), BigInt(den) * 10n ** BigInt(numDp))
}
