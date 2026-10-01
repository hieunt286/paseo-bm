# Implementation Plan — Calibrated autonomy, Phase 5: traceability

| Field | Value |
|---|---|
| Status | Active — converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 5: REQ-150 → REQ-152 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part E |
| Starts after | Phase 4 exit — since change-006, the previous phase **as built** (its code and isolated live check); its field exit is judged in the combined field period at the end |
| Target release | None — one release for the whole programme |

## 1. MVP-Lock

- **In:** §E.1 → §E.3. **Out:** any new persistent store (links are derived).
- **Exit (PRD §10 Phase 5):** A-10 ≥ 90 % on 30 sampled outputs of the owner's field use; both consumers in use; `npm run verify` green; owner acceptance.
- **Checkpoint posture:** read-only derivation; nothing to migrate.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-501 | `server/links.ts`: the chain request → decisions → beads → changes (report files, commits naming a bead via read-only `git log`) → checks → verdicts → turns, with supersession | REQ-150 | §E.1 | — | Tests on synthetic stores and a temporary git repository; read-only (repository unchanged byte for byte) |
| WP-502 | `bm_why` for the Orchestrator, and one line in its instructions on when to use it | REQ-151, REQ-152 | §E.2 | WP-501 | Tool tests: a bead, a file, a decision; bounded output; `roles-content` test |
| WP-503 | Work → request → **Why?** | REQ-151, REQ-152 | §E.2 | WP-501 | View model tests; owner review on phone and desktop widths |
| WP-505 | A-10 definition in evaluation design §4, and a read-only links audit in the replay (eval tooling; [change-011](./paseo-bm-plan-autonomy-change-011-phase5-start.md) C8) | PRD §2 A-10 | §E.3, §E.4 | WP-501 | Definition written before any sample; audit tests on a synthetic store and a temporary git repository; read-only |
| WP-504 | A-10 audit and phase exit | PRD §10 Phase 5 | §E.3 | WP-502, WP-503, WP-505 | Audit of 30 samples recorded in the baseline report; a small live check on the isolated daemon |

## 3. Open decisions

None.

## 4. Test strategy

Pure derivation tests; git read-only tests; the audit for the exit.

## 5. Risks

- **Commits that name no bead** cannot be linked by message: they link by path and time. Since [change-011](./paseo-bm-plan-autonomy-change-011-phase5-start.md) C4, a commit is not a required link. A change is linked by the request's reports and file evidence, and it counts as incomplete in A-10 only when its only link is a commit by time. In the field, 35 of the agents' 100 commits name a stored bead.
- **Few decisions in a window:** a short kind is filled from the others and the counts are reported (change-011 C8).

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's delegation) | **Phase 5 start** (bead `bm-autonomy-phase5-3e5v.1`). Read:<br>• *Phase 4 as built:* `loga.3` and `loga.4` closed on `npm run verify` green, `loga.5` not applicable. `loga.6`'s live check is not yet recorded, and Part E does not depend on it.<br>• *The field, read-only replay of 2026-09-30T18:47Z:* 63 requests, 60 finished, 2,074 records. The Phase 1 build holds 2 requests, and a later tree build 1. No boundary label is recorded; A-6 is 131 with 11 not shown authorised; A-8's median is 41.5 M; A-11's median is 36.3 min.<br>• *Part E's sources:* 57 and 54 of 59 finished requests name files and beads; 94.6 % of reported bead ids resolve; 91 beads carry `Split-from:`; 5 decisions, 1 superseding; 35 of 100 agent commits name a stored bead.<br>The field exits stay judged in the combined period (change-006). **Verdict: [change-011](./paseo-bm-plan-autonomy-change-011-phase5-start.md)**, which adds WP-505 and bead `3e5v.6` |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-006](./paseo-bm-plan-autonomy-change-006-build-then-field.md): built without waiting for the previous phase's field gate; this phase's exit is judged in the combined field period on the final build |
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §E.4 decisions (`bm_why` bound, `links.why`, the A-10 sample and completeness rule) |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase5-3e5v` with 5 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: `bm_why` documented in the Orchestrator's instructions |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the phase exit uses the field replay and a small live check instead of the suite (owner decision: the suite runs once at the programme's end, Phase 6 WP-604) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 5 |
