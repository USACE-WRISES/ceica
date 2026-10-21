// The page's head (site.ts): the stylesheets written into it in the Shiny page's order, their url()s
// made relative to the page with each file's ?v=, the install links (manifest, theme color), and a
// tabset id that is the same for the same sources. Then the manifest and its icons.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe as group, expect, it } from 'vitest'
import { contentHash, head, INLINED, inlineSheet, PAGE, rebase, STYLES, tabsetId } from '../site'

const read = (path: string): string => readFileSync(resolve(PAGE, path), 'utf-8')
/** every url() token, as a blank, so two sheets compare apart from their addresses */
const blankUrls = (css: string): string => css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^'")\s]+)\s*\)/g, 'url()')
const inner = (style: string): string => style.replace(/^<style data-ceica-src="[^"]+">/, '').replace(/<\/style>$/, '')

group('the page head', () => {
  const lines = head()

  it('links no stylesheet and keeps the Shiny page order', () => {
    expect(lines.filter((l) => /rel="stylesheet"/.test(l))).toEqual([])
    const at = (pattern: RegExp): number => lines.findIndex((l) => pattern.test(l))
    const order = [/^<meta name="viewport"/, /data-ceica-src="shiny\/bootstrap\.min\.css"/, /^<style>html \{ height: 100%; \}/,
      /data-ceica-src="ceica\.css"/, /src="boot\.js\?v=/, /src="ceica\.js\?v=/, /delete window\.jQuery/, /rel="icon" href="favicon\.ico"/,
      /rel="manifest" href="manifest\.webmanifest\?v=/, /name="theme-color" content="#243a61"/, /data-ceica-src="shiny\/fill\.css"/]
    const places = order.map(at)
    expect(places.every((p) => p >= 0), String(places)).toBe(true)
    expect([...places].sort((a, b) => a - b)).toEqual(places)
    expect(STYLES.every((s) => lines.some((l) => l.includes(`data-ceica-src="${s}"`)))).toBe(true)
    expect(INLINED).toContain('shiny/font.css')
  })

  it("writes font.css in where Bootstrap imports it, and each sheet's text as it is but its addresses", () => {
    const bootstrap = inner(inlineSheet('shiny/bootstrap.min.css'))
    expect(bootstrap).not.toContain('@import')
    expect(bootstrap.startsWith(read('shiny/font.css').slice(0, 40))).toBe(true)
    expect(blankUrls(bootstrap)).toBe(blankUrls(read('shiny/bootstrap.min.css').replace('@import url("font.css");', read('shiny/font.css'))))
    for (const path of ['ceica.css', 'shiny/fill.css']) expect(blankUrls(inner(inlineSheet(path)))).toBe(blankUrls(read(path)))
  })

  it('points every address at a file of the page with its ?v=, data: and fragments left alone', () => {
    const refs = lines.join('\n').match(/url\("[^"]*"\)/g) ?? []
    expect(refs.length).toBeGreaterThan(10)
    for (const ref of refs) {
      const target = ref.slice(5, -2)
      if (/^(data:|#)/.test(target)) continue
      const path = target.replace(/[?#].*$/, '')
      if (existsSync(resolve(PAGE, path))) expect(target, ref).toBe(`${path}?v=${contentHash(path)}`)
      // Bootstrap 3's glyphicons, which the page never had
      else expect(path, ref).toMatch(/^shiny\/fonts\/bootstrap\/glyphicons-halflings-regular\./)
    }
    expect(lines.join('\n')).toMatch(/url\(["']?#bslib---icon-gradient["']?\)/)
  })

  it('rebases addresses relative to the sheet', () => {
    expect(rebase('a{b:url(fonts/x.woff2)}', 'shiny/')).toBe('a{b:url("shiny/fonts/x.woff2")}')
    expect(rebase("a{b:url('../x.eot?#iefix')}", 'shiny/')).toBe('a{b:url("x.eot?#iefix")}')
    expect(rebase('a{b:url("data:image/svg+xml,%3csvg x=\'1\'%3e")}', 'shiny/')).toBe('a{b:url("data:image/svg+xml,%3csvg x=\'1\'%3e")}')
    expect(rebase('a{b:url(#g)} c{d:url(/x.png)}', 'shiny/')).toBe('a{b:url(#g)} c{d:url(/x.png)}')
    expect(rebase('a{b:url("fonts/SpaceGrotesk-latin.woff2")}', '')).toBe(`a{b:url("fonts/SpaceGrotesk-latin.woff2?v=${contentHash('fonts/SpaceGrotesk-latin.woff2')}")}`)
  })

  it('draws the same tabset id from the same sources', () => {
    expect(tabsetId()).toMatch(/^\d{6}$/)
    expect(tabsetId()).toBe(tabsetId())
  })
})

/** a PNG's pixel size */
function pngSize(path: string): string {
  const b = readFileSync(resolve(PAGE, path))
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
}

group('the manifest', () => {
  const m = JSON.parse(read('manifest.webmanifest')) as Record<string, any>
  it('installs the app as itself on the shared origin', () => {
    // resolved against the origin: STAF's "./" is the origin's root, so CEICA's names its folder
    expect(m.id).toBe('/ceica/')
    expect([m.name, m.short_name, m.start_url, m.scope, m.display]).toEqual(['CEICA', 'CEICA', './', './', 'standalone'])
    expect(m.theme_color).toBe('#243a61')
  })
  it('names icons the page has, at their sizes, a maskable one among them', () => {
    for (const icon of m.icons as { src: string, sizes: string }[]) {
      expect(existsSync(resolve(PAGE, icon.src)), icon.src).toBe(true)
      expect(pngSize(icon.src)).toBe(icon.sizes)
    }
    expect((m.icons as { purpose?: string }[]).filter((i) => i.purpose === 'maskable')).toHaveLength(1)
    expect((m.icons as { sizes: string }[]).map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  })
})
