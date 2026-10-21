// Number formatting against the Python engine (fmt_ref.json, web/parity/make_fmt_fixtures.py).
import { describe, expect, it } from 'vitest'
import { countText, money, num, pct, sig3Money } from '../src/engine/fmt'
import refJson from './fixtures/fmt_ref.json'
import { failures } from './helpers'

const ref = refJson as unknown as {
  rows: [number, string[], string[], string[], string][]
  missing: string[]
  counts: [string, string, string][]
}

describe('number formatting', () => {
  it('num, money, pct and sig3 money as Python writes them', () => {
    expect(failures(ref.rows, ([v, nums, moneys, pcts, sig3]) =>
      JSON.stringify([[0, 1, 2, 3, 4].map((dp) => num(v, dp)), [0, 2].map((dp) => money(v, dp)),
        [0, 1, 2].map((dp) => pct(v / 100, dp)), sig3Money(v)]) === JSON.stringify([nums, moneys, pcts, sig3])))
      .toEqual([])
  })

  it('missing values read n/a', () => {
    expect([num(null), money(null), pct(null), sig3Money(null), num(NaN), money(Infinity)]).toEqual(ref.missing)
  })

  it('counts', () => {
    for (const [n, plan, study] of ref.counts) {
      expect([countText(BigInt(n), 'plan'), countText(BigInt(n), 'study', 'studies')]).toEqual([plan, study])
    }
  })
})
