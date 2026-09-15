# AGENTS.md — paseo-bm

Read this before touching anything in this repository.

## What this project is

`paseo-bm` (BM = Beads Management) is published to npm and installed with `npx paseo-bm`. It does two things:

1. **Installs a Paseo plugin.** Copies a plugin payload into a stable install home, registers it with the Paseo daemon, registers three agent roles, and can delegate agent-skill installation to the third-party `skills` CLI.
2. **Provides an agent orchestration loop.** After install, the user chats with **Beads Manager** (an agent). Manager immediately delegates to a **Beads Worker** (a peer agent in the same workspace). Worker follows the feature-workflow process: update docs when needed, create or update beads, then keep going until the beads are implemented. After every batch of changes Worker spawns a **Reviewer** sub-agent. The user can chat directly with Worker, and only the user may archive or delete an agent.

**Current state: documentation and a bead graph only. There is no product code yet.** The first implementable bead is the project scaffold.

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
| Release | GitHub Release → npm trusted publishing (OIDC) with provenance; prereleases go to dist-tag `next` |

**Hard packaging rule:** no `preinstall` / `postinstall` scripts — downloading the package must never modify the user's machine. `prepack` is fine because it runs on the publisher's machine.

## Repository layout

```
AGENTS.md              this file (CLAUDE.md is a symlink to it)
docs/product/          PRD (Accepted)
docs/design/           Technical Design (Active)
docs/adr/              ADR-001..006 (Accepted)
docs/plans/            implementation plan v2 (Active, Plan-ready PASS); v1 is Superseded
docs/operations/       acceptance checklists and run records (created by WP-117 / WP-120)
.beads/                bead graph; issues.jsonl is tracked, *.db is gitignored
src/                   CLI source (not created yet)
plugin/                Paseo plugin payload (not created yet)
```

## Process: feature-workflow is mandatory

Every change goes through the `feature-workflow` skill. Do not improvise a different process.

- **Read the artifacts before proposing anything.** The PRD, Technical Design and plan already resolve most questions. Re-deriving them wastes tokens and invents contradictions.
- **Risk decides rigor, not effort estimates.** A one-line change that touches a public contract, a data schema, auth, or rollback safety is high-risk work and needs the matching artifacts.
- **The plan is frozen.** `docs/plans/paseo-bm-implementation-plan-v2.md` is `Active` with `Plan-ready: PASS`. Do not edit it in place to fit new scope — write a delta-change document instead. The same applies to the Accepted PRD and Active design; correcting stale text that contradicts an already-recorded decision is errata and is allowed, adding scope is not.
- **Gates are real.** `prd-ready` → `design-ready` → `plan-ready-for-beads` → `feature-done`. Report gate results honestly; a skipped gate is recorded as an exception, never as a pass.
- **Ask instead of guessing.** If a bead would force you to invent a flag name, an error code, a timeout value, a JSON shape, or a label convention, stop and ask. Those are already decided in the Technical Design; if one is genuinely missing, that is a design gap to surface, not to fill silently.

## Working with beads (`br`)

`br` is the issue tracker (Rust + SQLite + JSONL). `.beads/issues.jsonl` is the committed source of truth; the `.db` files are local caches and are gitignored.

### Conventions in this repo

- IDs look like `bm-wp-115-51j.2` — prefix `bm`, the work package, a hash, and a child suffix.
- Every bead carries three labels: `feature:paseo-bm`, `phase:1a` or `phase:1b`, and `wp:wp-1NN`.
- Epics mirror the plan's work packages; leaves are the executable units.
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

- **Take work from `br ready`.** Do not start a blocked bead, and do not invent work that has no bead.
- **Close with evidence.** The reason must point at the bead's Acceptance Criteria — a command that ran, a test that passed, an observation made. "Done" is not a reason.
- **Never delete beads.** Split or merge instead, and record `Split-from: <id>` in the Provenance section.
- **Never hand-edit `.beads/issues.jsonl`.** Go through `br` so the database and the JSONL stay consistent.
- **Scope lives in the plan.** A bead may be re-worded for clarity; it may not grow new scope.

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

## Safety boundaries when working in this repo

- Do not commit or push unless the user asks.
- Do not modify the user's real Paseo configuration (`~/.paseo/config.json`), their agent skill directories, or install plugins onto their daemon as a side effect of development work.
- Do not run `npm install`, `npx`, or publish anything without being asked.
- Treat credentials as untouchable: this product's entire security story is that it never reads, stores, or prints them.

## Verification before declaring work done

```bash
npm run typecheck && npm run lint && npm test && npm run build   # once src/ exists
br lint -s all && br dep cycles                                   # graph stays clean
```
