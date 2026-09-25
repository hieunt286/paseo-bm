# paseo-bm 0.3.0-alpha.5

A **packaging** release: no new feature, and no change to the behaviour of the agents or of the installer. Its only purpose is to put `paseo-plugin.json` at the **root of the npm tarball**, the condition for paseo-bm to be listed on [paseo.cafe](https://paseo.cafe). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

**Installing this version:** `npx paseo-bm@next`, or pin it with `npx paseo-bm@0.3.0-alpha.5`. `npm view paseo-bm dist-tags` says where `latest` is.

## Changes

### The npm package

- **`paseo-plugin.json` now sits at the root of the tarball** beside `package.json`, `README.md` and `LICENSE`; `dist/` and `plugin/` are unchanged, and `plugin/paseo-plugin.json` stays exactly where it was. The paseo.cafe CI downloads the published package and reads the manifest **at the tarball root**, ignoring the `path` field, so without this file the entry cannot pass. The installer is unaffected: `findPayloadRoot` looks for `<directory>/plugin/paseo-plugin.json`, not for the file at the root.

### The repository (not in the npm package)

- `paseo-plugin.json` at the repository root, a byte-for-byte copy of `plugin/paseo-plugin.json`, with a test that goes red the moment the two files differ. This is the file the paseo.cafe scanner reads on GitHub.
- The README renames two sections to `Install` and `Limitations and warnings`, the names the scanner looks for. Not a word of the content changed.
- `images/` holds three screenshots: the Beads screen, one request on the Metric screen, and the installer asking about the three roles.
- `docs/operations/paseo-bm-cafe-listing-20260923.md` records the whole submission: the content of the registry file, their three CI gates, the risks accepted and the steps that remain.

## Warning: do not install with `paseo plugin add npm:`

Now that the tarball root carries a manifest, `paseo plugin add npm:paseo-bm@0.3.0-alpha.5` will **find a plugin and fail to load it**: the package root has no `index.client.tsx` and no `index.server.ts` — the real payload is inside `plugin/`, and the payload cannot register the three `bm-*` roles by itself either. Paseo keeps the broken entry in the configuration; remove it with `paseo plugin remove paseo-bm`.

**The only supported way to install is still `npx paseo-bm`**, because it copies the payload, registers the plugin, registers the three roles and asks for consent. The paseo.cafe entry says exactly this in its first two caveats.

## Unchanged

- No change to the installer code, the plugin code, the role instructions or the `--json` contract.
- The `latest` dist-tag is moved by hand by the owner; `release.yml` only sets `next`. Checked on 2026-09-23 with `npm view paseo-bm dist-tags`: `latest` and `next` were both at `0.3.0-alpha.4`, so once the owner moves `latest` to this version, users of a bare `npx paseo-bm` go from `0.3.0-alpha.4` to `0.3.0-alpha.5` — one packaging step, no behaviour change. (The dist-tag table in the [20260923 run record](../archive/operations/paseo-bm-release-run-20260923.md) was taken right after the workflow, while `latest` was still at `0.2.0-alpha.1`; the owner moved it afterwards.)

## Sources

- Request `req-20260923T063441Z` — submitting the plugin to paseo.cafe.
- [The paseo.cafe listing record](../operations/paseo-bm-cafe-listing-20260923.md), in particular §4 (why a new entry must declare an npm package) and §9 (the release steps).
- PR [paseo-cafe/paseo-cafe#215](https://github.com/paseo-cafe/paseo-cafe/pull/215).
