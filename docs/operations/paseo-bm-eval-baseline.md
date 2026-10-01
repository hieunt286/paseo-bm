# paseo-bm — Evaluation baseline (calibrated autonomy programme)

| Field | Value |
|---|---|
| Status | Living during the programme — Phase 0 closed 2026-09-29; phases append their field figures |
| Owner | hieu.nt10 |
| Requirements | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-102, metrics A-1 → A-11 |
| Method | [Evaluation design](../design/paseo-bm-evaluation.md) §4 (definitions), §5 (replay), §6 (suite), §7 (this report) |

This report holds the numbers every phase of the programme is compared with: the **field** replay of the owner's own store, and the **suite** runs on an isolated daemon. Numbers only — no message text, no paths.

## How to reproduce

```bash
npm run -s eval:replay -- --since 2026-09-15 --until 2026-09-29T23:59:59Z --json   # field (read-only on ~/.paseo-bm)
npm run eval:suite -- --version paseo-bm-plugin@0.4.1                              # suite, 0.4.1
npm run eval:suite -- --version tree                                               # suite, working tree
npm run -s eval:replay -- --since <ISO> --until <ISO> --links-sample 30 --seed <n> --json  # A-10 links audit (read-only)
```

The links audit (A-10, evaluation design §4) draws the sample with the seed given, so write the seed down before the run; the same store, window and seed draw the same outputs. Its result is `linksAudit` in the JSON (a section at the end of the Markdown): per kind drawn and complete, each required link found / absent / missing, numbers, link kinds and ids only.

## 1. Field baseline — the owner's store, 2026-09-15 → 2026-09-29

Replay of 2026-09-29, all workspaces. The versions in this window are the 0.2–0.4 releases and development builds of the working tree; records carry no `pluginVersion` yet, so the window is by date.

| Metric | Value | Note |
|---|---|---|
| Requests in the window / finished | 74 / 70 | |
| **A-1** questions per finished request — reached the owner | **4.83** (338 of 376 asked in finished requests) | asked: 5.37 per finished request; answered by agents: 0 (the Orchestrator's Autopilot only started on 2026-09-29, and no Manager fact answer was recognised); 38 questions never answered |
| **A-2** duplicates | **21** | 20 questions answered twice; 1 pair of Orchestrator decisions open at the same time (2026-09-29) |
| A-3 owner actions per decision | — | suite only |
| **A-5** reversals (see caveat) | 5 questions re-answered with another option | the module also counts 43 `br reopen` after an answer, which mostly come from review findings rather than reversed decisions — see §3 |
| **A-6** effectful actions executed | **203**: 128 named by the owner before they ran, 75 not shown to be | `git push` 84 (8 not shown), `npm publish` 35 (1), `TRUNCATE` 8 (1), `DROP` 2 (0), `rm -rf` outside the workspace 74 (65) — see §3 for the `rm -rf` caveat |
| **A-7** Orchestrator wakes / with no action | **13 / 5 (38 %)** — approximate | 2026-09-28 → 29 only |
| **A-8** tokens per finished request | mean **86.4 M**, median **22.9 M** | Worker 80.3 M (93 %), Reviewer 3.6 M, Manager 2.4 M; one finished request lacks usage on a turn |
| A-9 suite outcome | — | suite only (§2) |
| **A-11** median time to finished, owner wait excluded | **35 min** (69 requests) | |

Supplementary:

| Figure | Value |
|---|---|
| Recommended option taken | 267 / 339 answered (78.8 %); another option 58; own words 14 |
| Owner wait per question | median 5.0 min, p90 53.3 min |
| Blocked rounds | 239 in total, 3.2 per request; 54 requests blocked at least once |
| Tier mix (last reported) | Large 26, Small 25, Medium 13, changed during the request 10 |
| Reviews | 425 reviews over 184 batches (1.69 per batch); 1.32 blocking findings per batch |
| Reports with format problems | 5 of 550 |
| Cancelled turns | Worker 75, Manager 64 |
| Turns by role | Manager 1,044 · Worker 861 · Reviewer 313 |

Consistency with PRD Appendix A (one-off queries of the same day): asked 379 vs ≈ 380 (−0.3 %); agreement 78.8 % vs 79 % (−0.7 %); requests, tiers and blocked requests identical. Within the ±5 % of the Phase 0 exit criterion.

## 2. Suite baseline

*Moved to the programme evaluation (Phase 6 WP-604), owner decision 2026-09-29: the suite runs once, after all other work — S1–S8, twice each, on `paseo-bm-plugin@0.4.1` and on the final build. Until then each phase adds its field replay below §1 and its live-check notes.*

## 3. Caveats found in the field numbers

- **A-5 is not a clean lower bound.** Its `br reopen` signal also fires when a Worker reopens a bead for a blocking review finding (`plugin/roles/worker.md`, *Proving a change*), which is normal work, not a reversed owner decision. Until Phase 1 decision objects record reversals exactly, read **5 re-answered questions** as the reversal signal and the 43 reopens as an upper-side noise term.
- **A-6 `rm -rf` outside the workspace is inflated.** The Worker's rules allow a scratch directory made with `mktemp -d` and deleted after use; its `rm -rf` falls outside the workspace and is counted. The other actions (`git push`, `npm publish`, SQL) are real; "named by the owner" is a text heuristic (design §4), so "not shown to be authorised" means the store holds no owner text naming the action before it ran — not that it was forbidden.
- **A-1 "answered by agents" is 0 in this window** because the Orchestrator ran with Autopilot for less than a day and Manager fact answers are not told apart from relayed ones in the records.

## 4. Targets

Confirmed at the Phase 0 exit, approved by Claude under the owner's delegation (2026-09-29); the source of truth is PRD §2.

| Metric | Field baseline | Target |
|---|---|---|
| A-1 questions reaching the owner / finished request | 4.83 | ≤ 1.5 at Phase 2 exit (checked at the Phase 2 start against the measured class mix) |
| A-2 duplicates / re-asks | 21 | 0 |
| A-3 owner actions per decision | — | 1 |
| A-4 override rate of delegated decisions | n/a | < 5 % per class |
| A-5 reversal rate of delegated decisions | owner's own: 5 / 339 re-answered | not higher than the owner's |
| A-6 unauthorised effectful actions | 75 of 203 not shown authorised (heuristic) | 0 (exact from Phase 1 on) |
| A-7 Orchestrator wakes with no action | 38 % (approximate) | < 20 % |
| A-8 tokens per finished request | median 22.9 M | no regression > 10 % per phase; a reduction target only with a Worker-context mechanism (Phase 6) |
| A-9 suite correct and boundary-clean | at the programme evaluation | final build not below 0.4.1 |
| A-10 traceable chains | not possible | ≥ 90 % at Phase 5 exit |
| A-11 time to finished, owner wait excluded | 35 min | not worse |

## 5. Phase 2 start — the field data available on 2026-09-30

Bead `bm-autonomy-phase2-t9lm.1`. Under change-006 no phase exit is judged here: every exit is judged in the combined field period on the final build. This section records what the owner's store held when Phase 2 started, and the class-mix check PRD §2 asks for before A-1's target is kept or re-set.

```bash
npm run -s eval:replay -- --since 2026-09-15 --until 2026-09-30T03:02:19Z --json   # earlier field
npm run -s eval:replay -- --since 2026-09-30T03:02:19Z --json                      # Phase 1 build
npm run -s eval:replay -- --since 2026-09-30T04:46:31Z --json                      # the fixed build (change-004)
```

### 5.1 Windows

Replay of 2026-09-30T04:59Z, read-only.

| Window | Requests / finished | Note |
|---|---|---|
| Earlier field, 2026-09-15 → 2026-09-30T03:02:19Z | 74 / 70 | the data of §1; A-1 4.80 (336 of 376 asked in finished requests), asked 5.37, recommended taken 267 of 339 (78.8 %) |
| Phase 1 build, from 2026-09-30T03:02:19Z | 1 / 1 | the only request on the Phase 1 build |
| Fixed build (change-004), from 2026-09-30T04:46:31Z | 0 / 0 | no use yet |

**The store changed during this check.** At 05:11Z the earlier-field window read 61 / 58, from 7 workspaces with activity instead of 18. Workspace histories had been deleted from the store after the 04:59Z replay. The Phase 1 window did not change. Two consequences:
- The figures below are the 04:59Z snapshot. The declared-effects pass and the broad text readings of §5.3 read the same snapshot: they reproduce its 74 / 70, 379 questions asked and 267 of 339 recommended exactly. The action-terms readings ran after the deletion. The deletion removed 2 of the 336 questions that reached the owner, and neither is hard-owner in any reading, so their hard-owner counts hold for the snapshot.
- The Phase 0 baseline can no longer be reproduced from the store, so §1–§4 stay the reference as recorded. Later phases compare with the recorded figures, not with a new replay of 2026-09-15 → 2026-09-29.

### 5.2 The Phase 1 build — one request

| Metric | Value | Note |
|---|---|---|
| A-1 reached the owner / finished request | **4** (4 of 5 asked) | 1 answered by agents, through an Orchestrator command's answer block — the path the fixed build refuses (change-004) |
| A-2 duplicates | **3** | 3 questions answered twice, on the same pre-fix path |
| A-5 | 0 re-answered | 2 bead reopens after an answer: review findings, the noise of §3 |
| A-6 | 1 effectful action, not shown authorised | `rm -rf` outside the workspace (the scratch-directory caveat of §3); no push, no publish |
| A-7 wakes / with no action | **4 / 1 (25 %)** | exact, from the wake records |
| A-8 tokens | 52.7 M | Worker 50.5 M (96 %), Reviewer 1.4 M, Manager 0.8 M. The Orchestrator's tokens are not recorded in the field (0 across all 17 wakes since 2026-09-28) |
| A-11 | 1.3 min | Read from the request's first `finished` report, sent while it was Small. It was re-sized to Large and reported `finished` again 60.4 min after its start, owner wait included |
| Recommended option taken | 5 of 5 | |
| Owner wait per question | median 1.6 min, p90 43.5 min | 4 questions |
| Blocked rounds; reviews | 3; 5 reviews in 2 batches, 9 blocking findings (4.5 per batch) | |

The decision store holds 5 `q:` decisions:
- 4 answered by the owner (2 on a chat card, 2 in the Inbox) and 1 superseded by a re-ask (`supersedes`).
- Every one carries a subject (4 distinct) and declared effects on every option.
- 1 grant (`network`).

One request is too few to judge any Phase 1 target.

### 5.3 Class mix

Decisions carry no `class` before Phase 2. The class is derived from declared effects with the map of design §B.1; a decision with no effect that maps to a class is **unclassified**.

**Declared effects — the owner-answered `q:` decisions of the Phase 1 build:**

| Class | Decisions | Share of those reaching the owner | Recommended option taken |
|---|---|---|---|
| unclassified (only `none` declared) | 3 | 75 % | 3 of 3 |
| environment (`network`) | 1 | 25 % | 1 of 1 |
| release, data, security, cost | 0 | 0 % | — |

None of the earlier field's 379 questions declares an effect (the tags came with Phase 1), so by this method all of them are unclassified.

**Text estimate — an approximation, not the design's method.** To bound the hard-owner share of the earlier field, the plugin's backstop vocabulary (`decision-gate.ts` categories: security, release, data, cost, dependency; negated matches ignored; riskier wins) was read over the question and option text. There are 336 questions that reached the owner in the 70 finished requests. Two readings:
- **Broad:** every term.
- **Action terms:** push, deploy, publish, merge into main, and their Vietnamese equivalents; secrets, passwords, credentials; drop, truncate, delete from, migration, real data; billing, paid, subscription; every dependency term.

| Reading | Hard-owner questions | Per finished request | Delegable questions | Recommended taken, delegable |
|---|---|---|---|---|
| Broad, question and options | 110 (release 69, security 25, data 14, cost 2) | 1.57 | 226 | 80.3 % |
| Broad, options only | 90 | 1.29 | 246 | 79.5 % |
| Action terms, question and options | 88 (release 65, data 16, security 6, cost 1) | 1.26 | 248 | ≈ 80 % |
| Action terms, options only | 69 | 0.99 | 267 | ≈ 80 % |

Recommended option taken per estimated class (broad, question and options):
- release 52 of 69 (75 %)
- security 17 of 25 (68 %)
- data 12 of 14 (86 %)
- cost 2 of 2
- no category 184 of 229 (80 %)

**The estimate over-counts.** On the Phase 1 build, the broad reading marks 3 of 5 questions hard-owner and the action-terms reading 2, while their declared effects mark none. Every one of those hits is a mention (a push already done, a coming release, a cost under discussion), not an action the option would take. The earlier field did run many release actions: 84 `git push` and 35 `npm publish` in 70 finished requests (§1, A-6).

**Project × class cells, recommended predictor (earlier field, the text estimate's classes):**
- 6 cells hold ≥ 10 answered questions. Their agreement is 63.6–85.7 %, over spans of 0.3–8.9 days.
- 0 cells meet §B.4 (≥ 90 % over ≥ 20 decisions spanning ≥ 14 days).
- Of 16 projects with requests, 3 had ≥ 5 finished requests (50 of the 74 requests) and 2 had ≥ 10.

### 5.4 A-1 against the Phase 2 target (≤ 1.5)

| Figure | Value |
|---|---|
| A-1 reached the owner / finished request | Phase 1 build 4 (1 request); earlier field 4.80 |
| If every delegable class reached ≥ 90 % and were delegated — declared classes (Phase 1) | 0: every owner-answered decision is delegable |
| The same — text estimate (earlier field): the hard-owner floor | 0.99 – 1.57 |
| Share of delegable questions that delegation or precedents must take to reach 1.5, for each floor | 86.5 % (floor 0.99) · 93.1 % (1.26) · 93.9 % (1.29) · not reachable (1.57) |
| With today's recommended predictor at the §B.4 threshold | 0 eligible cells, so A-1 stays at 4.80 |

**Verdict: kept, not re-set.** The class mix does not show that the delegable classes cannot reach 1.5:
- The declared mix has no hard-owner question.
- Only the broadest text reading puts the floor above 1.5, and that reading's hits on the Phase 1 build were all mentions.

The binding constraint is agreement, not the class mix. The recommended option agrees about 80 % on the delegable share, and no cell is eligible. The target therefore rests on:
- the Orchestrator predictor (the challenger, off by default, DQ-4);
- precedents;
- fewer questions asked.

Only Phase 2's shadow measures these. [Change-007](../plans/paseo-bm-plan-autonomy-change-007-phase2-start.md) lets the combined field period measure them. The Phase 2 exit (bead `t9lm.18`) judges the target, and re-sets it with per-class evidence if it is not met.

## 6. Phase 3 start — the compaction and handoff defaults from the field data available on 2026-09-30

Bead `bm-autonomy-phase3-7gxw.1`. Under change-006 the Phase 3 defaults are derived at the phase start from the Phase 2 measurement (`eval-metrics` `context`, the replay's candidates) over the field data available now. The Phase 2 exit re-checks them in the combined field period (beads `t9lm.18`, `i8fc.6`). [Change-008](../plans/paseo-bm-plan-autonomy-change-008-phase3-start.md) records what the re-check changed.

```bash
npm run -s eval:replay -- --json                                    # whole store
npm run -s eval:replay -- --until 2026-09-30T03:02:19Z --json       # earlier field
npm run -s eval:replay -- --since 2026-09-30T03:02:19Z --json       # Phase 1 build
npm run -s eval:replay -- --since 2026-09-30T04:46:31Z --json       # the fixed build (change-004)
```

### 6.1 What the figures rest on

Replay of 2026-09-30T13:51Z, read-only. The data folder's files had the same paths, sizes and times before and after.

| Window | Requests / finished | Turns with usage (Manager · Worker · Reviewer) |
|---|---|---|
| Whole store, 2026-09-16 → 2026-09-30 | 62 / 59 | 2,056 (958 · 812 · 286) |
| Earlier field, until 2026-09-30T03:02:19Z | 61 / 58 | 2,027 (944 · 801 · 282) |
| Phase 1 build, from 2026-09-30T03:02:19Z | 1 / 1 | 29 (14 · 11 · 4) |
| Fixed build, from 2026-09-30T04:46:31Z | 0 / 0 | 0 |

- **Agents:** 250 with usage (Manager 15, Worker 70, Reviewer 165).
- **Turns by provider:** Claude 1,900, Codex 155, OpenCode 1.
- **Context:** 0 turns with a reported context, 156 with an estimated one (Codex, last call), 1,902 unknown.
- **Tool calls:** 0 turns carry a tool-call count.
- **Why no context or tool calls:** the build installed on the owner's machine predates the Phase 2 collector (bead `t9lm.21`).
- **The store has changed since §5:** 62 requests from 2026-09-16, against 74 in the 04:59Z snapshot of §5. The workspace histories deleted on 2026-09-30 (§5.1) are not in these figures.

### 6.2 Tokens read

Tokens read per turn and per request, as §G.2 defines them: input + cached, Codex's input alone.

| Figure | Count | Median | p75 | p80 | p90 | Max |
|---|---|---|---|---|---|---|
| Per turn, Manager | 958 | 173,677 | **388,524** | 423,298 | 541,330 | 2,028,657 |
| Per turn, Worker | 812 | 1,978,044 | **5,713,582** | 6,996,310 | 14,421,207 | 325,431,341 |
| Per turn, Reviewer | 286 | 124,308 | 1,138,579 | 1,536,071 | 2,676,931 | 8,512,120 |
| Per request, all roles | 62 | 40,751,598 | 135,185,062 | **150,553,952** | 250,973,646 | 577,085,984 |
| Per request, Worker | 58 | 38,777,463 | 133,721,310 | 141,109,758 | 298,250,986 | 570,043,751 |

- **By role:** 6,235,687,858 tokens read in all: Worker 92.1 %, Manager 4.1 %, Reviewer 3.9 %.
- **The earlier field alone:** Manager p75 391,062, Worker p75 5,717,981, request p80 150,553,952, all within 1 %.
- **The Phase 1 build alone** (1 request, 29 turns) gives 65,297, 2,047,663 and 51,866,683: too few turns to set anything.

### 6.3 The defaults (design §G.7 as built)

| Setting | Default | Derived from |
|---|---|---|
| `compact.managerTokensPerTurn` | 390,000 | Manager p75 per turn, 388,524 |
| `compact.workerTokensPerTurn` | 5,700,000 | Worker p75 per turn, 5,713,582 |
| `handoff.requestTokens` | 150,000,000 | Request p80, all roles, 150,553,952 |
| `compact.contextShare` | 0.5 (the design's) | Not derivable: no context is reported in the field yet |

The first three are rounded to two significant figures. The tokens-per-turn defaults compare whole-turn counts (Claude); a Codex or OpenCode turn is judged by the context share (change-008 C2).

### 6.4 Candidates at those thresholds (estimates)

The replay's thresholds are the unrounded p75 and p80.

| Kind | Candidates | Where they cross | Estimated saving (tokens read) |
|---|---|---|---|
| Compaction, Worker | 44 of 70 Workers | median turn 3 of a median 12.5 | 4,599,423,001 |
| Compaction, Manager | 6 of 15 Managers | median turn 28.5 of a median 101.5 | 206,245,761 |
| Handoff | 13 of 62 requests (the heaviest fifth) | median turn 30 of a median 57 | 1,343,151,730 |

- **Handoff's share:** the 13 handoff candidates read at least 3,944 M tokens: 2,597 M up to the crossing, plus 1,347 M in Worker turns after it. The saving is therefore at most 34 % of their tokens read.
- **Compaction's share:** its estimate is 77 % of all tokens read. That would hold only if every later call re-read a brief-sized context.
- **Both are upper bounds.** The model assumes every model call after the crossing re-reads a 1,500-token brief. The call counts are exact for only 1 of 50 compaction rows and 1 of 13 handoff rows; the rest are lower bounds from the evidence, which makes the subtracted re-reading too small.

### 6.5 The pre-install reference for the Phase 3 exit (change-008 C7)

The Phase 3 exit compares the combined window with the field before the final build's install. That reference is read and recorded again at the install (`i8fc.6`). As of 2026-09-30:

| Figure | Value |
|---|---|
| Worker tokens read per request, p90 (the median of the heaviest fifth) | 298,250,986 over 58 requests; p80 141,109,758 |
| A-8 tokens per finished request | mean 101.7 M, median 46.6 M, over 59 finished requests (Worker 94.7 M per finished request, 93 %); 1 finished request lacks usage on a turn |
| Blocking findings per review batch | 1.46 (246 over 169 batches; 404 reviews). 114 reviews without a batch and 148 with an unknown blocking count, all before the Phase 1 build |
| Finished-unverified share | None before the final build: detection starts with it. The exit compares requests with and without a compaction or handoff in the same window |

A-8's median per finished request reads 46.6 M here against 22.9 M in §1: the population changed with the deleted histories (§6.1). §1–§4 stay the Phase 0 reference as recorded. This table is the Phase 3 reference.

### 6.6 Review figures, corrected for a double count (2026-09-30)

Found by bead `bm-autonomy-phase3-7gxw.5` and fixed by `7gxw.12`: the collector read `BM-REVIEW` blocks from every message of every role's turn, so a review quoted outside its Reviewer's own reply was counted again (113 from the plugin's old `BM-FORMAT` notices to Reviewers, 7 from Workers' re-review prompts, 1 from a Manager's relay). Reviews now count only in their Reviewer's own reply (`ownReviewsOf`). Read-only replay of the whole store, numbers only:

| Figure | Before the fix | After |
|---|---|---|
| Reviewed requests | 54 | 53 |
| Reviews | 404 | 283 |
| Reviews per reviewed request | 7.48 | 5.34 (Small 1.91, Medium 3.79, Large 7.46) |
| Batches | 169 | 169 |
| Blocking findings per batch (review lift) | 1.56 | 1.55 |
| Findings acted on / found on re-review | 148 / 175 | 148 / 175 |
| Tokens per review | 647k | 929,611 (266 reviews with usage) |
| Reviews without a batch | 114 | 0 |
| Reviews with an unknown blocking count | 148 | 27 |

The supplementary blocking figure, the §G.8 guardrail reference, stays 1.46. Still counted: 17 corrected copies a Reviewer sent after a format notice (5.02 reviews per request without them). The review budget counts calls, not reviews; its counter did not double count.

### 6.7 Writers observed (2026-09-30)

Read-only replay of the whole store after bead `i8fc.1`: 0 pairs of agents writing one file in overlapping turns, 0 files, 1 pair not judged (a turn without a recorded start or end), over 62 requests and 2,058 turns.

### 6.8 The combined field period: install and the pre-install reference (2026-10-01)

**Installed:** 2026-10-01T00:28:54Z on the owner's daemon, the frozen build `paseo-bm-builds/final-rc-20260930T200835Z` (identical to `plugin/` of commit `4c3ed5e`; checked on an isolated daemon first, `docs/archive/operations/paseo-bm-final-rc-check-20261001.md`). The window starts here (bead `i8fc.6`, change-006, change-012).

**Pre-install reference** (read-only replay of the whole store just before the install, numbers only):

| Figure | Value |
|---|---|
| Requests (finished) | 63 (60) |
| A-1 questions reaching the owner per finished request | 5.63 |
| A-8 tokens read per finished request | 100.2 M (Worker 93.3 M, Reviewer 4.2 M, Manager 2.8 M) |
| Worker tokens read per request (59 requests) | median 38.7 M, p80 141.1 M, p90 298.3 M |
| A-11 median time to finished (59 requests) | 36.3 min |
| A-7 wakes with no action | 8 of 19 (approximate) |
| Review lift: blocking findings per batch | 1.55 (supplementary reference 1.45) |
| Reviews per reviewed request | 5.28 |

**Reinstalled** 2026-10-01T01:25:47Z: `paseo-bm-builds/final-rc2-f5e9610` (commit `f5e9610`, ADR-023: delegation without an eligibility gate). Per change-012 C3 and change-013, only A-4/A-5 restart, counted per class from its delegation; every other figure keeps the window that started at 00:28:54Z.

**Reinstalled** 2026-10-01T01:42:47Z: `paseo-bm-builds/final-rc3-af22009` (commit `af22009`, a bug fix the owner reported: a Worker's question awaiting confirmation keeps its options, and an owner message no longer marks questions asked after it). No figure restarts: the fix changes which questions are marked, not how a question is counted.

**Reinstalled** 2026-10-01T01:50:18Z: `paseo-bm-builds/final-rc4-cccdcbb` (commit `cccdcbb`, a bug fix the owner reported: after a reload the Orchestrator's tools refused every call until a new agent was created; between 01:42:47Z and 01:50:18Z its 9 calls were refused, so its turns in that span sent nothing). No figure restarts.

**Reinstalled** 2026-10-01T02:27:20Z: `paseo-bm-builds/final-rc5-588a210` (commit `588a210`, ADR-024: `BM-INTERRUPTED` for a turn Paseo cut short, and waiting on the owner read from the decision store by the stall pass). No figure restarts. A `BM-INTERRUPTED` goes only to Managers and Workers, so it adds turns there (A-8 tokens, slightly), never Orchestrator wakes (A-7).

The owner chooses per project, in Settings → Autonomy, the action boundary (change-010) and the challenger; the choices are recorded here when made.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's request) | §6.8: reinstalled with ADR-024 (`588a210`) |
| 2026-10-01 | Claude (owner's request) | §6.8: reinstalled with the Orchestrator handle fix (`cccdcbb`) |
| 2026-10-01 | Claude (owner's request) | §6.8: reinstalled with the needs-confirmation fix (`af22009`) |
| 2026-10-01 | Claude (owner's request) | §6.8: the final build installed and the pre-install reference recorded (bead `i8fc.6`) |
| 2026-10-01 | Claude (owner's delegation) | How to reproduce: the A-10 links audit command (bead `bm-autonomy-phase5-3e5v.6`) |
| 2026-09-30 | Claude (owner's delegation) | §6.7: writers observed on the field store (bead `i8fc.1`) |
| 2026-09-30 | Claude (owner's delegation) | §6.6: review figures corrected for a double count (beads `7gxw.5`, `7gxw.12`) |
| 2026-09-30 | Claude (owner's delegation) | §6 Phase 3 start (bead `bm-autonomy-phase3-7gxw.1`, change-008): the compaction and handoff defaults from the whole store (62 requests, 2,056 turns; the Phase 1 build 1 request): Manager 390,000 and Worker 5,700,000 tokens read per turn, 150,000,000 per request; the candidates and their upper-bound savings; the pre-install reference for the Phase 3 exit |
| 2026-09-30 | Claude (owner's delegation) | §5 Phase 2 start (bead `bm-autonomy-phase2-t9lm.1`): the field data available on 2026-09-30 (earlier field, the Phase 1 build's one request, the fixed build unused), the class mix by declared effects and by a labelled text estimate, A-1 against ≤ 1.5 — kept; the store lost workspace histories during the check, so §1–§4 stay the reference as recorded |
| 2026-09-29 | Claude (owner's delegation) | Targets confirmed (§4); the suite section moved to the programme evaluation (autonomy change-001) |
| 2026-09-29 | hieu.nt10 (written by Claude) | Created with the field baseline (bead `bm-autonomy-phase0-m1ih.8`) |
