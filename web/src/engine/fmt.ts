// Number formatting for tables, charts and reports. Missing values read "n/a" (ceica/fmt.py).
import { pyFixed, pyFixedComma } from '../py/pyfmt'
import { commaInt, pyFormatG, pyRound } from '../py/pynum'

export const NA = 'n/a'

const missing = (v: number | null | undefined): v is null | undefined =>
  v === null || v === undefined || !Number.isFinite(v)

export function num(v: number | null | undefined, dp = 2): string {
  if (missing(v)) return NA
  const s = pyFixedComma(v, dp)
  return s.startsWith('-') && Number(s.replace(/,/g, '')) === 0 ? s.slice(1) : s
}

export function money(v: number | null | undefined, dp = 0): string {
  if (missing(v)) return NA
  const s = pyFixedComma(Math.abs(v), dp)
  return (v < 0 && Number(s.replace(/,/g, '')) !== 0 ? '-$' : '$') + s
}

export function pct(v: number | null | undefined, dp = 1): string {
  if (missing(v)) return NA
  return `${pyFixed(v * 100, dp)} percent`
}

/** Rounded to three significant figures: $368,000, $4.53 million. */
export function sig3Money(v: number | null | undefined): string {
  if (missing(v)) return NA
  if (Math.abs(v) >= 1e6) return `$${pyFormatG(v / 1e6, 3)} million`
  if (v === 0) return '$0'
  const digits = 3 - Math.floor(Math.log10(Math.abs(v))) - 1
  return money(pyRound(v, digits))
}

export function countText(n: number | bigint, singular: string, plural: string | null = null): string {
  const one = typeof n === 'bigint' ? n === 1n : n === 1
  return `${commaInt(n)} ${one ? singular : (plural || singular + 's')}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A date as Python's %B %d, %Y (English month names, the day zero-padded). */
export function longDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`
}
