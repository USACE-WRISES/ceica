// openpyxl 3.1.5's formula tokenizer and translator (openpyxl/formula/tokenizer.py, translate.py),
// which its reader uses for a shared formula (Excel writes one when a formula is filled down): each
// cell after the first gets the first cell's formula with its relative references moved.
//
// Ported as written, quirks included: a run of spaces reads as one space, a named range loses its
// sheet's name, and lowercase references come back uppercase.
import { pyFloatText } from '../../py/pystr'
import { colLetter } from './book'

/** What the tokenizer raises (TokenizerError). */
export class TokenizerError extends Error {}

/** What the translator raises when a reference would leave the sheet (TranslatorError). */
export class TranslatorError extends Error {}

const LITERAL = 'LITERAL'
const OPERAND = 'OPERAND'
const FUNC = 'FUNC'
const ARRAY = 'ARRAY'
const PAREN = 'PAREN'
const SEP = 'SEP'
const OP_PRE = 'OPERATOR-PREFIX'
const OP_IN = 'OPERATOR-INFIX'
const OP_POST = 'OPERATOR-POSTFIX'
const WSPACE = 'WHITE-SPACE'
const OPEN = 'OPEN'
const CLOSE = 'CLOSE'

export interface Token { readonly value: string, readonly type: string, readonly subtype: string }

const token = (value: string, type: string, subtype = ''): Token => ({ value, type, subtype })

/** whether float(value) reads the text */
function isNumber(value: string): boolean {
  try {
    pyFloatText(value)
    return true
  } catch {
    return false
  }
}

function makeOperand(value: string): Token {
  let subtype: string
  if (value.startsWith('"')) subtype = 'TEXT'
  else if (value.startsWith('#')) subtype = 'ERROR'
  else if (value === 'TRUE' || value === 'FALSE') subtype = 'LOGICAL'
  else subtype = isNumber(value) ? 'NUMBER' : 'RANGE'
  return token(value, OPERAND, subtype)
}

/** make_subexp: "value in '{}'" and the like are substring tests in the Python */
function makeSubexp(value: string, func = false): Token {
  let type: string
  if (func) type = FUNC
  else if ('{}'.includes(value)) type = ARRAY
  else if ('()'.includes(value)) type = PAREN
  else type = FUNC
  return token(value, type, ')}'.includes(value) ? CLOSE : OPEN)
}

function closerOf(t: Token): Token {
  return makeSubexp(t.type === ARRAY ? '}' : ')', t.type === FUNC)
}

const SN_RE = /^[1-9](\.[0-9]+)?[Ee]$/
const WSPACE_RE = /^[ \n]+/
const STRING_RE: Record<string, RegExp> = { '"': /^"(?:[^"]*"")*[^"]*"(?!")/, "'": /^'(?:[^']*'')*[^']*'(?!')/ }
const ERROR_CODES = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA']
const TOKEN_ENDERS = ',;}) +-*/^&=><%'

/** Tokenizer(formula).items */
export function tokenize(formula: string): Token[] {
  const items: Token[] = []
  if (!formula) return items
  if (formula[0] !== '=') return [token(formula, LITERAL)]
  const stack: Token[] = []
  let cur: string[] = []
  let offset = 1
  const assertEmpty = (canFollow = ''): void => {
    // "self.token[-1] not in can_follow": a substring test of the last piece
    if (cur.length && !(canFollow && canFollow.includes(cur[cur.length - 1]))) {
      throw new TokenizerError(`Unexpected character at position ${offset} in '${formula}'`)
    }
  }
  const save = (): void => {
    if (cur.length) {
      items.push(makeOperand(cur.join('')))
      cur = []
    }
  }
  const parseString = (): number => {
    assertEmpty(':')
    const delim = formula[offset]
    const m = STRING_RE[delim].exec(formula.slice(offset))
    if (m === null) throw new TokenizerError(`Reached end of formula while parsing ${delim === '"' ? 'string' : 'link'} in ${formula}`)
    if (delim === '"') items.push(makeOperand(m[0]))
    else cur.push(m[0])
    return m[0].length
  }
  const parseBrackets = (): number => {
    const rest = formula.slice(offset)
    const marks: [number, number][] = []
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] === '[') marks.push([k, 1])
      else if (rest[k] === ']') marks.push([k, -1])
    }
    marks.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let open = 0
    for (const [idx, step] of marks) {
      open += step
      if (open === 0) {
        cur.push(formula.slice(offset, offset + idx + 1))
        return idx + 1
      }
    }
    throw new TokenizerError(`Encountered unmatched '[' in ${formula}`)
  }
  const parseError = (): number => {
    assertEmpty('!')
    const sub = formula.slice(offset)
    for (const err of ERROR_CODES) {
      if (sub.startsWith(err)) {
        items.push(makeOperand(cur.join('') + err))
        cur = []
        return err.length
      }
    }
    throw new TokenizerError(`Invalid error code at position ${offset} in '${formula}'`)
  }
  const parseWhitespace = (): number => {
    items.push(token(formula[offset], WSPACE))
    return WSPACE_RE.exec(formula.slice(offset))![0].length
  }
  const parseOperator = (): number => {
    const two = formula.slice(offset, offset + 2)
    if (two === '>=' || two === '<=' || two === '<>') {
      items.push(token(two, OP_IN))
      return 2
    }
    const ch = formula[offset]
    let t: Token
    if (ch === '%') t = token('%', OP_POST)
    else if ('*/^&=><'.includes(ch)) t = token(ch, OP_IN)
    else if (!items.length) t = token(ch, OP_PRE)
    else {
      const prev = [...items].reverse().find((x) => x.type !== WSPACE)
      const infix = prev !== undefined && (prev.subtype === CLOSE || prev.type === OP_POST || prev.type === OPERAND)
      t = token(ch, infix ? OP_IN : OP_PRE)
    }
    items.push(t)
    return 1
  }
  const parseOpener = (): number => {
    let t: Token
    if (formula[offset] === '{') {
      assertEmpty()
      t = makeSubexp('{')
    } else if (cur.length) {
      t = makeSubexp(cur.join('') + '(')
      cur = []
    } else t = makeSubexp('(')
    items.push(t)
    stack.push(t)
    return 1
  }
  const parseCloser = (): number => {
    const open = stack.pop()
    if (open === undefined) throw new Error('pop from empty list')
    const t = closerOf(open)
    if (t.value !== formula[offset]) throw new TokenizerError(`Mismatched ( and { pair in '${formula}'`)
    items.push(t)
    return 1
  }
  const parseSeparator = (): number => {
    const ch = formula[offset]
    let t: Token
    if (ch === ';') t = token(';', SEP, 'ROW')
    else if (!stack.length || stack[stack.length - 1].type === PAREN) t = token(',', OP_IN)
    else t = token(',', SEP, 'ARG')
    items.push(t)
    return 1
  }
  const consumers: [string, () => number][] = [['"\'', parseString], ['[', parseBrackets], ['#', parseError], [' \n', parseWhitespace],
    ['+-*/^&=><%', parseOperator], ['{(', parseOpener], [')}', parseCloser], [';,', parseSeparator]]
  const dispatch = new Map<string, () => number>()
  for (const [chars, fn] of consumers) for (const ch of chars) dispatch.set(ch, fn)
  while (offset < formula.length) {
    const ch = formula[offset]
    // a sign inside a number in scientific notation (1.5E-3)
    if ((ch === '+' || ch === '-') && cur.length && SN_RE.test(cur.join(''))) {
      cur.push(ch)
      offset++
      continue
    }
    if (TOKEN_ENDERS.includes(ch)) save()
    const fn = dispatch.get(ch)
    if (fn) offset += fn()
    else {
      cur.push(ch)
      offset++
    }
  }
  save()
  return items
}

const ROW_RANGE_RE = /^(\$?[1-9][0-9]{0,6}):(\$?[1-9][0-9]{0,6})$/
const COL_RANGE_RE = /^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})$/
const CELL_REF_RE = /^(\$?[A-Za-z]{1,3})(\$?[1-9][0-9]{0,6})$/
const MAX_COLUMN = 18278

function columnIndex(letters: string): number {
  const up = letters.toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(up)) throw new TranslatorError('Formula out of range')
  let n = 0
  for (const ch of up) n = n * 26 + ch.charCodeAt(0) - 64
  return n
}

function translateRow(row: string, rdelta: number): string {
  if (row.startsWith('$')) return row
  const n = Number(row) + rdelta
  if (n <= 0) throw new TranslatorError('Formula out of range')
  return String(n)
}

function translateCol(col: string, cdelta: number): string {
  if (col.startsWith('$')) return col
  const n = columnIndex(col) + cdelta
  if (n < 1 || n > MAX_COLUMN) throw new TranslatorError('Formula out of range')
  return colLetter(n)
}

function translateRange(text: string, rdelta: number, cdelta: number): string {
  let ws = ''
  let range = text
  const bang = text.lastIndexOf('!')
  if (bang >= 0) {
    ws = text.slice(0, bang + 1)
    range = text.slice(bang + 1)
  }
  let m = ROW_RANGE_RE.exec(range)
  if (m) return ws + translateRow(m[1], rdelta) + ':' + translateRow(m[2], rdelta)
  m = COL_RANGE_RE.exec(range)
  if (m) return ws + translateCol(m[1], cdelta) + ':' + translateCol(m[2], cdelta)
  if (range.includes(':')) return ws + range.split(':').map((piece) => translateRange(piece, rdelta, cdelta)).join(':')
  m = CELL_REF_RE.exec(range)
  // a named range (its sheet's name dropped, as openpyxl drops it)
  if (m === null) return range
  return ws + translateCol(m[1], cdelta) + translateRow(m[2], rdelta)
}

/** "B4" as [row, column] (coordinate_to_tuple) */
function cellTuple(coord: string): [number, number] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(coord)
  if (!m) throw new Error(`Invalid cell coordinates (${coord})`)
  return [Number(m[2]), columnIndex(m[1])]
}

/** A shared formula's first cell (Translator(formula, origin)), to give its other cells their formula. */
export class Translator {
  private readonly row: number
  private readonly col: number
  private readonly tokens: Token[]

  constructor(formula: string, origin: string) {
    ;[this.row, this.col] = cellTuple(origin)
    this.tokens = tokenize(formula)
  }

  /** The formula as it reads at ``dest`` (translate_formula). */
  translate(dest: string | null): string {
    const tokens = this.tokens
    if (!tokens.length) return ''
    if (tokens[0].type === LITERAL) return tokens[0].value
    let rdelta = 0
    let cdelta = 0
    if (dest) {
      const [r, c] = cellTuple(dest)
      rdelta = r - this.row
      cdelta = c - this.col
    }
    let out = '='
    for (const t of tokens) out += t.type === OPERAND && t.subtype === 'RANGE' ? translateRange(t.value, rdelta, cdelta) : t.value
    return out
  }
}
