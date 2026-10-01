# Implementation Plan — Calibrated autonomy, Phase 6: specialisation and parallel work, on evidence

| Field | Value |
|---|---|
| Status | Active — converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 6: REQ-160 → REQ-162 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part F |
| Starts after | Phase 5 exit (WP-601 may start after Phase 3, since it only adds detection) — since change-006, the previous phase **as built** (its code and isolated live check); its field exit is judged in the combined field period at the end |
| Target release | None — one release for the whole programme; the programme closes when this phase exits |

## 1. MVP-Lock

- **In:** §F.1 (collision detection) unconditionally; §F.2 (admission) as a process; the **programme evaluation** (the full suite, moved here from Phase 0 by the owner, 2026-09-29). Candidate specialists are **not** in this plan until admitted: each admitted candidate is added by a change-delta of this plan with its own design section, then converted.
- **Exit (PRD §10 Phase 6):** every earlier phase's exit judged in the combined field period (WP-605, change-006); collision detection shipped and measured; every candidate either admitted with its scenario green or recorded as not admitted with its evidence; the programme evaluation done (WP-604); `npm run verify` green; owner acceptance — which also closes the programme before its single release.
- **Checkpoint posture:** detection is additive; each admitted candidate carries its own rollback in its delta.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-601 | `writers-observed`: two agents of one workspace with edit/write evidence on the same file in overlapping turns → Inbox alert and event; counted in the replay | REQ-161 | §F.1 | — | Pure detection tests incl. writes outside the workspace ignored; replay figure |
| WP-602 | Admission process: the candidate spec template, the evidence queries in the replay (per error class), and the model-choice experiment option of the suite driver (one role's model swapped) | REQ-160, REQ-162 | §F.2 | WP-601 | Template in `docs/operations/`; replay queries tested; the driver option unit-tested (the experiment itself runs in WP-604) |
| WP-603 | Admission review with the owner: each candidate (security reviewer, independent tester, read-only scout, design committee, per-Worker worktrees, cheaper model per role) judged on its evidence; admitted ones added by change-delta | REQ-160 → REQ-162 | §F.2 | WP-602, WP-605 and every earlier phase's exit | A decision per candidate recorded in this plan's revision history; deltas created for the admitted ones |
| WP-605 | **Combined field period** (change-006; details [change-012](./paseo-bm-plan-autonomy-change-012-phase6-start.md) C1–C3): freeze the final build, confirm the Phase 4 fixes on it on an isolated daemon, the owner installs it and makes the per-project choices (action boundary, challenger), the pre-install reference is recorded, and the window is held until every phase exit's minimums are met | PRD §10 (change-006) | change-006, change-012 | WP-602 | The install record, the reference and the window's figures in the baseline report; every earlier phase exit then judged on that window |
| WP-604 | **Programme evaluation:** the full suite (S1–S8, twice each) on `paseo-bm-plugin@0.4.1` and on the final build, with any model-choice experiment the owner asks for — the final build is the release-candidate commit, the action boundary off, run only on the owner's go-ahead with the cost estimate (change-012 C6–C9); the baseline report completed; every PRD §2 target judged | REQ-101, REQ-102, PRD §10 | Evaluation design §6–§7 | WP-603 and every earlier phase's exit | Two scorecards and the verdict per target in the baseline report; the owner's acceptance, which precedes the single release. Its bead carries `Supersedes: bm-autonomy-phase0-m1ih.9` (closed as moved, change-001). Uses what Phase 1 built: the `decision-rpc` channel for the final build, `scripts/eval/legacy-contracts.ts` for 0.4.1, and the metrics that read `decisions/` and `orchestrator/wakes.json`; the tree is configured by the policy, not Autopilot (Phase 2 WP-202) |

## 3. Open decisions

Which candidates to admit — owner: hieu.nt10, at WP-603, on the evidence.

## 4. Test strategy

Pure detection tests; a targeted run of each admitted candidate's own scenario; the replay for the evidence queries; the full suite once in WP-604.

## 5. Risks

- **Admitting on intuition:** prevented by the admission rule — no evidence, no candidate.
- **A-10 misses on the change link** (change-012 C5): today's field reads 0 of 30, 18 of them because commits of other sessions are linked only by time. The definition stands unless the owner amends it before the window's draw; the risk is known before the exit.
- **The window runs long** (change-012 C3): it waits for 25 finished requests with usage up to day 21, and for its hard minimums beyond that.
- **The programme evaluation finds a regression late** (the suite runs only at the end, owner decision): each phase's field replay and live checks are the early warning; a regression found in WP-604 is fixed before the release.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's delegation) | **Phase 6 start** (bead `bm-autonomy-phase6-i8fc.2`). Read:<br>• *Phase 5 as built:* `3e5v.2`, `.3`, `.4`, `.6` closed on `npm run verify` green; `3e5v.5`'s live check not run.<br>• *The Phase 4 live check* (2026-10-01) and its fixes F1–F5 in design §D.2, not yet confirmed live.<br>• *`i8fc.1`* closed: 0 collisions, 1 pair not judged.<br>• *The field, read-only replay of 2026-09-30T19:44Z:* unchanged since change-011 (63 requests, 60 finished, 2,074 records; no build of Phases 2–5 installed). A-1 5.63 reaching the owner per finished request; A-6 131 with 11 not shown authorised, every request `unknown` for the boundary; A-7 8 of 19 wakes with no action; A-8 median 41.5 M; A-11 median 36.3 min; 1.45 blocking findings per batch.<br>• *A-10 on today's data* (seed 20261001, not the exit sample; A-10 is audited in the combined field period, change-006): 0 of 30 — 25 lack decisions from before the decision store, 18 have a change linked only by a commit by time, 3 name a bead not in the store.<br>Part F, this plan and evaluation design §6–§7 re-checked against these and the code; Part F Active. **Verdict: [change-012](./paseo-bm-plan-autonomy-change-012-phase6-start.md)**: WP-605 named; the install's pre-check and owner choices, one pre-install reference, the window's close; the exit beads on the frozen build; the A-10 choice before the draw; the final build, the boundary off, the suite's A-10 and the go-ahead with its estimate |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-006](./paseo-bm-plan-autonomy-change-006-build-then-field.md): built without waiting for the previous phase's field gate; this phase's exit is judged in the combined field period on the final build |
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §F.3 decisions (`writers-observed` alert, event and clear rule; admission template and `--role-model`) |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase6-i8fc` with 5 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](./paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): WP-604 names the closed Phase 0 bead it supersedes and the Phase 1 tooling it runs on |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: WP-604 programme evaluation added (the suite, moved from Phase 0 by the owner's decision); the model experiment runs inside it; S6 no longer cited as a phase check |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design approved; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 6 |
