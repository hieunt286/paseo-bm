# paseo-bm 0.3.0

**The first stable release**, and the first one that works with **Paseo 0.9.2**.

From this version on, the `latest` dist-tag is set by `release.yml` itself over OIDC. Until now every version was a prerelease going to `next`, and `latest` was moved by hand by the owner with `npm dist-tag add` — a step that needs a one-time password, and it has just gone away. Before this version `latest` pointed at `0.3.0-alpha.7` (measured with `npm view paseo-bm dist-tags` right before the release).

**Installing this version:** `npx paseo-bm`, or pin it with `npx paseo-bm@0.3.0`. The way you install does not change. As in every release, the two packages `paseo-bm` and `paseo-bm-plugin` carry the same version.

## The installer works with Paseo 0.9.2

Paseo 0.9.2 dropped the `cliVersion` field from `paseo daemon status --json`, and with `0.3.0-alpha.7` and every version before it the version check therefore fails. Each command suffers differently: **`install` stops right there with exit 3** (`E_PASEO_OUTPUT_UNEXPECTED`) and **writes nothing**; **`doctor` reports the daemon check as an error, carries on, and ends with exit 1**; **`uninstall` carries on without a single answer from Paseo**, so **with `--apply`** it still removes what the install record names and leaves behind only the plugin registration and that record (without `--apply`, `uninstall` only prints a preview and writes nothing). In short: on Paseo 0.9.2 you cannot install, and the other two commands run blind.

- Where `cliVersion` is missing, the installer reads `paseo --version` and takes the first line as the CLI version; the rule of [ADR-004](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/adr/ADR-004-paseo-config-mutation.md) is unchanged (the CLI must match the daemon, `>= 0.8.0`).
- Where `cliVersion` is present — that is, on Paseo 0.8 — the behaviour is **unchanged** and `paseo --version` is never called.
- If `paseo --version` is **empty**, it still stops with `E_PASEO_OUTPUT_UNEXPECTED` (naming `cliVersion`); if `paseo --version` **fails** (a non-zero exit code), the CLI's own error surfaces under `E_DAEMON_UNREACHABLE`. For `install`, both paths are exit 3 and **write nothing**; `doctor` and `uninstall` react as described above.

If you are running Paseo 0.9.x, this is the reason to move up to this version.

## The interface: a kanban by status, quiet text, Setup in tabs, an error count

- **The Beads screen is four kanban columns** — In progress → Blocked → Ready → Closed, each column headed by its name and count, and an empty column still shows, so the layout does not jump when you filter. A wide window puts the columns side by side; a phone and a narrow window show one column at a time, chosen from a row of status tabs that a screen reader can read. No feature is lost in the narrow layout.
- **Closed beads are shown by default.** Closed is a column like any other; the eye button still hides and shows it with its count, remembers that for the app session, and returns to the default (shown) after a reload.
- **Status speaks in words, not in colour.** Everywhere a bead is shown — the Beads screen, the "Beads" tab, the "Beads in this chat" panel, the bead chips in chat cards, the numbers on the workspace row — status uses text and contrast alone: unfinished in the normal text colour, closed in a dimmed one. No orange, no red, no green; the chip still spells out Ready / In progress / Blocked / Closed, so status is never carried by colour alone.
- **Outside the places that show beads, colour is untouched**: the red error lines and yellow warnings on Metric, on Setup, in the chat cards and in the fallback cards are unchanged — a real failure must still hit you in the eye.
- **Setup is split into three tabs**: Beads tools (`br`, `bv`), Agent skills, Agents (Roles & models + Additional instructions). The overall status line and the warnings about the tools sit **above** the tab row, so no tab can hide a problem.
- **The "Errors" tile on the Metric screen** counts how many times a request failed, whatever the reason: a turn that ended `failed`, an agent that ended in the `error` state, and every provider fallback incident. Each death is counted once, even when several sources record it.
- **The result line of the three bead actions** (Assign a Worker / Close / Delete) survives the bead moving to another column on the next refresh; only an open confirmation card closes.

## One change on the release path

- `release.yml` **accepts a version that is not a prerelease** and sets the dist-tag from the kind of version: prerelease → `next`, stable → `latest`. Before this version the workflow refused every stable version outright and only ever set `next`.
- Because `npm publish --tag latest` runs over OIDC in the same run, a stable version no longer needs the `npm dist-tag add` step that asks for a one-time password.
- The GitHub Release's `prerelease` flag must agree with the shape of the version; flag it wrongly and the workflow goes red before anything is published. Everything else is unchanged: two packages at one version, provenance, the `release.yml` file name, the whole check matrix.

## What to know when upgrading

- **`next` still points at `0.3.0-alpha.7`**, which is older than `latest`. That is ordinary npm semantics: `next` is where a prerelease goes. If you use `npx paseo-bm@next` and want the stable version, use `npx paseo-bm` or pin `@0.3.0`.
- **No configuration, data or protocol change.** `~/.paseo-bm/`, `install.json`, the `bm-*` roles and their tools keep their shape; no error code and no exit code changed.
- **A Manager opened earlier keeps working as it did.** As the `0.3.0-alpha.7` notes said, Paseo does not let a plugin change an agent that already exists; that is unchanged here.
- After installing, remember to **reload the plugin** (or let the installer do it) for the new screens to take effect.

## Rollback

The project's way back is **to release a `0.3.1` patch**, not `npm unpublish`.

Going back locally with `npx paseo-bm@0.3.0-alpha.7` only works **if you are on Paseo 0.8**: on Paseo 0.9.2 that version cannot install — `install` stops with exit 3, as the first section says. Apart from that installer fix, `0.3.0-alpha.7` is missing only the interface work above and none of the core features (the `BM-*` block-building tools, the question ledger and the provider fallback are all there).

## Evidence

`npm run verify` exited 0 on exactly the tagged tree, run in a clean git worktree of that commit: **124 test files, 3052 tests passing**, build successful. On GitHub this version also went through the macOS + Linux × Node 24 matrix with `smoke:packed` twice — once as a rehearsal and once for the release event itself — and was then published over OIDC with provenance.

## Sources

[PRD delta REQ-069](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/product/paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) · [design delta kanban-quiet-colours](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/design/paseo-bm-delta-20260925-kanban-quiet-colours.md) · [design delta stable-release](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/design/paseo-bm-delta-20260925b-stable-release.md) · [the 0.3.0 release plan delta](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/plans/paseo-bm-implementation-plan-delta-20260925b-stable-release-030.md) · [ADR-009](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/adr/ADR-009-payload-as-npm-package.md)
