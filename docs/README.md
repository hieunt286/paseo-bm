# paseo-bm documentation — start here

Everything in `docs/` except `archive/` is **living documentation**: it describes the product **as it runs now** (0.8.0 and later work on `main`), is edited in place in the same commit as the code, and gains one Revision History line per change. Git is the audit trail; superseded documents and old history live in [`archive/`](archive/README.md). How much process a change needs (Direct / Tracked / Designed) is in [`AGENTS.md`](../AGENTS.md), section *Choose the lightest safe lane*.

paseo-bm is one package, the Paseo plugin `paseo-bm-plugin`, installed from npm with `paseo plugin add npm:paseo-bm-plugin` ([ADR-012](adr/ADR-012-plugin-is-the-product.md), [ADR-048](adr/ADR-048-no-dependency-on-paseo-cafe-and-no-bundle-size-limit.md)). What is published is `plugin-package/`, generated from `plugin/` ([ADR-026](adr/ADR-026-published-plugin-is-bundled.md)).

## What the product does — `product/`

A PRD states **the outcome the user gets**; colours, labels, limits and numbers live in the design, code and tests. A requirement not in the code yet says so in its own row. REQ ids are never renumbered: code cites them.

| PRD | Covers |
|---|---|
| [paseo-bm-prd.md](product/paseo-bm-prd.md) | Install and machine set-up, the Manager / Worker / Reviewer loop, safety boundaries, review, reporting, provider fallback, projects asking each other (peer links), resting agents, repositories that outlive their workspace, archiving finished sub-agents |
| [paseo-bm-dashboard-prd.md](product/paseo-bm-dashboard-prd.md) | The trace store and the history it keeps (its screen requirements are replaced by the autonomy PRD, REQ-118) |
| [paseo-bm-autonomy-prd.md](product/paseo-bm-autonomy-prd.md) | Calibrated autonomy: the Orchestrator, decisions as stored objects, autonomy levels per project, evidence, the action boundary, traceability, specialisation on evidence; update status, Update now and release notes (REQ-173, REQ-174) |
| [paseo-bm-missions-prd.md](product/paseo-bm-missions-prd.md) | Missions and their Mains, the governor, the mission runtime, the delivery line, bounded context, parallel lanes and the supervised line (ADR-029 → ADR-045) |

## How the product does it — `design/`

Code cites designs by name and section ("autonomy design §G.2", "design §7.13"); section numbers are never changed.

| Design | Covers |
|---|---|
| [paseo-bm.md](design/paseo-bm.md) — "the design" | Packaging and release, the data folder, machine set-up, Paseo configuration, the plugin server: the agent-creation hook, Manager, agent tools, `BM-*` notices, review budget, questions and answers, fallback, traces, peer links (§7.17); agent tools that create and deliver (§16, ADR-027) |
| [paseo-bm-dashboard.md](design/paseo-bm-dashboard.md) | The trace store, a trace per request, process steps, tokens and cost, the Beads Manager surface, the Beads board, chat cards |
| [paseo-bm-orchestrator.md](design/paseo-bm-orchestrator.md) | The Orchestrator agent: role and tools, rules and signals, the stall pass, Autopilot, `BM-COMMAND`, live coordination, the gate, the `orchestrator.*` RPCs |
| [paseo-bm-autonomy.md](design/paseo-bm-autonomy.md) | The autonomy programme, Parts A–G: decision objects and typed handoffs, autonomy per class and level, evidence, the action boundary, traceability, specialisation, coordination control |
| [paseo-bm-evaluation.md](design/paseo-bm-evaluation.md) | Metric definitions A-1 → A-11, the replay over the trace store, the evaluation suite on an isolated daemon |
| [paseo-bm-mission-runtime.md](design/paseo-bm-mission-runtime.md) | The mission runtime (ADR-033): the mission state, a long-lived Main, the authority resolver, transfers and merges, the Main's channel |
| [paseo-bm-delivery-line.md](design/paseo-bm-delivery-line.md) | The delivery line (ADR-035): bounded requests, a branch per mission, integration, review by milestone, waits by structure, one question per decision, the governor, typed messages; no waits on machines (§17), bounded context (§18), parallel lanes (§19), the supervised line (ADR-045), archiving finished sub-agents (§20) |
| [paseo-bm-missions.md](design/paseo-bm-missions.md) | Missions: the stores (mission, journal, roster, mission level, project memory), the home and the Main, the Main's tools, Main-side lookups, the two autonomy layers, the governor, the Missions screen, a mission per wake and danger to the Main first (§20) |

Each role's behaviour lives in its own instructions, which the designs do not copy: [`manager.md`](../plugin/roles/manager.md), [`worker.md`](../plugin/roles/worker.md), [`reviewer.md`](../plugin/roles/reviewer.md), [`orchestrator.md`](../plugin/roles/orchestrator.md).

## Why — `adr/`

An ADR is never rewritten; a later ADR supersedes or amends it. Each ADR's Status names which decisions changed and where.

| ADR | Decision | Status |
|---|---|---|
| [001](adr/ADR-001-plugin-distribution.md) | Distribute the plugin as a payload shipped in the npm package, registered from a local directory | Superseded by 012 |
| [002](adr/ADR-002-install-ownership-model.md) | An install record with checksums, atomic writes and backups; no full transaction journal | Accepted; amended by 012 |
| [003](adr/ADR-003-skills-delegation.md) | Delegate installing skills to the `skills` CLI; paseo-bm does not write skill files itself | Accepted; amended by 012 |
| [004](adr/ADR-004-paseo-config-mutation.md) | Integrate with Paseo through its CLI; turn on `pluginsEnabled` with a minimal edit of `config.json`, then reload | Accepted; amended by 006, 008, 012 |
| [005](adr/ADR-005-manager-as-agent.md) | Beads Manager is an agent; the plugin is only the entry point and the observation board | Accepted; extended by 011; partly superseded by 029; decision 5 clarified by 042, amended by 049 |
| [006](adr/ADR-006-role-registration.md) | Register roles with derived providers plus agent profiles; open tool permissions with a warning | Accepted; amended by 008, 012; decision 9 superseded by 020 |
| [007](adr/ADR-007-dashboard-trace-store.md) | Store the Dashboard's traces in the install home, deletable by the user | Accepted |
| [008](adr/ADR-008-role-settings-written-by-plugin.md) | The plugin writes role settings into the Paseo config through `config.patch`; fallback aliases for every role | Accepted; amended by 012 |
| [009](adr/ADR-009-payload-as-npm-package.md) | The payload is published as its own npm package `paseo-bm-plugin`, from the same repository and the same release | Accepted; decisions 4–5 superseded by 012, the published form by 026; amended by 048 |
| [010](adr/ADR-010-plugin-hosted-agent-tools.md) | The plugin serves schema-backed tools to its own agents over MCP HTTP | Accepted; amended by 017; partly superseded by 027 for bound agents |
| [011](adr/ADR-011-manager-coordinates-workers.md) | Manager coordinates Workers itself within what the user has decided | Accepted; amended by 016, 017, 028, 049; partly superseded by 029 |
| [012](adr/ADR-012-plugin-is-the-product.md) | One source: the `paseo-bm-plugin` plugin installed from npm / paseo.cafe is the whole product | Accepted; partly superseded by 022, 026; amended by 048 |
| [013](adr/ADR-013-orchestrator-assess-and-nudge.md) | Orchestrator: the plugin creates an assessment agent when asked, and nudges running agents when switched on | Superseded by 014 (never released) |
| [014](adr/ADR-014-orchestrator-agent-proposes-owner-approves.md) | Orchestrator: one machine-wide agent reads every paseo-bm project and proposes commands; only the owner's click sends them | Accepted; partly superseded by 015, 017, 021 |
| [015](adr/ADR-015-orchestrator-autopilot-per-project.md) | Orchestrator: Autopilot per project, and the owner's word in chat counts as approval | Accepted; amended by 016; partly superseded by 017, 018 |
| [016](adr/ADR-016-orchestrator-coordinates-workers-live.md) | Orchestrator: live watch of running Workers, direct Worker commands with a Manager copy, a rule gate on big decisions, structured commands | Accepted; partly superseded by 017, 018, 019, 029; amended by 032 |
| [017](adr/ADR-017-decisions-are-stored-objects.md) | Decisions are stored objects, handoffs are typed records, and nobody relays | Accepted; partly superseded by 027 for bound agents; decision 4 amended by 031 |
| [018](adr/ADR-018-calibrated-autonomy-per-class.md) | Autonomy is set per project and decision class, and earned from measured agreement | Accepted; partly superseded by 023, 025; amended by 050 |
| [019](adr/ADR-019-action-boundary-permission-events.md) | Effectful actions are held before they run, through Paseo's permission events | Accepted |
| [020](adr/ADR-020-paseo-tools-policy-per-role.md) | Every role's Paseo-tools policy is written explicitly | Accepted |
| [021](adr/ADR-021-orchestrator-measured-coordination-controller.md) | The Orchestrator is a measured coordination controller: it may compact agents and have the Manager hand work over | Accepted; partly superseded by 029; amended by 049 |
| [022](adr/ADR-022-retirements-after-code-review.md) | Retire the installer source, the 0.3.x migration banner, the 0.4.1 downgrade promise and the fallback chain's automatic switch | Accepted |
| [023](adr/ADR-023-delegation-without-eligibility.md) | The owner delegates a class whenever they choose: no eligibility gate | Accepted; partly superseded by 025 |
| [024](adr/ADR-024-structure-tells-stops-and-waits.md) | Structure, not words, tells a stop from a cut and a wait from a stall | Accepted; amended by 027, 028 |
| [025](adr/ADR-025-autonomy-levels.md) | Autonomy as five levels per project; no class is the owner's by rule | Accepted; decision 5 superseded by 029 |
| [026](adr/ADR-026-published-plugin-is-bundled.md) | The published plugin is a generated, bundled `plugin-package/` | Accepted; amended by 030, 048 |
| [027](adr/ADR-027-agents-write-content-code-carries-it.md) | Agents write the content; the plugin's code creates, routes and delivers | Accepted; extended by 028; decision 10's figures superseded by 035 |
| [028](adr/ADR-028-projects-ask-each-other-through-the-plugin.md) | Projects ask each other through the plugin: peer links | Accepted; decision 3 superseded by 029; amended by 050 |
| [029](adr/ADR-029-missions-mains-and-a-process-governor.md) | Missions and their Mains; the Orchestrator governs the process | Accepted; amended by 032; partly superseded by 033, 034, 035 |
| [030](adr/ADR-030-published-bundle-minifies-identifiers.md) | The published bundle minifies identifiers and keeps names | Accepted; decision 2 amended by 048 |
| [031](adr/ADR-031-orchestrator-decisions-grant-no-effects.md) | An answer to an Orchestrator decision grants no effect | Accepted |
| [032](adr/ADR-032-one-governor-a-mission-per-wake.md) | One governor, a mission per wake; danger goes to the Main first | Accepted; decisions 2 and 4 amended by 033 |
| [033](adr/ADR-033-the-mission-is-the-system-of-record.md) | The mission is the system of record; the Main is long-lived; one authority, one owner, a signal budget | Accepted; amended by 035, 040 |
| [034](adr/ADR-034-each-mission-has-its-own-workspace.md) | Each mission has its own workspace in the Mission-List project | Accepted; amended by 035, 049 |
| [035](adr/ADR-035-a-delivery-line.md) | A delivery line: bounded requests, a branch per mission, integration as a stage, limits that hold | Accepted; amended by 036, 038, 043, 045, 046, 049 |
| [036](adr/ADR-036-no-agent-waits-on-machines.md) | No agent waits on machines: CI off, re-reviews of the fix diff by a fresh Reviewer, Workers capped by context | Accepted; amended by 041, 045 |
| [037](adr/ADR-037-agents-are-given-a-bounded-context.md) | Agents are given a bounded context: scoped memory, budgeted briefs, summary reads, a Main compacted by tokens | Accepted |
| [038](adr/ADR-038-parallel-lanes-and-a-held-queue.md) | Parallel lanes in a repository, owner's words steered into a running turn, and a held queue | Accepted; amended by 039, 045; amended by 050 |
| [039](adr/ADR-039-new-work-never-into-a-busy-worker.md) | New work never goes into a busy Worker; outdated Mains are handed over when idle | Accepted; amended by 044, 045 |
| [040](adr/ADR-040-the-main-resolves-its-requests-fallback.md) | The Main resolves its requests' delegated provider fallback | Accepted; amended by 051 |
| [041](adr/ADR-041-incremental-review-and-affected-checks.md) | Review completed work once and validate the affected changes | Accepted; decision 4 amended by 045 |
| [042](adr/ADR-042-a-collected-agent-rests-and-a-failed-delivery-is-told.md) | A collected agent rests, and a failed delivery is told | Accepted; amended by 044, 045 |
| [043](adr/ADR-043-a-repository-outlives-its-root-workspace.md) | A repository outlives its root workspace | Accepted; amended by 047 |
| [044](adr/ADR-044-a-restart-does-not-revive-dormant-missions.md) | A plugin start does not revive a dormant mission | Accepted; decision 1 amended by 045 |
| [045](adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) | A mission runs as a supervised line of approved steps | Accepted; amended by 046, 047 |
| [046](adr/ADR-046-rollover-now-is-never-deferred-for-a-review.md) | `BM-ROLLOVER now` is never deferred for a review | Accepted |
| [047](adr/ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) | A repo's alias reaches later missions, and a peer answer takes no slot | Accepted |
| [048](adr/ADR-048-no-dependency-on-paseo-cafe-and-no-bundle-size-limit.md) | paseo-bm does not depend on paseo.cafe, and the published bundle has no size limit | Accepted |
| [049](adr/ADR-049-finished-sub-agents-are-archived.md) | Finished sub-agents are archived when nothing touched them for the owner's window | Accepted; amends 005 decision 5 and 021 |
| [050](adr/ADR-050-decisions-the-code-took-without-an-adr.md) | Decisions the code took without an ADR, recorded by the 2026-11-16 review: the Orchestrator's prediction and the Main's `bm_ask_project` retired; the held queue's own store | Accepted; amends 018 decision 3, 028 decision 2 and 038 decision 5 |
| [051](adr/ADR-051-three-owner-decisions-from-the-documentation-review.md) | Three owner decisions from the documentation review: no unverified-finish guard, the ceiling for rollover too, a replaced Main told who holds its mission | Accepted; amends 040 |

## Work in progress — `plans/`

A plan exists only for a piece of Designed work and moves to [`archive/plans/`](archive/plans/) when its beads are closed.

| Plan | State |
|---|---|
| Autonomy programme: [phase1b](plans/paseo-bm-plan-autonomy-phase1b.md), [phase2](plans/paseo-bm-plan-autonomy-phase2.md), [phase3](plans/paseo-bm-plan-autonomy-phase3.md), [phase4](plans/paseo-bm-plan-autonomy-phase4.md), [phase5](plans/paseo-bm-plan-autonomy-phase5.md), [phase6](plans/paseo-bm-plan-autonomy-phase6.md) | Built and shipped in 0.5.0. Open: each phase's exit, judged together in the combined field period (`bm-autonomy-phase6-i8fc.6`), the admission review (`i8fc.4`) and the programme evaluation (`i8fc.5`). The change-deltas 001–014 are applied and [archived](archive/README.md#the-autonomy-programmes-change-deltas) |
| [Mission line](plans/paseo-bm-mission-line.md) ([ADR-045](adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md)) | Active: Phases 1 and 2 built and released in 0.8.0; the epic `bm-mission-line-tplg` waits for the owner's acceptance |

Archived on 2026-11-16, all beads closed: [Inbox attention and update status](archive/plans/paseo-bm-attention-and-updates.md), [Update now and unified release notes](archive/plans/paseo-bm-update-and-release-notes.md).

## Running it — `operations/`

| Document | Use it when |
|---|---|
| [Release runbook](operations/paseo-bm-release-runbook.md) | Releasing a version |
| [Evaluation baseline](operations/paseo-bm-eval-baseline.md) | Comparing a phase's figures with the programme's baseline |
| [Specialist admission template](operations/paseo-bm-specialist-admission-template.md) | Proposing a new agent role or model (autonomy design §F.2) |
| Upstream requests: [cancel an agent](operations/paseo-upstream-request-agent-cancel.md), [timeline navigation](operations/paseo-upstream-request-timeline-navigation.md) | Two drafts for the Paseo maintainers, not sent yet |
| Acceptance records: [missions](operations/paseo-bm-missions-acceptance-20261009.md), [the governor](operations/paseo-bm-missions-governor-acceptance-20261009.md), [the Missions screen](operations/paseo-bm-missions-screen-acceptance-20261010.md), [peer links](operations/paseo-bm-peer-links-acceptance-20261009.md) | History: the isolated-daemon acceptance runs of 2026-10-09 and 2026-10-10 |
| [paseo.cafe listing record](operations/paseo-bm-cafe-listing-20260923.md) | History: the paseo.cafe listing, not maintained since ADR-048 |

Acceptance on a real daemon uses the kit in [`scripts/manual-test/`](../scripts/manual-test/README.md).

## Release notes — `releases/`

The **single authored changelog source**: one file per version, `paseo-bm-release-notes-<version>.md`. The release workflow uses it verbatim as the GitHub Release body, and `npm run build` validates it and embeds it in the plugin's Settings view; keep no second changelog. Latest: [0.8.0](releases/paseo-bm-release-notes-0.8.0.md).

## History — `archive/`

Read-only. Code and beads cite deltas, change-deltas, plans and run records by name; [archive/README.md](archive/README.md) says where each one is.
