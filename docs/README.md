# paseo-bm documentation — start here

The documentation in `docs/` is written in English and is **living documentation**: each file describes the product **as it runs now**, is edited in place in the same commit as the code, and gains one Revision History line. To learn why something was once decided, see the "History" section at the end of each design, then `archive/`. How to pick the process for a change (Direct / Tracked / Designed) is in [`AGENTS.md`](../AGENTS.md), section *Process*.

**The product is one package.** From 0.4.0 ([ADR-012](adr/ADR-012-plugin-is-the-product.md)) paseo-bm is the plugin `paseo-bm-plugin`, installed from paseo.cafe or with `paseo plugin add npm:paseo-bm-plugin` on Paseo 0.9+; the `npx paseo-bm` installer's last release, 0.4.0, only moves existing users over, and its source is kept at the `v0.4.0` tag ([ADR-022](adr/ADR-022-retirements-after-code-review.md)). The PRDs and designs describe the product as it is now and state clearly what is not in the code yet.

## What the product does — PRD

| Document | Contents |
|---|---|
| [paseo-bm-prd.md](product/paseo-bm-prd.md) | Installation and machine setup (target release 0.4.0: from paseo.cafe, set-up, moving existing users over), the Manager / Worker / Reviewer roles, safety boundaries, review, reporting, provider fallback |
| [paseo-bm-dashboard-prd.md](product/paseo-bm-dashboard-prd.md) | The trace store and the history it keeps; its screen and card requirements are replaced by the autonomy PRD (REQ-118) since Phase 1 |
| [paseo-bm-orchestrator-prd.md](product/paseo-bm-orchestrator-prd.md) | **Accepted** — the Orchestrator: one agent for the machine, rule-based signals, Autopilot per project, live coordination of Workers, the big-decision gate; the requirements Phase 1 replaced are named in its header |
| [paseo-bm-autonomy-prd.md](product/paseo-bm-autonomy-prd.md) | **Accepted** — the programme PRD for calibrated autonomy: seven phases from a measured baseline to decision objects, autonomy earned per class, evidence, the action boundary, traceability and specialisation on evidence; supersedes the Orchestrator PRD on acceptance |

A PRD states **the outcome the user gets**. Details such as colours, labels, limits and numbers live in the design, code and tests. A requirement not yet in the code is marked *"Not implemented yet"* in its own row.

## How the product does it — Technical Design

| Document | Contents |
|---|---|
| [paseo-bm.md](design/paseo-bm.md) | Packaging and release, the 0.4.0 migration CLI, the data folder, machine setup, Paseo configuration, the plugin's server side: the agent-creation hook, Manager, agent tools, `BM-*` notices, the review budget, questions and answers as stored decisions, fallback, trace |
| [paseo-bm-dashboard.md](design/paseo-bm-dashboard.md) | The trace store, building a trace per request, process steps, the Beads Manager surface (Inbox, Work, Insights, Settings with Roles & models), the Beads board, chat cards v2 |
| [paseo-bm-orchestrator.md](design/paseo-bm-orchestrator.md) | **Active** — the Orchestrator agent: its role and tools, the rules and signals, the stall pass, Autopilot, `BM-COMMAND`, the live watch, the gate, the Inbox's Orchestrator line, the `orchestrator.*` RPCs |
| [paseo-bm-autonomy.md](design/paseo-bm-autonomy.md) | **Active** — Phases 1–6 of the autonomy programme: decision objects and typed handoffs, calibrated autonomy per class, evidence, the action boundary, traceability, specialisation on evidence |
| [paseo-bm-evaluation.md](design/paseo-bm-evaluation.md) | **Active** — Phase 0 of the autonomy programme: metric definitions, the replay over the trace store, the evaluation suite on an isolated daemon, the baseline report |
| [paseo-bm-experience-concept.md](design/paseo-bm-experience-concept.md) | **Draft** — fresh-eye concept for the management screens (Inbox, Work, Insights, Settings) and the cards of the four roles, for the autonomy PRD |
| [paseo-bm-research-20260918-instructions-by-model.md](design/paseo-bm-research-20260918-instructions-by-model.md) | How role instructions reach Claude, Codex and OpenCode |

Each role's behaviour lives in its own instructions: [`plugin/roles/manager.md`](../plugin/roles/manager.md), [`worker.md`](../plugin/roles/worker.md), [`reviewer.md`](../plugin/roles/reviewer.md), [`orchestrator.md`](../plugin/roles/orchestrator.md). The design does not copy it.

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
| [ADR-013](adr/ADR-013-orchestrator-assess-and-nudge.md) | **Superseded by ADR-014** — the first Orchestrator (an assessment agent per click, `BM-NUDGE` sent by the plugin); built and tested, rejected by the owner before any release |
| [ADR-014](adr/ADR-014-orchestrator-agent-proposes-owner-approves.md) | **Accepted** — Orchestrator: one machine-wide agent reads every paseo-bm project through plugin tools and proposes commands to Managers; only the owner's click sends them; a stall watcher behind a switch wakes it. Amends REQ-047 of the Dashboard PRD |
| [ADR-015](adr/ADR-015-orchestrator-autopilot-per-project.md) | **Accepted** — Orchestrator Autopilot per project (answers questions and commands the Manager itself, woken on each question and finished step), the owner's word in chat counts as approval; limits: no commit/push/deploy, no real data, big decisions to the owner. Amends ADR-014 decisions 4-5 |
| [ADR-016](adr/ADR-016-orchestrator-coordinates-workers-live.md) | **Accepted** — Orchestrator: live watch of running Workers, direct Worker commands with a Manager copy (interrupt only on danger), rule gate on big decisions, read-only repo tool and notes, `BM-COMMAND` cards, coordinator's dashboard. Amends ADR-015 decision 4 and ADR-011 |
| [ADR-017](adr/ADR-017-decisions-are-stored-objects.md) | **Accepted** — decisions are stored objects rendered everywhere; typed handoffs; nobody relays; authority from declared effects and one-use grants |
| [ADR-018](adr/ADR-018-calibrated-autonomy-per-class.md) | **Accepted** — autonomy per project × decision class (owner / shadow / delegate), earned from measured agreement; precedents |
| [ADR-019](adr/ADR-019-action-boundary-permission-events.md) | **Accepted** (spike, 2026-09-30) — effectful actions held before they run through Paseo's permission events, for Claude and Codex (in a named configuration); OpenCode keeps detection |
| [ADR-020](adr/ADR-020-paseo-tools-policy-per-role.md) | **Accepted** — every role's Paseo-tools policy written explicitly (Reviewer and Orchestrator none; Manager and Worker a disabled list); supersedes ADR-006 decision 9 |
| [ADR-021](adr/ADR-021-orchestrator-measured-coordination-controller.md) | **Accepted** — the Orchestrator is a measured coordination controller: it may compact a Manager or a Worker and have the Manager hand a Worker's request over, on its own initiative within Settings; advice replaces the workflow assessment |
| [ADR-022](adr/ADR-022-retirements-after-code-review.md) | **Accepted** — after the 2026-09-30 code review: the installer source, the 0.3.x migration banner, the 0.4.1 downgrade promise and the fallback chain's Auto switch are retired (the last folded into delegating `environment`) |

An ADR is never rewritten; a new decision gets a new ADR that supersedes it.

## Plans in progress — `plans/`

| Plan | Status |
|---|---|
| [phase1b](plans/paseo-bm-plan-autonomy-phase1b.md) (Active; WP-108 → WP-110 and WP-112 built, the Phase 1 exit WP-111 waits for the owner's use of the new build), [phase2](plans/paseo-bm-plan-autonomy-phase2.md), [phase3](plans/paseo-bm-plan-autonomy-phase3.md), [phase4](plans/paseo-bm-plan-autonomy-phase4.md), [phase5](plans/paseo-bm-plan-autonomy-phase5.md), [phase6](plans/paseo-bm-plan-autonomy-phase6.md) | Active — converted to beads 2026-09-30 (epics `bm-autonomy-phase2-t9lm` … `bm-autonomy-phase6-i8fc`); each phase opens with a re-check bead against the previous phase's figures |
| [autonomy change-001](plans/paseo-bm-plan-autonomy-change-001-suite-at-end.md) | Applied — the suite at the programme's end, and the plan review's fixes to the Active plans (Phase 0, 1a, 1b) |
| [autonomy change-002](plans/paseo-bm-plan-autonomy-change-002-phase1-as-built.md) | Applied — Phase 1 as built (WP-112, the wake rule, A-3), how the owner installs the unreleased build for the exit, and what Phases 2–6 inherit |
| [autonomy change-003](plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) | Applied — the design choices the Phase 2–6 beads had left open, settled when the beads were polished; two new Phase 2 beads |
| [autonomy change-004](plans/paseo-bm-plan-autonomy-change-004-orchestrator-answers.md) | Applied — field finding: the Orchestrator answers through the decision store (`bm_decide`); decision options wrap |
| [autonomy change-005](plans/paseo-bm-plan-autonomy-change-005-coordination-control.md) | Applied — the Orchestrator as a measured coordination controller (ADR-021): measurement, intervention log and advice in Phase 2; compaction and handoff through the Manager in Phase 3 |
| [autonomy change-006](plans/paseo-bm-plan-autonomy-change-006-build-then-field.md) | Applied — the remaining phases are built continuously; every phase exit is judged in one combined field period on the final build |
| [autonomy change-007](plans/paseo-bm-plan-autonomy-change-007-phase2-start.md) | Applied to the plan and design (bead edits listed) — Phase 2 start: A-1's target kept; the challenger predicts for `owner` cells; the exit's delegation window; the challenger question at install; the Orchestrator's tokens per wake; the exit's active project |
| [autonomy change-008](plans/paseo-bm-plan-autonomy-change-008-phase3-start.md) | Applied to the plan, design and beads — Phase 3 start: the compaction and handoff defaults derived from the field; the `threshold.crossed` event; per-role compaction thresholds; the handoff command's authority and labels; the policy's `commit`/`release` refused on an unverified finish; `&&` chains and "not checked"; the review budget per tier as owner settings (new bead `7gxw.12`); the Phase 3 exit's window and pre-install references |
| [autonomy change-009](plans/paseo-bm-plan-autonomy-change-009-phase4-start.md) | Applied to the plan, design and beads — Phase 4 start: the pass path for Claude and Codex (the fail path's bead closed), detection for the rest; the modes by base provider with the Codex creation options; the `Action boundary` facts line and the `boundary-off` alert; what each request is read as; the class patterns and the scratch area shared with A-6; the held decision's kind, Paseo-prompt answers and ending; `danger` only when unauthorised; the restart scan; the field estimate before the modes switch |
| [autonomy change-010](plans/paseo-bm-plan-autonomy-change-010-boundary-per-project.md) | Applied to the plan, design and beads — the owner's decision after the field estimate failed its bound: the action boundary per project, off by default; the switch beside the autonomy policy, set only by the owner with a confirmation; off keeps today's modes and detection, and agents created while it was on are still answered; the Worker names its scratch folder literally; the gate moved to the combined field period as the threshold for a wider recommendation; the exit's live check with the boundary on and field A-6 split on/off |
| [autonomy change-011](plans/paseo-bm-plan-autonomy-change-011-phase5-start.md) | Applied to the plan, design and beads — Phase 5 start: the chain built on the rebuilt trace and the readers the product already has; every decision kind and precedents in the chain; four check verdicts; a commit is not a required link for A-10; handoff edges; `bm_why`'s `detail: "full"` and tool lists; `links.why`'s module and error codes; the A-10 definition and a read-only audit in the replay (new bead `3e5v.6`); the exit's pre-install references, a small live check and how use is shown |
| [autonomy change-012](plans/paseo-bm-plan-autonomy-change-012-phase6-start.md) | Applied to the plan, designs and beads — Phase 6 start: the combined field period as WP-605, with a pre-install check of the Phase 4 fixes on the frozen build, the owner's per-project choices at install (action boundary, challenger), one pre-install reference for every exit (A-11 included) and the window's close; the exit beads judged on the frozen build; A-10's definition kept unless the owner amends it before the window's draw (today's field reads 0 of 30, not the exit sample); the programme evaluation on the release-candidate commit with the boundary off, the suite's A-10 by hand, and the go-ahead with a cost estimate |

A plan exists only for a piece of Designed work and moves to `archive/plans/` when its work is done. Phase 0 of the autonomy programme completed on 2026-09-29: [archive/plans/paseo-bm-plan-autonomy-phase0.md](archive/plans/paseo-bm-plan-autonomy-phase0.md). The 0.4.0 single-source plan completed on 2026-09-30 (its last condition, the paseo.cafe caveats, merged 2026-09-28): [archive/plans/paseo-bm-plan-040-single-source.md](archive/plans/paseo-bm-plan-040-single-source.md). Phase 1 part a completed on 2026-09-29: [archive/plans/paseo-bm-plan-autonomy-phase1a.md](archive/plans/paseo-bm-plan-autonomy-phase1a.md). The Orchestrator plan was completed on 2026-09-28: [archive/plans/paseo-bm-plan-orchestrator.md](archive/plans/paseo-bm-plan-orchestrator.md), acceptance in [archive/operations/paseo-bm-orchestrator-run-20260928.md](archive/operations/paseo-bm-orchestrator-run-20260928.md). It was then replaced, before any release, by the Orchestrator agent of ADR-014: [archive/plans/paseo-bm-plan-orchestrator-v2.md](archive/plans/paseo-bm-plan-orchestrator-v2.md), acceptance in [archive/operations/paseo-bm-orchestrator-agent-run-20260928.md](archive/operations/paseo-bm-orchestrator-agent-run-20260928.md). Autopilot per project (ADR-015) followed on 2026-09-29: [archive/plans/paseo-bm-plan-orchestrator-autopilot.md](archive/plans/paseo-bm-plan-orchestrator-autopilot.md), acceptance in [archive/operations/paseo-bm-orchestrator-autopilot-run-20260929.md](archive/operations/paseo-bm-orchestrator-autopilot-run-20260929.md). Live coordination (ADR-016) followed the same day: [archive/plans/paseo-bm-plan-orchestrator-coordination.md](archive/plans/paseo-bm-plan-orchestrator-coordination.md), acceptance in [archive/operations/paseo-bm-orchestrator-coordination-run-20260929.md](archive/operations/paseo-bm-orchestrator-coordination-run-20260929.md).

## Operations — `operations/`

| Document | Use it when |
|---|---|
| [Evaluation baseline](operations/paseo-bm-eval-baseline.md) | The numbers every phase of the autonomy programme is compared with: field replay and suite runs |
| [Specialist admission template](operations/paseo-bm-specialist-admission-template.md) | The one-page spec a specialist agent candidate fills before the admission review: error class, evidence it is missed, token budget, evaluation scenario, decision record (autonomy design §F.2) |
| [Release runbook](operations/paseo-bm-release-runbook.md) | Releasing a version (from 0.4.1 only the `paseo-bm-plugin` package) |
| [0.4.0 install checklist](operations/paseo-bm-install-checklist.md) | Acceptance of installing from npm, set-up, migration and removal on a real daemon |
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
