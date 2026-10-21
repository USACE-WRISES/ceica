// The files' foundations against Python (parity/make_base_fixtures.py): zipfile's archives in both
// forms, zlib's deflate, csv's writer and reader, CPython's set order, lxml's escaping and describe().
import { describe as group, expect, it } from 'vitest'
import { csvText } from '../src/files/csv'
import { CsvError, csvRows } from '../src/files/csvreader'
import { describe as describeFile } from '../src/files/describe'
import { tupleSetOrder } from '../src/files/pyset'
import { escAttr, escText } from '../src/files/xml'
import { deflate, newInfo, readZip, ZipWriter } from '../src/files/zip'
import { fromBase64, sha256Hex } from '../src/py/bytes'
import ref from './fixtures/files_base_ref.json'

/** The bytes parity/make_base_fixtures.py makes the same way: an LCG's draws as noise, text or XML. */
function lcgBytes(seed: number, n: number, kind: string): Uint8Array {
  const alphabet = new TextEncoder().encode('abcdefghij <>/="0123456789\n')
  let x = seed
  if (kind === 'xml') {
    const parts: string[] = []
    let length = 0
    for (let i = 1; length < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
      const row = `<row r="${i}"><c r="A${i}" t="n"><v>${x % 100000}</v></c></row>`
      parts.push(row)
      length += row.length
    }
    return new TextEncoder().encode(parts.join('')).slice(0, n)
  }
  const out = new Uint8Array(n)
  for (let k = 0; k < n; k++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff
    out[k] = kind === 'noise' ? (x >> 16) & 0xff : alphabet[(x >> 16) % alphabet.length]
  }
  return out
}

group('zip archives as zipfile writes them', () => {
  for (const c of ref.zips) {
    it(c.name, () => {
      const w = new ZipWriter({ seekable: c.seekable })
      for (const m of c.members) {
        const [year, month, day, hour, minute, second] = m.time
        w.writestr(newInfo(m.name, { year, month, day, hour, minute, second }, m.method, m.attr), m.text)
      }
      const python = fromBase64(c.bytes)
      expect(w.finish()).toEqual(python)
      const z = readZip(python)
      expect(z.names()).toEqual(c.members.map((m) => m.name))
      for (const m of c.members) expect(new TextDecoder().decode(z.read(m.name))).toBe(m.text)
    })
  }

  it('refuses what is not a zip, in zipfile words', () => {
    expect(() => readZip(new TextEncoder().encode('not a zip'))).toThrow('File is not a zip file')
    const z = readZip(fromBase64(ref.zips[0].bytes))
    expect(() => z.read('missing.xml')).toThrow(`"There is no item named 'missing.xml' in the archive"`)
  })
})

group('deflate equals zlib 1.3.1 at level 6', () => {
  for (const c of ref.deflate) {
    it(`${c.kind}, ${c.size} bytes`, () => {
      const input = lcgBytes(c.seed, c.size, c.kind)
      expect(sha256Hex(input)).toBe(c.input)
      const out = deflate(input)
      expect(out.length).toBe(c.length)
      expect(sha256Hex(out)).toBe(c.output)
    })
  }
})

group('csv as Python writes and reads it', () => {
  it('writer', () => {
    for (const c of ref.csvWrite) expect(csvText(c.rows)).toBe(c.text)
  })
  for (const c of ref.csvRead) {
    it(`reader: ${JSON.stringify(c.text.slice(0, 24))}`, () => {
      if ('error' in c) {
        expect(() => csvRows(c.text)).toThrow(CsvError)
        expect(() => csvRows(c.text)).toThrow(c.error as string)
      } else expect(csvRows(c.text)).toEqual(c.rows)
    })
  }
})

it('sets of tuples iterate in CPython order', () => {
  for (const c of ref.sets) expect(tupleSetOrder(c.adds)).toEqual(c.order)
})

it('XML escapes as lxml writes them', () => {
  for (const c of ref.xml) {
    expect(escText(c.text, true)).toBe(c.textAscii)
    expect(escText(c.text)).toBe(c.textUtf8)
    expect(escAttr(c.text, true)).toBe(c.attrAscii)
    expect(escAttr(c.text)).toBe(c.attrUtf8)
  }
})

it('describe() as describe.py gives it', () => {
  for (const c of ref.describe) expect(describeFile(fromBase64(c.bytes))).toEqual(c.description)
})
