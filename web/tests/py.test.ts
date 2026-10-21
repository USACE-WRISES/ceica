// Python's number behavior, against py_ref.json (web/parity/make_py_fixtures.py).
import { describe, expect, it } from 'vitest'
import { pyFixed } from '../src/py/pyfmt'
import { commaInt, pyFormatG, pyRoundInt, pySum, ratioToFloat } from '../src/py/pynum'
import refJson from './fixtures/py_ref.json'
import { failures } from './helpers'

interface PyRef {
  formatG: [number, number, string][]
  roundN: [number, number, number][]
  roundInt: [number, number][]
  sums: [number[], number][]
  ratios: [string, string, number][]
  commas: [string, string][]
}
const ref = refJson as unknown as PyRef

describe('Python number behavior', () => {
  it('format(x, ".Ng"), ties half to even on the exact value', () => {
    expect(failures(ref.formatG, ([x, p, want]) => pyFormatG(x, p) === want)).toEqual([])
  })

  it('round(x, n)', () => {
    expect(failures(ref.roundN, ([x, n, want]) => Object.is(Number(pyFixed(x, n)), want)))
      .toEqual([])
  })

  it('round(x), half to even', () => {
    expect(failures(ref.roundInt, ([x, want]) => pyRoundInt(x) === want)).toEqual([])
  })

  it('sum() of floats, compensated as Python 3.12 adds them', () => {
    expect(failures(ref.sums, ([xs, want]) => Object.is(pySum(xs), want))).toEqual([])
  })

  it('float(Fraction(a, b)), correctly rounded', () => {
    expect(failures(ref.ratios, ([a, b, want]) =>
      Object.is(ratioToFloat(BigInt(a), BigInt(b)), want))).toEqual([])
  })

  it('f"{n:,}"', () => {
    expect(failures(ref.commas, ([n, want]) => commaInt(BigInt(n)) === want)).toEqual([])
  })
})
