# Change Request — Phase 6 start: the programme's end on the code as built, and what the owner does when

| Field | Value |
|---|---|
| Change ID | `autonomy-change-012` |
| Short name | Phase 6 start re-check |
| Original plans | [Phase 6](./paseo-bm-plan-autonomy-phase6.md) (Active); the combined field period of [change-006](./paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) and the phase exits it holds |
| Status | Applied — approved by Claude under the owner's delegation; plan, designs and the bead edits of §4 (made through `br`, 2026-10-01) |
| Owner | hieu.nt10 |
| Created | 2026-10-01, bead `bm-autonomy-phase6-i8fc.2` |
| Accepted | 2026-10-01 — Claude under the owner's delegation. No PRD target, owner decision or phase outcome changes. C5 leaves the A-10 definition as it is and puts one choice to the owner before the window's draw |
| Applied | 2026-10-01 |

## 1. Change summary

The Phase 6 start re-checked design Part F (its §F.3 decisions, change-003), the Phase 6 plan, evaluation design §6–§7 and the Phase 6 beads against:
- **Phase 5 as built:** `3e5v.2`, `.3`, `.4` and `.6` are closed on `npm run verify` green. The live check of `3e5v.5` is not run yet.
- **The Phase 4 live check** ([run note](../archive/operations/paseo-bm-phase4-live-check-20261001.md)) and the fixes to its findings recorded in design §D.2 ("After the Phase 4 live check").
- **`i8fc.1`** (`writers-observed`), closed.
- **The code as built** after Phases 1–5 and the consolidation.
- **The field data available now** (§2).

Since change-006, `i8fc.6` (the combined field period) and `i8fc.5` (the programme evaluation) carry every phase's exit. The re-check found that they do not yet say enough to run:
- **The install** (C1). What the owner decides at install is split across three deltas. The Phase 4 fixes are not confirmed on a live daemon, and one of them decides whether the window's A-6 can be split by boundary at all.
- **The references** (C2). Each exit bead names a different subset of figures, and A-11 is missing.
- **The window's close** (C3). It does not include the Phase 3 exit's minimum of 25 finished requests. It does not say what happens when a fix is installed mid-window.
- **The exit beads** (C4). They still describe the Phase 1 install path (`paseo plugin add <repository>/plugin`), not the frozen build.
- **The A-10 early warning** (C5). On today's data the audit reads 0 of 30, for a reason that will not go away with the final build.
- **The programme evaluation** (C6–C9). The final build is not defined as a commit, and the action boundary's state in the suite is not stated. The suite's A-10 samples have no procedure. The cost estimate cites a stale figure.

C10 brings the bead text up to the code as built. Every other decision is confirmed (§3.2).

## 2. Compelling reason

**The field.** Read-only replay of 2026-09-30T19:44Z (2026-10-01 local) over the whole store, numbers only. The data folder's files outside `orchestrator/` had the same paths, sizes and times before and after each run.
- **Nothing new since change-011.** The store holds 63 requests (60 finished) and 2,074 turn records, 2026-09-16 → 2026-09-30; the last day holds 2. The Phase 1 build holds 2 requests. No build of Phases 2–5 has been installed, so no field figure yet measures them.
- **Figures** (the pre-install reference will be read again at the install, C2):

| Figure | Value |
|---|---|
| A-1 | 6.32 questions asked, 5.63 reaching the owner per finished request |
| A-2 | 23 |
| A-5 (owner's own) | 5 re-answered of 342 answered |
| A-6 | 131 effectful actions, 11 not shown authorised; 363 scratch deletions apart. Boundary split: 0 on, 0 off, every request `unknown` |
| A-6 estimate (§D.2) | 23.7 held, 18.5 unreadable, 6.85 unreadable without package scripts, per finished request |
| A-7 | 19 wakes, 8 with no action (42 %) |
| A-8 | median 41.5 M, mean 100.2 M tokens per finished request (Worker 93.3 M, 93 %); the Orchestrator's wakes 235,918 tokens from 2 of 6 wake records with usage |
| A-11 | median 36.3 min over 59 requests |
| Reviews | 285 in 170 batches; 1.45 blocking findings per batch |
| Writers observed | 0 pairs, 0 files, 1 pair not judged |
| A-4, A-12 | no delegated decision, no intervention log yet |

**The A-10 audit on today's data** (`--links-sample 30 --seed 20261001`; the seed was chosen before the draw; this is **not the exit sample**, which is drawn from the combined window):
- *The population:* 60 finished requests, 1 without a chain; 736 beads, 2,312 files, 5 decisions. Drawn: 13 beads, 12 files, 5 decisions (the decisions' shortfall filled from the others).
- **0 of 30 complete.** The missing links:

| Link | Missing | Why |
|---|---|---|
| decisions | 25 | Requests from before the decision store: questions asked in chat, none stored. On the final build every question is a stored `q:` decision, so this cause should not recur |
| change | 18 | All "only a commit by time" (evaluation design §4: a change whose only link is a commit by path and time) |
| beads | 3 | A bead the request names that its bead store does not hold |

- *What-ifs* (a scratch `git` shim in the session scratchpad, read-only):
  - with no commits in the chains, the change link is missing 0 times, and 27 of the 30 lack only the pre-store decisions;
  - leaving out `.beads/` files changes nothing.
- *Over all 59 chains of the field:*
  - 19 requests have a file linked only by a commit by time;
  - 52 distinct commits are linked by path and time, 27 of them to two or more requests at once, and 20 of them carry ≥ 20 files;
  - such commits bring 3,207 files that no report and no edit or write names, against 991 recorded files.
  So a commit that names no bead and touches one file of the request pulls in every other file it carries. In the owner's repositories other sessions commit alongside the requests, and one commit often serves several requests. This is the owner's commit habit, which change-011 C4 meant A-10 not to measure. It stays in the window unless the definition or the way people commit changes.

**The code as built:**
- **The suite driver** (`scripts/eval/suite.ts`):
  - It configures the tree by the policy (`scenarioPolicyCalls`, `autonomy.set` with the Orchestrator as predictor), and `test/eval-suite.test.ts` pins that no retired RPC is called.
  - The tree answers through `decision-rpc` and 0.4.1 through `legacy-contracts.ts`.
  - `--version tree` installs **this checkout's** `plugin/`, not a frozen copy.
  - Nothing sets the action boundary, so the suite runs with it off.
  - The simulated owner stops at any pending Paseo permission request ("needed a human"), and its answer policy has no rule for a held `h:` decision, which recommends no option.
  - After each run it writes `replay.json` without `--links-sample`.
  - The scenario timeouts add to 320 minutes per pass.
- **Roles.** `roles.save-settings` accepts any provider and model. The Reviewer's different family (§C.6) is a default of setup and a notice in Settings, not a refusal, so `--role-model` can swap any role.
- **Metrics.** They are `plugin/shared/eval-metrics/*` behind `eval-metrics.ts`. The figures that already measure an error class are review lift and blocking findings per batch, the verification labels, `writers-observed`, A-8 by role with context and tokens read, the A-6 estimate and held figures, and the links audit.
- **Consolidation bead `81y2.25`.** It changes runtime schemas under `plugin/` after the Phase 2 exit, that is, after the field window and before the suite. The build the suite measures will therefore differ from the one the owner used in the field.
- **The Phase 4 live check.** F1 (`bm.boundary` never written, so every request reads `unknown`), F2 (Codex's Paseo tool calls held as unreadable), F3 (a false `danger` after a denied Codex push), F4 (`BM-SETTINGS` ignoring the project's boundary) and F5 (A-6 counting denied calls) are fixed in the tree and its tests (§D.2). None is confirmed on a live daemon yet. If F1 is not fixed on the build the owner installs, the window cannot split A-6 by boundary, and the Phase 4 exit cannot be judged.
- **Live checks still owed on the frozen build:** the Phase 3 check (`7gxw.7`: a detected and an unverified finish) and the Phase 5 check (`3e5v.5`: `bm_why` and Work → Why?).

**The programme evaluation's cost basis** (measured, all on Opus 5.5 for Manager, Worker and Orchestrator):
- the Phase 1 S1/S7 check: 161,943 and 486,462 tokens per request, $0.05–$0.07 of Orchestrator per scenario;
- the Phase 2 live check: 4 small requests, 2.28 M tokens, $3.06 in all by `totalCostUsd` (about $0.77 per small request, about $1.3 per million tokens read with caching).
- The bead's "field median 22.9 M" is the Phase 0 figure (today 41.5 M), and it describes real work, not the suite's small fixtures.
- Phase 0 recorded the owner deferring the suite "until a convenient time".

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | The install (`i8fc.6`) | Freeze, check on an isolated daemon ("status running, a new RPC answering"), install at the owner's request. The owner's choices are spread over three deltas; the scope's first bullet stands outside "In scope" | **Before the install** (Claude, on an isolated daemon, the frozen copy never patched): <br>• status `running` and a new RPC answering; <br>• **the Phase 4 fixes confirmed live** with one project on and one off, on Claude and Codex: <br>&nbsp;&nbsp;– F1: every new Worker and Reviewer labelled `bm.boundary=on\|off`, no false `boundary-off`; <br>&nbsp;&nbsp;– F2: a Codex Worker's Paseo tool call allowed by name, a `create_agent` for anything but a Reviewer held as `security`; <br>&nbsp;&nbsp;– F3: no `danger` after a denied Codex push; <br>&nbsp;&nbsp;– F4: `BM-SETTINGS` names the project's Worker mode; <br>&nbsp;&nbsp;– F5: the replay splits A-6 on/off and counts a denied call zero times. <br>A failure is fixed forward, frozen again and checked again **before** the owner installs. Run note in `docs/archive/operations/`, cited by `loga.6`. <br>**At the install**, the owner: <br>• picks the moment (no `bm-*` agent running) and installs, or asks Claude to (`~/.paseo/config.json` copied first, never read); <br>• turns the action boundary on or off per project in use (change-010). The C9 figure and the boundary-on half of A-6 need at least one project on; none is a valid answer; <br>• turns the challenger on or off per project in use (change-007 C3); <br>• chooses whether to start new Managers: agents created before the install keep their instructions and modes. Only the owner archives or stops an agent. <br>Each answer and the install time are recorded in the baseline report and in the exit beads' notes. <br>**The other live checks** (`7gxw.7`, `3e5v.5`) run on the same frozen copy, before or during the window; they do not change the build |
| C2 | The pre-install reference | `i8fc.6`: Worker tokens p80/p90, A-8, blocking findings per batch (change-008 C7). `3e5v.5` needs A-8 and A-11; `loga.6` A-6, A-8, A-11; `t9lm.18` A-1, A-5, A-7, A-8; `dbdv.7` A-8. A-11 is named nowhere at the install (change-011 left the question to this start) | **One reference for every exit:** `npm run -s eval:replay -- --until <install time> --json` over the whole store, read at the install. It is recorded in the baseline report as numbers only: <br>• A-1, A-2, A-5 (the owner's own rate), A-6 (with the estimate and the scratch deletions), A-7; <br>• A-8: median, mean, by role, Worker p80 and p90, the Orchestrator's wakes; <br>• **A-11**, review lift and blocking findings per batch, writers observed. <br>Until it is recorded, §2's figures stand. The finished-unverified share has no earlier value (change-008 C7) |
| C3 | The window's close (`i8fc.6`) | ≥ 10 requests, ≥ 14 days, ≥ 30 sampleable outputs; change-007 C2 | **The window closes at the first reading where all of these hold:** <br>• ≥ 14 days since the install; <br>• ≥ 10 finished requests (Phase 1); <br>• ≥ 30 sampleable outputs (Phase 5); <br>• change-007 C2: ≥ 10 finished requests after the owner's first promotion, or day 21 passed with no eligible cell; <br>• **≥ 25 finished requests with usage** (the Phase 3 exit's A-8 minimum, change-008 C7), or day 21 passed. Then A-8's verdict is reasoned, not passed. <br>A hard minimum still unmet at day 21 keeps the window open, and the owner is told. <br>**A fix installed mid-window** is recorded with its time. A metric whose measured behaviour the fix changes restarts its window at the reinstall, as `dbdv.7` did for Phase 1; the others continue. <br>Claude reads the window's figures read-only when the owner asks |
| C4 | The exit beads (`dbdv.7`, `t9lm.18`, `7gxw.7`, `loga.6`, `3e5v.5`) | Their Context still says the owner installs `<repository>/plugin` and reloads it (change-002). `loga.6` waits for "at least 10 requests" and carries the Phase 1 window over. `dbdv.7`'s notes point at the Phase 1 build's window. A-8 is judged "vs the field baseline" | **The build judged is the frozen final build `i8fc.6` installs**, over its window (C3), against C2's reference. The Phase 1 builds' installs stay in `dbdv.7`'s notes as history. <br>**`loga.6`'s live check:** <br>• the run of 2026-10-01 already covered held actions, the latency and the Codex gate; <br>• F1–F5 are confirmed by `i8fc.6`'s pre-install check (C1) and cited from its run note. <br>**`7gxw.7` and `3e5v.5`:** their live checks run on the frozen copy |
| C5 | A-10 on the field so far (`3e5v.5`) | The definition is fixed; the exit draws 30 outputs from the window | **The definition is not changed here:** evaluation design §4 fixed it before any sample, and a result has now been seen. <br>**Recorded as an early warning:** §2's pre-window audit (0 of 30; 25 missing from pre-store decisions, 18 from commits linked only by time, 3 from beads not in the store) and its what-ifs. <br>**Put to the owner before the window's draw**, by `3e5v.5`, recorded in the baseline report: <br>(a) **the definition stands** — the default when the owner says nothing; <br>(b) the owner amends it. A Phase 5 delta is then written and applied before the draw, disclosing this figure. <br>Either way the seed is recorded before the draw, and the rule "never changed after the window's sample is seen" holds. A window below 90 % follows `3e5v.5`'s rule: the gaps are fixed forward and the audit re-run |
| C6 | "The final build" of the programme evaluation (`i8fc.5`) | "The working tree after every other bead" | **A clean checkout of the release-candidate commit.** <br>• `npm run verify` is green on it, and `plugin/` matches its generated instructions. <br>• The commit and the SHA-256 of the `plugin/` tree are recorded. <br>• The differences from the field's frozen build are listed: `81y2.25` and any fix forward. <br>It runs as `--version tree`, because the driver installs this checkout's `plugin/` |
| C7 | The action boundary in the suite (`i8fc.5`, evaluation design §6.5) | Not stated | **Off for both builds,** as the build installs by default (§D.5). The simulated owner never answers a Paseo permission request, and a held `h:` decision recommends no option, so a boundary-on run would stop as "needed a human". The suite's A-6 is therefore a detection figure for both builds, which keeps A-9's comparison like for like. The boundary's A-6 = 0 rests on the Phase 4 live check and on the field's boundary-on half (`loga.6`). A boundary-on suite run is not planned. If the owner asks for one, an answer policy for `h:` in `scripts/eval/owner.ts` is new work in its own lane, done before the run |
| C8 | The suite's A-10 samples (§E.3) | "The suite adds its own samples"; no procedure | **By hand, after the final build's run and before its run folder is deleted:** `npm run -s eval:replay -- --home <work>/bm-home --json --links-sample <n> --seed <n>`, with the seed recorded before the draw and n ≤ 30. <br>It is reported beside the field A-10, under the same definition as C5 settles it; it is not a verdict of its own. <br>0.4.1 keeps no store to audit, and its A-10 stays "not possible" |
| C9 | The go-ahead and the estimate (`i8fc.5`) | "About 16 real requests per suite run"; the field median 22.9 M; the owner asked "right before the run" | **Asked when `i8fc.5` becomes ready**, honouring Phase 0's "at a convenient time". The owner picks the time; nothing starts without the go-ahead. <br>**The request carries:** <br>• *the runs:* 0.4.1, the final build, and each experiment from `i8fc.4`; <br>• *per build:* 16 scenario-runs, which are 18 requests (S6 sends two); <br>• *tokens:* measured 0.16–0.57 M per small request; Medium and Large scenarios, with a Reviewer, estimated 0.5–5 M. That is about 9–90 M tokens per build; <br>• *spend:* at the measured ≈ $1.3 per million tokens on Opus 5.5, about **$12–$120 per build and $25–$240 for both**. Each experiment adds about one build. The Codex Reviewer's tokens are on the owner's Codex plan, which Paseo does not price; <br>• *time:* at most 320 min per pass, 10.7 h per build and 21 h for both. S1 and S7 took 1–2 min each; <br>• *what it touches:* the owner's provider logins and quotas, shared with the owner's own daemon while it runs, and network access for 0.4.1. <br>The actual spend is reported (A-8, the Orchestrator's cost) |
| C10 | Bead text against the code as built | Pre-consolidation names; stale counts | • **`i8fc.3`:** the metrics in `eval-metrics/*` (tests in the `eval` project); the figures that already exist; the family rule is only a default. <br>• **`i8fc.4`:** the experiments listed with their added cost. <br>• **`i8fc.5`:** C6–C9. <br>• **`i8fc.6`:** C1–C3; the Context's duplicated rules sentence and the stray scope bullet fixed; the label `wp:wp-605`. <br>• **The plan:** WP-605 (the combined field period, bead `i8fc.6`), which change-006 added as a bead only |

### 3.2 Confirmed without change

| Decision | Verdict |
|---|---|
| WP-601 `writers-observed` | **Done** (`i8fc.1`). 0 pairs and 1 not judged in the field today |
| §F.3: the admission template at `docs/operations/paseo-bm-specialist-admission-template.md` | **Confirmed.** `i8fc.3` builds it |
| §F.3: `--role-model <role>=<baseProvider>/<model>` | **Confirmed.** It maps onto `configure`'s `roles.save-settings { role, baseProvider, model, … }`, which accepts any family |
| §F.3: the evidence queries per error class | **Confirmed with `i8fc.3`.** They come from each candidate's claim, and a class no figure measures is recorded as such |
| The suite configures the tree by the policy, not Autopilot (E-2) | **Confirmed.** §6.5 step 4 as built; `test/eval-suite.test.ts` pins the calls and that no retired RPC is called |
| The channels: `decision-rpc` for the tree, `0.4.1` by `legacy-contracts.ts` | **Confirmed** |
| S1–S8, their fixtures and timeouts | **Valid for the final build.** None uses a retired RPC. S6 uses `i8fc.1`'s shared pairing. S7 tests the question and the grant with the boundary off (C7). S8 uses the repository's `tsc`. The timeouts total 320 min |
| Twice each, E-1 models, a verdict per PRD §2 target, A-9 against 0.4.1 | **Confirmed** |
| The order `i8fc.3` → `i8fc.6` → the five exits → `i8fc.4` → `i8fc.5` (and `81y2.25`) | **Confirmed.** `i8fc.3` still changes `plugin/shared/`, so the freeze follows it |
| Phase 5 as built | **No conflict with Part F.** The links audit is one more evidence figure for admission |
| The admission rule (no evidence, no candidate), the six candidates, worktrees only on real collisions | **Confirmed** |

### 3.3 Considered and not changed

- **Amending the A-10 definition now.** Rejected: a result has been seen (C5). The choice is the owner's, before the window's draw.
- **A boundary-on suite run.** Not planned (C7).
- **Moving the Phase 3 and Phase 5 live checks into `i8fc.6`.** Not chosen: only the Phase 4 fixes gate the install. The others stay with their exits and use the same frozen copy.
- **A `--links-sample` flag in the suite driver.** Not needed: one command by hand (C8), no code.
- **Running the suite before the window to find regressions early.** Rejected by the owner's decision: the suite runs once, at the end.
- **Judging the worktrees candidate now on 0 collisions.** That is `i8fc.4`'s judgement, on the window.
- **Running `81y2.25` before the freeze,** so the field and the suite see one build. Not possible: it waits for the Phase 2 exit's replay, which still reads the history it removes. C6 lists the difference instead.

## 4. Impact

### Affected beads (edits made through `br` on 2026-10-01)

| Bead | Action |
|---|---|
| `bm-autonomy-phase6-i8fc` (epic) | A success criterion for the combined field period; the scope names it |
| `bm-autonomy-phase6-i8fc.3` | C10: module names, the figures that exist, the family rule only a default |
| `bm-autonomy-phase6-i8fc.4` | C9, C10: the experiments listed with their added cost for `i8fc.5`'s go-ahead |
| `bm-autonomy-phase6-i8fc.5` | C6–C9: the release-candidate commit, the boundary off, the suite's A-10 by hand, the go-ahead with the estimate; counts corrected |
| `bm-autonomy-phase6-i8fc.6` | C1–C3, C10: the pre-install check with F1–F5, the owner's choices at install, one reference, the window's close and a mid-window fix; text fixed; label `wp:wp-605` |
| `bm-autonomy-phase1b-dbdv.7` | C4: a note that the window and the reference are `i8fc.6`'s; the Phase 1 installs are history |
| `bm-autonomy-phase2-t9lm.18` | C2, C4: the frozen build and C2's reference |
| `bm-autonomy-phase3-7gxw.7` | C4: the frozen build; the live check on the frozen copy |
| `bm-autonomy-phase4-loga.6` | C1, C4: the window is `i8fc.6`'s; the live check of 2026-10-01 and the F1–F5 confirmation from `i8fc.6` |
| `bm-autonomy-phase5-3e5v.5` | C4, C5: the frozen build; the owner's A-10 choice before the draw |

No bead is added, split or closed. `i8fc.2` stays open for its own close.

### Other affected artifacts

- [x] Design Part F marked Active; §F.3 confirmed and completed; Revision History.
- [x] Evaluation design §6.5 (C6–C8) and §8 (C9); Revision History.
- [x] Plan Phase 6: WP-605, §1's exit, §5 risks, Revision History. Status stays Active.
- [x] docs/README.md: this delta listed.
- [ ] Evaluation design §4 A-10: **not changed** (C5).
- [ ] Baseline report: the pre-install reference, the owner's choices and the window come with `i8fc.6`; the A-10 choice with `3e5v.5`.
- [ ] PRD: unchanged. ADR: none.

### Risk delta

- **C1 adds a live run before the install:** a few provider tokens on an isolated daemon, and a later install if a fix is needed. Without it, the window could hold no on/off split and the Phase 4 exit could not be judged.
- **C3 can lengthen the window to day 21** when requests are few. The field ran 60 finished requests in 15 days, but only 6 in its last three days.
- **C5 leaves A-10 at risk.** If the owner keeps the definition and the owner's sessions keep committing alongside the requests, the Phase 5 exit may miss 90 % on the change link. It is known now, not found at the exit.
- **C7 means the suite does not test the boundary.** That is covered by the Phase 4 live check and the field.

## 5. Out of scope for this delta

Any code; PRD targets; the A-10 definition; the candidates' judgement; the programme's one release.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10), 2026-10-01.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's delegation) | Created at the Phase 6 start (bead `bm-autonomy-phase6-i8fc.2`); applied to the plan, the designs and the beads of §4 |
