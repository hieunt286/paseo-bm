# paseo-bm — Calibrated autonomy (Technical Design, Phases 1–6)

| Field | Value |
|---|---|
| Status | **Active** (2026-09-29) — approved by owner hieu.nt10; gate `design-ready` PASS; DQ-1 → DQ-4 answered |
| Living document | Once Active, edited in place with one Revision History line per edit. Each Part becomes Active when its phase starts; a Part may be revised at its phase start from what the previous phase measured |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Requirements source | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) (Accepted 2026-09-29): REQ-110 → REQ-172 |
| Routing decision | [PRD §0](../product/paseo-bm-autonomy-prd.md#0-routing-decision) |
| ADRs | [ADR-017](../adr/ADR-017-decisions-are-stored-objects.md) (Part A) · [ADR-018](../adr/ADR-018-calibrated-autonomy-per-class.md) (Part B) · [ADR-019](../adr/ADR-019-action-boundary-permission-events.md) (Part D, decided by its spike) — ADR-017 and ADR-018 Accepted, ADR-019 Proposed until its spike |
| Related designs | [Evaluation](./paseo-bm-evaluation.md) (Phase 0, Active; metrics every phase exit uses) · [Experience concept](./paseo-bm-experience-concept.md) (Draft; its decisions move into Part A §A.12) · [Base design](./paseo-bm.md), [Dashboard design](./paseo-bm-dashboard.md), [Orchestrator design](./paseo-bm-orchestrator.md) — each section this design replaces is named in §A.14 and edited when its phase lands |
| Reference environment | Paseo 0.9.2, `@getpaseo/plugin` 0.8.0 typings, Node ≥ 22 |

Facts this design relies on were read from the code and the SDK on 2026-09-29 (three read-only surveys: the question/answer and command flows, the client structure, agent creation and permissions). Where a fact is not verified on a live daemon it is marked **(verify)** and the first work package of its phase verifies it.

## 0. Principles (from the PRD §3) and what they mean in code

1. **Artifacts, not conversation.** A handoff is a typed record with one identity; chat text is a view of it.
2. **Workflow before agent.** Routing, ordering, deduplication, limits, authority are code. A model is woken only for judgement.
3. **Control matches risk** through declared effects, the owner's policy and one-use grants — never through prose patterns alone.
4. **Measure before promoting.** Every phase exit runs the evaluation suite (Evaluation design §6) and the replay.
5. **Delete what is superseded** in the same phase (§A.14, and each Part's retirement list).

**One idea carries Parts A and B: agents keep writing typed blocks with side-effect-free tools (ADR-010), and the plugin materialises state from those blocks at the end of the turn that wrote them** — keyed idempotently, because Paseo reuses turn ids. The Orchestrator, whose endpoint knows its caller (the secret path), writes state directly. This keeps caller identity out of the Worker, Manager and Reviewer tools.

---

## Part A — Phase 1 MVP: one source of truth for decisions and handoffs

### A.1 Scope

Owns: the decision model and store; materialising decisions from blocks; answering and delivering; the Orchestrator's decision tools, prepared actions and grants; typed commands (`BM-COMMAND` v2) and authority from declared effects; fallback incidents as decisions; the event bus to the Orchestrator and the Inbox's alerts; bounded coordinator context; capability limits per role; the rewritten role instructions; the new management surface and card system; the Phase 1 retirement.

Does not own: decision classes, policy and delegation (Part B); evidence classification (Part C); holding actions before they run (Part D).

### A.2 Architecture

```
 Worker ── bm_report(blocked, questions+effects) ──► BM-REPORT + BM-QUESTIONS ── send_agent_prompt ──► Manager
                                                             │ Manager turn_ended
 Manager ── bm_answers after the owner's typed message ──────┤ (collector → decision materialiser)
 Owner types in a Worker's chat ─────────────────────────────┤ Worker turn_ended
 Fallback incident (usage limit, login, …) ──────────────────┤
 Orchestrator ── bm_ask_owner / bm_decisions (secret endpoint)┤ direct write
                                                             ▼
                              decisions store  <data>/decisions/<workspaceId>.json
                  ▲ decisions.answer (Inbox, chat cards)     │ delivery by the plugin (notice queue):
                  │                                          │   answers → Worker · prepared action → Manager/Worker/fallback
 Inbox · Work · chat cards (renderer) ◄── decisions.list/get ┘   · owner's words → Orchestrator (with a grant)
                                                             │
 events: decision.opened · request.finished · request.stalled · worker.signal
        └─► event bus ──► Orchestrator (one batched message per idle moment) · Inbox alerts
```

### A.3 The decision model

`plugin/shared/decisions.ts` (zod, shared by server and client):

| Field | Meaning |
|---|---|
| `id` | Deterministic key: `q:<requestId>:<Qn>` (Worker question), `o:<uuid>` (Orchestrator), `f:<incidentId>` (fallback) |
| `workspaceId`, `requestId` | `requestId` null only for fallback incidents outside a request and Orchestrator decisions about a whole project (a Worker question always has one) |
| `askedBy` | `{ role: worker \| orchestrator \| plugin, agentId \| null }` |
| `askedAt`, `round` | first-seen time; the Worker's report round (for grouping on one card) |
| `question`, `subject` | text (≤ 1,000); `subject` a short slug the asker gives (used by supersession now, by precedents in Part B) |
| `options[]` | `{ key, label, recommended, effects: Effect[], action?: PreparedAction }`; one recommended at most |
| `effects` | `none, commit, push, publish, deploy, real-data, migration, dependency-install, network, outside-workspace, security, cost` — declared by the asker per option |
| `status` | `open → answered \| superseded \| withdrawn \| expired`; `open → needs-confirmation` when an owner message in a chat may have answered it (A.5 c) |
| `answer` | `{ by: owner, via: inbox \| chat-card \| chat-manager \| chat-worker \| chat-orchestrator, optionKey \| words, at }` |
| `grant` | `{ effects, expiresAt, usedAt \| null }` — REQ-112 (b) |
| `delivery` | `{ to, kind, at, outcome: sent \| queued \| failed }` |
| `supersedes`, `supersededBy` | ids |

Rules: a Worker question may re-ask with `supersedes: "Q3"` (new optional field of the `bm_report` question schema) or with the same normalised text → the old one becomes `superseded`. An Orchestrator decision supersedes the open Orchestrator decision of the same request unless it passes `separate: true`. A superseded, withdrawn or expired decision is never answerable; the tool that caused it returns the id it replaced.

`PreparedAction` is a union: `answer-worker` (implicit for Worker questions: deliver the answer), `command { to: manager | worker, agentId, intent, body, effects }` (Orchestrator decisions; P5), `fallback { action: switch | wait | resend | dismiss, target }` (fallback incidents).

Two bookkeeping fields complete the record: `settledAt` (set exactly when the status is final) and `needsConfirmation { via: chat-manager | chat-worker | chat-orchestrator, at }` (set exactly while `needs-confirmation`). The transitions are pure functions in the same module (`answerDecision`, `markNeedsConfirmation`, `confirmDecision`, `supersedeDecision`, `withdrawDecision`, `expireDecision`, `useGrant`); each returns the next record or a refusal and never reads a clock. An answer grants the chosen option's effects, or every effect the decision declares for own words (`none` never granted; nothing to grant → no grant). A chat answer the owner confirms (`decisions.confirm`) records no option, no words and no grant, because the plugin never read what was authorised.

### A.4 The store

`plugin/server/decision-store.ts`: `<data>/decisions/<workspaceId>.json` = `{ version: 1, entries: Decision[] }`, `0600` files in a `0700` folder, atomic writes, the same lock and no-symlink rules as `orchestrator-store.ts`. Open decisions are never evicted; settled ones keep the newest 500 per workspace. A malformed entry is skipped alone. `decisions.list` reads every workspace file with an mtime cache. Cleanup deletes the folder; deleting a request's traces deletes its settled decisions. Like `orchestrator-store.ts`, the store takes no lock: every operation is synchronous in the one plugin-server thread, so a read-modify-write cannot interleave. Opening is idempotent by id, and a `supersedes` naming an unsettled decision of the workspace supersedes it in the same write. A file with a newer `version` reads as empty and is never written.

### A.5 Materialisation (`plugin/server/decision-materialiser.ts`, on the collector's `onRecorded`)

The `BM-QUESTIONS` block carries the new fields as optional bracketed tags, so the text stays readable and older blocks still parse (each tag is optional; an unknown tag is ignored):

```
BM-QUESTIONS
requestId: req-20260929T073348Z
Q4: Push both backends to origin/dev? [subject: push-backends] [supersedes: Q2]
- a: Push contract only (recommended) [effects: push]
- b: Push both, manifest by hand [effects: push]
- c: Hold
```

`bm_report` gains the matching optional fields (`subject` ≤ 60 characters `[a-z0-9-]`, `supersedes` a `Qn` of the same request, `effects` per option from §A.3's list) and writes the tags; `parseQuestions` reads them; `bm-format.ts` accepts them.

a. **Open** — at a Manager's turn end, each `BM-QUESTIONS` in an inbound message that is not the owner's (today's `qa-ledger.questionsIn` logic, moved) opens `q:<requestId>:<Qn>` if absent; re-reading the same turn (reused turn ids) changes nothing.
b. **Answer through the Manager** — at a Manager's turn end whose inbound messages include the owner's typed message (`origin: "user"`), each `BM-ANSWERS` block the Manager wrote in its reply (built with `bm_answers`) settles those decisions with `via: chat-manager`. The Manager no longer sends answers to the Worker; the plugin delivers (A.6).
c. **Answer in a Worker's chat** — at a Worker's turn end, an owner-typed message holding a `BM-ANSWERS` block settles the named questions (`via: chat-worker`); any other owner text in that Worker's chat while decisions of its request are open marks them `needs-confirmation`: the Inbox asks "Answered in the Worker's chat? · Close · Keep open".
d. **Fallback** — each pending incident of `role-fallback-state.json` opens `f:<incidentId>` with the options the fallback card offers today (switch, wait, resend, dismiss) as prepared actions; resolving the incident any other way withdraws it.

Detail as built for a–c (`server/decision-materialiser.ts`):
- The collector hands `onRecorded` the record it just wrote (texts already masked); a–c read that record's `sent` (with `origin`) and `received`, never the store back. The block readers are the ledger's (`readableOf`, `questionBlockOf`, `answerBlockOf`), moved here; `qa-ledger.ts` calls them until it is retired.
- Open: `askedBy.agentId` is the live Worker labelled `bm.requestId = <requestId>` (the Manager's child first, else the only one of the workspace), null when not known for certain. A block's questions share one round: the stored round of any of them, else the request's highest round plus one. `askedAt` is the carrying message's time. A `[supersedes: Qn]` tag links only a question that is stored; the text match (case, punctuation and spacing ignored) replaces only an unsettled question.
- Answer lines: a leading option letter (`a — …`, `(a) …`, `a: …`, a bare `a`) is the option when the decision has it; otherwise the line, without an `other —` prefix, is the owner's words. The answer's time (and so the grant's hour) is the owner's message time — the last owner message of a Manager turn. A Manager's replies are read one by one and joined, so a streamed block still reads.
- `needs-confirmation` applies to the open `q:` decisions of the Worker's request (the record's `requestId`) and is remembered by owner message (agent, time, text) for the plugin run, so re-reading a record never re-marks a question the owner kept open.
- The decisions a turn answered go to the same `onSettled` hook as `decisions.answer` (`settledByKind` in `index.server.ts`), which the delivery (A.6) completes.

### A.6 Answering and delivery

RPCs (`plugin/shared/contracts.ts`, additive; handlers in `plugin/server/decision-rpc.ts`): `decisions.list { scope: inbox | workspace | request, workspaceId?, requestId?, status?, limit? }` → `{ decisions, truncated }` (`inbox`: unsettled decisions of every workspace or of `workspaceId`, oldest asked first; `workspace` and `request`: every stored one, newest asked first; `limit` ≤ 500, default 200; no usable data folder reads as none), `decisions.get { id }` → `{ decision }`, `decisions.answer { id, optionKey?, words?, confirmed?, via?: inbox | chat-card }` → `{ decision }`, `decisions.confirm { id, answered: boolean }` → `{ decision }`. An answer that would grant `push`, `publish`, `deploy`, `real-data`, `migration`, `security` or `cost` needs `confirmed: true` (experience concept X-4: release, data, security, cost). Error codes: `E_DECISION_NOT_FOUND`, `E_DECISION_SETTLED` (answered, superseded — the message names the replacing id —, withdrawn or expired), `E_DECISION_ANSWER_INVALID` (not exactly one of `optionKey`/`words`, blank words, unknown option), `E_DECISION_NOT_CONFIRMED`, `E_DECISION_NOT_NEEDS_CONFIRMATION` (`confirm` on a decision not waiting for one), `E_DECISION_WRITE_FAILED`, and `E_DATA_HOME_UNAVAILABLE`; every refusal writes nothing. After the answer and grant are stored, the handler hands the settled decision to an injectable `onSettled(decisions, { paseo })` hook — the delivery below; a failing hook is logged and never fails the answer. The client polls an open decision every 5 s while shown (REQ-111 b); a settled one stops polling.

Delivery, by the plugin through the notice queue:
- **Worker question (DQ-2, owner 2026-09-29: answers go to the Worker at once, coordination is proactive):** each answer is delivered as soon as it is given — at the Worker's next idle moment, one `BM-ANSWERS` block holding every settled, undelivered question of that request (kind `answers:<requestId>`, so a newer block replaces an unsent older one); questions still open stay open and the Worker carries on with what it has. No **Send** button, no waiting for the whole round.
- **Orchestrator decision with a prepared command:** the `BM-COMMAND` v2 (A.7) goes to its target with `authority: owner (decision <id>)` and `approved: <the option's effects>` — the owner's choice needs no further gate.
- **Orchestrator decision answered in words:** a `BM-ANSWER` block (`decisionId`, the words, the grant) goes to the Orchestrator; the grant allows exactly the decision's declared effects for one command within 60 minutes.
- **Fallback:** `fallback.act` with the prepared action.

Detail as built for Worker questions (`server/decision-delivery.ts`, wired as the `question` kind of `settledByKind` and as the materialiser's `afterTurn`):
- The message is `Continue <requestId>.`, a blank line, then `answersText` over every answered `q:` decision of the request whose `delivery` is null or `queued`, in question order (`Qn: a — <label>`, `Qn: other — <words>`). Target: the request's sole live Worker of the workspace (`soleWorkerOf` over the agents' labels, fallback-replaced Workers left out); none or several → every included decision is recorded `failed` (to the asking Worker) and nothing is sent. A queue `dropped` (archived, closed, gone, send failed) is `failed` too; a `failed` delivery is never retried.
- Recorded per included decision: `sent` (the Worker was idle), `queued` (held for its turn end). A `queued` decision becomes `sent` when a Worker's turn record carries an answers block naming it (the block arrived), or when this run's queue no longer holds its `answers:<requestId>` notice; it is then left out of the next block.
- An answer given in the Worker's own chat (`via: chat-worker`, including a confirmed chat answer) is not sent: it is recorded `sent` at the answer's time. Without a Paseo handle or data folder nothing is recorded and a later trigger delivers it.
- Once per plugin run — at the first settlement or recorded Manager or Worker turn with a Paseo handle, after that turn's arrivals are noted — every answered `q:` decision whose delivery is null or `queued` is delivered again, one block per request. A `queued` block sent just before a reload can therefore reach the Worker twice; an answer is never lost. One delivery runs per request at a time; a settlement meanwhile makes it look once more.

Detail as built for the Orchestrator's decisions (`server/orchestrator-tools.ts` `bm_ask_owner`, `server/orchestrator-decisions.ts`, wired as the `orchestrator` kind of `settledByKind`):
- `bm_ask_owner { workspaceId, requestId?, managerId?, question, recommendation, options?[≤ 5]{ label, effects[], recommended?, command?{ to: manager | worker, agentId, intent, body } }, subject?, separate? }` stores `o:<uuid>` with keys `a`–`e`; the stored question is the question, a blank line and `Recommendation: …` (≤ 1,000 in all); at most one option is recommended; an option's `effects` are also its command's. A prepared command is checked as it will be sent: its target is a live, non-archived paseo-bm agent of that role in the project (never a Reviewer), the block can be written, and the backstop finds no category in the option's label and body that its effects do not declare. Supersession: the Orchestrator's unsettled `o:` decision of the same request (or, both without one, of the same project) — the newest of the same `subject` when there is one, else the newest; the answer returns `{ decisionId, replaced }`, `replaced` only when the store did supersede one.
- Prepared command chosen: `BM-COMMAND` v2 `from: orchestrator` (it prepared it), `via: tab` (the owner's tap), `re:` the option's label, `why: The owner chose "<label>" on decision <id>.`, `authority: decision:<id>`, `approved:` the option's effects the answer granted, `limits:` derived. Queue kind `command:<id>`; a Worker's Manager gets the `copy: yes` block. The target is re-checked at delivery; the grant is claimed and spent as `bm_send_command` spends it (`claimGrant`, `spendGrant`: only once delivered). A command that cannot be delivered spends nothing, is recorded `failed`, and the Orchestrator gets the `BM-ANSWER` with a `delivery:` line saying why, so it can act on the unused grant.
- `BM-ANSWER` (a plugin notice, matched as a whole word so the owner's `BM-ANSWERS` never is): `decisionId`, `workspaceId`, `requestId` (or `none`), the question's first line, `answer:` (`option <key>: <label>`, or the owner's words after the header), `grant: <effects>, for one command with decisionId <id>, until <expiresAt>` (or `none`), then one instruction line. Queue kind `answer:<id>`, to the current main Orchestrator; with none open it is recorded `failed` and the Orchestrator reads it later with `bm_decisions`. An option without a command gets the same notice.
- Each decision is delivered once (a recorded `delivery` is never repeated); a confirmed chat answer (no option, no words) delivers nothing. The old tab's `orchestrator.ask { decisionId }` still answers the Orchestrator-store decisions recorded before this build, until the retirement sweep (A.14); new decisions are not on the tab.

### A.7 Typed commands and authority (`BM-COMMAND` v2)

Header lines added: `intent: answer | continue | redirect | stop | release | other`, `effects: <list or none>`, `authority: owner | decision:<id> | autopilot` (Phase 2 adds `policy:<class>`), `approved: <effects the authority covers>`. `limits:` is derived: the fixed limits (no commit/push/deploy, no real data) minus what `approved` covers — a delivered command never carries a limit that contradicts its approval. The parser reads v1 blocks (no `intent`) as before.

Authority check for `bm_send_command` / `bm_direct_worker` (replaces the gate as the authority): every declared effect must be covered by a live grant (`decisionId` input), or by Autopilot for effects outside `release, real-data, migration, security, cost` (Phase 1 keeps Autopilot until Part B replaces it). The regex gate (`decision-gate.ts`) stays as a **backstop**: a category it finds that the declared effects do not include refuses the command with "declare the effect or ask the owner" — never a silent send.

Detail as built (`shared/orchestrator-command.ts`, `server/orchestrator-tools.ts`):
- Header order after `re:`: `intent`, `effects`, `authority`, `approved`, then `limits` (only `from: orchestrator`). `effects`/`approved` list real effects in `EFFECTS` order, or `none`. A fixed limit that is partly approved is split into `no-<effect>` for what it still withholds (`approved: push` → `limits: no-commit, no-deploy, no-real-data`); the parser refuses a v2 block whose limits withhold an approved effect, or that carries only some of the four v2 fields.
- Both tools require `intent` and `effects` (`["none"]` for none). The decision-only effects are `CONFIRM_EFFECTS` (push, publish, deploy, real-data, migration, security, cost). Without `decisionId`: Autopilot (`authority: autopilot`), else the owner's own latest word in the Orchestrator's chat (`authority: owner`, `via: chat`) — both cover every effect except those. With `decisionId`: it must name an `o:` decision of the project that the owner answered and, when it has a request, the same request; the grant (`grantRefusal`) must cover every declared effect. It needs neither Autopilot nor the chat word (`via` is `autopilot` when Autopilot is on, else `chat`). A decision that granted nothing authorises only a command that declares no effect.
- The grant is spent (`useGrant` through the store's `transition`) only after the command is delivered; an in-memory claim keeps two concurrent calls from spending one grant. A delivery that fails spends nothing.
- No tab sends commands any more (§A.14): an option the owner picks on an `o:` decision delivers its prepared command as v2 `via: tab` with `authority: decision:<id>`; `from: owner` is only read from older builds. The owner's allowed categories and the stop-word exemption still silence the backstop until Phase 2 and cover no effect; the fixed limits stay only as the base the `limits:` line is derived from.

### A.8 Events to the Orchestrator and the Inbox

`plugin/server/event-bus.ts` replaces `BM-STALL`, `BM-EVENT` and the `autopilot-on` prompt with typed events: `decision.opened` (Autopilot projects only, until Part B), `request.finished` (Autopilot projects), `request.stalled` (no Worker or Reviewer of an unfinished request running for 5 min; a review over budget), `worker.signal` (the live watch's signals). `waiting-user` and `manager-turn` are dropped: a question now waits in the Inbox, and the Manager relays nothing.

Open alerts live in `<data>/inbox/alerts.json` (`{ version: 1, entries: { <key>: { workspaceId, kind, subject, since, clearedAt } } }`, same file rules as the decision store): raised once per key, cleared when the condition ends (an agent runs again, the permission is answered, the Worker's turn ends); this replaces the stall and signal keys of `orchestrator/stalls.json`.

Delivery: to the Orchestrator, all events pending at its idle moment go as **one** `BM-EVENTS` message (the notice queue gains a batch kind), each event one short line with the ids to look up; an event is dropped when its subject settled before delivery. To the owner: `request.stalled` and the `permission`, `danger`, `stuck` signals are **Inbox alerts** — never messages.

Detail as built (`server/event-bus.ts`, `server/alert-store.ts`, `shared/alerts.ts`; `server/stall-watcher.ts` and `server/worker-watch.ts` as its sources):
- **Scope.** Every event is published only for a project with Autopilot on and dropped at delivery when Autopilot was turned off meanwhile — outside Autopilot the Orchestrator acts only when the owner talks to it, and what needs the owner is in the Inbox. `decision.opened` comes from the `q:` decisions the materialiser opened in the recorded turn (an `o:` decision is the Orchestrator's own; an `f:` one only the owner answers); `request.finished` from each `finished` report of a recorded Manager turn; both from one `onRecorded` call, so they reach the Orchestrator together.
- **Only a judgement wakes** (REQ-115 b, as built after the Phase 1 live check measured 3 of 3 wakes with no action): a `q:` decision with an option carrying a `CONFIRM_EFFECTS` effect is the owner's alone (X-4) and raises no `decision.opened`; a `finished` report raises `request.finished` only when it shows work left — ready beads, open review findings, blockers, or failing checks (`workLeftOf`). Phase 3 (C.3) adds `finished-unverified` to what counts as work left.
- **Dedupe keys.** `decision.opened:<id>`, `request.finished:<ws>:<requestId>@<report time>`, `request.stalled:<ws>:<requestKey>@<alert since>`, `worker.signal:<ws>:<worker>:<signal>@<alert since, or the turn start>`; a key is published once per plugin run. Across reloads the sources dedupe themselves (a decision opens once, an alert is raised once, a turn is recorded once); only `failing`, `heavy` and `outside` may be told once more after a reload mid-turn.
- **Settled** (dropped at delivery): a decision no longer open or needs-confirmation; a stall or signal whose alert was cleared; a `failing`/`heavy`/`outside` signal whose Worker's turn ended.
- **Batch kind.** `enqueueBatch(target, { name: "BM-EVENTS", compose }, items)`: the items of one call are queued, then delivered once; at the target's idle moment every pending item of that batch goes as one message, oldest first, each item's `isCurrent()` read synchronously right after the idle read. A batch counts as one notice (the queue's one-per-idle-moment rule), and a batch whose every item settled sends nothing and lets the next notice go.
- **Stall pass.** Always on (no switch), every project with activity in 24 hours: `idle-unfinished` (5 minutes, the last report neither `finished` nor `blocked`) and `review-over-budget`; a `blocked` request is not stalled (its question waits in the Inbox), a malformed report alone is no stall. One `request-stalled` alert per request (subject the request key, `detail` the reasons); `orchestrator.state` reads it as a project's `stalled` state.
- **Worker watch.** Unchanged scope (running Workers of Autopilot projects, every 2 minutes). `stuck`, `permission` and `danger` raise the Worker's `stuck`, `permission-waiting`, `danger` alert (subject the Worker id, `detail` the redacted evidence, ≤ 300 characters); the pass that raises it publishes the event, a newly raised `danger` opens the interrupt allowance (still in `orchestrator/stalls.json`, its one remaining key). `stuck` and `permission` clear when no longer seen; all three at the Worker's recorded turn end, when it stops running, or when its project leaves Autopilot.
- **Alerts file.** `<data>/inbox/alerts.json`, key `<kind>:<workspaceId or ->:<subject>`, optional `detail`; the cleanup button deletes `inbox/`. Open alerts are never evicted, cleared ones keep the newest 500. Other producers: `pairing-mismatch` (`role-pairing.ts`, through `raiseInboxAlert`), `fallback-failed` (an answered `f:` decision whose `delivery.outcome` is `failed` while its incident is pending; cleared once the incident is not). `outdated-agent` (`outdated-agents.ts`, §A.11): one per live Manager, Worker or Reviewer on older instructions, cleared once it is current, replaced, archived, closed or gone.
- **Wakes recorded.** Each delivered `BM-EVENTS` message is one wake in `orchestrator/wakes.json` (the notice queue's batch `onSent`: Orchestrator id, time, projects, number of events); the Orchestrator's next turn end (the batch's `onTurnEnded`, called by the queue at that turn end before it delivers anything else) sets `endedAt` on its oldest open wake. Ids, times and a count only; the evaluation's A-7 reads it (evaluation design §4).
- **Retired.** `BM-STALL` and `BM-EVENT` (producers and notice prefixes), `server/autopilot-events.ts` (`question`, `finished`, `manager-turn`, `autopilot-on`), the Watch switch (the settings file no longer has `watch`; its RPC went with the sweep, §A.14), the stall, event and Worker-signal keys of `orchestrator/stalls.json` (ignored, dropped at the next write). Measured on a synthetic day in `test/event-bus.test.ts`: 160 events, 119 wakes, none without a pending event.

### A.9 Bounded context

Orchestrator tools return typed summaries by default: `bm_request` ≤ 4,000 characters (`detail: "full"` keeps today's 60,000), `bm_agent_messages` 5 messages of ≤ 1,500 characters (`detail: "full"` keeps 50 × 12,000), `bm_projects` counts and open decisions only. A new read tool `bm_decisions { workspaceId?, requestId?, status? }` lists decisions. The Manager gets a read-only `bm_decisions` face too (its block tools stay side-effect free: it reads decisions by `requestId`).

Detail as built (`server/decision-tools.ts`): `bm_decisions` returns `{ decisions, total, truncated }`, newest asked first, each redacted with the owner's words cut to 1,000 characters and a prepared action as one line; `status` also takes `unsettled` (open or needs-confirmation), `limit` 1–50 (default 20). The Orchestrator's face (in its endpoint) includes each grant; the Manager's (`MANAGER_SERVER_TOOLS`, `{ requestId, status? }`, served at `/mcp/manager` and pre-approved after `bm_answers`) reads that request's decisions of every project, at most 50, without grants, through the store's read path only (nothing is created or repaired). `bm_projects` lists each project's unsettled decisions of every kind from the store, oldest first, at most 10, with `counts.openDecisions` the total.

### A.10 Capability limits per role (REQ-116)

Today (read from the owner's config, 2026-09-29): `bm-manager` and `bm-worker` carry `paseoTools.enabled: true`; **`bm-reviewer` and `bm-orchestrator` carry no `paseoTools` key**, and Paseo 0.9.2 treats an absent policy as enabled while `mcp.injectIntoAgents` is on — so the Reviewer and the Orchestrator probably have every Paseo tool, including `create_agent`, `kill_agent`, `archive_agent`, `respond_to_permission`, `set_agent_mode` and `update_agent`. **Verified 2026-09-29** on an isolated Paseo 0.9.2 daemon ([run note](../archive/operations/paseo-bm-role-tools-run-20260929.md)): an alias with no policy gives its agent all 39 Paseo tools, and the target below leaves the Reviewer and the Orchestrator with none, and the Manager and the Worker with all the rest except their `disabledTools`. Paseo resolves the policy each time a session opens (create, resume, refresh), so an existing agent picks up the policy when its session is next opened (run note F1).

Target, written by `config-writer.ts` for every `bm-*` alias (and fallback alias):

| Role | `paseoTools` |
|---|---|
| Reviewer, Orchestrator | `{ enabled: false }` |
| Manager | `{ enabled: true, disabledTools: [kill_agent, archive_agent, archive_workspace, respond_to_permission, list_pending_permissions, set_agent_mode, update_agent, create_schedule, update_schedule, delete_schedule, run_schedule_once, pause_schedule, resume_schedule, create_heartbeat, delete_heartbeat] }` |
| Worker | the Manager's list plus `create_workspace`, `rename_workspace` |

Role pairing (only the Manager creates Workers, only a Worker creates Reviewers): verified 2026-09-29 (run note `docs/archive/operations/paseo-bm-role-pairing-run-20260929.md`) — a throw from `before("agent.create")` would reach `create_agent` cleanly, but the hook's request carries no creator id, so it cannot refuse. The `agent.created` handler (`role-pairing.ts`, wired in `agent-labels.ts`) reads `parentAgentId`, judges the creator by its **provider** (not its label, which can change), and on a mismatch calls `raiseRolePairingAlert`: an Inbox alert once the event bus passes the alerts store as `raiseAlert`, one log line until then. An agent with no creator agent (from the app, or the plugin's own Manager, Orchestrator and assessment agent) is outside the rule. Paseo re-reads the policy at every session open, so existing agents get the limits at their next resume ([ADR-020](../adr/ADR-020-paseo-tools-policy-per-role.md)).

### A.11 Role instructions rewritten (REQ-117)

Each file is rewritten from zero, within a budget, and says nothing the plugin enforces:

| Role | Budget | Keeps | Drops |
|---|---|---|---|
| Manager | ≤ 120 lines | intake; one Worker per request; **the project's context** in each brief (owner goals, precedents, related requests — REQ-117 c); **alignment check** of plan and result against the owner's goals, raised as a decision (d); read-only answers | answer letters, relays of questions/answers/reports (e), `BM-ANSWERED`, the long notice list |
| Worker | ≤ 250 lines | sizing, beads, proof, asking only the four kinds, effects per option, `subject`/`supersedes` | report formatting prose (the tool owns it), relay assumptions |
| Reviewer | ≤ 120 lines | review against the request, blocking vs not, one result | anything about other agents |
| Orchestrator | ≤ 100 lines | decide what reaches it, verify before acting, declare effects, ask with prepared actions, Situation/Done/Needs you | proposals, `BM-STALL`/`BM-EVENT` catalogue, gate folklore |

Detail as built (WP-107): 120 / 249 / 120 / 100 lines, with 5 / 5 / 4 / 3 limits in `## RULES`. The Manager's brief carries a **Context** part (the owner's goals and earlier decisions that bear on the request, the related requests); it checks alignment at `received`, `beads-done` and `finished` and raises a misalignment in its own reply as one question with options and a recommendation; when the owner answers in its chat it writes `BM-ANSWERS` with `bm_answers` in that reply and sends the Worker nothing. The Worker declares `subject` and per-option `effects`, re-asks with `supersedes`, and reads answers from `BM-DELIVERY answers`; an option the owner chose, or a `BM-COMMAND`'s `approved:` line, is its yes for exactly those effects. The Orchestrator reads `BM-EVENTS` and `BM-ANSWER`, and its first prompt no longer names `bm_propose_command`. The fallback `BM-REPORT`, `BM-QUESTIONS` (with tags), `BM-ANSWERS` and `BM-REVIEW` blocks stay as the degraded mode (REQ-113 c). Every old rule's destination: [run note](../archive/operations/paseo-bm-roles-rewrite-20260929.md); `test/roles-content.test.ts` pins budgets, duties and the absence of the retired mechanisms.

Older agents (PRD §11 rule 3, as built): every agent carries `bm.instructions=<first 12 hex of the SHA-256 of its role text>` (`instructions-label.ts`; the role file only, so Additional instructions and Runtime facts never make an agent outdated) — the Manager from `createManager`, every other agent from `agent.created` through `paseo agent update --label` (skipped when the snapshot's system prompt lacks the role text; the load-time label scan never adds it). An agent whose label is missing or different is **outdated**: a throttled pass (at most once a minute, started by `inbox.alerts` and `agent.turn_started`, neither waiting for it) lists every agent and raises one `outdated-agent` alert per live outdated Manager, Worker or Reviewer — not the Orchestrator, which replaces itself (Orchestrator design §3.3), not an agent marked `bm.replacedBy`, and not one created in the last 5 minutes still without the label — and clears the rest; `agent.archived` clears that agent's alert at once. The alert carries the agent's `role`; on a Manager's alert the Inbox offers **Replace Manager**, which calls `manager.ensure { workspaceId, replaceOutdated: true }` and opens the Manager it returns: a current Manager is returned as it is; an outdated one gets a new Manager created as when there is none, is marked `bm.replacedBy=<new id>` and its alert cleared, and is never archived (ADR-005); `replacedManagerId` names it. Workers and Reviewers are only flagged: they end with their request.

### A.12 Management surface and cards (REQ-118)

From the experience concept, with the SDK's limits:

- **One surface** (`beads-manager`) opens on **Inbox**; a segmented control switches **Inbox · Work · Insights · Settings**. Command Center items and the workspace Beads tab open it on a project through the existing one-shot slot pattern (`client/slot.ts`), since a surface takes no parameter.
- **No badge (DQ-3, owner 2026-09-29):** the SDK has no badge on a sidebar item and the owner dropped it; what needs the owner is handled in the **Inbox**, which is where Beads Manager opens, with its count in the Inbox tab's own label.
- **Inbox:** Needs you (open decisions by project, oldest first), Decided for you (Part B; empty in Phase 1), Alerts. Cards reuse the chat card components, outside the timeline as the pills do today.
  - *As built (WP-108 i, renamed by the sweep):* `client/launcher.tsx` is the section router over the views of `client/surface-view.ts` — `inbox` (home), `work`, `project-requests` and `project-beads` (a project's page opened on that tab, ← "Back to Work"), `insights`, `settings` — the tabs drawn with `StatusTabs` above every view. `client/inbox-model.ts` (pure) and `client/inbox.tsx`: `decisions.list {scope: inbox}`, `inbox.alerts` and `fallback.incidents` are read every 5 s only while the Inbox shows (the last read keeps the tab's count elsewhere); each list read is written into every decision's query, so the Inbox's `DecisionCard`s (`via: "inbox"`, `poll: false`) read nothing themselves. Groups are ordered by their oldest question; a decision settled on an Inbox card stays in place, settled, until the Inbox is left, and a settled `f:` decision shows what became of its incident (a new Manager/Worker/Reviewer running, with **Open**; waiting; dismissed; failed). A switched Reviewer whose replacement never appeared is **Resend to Worker** (`fallback.act resend`), under its card or, within 24 h of the switch, in Alerts. Alerts: `ALERT_KINDS` order, oldest first, one line (what · project · time), detail and ids on a tap, **Open Worker/agent** or **Open project** where the host's `navigation` allows. The tab's count is unsettled decisions plus alerts. `inbox.alerts` (`server/inbox-rpc.ts`) returns the open alerts, at most 200 (`truncated`). The Command Center item **Open Beads Inbox** (global) opens the surface on the Inbox through the `sectionRequests` slot; **Open Beads project** (workspace, id `open-beads-project`) opens that workspace's project page on Requests through `projectRequests`. The workspace Beads tab cannot open the surface (a workspace panel has no `openSurface`), so it draws the project page itself (below).
  - *As built (sweep, WP-110):* the Inbox's first line is the **Orchestrator line** (`client/orchestrator-line.tsx`, `orchestratorLineView`): `orchestrator.state` read once when the Inbox shows (Work's rows read the same query); **Start the Orchestrator…** shows `orchestrator.open-preview` in the Open dialog (Cancel first) and only its confirm calls `orchestrator.open {confirmed}`; **Orchestrator chat ▸** opens a current one; **Start a new Orchestrator…** (the recreate dialog, `recreate: true`) when it lost its tools or is outdated, with the reason; the "New Orchestrator since …" line while an older one is still listed. Without this line the retired tab left no way to start the Orchestrator. Its first prompt now starts "The user opened you from the Inbox of Beads Manager (paseo-bm)."; every version's first prompt is recognised by its start, "The user opened you from ".
- **Work:** project rows (running dot, stage, agents), project page with Requests (stage bar Received ▸ Plan ▸ Build ▸ Review ▸ Done, evidence lines, a timeline of typed events), Beads (the board: In progress · Ready · Blocked, Closed hidden by default), Agents (the tree view).
  - *As built (WP-108 ii):* `client/work-model.ts` (pure) and `client/work.tsx`. Rows: `workspaces.list` order, the running dot (`workspaces.overview`), and the stage, current request and M/W/R agents from `orchestrator.state` (read every 10 s only while the list shows); its coarse stage is refined by `workPhase` (the phase of the newest request's last Worker report that names a stage, `blocked` skipped), so a row tells Plan from Build with the same mapping as the project page and keeps the reported stage while waiting. A row opens the project page (view `project-requests`; ← "Back to Work"). Requests: `traces.list` rows merged per trace; the stage from the Worker's reports (`received`/`documents-done` → Plan, `beads-done`/`bead-implemented` → Build, `finished` or a completed trace → Done, a review asked after the last report or a running Reviewer → Review, `blocked` keeps the stage and marks it waiting); evidence lines from the reports (plan, closed with the checks the report named, last verdict, decisions open); the timeline (`traces.get` when opened, `decisions.list {scope: workspace}`) newest first — asked, handed over, report milestones, review asked, verdicts, the owner's messages, Manager replies, decisions asked/answered (with the grant)/closed; a report without a milestone, a review without a verdict and an event without a readable time are not drawn; ids only under Details, with what each agent ran on and the tokens per model (REQ-058, kept from the retired request graph by the sweep). Beads: the board first, filters folded, Closed hidden by default; the overview figures are `BeadsOverviewSection` for Insights. Agents: the tree without the role configuration.
  - *As built (sweep, WP-110):* the workspace **Beads tab** (panel `bm-beads`, and its header button) is the workspace's project page — `ProjectPage` with no title and no ←, opened on Beads — so the surface and the tab share Work's queries. **History actions** (owner's delegation, 2026-09-29: kept, moved from the retired Metric screen): a request's Details offer **Delete this request's history**, and the Requests tab of a closed workspace (a "Closed workspaces with history" row: archived, or no longer in Paseo) starts with a **History of a closed workspace** card offering to delete its history (older than 30 days, or all) and, when Paseo no longer has the workspace, to move it onto one that exists — the existing `traces.delete` / `traces.reassign` RPCs, each behind its dry run and confirmation, Cancel first (`client/dashboard-actions.tsx`); a closed workspace offers no chat. Settings → Data keeps the same actions per workspace, with the privacy line that the stored history holds agent conversation.
- **Insights:** Phase 1 shows the replay's flow and cost figures and the suite scorecards; autonomy (Part B) and review lift (Part C) follow.
  - *As built (WP-108 iv):* `client/insights.tsx` and `client/insights-model.ts` (pure). `insights.summary {window: 7d|30d|90d|all, workspaceId?}` (`server/insights-rpc.ts`) runs `computeEvalMetrics` over the data folder, read with the replay's reader (`server/eval-store.ts`, moved from `scripts/eval/replay.ts`: read-only, no lock), the window ending now and open at its end; it returns numbers only (requests and requests by UTC day, A-1 over finished requests, owner wait, A-11, A-8 by role, failed and cancelled turns, what was not counted) and `available: false` without a usable data folder. The screen: window and project tabs (projects by name: open workspaces, then closed ones with a known name), **Flow** (requests, questions per request, your wait, time to finished, errors; requests per day, at most the last 14 days), **Cost** (tokens per request with its median, tokens; tokens per request by role with shares), **Beads** (the Beads screen's former overview — `beadsOverview` — for the chosen project; *choose a project* across all), then placeholders for Autonomy by class (Phase 2) and Review lift (Phase 3). Read once when shown and on Refresh, never polled. The suite scorecards are not shown: the suite runs once at the programme's end (Evaluation design, revision of 2026-09-29).
- **Settings:** Agents (roles, fallback, sign-in, agent tools), Tools & skills, Data (data home, storage, cleanup) — reusing the Setup components; the Orchestrator tab and the role additional-instructions editor are removed.
  - *As built (sweep, WP-110):* the reused blocks live in `client/settings-blocks.tsx` (renamed from the Setup screen's file); the Setup landing — its tabs, headline and "Set up paseo-bm" checklist — and the additional-instructions editor are deleted. `orchestrator.set-autopilot` and `orchestrator.apply-suggestion` stay server-side with no screen until Part B retires Autopilot and the additional instructions; the Orchestrator can still turn Autopilot on at the owner's word (`bm_set_autopilot`).
- **Cards v2** (`CHAT_CARD_VERSION` 2): `decision` (live from the store), `progress`, `finished`, `verdict`, `brief`, `action` (a delivered command), `notice` (compact line). One frame (`ui.tsx`): actor → recipient · authority · time, one status chip, ≤ 3 body lines, one primary action, Details. Removed: reply boxes, answered chips, mark as answered, use recommendations, command/copy/event cards, the fallback variant.
  - *As built (WP-109):* a report that asks is one `decision` card per question (`q:<requestId>:<Qn>`; a `finished` report that asks is its `finished` card plus those); a `BM-FALLBACK` notice is the card of `f:<incidentId>`, a `BM-ANSWER` notice the card of its `decisionId`. A decision card reads `decisions.get` every 5 s while `open`/`needs-confirmation` and stops once settled; one not recorded yet is looked for only 10 minutes after its message. Every copy of one decision shares one query, so an answer shows everywhere at the next read. Options are buttons (the recommended one primary) plus *Own words…*; an answer whose effects are in `CONFIRM_EFFECTS` first shows the in-place confirmation, Cancel first; `needs-confirmation` shows *Keep open* / *Close as answered* (`decisions.confirm`). Chips: `Received`, `Working`, `Blocked`, `Finished`, `Passed`, `Changes required`, `Needs decision`, `Needs confirmation`, `Decided`, `Superseded`, `Withdrawn`, `Expired`, and the command's intent on an `action` card. A Manager's copy of a Worker command and a `BM-EVENTS` batch are `notice` lines. `DecisionCard` (`chat-card.tsx`, `via: "inbox"`) is the Inbox's card.
- React Native primitives only, theme tokens, phone and desktop widths, the accessibility rules of the Dashboard design §2.4.

### A.13 Evaluation adapter

`scripts/eval/owner.ts` implements the `decision-rpc` channel: the simulated owner answers only through `decisions.answer`. The suite's tree runs use it from Phase 1 on.

### A.14 Retirement (REQ-119)

| Removed | Files (and their tests) | Replaced by |
|---|---|---|
| Question–answer ledger, `BM-ANSWERED` | `server/qa-ledger.ts`, `ui/qa-ledger.json` | A.5, A.6 |
| `chat.waiting`, waiting pills, answer marks | `server/chat-waiting.ts`, `server/answer-marks.ts`, `client/waiting-pills*.ts`, `client/answer-state.ts`, `answers.mark(s)` RPCs, `ui/answer-marks.json` | Inbox, decision cards |
| Card reply and question forms | `QuestionForm`, reply helpers in `client/chat-card*.ts*` | decision card |
| Proposals and approve/dismiss | `bm_propose_command`, `orchestrator.approve`/`dismiss`/`command`, `proposals.json` command entries | decisions with prepared actions |
| Fixed limits, regex gate as authority, stop-word exemption | `COMMAND_LIMITS` use, `decision-gate.ts` as authority | A.7 |
| `BM-STALL`, `BM-EVENT`, `manager-turn`, `autopilot-on`, Watch switch | `server/stall-watcher.ts` (situations move to the event bus), `server/autopilot-events.ts` | A.8 |
| Fallback card variant, `BM-FALLBACK` to the Manager | fallback card code | `f:` decisions |
| Orchestrator tab, Setup landing, Workspaces list view, Metric screen, workflow-step chips, Beads overview-first layout | `client/orchestrator-tab.tsx` (parts reused), `client/launcher.tsx` views, `client/dashboard.tsx` layout, step chips | A.12 |
| Manager/Worker/Orchestrator role text on relays and notices | `plugin/roles/*.md` | A.11 |

Design sections replaced when Phase 1 lands: Base design (question–answer log, `BM-ANSWERED`, notices), Dashboard design §11 (screens), §15 (cards), Orchestrator design §5.3, §6, §6A, §6B.1–§6B.5, §7, §9.

Detail as built (WP-110, bead `bm-autonomy-phase1b-dbdv.6`):
- **Deleted with their tests:** the question–answer ledger and its turn-end hook; `chat.waiting`, the waiting pills and their registration; the answer marks and `answers.mark(s)`; the client's answer state; `bm_propose_command`; `orchestrator.approve`, `dismiss`, `command`, `save-settings`, and the tab's `ask` and `assess-workflow` (the owner asks the Orchestrator in its chat; its role file handles an assessment request); the Orchestrator tab (its model keeps only the Orchestrator line and Work's stage and M W R wording); the Setup landing; the Metric screen, its overview cards, charts, request graph, workflow-step chips and role legend; the Beads/Metric sub-tabs. `orchestrator.state` answers `{ agent, previousCount, toolsStale, outdated, projects }` only. The error codes only those RPCs raised (`E_ORCHESTRATOR_NOT_OPEN`, `E_WATCH_NOT_CONFIRMED`, `E_PROPOSAL_SETTLED`, `E_MANAGER_GONE`) left the registry.
- **Moved, not lost:** a fallback handover's `questions` and `openQuestions` read the decision store; the owner's way into the Orchestrator's chat is the Inbox's Orchestrator line (§A.12); a closed workspace's history actions are on its project page (§A.12).
- **Retired data files:** the new build never reads `ui/qa-ledger.json` or `ui/answer-marks.json`; `orchestrator/proposals.json` keeps only the commands the Orchestrator sent itself (source `autopilot` or `chat`) — the proposal era's entries are ignored and dropped by the next write; `stalls.json` keeps only interrupt allowances; `settings.json` has no Watch field. The cleanup button deletes all of them (everything in `ui/` but the setup state, and `orchestrator/` whole). `test/retired-data-files.test.ts` starts the surface's first reads on a folder that still holds every one and runs the cleanup over it.
- **Kept on purpose:** `BM-ANSWERED` stays recognised as a plugin notice (`RETIRED_NOTICE_MARKERS`), so stored 0.4.x history never reads it as the owner's words; the evaluation harness (`scripts/eval/legacy-contracts.ts`) keeps the shapes of `chat.waiting` and the old `orchestrator.state` to drive the builds it measures, and the metric module still reads every entry of `proposals.json` as history; the fixed limits remain the base of the derived `limits:` line (§A.7).

### A.15 No rollback between phases (REQ-171, DQ-1)

Owner decision 2026-09-29: no rollback path and no runtime switch between phases. Each phase replaces what it supersedes outright; if a phase goes wrong on the owner's machine, the remedy is a clean reinstall of the plugin (the cleanup button, then install) and a fix forward. Nothing in any phase keeps an old path alive for rollback.

### A.16 Security and boundaries

The decision store and the answer RPCs are the new authority path; negative tests cover: an answer to a settled, superseded or foreign decision; a grant used twice, after expiry, or for an undeclared effect; a command whose text shows an undeclared effect; the Manager's `BM-ANSWERS` without the owner's typed message in the same turn; an owner message in a Worker's chat never settling a decision without a parsed answer or the owner's confirmation; delivery never into a running turn; nothing sent to a Reviewer.

### A.17 Testing

Pure: the decision schema and transitions, supersession, grant arithmetic, `BM-COMMAND` v2 builder/parser (v1 still read), authority check, event batching, the Inbox/Work models (hook-free, `test/helpers/element-tree.ts`). Fake SDK: materialisation per turn kind with reused turn ids, delivery through the queue, fallback incidents, the capability patch (`config-writer`), the hook's pairing refusal. Live (isolated daemon): the verifications marked **(verify)**, then the evaluation suite with the `decision-rpc` channel.

---

## Part B — Phase 2 MVP: calibrated autonomy (ADR-018)

### B.1 Classes

`class` added to `Decision`: `reversible-technical, scope, preference, environment, dependency, release, data, security, cost`. The asker proposes it (`bm_report` question field; `bm_ask_owner` field). The plugin checks it against the declared effects — `push, publish, deploy` → `release`; `real-data, migration` → `data`; `security` → `security`; `cost` → `cost`; `dependency-install` → `dependency`; `network, outside-workspace` → `environment` — and keeps the riskier class on conflict (order: security, data, release, cost, dependency, environment, scope, preference, reversible-technical). A fallback incident is `environment`.

### B.2 Policy

`<data>/autonomy/policy.json` `{ version: 1, projects: { <workspaceId>: { <class>: owner | shadow | delegate } }, challenger: { <workspaceId>: boolean } }`; absent cell = `owner` with shadow on (Q-102). `release, data, security, cost` cannot be set to `delegate` (the RPC refuses). RPCs `autonomy.policy`, `autonomy.set { workspaceId, class, mode, confirmed }`, `autonomy.reset { workspaceId }`. Settings shows the matrix per project.

### B.3 Shadow and the agreement ledger

For every decision answered by the owner: `prediction.recommended` (the option marked recommended, at open time) and, when the project's challenger is on, `prediction.orchestrator` (the Orchestrator is sent the decision in a `BM-EVENTS` line and answers with `bm_predict { decisionId, optionKey, reason }`, never seen by the owner before answering). `plugin/shared/autonomy-ledger.ts` (pure) computes per project × class × predictor: agreement, count, first/last time, reversals. **Reversal** of a decision: re-asked with the same `subject` in the same request after it was settled; overridden from the digest; or a bead closed under it reopened with a reason citing it.

### B.4 Promotion and demotion

A cell is **eligible** when a predictor's agreement ≥ 90 % over ≥ 20 decisions spanning ≥ 14 days with no reversal. Insights shows **Delegate?** on an eligible cell; `autonomy.set` with `confirmed` applies it and records the predictor that earned it. A reversal or an owner override of a delegated decision demotes the cell to `shadow` at once, with an Inbox alert.

### B.5 Delegation

When a decision opens in a `delegate` cell: predictor `recommended` → the plugin answers with the recommended option at once (`answer.by: policy`); predictor `orchestrator` → a `decision.opened` event asks the Orchestrator to decide with `bm_decide { decisionId, optionKey, reason }`. Both deliver exactly as an owner answer would (A.6), with `authority: policy:<class>`. The Orchestrator's Autopilot and **Allow…** are removed (the Watch switch went in Phase 1).

### B.6 Precedents

`<data>/autonomy/precedents.json`: `{ id, scope: <workspaceId> | all, subject, text, sourceDecisionId, createdAt, expiresAt (default 30 days), supersededBy }`. Created from an answered decision (**Save as precedent** on its card) or by the owner in Settings. At agent creation the hook appends `## Owner precedents` (active, the workspace's and global, newest 20) to the Manager's and the Worker's runtime facts. A decision opening with a `subject` equal to an active precedent's is resolved by it when its class is not `owner`-fixed, citing the precedent; otherwise the precedent is shown on the card as a suggestion.

### B.7 Digest and override

Inbox → Decided for you: decisions answered `by: policy` or `by: precedent` since the owner last opened the Inbox, one line each with the reason; **Override** opens the decision as a new owner decision (`supersedes` the delegated one), which counts as an override for B.4.

### B.8 Retirement

Autopilot switch (`orchestrator.set-autopilot`, `bm_set_autopilot`), **Allow…**, `settings.json` v3 autopilot/allow fields, the additional instructions (`role-extras.json`, `roles.save-extra`, `orchestrator.apply-suggestion`, `role-extra-hash.ts`; their Settings editor and Preview went in Phase 1, as did the Watch switch and Assess workflow), runtime rule flags used only for assessment (`orchestrator-rules.ts` catalogue → replay metrics).

### B.9 Decided when the plan was converted (2026-09-30)

Settled by Claude under the owner's delegation while polishing the Phase 2 beads ([change-003](../plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md)); the Phase 2 start re-checks them against the Phase 1 field figures and changes them only through a delta.

- **Classes.** The tag is `[class: <class>]` after a question's other tags. A decision with no proposed class and no effect that maps to one is `reversible-technical`; a stored decision without `class` reads the same way; the store stays `version: 1`.
- **Modes.** An absent cell reads as `owner` (REQ-121 b). `owner` and `shadow` behave alike when a decision opens: the owner decides and the predictions are recorded. `shadow` is what a demotion sets, and its eligibility counts only decisions after the demotion. **Delegate?** is proposed for any eligible delegable cell in either mode, and the challenger, when the project's is on, predicts in both.
- **RPCs.** `autonomy.set { workspaceId, class, mode, predictor?, confirmed? }`: `confirmed: true` is required for `delegate`, and a hard-owner class is refused (`E_AUTONOMY_OWNER_ONLY`; also `E_AUTONOMY_NOT_CONFIRMED`, `E_AUTONOMY_INVALID`). The RPC does not check eligibility, since it is the owner's own surface and the suite's. The screens offer `delegate` only on an eligible cell. `autonomy.set-challenger { workspaceId, enabled }` needs no confirmation.
- **Ledger.** Predictions and reversals are additive fields of the decision record; the ledger is derived on demand. `answer.by` is `owner | policy | precedent`. A reopen is a reversal only when its reason cites the decision id or its `Qn`.
- **Which decisions agents judge.** The Orchestrator predicts and decides only decisions it did not ask (`q:`, `f:`). A `bm_predict` or `bm_decide` call is its wake's action for A-7. The `decision.opened` line names the tool to use.
- **Orchestrator commands without a decision** (replacing `authority: autopilot`). A command that answers no decision is authorised by the policy when every class its declared effects map to (B.1, with `none` and `commit` counting as `reversible-technical`) is `delegate` for its project. It carries `authority: policy:<class>`, naming the riskiest class. A hard-owner effect always needs a grant. Otherwise only the owner's own word in the Orchestrator's chat (`authority: owner`) authorises it. This keeps coordination proactive where the owner has delegated, and earned per class.
- **Demotion alert.** `autonomy-demoted`, keyed by project and class. It clears when the owner next sets that cell or resets the project, or when the cell is eligible again.
- **Precedents.** RPCs `precedents.list { workspaceId? }`, `precedents.save { decisionId?, scope, subject?, text?, expiresInDays? }` and `precedents.end { id }`. A decision without a `subject` cannot be saved. The resolving answer is the precedent's text as the owner's words, or the option whose label equals it. "Owner-fixed" means the four hard-owner classes: a precedent is the owner's own standing answer, so it also resolves a decision in an `owner` cell. Injection resolves the workspace from `config.cwd`; when it cannot, only global precedents are injected.
- **Digest and override.** The Inbox's last-opened time is kept in `<data>/inbox/seen.json`, with the alerts store's file rules. An override is a new owner decision `r:<uuid>` with `supersedes: <delegated id>`, open until the owner answers it. The delegated answer already delivered is not recalled; the corrected answer follows it.
- **A-4 and A-5.** Computed per delegated class in `eval-metrics.ts` from the overrides and the ledger's reversals of decisions answered `by: policy | precedent`. The owner's own reversal rate is the reference for A-5.
- **Retirement.** `bm_assessment` goes with the additional instructions, together with `assessment.ts`, `shared/bm-assessment.ts`, the assessments kept by the Orchestrator's store and its "Assessing a workflow" section. PRD Appendix B replaces it by precedents and replay findings. Every runtime rule flag goes except `review.over-budget`, which feeds the stall pass.

---

## Part C — Phase 3: evidence-grounded reflection

- **C.1 Richer evidence.** `evidenceSchema` gains optional `status`, `exitCode`, `cwd`, `callId` for `shell` entries (additive; `v` unchanged); the collector keeps them. `detail` of a command (and of a sub-agent label) is masked with `redactText` since 2026-09-30, brought forward from this phase because a Worker's command could carry a token.
- **C.2 Detected checks** (`plugin/shared/evidence.ts`, pure): a report's `buildAndTests` command is *detected* when a shell evidence entry of the same request runs the same normalised command with a successful status after the request's last file edit; *self-reported* when only the report names it; *unverified* when the report says "not run" or nothing matches.
- **C.3 Finished means proven.** A request with changed files is `finished-unverified` unless every named check is detected; the Work stage bar, the finished card and the `request.finished` event carry it, and a delegate (Part B) may not act on an unverified finish.
- **C.4 Review lift.** `eval-metrics.ts` adds per tier and project: blocking findings per batch, findings acted on (a re-review with the finding fixed), tokens per review; Insights shows it; the review budget table becomes a setting per tier only if the owner changes it from these numbers.
- **C.5 Independent review by default.** When roles are created and more than one base provider is signed in, the Reviewer defaults to a family other than the Worker's; Settings → Agents says when they are the same.

- **C.6 Decided when the plan was converted (2026-09-30)** ([change-003](../plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md); the Phase 3 start re-checks them).
  - **Named checks.** The named checks of `buildAndTests` are its backtick spans, which the Worker is told to use. A value naming checks only in words is self-reported; empty or "not run" is unverified, read at request level.
  - **REQ-130's other claims.** A file claim is detected when an `edit`/`write` evidence entry of the request names that file. A bead-closed claim is detected when a successful `br close <id>` shell entry of the request names that bead. Otherwise each is self-reported.
  - **"A delegate acts on an unverified finish".** This means a policy-answered decision of that request whose chosen option declares `commit`, `push`, `publish` or `deploy`, or an Orchestrator command with intent `release` under `authority: policy:<class>`. Both are refused while the request is `finished-unverified`, and the decision goes to the owner.
  - **Delivery to the client.** The verification reaches the client as an additive optional field of the traces rows.
  - **Review lift.** "Findings acted on" per batch with a re-review is the first review's blocking findings minus the last review's, floored at 0.
  - **Family (C.5).** A family is the model's vendor: Claude Code is Anthropic and Codex is OpenAI. Any other base provider takes the vendor prefix of its model id (`anthropic/…`, `openai/…`, `google/…`), else the base provider id. "Signed in" means `available: true` from `providers.listAvailable`.

## Part D — Phase 4: the action boundary (ADR-019, gated by a spike)

- **D.1 Spike** (isolated daemon, no agent of the owner's): for Claude `default`, `acceptEdits`, `auto` and Codex `auto`, `auto-review`, measure which tool calls raise `agent.permission_requested`, what `request.detail` carries (command, path, cwd), the latency of `respondToPermission` from the plugin, and what happens when the plugin is not running (does Paseo's UI show the request to the owner?). Pass criteria: every effect of the classification below is observable before it runs, the added latency per allowed call is under 1 s at p90, and nothing is allowed while the plugin is down.
- **D.2 If it passes:** Workers (and Reviewers) run in the least permissive mode that still lets the plugin allow ordinary work; `plugin/server/action-boundary.ts` answers every request at once: allow, or **hold** when the classification finds `release, real-data/migration, dependency-install, network, outside-workspace` and no grant or policy covers it — the held request becomes a decision whose prepared action is `permission { agentId, requestId, allow }`. A-6 must be 0 in a live check of held actions and in the field (PRD §10; the suite runs once, at the programme's end). `disabledTools`/prompts for `respond_to_permission` stay denied to every role but the plugin.
- **D.3 If it fails:** keep detection (`worker-watch` signals as Inbox alerts), document it as detection, and mark ADR-019 Rejected.

- **D.4 Decided when the plan was converted (2026-09-30)** ([change-003](../plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md); the spike's measurements can still change them at the Phase 4 start).
  - **Held requests.** A held request is the decision `p:<agentId>:<requestId>`. A live grant of the same request whose effects include the held effect allows it and is spent (grants are one use). A `delegate` cell of the held effect's class allows it with `authority: policy:<class>`.
  - **Unreadable or uncommitted requests.** A request whose command or path cannot be read is held. `commit` is not held.
  - **Options.** A held decision recommends no option.
  - **Owner-set mode.** A mode the owner hand-set on a role's profile still wins, and Settings → Agents says the boundary is off for that role.

## Part E — Phase 5: traceability

- **E.1 Links, derived:** `plugin/server/links.ts` builds, on demand, the chain request → decisions (store) → beads (report fields and `br` evidence) → changes (report `filesChanged`, commits whose message names a bead id, from read-only `git log`) → checks (Part C) → review verdicts → turn records. No new persistent store; results cached by mtime.
- **E.2 Consumers (REQ-152):** the Orchestrator tool `bm_why { workspaceId, bead | file | decision }` and Work → request → **Why?**. Supersession comes from decisions (`supersedes`) and beads (`Split-from`).
- **E.3 Audit:** A-10 measured on 30 sampled outputs of the owner's field use; ≥ 90 % complete chains (the suite at the programme's end adds its own samples).

- **E.4 Decided when the plan was converted (2026-09-30)** ([change-003](../plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md)).
  - **`bm_why`.** It returns at most 4,000 characters by default, cutting the longest parts first (as §A.9).
  - **The view's RPC.** Work's **Why?** reads the additive RPC `links.why { workspaceId, requestId } | { workspaceId, bead | file | decision }`.
  - **A-10.** The sample is 30 outputs: about 10 beads, 10 changed files and 10 decisions, drawn from finished requests of the phase's field window. A link that does not apply counts as complete when the chain states why it is absent, for example no bead on a Small request. A link that should exist but cannot be found is incomplete. This is fixed before sampling.

## Part F — Phase 6: specialisation on evidence

- **F.1 Collision detection first:** a `writers-observed` signal — two agents of one workspace with edit/write evidence on the same file in overlapping turns — as an Inbox alert and an event; measured in the replay.
- **F.2 Admission:** a candidate specialist (security reviewer, independent tester, read-only scout, design committee of two model families, per-Worker worktrees, a cheaper model for a role) is written as a one-page spec — the error class it catches, the replay/suite evidence that the class is missed today, its token budget, its evaluation scenario — and enters as a change-delta of the Phase 6 plan only when the owner accepts the evidence.

- **F.3 Decided when the plan was converted (2026-09-30)** ([change-003](../plans/paseo-bm-plan-autonomy-change-003-decisions-at-conversion.md)).
  - **The collision alert.** `writers-observed` is the alert kind and `writers.observed` the event type. The alert clears when the later of the two requests finishes.
  - **Admission tooling.** The admission template is `docs/operations/paseo-bm-specialist-admission-template.md`, and the suite driver's model option is `--role-model <role>=<baseProvider>/<model>`.

---

## 7. Open decisions

| ID | Decision | Owner | Status |
|---|---|---|---|
| DQ-1 | Rollback between phases | hieu.nt10 | **answered (2026-09-29)** — none; a clean reinstall and a fix forward (A.15; REQ-171 amended) |
| DQ-2 | When answers reach a Worker | hieu.nt10 | **answered (2026-09-29)** — at once, proactively, whatever is answered (A.6) |
| DQ-3 | Sidebar badge | hieu.nt10 | **answered (2026-09-29)** — dropped; handled in the Inbox (A.12) |
| DQ-4 | Orchestrator challenger in shadow off by default per project | hieu.nt10 | **answered (2026-09-29)** — yes (B.3) |

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | B.9, C.6, D.4, E.4, F.3: the design choices the Phase 2–6 beads had recorded as assumptions, settled when the beads were polished (change-003) — among them the policy authority of an Orchestrator command that answers no decision (replacing Autopilot), `owner`/`shadow` semantics, the override and held-request ids, REQ-130's file and bead claims, the model family, the A-10 sample |
| 2026-09-30 | Claude (owner's delegation) | §C.1: masking of recorded commands brought forward from Phase 3 (found while converting the Phase 3 plan); the masking rules themselves are unchanged |
| 2026-09-29 | Claude (owner's delegation) | §A.8: only a judgement wakes the Orchestrator — no `decision.opened` for a question with a confirm-class option, `request.finished` only with work left (the S1/S7 live check measured A-7 = 3 of 3 wakes with no action) |
| 2026-09-29 | Claude (owner's delegation) | §A.8 wakes recorded in `orchestrator/wakes.json` for the evaluation's A-7 (bead bm-autonomy-phase1b-dbdv.8) |
| 2026-09-29 | Claude (owner's delegation) | WP-110 retirement sweep as built (§A.14, §A.12, §A.8, §A.7): what was deleted, moved and kept; the surface's view names, the Beads tab as the project page, the Inbox's Orchestrator line, a closed workspace's history actions on Work, the retired data files |
| 2026-09-29 | Claude (owner's delegation) | WP-107 older agents as built (§A.11, §A.8): the `bm.instructions` label on every role, the throttled outdated-agents pass and its `outdated-agent` alerts, `manager.ensure { replaceOutdated }` |
| 2026-09-29 | Claude (owner's delegation) | WP-108 (iv) Insights as built (§A.12): `insights.summary`, the shared read-only store reader, the Flow, Cost and Beads figures and the Phase 2/3 placeholders |
| 2026-09-29 | Claude (owner's delegation) | WP-107 as built (§A.11): the four role files rewritten within their budgets; the Manager's Context part and alignment check, the Worker's `subject`/`effects`/`supersedes` and `BM-DELIVERY` answers, the Orchestrator's events and decisions; the mapping of every old rule in the run note |
| 2026-09-29 | Claude (owner's delegation) | WP-106 as built (§A.8): the event bus's scope, dedupe keys and settled rules, the notice queue's batch kind, the always-on stall pass and its two reasons, the Worker alerts, the alerts file and its producers, what was retired |
| 2026-09-29 | Claude (owner's delegation) | WP-109 cards v2 as built (§A.12): one decision card per question, the `f:`/`BM-ANSWER` decision cards, the 5 s read while unsettled, the confirmation in place, the chip set, copies and `BM-EVENTS` as notice lines |
| 2026-09-29 | Claude (owner's delegation) | WP-104 (ii) as built: an Orchestrator decision may be about a whole project (null `requestId`, §A.3); `bm_ask_owner`'s input, checks and supersession, the prepared command's block, the `BM-ANSWER` notice and the delivery rules (§A.6); `bm_decisions` for the Orchestrator and the Manager, and `bm_projects`' open decisions from the store (§A.9) |
| 2026-09-29 | Claude (owner's delegation) | §A.10: existing agents get the policy at their next session open (measured); ADR-020 records the explicit per-role policy, superseding ADR-006 d9 |
| 2026-09-29 | Claude (owner's delegation) | WP-102 details: `settledAt` and `needsConfirmation` on the record and the pure transitions (§A.3); the store's lock-free synchronous rule and idempotent open (§A.4); the `decisions.*` inputs, outputs, ordering, the X-4 confirmation on answers, the error codes and the `onSettled` hook (§A.6) |
| 2026-09-29 | Claude (owner's delegation) | WP-103 (answer delivery) as built: the Worker-question delivery rules, what `sent`/`queued`/`failed` record, chat-worker answers, and the once-per-run re-delivery (§A.6) |
| 2026-09-29 | Claude (owner's delegation) | Details needed to convert Phase 1 to beads: the `BM-QUESTIONS` tag format for `subject`, `supersedes` and `effects` (§A.5); the Inbox alerts file replacing the stall and signal keys (§A.8) |
| 2026-09-29 | hieu.nt10 | **Active**, `design-ready` PASS. DQ-1 no rollback between phases (clean reinstall); DQ-2 answers delivered at once; DQ-3 no sidebar badge, the Inbox handles it; DQ-4 challenger off by default |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Created (Draft) for Phases 1–6 of the calibrated autonomy programme, from the PRD, the experience concept and three read-only surveys of the code; flags that the Reviewer and Orchestrator aliases carry no `paseoTools` policy (A.10) |
