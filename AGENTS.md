# AGENTS.md — paseo-bm

Read this before touching anything in this repository.

## What this project is

`paseo-bm` (BM = Beads Management) is published to npm and installed with `npx paseo-bm`. It does two things:

1. **Installs a Paseo plugin.** Copies a plugin payload into a stable install home, registers it with the Paseo daemon, registers three agent roles, and can delegate agent-skill installation to the third-party `skills` CLI.
2. **Provides an agent orchestration loop.** After install, the user chats with **Beads Manager** (an agent). Manager answers what it can read itself and hands every change to a **Beads Worker** (a peer agent in the same workspace). Worker sizes the request and uses only the process that size needs: a small change is done and proved directly; larger work gets beads, documents where they are needed, and a **Reviewer** sub-agent. The user can chat directly with Worker, and only the user may archive or delete an agent. The behaviour itself lives in `plugin/roles/*.md`.

**Current state:** shipped on npm (0.3.x); the paseo.cafe listing PR is open, so there is no listing page yet. The work now is maintenance and new features on a running product.

## Language rule

- Everything **for agents** — this file, `plugin/roles/*.md`, and any system prompt — is written in **English**.
- Everything in `docs/` is written in **Vietnamese** for human readers. Keep it that way.
- Docs that the product's Worker generates in a *target* repo follow that repo's existing language, defaulting to English.

## Tech stack

| Area | Choice |
|---|---|
| Language / runtime | TypeScript, ESM, Node >= 22 |
| Build | `tsup` → `dist/index.js`; `bin: { "paseo-bm": "dist/index.js" }` |
| Test | Vitest. Integration tests run against a fake `$HOME` with fake `paseo` / `skills` binaries on `PATH` |
| Lint / types | ESLint, `tsc --noEmit` |
| Plugin payload | Paseo plugin API v0.8: split `index.client.tsx` + `index.server.ts`, Zod contracts in `shared/`, React Native primitives only in `client/` |
| Issue tracking | Beads via `br`; `.beads/issues.jsonl` is the source of truth |
| Release | GitHub Release → npm trusted publishing (OIDC) with provenance; the workflow sets the dist-tag from the version: prereleases to `next`, stable releases to `latest` |

**Hard packaging rule:** no `preinstall` / `postinstall` scripts — downloading the package must never modify the user's machine. `prepack` is fine because it runs on the publisher's machine.

### Two packages, one release

Every release publishes **two npm packages at the same version**, from the same commit and the
same `release.yml` run:

| Package | What it is | Root of its tarball |
|---|---|---|
| `paseo-bm` | the installer CLI you run with `npx` | `dist/`, `plugin/`, no manifest |
| `paseo-bm-plugin` | the payload in `plugin/` | **a loadable plugin**: `paseo-plugin.json` + `index.client.tsx` + `index.server.ts` |

This exists because [paseo.cafe](https://paseo.cafe) lists paseo-bm, and its security scan
demands a Paseo 0.8 runtime entry at the plugin root — reading the npm tarball root whatever the
entry's `path` says. An installer tarball can never satisfy that. See
[ADR-009](docs/adr/ADR-009-payload-as-npm-package.md) and
[the listing record](docs/operations/paseo-bm-cafe-listing-20260923.md).

What breaks the listing, so do not do it:

- **Letting the versions drift.** `package.json`, `plugin/package.json` and `PLUGIN_VERSION` must
  match; the build writes the last two and a test fails when they disagree. Their validator
  compares the version in git against the one it resolves on npm.
- **Renaming `release.yml`.** npm's trusted-publisher entries for *both* packages point at this
  workflow by file name.
- **Forgetting the dist-tag.** Their `resolveNpmPackage` reads `paseo-bm-plugin@latest`. Since
  0.3.0 `release.yml` sets the tag from the version — prerelease to `next`, stable to `latest` —
  so a stable release needs no manual step. Pointing `next` at a stable version, or moving either
  tag by hand, still needs a one-time password and is the owner's step, not an agent's.
- **Adding a `test` script to `plugin/package.json` to win the listing's health badge.** There is
  no test in `plugin/`; a script that exists to turn a check green is a fake check.
- **Putting anything at the installer tarball's root that looks like a plugin.**

The registry entry lives in the other repository, at `registry/paseo-bm.json` in
`paseo-cafe/paseo-cafe`, and declares `path: "plugin"` with `package: "paseo-bm-plugin"`. Two
things cost a red run to learn there:

- Their CI runs Biome over the entry: **short arrays stay on one line**. `JSON.stringify(x, null, 2)`
  expands them and fails the job before it reaches validation.
- **Never write a file, local or remote, from a value you have not checked is non-empty, and never
  let a shell chain continue past a failed step.** A `python3 … <<'PY'` block that exits non-zero
  does not stop the `cmd && cmd` line after it: on 2026-09-23 that truncated the entry on the PR
  branch to zero bytes, in someone else's repository. Guard the value (`test -s`, `test -n`) or put
  the whole sequence inside one script that stops on error.

## Repository layout

```
AGENTS.md              this file (CLAUDE.md is a symlink to it)
docs/product/          PRDs (Accepted, living): paseo-bm-prd.md, paseo-bm-dashboard-prd.md
docs/design/           Technical Designs (Active, living): paseo-bm.md, paseo-bm-dashboard.md;
                       *-delta-* files are merged history, cited by code comments
docs/adr/              ADR-001..010 (Accepted)
docs/plans/            one plan per piece of Designed work; Completed ones are history
docs/operations/       acceptance checklists, run records, release notes, the paseo.cafe listing record
.beads/                bead graph; issues.jsonl is tracked, *.db is gitignored
src/                   CLI source: the installer published as the npm package `paseo-bm`
plugin/                Paseo plugin payload, published as its own npm package `paseo-bm-plugin`;
                       has its own package.json, README.md, LICENSE, and images/ for the listing
```

There is deliberately **no `paseo-plugin.json` at the repo root**. One existed for a day while
the paseo.cafe entry pointed at the repository root; the entry now declares `path: "plugin"`, so
nothing reads a root manifest and a stray one would make `paseo plugin add` find a plugin that
cannot load. A test asserts the repository has exactly one manifest.

## Process: risk picks the lane

Rigor follows the risk of the change, never its size or the habit of the last change. Pick
the lightest lane that fits, say which one in a line, and move up when you learn more.
The product is shipped (0.3.x); this repository is in maintenance, not in a build-out phase.

| Lane | When | What it takes |
|---|---|---|
| **Direct** | Local and easy to undo: a bug fix, a screen, wording or style change, a refactor, a test, tooling, a doc correction — anything that changes none of the contracts below | Just do it. Update the docs that describe what you changed, in place. Proof = the verification commands below, green. No bead, no plan, no gate, no Reviewer |
| **Tracked** | Still low-risk, but several outcomes with an order between them, or work that will span sessions or be handed over | Beads written by hand (`br create`), closed on evidence. No plan and no gate unless a trigger below appears |
| **Designed** | Any of the **triggers** below | `feature-workflow`: the design (and PRD when the user-facing outcome changes) edited in place, an ADR for a durable decision, a plan and beads when there is a real dependency graph, and the gates that apply |

**Triggers for Designed** — a change that:

- changes a contract others consume: `npx paseo-bm` flags, exit and error codes, `--json` output, `install.json` / trace-store / any on-disk schema, the `BM-*` block formats and notices, plugin RPC contracts in `plugin/shared/contracts.ts` read across versions;
- writes to the user's Paseo configuration, agent skill directories or anything outside the install home;
- touches credentials, permissions, agent modes or anything the safety boundaries below guard;
- touches release, publishing or the two-package rule;
- adds a dependency or changes the architecture (overturns or adds an ADR);
- cannot be undone.

The **role files** (`plugin/roles/*.md`) are product behaviour for every user: changing what an
agent may do is Designed; rewording without changing behaviour is Direct.

How the lanes are held:

- **Look before you ask.** The design, ADRs and code already answer most questions; read the part you need instead of re-deriving it. A flag name, error code, timeout, JSON shape or label convention is decided in the design — if one is genuinely missing, surface the gap instead of inventing it.
- **Docs are living.** The PRD, the Technical Design and the ADR index describe the product **as it is now**. Change them in place in the same commit as the code, with one Revision History line when the change is not a correction. No delta files for new work: the deltas under `docs/` are merged history, kept only because code comments cite them. An ADR is never rewritten — a new ADR supersedes it.
- **PRD states outcomes, design states detail.** Theme tokens, labels, pixel values and limits belong in the design, code and tests, so a screen tweak never becomes a requirement change.
- **A plan belongs to one piece of Designed work** and is closed (`Status: Completed`) when its beads are; it is not a standing contract for later work.
- **Gates apply only where their artifact exists.** Report them honestly; a skipped gate is an exception, never a pass.
- **No bookkeeping after the fact.** Never create a bead to record work already done, and do not make a commit that only moves beads — bead state goes in the same commit as the work.

## Working with beads (`br`)

`br` is the issue tracker (Rust + SQLite + JSONL). `.beads/issues.jsonl` is the committed source of truth; the `.db` files are local caches and are gitignored.

### Conventions in this repo

- IDs start with `bm-`; beads converted from a plan also carry the work package (`bm-wp-115-51j.2`).
- Every bead carries `feature:<slug>`; beads converted from a plan also carry `phase:*` and `wp:wp-NNN`.
- Epics mirror a plan's work packages; leaves are the executable units.
- Leaf descriptions are self-contained on purpose: an implementer must be able to work from the bead alone, without opening the plan.

### Daily commands

```bash
br ready                  # what can be started right now — always start here
br show <id>              # full bead: objective, scope, AC, proof, provenance
br list --json            # machine-readable listing
br update <id> --status in_progress
br close <id> --reason "<evidence>"
br dep tree <id>          # why something is blocked
br dep add <issue> <depends-on>
br lint -s all            # template check across the graph
br dep cycles             # must always report no cycles
```

### Rules

Beads are for the Tracked and Designed lanes; Direct work has none.

- **When you use beads, take them from `br ready`.** Do not start a blocked bead.
- **Close with evidence.** The reason must point at the bead's Acceptance Criteria — a command that ran, a test that passed, an observation made. "Done" is not a reason.
- **Never delete beads.** Split or merge instead, and record `Split-from: <id>` in the Provenance section.
- **Never hand-edit `.beads/issues.jsonl`.** Go through `br` so the database and the JSONL stay consistent.
- **A bead does not grow new scope.** It may be re-worded for clarity; new scope is new work in its own lane.
- **Keep a hand-written bead short:** objective, acceptance criteria, how it is proved. The long leaf template is for beads converted from a plan.

### `br` gotchas that will bite you

- A value starting with `-` is parsed as a flag. Use `--description=<text>`, not `--description <text>`.
- `br show <id> --json` returns an **array**, not an object.
- `br lint` wants `## Acceptance Criteria` in tasks and `## Success Criteria` in epics. Keep those headings.

## Viewing progress (`bv`, `bva`)

- `bv` — kanban and list views over the same `.beads` directory.
- `bva` — reporting TUI: totals, phase progress from `phase:*` and `wp:*` labels, dependency leverage, and automatic findings. Run it in any directory that has `.beads/`.

Both read the bead data directly and are safe to run alongside `br`. They are read-only tools for orientation; all changes go through `br`.

## Verified facts about Paseo (do not re-derive these)

Checked against a live daemon, Paseo CLI/daemon 0.8.0:

- `paseo plugin install <dir>` succeeds **even when `pluginsEnabled` is off**, returning `status: "disabled"`. So "register the plugin first, ask for consent second" is a valid order.
- A plugin's `enabled` field is its own switch and is always true after install. Only `status` reflects reality (`running` vs `disabled`). **Check `status`, never `enabled`.**
- `paseo plugin remove` does **not** delete a local directory source, and it leaves an empty `plugins: {}` key behind. That key belongs to Paseo; do not clean it up.
- An agent created by another agent is still a first-class agent in the workspace — it only carries a `paseo.parent-agent-id` label. The user can open, message, stop, archive or delete it directly.
- `daemon.mcp.injectIntoAgents` defaults to **off**, and turning it on grants Paseo tools to **every** agent on the machine, not just ours.
- Never run `paseo daemon restart` or `stop`: it can kill a running agent.
- `paseo plugin install` refuses an id that is already configured (`Plugin ID "<id>" is already configured; choose another ID with --id`), and there is no command that changes a directory plugin's path (`update` is Git-only). A directory plugin can only be re-pointed by `paseo plugin remove <id>` followed by `paseo plugin install <new dir> --id <id>`. If the new plugin fails to start, Paseo keeps the `plugins[id]` entry it already wrote, so a fallback must `remove` again before reinstalling the old directory. On failure, `--json` prints `{"error": {"name": "DaemonRpcError", "code": "handler_error", "message": "Request failed: <reason>"}}` and exits non-zero.
- Rewriting the files of a directory plugin in place does not reload it: Paseo keeps running the bundle it compiled before. `paseo plugin reload <id> --json` reloads it without touching the daemon (log: `Plugin stopped` → `Loading plugin` → `Plugin ready`) and prints `{ id, path, enabled, status }`.
- A `daemon.agentProfiles[]` entry is `{ id, name, provider, model?, icon?, color?, modeId?, thinkingOptionId?, featureValues?, notes? }` (Zod schema in the Paseo 0.8 app bundle, passthrough). The key is **`provider`** and it is required — there is no `providerId`. `providerId` exists only in our own `install.json` role records.
- An agent snapshot's `lastUsage` mixes two scopes: `inputTokens` / `cachedInputTokens` / `outputTokens` are **this turn's**, but **`totalCostUsd` is the agent's running session total**. Measured across twelve Manager turns on a real daemon it only ever rose (0.3956 → 0.4492 → 0.6749 → … → 2.2712) while the token counts beside it went up and down. Never sum it per turn; estimate cost from the per-turn tokens instead.
- A message one agent sends another with `send_agent_prompt` arrives as a **`user_message`** timeline item, indistinguishable from a real user message. A Worker's progress update to its Manager therefore looks exactly like a new user request, and no wording test separates them reliably.
- A `user_message` typed in the Paseo app carries **`clientMessageId`**; one sent by an agent with `send_agent_prompt` does not (15/15 vs 43/43 on a real Manager). That field — not the wording — is how to tell the user's own messages from relayed ones.
- Claude Code loads a skill as a `tool_call` named **`Skill`** whose `plain_text` detail has `label` = the skill name ("Launching skill: feature-workflow"). Reading `<skill>/SKILL.md` is the fallback signal for other providers; listing or `test -f` is only a check.
- `timeline.refetch()` entries carry `turnId`, but a `turn_ended` event's `turnId` can be **null**; when it is, there is no turn boundary to filter on and the whole conversation comes back.
- An agent created by another agent through Paseo's `create_agent` MCP tool gets **no system prompt**: the tool has no system-prompt parameter. A plugin injects one with the server hook `before("agent.create", ({ request }) => …)`, which runs for every agent creation and may return a modified `{ config, env }`; paseo-bm keys it on `config.provider` (`bm-*`, possibly `<id>/<model>`).
- Paseo sets **`PASEO_AGENT_ID`** (and `PASEO_AGENT_CWD`) in every agent's environment. An agent that needs its own id reads that one variable; it never has to dump or search the environment.
- `send_agent_prompt` and `create_agent` take **`notifyOnFinish`** (default `true`): the caller is woken each time the other agent ends a turn. A Worker's `BM-REPORT` sent with the default wakes the Worker again when the Manager finishes reading it.
- `br` 0.2.10: `br update <id> --status in_progress` **refuses a bead whose blockers are still open** (`cannot claim blocked issue`; only `--force` overrides), and `br reopen <id>` works on a closed bead.
- `br` 0.2.10: a child bead is **blocked while its parent is blocked**, so a bead that depends on its own children deadlocks. Split a bead into siblings under the same parent and move the dependency edges instead.
- `br` read commands (`show`, `list`, `ready`, `lint`, `dep tree`) do not write `.beads/` files, even when `issues.jsonl` is newer than the database.
- Paseo **reuses turn ids inside one agent**: on a real store one Manager had `foreground-turn-1`, `-2` and `-3` twice each, eight minutes apart, and its Worker had `foreground-turn-1` twice. Nothing may treat `(agentId, turnId)` as unique.
- Paseo lets a plugin contribute **slash commands**: `client.addSlashCommand({ name, description, argumentHint, context, onSubmit })`, `context` being `"workspace"` or `"agent"`. `onSubmit` receives `args: string` plus `paseo`, `rpc`, `openSurface`, `openSettings`, `openPanel` and the workspace (and agent). It has **no channel to report success** — the composer only shows a message when `onSubmit` REJECTS, as an error toast — so a command that has something to say posts it to a surface instead of throwing.
- The client SDK can message an agent: `paseo.agents.ref(id).send(text)`. That is the same path the app uses, so the text is recorded as a **real user message** (it carries `clientMessageId`).
- Paseo's renderer is **Expo + `react-native-web`**; its bundle ships `PanResponder`, `Animated`, `LayoutAnimation`. Gestures and animation work in a plugin surface, but **`useNativeDriver` must be `false`**. A `.tsx` under `plugin/client/` may import `react-native`; a file under `test/` must **not** import it as a value — react-native's types pull the DOM lib into the root tsconfig program and `setTimeout` starts resolving to the DOM overload, breaking unrelated files. `import type` is fine.
- A message timestamp in a trace record **can be the write time**. The collector takes it from the timeline only when `timeline.refetch` answers; when that call fails it stamps every message of the record with `now()`. Never treat a stored message time as a real timeline time.
- `providers.listModes("bm-worker")` (and `bm-reviewer`) resolves the paseo-bm provider alias to the underlying provider and returns its modes as `{ id, label, colorTier }`, with `colorTier` one of `planning`, `safe`, `moderate`, `dangerous` (read-only probe, 2026-09-17: Claude → plan, default, acceptEdits, auto, bypassPermissions; Codex → auto, auto-review, full-access). Pass the bare id, not `bm-worker/<model>`.
- The daemon resolves a new agent's mode in `resolveMcpCreateAgent` **before** `before("agent.create")` runs: an explicit mode is used; a child of the same provider inherits the parent's mode; a child of an unattended parent gets the target provider's unattended mode; otherwise it **throws** `cannot inherit mode … Pass an explicit mode`. The hook then receives that resolved config and may change it (only `cwd` is immutable). So a hook can correct a mode but cannot rescue a creation the daemon already refused — a Manager that is not unattended must pass the Worker's mode itself. A Worker in `bypassPermissions` does not get the unattended path either: a Reviewer it creates without a mode is **refused**, not given `full-access` (`cannot inherit mode 'bypassPermissions' from caller … Pass an explicit mode. Available: auto, auto-review, full-access`, seen by two Workers on 2026-09-18), so the Worker passes the Reviewer mode named in its own `## Runtime facts`.
- The plugin SDK **cannot change the mode or the labels of an agent that already exists**: `PaseoAgentHandle` has no setter for either, `DaemonClient.setAgentMode` is not handed to plugins, and `before("agent.session_open")` can only change `env`. The Paseo CLI can: `paseo agent mode <id> <mode> [--json]` and `paseo agent update <id> --label <k=v> [--json]`. `manager.ensure` uses them (via `plugin/server/paseo-cli.ts`, `execFile` without a shell) to switch a Manager created before delta 20260918 once, marked by the `bm.modeSet` label. Running the CLI from inside the daemon process **works on a real daemon** (2026-09-18: two pre-existing Managers were switched and labelled; a Manager switched back to `default` by hand stayed there after `manager.ensure`).
- An agent snapshot (from `get_agent_status` or the `agent` of a `timeline.refetch` payload) carries both the **configured** values (`model`, `thinkingOptionId`, `effectiveThinkingOptionId`, `currentModeId`) and the **running** ones in `runtimeInfo { model, thinkingOptionId, modeId }`; prefer `runtimeInfo`. `persistence.metadata.systemPrompt` holds the exact system prompt the agent was given. A Codex Reviewer with no thinking set ran at effective `xhigh` with a 258,400-token window; a Claude Worker has 1,000,000.
- Paseo delivers `config.systemPrompt` differently per provider: Claude gets it as `append` to the `claude_code` preset (after the whole preset, which brings its own memory, `AskUserQuestion` and commit instructions), with `CLAUDE.md` injected into the conversation, not the system prompt; Codex gets it as `developerInstructions` (after a collaboration mode's own `developer_instructions`), with each `AGENTS.md` as a separate user-role message; OpenCode gets it as `system`. A daemon-level `appendSystemPrompt` (empty unless configured) follows it in all three. Details and sources: `docs/design/paseo-bm-research-20260918-instructions-by-model.md`.
- A plugin's server process **can serve its own MCP endpoint** and give it to agents (verified 2026-09-24, Claude): `node:http` listening on `127.0.0.1` inside the plugin process works, and `before("agent.create")` returning `config.mcpServers["<name>"] = { type: "http", url, alwaysLoad: true }` plus `config.toolPolicy.preapproved = [{ kind: "mcp", server, tool }]` gives the new agent the tool as `mcp__<name>__<tool>`, with **no permission prompt**. Without `alwaysLoad` Claude hides the tool behind a ToolSearch step. Agents that already exist never get it (`agent.session_open` changes only `env`). paseo-bm's endpoint: ADR-010, `plugin/server/agent-tools.ts`.
- **`toolPolicy` is refused outright on a provider that cannot pre-approve MCP tools.** Paseo 0.8 `applyProviderConfiguration` throws `Provider '<id>' cannot preapprove exact MCP tools for unattended execution` — the agent is never created — unless the provider's contract has `applyToolPolicy`: only **claude, codex, opencode** (`PROVIDER_CONTRACTS.supportsExactMcpPreapproval`); Pi, Oh My Pi, Copilot and other ACP providers do not. It also throws when a grant names a server missing from `mcpServers`. For Codex, `applyCodexToolPolicy` turns the grants into `mcp_servers.<server>.enabled_tools` plus `tools.<tool>.approval_mode = "approve"`. Verified 2026-09-24 through fallback aliases: a Codex agent created through Paseo calls the tool (shown as `paseo-bm.bm_review`) with no approval prompt; an OpenCode creation carrying `toolPolicy` is accepted; a Pi creation without it succeeds. The creation hook reads the alias's base provider with `config.get()` → `config.providers[<alias>].extends` (the SDK's shape; the file keeps them under `agents.providers`).
- Paseo **0.9.2** `daemon status --json` has **no `cliVersion`** (it still has `home`, `daemonVersion`, `listen`); `paseo --version` prints the bare CLI version. The adapter falls back to it (bm-qh4c). `plugin ls` / `plugin logs --json` kept their 0.8 shape.

## Safety boundaries when working in this repo

- Do not commit or push unless the user asks.
- Do not modify the user's real Paseo configuration (`~/.paseo/config.json`), their agent skill directories, or install plugins onto their daemon as a side effect of development work.
- Do not run `npm install`, `npx`, or publish anything without being asked.
- Treat credentials as untouchable: this product's entire security story is that it never reads, stores, or prints them.

## Verification before declaring work done

```bash
npm run typecheck && npm run lint && npm test && npm run build
br lint -s all && br dep cycles                                   # only when you changed beads
```
