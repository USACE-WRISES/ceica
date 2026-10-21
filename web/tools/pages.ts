// A local stand-in for GitHub Pages, for tools/offline.ts: one build of the app under /ceica/, swapped
// at will (a release), stopped (the network gone), paced (a slow network), beside a stand-in for
// STAF's app at /staf/app/ (the origin is shared). It answers as Pages does: Cache-Control
// max-age=600, an ETag, each file's own type, and text gzipped for a browser that takes it. Ported
// from the Python tool's server (offline.py), which sent every file as it is: the bytes counted now
// are the bytes sent, compressed or not.
//
// Every answer closes its connection (the Python server spoke HTTP/1.0), so stopping the server
// really takes the network away: no kept-alive connection outlives it.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'

export const SITE = '/ceica/'

export const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** the types Pages gzips */
const TEXT = /^(text\/|application\/(json|manifest\+json)|image\/svg)/

const STAF_STUB = Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>STAF</title>'
  + "</head><body><p>A stand-in for STAF's app on the shared origin.</p></body></html>")

export class Site {
  readonly port: number
  root: string | null = null
  /** paths under /ceica/ answered 404 as if missing */
  missing = new Set<string>()
  /** seconds before each answer, bytes a second while sending (null: no pacing) */
  pace: [number, number] | null = null
  private server: Server | null = null
  private sent = 0

  constructor(port: number) {
    this.port = port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}${SITE}`
  }

  /** This build served from now on (the server started when it is not running). */
  async serve(root: string): Promise<void> {
    this.root = root
    if (this.server !== null) return
    const server = createServer((req, res) => {
      this.answer(req, res).catch(() => res.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => resolve())
    })
    this.server = server
  }

  /** The server stopped: no network. */
  async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }

  /** The bytes sent since the last call. */
  take(): number {
    const n = this.sent
    this.sent = 0
    return n
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(501, { 'Content-Length': '0', Connection: 'close' }).end()
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === SITE.replace(/\/$/, '')) {
      res.writeHead(301, { Location: SITE, 'Content-Length': '0', Connection: 'close' }).end()
      return
    }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    if (path === '/staf/app/' || path === '/staf/app/index.html') {
      await this.send(res, STAF_STUB, 'text/html; charset=utf-8', '"staf"', gzip)
      return
    }
    let rel = path.startsWith(SITE) ? path.slice(SITE.length) : null
    if (rel === '') rel = 'index.html'
    const file = rel !== null && this.root !== null ? normalize(join(this.root, rel)) : null
    const inside = file !== null && this.root !== null && file.startsWith(normalize(this.root) + sep)
    if (rel === null || this.missing.has(rel) || !inside || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Length': '0', Connection: 'close' }).end()
      return
    }
    const data = readFileSync(file)
    const etag = `"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'max-age=600', Connection: 'close' }).end()
      return
    }
    await this.send(res, data, TYPES[extname(file)] ?? 'application/octet-stream', etag, gzip)
  }

  private async send(res: ServerResponse, data: Buffer, kind: string, etag: string, gzip: boolean): Promise<void> {
    const pace = this.pace
    if (pace) await sleep(pace[0] * 1000)
    const zipped = gzip && TEXT.test(kind)
    const body = zipped ? gzipSync(data) : data
    res.writeHead(200, {
      'Content-Type': kind, 'Content-Length': String(body.length), 'Cache-Control': 'max-age=600',
      ETag: etag, Connection: 'close', ...(zipped ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    })
    const step = 16384
    for (let i = 0; i < body.length; i += step) {
      if (res.destroyed) return
      const chunk = body.subarray(i, i + step)
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          res.once('drain', resolve)
          res.once('close', resolve)
        })
      }
      if (pace) await sleep((chunk.length / pace[1]) * 1000)
    }
    res.end()
    this.sent += body.length
  }
}
