# ADR-001 — Distribute the plugin as a payload shipped in the npm package, registered from a local directory

| Field | Value |
|---|---|
| Status | **Superseded by [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25)** — the product is the plugin package `paseo-bm-plugin`, installed from paseo.cafe / npm; the installer no longer copies the payload or registers a directory |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Related | [PRD §Q-004](../product/paseo-bm-prd.md#10-open-questions), [Technical Design](../design/paseo-bm.md) |

## Context

Paseo 0.8 accepts a plugin from two sources: a directory on the daemon's machine (`paseo plugin install <dir>`) or a Git repository (`paseo plugin add owner/repo[:path] --ref <ref>`). The daemon configuration stores plugin sources as `plugins: record<id, PluginSource>`, and the only source type written for a local install is `"directory"` — meaning **the directory path must exist for the long term**, not only while the command runs.

Constraints verified on the machine (Paseo CLI/daemon 0.8.0, 2026-09-14):

- `paseo plugin install --help` has `--id`, `--ref`, `--path`, `--json`, `--host`; `install` and `add` are the same command.
- `paseo plugin update` applies only to Git-source plugins.
- `paseo plugin remove` deletes the Paseo-managed checkout for a Git source, but **never deletes a local source directory**.
- `paseo plugin init` creates a scaffold with only `devDependencies` (`@getpaseo/plugin`, react, react-native, zod, typescript) for typechecking; Paseo provides the runtime modules to the plugin, so the payload needs no `node_modules` at run time.
- The PRD requires: the user knows exactly which plugin code they are trusting, and once `npx` has downloaded the package, installing the plugin needs no network.

The problem: `npx` runs the package from a temporary cache directory. If Paseo is pointed there, the plugin breaks when the cache is cleaned.

## Decision

1. The plugin code lives in the `paseo-bm` repository itself, in the `plugin/` directory, and is packed into the npm package through the `files` field.
2. On install, the CLI **copies** the payload from the npm package to `<install home>/plugin/<version>/` (by default `~/.paseo-bm/plugin/<version>/`), a stable path owned by paseo-bm.
3. It registers with Paseo using `paseo plugin install <install home>/plugin/<version> --id paseo-bm --json`.
4. **The plugin version always equals the npm package version.** `paseo plugin update` is not used (it is only for Git sources); the only update path is running `npx paseo-bm@<version>` again.
5. The payload ships without `node_modules`. `paseo-plugin.json` declares `requirements.paseo` as `>=0.8.0`.
6. On uninstall: `paseo plugin remove paseo-bm`, then paseo-bm deletes its own payload directory (because Paseo does not delete a local source).

## Consequences

**Positive**
- Installing the plugin needs no network and does not depend on GitHub at install time.
- The code that runs is exactly the code in the npm version the user chose; npm provenance covers the payload too.
- No `build` step is needed in `paseo-plugin.json` (building belongs to the release process), so no unfamiliar command runs on the user's machine at install time.
- Several versions can be kept side by side under `plugin/<version>/`, so downgrading or recovering from an incident is simple.

**Negative / to be accepted**
- Duplicated data: the payload lives both in the npm package and in the install home. Acceptable because it is small.
- The convenience of `paseo plugin update` and the update flow in Paseo's Settings is lost. Compensated by clear messages in `doctor` and the README.
- paseo-bm must clean up its own payload directory on uninstall; if it misses it, garbage is left behind. Bounded by the install record (ADR-002) and PRD criterion M-5.
- Each version takes additional disk space. *(Corrected 2026-09-15: the first draft proposed "keep at most N versions". The owner decided to **keep all of them**, cleaning up only when the user runs `--prune` — see Technical Design Q-016.)*

## Alternatives considered

| Option | Reason rejected |
|---|---|
| `paseo plugin add hieunt286/paseo-bm:plugin --ref v<version>` (Git source) | Needs network and GitHub access at install time; the plugin version is decoupled from the npm version and drifts easily; adds a second trust path besides npm provenance. Still kept as a fallback option if Paseo's update flow is needed later |
| Point Paseo straight at the `npx` cache directory | The cache is temporary; cleaning the cache breaks the plugin. Rejected outright |
| Split the plugin into its own repository and publish it independently | Inflates the release cost for a one-person product; keeping versions in sync across two repositories is an unnecessary burden in Phase 1 |
| Install the plugin as a global npm package and point at `node_modules` | Paseo has no npm source type; the global `node_modules` path differs between Node version managers |
