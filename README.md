# knip vite/vitest plugin: false-positive on `resolve.dedupe` / `optimizeDeps.include`

knip's vite and vitest plugins do not read bare-string package names from `resolve.dedupe` or `optimizeDeps.include` arrays. Any dependency referenced only via those fields is reported as unused, even though removing it from `package.json` would silently break the build under pnpm strict isolation.

The vite plugin re-exports the vitest plugin's `resolveConfig` (`packages/knip/src/plugins/vitest/index.ts`), so two changes there cover all four user-visible cases:

| # | Config file | Field |
|---|---|---|
| 1 | `vite.config.js` | `resolve.dedupe` |
| 2 | `vite.config.js` | `optimizeDeps.include` |
| 3 | `vitest.config.js` | `resolve.dedupe` |
| 4 | `vitest.config.js` | `optimizeDeps.include` |

This repro instantiates **all four cases simultaneously**: `jotai` appears in both `resolve.dedupe` and `optimizeDeps.include` in both `packages/app/vite.config.js` and `packages/app/vitest.config.js`.

The relevant gap upstream: `packages/knip/src/plugins/vitest/index.ts` `resolveConfig` only iterates `cfg.test.*`, `cfg.resolve.alias`, `cfg.resolve.extensions`, and `cfg.build.lib.entry`. Neither `dedupe` nor `optimizeDeps` appears anywhere in `packages/knip/src/plugins/vite/` or `packages/knip/src/plugins/vitest/`.

## Reproduce

```sh
pnpm install
pnpm --filter app knip
```

Expected output:

```
Unused dependencies (1)
jotai  package.json:11:6
```
  
That's the bug. `jotai` is correctly listed in `packages/app/package.json` — see [Why `jotai` really has to be a dependency](#why-jotai-really-has-to-be-a-dependency-of-packagesapp) at the bottom for the runtime proof.

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

(`optimizeDeps.exclude` is the inverse — vite explicitly tells the optimizer *not* to pre-bundle the package — so exclude entries probably shouldn't emit a dependency.)

## Workaround for users blocked on the upstream fix

knip's call-expression visitor (`packages/knip/src/typescript/visitors/calls.ts`) detects `require('foo')`, `require.resolve('foo')`, and `import.meta.resolve('foo')` calls anywhere in source. Adding a no-op static reference satisfies knip without changing runtime behavior:

```js
// vite.config.js or vitest.config.js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Static reference so knip's call-expression visitor detects jotai.
// The vite/vitest plugin's config parser doesn't read string literals from
// resolve.dedupe or optimizeDeps.include.
require.resolve('jotai');
```

---

# Why `jotai` really has to be a dependency of `packages/app`

The plain reading of knip's warning — "this dependency is unused, remove it from `package.json`" — is what makes this a *false* positive worth fixing rather than just a noisy warning. Removing `jotai` from `packages/app/package.json` would silently break the build. Both proofs below demonstrate this.

## Layout

```
.
├── pnpm-workspace.yaml
├── package.json                       (root)
└── packages/
    ├── app/
    │   ├── package.json               (declares jotai 2.11.0 — knip flags this as unused)
    │   ├── vite.config.js             (resolve.dedupe + optimizeDeps.include reference 'jotai')
    │   ├── vitest.config.js           (same shape — exercises the vitest plugin too)
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

`lib-writer` and `lib-reader` pin different minor versions of `jotai` on purpose — under pnpm's strict isolation each library gets its own physical copy in `node_modules/.pnpm/`. Without `resolve.dedupe`, vite resolves each `import 'jotai'` from the importing library's nearest `node_modules`, so the bundle ends up with two `jotai` module instances and two distinct `getDefaultStore()` WeakMaps.

## Why the dep declaration in `packages/app` matters

Vite's `tryNodeResolve` (`packages/vite/src/node/plugins/resolve.ts`) sets `basedir = config.root` whenever a name appears in `resolve.dedupe`, then walks `<dir>/node_modules/<name>` upward from there. Under pnpm's default strict isolation (<https://pnpm.io/symlinked-node-modules-structure>) transitive dependencies are not hoisted to the workspace root's `node_modules`. So if `jotai` isn't a direct dependency of `packages/app`, the upward walk finds nothing — `dedupe` silently becomes a no-op and the build ships two copies anyway. Adding `jotai` to `packages/app/package.json` is what makes the dedupe contract enforceable.

The same reasoning applies to `optimizeDeps.include`: vite's optimizer also resolves include names from `config.root`, and if it can't find them, logs `Failed to resolve dependency: <name>` and silently skips pre-bundling.

## Proof 1 — via vitest

```sh
pnpm --filter app test
```

Passes (`1 passed`). With `resolve.dedupe: ['jotai']` in `vitest.config.js`, both libraries resolve `jotai` from `packages/app/node_modules/jotai`, a single module instance is loaded, and `getDefaultStore()` returns the same store on both sides.

Now comment out `dedupe: ['jotai']` in `packages/app/vitest.config.js` and re-run:

```
Detected multiple Jotai instances. It may cause unexpected behavior with the default store. https://github.com/pmndrs/jotai/discussions/2044

 ❯ src/counter.test.js (1 test | 1 failed)
     → expected +0 to be 1 // Object.is equality
```

(jotai itself detects the duplicate and warns at runtime — independent confirmation that there really are two module instances.) Restore the line afterwards.

## Proof 2 — via plain vite, no test runner involved

The bug isn't a test-runner artifact — `vite.config.js` exhibits the same behavior. Run the same dedupe-dependent code through vite's transform pipeline via `vite-node`, which reads `vite.config.js`:

```sh
pnpm --filter app start
```

Prints `counter = 1`. Comment out `dedupe: ['jotai']` in `packages/app/vite.config.js` (the **vite**, not vitest, config) and re-run — same multi-instance warning, output becomes `counter = 0`. Restore the line afterwards.

This second proof exists to demonstrate the false-positive bug applies to knip's *vite* plugin reading `vite.config.js` just as much as to its *vitest* plugin reading `vitest.config.js` — both plugins share `resolveConfig` and both miss the same fields.

## Versions used in this repro

- node: v24
- pnpm: 10.x
- knip: 6.11.0
- vite: 7.x
- vite-node: 3.x
- vitest: 3.2.4
- jotai: 2.10.0 (lib-writer) + 2.11.0 (lib-reader, app)
