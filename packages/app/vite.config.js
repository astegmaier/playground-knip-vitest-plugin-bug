import { defineConfig } from 'vite';

// This config has the same shape as vitest.config.js. It exists to demonstrate
// that knip's *vite* plugin (separate from its vitest plugin) has the same
// false-positive bug: bare-string package names in `resolve.dedupe` and
// `optimizeDeps.include` are invisible to knip.
export default defineConfig({
  resolve: {
    dedupe: ['jotai']
  },
  optimizeDeps: {
    include: ['jotai']
  }
});
