# ADR-026 — The published plugin is a generated, bundled `plugin-package/`

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-01) — decided by the owner |
| Date | 2026-10-01 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-009](ADR-009-payload-as-npm-package.md) and [ADR-012](ADR-012-plugin-is-the-product.md) where they make `plugin/` itself the published package and the directory the paseo.cafe listing reads |
| Related | [paseo.cafe listing record](../operations/paseo-bm-cafe-listing-20260923.md) · [paseo-cafe PR #315](https://github.com/paseo-cafe/paseo-cafe/pull/315) · [Technical Design](../design/paseo-bm.md) §3 · [release runbook](../operations/paseo-bm-release-runbook.md) |
| The owner's decision | 2026-10-01: ship a bundled package so the listing passes the scan, as the safest of the options; keep the sources and tests as they are |

## Context

paseo.cafe's security scan (`scripts/plugin-security/static-scan.ts` in `paseo-cafe/paseo-cafe`, at `4608732`) reads a listed plugin's executable graph from its two entries, both in Git under the registry entry's `path` and in the npm tarball. A graph over **200 files**, **2,000,000 bytes**, 2 MB in one file or six directory levels is refused with the blocking finding `scanner/incomplete`. A refused release is not listed: the listing keeps the last version that passed.

`plugin/` at 0.5.1 is **250 TypeScript files, about 3.5 MB** (0.4.1 was 1.3 MB). Stripping the comments leaves about 2.5 MB, and the file count is over the limit either way. On 2026-10-01 the scan refused `paseo-bm-plugin@0.5.1` and the Git source at `6d9b1a6` (PR #315, run 36849724813), so the listing stayed at 0.4.1 with its 0.3 screenshots.

Paseo itself never needed the files split: it compiles each entry with esbuild into one bundle (CommonJS for the server, run in a forked worker) and provides the SDK, `zod`, React, React Native, React Query and Node built-ins at run time. The plugin's code already avoids locating any file of its own at run time (no `import.meta`, `__dirname` or `process.cwd()`; the role instructions are embedded), which a test guards.

The options were:

- **wait for paseo.cafe to raise its limit**: it does not fix the file count, and it depends on another team;
- **strip comments, or merge modules by hand**: still over 2 MB, and it damages the sources;
- **publish a bundle**: a build step, the sources and the tests unchanged.

## Decision

1. **`plugin/` stays the source**: hand-edited, typechecked, tested and loadable as a directory plugin, as now. Nothing in it changes.
2. **`plugin-package/` is the published form.** `scripts/generate-plugin-package.mjs`, run by `npm run build`, writes it from `plugin/`:
   - `index.server.ts` and `index.client.tsx`, each **one esbuild bundle** of the entry and everything it imports. Format ESM, `jsx: automatic`, whitespace and syntax minified, **identifiers kept** so a stack trace still names the function, no comments. The host-provided modules stay imports: `@getpaseo/*`, `zod`, `react`, `react-native`, `@tanstack/react-query`, `node:*`, which is the same set the scan accepts. Each file starts with `// @ts-nocheck` and a header naming the source at the version's tag.
   - `paseo-plugin.json`, `README.md` and `LICENSE` copied from `plugin/`.
   - `package.json` derived from `plugin/package.json`: the same name, version, description and keywords, `files` limited to the five shipped files, `repository.directory: "plugin-package"`, and no `scripts`, since a typecheck script would have nothing to check (a fake check).
   - `images/` copied from `plugin/images/`, for the listing only and not in the tarball.

   esbuild is the one `tsup` pins, resolved through it, so no dependency is added.
3. **`plugin-package/` is committed**, because the listing reads Git. It contains only what the build writes. `test/plugin-package.test.ts` fails when it differs from a fresh build, when it holds a file the build does not write, when the two entries exceed 2,000,000 bytes, or when a bundle imports a module outside the host-provided set (a client bundle importing a Node built-in or the server SDK counts as outside). `test/plugin-bundle-cjs.test.ts` loads the published server entry the way Paseo does (re-bundled as CommonJS, wrapped, eager interop), and requires every RPC and hook to register, exactly as it does for the source.
4. **npm publishes `plugin-package/`.** `release.yml` runs `npm publish` there, and checks the version and the absence of install scripts in it. `smoke:packed` checks that it is current, packs it, and asserts that the tarball is exactly the five files and within the budget.
5. **The paseo.cafe entry declares `path: "plugin-package"`.** `package` stays `paseo-bm-plugin`.
6. **The budget is watched.** The build refuses entries over 2,000,000 bytes. At 0.5.2 they are 1,626,599 bytes, which leaves about 370 KB. Before code growth uses that up, the choices are to ask paseo.cafe for a larger budget or to minify identifiers; either is a new decision.

## Consequences

- The listing and the npm tarball pass the scan: 3 files, 1,626,670 bytes, 0 findings, by paseo.cafe's own `scanStaticFiles` run locally.
- **Reading the published code is harder.** It is one long line per entry, with readable names. The header of each entry points at the source at the release's tag, and the source is what reviewers and users should read.
- **A stack trace from a user's machine points into the bundle**, not at a source file. The function names are kept, so the frame can still be found in `plugin/`.
- A change to `plugin/` needs `npm run build` before commit, or `plugin-package.test.ts` goes red. This is the same rule as the role-instruction modules.
- Field builds, the isolated-daemon kit and every test keep using `plugin/`. Only what is published and listed changes.
- The repository now has two `paseo-plugin.json` files, in `plugin/` and `plugin-package/`, and still none at the root. `test/plugin-structure.test.ts` asserts exactly that.
