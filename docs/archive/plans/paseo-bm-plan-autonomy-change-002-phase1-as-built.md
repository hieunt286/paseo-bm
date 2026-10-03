# Change Request — Phase 1 as built, and what the later phases inherit from it

| Field | Value |
|---|---|
| Change ID | `autonomy-change-002` |
| Short name | Phase 1 as built; the exit's install path; inheritance to Phases 2–6 |
| Original plans | [Phase 1a](paseo-bm-plan-autonomy-phase1a.md) (Completed by this delta), [Phase 1b](../../plans/paseo-bm-plan-autonomy-phase1b.md) (Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-29 |
| Accepted | 2026-09-29 — approved by Claude under the owner's delegation, after the plan review the owner asked for |
| Applied | 2026-09-29 |

## 1. Change summary

Phase 1 was built in 2026-09-29's session. Building and the two-request live checks changed things the Active plans do not say: a new work package (the metrics had to read the decision store), a new wake rule for the Orchestrator, a refined A-3 target, capabilities the retirement sweep had to keep, and additive contract fields. The Phase 1 exit also depends on the owner using an unreleased build, and no plan said how that build reaches the owner's machine. This delta records all of it, completes Phase 1a, and lists what Phases 2–6 inherit (their Draft plans are edited in place by the same review).

## 2. Compelling reason

- The Phase 1a plan's exit is met (epic `bm-autonomy-phase1a-odkl` closed on evidence); a completed plan moves to the archive (AGENTS.md).
- The Phase 1b exit line "A-3 = 1" contradicts the PRD as amended at the live check (the X-4 confirmation tap counts; PRD §2, §10).
- Bead `bm-autonomy-phase1b-dbdv.8` is new scope with no work package: without it the field replay could not judge A-1, A-2 (c), A-6 or A-7.
- The live checks measured A-7 = 3 of 3 wakes with no action; the wake rule of design §A.8 changed.

## 3. What changes — Before / After

| Plan · item | Before | After |
|---|---|---|
| 1a · status | Active | **Completed** 2026-09-29 and moved to `docs/archive/plans/`. As built: the role pairing is an Inbox alert on `agent.created` (the creation hook cannot see the creator; ADR-020 decision 3); outdated-agent alerts carry the agent's `role`, and a Manager's alert offers **Replace Manager** in the Inbox |
| 1a · WP-106 as built | Events for every Autopilot project; A-7 ≤ 20 % on a synthetic day | Plus **only a judgement wakes** (design §A.8): no `decision.opened` for a question with a `CONFIRM_EFFECTS` option, `request.finished` only when the report shows work left (ready beads, open findings, blockers, failing checks — `workLeftOf`) |
| 1b · MVP exit | A-3 = 1 | A-3 at target: 1, or 2 when the answer grants a release, data, security or cost effect (PRD §2) |
| 1b · work packages | WP-108 → WP-111 | Plus **WP-112** — the metrics read the Phase 1 stores: A-1, A-2 (c) and A-6 from `decisions/`, A-7 from the new wake record `orchestrator/wakes.json` (evaluation design §4). Needs WP-110; WP-111's field replay needs it. Bead `bm-autonomy-phase1b-dbdv.8` (closed) |
| 1b · WP-110 as built | Delete §A.14 | Kept working rather than lost: starting or opening the Orchestrator (the Inbox's first line), deleting or moving a closed project's history (Work's project page), models per request (a request's Details). Also deleted: `orchestrator.ask`, `orchestrator.assess-workflow`. Kept on the server until Phase 2 retires Autopilot: `orchestrator.set-autopilot`, `bm_set_autopilot`, `orchestrator.apply-suggestion`, the stall watcher (it feeds the event bus). Accepted `git grep` exceptions: archived-delta citations, recognising `BM-ANSWERED` in stored 0.4.x history, `scripts/eval/legacy-contracts.ts` for the 0.4.1 build, absence tests, the frozen 0.4.1 fixture, ADRs and history rows |
| 1b · WP-108 as built | Work rows from `orchestrator.state` | Plus the additive, optional `workPhase` field on each project of `orchestrator.state`, so a row tells Plan from Build |
| 1b · WP-111 exit | Field replay after the owner's use of "the new build" | Adds **how the build reaches the owner's machine** (no release per phase): `npm run build`, then `paseo plugin remove paseo-bm` and `paseo plugin add <repository>/plugin`; after a later rebuild, `paseo plugin reload paseo-bm`. On first open, Settings applies the role tool policies (ADR-020) and the Inbox offers to replace the outdated Manager. Back to the release: remove, then `paseo plugin add npm:paseo-bm-plugin@0.4.1` (0.4.1 ignores the new stores; DQ-1 — no other way back). The owner runs these, never an agent. The live check's A-7 is vacuous when its scenarios hold no judgement event (S1, S7): A-7 is judged by the field replay. The owner's review of the four sections at both widths, deferred by beads `.1`–`.4`, is part of this exit |

## 4. Impact

### Affected beads

| Bead ID | Action | Reason |
|---|---|---|
| `bm-autonomy-phase1b-dbdv.8` | none (created and closed 2026-09-29, label `wp:wp-111`) | Carries WP-112; its label names the exit it serves |
| `bm-autonomy-phase1b-dbdv.7` | none — its notes already name the install and review steps | WP-111 |

### Other affected artifacts

- [x] PRD §2 and §10 (A-3 target) — amended 2026-09-29.
- [x] Autonomy design §A.8 (wake rule), §A.11 (Replace Manager), §A.12 (Work, history actions) — amended 2026-09-29.
- [x] Evaluation design §4 (A-1, A-2, A-6, A-7 sources), §6.3 (`decision-rpc`) — amended 2026-09-29.
- [x] Draft plans 2, 3, 4 and 6 — edited in place by the same review (what they inherit from Phase 1).
- [ ] ADR: none.

### Risk delta

The Orchestrator is woken less. A judgement it should have made could now be missed: a finished report that hides work left in words the check does not read. Mitigation: the field replay's A-1 and the stalled-request alert still surface such a request to the owner.

## 5. Out of scope for this delta

The PRD's goals, the phase order, the one release at the programme's end.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10: "approve on my behalf … apply it"), 2026-09-29.

## 7. Apply plan

1. Phase 1a: Status Completed, a Revision History line, moved to `docs/archive/plans/`; links updated.
2. Phase 1b: the exit line, the WP-112 row, the WP-111 row, a Revision History line.
3. Draft plans 2, 3, 4, 6: edited in place.
4. Mark this delta Applied.

## 8. Things deliberately NOT changed

- The Phase 1 exit criteria other than A-3, and the owner's acceptance of the screens.
- The phase order and every phase's scope.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | Created, accepted and applied after the plan review of 2026-09-29 |
