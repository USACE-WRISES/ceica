// ZIP archives as Python's zipfile reads and writes them. Reading: every entry's metadata from the
// central directory (its name, method, times, attributes, extra field and comment), in the directory's
// order, and each member's bytes on demand. Writing: ZipFile(sink, "w").writestr(info, data) byte for
// byte: the local header with the info's versions and times, data deflated as zlib does at its default
// level (pako, whose output equals zlib's), then the central directory and its end record.
//
// Adapted from STAF's static app (src/files/zip.ts):
// - a member is inflated with pako, so reading is synchronous (the controller opens a workbook or a STAF
//   export inside an effect, as the Python does);
// - an entry with no attributes gets zipfile's 0o600 << 16 (_open_to_write);
// - a writer can take zipfile's streamed form, for a sink that cannot seek (the Report page's zips):
//   flag 0x08, the local header's CRC and sizes left 0, and a data descriptor after the data;
// - the errors are zipfile's, in its words.
import { deflateRaw, inflateRaw as pakoInflateRaw } from 'pako'
import { pyStrRepr } from '../py/pystr'

export interface ZipEntry {
  /** the name as decoded (UTF-8 when flag bit 11 is set, else cp437, as zipfile decodes it) */
  name: string
  versionMadeBy: number
  versionNeeded: number
  flags: number
  method: number
  dosTime: number
  dosDate: number
  crc: number
  compressedSize: number
  size: number
  internalAttr: number
  externalAttr: number
  /** the central directory's extra field and comment */
  extra: Uint8Array
  comment: Uint8Array
  localOffset: number
}

export interface ZipArchive {
  entries: ZipEntry[]
  /** the archive comment */
  comment: Uint8Array
  /** zipfile's namelist(): every entry's name, in the directory's order */
  names(): string[]
  has(name: string): boolean
  entry(name: string): ZipEntry
  /** ZipFile.read(name): a member's bytes, inflated and checked */
  read(name: string): Uint8Array
}

/** zipfile.BadZipFile */
export class BadZipFile extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadZipFile'
  }
}

/** KeyError from ZipFile.getinfo: str() of it is the message's repr, as Python prints a KeyError. */
export class ZipKeyError extends Error {
  constructor(readonly key: string) {
    super(pyStrRepr(`There is no item named ${pyStrRepr(key)} in the archive`))
    this.name = 'KeyError'
  }
}

/** cp437, the code page zipfile decodes a name without the UTF-8 flag in */
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let out = ''
  for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP437[b - 128]
  return out
}

/** Raw deflate, inflated. */
export const inflateRaw = (data: Uint8Array): Uint8Array => pakoInflateRaw(data)

/** The archive's central directory (zipfile.ZipFile(...).infolist()). */
export function readZip(data: Uint8Array): ZipArchive {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new BadZipFile('File is not a zip file')
  const count = dv.getUint16(eocd + 10, true)
  const sizeCd = dv.getUint32(eocd + 12, true)
  // data before the archive (zipfile's "concat") moves every offset
  const concat = eocd - sizeCd - dv.getUint32(eocd + 16, true)
  let p = dv.getUint32(eocd + 16, true) + concat
  const comment = data.slice(eocd + 22, eocd + 22 + dv.getUint16(eocd + 20, true))
  const entries: ZipEntry[] = []
  for (let k = 0; k < count; k++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 0x02014b50) throw new BadZipFile('Bad magic number for central directory')
    const flags = dv.getUint16(p + 8, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const name = decodeName(data.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0)
    entries.push({
      name, versionMadeBy: dv.getUint16(p + 4, true), versionNeeded: dv.getUint16(p + 6, true), flags, method: dv.getUint16(p + 10, true),
      dosTime: dv.getUint16(p + 12, true), dosDate: dv.getUint16(p + 14, true), crc: dv.getUint32(p + 16, true),
      compressedSize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true), internalAttr: dv.getUint16(p + 36, true),
      externalAttr: dv.getUint32(p + 38, true), extra: data.slice(p + 46 + nlen, p + 46 + nlen + xlen),
      comment: data.slice(p + 46 + nlen + xlen, p + 46 + nlen + xlen + clen), localOffset: dv.getUint32(p + 42, true) + concat,
    })
    p += 46 + nlen + xlen + clen
  }
  const byName = new Map<string, ZipEntry>()
  for (const e of entries) byName.set(e.name, e)       // zipfile's NameToInfo: the last of a repeated name
  const entry = (name: string): ZipEntry => {
    const e = byName.get(name)
    if (!e) throw new ZipKeyError(name)
    return e
  }
  return {
    entries, comment, entry, has: (name) => byName.has(name), names: () => entries.map((e) => e.name),
    read(name: string): Uint8Array {
      const e = entry(name)
      const at = e.localOffset
      if (at + 30 > data.length || dv.getUint32(at, true) !== 0x04034b50) throw new BadZipFile('Bad magic number for file header')
      const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true)
      const raw = data.subarray(start, start + e.compressedSize)
      let out: Uint8Array
      if (e.method === ZIP_STORED) out = raw.slice()
      else if (e.method === ZIP_DEFLATED) {
        try {
          out = inflateRaw(raw)
        } catch {
          throw new Error('Error -3 while decompressing data: invalid block type')
        }
      } else throw new Error(`That compression method is not supported`)
      if (crc32(out) !== e.crc) throw new BadZipFile(`Bad CRC-32 for file ${pyStrRepr(name)}`)
      return out
    },
  }
}

// ---------------------------------------------------------------- writing (zipfile.ZipFile(..., "w"))

export const ZIP_STORED = 0
export const ZIP_DEFLATED = 8
/** zipfile.ZipInfo's create_system for a new entry: 0 where Python runs on Windows, 3 elsewhere. The
 * Windows runs are the reference the parity checks compare against. */
export const NEW_ENTRY_SYSTEM = 0
const DEFAULT_VERSION = 20

/** A zipfile.ZipInfo: what writestr writes for one member. */
export interface ZipInfo {
  name: string
  dosTime: number
  dosDate: number
  compressType: number
  createVersion: number
  createSystem: number
  extractVersion: number
  reserved: number
  internalAttr: number
  externalAttr: number
  extra: Uint8Array
  comment: Uint8Array
}

/** The ZipInfo zipfile reads for an entry (its central directory record). */
export function infoOf(e: ZipEntry): ZipInfo {
  return {
    name: e.name, dosTime: e.dosTime, dosDate: e.dosDate, compressType: e.method, createVersion: e.versionMadeBy & 0xff,
    createSystem: e.versionMadeBy >> 8, extractVersion: e.versionNeeded & 0xff, reserved: e.versionNeeded >> 8,
    internalAttr: e.internalAttr, externalAttr: e.externalAttr, extra: e.extra, comment: e.comment,
  }
}

/** A ZipInfo's date_time, (year, month, day, hour, minute, second), in DOS's form. */
export interface DateTime { year: number, month: number, day: number, hour?: number, minute?: number, second?: number }

/** time.localtime()[:6] of a moment: its date and time where the app runs. */
export const localDateTime = (d: Date): DateTime => ({
  year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
})

/** The DOS time and date zipfile writes for a date_time (seconds halved). */
export function dosStamp(t: DateTime): { dosTime: number, dosDate: number } {
  return {
    dosDate: ((t.year - 1980) << 9) | (t.month << 5) | t.day,
    dosTime: ((t.hour ?? 0) << 11) | ((t.minute ?? 0) << 5) | Math.floor((t.second ?? 0) / 2),
  }
}

/** zipfile.ZipInfo(name, date_time=...): a new entry, dated 1980-01-01 00:00 unless ``time`` is given. */
export function newInfo(name: string, time: DateTime = { year: 1980, month: 1, day: 1 }, compressType = ZIP_STORED, externalAttr = 0): ZipInfo {
  return {
    name, ...dosStamp(time), compressType, createVersion: DEFAULT_VERSION, createSystem: NEW_ENTRY_SYSTEM,
    extractVersion: DEFAULT_VERSION, reserved: 0, internalAttr: 0, externalAttr, extra: new Uint8Array(0), comment: new Uint8Array(0),
  }
}

let CRC_TABLE: Uint32Array | null = null

/** zlib.crc32 */
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** zlib.compressobj(Z_DEFAULT_COMPRESSION, DEFLATED, -15): raw deflate at level 6 */
export const deflate = (data: Uint8Array): Uint8Array => deflateRaw(data, { level: 6 })

interface Written { info: ZipInfo, name: Uint8Array, flags: number, attr: number, crc: number, csize: number, usize: number, offset: number }

/** zipfile.ZipFile(sink, "w"): members written in order, then the central directory. ``seekable``:
 * false for a sink zipfile cannot seek (data descriptors after each member). */
export class ZipWriter {
  private chunks: Uint8Array[] = []
  private size = 0
  private written: Written[] = []

  constructor(private readonly opts: { seekable?: boolean } = {}) {}

  private push(b: Uint8Array): void {
    this.chunks.push(b)
    this.size += b.length
  }

  /** ZipFile.writestr(info, data): the info's metadata, the data compressed by its compress type. */
  writestr(info: ZipInfo, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const ascii = /^[\x00-\x7f]*$/.test(info.name)
    const name = new TextEncoder().encode(info.name)
    const stream = this.opts.seekable === false
    const flags = (ascii ? 0 : 0x800) | (stream ? 0x08 : 0)
    let body: Uint8Array
    if (info.compressType === ZIP_DEFLATED) body = deflate(bytes)
    else if (info.compressType === ZIP_STORED) body = bytes
    else throw new Error(`compression type ${info.compressType} is not supported`)
    const w: Written = {
      info, name, flags, attr: info.externalAttr || 0o600 << 16, crc: crc32(bytes), csize: body.length, usize: bytes.length,
      offset: this.size,
    }
    const head = new Uint8Array(30 + name.length + info.extra.length)
    const dv = new DataView(head.buffer)
    dv.setUint32(0, 0x04034b50, true)
    head[4] = info.extractVersion
    head[5] = info.reserved
    dv.setUint16(6, flags, true)
    dv.setUint16(8, info.compressType, true)
    dv.setUint16(10, info.dosTime, true)
    dv.setUint16(12, info.dosDate, true)
    // a streamed member's CRC and sizes come after its data
    dv.setUint32(14, stream ? 0 : w.crc, true)
    dv.setUint32(18, stream ? 0 : w.csize, true)
    dv.setUint32(22, stream ? 0 : w.usize, true)
    dv.setUint16(26, name.length, true)
    dv.setUint16(28, info.extra.length, true)
    head.set(name, 30)
    head.set(info.extra, 30 + name.length)
    this.push(head)
    this.push(body)
    if (stream) {
      const desc = new Uint8Array(16)
      const dd = new DataView(desc.buffer)
      dd.setUint32(0, 0x08074b50, true)
      dd.setUint32(4, w.crc, true)
      dd.setUint32(8, w.csize, true)
      dd.setUint32(12, w.usize, true)
      this.push(desc)
    }
    this.written.push(w)
  }

  /** ZipFile.close(): the central directory and the end record; the archive's bytes. */
  finish(): Uint8Array {
    const start = this.size
    for (const w of this.written) {
      const { info } = w
      const rec = new Uint8Array(46 + w.name.length + info.extra.length + info.comment.length)
      const dv = new DataView(rec.buffer)
      dv.setUint32(0, 0x02014b50, true)
      rec[4] = info.createVersion
      rec[5] = info.createSystem
      rec[6] = info.extractVersion
      rec[7] = info.reserved
      dv.setUint16(8, w.flags, true)
      dv.setUint16(10, info.compressType, true)
      dv.setUint16(12, info.dosTime, true)
      dv.setUint16(14, info.dosDate, true)
      dv.setUint32(16, w.crc, true)
      dv.setUint32(20, w.csize, true)
      dv.setUint32(24, w.usize, true)
      dv.setUint16(28, w.name.length, true)
      dv.setUint16(30, info.extra.length, true)
      dv.setUint16(32, info.comment.length, true)
      dv.setUint16(34, 0, true)
      dv.setUint16(36, info.internalAttr, true)
      dv.setUint32(38, w.attr >>> 0, true)
      dv.setUint32(42, w.offset, true)
      rec.set(w.name, 46)
      rec.set(info.extra, 46 + w.name.length)
      rec.set(info.comment, 46 + w.name.length + info.extra.length)
      this.push(rec)
    }
    const end = new Uint8Array(22)
    const dv = new DataView(end.buffer)
    dv.setUint32(0, 0x06054b50, true)
    dv.setUint16(8, this.written.length, true)
    dv.setUint16(10, this.written.length, true)
    dv.setUint32(12, this.size - start, true)
    dv.setUint32(16, start, true)
    this.push(end)
    const out = new Uint8Array(this.size)
    let p = 0
    for (const c of this.chunks) {
      out.set(c, p)
      p += c.length
    }
    return out
  }
}
