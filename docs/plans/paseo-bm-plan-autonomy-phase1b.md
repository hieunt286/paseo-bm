# Implementation Plan — Calibrated autonomy, Phase 1 MVP (part b): the management experience, retirement and exit

| Field | Value |
|---|---|
| Status | Active — built and shipped in 0.5.0; the phase exit (`bm-autonomy-phase1b-dbdv.7`) is open, judged in the combined field period (bead `bm-autonomy-phase6-i8fc.6`). Amended by [change-001](../archive/plans/paseo-bm-plan-autonomy-change-001-suite-at-end.md), [change-002](../archive/plans/paseo-bm-plan-autonomy-change-002-phase1-as-built.md) and [change-004](../archive/plans/paseo-bm-plan-autonomy-change-004-orchestrator-answers.md) |
| Plan-ready | PASS — 2026-09-29 — hieu.nt10 (design Active, DQ-3 answered: no sidebar badge) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 1 MVP: REQ-111 (b), REQ-118, REQ-119, REQ-171, REQ-172; exit criteria of PRD §10 Phase 1 MVP |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) §A.12 → §A.15; [experience concept](../archive/design/paseo-bm-experience-concept.md) |
| ADR | [ADR-017](../adr/ADR-017-decisions-are-stored-objects.md) |
| Starts after | [Phase 1 part a](../archive/plans/paseo-bm-plan-autonomy-phase1a.md) WP-102 → WP-106 (the surfaces render its decisions and events) |
| Target release | 0.5.0 — one release for the whole programme |

## 1. MVP-Lock

- **In:** §A.12 (surface, Inbox, Work, Insights for Phase 1, Settings, cards v2; no sidebar badge — the Inbox handles it, DQ-3), §A.13 (eval adapter), §A.14 (retirement), docs.
- **Out:** Decided-for-you content and autonomy in Insights (Phase 2), review lift (Phase 3), "Why?" (Phase 5).
- **Exit (PRD §10 Phase 1 MVP):** in the field replay of the owner's use of the new build (at least 10 requests) and a live check on the isolated daemon of S1 and S7 with the `decision-rpc` channel (two requests, one run) — A-2 = 0, A-3 at target (1, or 2 when the answer grants a release, data, security or cost effect), A-7 < 20 %, A-8 not worse than the field baseline by more than 10 %; every surface of the Phase 1 retirement list deleted; the owner accepts the new screens on a phone width and a desktop width; `npm run verify` and `npm run smoke:packed` green.
- **Checkpoint posture:** working tree only; no rollback between phases — a clean reinstall and a fix forward (DQ-1).

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-108 | The management surface: Inbox · Work · Insights · Settings on one surface, opened on a project through the slot pattern; Settings built from the Setup components (Agents, Tools & skills, Data). Four separable outcomes for the converter: (i) the surface shell and the Inbox, (ii) Work, (iii) Settings, (iv) Insights; no sidebar badge: the Inbox tab's label carries the count (DQ-3) | REQ-118 | §A.12 | Part a WP-102 (decisions RPCs), WP-106 (alerts) | Hook-free models tested (`test/helpers/element-tree.ts`); Inbox groups open decisions by project, oldest first, with alerts; Work shows stage bar, timeline, board (Closed hidden by default), agents; the Inbox tab label shows the count of open decisions and alerts; phone and desktop widths checked by the owner |
| WP-109 | Cards v2 in the chats: `decision` (live, 5 s poll while open), `progress`, `finished`, `verdict`, `brief`, `action`, `notice`; one frame in `ui.tsx` | REQ-111 (b), REQ-118 (c) | §A.12 (cards) | Part a WP-102, WP-104 | Card model tests per type; the same decision answered in the Inbox shows answered on the card within one poll; no reply box, no mark-as-answered; an unknown block still falls back to the generic notice |
| WP-110 | Retirement sweep and documents: every row of §A.14 deleted with its tests; the replaced sections of the Base, Dashboard and Orchestrator designs rewritten or removed; GUIDE and README describe only what exists | REQ-119, REQ-172 | §A.14 | WP-108, WP-109 (the replacements exist) | `git grep` finds none of the retired names outside `docs/archive/` and `.beads/`; retired data files (`ui/qa-ledger.json`, `ui/answer-marks.json`, command entries of `orchestrator/proposals.json`, event keys of `orchestrator/stalls.json`, the Watch field of `orchestrator/settings.json`) ignored by the new build and removed by the cleanup button (PRD §11 rule 2), with tests; docs index updated; `npm run verify` green |
| WP-111 | Evaluation adapter and the Phase 1 exit: `decision-rpc` channel in `scripts/eval/owner.ts` (the programme evaluation uses it); a live check of S1 and S7 with it on the isolated daemon; the field replay after the owner's use of the new build, installed by the owner as a frozen copy of a commit (the published file set of `plugin/` exported with `git archive` to a folder outside the repository, checked on an isolated daemon, then `paseo plugin remove paseo-bm` and `paseo plugin add <that folder>`), so later edits never reach the build in use; back to the release with `paseo plugin add npm:paseo-bm-plugin@0.4.1` (change-002) | PRD §10 Phase 1 exit | §A.13; Evaluation design §5, §7 | WP-110 (the tree is final for the phase), WP-112 (the metrics read the Phase 1 stores) | Adapter unit tests; the live check's run note and the field figures appended to `docs/operations/paseo-bm-eval-baseline.md`; exit metrics compared with the field baseline — A-7 judged in the field, since S1 and S7 hold no judgement event; the owner's review of the four sections at phone and desktop widths (deferred from WP-108); acceptance recorded |
| WP-112 | The metrics read the Phase 1 stores: A-1, A-2 (c) and A-6 from `decisions/`; A-7 from a wake record `orchestrator/wakes.json` (ids, times, a count) written by the event bus | PRD §2 A-1, A-2, A-6, A-7 | Evaluation design §4 | WP-110 | Synthetic-store tests per metric; the recorded field baseline unchanged; the live check re-scored (S7's question reached the owner, its push authorised) |
| WP-113 | The Orchestrator answers a Worker's question through the decision store: `bm_decide` settles the `q:` decision `by: orchestrator` and the plugin delivers it; a hand-written `BM-ANSWERS` for a question with a decision is refused (field finding, [change-004](../archive/plans/paseo-bm-plan-autonomy-change-004-orchestrator-answers.md)) | REQ-110, REQ-111, REQ-115 | §A.6, §A.9, §B.9 | — | The field case replayed as a boundary test; tool, card and metric tests; bead `bm-autonomy-phase1b-dbdv.9` |

## 3. Open decisions

| ID | Decision | Owner | Status | Blocks |
|---|---|---|---|---|
| DQ-3 | Sidebar badge | hieu.nt10 | **answered 2026-09-29** — dropped; the Inbox handles it | — |

## 4. Test strategy

Hook-free view models and pure card models by unit tests (the repository's client pattern); source assertions only where a test already uses them; the owner's acceptance for layout; the evaluation suite for the exit metrics.

## 5. Risks

- **UI scope:** reuse is maximised (Setup components, board, tree, card components); anything not reused is new code with tests.
- **Polling cost** of 5 s on open decisions: limited to decisions shown and open.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-006](../archive/plans/paseo-bm-plan-autonomy-change-006-build-then-field.md): built without waiting for the previous phase's field gate; this phase's exit is judged in the combined field period on the final build |
| 2026-09-30 | Claude (at the owner's request) | The fixed build (commit `685baf9`, change-004) installed on the owner's daemon at 04:46 UTC as the frozen copy `phase1-685baf9`; the Phase 1 field window restarts there |
| 2026-09-30 | Claude (owner approved) | [change-004](../archive/plans/paseo-bm-plan-autonomy-change-004-orchestrator-answers.md): WP-113 from the owner's field report — the Orchestrator's answers go through the decision store (`bm_decide`); decision options wrap; the field window restarts at the fixed build |
| 2026-09-30 | Claude (owner's delegation) | WP-111: the owner installed commit `df6b182` as a frozen copy on 2026-09-30 03:02 UTC (field window starts there); the install path is written as it was done |
| 2026-09-29 | Claude (owner's delegation) | [change-002](../archive/plans/paseo-bm-plan-autonomy-change-002-phase1-as-built.md) applied after the plan review: exit A-3 at target; WP-112 (bead `.8`); WP-111 names the owner's install path and the deferred screen review, and judges A-7 in the field; part a completed and archived |
| 2026-09-29 | Claude (owner's delegation) | Exit, part 1 completed: bead `.8` made the metrics read the decision store and a wake record; the re-run live checks found every Orchestrator wake ended with no action, so only a judgement now wakes it (autonomy design §A.8); the last S1/S7 run is correct, boundary-clean, A-1 and A-6 right, zero wakes (run note docs/archive/operations/paseo-bm-phase1-live-check-2-20260929.md). The field replay still waits for ≥ 10 owner requests on the new build |
| 2026-09-29 | Claude (owner's delegation) | Exit, part 1: the `decision-rpc` channel built and the S1/S7 live check correct and boundary-clean (run note docs/archive/operations/paseo-bm-phase1-live-check-20260929.md; owner config hash unchanged). The note's open question on A-3 is settled: the confirmation tap counts, target 2 for a confirm-class decision (PRD §2), so S7 met its target at 2. The field replay waits for ≥ 10 owner requests on the new build |
| 2026-09-29 | Claude (owner's delegation) | Converted to beads: epic `bm-autonomy-phase1b-dbdv` with 7 leaves (WP-108 → 4); labels `feature:autonomy`, `phase:a1-mvp`, `wp:wp-1NN`; no cycle, lint clean |
| 2026-09-29 | Claude (owner's delegation) | [change-001](../archive/plans/paseo-bm-plan-autonomy-change-001-suite-at-end.md) applied: exit by field replay and a two-request live check; WP-108 split guidance; WP-110 removes retired data files |
| 2026-09-29 | hieu.nt10 | **Active**, `plan-ready-for-beads` PASS; DQ-3 applied (no sidebar badge, the Inbox tab's label carries the count) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 1 MVP part b |
