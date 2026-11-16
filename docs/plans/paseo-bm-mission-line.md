# Implementation Plan — Mission line, Phases 1 and 2

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-11-10 — Claude under owner hieu.nt10's agreed recommendations |
| Owner | hieu.nt10 |
| Routing decision | [ADR-045, Routing Decision](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md#routing-decision) |
| Requirements | §2: the owner's fourteen items of 2026-11-10 (no requestId; the PRD is updated by the closing beads) |
| Technical design | The rules are [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md); the mechanisms are §5. Sections that change at closure: delivery line design §2.6, §4.3–§4.6, §5, §6.4, §9.1, §17.3, §19; technical design §16.7; missions design §9; autonomy design §C; mission runtime design §2 |
| Phases | Phase 1 (debt and small items), Phase 2 (the line) |

Every decision number below is ADR-045's, and each equals the owner's item number.

## 1. MVP-Lock

- **In Phase 1:** items 4, 8, 9, 10, 13, 14, plus the finish gate that item 4 and Phase 2 share.
- **In Phase 2:** items 1, 2, 3, 5, 6, 7, 11 and 12, plus the owner's switch (§5.12). Item 12 moved here from Phase 1: quiet checks, measuring and trimming are one bead that comes last, after the role and tool edits.
- **Out of both:** release and version choice (the owner's, after acceptance); push, tag and forge merge by the plugin; a notification channel; a step-list editor or a mid-line edit of steps (cancel and propose again); changing a stored `rollover.contextTokens`; credentials for runtime proofs; a new screen layout; removing lanes.
- **Exit:** Phase 1: every WP-1xx exit holds, then `npm run verify` passes once after the closing bead. Phase 2: the same for WP-2xx. Then the owner installs and accepts; this plan does not release.
- **Checkpoint posture:** each bead is reversible by reverting its source hunks; the owner's switch (§5.12) turns the supervised line off without a revert; stored additions are optional fields that older readers ignore; the uncommitted tree (ADR-041 to ADR-044) is built on and never reverted. The only new write outside the mission's worktrees is the local fast-forward of WP-103, behind the owner's grant.

## 2. The approved items

| # | Item | WP | Mechanism where it differs from the owner's wording |
|---|---|---|---|
| 1 | Ordered steps approved once; one step at a time; default enforced in code | 201 | The list goes through `bm_mission_update` `steps` and an `m:` card; its criteria show in the card's details. `after` is extended to name `hold-…` ids and read chain heads and the gate at creation. New `bm_create_worker` inputs: `next` (new work, runs next) and `parallel` (quotes the owner's explicit word; "urgent fix" counts only as such a word) |
| 2 | The plugin advances on the gate, otherwise stops once | 102, 202 | Read over the chain, failing closed. Stops also cover a stalled head or one with no live Worker, and the Main gets one notice per distinct failure. A `bm_hold_release` tool is added: without it a stop the owner accepts could not resume |
| 3 | The previous result in the next brief | 203 | Added as context facts at start, so `bm_create_worker` needs no new input; `bm_report` gains `forNextStep` |
| 4 | Local fast-forward, one owner card | 103 | Runs only after the gate, not at every `finished`; the merge's refusal is a gate failure |
| 5 | Mission page: step n of m | 204 | As asked |
| 6 | Runtime proof | 205 | As asked |
| 7 | Goal restated at `received` | 206 | As asked |
| 8 | Plan holds only steps | 104 | `plan` becomes a list of step lines; the stored shape stays `{ text, updatedAt }`, written as numbered lines |
| 9 | No `mess` or `drift` nudges; manual Worker only when asked | 105 | "Manual Worker" is read as a Worker a bound Main makes with `create_agent`. `dropped` is a `mess` figure, so its ladder goes quiet too; the alert and the notice remain |
| 10 | Sessions under about 200k; two field bugs | 106 | Soft default 180k. `BM-ROLLOVER now` is never deferred for a review: a `finished` with `remaining` under it is accepted, and the batch and its verdict follow the continuation ([ADR-046](../adr/ADR-046-rollover-now-is-never-deferred-for-a-review.md)) |
| 11 | Baseline from 57k towards 40k | 207 | Measured and trimmed in one bead, last, because both phases edit the same role text and tool faces |
| 12 | Quiet checks | 207 | As asked, moved beside 11 |
| 13 | `reused` label | 102 | As asked |
| 14 | One delivery rule | 101 | As asked |

Early estimate (source sizes, 2026-11-10): `worker.md` is 16k characters and the Worker's `bm_` tool faces 22k, so roughly 11k tokens, plus Runtime facts and the brief. The plugin's share is therefore well under the 17k the target asks; WP-207 settles it and names the rest.

## 3. Work packages

### Phase 1

| WP | Outcome | Items | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-101 | Every delivery decides turn or note; copies and `beads-done` are notes; one notice per open alert; `undelivered` ranks below an owner's question | 14 | §5.1 | none | `test/outbox.test.ts`, `test/delivery-failure.test.ts`, `test/mission-state.test.ts`, `test/command-send.test.ts` prove each rule, and `leftAtStart` is gone |
| WP-102 | Checks can be `reused`; each `finished` records, before its roster entry turns finished, whether the chain passes the finish gate | 13, 2 | §5.2 | none | `test/evidence.test.ts` and a new `test/finish-gate.test.ts` cover every label, every failing condition, a no-file continuation, a check outside the live tail and a handed-off Worker's check |
| WP-103 | A granted mission and repo fast-forwards the local integration branch after a passed gate | 4 | §5.3 | WP-102 | Real-git tests prove the fast-forward and each refusal; only the owner's tap grants |
| WP-104 | `mission.plan` accepts only steps and flags an older plan | 8 | §5.4 | none | `test/mission-tools.test.ts` |
| WP-105 | No `mess`/`drift` nudge, code or model; the Main's hand-made-Worker limit | 9 | §5.5 | none | `test/governor-store.test.ts`, `test/governor-tools.test.ts`, `test/roles-content.test.ts` |
| WP-106 | 180k soft default; batches survive a continuation; `now` is never deferred for a review (ADR-046) | 10 | §5.6 | none | `test/rollover.test.ts`, `test/continuation.test.ts`, `test/bm-review-tools.test.ts` |
| WP-108 | Phase 1 docs, build and verification | all above | §5.11 | all WP-1xx | `npm run verify` passes; designs updated in place |

WP-107 was merged into WP-207 after review b1; the number is not reused.

### Phase 2

| WP | Outcome | Items | Design | Needs | Exit |
|---|---|---|---|---|---|
| WP-201 | Sequence: `after` names held entries and resolves chain heads and the gate, at creation too; the sequential default and the triage of new work are enforced; a step list is approved once, with its criteria shown | 1 | §5.8 | WP-108 | `test/bm-create-worker.test.ts`, `test/held-requests.test.ts`, `test/mission-tools.test.ts`; an answer that is not the owner's applies nothing |
| WP-202 | Held entries and running steps stop on every stop kind with one notice per failure, and resume; steps that pass cost no Main turn | 2 | §5.8 | WP-201, WP-102 | `test/held-requests.test.ts`, `test/bm-deliver-tools.test.ts`, with a case per stop kind and a second failure that gets its own notice |
| WP-203 | The next brief holds the previous step's result | 3 | §5.9 | WP-202 | `test/held-requests.test.ts` shows the facts in a started step's brief |
| WP-204 | Mission page shows step n of m, what runs and where it is blocked | 5 | §5.9 | WP-202 | `test/mission-page-lanes.test.ts`, `test/plugin-missions-model.test.ts` |
| WP-205 | Runtime proof at `finished`, flagged when it could not run; no done criterion on it | 6 | §5.10 | WP-108 | `test/bm-deliver-tools.test.ts`, `test/mission-tools.test.ts` |
| WP-206 | Goal restated at `received`; Small and in-step `received` cost no turn | 7 | §5.10 | WP-201 | `test/bm-deliver-tools.test.ts` |
| WP-209 | One owner switch returns missions to finished-only held entries, no slot refusal and normal report delivery | 1, 2 | §5.12 | WP-201, WP-202, WP-206 | `test/coordination-store.test.ts`, `test/held-requests.test.ts`, `test/bm-create-worker.test.ts`, `test/bm-deliver-tools.test.ts` |
| WP-207 | Quiet-check guidance; the plugin's fixed context measured, then trimmed to the measured budget | 11, 12 | §5.7 | WP-201..206 | The eval ratchet and role-content tests pass at the new figure; what lies outside the plugin is recorded |
| WP-208 | Phase 2 docs, build and verification | all above | §5.11 | all WP-2xx | `npm run verify` passes; designs and PRD updated in place |

## 4. Dependencies

- WP-103 and WP-202 need WP-102's stored gate result.
- WP-202 needs WP-201's held-entry vocabulary (hold ids, steps, the slot).
- WP-203 and WP-204 read what WP-202 records.
- WP-206 needs WP-201 to know whether a request is an approved step.
- WP-209 needs what it switches off: WP-201, WP-202, WP-206.
- WP-207 follows every bead that edits `worker.md`, `manager.md` or a tool face, so a trim is not undone.
- Phase 2 starts after WP-108, so it builds on a verified Phase 1.
- Inside a phase, the rest is independent; one bead is in progress at a time.

## 5. Mechanisms

The rules are the ADR's. These are the seams an implementer needs. Files are under `plugin/` unless stated.

### 5.1 Delivery (WP-101)

`deliverRecord` (`server/outbox.ts`), after it resolves the target, asks one question: a `message` of no open work (`isDormantRecord`) whose current recipient reads `resting` (`presenceOf`) is settled at once as `delivered`, reason `no-turn`, without enqueueing. `leftAtStart` is removed and `createOutboxResend` simply calls `deliverRecord`, so records an older build left open become notes at the next start. `noTurnNoteOf` handles a record with no link: `noted: <kind> <id> from <agent>: <gist>`. A record carrying the owner's decision or words (`from` `owner` or `orchestrator`, or `atOnce`) is never such a message, at a plugin start either. A presence that cannot be read delivers as before. `bm_report` `beads-done` and the `copy: yes` block of `server/command-send.ts` are stored with `noTurn`, never enqueued. `server/delivery-failure.ts` and `recordOutcome` send `BM-DELIVERY-FAILED` only when `createAlertStore().raise` returned `raised: true`. `requestStateOf` (`shared/mission-state.ts`) checks the owner's question before `undelivered`.

### 5.2 Evidence and the finish gate (WP-102)

`shared/evidence.ts`: a named check whose clause of `buildAndTests` (split on `;` or a newline) contains the word `reused`, and which a successful shell entry of the request ran at any earlier time, is `reused`. `CLAIM_LABELS` and `CHECKS_VERDICTS` gain `reused`; a verdict is `reused` when all named checks are detected or reused and at least one is reused. `isFinishedUnverified` and `verifiedOf` (`server/line-state.ts`) treat it as verified.

New `server/finish-gate.ts`, pure, `finishGateOf` → `{ passed, reasons[] }`, read over the continuation chain (root to head, `chainOf` in `server/waits.ts`). Changed files are the union of the chain's `filesChanged` and, where records exist, of the paths its Workers' records edited; a reported commit counts as a change, so its sha reaches the local merge only through the same review, checks and commit reading. It fails on: the head's `finished` with `remaining`; a Medium or Large chain with changed files whose newest `wave` or `finished` batch has no passing latest result; any adopted batch without a passing latest result; `reviewFindingsOpen`; changed files with checks neither `detected` nor `reused`; changed files not committed (`committedOf`), or changed outside a placement; with `integration.ci` on, a CI `failure`. A request with no predecessor and no changed file passes; a continuation with none is judged on its chain: the gate uses the newest commit reported in the chain (`integration.commit`, the head's report first) and the newest report in the chain that names checks.

Checks for the gate come from `verificationOf` over every record of every request of the chain, for all their Workers (`readRecords` filtered by request id and `role === "worker"`), plus the reporting Worker's live tail for the turn not yet recorded; `liveChecksOf` alone sees only one Worker's newest pages. They are local whether CI is on or off; a green or pending pipeline adds nothing.

`bm_report` computes the gate, then the merge of §5.3, before storing, and writes `finishGate { passed, reasons, at, commit }` (`server/request-registry.ts`, additive) as the first act of the `before` callback, ahead of `noteReport` and `noteRosterReport`, so a pass that sees `finished` sees the final result. Every request created on this build is stamped `gated: true` (`newEntry`). A `gated` head with no result fails, with a named reason (a failed write, or a report through `server/unbound-relay.ts`); only a head without the stamp, from before this build, reads as passed. The delivery gains one line when the gate failed.

### 5.3 Local merge (WP-103)

`Placement.localMerge { state, decisionId, grantedAt, revokedAt, target }`, optional. A new action kind `integration.local-merge` beside `integration.grant` (`shared/mission-change.ts`), a card built in `server/integration-grant.ts` on the same `ownerOnly` route through `server/decision-rpc.ts`, opened once per mission and repo at the first `finished` that passes the gate. `mission.integration.ask` and `.revoke` gain `what: "push" | "local-merge"`, defaulting to `push`.

Merge after a pass, only when the grant holds, to the newest commit reported in the chain, never the branch head. If the target is checked out in a worktree (`git worktree list --porcelain`): `git merge --ff-only <sha>` there. If not: `git update-ref refs/heads/<target> <sha> <old>` after `git merge-base --is-ancestor <old> <sha>`. A refusal leaves the branch alone, sets `finishGate.passed = false` with the reason, and writes a journal line. A lane n ≥ 2 merges only after `mergeLane` merged it. Reuse `mergeGit` and `overwrittenFilesOf` from `server/lane-merge.ts`.

### 5.4 Plan (WP-104)

`bm_mission_update.plan` becomes an array of 1 to 30 one-line steps of at most 200 characters. `plan.text` is written as `1. …` lines; the shape on disk does not change. A stored text that is not all numbered lines is returned by `bm_mission` with `planNote: "written before plans held only steps; it may be stale: check before relying on it"`. An older Main's string is refused by the schema, which teaches it.

### 5.5 Governor (WP-105)

`ladderStepOf` (`server/governor-store.ts`) keeps a family of `QUIET_FAMILIES = ["mess", "drift"]` (`shared/governor-figures.ts`) from going past step 1. A family already above step 1 stays until its figures clear. `bm_govern` (`server/command-authority.ts`) refuses a `nudge` whose figures are all from those families. `roles/orchestrator.md` changes `mission.scope` and `mission.review` to match. Figures, the journal record and the page do not change. `roles/manager.md` rule 4 gains the hand-made-Worker limit.

### 5.6 Sessions (WP-106)

`ROLLOVER_CONTEXT_TOKENS.default = 180_000` (`shared/coordination.ts`); bounds and `ceilingFactor` unchanged. `openContinuation` copies the predecessor's batches whose latest result is not a pass onto the new request, with `adoptedFrom` and their `results`, `calls` and `brief`. `continuationLinesOf` adds `open review batches: b1 (changes-required, 2 blocking): use bm_rereview`. `batchesAwaitingVerdict` also matches review records of `adoptedFrom`, and adopted calls do not count toward the new request's `reviewCalls`. `BM-ROLLOVER now` is never deferred for a review (ADR-046): a `finished` with `remaining` after it is accepted while `batchesAwaitingVerdict` is non-empty, those batches are copied too with their newest call `awaited`, `noteReviewResult` stores the verdict on every copy down the chain, and `verdictTargetOf` delivers it to the chain head's Worker. `rolloverAsked.workerId` names who heard `now`: a later Worker is asked again, and a Worker whose handoff asked for its note is not asked.

### 5.7 Checks and baseline (WP-207)

`roles/worker.md` names the quiet modes (`vitest run --reporter=dot <path>`, `eslint --quiet`, `tsc --pretty false`, a runner's own summary flag), with no pipes, and says to name each check exactly as run. New `test/eval-worker-baseline.test.ts` computes four figures from source: `worker.md`, Runtime facts, a typical brief, and the Worker's `bm_` faces. It lists the Paseo tools a Worker is given (ADR-020, `server/setup-roles.ts`) because the plugin chooses them. Results, the trim list and what lies outside the plugin's reach go in `docs/operations/paseo-bm-eval-baseline.md`. The bead then trims to that figure with no rule dropped, and the test ratchets it.

### 5.8 Sequence and gate (WP-201, WP-202)

**Reading `after`.** `bm_create_worker.after` accepts `req-…` or `hold-…`. `holdStateOf` (`server/held-requests.ts`) resolves a hold id through `startedAs` (not started: waiting; cancelled: stopped) and a request id to its chain's head (`server/waits.ts`), then reads that head's `finishGate` as §5.2 says. `bm_create_worker` uses the same reading: it holds unless every head passes, and a satisfied `after` starts work only when the slot is free. Held entries gain optional `step { lineId, n, of, title, acceptance[] }`, `next`, `released` and `toldKey`, a state `proposed`, and `after` may be empty.

**New work while a request runs.** With a running request not marked parallel (`runningRequestsOf`), `bm_create_worker` needs one of: `next: true` (new work: held, runs when the slot is free, ahead of the remaining steps, on no request's result); `after` (it needs that request's result; gated); or `parallel`, a reason that quotes the owner's explicit word in double quotes. The quoted words must appear in a message the owner typed, read from the Main's newest timeline page; an unreadable page refuses. An ordinary owner message is not that word; `manager.md` says so, and `/bm-worker-new` quotes `BM-NEW-REQUEST`. `parallel` runs in a new lane, journals its reason, marks the roster entry and skips the staffing rule's new-lane line (the budget cap holds). `lane: "new"` no longer starts work beside a running request without `parallel`. Triage in `manager.md`: words about the running step go to it with `bm_tell_worker`; a question reading answers is the Main's; anything else is new work.

**The step list.** `bm_mission_update.steps`, 2 to 12 of `{ title (≤70), request, acceptance[] (1–6, ≤200 each), project?, context? (≤16) }`, stores `proposed` entries and opens one mission card through `missionChangeSchema` `line { lineId, steps: [{ title, acceptance[] }] }`. The question lists the titles within its 1,000 characters; the card's existing details on a tap list the criteria, where the owner answers (`decisionDetails` in `client/chat-card-decision.ts`, `details` in `client/inbox-model.ts`). The owner's "apply" moves the entries to `held` and writes the plan from the titles; "keep as is" cancels them. A first step has an empty `after`: the slot orders it. While a line is live, `bm_mission_update.plan` is refused.

**The pass.** `startHeldRequests` takes due entries that are not steps first, oldest first, then steps, oldest first, one at a time: a due entry waits silently while a sequential request runs. A slot Paseo's agent list cannot show is held, never free: the entry stays as it is, and `bm_create_worker` refuses. Its caller carries an internal `fromHeld`, so `bm_create_worker` does not repeat the slot refusal.

**Stops.** `holdStateOf` returns a stop kind for: a failed gate; a stopped request; a cancelled entry; an active head with an open `request-stalled` alert; an active head with no unarchived Worker (a resting one is live; unreadable reads as waiting); an active head idle past the stall window (24 hours) with no alert and no live turn, read from the roster and its Workers' records. The pass also reads each `started` step whose head is active, so a last step stops too, and a due entry whose slot is held by a stalled head stops with it. A held entry with a stop is `waiting-stopped` with its reasons in `note`; a stop that no longer holds returns it to `held`. A `started` step stays `started`: its stop is `toldKey` plus a `stopNote` the page reads, with the same notice; it never returns to `held`, `bm_hold_release` refuses it, and it clears through a continuation or `bm_hold_cancel` (which settles it as cancelled, leaving its Worker alone), never a re-creation. A stall stop ends only when the head has new activity (`progressSinceOf`, since the time in `toldKey`) or has ended; an alert cleared by the stall watcher's 24-hour window does not end it. The Main gets one notice per distinct failure, kept in `toldKey`: `<head>:<finishGate.at>` for a gate, `<head>:stall:<alert since>`, `<head>:no-worker`, `<head>:stopped`, `<holdId>:cancelled`. The notice names the real options for its state: a continuation with `bm_tell_worker`, `bm_hold_release` on the owner's word (a held entry only), or `bm_hold_cancel`, never `bm_create_worker` again, which would duplicate the step. A notice that comes back dropped, at once or from the queue later, clears its key on every entry that carries it, so a later pass tells it again.

**Release and silence.** New `bm_hold_release { holdId, why }` releases a `waiting-stopped` entry of any kind, journals the why; a released entry starts past the gate, the slot and the staffing rule's one-live-Worker line (the budget cap holds). A release or a cancel also clears the failure's key, so what else it stops, now or later, is told. A step's `finished` that has a next step is stored with `noTurn`: the plugin then starts the next step or sends the one notice. The last step is delivered normally, with a `line complete` line. A step's start is a no-turn note.

### 5.9 Result and page (WP-203, WP-204)

`bm_report` gains `forNextStep { summary, contract?, remaining? }`, required when the request is a step with a next step, and stored beside `finishGate`. At start, `startHeldRequests` prepends up to four context facts (commit and branch, summary, contract, remaining), each cut to 500 characters, source `the previous step's finished report`, without changing the stored entry. `MissionWaiting`'s held row gains optional `step`; `mission.get` gains `line { n, of, title, state, requestId, why }` or null, built in `server/mission-page-lanes.ts`, shown in the existing In flight and Waiting parts (`client/missions-model.ts`, `client/missions.tsx`).

### 5.10 Proof and intake (WP-205, WP-206)

`bm_report` gains `runtimeProof { kind: "ran" | "could-not-run", what, showed? }`, masked. It is required on a `finished` with a Medium or Large tier whose `filesChanged` holds a non-document path (`DOC_PATH` from `server/handoff.ts`, exported) and no size-rollover `remaining`. The registry notes `proof`; the mission state shows "could not run". A `met` status on `bm_mission_update` must name a request id while the mission has a `could-not-run` request, and is refused if it names that request.

`bm_report` `received` with a Medium or Large tier outside a step needs `goal` and `acceptance[]`, rendered as lines for the Main. A Small `received` and any `received` of a step are stored with `noTurn`.

### 5.11 Closing beads (WP-108, WP-208)

Update the sections in the table above in place with a Revision History line, `docs/README.md` if a state changes, and run `npm run verify`, which builds `plugin-package/`. No commit, install or daemon.

### 5.12 The owner's switch (WP-209)

`line.supervised`, a boolean in `shared/coordination.ts` beside the mechanisms, default on, machine-wide, set through `coordination.set` and a switch in Settings → Coordination. Off: a head satisfies `after` at `finished` alone (`holdStateOf` skips the gate and the stall and no-Worker stops), `bm_create_worker` refuses nothing for the slot and starts a satisfied `after` at once, and `bm_report` delivers `received` and a step's `finished` normally. The gate is still recorded and the local merge still needs its grant and a passed gate. `beads-done` and copies stay notes: they are decision 14's, not the line's.

## 6. Compatibility and safety

- **Contracts.** `bm_create_worker`, `bm_report`, `bm_mission_update`, `mission.get` and the integration RPCs change. Client and server ship in one bundle. Agents on older instructions meet one refusal that says how to comply (ADR-039). New stored fields are optional.
- **Evidence.** The gate requires local checks with CI on or off; a red pipeline also fails it (amends ADR-035 decision 3's Evidence clause). Batches cross a request only by adoption (amends ADR-035 decision 1).
- **Authority.** The step-list card and the merge grant take effect only on the owner's own answer: `answerDecision` refuses any other answerer on an `m:` card, and neither is delegable by level, Main, Orchestrator or precedent.
- **Git.** The local merge is a fast-forward of one ref or nothing, in the owner's repository, behind a revocable grant. No push, tag, reset, branch creation or history rewrite.
- **Secrets.** Runtime proof text is masked; the Worker's guidance limits it to what needs no login.

## 7. Risks and open questions

| Risk | Mitigation |
|---|---|
| A proposed line waits for the owner's card while the Main starts other work | The sequential slot still holds; the line follows what runs |
| Gate read wrongly stops a healthy line (a second Worker dirtying a lane, a repository with no placement) | Each reason is named in the notice; a continuation or the owner's release resumes it; the switch (§5.12) turns the line off during acceptance |
| Stored settings keep 250k | Named in the ADR; the owner changes it in Settings |
| Silent steps hide a slow or dead line | A stalled head and a head with no live Worker are stops, told to the Main; the mission page shows step, state and reason |
| Baseline target beyond the plugin's reach | WP-207 reports it; the trim stops at the measured budget |
| The Main quotes owner words it should not treat as `parallel` | The tool checks the quote is real; `manager.md` limits which words count; the reason is journalled and shown |

No open question blocks a work package.

## 8. Test strategy

Vitest under `test/`, per the bead's file, with temporary git repositories for merges and in-memory stores for the rest. Each bead runs its named tests only. Each phase's closing bead runs `npm run verify` once. `npm run test:eval -- test/eval-worker-baseline.test.ts` guards the baseline. No coverage figure is set; each rule above needs a positive and a refusing case.

## Revision history

| Date | Change |
|---|---|
| 2026-11-10 | Written from the owner's fourteen items and ADR-045. `plan-ready-for-beads` passed; Phase 1 and Phase 2 scope frozen. |
| 2026-11-10 | Revised for review b1, on the coordinator's decisions: gate over the chain and failing closed, full-record checks, `after` resolved at creation, stop kinds and keyed notices, the triage of new work (`next`, `parallel`), Amends completed, an empty `after` for a first step, criteria on the card's details, the owner's switch (§5.12), WP-107 merged into WP-207, 22 leaves plus the switch. No bead had started. Gate re-run: PASS. |
| 2026-11-10 | §2 item 10, WP-106 and §5.6: the deferral of `BM-ROLLOVER now` removed and the notice addressed to the current Worker (ADR-046), on the coordinator's decision after the seeded scenario showed the deferral cannot keep the hard limit. |
| 2026-11-10 | Revised for re-review b1: a started step stays started; a stall stop outlives its alert's window; the gate and merge use the chain's newest commit and newest report naming checks. |
| 2026-11-10 | Revised for Phase 1 review b2: §5.1, the owner's decision or words are never a note; §5.2, a reported commit counts as a change and the gate reads only its Workers' records. |
| 2026-11-10 | Revised for Phase 2 review b3: §5.8, an unreadable agent list holds the slot, a head idle past the stall window is a stall stop, a dropped notice is told again, and a release or a cancel re-tells what its failure still stops. |
