// An exact decimal for the test oracles: Python's Decimal in a context of 28 significant digits,
// rounding half to even, which is how tests/oracles mirror .NET's System.Decimal.
//
// A value is coef * 10**exp. Addition and subtraction are exact and then rounded to 28 digits;
// division is correctly rounded to 28 digits; comparisons are exact.

export const PREC = 28

export class Dec {
  constructor(readonly coef: bigint, readonly exp: number) {}

  toString(): string {
    const neg = this.coef < 0n
    const digits = (neg ? -this.coef : this.coef).toString()
    if (this.exp >= 0) return (neg ? '-' : '') + digits + '0'.repeat(this.exp)
    const k = -this.exp
    const padded = digits.padStart(k + 1, '0')
    return (neg ? '-' : '') + padded.slice(0, -k) + '.' + padded.slice(-k)
  }

  toNumber(): number {
    return Number(this.toString())
  }
}

/** A whole number as a Dec. */
export const decInt = (n: number | bigint): Dec => new Dec(BigInt(n), 0)

/** n * 10**-dp: Decimal(int(n)) / 10**dp, exact. */
export const decScaled = (n: number | bigint, dp: number): Dec => new Dec(BigInt(n), -dp)

/** Python's str(Decimal), "1.5E+3" and "-0.25" included, as a Dec. */
export function decParse(text: string): Dec {
  const m = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m) throw new RangeError(`not a decimal: ${text}`)
  const frac = m[3] ?? ''
  const coef = BigInt(m[2] + frac) * (m[1] === '-' ? -1n : 1n)
  return new Dec(coef, (m[4] ? Number(m[4]) : 0) - frac.length)
}

function digitsOf(n: bigint): number {
  return (n < 0n ? -n : n).toString().length
}

/** ``coef`` rounded to PREC significant digits, half to even (``sticky``: the exact value is a little
 * past coef, toward larger magnitude). */
function round(coef: bigint, exp: number, sticky = false): Dec {
  const neg = coef < 0n
  let a = neg ? -coef : coef
  const nd = a.toString().length
  if (nd <= PREC) return new Dec(coef, exp)
  const drop = nd - PREC
  const p = 10n ** BigInt(drop)
  let q = a / p
  const rem = a % p
  const half = p / 2n
  if (rem > half || (rem === half && (sticky || q % 2n === 1n))) q += 1n
  a = q
  return new Dec(neg ? -a : a, exp + drop)
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const e = Math.min(a.exp, b.exp)
  return [a.coef * 10n ** BigInt(a.exp - e), b.coef * 10n ** BigInt(b.exp - e), e]
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, e] = align(a, b)
  return round(x + y, e)
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, e] = align(a, b)
  return round(x - y, e)
}

export function cmp(a: Dec, b: Dec): number {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}

export const eq = (a: Dec, b: Dec): boolean => cmp(a, b) === 0

/** a / b, correctly rounded to PREC significant digits, half to even. */
export function div(a: Dec, b: Dec): Dec {
  if (b.coef === 0n) throw new RangeError('division by zero')
  if (a.coef === 0n) return new Dec(0n, a.exp - b.exp)
  const neg = (a.coef < 0n) !== (b.coef < 0n)
  const x = a.coef < 0n ? -a.coef : a.coef
  const y = b.coef < 0n ? -b.coef : b.coef
  // scale so the quotient has more than PREC digits, then round with the remainder as sticky
  const k = Math.max(0, PREC + 2 - (digitsOf(x) - digitsOf(y)))
  const num = x * 10n ** BigInt(k)
  const q = num / y
  const r = num % y
  const d = round(q, a.exp - b.exp - k, r !== 0n)
  return neg ? new Dec(-d.coef, d.exp) : d
}
