// Undo and redo against ceica/history.py (history_ref.json, make_history_fixtures.py).
import { describe, expect, it } from 'vitest'
import { History } from '../src/engine/history'
import ref from './fixtures/history_ref.json'

type Step = [string, ...unknown[]]
interface Case { limit: number, trace: { step: Step, got: unknown, can_undo: boolean, can_redo: boolean, peek_undo: string | null,
  peek_redo: string | null, cursor: number, entries: [string, string, string | null, number][] }[] }

describe('History follows history.py', () => {
  for (const [i, c] of (ref as Case[]).entries()) {
    it(`script ${i} (limit ${c.limit})`, () => {
      const hist = new History(c.limit)
      for (const [k, t] of c.trace.entries()) {
        const [op, ...a] = t.step
        let got: unknown
        if (op === 'baseline') got = hist.baseline(a[0] as string)
        else if (op === 'record') got = hist.record(a[0] as string, a[1] as string, { key: a[2] as string | null, now: a[3] as number })
        else if (op === 'undo') got = hist.undo()
        else if (op === 'redo') got = hist.redo()
        else got = hist.clear()
        const seen = {
          got: got === undefined ? null : got, can_undo: hist.canUndo(), can_redo: hist.canRedo(), peek_undo: hist.peekUndo(),
          peek_redo: hist.peekRedo(), cursor: hist.cursor, entries: hist.entries.map((e) => [e.label, e.snap, e.key, e.t]),
        }
        expect(seen, `step ${k}: ${JSON.stringify(t.step)}`).toEqual({ ...t, step: undefined, got: t.got })
      }
    })
  }
})
