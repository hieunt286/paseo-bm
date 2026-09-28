# paseo-bm — Orchestration Dashboard (Technical Design)

| Field | Value |
|---|---|
| Status | **Active** — gate `design-ready` PASS 2026-09-16 |
| Living document | From 2026-09-25 this document is **edited in place** and always describes the current state; each edit adds one Revision History line, and git is the audit trail. The old deltas merged into it remain only as historical records (the [History](#history) table) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| Requirements source | [Orchestration Dashboard PRD](../product/paseo-bm-dashboard-prd.md) (REQ-040 → REQ-069); REQ-059 (question card) lives in the [base PRD](../product/paseo-bm-prd.md) |
| Base design | [paseo-bm — Technical Design](./paseo-bm.md) — this document **extends** it: the install home, roles, instructions, fallback and slash commands are there |
| Related ADRs | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (trace store) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) (the agent lifecycle belongs to the user) · [ADR-006](../adr/ADR-006-role-registration.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (the plugin is the whole product; machine setup on Setup) |
| Reference environment | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0; Paseo CLI/daemon 0.8.0; Node ≥ 22. **(0.4.0)** Paseo ≥ 0.9.0 |

## 1. Scope

**This document owns:**

- the trace store (location, layout, schema, writing, reading, deleting, reassigning, measuring size) and the collector hooked on lifecycle hooks;
- how a trace is built per request, the `BM-REPORT` / `BM-REVIEW` / `BM-QUESTIONS` / `BM-ANSWERS` readers, how time is measured, how state is inferred, how errors are counted, how the feature-workflow step is inferred, how tokens and cost are computed;
- the `.beads/issues.jsonl` reader and the actions that hand out work from the Beads screen;
- every client screen of the plugin: the "Beads Manager" surface (Setup including the "Roles & models" screen, Workspaces, Metric, Beads), the "Beads" tab and the header button, chat cards, the question card, the fallback incident card, the waiting-question pill and the fallback pill, the "Beads in this chat" and "Beads agents" panels;
- the RPCs that feed the above (§5) and their error codes.

**Does not own** (they are in the [base design](./paseo-bm.md) or its still-living deltas): the content of `plugin/roles/*.md` (including the rule for the Worker writing `BM-QUESTIONS`, how the Manager relays answers, the `bm.requestId`/`bm.batchId` labels); the installer and the CLI (including `--install-beads-tools`; **(0.4.0)** the migration CLI); the install home layout (**(0.4.0)** the data folder, `setup-state.json`); the server contract, write rules and error codes of machine setup (`setup.ensure-roles`, `setup.grant-agent-tools`, `setup.install-skills`, `setup.cleanup`, the `setup` field of `setup.status` — base design §7.13); how agents are created and the `agent.create` hook; `manager.ensure`, `agents.list`, `roles.describe`, `agents.stop-all`; the server contract for role, model and fallback settings (`roles.settings`, `roles.options`, `roles.save-settings`, `roles.save-fallback`, `fallback.*`, the incident detection and handling rules); the question–answer ledger (qa-ledger); the plugin's agent tools (ADR-010); the two slash commands `/bm-worker-new` and `/bm-worker-stop-all`. This document only describes where those parts show up on screen.

## 2. Architecture

### 2.1 Modules

```
plugin/
  index.client.tsx            registers surface, sidebar, Command Center, settings screen,
                              2 timeline transformer + 1 renderer, 3 workspace panel,
                              header button, composer pill
    client/launcher.tsx         surface "Beads Manager": view picker, status strip, Workspaces list
    client/setup-screen.tsx     Setup screen (the surface's main screen), three tabs, "Roles & models"
    client/dashboard.tsx        Metric screen    client/dashboard-actions.tsx  delete / reassign trace
    client/beads-screen.tsx     Beads screen (kanban, filters, detail, actions)
    client/beads-tab.tsx        workspace panel "Beads" with two sub-tabs
    client/beads-header-button.ts  "Beads" button on the workspace header
    client/tree.tsx             panel "Beads agents"     client/agent-tree.ts   its logic
    client/chat-card.tsx        chat card, question card, fallback incident card (rendering)   client/chat-cards.ts   pure logic
    client/bead-chips.tsx       bead chips on cards, detail pane, panel "Beads in this chat"
    client/waiting-pills.tsx    composer pill           client/waiting-pills-model.ts
    client/answer-state.ts      "answered" state within the app session
    client/ui.tsx               shared views, no hooks
    client/*-model.ts, dashboard-view.ts, launch-manager.ts, slot.ts   pure logic
    client/settings.tsx         storage threshold settings screen
  index.server.ts
    server/collector.ts         turn_started / turn_ended hooks → write the trace
    server/trace-store.ts       read/write/delete/reassign/measure the store; path checker; mutex
    server/install-home.ts      find the install home; constant UI_DIR_NAME = "ui"
    server/traces.ts            build traces, split segments, status, count errors
    server/workflow-steps.ts    feature-workflow steps    server/cost.ts   token → cost
    server/beads-store.ts       read .beads/issues.jsonl  server/bead-work.ts   who is working on a bead
    server/bead-actions.ts      beads.list/get/action     server/shell.ts   br read commands
    server/dashboard-rpc.ts     RPCs for Metric, Beads, Workspaces
    server/chat-rpc.ts          chat.peers, chat.beads, beads.lookup
    server/chat-peers.ts        peersOfWorkspace, workspaceRecordsReader
    server/chat-waiting.ts      chat.waiting              server/answer-marks.ts  answers.mark(s)
    server/live-timeline.ts     readTimelinePages (shared)
    server/setup-rpc.ts, setup-tools.ts, setup-skills.ts, role-extras.ts   Setup screen
    server/setup-roles.ts, setup-machine.ts, setup-state.ts, data-home.ts   (0.4.0) machine setup, base design §5, §7.13
  shared/contracts.ts           Zod contracts for every RPC
  shared/bm-report.ts           BM-REPORT/BM-REVIEW parser (server/bm-report.ts only re-exports)
  shared/bm-questions.ts        BM-QUESTIONS/BM-ANSWERS parser/composer
  shared/bead-ids.ts, sole-worker.ts, order.ts, prices.ts, settings.ts
```

The common pattern: every decision lives in a pure module (no React, no React Native), testable without a renderer; `.tsx` only wires and draws. A server module receives a narrow, injectable window onto `PaseoApi` and onto the file system.

### 2.2 Three foundational decisions

1. **Collect on events, catch up on open.** The collector hooks `on("agent.turn_ended")` (and `turn_started` to get the start time) of `bm-*` agents and writes straight to the store. This is an event hook, not a cron, a watcher or a background loop. A **running** turn is caught up from the timeline when the user opens the screen.
2. **A durable trace that the user can delete** (ADR-007). The agent lifecycle belongs to the user (ADR-005): if the trace were only derived at read time, deleting a Worker would lose the history. The cost (writing conversations to disk) is paid for with: masking secrets before writing, `0600` permissions, and an explicit delete path.
3. **When unsure, say unknown.** Every inferred number carries a certainty (`exact` / `inferred` / `unknown`) shown in the interface.

### 2.3 Data flow

```
AGENT RUNS
  hook turn_started(bm-*)  → record the turn's start time (in memory)
  hook turn_ended(bm-*)    → timeline.refetch for timestamps → redact secrets → append one line to
                             <install home>/traces/<workspaceId>/events-<YYYYMM>.jsonl

USER OPENS A SCREEN
  traces.list / traces.get      trace store + agents.list (+ timeline backfill for running turns)
  beads.list / beads.stats      <workspace>/.beads/issues.jsonl (cache mtime+size)
  chat.peers / chat.waiting     agents.list + Manager timeline + trace store when labels are missing
```

`traces.list` does not read the timeline when every trace of the page is already finished in the store — which is what keeps D-1 (≤ 3 seconds) when the store is large.

### 2.4 Common rules for the client

- React Native primitives only; every color comes from the theme via `toneColor(theme, tone)`, `Tone = "muted" | "plain" | "info" | "warning" | "danger" | "success"` (`plain` = `foreground`, `muted` = `foregroundMuted`, `info` = `accent`, the other three tones are `status*`). No hard-coded color codes, no alpha channel spliced into a color string: tinting is done with an absolutely positioned overlay `View` with `opacity`.
- Interface text is in English; everything pressable has an accessibility label; usable at `layout.compact` (padding 12 instead of 24).
- Shared drawing code is **hook-free views** in `ui.tsx` (`WorkspaceScreenHeader`, `BeadRowCard`, `StatusTabs`, `KanbanBoard`, `StatCards`, `BarChart`, `Chip`, `RoleMark`, `RoleLegend`), so that `test/helpers/element-tree.ts` can build the tree without a renderer.
- State that survives a component unmount but not an app reload lives in a module, read with `useSyncExternalStore`: `createSlot<T>()` (`slot.ts`), `createSessionToggle`, `createSessionMap` (`beads-model.ts`), `answer-state.ts`. State that must survive a reload lives on the server, in `<install home>` (**(0.4.0)** the data folder, base design §5.1).
- No background polling, except the deliberate intervals: the Workspaces list 10 s (only while shown), `chat.waiting` 15 s, the header button 15 s, the "Beads in this chat" panel 15 s, the "Beads agents" panel 5 s, the fallback incident card 15 s (only while the incident is `pending`/`waiting`).

## 3. Trace store

### 3.1 Finding the install home

The server bundle has no cwd and cannot read `import.meta.url`, yet must honour `--home` / `PASEO_BM_HOME`. The order today, stopping at the first step that succeeds:

1. `paseo.config.get()` → `config.plugins["paseo-bm"]` is `{ source: "directory", path }` with `path` = `<install home>/plugin/<version>`, so `<install home>` = `dirname(dirname(path))`.
2. Confirm with `<install home>/install.json` having a readable `schemaVersion`. No match → step 3.
3. Fall back to `~/.paseo-bm`. Still no `install.json` → tracing is **off**, with a notice; the beads reading still runs.

`install.json` is only read, never written.

**(0.4.0)** Replaced by `resolveDataHome()` of base design §5.1: `PASEO_BM_HOME` → the pointer `~/.paseo-bm/home.json` → `~/.paseo-bm`; the plugin **creates** the folder itself (`0700`) on the first write and no longer reads `install.json`. Tracing is off only when `resolveDataHome` returns `home: null` (an unsafe folder, a broken pointer); the reason shows in the Metric notice as today and in the "This install" block of Setup (§11.3). Every `<install home>` path in this document reads, from 0.4.0, as `<data folder>`.

### 3.2 Layout

```
<install home>/traces/                     0700
  meta.json                                0600   { schemaVersion, createdAt, updatedAt }
  <workspaceId>/                           0700
    meta.json                              0600   { lastKnownName, lastKnownDirectory, lastSeenAt }
    events-202609.jsonl                    0600   append-only, one record per line
<install home>/ui/                         0700   UI state that must survive a reload
  answer-marks.json                        0600   (§15.6)
<install home>/role-extras.json            0600   (§11.3)
```

- Split by `workspaceId`: deleting by workspace is deleting one folder, reassigning is moving one folder. Split by month: deleting by cutoff is mostly deleting whole files.
- The workspace `meta.json` is the only thing that helps recognise a workspace that no longer exists in Paseo (REQ-057a); the collector updates it when a value changes.
- `schemaVersion` = `TRACE_STORE_SCHEMA_VERSION` = 1. A store with a higher version → limited reading, a notice, **no writing** (`E_TRACE_STORE_SCHEMA_TOO_NEW`). A new record may only **add** optional fields; no migration.
- `ui/launcher-order.json` may still be on the machine from the pinning feature that was dropped: not read, not written, not deleted.

### 3.3 Record (`traceRecordSchema`)

```
{ v: 1, kind: "turn", at, workspaceId, agentId, role, turnId | null,
  requestId | null, parentAgentId | null, agentCreatedAt | null,
  startedAt | null, endedAt, outcome: "completed" | "failed" | "canceled",
  sent:     [traceMessage],   // the turn's incoming messages, truncated and redacted
  received: [traceMessage],   // the turn's assistant_message items, truncated and redacted
  reports:  [parsedReport],   reviews: [parsedReview],
  evidence: [evidence],       // shell commands, files written, sub_agent, skills loaded
  usage:    usage | null,
  runtime?: { model, thinkingOptionId, modeId, provider? } | null }

traceMessage = { agentId | null, at, text, truncated, origin?: "user" | "agent" }
```

- **`origin`**: `user` when the message carries `clientMessageId` (the user typed it in the app), `agent` when an agent sent it with `send_agent_prompt`. An old record without this field is **never** treated as the user's words.
- **`runtime`**: what the agent actually ran in that turn, taken from the `timeline.refetch` snapshot — `runtimeInfo` first, the configured fields (`model`, `effectiveThinkingOptionId` → `thinkingOptionId`, `currentModeId`) only as a fallback; `null` when the snapshot cannot be read. `provider` (added by the fallback delta 20260921) is used to price a model that is not in the price table. `usage.model` keeps the old source.
- **`skill` evidence**: Claude Code loading a skill is a `tool_call` named `Skill` with `detail.label` = the skill name; for other providers it is reading `<skill>/SKILL.md` (inferred); `ls`/`test -f` do not count.
- **A message's time may be the write time.** A message carries the timeline's time only when `timeline.refetch` succeeds; when it fails (an archived agent is the obvious case) the whole record is stamped with `now()`. No code may treat a message time in a record as the real time, or use it as a key.

Write rules:

- **Append, never edit.** One turn, one line. The only edit is deletion (§3.5).
- **Deduplication** (`dedupeRecords`) by `(agentId, turnId, fingerprint of the turn's content)`, keeping the line with the latest `at`. Fingerprint = the first 16 hex characters of sha1 over the text of `sent` then `received`, in order; a record with no messages uses the key `(agentId, turnId)`. Reason: the hook may run again after a reload (same content → same key), while Paseo **reuses turn ids within one agent** for a different turn (different content → keep both). Accepted risk: a rewrite that falls onto the fallback path and cuts out a slightly different set gives one extra line, with no data lost. The timeline's `messageId` is truer to the nature of the thing, but `traceMessage` does not store it (adding it would change the store schema), so the text fingerprint is used; the concatenated texts carry a length prefix (`<len>:<text>`) so that two messages cannot split back into a different pair. A record with `turnId: null` has no key and so is always kept in full.
- **Safe writing:** the path goes through the checker of §3.8; open with `O_APPEND | O_NOFOLLOW`, one `write` for one line ending in `\n`, then `fsync`; every operation that modifies the store takes the mutex of §3.8. A write error (disk full, permissions, newer schema) → skipped, one line logged, **never** thrown out of the hook.
- **Length caps:** 8 KB for one message, 32 KB for one record; the cut part has the suffix `…[truncated]`.

### 3.4 Reading

`traces.list` reads the workspace's files from newest to oldest (by month name), builds traces per §6, and stops when it has `limit`. `traces.get` reads every line belonging to the trace, then adds the current state of each agent (`agents.list`) and the running turn (a timeline catch-up in the window `activeTurn.startedAt → now`). Cached by `(workspaceId, file, mtimeMs, size)`.

### 3.5 Deleting (`traces.delete`)

| Scope | How |
|---|---|
| `{ traceId }` | Rewrite the month files involved, dropping every line of the trace (temporary file → `fsync` → `rename`) |
| `{ before: ISO }` | Delete the month files that lie entirely before the cutoff; rewrite exactly the one file that contains the cutoff |
| `{ allOfWorkspace: true }` | Delete the folder `<traces>/<workspaceId>` |

- The interface always calls `dryRun: true` first (returning `{ traces, bytes, running }`), then asks for confirmation, defaulting to "No". `running` is the number of requests in scope that still have a `running` agent; > 0 shows a warning that later turns will become a new trace.
- Goes through the checker of §3.8; failing it → `E_TRACE_STORE_UNWRITABLE`, nothing deleted. Does not touch beads, documents, agents, Paseo conversations, `install.json`, `config.json` or anything outside `<install home>/traces`.
- Lines that cannot be read are **kept as they are** on a rewrite: do not delete data you do not understand.

### 3.6 Size

`store = { bytes, workspaceBytes }` is returned with `traces.list`, `traces.delete`, `traces.reassign`, computed with `stat` — without reading the content, so there is no trace count.

The warning threshold is on the **client**: the server returns raw bytes, the client reads the threshold with `useSettings(...)`. Reason: `registerSettings` on the server only declares the schema; the three read/write/reset RPCs managed by Paseo are for the client. Settings (`shared/settings.ts`): `defineSettings({ id: "paseo-bm", scope: "host", version: 1, schema: z.object({ warnAboveBytes: z.number().int().positive().default(200 * 1024 * 1024) }) })`. Paseo only has `scope: "host"`, so the threshold is one value for the whole machine, and the settings screen says so (`HOST_SCOPE_NOTICE`). An invalid value is stopped by Zod, Paseo returns `invalid`, and the old threshold is kept. **No automatic deletion, no automatic compression, no rotation.**

### 3.7 Workspaces that no longer exist, and reassigning

| State | Condition |
|---|---|
| `live` | in `paseo.workspaces.list()`, `archivingAt` empty |
| `archived` | in the list, `archivingAt` not empty |
| `orphaned` | not in the list |
| `unknown` | `workspaces.list()` failed — one failed call never becomes a "no longer exists" conclusion |

**Reassigning** (`traces.reassign`), started only by the user:

1. `to` must currently be in `workspaces.list()` and differ from `from`; otherwise → `E_TRACE_REASSIGN_INVALID`, nothing touched.
2. `dryRun: true` returns `{ traces, bytes }` to ask for confirmation.
3. The target has no folder yet → `rename` the whole folder.
4. The target already has one → merge month file by month file with the same `dedupeRecords`, temporary file → `fsync` → `rename`, then delete the source file; unreadable lines are kept. The whole thing runs inside the mutex of §3.8; if interrupted, at worst both copies remain, and the reader deduplicates so nothing is doubled.
5. The target's `meta.json` keeps the target's values.

Reassigning does not change `workspaceId` in the records (historical fact); the folder decides which workspace a trace belongs to, and `TraceSummary.reassignedFrom` reports when the two values differ.

### 3.8 Path checker and serialisation

Shared by every write, delete and reassign operation, and living only in `server/trace-store.ts`; no module builds a path into the store on its own. A failure at any step → `E_TRACE_STORE_UNWRITABLE`, the disk is not touched:

1. `workspaceId` matches `^[A-Za-z0-9._-]{1,128}$` and is not `.` or `..`.
2. The path after `resolve` lies inside `<install home>/traces`.
3. `lstat` **every component** from `<install home>` down to the target file; a symlink at any level is refused (a string prefix check is not enough).
4. The target file is opened with `O_NOFOLLOW`; the temporary file with `O_CREAT | O_EXCL | O_NOFOLLOW`, in the same folder as the file it replaces.

Files in `<install home>/ui/` use the same pattern (`assertNoSymlinkOnPath`, `writeStoreFileAtomically`).

**Serialisation:** the collector and every handler run in the same plugin process, so an **in-process async mutex, keyed by `workspaceId`**, is used for every operation that modifies the store. Reads do not take the lock; a half-written last line is skipped and counted in `skippedLines`. The collector waits when it meets the lock; after 5 seconds it drops the turn and logs one line. The only other process that can write the store is the CLI during uninstall; the uninstall command runs `paseo plugin remove` **before** touching `traces/`.

## 4. Data model

Every contract is in `plugin/shared/contracts.ts`, in Zod; `shared/` imports neither Node nor React Native. A field added later is always optional so that an old payload still parses (client and server ship in the same bundle, but both directions must still be readable).

### 4.1 Shared types

```ts
confidence = "exact" | "inferred" | "unknown"
evidence   = { kind: "report" | "shell" | "file" | "agent" | "timeline" | "skill",
               detail: string, agentId: string | null, at: string | null }
usage      = { inputTokens, cachedInputTokens, outputTokens, costUsd: number | null,
               costBasis: "provider" | "estimated" | "unavailable",
               model: string | null, pricesUpdatedAt: string | null }
traceState = "running" | "waiting_user" | "completed" | "stopped" | "failed" | "unknown"
tier       = "Small" | "Medium" | "Large"
```

`costBasis: "provider"` is still in the schema but the server never sets it (§9).

### 4.2 `TraceSummary` (one row of the list)

| Field | Meaning |
|---|---|
| `traceId` | `req:<requestId>` when the request is known; otherwise `<managerAgentId>:<seq>`. Durable in the store |
| `requestId` | `req-<YYYYMMDDTHHMMSSZ>` generated by the Manager, or `null` |
| `requestedAt`, `excerpt` | The time and the first line of the request (cut, masked); `excerpt: null` when the request could not be recorded |
| `turn` | `{ index, total }` when the request has several turns in which the user asked (§6.2); `null` when there is only one |
| `state` | §7.3 |
| `workerIds`, `reviewerIds` | Agents assigned to the trace |
| `reviewCalls` | Number of review **calls** observed (distinct from the number of Reviewer agents) |
| `guardrailReported` | The counter the Worker reports itself, verbatim |
| `durationMs` | `null` while running or when it cannot be measured |
| `usage` | Total of all agents |
| `messageCount`, `userMessageCount` | Messages sent and received; messages the user typed directly to an agent of the request |
| `workerUsage` | `[{ agentId, title, usage }]` — for the chart of the Workers that spent the most tokens |
| `usageByModelRole?` | `[{ role, model, usage }]` by effective model — for the model × role chart |
| `errors?` | §7.4 |
| `beadCounts` | `{ created, updated, closed, ready }`, each number `{ count, confidence }` |
| `tier`, `linking` | The tier the Worker classified itself; the certainty of the grouping |
| `agentsMissing` | Agents that are in the trace but no longer on the machine |
| `workspaceState`, `reassignedFrom` | §3.7 |
| `notices` | "data may be incomplete", "trace store off", … |

### 4.3 `TraceDetail` = `TraceSummary` + …

```
sent:     { userRequest, workerInitialPrompts[], reviewRequests[] (+ batchId) }
received: { reports[], reviews[], managerReplies[] }
timing:   { totalMs | null, managerTurns[], workers[], reviewers[], basis }
usageByAgent: [{ agentId, role, usage, runtime?: [{ model, thinkingOptionId, modeId, recorded, turns }] }]
usageByModel?: [{ model | null, usage }]
beads:    [{ id, title | null, statusNow | null, action: created|updated|closed|ready, confidence, evidence[] }]
workflowSteps: [{ step, status: done|skipped|unknown, confidence, evidence[], note | null }]  // always all 12 steps
subAgentTraces: [{ agentId, subAgentType | null, description | null, count }]
userMessages: [traceMessage]              // messages the user typed directly to the request's agents
skills: [{ agentId, skill, at | null }]   // skills each agent loaded
```

- `sent.userRequest` is exactly the message the rebuild chose as the request, not the first message of the first Manager turn (which may be a `BM-REPORT`).
- `runtime` merges an agent's turns into one row per combination of `(model, thinkingOptionId, modeId, recorded)`, in order of first appearance. A turn with `runtime` → `recorded: true`; an old turn with only `usage.model` → thinking/mode `null`, `recorded: false` (interface: `not recorded`); `recorded: true` with `thinkingOptionId: null` is `provider default`.
- `usageByModel` adds up to exactly the trace's `usage`.

### 4.4 Beads

```
BeadStats = { total, open, inProgress, blocked, closed, ready, readAt, source, skippedLines, present }
BeadRow   = { id, title | null, status, issueType, priority: 0..4 | null, labels[], createdAt, updatedAt,
              closedAt, ready, parentId | null, work: { started, last } | null }
BeadDetail = BeadRow + { description, closeReason, blockedBy[], children[] }
work mark = { agentId, at, title | null, status | null }   // status null: Paseo no longer lists the agent
```

`present: false` = the workspace has no `.beads/issues.jsonl`: an empty state, not an error.

## 5. RPC contracts

RPC names must match `^[a-z][a-z0-9._-]*$` (SDK). Every RPC below is read-only, except the rows that say otherwise.

| RPC | Input → Output | Notes |
|---|---|---|
| `traces.list` | `{ workspaceId, limit?, cursor? }` → `{ traces, nextCursor, truncated, store, notices }` | Newest first; `limit` capped at `TRACE_LIST_LIMIT` = 50 |
| `traces.get` | `{ workspaceId, traceId }` → `{ trace: TraceDetail }` | Cannot be rebuilt → `E_TRACE_NOT_FOUND` |
| `traces.delete` | `{ workspaceId, scope, dryRun? }` → `{ deleted: { traces, bytes, running }, store }` | **Writes** the store (§3.5); `scope` is exactly one of the three forms |
| `traces.reassign` | `{ fromWorkspaceId, toWorkspaceId, dryRun? }` → `{ moved: { traces, bytes }, store }` | **Writes** the store (§3.7) |
| `traces.workspaces` | `{}` → `{ workspaces: [{ workspaceId, state, lastKnownName, lastKnownDirectory, lastSeenAt, bytes }] }` | Every workspace that has history; the way into the history of a closed workspace |
| `beads.stats` | `{ workspaceId }` → `{ stats }` | §10 |
| `beads.list` | `{ workspaceId }` → `{ beads: BeadRow[], stats }` | §10 |
| `beads.get` | `{ workspaceId, id }` → `{ bead: BeadDetail }` | Id not present → `E_BEAD_NOT_FOUND` |
| `beads.action` | `{ workspaceId, id, action: implement\|delete\|close }` → `{ managerId, created }` | **Sends** a request to the Manager (§13.4) |
| `beads.lookup` | `{ workspaceId, ids (≤ 100) }` → `{ beads }` | Keeps only ids that really exist in the store |
| `workspaces.overview` | `{}` → `{ workspaces: [{ workspaceId, beads: { total, inProgress, blocked, ready } \| null, runningWorkers, runningAgents: { manager, worker, reviewer } }] }` | Every workspace not archived; `runningWorkers` = `runningAgents.worker`, kept for old readers |
| `chat.peers` | `{ agentId }` → `{ owner, peers, workspaceId }` | §15.2 |
| `chat.beads` | `{ workspaceId, agentId }` → `{ beads: [{ bead, mentions, lastMentionedAt }], scannedItems }` | §15.7 |
| `chat.waiting` | `{}` → `{ waiting: WaitingWorker[], fallback: [{ managerId, workspaceId, incident }] }` | §15.5, §15.8; `fallback` = `pending` incidents of live Managers (server rules: base design §7.10) |
| `answers.marks` | `{}` → `{ keys, notices }` | §15.6 |
| `answers.mark` | `{ key (1–400 characters), marked }` → `{ keys, notices }` | **Writes** `ui/answer-marks.json` |
| `setup.status` | `{}` → tools, skills, extras, … | §11.3; only runs `--version` |
| `setup.install-tool` | `{ tool: br\|bv, confirmed: true }` → `{ command, code, tail }` | **Runs** the installer; `confirmed` must be `true` |
| `setup.ensure-roles` **(0.4.0)** | `{ resume? }` → `{ created, baseProvider, model, skipped }` | **Writes** the Paseo configuration when a role is missing; Setup calls it on every open, before `setup.status`. Contract: base design §7.13.2 |
| `setup.grant-agent-tools` **(0.4.0)** | `{ confirmed: true }` → `{ injectIntoAgents: true, changed }` | **Writes** `daemon.mcp.injectIntoAgents`; base design §7.13.3 |
| `setup.install-skills` **(0.4.0)** | `{ confirmed: true }` → `{ command, code, tail, missingBefore, missingAfter }` | **Runs** the `skills` CLI; base design §7.13.4 |
| `setup.cleanup` **(0.4.0)** | `{ confirmed: true, deleteData }` → `{ removedProviders, removedProfiles, agentTools, data, nextCommand }` | **Deletes** the `bm-*` entries, restores the tool switch, optionally deletes the data; base design §7.13.7 |
| `roles.instructions` | `{ role }` → `{ base, extra, full, path \| null, maxChars }` | §11.3 |
| `roles.save-extra` | `{ role, text }` → `{ extra, full }` | **Writes** `role-extras.json` |

**Error codes** (`DASHBOARD_ERROR_CODES`, recorded in the base design's shared code registry; errors are thrown as an `Error` whose `message` starts with the code, and the client reads it with `errorCodeOf`):

| Code | When |
|---|---|
| `E_TIMELINE_UNAVAILABLE` | Paseo cannot return an agent's timeline |
| `E_BEADS_STORE_UNREADABLE` | `.beads/issues.jsonl` exists but cannot be read: permissions, over 32 MB, a symlink out of the workspace |
| `E_TRACE_NOT_FOUND` | `traceId` is no longer in the store |
| `E_TRACE_STORE_UNWRITABLE` | The store cannot be written/deleted: permissions, disk full, invalid `workspaceId`, a path escaping outside |
| `E_TRACE_STORE_SCHEMA_TOO_NEW` | `meta.json` has a `schemaVersion` higher than understood |
| `E_TRACE_REASSIGN_INVALID` | Reassigning to a workspace that does not exist, or `from` equal to `to` |
| `E_BEAD_NOT_FOUND` | The bead id is not in the store |
| `E_ROLE_EXTRA_INVALID` | Invalid additional instructions (over 8,000 characters) |
| `E_TOOL_PRESENT` | `setup.install-tool` for a tool that is already there |
| `E_TOOL_INSTALL_FAILED` | The install command failed |
| `E_SETUP_ROLES_FAILED` **(0.4.0)** | The missing roles could not be created (no usable provider/model, Paseo refused) |
| `E_SETUP_WRITE_FAILED` **(0.4.0)** | Paseo refused enabling the agent tools or removing paseo-bm's settings |
| `E_SKILLS_PRESENT` **(0.4.0)** | `setup.install-skills` when no skill is missing |
| `E_SKILLS_INSTALL_FAILED` **(0.4.0)** | The `skills` CLI failed or took over 300 seconds |
| `E_DATA_HOME_UNAVAILABLE` **(0.4.0)** | The data folder is unusable, or `setup-state.json` cannot be written |

The `E_ROLE_SETTINGS_*` and `E_FALLBACK_*` codes in the same list belong to the RPCs in the base design (§7.3.6, §7.10); the screens show them per §11.3 and §15.8.

## 6. Building a trace per request

### 6.1 Grouping

1. **Get the agents.** `agents.list` of every agent (`includeArchived: true`, page of 200); the role comes from the `bm.role` label, and without the label from the `bm-*` provider (`roleOfAgent`, `labelled: false`); filtered by `agent.workspaceId`. A tree by `parentAgentId`; a node whose parent is not in the set is a root.
2. **Read the store** of the workspace. Buckets are **keyed by `requestId`**, so all the Manager turns of one request are one trace. A trace is opened by a Manager turn whose incoming message is not a `BM-REPORT`, **or** by a Manager turn from which a `requestId` can be read (then the request is `null` and the row says plainly that it could not be recorded — the plugin only collects from the moment it is loaded).
3. **A Manager turn that names no `requestId`** belongs to the request that **that same Manager** names in its next turn; if there is none, a temporary row is opened. The scope is one Manager, not the whole workspace: a Worker's progress report to the Manager looks exactly like the user's words, so the Manager's own words in its next turn are the evidence; searching across the whole workspace once pulled the turns of an archived Manager into the request of another Manager 18 hours later. No time threshold is added.
4. **Get the `requestId`**, stopping at the first source that has a value: the agent's `bm.requestId` label → `exact`; `requestId:` in a `BM-REPORT` of the trace → `exact`; the line `requestId: req-…` in the Worker's initial prompt → `exact`; a bare `req-…` id that the messages sent to the agent mention more often than all other ids combined → `inferred` (Manager 0.1.0 writes a bare id and sets no label; Worker messages also cite other requests); a Worker whose `agentCreatedAt` falls within a Manager turn of the trace and that does not yet belong to any trace → `inferred`; cannot be placed → the "unknown request" group, `unknown`, **not** assigned arbitrarily to the nearest trace.
5. **Reviewers** by `parentAgentId` = a Worker of the trace (or the `bm.batchId` label). A report that names a **different** request is never evidence for this request, whichever record it sits in (`reportsBelongingTo`); the request's words are the **earliest** user message in the merged turns.
6. **Records of an agent no longer on the machine** are still attached to the trace by their own `requestId`; that agent goes into `agentsMissing` and the row says "no longer on this machine" (once a Worker is deleted, `includeArchived` does not see it either).
7. **Two kinds of number:** `reviewerIds.length` is the number of agents; `reviewCalls` counts the Reviewer's `sent` messages that are not `BM-REVIEW` and not the STOP notice the plugin sends. When it differs from the `guardrail` the Worker reports itself, both are shown and flagged.
8. **User messages** (`origin: "user"`) sent to a Worker/Reviewer go into `userMessages` by the role of the receiving agent, even when the agent has been deleted.

### 6.2 Splitting into segments by the turns in which the user asks

A request is split into **segments** on screen: each Manager turn whose first message is a real user message (`origin === "user"`, not based on wording) opens a segment, and the list shows one row per segment with `turn: { index, total }` (`summariseSegments`). The rows of one request share the `traceId`, so the list key is `traceId#index`. The `requestId`, how the Worker reports and the review budget do not change. Charts and the "requests with errors" number count **requests** (rows with `index === 1` or `turn: null`), not rows.

### 6.3 The `BM-REPORT` / `BM-REVIEW` reader (`shared/bm-report.ts`)

- Lenient: every block starting with a `BM-REPORT` line (with or without a ``` fence), reading each `key: value` line, keys case-insensitive, unknown keys into `unparsedFields`, missing keys `null`; `none` and the empty string mean "none". A block ends at the first line that does not have the `key: value` form — so a `BM-QUESTIONS` block right after it does not make the report read wrongly.
- `requestId` in prose is read leniently with respect to markdown (`REQUEST_ID_PATTERN`: "- `requestId`: `req-…`" still matches). A Manager turn that carries no `requestId` takes it from the Manager's own reply (`managerRequestId`: the Manager generates the id in the turn that opens the request, so the incoming message does not have it yet), **not** from the command `date -u +req-%Y%m%dT%H%M%SZ` (that is a format string).
- Bead ids are split on commas, semicolons or whitespace and filtered by id shape; a `( … )` group containing only ids is unpacked, any other group is a comment and dropped as a whole (`(b2 fix: no-logging AC)` does not produce a bead `no-logging`). The short form `.N` (`.2`, `.2.1`) expands from the root of the nearest full id before it (`x-gcj, x-gcj.1, .2` → `x-gcj.2`); a short form with no id before it is dropped and makes the list incomplete. When cut at the cap, the fragment cut in the middle is dropped too (`…60a.435` cut to `…60a.4` is a different bead); list fields are capped at `MAX_LIST_CHARS` = 8,000 characters; a list read incompletely goes into `incompleteFields` (the count is a lower bound, inferred).
- Deduplicated by `(agentId, phase, requestId, at)`. A block with template values (`a | b`, as in `verdict: approved | changes-required`) is an ordinary message, not a report.
- `BM-REVIEW`: `batchId`, `verdict`, `blockingCount` counted from the `- severity: blocking` lines.
- "The latest report" is always the latest **by time**, not the last element of the array.

### 6.4 Bead ids in `br` commands (`server/shell.ts`)

Taken only from **positional arguments**: the part before the first flag, after blanking out what is inside quotes. `br create` names no id (`br` generates it), `--help`/`--dry-run` are not actions, `br close` inside a quoted string is not closing a bead. Bead counting and the workflow step table share this module. Scanning the whole command line once read `-l "feature:format-date"` and the words in `-r "…"` as bead ids. **Bead counts** (`beadCounts`): `created`/`updated`/`closed` are the union of every report (by time) and the `br create`/`update`/`close` commands; `ready` is a **state**, not an action, so it is taken only from the **latest** report (an old `beads-done` report saying 3 beads are ready must not win over a `finished` saying `beadsReady: none`). A report → `exact`, a list read incompletely → `inferred`; only `br` commands → `inferred`; nothing → `unknown`. No filtering by looking up the `.beads` store: a bead just created may not be in the store yet, so "not in the store" is not enough to exclude it; the positional rule tells them apart right at the source.

## 7. Time, state and errors

### 7.1 Measurement points (fixed, printed in the interface)

| Number | Start | End |
|---|---|---|
| Total of the request | `startedAt` of the opening Manager turn | The later of the `endedAt` of the last Manager turn and the `at` of the `finished` `BM-REPORT` |
| One turn | `startedAt` (hook `turn_started`) | `endedAt` (hook `turn_ended`) |
| One Worker | `agentCreatedAt` | `at` of the `finished` `BM-REPORT`; if missing, the `endedAt` of the last turn |
| One Reviewer | `agentCreatedAt` | `at` of the last `BM-REVIEW`; if missing, the `endedAt` of the last turn |

A turn that still has an `activeTurn` → `ms = null`, the elapsed time is shown, not a total. This is wall-clock time, including time spent waiting for the user, and the interface says so. A missing point → `null` with a notice, never 0.

### 7.2 Plugin reload mid-turn

The `turn_started` point is lost; the record is still written, with `startedAt` inferred from the turn's first entry, with a notice.

### 7.3 `state`

Stops at the first matching condition: an agent is `running` → `running`; the latest `BM-REPORT` is `blocked` → `waiting_user`; an agent is in `error` or the last turn is `failed` → `failed`; the latest `BM-REPORT` is `finished` → `stopped` if `blockers` is not empty, otherwise `completed`; a Worker exists, is not `running`, and there is no `finished` → `stopped`; otherwise `unknown`. Only the last report decides: an earlier `canceled` turn is the past (a request interrupted four times and then finished is still `completed`).

### 7.4 Error counting (`TraceSummary.errors`)

`state` is the **current** state, so a request that failed and then ran again to completion reads as Completed, and the number of failures is lost. `errors` keeps that number, summed from records already there, without changing the collector or the trace files:

```ts
traceErrorsSchema = z.object({
  failedTurns: nonneg,  // turns of THIS ROW that ended `failed`
  agentErrors: nonneg,  // the request's Workers/Reviewers (not the Manager) in `error` with NO failed turn record in the trace
  fallbacks:   nonneg,  // the request's fallback incidents with `signal: "completed"`
})
```

- The three numbers **do not overlap**, so their sum is the real number of failures: one usage-limit hit records one failed turn, leaves the agent in `error` and opens a fallback incident, and must read as **one** failure. An incident with `signal: "failed"` arises from exactly one failed turn, so it is not counted again; a Manager's incident (`requestId` null) belongs to no request.
- `failedTurns` is counted per segment (§6.2). `agentErrors` and `fallbacks` belong to the whole request: set only on the row with `index === 1`, taken from the summary of the **whole trace** (reading per segment would count a Worker that died in a later turn twice), and the later rows get 0.
- Source of `fallbacks`: `SummariseDeps.fallbacksOf(requestId)`; `dashboard-rpc.ts` reads `role-fallback-state.json` **once** (`incidentsIn`) both for `fallbackCountsOf(incidents, workspaceId)` and for recognising replacement Reviewers. Every incident state counts.

## 8. Feature-workflow steps

The table always has all 12 steps, in order: `classify_tier`, `prd`, `design`, `adr`, `plan`, `review_plan`, `convert_to_beads`, `polish_beads`, `implement`, `review_batches`, `build_and_tests`, `close_with_evidence`.

| Step | `exact` | `inferred` |
|---|---|---|
| `classify_tier` | `tier:` in `BM-REPORT` | — |
| `prd` / `design` / `adr` / `plan` | `filesChanged` under `docs/product/` / `docs/design/` / `docs/adr/` / `docs/plans/` | `write`/`edit` under that folder (an absolute path is read against the workspace folder) |
| `review_plan` | `skillsUsed` has `reviewing-plan` | The Worker/Reviewer loads the `reviewing-plan` skill |
| `convert_to_beads` | `beadsCreated` not empty, `phase: beads-done`, or `skillsUsed` has `converting-plan-to-beads` | loads that skill; or `br create` |
| `polish_beads` | `skillsUsed` has `polishing-beads`; or `guardrail` records `polish n/max` with `n ≥ 1` | loads that skill; or `br update` touches **≥ 2 different beads** in one turn (editing the same bead several times is ordinary work) |
| `implement` | `phase: bead-implemented`, or `skillsUsed` has `implementing-beads` | `write`/`edit` outside `docs/` and `.beads/` in the workspace |
| `review_batches` | there is a Reviewer and there is a `BM-REVIEW` | there is a child agent `bm.role=reviewer` |
| `build_and_tests` | `buildAndTests` other than "not run" | `shell` runs the repo's test/build command |
| `close_with_evidence` | `beadsClosed` not empty (with the extra note "confirmed closed in the store" when the store says the bead is `closed`) | `shell` has `br close` |

**An exact negative** beats every inference and gives `skipped` (`confidence: exact`) with a sentence as the note: every `guardrail` that has a polish part records `polish 0` (a guardrail without a polish part says nothing); the latest `finished` report lists `skillsUsed` and the step's skill is missing (`review_plan`, `polish_beads`; a `skillsUsed` read incompletely proves nothing). A missing `converting-plan-to-beads` or `implementing-beads` is **never** a negative. When every `finished` report records an empty `beadsCreated` (or `beadsClosed`), a `br create` (or `br close`) in the timeline is not counted as evidence for `convert_to_beads` (or `close_with_evidence`). `build_and_tests` is inferred only when the test/build command stands at the **start** of a command segment (a `grep 'pytest'` is not running tests); a `buildAndTests` of the form "not run / none / n/a / skipped / no" is not evidence.

**`skipped` by tier:** when `tier` can be read, every tier (Small, Medium, Large) may skip `prd`, `design`, `adr`, `plan`, `review_plan`, `polish_beads` (`SKIPPABLE_BY_TIER`) — documents follow the change, not the tier (REQ-022d). The Small tier may also skip `convert_to_beads`, `review_batches`, `close_with_evidence`: a Small change has no beads and no review unless the user asks for it (REQ-022c, REQ-024c); with evidence it is still `done`. `implement` and `build_and_tests` are never `skipped` by tier. A `skipped` by tier carries `confidence: exact` and a note giving the reason (`skippedNote`). No evidence and not skippable → `unknown` (with no `tier`, the note "no tier was reported, so nothing can be called skipped"): without negative evidence, no negative conclusion is drawn.

## 9. Tokens and cost

1. **`lastUsage.totalCostUsd` cannot be used**: it is the agent session's running total (measured over 12 Manager turns: it only rose 0.3956 → … → 2.2712 while the tokens went up and down). The turn record does not store it; the cost of a request is **always** an estimate.
2. **Estimated** from `shared/prices.ts` by model: `inputTokens×in + cachedInputTokens×cacheRead + outputTokens×out` — cached tokens are priced separately at the cache rate. → `costBasis: "estimated"`. A model not in the table is looked up in the provider's model list (`runtime.provider`; `metadata.cost` of `listModels`).
3. Cannot be priced → `costUsd: null`, `costBasis: "unavailable"`, the interface shows only tokens.
4. The interface always shows `pricesUpdatedAt` next to the amount, with the label "estimated"; the amount is an estimate, not an invoice (Bedrock/Vertex prices differ from the original API prices). **No network call to fetch prices.**
5. Every aggregation by model (total cost, rows by model, the model × role chart) uses the **effective model**: `runtime.model`, falling back to `usage.model`.

## 10. Reading the beads store

- **The workspace folder** is taken from the SDK snapshot in the order `directory`, `workspaceDirectory`, `cwd`, and `projectRootPath` is added only for a workspace that is not a worktree. A worktree **never** falls back to `projectRootPath`: that is the main checkout, and the worktrees would all see its beads. The plugin's cwd is not used.
- **Path** `<dir>/.beads/issues.jsonl`: `resolve` and then check it is still inside `dir`; `lstat` every component, a symlink out → `E_BEADS_STORE_UNREADABLE`. A separate copy in `server/` (the payload does not import `src/`).
- **Reading** line by line, capped at 32 MB; a broken line is skipped and increments `skippedLines`; several lines with the same `id` keep the latest `updated_at`. Cached by `(path, mtimeMs, size)`.
- **Numbers:** `total` = the number of distinct ids; `open`/`inProgress`/`blocked`/`closed` by `status`; `ready` = `open`, not an epic, and **every** `blocks` dependency points to a `closed` bead (`parent-child` does not block; an id that does not exist counts as not closed).
- **Read only**: no `br` call, no child process, no writing, `beads.db` is not touched.
- **Who is working on a bead** (`BeadRow.work`, only for `in_progress` beads, `server/bead-work.ts`): `br` records no start time and the Worker does not set `assignee`, so it is inferred from the trace store, from Worker turns only. `started` = the latest command that moved the bead to `in_progress` (`--status in_progress`, `--status=in_progress`, `-s in_progress`, `--claim`); `last` = the latest command or `BM-REPORT` that mentions the id (whole-id match: `x.1` does not match `x.12`). No command that set the status → "start not recorded"; when another Worker takes the bead later, the new Worker is shown with its activity time, without borrowing the old start time. Without a trace store, only the Worker's name is missing.

## 11. Surface "Beads Manager"

### 11.1 Views and the way back

`DashboardViewName = "setup" | "workspaces" | "dashboard" | "beads"`; the surface opens at `SURFACE_HOME_VIEW = "setup"`.

| View | `backOf` | `backLabelOf` (accessibility label of ←) |
|---|---|---|
| `setup` | `null` (no ←) | `null` |
| `workspaces` | `setup` | "Back to Beads Manager setup" |
| `dashboard`, `beads` | `workspaces` | "Back to workspaces" |

```
sidebar / Command Center "Open Beads Manager"
  → setup ──(Workspaces)──> workspaces ──(Metric | Beads)──> dashboard | beads
Command Center "Open Beads Metric" → dashboard ──(←)──> workspaces ──(←)──> setup
```

The Command Center and slash commands cannot pass anything into the surface, so a **one-place slot** `createSlot<string>()` is used: `launchRequests` (open the Manager), `dashboardRequests` (open a workspace's Metric), `launcherNotices` (slash command notices). `take()` notifies listeners **only when it actually removes a value**, so pressing to dismiss a notice dismisses it at once and there is no loop. `runPendingRequest` returns `null` **before** `take()` while the launcher is `pending`, and the surface's effect runs again when the launcher state changes, so a request to open the Manager that arrives midway is not dropped (one-place slot: the newest request wins).

### 11.2 Status strip

`launcherStatusLines({ commandNotice, canOpenAgents, state })` returns, in order: the slash command notice (tone `muted`, `dismissable`, accessibility label `"<text>. Dismiss."`); `OLD_HOST_WARNING` when the host lacks `navigation.openAgent` (tone `warning`); the lines of `describeLauncherState(state)`: `pending` → "Opening Beads Manager…"; `opened` → "Started a new…" / "Reopened the existing Beads Manager…" (`muted`), then tone `warning` for other live Managers (`otherManagerIds`, "…nothing was archived or deleted."), `modeNotice`, `toolsNotice`, **(0.4.0)** `setupNotice` (the server's text verbatim, base design §7.3, §7.13.2); `error` → `danger` "Could not open Beads Manager (<code>). <message>", where `<message>` is the server's message with the daemon's wrapper stripped (`Request failed: … requestType=… code=…` of `DaemonRpcError`) and the leading code removed when the code is already in the parentheses (`withoutCode`); with no code, "Could not open Beads Manager. <message>". A line that cannot be dismissed is a `Text` with `accessibilityLiveRegion="polite"`. `LauncherStatus` is built **once** in `ManagerLauncherSurface` and placed on every view of the surface (Setup, Workspaces, Metric, Beads) — a slash command can open the surface at any view. The "Beads" tab (§14) has no such strip.

### 11.3 Setup screen (the main screen)

```
[Beads Manager ............................ (Workspaces)]
Setup for this machine: beads tools, agent skills, and each role's model and extra instructions.
<status strip> · spinner · error · setupHeadline · paseoToolsWarnings
<migration banner>                             ← (0.4.0) only when install.kind = installer-directory
<"Set up paseo-bm" card>                        ← (0.4.0) only while something is missing
[Beads tools] [Agent skills] [Agents]          ← StatusTabs, one tab at a time
<tab content>
paseo-bm <version>
<"This install" block>                          ← (0.4.0) data folder, cleanup button
```

- Tabs: `SETUP_TABS` = `tools` "Beads tools" · `skills` "Agent skills" · `agents` "Agents"; `DEFAULT_SETUP_TAB = "tools"`, a `useState`, so reopening the surface goes back to the first tab. Each tab has a `hint` (e.g. "br and bv on the daemon's PATH"), used for the accessibility label `"<label>: <hint>"`. Everything that reports a problem (`setupHeadline`, `paseoToolsWarnings`) sits **above** the tab row, so that no tab can hide a missing tool. The `agents` tab contains "Roles & models" then "Additional instructions".
- The "Workspaces" button (`secondaryButton`, accessibility label "Open the workspace list: Beads Manager, metrics and beads of each workspace").

**Beads tools** (`setup.status`, `setup-tools.ts`):

- Looks for `br`, `bv` (and `bd`, information only) on the daemon's `PATH` plus `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/go/bin`; runs `--version` in parallel (timeout 5 s). Never runs a bare `bv` (TUI). `br` only counts as present when it is named exactly `br`.
- Each tool shows its status, path (the daemon's PATH may differ from the terminal's), version, the latest known version (`LATEST_KNOWN`, a constant with a check date, no network lookup), the install command and the update command with a Copy button (back to the word "Copy" after 2 s).
- Install command: with `brew` → `brew install dicklesworthstone/tap/<tool>`; without it, `br` → the script `beads_rust/main/install.sh | bash -s -- --skip-skills` (so paseo-bm does not write into the skill folders); without it, `bv` → the `beads_viewer` script pinned at commit `a43b8e85a39664381566abdfd85dc8fcbfdcb773`. This command must match the CLI's command (a test locks it; `src/` and `plugin/` share no code).
- The Install button shows only when the tool is missing. The confirmation dialog states the command verbatim and warns that the command downloads code from the network. `setup.install-tool` runs the command in a login shell (`/bin/zsh -lc` if `SHELL` is zsh, otherwise `/bin/bash -lc`), timeout 300 s, and returns the exit code and the last 40 lines. Tool already present → `E_TOOL_PRESENT`; failure → `E_TOOL_INSTALL_FAILED`. Updates are not run from the screen. The plugin never installs anything on its own.

**Machine setup (0.4.0)** (`setup-screen.tsx`, pure logic in `setup-model.ts`; the server contract is in base design §7.13). No text on the screen points to `npx paseo-bm` any more, except the banner.

- **When the screen opens:** call `setup.ensure-roles {}` and only then `setup.status` (one sequence, a shared spinner). A non-empty `created` → the status strip has a `success` line "paseo-bm created its roles with defaults (<provider> · <model>). Change them in Agents." (dismissable). `E_SETUP_ROLES_FAILED` → a `danger` line with the code and the server's words, and a "Try again" button that calls `setup.ensure-roles` again. `skipped: "cleaned-up"` → no setup card; instead a `warning` line "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again." with a "Set up again" button (`setup.ensure-roles { resume: true }`).
- **Migration banner** (`status.setup.install.kind === "installer-directory"`, tone `warning`): "This copy of paseo-bm was installed by the old npx installer. Switch it to the paseo.cafe install once: `npx paseo-bm@0.4.0`. Your roles, settings and history stay." The command has a Copy button. Cannot be dismissed.
- **The "Set up paseo-bm" card** (`setupChecklist(status)`, returns the missing rows in the order below; with no row left the card does not show). Each row: a name, a status sentence, an action button (if any). Placed **above** the tab row like `setupHeadline`, so that no tab can hide what is still missing.

  The status sentence of each row (verbatim): Roles — "Not created: <Manager, Worker, Reviewer>. <the server's words of `E_SETUP_ROLES_FAILED`, omitted when absent>"; Agent tools — "Off — no new Beads Manager starts until you allow them." (the same sentence as the block on "Roles & models"); Agent skills — "Required skills for the Worker (<Claude Code | Codex | …>): <k>/5. The Worker works with lower quality without them."; Beads tools — "Missing <br | bv | br and bv> — the Worker cannot manage beads without it" (the same sentence as `setupHeadline`); Sign-in — the sentence in the last column.

  | Row | Missing when | Button | Confirmation dialog (verbatim, English) |
  |---|---|---|---|
  | Roles | `setup.roles.missing` not empty (ensure just failed) | "Try again" | — (not needed: it only creates paseo-bm's `bm-*` entries) |
  | Agent tools | `setup.agentTools.injectIntoAgents === false` | "Allow agent tools…" | Title "Allow Paseo's agent tools for every agent?". Body: "The Manager and the Worker need Paseo's agent tools to create and message other agents. Paseo has one switch for this (daemon.mcp.injectIntoAgents), and it applies to **every agent on this machine**, not only paseo-bm's: any agent can then create, message and stop other agents. paseo-bm records the current value so "Remove paseo-bm's settings" can turn it back off." Buttons "Allow for every agent" / "Cancel" (default). Calls `setup.grant-agent-tools { confirmed: true }` |
  | Agent skills | the agent of the provider that the `bm-worker` role uses (Claude Code for `claude`, Codex for `codex`) is missing a required skill; for other providers (Pi, OpenCode) it follows that provider's column if there is one, otherwise this row does not show | "Install skills…" | Title "Run the third-party skills CLI?". Body: the command verbatim (`status.skills.installCommand`), then "This downloads the skills from github.com/cuongntr/agent-skills (another author) with the `skills` CLI, a third-party tool with its own data collection. paseo-bm never writes to your skills folders itself. It can take up to 5 minutes." Buttons "Run it" / "Cancel" (default). Calls `setup.install-skills { confirmed: true }`; the result shows the exit code and the last 40 lines like the Install of `br`/`bv`, then `setup.status` is read again |
  | Beads tools | `br` or `bv` missing | "Open Beads tools" (switches tab) | The tab's existing Install confirmation dialog |
  | Sign-in | a `logins` row has `state: "logged-out"` | no button that runs anything | Text only: "`<provider>` (used by <roles>) is not signed in. Sign in with: `<loginCommand>`" + Copy; Pi: `guidance`. `unknown` does not make the row show |

- Every confirmation dialog: the cancel button is the default and takes the Escape key; the consent button is never focused in advance; only pressing consent sends the RPC (the schema requires `confirmed: true`). An RPC error shows right under the row, with its code.

**Agent skills:** `setup.status` reads (read only) the skill folders of the daemon process (`~/.agents/skills`, `~/.claude/skills` per `CLAUDE_CONFIG_DIR`, `~/.codex/skills` per `CODEX_HOME`, and the Pi/OpenCode folders when present). Claude Code counts only its own folder; Codex counts `~/.agents/skills` or its own folder. The **Test** button re-reads each `SKILL.md`: readable, with a frontmatter `name:` equal to the folder name → `ok` / `missing` / `broken`, with the check time. The screen shows the equivalent `skills add` command; the plugin does not install skills. **(0.4.0)** The tab also has an "Install skills…" button (the same confirmation dialog and RPC as the setup card) when an agent is missing a required skill, and a line "Last run: <time> · exit <code>" from `setup.skillsRun`; the command line's label changes per base design §7.13.10. The Pi/OpenCode columns stay read only.

**Roles & models** (`setup-screen.tsx`, logic in `setup-model.ts`; the server contract and validation rules are in base design §7.3.6):

- `RolesSection` reads `roles.settings` (key `ROLES_SETTINGS_KEY`) and `roles.options` of every base provider in the roles and the fallback chains (`rowOptionProviders`). One row per role: `RoleMark`, the role name, `roleSettingText` = `<Provider> · <model label> · thinking <id | provider default>[ · mode <label>]`, an Edit/Close button. Under the card: the `warnings` of `roles.settings` (tone `warning`, once for the whole card) and `ROLES_APPLY_NOTICE` "Changes apply to agents created after you save. Running agents keep their model and thinking."
- **Edit form** (`RoleEditForm`, `roleFormView`): Provider chips from `roles.settings.providers` (no `bm-*` alias; the saved provider is always present); Model from `roles.options`, with the price `~$<in> / $<out> per 1M tokens` below it when known; Thinking hidden when the model has no levels, the first choice "Provider default (<level>)"; Mode hidden when `capability: none`, the first choice "Not set", a Reviewer on `tiered` does not see `dangerous`/`planning` modes; `capability: unknown` with a mode currently set → a warning that saving will clear the mode. Save is enabled when the draft has both provider + model and differs from the saved version. The form keeps the `revision` from when it was opened: `E_ROLE_SETTINGS_CONFLICT` → "The configuration changed elsewhere; reopen Roles & models." and `roles.settings` is read again. After saving: "Saved." with each of the `warnings` under the row (`notified` is not shown).
- **(0.4.0) On "Roles & models":** `setup.roles.created` not `null` → a `muted` line "Created by paseo-bm on <date> with defaults (<provider> · <model>). Change them here." Under the role card: the **Paseo agent tools** block — "On for every agent" (with "turned on by paseo-bm" when `setBy` is present) or "Off — no new Beads Manager starts until you allow them" with an "Allow agent tools…" button (the same confirmation dialog as above); and the **Sign-in** block, one row per base provider of the three roles: `<provider>` · "used by Manager, Worker" · "Signed in" / "Not signed in — sign in with `<command>`" (Copy) / "Unknown"; Pi shows `guidance`. No button runs a sign-in command.
- **Fallback chain** (`FallbackBlock`) under each role present in `roles.settings.fallback`: `On a usage limit:` chips Ask me / Auto switch / Off; Auto switch → a cost warning (the Manager adds "The chat you use may be replaced."). Each entry `Fallback <n>  <Provider> · <model> · thinking …[ · mode …]`, buttons ↑ ↓ Edit Remove, a price line; "+ Add fallback" while under `MAX_FALLBACK_ENTRIES` (3). The entry form uses exactly the role form's rules. Edits stay on the client until "Save fallbacks" is pressed (`roles.save-fallback` for the whole chain, with the `revision` from when editing started) or "Discard".

**Additional instructions** (`role-extras.ts`):

- Stored in `<install home>/role-extras.json` (`0600`, temporary file then rename, symlinks refused): `{ "version": 1, "roles": { "manager", "worker", "reviewer" } }`, each role at most `MAX_EXTRA_CHARS` = 8,000 characters. It is user data: not hashed in `install.json`, untouched by update and `--prune`.
- **Append only**: the full text = base + `---` + `## Additional instructions from the user` + `These add to the rules above and never override a RULES item.` + the content. Applies to agents created after saving (the `agent.create` hook for the Worker/Reviewer, `manager.ensure` for the Manager); when the file cannot be read, the base version is used and agent creation is not blocked. Paseo's plugin settings cannot be used for this because the server cannot read them.
- The preview shows the whole full text as Markdown.

**The "This install" block (0.4.0)**, under the `paseo-bm <version>` line, outside the tabs:

- "Data folder: `<path>`" and its source (`default` / "set by PASEO_BM_HOME" / "from ~/.paseo-bm/home.json"); `path: null` → a `danger` line with the `reason`, and the buttons that need the folder (saving additional instructions, saving the fallback chain, enabling the agent tools) report `E_DATA_HOME_UNAVAILABLE` / their existing code when pressed.
- "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`." (instead of `doctor`, because when the plugin does not load no screen shows).
- The **"Remove paseo-bm's settings…"** button (tone `danger`, accessibility label "Remove paseo-bm's roles and settings from Paseo"). **First-level** confirmation: "This removes every bm-* provider and agent profile from Paseo (the three roles and their fallbacks)<, and turns Paseo's agent tools back off (paseo-bm turned them on)>. Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay." Buttons "Remove settings" / "Cancel" (default). **Second-level** confirmation (always asked, default keep): "Also delete paseo-bm's data in `<path>`: history (traces), extra instructions, fallback settings and incidents? One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay." Buttons "Keep my data" (default) / "Delete data". Sends `setup.cleanup { confirmed: true, deleteData }`. Result: the list of what was removed, what was kept (`data.kept`), the switch state ("left on — it was not turned on by paseo-bm" when `left-on`), then the fixed line "Now remove the plugin: `paseo plugin remove paseo-bm`" + Copy. After that the screen moves to the `skipped: "cleaned-up"` state above.

**The Orchestrator tab (fourth, after Agents)** — designed in [Orchestrator Design](./paseo-bm-orchestrator.md) §8.1 (Active 2026-09-28): an overview of the flags of every workspace and the agent nudge switch. The flags, the Assess button and the assessment result on the Metric screen are in the same document, §8.2.

### 11.4 Workspaces list

- The first line `[←] Workspaces`, a one-line introduction, the status strip, then one row per workspace in **exactly the order `workspaces.list` returns** (`activity_at desc`); no pinning, no drag-and-drop.
- Each row: the name (1 line) and the project; `workspaceStats` — four numbers with the icons `Layers` total, `CircleDot` in progress, `Ban` blocked, `Hammer` Workers running (tone `plain` when > 0, `muted` when 0; the total always `muted`; with no bead store, a single "–" line); an 8 px dot next to the name (`RunningDot`, `runningDotState`); three small buttons with icons on one row, on phones too: `WORKSPACE_ACTIONS` = Go to (`Bot`), Metric (`ChartColumn`), Beads (`ListChecks`). Go to is the primary button and is hidden when the host lacks `navigation.openAgent`; Metric and Beads are read only, so they always stay (REQ-040d).
- **Running dot:** total `runningAgents` > 0 → tone `success`, pulsing with `Animated.loop` opacity 1 ↔ `DIM_OPACITY` 0.3, each beat `PULSE_MS` = 900 ms (`useNativeDriver: false`), with the text `1 Worker, 1 Reviewer`; = 0 → a dimmed dot at 0.3, tone `muted`, no text, accessibility label "No Beads agent running"; no data yet → nothing drawn. `AccessibilityInfo.isReduceMotionEnabled()` true → a solid dot, no animation (a failed query counts as false). A poll that only changes the numbers does not restart the loop.
- The list leaves out workspaces being archived (`archivingAt`). `workspaces.list` and `traces.workspaces` are one-off queries that run on every view: the "Open Beads Metric" request needs the label from `workspaces.list` (falling back to `workspaceId`).
- `workspaces.overview` is read only while the view is `workspaces` (`overviewPolling`: `OVERVIEW_POLL_MS` = 10,000 ms), because each read touches the bead store of every workspace.
- At the end of the list: "Closed workspaces with history" (`closedWorkspaces`: in `traces.workspaces` but no longer listed, state other than `unknown`, newest first), each entry opening the Metric screen of that history; the Metric screen of a newly reopened workspace offers to reassign the history to it.
- The Metric/Beads screen title is `screenTitleOf(label, project)`: adds the project name when the workspace name differs from the project name, so that two bead stores are not confused.

## 12. Metric screen

`DashboardPanel(props: WorkspaceScreenProps)`; `WorkspaceScreenProps` = `PluginSurfaceProps` + `workspaceId`, `workspaceLabel?`, `onBack?`, `backLabel?`, `status?`. The top of the screen is `WorkspaceScreenHeader`: ← (when there is `onBack`), the title `Metric · <name>` (when there is `workspaceLabel`), a Refresh button; the status strip right below.

1. **Overview** — `overviewCards`, seven cards: Requests (the number of **rows**; hint running · waiting · done), **Errors**, Beads, Agents, Messages, Tokens (in · cached · out), Cost (estimated; the number of requests not priced).
   - `errorTally` adds up the `errors` of the rows shown (a row without the field reads as 0), and `requests` counts by `traceId`. `errorCard`: total 0 → value `0`, hint "no error recorded"; otherwise the hint `"<n> request(s) with an error · <a> failed turn(s) · <b> agent error(s) · <c> provider fallback(s)"`, leaving out the parts equal to 0. "request(s) with an error" states its unit because the Requests card next to it counts rows. The card is not coloured.
   - The size warning (§3.6) right below the row of cards.
2. **Charts** (when there are rows): "Requests, last 7 days — each request counted once" (`requestsPerDay`, only rows that open a request); "Top 5 heaviest Workers (tokens)" (`heaviestWorkers`, pressing opens the Worker when the host has `navigation.openAgent`); "Tokens by model × role" (`tokensByModelRole`, a model with no price shows only tokens).
3. **The requests** — `RoleLegend`, then `groupTraces` (grouped by `workspaceState` in the order live → archived → orphaned → unknown, leaving out empty groups; the orphaned group has a sentence suggesting reassigning or deleting — that is the only way the user finds the reassign feature; the last known name and path show in the "Closed workspaces with history" entry of the Workspaces list). Each row is a compact `RequestCard` (the Manager's `RoleMark`, the request in 1 line, a status badge, a secondary line `[turn i of n · ]<tier | size ?> · <time> · <n> tokens · <cost>[ · 💬 <n> from you]` — the last part when the user messaged an agent of the request directly); press to open the **graph** Request → Worker → Reviewer (`requestGraph`), with the detail loaded only on open. Press each node to see: what was asked, what was answered, time, tokens, model/thinking/mode (`runtimeLines`), beads, skills loaded, messages the user sent directly (`💬 You → <agent>`), and the workflow steps on one line of chips (`stepChip`: green ✓ exact, blue ✓~ inferred, grey – not needed, yellow ? unknown). The honesty rules (certainty of the grouping, mismatched counts, workspace no longer present) sit on the Request node. The "Open agent" button shows only when the host has `navigation.openAgent`.
   - **Model lines** (`runtimeLines`): each `runtime` element is one line `Model: <m> · thinking: <id | provider default> · mode: <id | unknown> · <n> turn(s)`; `recorded: false` → `Model: <m> · thinking/mode: not recorded · …`, or `Model: not recorded · …` when the model is `null`. The Manager has no node of its own: its line sits on the Request node, in the form `Manager <short id> — Model: …`, together with the line `Tokens by model: <model> <n> tokens · $… · …` (`tokensByModelLine`; a model with no price shows only tokens, a `null` model is `unknown model`). The subtitle of a Worker/Reviewer node adds the model name when the agent ran exactly one model with a known name (`singleModelOf`).
4. **Storage**, collapsed at the end: size, deleting by trace / older than `OLDER_THAN_DAYS` = 30 days / the whole workspace, reassigning (`dashboard-actions.tsx`, `createConfirmationGate`: no default "Yes").
5. `PRIVACY_NOTICE` at the end: the screen shows and stores agent conversations.

The screen calls `traces.list` once, without passing `cursor` (the first page, at most 50); with `truncated: true` the screen says "Older requests are not shown." **There is no load-more button yet** (REQ-041 (c), REQ-049 (a)) although the server already returns `nextCursor`.

**Role icons** (`ROLE_MARK`, Lucide icons of `Icon` in `@getpaseo/plugin/client/react-native` on a round background of the same colour at `opacity: 0.16`): request/Manager `BotMessageSquare` tone `info`; Worker `Hammer` tone `success`; Reviewer `ScanEye` tone `warning`. The `danger` colour is reserved for errors; the icon shapes differ, so they can still be told apart when two colours are close. A wrong icon name makes Paseo draw nothing, with no error.

## 13. Beads screen

`BeadsScreen(props: WorkspaceScreenProps)`, shared by the surface and the "Beads" tab. The top of the screen: ← · `Beads · <name>` · `doneText` (`✓ <closed> / <total> done`, accessibility label "`<closed> of <total> beads done, epics not counted`", shown only when there is data) · Refresh. Then the status strip and the line `Read from <file path>` (so that two workspaces on the same copy of beads do not look mixed up).

### 13.1 Overview (`beadsOverview`)

Five sections: Status (Total, Ready, In progress, Blocked, Closed); Progress (the percentage closed, **epics not counted**, not affected by the filters — `doneText` reads the same number); By type; By priority (P0 → P4, P?); Time (median created → closed, "Longest in progress" counted from `work.started` if known, Stale = open and not updated for over 7 days). There is no chart of created/closed per day.

### 13.2 Filters and sorting

A search box by id and title; filter chips Status / Type / Priority / Labels (`facetsOf`: the number next to a value is the number of beads it would show combined with the other filters; labels grouped by prefix `feature`, `area`, `component`, …, each group showing `LABEL_PREVIEW` = 5 values before "+N more"); active filter chips have ✕ and "Clear all" (tone `plain` — it only removes filters); Sort by Updated / Created / Closed / Priority, newest first, beads missing the value always last. Within one facet several choices mean "or", between facets "and". The Status chips are ordered by `STATUS_ORDER` (Ready first), unlike the column order `STATUS_GROUP_ORDER` (§13.3); merging the two orders changes what the user sees and must be asked of the owner.

### 13.3 Kanban

Every decision is in `beads-model.ts`; `KanbanBoard` and `StatusTabs` are hook-free views in `ui.tsx`.

- **Columns** by `STATUS_GROUP_ORDER` = `in_progress` → `blocked` → `ready` → `closed`. `statusBucket`: `closed`, `in_progress`, `blocked` by `status`; an open bead that is not ready yet or has an unknown status (`deferred`) is `blocked`. `kanbanColumns(beads, { showClosed, limit? })` takes the **already filtered and sorted** list, keeps the order within a column, and returns `{ columns, visible, closed }`; each column is `{ bucket, label, total, beads, hidden, empty: "Nothing here." }`. Empty columns are still returned and drawn (the layout does not jump when filtering); Closed is there only with `showClosed`.
- **Limit** `KANBAN_COLUMN_LIMIT` = 100 rows **per column**, so that a long Closed column does not eat the room of In progress; a cut column says `+<hidden> more · narrow the filters to see them`.
- **Layout** `kanbanLayout(width, compact, buckets)`, `width` measured with `onLayout` of the list area: not measured yet (`null`) → follows the host's `compact` (`tabs` / `columns` with all columns); `width < 2 × KANBAN_MIN_COLUMN` (260) → `tabs`; otherwise `columns` with `perRow = min(buckets, floor(width / 260))`. Each column sits in a cell of `flexBasis: (100 / perRow)%` with padding as the spacing (the percentages add up to exactly 100%; a `gap` on the row would push the last cell down). `tabs` mode: `StatusTabs` (`accessibilityRole="tablist"`, each tab `"tab"` + `accessibilityState.selected`, text `<name> <count>`), the column open by default is `defaultKanbanBucket` (the first column with beads), and `visibleKanbanBucket` goes back to the default when the selected column disappears.
- **The eye button** on the `<visible> of <total> beads` line: `Eye`/`EyeOff` + `Closed <n>`, `accessibilityState.selected`, label "Show/Hide closed beads (<n>)". `closedBeadsVisibility = createSessionToggle(true)`: **shown by default**, remembered for the app session, shared between the surface and the tab. When every matching bead is closed and they are hidden → "All <n> matching beads are closed. Show them with the eye button." A workspace with no beads → "This workspace has no beads yet."

### 13.4 Bead row, detail and actions

- **Row** (`BeadRowCard`, shared with the "Beads in this chat" panel): the title first (at most 2 lines when collapsed, ▸/▾), then the id, the chip `P<n> · <type>`, the status chip; an `in_progress` bead also has a line with the Worker's `RoleMark` + `workSummary.headline` (`<Worker> · since <time> (<how long>) · <state>`, or "start not recorded"). Press to open the detail right inside the card.
- **Detail** (`BeadDetailPanel`, `beads.get`): the description as Markdown, the close reason, dependencies; a "Being worked on" box with an "Open the Worker" button; the actions (`actionsFor`: a closed bead has only Delete).
- **Actions** go through the workspace's Manager, without creating a Worker directly: `beads.action` calls `ensureManager` then `paseo.agents.ref(managerId).send(actionMessage(...))`; the Manager creates a Worker per `manager.md`. That way the `requestId`, labels, reports, review budget and trace stay the same, and Metric sees the request like any other request. The message sent (English, for the agent):

  ```
  [Beads screen] The user asks: <implement|delete|close> bead <id> ("<title>").
  <the action's instructions>
  The user confirmed this action on the Beads screen. Treat it as a new request from the user. Do not commit or push.
  ```

  Delete and Close are **requests for an assessment**: the Worker checks whether the bead is still needed / has met its criteria, does it if it can, and otherwise reports why. The plugin never writes the bead store. Every action goes through a confirmation gate (`actionSpec`: Assign a Worker / Close / Delete; cancel button "No, cancel"), because every action spends real quota.
- **The result line survives a column change.** Each status is a column (a separate parent), so when a bead changes status after a refresh React rebuilds the row. The action result (`"Sent to the Beads Manager… It will hand the bead to a Worker."` with an "Open the Beads Manager" button, or an error) therefore lives in `beadActionResults: SessionMap<{ text, managerId, tone }>`, keyed by `beadResultKey(workspaceId, beadId)` = `<workspaceId>:<beadId>` (two repos may share the same `br` prefix), read with `useSyncExternalStore`, `clear`ed when the user opens a new action. `SessionMap.get` returns exactly the stored object, so it is stable between renders and needs no snapshot. `pending`/`busy` remain panel state: they live only for the few seconds of confirmation, and losing them when the bead changes column erases no evidence (an open confirmation dialog closes).

### 13.5 How a bead shows its status

Many colours on one list tire the eyes, so **everywhere a bead is shown** (the Beads screen, the "Beads" tab, the "Beads in this chat" panel, bead chips on chat cards, the numbers on a workspace row) the status is expressed only by **text and contrast**, not by hue:

- `STATUS_EMPHASIS`: `ready`, `in_progress`, `blocked` → `strong`; `closed` → `dim`. `beadEmphasis(bead)`; `emphasisTone`: `strong` → `plain`, `dim` → `muted`.
- `statusBadge(bead)` = `{ text: Ready | In progress | Blocked | Closed, tone: emphasisTone(beadEmphasis(bead)) }`: the chip and the title always have the same contrast, and the status always has text.
- `beadTitleStyle(styles, theme, emphasis | null)` = `sectionTitle` with `fontWeight: "400"` (not bold) and the colour `foreground`/`foregroundMuted`; `null` (a detail box opened from a chip) keeps `foreground`. Rows have no background fill and no left bar.
- Column titles use `sectionTitle` without colour. The `StatusTabs` row is buttons: the selected tab in the `button` style (accent background), the others `secondaryButton`, like the sub-tabs of the "Beads" tab; that colour says which tab is open, not a bead's status. `workSummary.tone`: `running` → `plain`, otherwise `muted`.
- Outside the places where beads are shown, colours stay as they are: RPC error lines (red), warnings (yellow), active filter chips and "+N more" (accent), the Metric screen, chat cards, the Delete button.

## 14. The "Beads" tab and the header button

- **Panel** `client.addWorkspacePanel({ id: BEADS_TAB_PANEL_ID ("bm-beads"), title: "Beads", icon: "ListChecks", context: "workspace", Component: BeadsTabPanel })`, registered before the "Beads agents" panel; no `locations` declared (default `["workspace"]`). Paseo puts every `context: "workspace"` panel into the "+" menu of the tab bar and the "New tab" screen.
- `BeadsTabPanel`: a row of sub-tabs `BEADS_TAB_VIEWS` = Beads, Metric (`accessibilityRole="tab"`, the selected tab in the `button` style, the other `secondaryButton`, ~40 px high), opening at `DEFAULT_BEADS_TAB_VIEW = "beads"` (`useState`, living within the tab). The content is `BeadsScreen` / `DashboardPanel` **without** passing `onBack`, `workspaceLabel`, `status`: no ←, no title, no status strip; the first line keeps only its right-hand part. Switching sub-tab unmounts the other screen; the data sits in the React Query cache under the keys `["paseo-bm", "beads-list", id]`, `["paseo-bm", "traces", id]`. Two "Beads" tabs of the same workspace share the cache, each keeping its own sub-tab; reopening an old tab or opening a new tab is Paseo's business.
- **Paseo 0.8's mobile app has no "+"** (the mobile tab bar only lists open tabs; `onCreateNewTab` is only handed to `WorkspaceDesktopTabsRow` and `SplitContainer`). The mobile entry point is the **header button**: `registerBeadsHeaderButtons(client)` (`beads-header-button.ts`) reads `client.paseo.workspaces.list({})` at start, every `BEADS_HEADER_POLL_MS` = 15,000 ms and whenever `workspaces.subscribe` reports an update (one read at a time; on error the buttons are kept; a client without `paseo` does not break loading). `planHeaderButtons(shown, listed)` → `{ add, remove }` by the open workspaces (no `archivingAt`). One `client.addHeaderButton({ id: BEADS_HEADER_BUTTON_ID ("bm-beads-open"), workspaceId, button })` per workspace, an icon-only button `ListChecks`, title "Open the Beads tab: beads and metrics of this workspace", pressing → `client.openPanel("bm-beads", { workspaceId })`. In the narrow form (`useIsCompactFormFactor` or width < 1100 px) Paseo shows the **first** plugin button directly on the header and later buttons in the "more" menu; desktop shows them on the right of the header. Paseo keys header buttons by `id` + `workspaceId` (a duplicate `id` within one workspace is an error), so every workspace uses the same `id`. `addButton(workspaceId)` takes the workspace as a parameter and does not capture the loop variable: on Hermes (mobile) every closure created in a loop sees the last value. The timer is `unref`ed; cleanup removes every button.
- **The "Beads agents" panel** (`tree.tsx`, logic in `agent-tree.ts`, registered after the "Beads" panel): the Manager → Worker → Reviewer tree from `agents.list` (base design §7.3), refreshed every `AGENT_TREE_POLL_MS` = 5,000 ms while the panel is shown; an agent that has been replaced reads `<role> · replaced by <id>`.

## 15. Chat

### 15.1 What Paseo provides

- `addTimelineTransformer({ query: { itemType }, transform({ item, phase }) })` runs for **every** chat item of **every** agent; returning `undefined` keeps the original item, returning `{ items }` replaces it with a `plugin` item. The transformer does not know which agent the chat belongs to.
- `addTimelineRenderer({ kind, version, schema, Component })` receives the chat pane's `agentId`, `timestamp`, `theme`, `layout`, and **no** `workspaceId` or `navigation`.
- Only the display changes; the history in the daemon and what the model reads stay the same. Undo = remove the two transformers and the renderer in `index.client.tsx`.

### 15.2 Chat card

Two transformers, `bm-chat-received` (`user_message`) and `bm-chat-sent` (`assistant_message`), call `toChatCard(item, phase)`; the renderer `CHAT_CARD_KIND` = `"bm-message"`, `CHAT_CARD_VERSION` = 1, `ChatCardView`. `toChatCard` never throws.

**When there is a card:**

- a `user_message` **without** `clientMessageId` (sent by an agent) that contains `BM-REPORT`, `BM-REVIEW` or a request id `req-YYYYMMDDTHHMMSSZ`;
- an **already complete** `assistant_message` (`phase: complete`, to avoid flicker while streaming) that contains `BM-REPORT` or `BM-REVIEW`;
- a `user_message` with `clientMessageId` becomes a `reply` card only when it is the message written by a card's Reply box (first line `Reply from the user about …`); what the user typed themselves is left to Paseo;
- the plugin's own notices (prefixes in base design §7.5) are recognised by their first line: a `BM-FALLBACK` from which an `incident` can be read → a `fallback` card (§15.8), otherwise → plain text; the other prefixes → a `notice` card (`noticeCardOf`): a one-line summary of the notice (without the prefix and `requestId:`), a `requestId` chip when present, the full text one tap away; no template check, no Reply box.

A block that lists the allowed values (`phase: … | …`) is a format template, not a report. Every other item stays as it is.

**Data** (`chatCardSchema`): `type` (`report` / `review` / `message` / `fallback` / `reply` / `notice`), `direction` (`received` / `sent`), `requestId`, `batchId`, `phase`, `tier`, `verdict`, `blocking`, `blockers`, `beads { created, updated, closed }`, `gist`, `text`, `questions` (§15.3), `formatIssues`, `fallback`, `answers`, `notice`. The card is rebuilt from the message each time it is shown, and stored nowhere.

**Who sends, who receives** (`partiesOf(card, owner, peers)`), with data from `chat.peers({ agentId })` → `{ owner, peers, workspaceId }` where `ChatPeer = { id, role, title, status, parentId, requestId, batchId, labelled, archived, replaced }`. A Worker's `requestId` comes from its label, and without the label from the trace store using exactly the Metric rules; the store is read at most once and only when a label is missing (`peersOfWorkspace`, `server/chat-peers.ts`).

- A received report → the Worker of the request; a received review → the Reviewer matching `requestId` and `batchId`; any other message in a Worker's chat → the Manager (the parent if it is a Manager); in a Reviewer's chat → the parent Worker; in a Manager's chat → the Worker of the request.
- A message it wrote itself: the sender is the owner of the chat pane; the receiver is the parent Worker (review) or the Manager.
- **The Worker of the request** = `soleWorkerOf(peers, requestId)` (`shared/sole-worker.ts`, shared by server and client): a `worker` agent that is **not archived**, not replaced (`replaced`), carries exactly the `requestId`, and is **the only one**; none or more than one → none. `partiesOf` is only used for naming, so it falls back to the only Worker even when archived; the send path never does.
- When it cannot be determined, the role is written with "unknown", and no id is guessed.
- `drawAsCard(card, owner)`: the chat pane's owner is not a paseo-bm agent (`owner` null or `unknown`) → false; a received card is always drawn; a sent card is drawn only when the pane owner's role matches (review → Reviewer, otherwise → Worker), so a block quoted by the Manager shows verbatim. False → verbatim as Markdown, without the card frame.

**Layout:**

- Frame `styles.card`, no left border. Header row: the left column has `RoleMark` (only the icon carries the role colour), the sender's name (`sectionTitle`, colour `foreground`) `→ <receiver>`, and below it the send time `HH:MM`; the right-aligned right column has the status chip (`statusChip`: phase/verdict) and right below it the "Answered" chip when present.
- **The `template error` chip** (tone `danger`) when `formatIssues` is not empty: `checkBlocks(text)` (the template checker, base design §7.6) on another agent's block (received card), or on the Reviewer's own `BM-REVIEW` in its own chat (a Worker quoting its own report in its own chat has not sent anything yet). Opening the full text shows "This message breaks the template:" at the top and each error on its own line.
- `statusChip`: report `blocked` → `warning`, `finished` → `success`, other phases → `info`; review `pass`/`approved` → `success`, `stopped` → `muted`, otherwise `warning`, with `· <n> blocking` when present; a `reply` card reads "Your reply" (`info`); a `notice` card reads the notice (`muted`).
- A `requestId` chip (tone `muted`) when the card names a request, then a summary line (`summaryOf`), at most 2 lines (`numberOfLines={2}` even when open); the `waiting on: <blockers>` part is cut at `SUMMARY_BLOCKERS_CHARS` = 160 characters. A report with questions is summarised as `<tier> · <n> questions waiting`.
- Related beads: bead chips (§15.7).
- "▸ Show message" / "▾ Hide message" opens the full text as Markdown (`markdownOf`: a `key: value` block becomes a list with bold field names; `BM-QUESTIONS`/`BM-ANSWERS` are blocks like `BM-REPORT`, `Q<n>:` lines in bold, options indented under the question).
- **A `finished` card**: `startsOpen(card)` true and `outlineTone(card)` = `"success"` only when `type === "report" && phase === "finished"`, regardless of direction: the card opens with the full text shown and the frame has a success `borderColor` (still `borderWidth: 1`). `open` is component state, so a card that is unmounted and drawn again opens again.

### 15.3 Questions: `BM-QUESTIONS` and `BM-ANSWERS`

The Worker asks questions in a `BM-QUESTIONS` block right after `BM-REPORT`, in the same `blocked` message; `blockers:` only points to the block (the writing rule is in `worker.md`):

```
BM-QUESTIONS
requestId: req-20260917T010956Z
Q1: Storage — the request says "save the user list" but not where.
- a: the existing Postgres `users` table: no migration, ready today. (recommended)
- b: a new table: needs a migration, which makes this request Large.
```

The `Q<n>` ids keep counting across the whole request, so a late answer to an old turn does not clash with a new question's id. The answers:

```
BM-ANSWERS
requestId: req-20260917T010956Z
Q1: a — the existing Postgres `users` table: no migration, ready today.
Q2: other — <the user's words, line breaks turned into spaces>
```

**`plugin/shared/bm-questions.ts`** (pure, usable by the client; separate from `bm-report.ts` so that the report contract does not change):

```ts
interface QuestionOption { key: string; text: string; recommended: boolean }
interface Question { id: string; text: string; options: QuestionOption[] }
interface QuestionSet { requestId: string | null; questions: Question[] }
function parseQuestions(text: string): QuestionSet | null;          // the LAST BM-QUESTIONS block in the message
type Pick = { key: string } | { other: string };
function answersText(requestId, questions, picks): string;          // throws when a question is passed without an answer
```

`parseQuestions` is lenient because the input is written by a model: the opening `BM-QUESTIONS` line accepts `>`, `-`, `**`, a ``` fence; a question line is `Q<n>` followed by `:` `.` or `)` (also `**Q1:**`, `- Q1:`); an option must have a bullet or parentheses (`- a: …`, `- (a) …`, `a) …`, `(a) …`) — prose `a: …` is not an option; `(recommended)`/`[recommended]` is removed from the text, and more than one recommendation in one question → treated as none; a line indented by ≥ 2 spaces is joined to the line above; every line has its `>` quote prefix removed; a block ends at a line that opens another block, a closing fence (``` or `~~~`), or unindented prose **after** the first question (prose before the first question is a lead-in, ignored); a duplicate id/key keeps the first one. **Limits:** the whole message is scanned line by line (one regex anchored at the line start, no nested quantifiers, linear) to find the last opening line, then only 20,000 characters from there are read; at most 10 questions × 8 options; each piece of text is cut at 1,000 characters. A question with fewer than 2 options is still returned and can only be answered with "Other".

### 15.4 Question card and the Reply box

**When:** `toChatCard` fills `questions` when the card is a `report` and the block's `requestId` is empty or equal to the report's `requestId` (a block of another request is dropped). `showsQuestions(card, owner)` is true when the card is a `report`, `received`, the chat pane's owner is a Manager, and there are questions. Worker and Reviewer chats do not have this part; an old-style report without the block is an ordinary card.

**Layout of the question part:** one block per question (`gap: 6`, `paddingVertical: 8`, from the second question on a `borderTopWidth: 1` line in the `border` colour); the heading `questionHeading` (`Q6 · Storage`, the topic being the part before the first ` — `; with no topic, `Q6`) in `600`, the question in `styles.body` with colour `foreground`; each option is a `Pressable` as wide as the card (row: `○`/`●` 14 wide, the key in bold 16 wide, text `flex: 1`, a `recommended` chip in tone `success` at the end; `paddingVertical: 8`, `paddingHorizontal: 10`, `borderRadius: 8`, `borderWidth: 1`; selected: `info` border, `surface2` background; `accessibilityRole="button"`, `accessibilityState.selected`); a last row "Other…" (no key) opens an input box for that question. No option is preselected: `picks` starts empty. Under all the questions: the line `Answers go to <Worker> · <requestId>`, the reason line (when there is one), then the button row `Use recommendations` (`recommendedPicks`: fills the recommendation into questions still empty, does not overwrite, does not send), `Clear`, `Mark as answered`. When the receiver cannot be determined → the questions still show; the options, the Other box, `Use recommendations` and `Clear` are disabled (`Mark as answered` can still be pressed), with the reason. A running Worker does **not** disable the options: the user can compose in advance, and `sendReply` refuses when Send is pressed.

**Choices are written into the Reply box** — a single send path for every card:

- `isAnswered(question, pick)`: a real key of a question with ≥ 2 options, or "Other" with text after `trim`.
- `answersDraft(card, picks)` = `answersText` over only the answered questions; `""` when there are none or the card names no request.
- `withAnswersBlock(text, block)`: the block region is the first `BM-ANSWERS` line plus the lines right after it that match `^\s*(requestId|Q\d+)\s*:`. The user's text outside the region (above and below) keeps its order; **the block always comes first in the box**, then a blank line, then the user's text. Manual edits inside the block are overwritten on the next choice.
- Each time `picks` changes: `setAnswer(withAnswersBlock(answer, answersDraft(card, next)))` and the Reply box opens.
- The **Send** button is enabled when the box has text and nothing is being sent, and calls `sendReply({ card, text, refreshPeers, send })` with `refreshPeers` = `peers.refetch({ throwOnError: true })`, `send` = `paseo.agents.ref(id).send(text)` (the app's composer path; the message carries `clientMessageId` like the user's words):
  1. empty box → "Write a reply first.", nothing is called;
  2. read `chat.peers` again; `replyTarget(card, owner, peers)` returns a reason → nothing is sent;
  3. `send(peer.id, replyText(card, text))` **exactly once**, the id never taken from the message content; `replyText` = `Reply from the user about \`<requestId>\`[, batch <id>]:` + a blank line + the text;
  4. an error from `refreshPeers` or `send` → the reason; the box and the choices stay as they are.
- `replyTarget`: the receiver is `from` (received card) or `to` (sent card) of `partiesOf` and must be in `peers`. Blocking reasons: not found ("Cannot tell which Worker asked this: no single Worker has `<requestId>`." for a received report; "Cannot tell which <Role> to send this to." for other cards); oneself ("This is your own message."); archived ("<name> is archived." — a message to an archived agent would unarchive it); `running`/`initializing` ("<name> is working; a message now would replace its turn. Send when it stops."); any other state ("<name> is <status>."). Only `idle` and `error` may be sent to.
- After sending: "Sent to <name>.", the box is cleared and closed; if `sentSummary(card, picks, text)` is not `null` (the block is intact in the sent text) the question part is replaced by `Answered at HH:MM → <Worker>: Q6 a, Q7 other` (`answerSummary` lists only answered questions). Unanswered questions stay open and the Worker asks again.
- A `blocked` report **without** questions has two prefilled suggested sentences (`quickReplies`, not sent automatically); a report with questions does not.
- After a Reply, the "Reply to <role>" button gives way to the "Answered" chip (`replyControls(canReply, replied)`: `canReply` false → neither); pressing the chip reopens the Reply box.

### 15.5 Waiting questions: `chat.waiting` and the composer pill

- **Server** (`server/chat-waiting.ts`): for each Manager not archived and not closed, `readTimelinePages(paseo, managerId, { pages: 1, limit: 200 })` then `waitingOf(manager, entries, workers, answered)`: takes the `user_message`s **without** `clientMessageId`; the last report with a `requestId` of the form `req-…` is the message's report; keeps the latest report per request; keeps only `phase: blocked` with at least one question and a matching block `requestId`; Worker = `soleWorkerOf` in the same workspace, in state `idle` or `error`; questions that the question–answer ledger already has an answer for go into `answered`, and a report whose questions are all answered is dropped. A read error for one Manager only loses that Manager (the `try/catch` around `readTimelinePages` is kept on purpose: the function can still throw when `refetch` returns nothing). It reads the live timeline, not the trace store: a report only reaches the store when the Manager's turn ends, while the pill must show as soon as the question arrives. The trace store is read only for a workspace **that has a live Manager** and only when a Worker lacks its label.
- `WaitingWorker = { managerId, workspaceId, workerId, workerTitle, requestId, text, at, answered }`; `text` is the whole report message, so that the client rebuilds exactly the card.
- **Client** (`waiting-pills.tsx`, `waiting-pills-model.ts`): `registerWaitingPills(client)` reads `chat.waiting` at once and then every `WAITING_POLL_MS` = 15,000 ms, without overlapping runs; on an RPC error it keeps the pills and reports nothing. `planPills(current, waiting)` → `{ add, update, remove }`; pill id `bm-waiting-<workerId>`, attached to the composer of the Manager's chat (`addComposerPill({ id, workspaceId, agentId: managerId, button: { …, behavior: { kind: "popover", Content } } })`; a registration cannot move to another chat, so a Manager change removes and re-adds it); no open question left → no pill; the key `[managerId, workspaceId, requestId, label, at ?? "", fnv1a32Hex(text), answered]` — it includes a content hash so that a new report with the same number of questions (and a null `at`) still reaches the popover. Label `<Worker> · <n> question(s)` (only questions still open), title `Questions from <Worker> about <requestId>`, icon `MessageCircleQuestion`. Popover: each pill has **one** `Content` created when it is added, which reads the latest entry from a module-level `Map`, so an `update` does not rebuild an open popover and text being typed is not lost; `Content` draws `ChatCardView` with the card built from `toChatCard({ type: "user_message", text }, "complete")`, so it has all the questions, the Reply box, the state checks, the "Answered" chip. There is no API to scroll the chat to an item.
- Limit: only the 200 newest items of the Manager's timeline; a `blocked` report older than that looks like "no longer waiting" and has no pill, but can still be answered with the card's Reply box.

### 15.6 The "answered" state

- **Within the app session** (`answer-state.ts`, no React): the tables `answered` (key → `{ at, summary, to }`) and `replied` (key → `Date`), `setAnswered`/`setReplied` notify all listeners (`subscribeAnswers`), `answersVersion()` is the snapshot; `chat-card.tsx` reads them with `useSyncExternalStore`, so the copy in the chat and the copy in the popover redraw at the same time. Lost on an app reload.
- **Key** `answeredKey(agentId, card)` = `<chat agentId>|<requestId>|<the question ids>` — the message content is not hashed: a report resent with one field edited must not produce a second empty card for questions already answered. In exchange, two different sets of questions reusing the same ids in one request would share a key (the Worker keeps counting ids, so this should not happen).
- **The "Mark as answered" mark** is stored durably (`server/answer-marks.ts`): `<install home>/ui/answer-marks.json` = `{ schemaVersion: 1, marks: [{ key, at }] }`; key 1–`ANSWER_MARK_KEY_MAX` (400) characters, no control characters; keeps at most the `ANSWER_MARKS_LIMIT` = 500 newest marks. Read/written through the no-follow checker and written atomically like the trace store (§3.8). A broken or newer-generation file reads as empty, with `notices`; a broken key in the file is dropped, with `notices`; an invalid key or a newer-generation file on write → `E_TRACE_STORE_UNWRITABLE`. The button calls `answers.mark` then writes the result into the `answer-marks` cache; an error shows on the card.
- **A card knows by itself that it has been answered** (only `showsQuestions` cards): `useQuery(["paseo-bm", "chat-waiting"], refetchInterval 15 000)` and `answers.marks`, sharing the cache, so one read serves every card. `stillWaiting` = there is an entry with the same `managerId`, `requestId` and verbatim message. `answeredHow({ sent, marked, waiting, stillWaitingNow })`: `sent` → "sent" (`Answered at … → …`); `marked` → "marked" ("Marked as answered."); `waiting` known and the card no longer waiting → "moved-on" (`Answered, or <Worker> is working or has reported since.`); `waiting` not known yet → nothing is inferred. Once answered, the "Answered" chip shows and the Reply button is hidden.
- **A question that the question–answer ledger already has an answer for** (`answered` of a `chat.waiting` entry): shows "Answered." (tone `success`) instead of the options, and cannot be chosen; `Use recommendations` skips it; a choice made earlier for that question is removed from the `BM-ANSWERS` block in the Reply box.

### 15.7 Beads in the chat

- **Bead chips on a card:** `shared/bead-ids.ts` finds strings shaped like bead ids (leaving out request ids, paths, command flags, URLs). `BeadChips` takes **every** candidate (≤ 100), looks them up with `beads.lookup` (which keeps only ids that really exist, so `feature-workflow` or `BM-REPORT` never becomes a chip), and **only then** cuts: `beadChipsView(found, expanded)` uses `visibleBeads` with `BEAD_CHIPS_SHOWN` = 2; the rest go behind a "…" chip (tone `muted`, label "Show all N beads"), pressed to expand, with no collapse button. No bead really exists → nothing is drawn. A chip reads `beadChipText` (`<title, ≤ 48 characters> · <id>`), toned by `statusBadge`; pressing opens the detail right inside the card (`BeadInline`, reusing `BeadDetailPanel` with the three actions). `chat.peers` returns `workspaceId` to know which store to look up.
- **The "Beads in this chat" panel** (`addWorkspacePanel`, `id: "bm-chat-beads"`, `context: "agent"`): a Worker's ordinary questions are chat text, and turning them into cards would change the chats of other agents too, so beads are gathered in a panel. `chat.beads` reads `CHAT_BEADS_PAGES` = 2 pages × `CHAT_BEADS_PAGE_SIZE` = 200, i.e. the 400 newest items, takes ids from messages and shell commands, keeps only ids that really exist, counts the mentions, sorts by most recent mention, at most `CHAT_BEADS_LIMIT` = 30. The panel refreshes every 15 s; a row is a `BeadRowCard`, no grouping, no eye button.
- Every chat RPC is in `server/chat-rpc.ts` (`registerChatRpcs`), separate from `dashboard-rpc.ts`; the shared timeline read loop is `readTimelinePages` (`live-timeline.ts`).

### 15.8 Fallback incident: card and pill

The incident detection rules, the candidates, `BM-FALLBACK` and `fallback.incidents` / `fallback.act` are in base design §7.10; this is only the part that shows up.

- **Card** (`fallbackCardOf`: first line exactly `BM-FALLBACK` and an `incident` can be read). The card keeps only the incident id; state, candidates and reset time come from `fallback.incidents({ ids })`, key `["paseo-bm", "fallback-incident", id]` shared with the pill's popover, re-read every `WAITING_POLL_MS` while `pending`/`waiting` — the text of the message is never the state.
- **Layout:** `RoleMark` + "<Role> stopped by its provider plan", the time, a state chip (`pending` → `warning`; `switched`/`resumed` → `success`; `waiting` → `info`; `dismissed`/`expired` → `muted`; `exhausted`/`failed` → `danger`); a `requestId` chip; the line `Usage limit (L1) | Billing (L2) | Login (L4) | Provider unavailable (L5) · <alias> · <model>`; the provider's words (mono, 3 lines).
- **Buttons, only when `pending`:** "Switch to <alias> · <Provider> · <model>[ · ~$in / $out per 1M tokens]" when there is a candidate (price: `MODEL_PRICES` then `roles.options`); "Wait until <machine time>" when `resetsAt` is no more than `FALLBACK_MAX_WAIT_MS` (7 days) away, and once it has passed "Resume now (the limit reset at …)"; "I'll handle it" is always there. A `switched` Reviewer that has no `replacementId` yet → only "Resend to Worker". Each button is one `fallback.act`; the result is the new state; an error → "Could not <action> (<code>): …" and then a re-read.
- No longer `pending` → one state line (`fallbackStatusLine`); a `switched` Manager: "A new Beads Manager is running on … Open Beads Manager from the sidebar or Command Center to continue with it."
- **Pill:** each Manager with a `pending` incident (from `chat.waiting.fallback`) gets one pill `bm-fallback-<managerId>`, icon `FALLBACK_PILL_ICON` = `TriangleAlert`, label `Fallback · <n> decision(s)`, title "An agent stopped by its provider plan waits for your decision" (several: "<n> agents stopped by their provider plan wait for your decision"). The popover draws one card per incident (`fallbackCardOfIncident`), oldest first, with all the buttons. It shares the `chat.waiting` read loop and `planPills` with the question pill; the key consists of the Manager and the incident ids.

## 16. Performance

| Where | How |
|---|---|
| Writing the trace | One `write` + `fsync` per turn; target under 50 ms; an error never blocks the agent |
| Reading the trace | By month file, newest to oldest, stopping at `limit` (50); `mtime`+`size` cache |
| Timeline | Only catches up the running turn, or when the store is off; capped at 2,000 entries per agent per read |
| Beads store | Capped at 32 MB; `(path, mtimeMs, size)` cache |
| Client | `useQuery` with keys that include `workspaceId`; trace detail loaded only on open; the polling intervals in §2.4, none of which runs while its screen is not shown (except the pills and the header button, which are tied to the app) |

## 17. Security & Privacy

- **Write boundary:** `<install home>/traces/**`, `<install home>/ui/**`, `<install home>/role-extras.json`. No writing into the workspace, `~/.paseo`, skill folders, `install.json`. **(0.4.0)** The data folder (base design §5.1) replaces `<install home>`; `ui/setup-state.json` is added; the Paseo configuration only through `config.patch` of base design §6.2; deletion only through `setup.cleanup` and only the entries listed in base design §7.13.7.
- **Reading disk outside its own part:** `<workspace>/.beads/issues.jsonl`, `<install home>/install.json` (only to confirm the install home; **(0.4.0)** only to know whether it exists, for the migration banner), the plugin's `role-fallback-state.json`, and the skill folders (only `SKILL.md`, for the Setup screen). **(0.4.0)** Plus `~/.paseo-bm/home.json` (the pointer).
- **Secrets are masked before writing**, not only before rendering: the rules come from `src/redact.ts`, and the plugin has a copy of the constants because it does not import `src/`.
- `env` is not recorded: the collector does not use the `agent.create` hook.
- Permissions: folders `0700`, files `0600`.
- Deletion is the user's right: no path deletes traces on its own; the uninstall command must ask.
- The Metric screen states plainly that it shows and stores agent conversations.
- **No network** in any dashboard flow. Deliberate exception: `setup.install-tool` runs an installer downloaded from the network, only when the user presses and confirms the verbatim command (`confirmed: true` required by the schema); the `bv` script is pinned to a commit, the `br` script checks its own SHA256. **(0.4.0)** A second exception under the same rule: `setup.install-skills` runs the `skills` CLI (downloading from npm and GitHub); `providers.diagnostic` is the daemon asking its provider, not the plugin going out to the network.
- The Beads screen and chat cards **send messages to agents** (bead actions, Reply): always through a confirmation or an explicit send button, always re-reading the receiver's state, never sending to an agent that is running or archived. The Metric screen creates, stops or sends nothing to any agent.

## 18. Reliability

- An agent archived or deleted → the trace keeps everything already stored; `agentsMissing` with a notice.
- A trace write error → skipped, one line logged, the Dashboard shows "traces may be missing".
- A store with a newer `schemaVersion` → limited reading, no writing.
- A trace file with one broken line → exactly that line is skipped and counted in `skippedLines`.
- `reset`, `gap`, `staleCursor` from the timeline → read again once and attach a notice.
- A host lacking the timeline API or the `before`/`on` hooks → exactly that part is turned off, with a notice. A host lacking `navigation.openAgent` → the "Open …" buttons hide themselves.
- An RPC error → each screen shows a red line with the code and a Refresh button; the rest (including the sub-tab row) stays usable.

## 19. Test strategy

| Layer | Principle |
|---|---|
| Logic | Every decision is in a pure module (`*-model.ts`, `chat-cards.ts`, `dashboard-view.ts`, `slot.ts`, `shared/*`, `server/*`), tested with Vitest without a renderer. Each behavioural criterion has a negative control that has been seen to fail |
| View | Hook-free views are built with `test/helpers/element-tree.ts`; placement (e.g. the status strip on every view) is checked with assertions on the source code. Files in `test/` do not import `react-native` as a value |
| Store | Write then read back; duplicate keys including reused turn ids and a rewrite stamped with the write time; broken lines, a half-written last line; symlinks at every level refused and the target unchanged by a single byte; a barrier for writes concurrent with delete/reassign |
| Contract | The exact RPC list in `test/plugin-bundle-cjs.test.ts` and `test/rpc-list-describe.test.ts`; the client entry does not import `server/`, `shared/` does not import Node |
| Negative | No writing outside the boundary of §17, no network, Metric calls no write function of the SDK |
| Real data | The readers are tried on strings written by real agents; acceptance runs on a real daemon write a run record in `docs/operations/`. The visual part (colours, layout, gestures) is checked by the owner on a real daemon, on desktop and phone |

## 20. Compatibility

- A new version reads an old version's store; an old version meeting a newer store reads it in limited mode and does not write. A version update does **not** delete the store, including `--prune`.
- Fields added to a payload (`errors`, `usageByModelRole`, `usageByModel`, `runtime`, `labelled`, `replaced`, `answered`, …) are always optional or have a default.
- Agents created by an earlier version (without the `bm.requestId` label) still show, at the `inferred` level.
- The `BM-REPORT` reader reads the current format and the previous one; a report without `BM-QUESTIONS` gives an ordinary card. Instructions are attached when the agent is created, so an old Manager/Worker and a new plugin still understand each other: the card still has its buttons because the card is plugin code.

## 21. Open questions

| ID | Question | Affects |
|---|---|---|
| Q-042 | The size threshold is only machine-wide because Paseo only has `scope: "host"`; is a per-workspace threshold (stored in `meta.json` ourselves) needed? | §3.6 |

## 22. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | hieu.nt10 (drafted by Claude) | §11.2: the launcher's error line (and the agent tree's "Could not load …") shows the server's message without the `Request failed: … requestType=… code=…` wrapper the app receives from `DaemonRpcError`, and without repeating the code; before this, `errorCodeOf` could never extract the code in the app |
| 2026-09-26 | hieu.nt10 (drafted by Claude) | §11.3: the agent tools status sentence when off becomes "Off — no new Beads Manager starts until you allow them", because from 0.4.0 `manager.ensure` does not create a Manager while the switch is off (base design §7.3); the old sentence saying the Manager "may not be able to create a Worker" is no longer true |
| 2026-09-25 | hieu.nt10 (drafted by Claude) | **ADR-012: a single source — machine setup moves to Setup (target release 0.4.0).** §11.3: call `setup.ensure-roles` when the screen opens, the "created its roles with defaults" line, the migration banner, the "Set up paseo-bm" card with five rows (roles, agent tools with the machine-wide warning, skills with the third-party note, `br`/`bv`, sign-in showing only the command), the "Install skills…" button on the skills tab, the agent tools and sign-in blocks on "Roles & models", the "This install" block with the data folder and the "Remove paseo-bm's settings…" button with a second confirmation for the data (default keep). §3.1 points to the new data folder; §5 adds four RPCs and five error codes (contract in base design §7.13); §11.2 `setupNotice`; §1, §2.1, §2.4, §17 updated. §21: Q-039 removed (answered in ADR-012 decision 6). Still three tabs, per REQ-069 (f). Independent `design-ready` review the same day: §11.3 adds the verbatim status sentence for each row of the "Set up paseo-bm" card (reusing the existing sentences of `setupHeadline` and the agent tools block) |
| 2026-09-25 | hieu.nt10 (drafted by Claude) | Review after the merge: checked each delta in the History table, the interface part of the four base deltas (17e, 18, 21, qa-ledger) and REQ-059 against the code. Added: the "Roles & models" screen and the fallback chain (§11.3), the running dot and the Manager-opening status line (§11.2, §11.4), model lines on the graph (§12), the fallback incident card and pill (§15.8), the `notice` card, the `template error` chip, `statusChip`, `drawAsCard` (§15.2), the "Beads agents" panel (§14), the bead counting rule and reading the short `.N` ids (§6.3, §6.4), `managerRequestId` and bare `req-…` ids (§6.1, §6.3), the effect of the question–answer ledger on the card (§15.6), the reason for choosing a text fingerprint (§3.3). Corrected to match the code: `chat.beads` reads 400 items, `agents.list` fetches every agent then `roleOfAgent`, `close_with_evidence` exact needs no store confirmation, the order and the disabled parts under the questions, `StatusTabs` has button colours, `chat.waiting.fallback`, the scope of §1 (the Roles & models and fallback interface belongs to this document). Stated that there is no load-more button yet (§12) |
| 2026-09-25 | hieu.nt10 (drafted by Claude) | **Merged into a living document.** Merged the 11 deltas in the History table into this one, rewritten by screen/component and to match the current code (§2.4, §11–§15 new; §3.3, §3.6, §4, §5, §6, §8 updated to the code); removed the old §14 "Impact on frozen documents" and assumptions A-1, A-2 (checked: a report to the Manager is a `user_message`; the collector calls `timeline.refetch` to get timestamps). From now on edited in place |
| 2026-09-25 | hieu.nt10 (drafted by Beads Worker) | Per the kanban-quiet-colours delta: a four-column kanban, bead status expressed by text and contrast, three tabs for Setup, `TraceSummary.errors` and the Errors card |
| 2026-09-19 | hieu.nt10 (drafted by Beads Worker) | Per delta 20260918e batch `b6`: the `bm-beads-open` header button; Paseo 0.8's mobile app has no "+" |
| 2026-09-18 | hieu.nt10 (drafted by Beads Worker) | Per delta 20260918f: UI review — the `createSlot` slot, a request to open the Manager is not dropped, the status strip on Metric/Beads, workspace figures read only while the list is shown, bead chips looked up before cutting, `chat.peers.archived`, `soleWorkerOf`; the pinning feature removed (`launcher.order.*`) |
| 2026-09-18 | hieu.nt10 (drafted by Beads Worker) | Per delta 20260918e: the `bm-beads` panel with two sub-tabs; Setup is the main screen; four groups, the eye button, `doneText`; the 14-day chart removed |
| 2026-09-18 | hieu.nt10 (drafted by Beads Worker) | Errata per delta 20260918 (manager-mode-model-metrics): `runtime` in the record, `usageByModelRole`, `usageByAgent[].runtime`, `usageByModel`; aggregation by effective model |
| 2026-09-17 | hieu.nt10 (drafted by Claude) | Per delta 20260917e: requests split into segments by the turns in which the user asks; `workspaces.overview.runningAgents` |
| 2026-09-17 | hieu.nt10 (drafted by Claude) | Errata per delta 20260917d: the deduplication key adds a fingerprint of the turn's content; anonymous Manager turns are merged only within the same Manager |
| 2026-09-16 | hieu.nt10 (drafted by Claude) | Version 5 after the acceptance run on a real daemon (delta acceptance-fixes): eight rules for re-reading traces |
| 2026-09-16 | hieu.nt10 (drafted by Claude) | Approved by the owner; `design-ready` PASS; Draft → Active |
| 2026-09-16 | hieu.nt10 (drafted by Claude) | Versions 2–4: durable trace on disk, deleting, reassigning, the no-follow path checker and the per-workspace mutex (after an independent review with Codex) |
| 2026-09-16 | hieu.nt10 (drafted by Claude) | First Draft |

## History

The deltas merged into this document. The files live in `docs/archive/` (the source code cites them by name and section) but they are only historical records; the current state is this document.

| Delta | Date | Brought in |
|---|---|---|
| [delta-20260916-acceptance-fixes](../archive/design/paseo-bm-delta-20260916-acceptance-fixes.md) | 2026-09-16 | Eight rules for re-reading traces after the real acceptance run: buckets by `requestId`, cost always estimated, bead ids only in positional arguments, only the last report decides the state, the exact negative for polish, records of a deleted agent still belong to the request |
| [delta-20260916-beads-screen](../archive/design/paseo-bm-delta-20260916-beads-screen.md) | 2026-09-16 | The Beads screen, `beads.list/get/action`, three actions that hand out work through the Manager, `E_BEAD_NOT_FOUND` |
| [delta-20260916-chat-cards](../archive/design/paseo-bm-delta-20260916-chat-cards.md) | 2026-09-16 | Chat cards for messages between Manager, Worker, Reviewer; `chat.peers`; bead chips, `beads.lookup`, the "Beads in this chat" panel |
| [delta-20260916-owner-feedback](../archive/design/paseo-bm-delta-20260916-owner-feedback.md) | 2026-09-16 | Metric as cards + charts + graph; `origin` and `skill` evidence; role icons; worktree folders; who is working on a bead; `workspaces.overview`; `store` down to bytes only (the role instructions part is not merged here) |
| [delta-20260916-setup-screen](../archive/design/paseo-bm-delta-20260916-setup-screen.md) | 2026-09-16 | The Setup screen: additional instructions per role, skill check, `br`/`bv` and the Install button (the `--install-beads-tools` CLI part is not merged here) |
| [dashboard-delta-20260917d-request-attribution](../archive/design/paseo-bm-dashboard-delta-20260917d-request-attribution.md) | 2026-09-17 | Deduplication adds a fingerprint of the turn's content; anonymous Manager turns are merged only within the same Manager |
| [delta-20260917e-manager-screen-and-commands](../archive/design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) (interface part; the rest is in the base design) | 2026-09-17 | Requests split into segments, `runningAgents` and the running dot, slash command notices on the status strip; pinning removed |
| [delta-20260918-manager-mode-model-metrics](../archive/design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) (model metrics part) | 2026-09-18 | `runtime`, `usageByAgent[].runtime`, `usageByModel`, `usageByModelRole`, model lines on the graph, `modeNotice` on the status strip |
| [delta-20260918c-question-cards](../archive/design/paseo-bm-delta-20260918c-question-cards.md) | 2026-09-18 | The `BM-QUESTIONS` / `BM-ANSWERS` blocks, the `bm-questions.ts` reader, question cards in the Manager's chat (the writing rules of `worker.md`/`manager.md` are not merged here) |
| [delta-20260918d-card-replies](../archive/design/paseo-bm-delta-20260918d-card-replies.md) | 2026-09-18 | A single `sendReply` send path for every card, choices written into the Reply box, the question layout, the "Answered" chip, `chat.waiting` and the pill, "Mark as answered", `finished` cards open by default (the `manager.md` part is not merged here) |
| [delta-20260918e-beads-tab](../archive/design/paseo-bm-delta-20260918e-beads-tab.md) | 2026-09-18 | The "Beads" tab with two sub-tabs, Setup as the main screen, the status strip, the eye button, `doneText`, the header button |
| [delta-20260918f-ui-review](../archive/design/paseo-bm-delta-20260918f-ui-review.md) | 2026-09-18 | UI review: `createSlot`, a request to open the Manager is not dropped, `WorkspaceScreenHeader`, `overviewPolling`, the pinning feature removed, bead chips looked up before cutting, `soleWorkerOf` and `archived`, the pill does not rebuild the popover |
| [delta-20260921-worker-fallback-and-role-settings](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) (interface part) | 2026-09-21 | The "Roles & models" screen and the fallback chain, the fallback incident card and pill, `replaced by` in the "Beads agents" panel, the Pi/OpenCode skill columns |
| [delta-20260924-qa-ledger](../archive/design/paseo-bm-delta-20260924-qa-ledger.md) (interface part) | 2026-09-24 | `answered` on the pill and the question card |
| [delta-20260925-kanban-quiet-colours](../archive/design/paseo-bm-delta-20260925-kanban-quiet-colours.md) | 2026-09-25 | A four-column responsive kanban, bead status by text and contrast, three tabs for Setup, `errors` and the Errors card on Metric, `beadActionResults` |
