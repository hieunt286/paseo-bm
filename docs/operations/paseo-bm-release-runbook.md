# Release runbook — paseo-bm

| Field | Value |
|---|---|
| Status | Active — the release process in force |
| Workflow | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — the real publish runs only on a **GitHub Release** event (`release: published`); a manual run (`workflow_dispatch`) is a rehearsal and stops at `npm publish --dry-run` |
| Packages | **`paseo-bm-plugin`** only, published from `plugin-package/`, which `npm run build` generates from `plugin/` with each entry bundled ([ADR-026](../adr/ADR-026-published-plugin-is-bundled.md)). `paseo-bm`, the migration command, was last published at `0.4.0` and is deprecated on npm; its source lives only at the `v0.4.0` tag, and the root `package.json` is `"private": true` with no `bin`, `files` or `prepack` (§7 if the command ever needs a fix) |
| Dist-tag | The workflow picks it from the version: with a `-` (a prerelease, `0.4.0-alpha.0` for instance) → `next`; without one (stable, `0.4.0` for instance) → `latest` |
| Release notes | `docs/releases/paseo-bm-release-notes-<version>.md`, used as the body of the GitHub Release |
| Underlying decisions | [ADR-009](../adr/ADR-009-payload-as-npm-package.md) (the payload as its own package); [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (the plugin is the product, `paseo-bm` stops at `0.4.0`); [ADR-022](../adr/ADR-022-retirements-after-code-review.md) decision 1 (the command's source deleted, a fix made from its tag); [design delta 20260925b](../archive/design/paseo-bm-delta-20260925b-stable-release.md) §2 (the dist-tag follows the kind of version) |

## 0. Rules that do not change

- **Authentication is OIDC** (trusted publishing): there is no `NPM_TOKEN` and no other secret. The trusted publisher of **both** packages points at the file name `release.yml` (`paseo-bm`'s is kept for §7) — do not rename it and do not move it.
- **The GitHub Release is the approval point.** After 72 hours there is no `unpublish`; the way back is always to release a patch.
- **An agent never logs in to npm and never touches the owner's credentials.** The npm account has 2FA at `auth-and-writes`, so every write outside `release.yml` (`npm publish` by hand, `npm trust …`, `npm dist-tag add …`) asks for a one-time password and is the owner's job.
- **Three version sources must agree**: `package.json`, `plugin/package.json`, `plugin/shared/version.ts` (`PLUGIN_VERSION`). The last two (and `plugin-package/package.json`) are generated from the first by `npm run build`, and a test fails when they disagree. In the workflow, `Resolve version, tag and dist-tag` requires the tag to be `v` + the root version, and `Assert the plugin version` checks `plugin/package.json` and `plugin-package/package.json` against it, before anything reaches npm. Why: [the paseo.cafe record](./paseo-bm-cafe-listing-20260923.md) §9.
- No `preinstall` / `install` / `postinstall` in the root `package.json`, `plugin/package.json` or `plugin-package/package.json` (the published one); the workflow's `Assert no npm install lifecycle scripts` checks all three.

## 1. Preparation (an agent can do this)

1. **Pick the number.** A prerelease → `next`, a stable version → `latest`. `test/plugin-role-labels.test.ts` pins the payload's minor version (`0.5.`); changing the minor means fixing that check in the same commit.
2. **Change the version, then build, before verifying**:
   ```bash
   npm version <version> --no-git-tag-version
   npm run build          # writes plugin/package.json, PLUGIN_VERSION and plugin-package/ (ADR-026)
   npm run verify         # typecheck, typecheck:plugin, lint, test, test:bench, test:eval, build
   ```
   Verifying before building, after a version change, goes red because the two generated sources do not agree yet.
3. **Write the release notes** at `docs/releases/paseo-bm-release-notes-<version>.md`, **in English**, following the shape of the most recent one: what this version brings, what to know when upgrading, rollback, evidence, sources. Name every change in the behaviour of the agents (`plugin/roles/*.md`) and of the screens.
4. **Verify on exactly the tree that will be tagged.** If the working tree holds another session's unfinished work, measure in a clean worktree:
   ```bash
   WT=$(mktemp -d) && git worktree add --detach "$WT" <commit>
   ln -s "$PWD/node_modules" "$WT/node_modules" && (cd "$WT" && npm run verify)
   git worktree remove "$WT"
   ```
   When the release changes what the plugin does, also install the packed payload on an isolated Paseo daemon and walk it through [`scripts/manual-test/`](../../scripts/manual-test/README.md): both a fresh install and an update from the version on `latest`. The run record for `0.4.0` (`docs/archive/operations/paseo-bm-install-run-20260926.md` §1) shows how to serve an unpublished tarball through `paseo plugin add npm:…` with a registry mirror.
5. **Commit** `chore(release): <version>`, push `main`, wait for `ci.yml` to go green (Node 22, ubuntu).
6. **Rehearse** `release.yml` on `main`:
   ```bash
   gh workflow run release.yml -f tag=v<version>
   ```
   It passes when: both jobs `verify (ubuntu-latest, node 24)` and `verify (macos-latest, node 24)` are green, including `Smoke test packed package`; the log holds `Dry-run publish of paseo-bm-plugin@<version> with dist-tag <next|latest>`; and the two real steps, `Publish payload to npm` and `Verify published payload`, are `skipped`. A rehearsal does not prove the registry accepts the dist-tag. It does ask whether the version exists: rehearsing a version already on npm fails at the dry-run with `You cannot publish over the previously published versions`, so rehearse only after step 2 has moved the version.
7. **When you change `release.yml`, check the shell layer too**, not only the JavaScript: `bash -n` over every `run:` block; no `node -e '…'` may contain a single quote, not even inside a comment (one apostrophe ends the shell string).

## 2. Releasing (after the owner approves)

The GitHub Release's `prerelease` flag must agree with the shape of the version; where they differ, the workflow goes red at `Resolve version, tag and dist-tag`, before anything is published.

```bash
git tag v<version> && git push origin v<version>
# prerelease:
gh release create v<version> --prerelease --title "v<version>" --notes-file docs/releases/paseo-bm-release-notes-<version>.md
# stable:
gh release create v<version> --title "v<version>" --notes-file docs/releases/paseo-bm-release-notes-<version>.md
```

Follow the run of the `release` event: the checks, `smoke:packed`, `Assert the plugin version`, the dry-run step, then `Publish payload to npm` → `Verify published payload` (waits up to 10 minutes, because npm answers "being processed" for several minutes).

## 3. Verification

```bash
npm view paseo-bm-plugin version
npm view paseo-bm-plugin dist-tags
npm view paseo-bm-plugin@<version> dist.attestations   # SLSA provenance v1
npm view paseo-bm dist-tags                            # unchanged: latest stays 0.4.0
```

It passes when `paseo-bm-plugin` is at `<version>` on the dist-tag that matches the kind of version (`next` or `latest`), the attestations are there, and `paseo-bm` did not move. Then install it the way users do, on an isolated daemon (`scripts/manual-test/start-daemon.sh`, then `paseo plugin add npm:paseo-bm-plugin`), and update to it from the previous version with `paseo plugin update paseo-bm`. Record the evidence (the run number, the output) in the close reason of the release bead.

## 4. After the release

- **A stable release does not move `next`.** `next` still points at the last prerelease. To make `@next` give the stable version, the owner runs (a one-time password is needed): `npm dist-tag add paseo-bm-plugin@<version> next`. The same command with `latest` is the fallback if `latest` does not move after a publish.
- **paseo.cafe**: if a caveat of the `registry/paseo-bm.json` entry names the number or the kind of version, fix it as [the listing record](./paseo-bm-cafe-listing-20260923.md) §9 says (Biome keeps a short array on one line; check the content is non-empty before writing it).
- The real dist-tag state is always read with `npm view <package> dist-tags`, never copied into a document.

## 5. The way back

Release a patch (`<major>.<minor>.<patch+1>` or `-alpha.<n+1>`); never `npm unpublish`. A user who needs to go back right away runs `paseo plugin update paseo-bm --version <previous version>`; the release notes say what the previous version still reads (a 0.3.x plugin does not read the 0.4 data folder, for instance).

## 6. Only when adding a new npm package

`npm trust` can only be configured for a package that **already exists** on the registry, so the first version of a new package name does not go through OIDC. The owner does this on their own machine (a one-time password is needed):

```bash
npm login && npm whoami
npm version 0.0.0-placeholder.0 --no-git-tag-version      # in the package's own directory
npm publish --tag placeholder --access public             # never next or latest
git checkout package.json
npm trust github <package> --file release.yml --repo hieunt286/paseo-bm --allow-publish
npm trust list <package>
```

Both current packages already have a trusted publisher (`paseo-bm` since `0.1.0-alpha.0`, `paseo-bm-plugin` confirmed in [the listing record](./paseo-bm-cafe-listing-20260923.md) §12); the placeholder version `0.0.0-placeholder.0` sits on the `placeholder` dist-tag, so `npx` never picks it up. If the package name already belongs to someone else, or `npm trust` reports missing permissions: stop and ask the owner; never use a token that bypasses 2FA.

## 7. Only if the `paseo-bm` command needs a fix after 0.4.0

`main` does not hold the command: its source, tests and packaging were deleted ([ADR-022](../adr/ADR-022-retirements-after-code-review.md) decision 1). The fix is made on a branch from the `v0.4.0` tag, whose tree still builds, tests, packs and publishes the command; that branch is never merged back into `main`. Its trusted publisher still points at `release.yml`, which is the file name npm checks, so the branch's own copy of the workflow publishes it.

1. **Branch from the tag** and make the fix in `src/` there, with its test: `git switch -c paseo-bm-fix-<version> v0.4.0`.
2. **Pick `<version>` with the owner.** It must not be published for `paseo-bm` yet (`npm view paseo-bm versions`), and `v<version>` must not be a tag of this repository already: both packages share the tag names, and the workflow requires the tag to be `v` + the root version. `npm version <version> --no-git-tag-version` on the branch.
3. **Publish only `paseo-bm` from that branch.** In the branch's `release.yml`, delete `Publish payload (dry-run)`, `Publish payload to npm` and `Verify published payload`, so the run cannot publish a second `paseo-bm-plugin` from the old payload; `paseo-bm-plugin` is released from `main` only.
4. **Verify there:** `npm run build && npm run verify && npm run smoke:packed`. That tree's `verify` and smoke are 0.4.0's (one Vitest run; the smoke packs both tarballs).
5. **Rehearse and release** as §1.6 and §2 say, on the branch: `gh workflow run release.yml --ref paseo-bm-fix-<version> -f tag=v<version>`, then tag the branch's head `v<version>`, push the tag and publish the GitHub Release from it. A release runs the workflow as it is at the tag, so the branch's copy is the one that runs.
6. **Tell users.** The deprecation message names `npx paseo-bm@0.4.0`; if the fix must reach users, the owner reruns `npm deprecate` with the new number (a one-time password is needed).
