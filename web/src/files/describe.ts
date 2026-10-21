// What a file is, for the file goldens: the same description web/parity/describe.py gives, so a file
// this app makes can be compared with Python's part by part.
//
// - A zip (a workbook, a Word file, the Report page's zips): each entry's record, in the archive's
//   order (name, method, flags, versions, attributes, date, CRC and sizes), and each member described in
//   turn. A member holding pictures (a PNG, or a Word file with pictures) leaves out of its record what
//   the pictures' bytes decide (its CRC and sizes), and so does the zip's own digest when it holds one.
// - A PNG: its pixel size and pixels per meter.
// - Anything else: its text, when it is UTF-8 and at most 4,096 bytes; else its digest.
import { sha256 } from '../py/bytes'
import { readZip } from './zip'

export const LIMIT = 4096
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export interface Described {
  zip?: { entries: Record<string, unknown>[], parts: [string, Described][] }
  png?: { width?: number, height?: number, ppm?: number[] }
  text?: string
  digest?: string
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** sha256:<16 hex>:<length> */
export const digest = (data: Uint8Array): string => `sha256:${hex(sha256(data)).slice(0, 16)}:${data.length}`

const isPng = (data: Uint8Array): boolean => data.length >= 8 && PNG.every((b, i) => data[i] === b)

export function describe(data: Uint8Array): Described {
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6))) {
    return describeZip(data)
  }
  if (isPng(data)) return { png: pngInfo(data) }
  let text: string | null = null
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    text = null
  }
  if (text !== null && data.length <= LIMIT) return { text }
  return { digest: digest(data) }
}

/** A PNG's pixel size and its pHYs (pixels per meter), from its chunks. */
export function pngInfo(data: Uint8Array): { width?: number, height?: number, ppm?: number[] } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: { width?: number, height?: number, ppm?: number[] } = {}
  let p = 8
  while (p + 8 <= data.length) {
    const n = dv.getUint32(p)
    const kind = String.fromCharCode(...data.subarray(p + 4, p + 8))
    if (kind === 'IHDR') {
      out.width = dv.getUint32(p + 8)
      out.height = dv.getUint32(p + 12)
    } else if (kind === 'pHYs' && data[p + 16] === 1) out.ppm = [dv.getUint32(p + 8), dv.getUint32(p + 12)]
    else if (kind === 'IEND') break
    p += 12 + n
  }
  return out
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function describeZip(data: Uint8Array): Described {
  const z = readZip(data)
  const entries: Record<string, unknown>[] = []
  const parts: [string, Described][] = []
  let pictures = false
  for (const e of z.entries) {
    const member = z.read(e.name)
    const part = describe(member)
    const picture = isPng(member) || (part.zip !== undefined && part.digest === undefined)
    pictures ||= picture
    const time = `${pad((e.dosDate >> 9) + 1980, 4)}-${pad((e.dosDate >> 5) & 0xf)}-${pad(e.dosDate & 0x1f)} `
      + `${pad(e.dosTime >> 11)}:${pad((e.dosTime >> 5) & 0x3f)}:${pad((e.dosTime & 0x1f) * 2)}`
    const rec: Record<string, unknown> = {
      name: e.name, method: e.method, flags: e.flags, made: e.versionMadeBy, needed: e.versionNeeded, attr: e.externalAttr, time,
    }
    if (!picture) Object.assign(rec, { crc: e.crc, csize: e.compressedSize, size: e.size })
    entries.push(rec)
    parts.push([e.name, part])
  }
  const out: Described = { zip: { entries, parts } }
  if (!pictures) out.digest = digest(data)
  return out
}
