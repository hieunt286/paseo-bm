# Implementation Plan — Calibrated autonomy, Phase 2 MVP: autonomy earned per decision class

| Field | Value |
|---|---|
| Status | Active — amended by [change-005](./paseo-bm-plan-autonomy-change-005-coordination-control.md) and, at the phase start, [change-007](./paseo-bm-plan-autonomy-change-007-phase2-start.md); converted to beads 2026-09-30 at the owner's request; re-checked at the phase start against what the previous phase measured (the phase's first bead) |
| Plan-ready | PASS — 2026-09-30 — Claude under the owner's delegation (hieu.nt10 asked to convert the reviewed plans; `plan-ready-for-beads` self-evaluated) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) Phase 2 MVP: REQ-120 → REQ-128 |
| Technical Design | [paseo-bm-autonomy.md](../design/paseo-bm-autonomy.md) Part B; Part G §G.1–§G.4, §G.7 (measurement, intervention log, advice) |
| ADR | [ADR-018](../adr/ADR-018-calibrated-autonomy-per-class.md), [ADR-021](../adr/ADR-021-orchestrator-measured-coordination-controller.md) |
| Starts after | Phase 1 MVP exit — since change-006, the previous phase **as built** (its code and isolated live check); its field exit is judged in the combined field period at the end |
| Target release | None — one release for the whole programme |

## 1. MVP-Lock

- **In:** §B.1 → §B.9 and §G.1 → §G.4, §G.7's `advice.everyFinished`. Every WP that adds a mechanism an agent uses also updates that role's instructions within its budget (design §A.11), proved by `test/roles-content.test.ts`: the Worker's `class` and `subject` (WP-201, WP-206), the Orchestrator's `bm_predict` and `bm_decide` (WP-203, WP-205), the Manager's and Worker's use of injected precedents (WP-206).
- **Out:** evidence rules for acting on a finish (Phase 3); holding actions before they run (Phase 4).
- **Exit (PRD §10 Phase 2 MVP):**
  - At least two weeks of shadow data on the owner's machine.
  - A-1 ≤ 1.5 in the field.
  - A-4 < 5 % and A-5 within the owner's own rate for every delegated class.
  - A-7 < 20 % in the field (PRD cost NFR — the challenger adds wakes).
  - The measurement (WP-209) and the intervention log (WP-210) in use, and the Phase 3 threshold defaults derived from them.
  - Advice given at least once per active project (WP-211).
  - `npm run verify` green; the owner's acceptance.

  *Windows* (change-007): A-1, A-4 and A-5 are judged over the **delegation window**, the finished requests after the owner's first promotion (at least 10). A-7 and A-8 are judged over the whole window. If no cell is eligible by day 21 of the combined field period, A-1 is judged over the whole window, with the per-cell figures. An **active project** is one with at least `advice.everyFinished` finished requests in the window.
- **Inherited from Phase 1 (change-002):** Autopilot is still on the server with no screen (`orchestrator.set-autopilot`, the Orchestrator's `bm_set_autopilot`, `orchestrator.apply-suggestion`, the `autopilot`/`allow` fields of `settings.json` and `orchestrator.state`); the Watch switch is already gone. The event bus wakes the Orchestrator only for a judgement (design §A.8: no `decision.opened` for a question with a `CONFIRM_EFFECTS` option, `request.finished` only with work left). A-7 reads `orchestrator/wakes.json`. The evaluation suite turns Autopilot on for the tree with `orchestrator.set-autopilot` (`scripts/eval/suite.ts`).
- **Checkpoint posture:** every class can be returned to `owner` in one action per project (`autonomy.reset`); no rollback between phases — a clean reinstall and a fix forward (DQ-1).

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-201 | Decision classes: the `class` field, proposed by the asker (`bm_report`, `bm_ask_owner`), checked against effects, riskier wins | REQ-120 | §B.1 | — | Pure tests of the effect → class map and the conflict order; tool schema tests |
| WP-202 | The policy: store, RPCs (`autonomy.policy/set/reset`), hard-owner classes refused, the Settings matrix; Autopilot (`orchestrator.set-autopilot`, `bm_set_autopilot`, the Orchestrator's Autopilot instructions), Allow… and the `settings.json` v3 fields removed; the suite driver sets the policy instead of Autopilot — for the tree, every class that may be delegated is delegated to the Orchestrator, the equivalent of owner decision E-2 ("the Orchestrator and Autopilot"); the live Worker watch and the Orchestrator's events, scoped to Autopilot projects in Phase 1, move to every project that has any class above `owner` (and the watch's `stuck`/`permission-waiting`/`danger` alerts to every project, since they cost no model call) | REQ-121 | §B.2, §B.8 | WP-201 | RPC and negative tests (delegate refused for release/data/security/cost; reset); Settings model tests; suite driver test (no retired RPC called for the tree); retired names gone |
| WP-203 | Shadow and the agreement ledger: predictions recorded (recommended always; the Orchestrator's `bm_predict` when the challenger is on, DQ-4 — asked only for a class that may be delegated, never a hard-owner one), reversals detected, Insights → Autonomy; a recorded prediction is the action of its wake for A-7 (evaluation design §4 updated) | REQ-122 | §B.3 | WP-201 | Ledger tests (agreement, count, span, reversal kinds); prediction never shown to the owner before answering; no prediction asked for a hard-owner class; A-7 test: a wake answered by `bm_predict` is acted on; Insights model tests |
| WP-204 | Promotion and demotion: eligibility (≥ 90 %, ≥ 20, ≥ 14 days, no reversal), **Delegate?** confirmed by the owner, automatic demotion with an alert | REQ-123 | §B.4 | WP-202, WP-203 | Threshold tests at each boundary; demotion on override and on each reversal kind |
| WP-205 | Delegation executors: recommended by code, Orchestrator by `bm_decide`; delivery as an owner answer with `authority: policy:<class>`; the Phase 1 wake rule for `decision.opened` becomes the policy's — the Orchestrator is asked for a delegate cell whose predictor is `orchestrator` and for an `owner` or `shadow` cell of a delegable class with the challenger on (§B.9; change-007), never for a hard-owner class or with the challenger off; `decision.opened` follows this per-cell rule, not the event scope of WP-202 | REQ-121, REQ-123 | §B.5, §A.8 | WP-204 | Tests: a delegate cell answers at open; an owner cell never; a hard-owner class never, and wakes nobody; the command's `approved` never includes release/data/security/cost without a grant |
| WP-206 | Precedents: store, **Save as precedent**, Settings list, injection at agent creation (`## Owner precedents`), resolution by `subject` within the policy | REQ-124 | §B.6 | WP-201, WP-202 | Store and expiry tests; hook test for the injected section (≤ 20, workspace + global); resolution tests incl. a hard-owner class shown as a suggestion only |
| WP-207 | Digest and override in the Inbox; role additional instructions, `apply-suggestion`, rule flags used only for assessment removed | REQ-125 | §B.7, §B.8 | WP-205, WP-206 | Digest model tests; override supersedes and counts for demotion; retired names gone |
| WP-209 | Context and token measurement: `contextUsed`/`contextMax` recorded where the provider reports them (verified per provider on the isolated daemon), compaction items as evidence, tokens read per turn, per request by role, per agent, a context estimate; the Orchestrator's tokens per wake on its wake record, in the replay's A-8 (change-007); shown in Work and Insights; replay candidates and estimated savings for the Phase 3 thresholds | REQ-126 | §G.2 | — | eval-metrics and collector tests on real entry shapes; replay candidate test; Work/Insights model tests; the verification note per provider |
| WP-210 | The intervention log and outcomes: `orchestrator/interventions.json`, kinds `answer`, `unblock`, `correct`, `stop`, `advice` recorded where they happen, the outcome check, A-12 in Insights; the digest lists interventions. Two outcomes for the converter: (i) log, check and A-12; (ii) the digest's intervention lines | REQ-127 | §G.3 | (ii) needs WP-207's digest | store tests; one test per kind (met, missed, unknown); A-12 metric test; digest model test |
| WP-211 | Proactive advice and Settings → Coordination: the store and RPCs with `advice.everyFinished`; the `advice.due` event after N finished requests; `bm_findings`; prepared changes (`precedent.save`, `autonomy.set`, `coordination.set`) applied on the owner's answer; the Orchestrator's instructions. Two outcomes for the converter: (i) the Coordination settings store, RPCs and section; (ii) advice | REQ-128 | §G.4, §G.7 | WP-209, WP-210 (i), WP-202, WP-206 (the prepared changes) | event test (count, 0 = off); tool test (bounded, figures only); prepared-change tests; Settings model test; `roles-content` test |
| WP-208 | Phase exit (also needs WP-209 → WP-211): two weeks of field shadow, then the delegation window of §1 (change-007; the owner asked at install whether to switch the challenger on per project), a live check on the isolated daemon of the three policy paths (a delegated class answered by policy, a hard-owner class reaching the Inbox, a precedent resolving a question), field replay, report | PRD §10 Phase 2 | Evaluation design §5, §7 | WP-207 | Field replay in the baseline report with A-1, A-4, A-5 against targets; the live check's run note; owner acceptance |

## 3. Open decisions

| ID | Decision | Owner | Status | Blocks |
|---|---|---|---|---|
| DQ-4 | The Orchestrator challenger in shadow is off by default per project | hieu.nt10 | **answered 2026-09-29** — yes | — |

## 4. Test strategy

Pure ledger, policy and precedent logic by unit tests; fake-SDK tests for delegation delivery; negative tests for hard-owner classes in the boundary suite; two weeks of field data and a live check for the exit; the suite runs at the programme's end (Phase 6 WP-604).

## 5. Risks

- **Anchoring:** agreement with the recommendation may reflect the owner deferring to it; reversal tracking and demotion bound the damage.
- **Too few decisions in a class** to ever reach 20 in two weeks: the class stays `shadow`; that is the intended outcome.

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Phase 2 start (bead `t9lm.1`), re-checked against the field data available now (baseline report §5); A-1's target kept. [Change-007](./paseo-bm-plan-autonomy-change-007-phase2-start.md) makes these changes (beads `t9lm.4`, `.6`, `.7`, `.11`, `.18`, `.21`, `.26` and `i8fc.6` to be edited through `br`), and confirms every other §B.9 and §G.1–§G.4 decision: <br>• §1 exit: the delegation window, and a definition of the active project. <br>• WP-205: the challenger predicts for `owner` and `shadow` cells. <br>• WP-208: the challenger question at install. <br>• WP-209: the Orchestrator's tokens per wake |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-006](./paseo-bm-plan-autonomy-change-006-build-then-field.md): built without waiting for the previous phase's field gate; this phase's exit is judged in the combined field period on the final build |
| 2026-09-30 | Claude | Beads polished (second pass): WP-209's bead split into recording and provider verification (`t9lm.21`), figures and replay candidates (`t9lm.26`) and screens (`t9lm.27`) — decomposition only; the start and exit beads aligned with Part G (the exit derives and records the Phase 3 defaults); `t9lm.22` says which event a command answers; `t9lm.16` names advice as the assessment's replacement |
| 2026-09-30 | hieu.nt10 (drafted by Claude) | [change-005](./paseo-bm-plan-autonomy-change-005-coordination-control.md): WP-209 measurement, WP-210 intervention log, WP-211 advice and Settings → Coordination (ADR-021, design Part G); the exit widened |
| 2026-09-30 | Claude (owner's delegation) | Beads polished; [change-003](./paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md) applied: design §B.9 decisions; new beads `bm-autonomy-phase2-t9lm.19` (policy authority for an Orchestrator command that answers no decision, replacing Autopilot's) and `.20` (A-4/A-5); `.5`'s negative test corrected; `bm_assessment` retired in `.16` |
| 2026-09-30 | Claude (owner's delegation) | **Active**, `plan-ready-for-beads` PASS, converted to beads at the owner's request: epic `bm-autonomy-phase2-t9lm` with 18 leaves, the first a phase-start re-check whose assumptions list is settled through a delta; the phase-start re-check stays, as the phase's first bead, and changes the beads through a delta if the previous phase's figures call for it |
| 2026-09-29 | Claude (owner's delegation) | Plan review after Phase 1 ([change-002](./paseo-bm-plan-autonomy-change-002-phase1-as-built.md)): what Phase 2 inherits; WP-202 names the Autopilot pieces left on the server and moves the suite driver from Autopilot to the policy (E-2); WP-203 asks predictions only where delegation is possible and counts them as a wake's action; WP-205 takes over the wake rule; A-7 in the exit |
| 2026-09-29 | Claude (owner's delegation) | WP-202 carries the scope change of the live watch and events when Autopilot goes (found in Phase 1 bead .11) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: role-instruction updates made explicit per WP |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review: the phase exit uses the field replay and a small live check instead of the suite (owner decision: the suite runs once at the programme's end, Phase 6 WP-604) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Design and ADR-018 approved; DQ-1 and DQ-4 applied; stays Draft until the phase start |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 2 MVP |
