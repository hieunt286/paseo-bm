# Implementation Plan — Calibrated autonomy, Phase 3: evidence-grounded reflection

| Field | Value |
|---|---|
| Status | Active — built and shipped in 0.5.0; the phase exit (`bm-autonomy-phase3-7gxw.7`) is open, judged in the combined field period (bead `bm-autonomy-phase6-i8fc.6`). Amended by [change-005](../archive/plans/paseo-bm-plan-autonomy-change-005-coordination-control.md) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 3: REQ-130 → REQ-136 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part C; Part G §G.5 → §G.8 (compaction, handoff, Settings) |
| ADR | [ADR-021](../adr/ADR-021-orchestrator-measured-coordination-controller.md) |
| Starts after | Phase 2 MVP exit — in practice the previous phase **as built** (its code and isolated live check, change-006); its field exit is judged in the combined field period |
| Target release | 0.5.0 — one release for the whole programme |

## 1. MVP-Lock

- **In:** §C.1 → §C.6 and §G.5 → §G.8, and the Worker's instructions (WP-302): name each check in `buildAndTests` exactly as run, without pipes, so it can be detected. **Out:** holding actions (Phase 4); traceability (Phase 5).
- **Exit (PRD §10 Phase 3):** every finished request in the field after the phase carries detected evidence or is shown unverified; review lift reported; A-8 −20 % on the heaviest 20 % of finished requests with no quality regression; A-12 ≥ 80 % for compaction and handoff; `npm run verify` green; owner acceptance.
- **Checkpoint posture:** additive evidence fields (`v` unchanged); no rollback between phases — a clean reinstall and a fix forward (DQ-1).

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-301 | Richer shell evidence: `status`, `exitCode`, `cwd`, `callId` recorded (optional), `detail` redacted | REQ-130 | §C.1 | — | Collector tests on Claude and Codex entry shapes (Claude has no `exitCode`: `status: failed` counts); old records still parse; redaction test |
| WP-302 | Detected / self-reported / unverified checks, and `finished-unverified` on the stage bar, the finished card and `request.finished`; an unverified finish counts as work left, so it wakes the Orchestrator under the Phase 1 wake rule (`workLeftOf`, design §A.8), and a delegate cannot act on it | REQ-130, REQ-131 | §C.2, §C.3, §A.8 | WP-301 | Pure classification tests (same command after the last edit, failed run, piped command, no check named); event tests incl. an unverified finish with nothing else left publishing `request.finished`; card tests; delegation refusal test |
| WP-303 | Review lift in the replay and Insights; the review budget per tier becomes a setting only through the owner | REQ-132 | §C.4 | WP-301 | `eval-metrics` tests for the new figures; Insights model test |
| WP-304 | Independent review by default: the Reviewer's family differs from the Worker's when another is signed in; Settings says when they match | REQ-133 | §C.5 | — | Role-creation tests with one and with two signed-in families; Settings model test |
| WP-306 | Compaction verified per provider on the isolated daemon: a `/compact <focus>` message through the SDK, the `compaction` timeline item, the focus honoured, `preTokens`, cost and time, how the collector classifies the message; the fallback per provider recorded in §G.5 | REQ-134 | §G.5 | — | Run note in `docs/archive/operations/`; §G.5 as built |
| WP-307 | Settings → Coordination for compaction and handoff: the fields of §G.7 with defaults from the Phase 2 measurement; a compaction or handoff kind below A-12's target switched off with an Inbox alert | REQ-136, REQ-127 | §G.7, §G.3 | WP-306 | store and RPC tests (owner-only); Settings model test; the auto-off test |
| WP-308 | Compaction on the Orchestrator's request: `bm_compact`, the safe point and idle moment, the focus template, the state brief (`BM-STATE`), the plugin's `/compact` message classified as the plugin's; the intervention logged | REQ-134 | §G.5 | WP-306, WP-307 | tool refusal tests; sequence test with a fake SDK (never into a running turn; brief after the compaction item); collector test; outcome test |
| WP-309 | Handoff through the Manager: `bm_handoff`, the outgoing Worker's `handoffNote`, the plugin-built brief, the Manager's `intent: handoff` execution, the successor's labels and verification; the Manager's and Worker's instructions within budget | REQ-135 | §G.6 | WP-307, WP-302 (the successor's detected evidence) | tool refusal tests; boundary test of the whole sequence (no archive, pairing kept, request id kept, successor proves again); `roles-content` tests; a live check on the isolated daemon |
| WP-305 | Phase exit: field replay of the owner's use of the new build, report, owner acceptance | PRD §10 Phase 3 | Evaluation design §5, §7 | WP-302, WP-303, WP-304, WP-308, WP-309 | Field figures in the baseline report; exit metrics met or reasoned |

## 3. Open decisions

None.

## 4. Test strategy

Collector and pure-module unit tests with real entry shapes; the field replay for the exit.

## 5. Risks

- **Checks run by shell pipelines** (`npm test | tail`) hide their status: counted as self-reported, never as detected.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Phase 3 start (bead `7gxw.1`), re-checked against Phase 2 as built and its live check ([run note](../archive/operations/paseo-bm-phase2-live-check-20260930.md), bead `t9lm.17`: all three paths passed; F1 and F2 fixed since) and the field data available now (baseline report §6: the replay of the whole store, 62 requests and 2,056 turns; the Phase 1 build holds 1 request, the fixed build none). <br>The Phase 3 defaults are derived there: compaction at 390,000 (Manager) and 5,700,000 (Worker) tokens read per turn, handoff at 150,000,000 per request, each p75 or p80 rounded. That gives 50 compaction and 13 handoff candidates, with upper-bound savings; the handoff's is at most 34 % of the heaviest fifth's tokens. The combined field period re-checks them (`t9lm.18`, `i8fc.6`). A-8's −20 % target is kept. <br>[Change-008](../archive/plans/paseo-bm-plan-autonomy-change-008-phase3-start.md) confirms every other §C.6 and §G.5–§G.8 decision, and makes these changes (beads `7gxw.2`–`.11`, `i8fc.6` and `t9lm.18` edited through `br`; new bead `7gxw.12` under WP-303): <br>• the `threshold.crossed` event (C1); <br>• per-role compaction thresholds, by the figure each provider reports (C2); <br>• the handoff command's authority and labels (C3); <br>• the policy's `commit`/`release` refused on an unverified finish (C4); <br>• `&&` chains, file paths and "not checked" (C5); <br>• the review budget as owner settings (C6, WP-303); <br>• the exit's window and pre-install references (C7). <br>Status stays Active |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-006](../archive/plans/paseo-bm-plan-autonomy-change-006-build-then-field.md): built without waiting for the previous phase's field gate; this phase's exit is judged in the combined field period on the final build |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-005](../archive/plans/paseo-bm-plan-autonomy-change-005-coordination-control.md): WP-306 compaction verified, WP-307 Settings for compaction and handoff, WP-308 compaction, WP-309 handoff through the Manager (ADR-021, design Part G); the exit gets A-8's target and A-12 |
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](../archive/plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §C.6 decisions; REQ-130's files changed and beads closed added to `bm-autonomy-phase3-7gxw.3`/`.4`; the Reviewer's family is the model's vendor |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase3-7gxw` with 7 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](../archive/plans/paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): WP-302 makes an unverified finish wake the Orchestrator, since Phase 1 wakes it only when a finish shows work left |
| 2026-09-29 | Claude (owner's delegation) | A-8 exit follows the amended PRD target (no regression > 10 %) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the Worker's instruction on naming checks made explicit |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the phase exit uses the field replay and a small live check instead of the suite (owner decision: the suite runs once at the programme's end, Phase 6 WP-604) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; DQ-1 applied; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 3 |
