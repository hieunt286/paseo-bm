# Implementation Plan — Calibrated autonomy, Phase 0 — Baseline

| Field | Value |
|---|---|
| Status | Completed (2026-09-29) |
| Plan-ready | PASS — 2026-09-29 — hieu.nt10 (design approved, E-1/E-2 answered, review suggestions accepted); amended by [change-001](../../plans/paseo-bm-plan-autonomy-change-001-suite-at-end.md) |
| Owner | hieu.nt10 |
| Routing decision | [PRD §0](../../product/paseo-bm-autonomy-prd.md#0-routing-decision) — plan → converter, one phase at a time |
| Requirements | [Calibrated autonomy PRD](../../product/paseo-bm-autonomy-prd.md) REQ-100 → REQ-103 (Phase 0 — Baseline), metrics A-1 → A-11 |
| Technical Design | [paseo-bm-evaluation.md](../../design/paseo-bm-evaluation.md) |
| ADR | None — no architecture decision (design header) |
| Target release | None — one release for the whole programme (PRD Q-101) |

## 1. MVP-Lock

- **In:** design §3–§9; REQ-100 → REQ-103.
- **Out of phase:** the Insights screen (Phase 1–2); A-4 (delegation does not exist yet) and A-10 (Phase 5); any change to agent behaviour; any release.
- **Exit (PRD §10, Phase 0):**
  1. the replay reproduces PRD Appendix A's *asked-questions* count and recommended-option agreement on the owner's store within ±5 % (A-1 itself is defined more strictly, design §4, and becomes the new baseline);
  2. the suite ran S1–S8 twice each on 0.4.1 and on the working tree, each run scored and each scenario marked stable or not;
  3. `docs/operations/paseo-bm-eval-baseline.md` exists, and the PRD §2 Baseline column holds the measured values and the owner's confirmed targets;
  4. `npm run verify` green.
- **Checkpoint posture:** development tooling plus one optional trace field; every step reverts with git. No irreversible point.

## 2. Work packages

| WP | Outcome | REQ | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-001 | Trace records carry `pluginVersion` | REQ-100 (c) | §3 | — | The collector writes `PLUGIN_VERSION`; `traceRecordSchema` accepts it as optional; a record without it still parses (test); `schemaVersion` unchanged |
| WP-002 | `plugin/shared/eval-metrics.ts`: every metric of §4 with its unknowns, reusing the plugin's parsers | REQ-100 (a, b), REQ-103 | §2, §4, §10 | — | Unit tests per metric on synthetic records, including each unknown case and the A-1 split (reached the owner / answered by agents / asked); one test on the 0.4.1 fixture store; same input → same output |
| WP-003 | Replay command `npm run eval:replay` (bundled by `tsup` into git-ignored `.eval-dist/`), JSON and Markdown, filters; old measurement removed | REQ-100 | §2, §5, §9 | WP-002 (the metric module) | Test on a temporary store: output schema, filters, a bad line skipped and counted, file mtimes unchanged; `scripts/measure-requests.mjs`, `test/measure-requests.test.ts` and the `measure` script deleted; root `tsconfig.json` covers `scripts/eval`; exit criterion 1 checked on a copy of the owner's store |
| WP-004 | Suite building blocks: scenario files S1–S8, fixture generator (Node project; two-package TypeScript repository for S8), simulated owner (three channels), scoring with the double run | REQ-101 | §6.1–§6.4 | WP-002 (scoring reuses the metrics) | Unit tests: fixture generation (repo, beads, bare remote, sentinel, the S8 packages type-check with the repository's `tsc`), the answer policy per channel (recommended, keyword override, 10-minute miss rule), each scoring rule (correct, boundary-clean, S6 overlap, stable across the two runs) |
| WP-005 | Suite driver on the isolated daemon: install by version, role models, Orchestrator + Autopilot for the tree, each scenario twice, score, stop | REQ-101 | §6.5, §8 | WP-004 (scenarios, owner, scoring) | Refuses port 6767 and the owner's homes (test); a dry run of S1 on the isolated daemon produces a scorecard; nothing written under `~/.paseo` or `~/.paseo-bm` (checked by hash before/after) |
| WP-006 | Baseline: field replay, suite on 0.4.1 and on the working tree, report, targets | REQ-102 | §7 | WP-001 (tree records carry their version), WP-003 (replay), WP-005 (suite) | Exit criteria 1–3 of §1 met; the owner confirmed the targets |

WP-001, WP-002 can start together; WP-003 and WP-004 follow WP-002 and can run in parallel.

## 3. Open decisions

| ID | Decision | Owner | Status | Blocks |
|---|---|---|---|---|
| E-1 | The suite uses both model families as the owner runs them: Opus 5.5 (Manager, Worker, Orchestrator), GPT `gpt-5.6-sol` (Reviewer) | hieu.nt10 | **answered 2026-09-29** | — |
| E-2 | The working tree runs with the Orchestrator and Autopilot on; 0.4.1 runs without an Orchestrator | hieu.nt10 | **answered 2026-09-29** | — |

## 4. Test strategy

Vitest, as the rest of the repository: pure modules (`eval-metrics`, scoring, answer policy, fixtures) by unit tests on synthetic data and the 0.4.1 fixture store; the replay by a test on a temporary store; the collector field by the existing collector tests extended. The driver is proved by its dry run (WP-005) and by the baseline runs themselves (WP-006), recorded in the report. No coverage target (the repository sets none).

## 5. Risks

- **Suite flakiness** (models vary run to run): a scenario is judged on outcomes and boundaries, not wording, and every scenario runs twice so instability is visible rather than hidden.
- **Cost:** eight scenarios × two runs ≈ sixteen real requests per suite run, two suite runs for the baseline (owner accepted, PRD Q-104 and 2026-09-29).
- **Field metrics are approximate** where the data is (A-5 lower bound, A-7 pairing, A-1 "reached the owner" inferred from typed messages): labelled in the report; Phase 1 decision objects make them exact.
- **The Orchestrator and the simulated owner answering the same question** (tree run): prevented by the 10-minute miss rule (design §6.3).

## 6. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | **Completed.** Change-001 applied: exit criterion 2 (the suite) moved to Phase 6 WP-604 (owner decision); targets confirmed from the field baseline (PRD §2, A-8 amended). Beads: epic `bm-autonomy-phase0-m1ih` closed (8 implemented, `.9` moved, `.10` targets). `npm run verify` green. Archived |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Progress: 8 of 10 beads closed (trace version, metric module, replay, scenarios and fixtures, simulated owner, scoring, suite driver with a live S1 dry run, field baseline). The suite baseline (`m1ih.9`, ~32 real requests) is **deferred by the owner** until a convenient time; `m1ih.10` (targets) waits on it |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Converted to beads: epic `bm-autonomy-phase0-m1ih` with 10 leaves (WP-004 split into scenarios/fixtures, simulated owner, scoring; WP-006 into field baseline, suite baseline, closing targets); labels `feature:autonomy`, `phase:a0-baseline`, `wp:wp-00N`; no cycle, lint clean. The metric tests use the synthetic trace builders of `test/fixtures/orchestrator-traces.ts` (no recorded 0.4.1 store exists; design §10 corrected) |
| 2026-09-29 | hieu.nt10 | **Active**, `plan-ready-for-beads` PASS. Design approved; E-1 (both model families as the owner runs them) and E-2 (Orchestrator and Autopilot for the tree) answered; the review's suggestions accepted: every scenario twice, S6 checkable, S8 two-package TypeScript scenario |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan review (`reviewing-plan`): routing link, REQ and exit per WP, E-1/E-2 blocking WP-005, test strategy; exit criterion 1 compares the asked-questions figure (A-1 is now stricter); removal of the old measurement includes its test; the replay is bundled by `tsup` |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for Phase 0 of the calibrated autonomy programme |
