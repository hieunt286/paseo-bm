# paseo.cafe — the paseo-bm listing record

| Field | Value |
|---|---|
| ID | `cafe-listing-20260923` |
| Status | **Active** — paseo-bm is listed. The entry declares `path: "plugin-package"` and `package: "paseo-bm-plugin"`, as set by [PR #315](https://github.com/paseo-cafe/paseo-cafe/pull/315) (0.5 caveats and the bundled path, [ADR-026](../adr/ADR-026-published-plugin-is-bundled.md)), merged 2026-10-01. Earlier PRs: [#215](https://github.com/paseo-cafe/paseo-cafe/pull/215) (first listing), [#284](https://github.com/paseo-cafe/paseo-cafe/pull/284) (0.4 caveats) |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Request | `req-20260923T063441Z`: "Now I want to register my plugin on this site : https://paseo.cafe/submit , what do I need to do and what can you help me do" |
| Owner's decisions | Q3a (edit in the working tree, the owner commits), Q4a (the owner sends the screenshots), Q5a (use the draft metadata). Q1a (manifest at the repo root, no `path` declared) and Q2a (no `package` declared) **have been superseded**: the registry's CI rejected both (§4, §10), the entry declares `path: "plugin-package"` and `package: "paseo-bm-plugin"` ([ADR-009](../adr/ADR-009-payload-as-npm-package.md), [ADR-026](../adr/ADR-026-published-plugin-is-bundled.md)) |
| Sources read (2026-09-23) | `paseo-cafe/paseo-cafe`: `README.md`, `scripts/validate-registry.ts`, `scripts/scan.ts`, `src/lib/registry-schema.ts`, `registry/paseo-beads.json`; the pages `paseo.cafe/submit` and `paseo.cafe/plugins/paseo-beads` |

## 1. How paseo.cafe takes a listing

- A community directory, **not official**; the home page itself says its entries are "not reviewed, audited, or vouched for".
- A plugin is **one file** `registry/<plugin-id>.json` in the repo `github.com/paseo-cafe/paseo-cafe`. The file name must match the plugin id in kebab-case: for us that is `registry/paseo-bm.json`.
- Two ways to submit: the form at https://paseo.cafe/submit pre-fills and then opens an issue (a bot turns it into a PR), or open a PR adding the file yourself.
  **This listing goes the manual PR way.** The form requires an npm package, and it turns out their CI does too for a new listing — see §4.

## 2. The content of the file being submitted

`registry/paseo-bm.json` on paseo-cafe's default branch, as merged in [PR #315](https://github.com/paseo-cafe/paseo-cafe/pull/315) (branch `hieunt286:paseo-bm-050`):

```json
{
  "repo": "hieunt286/paseo-bm",
  "path": "plugin-package",
  "package": "paseo-bm-plugin",
  "categories": ["orchestration", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [
    "Install here or with `paseo plugin add npm:paseo-bm-plugin`; its four bm-* agent roles are created the first time you open it.",
    "Requires Paseo 0.9.0+ and the br and bv Beads CLIs (Tools & skills offers to install them); macOS or Linux only, no Windows.",
    "It asks before each grant: Paseo agent tools (given to every agent on the machine) and skills via a third-party CLI.",
    "The optional Orchestrator, started only by you, reads every paseo-bm project (secrets masked) and spends tokens on its provider.",
    "Workers run without permission prompts unless a project turns on Hold risky actions (off by default); review git diff before committing.",
    "Remove via Settings → More → Data → Remove paseo-bm's settings first, or the bm-* config and agent-tools switch stay behind."
  ],
  "submittedBy": "hieunt286"
}
```

No caveat states a version number of the product (only Paseo 0.9.0+). The `Registry admission` check of PR #315 was green after its last commit, which followed the 0.5.2 publish.

`registryEntrySchema` declares `.strict()`: it accepts only the fields `repo`, `path`, `package`, `categories`, `platforms`, `caveats`, `submittedBy`; adding an unknown field breaks it. `caveats` is at most 6 sentences, each at most 140 characters — the ones above are 126, 124, 116, 128, 136, 124 long, in order.

`categories` are free strings (`z.array(z.string().min(1))`), but `platforms` is an **enum** (`z.array(z.enum(PLATFORMS))`): the value `macos` was confirmed by a real listing already in the registry (`registry/launchd-jobs.json`), so it is lower case as above.


## 3. What their CI checks

Four gates, all in the same `Registry admission` job; the summary step `Enforce admission result` requires **all** of them green. The configuration: `path: "plugin-package"`, `package: "paseo-bm-plugin"`.

| Gate | What it checks | This listing |
|---|---|---|
| 1 | The file name is the plugin id in kebab-case, and `<path>/paseo-plugin.json` on the default branch has an `id` matching the file name | reads `plugin-package/paseo-plugin.json`, `id` is `paseo-bm` |
| 2 | `plugin-security/targets.ts`: a **new** listing that declares no `package` throws right away (§4) | declares `paseo-bm-plugin` |
| 3 | `validate-registry.ts` downloads the npm tarball, requires `paseo-plugin.json` **at the tarball root**, a matching `name`, a `version` matching npm and matching `<path>/package.json` on Git | the tarball root is `plugin-package/`, which has the manifest; the versions are kept in sync by the build and a test |
| 4 | `plugin-security/static-scan.ts`: the plugin root must have a real runtime entry, scanning both the Git source (applying `path`) and the npm tarball root (**not** applying `path`); a graph over **200 files or 2,000,000 bytes** is refused (`scanner/incomplete`) | `plugin-package/` and the tarball root are the same bundled entries `index.client.tsx` and `index.server.ts` (§10) |

CI reads the repo's **default branch**, so everything gates 1 and 4 need must be on `main` before opening or updating the PR.

## 4. A new listing **must** declare `package`

`registryEntrySchema` does not require `package`, and `validate-registry.ts` puts the whole npm block inside `if (entry.package)` — but a third gate, `scripts/plugin-security/targets.ts`, throws for every **new** listing that declares none (the condition is `!previous && !baseIds.has(entry.id)`, so old entries are not touched):

```
error: new registry entry "paseo-bm" must declare a public npm package
    at selectPullRequestTargets (scripts/plugin-security/targets.ts:100:17)
```

(PR #215, run [35834044223](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35834044223).) The lesson still holds: reading the schema and one validator file is not enough, one CI job can have several gates. Declaring the installer package `paseo-bm` was then refused by gate 4 (§10), which led to the payload's own package `paseo-bm-plugin` ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)).

## 5. Changes in this repo

| File | Change |
|---|---|
| ~~`paseo-plugin.json` (repo root)~~ | Removed. Gate 1 reads `<path>/paseo-plugin.json` and gate 3 the tarball root, so a manifest at the repo root only makes `paseo plugin add` find a plugin that cannot load. `test/plugin-structure.test.ts` asserts the only manifests are in `plugin/` and `plugin-package/`. |
| `test/plugin-structure.test.ts` | Keeps the manifests from drifting apart |
| `README.md` | Sections named `Install` and `Limitations and warnings`, so that paseo.cafe's reader recognises the install section and the limitations section |
| `AGENTS.md` | The section "One published package" records the packaging rule and the things that break the listing |
| `plugin/images/` | The five design artboards of the 0.5 screens that the site [paseo-bm.erai.pro](https://paseo-bm.erai.pro/) shows — `01-inbox.jpg`, `02-projects.jpg`, `03-project-beads.jpg`, `04-settings-autonomy.jpg`, `05-chat-manager.jpg` — copied unchanged from `paseo-bm-site/src/assets/media` (owner's request). The build copies them to `plugin-package/images/`, which is what the scanner reads; they are not in the package's `files`, so they go into no tarball. |

## 6. What the listing page will show (`scripts/scan.ts`)

Every path is resolved against `path`, so everything is read inside `plugin-package/`:

- **Description**: `plugin-package/package.json.description`, the same as `plugin/package.json`'s — "Beads Management for Paseo: a Beads Manager agent that hands each request to a Beads Worker, with an Inbox, Projects, Settings and Tools & skills. Install from paseo.cafe or with "paseo plugin add npm:paseo-bm-plugin" (Paseo 0.9+)."
- **Version**: `plugin-package/package.json.version`, always equal to the root `package.json`.
- **Images**: the `images` folder **right under `path`**, `plugin-package/images/`, numbered so that the leading image is the Inbox. No absolute URL for an image in the README: an absolute URL is only kept if its host is on a trust list we have not been able to read. The images are in no tarball and `smoke:packed` guards that. Each image was inspected: no credential and no token; their Exif block holds only the colour space and the size; `02-projects.jpg` shows the site's own folder path (`/Users/Shared/work/self/paseo-plugins/paseo-bm-site`), as the site does.
- **Health, not all green, on purpose**: `manifestValid`, `hasReadme` (`plugin-package/README.md`), `hasLicense` (`plugin-package/LICENSE`), `updatedRecently` pass. `hasTests` does not: there is no test under `path`, and inventing a `test` script to make it green would be a fake check; the plugin is tested by the tests under `test/` at the repo root. `plugin-package/package.json` has no `scripts` at all ([ADR-026](../adr/ADR-026-published-plugin-is-bundled.md): a typecheck script would have nothing to check), so `hasTypecheckScript`, which passed while the entry pointed at `plugin/`, is expected to fail too.
- Scan schedule: the npm package every 15 minutes, the Git source every 6 hours.

## 7. Accepted risk

Closed. The risk was that the install commands the listing generates load a product without its agent roles. From 0.4.0 the plugin creates its roles itself on first use ([ADR-012](../adr/ADR-012-plugin-is-the-product.md)), so installing from the listing installs the whole product. The old text is in git.

## 8. The owner's steps

Done: the first listing (PR #215), the payload package and its trusted publisher (§12), the 0.4 caveats (PR #284), and the 0.5 caveats with the bundled path (PR #315). One check waits on an outside party: after a scan has run, open the listing page and check that the description, the version and the five images show correctly. Adding or changing images later only needs a push, not a new PR.

## 9. What every later release must keep right

The things a release **must not** get wrong, or the listing breaks silently. The short version for agents is in the section "One published package" of `AGENTS.md`; the steps are in the [release runbook](./paseo-bm-release-runbook.md).

1. **One package, from `plugin-package/`.** `release.yml` publishes only `paseo-bm-plugin`; the step `Assert the plugin version` checks `plugin/package.json` and `plugin-package/package.json` before anything reaches npm.
2. **The three version sources must not drift**: `package.json`, `plugin/package.json`, `PLUGIN_VERSION`. Gate 3 compares the version on Git with the npm version it resolves.
3. **`paseo-bm-plugin@latest` must point at the new version.** `resolveNpmPackage` reads exactly that tag. `release.yml` sets the dist-tag from the kind of version — prerelease to `next`, stable to `latest` — so a stable release needs no manual step. Pointing `next` at a stable version, or moving a tag by hand, requires an OTP and is the owner's job.
4. **Do not rename `release.yml`**: the trusted publisher configuration of **both** packages points at it by file name.
5. **The published tarball root must always be a loadable plugin within the scan budget** (200 files, 2,000,000 bytes). `smoke:packed` checks that `plugin-package/` is what the build writes, its exact contents and the budget.
6. When editing the registry entry, **Biome keeps short arrays on one line**, otherwise the job goes red before the validate step; and **check the content is non-empty before writing the file**, local or remote, with a script that stops on error (§13).

## 10. The fourth gate: the security scan requires the plugin root to **really load**

The `entrypoint/missing` rule in `scripts/plugin-security/static-scan.ts` requires **one of four files** `index.client.ts(x)` or `index.server.ts(x)` right in the plugin's root folder, and it is **blocking**. Two scans read two different folders (`scripts/plugin-security/scan.ts`):

| Scan | Folder |
|---|---|
| Git repository | `target.path ?? "."` — **does** apply `path` |
| npm package | `pluginPath: "."` — **always the tarball root**, does not apply `path` |

So the registry only accepts a plugin whose **npm package root is itself the loadable plugin**. The installer package `paseo-bm` could never pass (PR #215, run [35838506116](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35838506116)), which is why the payload became its own package ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)). The step "Scan changed plugins" sets `continue-on-error`, so it looks green in the step list; the real value is in the step "Enforce admission result".

The same scan refuses a graph over **200 files or 2,000,000 bytes** (`scanner/incomplete`). It refused 0.5.1 (250 files, about 3.5 MB, in Git and on npm; PR #315, run 36849724813), which is why the listed and published form is the bundled `plugin-package/` from 0.5.2 ([ADR-026](../adr/ADR-026-published-plugin-is-bundled.md)).

## 11. Comparing the payload with every scan rule (WP-317, before publishing)

Every rule in `scripts/plugin-security/static-scan.ts` is blocking; there is no advisory level. The rules: `manifest/missing`, `manifest/json`, `manifest/id`, `manifest/requirements` (`.paseo`, `.unknown`), `manifest/build`, `manifest/unknown:<key>`, `entrypoint/missing`, `entrypoint/legacy-index`, `boundary/unsupported-sdk-import`, `boundary/runtime-module-import`, `boundary/cross-runtime-import`, `boundary/invalid-module-location`, `scanner/symlink`, `scanner/size-limit` (2 MB per file), `scanner/incomplete`. The payload was compared with each of them before its first publish (WP-317, all passed; the table is in git). For 0.5.2, paseo.cafe's own scanner (`scanStaticFiles`) was run locally on the package: 3 files, 1,626,670 bytes, no finding ([0.5.2 release notes](../releases/paseo-bm-release-notes-0.5.2.md)).

## 12. The payload package's trusted publisher — confirmed

`npm trust list paseo-bm-plugin`, run by the owner:

```
type: github
id: c392d9f4-e672-441c-a684-01331bc8cd81
file: release.yml
repository: hieunt286/paseo-bm
permissions: publish, stage publish
```

The trusted source is GitHub Actions, the file `release.yml`, this repo, with publish permission. `npm trust list` and `npm trust github` both require an OTP (the endpoint `/-/package/<package>/trust` returns 401, and the public packument carries no trust information), so they are always the owner's job. Only the real release runs without an OTP, because `release.yml` uses OIDC.


## 13. Final state — all four gates green

Read at the step "Enforce admission result" rather than from the step list. The first green run, on PR #215, was [35854151581](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35854151581):

```
FETCH_OUTCOME: success     VALIDATE_OUTCOME: success
TARGETS_OUTCOME: success   SCAN_OUTCOME: success      PUBLISH_OUTCOME: success
```

The current entry (§2) passed `Registry admission` on PR #315 and is merged.

**A trap in an old version.** `paseo-bm@0.3.0-alpha.6` was published before the root manifest was removed, so its tarball **still has `paseo-plugin.json` at its root**: on Paseo 0.9+, `paseo plugin add npm:paseo-bm@0.3.0-alpha.6` finds a plugin and then **fails to load**; remove it with `paseo plugin remove paseo-bm`. Later versions do not have it. A published version cannot be fixed.
