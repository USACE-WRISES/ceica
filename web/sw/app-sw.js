// The CEICA web app's offline copy and its updates (src/app/offline.ts registers it; its scope is the
// app's folder, beside the download worker's download/). Adapted from STAF's static app (sw/app-sw.js).
//
// The build (appWorker.ts) writes this file into dist as app-sw.js with the build's id and its files,
// so every changed build is a new worker. The browser looks for one each time the app opens online, and
// the page asks again every hour (always past the HTTP cache). A new build takes over as soon as its
// copy is in (the owner, 2026-10-19): a page with no project open reloads into it at once, and a page
// with one keeps running and offers Reload (src/app/offline.ts). Such a page still reads its own files
// from the build before, kept until the next build takes over. The page and every file of the app come
// from the running build's copy, so the app opens without the network.
//
// Every name here starts with "ceica-": the site's origin (usace-wrises.github.io) is shared with STAF's
// app, whose caches this worker never reads or deletes.
'use strict'

const BUILD = '__CEICA_BUILD__'
/** each file of the build: [path, sha256] */
const FILES = __CEICA_FILES__
const PREFIX = 'ceica-app-'
const CACHE = `${PREFIX}${BUILD}`
/** the running build's copy and the one before it (kept for the pages still running it) */
const META = 'ceica-meta-1'

const here = (path) => new URL(path, self.registration.scope).href

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A file of the build, its bytes checked. A file whose name carries no hash is asked for by its content
 * (?v=, as the page asks for it), so the browser's HTTP cache never answers with the build before's.
 * GitHub Pages' CDN ignores the query, so for up to 10 minutes after a release it may still send the old
 * file: an answer that is not this build's file is asked for once more past the HTTP cache, then the
 * install fails and the running build stays (the next check tries again). */
async function fetchChecked(path, hash) {
  const url = path.startsWith('assets/') ? here(path) : `${here(path)}?v=${hash.slice(0, 10)}`
  for (const cache of ['default', 'reload']) {
    const res = await fetch(new Request(url, { cache }))
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    const body = await res.arrayBuffer()
    if (await sha256(body) === hash) return new Response(body, { status: 200, headers: res.headers })
  }
  throw new Error(`${path}: not this build's file`)
}

self.addEventListener('install', (event) => {
  // every file of the build, then the build takes over without waiting for every CEICA window to close
  event.waitUntil((async () => {
    const got = await Promise.all(FILES.map(([path, hash]) => fetchChecked(path, hash).then((res) => [path, res])))
    const cache = await caches.open(CACHE)
    for (const [path, res] of got) await cache.put(here(path), res)
    await self.skipWaiting()
  })())
})

/** The cache a record names, or null. */
async function record(meta, key) {
  const kept = await meta.match(key)
  return kept ? kept.text() : null
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // the copy of the build being replaced stays for the pages still running it; any older one goes
    const meta = await caches.open(META)
    const running = await record(meta, 'running')
    const previous = running !== null && running !== CACHE ? running : await record(meta, 'previous')
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE && name !== previous) await caches.delete(name)
    }
    await meta.put('running', new Response(CACHE))
    if (previous !== null) await meta.put('previous', new Response(previous))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const scope = self.registration.scope
  if (!req.url.startsWith(scope) || req.url.startsWith(here('download/'))) return
  if (req.mode === 'navigate') {
    // the app's page (any query); any other page of the folder is the site's
    const path = new URL(req.url).pathname
    if (path === new URL(scope).pathname || path === new URL(here('index.html')).pathname) event.respondWith(page(req))
    return
  }
  event.respondWith(own(req))
})

// The copies are matched past their Vary header: a server may say Vary: Origin (vite preview does), and a
// module script's request carries an Origin header the copy's request had not, while the app's files are
// the same for every request.

/** The app's page: the running build's, else the site's. */
async function page(req) {
  return (await caches.match(here('index.html'), { cacheName: CACHE, ignoreVary: true })) || fetch(req)
}

/** A file of the app: the running build's copy (its ?v= aside: a build holds one version of each), else
 * the copy of the build before (a page still running it asks for its own files), else the site's. */
async function own(req) {
  const opts = { ignoreSearch: true, ignoreVary: true }
  const mine = await caches.match(req, { ...opts, cacheName: CACHE })
  if (mine) return mine
  const previous = await record(await caches.open(META), 'previous')
  if (previous !== null && previous !== CACHE) {
    const before = await caches.match(req, { ...opts, cacheName: previous })
    if (before) return before
  }
  return fetch(req)
}
