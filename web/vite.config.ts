/// <reference types="vitest/config" />
// The static CEICA app's build, dev server and tests.
//
// GitHub Pages serves the built app at https://usace-wrises.github.io/ceica/ (the owner's decision D2,
// notes/2026-10-18_Static_Web_App). The page (index.html) gets its stylesheets, scripts and body from
// site.ts; page/ is the public folder, the files the page serves as is.
//
// What's new on the start page reads the repo's CHANGELOG.md (src/views/shell.ts imports it), so the
// dev server may read the repo root. The tests see the release identity the goldens were made with
// instead of the real one (tests/identity.ts).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { ceicaAppWorker } from './appWorker.ts'
import { ceicaSite, PAGE } from './site.ts'
import { frozenIdentity } from './tests/identity.ts'

/** The path the built app is served under. */
export const SITE_PATH = '/ceica/'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** A second build for the offline checks (tools/offline.ts, CEICA_TEST_BUILD=b): every hashed name
 * differs, as a new release's would, so a page left open must read its own files from its build. */
const TEST_BUILD = process.env.CEICA_TEST_BUILD ? `-${process.env.CEICA_TEST_BUILD}` : ''

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? SITE_PATH : '/',
  publicDir: PAGE,
  // the offline worker is written after the build (appWorker.ts); the tests' pinned identity
  plugins: [ceicaSite(), ceicaAppWorker(), ...(process.env.VITEST ? [frozenIdentity()] : [])],
  server: { port: 5190, strictPort: true, fs: { allow: [REPO] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]${TEST_BUILD}-[hash].js`,
        chunkFileNames: `assets/chunk${TEST_BUILD}-[hash].js`,
        assetFileNames: `assets/asset${TEST_BUILD}-[hash][extname]`,
      },
    },
  },
  // the files worker's bundle (src/app/fileMaker.ts), named as the page's
  worker: { rollupOptions: { output: { entryFileNames: `assets/[name]${TEST_BUILD}-[hash].js` } } },
  test: {
    // the engine timings (bench/) run on their own: npm run bench
    include: ['tests/**/*.test.ts'],
    // the golden files are large, and the property tests run hundreds of cases
    testTimeout: 120_000,
  },
}))
