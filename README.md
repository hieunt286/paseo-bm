# paseo-bm — Beads Management for Paseo

`paseo-bm` installs a [Paseo](https://paseo.sh) plugin and three agent roles that turn a feature request typed in chat into reviewed documents, beads and implemented code.

After installing, you open **Beads Manager** in a Paseo workspace and describe what you want. The Manager hands the request straight to a **Beads Worker** in the same workspace. The Worker follows the feature-workflow process (documents when needed, then beads, then implementation), and a **Reviewer** agent checks each batch of changes. You can talk to the Worker directly at any time, and only you archive or delete agents.

> **Status:** prerelease (`0.1.0-alpha.*`). Command names, flags, exit codes and the `--json` shape are treated as a public contract, but expect rough edges.

## Contents

- [Before you install: read these warnings](#before-you-install-read-these-warnings)
- [Requirements](#requirements)
- [Install](#install)
- [Using it: the orchestration loop](#using-it-the-orchestration-loop)
- [Everything paseo-bm writes](#everything-paseo-bm-writes)
- [Agent skills](#agent-skills)
- [Checking health: `doctor`](#checking-health-doctor)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Command reference](#command-reference)
- [Exit codes and JSON output](#exit-codes-and-json-output)
- [Troubleshooting](#troubleshooting)
- [Not available yet](#not-available-yet)

## Before you install: read these warnings

Installing paseo-bm asks you for **one consent** that turns on **two switches** in `~/.paseo/config.json`. Both have consequences that reach beyond paseo-bm.

> [!WARNING]
> **1. Plugin trust: `pluginsEnabled`.**
> Paseo plugins run **without a sandbox**. The paseo-bm plugin runs inside the Paseo daemon with the same access to your machine as the daemon itself: files, processes, credentials and network. Only enable it if you trust this package.

> [!WARNING]
> **2. Agent-creation permission: `daemon.mcp.injectIntoAgents`.**
> The Manager and the Worker need Paseo's tools to create, message and stop other agents. Paseo grants those tools to **every agent on this machine**, not only to paseo-bm's roles. Once the switch is on, any agent can create, prompt and stop other agents, which means it can start work and spend money on your model providers.

In a terminal, both switches are covered by a single question, `Enable Paseo plugins and grant Paseo tools to agents?`, which defaults to **No** and is shown with the warning text above. Without a terminal, the only way to give this consent is `--enable-plugins`. **`--yes` is never consent**: it only skips the "apply" confirmation.

If you decline, the rest of the install still completes, but the plugin will not run and the Manager cannot create a Worker. The command exits with code `4` and tells you how to enable later:

```bash
npx paseo-bm install --apply --enable-plugins
```

> [!CAUTION]
> **3. Sub-agent permission modes.**
> - **The Worker** is created in its provider's **no-prompt mode**: Claude `bypassPermissions`, Codex `full-access`, or the equivalent for other providers. Paseo does not ask you to approve its commands.
> - **The Reviewer** is created in **auto mode** (Claude `auto`, Codex `auto`), which does not grant full or network access.
> - **The Manager** runs in the mode of its `bm-manager` profile and never approves permission requests on your behalf.
>
> The Worker's boundaries (no git, no destructive commands, ask before dependencies, network or migrations) are therefore enforced **only by its role instructions**. No Paseo permission prompt backs them up. Use paseo-bm in repositories where you are comfortable with that, and review `git diff` before you commit anything.

## Requirements

| Requirement | Detail |
|---|---|
| Operating system | macOS or Linux. Native Windows is refused. WSL reports itself as Linux but is not covered by testing. |
| Node.js | 22 or newer |
| Paseo | Paseo desktop with its CLI and daemon at **0.8.0 or newer**, both reporting the **same** version. The daemon must be running, which usually means the Paseo app is open. |
| `paseo` CLI | On your `PATH`: `paseo --version` must work in the shell you install from |
| Beads CLI (`br` or `bd`) | Optional for installing, but **required for the orchestration loop**: the Worker uses it to create and update beads. A missing beads CLI is only a warning. |
| A logged-in agent provider | At least one provider Paseo offers (for example Claude or Codex), logged in with that tool's own login. paseo-bm never handles credentials. |
| Network | Needed for `npx` to download the package, and for the optional skills step. The plugin install itself runs locally. |

No `sudo` is needed. The npm package has no install scripts, so downloading it changes nothing on your machine until you run a command and confirm.

## Install

While paseo-bm is in prerelease, every build is published under the npm dist-tag `next`, so run:

```bash
npx paseo-bm@next
```

There is no stable release yet, so `npx paseo-bm` without `@next` does not resolve. Once a stable version is published, `npx paseo-bm` installs it.

### What the interactive install asks

Run the command in a real terminal. If you pipe its output (for example `| tee`), paseo-bm sees no terminal and asks nothing: see [non-interactive](#non-interactive-install). `--json` also turns off every question.

1. **Environment check.** paseo-bm checks the operating system, the Node version, the `paseo` CLI, the daemon, the Paseo version and whether the install home can be created. If any check fails, it stops **before writing anything**, prints a remediation and exits `3`. A missing beads CLI is only a warning.
2. **Role configuration** (first install, or with `--reconfigure`). For each of the Manager, Worker and Reviewer it asks three things:
   - a name (defaults: `Beads Manager`, `Beads Worker`, `Beads Reviewer`);
   - a provider, from the providers Paseo offers;
   - a model for that provider.

   The Reviewer is asked separately: choosing a different provider from the Worker's gives the review an independent point of view. The Reviewer is the only role that is not granted Paseo tools.
3. **Preview.** Every file, Paseo registration and config key that would change is listed, along with the agent roles to register.
4. **`Apply these changes?`** (default No). Answering No writes nothing. If there is nothing to change, this question is skipped and every action is reported as skipped.
5. **Plugin registration.** The payload is copied into `~/.paseo-bm/plugin/<version>/` and registered with Paseo as plugin `paseo-bm`.
6. **`Enable Paseo plugins and grant Paseo tools to agents?`** (default No). This is the single trust consent described [above](#before-you-install-read-these-warnings). It is not asked when both switches are already on.
7. **Provider login.** For a chosen provider that is not logged in, paseo-bm prints that provider's own login command and asks `Run <command> now?`. If you decline, it prints manual steps. The role stays registered either way.
8. **Agent skills.** If recommended skills are missing, paseo-bm shows the exact `skills` command and asks `Run the skills CLI now to install the missing agent skills?`. See [Agent skills](#agent-skills). Declining is remembered; `--ask-skills-again` asks again.
9. **Summary.** This covers the plugin state, the registered roles, the login state, the skills state, and where everything was written.

Two extra questions appear only when they apply: overwriting files you edited by hand (a backup is taken first), and installing an **older** paseo-bm over a newer one.

When the summary shows the plugin as `running`, open Paseo and continue with [the orchestration loop](#using-it-the-orchestration-loop).

### Non-interactive install

Without a terminal, `install` needs `--apply` to write anything. Without `--apply` it prints the preview and exits `6`. Consent to each trust boundary needs its own flag:

```bash
npx paseo-bm install --apply --yes --enable-plugins --install-skills \
  --role manager=claude/<model> --role worker=claude/<model> --role reviewer=codex/<model> \
  --json
```

- `--enable-plugins` is the consent for both `pluginsEnabled` and `daemon.mcp.injectIntoAgents`. Without it, the install completes and exits `4`.
- `--install-skills` allows paseo-bm to run the third-party `skills` CLI. Without it, missing skills are only a warning.
- `--role <role>=<provider>/<model>` picks the tool for a role; `role` is `manager`, `worker` or `reviewer`. A role with no `--role` and no earlier configuration gets Paseo's default provider and model, with a warning. The provider/model pair must exist in Paseo, otherwise the run stops with `E_PROVIDER_UNAVAILABLE` before anything is written.
- Installing an older version over a newer one is refused without a terminal (exit `5`).

## Using it: the orchestration loop

1. **Open Beads Manager.** In Paseo, use the **Beads Manager** item in the sidebar, or **Open Beads Manager** in the Command Center. Each workspace reuses one Manager: an existing Manager is reopened rather than duplicated. The **Beads agents** workspace panel shows the Manager → Worker → Reviewer tree with each agent's status.
2. **Chat with the Manager.** Describe the feature or fix in the normal Paseo chat. The Manager does not do the work itself. It **immediately creates a Beads Worker in the same workspace** and tells you which Worker has the request. If recommended skills are missing, the Manager says so and still delegates.
3. **The Worker classifies the request** and tells you the size and the reason. The first rule that matches wins:
   - **Large:** touches a public contract, a data schema, authentication, permissions, weak reversibility, or several independent components. This applies no matter how small the request sounds.
   - **Small:** fits in one component, changes no contract, needs no new document, and the approach is clear from the start.
   - **Medium:** everything else.
4. **The Worker follows feature-workflow through to implementation.** The path depends on the size:

   | | Small | Medium | Large |
   |---|---|---|---|
   | New documents | none | only the affected parts | the full document chain |
   | Before implementing | goes straight on | goes straight on | **asks you to confirm** |
   | Reviews | exactly one, after implementing | at most 2 per batch | at most 2 per batch |
   | Bead polish passes | none | at most 1 per bead batch | at most 1 per bead batch |
   | Review + polish budget per request | 1 | 6 | 10 |

   Before creating beads, the Worker searches open beads by label and updates a matching bead instead of creating a duplicate. It then implements the ready beads, runs the repository's tests, and closes each bead with evidence.
5. **A Reviewer checks each batch.** A batch is one coherent change: a document, a round of bead changes, or one implemented bead. The Reviewer only reads and comments. The Worker fixes blocking findings and re-reviews. If blocking findings remain after the second review, or the budget is reached, the Worker **stops and asks you** instead of reviewing again.
6. **The Worker reports and waits.** It sends structured progress reports to the Manager, so you can ask the Manager "what's the status?". When the Worker is finished it stays idle for you to inspect. **Only you archive or delete agents**: the Manager may stop a Worker, but no agent archives or deletes another.

**Limits you should know about:**

- **The review and polish budget is a behavioural guardrail, not a hard block.** The Worker counts and reports its own reviews, and the Manager watches those counts. Nothing in code prevents a Worker that ignores its instructions.
- **The Worker never commits, pushes or opens pull requests.** You review `git diff` and decide. It does not run destructive commands, write outside the workspace, or read credential files. It **asks first** before:
  - installing or upgrading dependencies;
  - running commands that need the network;
  - running migrations;
  - deploying or publishing;
  - editing frozen documents, widening scope, or deleting or merging beads.
- **You can chat with the Worker directly** to clarify or redirect; you do not have to go through the Manager.
- **Stopping a Worker also stops its running Reviewers.** When you press Stop on a Worker in Paseo, the plugin sends a fixed stop notice to that Worker's running Reviewers, and the role instructions tell both agents to stand down. This is **not a hard cancel**: Paseo 0.8 gives plugins no way to cancel an agent. A stopped Reviewer takes one short extra turn to acknowledge, and the stopped Worker is woken once by the Reviewer's "finished" notification. It then reports where it stopped and waits for you.
- Your requests and source code go to the model providers you chose for each role. paseo-bm has no telemetry.

## Everything paseo-bm writes

This is the complete list. paseo-bm writes nowhere else.

### Install home: `~/.paseo-bm/**`

Change the location with `--home <dir>` or `PASEO_BM_HOME`. paseo-bm refuses an install home that is, or contains, your home directory, Paseo's directory or an agent configuration directory.

| Path | What it is |
|---|---|
| `~/.paseo-bm/plugin/<version>/` | The plugin payload for each installed version, including `roles/manager.md`, `roles/worker.md` and `roles/reviewer.md`. Older versions are kept until you run `install --prune`. |
| `~/.paseo-bm/install.json` | The install record and the source of truth for what paseo-bm owns: version, a hash of every file, Paseo config changes and their previous values, roles, and skills-step state. Do not edit or delete it by hand. |
| `~/.paseo-bm/backups/<timestamp>/` | A copy of `config.json` taken before paseo-bm edits it (`paseo-config.json`), and copies of files paseo-bm deliberately overwrote. Kept until you prune them or remove them at uninstall. |
| `~/.paseo-bm/.lock` | Process lock held while `install` or `uninstall` runs. `doctor` never takes it. |

### Paseo config: `~/.paseo/config.json`

The location follows `--paseo-home <dir>`, `PASEO_HOME`, or the directory the Paseo daemon reports. A backup is taken first, and only these keys are touched:

| Key | What paseo-bm writes | When |
|---|---|---|
| `pluginsEnabled` | `true` | Only with the trust consent |
| `daemon.mcp.injectIntoAgents` | `true`; the previous state is recorded so uninstall can restore it | Only with the trust consent (the same single consent) |
| `agents.providers.bm-manager`, `agents.providers.bm-worker`, `agents.providers.bm-reviewer` | A derived provider `{ extends, label, paseoTools }` that reuses your existing provider login, with no command and no environment | Role registration |
| `daemon.agentProfiles[]` entries whose `id` starts with `bm-` (`bm-manager`, `bm-worker`, `bm-reviewer`) | The role's provider, model and name. Other profiles and their order are left untouched. | Role registration |

The `plugins` key is written **by Paseo** when paseo-bm runs `paseo plugin install`, not by paseo-bm. After uninstall Paseo leaves an empty `plugins: {}` behind; that key belongs to Paseo.

### Temporary files

Every write goes to a temporary file first and is then renamed into place. If a run is killed mid-write, a leftover file such as `~/.paseo/.config.json.<pid>.<hex>.tmp`, or the same pattern beside a file in the install home, may remain. It is safe to delete once no paseo-bm command is running.

### What paseo-bm never writes

- **Agent skills.** paseo-bm only reads the skills directories. Skills are installed and removed only by the third-party `skills` CLI, and only when you consent (see below).
- Credentials and provider logins: it never reads, stores or prints them.
- Plugins, providers or profiles that other tools or you created. Only `bm-*` entries are paseo-bm's.
- Git: neither the installer nor the agents commit or push.
- Existing agents in Paseo. They are yours, and uninstall leaves them in place.

## Agent skills

The Worker follows the **feature-workflow** process, which comes from a set of agent skills. The skills are not required for paseo-bm to run, but **without them the Worker's results are noticeably worse**, which is why paseo-bm checks for them.

- **Source:** https://github.com/cuongntr/agent-skills. This is **another author's repository** (`cuongntr`). paseo-bm does not bundle, maintain, fork or patch these skills; their content and availability are outside paseo-bm's control.
- **Required skills** (checked and warned about):
  - `feature-workflow`
  - `reviewing-plan`
  - `converting-plan-to-beads`
  - `polishing-beads`
  - `implementing-beads`
- **Optional skills** (suggested only, never warned about): `architecture-premise-audit` and `authoring-workspace-protocol`.
- **Where paseo-bm looks** (read-only):
  - the shared `~/.agents/skills`;
  - Claude Code's `~/.claude/skills` (follows `--claude-home` or `CLAUDE_CONFIG_DIR`);
  - Codex's `~/.codex/skills` (follows `--codex-home` or `CODEX_HOME`).

  Symlinked skills count as present. Only skill names are compared, not versions.

### How paseo-bm helps

When required skills are missing, paseo-bm shows the exact command and asks before running it. Without a terminal, it runs the command only with `--install-skills`. The target agents come from `--skills-agents`, which defaults to `claude,codex`. `claude` is passed to the skills CLI as `claude-code`, the name that CLI uses. With the defaults, the command is:

```bash
npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s feature-workflow reviewing-plan converting-plan-to-beads polishing-beads implementing-beads -y
```

That is also the **equivalent manual install command**: run it yourself if you prefer not to let paseo-bm run it.

Before you run it, note the following:

- **Skills are installed as symlinks** (the skills CLI's default mode), so all your agents share **one copy** of each skill. Updating or removing that copy affects every agent that uses it.
- **The `skills` CLI is a third-party tool with its own data collection.** paseo-bm has no telemetry, but that promise does not cover the `skills` CLI.
- A skills failure, a timeout (300 seconds) or a missing network never blocks the plugin install and never changes the exit code. You get a warning and the manual command.

### Removing skills

paseo-bm never removes skills, and `uninstall` does not touch them. Remove them with the `skills` CLI itself; run `npx skills --help` to see its removal command.

## Checking health: `doctor`

```bash
npx paseo-bm doctor
```

`doctor` is **read-only**:

- it writes nothing and takes no lock;
- it does not touch the network and never runs the `skills` CLI;
- the only Paseo commands it calls are the read-only `paseo daemon status` and `paseo plugin ls`.

It reports each check with a remediation:

| Area | Check ids |
|---|---|
| Paseo | `paseo-daemon`, `paseo-version` |
| Install record | `install-record`, `install-version` |
| Payload files | `files-missing`, `files-modified` |
| Plugin | `plugin-registered`, `plugin-status`, `plugin-path` |
| Consent switches | `plugins-enabled`, `agent-tools` |
| Roles | `role-bm-manager`, `role-bm-worker`, `role-bm-reviewer` |
| Housekeeping | `payload-versions`, `backups` |
| Warnings only | `beads-cli`, the per-agent skills checks, provider login state |

Exit codes:

- `0`: healthy;
- `1`: drift in what paseo-bm owns;
- `2`: misuse.

Warnings about skills, the beads CLI or provider logins never change the exit code. After an uninstall, `doctor` reports that paseo-bm is not installed.

## Updating

Run the installer again with the newer version, for example `npx paseo-bm@latest` (or `npx paseo-bm@next` for prereleases):

- **New version.** The payload is copied into a new `~/.paseo-bm/plugin/<new version>/`. Because Paseo 0.8 cannot re-point a directory plugin, paseo-bm runs `paseo plugin remove paseo-bm` and then `paseo plugin install <new dir>`. The plugin is absent for a few seconds in between. If the new version fails to register or load, paseo-bm reinstalls the previous directory, keeps the record on the old version, and exits `7` with Paseo's own error message. Older versions stay on disk until `--prune`.
- **Same version.**
  - Nothing to change: nothing is asked, every action is reported as skipped, and the exit code is `0`.
  - Files repaired or changed in the active plugin directory: paseo-bm **reloads the plugin automatically** and waits for `running`.
- **Files you edited by hand** are never overwritten silently. On a terminal you are asked, and a backup is taken before overwriting. Without a terminal they are kept unless you pass `--force`.
- **Downgrade** (older over newer) needs an explicit answer on a terminal.
- **Role changes:** `npx paseo-bm install --reconfigure` asks the role questions again.
- **Clean up:** `npx paseo-bm install --apply --prune` removes old payload versions and backups. It never removes the version in use or files you edited, and it always **keeps the newest Paseo config backup** as a manual-recovery copy.

paseo-bm never restarts or stops the Paseo daemon.

## Uninstalling

```bash
npx paseo-bm uninstall          # preview only
npx paseo-bm uninstall --apply  # remove, after confirmation
```

Uninstall removes **only what `install.json` says paseo-bm owns**:

- it unregisters the `paseo-bm` plugin;
- it deletes the `bm-*` providers and profiles, and any config container paseo-bm created that is now empty;
- it puts `daemon.mcp.injectIntoAgents` back to its recorded previous state if paseo-bm changed it;
- it deletes the payload.

Questions you are asked, all defaulting to No:

1. `Uninstall paseo-bm as shown above?` (skipped with `--yes`)
2. `paseo-bm turned Paseo plugins on and no other plugin is installed. Turn plugins off again?` This is only asked when that is true.
3. `Also remove paseo-bm's backups? This cannot be undone.`

**Questions 2 and 3 are interactive-only.** Without a terminal, plugins stay enabled and backups are kept. To remove everything paseo-bm created, run uninstall in a terminal.

What stays, on purpose:

- **Files you edited by hand** are kept and listed. `--force` deletes them too, after copying them into a backup.
- **Backups**, unless you chose to remove them.
- **`install.json`, when the Paseo daemon is not running.** Files are removed, but the Paseo side cannot be undone without the daemon. Run `uninstall --apply` again once Paseo is running.
- **Agent skills**: see [Removing skills](#removing-skills).
- **Beads Manager, Worker and Reviewer agents** already in Paseo. Archive or delete them yourself in Paseo.
- The empty `plugins: {}` key that Paseo leaves in `config.json`.

`--restore-backups` copies backed-up **payload files** back before removing, and they are kept as your files. It **never restores the whole `config.json`**: that would discard every change made since the install. Only the keys paseo-bm owns are undone. If you need an older copy of the config, the backups under `~/.paseo-bm/backups/` are there for manual recovery.

## Command reference

```text
npx paseo-bm [command] [options]
```

| Command | Meaning |
|---|---|
| *(none)* | The install wizard on a terminal. Without a terminal, prints a preview and writes nothing. |
| `install` | Install or update. Without a terminal and without `--apply`, only previews. |
| `doctor` | Read-only health check |
| `uninstall` | Remove what paseo-bm owns. Only previews without `--apply`. |

| Option | Applies to | Meaning |
|---|---|---|
| `--apply` | install, uninstall | Actually write; without it the command only previews |
| `--yes` | install, uninstall | Skip the apply confirmation; never implies consent to any trust boundary |
| `--enable-plugins` | install | Consent to both halves of one trust boundary: enable `pluginsEnabled` and grant Paseo tools to agents |
| `--install-skills` | install | Consent to running the third-party skills CLI |
| `--skills-agents <list>` | install, doctor | Target agents for the skills CLI (default `claude,codex`) |
| `--role <role>=<provider>/<model>` | install | Pick the tool for a role; repeatable |
| `--reconfigure` | install | Ask the full role configuration again even when it already exists |
| `--skip-skills-check` | install, doctor | Skip the skills step entirely |
| `--force` | install, uninstall | Install: overwrite user-modified files. Uninstall: delete them too |
| `--ask-skills-again` | install | Clear the remembered "do not ask again" answer for the skills step |
| `--restore-backups` | uninstall | Restore backups before removing (payload files only) |
| `--prune` | install | Clean up old payloads and backups; only on request |
| `--home <dir>` | all | paseo-bm install home (env `PASEO_BM_HOME`) |
| `--paseo-home <dir>` | all | Paseo home directory (env `PASEO_HOME`) |
| `--claude-home <dir>` | all | Claude Code config directory used when detecting skills (env `CLAUDE_CONFIG_DIR`) |
| `--codex-home <dir>` | all | Codex config directory used when detecting skills (env `CODEX_HOME`) |
| `--json` | all | Emit exactly one JSON document on stdout |
| `--verbose` | all | Print more detail about each step |
| `-h`, `--help` | | Show help |
| `-v`, `--version` | | Print the version and exit |

Precedence: flag, then environment variable, then default. `npx paseo-bm <command> --help` shows the options for one command.

## Exit codes and JSON output

| Code | Meaning |
|---|---|
| `0` | success, an intentional preview, or a healthy doctor |
| `1` | doctor found drift in what paseo-bm owns |
| `2` | misuse of a command or flag |
| `3` | environment precondition failed; nothing was written |
| `4` | installed, but a trust boundary was not consented to |
| `5` | stopped on a conflict that needs a human decision |
| `6` | no terminal and no --apply; preview printed, nothing written |
| `7` | files installed, but Paseo could not install or load the plugin |

Exit codes `0` and `6` are different on purpose: `6` means a script forgot `--apply`, so nothing happened. Warnings, such as missing skills, a missing beads CLI or a provider that is not logged in, never change the exit code.

With `--json`, stdout carries exactly one JSON document, and output from child processes goes to stderr. The document contains:

- `schemaVersion`, `command` and `mode` (`preview` or `applied`);
- the versions;
- the `actions` (`checks` for `doctor`);
- `roles`, `skills` and `warnings`;
- a `result`.

A failed run with a registered error code adds `result.error`:

```json
{
  "result": {
    "exitCode": 3,
    "pluginState": null,
    "error": { "code": "E_TARGET_NOT_WRITABLE", "message": "…" }
  }
}
```

`result.error` is present **only** when the command failed, so `"error" in result` tells a script whether it failed. Error codes (`E_…`) and warning codes (`W_…`) are stable: within a major version codes are only added, never renamed or given a new meaning.

## Troubleshooting

Start with `npx paseo-bm doctor` (add `--verbose` for detail). Every error prints a remediation.

**The plugin is not running, or Beads Manager does not appear in Paseo**

- Run `paseo plugin logs paseo-bm` to see Paseo's reason.
- Run `npx paseo-bm doctor`:
  - `plugins-enabled` or `agent-tools` not ok means the trust consent was not given. Run `npx paseo-bm install --apply --enable-plugins`.
  - `plugin-path` or `install-version` in error means Paseo is loading a different version than the one recorded. Run `npx paseo-bm install --apply` again.
- Check a plugin's `status` (`running` or `disabled`) in `paseo plugin ls`, not its `enabled` field.

**`E_PLUGIN_LOAD_FAILED` (exit 7)**

paseo-bm copied its files, but Paseo could not install or load the plugin. The files are kept. Run `paseo plugin logs paseo-bm`, fix the cause, then run `npx paseo-bm install --apply` again. During an update, the message also says whether the previous version was restored.

**The Paseo daemon is not running: `E_DAEMON_UNREACHABLE`, `E_PASEO_CLI_MISSING` or `E_VERSION_MISMATCH` (exit 3)**

- Open the Paseo app so its daemon is running.
- Make sure `paseo --version` works in the same shell.
- Upgrade Paseo so the CLI and the daemon are both 0.8.0 or newer and report the same version.

Nothing has been written at this point. Do not restart or stop the daemon while agents are running: that can kill them.

**Missing skills: `W_SKILLS_MISSING` or `W_SKILLS_ASSIST_FAILED`**

Run the printed `skills add` command yourself, or re-run `npx paseo-bm install --apply --install-skills`. If you declined earlier and want to be asked again, add `--ask-skills-again`. Then run `doctor`. Skills problems never block the install.

**Conflicts: `E_CONFLICT` (exit 5)**

Something paseo-bm does not own is in the way, or a file you edited would be overwritten. Inspect the reported target:

- move a foreign file aside yourself, or
- re-run with `--force` to overwrite files recorded as user-modified. A backup is always taken first.

Exit `5` also covers a downgrade attempted without a terminal.

**Other errors that exit 3 before writing**

| Code | What to do |
|---|---|
| `E_LOCKED` | Another install or uninstall holds `~/.paseo-bm/.lock`. Wait for it to finish; delete `.lock` only if you are sure no run is active. |
| `E_CONFIG_CONCURRENT_WRITE` | Something else changed `config.json` during the write, for example Paseo's settings screen or another run. Close it and retry. |
| `E_TARGET_NOT_WRITABLE`, `E_UNSAFE_INSTALL_HOME`, `E_SYMLINK_IN_PATH`, `E_PATH_ESCAPE` | Point `--home` at a dedicated directory you own, such as `~/.paseo-bm`, with no symlinks in the path. |
| `E_PROVIDER_UNAVAILABLE` | The provider or model given for a role does not exist in Paseo. Pick an existing pair with `--role`. |
| `E_RECORD_SCHEMA_TOO_NEW` | `install.json` was written by a newer paseo-bm. Upgrade with `npx paseo-bm@latest`. Do not edit the record. |

**Roles do not work, or the provider is not logged in: `W_PROVIDER_NOT_LOGGED_IN`**

- Run the provider's own login command. paseo-bm never handles credentials.
- Run `doctor` and check `role-bm-manager`, `role-bm-worker` and `role-bm-reviewer`.
- Change a role's provider or model with `npx paseo-bm install --reconfigure`.

If the Manager says it cannot create a Worker, check that `agent-tools` is ok in `doctor` and that the Worker's provider is logged in.

**The Worker cannot create or update beads**

Install the beads CLI (`br` or `bd`) and make sure it is on the `PATH` that Paseo's agents use.

**A script installed without asking**

Piping output (`| tee`) or passing `--json` removes the terminal, so no question is asked. Without a terminal, consent only comes from `--enable-plugins` and `--install-skills`.

## Not available yet

The following are planned for later phases and are **not** in this release:

- a separate `configure` command (use `install --reconfigure`);
- an in-Paseo skills reminder;
- suggested extra agent profiles;
- a limit on parallel Workers;
- a history of past requests;
- a bead progress dashboard in Paseo;
- remote daemons;
- Windows support;
- a hard, code-enforced review budget.

## License

MIT, as declared in `package.json`.
