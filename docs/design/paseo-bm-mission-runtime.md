# paseo-bm — The mission runtime: state, a long-lived Main, one authority, one owner, a signal budget (Technical Design)

| Field | Value |
|---|---|
| Status | Active — the contract the plan's beads build to; edited in place as built |
| Owner | hieu.nt10 |
| Requirements | [Missions PRD](../product/paseo-bm-missions-prd.md) REQ-202 → REQ-208, M-31 → M-35 |
| Decision | [ADR-033](../adr/ADR-033-the-mission-is-the-system-of-record.md) |
| Plan | [mission runtime plan](../archive/plans/paseo-bm-plan-mission-runtime.md) |
| Builds on | [missions design](./paseo-bm-missions.md) (stores §2, the Main §3, autonomy §8, governor §9, §20); [base design](./paseo-bm.md) §7.16 (outbox), §7.5 (notices); [autonomy design](./paseo-bm-autonomy.md) Part B (levels), §A.6 (decisions); [Orchestrator design](./paseo-bm-orchestrator.md) |

Section numbers are cited by code; they are never renumbered. Where this design and an older one differ on the runtime of a mission, this one holds, and the older section gains a pointer here.

## 1. Principles

1. **Code writes every event where it happens; one function reads the mission.** No agent's conversation holds state the plugin needs.
2. **An agent is maintained, not replaced.** Replacement is the exception and loses nothing.
3. **One function names who decides; whoever it names is told at once.**
4. **Each thing has one owner.** Ownership moves only through one function, on the owner's card.
5. **A notice is sent only when its recipient has something to do.**

## 2. The mission state (ADR-033 decision 1, REQ-202)

### 2.1 What it holds

`missionStateOf(home, missionId, deps) → MissionState` (`server/mission-state.ts`; types and the pure renderer in `shared/mission-state.ts`). Reads only; never throws (a store it cannot read leaves its part empty and adds a line to `unknown`).

```ts
interface MissionState {
  at: string;
  mission: { missionId; code; name; state: "open" | "closed"; goal; charterConfirmed: boolean;
             repos: Array<{ workspaceId; name | null }>; mainId: string | null;
             mainHistory: Array<{ agentId; from; to: string | null; reason }> };
  requests: Array<{ requestId; workspaceId; topic; workerId: string | null;
                    state: "working" | "waiting-owner" | "waiting-main" | "waiting-other" | "finished" | "stopped";
                    lastReport: { phase; at; line } | null;   // line: the report's first summary line, ≤ 200
                    followUpAt: string | null;                // a follow-up told after the newest report
                    waitingOn: string | null }>;              // the blocked report's "waiting for …", ≤ 200
  questions: Array<{ id; requestId: string | null; qn: string | null; class; subject: string | null;
                     decider: "code" | "main" | "orchestrator" | "owner"; askedAt; question; recommended: string | null }>;
  asks: Array<{ id; askedAt; question; options: string[] }>;   // the Main's open m: questions (§4.6) and open m: cards
  links: Array<{ linkId; route; kind; direction: "out" | "in"; partner; state; waitingSince: string | null; gist }>;
  owner: Array<{ at; from: "owner" | "main"; text }>;          // the newest 6 entries of the owner's exchange with the Main
  governor: Array<{ family; step; since; crossed: string[] }>; // families above step 0
  journal: Array<{ at; kind; by; text }>;                      // the newest 10 lines
  unknown: string[];
}
```

**Sources.**

| Part | Read from |
|---|---|
| `mission` | `missions/<id>.json` |
| `requests` | the roster (every entry not `finished`/`stopped`, plus those finished in the last 24 h), the registry (`workerIds`, `finishedAt`), the outbox's newest `report` record of the request (`newestReportRecordOf`), the roster's `followUpAt` (§2.3) |
| `questions` | the unsettled `q:` decisions of the roster's requests in their repos, and the unsettled `m:` decisions of the mission; `decider` from `deciderOf` (§4.1) |
| `asks` | the unsettled `m:` decisions of the mission |
| `links` | the peer-link store: live links whose `from.requestId` or `to.requestId` is on the roster, or whose `missionId` is this mission |
| `owner` | the trace records of the mission's Main agents (`mainHistory` ids) in the Missions home (or `legacyWorkspaceId`): each turn's owner-origin `sent` message and the first paragraph of its `received` reply, ≤ 300 characters each, newest last |
| `governor` | `orchestrator/governor.json` |
| `journal` | `missions/<id>.journal.jsonl` |

**A request's `state`.** Read in order, the first that holds:
1. `finished` or `stopped`: the roster state, unless `followUpAt` is later than the newest report, which reads `working`.
2. `waiting-owner`: an open question whose decider is the owner.
3. `waiting-main`: an open question whose decider is the Main.
4. `waiting-other`: the newest report is `blocked` with a `waiting for` line and no open question.
5. Otherwise `working`.

### 2.2 The rendering

`renderMissionState(state, { maxChars })` (pure) writes sections in this order, each line cut and masked with `redactText`:
1. a header line;
2. **In flight**: one line per request: repo, request, Worker, state, newest report and its age, follow-up;
3. **Waiting on you**: owner questions and the Main's asks;
4. **Yours to decide**: questions whose decider is the Main;
5. **Links**;
6. **The owner said lately**;
7. **Governor**;
8. **Recently**: the journal.

It closes with "Read the whole mission with bm_mission." The cap is `MISSION_STATE_MAX_CHARS` = 6,000. Sections are dropped from the end, and lines from the oldest, until it fits.

**Consumers.** The rendering replaces these, which are retired:

| Consumer | Uses | Replaces |
|---|---|---|
| A Main's first prompt at creation and replacement (`mainBriefOf`) | the header, the charter lines kept, then the rendering | the roster-only "Open requests" list and the journal tail |
| The Main's `BM-STATE` after compaction (`compaction.ts` `managerBrief` for a Main) | the rendering | `missionRequestLines` and the owner's last 3 messages |
| The governor's wake brief (`governor-brief.ts` `missionBriefOf`) | `governor`, `requests`, `questions`, `journal` of the same state | the brief's own reads (ADR-032 §20.1) |
| `mission.get` (Missions screen, §7) | the structured `MissionState` (`inFlight`, `mainHistory`) | — |


*Since 2026-10-21* (delivery line design §4.9, §9.3), the rendering gains two sections after In flight:
- **Lines:** one line per repository with a placement.
- **Contracts:** the open contracts, proposed first, at most 10.

Each link shows its latest message with its refs, and links closed in the last 24 hours are listed. When the text must shrink, the sections drop in this order: Recently, Governor, the owner's recent words, Contracts, Links.

A Worker's compaction brief carries its request's links and the contracts touching its repository, within a 2,400-character block.

### 2.3 Writes that make it complete

Each write is code, at the event, through `journalQuietly` (a failed line is one log line; the event itself stands):

| Event | Where | Writes |
|---|---|---|
| A follow-up to a Worker (`bm_tell_worker`) | `deliver-tools.ts` | roster `state: active`, `followUpAt = now`; journal `worker` "Follow-up to <request>: <first line, ≤ 160>" |
| A Worker's `blocked`, `finished`, `stopped` report | `deliver-tools.ts`, `unbound-relay.ts` | journal `worker` "<request> <phase>: <summary, ≤ 160>" (the roster as today) |
| A mission link asked (`bm_ask_mission`) | `peer-tools.ts` | journal `link` on the asker's mission "Asked mission <code> (<kind>): <gist>" |
| A link taken (`bm_create_worker`/`bm_tell_worker` with `peerLink`), answered, or closed | `create-worker.ts`, `deliver-tools.ts`, `peer-tools.ts` | journal `link` on each mission concerned |
| A Main's question to the owner, and its answer | §4.6 | journal `decision` (as `m:` cards today) |
| Requests moved between missions | §5.1 | journal `charter` on both missions |
| A Main replaced | §3.4 | one journal `main` line (exactly one) |

The missions design §2.2 rule "the journal is not the source of any state" is replaced by: the journal is the mission's history; `missionStateOf` composes the stores; the one journal read for state (the open split suggestions) stays.

## 3. A long-lived Main (ADR-033 decision 2, REQ-203)

### 3.1 The figure

`mainContextOf(record) → { used: number; max: number | null } | null`:
- `used` is the turn's `usage.contextUsed`. When that is absent, it is the estimate `tokensRead / (toolCalls + 1)` on Claude, or `tokensRead` on a last-call provider. Without either it is null.
- `max` is `usage.contextMax` when reported.
- The per-turn token sum is **never** a Main's figure.

### 3.2 The settings

Coordination gains the group `main = { compact: true, contextShare: 0.6, contextTokens: 150_000, hardShare: 0.85 }` (`shared/coordination.ts`; change keys `main.compact`, `main.contextShare`, `main.contextTokens`, `main.hardShare`, each a prepared change the owner can apply).

| Setting | Bounds |
|---|---|
| `main.contextShare` | 0.3–0.9 |
| `main.contextTokens` | 50,000–2,000,000 |
| `main.hardShare` | 0.35–0.95; the hard figure is never read below `contextShare` + 0.05 |

The figure crosses when `used / max ≥ contextShare`, or, with no `max`, when `used ≥ contextTokens`. The hard figure is `used / max ≥ hardShare`, or, with no `max`, `used ≥ contextTokens / contextShare × hardShare`.

`main.compact` is separate from `compact.enabled`, `compact.maxPerAgent` and the A-12 guard. A Main's compaction is maintenance, not a coordination intervention, so it records no intervention entry and the guard never counts it.

### 3.3 In-place compaction

The existing runner (`compaction.ts`) handles a Main with these differences:
- **Trigger:** §3.1 against the `main` settings, at a recorded turn of a mission's current Main.
- **Safe point:** the Main idle with nothing else queued for it (as today).
- **What it sends:** `/compact` as today, then `BM-STATE` = `renderMissionState` (§2.2).
- **No cap:** a Main may compact as often as it crosses.

The agent id and the owner's chat do not change.

### 3.4 One replacement path

`replaceMain(missionId, newMainId, reason, { expectedOld })` (`mission-replace.ts`) is the only function that changes a mission's `mainId`:
- **Single flight per mission:** an in-memory chain keyed by mission id. A second call waits for the first and then re-reads the mission.
- **Idempotent:** when `mission.mainId === newMainId` it returns ok and writes nothing.
- **Compare-and-set:** when `expectedOld` is given (null for a mission with no Main) and differs from `mission.mainId`, it is refused, and nothing is written or sent.
- **Steps:** `setMain`; one journal `main` line; the roster's requests reassigned in the registry; Worker bindings re-pointed and their `paseo.parent-agent-id` labels set; the old Main labelled `bm.replacedBy` and retitled; the notice queue retargeted; open outbox records redelivered.
- **No notice to any Worker**, and none to the old Main.

**`createMain`** creates the agent only: labels, binding, first prompt. It neither sets `mainId` nor writes the journal. Every caller follows it with `replaceMain`:
- `mission.ensure`
- `handOverMain`
- the successor claim
- the composer adoption
- the fallback
- the split's new mission

**`mission.ensure` while a Main is being created.** It joins the in-flight creation for that mission (`creatingMain: Map<missionId, Promise<agentId>>`) instead of adopting the half-made agent. `findMain` skips an agent that an in-flight creation holds.

### 3.5 When a new Main is still created

Through `handOverMain` → `createMain` → `replaceMain(…, "handoff", { expectedOld })`, only in these cases:
1. The Main's provider cannot compact (not in `COMPACTION_PROVIDERS`) and §3.1 crosses.
2. Two compactions of this Main in a row ended `no-compaction`.
3. The first recorded turn after a completed compaction still reaches the hard figure.

The successor's first prompt is the brief of §2.2, plus the line: "You take over mission <code> from Main <old> (<reason>). In your first reply tell the owner in one line that you took over and what is in flight, from the state above."

Settings → Coordination's `handoff.enabled` still governs this path.

### 3.6 A replaced Main

Every bound Main tool resolves its caller's mission (`mainOf`). When the caller is not the mission's current `mainId`:
- a tool that writes or sends is refused with "You were replaced by Main <id> of mission <code>; tell the owner to continue in that Main's chat (the Missions screen opens it)";
- reads (`bm_mission`, `bm_decisions`, `bm_repo`, `bm_memory` read) still answer.

## 4. One authority (ADR-033 decision 3, REQ-204, REQ-205)

### 4.1 The resolver

`deciderOf(decision, facts) → { decider: "code" | "main" | "orchestrator" | "owner"; rule; why }` (`shared/authority.ts`, pure). `facts` holds:
- `policy` (the repo cells);
- `missionOf(requestId)`;
- `missionDelegates(missionId, cell)`;
- `finishedUnverified?(requestId)` (optional; the `f:` rule below). Review figures left the resolver on 2026-10-20 (delivery line design §5).

Rules, the first that holds:

| # | Decision | Decider |
|---|---|---|
| 1 | `ownerOnly`; `o:`; `r:`; `h:`; an option carrying a prepared change | owner |
| 2 | `f:` whose class (`environment`) the project delegates, unless every acting option is refused for an unverified finish (then the owner) | orchestrator |
| 3 | retired on 2026-10-20 (review budgets): reviews past a request's cap are one owner-only `review-cap` question, rule 1 (delivery line design §5.4) | — |
| 4 | `q:` of a request of a mission, its class delegated by the repo cell or the mission cell (`answer-technical` / `answer-effects`). When only the mission cell delegates it, the Main is named only if an option leaves no effect (rule `mission-effects`), and `bm_answer_worker` refuses an option with effects (delivery line design §7.1) | main |
| 5 | `q:` of a request of a mission, repo cell `shadow` | owner, the Main recommending |
| 6 | anything else | owner |

A precedent (`resolveAtOpen`) still answers first, at open, wherever it applies today. It is code acting on the owner's own earlier words, so it is not a row of the table.

The resolver is the only place these rules live. Its callers:
- the materialiser at open;
- `bm_answer_worker` (it answers only where the decider is the Main, or records a recommendation at rule 5);
- `bm_decide` (rule 2);
- `missionStateOf` (§2);
- the owner's views, which name "Main" or "paseo-bm" where they decide.

These are retired:
- `mainAnswerRuleOf`'s inline checks;
- the Main's ten-minute window (`MAIN_ANSWER_MINUTES`);
- the "carries a grant: only the owner" refusal for review grants;
- the unused `missionQuestionRefusalOf`.

### 4.2 The owner always may

The owner answers any unsettled decision at any time, on its card or in a chat; the first answer stands (as today). Rule 4 never hides a card from the owner.

### 4.3 Review budgets

Retired on 2026-10-20 by [ADR-035](../adr/ADR-035-a-delivery-line.md) decision 4. The things that are gone:
- the code and Main caps;
- delegated `untilClean`;
- the `review-budget` question.

A request's reviews converge by themselves under a computed cap, and past the cap paseo-bm asks the owner once ([delivery line design](paseo-bm-delivery-line.md) §5). The Main is not told about reviews: `BM-BUDGET` stays retired (§6.1).

### 4.4 The Main is told at once

When a question opens whose decider is the Main, the Main gets one channel item (§6.2):
- `BM-DELIVERY message` from `plugin`: "Q<n> of <request> (<class>, <subject>) is yours to answer within the mission's delegation: <question, ≤ 300>; options <key — label, recommended marked>. Answer with bm_answer_worker; the owner sees your answer and may override it."
- A rule-5 question gets the same item, ending "Recommend with bm_answer_worker; the owner decides."

### 4.5 `bm_answer_worker`

It refuses, before writing anything:
- a question whose decider (§4.1) is not the Main;
- a settled question;
- an unknown option;
- a request outside the caller's mission.

It writes the Main's recommendation with `withMainPrediction`. The same writer attaches a recommendation when `bm_owner_question` refuses a repeat of an open Worker question (delivery line design §7.2).

Under the mission-only delegation it also refuses an option with effects (delivery line design §7.1). The answer is `by: main`, `via: main`, delivered to the Worker as the Main's.

### 4.6 The Main asks the owner with a stored decision

A new Main tool, `bm_owner_question { question ≤ 1,000, options: [{ label ≤ 200, recommended? }] (2–5, exactly one recommended), class, subject?, ownerOnly? }`. It opens an `m:` decision on the Main's mission:
- `askedBy` is the Main;
- the options carry no action;
- the class is the Main's.

**The owner answers:**
- on its card in the Inbox; or
- in the Main's chat. The Main then records the answer with `bm_owner_question { answered: "m:…", option | words }` (`server/owner-question.ts`; `bm_answers` stays for Worker questions), settled at the turn end only when the turn holds an owner-typed message, as for Worker questions; without one it is dropped with a log line.

**The answer** on the card reaches the Main as a channel item (`tellMain`: "The owner answered your question m:…: <label or words>."); one the Main recorded from its own chat is journaled and not told back. The journal gains `decision` lines for the question and its answer.

**Role change:** the Main's role file asks everything the owner must decide this way, one decision per question. Its reply names the question in one line, never as the only place the question exists.

## 5. One owner (ADR-033 decision 4, REQ-206)

### 5.1 One transfer function

`transferRequests(home, { from, to, requestIds, reason, by }, deps)` (`server/mission-transfer.ts`):
1. `roster.move`;
2. the registry's `managerId` set to the target's Main and `missionId` to the target;
3. the Workers' bindings re-pointed and their parent labels set;
4. a journal `charter` line on both missions;
5. both Mains told (channel items, §6.2).

No Worker notice. Refused (`transferRefusalsOf`), with nothing written, for:
- an unknown or closed mission;
- no request named;
- a request not on the source roster (a request on another mission's roster is never on it);
- the same mission as source and target.

A target with no Main yet gets steps 1, 2's `missionId` and the bindings' mission only; the Main's creation (`replaceMain`, §3.4) then points the requests and their Workers at it. Steps 4 and 5 can be left to the caller (`journal: false`, `tell: false`).

The split (`executeSplit`) calls it instead of its own `roster.move` and `reassignRequests`: it transfers to the new mission before its Main exists (so its brief lists them), keeps its own journal lines and its word to the source Main, and undoes a failed split by transferring back.

### 5.2 Merging a legacy one-repo mission

A legacy mission is `createdBy: "legacy"`, with goal `""` and exactly one repo (`isLegacyMission`, `server/mission-ownership.ts`). When an owner-created or split mission holds that repo — at creation, when `bm_mission_start` settles, when a repo is added, and once per plugin run for every open mission (`createLegacyMigration`, so missions that already overlap get their card) — the plugin opens one `m:` card on the holding mission (`offerMerges`): "Merge mission <legacy code> (<repo>) into <code>". Its "apply" option carries the new prepared change `mission-merge { from }`. A pair is asked once: an open card waits, and the owner's "keep as is" stands.

Applying it:
1. transfers every roster request of the legacy mission;
2. closes the legacy mission (`closedAt`, `mergedInto: <missionId>`);
3. labels the legacy Main `bm.replacedBy` with the holding mission's Main and retitles it "· merged into <code>". Nothing is archived (ADR-005).

Refused when a Worker of the legacy mission is running a turn (`busyRequestsOf`, §5.4). The mission record gains the optional `mergedInto`.

### 5.3 Transferring requests to another mission

Moving requests to another mission needs the owner's yes:
1. The source Main records it with `bm_mission_update { transfer: { to: <code>, requestIds, reason } }`; the tool checks it as §5.1 refuses and answers `transferDecisionId`.
2. That opens an `m:` card with the prepared change `mission-transfer { to, requestIds, reason }` (`offerTransfer`); the same move asked twice is refused while its card is open.
3. The owner's tap runs §5.1, checked again first.

`bm_ask_mission` stays for asking another mission a question or for work. It moves nothing.

### 5.4 Closing

A close (and a merge) waits only for `busyRequestsOf`: a roster request whose Worker is `running` or `initializing` in Paseo; idle and unknown Workers do not hold it. `runningRequestsOf` keeps counting live Workers for the staffing rule, where an idle Worker should be given the work. When a mission closes — on its card or from the Missions screen — its `active` roster entries become `stopped` (`stopActiveRequests`). *Since 2026-10-21 (ADR-035):* its placements become `retired`, and one owner-only `worktree-archive` card lists each with its uncommitted, unpushed and merge-request state. Archiving a worktree is the owner's, in Paseo, because Paseo's archive deletes uncommitted work (delivery line design §3.6).

### 5.5 Entry points

- **`manager.ensure`** gains `requestId?`. With a request of an open mission, it opens that mission's Main; a request of no mission falls back to the workspace. No client entry point opens a Manager for one request today (Work's "Open Manager" is per project), so the ordering below is what fixes the XAI case.
- **`missionOfWorkspace`** (workspace only) orders the open missions that hold the workspace:
  1. created by the owner or the orchestrator, before legacy;
  2. then the newest journal line;
  3. then `createdAt`.

## 6. A signal budget (ADR-033 decision 5, REQ-207)

### 6.1 Every notice and its action

| Notice | Recipient | Its action | Decision |
|---|---|---|---|
| `BM-DELIVERY report` | Main | alignment at `received`/`beads-done`/`finished`; questions or waits at `blocked`; `stopped` | keep, through the Main's channel |
| `BM-DELIVERY message` | Main | as its text says (`m:` answers, a question to answer §4.4, transfers) | keep, through the channel |
| `BM-DELIVERY peer` / `peer-reply` / `peer-message` | Main | answer, take or route the ask | keep, through the channel |
| `BM-COMMAND` (governor, prepared commands, handoff info) | Main | re-plan, act or note | keep, through the channel |
| `BM-SIGNAL danger` | Main | stop the Worker unless the owner asked for it | keep, through the channel, `first` |
| `BM-STATE` | Main, Worker | take the state after a compaction | keep |
| `BM-SETTINGS` "the Manager you report to was replaced" | Workers | none | **removed** (§3.4) |
| `BM-BUDGET` | Main | none ("for your information") | **removed** (§4.3) |
| `BM-SETTINGS` mode changes | unbound Managers, Workers | update the child mode | keep |
| `BM-INTERRUPTED`, `BM-TOOLS`, `BM-RESUME`, `BM-FORMAT`, `BM-STOP`, `BM-REPLACED`, `BM-HANDOFF`, `BM-FALLBACK`, `BM-ASK`, `BM-ANSWER`, `BM-EVENTS` | as today | as today | keep |
| `BM-DELIVERY message`, `answers`, review, override | a Worker waiting by structure | settles an item it waits on, or nothing | **held** while it settles none (delivery line design §6.4); released with the wait |
| `BM-UPDATES` (with a `BM-DELIVERY wait` facts block) | a Worker whose wait is met | act on each block | added (delivery line design §6.4) |
| `BM-ROLLOVER soft` / `now` | a Worker | finish, with what remains listed | added (delivery line design §2.6) |

### 6.2 The Main's channel

**Batching.** Records and commands addressed to a mission's Main go through the notice queue's batch kind (`server/main-channel.ts`, `enqueueNotice`):
- batch `BM-UPDATES`, item key = the notice's own queue kind (`<kind>:<recordId>` for a record, the command's kind, `BM-SIGNAL:<workerId>`), so a newer signal for one Worker still replaces a queued one;
- one group, with a `danger` item marked `first`: the group goes before every other notice queued for the Main;
- a Main is the current Main of an open mission (`isMissionMain`); a replaced Main gets single notices.

**Message format.** Everything pending at the Main's idle moment goes as one message (`shared/notices.ts`, `updatesNoticeOf`; read back by `updatesItemsOf`):
- line 1: `BM-UPDATES <n>`;
- line 2: "From the paseo-bm plugin, not the owner: <n> items, oldest first. Act on each as its block says.";
- then each item's exact block (`BM-DELIVERY …`, `BM-COMMAND …`, `BM-SIGNAL …`), separated by a line `BM-ITEM <i>`.

One item alone goes as its block, with no `BM-UPDATES` wrapper: the commonest case keeps the shape every reader already knows.

**Delivery tracking.** The queue's batch items gain per-item `callbacks` (`onSent`, `onDropped`), so the outbox settles, retargets and holds each record as it does today. An item is dropped, and told, when its target is gone, its send fails, or its subject settled before delivery. `BM-UPDATES` is a plugin notice (`PREFIXES`), matched as a whole word.

**Who uses it:**
- the outbox's `deliverRecord` for records whose target resolves to a mission's Main;
- `command-send.ts` for a command to a Main;
- the Worker watch for `BM-SIGNAL`.

Records to unbound Managers keep one message each. Records to Workers keep one message each, except the release of a Worker that waited by structure: its held items and the facts of what settled go as one `BM-UPDATES` (`enqueueUpdates`, delivery line design §6.4).

**The chat** (`client/chat-card-parse.ts`): a `BM-UPDATES` message is split at its `BM-ITEM` lines, and each block is drawn as the card it would be alone, in order. One whose items draw nothing is a single notice line, "Updates from paseo-bm".

**The role file:** a `BM-UPDATES` message holds several of the blocks the Main already knows; act on each.

### 6.3 The governor counts waiting as waiting

The `stalled` figure (`governor-figures.ts`, `waitingOrStoppedOf`) reads a request's structured wait first: `waiting.items`, judged by `structuralWaitOf` (delivery line design §6.5). A wait on live items is waiting. The rule below applies to reports without items. It leaves out a request that is:
- **waiting**: its newest report is `blocked` and its `waiting for` (`waitingOnOf`, `shared/mission-state.ts`) names, by id, a request or Worker of the same mission that is not `finished`/`stopped`;
- **stopped**: its roster state is `stopped`, or its newest report is `stopped`.

A wait that names other work only in words (a topic, "the frontend Worker") still counts as stalled: the figure reads ids, not prose.

The owner's Inbox stall alert is unchanged.

### 6.4 No budget notice to a Main

`review-budget.ts` sends no `BM-BUDGET` to the Main of an open mission: neither at a Worker's or Reviewer's turn end that finds the overrun, nor at the Main's turn end that would flush one held. A Manager that is no open mission's Main is told as before.

## 7. The Missions screen (REQ-208)

The mission page gains two parts. The owner approved the mockup on 2026-10-10 ([`mockups/mission-runtime.html`](mockups/mission-runtime.html), artboards G and H); it is the contract. Built in `client/missions.tsx` (`MainsCard`, `InFlightCard`) from `client/missions-model.ts` (`mainHistoryOf`, `inFlightOf`); checked by a static render of the real components (react-native-web, headless Chrome) against both artboards.
- **In flight**, between "Workers by repository" and the Contracts/Journal grid. It shows, from `mission.get`'s `inFlight` (the structured `MissionState`):
  - each request with its state words ("working", "waiting for you", "waiting for the Main", "waiting for <other>", "finished");
  - the questions grouped by who decides;
  - the Main's asks;
  - live links with how long they have waited.
- **Main history** in the page header: each Main of `mainHistory` with when and why it changed, and "Open" on a previous one (`openAgent`).

`mission.get`'s output gains `inFlight: MissionState` and `mainHistory`, both optional for an older reader; neither card shows without them.

As built:
- **Placement:** the Main card right under the title row, before the stats (desktop and phone); In flight between "Workers by repository" and the Contracts/Journal grid (desktop), after the stats on a phone.
- **Words:** request states "working", "waiting for you · Q1", "waiting for the Main · Q2", "waiting for <other work>" (a request id shortened; on a phone, that request's topic), "finished", "stopped"; why a Main changed: "created with the mission", "replaced", "handoff — its context was full; this Main carries on", "fallback — its provider plan stopped it", "you asked" (the phone: the one word).
- **"The Main asked you"** lists only the Main's own open `m:` cards: `MissionState.asks` gains `byMain` and `recommended` (optional); paseo-bm's cards (governor, merge) stay in the Inbox. The rendered state names them "paseo-bm's card".
- **"Answer"** opens the Inbox (`onOpenInbox`), where the card is answered; it is offered for the owner's questions and the Main's asks only.

## 8. Role files

- **`manager.md`:**
  - ask the owner with `bm_owner_question`;
  - answer the questions the plugin names as yours with `bm_answer_worker`, no time window;
  - `BM-UPDATES` holds several known blocks;
  - after `BM-STATE`, carry on from it;
  - a successor's first reply says it took over and what is in flight.

  The file stays within its 100 lines and five limits. As built: rule 4's list no longer names `BM-SIGNAL` (the general rule "the plugin's `BM-` notices each say what to do" covers it, and the notice says to stop the Worker); a `copy: yes` block is "context only: one line at most"; the owner's answer to the Main's own question is recorded with `bm_owner_question`'s `answered`, not `bm_answers`. The handoff instruction for the first reply is in the successor's brief (`mainHandoffLineOf`), not the role file.
- **`worker.md`:** no change. The replacement notice it never relied on is removed.
- **`orchestrator.md`:** no change beyond the wake brief's source (§2.2).

## 9. Stored formats and compatibility

All changes are additive:

| Change | Where |
|---|---|
| `followUpAt?` | roster entries |
| `mergedInto?` | missions |
| new journal texts | under existing kinds (`worker`, `link`, `decision`, `charter`, `main`) |
| `m:` questions without actions | the existing schema allows options without `action` |
| prepared actions `mission-merge`, `mission-transfer` | `preparedActionSchema` |
| `main.*` | Coordination settings, each field defaulted on its own |
| per-item batch callbacks | memory only |
| `inFlight`, `mainHistory` | optional in `mission.get` |
| `requestId?` | optional in `manager.ensure` |
| `asks[].byMain?`, `asks[].recommended?` | optional in `MissionState` (`mission.get`'s `inFlight`) |
| `transfer?` | optional in `bm_mission_update`'s input |

An older build ignores the new fields. It reads an `m:` question as a card with options and no action. A `mission-merge` or `mission-transfer` it cannot parse fails that one decision's validation, so it skips the decision, as it does with any entry it cannot read.

The role-file changes flag running Mains outdated once.

## 10. Measures and tests

- **M-31 — work lost across a Main replacement:** 0. Measured by a property test that replaces the Main after each event of a scripted mission and compares `missionStateOf` before and after, plus a drill on an isolated daemon.
- **M-32 — Main replacements for context while the real context is below `hardShare`:** 0. Measured from the journal and the traces.
- **M-33 — share of a Main's turns started by the owner:** ≥ 50 % on the acceptance scenario (XAI baseline 25 %). Reported by the replay as **A-14**: Main turns by trigger (owner, report, message, peer, command, state, other), from the Missions home's trace records (`shared/eval-metrics/mains.ts`; evaluation design §4). A turn's trigger is its first inbound message; a `BM-UPDATES` message counts by its first item and once in `batched`.
- **M-34 — questions reaching the owner at Full auto other than `ownerOnly` and beyond the caps:** 0. Measured from the decision store.
- **M-35 — open legacy missions overlapping an owner's mission once its merge card is applied:** 0.

**Unit tests** per module:
- `mission-state` (each source, each request state, rendering bounds);
- `authority` (each rule);
- `replaceMain` (single flight, compare-and-set, idempotent, no Worker notice);
- Main compaction (figure, no token sum, hard figure → handoff);
- `transferRequests`, merge and transfer cards, the close rule, `missionOfWorkspace` ordering;
- the channel (one message, per-item outcomes, `first`);
- the chat split;
- the governor `stalled` exclusions.

## 11. Phases

| Phase | Contents | Exit |
|---|---|---|
| P1 State | §2 (state, rendering, writes), consumers except the screen | unit tests; M-31 property test green |
| P2 Long-lived Main | §3 | unit tests; M-32 in the tests |
| P3 Authority | §4 | unit tests; M-34 scripted |
| P4 Signal budget | §6 | unit tests; A-14 in the replay |
| P5 One owner | §5 | unit tests; M-35 scripted |
| P6 Screen and acceptance | §7 after the mockup; the isolated-daemon drill is the owner's | mockup approved; checks green |

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-10 | Claude (owner's approval of the five changes; technical choices under the owner's delegation) | Created. `design-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-10 | Claude (Phase 4 as built) | §6.2: one item alone goes as its block; item keys are the notices' queue kinds; per-item callbacks also on a settled subject. §6.3: the waiting rule reads ids. New §6.4: no budget notice to a Main. §10: A-14's trigger rule |
| 2026-10-10 | Claude (Phase 5 as built) | §5.1: refusals, a target without a Main, the split's order and undo. §5.2: `offerMerges`, the start-up sweep, asked once per pair, `mergedInto`. §5.3: `transferDecisionId`, duplicate card refused. §5.4: `busyRequestsOf` for close and merge; `runningRequestsOf` stays for staffing. §5.5: no per-request client entry point |
| 2026-10-10 | Claude (Phases 2–3 as built) | §3.2: the settings are the `main` group (`main.compact`, …), `hardShare` bounds 0.35–0.95 with the `contextShare` + 0.05 floor in the figure. §4.6: the owner's chat answer is recorded with `bm_owner_question`'s `answered`. §8: the role file as built. `bm_decide` keeps its own refusal (`decideRefusalOf`), equivalent to rule 2 of §4.1 |
| 2026-10-10 | Claude (Phase 6 as built) | §7: the owner approved the mockup (artboards G, H); the cards as built, `asks[].byMain`/`recommended`, "Answer" opens the Inbox. §9: the optional fields added. Every phase built; the drill is the owner's |
| 2026-10-20 | Claude (as built, ADR-035 Phase 6) | §4.1: rule 3 retired, rule 4's mission-effects condition, rule 2's unverified-finish exception, `reviewFigures` gone; §4.3 retired (the review cap, delivery line design §5); §4.5 the effects refusal and `withMainPrediction` |
| 2026-10-21 | Claude (as built, ADR-035 Phase 7) | §6.1 held deliveries, the Worker's `BM-UPDATES` release, `BM-ROLLOVER`; §6.2 records to Workers except a release; §6.3 structured waits first (delivery line design §6) |
| 2026-10-21 | Claude (as built, ADR-035 Phase 8) | §5.4 a close retires the mission's placements and offers their archive card |
| 2026-10-21 | Claude (as built, ADR-035 Phases 8–9) | §2.2 the Lines and Contracts sections, links by their latest message, the Worker brief's links and contracts |
