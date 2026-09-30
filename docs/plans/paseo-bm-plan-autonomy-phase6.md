# Implementation Plan — Calibrated autonomy, Phase 6: specialisation and parallel work, on evidence

| Field | Value |
|---|---|
| Status | Active — converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 6: REQ-160 → REQ-162 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part F |
| Starts after | Phase 5 exit (WP-601 may start after Phase 3, since it only adds detection) |
| Target release | None — one release for the whole programme; the programme closes when this phase exits |

## 1. MVP-Lock

- **In:** §F.1 (collision detection) unconditionally; §F.2 (admission) as a process; the **programme evaluation** (the full suite, moved here from Phase 0 by the owner, 2026-09-29). Candidate specialists are **not** in this plan until admitted: each admitted candidate is added by a change-delta of this plan with its own design section, then converted.
- **Exit (PRD §10 Phase 6):** collision detection shipped and measured; every candidate either admitted with its scenario green or recorded as not admitted with its evidence; the programme evaluation done (WP-604); `npm run verify` green; owner acceptance — which also closes the programme before its single release.
- **Checkpoint posture:** detection is additive; each admitted candidate carries its own rollback in its delta.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-601 | `writers-observed`: two agents of one workspace with edit/write evidence on the same file in overlapping turns → Inbox alert and event; counted in the replay | REQ-161 | §F.1 | — | Pure detection tests incl. writes outside the workspace ignored; replay figure |
| WP-602 | Admission process: the candidate spec template, the evidence queries in the replay (per error class), and the model-choice experiment option of the suite driver (one role's model swapped) | REQ-160, REQ-162 | §F.2 | WP-601 | Template in `docs/operations/`; replay queries tested; the driver option unit-tested (the experiment itself runs in WP-604) |
| WP-603 | Admission review with the owner: each candidate (security reviewer, independent tester, read-only scout, design committee, per-Worker worktrees, cheaper model per role) judged on its evidence; admitted ones added by change-delta | REQ-160 → REQ-162 | §F.2 | WP-602 | A decision per candidate recorded in this plan's revision history; deltas created for the admitted ones |
| WP-604 | **Programme evaluation:** the full suite (S1–S8, twice each) on `paseo-bm-plugin@0.4.1` and on the final build, with any model-choice experiment the owner asks for; the baseline report completed; every PRD §2 target judged | REQ-101, REQ-102, PRD §10 | Evaluation design §6–§7 | WP-603 and every earlier phase's exit | Two scorecards and the verdict per target in the baseline report; the owner's acceptance, which precedes the single release. Its bead carries `Supersedes: bm-autonomy-phase0-m1ih.9` (closed as moved, change-001). Uses what Phase 1 built: the `decision-rpc` channel for the final build, `scripts/eval/legacy-contracts.ts` for 0.4.1, and the metrics that read `decisions/` and `orchestrator/wakes.json`; the tree is configured by the policy, not Autopilot (Phase 2 WP-202) |

## 3. Open decisions

Which candidates to admit — owner: hieu.nt10, at WP-603, on the evidence.

## 4. Test strategy

Pure detection tests; a targeted run of each admitted candidate's own scenario; the replay for the evidence queries; the full suite once in WP-604.

## 5. Risks

- **Admitting on intuition:** prevented by the admission rule — no evidence, no candidate.
- **The programme evaluation finds a regression late** (the suite runs only at the end, owner decision): each phase's field replay and live checks are the early warning; a regression found in WP-604 is fixed before the release.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §F.3 decisions (`writers-observed` alert, event and clear rule; admission template and `--role-model`) |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase6-i8fc` with 5 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](./paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): WP-604 names the closed Phase 0 bead it supersedes and the Phase 1 tooling it runs on |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: WP-604 programme evaluation added (the suite, moved from Phase 0 by the owner's decision); the model experiment runs inside it; S6 no longer cited as a phase check |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 6 |
