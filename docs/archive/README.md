# paseo-bm archive — index

The historical record. **Read-only**: a file here is never edited, except that a link is re-pointed when the file it names moves. Files written before 2026-09-28 are in Vietnamese, as they were written. The living documents in `docs/` describe the product as it is now; nothing here overrides them.

Code comments and beads cite these files by name and section ("delta 20260917c §4.7", "change-008", "the code review §2.3"). Find the name below, then open the file.

| Folder | Contains |
|---|---|
| [design/](design/) | Design deltas and proposals merged into the living designs; the dated research note on role instructions; the experience concept; the designs' Revision History up to 2026-10-02 |
| [product/](product/) | PRD deltas merged into the living PRDs; the Orchestrator PRD; the PRDs' Revision History up to 2026-10-02 |
| [plans/](plans/) | Every completed implementation plan and every applied change-delta |
| [operations/](operations/) | Run records, live checks, spikes, diagnoses, release runs, the code review of 2026-09-30, the acceptance checklists of closed releases, and the evaluation baseline's Revision History up to 2026-10-02 |

## Archived on 2026-10-02

| File | Why |
|---|---|
| [product/paseo-bm-orchestrator-prd.md](product/paseo-bm-orchestrator-prd.md) | Superseded: the autonomy PRD replaces REQ-071 → REQ-087 (autonomy PRD §9). Code still cites those REQ ids; they resolve here |
| [design/paseo-bm-experience-concept.md](design/paseo-bm-experience-concept.md) | A Draft concept; its decisions moved into the autonomy design §A.12, as the concept itself said they would |
| [design/paseo-bm-research-20260918-instructions-by-model.md](design/paseo-bm-research-20260918-instructions-by-model.md) | A dated research report (2026-09-18), not a maintained design; AGENTS.md cites it for how each provider receives the system prompt |
| [operations/paseo-bm-install-checklist.md](operations/paseo-bm-install-checklist.md) | Acceptance of the 0.4.0 install and migration; that release is done |
| [operations/paseo-bm-orchestration-checklist.md](operations/paseo-bm-orchestration-checklist.md) | Acceptance of the 0.3.0 loop; role instructions and the product have moved on. The live acceptance kit is `scripts/manual-test/` |
| [operations/paseo-bm-worker-fallback-checklist.md](operations/paseo-bm-worker-fallback-checklist.md) | Acceptance of the 0.3.0 fallback, written for the retired installer |
| `plans/paseo-bm-plan-autonomy-change-001` … `-014` | The autonomy programme's change-deltas, all applied to its plans, designs and beads (table below) |
| `*-revision-history-to-20261002.md` (design/, product/, operations/) | The Revision History tables of the eight living PRDs and designs and of the evaluation baseline, up to the restructure |

## Design deltas merged into the base design (`design/paseo-bm.md`)

Merged on 2026-09-25. [Proposal 20260921-worker-fallback-and-role-settings](design/paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) is kept as the checked source for the fallback part.

| Delta | Date | Brought in |
|---|---|---|
| [20260916-trace-store](design/paseo-bm-delta-20260916-trace-store.md) | 2026-09-16 | `traces/` in the install home; the `user-data` ownership kind; the Dashboard's RPC error codes |
| [20260916-review-budget](design/paseo-bm-delta-20260916-review-budget.md) | 2026-09-16 | The batch review rule (now in the role instructions; the budget numbers have been replaced) |
| [20260917-workflow-skills](design/paseo-bm-delta-20260917-workflow-skills.md) | 2026-09-17 | The `skillsUsed` field of `BM-REPORT`; the rest is role instructions and Dashboard |
| [20260917b-simplify-roles](design/paseo-bm-delta-20260917b-simplify-roles.md) | 2026-09-17 | The `## RULES` layout by kind in the three role files; the two-tier role content test policy |
| [20260917c-context-engineering](design/paseo-bm-delta-20260917c-context-engineering.md) | 2026-09-17 | The hook choosing and lowering modes; Runtime facts; the hook's 5-second budget; the plugin counting the review budget and `BM-BUDGET`; recognising plugin notices by text |
| [20260917e-manager-screen-and-commands](design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) | 2026-09-17 | `/bm-worker-new`, `/bm-worker-stop-all`, `agents.stop-all`, `BM-STOP` (the UI part belongs to Design Dashboard) |
| [20260917f-new-request-command](design/paseo-bm-delta-20260917f-new-request-command.md) | 2026-09-17 | The `BM-NEW-REQUEST` marker line, kept as the user's message |
| [20260918-manager-mode-model-metrics](design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) | 2026-09-18 | The Manager in a no-permission-prompt mode, switched once with the Paseo CLI, the `bm.modeSet` label, `modeNotice`; the record's `runtime` field (model metrics belong to Design Dashboard) |
| [20260918g-agent-conventions](design/paseo-bm-delta-20260918g-agent-conventions.md) | 2026-09-18 | Recognising the role by label or provider; labelling and the sweep; `BM-*` format checks and `BM-FORMAT`; the fallback Reviewer mode |
| [20260921-ci-linux-hang](design/paseo-bm-delta-20260921-ci-linux-hang.md) | 2026-09-21 | `release.yml` only Node 24 × two operating systems; how to build an unwritable path in tests |
| [20260921-worker-fallback-and-role-settings](design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) | 2026-09-21 | Profile thinking/features; running by provider capability; `BM-TOOLS`; the "Roles & models" screen and `config-writer`; the installer merging; fallback for the three roles (`BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`), Auto |
| [20260923-payload-npm-package](design/paseo-bm-delta-20260923-payload-npm-package.md) | 2026-09-23 | The `paseo-bm-plugin` package, version sync, publishing two packages in `release.yml` |
| [20260924-instruction-quality](design/paseo-bm-delta-20260924-instruction-quality.md) | 2026-09-24 | The `Worker skills` line in Runtime facts; plugin notices that describe by themselves what to do |
| [20260924-qa-ledger](design/paseo-bm-delta-20260924-qa-ledger.md) | 2026-09-24 | The Q&A ledger, `BM-ANSWERED`, `chat.waiting.answered`, `BM-BUDGET` for information only, the `questions` block of `BM-HANDOVER` |
| [20260924-worker-autonomy](design/paseo-bm-delta-20260924-worker-autonomy.md) | 2026-09-24 | `REVIEW_BUDGET = { Small: 2, Medium: 2, Large: 4 }`; the rest is role instructions |
| [20260924b-agent-tools](design/paseo-bm-delta-20260924b-agent-tools.md) | 2026-09-24 | The MCP endpoint in the plugin, `bm_report` / `bm_review` / `bm_answers`, attaching tools by base provider |
| [20260925b-stable-release](design/paseo-bm-delta-20260925b-stable-release.md) | 2026-09-25 | `release.yml` accepts stable releases; dist-tag by kind of version (`next` / `latest`); a stable release is not pushed to `next` |

## Design deltas merged into the Dashboard design (`design/paseo-bm-dashboard.md`)

| Delta | Date | Brought in |
|---|---|---|
| [delta-20260916-acceptance-fixes](design/paseo-bm-delta-20260916-acceptance-fixes.md) | 2026-09-16 | Eight rules for re-reading traces after the real acceptance run: buckets by `requestId`, cost always estimated, bead ids only in positional arguments, only the last report decides the state, the exact negative for polish, records of a deleted agent still belong to the request |
| [delta-20260916-beads-screen](design/paseo-bm-delta-20260916-beads-screen.md) | 2026-09-16 | The Beads screen, `beads.list/get/action`, three actions that hand out work through the Manager, `E_BEAD_NOT_FOUND` |
| [delta-20260916-chat-cards](design/paseo-bm-delta-20260916-chat-cards.md) | 2026-09-16 | Chat cards for messages between Manager, Worker, Reviewer; `chat.peers`; bead chips, `beads.lookup`, the "Beads in this chat" panel |
| [delta-20260916-owner-feedback](design/paseo-bm-delta-20260916-owner-feedback.md) | 2026-09-16 | Metric as cards + charts + graph; `origin` and `skill` evidence; role icons; worktree folders; who is working on a bead; `workspaces.overview`; `store` down to bytes only (the role instructions part is not merged here) |
| [delta-20260916-setup-screen](design/paseo-bm-delta-20260916-setup-screen.md) | 2026-09-16 | The Setup screen: additional instructions per role, skill check, `br`/`bv` and the Install button (the `--install-beads-tools` CLI part is not merged here) |
| [dashboard-delta-20260917d-request-attribution](design/paseo-bm-dashboard-delta-20260917d-request-attribution.md) | 2026-09-17 | Deduplication adds a fingerprint of the turn's content; anonymous Manager turns are merged only within the same Manager |
| [delta-20260917e-manager-screen-and-commands](design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) (interface part; the rest is in the base design) | 2026-09-17 | Requests split into segments, `runningAgents` and the running dot, slash command notices on the status strip; pinning removed |
| [delta-20260918-manager-mode-model-metrics](design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) (model metrics part) | 2026-09-18 | `runtime`, `usageByAgent[].runtime`, `usageByModel`, `usageByModelRole`, model lines on the graph, `modeNotice` on the status strip |
| [delta-20260918c-question-cards](design/paseo-bm-delta-20260918c-question-cards.md) | 2026-09-18 | The `BM-QUESTIONS` / `BM-ANSWERS` blocks, the `bm-questions.ts` reader, question cards in the Manager's chat (the writing rules of `worker.md`/`manager.md` are not merged here) |
| [delta-20260918d-card-replies](design/paseo-bm-delta-20260918d-card-replies.md) | 2026-09-18 | A single `sendReply` send path for every card, choices written into the Reply box, the question layout, the "Answered" chip, `chat.waiting` and the pill, "Mark as answered", `finished` cards open by default (the `manager.md` part is not merged here) |
| [delta-20260918e-beads-tab](design/paseo-bm-delta-20260918e-beads-tab.md) | 2026-09-18 | The "Beads" tab with two sub-tabs, Setup as the main screen, the status strip, the eye button, `doneText`, the header button |
| [delta-20260918f-ui-review](design/paseo-bm-delta-20260918f-ui-review.md) | 2026-09-18 | UI review: `createSlot`, a request to open the Manager is not dropped, `WorkspaceScreenHeader`, `overviewPolling`, the pinning feature removed, bead chips looked up before cutting, `soleWorkerOf` and `archived`, the pill does not rebuild the popover |
| [delta-20260921-worker-fallback-and-role-settings](design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) (interface part) | 2026-09-21 | The "Roles & models" screen and the fallback chain, the fallback incident card and pill, `replaced by` in the "Beads agents" panel, the Pi/OpenCode skill columns |
| [delta-20260924-qa-ledger](design/paseo-bm-delta-20260924-qa-ledger.md) (interface part) | 2026-09-24 | `answered` on the pill and the question card |
| [delta-20260925-kanban-quiet-colours](design/paseo-bm-delta-20260925-kanban-quiet-colours.md) | 2026-09-25 | A four-column responsive kanban, bead status by text and contrast, three tabs for Setup, `errors` and the Errors card on Metric, `beadActionResults` |

## The autonomy programme's change-deltas

Each was applied to the phase plans, the designs and the beads; the plans in `docs/plans/` already read as amended.

| Change | Brought in |
|---|---|
| [001](plans/paseo-bm-plan-autonomy-change-001-suite-at-end.md) | The evaluation suite runs once, at the programme's end; the plan review's fixes to Phases 0, 1a, 1b |
| [002](plans/paseo-bm-plan-autonomy-change-002-phase1-as-built.md) | Phase 1 as built (WP-112, the wake rule, A-3); what Phases 2–6 inherit |
| [003](plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) | Design choices left open by the Phase 2–6 beads, settled at polishing |
| [004](plans/paseo-bm-plan-autonomy-change-004-orchestrator-answers.md) | The Orchestrator answers through the decision store (`bm_decide`) |
| [005](plans/paseo-bm-plan-autonomy-change-005-coordination-control.md) | The Orchestrator as a measured coordination controller (ADR-021) |
| [006](plans/paseo-bm-plan-autonomy-change-006-build-then-field.md) | Phases built continuously; every exit judged in one combined field period |
| [007](plans/paseo-bm-plan-autonomy-change-007-phase2-start.md) | Phase 2 start: challenger, delegation window, Orchestrator tokens per wake |
| [008](plans/paseo-bm-plan-autonomy-change-008-phase3-start.md) | Phase 3 start: compaction and handoff defaults, `threshold.crossed`, review budget per tier |
| [009](plans/paseo-bm-plan-autonomy-change-009-phase4-start.md) | Phase 4 start: the action boundary's pass path for Claude and Codex, detection for the rest |
| [010](plans/paseo-bm-plan-autonomy-change-010-boundary-per-project.md) | The action boundary per project, off by default, set only by the owner |
| [011](plans/paseo-bm-plan-autonomy-change-011-phase5-start.md) | Phase 5 start: the traceability chain, `bm_why`, `links.why`, the A-10 audit |
| [012](plans/paseo-bm-plan-autonomy-change-012-phase6-start.md) | Phase 6 start: the combined field period (WP-605) and the programme evaluation |
| [013](plans/paseo-bm-plan-autonomy-change-013-delegation-without-eligibility.md) | Delegation without eligibility (ADR-023) |
| [014](plans/paseo-bm-plan-autonomy-change-014-levels-and-flat-surface.md) | Five autonomy levels per project (ADR-025); the flat management surface |

## Completed plans and their acceptance records

| Plan | Completed | Acceptance |
|---|---|---|
| [implementation-plan](plans/paseo-bm-implementation-plan.md), [v2](plans/paseo-bm-implementation-plan-v2.md) and their deltas | before 0.3.0 | run records in [operations/](operations/) |
| [dashboard-implementation-plan](plans/paseo-bm-dashboard-implementation-plan.md) | 2026-09-25 | — |
| [plan-040-single-source](plans/paseo-bm-plan-040-single-source.md) | 2026-09-30 | — |
| [plan-orchestrator](plans/paseo-bm-plan-orchestrator.md) (replaced before release by v2) | 2026-09-28 | [orchestrator-run-20260928](operations/paseo-bm-orchestrator-run-20260928.md) |
| [plan-orchestrator-v2](plans/paseo-bm-plan-orchestrator-v2.md) (ADR-014) | 2026-09-28 | [orchestrator-agent-run-20260928](operations/paseo-bm-orchestrator-agent-run-20260928.md) |
| [plan-orchestrator-autopilot](plans/paseo-bm-plan-orchestrator-autopilot.md) (ADR-015) | 2026-09-29 | [orchestrator-autopilot-run-20260929](operations/paseo-bm-orchestrator-autopilot-run-20260929.md) |
| [plan-orchestrator-coordination](plans/paseo-bm-plan-orchestrator-coordination.md) (ADR-016) | 2026-09-29 | [orchestrator-coordination-run-20260929](operations/paseo-bm-orchestrator-coordination-run-20260929.md) |
| [plan-autonomy-phase0](plans/paseo-bm-plan-autonomy-phase0.md) | 2026-09-29 | the [evaluation baseline](../operations/paseo-bm-eval-baseline.md) |
| [plan-autonomy-phase1a](plans/paseo-bm-plan-autonomy-phase1a.md) | 2026-09-29 | — |
