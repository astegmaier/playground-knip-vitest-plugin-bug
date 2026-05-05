# knip vitest plugin: false-positive on `resolve.dedupe` / `optimizeDeps.include`

Minimal reproduction of a knip false positive: a dependency referenced **only** in `vitest.config.js` (or `vite.config.js`) inside `resolve.dedupe` or `optimizeDeps.include` is incorrectly reported as an unused dependency, even though removing it from `package.json` would silently break the build.

## TL;DR

knip's vite/vitest plugin reads `cfg.resolve.alias` and `cfg.resolve.extensions` but **does not** read `cfg.resolve.dedupe` or `cfg.optimizeDeps.include`. Bare-string package names in those two arrays are invisible to knip's dependency analysis.

Source: `packages/knip/src/plugins/vitest/index.ts` `resolveConfig` only iterates `cfg.test.*`, `cfg.resolve.alias`, `cfg.resolve.extensions`, and `cfg.build.lib.entry`. Neither `dedupe` nor `optimizeDeps` appears anywhere in `packages/knip/src/plugins/vite/` or `packages/knip/src/plugins/vitest/`.

## The repro

```
.
├── package.json          # lists react-is as a direct dep
├── vitest.config.js      # references react-is in resolve.dedupe + optimizeDeps.include
└── src/
    └── example.test.js   # one trivial test; does NOT import react-is
```

`react-is` is **not** imported by any source file. It only appears as a bare string in two arrays in `vitest.config.js`.

## Reproduce

```sh
pnpm install
pnpm knip
```

### Actual output

```
Unused dependencies (1)
react-is  package.json:11:6
```

### Expected

No issues. `react-is` is a legitimate, intentional dependency: see "Why the dep is in package.json" below.

## Why the dep is in `package.json` (and why this matters)

Removing `react-is` from `package.json` would *appear* to silence the knip warning, but it would silently break the very thing the vitest config is trying to do. Here's why this is a real-world pattern, not a contrived one:

1. **`resolve.dedupe: ['react-is']`** forces vite to resolve `react-is` from the project root for every importer in the graph. Vite's resolver (see `tryNodeResolve` in vite's `plugins/resolve.ts`) sets `basedir = config.root` when a name appears in `dedupe`, then walks `<dir>/node_modules/<name>` upward. If `react-is` isn't a *direct* dep of this package, that walk fails under any package manager that doesn't hoist transitive deps (notably **pnpm with default strict isolation** — see <https://pnpm.io/symlinked-node-modules-structure>). The dedupe contract silently breaks: you ship multiple copies of `react-is`, and identity checks like `isElement` start failing across module boundaries.

2. **`optimizeDeps.include: ['react-is']`** asks vite to pre-bundle `react-is` upfront so its CJS build is converted to ESM and dev-mode doesn't hit interop issues mid-graph. Vite resolves the include name from `config.root`. Same story: if it's not a direct dep, pnpm doesn't put it in `node_modules/react-is`, so vite logs `Failed to resolve dependency: react-is, present in optimizeDeps.include` and the include silently becomes a no-op.

3. **Version pinning.** Even with hoisting (yarn-classic / npm), the version of `react-is` that gets hoisted is whatever yarn picks from the transitive graph. If you want `react-is@19` to match React 19, you have to declare it directly. Otherwise an older transitive copy (e.g. `react-is@16` requested by some legacy dep) can win the hoist.

4. **Real-world precedent.** This is a well-trodden pattern for any monorepo that bundles a React app with libraries that internally call `react-is` (styled-components, recharts, react-redux's older releases, `prop-types`, `@testing-library/react`, mantine, MUI's older releases, etc.). The same situation occurs for `@emotion/react`, `vue`, `lit`, and other libraries that misbehave when multiple copies coexist.

So: keeping `react-is` in `package.json` is *correct*. The knip warning is the false positive.

## Workaround

knip's call-expression visitor does detect `require('foo')`, `require.resolve('foo')`, and `import.meta.resolve('foo')` calls anywhere in the source (see `packages/knip/src/typescript/visitors/calls.ts`). So one can satisfy knip by adding a no-op static reference to `vitest.config.js`:

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Static reference so knip detects react-is as a dependency.
// The vitest plugin doesn't read string literals from resolve.dedupe or
// optimizeDeps.include; require.resolve() is detected by knip's global
// call-expression visitor.
require.resolve('react-is');

export default defineConfig({ /* ... */ });
```

This works but is a workaround. The right fix is in knip's plugin.

## Suggested fix

Extend `resolveConfig` in `packages/knip/src/plugins/vitest/index.ts` (which the vite plugin re-uses) to emit dependencies for `cfg.resolve.dedupe` and `cfg.optimizeDeps.include`. Roughly:

```ts
for (const id of cfg.resolve?.dedupe ?? []) {
  inputs.add(toDependency(id));
}
for (const id of cfg.optimizeDeps?.include ?? []) {
  // strip nested 'foo > bar' optimizer-only syntax
  const pkgName = getNpmPackageName(id.split('>')[0].trim());
  if (pkgName) inputs.add(toDependency(pkgName));
}
```

(`optimizeDeps.exclude` is the inverse — vite explicitly tells the optimizer *not* to pre-bundle it — and probably should not emit a dependency, since exclude entries don't imply the package is depended on.)

## Versions

- node: v24
- pnpm: 10.x
- knip: ^6.10.0 (resolved to 6.11.0 at time of repro)
- vitest: ^3.0.0 (resolved to 3.2.4 at time of repro)
- react-is: ^19.0.0 (resolved to 19.2.5 at time of repro)
