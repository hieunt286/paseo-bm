# paseo-bm 0.4.0

**The plugin is now the whole product.** You install paseo-bm from [paseo.cafe](https://paseo.cafe) — or with `paseo plugin add npm:paseo-bm-plugin` — and it sets itself up from its own Setup screen. The `npx paseo-bm` installer is retired; its last version does exactly one thing, described under [Coming from `npx paseo-bm`](#coming-from-npx-paseo-bm).

**This is the stable release, on `latest`.** It is `0.4.0-alpha.0` plus one clarification of the Manager's instructions (below), after the prerelease passed its acceptance on real Paseo 0.9.2 daemons. As in every release, `paseo-bm` and `paseo-bm-plugin` carry the same version.

**It needs Paseo 0.9.0 or newer.** 0.9 is where Paseo learned to install a plugin from npm, which is the only install path this version has. On Paseo 0.8, keep `paseo-bm@0.3.1`.

## One install path, and a plugin that sets itself up

- **Install from the listing, or one command.** `paseo plugin add npm:paseo-bm-plugin`, updated with `paseo plugin update paseo-bm`. Before this release, installing from paseo.cafe gave you the screens but no agent roles, so the Manager could not create a Worker; that gap is what this version closes.
- **The three roles are created for you.** The first time you open **Beads Manager** or **Setup**, paseo-bm creates whichever of `bm-manager`, `bm-worker` and `bm-reviewer` is missing, on the first provider Paseo reports as available and that provider's first model — the same defaults the old installer used. An entry that already exists is never changed, so a model or provider you set yourself is kept. Setup and the launcher both tell you it happened, and **Setup → Agents** is where you change it.
- **Nothing else happens without a press.** Three steps grant something, so each is a button with a warning:
  - **Allow agent tools…** turns on Paseo's `daemon.mcp.injectIntoAgents`. It applies to **every agent on this machine**, not only paseo-bm's, and paseo-bm writes down what the switch was before so removal can put it back. Until you press it, **Beads Manager does not start**: an agent only gets Paseo's tools when it is created, so a Manager started earlier could never create a Worker. Opening it says so and points at the button.
  - **Install skills…** runs the third-party `skills` CLI once, with the exact command shown first. It downloads from [cuongntr/agent-skills](https://github.com/cuongntr/agent-skills) (another author's repository) and has its own data collection; paseo-bm never writes to your skills folders itself.
  - **Install `br` / `bv`** runs the beads tools' own documented install command.
- **Setup shows the whole machine.** Which roles exist and how they were created, whether Paseo's agent tools are on and who turned them on, each provider's sign-in with the command to run yourself, the required skills per agent and when the CLI last ran, `br` and `bv`, and which data folder this install uses.

## Removing it is a button, then one command

Paseo has no hook that runs when a plugin is removed, so **Setup → Remove paseo-bm's settings…** is the uninstall. It takes every `bm-*` provider and agent profile out of Paseo (the three roles and their fallback aliases) and puts the agent-tools switch back — but only if paseo-bm turned it on. A second, separate question asks whether to delete the plugin's data; the default keeps it. Then:

```bash
paseo plugin remove paseo-bm
```

Skipping the button leaves the `bm-*` entries in your configuration. One file always survives even when you ask for the data to go — `ui/setup-state.json` — because it records that you removed the settings; without it, one plugin reload before you run `paseo plugin remove` would create the three roles again.

## The plugin owns its data folder

Before this release the plugin only trusted a folder that held an `install.json` written by the installer, so a paseo.cafe install had no history, no role instructions and no fallback settings. Now the plugin finds and creates its own folder: `PASEO_BM_HOME` if set, then the pointer `~/.paseo-bm/home.json`, then `~/.paseo-bm`, created at mode `0700` on the first write. A candidate that is your home directory, or overlaps Paseo's or an agent's directory, is refused — and paseo-bm then stops rather than quietly using the default, because splitting your data across two folders is worse than saying so. **Setup → This install** shows the folder and how it was found.

Existing users keep everything in place: traces, `ui/`, `role-extras.json` and `role-fallback*.json` are read where they already are, with no migration.

## Coming from `npx paseo-bm`

If you installed paseo-bm before this release, the plugin on your machine is a **directory install**. It never updates by itself, and installing the npm package on top of it is refused by Paseo with exactly:

```
Plugin ID "paseo-bm" is already configured; choose another ID with --id
```

**Do not choose another id**: two copies of paseo-bm would both create roles and both inject instructions into your agents. Run this once instead:

```bash
npx paseo-bm@latest
```

It removes the directory plugin, installs `npm:paseo-bm-plugin` at the same version, and — if that fails — puts your directory install back exactly as it was. Your data folder, your roles and Paseo's switches are left alone. Afterwards `~/.paseo-bm/plugin/` and `~/.paseo-bm/backups/` are read by nothing and you can delete them by hand.

That is all the `paseo-bm` command does now. `install`, `doctor`, `uninstall` and thirteen flags are retired: each one answers with the sentence that says where its job went, and exits `2` with `E_COMMAND_RETIRED`. Its exit codes are `0` (migrated, or nothing to migrate, or a preview), `2` (retired command or flag), `3` (Paseo older than 0.9.0, no daemon, no CLI, or another paseo-bm holding the install home), `5` (the registered plugin is not one paseo-bm installed), `6` (no terminal and no `--apply`) and `7` (the npm plugin would not start; your directory install was put back).

## What changed in agent behaviour

- **The Manager answers in the language you write in.** A Worker's `BM-REPORT` arrives in the Manager's chat as a message and is always English; in the acceptance run the Manager switched to English after one. Its instructions now say the user's language is the language of what the user typed, which a report or a notice never changes.
- **The Manager's Runtime facts** now point a missing Worker skill at **Beads Manager → Setup → Agent skills** instead of at the retired `npx paseo-bm doctor`.
- **`manager.ensure` reports what the machine still needs.** Opening Beads Manager creates the roles if they are missing and shows one line under the Manager when it created them with defaults, or when Paseo's agent tools are off. With the agent tools off it creates no new Manager (an existing one still opens).
- **A Worker or Reviewer always starts on the model its profile names.** When you change a role's provider or model in **Setup → Agents**, a Manager or Worker that was already running used to keep asking for the old model, and a Worker moved from Claude to Codex then failed at its first turn. The plugin now starts it on the model you set, and logs one line when it had to correct one.
- **The Worker's profile note** in Paseo's Agents tab now describes how it works since 0.3.1: a small change is made and checked directly, larger work gets beads, documents and a Reviewer, and it commits or pushes only when you ask. Only roles created from now on carry the new note.
- Nothing else about how the three agents work changed in this release: the review budget, the sizing rules, the `BM-*` block formats and the trace store are all as they were in 0.3.1.

## What to know when upgrading

- **Paseo 0.9.0 or newer only.** `plugin/paseo-plugin.json` declares `requirements.paseo: ">=0.9.0"`, so an older daemon refuses the plugin rather than loading a build that cannot reach its own install path.
- **A directory install never updates by itself.** Run `npx paseo-bm@latest` once, as above.
- **On `0.4.0-alpha.0` from `next`**, `paseo plugin update paseo-bm` now brings you to `0.4.0`.
- **An old `npx paseo-bm@0.3.x` after the migration** stops with `E_RECORD_SCHEMA_TOO_NEW` (exit `3`) and changes nothing; the `npx paseo-bm@latest` it suggests is this version.
- **Only agents created after the upgrade get the new instructions.** Paseo does not let a plugin change an agent that already exists, so a Manager or Worker opened earlier keeps working as it did.
- Your own additional role instructions (Setup → Agents) are kept and still come after the built-in ones.
- The `paseo-bm` npm package still publishes at this version, for the migration. It is the last version that will; the package will then be marked deprecated with a pointer to `paseo-bm-plugin`.

## Rollback

A patch at **0.4.0 or later**. Downgrading to 0.3.x is **not** a way back: a 0.3.x plugin does not trust a data folder whose `install.json` is missing or marked as migrated, so it would find no history. A user whose migration fell back is still running 0.3.1 exactly as before, with an unchanged `install.json`.

## Evidence

`npm run verify` (typecheck, plugin typecheck, lint, tests, build) exited 0 on the tagged tree, and `npm run smoke:packed` passed every check including that the `paseo-bm` tarball now carries only `dist/` and that the payload tarball's manifest requires Paseo `>=0.9.0`. The new tests cover the data folder and its refusals, the `ui/setup-state.json` store, role creation and the cleaned-up gate, the agent-tools and skills buttons with their confirmations, the cleanup button's deletions and what it keeps, the Setup checklist model, and the migration end to end against a fake daemon: all five cases, both failure paths with the fallback, the write order, and that a run with nothing to do writes nothing at all.

Before `0.4.0-alpha.0` was published, the exact tarballs were installed the way users install them, on isolated Paseo 0.9.2 daemons served by a test registry that mirrored npm with that version on `next`. The run covered a fresh install through Setup, a Medium request going Manager → Worker → beads → Reviewer on Claude and then on Codex, and the migration from a real `paseo-bm@0.3.1` install, both default and `--home`. Three defects found there were fixed before publishing. After publishing, the same checks ran again against the real registry: `paseo plugin add npm:paseo-bm-plugin@next` resolved from `registry.npmjs.org` with the published integrity. A fresh install refused to start a Manager until the agent tools were allowed, then ran a Medium request with beads and a Reviewer. A Manager created before the user moved the Worker to Codex still asked for the Claude model, and the plugin started the Worker on Codex as set. Paseo refused `paseo plugin add` on top of a `0.3.1` directory install with the exact sentence quoted above, `npx paseo-bm@next --apply` migrated it, and `0.3.1` then stopped at exit `3`. paseo.cafe's security scanner reports no finding on the published tarball. The run record is `docs/archive/operations/paseo-bm-install-run-20260926.md`.

## Sources

[ADR-012](https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/adr/ADR-012-plugin-is-the-product.md) · [PRD](https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/product/paseo-bm-prd.md) (REQ-001 → REQ-015, REQ-027, REQ-031, REQ-070) · [Technical Design](https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/design/paseo-bm.md) (§3, §4, §5, §6, §7.2, §7.3, §7.13) · [GUIDE.md](https://github.com/hieunt286/paseo-bm/blob/v0.4.0/GUIDE.md) · [Run record](https://github.com/hieunt286/paseo-bm/blob/v0.4.0/docs/archive/operations/paseo-bm-install-run-20260926.md) · [0.4.0-alpha.0 notes](https://github.com/hieunt286/paseo-bm/releases/tag/v0.4.0-alpha.0)
