// Python's numbers where the engine needs them exact: format(x, ".15g"), round(), sum(), int / int
// true division (Fraction to float), f"{n:,}", and the power x ** y.
//
// pyfmt.ts and pyjson.ts are STAF's copies (web/parity/sources.json) and stay as they are; what the
// CEICA engine needs beyond them is here. Every result is checked against Python in
// tests/py.test.ts (py_ref.json) and tests/pow.test.ts (pow_ref.json).
import { pyFixed, pySum as stafPySum } from './pyfmt'

const view = new DataView(new ArrayBuffer(8))

/** ``x`` as m * 2**e with m a BigInt (exact), for finite nonzero ``x``; the sign is dropped. */
export function binary(x: number): { m: bigint, e: number } {
  view.setFloat64(0, Math.abs(x))
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const exp = (hi >>> 20) & 0x7ff
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  if (exp) m |= 1n << 52n
  return { m, e: (exp || 1) - 1075 }
}

/** The number of bits of a positive BigInt. */
export function bitLength(n: bigint): number {
  if (n <= 0n) return 0
  const h = n.toString(16)
  return (h.length - 1) * 4 + (32 - Math.clz32(parseInt(h[0], 16)))
}

// ---------------------------------------------------------------- exact decimals

/** |x| written exactly in decimal: ``digits`` (no leading or trailing zeros) times 10**exp. */
export interface ExactDecimal {
  neg: boolean
  digits: string
  exp: number
}

/** The exact decimal value of a finite double (every double is a finite decimal). */
export function exactDecimal(x: number): ExactDecimal {
  const neg = x < 0 || Object.is(x, -0)
  if (x === 0) return { neg, digits: '0', exp: 0 }
  const { m, e } = binary(x)
  let digits: string
  let exp: number
  if (e >= 0) {
    digits = (m << BigInt(e)).toString()
    exp = 0
  } else {
    // m / 2**k = m * 5**k / 10**k
    digits = (m * 5n ** BigInt(-e)).toString()
    exp = e
  }
  const trimmed = digits.replace(/0+$/, '')
  return { neg, digits: trimmed, exp: exp + (digits.length - trimmed.length) }
}

/** ``digits`` (a digit string) rounded to ``p`` significant digits, half to even, as Python's float
 * formatting rounds the exact value. Returns the kept digits and how much the exponent grew (a carry
 * that adds a digit, 999 to 1000). */
function roundDigits(digits: string, p: number): { kept: string, carry: number } {
  if (digits.length <= p) return { kept: digits, carry: 0 }
  let kept = digits.slice(0, p)
  const rest = digits.slice(p)
  const first = rest.charCodeAt(0) - 48
  let up: boolean
  if (first > 5) up = true
  else if (first < 5) up = false
  else if (/[1-9]/.test(rest.slice(1))) up = true
  else up = (kept.charCodeAt(kept.length - 1) - 48) % 2 === 1  // an exact tie: to even
  if (!up) return { kept, carry: 0 }
  const n = (BigInt(kept) + 1n).toString()
  if (n.length > kept.length) return { kept: n.slice(0, p), carry: 1 }
  kept = n
  return { kept, carry: 0 }
}

/** format(x, f".{p}g") for a float. */
export function pyFormatG(x: number, p: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (p === 0) p = 1
  const d = exactDecimal(x)
  const sign = d.neg ? '-' : ''
  if (x === 0) return sign + '0'
  const { kept, carry } = roundDigits(d.digits, p)
  // the exponent of the first digit, after rounding
  const sci = d.exp + d.digits.length - 1 + carry
  const body = kept.replace(/0+$/, '') || '0'
  if (sci >= -4 && sci < p) {
    // fixed notation
    if (sci >= 0) {
      const whole = body.length > sci + 1 ? body.slice(0, sci + 1) : body.padEnd(sci + 1, '0')
      const frac = body.length > sci + 1 ? body.slice(sci + 1) : ''
      return sign + whole + (frac ? '.' + frac : '')
    }
    return sign + '0.' + '0'.repeat(-sci - 1) + body
  }
  const mant = body.length > 1 ? body[0] + '.' + body.slice(1) : body
  const es = sci < 0 ? '-' : '+'
  return `${sign}${mant}e${es}${String(Math.abs(sci)).padStart(2, '0')}`
}

/** A decimal string (what format or str writes: "-12.5", "1e+16", "0.00015") as
 * sign * coef * 10**exp with coef a BigInt. */
export function parseDecimal(text: string): { neg: boolean, coef: bigint, exp: number } {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (!m || (!m[2] && !m[3])) throw new RangeError(`not a decimal number: ${text}`)
  const frac = m[3] ?? ''
  const coef = BigInt((m[2] || '0') + frac)
  return { neg: m[1] === '-', coef, exp: (m[4] ? Number(m[4]) : 0) - frac.length }
}

// ---------------------------------------------------------------- correctly rounded binary results

/** The double nearest q * 2**e (q a positive BigInt, ``sticky`` true when the exact value is a little
 * more than q * 2**e), half to even: the last step of every exact computation here. */
function roundBits(q: bigint, sticky: boolean, e: number): number {
  const qb = bitLength(q)
  let extra = qb - 53
  // below 2**-1022 a double keeps fewer bits: the lowest is 2**-1074
  if (e + extra < -1074) extra = -1074 - e
  let mant: bigint
  if (extra <= 0) {
    mant = q
    extra = 0
  } else {
    const shift = BigInt(extra)
    mant = q >> shift
    const rem = q & ((1n << shift) - 1n)
    const half = 1n << (shift - 1n)
    if (rem > half || (rem === half && (sticky || (mant & 1n) === 1n))) mant += 1n
  }
  return scale2(Number(mant), e + extra)
}

/** v * 2**e, exact while the result is representable (v holds at most 53 bits). */
function scale2(v: number, e: number): number {
  while (e > 1000) {
    v *= 2 ** 1000
    e -= 1000
  }
  while (e < -1000) {
    v *= 2 ** -1000
    e += 1000
  }
  return v * 2 ** e
}

/** The double nearest num / den * 2**exp2, half to even (Python's int / int true division, and so
 * float(Fraction(num, den))). Zero gives 0.0. */
export function roundRational(num: bigint, den: bigint, exp2 = 0): number {
  if (den === 0n) throw new RangeError('division by zero')
  if (num === 0n) return 0
  let neg = false
  if (num < 0n) {
    neg = true
    num = -num
  }
  if (den < 0n) {
    neg = !neg
    den = -den
  }
  // shift so the quotient has 55 or 56 bits: two to round with, and a sticky remainder
  const s = 55 - (bitLength(num) - bitLength(den))
  const a = s >= 0 ? num << BigInt(s) : num
  const b = s >= 0 ? den : den << BigInt(-s)
  const q = a / b
  const v = roundBits(q, a % b !== 0n, exp2 - s)
  return neg ? -v : v
}

/** float(Fraction(num, den)): Python's correctly rounded int / int. */
export const ratioToFloat = (num: bigint, den: bigint): number => roundRational(num, den)

/** Integer square root: the largest s with s * s <= n. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number')
  if (n < 2n) return n
  let x = 1n << BigInt((bitLength(n) + 1) >> 1)
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** The double nearest sqrt(num / den * 2**exp2), half to even. */
function roundSqrtRational(num: bigint, den: bigint, exp2: number): number {
  if (exp2 % 2 !== 0) {
    num <<= 1n
    exp2 -= 1
  }
  // sqrt(num / den) with at least 56 bits: scale by 4**t
  const d = bitLength(num) - bitLength(den)
  const t = Math.ceil((114 - d) / 2)
  const a = t >= 0 ? num << BigInt(2 * t) : num
  const b = t >= 0 ? den : den << BigInt(-2 * t)
  const n = a / b
  const s = isqrt(n)
  const exact = a % b === 0n && s * s === n
  return roundBits(s, !exact, exp2 / 2 - t)
}

// ---------------------------------------------------------------- x ** y, correctly rounded

const POW_MEMO = new Map<string, number>()
const LN2 = new Map<number, bigint>()

/** atanh(a / b) for 0 <= a / b < 1 in fixed point with ``p`` fraction bits, and the number of terms
 * (each term is truncated, so the error is below 2 units a term). */
function atanhFixed(a: bigint, b: bigint, p: number): { v: bigint, terms: number } {
  const P = BigInt(p)
  let zp = (a << P) / b                    // z ** (2k + 1)
  const z2 = ((a * a) << P) / (b * b)      // z ** 2
  let sum = 0n
  let terms = 0
  for (let k = 0n; zp !== 0n; k++) {
    sum += zp / (2n * k + 1n)
    zp = (zp * z2) >> P
    terms++
  }
  return { v: sum, terms }
}

/** ln 2 in fixed point with ``p`` fraction bits (2 atanh(1/3)), and its error bound in units. */
function ln2Fixed(p: number): { v: bigint, err: number } {
  let v = LN2.get(p)
  if (v === undefined) {
    v = 2n * atanhFixed(1n, 3n, p).v
    LN2.set(p, v)
  }
  // atanh(1/3) takes about p / 3.17 terms, each within 2 units; doubled
  return { v, err: 4 * (Math.ceil(p / 3) + 4) }
}

/** x ** y for x > 0 by exp(y ln x) in fixed point with ``p`` fraction bits: the value as
 * mant * 2**e, and the error bound in units of mant. */
function powFixed(x: number, y: number, p: number): { mant: bigint, e: number, err: bigint } {
  const P = BigInt(p)
  const { m, e } = binary(x)
  // x = f * 2**k with f = m / 2**52 in [0.75, 1.5)
  const one52 = 1n << 52n
  let k = e + 52
  let num = m - one52
  let den = m + one52
  if (m * 2n >= 3n * one52) {
    // f >= 1.5: use f / 2
    num = m - 2n * one52
    den = m + 2n * one52
    k += 1
  }
  const neg = num < 0n
  const at = atanhFixed(neg ? -num : num, den, p)
  const ln2 = ln2Fixed(p)
  const lnx = 2n * (neg ? -at.v : at.v) + BigInt(k) * ln2.v
  const errLn = 4 * (at.terms + 2) + Math.abs(k) * ln2.err
  // t = y ln x, exactly but for the final shift
  const { m: my, e: ey } = binary(y)
  let t = lnx * my
  if (ey >= 0) t <<= BigInt(ey)
  else t >>= BigInt(-ey)
  if (y < 0) t = -t
  const errT = Math.abs(y) * errLn + 2
  // range reduction: t = j ln 2 + r, |r| <= ln 2 / 2
  const j = (t >= 0n ? t + ln2.v / 2n : t - ln2.v / 2n) / ln2.v
  const r = t - j * ln2.v
  const errR = errT + Math.abs(Number(j)) * ln2.err + 2
  // exp(r) by its series
  const one = 1n << P
  let term = one
  let sum = one
  let n = 1n
  let terms = 0
  while (term !== 0n) {
    term = (term * r) >> P
    term /= n
    sum += term
    n++
    terms++
  }
  // exp(r) <= 1.5, so an error in r grows by at most 1.5; each term adds at most 2 units
  const errExp = 1.5 * errR + 2 * terms + 4
  return { mant: sum, e: Number(j) - p, err: BigInt(Math.ceil(errExp * 16)) }
}

/** x ** y as the double nearest the exact value, half to even: the same in every browser, where
 * Math.pow may differ in the last bit between engines (and from Python's C library). Whole and
 * half exponents are exact in BigInt; others use exp(y ln x) to enough bits that the rounding is
 * certain (Ziv's test: both ends of the error bound round to the same double). */
export function crPow(x: number, y: number): number {
  if (y === 0 || x === 1) return 1
  if (!(x > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return Math.pow(x, y)
  const key = `${x},${y}`
  const hit = POW_MEMO.get(key)
  if (hit !== undefined) return hit
  let v: number
  const { m, e } = binary(x)
  if (Number.isInteger(y) && Math.abs(y) <= 1024) {
    const n = Math.abs(y)
    const big = m ** BigInt(n)
    v = y > 0 ? roundRational(big, 1n, e * n) : roundRational(1n, big, -e * n)
  } else if (Number.isInteger(2 * y) && Math.abs(y) <= 512) {
    // a half exponent: sqrt(x ** (2y))
    const n = Math.abs(2 * y)
    const big = m ** BigInt(n)
    v = y > 0 ? roundSqrtRational(big, 1n, e * n) : roundSqrtRational(1n, big, -e * n)
  } else {
    v = NaN
    for (let p = 128 + Math.ceil(Math.log2(Math.abs(y) + 2)) + 64; p <= 4096; p *= 2) {
      const { mant, e: pe, err } = powFixed(x, y, p)
      const lo = roundRational(mant - err, 1n, pe)
      const hi = roundRational(mant + err, 1n, pe)
      v = lo
      if (lo === hi) break
    }
  }
  if (POW_MEMO.size > 8192) POW_MEMO.clear()
  POW_MEMO.set(key, v)
  return v
}

// ---------------------------------------------------------------- logarithms, correctly rounded

/** ln(n * 2**e) for a positive BigInt n, in fixed point with ``p`` fraction bits, and its error
 * bound in units (the same series as the power's). */
function lnFixed(n: bigint, e: number, p: number): { v: bigint, err: number } {
  // n * 2**e = f * 2**k with f in [0.75, 1.5)
  const bl = bitLength(n)
  const one = 1n << BigInt(bl - 1)
  let k = e + bl - 1
  let num = n - one
  let den = n + one
  if (n * 2n >= 3n * one) {
    num = n - 2n * one
    den = n + 2n * one
    k += 1
  }
  const neg = num < 0n
  const at = atanhFixed(neg ? -num : num, den, p)
  const ln2 = ln2Fixed(p)
  return { v: 2n * (neg ? -at.v : at.v) + BigInt(k) * ln2.v, err: 4 * (at.terms + 2) + Math.abs(k) * ln2.err }
}

const LN10 = new Map<number, { v: bigint, err: number }>()

/** ln 10 = 3 ln 2 + 2 atanh(1/9) in fixed point with ``p`` fraction bits, and its error bound. */
function ln10Fixed(p: number): { v: bigint, err: number } {
  let r = LN10.get(p)
  if (!r) {
    const ln2 = ln2Fixed(p)
    const at = atanhFixed(1n, 9n, p)
    r = { v: 3n * ln2.v + 2n * at.v, err: 3 * ln2.err + 8 * (at.terms + 2) }
    LN10.set(p, r)
  }
  return r
}

/** The double nearest ln(n * 2**e), by Ziv's test (n * 2**e != 1). */
function crLnOf(n: bigint, e: number): number {
  for (let p = 96; p <= 8192; p *= 2) {
    const { v, err } = lnFixed(n, e, p)
    const E = BigInt(err)
    const lo = roundRational(v - E, 1n, -p)
    if (lo === roundRational(v + E, 1n, -p)) return lo
  }
  throw new RangeError('ln: the rounding was not settled')
}

/** math.log(x), correctly rounded: the same in every browser (Math.log may differ in the last bit
 * between engines, and from the C library Python uses). */
export function crLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Math.log(x)
  if (x === 1) return 0
  const { m, e } = binary(x)
  return crLnOf(m, e)
}

/** math.log10(x), correctly rounded; exact at the powers of ten a double holds (1 to 1e22).
 * Python's (the C library's) is correctly rounded at every power of ten and nice step (1, 2, 2.5
 * and 5 times one), which is where a figure's axis turns on it (ticks.ts). */
export function crLog10(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Math.log10(x)
  if (Number.isInteger(x) && x <= 1e22) {
    let k = 0
    for (let t = 1; t <= x; t *= 10, k++) if (t === x) return k
  }
  const { m, e } = binary(x)
  for (let p = 96; p <= 8192; p *= 2) {
    const L = lnFixed(m, e, p)
    const T = ln10Fixed(p)
    const P = BigInt(p)
    const q = (L.v << P) / T.v
    // ln 10 > 2 units of 2**p, so an error in ln x or ln 10 shrinks at least by half in the quotient
    const qReal = Math.abs(Number(q)) / 2 ** p
    const E = BigInt(Math.ceil((L.err + (qReal + 1) * T.err) / 2) + 2)
    const lo = roundRational(q - E, 1n, -p)
    if (lo === roundRational(q + E, 1n, -p)) return lo
  }
  throw new RangeError('log10: the rounding was not settled')
}

const LOG1P_MEMO = new Map<number, number>()

/** math.log1p(x) (numpy.log1p on a float), correctly rounded: ln(1 + x) with 1 + x taken exactly.
 * numpy's (the C library's) is a unit off on about one integer in 18,000 (web/README.md). */
export function crLog1p(x: number): number {
  if (x === 0 || Number.isNaN(x)) return x
  if (!(x > -1) || !Number.isFinite(x)) return Math.log1p(x)
  const hit = LOG1P_MEMO.get(x)
  if (hit !== undefined) return hit
  const { m, e } = binary(x)
  let n: bigint
  let ex: number
  if (e >= 0) {
    n = x > 0 ? (m << BigInt(e)) + 1n : 1n - (m << BigInt(e))
    ex = 0
  } else {
    const one = 1n << BigInt(-e)
    n = x > 0 ? one + m : one - m
    ex = e
  }
  const v = crLnOf(n, ex)
  if (LOG1P_MEMO.size > 65536) LOG1P_MEMO.clear()
  LOG1P_MEMO.set(x, v)
  return v
}

/** Python's (and numpy's) float floor division a // b: from the exact remainder (fmod), as CPython's
 * float_floor_div and numpy's npy_divmod do, so it never differs from Math.floor(a / b)'s rounding
 * where a / b rounds up to a whole number. */
export function pyFloorDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError('float floor division by zero')
  let mod = a % b
  let div = (a - mod) / b
  if (mod) {
    if ((b < 0) !== (mod < 0)) {
      mod += b
      div -= 1.0
    }
  }
  let floordiv: number
  if (div) {
    floordiv = Math.floor(div)
    if (div - floordiv > 0.5) floordiv += 1.0
  } else {
    floordiv = Math.sign(a / b) < 0 || Object.is(a / b, -0) ? -0.0 : 0.0
  }
  return floordiv
}

/** Python's float a % b: fmod, then the sign of b (CPython's float_rem). */
export function pyMod(a: number, b: number): number {
  if (b === 0) throw new RangeError('float modulo')
  let mod = a % b
  if (mod) {
    if ((b < 0) !== (mod < 0)) mod += b
  } else mod = b < 0 ? -0.0 : 0.0
  return mod
}

// ---------------------------------------------------------------- built-ins

/** Python 3.12's sum() of floats from the start 0: STAF's compensated sum, with 0 + -0.0 giving
 * 0.0 as Python's int start does. */
export function pySum(values: Iterable<number>): number {
  const s = stafPySum(values)
  return s === 0 ? 0 : s
}

/** round(x, n) for a float: x rounded to n decimals (n may be negative: round(368123.0, -3) is
 * 368000.0), half to even on the exact value, then the nearest double, as Python rounds. */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x
  if (n >= 0) return n > 100 ? x : Number(pyFixed(x, n))
  const { m, e } = binary(x)
  const k = 10n ** BigInt(-n)
  // |x| / 10**-n = m * 2**e / 10**-n, rounded half to even
  const num = e >= 0 ? m << BigInt(e) : m
  const den = e >= 0 ? k : k << BigInt(-e)
  let q = num / den
  const r2 = 2n * (num % den)
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n
  const v = Number(q * k)
  return x < 0 ? -v : v
}

/** round(x) for a float: the nearest integer, half to even. */
export function pyRoundInt(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 52) return x
  const f = Math.floor(x)
  const d = x - f
  if (d < 0.5) return f + 0
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f + 0 : f + 1
}

/** f"{n:,}" for an int. */
export function commaInt(n: number | bigint): string {
  const s = typeof n === 'bigint' ? n.toString() : String(Math.trunc(n))
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** max(items, key=...): the first item whose key is largest (keys compared as tuples). */
export function pyMaxBy<T>(items: readonly T[], key: (item: T) => readonly number[]): T | undefined {
  let best: T | undefined
  let bestKey: readonly number[] | undefined
  for (const item of items) {
    const k = key(item)
    if (bestKey === undefined || compareTuples(k, bestKey) > 0) {
      best = item
      bestKey = k
    }
  }
  return best
}

/** Python's tuple comparison for tuples of numbers. */
export function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return a.length - b.length
}
