# paseo-bm 0.5.2

**Packaged so paseo.cafe can list 0.5.** Nothing changes in how the agents work or in the screens: the code that runs is the same as 0.5.1, packaged differently. Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

- **The published package is bundled.** paseo.cafe's security scan reads a plugin's code from its two entries and refuses more than 200 files or 2,000,000 bytes. 0.5.1 shipped its 250 TypeScript source files (about 3.5 MB), so the scan refused it and the paseo.cafe listing stayed on 0.4.1. From 0.5.2 the package holds the two entries, each bundled into one file (1.63 MB together), with the manifest, `README.md` and `LICENSE` ([ADR-026](https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/adr/ADR-026-published-plugin-is-bundled.md)). Paseo compiles them as it compiled the sources.
- **The bundles keep their names.** Whitespace is minified, but function and variable names are kept, so an error in Paseo's plugin log still names the function. Each file's header points at its readable source at this release's tag, [`plugin/`](https://github.com/hieunt286/paseo-bm/tree/v0.5.2/plugin).
- The source, the tests and the way the plugin behaves are unchanged.

## What to know when upgrading

Nothing beyond [0.5.0](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.0). Paseo replaces the installed files on update; your data folder and settings are untouched.

## Rollback

`paseo plugin update paseo-bm --version 0.5.1`. It is the same code, unbundled.

## Evidence

- `npm run verify` and `npm run smoke:packed` exited 0 on the tagged tree. The smoke now checks that the published package is current with the source, holds exactly its six files, and fits the scan budget.
- paseo.cafe's own scanner (`scanStaticFiles`, paseo-cafe `4608732`), run locally on the package: 3 files, 1,626,670 bytes, no finding. On 0.5.1 it reported `scanner/incomplete`.
- The published server entry loads the way Paseo loads a plugin (re-bundled as CommonJS, eager interop) and registers every RPC and hook, as the source does (`test/plugin-bundle-cjs.test.ts`).
- The packed tarball, served through a registry mirror to isolated Paseo 0.9.2 daemons:
  - **Update from the real 0.5.1:** `running`, with clean logs. The 0.5.1 data and settings were read, and the 19 read RPCs behind the screens gave the same answers as on 0.5.1. The plugin now loads in 0.6 s instead of 6.5 s.
  - **Fresh install:** the Manager was created with its role instructions, tools and title marker, and removal left nothing behind.
  - **The client:** the client bundle the daemon compiled for 0.5.2 was evaluated the way the app evaluates it, beside 0.5.1's. Both registered the same 18 contributions, transformed 56 sample messages identically, and rendered 17 screens and cards to identical HTML.

## Sources

[ADR-026](https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/adr/ADR-026-published-plugin-is-bundled.md) · [Technical Design](https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/design/paseo-bm.md) §3.1 · [paseo.cafe listing record](https://github.com/hieunt286/paseo-bm/blob/v0.5.2/docs/operations/paseo-bm-cafe-listing-20260923.md) · [0.5.1 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.5.1)
