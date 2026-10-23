# paseo-bm — Orchestrator (Technical Design)

| Field | Value |
|---|---|
| Status | **Active** — the Orchestrator as shipped in 0.5.0 |
| Living document | Edited in place like the other designs, one Revision History line per edit |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-28 |
| Requirements source | The [calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md), which supersedes the Orchestrator PRD. The ids REQ-071 → REQ-087 cited here and in the code resolve in the [archived Orchestrator PRD](../archive/product/paseo-bm-orchestrator-prd.md) |
| Routing decision | [Archived Orchestrator PRD §0](../archive/product/paseo-bm-orchestrator-prd.md#0-routing-decision) |
| Related designs | [Autonomy design](./paseo-bm-autonomy.md) (decisions, authority, events, the management surface; what the programme retired from this design, §A.14) · [Design Dashboard](./paseo-bm-dashboard.md) (trace store, reconstruction) · [Base design](./paseo-bm.md) (roles, the `before("agent.create")` hook, `config.patch`, the notice queue, "Additional instructions", the plugin's MCP endpoint) |
| Related ADRs | **[ADR-014](../adr/ADR-014-orchestrator-agent-proposes-owner-approves.md)** (supersedes [ADR-013](../adr/ADR-013-orchestrator-assess-and-nudge.md)) · [ADR-005](../adr/ADR-005-manager-as-agent.md) · [ADR-007](../adr/ADR-007-dashboard-trace-store.md) · [ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md) (extended for the Orchestrator's endpoint) · [ADR-011](../adr/ADR-011-manager-coordinates-workers.md) |
| Reference environment | Paseo ≥ 0.9.0, `@getpaseo/plugin` 0.8.0, Node ≥ 22 |

## 1. Scope

**This document owns:** the Orchestrator agent (how it is created, where it lives, its instructions, its tools); the rule catalogue as signals; the stall pass and the live watch of running Workers; the commands the Orchestrator sends and how they are delivered; workflow assessment; the Orchestrator line of the Inbox; the `orchestrator.*` RPCs and error codes; the removal of the first design's parts (§11).

**Owned by the [autonomy design](./paseo-bm-autonomy.md):** the owner's decisions and their delivery (§A.3–§A.6), the authority of a command (§A.7), the event bus and the Inbox alerts (§A.8), the management surface — Inbox, Projects, Settings, Tools & skills — and the chat cards (§A.12), the owner's autonomy policy (§B.8, §B.9). What the programme retired from this design is listed in §A.14; Autopilot and Allow… (§6A, §6B.5) were replaced by the autonomy policy (§B.8).

**Does not own:** the trace store, the collector, reconstruction (Design Dashboard — **read** only); the mode rule and instruction injection (Base design §7.2 — the role is only **added**); the notice queue (Base design — used, with one new kind per delivery); instruction text written by the user (only **appended** to on a click).

## 2. Architecture

> **The governor of missions** (ADR-029, ADR-031, ADR-032; missions design §9, §17, §20). The Orchestrator is one agent for the machine that governs the process of every mission through its Main. Since 2026-10-10:
> - `bm_predict` is retired; a stored Orchestrator prediction is still read and shown, and the Main's `prediction.main` is the proposal at Co-pilot and up;
> - the Orchestrator decides only `f:` incidents delegated to it (`bm_decide`);
> - each `BM-EVENTS` message carries one mission's events, opened by its brief;
> - a mission Worker's `danger` goes to its Main first.

```
                 ┌─────────────────────── plugin server ───────────────────────────────┐
 agent.turn_ended│ collector ──► trace store (ADR-007) ──► decision materialiser         │
                 │ stall pass (always on, every 60 s) ── reconstruct ── rules            │
                 │   └─► request-stalled Inbox alert; policy-scope project: event bus    │
                 │ live Worker watch (every project, every 2 min) ─► alert (+ event)     │
                 │   a mission Worker's danger ─► BM-SIGNAL to its Main (missions §20)   │
                 │ governor pass (60 s, each turn) ─► figures, ladder, mission events    │
                 │ event bus ─► noticeQueue.enqueueBatch(Orchestrator, "BM-EVENTS",      │
                 │   one group per mission, its brief composed at delivery)              │
                 │ MCP /mcp/orchestrator/<secret>:                                       │
                 │   bm_projects · bm_missions · bm_request · bm_agent_messages ·        │
                 │   bm_decisions · bm_repo · bm_why · bm_findings (read)                │
                 │   bm_govern · bm_arbitrate · bm_create_main · bm_direct_worker (stop) │
                 │     → noticeQueue.enqueue(agent, "command:<id>") → proposals.json log │
                 │   bm_ask_owner → decision store · bm_decide (f:) · bm_reply · bm_note │
 RPC orchestrator.* ─► open-preview · open · state                                        │
 RPC decisions.answer ─► an o: decision's prepared command, or BM-ANSWER to the Orchestrator│
                 └──────────────────────────────────────────────────────────────────────┘
 client: the Inbox's Orchestrator line (open or start it) · the Projects rows read orchestrator.state
```

Modules (all in `plugin/`):

| Module | Job |
|---|---|
| `shared/orchestrator-rules.ts`, `shared/rule-input.ts`, `server/request-trace.ts` | The one rule left, `review.over-budget`, for the stall pass (§4); the other rules' figures are in the replay (evaluation design, `supplementary.process`) |
| `server/orchestrator-store.ts` | `orchestrator/` in the data folder: the command log, interrupt allowances, notes, model-correction log, wakes (§5.4) |
| `server/orchestrator-agent.ts` | Opens or creates the one Orchestrator agent, its workspace, its replacement (§3.3) |
| `server/stall-watcher.ts`, `server/worker-watch.ts` | The stall pass (§6) and the live watch of running Workers (§6B.3), publishing through `server/event-bus.ts` (autonomy design §A.8) |
| `server/orchestrator-tools.ts` (used by `agent-tools.ts`) | The registry of the Orchestrator's MCP tools (§5, §6A, §6B.4); the tools are in `orchestrator-read-tools.ts` (`bm_projects`, `bm_missions`, `bm_request`, `bm_agent_messages`, `bm_note`), `command-authority.ts` (authority, `bm_govern`, `bm_direct_worker`), `governor-tools.ts` (`bm_arbitrate`, `bm_create_main`), `orchestrator-decide-tools.ts` (`bm_ask_owner`, `bm_decisions`, `bm_decide`), `decision-ask.ts` (`bm_reply`, change-014) and `repo-tool.ts` (`bm_repo`), over the shared context of `orchestrator-tool-context.ts`; every command leaves through `command-send.ts` (§7) |
| `server/governor-brief.ts` | The mission brief each `BM-EVENTS` wake opens with (missions design §20.1) |
| `server/orchestrator-decisions.ts` | Delivers an answered Orchestrator decision (§7) |
| `server/orchestrator-rpc.ts`, `server/orchestrator-state.ts` | The `orchestrator.*` RPCs (§8) |
| `server/request-render.ts` | The redacted, capped content of one request for `bm_request` (`buildRequestContent`) |
| `client/orchestrator-model.ts`, `client/orchestrator-line.tsx` | The Orchestrator line of the Inbox, and the stage and agent letters of the Projects rows (§9) |
| `roles/orchestrator.md` → `server/orchestrator-instructions.ts` | The instructions (§3.2) |

## 3. The Orchestrator agent

### 3.1 The role

Role key `orchestrator`, alias and profile `bm-orchestrator`, display name "Beads Orchestrator"; created by `ensureRoles` like the three roles; **no** `paseoTools`; mode by the Reviewer's rule (never `dangerous`/`planning`, `auto_accept` off); the hook injects its instructions, its profile's model/thinking, and — on `claude`/`codex`/`opencode` — the plugin's MCP server at the Orchestrator's path with its tools pre-approved (§5.1). The collector, format check, review budget, fallback and stop propagation ignore it. Settings → Agents has its card. Going back to 0.4.1 is a clean reinstall ([ADR-022](../adr/ADR-022-retirements-after-code-review.md)).

### 3.2 Instructions (`roles/orchestrator.md`)

Written for the autonomy programme (autonomy design §A.11; at most 100 lines, three limits) and rewritten as the governor's file (missions design §11, §17, §20):

- **What you are:** the owner's governor of paseo-bm missions; each mission's Main runs its work. Its three rules:
  1. you change nothing yourself;
  2. you act only as far as the owner's authority goes: your commands carry no effect and no answer grants one (ADR-031), and a stop goes on the owner's word, a delegated class or an answered decision;
  3. you never guess what your tools do not show.
- **Your tools:** one line pointing at each tool's own description, and what those descriptions do not say. Before saying a named `bm_` tool is unavailable, it must attempt that tool once in the current turn; only a tool-discovery or transport error proves it unavailable. The served tools, sixteen, are `bm_projects`, `bm_missions`, `bm_request`, `bm_agent_messages`, `bm_govern`, `bm_arbitrate`, `bm_create_main`, `bm_decisions`, `bm_ask_owner`, `bm_decide`, `bm_direct_worker`, `bm_repo`, `bm_note`, `bm_findings`, `bm_why` and `bm_reply`, all pre-approved; the first prompt names each.
- **Governing a mission:** it reads the figures and the charter before it acts. Each `BM-EVENTS` is one mission's wake, opened by its brief, and it never carries one mission's facts into another's wake. It speaks to a mission through its Main with `bm_govern`. It keeps one `bm_note` per owner decision by mission, or by project, where the note goes to project memory (missions design §20.4).
- **What reaches you:** the owner's messages and `BM-EVENTS` (the plugin's, never the owner's word):
  - `mission.signal` → re-plan;
  - `mission.conflict` → arbitrate;
  - `mission.scope` → govern or ask;
  - `mission.review` → govern, ask or note;
  - `mission.split` → `bm_create_main` or tell the Main why;
  - `worker.signal danger` → as the Main's backup, evidence first, only a stop.

  `BM-ANSWER` is the owner's answer to one of its decisions; `BM-ASK` is answered once with `bm_reply`.
- **Workers, questions and decisions:** a Worker is its Main's, and the Orchestrator never briefs, corrects or answers one. It decides only `f:` incidents delegated to it, and asks the owner with `bm_ask_owner` (options with effects as information, prepared commands to a Main only).
- **Talking to the owner:** short, in the owner's language, as **Situation** / **Done** / **Needs you**; the owner's word wins.

### 3.3 Where it lives, and opening it

- **One agent** (REQ-075 a): the Orchestrator is the non-archived agent labelled `bm.role=orchestrator` and `bm.orchestrator=main`. `orchestrator.open` returns it if it exists (in any workspace); otherwise it creates it.
- **Its workspace (Q-077):** `paseo.workspaces.open({ cwd: <data folder>/orchestrator/home })` — a folder the plugin creates (mode `0700`, no symlink on the way, like the store's folders) with a short `README.md` saying what it is. The plugin **server's** `paseo` object can open a plain, non-git folder this way: Paseo registers a project `home` and a local workspace, and `workspaces.ref(<id>).agents.create` creates the agent there (verified on an isolated daemon, Paseo 0.9.2; `docs/archive/operations/paseo-bm-orchestrator-agent-run-20260928.md`). So `open-preview` always says `workspace: "own"` and `open` ignores `workspaceId`. The **fallback** — the Open dialog lists the user's workspaces and creates the agent in the one the user picks, `open-preview` saying `workspace: "choose"` — is not implemented; it is kept here only in case a later Paseo refuses the call.
- **Creation** (`server/orchestrator-agent.ts`)**:** (`orchestratorTargetOf`, `orchestratorPostureOf`, from the first design's assessment agent): provider `bm-orchestrator/<profile model>` (bare alias without a model), mode by the Reviewer rule, labels `bm.role=orchestrator`, `bm.orchestrator=main`, `bm.version`, `bm.instructions=<first 12 hex digits of the SHA-256 of ORCHESTRATOR_INSTRUCTIONS>`, title "Beads Orchestrator", and a first prompt that introduces the tools and asks it to wait for the user. Missing profile or provider not available → `E_ORCHESTRATOR_UNAVAILABLE`, nothing created; no usable data folder → `E_DATA_HOME_UNAVAILABLE`; the home folder cannot be written → `E_ORCHESTRATOR_WRITE_FAILED`. Calls that overlap share one creation. An agent whose provider did not start is kept (ADR-005), logged, and reopened by the next `open`. When the agent exists but its profile can no longer be read, `open-preview` still answers (`exists: true`, the agent's own provider, `model: null`) so it can be reopened.
- **Outdated or tool-stale Orchestrators are replaced without the owner.** Paseo fixes an agent's system prompt when it is created, so an Orchestrator created before its role file changed keeps the old instructions. One whose `bm.instructions` label is missing or differs from the current hash is **outdated**; one created before the endpoint's secret was made is **tool-stale** (§5.1). `orchestrator.state` reports both (`outdated`, `toolsStale`), and `orchestrator.open { recreate: true }` replaces either. Every wake-up goes through `wakeableOrchestrator(paseo, deps)`: the main Orchestrator when it is current; when the newest one is outdated or tool-stale, a new one created exactly as `orchestrator.open { confirmed: true, recreate: true }` creates it — the owner consented to an Orchestrator when first opening it — which then gets the notice; **null** when there is none, since the plugin never creates an Orchestrator the owner never opened. The old one is left in the owner's list — never archived, stopped or messaged (ADR-005) — and one log line says it was replaced. Replacing lists again under the single-flight `open`, so two wake-ups at once create one agent. A replacement that fails (no profile, no data folder) is logged and the old one is woken, so the notice still reaches an agent that can tell the owner. The event bus (autonomy design §A.8) wakes it through it.
- The client opens its chat with the host's `navigation.openAgent` (the Inbox's Orchestrator line, §9).
- **Its first prompt** introduces its tools and asks it to wait for the owner; its first line is "The user opened you from the Inbox of Beads Manager (paseo-bm)." The chat check (`isOwnerWord`) matches the opening words every version's first prompt shares (`ORCHESTRATOR_FIRST_PROMPT_START` = "The user opened you from "), so no first prompt, of any version, is ever the owner's word. The home folder's `README.md` (`ORCHESTRATOR_HOME_README`) says what the agent is: the one governor of every mission, through their Mains. It says it changes nothing itself and decides no business question, that its commands carry no effect and no answer grants one (ADR-031), and that it asks the owner in the Inbox what is theirs (missions design §20.4). The first prompt also says each `BM-EVENTS` message is one mission's wake, opened by its brief.

## 4. Rules (signals)

### 4.1 The scoring function

`flagsOf(input: RuleInput, facts: RuleFacts): Flag[]`, pure and deterministic, `RuleInput = { traceId, requestId, tier, reviewCalls, inbound }` built by `ruleInputOf(trace)` (`server/request-trace.ts`), `RuleFacts = { reviewBudget }`. No snapshot is stored.

### 4.2 The catalogue

The Orchestrator reads work through its bounded tools, not rule flags, so one rule is left; the others moved to the replay (autonomy design §B.8).

| ID | Severity | When it is raised | Evidence |
|---|---|---|---|
| `review.over-budget` | warning | `overReviewCap(reviewCalls, ceiling)`: the request's review cap (`reviewCapOf`, delivery line design §5.3) plus owner-granted calls; no tier → the Small cap, `unknown` | the review call turns |

It feeds the stall pass (§6). The six other rules of the first design are measured across requests by the replay (`shared/eval-metrics.ts` `supplementary.process`, computed by `eval-metrics/requests.ts` `processOf`, evaluation design §4): `process.small-heavy` → `smallHeavy` (unknown: `processWeightWithoutTier`); `process.no-review` → `unreviewed` (a Reviewer linked with no recorded turn counts as unreviewed; unknown: `unreviewedWithoutTier`); `agent.failed-first-turn` → `failedFirstTurns { worker, reviewer }` (the "in error with no recorded turn" case is dropped: it needs Paseo's live agent list); `report.malformed` → `reportFormat` (already measured) and `finishedWithoutReceived`; `manager.language-mismatch` → `languageMismatch` (unknown: `languageOrderUnknown`; requests with a request id only); `agent.model-corrected` → dropped (the replay does not read `model-corrections.json`). `bm_projects` returns no per-request `signals` and `bm_request` no flags section.

Language guess (`language-guess.ts`, used by the replay's `languageMismatch`): drop code blocks and backticked strings; count letters; `vi` when ≥ 3% of the letters are **Vietnamese-only** letters — the ones no other Latin language writes: `ă đ ơ ư`, any tone on `ă â ê ô ơ ư`, the hook above or dot below on any vowel, the tilde on `e i u y`, the grave on `y` (the accents Vietnamese shares with French, Spanish or Portuguese — `â ê ô à á é è ã …` — do not count, so dense French is not `vi`); `en` when there is **no accented letter at all** and ≥ 20 Latin letters; otherwise `unknown`. Only `vi`/`en` are distinguished in O1 — enough for the case seen, and no false alarm for other languages (they come out `unknown`).

### 4.3 The model-correction log — retired

**Retired** (bead `bm-consolidation-81y2.23`): nothing read it once the `agent.model-corrected` rule went (§4.2), so the creation hook does not write `orchestrator/model-corrections.json`. `applyRoleModel` keeps its one `console.warn` line when it replaces a requested model with the profile's; an earlier version's file is left alone and deleted with the `orchestrator/` folder by the cleanup.

## 5. The Orchestrator's tools

### 5.1 The endpoint

`agent-tools.ts` serves the Orchestrator's tools at `/mcp/orchestrator/<secret>`, where `<secret>` is 32 random bytes (hex); the hook builds the URL with it. A request to `/mcp/orchestrator` without the right secret gets `404`. **The secret outlives the plugin process**, like the port: it is kept in `<data folder>/ui/orchestrator-endpoint.json` (`{ schemaVersion: 1, secret, createdAt }`, `0600`, written atomically, read and written through no symlink) and reused by every later start, so a plugin reload does not cut an open Orchestrator off its tools. A new secret is made and saved only when the file is missing or unusable — not JSON, another schema, a secret that is not 64 lower-case hex digits, a `createdAt` that cannot be read or lies ahead of the clock, a file readable by anyone but the user, or a symlink on the way; a secret that cannot be saved still serves that start (one log line), and the next start makes another. The secret never appears in a log line. `secretSince` is the stored `createdAt`; `orchestrator.state` reports `toolsStale` when the Orchestrator's `createdAt` is earlier (`toolsStaleSince`; an unknown creation time, or no endpoint, is never stale) — so only an Orchestrator created before the stored secret was (re)generated — and such an Orchestrator is replaced at its next wake-up or by `orchestrator.open { recreate: true }` (§3.3); the newest labelled agent is the Orchestrator from then on. A current Orchestrator is returned as it is. The tools are pre-approved for the Orchestrator only (`toolPolicy.preapproved`), on `TOOL_PROVIDERS` only.

### 5.2 Read tools

| Tool | Input | Returns (text, JSON inside) |
|---|---|---|
| `bm_projects` | `{ sinceHours?: 1-168 (default 24) }` | per workspace with paseo-bm activity in the period: id, label, directory, its Manager(s) (id, status), up to 10 recent requests (requestId, first line of the request, tier, state, last activity, `waitingSince` when blocked, open stall situations) |
| `bm_request` | `{ workspaceId, requestId }` | the request's content (`server/request-render.ts` `buildRequestContent`, opening with "# The request": request, reports, reviews, Manager replies, user messages), redacted, capped at 60,000 characters |
| `bm_agent_messages` | `{ agentId, limit?: 1-50 (default 20) }` | the agent's most recent user messages and replies, redacted, each ≤ 12,000 characters (§6A); refused (`not a paseo-bm agent`) unless `agents.list` shows the agent with a `bm-manager`/`bm-worker`/`bm-reviewer` provider |

All three read only the trace store, `agents.list`, `workspaces.list`, and the timelines of paseo-bm agents: `bm_agent_messages` reads that one agent's, and `bm_request` (built as `traces.get` builds the Requests tab's request timeline — `readTraceContext` then `traceDetailOf`, one rebuild and one agent list per call) reads the request's own Manager, Workers and Reviewers (REQ-074). Stalls and requests are keyed by `requestId ?? traceId` (`requestKeyOf`). Each returns a bounded summary by default and the contents above with `detail: "full"`; `bm_decisions` lists the stored decisions, read-only (autonomy design §A.9).

### 5.3 Asking the owner

There is no proposal waiting for a click (retired, autonomy design §A.14). What the Orchestrator's authority does not cover, it asks the owner with `bm_ask_owner`: an `o:` decision in the decision store — the question, its recommendation, options each with their declared effects and, optionally, a prepared command the plugin delivers itself when the owner picks that option (autonomy design §A.3, §A.6; §7). A `bm_direct_worker` stop without authority refuses with "…; ask the owner with bm_ask_owner, and once the owner has answered, stop it with that decisionId", and sends and records nothing.

### 5.4 Stored data (`<data folder>/orchestrator/`, `0700`/`0600`)

- `settings.json` (**retired** with Autopilot, autonomy design §B.8): no build reads or writes it; an earlier build's file is ignored, and the cleanup deletes it with the folder.
- `proposals.json`: `{ version: 1, entries: Proposal[] }` — the **log of every command delivered on the Orchestrator's side**: the ones it sent itself (`bm_govern`, `bm_arbitrate`, `bm_direct_worker`; `bm_send_command` in older entries) and the prepared commands delivered on the owner's, the policy's or a precedent's choice of an option (§7). All of them go through one pipeline, `server/command-send.ts`, which writes each once, under the id its intervention entry carries: `status: "sent"`, `source: "chat"` (an older `"autopilot"` still read and counted), the 200 newest (store API `appendCommand`, `listCommands`). `Proposal = { id, at, kind, workspaceId, managerId | null, requestId | null, situation, command, reason, source, status, settledAt, sentText, outcome: "sent" | "queued", error, to?, workerId? }`, with `situation` the block's `re:`, `command` its body, `reason` its `why:` and `sentText` the whole block (§6B.1). The loop guard (§6A) and a project's `lastAction` (§6B.7) read it. The schema keeps every shape the file has held, so an older file parses and the evaluation can count it; the proposal era's entries — `pending`, `dismissed` or `failed` proposals, commands of `source: "orchestrator"` or `"user"` sent from the retired screen, and entries of `kind: "decision"` — are ignored on read (`isSentCommand`) and dropped by the next write.
- `stalls.json`: `{ version: 1, entries }` holding only **interrupt allowances**, `"<ws>::<workerId>::danger-open@<time>"` (§6B.3), at most 500 (oldest opened first). The stall, event and Worker-signal keys of older builds are ignored and dropped by the next write: stalls and signals are Inbox alerts (`inbox/alerts.json`, autonomy design §A.8).
- `notes/<ws>.json`: the Orchestrator's notes about a project (§6B.4).
- `wakes.json`: `{ version: 1, entries: { orchestratorId, at, endedAt | null, workspaceIds, events }[] }`, the 500 newest — one entry per `BM-EVENTS` message the event bus delivered, its end set at that Orchestrator's next turn end (the oldest open wake first). Ids, times and a count only; read by the evaluation's A-7 (evaluation design §4), never by the Orchestrator (store API `appendWake`, `endWake`, `readWakes`).
- `model-corrections.json`: not written (§4.3); an old file goes with the folder. `assessments/<ws>.jsonl` (**retired** with `bm_assessment`, §5.5): never read or written; deleting any trace of a project deletes that project's old file (`deleteRetiredAssessments`), since it may quote the project's messages, and the cleanup deletes the folder.
- Store rules (`orchestrator-store.ts`, on the JSON store factory of `data-files.ts`): every operation is synchronous, so a read-modify-write needs no lock. An entry of `proposals.json` or `stalls.json` that does not validate is skipped on its own. A file a newer paseo-bm wrote reads as its default and is **never written**; every file failure is `E_ORCHESTRATOR_WRITE_FAILED` (a bad workspace id stays `E_TRACE_STORE_UNWRITABLE`). Above its cap, `proposals.json` keeps the newest 200 in file order.
- The cleanup button deletes the whole `orchestrator/` folder, the retired entries with it. Removed: `nudges.json` (§11).

### 5.5 `bm_assessment` (workflow) — retired

**Retired** (autonomy design §B.8, §B.9, bead `bm-autonomy-phase2-t9lm.16`): proactive advice (autonomy design §G.4) and precedents replace the workflow assessment. The tool, its modules, the store's assessments and the `assessment` field of `orchestrator.state` are deleted; `request-render.ts` keeps the content builder `bm_request` uses.

## 6. The stall pass (REQ-073)

`server/stall-watcher.ts` (autonomy design §A.8):

- **Always on:** started at plugin load, stopped at unload, its timer `unref`ed; there is no switch. It costs no token: no timeline read, no model call.
- **Its Paseo handle:** the plugin server has none of its own, so the pass keeps the last one a hook or RPC brought. `index.server.ts` hands every handle it receives — an `orchestrator.*` call, an Inbox read, a fallback hook, a paseo-bm agent creation (the role hook), any agent's turn start or recorded turn (the collector) — to every keeper at once: the agents' tools endpoint, the stall watcher, the event bus and the action boundary; a pass before any arrived does nothing.
- **Every 60 seconds**, one non-overlapping pass: `agents.list` once; for each workspace whose trace store has activity in the last 24 hours (mtime cache), reconstruct its requests (`workspaceTracesOf`) and look at **every** request with activity in those 24 hours (a Manager often runs several at once).
- **Why a request stalls** (`stallReasonsOf`, pure), never while a **Worker or Reviewer** of the request is `running` (the Manager is left out: it is shared by every request of its workspace):

| Reason | Raised when |
|---|---|
| `idle-unfinished` | the last report is not `finished`, the request waits on no decision of the owner, and nothing happened for ≥ **5 min** |
| `review-over-budget` | `review.over-budget` is raised and the last report is not `finished` |

  **Waiting on the owner is read from the decision store, never from a report** ([ADR-024](../adr/ADR-024-structure-tells-stops-and-waits.md)): a request with an unsettled decision (`q:`, `o:`, `h:`, `f:` of that request) is not stalled — it waits in the Inbox. A `blocked` report whose questions are all answered, or whose agent asked only in chat words or waits on another agent, waits on nothing the Inbox shows: after 5 idle minutes it stalls like any other request. When the decision store cannot be read, a `blocked` report counts as waiting. A request with no Worker and no report — the Manager answered it itself — never stalls.

- **Once per stall:** one `request-stalled` Inbox alert per request (subject the request key, `detail` the reasons), raised while it holds and cleared when it no longer does (an agent runs, a new report arrives, the request leaves the 24-hour window or its trace is deleted); raised afresh after that.
- **To the Orchestrator:** only for a project in the policy's scope (a class `shadow` or `delegate`, autonomy design §A.8), the pass that raises the alert publishes a `request.stalled` event on the event bus; it reaches the Orchestrator in the next `BM-EVENTS` batch and is dropped if the alert is cleared first. Outside that scope nothing is sent: the owner sees the alert in the Inbox.
- The live watch of running Workers rides on the same timer (§6B.3).

## 6A. Autopilot and the owner's word in chat (ADR-015, REQ-082)

Autopilot (ADR-015) is **retired**, replaced by the owner's autonomy policy (autonomy design §B.8, §B.9). ADR-029 then made the Orchestrator the governor of missions, and ADR-031 took every effect out of its commands. What this section now holds:

- **Events** (missions design §9.7, §20; `event-bus.ts`). Only the governor's events wake the Orchestrator: `mission.signal`, `mission.conflict`, `mission.scope`, `mission.review`, `mission.split`, and `worker.signal` `danger`. Every other event type is retired as a wake.
  - A mission Worker's `danger` reaches it at any repo level, as its Main's backup, from `backupAt`. Another Worker's `danger` reaches it only in the policy's scope.
  - The bus sends, at the Orchestrator's idle moment, **one** `BM-EVENTS` message per group: one mission's events (a conflict's two missions together), opened by each mission's brief (`governor-brief.ts`). A `danger` group goes first.
  - An event whose subject settled first is dropped, and each mission wakes at most once per 15 minutes, `danger` excepted. `BM-EVENTS` is a plugin notice, never the owner's word.
- **Authority** (ADR-031, autonomy design §A.7). The Orchestrator's commands declare `effects: none`.
  - `bm_govern` and `bm_arbitrate` carry the structural authority `governor:<step>`.
  - A stop (`bm_direct_worker`) needs the project's default class delegated, the owner's own latest inbound message in its chat (`isOwnerWord`), or an answered decision (`stopAuthorityOf`).
  - An answer to an `o:` decision grants nothing; its prepared command goes to a Main with `approved: none`.
  - Every command of the Orchestrator is `via: chat`.
- **Loop guard** (`server/command-send.ts`), counted from the command log (§5.4) over the last **24 hours**:
  - `bm_govern` and `bm_arbitrate` count per mission, in four pools (code nudges, re-plans, arbitrations, others; missions design §9.4, delivery line design §8.1).
  - `bm_direct_worker` counts per request, at most **12**.
  - A full pool refuses with "This mission's <pool> commands are spent until <time>; paseo-bm puts the figures in the Main's daily digest. Nothing was sent." Nothing is sent or recorded.
  - The prepared command of the owner's own answer is counted but never refused.
  - `bm_ask_owner` about a mission's process passes only from ladder step 4, unless the owner wrote to the Orchestrator in the last 2 hours or the ask is about a goal change or a split (delivery line design §8.3).
- **Tools** (Orchestrator endpoint):

| Tool | Behaviour |
|---|---|
| `bm_govern` | A nudge, re-plan or arbitration to a mission's current Main (missions design §9.4) |
| `bm_ask_owner` | Stores an open `o:` decision (§5.3): a question, a recommendation, options whose effects are information and whose prepared commands go to a Main only; a new one replaces the Orchestrator's open decision of the same request unless `separate`. Sends nothing to any agent |
| `bm_decisions` | Read-only: the stored decisions, redacted, with their answers (autonomy design §A.9) |
| `bm_send_command`, `bm_set_autopilot`, `bm_predict`, `bm_compact`, `bm_handoff` | **Retired** (ADR-029, missions design §9.1, §19; autonomy design §B.8) |

- **Reading enough:** `bm_agent_messages` returns up to 50 messages of up to 12,000 characters with `detail: "full"`; `bm_request` keeps the 60,000-character cap with `detail: "full"` (§5.2).

## 6B. Coordinating running work (ADR-016)

### 6B.1 `BM-COMMAND` — every command the plugin delivers

Built by `commandBlockOf` in `shared/orchestrator-command.ts` (with its parser `parseCommandBlock`), used for every command the plugin delivers — the Orchestrator's own and the command it prepared on an option the owner chose. Version 2 (autonomy design §A.7):

```
BM-COMMAND
from: orchestrator | owner
via: chat | tab                 ← `autopilot` only in older blocks (read, never written)
to: manager | worker
copy: yes                       ← only on the Manager's copy of a Worker command
requestId: req-… | none
re: <subject, one line, ≤ 120>
intent: answer | continue | redirect | stop | release | other
effects: <effects, in EFFECTS order> | none
authority: owner | decision:<decision id> | policy:<class>    ← `autopilot` only in older blocks
approved: <the effects the authority covers> | none
limits: <derived>               ← only when from: orchestrator

<body: the instructions, markdown allowed, ≤ 4,000; an answer to questions embeds a BM-ANSWERS block>

why: <one line, ≤ 300>          ← optional
```

- **Limits** are derived: the fixed limits (`COMMAND_LIMITS`: no commit, push or deploy; no real data) less what `approved` covers (`limitsOf`), so a delivered command never carries a limit that contradicts its approval; a limit partly approved is split into `no-<effect>` for what it still withholds. A command `from: owner` carries none; no current build writes one — it is read from blocks older builds delivered.
- **`via`:** `chat` for the Orchestrator's own commands (§6A; older builds also wrote `autopilot`, which the parser reads and the builder refuses); `tab` for a prepared command delivered because the owner tapped its option (in the Inbox or on a decision card), always with `authority: decision:<id>`.
- **Builder and parser** (`orchestrator-command.ts`): `commandBlockOf(input)` collapses `re:` and `why:` to one line, drops the blank lines around the body, writes `requestId: none` for no request, and throws on anything `commandInputProblems` reports — an empty `re:`/body, a limit exceeded, `copy` without `to: worker`, a request id that is not one token (1–128 of letters, digits, `.` `_` `:` `-`), or a body whose last paragraph is a lone `why:` line with no `why` given. `parseCommandBlock(text)` is strict — the marker alone on the first line, the header up to the first blank line (unknown keys ignored, a repeated or malformed line refused), the `why:` taken only from a last paragraph of one `why:` line; a v2 block whose limits withhold an approved effect, or that carries only some of the four v2 fields, is refused — and `parseCommandBlock(commandBlockOf(x))` equals `commandOf(x)`. A version 1 block (no `intent`, `effects`, `authority`, `approved`) still reads. An embedded `BM-ANSWERS` block stays as written; `parseAnswers` still reads it in the whole text.
- **Stored** in the command log (§5.4): `sentText` is the whole block; `situation` holds the `re:` line, `command` the body and `reason` the `why:` line (empty when none).
- `BM-COMMAND` is in `PREFIXES` (a plugin-delivered block, never counted as a new user request by the collector).
- **Who writes which block:**

| Path | `from` | `via` | `to` | `re:` | body | `why:` |
|---|---|---|---|---|---|---|
| `bm_govern`, `bm_arbitrate` (missions design §9.4, §9.6) | `orchestrator` | `chat` | `manager` (the mission's current Main) | `Governor: <step>, mission <code>` | `text`, then a `Figures:` block | — |
| `bm_direct_worker` | `orchestrator` | `chat` | `worker` (the Manager's copy adds `copy: yes`) | `re` | `command` | `why` (optional) |
| a prepared command the owner picked (`orchestrator-decisions.ts`, `preparedCommandOf`) | `orchestrator` | `tab` | the action's `to` | the option's label, else the body's first line | the action's `body` | "The owner chose "<label>" on decision <id>." |

  A subject taken from a line is that line with whitespace collapsed, cut to 120 characters with "…" (`commandSubjectOf`). A tool whose block cannot be written is refused with the builder's problems and sends nothing.
- **Manager instructions:** a `BM-COMMAND` is the owner's word (an option they chose, or the Orchestrator on their authority); act on it as theirs, within its `approved:` and `limits:`; a `copy: yes` block is for context only.
- **Worker instructions:** a `BM-COMMAND` with `to: worker` is the owner's word, from an option they chose or the Orchestrator: follow it within its rules; if it cut a step short, check that step first and report it as interrupted by the Orchestrator, not by the user (Claude shows the replaced turn's tool call as a user rejection; coordination run 2026-09-29, F4).

### 6B.2 Chat cards

Cards v2 (`CHAT_CARD_VERSION` 2, autonomy design §A.12 as built; `client/chat-card-parse.ts` and the `chat-card-*.ts` modules beside it, drawn by `chat-card.tsx`):

- A `BM-COMMAND` block is an **`action`** card in the one card frame: actor → recipient ("Orchestrator → Manager", "Orchestrator → Worker"), the authority ("your word in chat", "your decision", "Policy · <class>"; an older block sent on Autopilot reads "Autopilot (retired)"), the command's `intent` as its chip, the `re:` line and at most three lines of the body, the effects and limits, the raw block under Details. The Worker a block names nothing about is named from the chat's peers (`commandWorkerName`, `soleWorkerOf`).
- The Manager's `copy: yes` of a Worker command, and a `BM-EVENTS` batch in the Orchestrator's chat, are one compact **`notice`** line each: what happened in plain words, with the lines and their ids under Details.
- A `BM-ANSWER` notice is the card of its decision (`decision`, live from the store).
- The Orchestrator's answers to the owner follow its instructions' template (**Situation** / **Done** / **Needs you**), plain markdown.

### 6B.3 Live watch of running Workers

*Since 2026-10-09 (ADR-028; [base design §7.17.8](./paseo-bm.md) (f)):* the `danger` signal reads here-document bodies default-deny — a body written to a file (`cat >`, `tee`) or a driverless stdin script is not SQL that runs; one fed to a database client, a wrapper (`ssh`, `docker`, `kubectl`, a shell) or a script naming a driver is. The role file has the Orchestrator read a danger signal's evidence before a stop, never carry words between projects (they ask each other through peer links, base design §7.17), and leave review budgets to the Worker.

`server/worker-watch.ts`, on the stall pass's timer (§6), for the running Workers of **every** project — the Inbox alerts cost no model call — with the events and the interrupt allowance only for a project in the owner's policy scope (a class `shadow` or `delegate`; autonomy design §A.8):

- A pass every **2 minutes** (non-overlapping; the 60-second stall pass is unchanged) reads, for each running `bm-worker` (at most 5 per pass, the newest; the oldest dropped), the tail of its timeline since its turn started (`readTimelinePages`, ≤ 300 entries), plus its snapshot.
- **How** (`worker-watch.ts`, driven by the stall watcher): the Worker pass rides on the stall watcher's one timer, every second tick, with its own non-overlap flag, and stops with it; with no running Worker nothing is refreshed or read. Per Worker: `agents.ref(id).refresh()` (the snapshot), then at most two pages of 150 entries, newest first; a page that reaches back before the turn start ends the read. The **turn start** is the snapshot's `activeTurn.startedAt`, else its `lastUserMessageAt`; a Worker whose snapshot gives neither, or that is no longer `running`, is not read. The **workspace directory** is the listed workspace's, else the trace store's last known one, else the Worker's `cwd`; unknown, `outside` and the outside-`rm -rf` rule are not judged.
- **Rule details:** `stuck` counts from the newest entry read, never earlier than the turn start, and needs one entry read. `permission` counts from the snapshot's `attentionTimestamp` when its `attentionReason` is `permission`, else from when the watch first saw that pending permission (kept in memory). The tool-call rules look at `tool_call` entries since the turn start, once per `callId` (its first time, its latest state): `danger` at any status, on the command text (`shared/effectful-actions.ts`, the one list the replay's A-6 reads too; `git`/`npm`/`pnpm`/`yarn` flags before the verb allowed; SQL case-insensitive; `DELETE FROM` checked per statement; `rm` needs both a recursive and a force flag, and a target `/`, `~`, `$HOME` or — resolved against the call's `cwd`, else the workspace — outside the workspace; another variable is not judged); `failing` counts shell calls that failed — a `status` of `failed` or `error`, or a non-zero numeric `exitCode` (`shellFailureOf`): Paseo's timeline for a Claude Worker carries no `exitCode`, a failed call is `status: "failed"` with no output (coordination run 2026-09-29, F1) — per normalised command (trimmed, white space collapsed), and a call seen running and then ended counts once, as it ended; a command piped into another (`npm test | tail`) ends as its last part does, so its failure is not seen; `heavy` needs the request's tier (its latest report's) to be Small and a `br create` or an edit/write whose path `isProcessDocumentPath`; `outside` an edit/write on an absolute path.
- Signals (each told to the Orchestrator **once per Worker turn**):

| Signal | Raised when |
|---|---|
| `stuck` | the newest timeline entry is ≥ **10 min** old while the Worker is `running` |
| `permission` | the snapshot shows a pending permission for ≥ **3 min** |
| `danger` | a shell command matching: `git push`, `npm publish`, `pnpm publish`, `yarn publish`, `kubectl (apply\|delete)`, `terraform (apply\|destroy)`, `helm (install\|upgrade\|uninstall)`, `vercel .*--prod`, `docker push`, destructive SQL (`DROP (TABLE\|DATABASE)`, `TRUNCATE`, `DELETE FROM` without `WHERE`), `rm -rf` of `/`, `~` or a path outside the workspace |
| `failing` | the same shell command (normalised) failed 3 times in the turn (`status` `failed`/`error`, or a non-zero exit code) |
| `heavy` | the request's tier is Small and a `br create` or a write under `docs/plans/` or `docs/adr/` appears (`isProcessDocumentPath`) |
| `outside` | an edit/write tool call on an absolute path outside the workspace directory |

- **Where a signal goes** (autonomy design §A.8; missions design §20.3): in the policy scope, or for a Worker of a mission's request at any level, every signal is one `worker.signal` event on the event bus. Only `danger` wakes the Orchestrator (missions design §9.1): in the next `BM-EVENTS` batch (project, Worker, request, signal, redacted evidence, since), dropped when settled first or, for a Worker of no mission, when the project left the scope. A mission Worker's `danger` first goes to its Main as `BM-SIGNAL`, and its event carries `missionId` and, when the Main was told, `backupAt` (the alert + 3 minutes), before which the bus holds it. Every `danger` is one entry of the danger log (`orchestrator/dangers.json`, A-13). `stuck`, `permission` and `danger` are **Inbox alerts** for the owner in every project (`stuck`, `permission-waiting`, `danger`; subject the Worker id, `detail` the redacted evidence ≤ 300 characters), raised once while they hold; `stuck` and `permission` clear when no longer seen, all three at the Worker's recorded turn end or when it stops running; a project leaving the scope keeps its alerts. `failing`, `heavy` and `outside` are events only.
- **The interrupt allowance:** in the policy scope, or for a mission's Worker, a newly raised `danger` alert opens the Worker's allowance for 10 minutes (`openDangerAllowance`, a `…::danger-open@<time>` entry of `stalls.json`; expired ones are dropped at the next opening; `isDangerOpen` is true while `now < opened + 10 min`); the `BM-EVENTS` line then says until when the Orchestrator may interrupt it. The plugin itself never interrupts anyone. An outdated or tool-stale Orchestrator is replaced before it is woken (`wakeableOrchestrator`).
- Cost: one timeline read per watched Worker per 2 minutes; no model call.

### 6B.4 Tools added (Orchestrator endpoint)

| Tool | Input | Behaviour |
|---|---|---|
| `bm_direct_worker` | `{ workspaceId, workerId, requestId?, re, intent: "stop", decisionId?, command, why?, interrupt: true }` | Stops a Worker at once (missions design §9.1): only `intent: stop` with `interrupt: true`, no effect, while a `danger` of that Worker is open or a family of its mission stands at the governor's stop step. Authority `stopAuthorityOf` (§6A), the backstop (§6B.5) and the loop guard. Target: a non-archived `bm-worker` of that workspace (never a Reviewer). `agents.ref(workerId).send` replaces its turn; its Main (else its Manager) gets the same block with `copy: yes` through the queue. Records the command (`to: "worker"`) |
| `bm_repo` | `{ workspaceId, action: "status" \| "diff-stat" \| "log" \| "show", path?: string, file?: string }` | Runs `git` read-only with `execFile` (no shell) in the workspace directory or a sub-directory `path` inside it (refused if it escapes): `status --short --branch`, `diff --stat` (plus `--cached`), `log --oneline -20`, `show HEAD:<file>` or the working-tree file (≤ 200 KB). Output redacted, capped at 20,000 characters, 10-second timeout, `GIT_TERMINAL_PROMPT=0`, no network command |
| `bm_note` | `{ workspaceId, text, replace?: boolean }` | Per-project notes in `orchestrator/notes/<ws>.json`: at most 20 notes of ≤ 500 characters (oldest dropped); `replace` empties first. `bm_projects` returns each project's notes |

`bm_ask_owner`'s options (at most 5, 1–80 characters each, with their effects and an optional prepared command) are one button each on the decision card, in the Inbox and in the chats (autonomy design §A.12).

Notes (`orchestrator-store.ts` `readNotes`, `appendNote`): each note is `{ at, text }`, `text` trimmed and 1–500 characters (else refused, and nothing is written — `replace` included), kept oldest first; the file is `{ version: 1, entries }`, `0600` in a `0700` `notes/` folder, written atomically; a note that does not validate is skipped on its own. Notes are the Orchestrator's memory of a project, not an excerpt of one request: `traces.delete` leaves them, as it leaves the command log; cleanup deletes them with `orchestrator/`.

Decided in implementing (bead ouuu.3):

- **`bm_direct_worker`.** Checks, in this order, each refusal sending and recording nothing: the target is a non-archived `bm-worker` of the workspace by `agents.list` (a Reviewer, Manager, the Orchestrator or another provider's agent: "is not a paseo-bm Worker"); only a stop at once (`intent: stop`, `interrupt: true`), while a `danger` of that Worker is open or a family of its mission stands at the stop step (missions design §9.1); the authority (`stopAuthorityOf`, §6A; refused with "<class> is not delegated in this project and the owner has not just told you to stop it; ask the owner with bm_ask_owner, and once the owner has answered, stop it with that decisionId"); the block, the gate and the cap (`checkedCommand`). The copy goes to the Worker's Main (the registry's `managerId` for a mission's request), else the agent that created it (`paseo.parent-agent-id`) when that is a non-archived `bm-manager` of the same workspace. The Worker is served first — the queue's `command:<id>`, or with an interrupt `agents.ref(workerId).send` at once — and a Worker that cannot be reached is refused, with no copy sent; then the copy goes to its Manager through the queue under the same kind. A Worker with no such Manager gets the command without a copy (the answer says so) and is recorded with `managerId: null`; a copy that cannot be delivered is said in the answer. Recorded `sent` with `to: "worker"`, `workerId`, `outcome` of the Worker's delivery, `situation`/`command`/`reason` as §6B.1. Answers `{ commandId, outcome, interrupted, managerId, copy: "sent" | "queued" | "failed" | null, authority, approved }` (there is no `source` field: every command is `chat`).
- **`bm_repo`.** The folder is the one `workspaces.list` gives for the workspace, else the trace store's `lastKnownDirectory`; the project must be a paseo-bm project (`requireProject`). `path` is resolved from that folder through symlinks (`realpath`) and must stay inside it, be a folder, and not be inside `.git`. `show` needs `file`: `HEAD:<path>` runs `git show --no-textconv HEAD:./<path>` (relative to `path`), a plain `<path>` reads the working-tree file; either is refused when it leaves the folder (a working-tree file also after `realpath`), lies inside `.git`, or has a name that marks a secret (`.env*`, `.envrc`, keys and certificates such as `*.pem`/`*.key`/`id_rsa`, `.npmrc`, `.netrc`, `.git-credentials`, `credentials*`, `secret*`); a working-tree file must also be a regular text file of at most 200 KB that git does not ignore (`git check-ignore -q`). The commands: `status --short --branch`; `diff --stat --no-ext-diff --no-textconv`, then the same with `--cached` (shown as "Not staged" / "Staged"); `log --oneline -20 --no-decorate`. Every one starts with `--no-pager -c core.fsmonitor=false -c color.ui=false -c core.quotePath=false` (`GIT_READ_ONLY_PREFIX`) and runs with `execFile` (no shell) in an environment without `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` and with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (so `status` does not refresh the index), `GIT_NO_LAZY_FETCH=1`, a 10-second timeout and a 200 KB output buffer. A failure is a refusal naming it (git missing, the timeout, the output too large, or git's first error line, redacted). The answer is a title line, then the output redacted and cut to 20,000 characters.
- **`bm_note`** answers "Noted. …" with `{ workspaceId, notes: <count>, replaced }`; `bm_projects` gives each project `notes: [{ at, text }]`, oldest first, redacted (none when unreadable).
- **`bm_ask_owner` options** are trimmed with whitespace collapsed; an empty list stores none.
- **The first-prompt check** (`isOwnerWord`, `orchestrator-agent.ts`) matches the opening words every version's first prompt shares (`ORCHESTRATOR_FIRST_PROMPT_START`, §3.3), so an older Orchestrator's first prompt, with another opening line or tool list, is never the owner's word.

### 6B.5 The big-decision gate

`shared/decision-gate.ts` `gateOf(text) → category[]`, applied by `bm_govern`, `bm_arbitrate` and `bm_direct_worker` to the Orchestrator's own words (`re` + body, never the header or a mission's name; missions design §17). It is a **backstop**, not the authority (autonomy design §A.7): a category it finds that the command's declared effects do not cover refuses the command with "declare the effect or ask the owner with bm_ask_owner" — never a silent send (`undeclaredCategoriesOf`). Categories and patterns (case-insensitive, English and Vietnamese):

| Category | Patterns |
|---|---|
| `security` | security, permission, authoriz, authenticat, login-as, impersonat, token, secret, password, credential, bảo mật, phân quyền, đăng nhập hộ, mật khẩu |
| `release` | push, deploy, publish, release, production, prod, merge into main, triển khai, phát hành |
| `data` | drop table, truncate, delete from, migrate, migration, real data, production data, xoá dữ liệu, dữ liệu thật, cơ sở dữ liệu thật |
| `cost` | billing, cost, price, pricing, paid, subscription, chi phí |
| `dependency` | npm install, pnpm add, yarn add, add a dependency, new dependency, license, thêm thư viện |

A match preceded within 4 words by a negation (not, no, never, don't, do not, without, stop, avoid, không, đừng, chưa, cấm, dừng, tránh) does not count. Nothing else silences it: `gateOf(text)` and `undeclaredCategoriesOf(text, effects)` take no allowed categories, and every project is gated on every category.

**The stop of a dangerous Worker** has no exemption: a stop that names the dangerous command un-negated ("how many git push runs you made") is refused like any command, even while that Worker's interrupt allowance is open; a stop whose stop word negates what it stops — "Stop the push" — passes, as any negated mention does. Allow… (the categories the owner once allowed per project) and the stop exemption of the coordination run's finding F2 were retired with Autopilot (autonomy design §B.8); the old text is in git.

Matching details (`gateOf(text)`, with `gateMatchesOf` for the evidence): the text is compared lower-cased in Unicode NFC; a term matches only on word boundaries (no letter, digit or `_` right before or after it — "product" is not "prod", "prepaid" is not "paid"), with its listed inflections ("pushed", "deployment", "credentials", "migrating"; `authoriz`, `authenticat`, `impersonat` take any ending) and both Vietnamese spellings `xoá`/`xóa`. The negation window is the 4 words before the match **in the same sentence** — it stops at `.`, `!`, `?`, `;` or a line break, so "Do not deploy. Push the fix." still gates the push; "don't" with a straight or curly apostrophe is one word. The result lists each category once, in the table's order (`GATE_CATEGORIES`).

Any category the declared effects do not cover refuses the command (`undeclaredRefusalOf`: "the text shows <category> that effects does not declare: declare the effect or ask the owner with bm_ask_owner") — the command is not sent, recorded or spent. The gate runs after the target and authority checks and before the loop guard (`checkedCommand`), on the `re:` line (the defaulted one included) and the body, for every command the Orchestrator sends itself. A prepared command the owner picked is not checked again: the backstop checked its text against its effects when it was asked.

### 6B.6 Fresh Orchestrator after a day

`wakeableOrchestrator` also replaces a current Orchestrator when its load calls for it, it is idle, and the newest owner message in its chat is older than 2 hours (missions design §20.2, ADR-032 decision 3). Its load calls for it when its wakes in `wakes.json` name 4 missions, or number 10, or it was created more than 24 hours ago. The new one needs nothing from the old conversation: each wake's brief carries its mission's figures, notes and governor journal, and `bm_missions` the rest.

Decided in implementing (bead ouuu.3, `dayOldReasonOf`; `loadReasonOf` since ADR-032):
- "older than 24 hours" is its `createdAt` (unknown: no age reason);
- "idle" is a listed status other than `running` or `initializing` (unknown: kept);
- its chat is read (5 pages of 200 entries) only when both a load reason and idleness hold;
- the owner's messages are those `isOwnerWord` accepts: none in what was read counts as silence, one without a time counts as just now, and a chat that yields no entry keeps the Orchestrator.

The replacement is `orchestrator.open`'s creation, shared with any in flight, and only while the old one is still the newest (`retire`), so two wake-ups, or one holding an older list, create one agent. The log line gives the reason ("has governed N missions", "has carried N wakes", "is more than a day old"). The old one is never archived or messaged.

**Older Orchestrators are retired** (delivery line design §8.5, `retireOlderOrchestrators`). When more than one agent carries `bm.orchestrator=main`, every older one is relabelled `bm.orchestrator=retired` and retitled "Beads Orchestrator (retired)". The title is set first, so a failed relabel retries both at the next pass. This runs:
- at the first Paseo handle of a run;
- at `agent.created` of a `bm-orchestrator` agent, counted even before the list shows it.

It is idempotent. Nothing is archived, stopped or messaged (ADR-005). The owner's 2-hour rule reads `newestOwnerWordOf`, which `ownerWroteRecently` also uses for the step-4 gate (§6A).

### 6B.7 A project's facts in `orchestrator.state`

`orchestrator.state` returns `{ agent, previousCount, toolsStale, outdated, projects }` (§8); what the retired screen alone read is gone (autonomy design §A.14). The Projects rows read `projects` (autonomy design §A.12): per project `state`, `health: "ok" | "waiting" | "risk" | "idle"`, `stage: "idle" | "received" | "implementing" | "reviewing" | "waiting-user" | "finished"`, `workPhase` (the phase of the newest request's last report that names a stage, `blocked` skipped, or null; `workPhaseOf`), `agents { manager, workers: [], reviewers: [] }` with statuses, `lastProgressAt`, `currentRequest { requestId, title }`, `openSignals: [{ signal, workerId, since }]`, `notes` and `lastAction`. The per-project fields past the first design's are optional, so an older reader or server still parses. There is no `autopilot`, `allow` or `assessment` field (retired, §6A, §5.5); the owner's policy is read with `autonomy.policy`.

How `handleOrchestratorState` computes them (`orchestrator-state.ts`), from one read of agents, workspaces, the stores and the open Inbox alerts:

- **Projects:** workspaces with activity in the last 7 days, at most 30, newest activity first; `requests` counts their requests with activity in those 7 days.
- **`state`:** `running` when a paseo-bm agent of the workspace runs, else `stalled` with an open `request-stalled` alert (§6), else `waiting-user` when its newest request's last report is `blocked`, else `idle`.
- **Current request:** the project's newest request with activity in the last 7 days. `currentRequest` is its request id (its trace id when it has none) and the redacted first line of its text (`firstLine`, null when the text was not recorded); `lastProgressAt` is the later of its newest turn end and its last report.
- **`agents`** (`projectAgentsOf`): the project's Manager, and of Workers and Reviewers the non-archived ones that belong to the current request, run now, or carry an open signal — at most 10 each, running ones first — each `{ id, title, status }`. Never every Worker the project ever had.
- **`stage`** (`stageOf`): no current request → `idle`; a Reviewer running → `reviewing`; a Worker running → `implementing`; else from the last report: `blocked` → `waiting-user`, `finished` → `finished`, `documents-done` / `beads-done` / `bead-implemented` → `implementing`, `received` or none → `received`.
- **`health`** (`healthOf`): an open stall or open Worker signal → `risk`; else the stage `waiting-user` → `waiting`; else an agent running or the stage `received` / `implementing` / `reviewing` → `ok`; else `idle`.
- **`openSignals`**: the project's open `stuck`, `permission-waiting` and `danger` Inbox alerts, read as the signals `stuck`, `permission`, `danger` (§6B.3), `since` = when raised. **`notes`**: the project's notes, oldest first (`readNotes`).
- **`lastAction`**: the newest command of the project in the command log (§5.4) — when it was sent, the `re:` line of its block (else its first line) and its `source` — or null.

## 7. Delivering commands (REQ-076)

- **One pipeline:** every command below leaves through `sendCommand` (`server/command-send.ts`), in this order: the block, the backstop (commands the Orchestrator sends itself), the loop guard, the interrupt check (and a handoff only while Settings → Coordination has handoff on, autonomy design §G.6); delivery; then the command recorded (§5.4), its intervention logged (autonomy design §G.3) and the Worker's Main copied. No command claims or spends a grant (ADR-031). A refusal sends and records nothing; nothing after delivery fails the send.
- **The Orchestrator's own commands:** `bm_govern`, `bm_arbitrate` and `bm_direct_worker` deliver their `BM-COMMAND` block (§6B.1) through the notice queue under a kind of its own per command, `command:<id>`, so two commands never replace each other: sent at once when the agent is idle, at its turn end when it runs (a Worker's stop, §6B.4, is the one exception). Each is recorded in the command log (§5.4) once delivered. No command spends a grant (ADR-031).
- **The owner's option on an Orchestrator decision** (`decisions.answer`, from the Inbox or a decision card; `server/orchestrator-decisions.ts`, autonomy design §A.6): an option with a prepared command is delivered by the plugin itself, once, as a `BM-COMMAND` `from: orchestrator`, `via: tab`, `authority: decision:<id>`, `approved: none` (ADR-031, `preparedCommandOf`), to the mission's current Main. An answer in the owner's own words, or an option without a command, goes to the Orchestrator as a `BM-ANSWER` notice that names no grant; a prepared command that could not be delivered says so in the same `BM-ANSWER`.
- **They read as the owner's:** the notice queue sends through `agents.ref(id).send(text)`, which records the message with `clientMessageId` like the app (Base design §7.5); the text is a `BM-COMMAND` block, which the Manager's and Worker's instructions read as the owner's word.
- **Talking to the Orchestrator** is the owner's own message in its chat; nothing of the plugin sends it the owner's words but a `BM-ANSWER`.
- A queued command is lost if the plugin reloads before the target's turn ends (the queue is in memory, as for every notice); it stays recorded with `outcome: "queued"` (accepted limit).

## 8. RPC

| RPC | Input | Output |
|---|---|---|
| `orchestrator.state` | `{}` | `{ agent: { id, status, workspaceId, createdAt? } \| null, previousCount?, toolsStale: boolean, outdated: boolean, projects: [{ workspaceId, workspaceLabel, managerId, managerTitle, managerStatus, state: "running" \| "waiting-user" \| "stalled" \| "idle", lastActivityAt, requests, health?, stage?, workPhase?, agents?, lastProgressAt?, currentRequest?, openSignals?, notes?, lastAction: { at, text, source } \| null }] }` (§6B.7). Reads only; `agents.list` and `workspaces.list` once, each workspace store once (mtime cache) |
| `orchestrator.open-preview` | `{}` | `{ exists, provider, model, workspace: "own" \| "choose" }` |
| `orchestrator.open` | `{ confirmed: true, workspaceId?, recreate?: true }` | `{ agentId, created }` — `recreate` replaces an Orchestrator that lost its tools or is outdated (§3.3, §5.1) |

- **Retired:** the RPCs of the retired screen (the Watch switch's settings, the approve, dismiss and typed-command RPCs of proposals, the question box, the Assess-workflow button; autonomy design §A.14) — the owner asks the Orchestrator in its chat and answers its decisions in the Inbox; `orchestrator.set-autopilot` with Autopilot (§6A) — the owner's policy is set with `autonomy.set`; `orchestrator.apply-suggestion` with `bm_assessment` (§5.5).
- **Error codes:** `E_ORCHESTRATOR_WRITE_FAILED`, `E_ORCHESTRATOR_UNAVAILABLE`; an unreadable store (`orchestrator.state`) or a data folder that cannot be created (`orchestrator.open`) answers `E_DATA_HOME_UNAVAILABLE` (base design §8). The codes of the retired RPCs left the registry, since nothing raises them: `E_SUGGESTION_TOO_LONG`, `E_ROLE_EXTRA_CHANGED`, `E_AUTOPILOT_NOT_CONFIRMED`, and the first design's `E_ASSESS_UNAVAILABLE`, `E_NUDGE_NOT_CONFIRMED` (§11).

## 9. Opening the Orchestrator from the Inbox (REQ-071, autonomy design §A.12)

There is no Orchestrator screen: the owner decides in the **Inbox**, follows projects and reads their figures in **Projects** (a project's Metrics), sets autonomy and the agents up in **Settings** and sees the tools in **Tools & skills** (autonomy design §A.12, change-014), and talks to the Orchestrator in its chat. The Inbox's first line is the way into that chat (`client/orchestrator-line.tsx`, its words from `orchestratorLineView` in `client/orchestrator-model.ts`). It reads `orchestrator.state` once when the Inbox shows (the same query the Projects rows poll), never polls it itself:

| The state says | The line shows | A press |
|---|---|---|
| no Orchestrator | "Beads Orchestrator — not open" · **Start the Orchestrator…** | `orchestrator.open-preview`, then the Open dialog in place — the provider and model, the cost sentence "Reads the work of every paseo-bm project on this machine; uses tokens.", Cancel first — and only its confirm calls `orchestrator.open { confirmed: true }` and opens the chat |
| a current one | "Beads Orchestrator — running" (or "idle") · **Orchestrator chat ▸** | opens its chat with `navigation.openAgent` |
| `toolsStale` or `outdated` | the same title, the reason ("… has lost its tools." / "… runs on older instructions than this paseo-bm.") · **Start a new Orchestrator…** | the recreate dialog (Cancel first; "The old one stays in your agent list") → `orchestrator.open { confirmed: true, recreate: true }` |

While an Orchestrator younger than 24 hours has replaced an older one still in the owner's list, the line adds "New Orchestrator since <time> ago — the old chat is no longer used." (`replacedLine`). On a host that cannot open an agent from a plugin it says "The Orchestrator is ready. Open Beads Orchestrator from your agent list."; a failure is said on the line. The outdated and tool-stale Orchestrators are also replaced without the owner at their next wake-up (§3.3).

## 10. Security and boundaries (REQ-074, REQ-079, REQ-080)

- **Only paseo-bm's agents:** data comes from the trace store, `agents.list` filtered to `bm-*` providers, and the timelines of those agents only.
- **What reaches a working agent:** a Main receives only the prepared command of an option the owner picked (§7), `bm_govern` and `bm_arbitrate` commands (no effect, ADR-031), the copy of a `bm_direct_worker` stop, and the plugin's `BM-SIGNAL` of its Worker's `danger` (missions design §20.3); a Worker receives only a `bm_direct_worker` stop (§6B.4). Every one is a `BM-COMMAND` block from the Orchestrator with its limits (§6B.1); the Orchestrator's own pass the backstop (§6B.5). Nothing sends to a Reviewer. `bm_repo` runs read-only git and writes nothing.
- **What reaches the Orchestrator:** the owner's messages in its chat, `BM-EVENTS` (`decision.opened` by its own rule; `request.finished`, `request.stalled`, `worker.signal` only for a project in the policy's scope; autonomy design §A.8) and `BM-ANSWER` (the owner's answer to one of its decisions, §7).
- **What the plugin reads live:** the Worker watch (§6B.3) refreshes and reads the timeline of running `bm-worker` agents only — of every project, for the Inbox alerts — and nothing at all with no running Worker.
- **No other action:** no `archive`, `cancel`, `stop`, `delete`; no config write outside role creation; no instruction writes (`apply-suggestion` retired, §8); workspace creation only for the Orchestrator's own home (§3.3).
- **Endpoint:** the path secret (§5.1); tools answer only with redacted content.
- **The Orchestrator itself:** no Paseo agent tools; read-only by instructions and the Reviewer's mode rule; it keeps its provider's own tools, as the Reviewer does.
- **REQ-047** of the Dashboard PRD is amended: the exceptions are creating the Orchestrator agent and its workspace, delivering a command the owner chose on a decision, approved in the Orchestrator's chat or delegated by the owner's autonomy policy (autonomy design §B.8) — to a Manager, or directly to a Worker with a copy to its Manager (ADR-016) — recording the Orchestrator's notes, and waking the Orchestrator (`BM-EVENTS` of the projects in the policy's scope, the owner's answers).

## 11. The first design: what is kept, what is removed

The first design (ADR-013: rule flags, a turn-end nudge, workflow assessment) never shipped. What is left of it: the role `bm-orchestrator` with its card and cleanup (§3.1), the rules as signals (§4; one rule left), `language-guess` (§4.2), `rule-input` and `request-trace`, the content builder now `request-render.ts` (§5.2), and two Dashboard corrections — `workerInitialPrompts` ignoring plugin notices, and the P1 fix of trace grouping. Removed: `nudge.ts` and every `BM-NUDGE` text and marker, the first design's RPCs (`flags`, `flag-counts`, `overview`, `settings`, `assess-preview`, `assess`, `assessments`) and its Metric additions (REQ-071 f); its screen gave way to ADR-014's tab, itself retired (autonomy design §A.14). Later retirements are in §4.3, §5.5, §6A and §8. No data migration is needed beyond reading an old `settings.json` as the default. The full table is in git.

## 12. Testing

| Layer | Content |
|---|---|
| Pure | Stall reasons on fixtures (each raised; a healthy running request raises none; cleared and raised again); the Orchestrator line's model (`orchestratorLineView`: start, open, restart with its reason, the replaced line) and its hook-free row; the Orchestrator's instructions (`roles-content`) |
| Server with a fake SDK | `open`: creates once, reopens the same agent, labels and mode, `E_ORCHESTRATOR_UNAVAILABLE`, the workspace path and its fallback; tools: secret required, `bm_agent_messages` refuses a non-`bm-*` agent, `bm_send_command` and `bm_direct_worker` refused without authority, one delivery through the queue each, recorded in the command log with their source, a running Manager gets it at turn end; `orchestrator.state` answers only the agent and the projects, and reads a data folder with the proposal era's entries as if they were not there (`test/retired-data-files.test.ts`); the stall pass once per stall, an Inbox alert, an event only for a project in the policy's scope; the Worker watch's `failing` on Claude's entry shape (`status: "failed"`, no `exitCode`); `bm_direct_worker`'s stop of an open danger gated like any command (a stop word before what it stops negates it); no tool or RPC switches Autopilot, and an earlier build's `settings.json` authorises nothing; the loop guard refuses the 13th command for a request in 24 h and sends nothing |
| Negative (REQ-079 e, O-2 → O-4, REQ-083 → REQ-086; `test/orchestrator-boundary.test.ts`) | Across every path: no `send` to a Main but a prepared command the owner picked, a `bm_govern` or `bm_arbitrate` command, a stop's copy or a `BM-SIGNAL`; to a Worker only `bm_direct_worker` on the owner's policy or right after the owner's word, every block it gets copied to its Manager, and a running Worker's turn replaced only while its danger allowance is open; never a Reviewer; a gated command sends and records nothing, a negated mention passes, no category is allowed and a stop naming the push un-negated is gated even while the Worker's danger allowance is open; `bm_repo` stays in the folder and a real repository is unchanged byte for byte; the Worker watch refreshes and reads only running `bm-worker` agents; a project whose classes are all `owner` → no finished, stalled or Worker-signal event for the Orchestrator, a stall only an Inbox alert; no Orchestrator agent and no token before the owner starts it; no `archive`/`cancel`/config write; no read of a non-paseo-bm agent; every RPC and tool covered; the mutants run against it are listed in its header |
| Acceptance | Isolated daemon, `scripts/manual-test/` §5 (written for the autonomy policy): the Orchestrator opened in its own workspace and reading a project; a delegated class — the Orchestrator decides a Worker's question with `bm_decide` and moves a finished request on with `bm_send_command`; an undelegated one — it asks the owner with `bm_ask_owner`, sends after the owner's "Send it." in the chat (source `chat`), and a prepared command goes out when the owner picks its option (`decisions.answer`); ADR-016 — a running Worker's `git push` raising `worker-signal danger`, the Orchestrator's direct Worker command with an interrupt and the Manager's copy as `BM-COMMAND` blocks, `bm_repo` verifying a claim, the project facts of `orchestrator.state`; cleanup. The Phase 2 live check ran 5.3's decision part; 5.4 and 5.7 as written for the policy have not run on a daemon yet. The coordination part last ran in the 2026-09-29 coordination run, whose findings F1 (`failing` never raised on Claude) and F2 (the gate held a stop naming the dangerous command) were fixed after it and are covered by the tests above. Run records in `docs/archive/operations/` |

## 13. Open questions

Answered: Q-077 (the Orchestrator's own workspace, §3.3) and Q-078 (the workflow assessment's scope, moot since `bm_assessment` was retired, §5.5).

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-075 | Snapshot signals when a request ends | hieu.nt10 | deferred |

## 14. Revision History

Rows up to 2026-10-02 are archived in [paseo-bm-orchestrator-revision-history-to-20261002.md](../archive/design/paseo-bm-orchestrator-revision-history-to-20261002.md); git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-04 | Codex (owner request) | Require a real tool-call failure before a fresh Orchestrator may report a named `bm_` tool unavailable |
| 2026-10-02 | Claude (owner request) | Documentation restructure: earlier rows moved to the archive; stale, retired and duplicated content condensed to the current state (section numbers and REQ ids kept) |
| 2026-10-09 | Claude (owner's delegation) | §6B.3: the danger signal's here-document reading and the role file's peer-link and review-budget lines (ADR-028) |
| 2026-10-10 | Claude (owner's decision) | `bm_predict` retired (missions design §19): a note where this document first names it |
| 2026-10-10 | Claude (owner's request: every recommendation of the assessment) | ADR-032 and the governor's present shape: §2 banner, diagram and modules; §3.2 the governor's file; §3.3 the README and first prompt; §6A rewritten (governor events, a mission per wake, `effects: none` authority, the loop guard per mission, retired tools); §6B.1 `bm_govern`/`bm_arbitrate` row; §6B.3 a mission Worker's `danger` to its Main first, the danger log; §6B.4 `bm_direct_worker` stop only; §6B.5 the gate's tools; §6B.6 a fresh Orchestrator after 4 missions, 10 wakes or a day; §7 no grant (ADR-031) |
| 2026-10-20 | Claude (as built, ADR-035 Phase 6) | §6A loop guard: four pools per mission, the spent-pool text, the step-4 gate on `bm_ask_owner`; §6B.6 older Orchestrators relabelled `retired` (delivery line design §8) |
