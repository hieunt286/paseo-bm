# paseo-bm — The mission runtime: state, a long-lived Main, one authority, one owner, a signal budget (Technical Design)

| Field | Value |
|---|---|
| Status | Active — the contract the plan's beads build to; edited in place as built |
| Owner | hieu.nt10 |
| Requirements | [Missions PRD](../product/paseo-bm-missions-prd.md) REQ-202 → REQ-208, M-31 → M-35 |
| Decision | [ADR-033](../adr/ADR-033-the-mission-is-the-system-of-record.md); request fallback amended by [ADR-040](../adr/ADR-040-the-main-resolves-its-requests-fallback.md) |
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

`missionStateOf(home, missionId, deps) → MissionState | null` (`server/mission-state.ts`; types and the pure renderer in `shared/mission-state.ts`). Reads only; null for an unknown mission; never throws (a store it cannot read leaves its part empty and adds a line to `unknown`). Its texts are masked as they are read.

```ts
interface MissionState {
  at: string;
  mission: { missionId; code; name; state: "open" | "closed"; goal; charterConfirmed: boolean;
             repos: Array<{ workspaceId; name | null }>; mainId: string | null;
             mainHistory: Array<{ agentId; from; to: string | null; reason }> };
  criteria: { met; total; open: Array<{ id; text }> };       // the charter's done criteria
  requests: Array<{ requestId; workspaceId; repo: string | null; topic; workerId: string | null;
                    state: "working" | "undelivered" | "waiting-owner" | "waiting-main" | "waiting-other" | "finished" | "stopped";
                    lastReport: { phase; at; line } | null;   // line: the report's first summary line, ≤ 200
                    followUpAt: string | null;                // a follow-up told after the newest report
                    waitingOn: string | null;                 // the blocked report's "waiting for …", ≤ 200
                    continuationOf?; continuedBy?; chainPosition?;     // delivery line design §2.7
                    committed?; verified?; commit?; couldNotRun? }>;   // delivery line design §4.4, §4.6
  placements?: MissionStatePlacement[];                        // delivery line design §4.9
  contracts?: MissionStateContract[];                          // delivery line design §9.3
  questions: Array<{ id; requestId: string | null; qn: string | null; class; subject: string | null;
                     decider: "code" | "main" | "orchestrator" | "owner"; recommend: boolean;
                     askedAt; question; recommended: string | null }>;
  asks: Array<{ id; askedAt; question; options: string[]; recommended?; byMain? }>;   // the mission's open m: cards (§4.6, §7)
  links: Array<{ linkId; route; kind; direction: "out" | "in"; partner; state; waitingSince: string | null; gist; last? }>;
  owner: Array<{ at; from: "owner" | "main"; text }>;          // the newest 6 entries of the owner's exchange with the Main
  governor: Array<{ family; step; since; crossed: string[] }>; // families above step 0
  journal: Array<{ at; kind; by; text }>;                      // the newest 10 lines
  unknown: string[];
}
```

The `code` decider is kept only so stored states still parse; no rule names it (delivery line design §5.6).

**Sources.**

| Part | Read from |
|---|---|
| `mission` | `missions/<id>.json` |
| `requests` | the roster (every entry not `finished`/`stopped`, plus those whose newest report — else their creation — is less than 24 h old, or that were followed up since), the registry (`workerIds`), the outbox's newest `report` record of the request, the roster's `followUpAt` (§2.3), and the open `delivery-dropped` alerts |
| `questions` | the unsettled `q:` and `f:` decisions of the roster's requests in their repos; `decider` and `recommend` from `deciderOf` (§4.1) |
| `asks` | the unsettled `m:` decisions of the mission |
| `links` | the peer-link store: live links whose `from.requestId` or `to.requestId` is on the roster, or whose `missionId` is this mission |
| `owner` | the trace records of the mission's Main agents (`mainHistory` ids) in the Missions home (or `legacyWorkspaceId`): each turn's owner-origin `sent` message and the first paragraph of its `received` reply, ≤ 300 characters each, newest last |
| `governor` | `orchestrator/governor.json` |
| `journal` | `missions/<id>.journal.jsonl` |

**A request's `state`.** Read in order, the first that holds:
1. `finished` or `stopped`: the roster state. A request that is not bound reads `working` instead when `followUpAt` is later than its newest report; a bound one is final (delivery line design §2.3).
2. `waiting-owner`: an open question whose decider is the owner, who is the one holding the request (ADR-045 decision 14).
3. `undelivered`: an open `delivery-dropped` alert of the request (ADR-042).
4. `waiting-main`: an open question whose decider is the Main.
5. `waiting-other`: the newest report is `blocked` with a `waiting for` line and no open question.
6. Otherwise `working`.

### 2.2 The rendering

`renderMissionState(state, { maxChars })` (pure) writes, in this order:
1. a header line, then a "Done criteria:" line;
2. **In flight**: one line per request: repo, request, state (a continued one "finished → `<id>`", with committed, verified or "could not run"), Worker, newest report and its age, follow-up, what it waits on, its topic;
3. **Lines**: one line per repository with a placement (delivery line design §4.9), only when the mission has one;
4. **Contracts**: the live contracts, proposed first, at most 10 (delivery line design §9.3);
5. **Waiting on the owner**: owner questions and the mission's open `m:` cards;
6. **Yours to decide**: questions whose decider is the Main;
7. **Links**: each with its latest message and refs; links closed in the last 24 hours are listed too;
8. **The owner said lately**;
9. **Governor**;
10. **Recently**: the journal.

It closes with "Read the whole mission with bm_mission." An empty section reads "`<title>`: none". The default cap is `MISSION_STATE_MAX_CHARS` = 6,000. Until the text fits, lines go from the oldest end of each section in this order: Recently, Governor, The owner said lately, Contracts (from its end: agreed after proposed), Links, Yours to decide, Waiting on the owner, Lines, In flight. A text still too long is cut with "…". The renderer masks nothing: the state was masked when read.

**Consumers.** The rendering replaces these, which are retired:

| Consumer | Uses | Replaces |
|---|---|---|
| A Main's first prompt at creation and replacement (`missions-home.ts` `mainBriefOf`) | the header, the charter lines kept, then the rendering | the roster-only "Open requests" list and the journal tail |
| The Main's `BM-STATE` after compaction (`compaction.ts` `mainStateLines`, capped at `STATE_BRIEF_MAX_CHARS` − 600) | the rendering | `missionRequestLines` and the owner's last 3 messages |
| The governor's wake brief (`governor-brief.ts` `missionBriefOf`, at most 3,000 characters with the governor's newest notes) | the rendering | the brief's own reads (ADR-032 §20.1) |
| `mission.get` (Missions screen, §7) | the structured `MissionState` (`inFlight`, `mainHistory`) | — |

A Worker's compaction brief carries its request's links and the contracts touching its repository, within a 2,400-character block (delivery line design §9.3).

### 2.3 Writes that make it complete

Each write is code, at the event, through `journalQuietly` (a failed line is one log line; the event itself stands):

| Event | Where | Writes |
|---|---|---|
| A follow-up to a Worker (`bm_tell_worker`) | `deliver-tools.ts` → `mission-roster.ts` `noteFollowUp` | roster `state: active`, `followUpAt = now`; journal `worker` "Follow-up to <request>: <first line, ≤ 160>". Not for a bound request that is finished or stopped: its work goes on as a continuation (delivery line design §2.4) |
| A Worker's `blocked`, `finished`, `stopped` report | `deliver-tools.ts`, `unbound-relay.ts` → `noteRosterReport` | the roster state; journal `worker` "<request> <phase>: <summary, ≤ 160>" |
| A link asked, taken, answered or closed | `peer-links.ts` → `mission-events.ts` `journalLinkEvent` | journal `link` on each mission concerned, such as "Link <id> asked <workspace> (<kind>): <gist>" |
| A Main's question to the owner, and its answer | §4.6 | journal `decision` (as `m:` cards today) |
| Requests moved between missions | §5.1 | journal `charter` on both missions |
| A Main replaced | §3.4 | one journal `main` line (exactly one) |

The missions design §2.2 rule "the journal is not the source of any state" is replaced by: the journal is the mission's history; `missionStateOf` composes the stores; the one journal read for state (the open split suggestions) stays.

## 3. A long-lived Main (ADR-033 decision 2, REQ-203)

### 3.1 The figure

A turn's context is read by `turnTokensOf` (`shared/eval-metrics/tokens.ts`) as `{ context: { tokens, basis } | null, contextShare }`:
- `tokens` is the turn's `usage.contextUsed` (basis `reported`). When that is absent it is an estimate (`estimated`): the tokens read on a last-call provider, or `tokensRead / (toolCalls + 1)` when the turn's tool calls are known. Without either it is null.
- `contextShare` is `tokens / usage.contextMax` when Paseo reports the window, else null.
- The per-turn token sum is **never** a Main's figure.

### 3.2 The settings

Coordination gains the group `main = { compact: true, contextShare: 0.6, contextTokens: 150_000, hardShare: 0.85 }` (`shared/coordination.ts`; change keys `main.compact`, `main.contextShare`, `main.contextTokens`, `main.hardShare`, each a prepared change the owner can apply).

| Setting | Bounds |
|---|---|
| `main.contextShare` | 0.3–0.9 |
| `main.contextTokens` | 50,000–2,000,000 |
| `main.hardShare` | 0.35–0.95; the hard figure is never read below `contextShare` + 0.05 |

The figure crosses (`mainContextCrossingOf`) when the window share reaches `main.contextShare` or the context reaches `main.contextTokens`, whichever comes first; with no window reported, only the second applies. The hard figure (`mainContextHardOf`) is the share at `main.hardShare`, or the context at `contextTokens / contextShare × hardShare` (212,500 at the defaults), never below `MAIN_HARD_TOKENS_FLOOR` (1.25) × `contextTokens` (delivery line design §18.4).

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

**`createMain`** creates the agent only: labels, binding, first prompt. It neither sets `mainId` nor writes the journal. Every path that gives a mission its Main ends in `replaceMain`:
- `mission.ensure` (`missions-home.ts`, which the split's new mission goes through too) and `handOverMain` create the agent with `createMain`;
- the successor claim, the composer adoption and the legacy migration (`mission-legacy.ts`) adopt an agent that already exists;
- the fallback creates its Main with `createManager` (`fallback-manager.ts`).

**`mission.ensure` while a Main is being created.** It joins the in-flight creation for that mission (`creatingMain: Map<missionId, Promise<agentId>>`) instead of adopting the half-made agent: it checks `creatingMain` before it looks for a Main with `findMain`.

### 3.5 When a new Main is still created

Through `handOverMain` → `createMain` → `replaceMain(…, "handoff", { expectedOld })`, only in these cases (`mainHandoffReasonOf`, `handoff.ts`):
1. The Main's provider cannot compact (not in `COMPACTION_PROVIDERS`: Claude, Codex, OpenCode) or `main.compact` is off, and §3.1 crosses.
2. Two compactions of this Main in a row ended `no-compaction`.
3. The first recorded turn after a completed compaction still reaches the hard figure.

The successor's first prompt is the brief of §2.2, plus `mainHandoffLineOf`: "You take this mission over from Main <old>: <why>, so paseo-bm handed the mission over to you in a fresh context. Its chat keeps the earlier conversation; start from the mission state above. In your first reply tell the owner in one line that you took over and what is in flight, from that state."

Settings → Coordination's `handoff.enabled` still governs this path.

### 3.6 A replaced Main

Every Manager tool is refused when its caller is a Main whose binding names an open mission whose current `mainId` is another agent (`replacedMainRefusalOf`, `mission-replace.ts`, checked in `agent-tools.ts`; [ADR-051](../adr/ADR-051-three-owner-decisions-from-the-documentation-review.md) decision 3). The refusal names the current Main: "You were replaced by Main <id> of mission <code>; tell the owner to continue in that Main's chat (the Missions screen opens it)." It ends "Nothing was read." for a reading tool (`MAIN_READ_TOOLS`: `bm_mission`, `bm_decisions`, `bm_repo`, `bm_peers`, and `bm_memory` with `op: read`) and "Nothing was done." for any other, which writes or sends (`MAIN_WRITE_TOOLS`, the rest of the Manager's tools).

A Main of no mission, the mission's current Main, and a caller whose mission cannot be read are not refused by this rule; a Manager of no mission still gets `NOT_A_MAIN_MESSAGE` from the tools that serve only a mission's Main (`missionOfMain`).

## 4. One authority (ADR-033 decision 3, REQ-204, REQ-205)

### 4.1 The resolver

`deciderOf(decision, facts) → { decider; rule; recommend; why; withoutEffects? }` (`shared/authority.ts`, pure). `facts` holds:
- `modeOf(workspaceId, class)`: the repo cell of a class, over the owner's policy;
- `missionOf(requestId)`;
- `missionDelegates(missionId, cell)`.

The `finishedUnverified` fact left the resolver with the unverified-finish guard (ADR-051 decision 1), and review figures on 2026-10-20 (delivery line design §5).

Rules, the first that holds (the code's comments number rows 4–6 as its rules 3–5):

| # | Decision | Decider |
|---|---|---|
| 1 | `ownerOnly`; `o:`; `r:`; `h:`; an `m:` decision; an unknown kind; an option carrying a prepared change | owner |
| 2 | `f:` of a mission request, its class delegated by the repo or `answer-effects` by the mission (the latter permits only options without effects) | main; otherwise a repo-delegated incident stays orchestrator, else owner |
| 3 | retired on 2026-10-20 (review budgets): reviews past a request's cap are one owner-only `review-cap` question, rule 1 (delivery line design §5.4) | — |
| 4 | `q:` of a request of a mission, its class delegated by the repo cell or the mission cell (`answer-technical` / `answer-effects`). When only the mission cell delegates it, the Main decides only when an option leaves no effect (`withoutEffects`), and `bm_answer_worker` refuses an option with effects; when every option has one, the owner decides with the Main recommending (rule `mission-effects`) (delivery line design §7.1) | main (rule `delegated-main`) |
| 5 | `q:` of a request of a mission, repo cell `shadow` | owner, the Main recommending (rule `shadow-main`) |
| 6 | anything else | owner |

A precedent (`resolveAtOpen`) still answers first, at open, wherever it applies today. It is code acting on the owner's own earlier words, so it is not a row of the table.

The resolver is the only place these rules live. Its callers:
- the materialiser at open;
- `bm_answer_worker` (it answers only where the decider is the Main, or records a recommendation where the Main recommends);
- `bm_decide` (rule 2; it keeps its own equivalent refusal, `decideRefusalOf`);
- `missionStateOf` (§2);
- the owner's views, which name "Main" or "paseo-bm" where they decide.

The earlier inline checks, the Main's ten-minute answer window and the review-grant refusal are retired.

### 4.2 The owner always may

The owner answers any unsettled decision at any time, on its card or in a chat; the first answer stands (as today). Rule 4 never hides a card from the owner.

### 4.3 Review budgets

Retired on 2026-10-20 by [ADR-035](../adr/ADR-035-a-delivery-line.md) decision 4. The things that are gone:
- the code and Main caps;
- delegated `untilClean`;
- the `review-budget` question.

A request's reviews converge by themselves under a computed cap, and past the cap paseo-bm asks the owner once ([delivery line design](paseo-bm-delivery-line.md) §5). The Main is not told about reviews: `BM-BUDGET` stays retired (§6.1).

### 4.4 The Main is told at once

When a question opens whose decider is the Main, or one the Main recommends on, `tellMainOfQuestions` sends the Main one channel item (§6.2), a `BM-DELIVERY message` from `plugin`:
- "Q<n> of <request> (<class>, <subject>) is yours to answer within the mission's delegation: <question, ≤ 300>; options <key — label, recommended marked>. Answer with bm_answer_worker; the owner sees your answer and may override it."
- A question the Main recommends on (rules 4 `mission-effects` and 5) reads "… is yours to recommend on: …; options …. Recommend an option with bm_answer_worker; the owner decides."
- Every item ends "bm_mission shows the mission as it stands." (`tellMain`). An `f:` decision for the Main is §4.5.1's.

### 4.5 `bm_answer_worker`

It refuses, before writing anything:
- a question whose decider (§4.1) is not the Main;
- a settled question;
- an unknown option;
- a request outside the caller's mission.

It writes the Main's recommendation with `withMainPrediction`. The same writer attaches a recommendation when `bm_owner_question` refuses a repeat of an open Worker question (delivery line design §7.2).

Under the mission-only delegation it also refuses an option with effects (delivery line design §7.1). The answer is `by: main`, `via: main`, delivered to the Worker as the Main's.

### 4.5.1 The Main resolves fallback (ADR-040)

Requirements: REQ-204 e and [ADR-040](../adr/ADR-040-the-main-resolves-its-requests-fallback.md). This extension covers request fallback authority, notification and answer delivery; provider choice stays in the configured chain.

`bm_answer_fallback { decisionId: f:<incidentId>, option: switch | wait | dismiss, why: 1–300 chars }` is Main-only. It checks that the caller is the current Main, the request belongs to its mission, the resolver names the Main, the decision is open and the option exists, again in the synchronous store transition. It records `by: main`, `via: main`, no grant, and runs the same settlement as the owner's answer; its result reports the stored delivery, a failure included. Other missions, replaced Mains, owner-only or prepared changes, missing delegation, invalid options and settled decisions write nothing.

A new fallback decision reaches the Main through `tellMainOfQuestions` as a durable `message` that names the full decision id, keeps the original request id for retargeting, and ends: "Resolve this fallback now with bm_answer_fallback using this decisionId, an offered option and your reason. Normally switch to the configured candidate; do not ask the owner to confirm again or create a replacement yourself. Check the tool's delivery result and keep following the replacement." On the first Paseo handle after a reload, open pending incidents are reconciled, and a non-dropped outbox message for that decision is not sent twice. Pending outbox delivery follows the current Main. The first answer and the switch locks stand against duplicates. An unresolved fallback blocks the mission row even before a Worker can report. The Main's own fallback keeps its existing authority, and the Orchestrator, through the same resolver, refuses a Main's incident.

The tool and the Main's answer kind are additive; no stored format changes.

### 4.6 The Main asks the owner with a stored decision

A Main tool, `bm_owner_question { question ≤ 1,000, options: [{ label ≤ 200, recommended? }] (2–5, exactly one recommended), class, subject? (≤ 60), ownerOnly?, about? }` (`about`: delivery line design §7.2). It opens an `m:` decision on the Main's mission:
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

`transferRequests(input, deps)` (`server/mission-transfer.ts`), with `input` = `{ from, to, requestIds, reason, by, ref, journal?, tell? }` and the data folder in `deps.home`:
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

A legacy mission is `createdBy: "legacy"`, with goal `""` and exactly one repo (`isLegacyMission`, `server/mission-ownership.ts`). When an owner-created or split mission holds that repo — at creation, when `bm_mission_start` settles, when a repo is added, and once per plugin run for every open mission (`createLegacyMigration`, so missions that already overlap get their card) — the plugin opens one `m:` card on the holding mission (`offerMerges`): "Merge mission <legacy code> (<repo>) into <code>". Its "apply" option carries the new prepared change `mission-merge { missionId, from }`. A pair is asked once: an open card waits, and the owner's "keep as is" stands.

Applying it:
1. transfers every roster request of the legacy mission;
2. closes the legacy mission (`closedAt`, `mergedInto: <missionId>`);
3. labels the legacy Main `bm.replacedBy` with the holding mission's Main and retitles it "· merged into <code>". Nothing is archived (ADR-005).

Refused when a Worker of the legacy mission is running a turn (`busyRequestsOf`, §5.4). The mission record gains the optional `mergedInto`.

### 5.3 Transferring requests to another mission

Moving requests to another mission needs the owner's yes:
1. The source Main records it with `bm_mission_update { transfer: { to: <code>, requestIds, reason } }`; the tool checks it as §5.1 refuses and answers `transferDecisionId`.
2. That opens an `m:` card with the prepared change `mission-transfer { missionId, to, requestIds, reason }` (`offerTransfer`; `missionId` is the source); the same move asked twice is refused while its card is open.
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
| `BM-SETTINGS` "the Manager you report to was replaced" | Workers | none | **removed** for a mission's Main: `replaceMain` tells no Worker (§3.4). The Workers of an unbound Manager replaced by fallback still get it (`fallback-manager.ts`) |
| `BM-BUDGET` | Main | none ("for your information") | **removed** for a mission's Main (§4.3, §6.4); a Manager that is no mission's Main is told as before |
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

The mission page has two parts from this design, built to the owner's approved mockup ([`mockups/mission-runtime.html`](mockups/mission-runtime.html), artboards G and H, 2026-10-10), which is the contract. They are in `client/missions.tsx` (`MainsCard`, `InFlightCard`), from `client/missions-model.ts` (`mainHistoryOf`, `inFlightOf`).
- **Main history**, right under the title row, before the stats (desktop and phone): each Main of `mainHistory` with when and why it changed — "created with the mission", "replaced", "handoff — its context was full; this Main carries on", "fallback — its provider plan stopped it", "you asked" (the phone: the one word) — and "Open" on a previous one (`openAgent`).
- **In flight**, between "Workers by repository" and the Contracts/Journal grid on a desktop, after the stats on a phone. It shows, from `mission.get`'s `inFlight` (the structured `MissionState`):
  - each request with its state words: "working", "waiting for you · Q1", "waiting for the Main · Q2", "waiting for <other work>" (a request id shortened; on a phone, that request's topic), "undelivered", "finished", "stopped";
  - the questions grouped by who decides;
  - "The Main asked you": only the Main's own open `m:` cards (`asks[].byMain`, `recommended`). paseo-bm's cards (governor, merge) stay in the Inbox, and the rendered state names them "paseo-bm's card";
  - live links with how long they have waited.
- **"Answer"** opens the Inbox (`onOpenInbox`), where the card is answered; it is offered for the owner's questions and the Main's asks only.

`mission.get`'s output gains `inFlight: MissionState` and `mainHistory`, both optional for an older reader; neither card shows without them. The lanes, the Waiting part and the repository lines are the delivery line design's (§2.7, §4.9, §19.8).

## 8. Role files

- **`manager.md`:**
  - ask the owner with `bm_owner_question`, and record an answer the owner gives in the Main's chat with its `answered`, not `bm_answers`;
  - answer the questions the plugin names as yours with `bm_answer_worker`, with no time window;
  - a `BM-UPDATES` message holds several known blocks: act on each;
  - the plugin's `BM-` notices each say what to do; a `copy: yes` block is context only: one line at most.

  The file stays within its 100 lines and five limits. The successor's first reply is asked for in its brief (`mainHandoffLineOf`, §3.5), not in the role file.
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

Built in Phases P1–P6 of the [mission runtime plan](../archive/plans/paseo-bm-plan-mission-runtime.md); the isolated-daemon drill is the owner's.

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
| 2026-10-25 | hieu.nt10 (owner's answer; written by Claude) | §3.2: a Main crosses at its window share or `main.contextTokens`, whichever comes first ([ADR-037](../adr/ADR-037-agents-are-given-a-bounded-context.md)) |
| 2026-10-26 | Codex (owner request, ADR-040) | §4.1/§4.5.1: the Main resolves delegated request fallback, receives durable notices and recovers pending incidents; additive tool with negative authority and delivery proof |
| 2026-11-06 | Claude (owner request, ADR-042) | §2.1: the `undelivered` request state |
| 2026-11-10 | Claude (as built, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) Phase 1) | §2.1: `undelivered` ranks below a question waiting for the owner |
| 2026-11-16 | Claude (owner request: documentation review) | Checked against the code. §2.1: the state's real fields, `null` for an unknown mission, the 24-hour rule, `m:` cards only in `asks`, a bound request stays final; §2.2: the section titles and order, the drop order and caps, masking at read, `mainStateLines`; §2.3: where follow-up, report and link lines are written; §3.1: `turnTokensOf` replaces the retired `mainContextOf`; §3.2: the hard figure's floor; §3.4: the paths that end in `replaceMain`; §3.5: `main.compact` off and the real successor line; §3.6: `MAIN_WRITE_TOOLS`, and the read tools refuse a replaced Main; §4.1: the resolver's facts and rule names; §4.4: the recommend text; §4.5.1 condensed; §4.6, §5.1–§5.3: the real inputs; §6.1: two notices removed only for a mission's Main; §7, §8: as built, without history; §11 points to the plan |
| 2026-11-17 | Claude (owner decision, ADR-051) | §3.6: every tool of a replaced Main refuses and names the current Main, a reading tool's refusal ending "Nothing was read."; §4.1: the `finishedUnverified` fact and rule 2's unverified-finish exception retired |
