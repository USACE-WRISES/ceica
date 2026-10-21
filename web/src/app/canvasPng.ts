// The PNG figures drawn by the browser: the files worker's offscreen canvas (or the page's, where it
// runs the job itself), painted as Agg paints (engine/figures/raster.ts), its PNG given the figure's dpi.
import { paint, withDpi, type PngMaker } from '../engine/figures/raster'

export const canvasPng: PngMaker = async (r) => {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('This browser cannot draw PNG files.')
  const canvas = new OffscreenCanvas(r.pixels[0], r.pixels[1])
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw PNG files.')
  paint(ctx, r)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return withDpi(new Uint8Array(await blob.arrayBuffer()), r.dpi)
}
