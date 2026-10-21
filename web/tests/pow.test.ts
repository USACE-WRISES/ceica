// x ** y on the engine's bases and exponents, against pow_ref.json (web/parity/probe_pow.py).
import { describe, expect, it } from 'vitest'
import { crPow } from '../src/py/pynum'
import refJson from './fixtures/pow_ref.json'
import { failures, ulpsApart } from './helpers'

const ref = refJson as unknown as { cases: [number, number, number, number][] }

describe('crPow', () => {
  it('gives the correctly rounded power (Decimal at 80 digits)', () => {
    expect(failures(ref.cases, ([x, y, cr]) => crPow(x, y) === cr)).toEqual([])
  })

  it('differs from Python\'s own ** only where the C library is a unit off', () => {
    const off = ref.cases.filter(([, , cr, py]) => cr !== py)
    console.info(`Python's ** differs from the correctly rounded power in ${off.length} of ` +
      `${ref.cases.length} cases`)
    expect(failures(off, ([, , cr, py]) => ulpsApart(cr, py) === 1)).toEqual([])
  })

  it('is exact on whole and half exponents and on the trivial cases', () => {
    expect(crPow(1.5, 2)).toBe(2.25)
    expect(crPow(2, 0.5)).toBe(Math.SQRT2)
    expect(crPow(4, -0.5)).toBe(0.5)
    expect(crPow(1.03, 0)).toBe(1)
    expect(crPow(1, 123.456)).toBe(1)
    expect(crPow(1.1, 1)).toBe(1.1)
  })
})
