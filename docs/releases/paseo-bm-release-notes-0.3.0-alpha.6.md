# paseo-bm 0.3.0-alpha.6

A **packaging** release: no new feature, and no change to the behaviour of the agents or of the installer. From this version on, every release produces **two npm packages** at the same version: `paseo-bm` (the installer, as before) and `paseo-bm-plugin` (the payload, whose package root is a loadable plugin). Use it as `--notes-file` as the [release runbook](../operations/paseo-bm-release-runbook.md) describes.

**Installing this version:** `npx paseo-bm@next`, or pin it with `npx paseo-bm@0.3.0-alpha.6`. Nothing about the way you install changes.

## Why there is a second package

[paseo.cafe](https://paseo.cafe) can only list a plugin whose **npm package root is the loadable payload itself**: their security scan demands `index.client.ts(x)` or `index.server.ts(x)` at the plugin root, and for npm it always scans the tarball root. The `paseo-bm` package is an installer, so it can never pass that gate — the four gates in detail are in the [listing record](../operations/paseo-bm-cafe-listing-20260923.md) §4 and §10, the decision in [ADR-009](../adr/ADR-009-payload-as-npm-package.md).

## Changes

- **`paseo-bm-plugin` is a new package**, its root holding `paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`, plus a `README.md` and a `LICENSE` of its own. Its version always equals the version of `paseo-bm`, it is published in the same `release.yml` run, with the same provenance.
- **Three version sources that cannot drift apart**: `package.json` at the root, `plugin/package.json`, and `PLUGIN_VERSION`. The generator writes the last two from the first, and a test goes red when they differ.
- **The screenshots move to `plugin/images/`** for the listing page, and they are in **no** tarball: the payload package does not list them, the installer package excludes them with a negative pattern, and `smoke:packed` checks that on the real tarball.
- `plugin/LICENSE` appears because MIT requires the licence to travel with every copy, and the payload package is a distribution of its own.

## Warning: installing the payload package alone leaves the roles missing

`paseo-bm-plugin` **loads**, but it is only the payload: the three roles `bm-manager`, `bm-worker` and `bm-reviewer` are registered by the **installer**, not by the payload. Install it alone and the screens come up, but Beads Manager cannot create a Worker — the product does not work end to end.

The command differs by Paseo version; only 0.9 and later has an npm source:

```bash
# Paseo 0.9+
paseo plugin add npm:paseo-bm-plugin@0.3.0-alpha.6
# Paseo 0.8
paseo plugin add hieunt286/paseo-bm --ref <commit> --path plugin
```

**The supported way to install is still `npx paseo-bm`.**

## Unchanged

- The installer code, the plugin code, the role instructions, the `--json` contract, the commands and the exit codes: all as they were.
- The `latest` dist-tag of `paseo-bm` is moved by hand by the owner; `release.yml` only sets `next`.

## Sources

- Request `req-20260923T063441Z`; [ADR-009](../adr/ADR-009-payload-as-npm-package.md); [the design delta](../archive/design/paseo-bm-delta-20260923-payload-npm-package.md); [the plan delta](../archive/plans/paseo-bm-implementation-plan-delta-20260923-payload-npm-package.md) phase 2a-20.
