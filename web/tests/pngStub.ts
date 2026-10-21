// A stand-in for the browser's canvas in the tests (Node has none): a white PNG of the figure's pixel
// size and dpi, its first pixel a digest of the draw calls, so different figures never share bytes
// (python-docx and the zips share equal pictures) and equal ones always do.
import { deflateSync } from 'node:zlib'
import { withDpi, type PngMaker } from '../src/engine/figures/raster'
import { crc32 } from '../src/files/zip'

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** FNV-1a of the ops, as four bytes */
function digest(text: string): number[] {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return [h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]
}

export const stubPng: PngMaker = async (r) => {
  const [w, h] = r.pixels
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc(h * (1 + 4 * w), 255)
  for (let y = 0; y < h; y++) raw[y * (1 + 4 * w)] = 0
  raw.set(digest(JSON.stringify(r.ops)), 1)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
  return withDpi(new Uint8Array(png), r.dpi)
}
