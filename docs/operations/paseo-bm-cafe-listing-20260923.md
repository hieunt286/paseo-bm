# paseo.cafe — the paseo-bm listing record

| Field | Value |
|---|---|
| ID | `cafe-listing-20260923` |
| Status | **Active** — paseo-bm is listed: [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) merged 2026-09-25. Caveats rewritten for 0.4 in [PR #284](https://github.com/paseo-cafe/paseo-cafe/pull/284), merged 2026-09-28 |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Request | `req-20260923T063441Z`: "Now I want to register my plugin on this site : https://paseo.cafe/submit , what do I need to do and what can you help me do" |
| Owner's decisions | Q3a (edit in the working tree, the owner commits), Q4a (the owner sends the screenshots), Q5a (use the draft metadata). Q1a (manifest at the repo root, no `path` declared) and Q2a (no `package` declared) **have been superseded**: the registry's CI rejected both (§4, §10), the entry now declares `path: "plugin"` and `package: "paseo-bm-plugin"` ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)) |
| Sources read (2026-09-23) | `paseo-cafe/paseo-cafe`: `README.md`, `scripts/validate-registry.ts`, `scripts/scan.ts`, `src/lib/registry-schema.ts`, `registry/paseo-beads.json`; the pages `paseo.cafe/submit` and `paseo.cafe/plugins/paseo-beads` |

## 1. How paseo.cafe takes a listing

- A community directory, **not official**; the home page itself says its entries are "not reviewed, audited, or vouched for".
- A plugin is **one file** `registry/<plugin-id>.json` in the repo `github.com/paseo-cafe/paseo-cafe`. The file name must match the plugin id in kebab-case: for us that is `registry/paseo-bm.json`.
- Two ways to submit: the form at https://paseo.cafe/submit pre-fills and then opens an issue (a bot turns it into a PR), or open a PR adding the file yourself.
  **This listing goes the manual PR way.** The form requires an npm package, and it turns out their CI does too for a new listing — see §4.

## 2. The content of the file being submitted

Branch `hieunt286:paseo-bm-caveats-040` ([PR #284](https://github.com/paseo-cafe/paseo-cafe/pull/284), 2026-09-28), which changes only `caveats` compared with the version merged in PR #215:

```json
{
  "repo": "hieunt286/paseo-bm",
  "path": "plugin",
  "package": "paseo-bm-plugin",
  "categories": ["orchestration", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [
    "Install from this page or with `paseo plugin add npm:paseo-bm-plugin`; the three bm-* agent roles are created the first time you open it.",
    "Requires Paseo 0.9.0+ and the br and bv Beads CLIs (Setup offers to install them). macOS or Linux only, no Windows.",
    "Setup asks before each grant: Paseo agent tools (given to every agent on the machine) and skills via a third-party CLI.",
    "Removing the plugin without Setup → Remove paseo-bm's settings leaves the bm-* config and the agent-tools switch behind.",
    "Installed with npx paseo-bm before? Installing here fails (\"already configured\") until you run `npx paseo-bm@0.4.0` once.",
    "The Worker runs without permission prompts; its limits are role instructions only, so review git diff before you commit."
  ],
  "submittedBy": "hieunt286"
}
```

The owner approved the content on 2026-09-28. No sentence states a version number of the product any more (only Paseo 0.9.0+ and the migration command `npx paseo-bm@0.4.0`, both fixed). CI of PR #284: `Registry admission` with `FETCH/VALIDATE/TARGETS/SCAN/PUBLISH_OUTCOME` all `success`; their scan report: `paseo-bm-plugin` 0.4.1 `passed`, 0 blocking, 0 advisory. Before pushing: `bunx biome check --error-on-warnings` clean and `validate-registry.ts` passing locally; the file was written by a script that stops on error and checks that the content is not empty (§13).

The 0.3.x version (PR #215) said `npx paseo-bm` was the only install path and that installing from this page lacked the roles; from 0.4.0 neither is true any more (ADR-012).

`registryEntrySchema` declares `.strict()`: it accepts only the fields `repo`, `path`, `package`, `categories`, `platforms`, `caveats`, `submittedBy`; adding an unknown field breaks it. `caveats` is at most 6 sentences, each at most 140 characters — the ones above are 137, 115, 119, 120, 121, 120 long, in order.

`categories` are free strings (`z.array(z.string().min(1))`), but `platforms` is an **enum** (`z.array(z.enum(PLATFORMS))`): the value `macos` was confirmed by a real listing already in the registry (`registry/launchd-jobs.json`), so it is lower case as above.


## 3. What their CI checks

Four gates, and the final listing passes all four (§13). The configuration being submitted: `path: "plugin"`, `package: "paseo-bm-plugin"`.

| Gate | What it checks | This listing |
|---|---|---|
| 1 | The file name is the plugin id in kebab-case, and `<path>/paseo-plugin.json` on the default branch has an `id` matching the file name | reads `plugin/paseo-plugin.json`, `id` is `paseo-bm` — pass |
| 2 | `plugin-security/targets.ts` line 99: a **new** listing that declares no `package` throws right away | declares `paseo-bm-plugin` — pass (§4 tells why we once failed) |
| 3 | `validate-registry.ts` downloads the npm tarball, requires `paseo-plugin.json` **at the tarball root**, a matching `name`, a `version` matching npm and matching `<path>/package.json` on Git | the payload package root has the manifest; the three versions are kept in sync by a generator and a test — pass |
| 4 | `plugin-security/static-scan.ts`: the plugin root must have a real runtime entry, scanning both the Git source (applying `path`) and the npm tarball root (**not** applying `path`) | `plugin/` and the payload package root both have `index.client.tsx` and `index.server.ts` — pass (§10 tells why we once failed, §11 is the comparison table before publishing) |

The four gates are in the same `Registry admission` job, and the summary step `Enforce admission result` requires **all** of them green. CI reads the repo's **default branch**, so everything gates 1 and 4 need must be on `main` before opening or updating the PR.

## 4. A new listing **must** declare `package`

**Correction 2026-09-23, after the real PR was blocked by CI.** The first version of this document said `package` was optional, based on `registryEntrySchema` (`package` not required) and on `validate-registry.ts` (the whole npm block is inside `if (entry.package)`). That is right for those two places, but **a third gate was missed**: `scripts/plugin-security/targets.ts` line 99 throws for every new listing that declares no `package`, and the `Registry admission` job requires that step to be green.

Evidence: PR [paseo-cafe/paseo-cafe#215](https://github.com/paseo-cafe/paseo-cafe/pull/215), run [35834044223](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35834044223) — `VALIDATE_OUTCOME: success` (§3 of this document was right: a manifest at the repo root is accepted), but `TARGETS_OUTCOME: failure` with

```
error: new registry entry "paseo-bm" must declare a public npm package
    at selectPullRequestTargets (scripts/plugin-security/targets.ts:100:17)
```

An old listing that declares no `package` (for example some entry already in the registry) is not touched: the condition is `!previous && !baseIds.has(entry.id)`, that is, it only applies to new entries.

The consequence at that time: to get a listing, `package` **had to** be declared. The next conclusion of this version — "declare `paseo-bm` then add the manifest to the `files` of the installer package" — **was rejected by gate 4 itself an hour later**: see §10. The final path was to publish the payload as its own package `paseo-bm-plugin` and declare that package ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)). This section is kept because it records a lesson that still holds: reading the schema and one validator file is not enough, one CI job can have several gates.

## 5. Changes in this repo

| File | Change |
|---|---|
| ~~`paseo-plugin.json` (repo root)~~ | **Removed 2026-09-23** together with its check. It was created for the option where the entry points at the repo root; since the entry declares `path: "plugin"`, gate 1 reads `plugin/paseo-plugin.json`, gate 3 reads the payload package's tarball root, and a manifest at the root only makes `paseo plugin add` find a plugin that then dies for lack of a runtime entry. A test now asserts the repo has only **one** manifest. |
| `test/plugin-structure.test.ts` | Added a test that keeps the two manifests from drifting apart |
| `README.md` | Renamed the section `Quick start` to `Install` and `Before you install` to `Limitations and warnings`, so that paseo.cafe's reader recognises the install section and the limitations section. The content did not change, so REQ-015 did not change. |
| `AGENTS.md` | **Final state:** the section "Two packages, one release" records the two-package rule and the five things that break the listing; the "Repository layout" block matches the real directory tree. The three lines describing the root manifest were removed together with the file itself (§10, WP-321a). |
| `plugin/images/` | Since 2026-10-01 (owner's request): the five images the site [paseo-bm.erai.pro](https://paseo-bm.erai.pro/) shows on its home page, the design artboards of the 0.5 screens — `01-inbox.jpg`, `02-projects.jpg`, `03-project-beads.jpg`, `04-settings-autonomy.jpg`, `05-chat-manager.jpg` — copied unchanged from `paseo-bm-site/src/assets/media` (`m-13`, `m-14`, `m-15`, `m-17`, `m-19`). Until then: three screenshots of 0.3 (the Beads screen, the Metric screen, the installer), provided by the owner (Q4a). **Moved from `images/` at the repo root into `plugin/` on 2026-09-23** when the entry changed to `path: "plugin"`; not in the `files` of the payload package and excluded from the installer package by a negative pattern, so it goes into no tarball. |

## 6. What the listing page will show (`scripts/scan.ts`)

Every path is resolved against `path`, and the listing declares `path: "plugin"`, so everything is read inside `plugin/`:

- **Description**: `plugin/package.json.description` — "Beads Management for Paseo — the plugin payload: the Metric, Beads and Setup screens plus the agent role instructions. Install with npx paseo-bm, which also registers the three agent roles."
- **Version**: `plugin/package.json.version`, always equal to the installer package (`0.3.0` when checked).
- **Images**: the scanner reads the `images` folder **right under `path`**, that is `plugin/images/` — the images were moved there, numbered to fix the order so that the leading image is the Inbox. No absolute URL for an image in the README: an absolute URL is only kept if its host is on a trust list we have not been able to read. The images are in no tarball and `smoke:packed` guards that. Each image was inspected: no credential and no token; their Exif block holds only the colour space and the size; `02-projects.jpg` shows the site's own folder path (`/Users/Shared/work/self/paseo-plugins/paseo-bm-site`), as the site does.
- **Health, 5/6 passing, on purpose**: `manifestValid`, `hasReadme` (`plugin/README.md`), `hasLicense` (`plugin/LICENSE`, and even without the file the repo's license would be enough), `hasTypecheckScript`, `updatedRecently` — pass. `hasTests` **does not pass**: there is no test in `plugin/`, and inventing a `test` script to make this item green would be making a check look green. The payload is still really tested by the tests under `test/` at the repo root; they just are not under `path`.
- Scan schedule: the npm package every 15 minutes, the Git source every 6 hours.

## 7. Accepted risk

The listing page generates direct install commands on its own: `paseo plugin add npm:paseo-bm-plugin@<version>` for Paseo 0.9+, and `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin` for 0.8. Since the payload package exists, **both commands load** — but they load a product **missing the three roles** `bm-manager`, `bm-worker`, `bm-reviewer`, because the installer is the one that registers them (ADR-006). Beads Manager then cannot create a Worker.

This is a consciously accepted risk, and caveats number 1 and number 2 say both halves plainly: `npx paseo-bm` is the only supported install method, and a direct install brings up the screens but lacks the roles.

*(The previous version of this section described a different risk — the generated command **failing to load**, because the listing at that time pointed at the repo root, where there was a manifest but no runtime entry. The owner had chosen that option in Q1a, precisely because "one big, clear error" is easier to understand than "a half-working product". Gate 4 of the registry rejected that option, so we are now in exactly that half-working state — and pay for it with two caveats that say so clearly. The real way out is still the same: let the payload register the roles itself the first time, a separate request the owner decided in Q12 b.)*

## 8. The owner's steps

1. ~~Commit the changes of §5 and push them to the default branch `main`~~ — **done 2026-09-23**, `main` at `5c7daa5`, the repo's CI green (run 35832961123).
2. ~~Fork `paseo-cafe/paseo-cafe`, add `registry/paseo-bm.json`, open a PR~~ — **done**: [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) from the branch `hieunt286:add-paseo-bm`. At that time **red** because of §4 and then §10; now green, see step 3 and §13.
3. ~~Release a new version then update the listing~~ — **done 2026-09-23**: `0.3.0-alpha.6` published both packages, the listing moved to `path: "plugin"` + `package: "paseo-bm-plugin"`, and `Registry admission` is green on all four gates (§13). Three commands needing an OTP were run by the owner: the placeholder release, `npm trust github`, and two runs of `npm dist-tag add`.
4. ~~Fix the caveat when moving to the stable release~~ — **done 2026-09-25**: commit `d2213653` on the PR branch (+1/−1, caveat number 3), comment on PR #215.
5. After the PR is merged and the next scan has run, open the listing page and check that the three images in `plugin/images/` show correctly — this is the only check that has to wait on an outside party, so it lives here and not in the bead's criteria. Adding or changing images later only needs a push, not a new PR.

## 9. What every later release must keep right

No longer a to-do list — phase 2a-20 has finished it. These are the things a release **must not** get wrong, or the listing breaks silently. The short version for agents is in the section "Two packages, one release" of `AGENTS.md`.

1. **Two packages, one version.** `release.yml` publishes `paseo-bm` then `paseo-bm-plugin` in the same run; the step "Assert both packages agree" blocks before anything reaches npm.
2. **The three version sources must not drift**: `package.json`, `plugin/package.json`, `PLUGIN_VERSION`. Gate 3 compares the version on Git with the npm version it resolves.
3. **`paseo-bm-plugin@latest` must point at the new version.** `resolveNpmPackage` reads exactly that tag. Since `0.3.0`, `release.yml` sets the dist-tag from the kind of version on its own — prerelease to `next`, stable to `latest` — so a stable release needs no manual step. Pointing `next` at a stable version, or moving a tag by hand, still requires an OTP and is still the owner's job.
4. **Do not rename `release.yml`**: the trusted publisher configuration of **both** packages points at it by file name.
5. **The installer package's tarball root must not look like a plugin**, and the payload package's root must always be a loadable plugin — `smoke:packed` guards both directions.
6. When editing the registry listing, remember that **Biome keeps short arrays on one line**, otherwise the job goes red right away, before even the validate step.

## 10. The fourth gate: the security scan requires the plugin root to **really load**

After declaring `package`, the second run of `Registry admission` (run [35838506116](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35838506116)) gave: `VALIDATE_OUTCOME: success`, `TARGETS_OUTCOME: success` — the two old gates passed — but `SCAN_OUTCOME: failure`. The step "Scan changed plugins" sets `continue-on-error`, so looking at the step list it seems green; the real value is in the step "Enforce admission result".

The report the bot pasted into the PR:

```
## paseo-bm
Status: failed          Blocking findings: 1
- [entrypoint] missing . plugin has no Paseo 0.8 runtime entry
npm package: paseo-bm   npm status: failed   npm version: 0.3.0-alpha.5
- [npm/entrypoint] missing . plugin has no Paseo 0.8 runtime entry
```

The `entrypoint/missing` rule in `scripts/plugin-security/static-scan.ts` requires **one of four files** `index.client.ts(x)` or `index.server.ts(x)` right in the plugin's root folder, and it is **blocking**.

Two scans, two different folders (`scripts/plugin-security/scan.ts`):

| Scan | Folder | Line |
|---|---|---|
| Git repository | `target.path ?? "."` — **does** apply `path` | 229 |
| npm package | `pluginPath: "."` — **always the tarball root**, does not apply `path` | 322 |

The consequence, and this is the real blocker of this whole request:

- Declaring `path: "plugin"` makes the Git scan pass, because `plugin/` has `index.client.tsx`, `index.server.ts` and the manifest.
- But the npm scan can **never** pass with the `paseo-bm` package, because the package root is the installer, not the payload. Adding the manifest to the tarball root (0.3.0-alpha.5) does not save it: it requires a **runtime entry**, not a manifest.
- And dropping `package` is not possible either, because of §4: a new listing must declare it.

In other words, the registry only accepts a plugin whose **npm package root is itself the loadable payload**. That is the shape of `@omercnet/paseo-beads` (the repo has a `path`, a separate npm package for the payload). paseo-bm does not currently have that shape, and this is a packaging decision of the product, not a small fix — see ADR-001.

Their review bot (CodeRabbit) also independently raised exactly the concern in our two caveats: "The registry's generated install command cannot load Paseo BM, so users must use its separate `npx paseo-bm` installer."

## 11. Comparing the payload with every scan rule (WP-317, before publishing)

Measured on 2026-09-23 on `plugin/` in its final state (with `package.json`, `README.md`, `LICENSE`, `images/`). Source of the rules: `scripts/plugin-security/static-scan.ts` — **every** rule is blocking, there is no advisory level.

| Rule | Evidence | Result |
|---|---|---|
| `manifest/missing`, `manifest/json` | `plugin/paseo-plugin.json` parses | pass |
| `manifest/id` | `id` is `paseo-bm`, matching `PLUGIN_ID = /^[a-z][a-z0-9-]*$/` and matching the listing file name `registry/paseo-bm.json` | pass |
| `manifest/requirements`, `.paseo`, `.unknown` | the top-level keys are only `id` and `requirements`; `requirements` has only `paseo` at `>=0.8.0` | pass |
| `manifest/build` | no `build` declared | pass |
| `manifest/unknown:<key>` | no unknown key | pass |
| `entrypoint/missing` | `index.client.tsx` and `index.server.ts` right at the root of `plugin/` | pass |
| `entrypoint/legacy-index` | no `index.ts` or `index.tsx` at the payload root (count: 0) | pass |
| `boundary/unsupported-sdk-import` | subpaths used: `@getpaseo/plugin`, `/client`, `/client/react-native`, `/server` — all four are in their `SUPPORTED_SDK`; number of subpaths outside the list: 0 | pass |
| `boundary/runtime-module-import` | `node:` builtins outside `server/`: 0 files; server-only SDK outside `server/`: 0; client-only modules (`react`, `react-dom`, `react-native`, `use-sync-external-store`, `@tanstack/react-query`) outside `client/`: 0 | pass |
| `boundary/cross-runtime-import` | `test/plugin-structure.test.ts` already guards it: the client does not reach into `server/`, the server does not reach into `client/`, `shared/` imports neither Node nor react-native — run in `npm run verify` | pass |
| `boundary/invalid-module-location` | every relative import resolves inside `client/`, `server/`, `shared/` or the same folder | pass |
| `scanner/symlink` | `find plugin -type l`: 0 | pass |
| `scanner/size-limit` (2 MB) | the largest file is `plugin/images/02-metric-request.jpg` at 154.8 KB; number of files over 2 MB: 0 | pass |
| `scanner/incomplete` | nothing blocks reading: no symlink, no huge file, no `node_modules` in the payload | pass |

**No rule is red**, so under the owner's decision Q15 a the work moves on to the release step. This is still reading the rules plus measuring in place, not running their scanner itself — the final evidence is still the `Registry admission` run after publishing.

## 12. The payload package's trusted publisher — confirmed

The bead `bm-phase-2a-20-x3g0.6` was closed while this part was still only the owner's word: `npm trust list` requires an OTP, the endpoint `/-/package/<package>/trust` returns 401, and the public packument carries no trust information — all three ways were tried. The owner ran the command and pasted the result right afterwards:

```
type: github
id: c392d9f4-e672-441c-a684-01331bc8cd81
file: release.yml
repository: hieunt286/paseo-bm
permissions: publish, stage publish
```

Exactly what is needed: the trusted source is GitHub Actions, the right file `release.yml`, the right repo, with publish permission. So the half of the risk "the installer package publishes and then the payload package fails" is no longer an unknown before the release.

**Noted for next time:** `npm trust list` and `npm trust github` both require an OTP, so they are always the owner's job, like the placeholder release. Only the real release runs without an OTP, because `release.yml` uses OIDC.


## 13. Final state — all four gates green

Run [35854151581](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35854151581) on PR #215, read at the step "Enforce admission result" rather than from the step list:

```
FETCH_OUTCOME: success     VALIDATE_OUTCOME: success
TARGETS_OUTCOME: success   SCAN_OUTCOME: success      PUBLISH_OUTCOME: success
```

The listing being submitted: `path: "plugin"`, `package: "paseo-bm-plugin"`, six caveats. The PR is `MERGEABLE`, waiting for a maintainer to review and merge — the rest is outside this repo's reach.

Two mistakes of the Worker on the PR branch, recorded to avoid them next time: one commit overwrote the file with 0 bytes, because a step in the command failed and the command chain kept going (from now on: check the file has content **before** calling the write API); and one commit had the wrong formatting, because `json.dumps` expanded short arrays onto several lines while their Biome keeps short arrays on one line.

**A remaining trap in an old version.** `paseo-bm@0.3.0-alpha.6` was published from `e7424cb`, before the commit `4b444b5` that removed the root manifest, so its tarball **still has `paseo-plugin.json` at its root**: on Paseo 0.9+, `paseo plugin add npm:paseo-bm@0.3.0-alpha.6` finds a plugin and then **fails to load**; remove it with `paseo plugin remove paseo-bm`. From `0.3.0-alpha.7` on (including `latest` = `0.3.0`) this is gone, and `smoke:packed` already guards it. A published version cannot be fixed.

What remains after the merge, not part of this phase: open the listing page and check that the description, the version and the three images show correctly; the scan schedule is 15 minutes for the npm source and 6 hours for the Git source.

---

*Revision 2026-09-25: Status, the decisions still in force, §2 (the real entry on the PR branch after fixing the caveat for `0.3.0`), §6, §8 and the trap in §13 updated to the current state. §4 and §10 are kept because they record the reasons for the configuration in use.*

*Revision 2026-09-28: Status (PR #215 merged; PR #284 rewrites the caveats for 0.4) and §2 (new content, lengths, CI result). The paragraph explaining the two old caveats about `npx paseo-bm` was removed because it is no longer true.*

*Revision 2026-09-30: Status — PR #284 merged 2026-09-28.*

*Revision 2026-10-01: §5 and §6 — the listing images are now the site's five design artboards of the 0.5 screens, led by the Inbox (owner's request).*

*Revision 2026-10-01 (later): the scan refused 0.5.1 (`scanner/incomplete`: 250 files, 3.5 MB against 200 files and 2,000,000 bytes, in Git and on npm; [PR #315](https://github.com/paseo-cafe/paseo-cafe/pull/315), run 36849724813). From 0.5.2 the listed and published form is `plugin-package/`, the bundled entries ([ADR-026](../adr/ADR-026-published-plugin-is-bundled.md)); PR #315 changes the entry's `path` to `"plugin-package"` together with the 0.5 caveats. Where §2, §5 and §6 say `plugin/`, read `plugin-package/` for what the scanner reads; the images are copied there from `plugin/images/` by the build.*
