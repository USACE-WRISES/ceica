// The files worker: makes a download's file off the page's thread (files.ts's buildJob), so a large
// study's zip or document leaves the page responsive, as Shiny's server does.
import { buildJob, type FileJob } from './files'

/** the worker's scope (the page's lib types `self` as a window) */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number, job: FileJob }>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

scope.onmessage = (e) => {
  const { id, job } = e.data
  buildJob(job).then(
    (bytes) => scope.postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]),
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  )
}
