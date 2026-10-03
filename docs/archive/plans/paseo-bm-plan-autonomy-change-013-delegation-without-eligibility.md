# Change Request — Delegation without eligibility: the owner delegates a class whenever they choose

| Field | Value |
|---|---|
| Change ID | `autonomy-change-013` |
| Short name | Delegation without eligibility |
| Original plans | [Phase 2](../../plans/paseo-bm-plan-autonomy-phase2.md) (WP-204 promotion and demotion, WP-208 exit); [change-007](paseo-bm-plan-autonomy-change-007-phase2-start.md) C2 (the delegation window); [change-012](paseo-bm-plan-autonomy-change-012-phase6-start.md) C3 (the combined field period's close and a fix installed mid-window) |
| Status | Applied — the owner's decision of 2026-10-01 ([ADR-023](../../adr/ADR-023-delegation-without-eligibility.md)); PRD, designs, GUIDE, code and the bead edits of §4 (made through `br`, 2026-10-01) |
| Owner | hieu.nt10 |
| Created | 2026-10-01 |
| Accepted | 2026-10-01 — the owner: "Remove this condition from the product entirely; the machinery is too cumbersome. The user turns delegation on whenever they like." |
| Applied | 2026-10-01 |

## 1. Change summary

A class could become `delegate` only once a predictor had earned it (ADR-018 decision 4, design §B.4): agreement ≥ 90 % over ≥ 20 owner answers spanning ≥ 14 days, with no reversal. The owner removed that gate. Now the owner can set any delegable class to `delegate`, with either predictor, at any time, from Settings → Autonomy, after one confirmation.

**Kept:**
- release, data, security and cost are never delegable;
- demotion to `shadow` on a reversal or an override, with its Inbox alert;
- `owner` and `shadow`, the agreement ledger, the challenger, precedents, overrides and the action boundary;
- prepared changes applied only on the owner's own answer.

## 2. Compelling reason

The owner's decision. Two facts support it:
- **The field never met the gate.** The baseline (`docs/operations/paseo-bm-eval-baseline.md`) counted 0 eligible cells: the recommended option agrees about 80 % on the delegable share. So the owner could not delegate a class they were willing to hand over.
- **The gate cost machinery on every surface:**
  - thresholds and a span rule in `shared/autonomy.ts`;
  - an "earned" offer in Insights, and no Delegated choice in Settings;
  - a refusal in advice's prepared `autonomy.set`;
  - a ledger re-read after every settlement, only to clear a demotion alert.

## 3. What changes — Before / After

| # | Item | Before | After |
|---|---|---|---|
| C1 | The rules and the RPC | `eligibility(cell, now)` with `ELIGIBLE_MIN_AGREEMENT` 0.9, `ELIGIBLE_MIN_DECISIONS` 20, `ELIGIBLE_MIN_SPAN_DAYS` 14, `eligibilitySpanMs` and `ELIGIBILITY_UNMET` (`EligibilityUnmet`, `Eligibility`) in `shared/autonomy.ts`. `autonomy.set` itself did not check eligibility | **All removed**, with their tests (`test/autonomy-eligibility.test.ts` deleted; its demotion-ledger cases kept elsewhere). No compatibility layer (REQ-171). `autonomy.set` is unchanged: `E_AUTONOMY_INVALID`, `E_AUTONOMY_OWNER_ONLY` for a hard-owner class, `E_AUTONOMY_NOT_CONFIRMED` for `delegate` without `confirmed: true`. No RPC and no error code added or removed |
| C2 | Settings → Autonomy | Owner / Shadow only; "set only through Delegate? in Insights, once a class has earned it" | Each delegable row: **Owner** / **Shadow** / **Delegated**. Owner and Shadow are one press with no confirmation. **Delegated** opens, in place under the row: <br>• **Decided by**: Recommended option or Orchestrator, the recommended option preselected; <br>• the confirmation, Cancel first and the default. Its title is "Delegate <Class> decisions in <project>?". Its bullets: "The recommended option answers them for you, without asking you." (or "The Orchestrator answers them for you, without asking you." plus "Each decision wakes the Orchestrator, which costs tokens."); then "A reversal or an override sends the class back to Shadow at once; Return all to owner undoes it." The button is **Delegate**. <br>Confirming sends `autonomy.set { mode: delegate, predictor, confirmed: true }`. To change the predictor, the owner sets Shadow or Owner, then Delegated again. The four hard-owner rows stay fixed. New meaning line: "Owner and Shadow: you decide, and what the agents would have chosen is recorded beside your answer. Delegated: decided for you by the recommended option or the Orchestrator, after one confirmation; a reversal or an override sends it back to Shadow." |
| C3 | Insights → Autonomy by class | **Delegate?** only on an eligible cell; a confirmation citing "it earned this"; a note giving the thresholds | **The agreement figures are information.** **Delegate?** stays as a shortcut, never required: it shows on each predictor's figures of any delegable class not yet delegated. It opens the same confirmation as Settings, plus "So far it matched <a> of your <n> answers (<p> %)." when that predictor has counted answers. The note keeps "a class that went back to Shadow counts again from then", and ends: "The figures are for your information: you can delegate a class at any time, here with Delegate? or in Settings → Autonomy." |
| C4 | Advice (§G.4) | A prepared `autonomy.set` to `delegate` was refused unless that predictor's cell had earned it (`PreparedChangeFacts.eligible`). The `delegation-eligible` finding listed earned cells | **A prepared `autonomy.set` may delegate any delegable class, with either predictor.** It is still applied only on the owner's own answer, still refused for release, data, security and cost, and still "unchanged" when the class is set so already. `PreparedChangeFacts.eligible` is removed. `bm_ask_owner`'s field text reads "delegate (any class but release, data, security and cost)"; `predictor` reads "the predictor that decides it (default recommended)". <br>**`bm_findings`:** `delegation-eligible` is replaced by **`agreement`**, a plain figure: `{ finding: "agreement", class, predictor, agreement, answers, reversals, mode, act: "autonomy.set" }`. It covers each delegable class not delegated whose predictor has at least one counted answer, most answers first, at most 3 (`FINDINGS_PER_KIND.agreement`) |
| C5 | The `autonomy-demoted` alert | It cleared when the owner set the cell, reset the project, or once the class was eligible again (`clearRenewedDemotions`, run from `index.server.ts`'s `onSettled` after every settlement) | **It clears only when the owner next sets that cell** (`autonomy.set`, any mode, delegating it again included) **or resets the project.** `clearRenewedDemotions` and its call are removed. The detail now ends "They come to you again until you delegate them again in Settings → Autonomy." The `demotions` times stay in `policy.json`: the ledger and Insights still count a demoted class's agreement from its last demotion, as information |

### 3.1 The combined field period (bead `bm-autonomy-phase6-i8fc.6`)

**This change does not touch the field yet.** The owner's daemon runs the frozen build `paseo-bm-builds/final-rc-20260930T200835Z`, installed at the start of the combined field period (`i8fc.6`). This change is not in that build. It reaches the field only if the owner installs a new build. If that happens mid-window, it is a fix installed mid-window, under change-012 C3: recorded with its time and folder, and **only the metrics it changes restart**.

**What restarts:**
- **A-4 and A-5 per delegated class.** A class delegated under the new rule counts from its delegation. The rule for a class delegated earlier is unchanged.

**What is dropped, not restarted:**
- **The Phase 2 exit's eligibility checks.** The replay's eligibility column, "which classes stayed `shadow` for lack of data", and "no cell eligible by day 21" no longer exist.

**Restated, not restarted:**
- **The delegation window of change-007 C2** counts from the owner's **first delegation**, not the first promotion. The fallback "day 21 passed with no eligible cell" becomes "day 21 passed with no class delegated". The owner can now delegate on day one, so the window can start at the install.

**Continues unchanged:**
- A-1 (asked and reaching the owner), A-2, A-3, A-6, A-7, A-8, A-10, A-11, A-12;
- the agreement per predictor and the challenger projects (change-007 C3);
- precedents, reviews and the coordination figures;
- the window's other minimums (≥ 14 days, ≥ 10 finished requests, ≥ 30 outputs, ≥ 25 with usage or day 21).

**The baseline report's "0 cells meet §B.4" / "0 eligible cells" lines** (`docs/operations/paseo-bm-eval-baseline.md`) are a dated measurement. They stay as history and are not edited.

### 3.2 Confirmed without change

| Decision | Verdict |
|---|---|
| The four hard-owner classes never delegable (REQ-121 c) | **Kept.** A safety rule, not the gate |
| `delegate` needs `confirmed: true` | **Kept.** The confirmation is now the owner's only step |
| Demotion on a reversal or an override (REQ-123 b) | **Kept,** with its alert; only its clearing changed (C5) |
| The `demotions` map in `policy.json` | **Kept** (on-disk schema unchanged) |
| The agreement ledger and `autonomy.ledger` | **Kept** as information |
| The suite's policy calls (evaluation design §6.5) | **Unchanged.** It already set `delegate` through `autonomy.set` |

### 3.3 Considered and not changed

- **Keeping the gate for the Orchestrator predictor only, or lowering the thresholds.** Rejected by the owner (ADR-023).
- **Removing Insights' Delegate?** Not needed: as an ungated shortcut it costs one button and shares Settings' confirmation.
- **Dropping the `demotions` times.** Not done: they keep the figures honest after a demotion, and removing them would change an on-disk schema for no gain.

## 4. Impact

### Affected beads (edits made through `br` on 2026-10-01)

| Bead | Action |
|---|---|
| `bm-autonomy-phase2-t9lm.18` (Phase 2 exit) | Context: the risk sentence about classes "too few to reach 20". Scope: no eligibility column, and "stayed owner or shadow" instead of "for lack of data". Assumptions and acceptance criteria: the delegation window counts from the first delegation, or day 21 with no class delegated; A-4/A-5 per delegated class from its delegation (§3.1) |
| `bm-autonomy-phase6-i8fc.6` (combined field period) | The window's close and its tracked figures: "since the first delegation" for "since the first promotion"; "day 21 passed with no class delegated" for "no eligible cell"; this change named as a possible mid-window fix whose restarts are §3.1's |

No bead is added, split, closed or deleted.

### Other affected artifacts

- [x] ADR-023 (new); ADR-018 is not edited: docs/README.md marks its promotion thresholds superseded.
- [x] PRD (autonomy): REQ-123 (a), REQ-122 (b), J-3, the Phase 2 exit row, Q-105 marked superseded, the Testing line; Revision History.
- [x] Autonomy design: §B.2, §B.4 (renamed "Delegation and demotion"), §B.9, §A.12, §A.8 alerts file, §G.4 findings and prepared changes, the window note of Phase 6; Revision History.
- [x] Evaluation design §6.5 step 4 wording; no metric depended on eligibility; Revision History.
- [x] Experience concept §4.1, §4.3, §4.4; Revision History.
- [x] GUIDE.md: Settings → Autonomy, Insights, the digest's Override line, Advice.
- [x] docs/README.md: ADR-018's row, ADR-023 and this delta listed.
- [x] Code and tests (`plugin/`, `test/`): C1–C5.
- [ ] The Phase 2 plan and change-007: not edited (a plan is not a standing contract); this delta restates what they say about promotion.
- [ ] The baseline report: unchanged (§3.1).

### Risk delta

- **A class can be delegated with a weak predictor.** The confirmation says who decides and how it is taken back. Insights shows the agreement. Demotion, the digest's override and Return all to owner remain. The owner accepted this risk.
- **The Orchestrator predictor costs tokens per decision.** The confirmation says so.
- **A-4 and A-5 may now be measured on classes delegated early, with little shadow history.** That is intended: they measure the delegation the owner chose.

## 5. Out of scope for this delta

The A-4 and A-5 targets; the hard-owner rule; demotion; the suite's scenarios; any release.

## 6. Approval

- [x] Approved-by: the owner (hieu.nt10), 2026-10-01.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | hieu.nt10 (owner decision; written by Claude) | Created and applied: ADR-023, the PRD, designs and GUIDE edited in place, the code changed, and the beads of §4 edited through `br` |
