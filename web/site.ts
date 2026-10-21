// The CEICA page as the website serves it: its stylesheets and scripts in the Shiny page's order,
// and the page's body (src/app/ui.ts, app.py's app_ui), written into index.html. Adapted from
// STAF's static app (site.ts).
//
// Everything the page serves as is lives in page/ (Vite's public folder: served at the app's root
// in development, copied into the build as is): CEICA's stylesheet, script, fonts and icons (copies
// of www/), the framework's stylesheets and fonts (py-shiny's), page/boot.js and the download
// worker. The copies were made while the Python app was here; web/README.md (Copies) says where each
// came from.
// Each file the page asks for carries a ?v= content hash, as the Shiny app's assets carry ?v=.
//
// The stylesheets are written into the page, in the Shiny page's order: under the USACE network's
// browser isolation (DISA CBII, Menlo Security) a linked stylesheet did not apply in STAF's app
// (2026-10-12). Their url()s are made relative to the page, and Bootstrap's import of font.css is
// replaced by font.css itself. The build then leaves those files out (appWorker.ts, INLINED).
//
// The Shiny page loads jQuery, Bootstrap's bundle, shiny.js and bslib's components before its own
// files; here src/app (a module) stands in for them, and page/boot.js stands in for the two globals
// www/ceica.js expects, just before it (boot.js says why the jQuery stand-in then leaves).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { pageBody } from './src/app/ui.ts'
import { APP_NAME } from './src/engine/version.ts'
import { tag } from './src/shiny/htm.ts'

/** The page's own files (Vite's public folder). */
export const PAGE = fileURLToPath(new URL('./page', import.meta.url))

/** The first 10 hex digits of a page file's sha256: its ?v= */
export function contentHash(path: string): string {
  return createHash('sha256').update(readFileSync(resolve(PAGE, path))).digest('hex').slice(0, 10)
}

function url(path: string): string {
  return `${path}?v=${contentHash(path)}`
}

/** The stylesheets written into the page, in its order (shiny/font.css comes in with Bootstrap). */
export const STYLES = ['shiny/bootstrap.min.css', 'ceica.css', 'shiny/fill.css'] as const
/** Every stylesheet now in the page, which the build leaves out */
export const INLINED: readonly string[] = [...STYLES, 'shiny/font.css']

/** A CSS url(), quoted either way or bare */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/g
/** What filters on managed networks treat as attacks (none of the sheets has any today) */
const IE_HOOKS = /behavior\s*:\s*url|expression\s*\(|progid\s*:/i

/** A sheet's relative url()s made relative to the page: the sheet's folder in front, and the file's
 * ?v= where the page has the file (Bootstrap 3's glyphicon files, which it never had, keep their
 * paths). data: and absolute addresses and fragment references are left as they are. */
export function rebase(css: string, folder: string): string {
  return css.replace(CSS_URL, (all: string, dq?: string, sq?: string, bare?: string) => {
    const ref = dq ?? sq ?? bare ?? ''
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return all
    const cut = ref.search(/[?#]/)
    const path = posix.normalize(folder + (cut < 0 ? ref : ref.slice(0, cut)))
    const rest = cut < 0 ? '' : ref.slice(cut)
    const target = !rest && existsSync(resolve(PAGE, path)) ? url(path) : path + rest
    return `url("${target}")`
  })
}

/** A stylesheet as a style element (font.css written in where Bootstrap imports it). */
export function inlineSheet(path: string): string {
  let css = readFileSync(resolve(PAGE, path), 'utf-8')
  if (path === 'shiny/bootstrap.min.css') {
    const parts = css.split('@import url("font.css");')
    if (parts.length !== 2) throw new Error('Bootstrap should import font.css once')
    css = parts.join(readFileSync(resolve(PAGE, 'shiny/font.css'), 'utf-8'))
  }
  if (/<\/style/i.test(css)) throw new Error(`${path} would end its style element`)
  if (IE_HOOKS.test(css)) throw new Error(`${path} holds an IE hook`)
  const folder = posix.dirname(path) === '.' ? '' : `${posix.dirname(path)}/`
  return `<style data-ceica-src="${path}">${rebase(css, folder)}</style>`
}

/** The head after its charset, in the Shiny page's order (its framework scripts left out; the page's
 * title is in the body, as Shiny serves it: see body()). */
export function head(): string[] {
  return [
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    inlineSheet('shiny/bootstrap.min.css'),
    '<style>html { height: 100%; }</style>',
    inlineSheet('ceica.css'),
    `<script src="${url('boot.js')}"></script>`,
    `<script src="${url('ceica.js')}"></script>`,
    '<script>delete window.jQuery;</script>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<link rel="icon" href="favicon.ico" sizes="any"/>',
    '<link rel="icon" href="ceica-icon.svg" type="image/svg+xml"/>',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png"/>',
    // installing (Phase 4): the web app manifest and the title bar's color (the header's)
    `<link rel="manifest" href="${url('manifest.webmanifest')}"/>`,
    '<meta name="theme-color" content="#243a61"/>',
    // search engines leave the site out (the owner's decision, 2026-10-20)
    '<meta name="robots" content="noindex"/>',
    inlineSheet('shiny/fill.css'),
  ]
}

/** The tabset id: py-shiny draws a random one for each page; here it is drawn from the page itself,
 * so the same sources build the same page (and an unchanged build is no update). */
export function tabsetId(): string {
  const digest = createHash('sha256').update(body('0')).digest()
  return String(100000 + (digest.readUInt32BE(0) % 900000))
}

export function ceicaSite(): Plugin {
  return {
    name: 'ceica-site',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('index.html')) return html
        const tabset = tabsetId()
        // (Shiny's page ends at </html>: a line break after it would be one more text node in the body)
        return html
          .replace('<!--ceica:head-->', head().join('\n    '))
          .replace('<!--ceica:body-->', body(tabset))
          .replace(/\s+$/, '')
      },
    },
  }
}

/** The page's body as py-shiny serves it: ui.page_fillable gives a whole document (its title in a
 * head, then the body), which the server puts inside the page's <body>. The browser keeps the title
 * there and moves the inner body's class and style onto the page's body, so the page has the Shiny
 * page's elements and whitespace (a Shiny quirk, copied; to fix after cutover). */
export function body(tabset: string): string {
  const doc = tag('html', tag('head', tag('title', APP_NAME)), pageBody(tabset))
  return `<body>\n${doc.render(2)}\n  </body>`
}
