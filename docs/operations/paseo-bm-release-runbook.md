# Release runbook — paseo-bm

| Field | Value |
|---|---|
| Status | Active — the release process in force |
| Workflow | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — the real publish runs only on a **GitHub Release** event (`release: published`); a manual run (`workflow_dispatch`) is a rehearsal and stops at `npm publish --dry-run` |
| Packages | Since `0.4.1`: **`paseo-bm-plugin`** only (the payload in `plugin/`). `paseo-bm`, the migration command, was last published at `0.4.0` and is deprecated on npm; the root `package.json` is `"private": true` (§7 if it ever needs a fix). Up to `0.4.0` both were published at the same version from the same run |
| Dist-tag | The workflow picks it from the version: with a `-` (a prerelease, `0.4.0-alpha.0` for instance) → `next`; without one (stable, `0.4.0` for instance) → `latest` |
| Release notes | `docs/releases/paseo-bm-release-notes-<version>.md`, used as the body of the GitHub Release |
| Underlying decisions | [ADR-009](../adr/ADR-009-payload-as-npm-package.md) (the payload as its own package); [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (the plugin is the product, `paseo-bm` stops at `0.4.0`); [design delta 20260925b](../archive/design/paseo-bm-delta-20260925b-stable-release.md) §2 (the dist-tag follows the kind of version) |

## 0. Rules that do not change

- **Authentication is OIDC** (trusted publishing): there is no `NPM_TOKEN` and no other secret. The trusted publisher of **both** packages points at the file name `release.yml` (`paseo-bm`'s is kept for §7) — do not rename it and do not move it.
- **The GitHub Release is the approval point.** After 72 hours there is no `unpublish`; the way back is always to release a patch.
- **An agent never logs in to npm and never touches the owner's credentials.** The npm account has 2FA at `auth-and-writes`, so every write outside `release.yml` (`npm publish` by hand, `npm trust …`, `npm dist-tag add …`) asks for a one-time password and is the owner's job. Letting an agent try failed three times (2026-09-23).
- **Three version sources must agree**: `package.json`, `plugin/package.json`, `plugin/shared/version.ts` (`PLUGIN_VERSION`). The last two are generated from the first by `npm run build`; the workflow's `Assert the plugin version` step stops the run before anything reaches npm. Why: [the paseo.cafe record](./paseo-bm-cafe-listing-20260923.md) §9.
- No `preinstall` / `install` / `postinstall` in `plugin/package.json` (the published one) or in the root `package.json`; the workflow checks both.

## 1. Preparation (an agent can do this)

1. **Pick the number.** A prerelease → `next`, a stable version → `latest`. `test/plugin-role-labels.test.ts` pins the payload's minor version (`0.4.`); changing the minor means fixing that check in the same commit.
2. **Change the version, then build, before verifying**:
   ```bash
   npm version <version> --no-git-tag-version
   npm run build          # writes plugin/package.json and PLUGIN_VERSION
   npm run verify         # typecheck, typecheck:plugin, lint, test, build
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
   It passes when: both jobs `verify (ubuntu-latest, node 24)` and `verify (macos-latest, node 24)` are green, including `Smoke test packed package`; the log holds `Dry-run publish of paseo-bm-plugin@<version> with dist-tag <next|latest>`; and the two real steps, `Publish payload to npm` and `Verify published payload`, are `skipped`. A rehearsal does not prove the registry accepts the dist-tag. It does ask whether the version exists: rehearsing a version already on npm fails at the dry-run with `You cannot publish over the previously published versions` (seen on 2026-09-28 with `0.4.0`), so rehearse only after step 2 has moved the version.
7. **When you change `release.yml`, check the shell layer too**, not only the JavaScript: `bash -n` over every `run:` block; no `node -e '…'` may contain a single quote, not even inside a comment (an `owner's` turned the first `0.3.0` rehearsal red).

## 2. Releasing (after the owner approves)

The GitHub Release's `prerelease` flag must agree with the shape of the version; where they differ, the workflow goes red at `Resolve version, tag and dist-tag`, before anything is published.

```bash
git tag v<version> && git push origin v<version>
# prerelease:
gh release create v<version> --prerelease --title "v<version>" --notes-file docs/releases/paseo-bm-release-notes-<version>.md
# stable:
gh release create v<version> --title "v<version>" --notes-file docs/releases/paseo-bm-release-notes-<version>.md
```

Follow the run of the `release` event: the checks, `smoke:packed`, `Assert the plugin version`, the dry-run step, then `Publish payload to npm` → `Verify published payload` (waits up to 5 minutes, because npm answers "being processed").

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

`release.yml` no longer publishes `paseo-bm`. Its trusted publisher still points at `release.yml`, so one more release of it goes through the same workflow: for that one release, set `"private": false` in the root `package.json`, restore the three `paseo-bm` steps removed in 0.4.1 (`Publish (dry-run)`, `Publish to npm` before the payload, and `Verify published version`; `git show v0.4.0:.github/workflows/release.yml` has them), and put both back as they are after it. Both packages then carry the release's version, as before 0.4.1. The deprecation message names `npx paseo-bm@0.4.0`; if the fix must reach users, the owner reruns `npm deprecate` with the new number (a one-time password is needed).

---

*Revision 2026-09-28: `release.yml` publishes only `paseo-bm-plugin` from `0.4.1` (the `paseo-bm` steps removed, the root package private, the lifecycle-script check covers `plugin/package.json`); §3 verifies one package and installs it on an isolated daemon; §5 goes back with `paseo plugin update --version`; new §7 for a fix of the migration command.*

*Revision 2026-09-25: rewritten as the runbook in force, following `release.yml` at HEAD (two packages, the dist-tag from the kind of version, release notes under `docs/releases/`). The first release, `0.1.0-alpha.0`, is condensed into §6; what happened in each release lives in the run records in the archive.*

*Revision 2026-09-25 (later the same day): translated to English, and step 1.3 now asks for English release notes — the language rule in `AGENTS.md` puts commit messages, the release notes and this runbook in English (request `req-20260925T045037Z`).*
