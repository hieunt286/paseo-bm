# Release runbook — paseo-bm

| Field | Value |
|---|---|
| Status | Active — the release process in force |
| Workflow | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — the real publish runs only on a **GitHub Release** event (`release: published`); a manual run (`workflow_dispatch`) is a rehearsal and stops at `npm publish --dry-run` |
| Packages | `paseo-bm` (the installer) and `paseo-bm-plugin` (the payload in `plugin/`), at **the same version**, from the same run |
| Dist-tag | The workflow picks it from the version: with a `-` (a prerelease, `0.4.0-alpha.0` for instance) → `next`; without one (stable, `0.4.0` for instance) → `latest` |
| Release notes | `docs/releases/paseo-bm-release-notes-<version>.md`, used as the body of the GitHub Release |
| Underlying decisions | [ADR-009](../adr/ADR-009-payload-as-npm-package.md) (two packages); [design delta 20260925b](../archive/design/paseo-bm-delta-20260925b-stable-release.md) §2 (the dist-tag follows the kind of version) |

## 0. Rules that do not change

- **Authentication is OIDC** (trusted publishing): there is no `NPM_TOKEN` and no other secret. The trusted publisher of **both** packages points at the file name `release.yml` — do not rename it and do not move it.
- **The GitHub Release is the approval point.** After 72 hours there is no `unpublish`; the way back is always to release a patch.
- **An agent never logs in to npm and never touches the owner's credentials.** The npm account has 2FA at `auth-and-writes`, so every write outside `release.yml` (`npm publish` by hand, `npm trust …`, `npm dist-tag add …`) asks for a one-time password and is the owner's job. Letting an agent try failed three times (2026-09-23).
- **Three version sources must agree**: `package.json`, `plugin/package.json`, `plugin/shared/version.ts` (`PLUGIN_VERSION`). The last two are generated from the first by `npm run build`; the workflow's `Assert both packages agree` step stops the run before anything reaches npm. Why: [the paseo.cafe record](./paseo-bm-cafe-listing-20260923.md) §9.
- No `preinstall` / `install` / `postinstall` in `package.json`; the workflow checks it.

## 1. Preparation (an agent can do this)

1. **Pick the number.** A prerelease → `next`, a stable version → `latest`. `test/plugin-role-labels.test.ts` pins the payload's minor version (`0.3.`); changing the minor means fixing that check in the same commit.
2. **Change the version, then build, before verifying**:
   ```bash
   npm version <version> --no-git-tag-version
   npm run build          # writes plugin/package.json and PLUGIN_VERSION
   npm run verify         # typecheck, typecheck:plugin, lint, test, build
   ```
   Verifying before building, after a version change, goes red because the two generated sources do not agree yet.
3. **Write the release notes** at `docs/releases/paseo-bm-release-notes-<version>.md`, **in English**, following the shape of the most recent one: what this version brings, what to know when upgrading, rollback, evidence, sources. Name every change in the behaviour of the agents (`plugin/roles/*.md`) and of the installer.
4. **Verify on exactly the tree that will be tagged.** If the working tree holds another session's unfinished work, measure in a clean worktree:
   ```bash
   WT=$(mktemp -d) && git worktree add --detach "$WT" <commit>
   ln -s "$PWD/node_modules" "$WT/node_modules" && (cd "$WT" && npm run verify)
   git worktree remove "$WT"
   ```
5. **Commit** `chore(release): <version>`, push `main`, wait for `ci.yml` to go green (Node 22, ubuntu).
6. **Rehearse** `release.yml` on `main`:
   ```bash
   gh workflow run release.yml -f tag=v<version>
   ```
   It passes when: both jobs `verify (ubuntu-latest, node 24)` and `verify (macos-latest, node 24)` are green, including `Smoke test packed package`; the log holds `Dry-run publish of paseo-bm@<version> with dist-tag <next|latest>` and the same line for `paseo-bm-plugin`; and the four real publish/verify steps are `skipped`. A rehearsal does not prove the registry accepts the dist-tag — `--dry-run` never asks the registry.
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

Follow the run of the `release` event: the checks, `smoke:packed`, `Assert both packages agree`, the two dry-run steps, then `Publish to npm` (`paseo-bm`) → `Publish payload to npm` (`paseo-bm-plugin`) → `Verify published version` → `Verify published payload` (each waits up to 5 minutes, because npm answers "being processed").

## 3. Verification

```bash
npm view paseo-bm version && npm view paseo-bm-plugin version
npm view paseo-bm dist-tags && npm view paseo-bm-plugin dist-tags
npm view paseo-bm dist.attestations && npm view paseo-bm-plugin dist.attestations   # SLSA provenance v1
cd "$(mktemp -d)" && npx --yes paseo-bm@<version> --version
```

It passes when both packages are at `<version>`, the dist-tag matches the kind of version (`next` or `latest`) on **both** packages, and the attestations are there. Record the evidence (the run number, the output) in the close reason of the release bead.

## 4. After the release

- **A stable release does not move `next`.** `next` still points at the last prerelease. To make `npx paseo-bm@next` give the stable version, the owner runs (a one-time password is needed): `npm dist-tag add paseo-bm@<version> next` and `npm dist-tag add paseo-bm-plugin@<version> next`. Those two commands are also the fallback if `latest` does not move after a publish.
- **paseo.cafe**: if a caveat of the `registry/paseo-bm.json` entry names the number or the kind of version, fix it as [the listing record](./paseo-bm-cafe-listing-20260923.md) §9 says (Biome keeps a short array on one line; check the content is non-empty before writing it).
- The real dist-tag state is always read with `npm view <package> dist-tags`, never copied into a document.

## 5. The way back

Release a patch (`<major>.<minor>.<patch+1>` or `-alpha.<n+1>`); never `npm unpublish`. A user who needs to go back right away uses `npx paseo-bm@<previous version>`; the release notes say which Paseo versions the previous release still runs on (`0.3.0-alpha.7` cannot install on Paseo 0.9.2, for instance).

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

---

*Revision 2026-09-25: rewritten as the runbook in force, following `release.yml` at HEAD (two packages, the dist-tag from the kind of version, release notes under `docs/releases/`). The first release, `0.1.0-alpha.0`, is condensed into §6; what happened in each release lives in the run records in the archive.*

*Revision 2026-09-25 (later the same day): translated to English, and step 1.3 now asks for English release notes — the language rule in `AGENTS.md` puts commit messages, the release notes and this runbook in English (request `req-20260925T045037Z`).*
