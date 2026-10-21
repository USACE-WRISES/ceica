// Python's str methods where the views and file names need them: whitespace as str.isspace() knows
// it, str.split() and str.strip(), str.isalnum() and str.isdigit() for one character, and len() and
// slices counted in code points (JavaScript counts UTF-16 units).
//
// JavaScript's Unicode properties stand in for Python's tables: letters and numbers for isalnum,
// decimal digits for isdigit. They agree on every character a study is likely to hold; a rare digit
// or numeric sign may differ (web/README.md).

/** str.isspace(): Unicode spaces and separators, and the ASCII control spaces Python counts. */
const WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g')
const RUNS = new RegExp(`[${WS}]+`)
const LEFT = new RegExp(`^[${WS}]+`)
const RIGHT = new RegExp(`[${WS}]+$`)

/** str.strip() */
export const pyStrip = (s: string): string => s.replace(EDGES, '')
/** str.lstrip() */
export const pyLstrip = (s: string): string => s.replace(LEFT, '')
/** str.rstrip() */
export const pyRstrip = (s: string): string => s.replace(RIGHT, '')
/** str.split() with no separator: runs of whitespace, none at the ends. */
export const pySplit = (s: string): string[] => s.split(RUNS).filter((part) => part !== '')
/** len(s): code points */
export const pyLen = (s: string): number => [...s].length
/** s[start:end] in code points (non-negative bounds). */
export const pySlice = (s: string, start: number, end?: number): string => [...s].slice(start, end).join('')
/** ch.isalnum() for one character */
export const pyIsAlnum = (ch: string): boolean => /^[\p{L}\p{N}]$/u.test(ch)
/** s.isdigit(): every character a digit, and at least one. */
export const pyIsDigit = (s: string): boolean => /^\p{Nd}+$/u.test(s)
/** str.capitalize(): the first character upper case, the rest lower. */
export const pyCapitalize = (s: string): string => {
  const cs = [...s]
  return cs.length ? cs[0].toUpperCase() + cs.slice(1).join('').toLowerCase() : s
}

/** str.splitlines(): Python's line boundaries (CR LF, LF, CR, VT, FF, the file, group and record
 * separators, NEL and the Unicode line and paragraph separators), no empty last part. */
export function pySplitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** repr(s) for a str: single quotes unless the text holds one and no double quote; backslashes, the
 * quote, line breaks, tabs and other control characters escaped. */
export function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') out += '\\' + '\\'
    else if (ch === q) out += '\\' + q
    else if (ch === '\n') out += '\\' + 'n'
    else if (ch === '\r') out += '\\' + 'r'
    else if (ch === '\t') out += '\\' + 't'
    else if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) out += '\\' + 'x' + c.toString(16).padStart(2, '0')
    else if (c === 0x2028 || c === 0x2029) out += '\\' + 'u' + c.toString(16).padStart(4, '0')
    else out += ch
  }
  return q + out + q
}

/** What float(text) and int(text) raise: Python's ValueError, in its words. */
export class PyValueError extends Error {}

/** Python's TypeError, in its words (float() of a value that is not a number or text). */
export class PyTypeError extends Error {}

const DECIMAL = /^\p{Nd}$/u
const ASCII_SPACE = /^[\t\n\x0b\x0c\r\x1c-\x1f ]+|[\t\n\x0b\x0c\r\x1c-\x1f ]+$/g
const FLOAT_TEXT = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/
const SPECIAL = /^([+-]?)(inf|infinity|nan)$/i

/** A Unicode decimal digit's value: such digits come in runs of ten, 0 to 9, each run whole. */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0)!
  let n = 0
  while (DECIMAL.test(String.fromCodePoint(cp - 1))) {
    cp -= 1
    n += 1
  }
  return n % 10
}

/** float(text) for a str: spaces around it, Unicode digits, underscores between digits, inf and nan;
 * anything else raises Python's "could not convert string to float: '...'". */
export function pyFloatText(text: string): number {
  let ascii = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) ascii += ch
    else if (RUNS.test(ch)) ascii += ' '
    else if (DECIMAL.test(ch)) ascii += String(digitValue(ch))
    else ascii += '?'
  }
  const s = ascii.replace(ASCII_SPACE, '')
  const sp = SPECIAL.exec(s)
  if (sp) return sp[2].toLowerCase() === 'nan' ? NaN : sp[1] === '-' ? -Infinity : Infinity
  if (!FLOAT_TEXT.test(s)) throw new PyValueError(`could not convert string to float: ${pyStrRepr(text)}`)
  return Number(s.replace(/_/g, ''))
}
