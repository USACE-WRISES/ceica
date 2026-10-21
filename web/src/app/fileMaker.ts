// Download jobs made in the files worker (filesWorker.ts), each answered by its id; where there is no
// worker (none allowed, or it failed to start), the page makes the file itself.
import type { FileJob } from './files'

interface Waiting { resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void }

export class FileMaker {
  private worker: Worker | null = null
  private failed = false
  private next = 1
  private readonly waiting = new Map<number, Waiting>()

  /** The job's file. */
  make(job: FileJob): Promise<Uint8Array> {
    const w = this.start()
    if (!w) return import('./files').then((m) => m.buildJob(job))
    const id = this.next++
    return new Promise<Uint8Array>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      w.postMessage({ id, job })
    })
  }

  /** The worker started now (its script read while this build's copy is still kept: an update). */
  warm(): void {
    this.start()
  }

  private start(): Worker | null {
    if (this.worker || this.failed || typeof Worker === 'undefined') return this.worker
    try {
      const w = new Worker(new URL('./filesWorker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<{ id: number, bytes?: Uint8Array, error?: string }>) => {
        const wait = this.waiting.get(e.data.id)
        if (!wait) return
        this.waiting.delete(e.data.id)
        if (e.data.error !== undefined) wait.reject(new Error(e.data.error))
        else wait.resolve(e.data.bytes!)
      }
      w.onerror = (e) => {
        // the worker could not run: what it was making fails, and the page makes what comes next
        e.preventDefault()
        this.failed = true
        this.worker = null
        w.terminate()
        for (const wait of this.waiting.values()) wait.reject(new Error('the files worker stopped'))
        this.waiting.clear()
      }
      this.worker = w
    } catch {
      this.failed = true
    }
    return this.worker
  }
}
