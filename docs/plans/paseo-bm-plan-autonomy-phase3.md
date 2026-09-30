# Implementation Plan — Calibrated autonomy, Phase 3: evidence-grounded reflection

| Field | Value |
|---|---|
| Status | Active — converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 3: REQ-130 → REQ-133 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part C |
| Starts after | Phase 2 MVP exit |
| Target release | None — one release for the whole programme |

## 1. MVP-Lock

- **In:** §C.1 → §C.5, and the Worker's instructions (WP-302): name each check in `buildAndTests` exactly as run, without pipes, so it can be detected. **Out:** holding actions (Phase 4); traceability (Phase 5).
- **Exit (PRD §10 Phase 3):** every finished request in the field after the phase carries detected evidence or is shown unverified; review lift reported; A-8 no regression > 10 %; `npm run verify` green; owner acceptance.
- **Checkpoint posture:** additive evidence fields (`v` unchanged); no rollback between phases — a clean reinstall and a fix forward (DQ-1).

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-301 | Richer shell evidence: `status`, `exitCode`, `cwd`, `callId` recorded (optional), `detail` redacted | REQ-130 | §C.1 | — | Collector tests on Claude and Codex entry shapes (Claude has no `exitCode`: `status: failed` counts); old records still parse; redaction test |
| WP-302 | Detected / self-reported / unverified checks, and `finished-unverified` on the stage bar, the finished card and `request.finished`; an unverified finish counts as work left, so it wakes the Orchestrator under the Phase 1 wake rule (`workLeftOf`, design §A.8), and a delegate cannot act on it | REQ-130, REQ-131 | §C.2, §C.3, §A.8 | WP-301 | Pure classification tests (same command after the last edit, failed run, piped command, no check named); event tests incl. an unverified finish with nothing else left publishing `request.finished`; card tests; delegation refusal test |
| WP-303 | Review lift in the replay and Insights; the review budget per tier becomes a setting only through the owner | REQ-132 | §C.4 | WP-301 | `eval-metrics` tests for the new figures; Insights model test |
| WP-304 | Independent review by default: the Reviewer's family differs from the Worker's when another is signed in; Settings says when they match | REQ-133 | §C.5 | — | Role-creation tests with one and with two signed-in families; Settings model test |
| WP-305 | Phase exit: field replay of the owner's use of the new build, report, owner acceptance | PRD §10 Phase 3 | Evaluation design §5, §7 | WP-302, WP-303, WP-304 | Field figures in the baseline report; exit metrics met or reasoned |

## 3. Open decisions

None.

## 4. Test strategy

Collector and pure-module unit tests with real entry shapes; the field replay for the exit.

## 5. Risks

- **Checks run by shell pipelines** (`npm test | tail`) hide their status: counted as self-reported, never as detected.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §C.6 decisions; REQ-130's files changed and beads closed added to `bm-autonomy-phase3-7gxw.3`/`.4`; the Reviewer's family is the model's vendor |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase3-7gxw` with 7 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](./paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): WP-302 makes an unverified finish wake the Orchestrator, since Phase 1 wakes it only when a finish shows work left |
| 2026-09-29 | Claude (owner's delegation) | A-8 exit follows the amended PRD target (no regression > 10 %) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the Worker's instruction on naming checks made explicit |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the phase exit uses the field replay and a small live check instead of the suite (owner decision: the suite runs once at the programme's end, Phase 6 WP-604) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; DQ-1 applied; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 3 |
