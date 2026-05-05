import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {},
  resolve: {
    // Without this, lib-writer (jotai 2.10) and lib-reader (jotai 2.11) each
    // bring their own copy of jotai. Two module instances => two distinct
    // `getDefaultStore()` WeakMaps => the test below fails.
    // (Comment this entry out and re-run `pnpm --filter app test` to see it.)
    dedupe: ['jotai']
  },
  optimizeDeps: {
    // Pre-bundle jotai. Not strictly required for this repro to fail without
    // dedupe, but `optimizeDeps.include` has the same knip false-positive
    // problem as `resolve.dedupe`: bare-string package names here are
    // invisible to knip's vite/vitest plugin. Listed here so a knip fix has
    // to detect both fields, not just dedupe.
    include: ['jotai']
  }
});
