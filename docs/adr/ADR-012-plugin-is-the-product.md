# ADR-012 — One source: the `paseo-bm-plugin` plugin installed from npm / paseo.cafe is the whole product

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-25) |
| Date | 2026-09-25 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-001](ADR-001-plugin-distribution.md) (distribution through a payload shipped with the installer); [ADR-009](ADR-009-payload-as-npm-package.md) decisions 4 and 5 (the installer is the supported install path; the second package is not on the install path) |
| Amends | [ADR-002](ADR-002-install-ownership-model.md) (the install record now exists only for existing users); [ADR-003](ADR-003-skills-delegation.md) (the plugin, not the installer, runs the `skills` CLI after the user clicks); [ADR-004](ADR-004-paseo-config-mutation.md) (the plugin edits the config through `config.patch`, not through the file); [ADR-006](ADR-006-role-registration.md) decisions 1, 4, 6, 7, 8 (who creates and removes roles, who asks for consent); [ADR-008](ADR-008-role-settings-written-by-plugin.md) decision 2 (the plugin may **create** the three main roles) |
| Related | [Technical Design](../design/paseo-bm.md) §3, §4, §5, §6, §7 · [PRD](../product/paseo-bm-prd.md) · [paseo.cafe listing record](../operations/paseo-bm-cafe-listing-20260923.md) |
| The owner's decisions | 2026-09-25: the single source is `paseo-bm-plugin`; the last release of `npx paseo-bm` migrates existing users itself; only Paseo 0.9+ is supported; the plugin creates the three roles itself, the remaining steps need consent through a button on Setup |

## Context

Up to 0.3.1, paseo-bm had two npm packages at the same version:

- `paseo-bm` — the installer run with `npx`: copies the payload into `~/.paseo-bm/plugin/<version>/`, registers the plugin as a directory, creates the three `bm-*` roles, asks for consent to enable the plugin and grant Paseo tools to agents, runs the `skills` CLI, installs `br`/`bv`, and has `doctor` and `uninstall`.
- `paseo-bm-plugin` — the `plugin/` directory itself, existing only because paseo.cafe demands that the npm package root be a loadable plugin (ADR-009).

A user installing directly from paseo.cafe gets the interface but **lacks the three roles**, so Manager cannot create a Worker; the listing's caveat has to warn about that. Two install paths, one of them broken, two packages whose versions must be kept in step.

Paseo 0.9 has an npm source (`paseo plugin add npm:<package>`) and updates by itself (`paseo plugin update`). An analysis comparing each of the installer's jobs (27 jobs, 2026-09-25) showed: 5 jobs the plugin already does, 12 jobs the plugin can do with existing APIs (mostly `config.patch`), 10 jobs no longer needed because Paseo handles them. The plugin **cannot** do three things: turn on `pluginsEnabled` (the plugin is not running while the switch is still off), clean up after itself when removed (Paseo has no plugin-removal hook), and back up the whole config file (the SDK returns only a view). What is still missing is **the plugin's own rules**, not missing APIs.

## Decision

1. **The product is one package: `paseo-bm-plugin`.** The user installs it through paseo.cafe or `paseo plugin add npm:paseo-bm-plugin`, and updates it with `paseo plugin update paseo-bm`. That is the only supported install path. The registry entry keeps `package: "paseo-bm-plugin"`, `path: "plugin"`.
2. **Only Paseo 0.9 and later is supported.** `paseo-plugin.json` declares `requirements.paseo: ">=0.9.0"`. Paseo 0.8 users keep `paseo-bm@0.3.1` or upgrade Paseo.
3. **The plugin owns its data folder itself.** By default `~/.paseo-bm` (existing users' data is kept), the plugin **creates** it itself when needed, with permissions `0700`. The directory where Paseo manages npm packages may change on every update, so it never holds data. `install.json` is no longer a condition for the plugin to trust a data folder.
4. **The plugin creates the three roles itself the first time.** When the plugin finds `bm-manager`, `bm-worker` or `bm-reviewer` missing (when the entry point opens, on Setup, or in `manager.ensure`), it creates that role's derived provider and agent profile through `config.patch`, following exactly the old installer's default rules: the first provider Paseo reports as usable, that provider's first model; `paseoTools.enabled` for Manager and Worker, not for Reviewer; never writing `command` or `env`. It creates only **missing entries**, does not edit existing ones (ADR-008 decision 5: the Paseo config is the source of truth), and says on Setup that the roles were created with defaults and can be changed in the Agents tab. ADR-008 decision 2 ("the plugin never creates the three main roles") no longer applies; the write scope is still only entries whose id starts with `bm-`.
5. **The three remaining steps need a click with a warning on Setup**; nothing runs by itself:
   - **Grant Paseo tools to agents** (`daemon.mcp.injectIntoAgents`), with the warning "applies to every agent on the machine". The plugin records the previous value in the data folder so it can be undone correctly.
   - **Install skills** with the third-party `skills` CLI (fixed argv, a 300-second limit, a check after running), with a note that it is a third-party tool.
   - **Install `br`/`bv`**: already on Setup, unchanged.
   Provider login: Setup shows the state and the login command of the tool itself; the plugin does not run the login command and never sees the credentials.
6. **Uninstalling is a button on Setup**: "Remove paseo-bm's settings" deletes every `bm-*` provider and profile (including the fallback aliases), returns `injectIntoAgents` to the recorded value if the plugin itself turned it on, and deletes the data folder only after a second confirmation (kept by default). The user then runs `paseo plugin remove paseo-bm`. If the plugin is removed without clicking the button, the settings remain; the README and the listing's caveat say so plainly.
7. **`npx paseo-bm` 0.4.0 is the last release, for migration only.** It replaces every old command with one job: if the machine has a directory install of paseo-bm, run `paseo plugin remove paseo-bm` and then `paseo plugin add npm:paseo-bm-plugin@<its version>`, and if the latter fails, reinstall the old directory; keep the data, the roles and the switches intact; mark `install.json` as migrated. With no old install, it only prints instructions for installing from paseo.cafe. After 0.4.0, `release.yml` publishes only `paseo-bm-plugin`, and the owner marks `paseo-bm` deprecated on npm (needs an OTP). A plugin running from a directory install shows a banner on Setup reminding the user to run `npx paseo-bm` once.
8. **Health**: Setup's tab and status line replace `doctor` while the plugin is running. When the plugin cannot load, the README points to `paseo plugin ls` and `paseo plugin logs paseo-bm`.
9. **Version 0.4.0.** Dropping the CLI changes a public contract that the listing's caveat promised, so the minor version goes up.

## Consequences

**Positive**
- One install path, one package, one place to update: users from paseo.cafe get the complete product.
- Most of the code in `src/` (copying the payload, the ownership record, registration, upgrade, prune, lock, preflight, CLI reports) and its tests go away; maintenance is down to one package.
- Updates are handled by Paseo (`paseo plugin update`); no more parallel version directories in `~/.paseo-bm/plugin/`.

**Negative / to be accepted**
- Paseo 0.8 users no longer have a path to new versions.
- There is no longer a backup of the whole `~/.paseo/config.json` file before editing; replaced by `config.patch` (the daemon validates and restores its own file on error) plus the plugin's revision check — exactly the level ADR-008 accepted for editing roles.
- Creating a profile means rewriting the whole `agentProfiles` array: the same concurrent-overwrite risk already accepted in ADR-008 decision 3.
- Removing the plugin without the button leaves the `bm-*` settings and `injectIntoAgents` behind; this can only be pointed out in documentation.
- A cached `npx paseo-bm@0.3.x` can still install the directory version back; only npm's deprecation warning and the 0.4.0 release reduce this risk.
- Granting Paseo tools to agents is still a machine-wide switch; if a check on a real daemon shows that each provider's `paseoTools.enabled` is enough to grant the tools without the switch, this button will be dropped by a later decision.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Keep two packages, only let the plugin create the roles itself | Still two install paths, two things to release and keep in step; the owner wants one source |
| Rename the single package to `paseo-bm` | `paseo-bm` 0.1–0.3.1 is the installer: an old version range would give Paseo a package that cannot load; `npx paseo-bm` would break outright with no explanation; the registry entry and trusted publisher would have to change |
| The plugin migrates the directory install to npm itself | `paseo plugin remove` run from inside the plugin stops that very process midway; if it fails halfway, the user is left with no interface to troubleshoot from |
| Keep supporting Paseo 0.8 through a Git source | Adds another install path to test and document, against the one-source goal |
| Ask for consent to create the roles as well | The owner chose to create them automatically: the roles are only paseo-bm's own `bm-*` entries and grant no new permission; the real permissions (Paseo tools for every agent, running a third-party tool) still go through a button |
