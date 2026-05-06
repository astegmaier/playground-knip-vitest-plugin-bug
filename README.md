# knip vite/vitest plugin: false-positive on `resolve.dedupe` / `optimizeDeps.include`

This repo demonstrates an issue with knip's vite and vitest plugins. Those plugins do not read bare-string package names from `resolve.dedupe` or `optimizeDeps.include` arrays in `vite.config.js` or `vitest.config.js`. Any dependency referenced only via those fields is reported as unused, even if they are actually needed.

## How to reproduce

`packages/app` has `jotai` as a dependency and references it in both `vite.config.js` and `vitest.config.js` , but not elsewhere.

```sh
pnpm install
pnpm knip
```

Expected output:

```sh
✂️  Excellent, Knip found no issues.
```

Actual output:

```sh
Unused dependencies (1)
jotai  package.json:11:6
```

`jotai` is correctly listed in `packages/app/package.json` — see [Why `jotai` really has to be a dependency](#why-jotai-really-has-to-be-a-dependency-of-packagesapp) at the bottom for the runtime proof.

## Suggested fix (AI Generated)

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

## Why `jotai` really has to be a dependency of `packages/app`

The plain reading of knip's warning — "this dependency is unused, remove it from `package.json`" — is what makes this a *false* positive worth fixing rather than just a noisy warning. Removing `jotai` from `packages/app/package.json` would silently break the build. Both proofs below demonstrate this.

### Layout

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

### Why the dep declaration in `packages/app` matters

Vite's `tryNodeResolve` (`packages/vite/src/node/plugins/resolve.ts`) sets `basedir = config.root` whenever a name appears in `resolve.dedupe`, then walks `<dir>/node_modules/<name>` upward from there. Under pnpm's default strict isolation (<https://pnpm.io/symlinked-node-modules-structure>) transitive dependencies are not hoisted to the workspace root's `node_modules`. So if `jotai` isn't a direct dependency of `packages/app`, the upward walk finds nothing — `dedupe` silently becomes a no-op and the build ships two copies anyway. Adding `jotai` to `packages/app/package.json` is what makes the dedupe contract enforceable.

The same reasoning applies to bare-name entries in `optimizeDeps.include`: vite's optimizer also resolves them from `config.root`, and if it can't find them, logs `Failed to resolve dependency: <name>, present in client 'optimizeDeps.include'` and silently skips pre-bundling — see [Proof 3](#proof-3--optimizedepsinclude-silently-fails-when-the-dep-isnt-a-direct-dep) below. (Nested-syntax entries `'a > b'` are the exception — only the head needs to be a direct dep, which is why the suggested fix splits on `>`.)

### Proof 1 — via vitest

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

### Proof 2 — via plain vite, no test runner involved

The bug isn't a test-runner artifact — `vite.config.js` exhibits the same behavior. Run the same dedupe-dependent code through vite's transform pipeline via `vite-node`, which reads `vite.config.js`:

```sh
pnpm --filter app start
```

Prints `counter = 1`. Comment out `dedupe: ['jotai']` in `packages/app/vite.config.js` (the **vite**, not vitest, config) and re-run — same multi-instance warning, output becomes `counter = 0`. Restore the line afterwards.

This second proof exists to demonstrate the false-positive bug applies to knip's *vite* plugin reading `vite.config.js` just as much as to its *vitest* plugin reading `vitest.config.js` — both plugins share `resolveConfig` and both miss the same fields.

### Proof 3 — `optimizeDeps.include` silently fails when the dep isn't a direct dep

Proofs 1 and 2 cover `resolve.dedupe`. This third proof covers `optimizeDeps.include` independently: under pnpm strict isolation, an include entry that isn't a direct dep of the package containing the config can't be resolved from `config.root`, so the optimizer logs a warning and skips pre-bundling.

```sh
pnpm --filter app bundle
```

With `jotai` listed in `packages/app/package.json`, the optimizer succeeds:

```
Optimizing dependencies:
  jotai
```

Now remove `"jotai": "2.11.0"` from `packages/app/package.json`, run `pnpm install`, and re-run the same command:

```
Failed to resolve dependency: jotai, present in client 'optimizeDeps.include'
Optimizing dependencies:
```

The warning confirms vite's optimizer resolves `optimizeDeps.include` names from `config.root` and silently no-ops when the dep isn't reachable from there — the same root-relative-resolution argument that makes `resolve.dedupe` brittle. Restore the dependency afterwards.
