// The edits and the grid cells against views/edits.py and views/cells.py (edits_ref.json,
// make_edits_fixtures.py): each scripted step's project, by its content digest, whether it equals the
// one before, and every refusal in the Python's words.
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { modelEquals, type Project } from '../src/engine/model'
import { pyFloat } from '../src/py/pyfmt'
import { pyFloatText } from '../src/py/pystr'
import { contentDigest, loads } from '../src/engine/projectfile'
import * as cells from '../src/views/cells'
import * as edits from '../src/views/edits'
import ref from './fixtures/edits_ref.json'
import { projectGoldens } from './projects'

interface Step { op: string, args: unknown[], kw: Record<string, unknown>, res: boolean, ok?: { digest: string, same: boolean, cells?: number },
  error?: [string, string] }

const inputs = new Map(projectGoldens().map((g) => [g.name, g.input]))
const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** The TypeScript's function for a Python edit: the same name in camelCase. */
const FN: Record<string, (...a: any[]) => any> = {
  ...Object.fromEntries(Object.entries(edits).filter(([, v]) => typeof v === 'function')),
  copyItemsToSite: edits.copyItemsToSite, apply: cells.apply, applyBlock: cells.applyBlock,
}

function run(p: Project, s: Step): unknown {
  const fn = FN[camel(s.op)]
  if (!fn) throw new Error(`no function for ${s.op}`)
  const head = s.res ? [p, analyze(p)] : [p]
  if (s.op === 'report_settings') return fn(p, s.kw)
  return fn(...head, ...s.args)
}

describe.each((ref as { scripts: { project: string, steps: Step[] }[] }).scripts)('edits on $project', ({ project, steps }) => {
  it('every step as the Python takes it', () => {
    let p = loads(inputs.get(project)!).project
    for (const [i, s] of steps.entries()) {
      const where = `step ${i}: ${s.op}(${JSON.stringify(s.args)}${Object.keys(s.kw).length ? ', ' + JSON.stringify(s.kw) : ''})`
      let out: unknown
      try {
        out = run(p, s)
      } catch (exc) {
        const name = exc instanceof edits.EditError ? 'EditError' : exc instanceof cells.CellError ? 'CellError' : (exc as Error).name
        expect([name, (exc as Error).message], where).toEqual(s.error)
        continue
      }
      expect(s.error, `${where}: Python refused it`).toBeUndefined()
      let next = out as Project
      let n: number | undefined
      if (s.op === 'apply_block') [next, n] = out as [Project, number]
      expect({ digest: contentDigest(next), same: modelEquals(next, p), ...(n !== undefined ? { cells: n } : {}) }, where).toEqual(s.ok)
      p = next
    }
  })
})

/** repr() of a float, as the golden writes values. */
const repr = (v: number | null): string | null => (v === null ? null : pyFloat(v))

describe('numbers in cells and dialogs', () => {
  for (const c of (ref as unknown as { numbers: Record<string, string | null>[] }).numbers) {
    it(JSON.stringify(c.text), () => {
      const text = c.text as string
      if ('parse_number_error' in c) expect(() => cells.parseNumber(text)).toThrow(c.parse_number_error!)
      else expect(repr(cells.parseNumber(text))).toBe(c.parse_number)
      if ('float_error' in c) expect(() => pyFloatText(text)).toThrow(c.float_error!)
      else expect(repr(pyFloatText(text))).toBe(c.float)
    })
  }
})
