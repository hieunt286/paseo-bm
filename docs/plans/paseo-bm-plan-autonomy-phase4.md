# Implementation Plan — Calibrated autonomy, Phase 4: the action boundary (spike-gated)

| Field | Value |
|---|---|
| Status | Active — converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 4: REQ-140 → REQ-142 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part D |
| ADR | [ADR-019](../adr/ADR-019-action-boundary-permission-events.md) — Accepted or Rejected by WP-401 |
| Starts after | Phase 3 exit (WP-401 may run earlier, in parallel with Phase 2, since it touches no product code) |
| Target release | None — one release for the whole programme |

## 1. MVP-Lock

- **In:** §D.1 → §D.3. **Branching:** WP-401 decides the path; WP-402/WP-403 only if it passes, WP-404 only if it fails. The branch not taken is closed as not applicable, with the spike report as its reason.
- **Exit (PRD §10 Phase 4):** the spike report accepted by the owner and ADR-019 decided; then A-6 = 0 in a live check of held actions and in the field (pass path) or the fallback documented (fail path); `npm run verify` green.
- **Checkpoint posture:** the spike runs on an isolated daemon only; the pass path changes the Worker's and Reviewer's modes — reversible by restoring the mode rule (one release), no rollback between phases — a clean reinstall and a fix forward (DQ-1).

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-401 | Spike and decision: per provider and mode, which calls raise permission requests, what they carry, the plugin's response latency, behaviour with the plugin down; ADR-019 Accepted or Rejected | REQ-140 | §D.1 | — | Spike report in `docs/archive/operations/` with the measurements and the pass/fail verdict against §D.1's criteria; owner decision recorded in ADR-019 |
| WP-402 | (pass) The action boundary: classification of requests, allow at once or hold as a decision with a `permission` prepared action; grants and policy honoured | REQ-141 | §D.2 | WP-401 passed | Classification tests per effect; hold/allow tests; a held request answered from the Inbox is allowed exactly once; a held request is one Inbox decision and replaces the `permission-waiting` alert for it (one item per request, never two); an action allowed from a held decision counts as authorised in A-6 (`eval-metrics` test); latency measured on the isolated daemon |
| WP-403 | (pass) Modes: the Worker and Reviewer move to the least permissive mode the boundary supports; the Worker's instructions no longer say it runs without permission prompts; the plugin-down behaviour verified | REQ-141 | §D.2 | WP-402 | Role-mode tests; `roles-content` test for the new wording; live check with the plugin stopped: nothing allowed silently |
| WP-404 | (fail) Detection kept and documented: live-watch signals as Inbox alerts, documented as detection; ADR-019 Rejected | REQ-142 | §D.3 | WP-401 failed | Docs updated; alert tests |
| WP-405 | Phase exit: on the pass path a live check on the isolated daemon where a Worker attempts a push, a publish and a write outside the workspace — each held, one allowed from the Inbox exactly once; the field replay's A-6; report, owner acceptance | PRD §10 Phase 4 | Evaluation design §5, §7 | WP-403 or WP-404 | Run note and field A-6 in the baseline report |

## 3. Open decisions

The spike's verdict (WP-401) — owner: hieu.nt10.

## 4. Test strategy

Pure classification tests; fake-SDK permission events; the isolated daemon for the spike, the plugin-down check and the held-actions live check; the field replay for A-6.

## 5. Risks

- **A provider that does not describe the command in its request** cannot be classified: it stays on detection for that provider (recorded in the spike report).
- **A slow plugin slows every Worker:** the latency criterion in §D.1 guards it.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §D.4 decisions (held-request id, grant spent, policy coverage, hand-set mode); the spike still decides the patterns and the mode per provider |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase4-loga` with 6 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](./paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): WP-402 keeps one Inbox item per held request (the decision replaces Phase 1's `permission-waiting` alert) and has A-6 count an allowed held action as authorised |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: WP-403 updates the Worker's instructions with the mode |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the phase exit uses the field replay and a small live check instead of the suite (owner decision: the suite runs once at the programme's end, Phase 6 WP-604) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 4 |
