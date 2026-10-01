# Change Request — Phase 3 start: what Phase 2 as built and the field data change

| Field | Value |
|---|---|
| Change ID | `autonomy-change-008` |
| Short name | Phase 3 start re-check |
| Original plans | [Phase 3](./paseo-bm-plan-autonomy-phase3.md) (Active); the combined field period of [change-006](./paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) |
| Status | Applied — plan, design and the bead edits of §4 (made through `br`, 2026-09-30; new bead `bm-autonomy-phase3-7gxw.12`) |
| Owner | hieu.nt10 |
| Created | 2026-09-30, bead `bm-autonomy-phase3-7gxw.1` |
| Accepted | 2026-09-30 — Claude under the owner's delegation. No PRD target, owner decision or phase outcome changes; C6 builds what ADR-021 decision 5, REQ-128 and REQ-132 already name |
| Applied | 2026-09-30 (plan and design) |

## 1. Change summary

The Phase 3 start re-checked design Part C, Part G's Phase 3 sections (§G.5–§G.8) and the Phase 3 beads against three things:
- Phase 2 as built, and its live check on an isolated daemon (bead `bm-autonomy-phase2-t9lm.17`, [run note](../archive/operations/paseo-bm-phase2-live-check-20260930.md));
- the context-fields run of Phase 2 ([run note](../archive/operations/paseo-bm-context-fields-run-20260930.md)), which already sent `/compact` to all three providers;
- the field data available on 2026-09-30 ([baseline report §6](../operations/paseo-bm-eval-baseline.md#6-phase-3-start--the-compaction-and-handoff-defaults-from-the-field-data-available-on-2026-09-30)).

The Phase 3 defaults are derived there (§G.7 as built): compaction at 390,000 tokens read per turn for a Manager and 5,700,000 for a Worker, handoff at 150,000,000 tokens read per request.

The re-check found three gaps that would stop compaction and handoff from working as the design means them:
- **Nothing wakes the Orchestrator when a threshold is crossed** (C1).
- **One tokens-per-turn threshold cannot serve both roles or every provider** (C2).
- **A handoff command has no authority** under the authority model Phase 2 kept (C3).

It also found four smaller points (C4–C7). Every other decision of §C.6 and §G.5–§G.8 is confirmed (§3.2).

## 2. Compelling reason

**The field.** Replay of 2026-09-30T13:51Z, read-only, over the whole store (baseline report §6):
- **62 requests (59 finished), 2026-09-16 → 2026-09-30; 2,056 turns with usage.** The Phase 1 build holds 1 request (29 turns) and the fixed build none, so the defaults rest on the earlier field.
- **No turn has a reported context or a tool-call count.** The build installed on the owner's machine predates the Phase 2 collector. `compact.contextShare` cannot be derived, and the savings are upper bounds.
- **Tokens read per turn, p75:** Manager 388,524, Worker 5,713,582. The two differ 15-fold.
- **Candidates at those thresholds:** 44 of 70 Workers (crossing at a median third turn) and 6 of 15 Managers would be compaction candidates. 13 requests, the heaviest fifth, would be handoff candidates. Their estimated saving is at most about a third of the tokens they read.
- **The store lost workspace histories on 2026-09-30** (baseline §5.1). A-8's median per finished request now reads 46.6 M against the 22.9 M recorded in §1, so any reference must be recorded when it is read.

**Phase 2 as built:**
- **The event bus** publishes `decision.opened`, `request.finished`, `request.stalled`, `worker.signal` and `advice.due`. None of them is a threshold, and the intervention log's triggers follow the same list. `bm_findings` lists the candidates only in an `advice.due` wake, after five finished requests.
- **Three authorities remain for an Orchestrator command:** a grant, the policy and the owner's word (§B.8 as built).
- **The live check** saw a compound Bash call read by its last part. A `git push` that succeeded read `failed` because a `git fetch` chained after it failed.

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | What wakes the Orchestrator for a compaction or a handoff (§G.1, §G.5–§G.8) | §G.1: code detects a threshold, then wakes the Orchestrator. §G.8: "the threshold events are judgement wakes". No event is defined, and no bead builds one. `bm_findings` lists the candidates only in an `advice.due` wake, after the request has finished | **A `threshold.crossed` event** `{ workspaceId, requestId, agentId, role, kind: compact \| handoff, figure: tokensPerTurn \| contextShare \| requestTokens, value, threshold, at }`, from the collector's `onRecorded` for a Manager's or a Worker's turn. <br>• **`compact`:** the turn crosses its role's threshold (C2), while compaction is on for its provider, the agent is below `compact.maxPerAgent` and no compaction of it is pending. <br>• **`handoff`:** a Worker's turn of an unfinished request whose tokens read, since the request started or since its last handoff, reach `handoff.requestTokens`, while handoff is on and the request is below `handoff.maxPerRequest`. <br>• **Scope:** published for every project, as `advice.due` is: the owner's Settings are its scope, not the autonomy policy. <br>• **Dropped at delivery** when the mechanism was turned off, the agent compacted, or the request was handed over or finished meanwhile. <br>• **Once per cycle:** key `threshold.crossed:compact:<agentId>#<its compactions so far>` or `…:handoff:<requestId>#<its handoffs so far>`. <br>• **The line** names `bm_compact` or `bm_handoff`. It is a judgement wake: the Orchestrator may leave it with a `bm_note`, which A-7 counts as acted on. <br>• **The intervention log:** `INTERVENTION_TRIGGERS` gains `threshold.crossed` (additive; the store stays `version: 1`). <br>• **Built by:** the `compact` kind with `bm_compact` (bead `7gxw.10`), the `handoff` kind with `bm_handoff` (`7gxw.11`) |
| C2 | The compaction threshold (§G.7) | One setting, `compact.tokensPerTurn`, "the agent's p75"; the replay computes it per role (§G.2 as built) | **Two settings: `compact.managerTokensPerTurn` (default 390,000) and `compact.workerTokensPerTurn` (default 5,700,000)**, each role's p75 rounded to two significant figures (§G.7 as built). <br>• A turn's tokens read are compared with them **only on a provider whose counts cover the whole turn** (Claude, `TOKEN_COVERAGE` `turn`). <br>• A last-call provider (Codex, OpenCode) reports a single call. On such a turn "tokens read" is about the context, so the p75, which sums many calls, would never be reached. Such a turn is judged by `compact.contextShare` alone (all three providers report the context). <br>• **Either figure crossing counts.** <br>• `handoff.requestTokens` default **150,000,000** (the request p80, rounded) |
| C3 | The handoff command and the successor's labels (§G.6, against §A.7/§B.8 as built) | `BM-COMMAND intent: handoff` with no authority named. "The creation hook … labels it `bm.handoffFrom=<old>`". The brief is a new builder | **The command:** `intent: handoff` joins `COMMAND_INTENTS`. It carries **`authority: coordination:handoff`, `effects: none`, `approved: none`, `to: manager`**. The authority is the owner's Settings switch (ADR-021 decisions 1 and 4); none of Phase 2's three authorities covers a handoff. <br>• The builder refuses that authority for any other intent. The send refuses it while `handoff.enabled` is off. <br>• It goes through `command-send.ts` and counts toward the loop guard. The parser reads it, and the card reads "Coordination · handoff". <br>**The labels:** the Manager passes `bm.handoffFrom=<old>` in `create_agent`'s labels, beside `bm.role` and `bm.requestId`. Paseo 0.9.2's `before("agent.create")` sees only `{ config, env }` and cannot set labels (AGENTS.md). The plugin checks the label on `agent.created` and labels the outgoing Worker `bm.replacedBy=<new>` through `paseo-cli.ts`, as the fallback switch does. Delivery, the materialiser and the chat peers already skip a replaced Worker. <br>**The brief:** it extends the fallback Worker handover (`workerHandover`, `fallback-handover.ts`), which already gives the latest report, the review calls, the request's questions and answers and the original request. It adds the plan and doc paths, the bead state, the open findings, the branch and diff stat, and the note. It is masked with `redactText` and written with the `data-files.ts` rules; the cleanup deletes `handoffs/` |
| C4 | "A delegate acts on an unverified finish" (§C.6, against §B.5 as built) | Refused: a policy-answered decision of the request whose chosen option declares `commit`, `push`, `publish` or `deploy`, and an Orchestrator command with intent `release` under `authority: policy:<class>` | The rule holds **while the request's latest report is a `finished` one read finished-unverified**, and has two parts. <br>(a) **The policy (either predictor) answers no decision of that request** whose chosen option declares `commit`, or carries a prepared command that approves `commit` or has intent `release`. `resolveByPolicy` (through `resolveAtOpen`) and `decideRefusalOf` (`bm_decide`) leave such a decision open for the owner. <br>(b) **`bm_send_command` and `bm_direct_worker` refuse a policy command for that request**: one on `authority: policy:<class>` whose `approved` holds `commit` or whose intent is `release` (`policyCoverOf`, `command-authority.ts`). "That request" is the command's request, else its Worker's. The refusal says to ask the owner with `bm_ask_owner`. <br>**What stays the owner's:** a precedent's answer (the owner's standing word, §B.6) and a grant (`decision:<id>`) are not refused. <br>**How it is read:** the state comes from the trace store at the call, and a later report of the request ends it. <br>**Why:** a policy answer never grants push, publish or deploy (release is hard-owner, §B.5), so naming them changed nothing. A `continue` command approving `commit` under the policy would have committed unverified work |
| C5 | Detection details (§C.2, §C.6) | A check is detected when a shell entry runs "the same normalised command" successfully after the last edit. File claims match by path. Nothing says how a request recorded before C.1 reads | **`&&` chains.** A named check is also detected as **one segment of a chain joined only by `&&` whose run succeeded**: every segment of such a chain ran and passed. A segment of a chain joined by `;`, `\|\|` or `\|` is not detected, because its status is the last segment's. <br>**File claims** match an `edit`/`write` entry by the path relative to the workspace folder. Claude records absolute paths, Codex relative ones inside the workspace. <br>**Records before C.1.** A request none of whose shell entries carries a `status` is **not checked**: neither detected nor unverified. Work, the card and the event show it as before, and the replay counts it apart. The trace store drops undeclared keys, so without this rule every earlier request would read unverified |
| C6 | The review budget (§C.4, §G.4, §G.7) | §G.4 lists a `review.budget` prepared change "(Phase 3)". §C.4: the budget becomes a setting "only if the owner changes it". Bead `7gxw.5`: no setting is built. No Phase 3 bead builds `review.budget` | **Three Coordination settings, `review.smallBudget`, `review.mediumBudget` and `review.largeBudget`:** review calls per request, default 2 / 2 / 4 (today's `REVIEW_BUDGET`). The bounds are 2–8: never below one review and its re-review (§G.8). <br>• **Who reads them:** `review-budget.ts` (the budget notice and the stall pass's `review.over-budget`). A new Worker gets them in its `## Runtime facts`, and worker.md's budget line points there (reworded within its budget). An existing Worker keeps the budget it started with. <br>• **Who changes them:** only the owner, in Settings → Coordination or by answering advice whose option carries `coordination.set` on one of these keys. That is G.4's `review.budget`, and no separate prepared-change kind is built. <br>• **Where it is built:** a new bead under WP-303 |
| C7 | The Phase 3 exit: its window and references (`7gxw.7`, §G.8) | ≥ 10 requests after the install. A-8 "against the Phase 2 field figures". The guardrails have no stated reference | **Window:** the combined field period's whole window (≥ 14 days from the final build's install, change-006/007), not its first 10 requests. <br>**A-8's target:** read as the **p90 of Worker tokens read per request**, the median of the heaviest fifth (evaluation design §4 already reads it from that spread). −20 % means the window's p90 ≤ 0.8 × the reference's. It needs ≥ 25 finished requests with usage (≥ 5 in the heaviest fifth); below that it is reported and the verdict reasoned, not passed. <br>**The reference:** the field **before the final build's install**, read at the start of the combined period (`i8fc.6`) and recorded in the baseline report. Under change-006 no Phase 2 build runs in the field without Phase 3's mechanisms, so "the Phase 2 field figures" would hold none. Baseline §6 is that reference as of 2026-09-30: Worker p90 298.3 M over 58 requests. <br>**Guardrails:** <br>• blocking findings per batch are judged against the same reference; <br>• A-5 against the owner's own rate, as in Phase 2; <br>• the finished-unverified share has no earlier value, so it is compared between the window's requests with a compaction or handoff and those without. <br>**A-12** for `compact` and `handoff` is judged over every entry checked in the window. A kind with fewer than 10 checked entries is reported with its count and not called met |

### 3.2 Confirmed without change

Every other decision of design §C.6 and §G.5–§G.8, against Phase 2 as built and the field figures:

| Decision | Verdict and figure |
|---|---|
| §C.6 Named checks: the backtick spans of `buildAndTests`; words only → self-reported; empty or "not run" → unverified, at request level | **Confirmed.** C5 adds the `&&` chain and the "not checked" state. Claude's shell entry has no exit code: `completed` is success, `failed` is not (§C.1, coordination run F1). Phase 2's check reader (`namesFailingChecks`, fixed for `fail 0` after the live check) keeps reading pass or fail. The command reading has one home, `shared/shell.ts` (`commandSegments`, `brActions`). `normalisedCommand` and `shellFailureOf` move there from `worker-watch.ts` |
| §C.6 REQ-130's files changed and beads closed | **Confirmed.** A closed bead is read with `brActions` from a successful shell entry; C5 adds how file paths match |
| §C.6 Delivery to the client: an additive optional field of the traces rows | **Confirmed.** It is `verification` on `traceSummarySchema` (`contracts/dashboard.ts`, built in `trace-views.ts`), so `traces.list` and `traces.get` carry it. `traceStateSchema` gets no new value, so an older reader ignores it. The finished card reads it by the request |
| §C.6 Review lift: findings acted on = first review's blocking findings − last review's, floored at 0; reviewer tokens by the record's `requestId` | **Confirmed.** Field basis: 404 reviews in 169 batches, 1.46 blocking findings per batch. 114 reviews have no batch and 148 an unknown blocking count, all from builds before Phase 1; the Phase 1 build's 5 reviews have neither. The figures report them as unknown |
| §C.6 Family = the model's vendor; signed in = `available: true` | **Confirmed.** `availableProviders` (`role-choices.ts`) reads it. The owner's own roles already differ: Reviewer Codex, the others Claude (Phase 2 live check). One pure rule in `plugin/shared/` serves `setup-roles.ts` and Settings → Agents (`settings-roles-model.ts`) |
| §C.1 Richer evidence | **Confirmed.** `evidenceSchema` is now in `contracts/persisted.ts` and already has `compaction` with `trigger` and `preTokens` (Phase 2). Command and sub-agent redaction came forward; file paths are not masked yet |
| §C.3 The event: `request.finished` with `unverified`, under Phase 2's policy scope | **Confirmed.** The scope stays Phase 2's: projects with a class above `owner` |
| §G.5 Verify first | **Confirmed, narrowed.** The context-fields run already saw a bare `/compact`, sent as the app sends it, start a manual compaction on Claude, Codex and OpenCode. Each time a `loading` then a `completed` item appeared, with `trigger: manual`. <br>• `preTokens` came on Claude only. <br>• Codex compacts in a turn of its own with no user message. <br>• OpenCode's `/compact` turn repeats the counts before. <br>• The compaction's own model call is in no turn's usage, so its cost is the agent's `totalCostUsd` difference. <br>Left to verify (`7gxw.8`): the focus, time and cost, and the collector's classification |
| §G.5 the tool, the sequence; §G.6 the refusals, the safe points, the note, the successor proving again | **Confirmed**, with C1's wake and C3's authority and labels |
| §G.3 `compact` and `handoff` outcomes and windows | **Confirmed.** Phase 3 checks them, and they read the same tokens-per-turn figure as C2 |
| §G.7 `compact.contextShare` 0.5, `compact.maxPerAgent` 2, `handoff.enabled` on, `handoff.maxPerRequest` 2, `compact.enabled` per provider after G.5's verification | **Confirmed.** No field data bears on them: no context is reported in the field yet (§6) |
| §G.8 quality first; bounded; A-7 | **Confirmed.** C1's events are judgement wakes. C7 gives each guardrail its reference |
| PRD §2 A-8: −20 % on the heaviest 20 % at the Phase 3 exit | **Kept.** The replay's estimate for the 13 heaviest requests is 1.34 B of the ≥ 3.94 B tokens they read, at most 34 %, and it is an upper bound. That leaves room for −20 % but no margin to raise the target |

### 3.3 Considered and not changed

- **Deriving `compact.contextShare` from the field.** There is no reported context in the field until the final build is installed; 0.5 stays.
- **Raising the Worker's compaction threshold** because 44 of 70 Workers cross it by their third turn. Rejected: the threshold only wakes the Orchestrator, which judges. `compact.maxPerAgent` and A-12's auto-off bound it, and the combined period measures it.
- **A new replay figure for the heaviest fifth.** Not needed: the p90 of the per-request Worker spread the replay already reports is the median of the heaviest fifth.
- **Re-deriving the defaults from the combined window at the Phase 2 exit (`t9lm.18`) alone.** Compaction and handoff lower the distribution they are set from. The re-check therefore compares that window's figures with §6's before changing a default.
- **The plugin creating the successor itself**, as the fallback switch does. Rejected by ADR-021: the Manager owns its Workers.

## 4. Impact

### Affected beads (edits made through `br` on 2026-09-30)

| Bead | Action |
|---|---|
| `bm-autonomy-phase3-7gxw.2` | Context brought up to date: `evidenceSchema` in `contracts/persisted.ts` with Phase 2's `compaction` fields; command and sub-agent redaction done, file paths not |
| `bm-autonomy-phase3-7gxw.3` | C5: the `&&` chain, file paths relative to the workspace, "not checked". The helpers move to `shared/shell.ts`, and closed beads are read with `brActions`. worker.md is 248 of 250 lines |
| `bm-autonomy-phase3-7gxw.4` | C4: the rule and the modules that apply it. C5: "not checked". The field is `verification` on `traceSummarySchema`. The finished card is in `chat-card-frame.ts` (`chat-cards.ts` is gone). The request's records are read with `request-trace.ts` |
| `bm-autonomy-phase3-7gxw.5` | C6: the setting moves to its own bead; the Scope's "Budget" line and the Assumptions are reworded. Module names: the review figures are in `eval-metrics/requests.ts` behind `eval-metrics.ts`, and `insights.summary` is in `contracts/insights.ts`. The replay test runs in the `eval` project. The field's unknowns are noted |
| `bm-autonomy-phase3-7gxw.6` | Settings → Agents is `settings-roles-model.ts` (test `plugin-settings-roles-model.test.ts`); the family rule is one pure function in `plugin/shared/` |
| `bm-autonomy-phase3-7gxw.7` | C7: the window, A-8's reading and reference, the guardrails' references and A-12's minimum. The verification figure adds "not checked" and the split with and without a compaction or handoff |
| `bm-autonomy-phase3-7gxw.8` | The context-fields run's facts as already seen; what is left to verify; the cost from `totalCostUsd` |
| `bm-autonomy-phase3-7gxw.9` | C2: the per-role keys and the derived defaults. C6: the review keys go in the same store, but their bead is new |
| `bm-autonomy-phase3-7gxw.10` | C1 (the `compact` kind of `threshold.crossed`). The tools live in a new module registered in `orchestrator-tools.ts`, and its test fakes come from `test/helpers/fake-paseo.ts` |
| `bm-autonomy-phase3-7gxw.11` | C1 (the `handoff` kind). C3: the authority, the labels and the brief on `workerHandover`. The role budgets are now 118/120 (Manager) and 248/250 (Worker) |
| `bm-autonomy-phase3-7gxw.12` (new, WP-303) | C6: *The review budget per tier as an owner setting (Settings → Coordination), proposed by advice with coordination.set*. Depends on `7gxw.5` and `7gxw.9`; `7gxw.7` depends on it |
| `bm-autonomy-phase6-i8fc.6` | C7: at install, read and record the pre-install reference (the replay over the store before the install) |
| `bm-autonomy-phase2-t9lm.18` | C2: re-check the per-role keys against §6, comparing rather than re-deriving (§3.3) |

One bead is added. No bead is split or closed.

### Other affected artifacts

- [x] Design: Part C Active (§C.2, §C.3, §C.4, §C.6); §G.5–§G.8 Active (§G.5, §G.6, §G.7 as derived, §G.8); §G.4's `review.budget` lines (a `coordination.set` on the review-budget keys); Revision History.
- [x] Plan Phase 3: Revision History. The WP table is unchanged at its level: WP-303 already says "the review budget per tier becomes a setting only through the owner".
- [x] Baseline report §6.
- [x] docs/README.md: this delta listed.
- [ ] PRD: unchanged. REQ-128, REQ-132 and REQ-136 already name the review budget, the per-tier tuning and the thresholds, and A-8's target is kept.
- [ ] ADR: none. C3 applies ADR-021 decisions 1 and 4 within ADR-017's command model.

### Risk delta

- **C1 adds Orchestrator wakes.** At the replay's rates, with both mechanisms on, that is about 50 compaction and 13 handoff crossings in 15 days, some four a day. Each is a judgement wake, and a declined one ends with a note.
- **C4 sends more decisions to the owner**, only while a request is finished-unverified.
- **C6 lets the owner lower a budget**, never below one review and its re-review.
- **C3 adds an authority value** that covers one intent, only while the owner's switch is on, bounded by `handoff.maxPerRequest`.
- **Without these changes**, compaction and handoff would fire only when the Orchestrator happened to be awake. A Codex Worker would never cross its threshold, and the handoff command would be refused by the authority check Phase 2 built.

## 5. Out of scope for this delta

PRD targets; the owner's decisions of ADR-021; §G.3's expected outcomes; Part D (the Phase 4 spike reports on it); any code.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10), 2026-09-30.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Bead edits of §4 applied through `br` (13 beads re-worded; `bm-autonomy-phase3-7gxw.12` created with its three edges); §G.4 and docs/README.md updated |
| 2026-09-30 | Claude (owner's delegation) | Created at the Phase 3 start (bead `bm-autonomy-phase3-7gxw.1`); applied to the plan and design; the bead edits listed for the coordinator |
