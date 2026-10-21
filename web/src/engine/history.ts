// Undo and redo: a bounded stack of project snapshots (ceica/history.py).
//
// A snapshot is the canonical JSON of the project (inputs and decisions); the text is the dedupe
// key, so a no-op never records. A new edit drops the redo tail, and edits with the same key within
// COALESCE_S seconds fold into one entry (typing a note is one step, not one per keystroke).

export const LIMIT = 100
export const COALESCE_S = 2.0

export interface Entry {
  label: string
  snap: string
  key: string | null
  t: number
}

export class History {
  readonly limit: number
  entries: Entry[] = []
  cursor = -1

  constructor(limit = LIMIT) {
    this.limit = Math.trunc(limit)
  }

  baseline(snap: string): void {
    this.entries = [{ label: '', snap, key: null, t: 0.0 }]
    this.cursor = 0
  }

  record(label: string, snap: string, { key = null as string | null, now = 0.0 } = {}): boolean {
    if (this.cursor < 0) {
      this.baseline(snap)
      return false
    }
    const cur = this.entries[this.cursor]
    if (snap === cur.snap) return false
    this.entries.splice(this.cursor + 1)
    if (key !== null && cur.key === key && now - cur.t <= COALESCE_S && this.cursor > 0) {
      cur.snap = snap
      cur.t = now
      return true
    }
    this.entries.push({ label, snap, key, t: now })
    if (this.entries.length > this.limit + 1) this.entries.splice(0, 1)
    this.cursor = this.entries.length - 1
    return true
  }

  canUndo(): boolean {
    return this.cursor > 0
  }

  canRedo(): boolean {
    return this.cursor >= 0 && this.cursor < this.entries.length - 1
  }

  peekUndo(): string | null {
    return this.canUndo() ? this.entries[this.cursor].label : null
  }

  peekRedo(): string | null {
    return this.canRedo() ? this.entries[this.cursor + 1].label : null
  }

  undo(): [string, string] | null {
    if (!this.canUndo()) return null
    const label = this.entries[this.cursor].label
    this.cursor -= 1
    return [label, this.entries[this.cursor].snap]
  }

  redo(): [string, string] | null {
    if (!this.canRedo()) return null
    this.cursor += 1
    const e = this.entries[this.cursor]
    return [e.label, e.snap]
  }

  clear(): void {
    this.entries = []
    this.cursor = -1
  }
}
