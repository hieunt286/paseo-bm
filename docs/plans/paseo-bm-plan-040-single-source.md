# Implementation Plan — 0.4.0: a single source, the plugin from paseo.cafe is the whole product

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-25 — hieu.nt10 (independent review; D1 settled: keep `ui/setup-state.json` when deleting data) |
| Owner | hieu.nt10 |
| Phase | **Phase 0.4.0 — Single source** |
| Decision | [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (Accepted 2026-09-25) |
| Requirements | [PRD](../product/paseo-bm-prd.md) REQ-001 → REQ-015, REQ-027, REQ-031, REQ-070 (0.4.0 version, currently marked *Not implemented yet*) |
| Technical Design | [paseo-bm.md](../design/paseo-bm.md) §3, §4, §5, §6, §7.3, §7.12, §7.13, §9, §11, §12, §13 · [paseo-bm-dashboard.md](../design/paseo-bm-dashboard.md) §11.3 |
| Background analysis | Comparison table of the installer's 27 jobs (2026-09-25), summarised in the Context section of ADR-012 |

## 0. Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** change to a public contract (drop the `paseo-bm` CLI, change the install path); writes to the user's Paseo config (creating roles, granting tools to every agent, cleaning up config); consent boundary (running a third-party CLI, installing tools from the network); release and the two-package rule; overturning ADR-001, ADR-009 and amending ADR-002/003/004/006/008; a change in another repository (the paseo.cafe registry entry); an npm publish that cannot be rolled back (R3).
- **Artifacts and gates:** ADR-012 (Accepted); the PRD and both designs edited in place; this plan + `plan-ready-for-beads`; beads via `converting-plan-to-beads`; `feature-done` profile standard.
- **Execution path:** plan → converter.
- **Exceptions:** none.
- **Decided:** 2026-09-25 — hieu.nt10.
- **Supersedes:** none.

## 1. MVP-Lock

**In phase:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011, REQ-012, REQ-014, REQ-015, REQ-027, REQ-031, REQ-070 as in the 0.4.0 version of the PRD, together with the PRD parts rewritten for 0.4.0: REQ-035 (b) (where skills are added on Setup), REQ-062 (c), (e), REQ-063 (a), (f); REQ-006 and REQ-013 dropped per ADR-012. REQ-028 and REQ-032 (c) only change wording in the PRD, with no work in the phase.

**Out of phase:**
- Deleting the installer's old files (`~/.paseo-bm/plugin/*`, `backups/*`) by the hashes in `install.json` — design §5.4 leaves this for later.
- Opening a terminal automatically to log in to a provider — 0.4.0 only shows the command.
- Supporting Paseo 0.8.
- Renaming the packages.
- Deleting `src/` (the migration CLI) and its tests — a release after 0.4.0 (design §3.1).

**Phase exit conditions:**
1. On Paseo 0.9.2, a machine that has never had paseo-bm installs `npm:paseo-bm-plugin@0.4.0` and can then use everything: Manager creates Worker, Worker creates Reviewer, the Metric screen has traces — after exactly the steps on Setup that design §7.13 lists.
2. A machine running 0.3.1 as a directory install runs `npx paseo-bm@0.4.0` once and moves to the npm release, keeping its traces, roles and switch.
3. The "Remove paseo-bm's settings" button leaves a config with no `bm-*` entry and puts the tool-grant switch back to its previous value.
4. `paseo-bm-plugin@0.4.0` and `paseo-bm@0.4.0` on `latest`, with provenance; `paseo-bm` deprecated; the paseo.cafe entry has the new caveat; from then on `release.yml` publishes only `paseo-bm-plugin`.
5. `npm run verify` green; Q-044 → Q-047 have answers recorded in design §13.

**Default checkpoint posture:** every work package before WP-407 only changes code and documentation in the repository, undone with git. The points of no return are the npm publishes (WP-407 prerelease to `next`, WP-408 stable release to `latest`); the approval point is the GitHub Release the owner agrees to, per the [release runbook](../operations/paseo-bm-release-runbook.md). The way back for users is a patch release ≥ 0.4.0; downgrading to 0.3.x is **not** a way back, because the 0.3.x plugin does not trust the data folder when `install.json` is `schemaVersion: 2` or absent (design §12). Directory-install users whose migration fell back (`fell-back`) still run 0.3.1 as before. **R3 decision** (design §12): risk owner hieu.nt10; selective rehearsal — a prerelease on `next` plus an acceptance run on a real daemon (WP-407) before anything goes to `latest`.

## 2. Work packages

### WP-401 — The plugin owns its data folder

- **Outcome:** every store of the plugin (traces, `ui/`, `role-extras.json`, `role-fallback*.json`, the question–answer log, the answered markers, budget-told, the gate of the tool endpoint) works when there is no `install.json`: the data folder is found in the order environment variable → `home.json` pointer → default `~/.paseo-bm`, and is created when needed with mode 0700. There is a readable/writable `ui/setup-state.json` store.
- **Requirements:** REQ-004, REQ-014, REQ-008.
- **Design:** paseo-bm.md §5.1, §5.2, §5.3, §5.4, §7.11; new modules `data-home.ts` (`resolveDataHome`, `ensureDataHome`), `setup-state.ts`; error code `E_DATA_HOME_UNAVAILABLE`.
- **Prerequisites:** none.
- **Exit:** tests prove: brand-new HOME → the collector writes traces, the Dashboard RPCs return data, saving role extras and the fallback chain succeeds; HOME with an old `install.json` → the old folder is used; a `home.json` pointer to a custom folder → that folder is used; a symlink on the path is refused as `trace-store` does today.
- **Boundary:** this is the seam of existing user data — no file of an existing user is moved, renamed or deleted.

### WP-402 — The plugin creates the three roles the first time

- **Outcome:** when `bm-manager`/`bm-worker`/`bm-reviewer` is missing, the plugin creates exactly the missing entries (derived provider + profile) with the default "first usable provider, first model"; an existing entry is never modified; after the user has cleaned up the config, they are not recreated automatically.
- **Requirements:** REQ-005, REQ-009, REQ-027, REQ-031 (a), (b), REQ-062 (c), (e).
- **Design:** paseo-bm.md §6.1, §6.2 (`createRoleEntries`, new scope rule), §7.3 (`manager.ensure` + `setupNotice`), §7.12, §7.13.1, §7.13.2 (`setup.ensure-roles` / `setupEnsureRolesRpc`, `setup-roles.ts`, `E_SETUP_ROLES_FAILED`); paseo-bm-dashboard.md §11.2 (the status strip shows `setupNotice`).
- **Prerequisites:** WP-401 (needs `setup-state.json` to record `rolesCreated`, `cleanedUpAt`).
- **Exit:** tests with a fake SDK: empty config → the three roles are created with the right `paseoTools` per role, no `command`/`env`, profiles with `notes`; config with one role already present → only the other two roles are created; entries that are not `bm-*` are unchanged; `cleanedUpAt` has a value → nothing is created; two concurrent calls write only once (mutex + revision).

### WP-403 — Setup: machine state and the buttons that need consent

- **Outcome:** Setup shows what is still missing (roles, Paseo tool grant, provider login with the command, skills, `br`/`bv`, data folder, directory install) and lets each job that needs consent be done with a button carrying a warning: grant Paseo tools to agents (recording the previous value), install skills with the `skills` CLI. A migration banner shows when the plugin runs from a directory install.
- **Requirements:** REQ-003, REQ-007, REQ-008 (e), REQ-011, REQ-027 (b), REQ-031 (c), REQ-063 (f), REQ-070 (g).
- **Design:** paseo-bm.md §6.2 (`setAgentTools`), §7.12, §7.13 (`setup.grant-agent-tools` / `setupGrantAgentToolsRpc`, `setup.install-skills` / `setupInstallSkillsRpc`, the `setup` field of `setup.status`, `setup-machine.ts`, `SKILLS_INSTALL_TIMEOUT_MS`, `E_SETUP_WRITE_FAILED`, `E_SKILLS_PRESENT`, `E_SKILLS_INSTALL_FAILED`); paseo-bm-dashboard.md §11.3 (layout, wording, warnings).
- **Prerequisites:** WP-401 (`setup-state.json`), WP-402 (role state read from the same module).
- **Exit:** server tests: the tool-grant button writes `injectIntoAgents: true` and stores `previous`; a second press does not write again; installing skills runs the right constant command, a 300-second timeout reports an error with a code, skills are checked again after the run; `setup.status` returns all the new fields (including `logins` taking only the boolean `loggedIn`, error/timeout → `unknown`, and `install.kind`); negative tests: a call without `confirmed: true` is refused by the schema, no patch when `setup-state.json` cannot be written, no write into the skills directories. Client tests (pure model): each state shows the right line, the right sentence and the right button; no button runs before it is confirmed.
- **Boundary:** trust boundary — the warnings "every agent on the machine" and "third-party tool" must show before the press; there is no path that writes without `confirmed: true`.

### WP-404 — The button that removes paseo-bm's settings

- **Outcome:** a button on Setup deletes every `bm-*` provider and profile (including fallback aliases), puts the tool-grant switch back to its previous value if paseo-bm itself turned it on, deletes the data folder only after a second confirmation, records `cleanedUpAt`, then states the command `paseo plugin remove paseo-bm`.
- **Requirements:** REQ-012.
- **Design:** paseo-bm.md §5.3, §6.2 (`removeAllBmEntries`), §7.13 (`setup.cleanup` / `setupCleanupRpc`); paseo-bm-dashboard.md §11.3.
- **Prerequisites:** WP-401, WP-403 (the switch's previous value is recorded by WP-403).
- **Exit:** tests: after cleanup no `bm-*` entry remains, other entries are intact; a switch the user turned on themselves is left as is (`left-on`); `deleteData: false` keeps the folder; `deleteData: true` keeps `ui/setup-state.json`, and after the plugin is reloaded `ensureRoles` still returns `skipped: "cleaned-up"` (REQ-012 e); without confirmation nothing is done.

### WP-405 — Text, user documentation and the plugin manifest

- **Outcome:** no message is left that tells the user to run `npx paseo-bm install/doctor/uninstall`; `paseo-plugin.json` requires Paseo `>=0.9.0`; README, `plugin/README.md`, GUIDE describe the install path from paseo.cafe, the steps on Setup, updating with `paseo plugin update`, removal with the button then `paseo plugin remove`, and the diagnostic command when the plugin does not load.
- **Requirements:** REQ-001, REQ-002, REQ-010, REQ-015, REQ-035 (b).
- **Design:** paseo-bm.md §3.1, §7.13 (table of replacement wording), §8, §12.
- **Prerequisites:** WP-402, WP-403, WP-404 (the documentation describes the final behaviour).
- **Exit:** README and `plugin/README.md` have a section "Installed with `npx paseo-bm` before" stating the error `Plugin ID "paseo-bm" is already configured` and the command `npx paseo-bm@0.4.0` (design §4.3); `grep` finds no `npx paseo-bm install|doctor|uninstall` in `plugin/` or in the user documentation outside the migration section; the manifest test and `smoke:packed` confirm `requirements.paseo: ">=0.9.0"` in the plugin tarball; the role content tests are green (the message in Runtime facts changes).

### WP-406 — `paseo-bm` 0.4.0: a CLI only for migration

- **Outcome:** `npx paseo-bm` (and `install`, `migrate`) migrates a directory install to npm per design §4 (case A–E, fallback reinstalling the old directory, the `home.json` pointer for a custom folder, marking `install.json` `schemaVersion: 2` + `migratedTo`); `doctor`, `uninstall` and the old flags exit 2 with `E_COMMAND_RETIRED`; the installer parts no longer used are deleted along with their tests; the `paseo-bm` tarball contains only `dist/` and `smoke:packed` checks the new shape of both packages.
- **Requirements:** REQ-070, REQ-013 (dropped), REQ-014.
- **Design:** paseo-bm.md §3.1, §3.2, §4.1 → §4.6, §5.2, §11.
- **Prerequisites:** WP-401 (the `home.json` format the plugin reads).
- **Exit:** integration tests with a fake HOME and a fake `paseo` for all five cases (and a directory in `<install home>/plugin/` with no `install.json` → 5), including a successful fallback and a failed fallback, plus every exit code and `--json`; `npm run verify` green; `smoke:packed` green for the new shape of the `paseo-bm` tarball (only `dist/`, `package.json`, `README.md`, `LICENSE`).
- **Boundary:** compatibility seam with existing users — the write order (pointer first, Paseo next, `install.json` last) must not be reversed; no command deletes data or roles. In the same commit as the tarball shape change, the "Two packages, one release" table of `AGENTS.md` is updated to match (the `paseo-bm` package has only `dist/`).

### WP-407 — Trial release 0.4.0-alpha.0 to `next` and acceptance on a real daemon

- **Outcome:** `0.4.0-alpha.0` of both packages on the dist-tag `next`; the install checklist (`paseo-bm-install-checklist.md`) rewritten for 0.4.0 and passing on Paseo 0.9.2: fresh install from `npm:paseo-bm-plugin@next`, migration from 0.3.1 with `npx paseo-bm@next`, the Setup buttons, removing paseo-bm's settings; Q-044 → Q-047 have answers recorded in design §13.
- **Requirements:** every REQ in the MVP-Lock (observed evidence).
- **Design:** paseo-bm.md §11, §13; release runbook §1–§3.
- **Prerequisites:** WP-405, WP-406; the mandatory independent review of the parts in design §9 (last item) — the three new paths of `config-writer.ts`, `setup-skills.ts`, `setup.cleanup`, the migration CLI — is done and every blocking finding is closed before the prerelease is published.
- **Exit:** a run record in `docs/archive/operations/` with each item passed/failed, including: migrating both a default install and a `--home` one; after migration, `npx paseo-bm@0.3.1 install` stops with code 3 without changing anything (REQ-070 e); `paseo plugin update paseo-bm` (Q-046); removing paseo-bm's settings then `paseo plugin remove`. Q-045 (a plugin installed from npm can load `zod` and `@getpaseo/plugin`) **must pass**; if it does not, stop the phase and go back to the design. Q-047 differs from design §4.3/§4.4 → fix within WP-406's scope, release `0.4.0-alpha.<n+1>` to `next` and rerun the affected items before WP-408.
- **Boundary:** R3 — a publish to `next` cannot be rolled back; the acceptance run happens on the owner's machine and so changes the real config: the owner consents first, the config is recorded before the run and restored after (as the earlier acceptance runs did).

### WP-408 — Release 0.4.0, update paseo.cafe, close the two-package rule

- **Outcome:** `0.4.0` of both packages on `latest`; a PR to `paseo-cafe/paseo-cafe` replaces the caveats saying "must be installed with npx" with caveats about the steps on Setup, the machine-wide tool-grant switch and removal; the owner runs `npm deprecate` for `paseo-bm` (needs an OTP) with the verbatim message of design §3.1; after that `release.yml` drops the step that publishes `paseo-bm` (design §3.2 item 4), the root `package.json` carries `"private": true`, and the "Two packages, one release" section of AGENTS.md and the release runbook are updated to match.
- **Requirements:** REQ-001, REQ-010, REQ-070.
- **Design:** paseo-bm.md §3.2; release runbook §2–§4; paseo.cafe record §9.
- **Prerequisites:** WP-407.
- **Exit:** `npm view` shows both packages 0.4.0 on `latest` with provenance; the registry PR passes every check; `paseo-bm` shows the deprecation notice; a post-release commit removes the step that publishes `paseo-bm`, with CI green.
- **Boundary:** R3 as in WP-407; another repository (paseo-cafe) — the entry changes only the caveats, Biome keeps short arrays on one line, no file is written from a value not checked to be non-empty.

## 3. Dependencies

| WP | Needs | For which product |
|---|---|---|
| WP-402 | WP-401 | `setup-state.json` to record `rolesCreated`, `cleanedUpAt` |
| WP-403 | WP-401, WP-402 | `setup-state.json`; role state |
| WP-404 | WP-401, WP-403 | the previous value of the tool-grant switch |
| WP-405 | WP-402, WP-403, WP-404 | the final behaviour, to write the documentation |
| WP-406 | WP-401 | the `home.json` format the plugin reads |
| WP-407 | WP-405, WP-406 | both packages in a releasable state |
| WP-408 | WP-407 | acceptance passed |

No cycles.

## 4. Risks

| Risk | Mitigation |
|---|---|
| A plugin installed from npm cannot load because `plugin/package.json` declares no dependencies (Q-045) | Measured in WP-407 on the `next` release before anything goes to `latest`; if it fails, stop the phase; evidence from `paseo-cafe` shows the host provides modules for an npm source |
| Creating a profile writes the whole `agentProfiles` array and may overwrite a concurrent change | Mutex + revision check + read-back in `config-writer.ts`, as ADR-008 accepted |
| The user removes the plugin without pressing the cleanup button → `bm-*` entries and the tool-grant switch remain | The README and the listing caveat say so clearly; the cleanup button is on Setup |
| `npx paseo-bm@0.3.x` from the cache installs backwards | `install.json` `schemaVersion: 2` makes 0.3.x stop before writing (design §4.5); `npm deprecate` |
| Paseo 0.8 users lose their upgrade path | Stated clearly in the release notes and README; keep 0.3.1 |
| A 0.3.x user who presses install on paseo.cafe gets `Plugin ID "paseo-bm" is already configured` | README, `plugin/README.md` (WP-405) and the listing caveat (WP-408) state the exact error and the command `npx paseo-bm@0.4.0` (design §4.3) |
| A directory-install user who never runs `npx` stays on 0.3.1 with no notice (a directory install does not update itself) | 0.4.0 release notes, README, listing caveat, the `npm deprecate` message |
| After WP-408 `paseo-bm` is no longer published: fixing a bug in the migration CLI needs the publish step turned back on | The release runbook records how to turn it back on (WP-408) |
| Running the `skills` CLI through a login shell | The command is a constant, with no user input; recorded in the ADR-003 header |

## 5. Open questions

| ID | Question | Owner | Status | Blocks |
|---|---|---|---|---|
| Q-044 | Does each provider's `paseoTools.enabled` grant the tools by itself when the machine-wide switch is off | hieu.nt10 | **closed 2026-09-25 — no** (measured on a real daemon, with a positive control; design §13) | blocks nothing any more; the tool-grant button in WP-403 stays |
| Q-045 | Can a plugin installed from npm load `zod`, `@getpaseo/plugin` | hieu.nt10 | measured in WP-407; low risk — `paseo-cafe` installed from npm runs with the same imports without declaring dependencies (design §13) | blocks WP-408 |
| Q-046 | Does `paseo plugin update` change the registered path | hieu.nt10 | measured in WP-407 | does not block (the data does not live next to the package) |
| Q-047 | Does `paseo plugin add npm:` with `--json` and no TTY ask for trust, what shape is the returned JSON; does `plugin ls --json` of the npm release have `installation.identity` | hieu.nt10 | measured in WP-407 | does not block writing WP-406 (written per design §4.3/§4.4); blocks WP-408 if it differs from the design, fixed per WP-407 Exit |

## 6. Test strategy

- **Unit (Vitest):** the new server modules (`data-home`, `setup-state`, `setup-roles`, `setup-machine`, the new part of `config-writer`) with a fake SDK and a temporary HOME; the client's pure model for Setup (no `react-native` import in `test/`, per AGENTS.md). The test table of design §11 is the mandatory list.
- **Negative (trust boundary):** an RPC with external effects that lacks `confirmed: true` is refused by the schema; no write outside the data folder and the `config.patch` scope of design §6.2; no write into the skills directories; no `npx paseo-bm` string in the plugin code outside the banner.
- **Integration (Vitest):** the migration CLI with a fake HOME and a fake `paseo` binary on `PATH`, like the existing integration tests; the five cases, every exit code and `--json`.
- **Packaging:** `smoke:packed` for the new shape of the two tarballs.
- **Acceptance:** the 0.4.0 install checklist on a real daemon (WP-407).
- **No new coverage threshold**; the tests of the deleted installer parts are replaced by tests of the new paths, with no reduction in the tests of the parts that remain.

## 7. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-25 | hieu.nt10 | First version |
| 2026-09-25 | hieu.nt10 (reviewed by Claude) | `reviewing-plan`: corrected the way back (downgrading to 0.3.x cannot read the data — design §12) and recorded the R3 decision; MVP-Lock adds REQ-035 (b), REQ-062 (c)(e), REQ-063 (a)(f), out of phase adds deleting `src/`; WP-402 adds dashboard §11.2; WP-403 adds REQ-008 (e), REQ-031 (c), REQ-063 (f), REQ-070 (g) and negative tests; WP-405 takes on the manifest check of `smoke:packed`; WP-406 adds the case of a missing `install.json`; WP-407 adds the mandatory security review before the prerelease, the acceptance items of design §11 and the fix loop when Q-047 differs from the design; WP-408 adds `private: true`; Q-047 adds the shape of `plugin ls`; the test strategy adds the negative layer |
| 2026-09-25 | hieu.nt10 | Settled D1 (keep `ui/setup-state.json` when deleting data, WP-404) and the Worker's per-provider skills line (dashboard §11.3); WP-406 updates the two-package table of `AGENTS.md`; gate `plan-ready-for-beads` PASS, plan Active |
| 2026-09-25 | hieu.nt10 | Thorough plan review: Q-044 measured on a real daemon and closed (no — the machine-wide switch is required, WP-403 keeps the button); Q-045 risk lowered thanks to `paseo-cafe` evidence; Q-047 partly answered; three risks added (id conflict when installing from paseo.cafe, directory-install users receive no notice, turning the `paseo-bm` publish back on when the CLI needs a fix); WP-405 Exit adds the guidance section for existing users |
