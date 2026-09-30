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
```

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

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | Targets confirmed (§4); the suite section moved to the programme evaluation (autonomy change-001) |
| 2026-09-29 | hieu.nt10 (written by Claude) | Created with the field baseline (bead `bm-autonomy-phase0-m1ih.8`) |
