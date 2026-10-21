/// <reference types="vitest/config" />
// The engine timings (bench/timings.test.ts), kept out of the test run: npm run bench.
import { defineConfig } from 'vite'

export default defineConfig({
  root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  test: {
    include: ['bench/**/*.test.ts'],
    testTimeout: 600_000,
  },
})
