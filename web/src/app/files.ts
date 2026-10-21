// A download job: a Report file made from the project's text, as Shiny's route makes it from the session's
// results. The analysis is run again (results are never stored, CONTRIBUTING.md rule 3), so a job needs
// nothing but the project and the clock; the files worker (filesWorker.ts) runs it off the page's
// thread, the page runs it itself where there is no worker, and the tests call it directly.
import { analyze } from '../engine/analysis'
import { loads } from '../engine/projectfile'
import { buildFile } from '../engine/report/build'
import { canvasPng } from './canvasPng'

export interface FileJob {
  /** the project file's text, taken at the click */
  readonly project: string
  /** the link's key and format (resolve's job) */
  readonly f: string
  readonly fmt: string
  /** the download's day (YYYY-MM-DD) and moment (milliseconds since the epoch) */
  readonly today: string
  readonly now: number
}

/** A day YYYY-MM-DD as a local date at midnight. */
export function localDay(text: string): Date {
  const [y, m, d] = text.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The job's file, as bytes. */
export async function buildJob(job: FileJob): Promise<Uint8Array> {
  const res = analyze(loads(job.project).project)
  return buildFile(res, { f: job.f, fmt: job.fmt }, { today: localDay(job.today), now: new Date(job.now), png: canvasPng })
}
