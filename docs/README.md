# paseo-bm documentation — start here

Everything in `docs/` except `archive/` is **living documentation**: it describes the product **as it runs now** (0.5.x), is edited in place in the same commit as the code, and gains one Revision History line per change. Git is the audit trail; superseded documents and old history live in [`archive/`](archive/README.md). How much process a change needs (Direct / Tracked / Designed) is in [`AGENTS.md`](../AGENTS.md), section *Process*.

paseo-bm is one package, the Paseo plugin `paseo-bm-plugin`, installed from paseo.cafe or with `paseo plugin add npm:paseo-bm-plugin` ([ADR-012](adr/ADR-012-plugin-is-the-product.md)). What is published is `plugin-package/`, generated from `plugin/` ([ADR-026](adr/ADR-026-published-plugin-is-bundled.md)).

## What the product does — `product/`

A PRD states **the outcome the user gets**; colours, labels, limits and numbers live in the design, code and tests. A requirement not in the code yet says so in its own row. REQ ids are never renumbered: code cites them.

| PRD | Covers |
|---|---|
| [paseo-bm-prd.md](product/paseo-bm-prd.md) | Install and machine set-up, the Manager / Worker / Reviewer loop, safety boundaries, review, reporting, provider fallback |
| [paseo-bm-dashboard-prd.md](product/paseo-bm-dashboard-prd.md) | The trace store and the history it keeps (its screen requirements are replaced by the autonomy PRD, REQ-118) |
| [paseo-bm-autonomy-prd.md](product/paseo-bm-autonomy-prd.md) | Calibrated autonomy: the Orchestrator, decisions as stored objects, autonomy levels per project, evidence, the action boundary, traceability, specialisation on evidence |

## How the product does it — `design/`

Code cites designs by name and section ("autonomy design §G.2", "design §7.13"); section numbers are never changed.

| Design | Covers |
|---|---|
| [paseo-bm.md](design/paseo-bm.md) — "the design" | Packaging and release, the data folder, machine set-up, Paseo configuration, the plugin server: the agent-creation hook, Manager, agent tools, `BM-*` notices, review budget, questions and answers, fallback, traces |
| [paseo-bm-dashboard.md](design/paseo-bm-dashboard.md) | The trace store, a trace per request, process steps, tokens and cost, the Beads Manager surface, the Beads board, chat cards |
| [paseo-bm-orchestrator.md](design/paseo-bm-orchestrator.md) | The Orchestrator agent: role and tools, rules and signals, the stall pass, Autopilot, `BM-COMMAND`, live coordination, the gate, the `orchestrator.*` RPCs |
| [paseo-bm-autonomy.md](design/paseo-bm-autonomy.md) | The autonomy programme, Parts A–G: decision objects and typed handoffs, autonomy per class and level, evidence, the action boundary, traceability, specialisation, coordination control |
| [paseo-bm-evaluation.md](design/paseo-bm-evaluation.md) | Metric definitions A-1 → A-11, the replay over the trace store, the evaluation suite on an isolated daemon |

Each role's behaviour lives in its own instructions, which the designs do not copy: [`manager.md`](../plugin/roles/manager.md), [`worker.md`](../plugin/roles/worker.md), [`reviewer.md`](../plugin/roles/reviewer.md), [`orchestrator.md`](../plugin/roles/orchestrator.md).

## Why — `adr/`

An ADR is never rewritten; a later ADR supersedes or amends it.

| ADR | Decision | Status |
|---|---|---|
| [001](adr/ADR-001-plugin-distribution.md) | The payload ships inside the npm package and is registered from a local directory | Superseded by 012 |
| [002](adr/ADR-002-install-ownership-model.md) | Install record with checksums, atomic writes, backups | Amended by 012 |
| [003](adr/ADR-003-skills-delegation.md) | Skill installation is delegated to the `skills` CLI | Amended by 012 |
| [004](adr/ADR-004-paseo-config-mutation.md) | Integrate through the Paseo CLI; change `config.json` minimally | Amended by 012 |
| [005](adr/ADR-005-manager-as-agent.md) | Beads Manager is an agent; the plugin is the entry point and the observation panel | Accepted |
| [006](adr/ADR-006-role-registration.md) | Roles registered as derived providers and agent profiles | Amended by 012; decision 9 superseded by 020 |
| [007](adr/ADR-007-dashboard-trace-store.md) | Trace store in the install home, deletable by the user | Accepted |
| [008](adr/ADR-008-role-settings-written-by-plugin.md) | The plugin writes role settings through `config.patch`; fallback aliases | Amended by 012 |
| [009](adr/ADR-009-payload-as-npm-package.md) | The payload is its own npm package, `paseo-bm-plugin` | Decisions 4–5 superseded by 012; the published form by 026 |
| [010](adr/ADR-010-plugin-hosted-agent-tools.md) | The plugin serves schema-typed tools to agents over MCP HTTP | Accepted |
| [011](adr/ADR-011-manager-coordinates-workers.md) | The Manager coordinates Workers within the scope the user decided | Amended by 016 |
| [012](adr/ADR-012-plugin-is-the-product.md) | The plugin from npm / paseo.cafe is the whole product; `npx paseo-bm` 0.4.0 only migrates | Accepted; the published form amended by 026 |
| [013](adr/ADR-013-orchestrator-assess-and-nudge.md) | The first Orchestrator: an assessment per click, nudges sent by the plugin | Superseded by 014 (never released) |
| [014](adr/ADR-014-orchestrator-agent-proposes-owner-approves.md) | One machine-wide Orchestrator agent proposes; the owner approves | Accepted; decisions 4–5 superseded by 015 |
| [015](adr/ADR-015-orchestrator-autopilot-per-project.md) | Autopilot per project; the owner's word in chat counts as approval | Accepted; amended by 016 |
| [016](adr/ADR-016-orchestrator-coordinates-workers-live.md) | The Orchestrator watches and commands running Workers live | Accepted |
| [017](adr/ADR-017-decisions-are-stored-objects.md) | Decisions are stored objects; typed handoffs; nobody relays | Accepted |
| [018](adr/ADR-018-calibrated-autonomy-per-class.md) | Autonomy per project × decision class, measured by agreement | Thresholds superseded by 023; decision 3, demotion and the predictor by 025 |
| [019](adr/ADR-019-action-boundary-permission-events.md) | Effectful actions held through Paseo's permission events | Accepted |
| [020](adr/ADR-020-paseo-tools-policy-per-role.md) | Every role's Paseo-tools policy written explicitly | Accepted |
| [021](adr/ADR-021-orchestrator-measured-coordination-controller.md) | The Orchestrator is a measured coordination controller: compaction, handoff, advice | Accepted |
| [022](adr/ADR-022-retirements-after-code-review.md) | Retirements after the 2026-09-30 code review: installer source, migration banner, Auto fallback | Accepted |
| [023](adr/ADR-023-delegation-without-eligibility.md) | No eligibility gate; agreement is information | Accepted; partly superseded by 025 |
| [024](adr/ADR-024-structure-tells-stops-and-waits.md) | A cut turn is told from the owner's stop by structure (`BM-INTERRUPTED`) | Accepted |
| [025](adr/ADR-025-autonomy-levels.md) | Five autonomy levels per project; no owner-only class; overrides recorded | Accepted |
| [026](adr/ADR-026-published-plugin-is-bundled.md) | The published plugin is `plugin-package/`, each entry bundled | Accepted |
| [027](adr/ADR-027-agents-write-content-code-carries-it.md) | Agents write the content; the plugin's code creates, routes and delivers | Accepted |

## Work in progress — `plans/`

A plan exists only for a piece of Designed work and moves to the archive when its beads are closed.

| Plan | State |
|---|---|
| Autonomy programme: [phase1b](plans/paseo-bm-plan-autonomy-phase1b.md), [phase2](plans/paseo-bm-plan-autonomy-phase2.md), [phase3](plans/paseo-bm-plan-autonomy-phase3.md), [phase4](plans/paseo-bm-plan-autonomy-phase4.md), [phase5](plans/paseo-bm-plan-autonomy-phase5.md), [phase6](plans/paseo-bm-plan-autonomy-phase6.md) | Every phase is built and shipped in 0.5.0. What is open is each phase's exit, judged together in the combined field period (bead `bm-autonomy-phase6-i8fc.6`), then the programme evaluation. The change-deltas 001–014 are applied and [archived](archive/README.md#the-autonomy-programmes-change-deltas) |
| [Agent tools that create and deliver](plans/paseo-bm-plan-agent-tools-delivery.md) (ADR-027) | Active, plan-ready PASS: fourteen work packages in ADR-027's five steps, spikes first; installing on the owner's daemon waits for the field period |

## Running it — `operations/`

| Document | Use it when |
|---|---|
| [Release runbook](operations/paseo-bm-release-runbook.md) | Releasing a version |
| [paseo.cafe listing record](operations/paseo-bm-cafe-listing-20260923.md) | Changing the paseo.cafe entry; the registry's traps |
| [Evaluation baseline](operations/paseo-bm-eval-baseline.md) | Comparing a phase's figures with the programme's baseline |
| [Specialist admission template](operations/paseo-bm-specialist-admission-template.md) | Proposing a new agent role or model (autonomy design §F.2) |
| Upstream requests: [cancel an agent](operations/paseo-upstream-request-agent-cancel.md), [timeline navigation](operations/paseo-upstream-request-timeline-navigation.md) | Two drafts for the Paseo maintainers, not sent yet |

Acceptance on a real daemon uses the kit in [`scripts/manual-test/`](../scripts/manual-test/README.md).

## Release notes — `releases/`

One file per version, `paseo-bm-release-notes-<version>.md`, published verbatim as the GitHub Release body. Latest: [0.5.2](releases/paseo-bm-release-notes-0.5.2.md).

## History — `archive/`

Read-only. Code and beads cite deltas, change-deltas, plans and run records by name; [archive/README.md](archive/README.md) says where each one is.
