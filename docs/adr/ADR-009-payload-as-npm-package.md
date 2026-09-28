# ADR-009 — The payload is published as its own npm package `paseo-bm-plugin`, from the same repository and the same release

| Field | Value |
|---|---|
| Status | Accepted; decisions 4 and 5 **Superseded by [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25)**: `paseo-bm-plugin` is the only supported install path, on Paseo 0.9+ |
| Date | 2026-09-23 |
| Owner | hieu.nt10 |
| Related | Amends [ADR-001](ADR-001-plugin-distribution.md) decision 1 and its "Alternatives considered" section; [the paseo.cafe listing record](../operations/paseo-bm-cafe-listing-20260923.md) §4 and §10 |
| Request | `req-20260923T063441Z` — the owner answered Q10 "other", Q11 a, Q12 b, Q13 b in the chat with Beads Worker |

## Context

The owner's requirement: every release both goes to npm and keeps the listing on [paseo.cafe](https://paseo.cafe) valid.

That directory has four gates, checked with a real PR ([#215](https://github.com/paseo-cafe/paseo-cafe/pull/215)) rather than by reading documentation:

1. `validate-registry.ts` — `<path>/paseo-plugin.json` on GitHub must have an `id` matching the entry's file name. **Passes** since there has been a manifest at the repository root.
2. `plugin-security/targets.ts` line 99 — a **new** entry must declare `package`. **Passes** after declaring `paseo-bm`.
3. `validate-registry.ts`, the npm part — the published tarball must have `paseo-plugin.json` **right at the root**, with matching `name` and `version`. **Passes** since 0.3.0-alpha.5.
4. `plugin-security/static-scan.ts` — the rule `entrypoint/missing`, blocking: there must be an `index.client.ts(x)` or `index.server.ts(x)` **right at the plugin's root directory**. It scans two roots: the Git root **does** apply `path` (`scan.ts:229`), while the npm root **is always the tarball root** (`scan.ts:322`). **Red.**

Gate 4 is the one that cannot be worked around. The `paseo-bm` package is the installer: the tarball root has `dist/` and `plugin/`, no runtime entry, and never will — adding a manifest there cannot save it, because the rule demands an *entry*, not a manifest. Dropping `package` runs into gate 2. In other words, the registry only accepts a plugin whose **npm package root is the loadable payload itself**; that is the shape of `@omercnet/paseo-beads` (the repository declares `path`, a separate npm package for the payload).

ADR-001 decision 1 put the payload in `plugin/` and packed it into **the installer's package**. Its "Alternatives considered" section rejected the option "split the plugin into its own repository and publish it independently" because of the cost of keeping two repositories in sync in Phase 1. The decision below does **not** split the repository; it publishes that same directory as a second package from the same repository and the same release, so the old reason for rejection no longer applies.

## Decision

1. **`plugin/` is an npm package: `paseo-bm-plugin`.** The directory has its own `package.json`; the package root is the payload itself (`paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`).
2. **The two packages' versions are always equal.** `scripts/generate-plugin-version.mjs` generates both `plugin/shared/version.ts` and the `version` field of `plugin/package.json` from the root `package.json`; a test turns red when the three places disagree.
3. **One release, two packages.** `release.yml` publishes `paseo-bm` and then `paseo-bm-plugin`, with the same dist-tag and the same `--provenance`. The second package's trusted publisher points at this same workflow file.
4. **The supported install path does not change: `npx paseo-bm`.** ADR-001 decisions 2 → 6 stay unchanged: the installer still copies the payload from its own package to `~/.paseo-bm/plugin/<version>/` and then registers it, without taking it from `paseo-bm-plugin`. The second package is **not** on the install path.
5. **The second package promises exactly one thing: it loads** — and it must say correctly with which command. Paseo **0.8 has no npm source**: `paseo plugin add --help` accepts only a directory on the machine or a Git source, so on 0.8 the direct install command is `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin`; the `npm:<package>@<v>` form belongs to **0.9 and later**, and the listing page attaches exactly those two labels itself. Both paths give the interface but **not** the three `bm-*` roles — only the installer registers them. The entry's two caveats say this plainly. Letting the payload register the roles itself the first time is **a separate request**, done after the listing is complete (owner decided Q12 b).
6. **The registry entry** declares `path: "plugin"` and `package: "paseo-bm-plugin"`.

## Consequences

**Positive**
- Passes all four gates: gate 4 scans `plugin/` for the Git source and the new package root for npm, and both have a real runtime entry.
- The second package is a payload in the true sense, readable, checkable, with provenance — anyone who wants to inspect the code before trusting it downloads exactly what runs on their machine.
- No repository split, no second release schedule: the same tag, the same workflow.

**Negative / to be accepted**
- **One more public artifact** that people can install directly and get a product without roles. Paid for with a caveat, and with the next request (decision 5).
- Publishing two packages in one job: if the second package fails after the first is already up, the first cannot be rolled back. The design must check everything checkable **before** the first publish step.
- The first time requires publishing a placeholder version and then `npm trust github` for the new name, because trusted publishing can only be configured for a package that already exists (runbook §1).
- The listing's metadata is now read from inside `plugin/`, so `plugin/` needs its own `package.json` and `README.md`.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Add `index.client.tsx` and `index.server.ts` at the repository root, only re-exporting from `plugin/` | Makes the repository root *look like* a plugin while the real payload is elsewhere; it is unverified whether Paseo's bundler can follow relative imports when loading from the root; and the npm tarball root would still need that shim, that is, still publish something that loads a product without roles — at exactly the cost of decision 1 but more obscure |
| Ask the maintainers for an exception | Gate 4 is an automated check in their CI, not a human opinion; their own review bot had also raised exactly this concern |
| Drop the listing | Contrary to the owner's requirement |
| Put the installer inside the payload package itself | Mixes two different things into one package; `npx` of a payload package is meaningless, and the package root would then also have the CLI's `dist/` |
