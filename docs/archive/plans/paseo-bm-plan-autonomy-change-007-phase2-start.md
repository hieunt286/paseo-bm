# Change Request — Phase 2 start: what the field data and the re-check change

| Field | Value |
|---|---|
| Change ID | `autonomy-change-007` |
| Short name | Phase 2 start re-check |
| Original plans | [Phase 2](../../plans/paseo-bm-plan-autonomy-phase2.md) (Active); the combined field period of [change-006](paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) |
| Status | Applied — plan, design and the bead edits of §4 (made through `br` by the coordinator, 2026-09-30) |
| Owner | hieu.nt10 |
| Created | 2026-09-30, bead `bm-autonomy-phase2-t9lm.1` |
| Accepted | 2026-09-30 — Claude under the owner's delegation. No target, scope or owner decision changes; C3 puts a question to the owner at install |
| Applied | 2026-09-30 (plan and design) |

## 1. Change summary

The Phase 2 start re-checked design Part B, Part G's Phase 2 sections and the plan's WP-201 → WP-211 against two things:
- the field data available on 2026-09-30 ([baseline report §5](../../operations/paseo-bm-eval-baseline.md#5-phase-2-start--the-field-data-available-on-2026-09-30));
- Part A as built.

A-1's target (≤ 1.5) is **kept**: the class mix does not show that the delegable classes cannot reach it. The re-check found three problems that would stop the phase from ever showing whether it can:
- **The challenger would never predict on a new project** (C1). The beads disagree with §B.9 on which cells it predicts for.
- **The exit window cannot contain a delegated decision** (C2). A cell needs ≥ 14 days of shadow before it can be delegated, and the exit judges only the first 14 days.
- **The only predictor measured by default does not reach the bar** (C3). The recommended option agrees about 80 % on the delegable share, below the 90 % needed.

It also found three smaller gaps (C4–C6). Every other decision of §B.9 and §G.1–§G.4 is confirmed (§3.2).

## 2. Compelling reason

Field figures (baseline report §5, replay of 2026-09-30T04:59Z):
- **Earlier field** (74 requests, 70 finished): A-1 4.80; the recommended option taken 78.8 %. About 80 % on the delegable share, under every text reading of the class. No project × class cell meets §B.4.
- **Phase 1 build** (1 request): A-1 4. Every owner-answered decision is delegable by its declared effects, and the recommended option was taken 4 of 4. A-7 1 of 4 wakes with no action.
- **The Orchestrator's cost:** its tokens are recorded nowhere in the field — 0 across 17 wakes.
- **Advice cadence:** 3 of 16 projects reached 5 finished requests in the earlier 15 days.

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | Which cells the challenger predicts for | §B.9 and bead `t9lm.7`: a prediction is asked for an `owner` or `shadow` delegable cell when the challenger is on. Plan WP-205 and bead `t9lm.11`: `decision.opened` goes to "a `shadow` cell with the challenger on … never for an `owner` cell". Bead `t9lm.4` scopes every event to projects with a cell above `owner` | **A prediction is asked for an `owner` or `shadow` cell of a delegable class whenever the project's challenger is on**, as §B.9 says. `decision.opened` follows this per-cell rule alone (a prediction, or a decision for a `delegate` cell whose predictor is `orchestrator`). The policy scope of `t9lm.4` applies to `request.finished`, `request.stalled` and `worker.signal` only. Every new cell reads `owner`, so under the old wording no project would ever get a prediction and the Orchestrator could never earn a cell |
| C2 | The window of the Phase 2 exit | ≥ 14 days after the final build's install. A-1, A-4 and A-5 are judged over that whole window (`t9lm.18`). The combined field period closes at ≥ 10 requests, ≥ 14 days and ≥ 30 outputs (`i8fc.6`) | Shadow runs ≥ 14 days from the install. **A-1, A-4 and A-5 are judged over the delegation window: the finished requests after the owner's first promotion (Delegate?), at least 10.** A-7 and A-8 are judged over the whole window. The combined field period holds its window until the delegation window is met, or until day 21 with no eligible cell. The exit then records the per-cell figures, judges A-1 over the whole window and applies `t9lm.18`'s re-set rule. Why: eligibility needs decisions spanning ≥ 14 days (§B.4), so a 14-day window holds no delegated decision, and A-4/A-5 would read unknown for every class |
| C3 | The challenger during the combined field period | Off by default per project (DQ-4). Nothing asks the owner at install | **DQ-4's default is unchanged.** At the install of the final build (`i8fc.6`) the owner is asked, per project in use, whether to switch the challenger on, and the answer is recorded. The recommendation is yes: the recommended predictor agreed about 80 % on the delegable share and no cell reached 90 %, so with the challenger off Phase 2 would most likely delegate nothing. `t9lm.18` reports agreement per predictor and names the projects that had the challenger on |
| C4 | `answer.by` in the ledger bead | Bead `t9lm.6`: `answer.by` widened to `owner \| policy \| precedent` | **`owner \| orchestrator \| policy \| precedent`**, as §B.9 says. `orchestrator` stays readable for the Phase 1 answers of `bm_decide` (change-004); Phase 2 writes `policy` for the Orchestrator's delegated answers (`t9lm.11`). A decision answered `by: orchestrator` is neither an owner answer (agreement) nor a delegated one (A-4, A-5) |
| C5 | "Advice given at least once per active project" (the exit) | "Active project" not defined | **An active project is one with at least `advice.everyFinished` finished requests in the window** (default 5). Below that, no `advice.due` can fire. In the earlier 15 days, 3 of 16 projects met it, and they held 50 of the 74 requests |
| C6 | The Orchestrator's tokens in the field | §G.8: the Orchestrator's own tokens are part of A-8. The collector records no Orchestrator turn (`recordedRoleOf`), so the field A-8 holds none of them. Only the suite reads its cost, from a snapshot | **Each wake record also keeps the tokens of the Orchestrator turn that closed it**: input, cached and output from its snapshot's `lastUsage`, which are this turn's (AGENTS.md). Numbers only, additive. The replay's A-8 reports the Orchestrator's tokens over the window and per finished request. The challenger (C1, C3) and `advice.due` add wakes, so their cost becomes visible |

### 3.2 Confirmed without change

Every decision of design §B.9 and §G.1–§G.4, against the field figures:

| Decision | Verdict and figure |
|---|---|
| §B.9 Classes: the `[class: …]` tag; no class and no mapped effect → `reversible-technical`; store `version: 1` | Confirmed. All 5 Phase 1 questions declare effects on every option; 4 declare only `none` and would read `reversible-technical` unless the Worker proposes a class (WP-201) |
| §B.9 Modes: absent = `owner`; `owner` and `shadow` alike at open; `shadow` set by a demotion; Delegate? in either mode; the challenger in both | Confirmed; C1 aligns the beads with it |
| §B.9 RPCs: `autonomy.set { …, predictor?, confirmed? }`, `autonomy.set-challenger` | Confirmed |
| §B.9 Ledger: additive fields; `answer.by`; a reopen is a reversal only when its reason cites the decision | Confirmed. The Phase 1 build's 2 reopens after an answer were review findings (baseline §3 noise). C4 aligns `t9lm.6` |
| §B.9 Which decisions agents judge: `q:` and `f:`; `bm_predict`/`bm_decide` are a wake's action; the event line names the tool | Confirmed; C1 |
| §B.9 `bm_decide` from Phase 1, with the policy swapped in by `t9lm.11` | Confirmed. The Phase 1 build's one agent answer came through the command path the fixed build refuses (A-2 = 3 there). `bm_decide` itself has no field use yet (0 requests since 04:46:31Z) |
| §B.9 Orchestrator commands without a decision: authorised by the policy, else the owner's word or a grant | Confirmed. The owner's Autopilot is on for 2 projects, and `t9lm.5` drops it outright (REQ-171). Until a cell is delegated, the Orchestrator answers no question and sends no unapproved command there. That is autonomy earned (ADR-018), not a regression to repair |
| §B.9 Demotion alert `autonomy-demoted` | Confirmed (nothing delegated yet) |
| §B.9 Precedents: RPCs; a subject is required; "owner-fixed" = the four hard-owner classes; workspace from `cwd` | Confirmed. 5 of 5 Phase 1 decisions carry a subject (4 distinct, 1 re-ask by `supersedes`). The earlier field has no subjects, so how often a subject repeats across requests is not measured yet |
| §B.9 Digest and override: `inbox/seen.json`; `r:<uuid>` | Confirmed |
| §B.9 A-4 and A-5 per delegated class | Confirmed; C2 gives them a window that holds delegated decisions |
| §B.9 Retirement: `bm_assessment` goes; advice replaces it | Confirmed |
| §G.1 the loop and the ladder | Confirmed |
| §G.2 measurement: context fields (verify), compaction evidence, tokens per turn / request / agent, the context estimate, replay candidates | Confirmed, plus C6. The Worker holds 96 % of the Phase 1 request's tokens (93 % in the earlier field) |
| §G.3 intervention kinds and windows: `answer` 10 min, `unblock` 15 min, `correct` next report, `stop` 2 min, `advice` 7 days | Confirmed. No intervention has been logged yet (the log is built in WP-210); A-12 measures them. Phase 1's answers reached an idle Worker (`sent`), within the `answer` window |
| §G.4 the trigger (`advice.due` after `advice.everyFinished` finished requests), `bm_findings`, the prepared-change kinds (`precedent.save`, `autonomy.set`, `coordination.set`; `review.budget` in Phase 3) | Confirmed; C5 defines the exit's active project. `bm_findings` has live inputs: blocked rounds 3.2 per request (3 in Phase 1), blocking findings 1.32 per batch (4.5 in Phase 1's 2 batches) |
| §G.7 `advice.everyFinished` default 5 | Confirmed. At the earlier pace the busiest project (26 finished in 15 days) gets advice about every 3 days |
| PRD §2 A-1 ≤ 1.5 | Kept, not re-set (baseline report §5.4). Judged at the Phase 2 exit and re-set there with per-class evidence if not met |

### 3.3 Considered and not changed

- **Counting the Phase 1 build's decisions as shadow data** (the recommended prediction read from the option marked recommended). Rejected: those decisions carry no proposed class. All but one would read `reversible-technical` and mix scope and preference questions into one cell.
- **Seeding the policy from the owner's Autopilot projects.** Rejected: ADR-018 (earned per class) and REQ-171 (no carry-over path).
- **Changing DQ-4's default.** It is the owner's decision; C3 asks the owner instead.

## 4. Impact

### Affected beads (edits to be made through `br`; not made by this delta)

| Bead | Action |
|---|---|
| `bm-autonomy-phase2-t9lm.4` | C1: the policy scope applies to `request.finished`, `request.stalled` and `worker.signal`. `decision.opened` keeps the Phase 1 filter until `t9lm.7`/`t9lm.11`, and is then governed by their per-cell rule, not by this scope |
| `bm-autonomy-phase2-t9lm.7` | C1: say explicitly that the prediction event is published whatever the policy scope, including for a project whose cells are all `owner`; one event test for that case |
| `bm-autonomy-phase2-t9lm.11` | C1: rule (b) becomes "an `owner` or `shadow` cell of a delegable class with the challenger on (asks `bm_predict`)". The AC "an `owner` cell never" becomes "an `owner` or `shadow` cell with the challenger off never". Its Context line quoting WP-205 is reworded to match |
| `bm-autonomy-phase2-t9lm.6` | C4: `answer.by` widened to `owner \| orchestrator \| policy \| precedent`; a `by: orchestrator` answer counts in neither agreement nor the delegated figures |
| `bm-autonomy-phase2-t9lm.21` | C6: record the tokens of the Orchestrator turn that closes a wake on its wake record (additive; `wakeEntrySchema`), one test |
| `bm-autonomy-phase2-t9lm.26` | C6: the replay's A-8 adds the Orchestrator's tokens over the window and per finished request from the wake records; evaluation design §4 A-8 as built |
| `bm-autonomy-phase2-t9lm.18` | C2: A-1, A-4 and A-5 over the delegation window (≥ 10 finished requests after the first promotion), or the whole window when no cell was eligible by day 21. C3: agreement per predictor and the projects with the challenger on. C5: the active-project definition. C6: A-8 with the Orchestrator's tokens |
| `bm-autonomy-phase6-i8fc.6` | C2: the window closes only when Phase 2's delegation window is met or day 21 has passed with no eligible cell. C3: at install, ask the owner per project in use whether to switch the challenger on, and record the answer |

No bead is added, split or closed. The dependency graph is unchanged.

### Other affected artifacts

- [x] Plan Phase 2: §1 Exit (C2, C5), WP-205 (C1), WP-208 (C2), WP-209 (C6), the status line and Revision History.
- [x] Design: Part B and Part G's Phase 2 sections marked Active; §B.9 "Which decisions agents judge" (C1); §G.2 (C6); §G.4 (C5); Revision History. Part D untouched.
- [x] Baseline report §5.
- [x] docs/README.md (this delta).
- [ ] PRD: unchanged. The A-1 target is kept, and "at least two weeks of shadow data; A-1 ≤ 1.5 in the field" reads as C2 details it.

### Risk delta

- **C2 lengthens the combined field period** by the delegation window. At the earlier pace (70 finished requests in 15 days) that is about 2–3 days, and at most to day 21.
- **C1 and C3 add Orchestrator wakes**: one batched wake per idle moment with a delegable decision on a project with the challenger on. C6 makes their tokens visible, and A-7 counts each prediction as its wake's action.
- **Without these changes** Phase 2 would have been judged on a window where delegation could not happen. Its A-1 would then have been re-set on evidence that measured nothing.

## 5. Out of scope for this delta

PRD targets; DQ-4's default; the thresholds of §B.4; Part D (the Phase 4 spike may report on it); any code.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10), 2026-09-30. C3 is a question put to the owner at install, not a decision taken here.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Created at the Phase 2 start (bead `bm-autonomy-phase2-t9lm.1`); applied to the plan and design; the bead edits listed for the coordinator |
