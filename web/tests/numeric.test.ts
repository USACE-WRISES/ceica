// numeric.ts against the Python engine (py_ref.json: quantize and ratio).
import { describe, expect, it } from 'vitest'
import { quantize, ratio, roundHalfUp, TooLargeError } from '../src/engine/numeric'
import refJson from './fixtures/py_ref.json'
import { failures } from './helpers'

const ref = refJson as unknown as {
  quantize: [number, number, number][]
  engineRatio: [number, number, number, number, number][]
}

describe('numeric', () => {
  it('quantize: 15 significant digits, then half away from zero', () => {
    expect(failures(ref.quantize, ([x, dp, want]) => quantize(x, dp) === want)).toEqual([])
  })

  it('ratio: exact, then rounded once', () => {
    expect(failures(ref.engineRatio, ([a, b, ndp, ddp, want]) =>
      Object.is(ratio(a, b, ndp, ddp), want))).toEqual([])
  })

  it('refuses a value too large to hold exactly', () => {
    expect(() => quantize(5e10, 6)).toThrow(TooLargeError)
  })

  // tests/test_ceica_core.py
  it.each([
    [2.675, 2, 268], [1.005, 2, 101], [-2.675, 2, -268], [0.0005, 3, 1], [-0.0005, 3, -1],
    [31.3794, 3, 31379], [46343.495, 2, 4634350], [1e9, 2, 100000000000],
  ])('quantize(%s, %s) is %s', (x, dp, want) => {
    expect(quantize(x, dp)).toBe(want)
  })

  it('round half up and ratio', () => {
    expect(roundHalfUp(2.675, 2)).toBe(2.68)
    expect(ratio(15000, 20000, 2, 3)).toBe(7.5)
    expect(ratio(5, 0, 2, 3)).toBe(0)
  })
})
