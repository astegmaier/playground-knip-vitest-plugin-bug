# knip vitest plugin: false-positive on `resolve.dedupe` / `optimizeDeps.include`

A pnpm-workspace reproduction of a knip false-positive: a dependency referenced **only** in `vitest.config.js` (or `vite.config.js`) inside `resolve.dedupe` (or `optimizeDeps.include`) is flagged as unused — but removing it from `package.json` would silently break the build at runtime.

This repro demonstrates that the dependency in question (`jotai`) is **not** removable: with the `dedupe` line in place a vitest test passes and a non-test `vite-node` run prints `counter = 1`; without it both produce the wrong result and jotai itself logs `Detected multiple Jotai instances`.

The repro covers both knip plugins: knip's *vitest* plugin reads `vitest.config.js` and knip's *vite* plugin reads `vite.config.js`. Both share `resolveConfig` and both have the same false positive; the repro ships both config files so a fix has to handle both code paths.

## TL;DR

knip's vite/vitest plugin reads `cfg.resolve.alias` and `cfg.resolve.extensions` but **does not** read `cfg.resolve.dedupe` or `cfg.optimizeDeps.include`. Bare-string package names in those two arrays are invisible to knip's dependency analysis.

Source: `packages/knip/src/plugins/vitest/index.ts` `resolveConfig` only iterates `cfg.test.*`, `cfg.resolve.alias`, `cfg.resolve.extensions`, and `cfg.build.lib.entry`. Neither `dedupe` nor `optimizeDeps` appears anywhere in `packages/knip/src/plugins/vite/` or `packages/knip/src/plugins/vitest/`.

## Layout

```
.
├── pnpm-workspace.yaml
├── package.json                       (root)
└── packages/
    ├── app/
    │   ├── package.json               (declares jotai 2.11.0 — knip flags this as unused)
    │   ├── vite.config.js             (resolve.dedupe + optimizeDeps.include both reference 'jotai')
    │   ├── vitest.config.js           (same shape — exercises knip's vitest plugin too)
    │   └── src/
    │       ├── main.js                (non-test entry — runnable via vite-node)
    │       └── counter.test.js        (imports lib-writer + lib-reader; never imports jotai)
    ├── lib-writer/
    │   ├── package.json               (depends on jotai 2.10.0)
    │   └── index.js                   (exports `counterAtom`, `bumpCounter`)
    └── lib-reader/
        ├── package.json               (depends on jotai 2.11.0 — different minor)
        └── index.js                   (exports `readCounter`)
```

`lib-writer` and `lib-reader` pin different minor versions of `jotai` on purpose — under pnpm's strict isolation, that means two physically separate copies of `jotai` end up in `node_modules/.pnpm/`. Each library, when bundled by vite without dedupe, brings its own copy.

## Reproduce

```sh
pnpm install
```

### Step 1: with dedupe — test passes

```sh
pnpm --filter app test
```

Expected: `1 passed`. Both libraries resolve `jotai` from `packages/app/node_modules/jotai` (because `resolve.dedupe: ['jotai']` forces vite's resolver to start at `config.root`), so a single `jotai` module instance is loaded and `getDefaultStore()` returns the same store on both sides.

### Step 2: comment out the dedupe — test fails

In `packages/app/vitest.config.js`, comment out the `dedupe` line:

```js
resolve: {
  // dedupe: ['jotai']
}
```

Re-run:

```sh
pnpm --filter app test
```

Expected:

```
Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044

 ❯ src/counter.test.js (1 test | 1 failed)
     → expected +0 to be 1 // Object.is equality
```

(jotai itself detects the duplicate and warns — independent confirmation that there really are two module instances.)

This proves the `dedupe` entry — and therefore the `jotai` declaration in `packages/app/package.json` — is load-bearing. Restore the line before the next step.

### Step 3 (optional): same failure outside the test runner

The bug isn't a test-runner artifact — `vite.config.js` has the same problem. To prove it, run the same dedupe-dependent code through plain vite (via `vite-node`, which uses vite's transform pipeline against `vite.config.js`):

```sh
pnpm --filter app start
```

With the `dedupe` line restored, this prints `counter = 1`. Comment the `dedupe` line out in `vite.config.js` (note: this is the **vite**, not vitest, config) and re-run — same `Detected multiple Jotai instances` warning, output becomes `counter = 0`. Restore the line afterwards.

This step exists to demonstrate that the false-positive bug applies to knip's vite plugin reading `vite.config.js` just as much as to its vitest plugin reading `vitest.config.js` — both plugins share `resolveConfig` and both miss the same fields.

### Step 4: run knip — `jotai` is incorrectly flagged

```sh
pnpm --filter app knip
```

Output:

```
Unused dependencies (1)
jotai  package.json:10:6
```

This is wrong: step 2 just demonstrated that removing `jotai` from `packages/app/package.json` would break the build under pnpm strict isolation. The dependency is in `package.json` precisely so vite's resolver can find it at `packages/app/node_modules/jotai` when applying `resolve.dedupe`.

The same false-positive applies to `optimizeDeps.include`. The repro lists `jotai` in **both** `resolve.dedupe` and `optimizeDeps.include` so a knip fix needs to detect both fields. (The dedupe entry is the one that's load-bearing for the failing test — `optimizeDeps.include` is included alongside it because it has the same false-positive shape and a complete fix should cover it too.)

## Why `jotai` has to be in `packages/app/package.json` even though no app source imports it

Vite's `tryNodeResolve` (`packages/vite/src/node/plugins/resolve.ts`) sets `basedir = config.root` whenever a name appears in `resolve.dedupe`, then walks `<dir>/node_modules/<name>` upward from there. Under pnpm's default strict isolation (<https://pnpm.io/symlinked-node-modules-structure>), transitive dependencies are not hoisted to the workspace root's `node_modules`. So if `jotai` isn't a direct dependency of `packages/app`, the upward walk finds nothing — `dedupe` silently becomes a no-op and you ship two copies anyway. Adding `jotai` to `packages/app/package.json` is what makes the dedupe contract enforceable.

The same reasoning applies to `optimizeDeps.include`: vite's optimizer also resolves include names from `config.root`, and if it can't find them, logs `Failed to resolve dependency: <name>` and silently skips pre-bundling.

## Workaround

knip's call-expression visitor (`packages/knip/src/typescript/visitors/calls.ts`) detects `require('foo')`, `require.resolve('foo')`, and `import.meta.resolve('foo')` calls anywhere in source. So one can satisfy knip by adding a no-op static reference:

```js
// vitest.config.js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Static reference so knip detects jotai. The vitest plugin doesn't read
// string literals from resolve.dedupe; require.resolve() is detected by
// knip's global call-expression visitor.
require.resolve('jotai');

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

(`optimizeDeps.exclude` is the inverse — vite explicitly tells the optimizer *not* to pre-bundle the package, so exclude entries probably shouldn't emit a dependency.)

## Versions used in this repro

- node: v24
- pnpm: 10.x
- knip: 6.11.0
- vite: 7.x
- vite-node: 3.x
- vitest: 3.2.4
- jotai: 2.10.0 (lib-writer) + 2.11.0 (lib-reader, app)
