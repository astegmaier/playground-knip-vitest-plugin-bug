import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {},
  resolve: {
    // Force a single instance of `react-is` across all transitive consumers.
    // (Common pattern: many libraries in the React ecosystem — styled-components,
    // recharts, react-hook-form internals, etc. — drag in their own copies. Without
    // dedupe you can ship multiple `react-is` versions, which breaks `isElement`-style
    // identity checks.)
    dedupe: ['react-is']
  },
  optimizeDeps: {
    // Pre-bundle `react-is` so its CJS build is converted to ESM upfront and dev-mode
    // doesn't hit interop issues mid-graph.
    include: ['react-is']
  }
});
