// Python's csv.reader with its defaults (the "excel" dialect), over the lines io.StringIO(text) gives:
// a line ends at "\n" only (StringIO's newline="\n"), and the reader takes every character of it, so a
// carriage return inside a line ends the record and anything after it is an error, in csv's words.
//
// Ported from CPython 3.12's Modules/_csv.c (parse_process_char and Reader_iternext): delimiter ",",
// quote '"', doubled quotes, no escape character, strict off, the 131,072-character field limit.

/** _csv.Error */
export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Error'
  }
}

const enum S { StartRecord, StartField, InField, InQuotedField, QuoteInQuotedField, EatCrnl }

/** csv.field_size_limit() */
export const FIELD_LIMIT = 131072
/** the end of a line, as _csv.c's EOL marks it */
const EOL = -1

/** list(csv.reader(io.StringIO(text))) */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let fields: string[] = []
  let field: string[] = []
  // (typed wide: step() changes it, which the checker cannot see from here)
  let state = S.StartRecord as S
  const save = (): void => {
    fields.push(field.join(''))
    field = []
  }
  const add = (ch: string): void => {
    if (field.length >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`)
    field.push(ch)
  }
  const step = (ch: string | typeof EOL): void => {
    const nl = ch === '\n' || ch === '\r'
    switch (state) {
      case S.StartRecord:
        if (ch === EOL) return                     // an empty line: []
        if (nl) {
          state = S.EatCrnl
          return
        }
        state = S.StartField
      // falls through
      case S.StartField:
        if (nl || ch === EOL) {
          save()
          state = ch === EOL ? S.StartRecord : S.EatCrnl
        } else if (ch === '"') state = S.InQuotedField
        else if (ch === ',') save()
        else {
          add(ch)
          state = S.InField
        }
        return
      case S.InField:
        if (nl || ch === EOL) {
          save()
          state = ch === EOL ? S.StartRecord : S.EatCrnl
        } else if (ch === ',') {
          save()
          state = S.StartField
        } else add(ch)
        return
      case S.InQuotedField:
        if (ch === EOL) return
        if (ch === '"') state = S.QuoteInQuotedField
        else add(ch)
        return
      case S.QuoteInQuotedField:
        if (ch === '"') {
          add(ch)
          state = S.InQuotedField
        } else if (ch === ',') {
          save()
          state = S.StartField
        } else if (nl || ch === EOL) {
          save()
          state = ch === EOL ? S.StartRecord : S.EatCrnl
        } else {
          add(ch)
          state = S.InField
        }
        return
      case S.EatCrnl:
        if (nl) return
        if (ch === EOL) state = S.StartRecord
        else throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?")
    }
  }
  // io.StringIO's lines: each up to and including its "\n"
  const lines: string[] = []
  let at = 0
  while (at < text.length) {
    const nl = text.indexOf('\n', at)
    const end = nl < 0 ? text.length : nl + 1
    lines.push(text.slice(at, end))
    at = end
  }
  for (const line of lines) {
    for (const ch of line) step(ch)
    step(EOL)
    // a record ends with its line (a blank line gives []); one still open (a quoted field) goes on
    if (state === S.StartRecord) {
      rows.push(fields)
      fields = []
    }
  }
  // the input ended inside a record: what is there is its last field (strict off)
  if (field.length || state === S.InQuotedField) {
    save()
    rows.push(fields)
  }
  return rows
}
