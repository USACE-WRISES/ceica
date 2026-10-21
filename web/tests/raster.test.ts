// The PNG figures against matplotlib (raster/<project>.json, make_raster_fixtures.py): every figure's
// draw calls in paint order, coordinates within 0.01 px, and the canvas size and pixels per meter at
// the downloads' 300 dpi and the Word document's 130 dpi. The PNG chunks are checked on a made-up file.
import { deflateSync } from 'node:zlib'
import { describe as group, expect, it } from 'vitest'
import { analyze } from '../src/engine/analysis'
import { pngInfo, rasterOps, withDpi, type RasterOp } from '../src/engine/figures/raster'
import { loads } from '../src/engine/projectfile'
import { catalog, type FigureData } from '../src/engine/report/exhibits'
import { crc32 } from '../src/files/zip'
import { projectGoldens } from './projects'

interface Golden { png: Record<string, [number, number, number]>, ops: Record<string, unknown>[] }
const goldens = import.meta.glob<Record<string, Golden>>('./fixtures/raster/*.json', { import: 'default', eager: true })

/** The op's fields, with coordinates (p, at, clip) within 0.01 px and other numbers within 1e-9. */
function sameOp(got: RasterOp, want: Record<string, unknown>, where: string): void {
  expect(Object.keys(got).sort(), where).toEqual(Object.keys(want).sort())
  const near = (a: unknown, b: unknown, tol: number, path: string): void => {
    if (typeof b === 'number') {
      expect(typeof a, path).toBe('number')
      expect(Math.abs((a as number) - b), `${path}: ${a} against ${b}`).toBeLessThanOrEqual(tol)
    } else if (Array.isArray(b)) {
      expect(Array.isArray(a) && a.length === b.length, `${path}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`).toBe(true)
      b.forEach((v, i) => near((a as unknown[])[i], v, tol, `${path}[${i}]`))
    } else expect(a, path).toEqual(b)
  }
  for (const [k, v] of Object.entries(want)) {
    near((got as unknown as Record<string, unknown>)[k], v, k === 'p' || k === 'at' || k === 'clip' ? 0.01 : 1e-9, `${where}.${k}`)
  }
}

const cases = projectGoldens().filter(({ name }) => goldens[`./fixtures/raster/${name}.json`])

group('the PNG figures', () => {
  it('cover two projects', () => expect(cases.map((c) => c.name)).toEqual(['staf-demo', 'utoy-creek']))
  for (const { name, input } of cases) {
    const golden = goldens[`./fixtures/raster/${name}.json`]
    it(`of ${name} are drawn as matplotlib draws them`, () => {
      const res = analyze(loads(input).project)
      const figures = catalog(res).filter((e) => e.kind === 'figure')
      expect(figures.map((e) => e.id)).toEqual(Object.keys(golden))
      for (const ex of figures) {
        const data = ex.build() as FigureData
        const want = golden[ex.id]
        for (const [dpi, [w, h, ppm]] of Object.entries(want.png)) {
          const r = rasterOps(data.panels, data.labels, Number(dpi))
          expect([...r.pixels, Math.trunc(Number(dpi) / 0.0254 + 0.5)], `${ex.id} at ${dpi} dpi`).toEqual([w, h, ppm])
        }
        const r = rasterOps(data.panels, data.labels, 300)
        expect(r.ops.length, `${ex.id}: ops`).toBe(want.ops.length)
        r.ops.forEach((op, i) => sameOp(op, want.ops[i], `${ex.id} op ${i}`))
      }
    })
  }
})

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(Buffer.from(type, 'latin1'), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

group('a PNG with a dpi', () => {
  it('keeps IHDR, IDAT and IEND, and gains pHYs as Pillow writes it', () => {
    const ihdr = new Uint8Array([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0])
    const idat = new Uint8Array(deflateSync(Buffer.alloc(2 * (1 + 3 * 4), 255)))
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const parts = [Uint8Array.from(sig), chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])), chunk('IDAT', idat),
      chunk('tEXt', Buffer.from('Software\0browser', 'latin1')), chunk('IEND', new Uint8Array(0))]
    const png = new Uint8Array(Buffer.concat(parts))
    const out = withDpi(png, 130)
    const phys = new Uint8Array([0, 0, 0x13, 0xfe, 0, 0, 0x13, 0xfe, 1])
    expect(Buffer.from(out)).toEqual(Buffer.concat([Uint8Array.from(sig), chunk('IHDR', ihdr), chunk('pHYs', phys), chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0))]))
    expect(pngInfo(out)).toEqual({ width: 3, height: 2, ppm: 5118 })
    expect(pngInfo(withDpi(png, 300)).ppm).toBe(11811)
  })
})
