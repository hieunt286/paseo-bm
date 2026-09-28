# paseo-bm documentation — start here

The documentation in `docs/` is written in English and is **living documentation**: each file describes the product **as it runs now**, is edited in place in the same commit as the code, and gains one Revision History line. To learn why something was once decided, see the "History" section at the end of each design, then `archive/`. How to pick the process for a change (Direct / Tracked / Designed) is in [`AGENTS.md`](../AGENTS.md), section *Process*.

**The product is one package.** From 0.4.0 ([ADR-012](adr/ADR-012-plugin-is-the-product.md)) paseo-bm is the plugin `paseo-bm-plugin`, installed from paseo.cafe or with `paseo plugin add npm:paseo-bm-plugin` on Paseo 0.9+; the `npx paseo-bm` installer has only one last release left, to move existing users over. The PRDs and designs describe that target release and state clearly what is not in the code yet.

## What the product does — PRD

| Document | Contents |
|---|---|
| [paseo-bm-prd.md](product/paseo-bm-prd.md) | Installation and machine setup (target release 0.4.0: from paseo.cafe, Setup, moving existing users over), the Manager / Worker / Reviewer roles, safety boundaries, review, reporting, provider fallback |
| [paseo-bm-dashboard-prd.md](product/paseo-bm-dashboard-prd.md) | The Metric, Beads and Setup screens, cards in chat, the trace store |
| [paseo-bm-orchestrator-prd.md](product/paseo-bm-orchestrator-prd.md) | **Accepted** — the Orchestrator tab: rule-based flags assessing coordination, an LLM assessment on click (role `bm-orchestrator`), nudging a running agent after a flag |

A PRD states **the outcome the user gets**. Details such as colours, labels, limits and numbers live in the design, code and tests. A requirement not yet in the code is marked *"Not implemented yet"* in its own row.

## How the product does it — Technical Design

| Document | Contents |
|---|---|
| [paseo-bm.md](design/paseo-bm.md) | Packaging and release, the 0.4.0 migration CLI, the data folder, machine setup, Paseo configuration, the plugin's server side: the agent-creation hook, Manager, agent tools, `BM-*` notices, the review budget, the question–answer log, fallback, trace |
| [paseo-bm-dashboard.md](design/paseo-bm-dashboard.md) | The trace store, building a trace per request, process steps, the Metric / Beads / Setup screens (including Roles & models), chat cards, pills, the fallback card |
| [paseo-bm-orchestrator.md](design/paseo-bm-orchestrator.md) | **Active** — the Orchestrator tab: the catalogue of rules and flags, the `bm-orchestrator` role and the `bm_assessment` tool, the `BM-NUDGE` agent nudge, the `orchestrator.*` RPCs |
| [paseo-bm-research-20260918-instructions-by-model.md](design/paseo-bm-research-20260918-instructions-by-model.md) | How role instructions reach Claude, Codex and OpenCode |

Each role's behaviour lives in its own instructions: [`plugin/roles/manager.md`](../plugin/roles/manager.md), [`worker.md`](../plugin/roles/worker.md), [`reviewer.md`](../plugin/roles/reviewer.md). The design does not copy it.

## Architecture decisions — ADR

| ADR | Decision |
|---|---|
| [ADR-001](adr/ADR-001-plugin-distribution.md) | The payload ships inside the npm package and is registered from a local directory (**Superseded** by ADR-012) |
| [ADR-002](adr/ADR-002-install-ownership-model.md) | Install record with checksums, atomic writes, backups |
| [ADR-003](adr/ADR-003-skills-delegation.md) | Delegate skill installation to the `skills` CLI |
| [ADR-004](adr/ADR-004-paseo-config-mutation.md) | Integrate with Paseo through its CLI; change `config.json` minimally |
| [ADR-005](adr/ADR-005-manager-as-agent.md) | Beads Manager is an agent; the plugin is the entry point and the observation panel |
| [ADR-006](adr/ADR-006-role-registration.md) | Register roles with derived providers and agent profiles |
| [ADR-007](adr/ADR-007-dashboard-trace-store.md) | Trace store in the install home, deletable by the user |
| [ADR-008](adr/ADR-008-role-settings-written-by-plugin.md) | The plugin writes role settings through `config.patch`; fallback aliases |
| [ADR-009](adr/ADR-009-payload-as-npm-package.md) | The payload is its own npm package `paseo-bm-plugin`, in the same release (decisions 4–5 replaced by ADR-012) |
| [ADR-010](adr/ADR-010-plugin-hosted-agent-tools.md) | The plugin serves schema-typed tools to agents over MCP HTTP |
| [ADR-011](adr/ADR-011-manager-coordinates-workers.md) | Manager coordinates Workers itself within the scope the user has decided |
| [ADR-012](adr/ADR-012-plugin-is-the-product.md) | One source: the plugin `paseo-bm-plugin` installed from npm / paseo.cafe is the whole product; `npx paseo-bm` 0.4.0 only migrates; Paseo 0.9+. Replaces ADR-001, replaces ADR-009 decisions 4–5, amends ADR-002, 003, 004, 006, 008 |
| [ADR-013](adr/ADR-013-orchestrator-assess-and-nudge.md) | **Accepted** — Orchestrator: the plugin creates the `bm-orchestrator` assessment agent when the user clicks, and nudges a running Manager/Worker with `BM-NUDGE` when the user turns the nudge switch on; no other action. Amends REQ-047 of the Dashboard PRD |

An ADR is never rewritten; a new decision gets a new ADR that supersedes it.

## Plans in progress — `plans/`

| Plan | Status |
|---|---|
| [paseo-bm-plan-040-single-source.md](plans/paseo-bm-plan-040-single-source.md) | Active — 0.4.0 and 0.4.1 are released; the last exit condition waits for the paseo.cafe caveats PR to be merged |
| [paseo-bm-plan-050-orchestrator.md](plans/paseo-bm-plan-050-orchestrator.md) | Draft — 0.5.0, the Orchestrator: eight work packages, `plan-ready-for-beads` self-evaluated, awaiting the owner |

A plan exists only for a piece of Designed work and moves to `archive/plans/` when its work is done.

## Operations — `operations/`

| Document | Use it when |
|---|---|
| [Release runbook](operations/paseo-bm-release-runbook.md) | Releasing a version (from 0.4.1 only the `paseo-bm-plugin` package) |
| [0.4.0 install checklist](operations/paseo-bm-install-checklist.md) | Acceptance of installing from npm, Setup, migration and removal on a real daemon |
| [Orchestration checklist](operations/paseo-bm-orchestration-checklist.md) | Acceptance of Manager → Worker → Reviewer with the sample request set |
| [Roles and fallback checklist](operations/paseo-bm-worker-fallback-checklist.md) | Acceptance of role settings and provider fallback |
| [paseo.cafe record](operations/paseo-bm-cafe-listing-20260923.md) | Listing paseo-bm on paseo.cafe; the registry's traps |
| [Request to Paseo: cancel an agent](operations/paseo-upstream-request-agent-cancel.md), [timeline navigation](operations/paseo-upstream-request-timeline-navigation.md) | Two open requests to the Paseo maintainers (in English) |

## Release notes — `releases/`

One file per version, `paseo-bm-release-notes-<version>.md`; that file is the GitHub Release body. Latest: [0.3.0](releases/paseo-bm-release-notes-0.3.0.md).

## Archive — `archive/`

Read-only, never edited. This is the historical record and is still in Vietnamese. Code and older documents cite deltas by name and section number (for example "delta 20260917c §4.7"); find them here.

| Folder | Contains |
|---|---|
| `archive/design/` | The design deltas and proposals merged into the two Technical Designs |
| `archive/product/` | The PRD deltas merged into the two PRDs |
| `archive/plans/` | Every completed implementation plan |
| `archive/operations/` | Run records of acceptance runs and releases, diagnoses, checklists of closed phases |
