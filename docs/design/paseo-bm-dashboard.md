# paseo-bm — Orchestration Dashboard (Technical Design)

| Field | Value |
|---|---|
| Status | **Active** — gate `design-ready` PASS 2026-09-16 |
| Living document | From 2026-09-25 this document is **edited in place** and always describes the current state; each edit adds one Revision History line, and git is the audit trail. The old deltas merged into it remain only as historical records (the [History](#history) table) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| Requirements source | [Orchestration Dashboard PRD](../product/paseo-bm-dashboard-prd.md) (REQ-040 → REQ-069); REQ-059 (question card) lives in the [base PRD](../product/paseo-bm-prd.md) |
| Base design | [paseo-bm — Technical Design](./paseo-bm.md) — this document **extends** it: the install home, roles, instructions, fallback and slash commands are there |
| Related ADRs | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (trace store) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) (the agent lifecycle belongs to the user) · [ADR-006](../adr/ADR-006-role-registration.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (the plugin is the whole product; machine setup in Settings) |
| Reference environment | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0; Paseo CLI/daemon 0.8.0; Node ≥ 22. **(0.4.0)** Paseo ≥ 0.9.0 |

## 1. Scope

**This document owns:**

- the trace store (location, layout, schema, writing, reading, deleting, reassigning, measuring size) and the collector hooked on lifecycle hooks;
- how a trace is built per request, the `BM-REPORT` / `BM-REVIEW` / `BM-QUESTIONS` / `BM-ANSWERS` readers, how time is measured, how state is inferred, how errors are counted, how the feature-workflow step is inferred, how tokens and cost are computed;
- the `.beads/issues.jsonl` reader and the actions that hand out work from the Beads board;
- the client pieces the "Beads Manager" surface is built from — the surface's views and hand-offs, the status strip, the Settings blocks (including "Roles & models"), a project's page (Requests, the Beads board, Agents), the history actions — the "Beads" tab and the header button, chat cards v2, the "Beads in this chat" and "Beads agents" panels. What the Inbox, Work, Insights and Settings show, and the decision card, are specified in the [autonomy design](./paseo-bm-autonomy.md) §A.12; this document says how those pieces work;
- the RPCs that feed the above (§5) and their error codes.

**Does not own** (they are in the [base design](./paseo-bm.md) or its still-living deltas): the content of `plugin/roles/*.md` (including the rule for the Worker writing `BM-QUESTIONS`, how the Manager relays answers, the `bm.requestId`/`bm.batchId` labels); the installer and the CLI (including `--install-beads-tools`; **(0.4.0)** the migration CLI); the install home layout (**(0.4.0)** the data folder, `setup-state.json`); the server contract, write rules and error codes of machine setup (`setup.ensure-roles`, `setup.grant-agent-tools`, `setup.install-skills`, `setup.cleanup`, the `setup` field of `setup.status` — base design §7.13); how agents are created and the `agent.create` hook; `manager.ensure`, `agents.list`, `roles.describe`, `agents.stop-all`; the server contract for role, model and fallback settings (`roles.settings`, `roles.options`, `roles.save-settings`, `roles.save-fallback`, `fallback.*`, the incident detection and handling rules); the decision store and its RPCs (autonomy design §A.3–§A.6); the plugin's agent tools (ADR-010); the two slash commands `/bm-worker-new` and `/bm-worker-stop-all`. This document only describes where those parts show up on screen.

## 2. Architecture

### 2.1 Modules

```
plugin/
  index.client.tsx            registers surface, sidebar, 3 Command Center items, settings screen,
                              2 timeline transformer + 1 renderer, 3 workspace panel, header button
    client/launcher.tsx         surface "Beads Manager": section router (Inbox · Work · Insights · Settings),
                                status strip, running dot
    client/surface-view.ts      the surface's views, back links and Command Center hand-offs (pure)
    client/inbox.tsx            Inbox        client/inbox-model.ts
    client/orchestrator-line.tsx the Inbox's Orchestrator line   client/orchestrator-model.ts  its wording,
                                and the stage bar and M W R letters of Work's rows
    client/work.tsx             Work: project rows, a project's page (Requests · Beads · Agents)   client/work-model.ts
    client/insights.tsx         Insights     client/insights-model.ts
    client/settings-section.tsx Settings     client/settings-model.ts
    client/settings-blocks.tsx  the Settings blocks: Roles & models, fallback chains, tools, skills,
                                agent tools, cleanup; RoleFields, useBusyAction
                                client/settings-roles-model.ts    roles and fallback chains: wording
                                client/settings-machine-model.ts  tools, skills, agent tools, sign-in,
                                data folder, cleanup: wording and confirmations
    client/ui-types.ts          ConfirmDialog, the shape every confirmation shares (pure)
    client/dashboard-actions.tsx delete / reassign request history
    client/beads-screen.tsx     the Beads board (kanban, filters, detail, actions)
    client/beads-tab.tsx        workspace panel "Beads": the workspace's project page
    client/beads-header-button.ts  "Beads" button on the workspace header
    client/tree.tsx             panel "Beads agents", Work's Agents tab     client/agent-tree.ts   its logic
    client/chat-card.tsx        chat cards v2 and the live DecisionCard (rendering)
                                client/chat-card-{parse,events,parties,frame,decision,precedent,markdown}.ts
                                pure logic
    client/chat-beads-panel.tsx panel "Beads in this chat"
    client/format.ts, tone.ts, styles.ts   the shared view kit (pure); format.ts holds the one
                                duration style and the one date style
    client/errors.ts            errorMessageOf, errorCodeOf, codedReason: an RPC error as text
    client/history-model.ts     request history wording, storage notices, the delete/reassign gate
    client/ui.tsx               shared views, no hooks
    client/*-model.ts, launch-manager.ts, slot.ts   pure logic
    client/settings.tsx         storage threshold settings screen
  index.server.ts
    server/collector.ts         turn_started / turn_ended hooks → write the trace
    server/trace-store.ts       read/write/measure/classify the store; path checker; mutex
    server/trace-store-rewrite.ts   delete and reassign, on trace-store.ts's checker and mutex
    server/data-files.ts        the data folder's file primitives (no symlink, 0700/0600, atomic
                                replace, append) and createJsonFileStore, the JSON store factory
    server/traces.ts            build traces, split segments, status
    server/trace-timing.ts      timing, bead actions      server/trace-usage.ts   tokens, cost, context per agent
    server/trace-views.ts       summaries, detail, errors, pages
    server/paseo-directory.ts   workspaces, their directories, the paseo-bm agents (DashboardPaseo)
    server/workflow-steps.ts    feature-workflow steps    server/cost.ts   token → cost
    server/beads-store.ts       read .beads/issues.jsonl  server/bead-work.ts   who is working on a bead
    server/bead-actions.ts      beads.list/get/action     shared/shell.ts   br read commands
    server/dashboard-rpc.ts     RPCs for requests, beads and the workspace figures
    server/rpc-kit.ts           what every RPC handler shares: the data folder (dataHome,
                                requireDataHome), error coding (coded, errorText), readOr
    server/coordination-rpc.ts  coordination.settings / coordination.set
    server/chat-rpc.ts          chat.peers, chat.beads
    server/chat-peers.ts        peersOfWorkspace, workspaceRecordsReader
    server/live-timeline.ts     readTimelinePages (shared)
    server/setup-rpc.ts, setup-tools.ts, setup-skills.ts, role-instructions.ts   Settings: tools, skills, roles
    server/setup-roles.ts, setup-machine.ts, setup-state.ts, data-home.ts   (0.4.0) machine setup, base design §5, §7.13
  shared/contracts.ts           the barrel: re-exports shared/contracts/*, the Zod contracts for
                                every RPC, one module per area
  shared/bm-report.ts           BM-REPORT/BM-REVIEW parser (server/bm-report.ts only re-exports)
  shared/bm-questions.ts        BM-QUESTIONS/BM-ANSWERS parser/composer
  shared/bead-ids.ts, sole-worker.ts, order.ts, prices.ts, settings.ts
  shared/time.ts, text.ts       timeOrNull / timeOrZero; plural, shorten — one definition each
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
  chat.peers                    agents.list + trace store when labels are missing
```

`traces.list` does not read the timeline when every trace of the page is already finished in the store — which is what keeps D-1 (≤ 3 seconds) when the store is large.

### 2.4 Common rules for the client

- React Native primitives only; every color comes from the theme via `toneColor(theme, tone)`, `Tone = "muted" | "plain" | "info" | "warning" | "danger" | "success"` (`plain` = `foreground`, `muted` = `foregroundMuted`, `info` = `accent`, the other three tones are `status*`). No hard-coded color codes, no alpha channel spliced into a color string: tinting is done with an absolutely positioned overlay `View` with `opacity`. Coloured text goes through `<ToneText tone>`, and a pressable text button through `<Button>` (label, role, disabled and busy states for screen readers).
- **One duration style and one date style** (`client/format.ts`, pinned in `test/plugin-dashboard-model.test.ts`): durations `450 ms`, `12 s`, `3 min 5 s`, `1 h 20 min`, `2 d 3 h` (at most two units), time ago `just now`, `12 min ago`, `2 d 3 h ago`; dates `15:40` today, `yesterday 15:40`, `tomorrow 15:40`, else `Thu 24 Sep 15:40`, with the year when it is not this year, in the device's time zone.
- Interface text is in English; everything pressable has an accessibility label; usable at `layout.compact` (padding 12 instead of 24).
- Shared drawing code is **hook-free views** in `ui.tsx` (`WorkspaceScreenHeader`, `BeadRowCard`, `StatusTabs`, `KanbanBoard`, `StatCards`, `BarChart`, `Chip`, `RoleMark`, `ConfirmBlock`, `CardFrame`, `CompactLine`, `Button`, `ToneText`), so that `test/helpers/element-tree.ts` can build the tree without a renderer.
- State that survives a component unmount but not an app reload lives in a module, read with `useSyncExternalStore`: `createSlot<T>()` (`slot.ts`), `createSessionToggle`, `createSessionMap` (`beads-model.ts`). State that must survive a reload lives on the server, in `<install home>` (**(0.4.0)** the data folder, base design §5.1).
- No background polling, except the deliberate intervals: the Inbox 5 s (only while shown), Work's rows and figures 10 s (only while shown), a project's requests and decisions and an open live request's detail 10 s (only while shown), a decision card 5 s (only while the decision can be answered), the header button 15 s, the "Beads in this chat" panel 15 s, the "Beads agents" panel and Work's Agents tab 5 s.

## 3. Trace store

### 3.1 Finding the install home

The server bundle has no cwd and cannot read `import.meta.url`, yet must honour `--home` / `PASEO_BM_HOME`. The order today, stopping at the first step that succeeds:

1. `paseo.config.get()` → `config.plugins["paseo-bm"]` is `{ source: "directory", path }` with `path` = `<install home>/plugin/<version>`, so `<install home>` = `dirname(dirname(path))`.
2. Confirm with `<install home>/install.json` having a readable `schemaVersion`. No match → step 3.
3. Fall back to `~/.paseo-bm`. Still no `install.json` → tracing is **off**, with a notice; the beads reading still runs.

`install.json` is only read, never written.

**(0.4.0)** Replaced by `resolveDataHome()` of base design §5.1: `PASEO_BM_HOME` → the pointer `~/.paseo-bm/home.json` → `~/.paseo-bm`; the plugin **creates** the folder itself (`0700`) on the first write and no longer reads `install.json`. Tracing is off only when `resolveDataHome` returns `home: null` (an unsafe folder, a broken pointer); the reason shows in the notices of `traces.list` and in the Data group of Settings (§11.4). Every `<install home>` path in this document reads, from 0.4.0, as `<data folder>`.

### 3.2 Layout

```
<install home>/traces/                     0700
  meta.json                                0600   { schemaVersion, createdAt, updatedAt }
  <workspaceId>/                           0700
    meta.json                              0600   { lastKnownName, lastKnownDirectory, lastSeenAt }
    events-202609.jsonl                    0600   append-only, one record per line
<install home>/ui/                         0700   plugin state that must survive a reload (setup state, …)
<install home>/role-extras.json            0600   retired, never read; deleted by the cleanup with the data (§11.4)
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
  evidence: [evidence],       // shell commands, files written, sub_agent, skills loaded; a shell entry may
                              // carry status, exitCode, cwd, callId (optional, autonomy design §C.1); every
                              // detail and cwd masked
  usage:    usage | null,
  runtime?: { model, thinkingOptionId, modeId, provider? } | null,
  pluginVersion?: string | null }

traceMessage = { agentId | null, at, text, truncated, origin?: "user" | "agent" }
```

- **`origin`**: `user` when the message carries `clientMessageId` (the user typed it in the app), `agent` when an agent sent it with `send_agent_prompt`. An old record without this field is **never** treated as the user's words.
- **`runtime`**: what the agent actually ran in that turn, taken from the `timeline.refetch` snapshot — `runtimeInfo` first, the configured fields (`model`, `effectiveThinkingOptionId` → `thinkingOptionId`, `currentModeId`) only as a fallback; `null` when the snapshot cannot be read. `provider` (added by the fallback delta 20260921) is used to price a model that is not in the price table. `usage.model` keeps the old source.
- **`pluginVersion`**: the paseo-bm version that wrote the record (`PLUGIN_VERSION`), for the evaluation replay ([evaluation design](./paseo-bm-evaluation.md) §3). Optional: records written before it have none and `v` stays 1.
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

In `server/trace-store-rewrite.ts`, with reassignment (§3.7), over the path checker and the per-workspace mutex of `trace-store.ts` (§3.8).

| Scope | How |
|---|---|
| `{ traceId }` | Rewrite the month files involved, dropping every line of the trace (temporary file → `fsync` → `rename`) |
| `{ before: ISO }` | Delete the month files that lie entirely before the cutoff; rewrite exactly the one file that contains the cutoff |
| `{ allOfWorkspace: true }` | Delete the folder `<traces>/<workspaceId>` |

- The interface always calls `dryRun: true` first (returning `{ traces, bytes, running }`), then asks for confirmation, defaulting to "No". `running` is the number of requests in scope that still have a `running` agent; > 0 shows a warning that later turns will become a new trace.
- Goes through the checker of §3.8; failing it → `E_TRACE_STORE_UNWRITABLE`, nothing deleted. Does not touch beads, documents, agents, Paseo conversations, `install.json`, `config.json` or anything outside `<install home>/traces`, except an earlier version's workflow assessments of that project ([Design Orchestrator](./paseo-bm-orchestrator.md) §5.4; retired in Phase 2): when any trace of the project is in scope, its whole `orchestrator/assessments/<workspaceId>.jsonl` is deleted (`deleteRetiredAssessments`), before the traces, since it may quote them. A `before` cutoff counts a trace as in scope when any of its records lies before the cutoff. A preview (`dryRun`) touches neither.
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

Shared by every write, delete and reassign operation; the trace store's path rules live in `server/trace-store.ts`, over the file primitives of `server/data-files.ts` (code review 2026-09-30 §3.1, bead `bm-consolidation-81y2.3`); no module builds a path into the store on its own. A failure at any step → `E_TRACE_STORE_UNWRITABLE`, the disk is not touched:

1. `workspaceId` matches `^[A-Za-z0-9._-]{1,128}$` and is not `.` or `..`.
2. The path after `resolve` lies inside `<install home>/traces`.
3. `lstat` **every component** from `<install home>` down to the target file; a symlink at any level is refused (a string prefix check is not enough).
4. The target file is opened with `O_NOFOLLOW`; the temporary file with `O_CREAT | O_EXCL | O_NOFOLLOW`, in the same folder as the file it replaces.

Files in `<install home>/ui/` use the same pattern (`assertNoSymlinkOnPath`, `writeStoreFileAtomically`). The other JSON stores of the data folder are built on `createJsonFileStore` (`data-files.ts`): a missing or corrupt file reads as empty, a bad entry is skipped alone, a file a newer paseo-bm wrote reads as empty and is **never written** (a coded error), the folder is created `0700` on the first write and the file replaced atomically `0600`, and a symlink anywhere below the data folder (`firstSymlinkBelow`, `data-home.ts`) is refused on read and write. Every JSON store of the data folder uses it (beads `.3` and `.6`): the Orchestrator's, the fallback, decision, alert, policy, precedent, intervention and coordination stores, `ui/setup-state.json` and `ui/budget-told.json`; only `ui/agent-tools.json` and the trace store still use the helpers above directly.

**Serialisation:** the collector and every handler run in the same plugin process, so an **in-process async mutex, keyed by `workspaceId`**, is used for every operation that modifies the store. Reads do not take the lock; a half-written last line is skipped and counted in `skippedLines`. The collector waits when it meets the lock; after 5 seconds it drops the turn and logs one line. The only other process that can write the store is the CLI during uninstall; the uninstall command runs `paseo plugin remove` **before** touching `traces/`.

## 4. Data model

Every contract is in `plugin/shared/contracts/*` (one module per area — errors, persisted, dashboard, setup, roles, fallback, chat-beads, orchestrator, decisions, insights, autonomy — re-exported by the barrel `plugin/shared/contracts.ts`), in Zod; `shared/` imports neither Node nor React Native. A field added later is always optional so that an old payload still parses (client and server ship in the same bundle, but both directions must still be readable).

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
| `workerUsage` | `[{ agentId, title, usage }]` — tokens per Worker |
| `usageByModelRole?` | `[{ role, model, usage }]` by effective model |
| `errors?` | §7.4 |
| `beadCounts` | `{ created, updated, closed, ready }`, each number `{ count, confidence }` |
| `tier`, `linking` | The tier the Worker classified itself; the certainty of the grouping |
| `agentsMissing` | Agents that are in the trace but no longer on the machine |
| `workspaceState`, `reassignedFrom` | §3.7 |
| `notices` | "data may be incomplete", "trace store off", … |

### 4.3 `TraceDetail` = `TraceSummary` + …

```
sent:     { userRequest, workerInitialPrompts[], reviewRequests[] (+ batchId) }  // a Worker record's first message, unless it is a plugin notice
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
| `traces.list` | `{ workspaceId, limit?, cursor? }` → `{ traces, nextCursor, truncated, store, notices }` | Newest first; `limit` capped at `TRACE_LIST_LIMIT` = 50 Each row may carry the optional `verification` of its request's latest finished report (autonomy design §C.3, bead `7gxw.4`) |
| `traces.get` | `{ workspaceId, traceId }` → `{ trace: TraceDetail }` | Cannot be rebuilt → `E_TRACE_NOT_FOUND` |
| `traces.agents` | `{ workspaceId, traceId? }` → `{ agents: AgentTokenFigures[] }` | Tokens read and context per agent ([autonomy design](./paseo-bm-autonomy.md) §G.2): of one request with `traceId` (unknown → `E_TRACE_NOT_FOUND`), else of each listed, unarchived agent over its life; a request's Details and Work → Agents |
| `traces.delete` | `{ workspaceId, scope, dryRun? }` → `{ deleted: { traces, bytes, running }, store }` | **Writes** the store (§3.5); `scope` is exactly one of the three forms |
| `traces.reassign` | `{ fromWorkspaceId, toWorkspaceId, dryRun? }` → `{ moved: { traces, bytes }, store }` | **Writes** the store (§3.7) |
| `traces.workspaces` | `{}` → `{ workspaces: [{ workspaceId, state, lastKnownName, lastKnownDirectory, lastSeenAt, bytes }] }` | Every workspace that has history; the way into the history of a closed workspace (Work's "Closed workspaces with history", Settings → Data) |
| `beads.stats` | `{ workspaceId }` → `{ stats }` | §10 |
| `beads.list` | `{ workspaceId }` → `{ beads: BeadRow[], stats }` | §10 |
| `beads.get` | `{ workspaceId, id }` → `{ bead: BeadDetail }` | Id not present → `E_BEAD_NOT_FOUND` |
| `beads.action` | `{ workspaceId, id, action: implement\|delete\|close }` → `{ managerId, created }` | **Sends** a request to the Manager (§13.4) |
| `workspaces.overview` | `{}` → `{ workspaces: [{ workspaceId, beads: { total, inProgress, blocked, ready } \| null, runningWorkers, runningAgents: { manager, worker, reviewer, orchestrator? } }] }` | Every workspace not archived; `runningWorkers` = `runningAgents.worker`, kept for old readers; `orchestrator` counts running Orchestrator assessment agents ([Design Orchestrator](./paseo-bm-orchestrator.md) §3.2) and is absent from a 0.4.x server |
| `chat.peers` | `{ agentId }` → `{ owner, peers, workspaceId }` | §15.2 |
| `chat.beads` | `{ workspaceId, agentId }` → `{ beads: [{ bead, mentions, lastMentionedAt }], scannedItems }` | §15.7 |
| `setup.status` | `{}` → tools, skills, extras, … | §11.4; only runs `--version` |
| `setup.install-tool` | `{ tool: br\|bv, confirmed: true }` → `{ command, code, tail }` | **Runs** the installer; `confirmed` must be `true` |
| `setup.ensure-roles` **(0.4.0)** | `{ resume? }` → `{ created, baseProvider, model, skipped }` | **Writes** the Paseo configuration when a role is missing; Settings calls it on every open, before `setup.status`. Contract: base design §7.13.2 |
| `setup.grant-agent-tools` **(0.4.0)** | `{ confirmed: true }` → `{ injectIntoAgents: true, changed }` | **Writes** `daemon.mcp.injectIntoAgents`; base design §7.13.3 |
| `setup.install-skills` **(0.4.0)** | `{ confirmed: true }` → `{ command, code, tail, missingBefore, missingAfter }` | **Runs** the `skills` CLI; base design §7.13.4 |
| `setup.cleanup` **(0.4.0)** | `{ confirmed: true, deleteData }` → `{ removedProviders, removedProfiles, agentTools, data, nextCommand }` | **Deletes** the `bm-*` entries, restores the tool switch, optionally deletes the data; base design §7.13.7 |

**Error codes** (`DASHBOARD_ERROR_CODES`, recorded in the base design's shared code registry; errors are thrown as an `Error` whose `message` starts with the code, and the client reads it with `errorCodeOf`):

| Code | When |
|---|---|
| `E_BEADS_STORE_UNREADABLE` | `.beads/issues.jsonl` exists but cannot be read: permissions, over 32 MB, a symlink out of the workspace |
| `E_TRACE_NOT_FOUND` | `traceId` is no longer in the store |
| `E_TRACE_STORE_UNWRITABLE` | The trace store cannot be written/deleted: permissions, disk full, invalid `workspaceId`, a path escaping outside (no other store's RPC answers it since bead `bm-consolidation-81y2.7`) |
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
| `E_DATA_HOME_UNAVAILABLE` **(0.4.0)** | The data folder is unusable or cannot be created, a store cannot be read, or `setup-state.json` cannot be written; every RPC, `traces.*` included ("cannot open the trace store: …") |

The `E_ROLE_SETTINGS_*` and `E_FALLBACK_*` codes in the same list belong to the RPCs in the base design (§7.3.6, §7.10); Settings shows them per §11.4, the Inbox per autonomy design §A.12.

**How an RPC codes a failure** (`server/rpc-kit.ts`, code review 2026-09-30 §3.2, bead `bm-consolidation-81y2.7`): no usable data folder — missing, unsafe, or one that cannot be created — and a store that cannot be read answer `E_DATA_HOME_UNAVAILABLE`; a store that cannot be written answers that store's own `*_WRITE_FAILED` code (`E_DECISION_WRITE_FAILED`, `E_AUTONOMY_WRITE_FAILED`, `E_PRECEDENT_WRITE_FAILED`, `E_COORDINATION_WRITE_FAILED`, `E_ORCHESTRATOR_WRITE_FAILED`, …), never `E_TRACE_STORE_UNWRITABLE`, which stays the trace store's own; any other coded error passes through. The stores themselves may still throw `E_TRACE_STORE_UNWRITABLE` inside the plugin (tool and log text). Exception: `roles.save-fallback` with no data folder still answers `E_ROLE_SETTINGS_WRITE_FAILED`.

## 6. Building a trace per request

### 6.1 Grouping

1. **Get the agents.** `agents.list` of every agent (`includeArchived: true`, page of 200); the role comes from the `bm.role` label, and without the label from the `bm-*` provider (`roleOfAgent`, `labelled: false`); filtered by `agent.workspaceId`. A tree by `parentAgentId`; a node whose parent is not in the set is a root.
2. **Read the store** of the workspace. Buckets are **keyed by `requestId`**, so all the Manager turns of one request are one trace. A trace is opened by a Manager turn whose incoming message is not a `BM-REPORT`, **or** by a Manager turn from which a `requestId` can be read (then the request is `null` and the row says plainly that it could not be recorded — the plugin only collects from the moment it is loaded).
3. **A Manager turn that names no `requestId`** belongs to the request that **that same Manager** names in its next turn; if there is none, a temporary row is opened. **Exception:** a turn with **no inbound message** (the Manager woken because its Worker ended a turn) belongs to the request that Manager named **before** it — it is the summary that closes that request — and only falls forward when there is none (Orchestrator acceptance 2026-09-28, P1: it made a phantom row 41 s before the next request). The scope is one Manager, not the whole workspace: a Worker's progress report to the Manager looks exactly like the user's words, so the Manager's own words in its next turn are the evidence; searching across the whole workspace once pulled the turns of an archived Manager into the request of another Manager 18 hours later. No time threshold is added.
4. **Get the `requestId`**, stopping at the first source that has a value: the agent's `bm.requestId` label → `exact`; `requestId:` in a `BM-REPORT` of the trace → `exact`; the line `requestId: req-…` in the Worker's initial prompt → `exact`; a bare `req-…` id that the messages sent to the agent mention more often than all other ids combined → `inferred` (Manager 0.1.0 writes a bare id and sets no label; Worker messages also cite other requests); a Worker whose `agentCreatedAt` falls within a Manager turn of the trace and that does not yet belong to any trace → `inferred`; cannot be placed → the "unknown request" group, `unknown`, **not** assigned arbitrarily to the nearest trace.
5. **Reviewers** by `parentAgentId` = a Worker of the trace (or the `bm.batchId` label). A report that names a **different** request is never evidence for this request, whichever record it sits in (`reportsBelongingTo`); the request's words are the **earliest** user message in the merged turns.
6. **Records of an agent no longer on the machine** are still attached to the trace by their own `requestId`; that agent goes into `agentsMissing` and the row says "no longer on this machine" (once a Worker is deleted, `includeArchived` does not see it either).
7. **Two kinds of number:** `reviewerIds.length` is the number of agents; `reviewCalls` counts the Reviewer's `sent` messages that are not `BM-REVIEW` and not the STOP notice the plugin sends. The `guardrail` the Worker reports itself is kept beside it (`guardrailReported`), never merged into it.
8. **User messages** (`origin: "user"`) sent to a Worker/Reviewer go into `userMessages` by the role of the receiving agent, even when the agent has been deleted.

### 6.2 Splitting into segments by the turns in which the user asks

A request is split into **segments**: each Manager turn whose first message is a real user message (`origin === "user"`, not based on wording) opens a segment, and `traces.list` returns one row per segment with `turn: { index, total }` (`summariseSegments`). The rows of one request share the `traceId`, so a row's key is `traceId#index`. The `requestId`, how the Worker reports and the review budget do not change. Work merges the rows of one trace back into one request (`requestSummaries`), and every count of requests counts **requests** (rows with `index === 1` or `turn: null`), not rows.

### 6.3 The `BM-REPORT` / `BM-REVIEW` reader (`shared/bm-report.ts`)

- Lenient: every block starting with a `BM-REPORT` line (with or without a ``` fence), reading each `key: value` line, keys case-insensitive, unknown keys into `unparsedFields`, missing keys `null`; `none` and the empty string mean "none". A block ends at the first line that does not have the `key: value` form — so a `BM-QUESTIONS` block right after it does not make the report read wrongly.
- `requestId` in prose is read leniently with respect to markdown (`REQUEST_ID_PATTERN`: "- `requestId`: `req-…`" still matches). A Manager turn that carries no `requestId` takes it from the Manager's own reply (`managerRequestId`: the Manager generates the id in the turn that opens the request, so the incoming message does not have it yet), **not** from the command `date -u +req-%Y%m%dT%H%M%SZ` (that is a format string).
- Bead ids are split on commas, semicolons or whitespace and filtered by id shape; a `( … )` group containing only ids is unpacked, any other group is a comment and dropped as a whole (`(b2 fix: no-logging AC)` does not produce a bead `no-logging`). The short form `.N` (`.2`, `.2.1`) expands from the root of the nearest full id before it (`x-gcj, x-gcj.1, .2` → `x-gcj.2`); a short form with no id before it is dropped and makes the list incomplete. When cut at the cap, the fragment cut in the middle is dropped too (`…60a.435` cut to `…60a.4` is a different bead); list fields are capped at `MAX_LIST_CHARS` = 8,000 characters; a list read incompletely goes into `incompleteFields` (the count is a lower bound, inferred).
- Deduplicated by `(agentId, phase, requestId, at)`. A block with template values (`a | b`, as in `verdict: approved | changes-required`) is an ordinary message, not a report.
- `BM-REVIEW`: `batchId`, `verdict`, `blockingCount` counted from the `- severity: blocking` lines.
- "The latest report" is always the latest **by time**, not the last element of the array.

### 6.4 Bead ids in `br` commands (`shared/shell.ts`, shared with the replay)

Taken only from **positional arguments**: the part before the first flag, after blanking out what is inside quotes. `br create` names no id (`br` generates it), `--help`/`--dry-run` are not actions, `br close` inside a quoted string is not closing a bead. Bead counting and the workflow step table share this module. Scanning the whole command line once read `-l "feature:format-date"` and the words in `-r "…"` as bead ids. **Bead counts** (`beadCounts`): `created`/`updated`/`closed` are the union of every report (by time) and the `br create`/`update`/`close` commands; `ready` is a **state**, not an action, so it is taken only from the **latest** report (an old `beads-done` report saying 3 beads are ready must not win over a `finished` saying `beadsReady: none`). A report → `exact`, a list read incompletely → `inferred`; only `br` commands → `inferred`; nothing → `unknown`. No filtering by looking up the `.beads` store: a bead just created may not be in the store yet, so "not in the store" is not enough to exclude it; the positional rule tells them apart right at the source.

## 7. Time, state and errors

### 7.1 Measurement points (fixed)

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
- Source of `fallbacks`: `SummariseDeps.fallbacksOf(requestId)`; `dashboard-rpc.ts` reads `role-fallback-state.json` **once** (`incidentsIn` and `fallbackCountsOf` in `fallback-state.ts`) both for the counts and for recognising replacement Reviewers, whose ids `readTraceContext` passes to `request-trace.ts` `workspaceTracesOf`. Every incident state counts.

## 8. Feature-workflow steps

`traces.get` returns these steps, and the Orchestrator's `bm_request` reads them (`request-render.ts` `buildRequestContent`); no screen draws them since the autonomy programme's Phase 1 (§12).

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
5. Every aggregation by model (total cost, rows by model, tokens by model and role) uses the **effective model**: `runtime.model`, falling back to `usage.model`.

## 10. Reading the beads store

- **The workspace folder** is taken from the SDK snapshot in the order `directory`, `workspaceDirectory`, `cwd`, and `projectRootPath` is added only for a workspace that is not a worktree. A worktree **never** falls back to `projectRootPath`: that is the main checkout, and the worktrees would all see its beads. The plugin's cwd is not used.
- **Path** `<dir>/.beads/issues.jsonl`: `resolve` and then check it is still inside `dir`; `lstat` every component, a symlink out → `E_BEADS_STORE_UNREADABLE`. Its own code in `server/` (the 0.4.0 installer's copy is at the `v0.4.0` tag).
- **Reading** line by line, capped at 32 MB; a broken line is skipped and increments `skippedLines`; several lines with the same `id` keep the latest `updated_at`. Cached by `(path, mtimeMs, size)`.
- **Numbers:** `total` = the number of distinct ids; `open`/`inProgress`/`blocked`/`closed` by `status`; `ready` = `open`, not an epic, and **every** `blocks` dependency points to a `closed` bead (`parent-child` does not block; an id that does not exist counts as not closed).
- **Read only**: no `br` call, no child process, no writing, `beads.db` is not touched.
- **Who is working on a bead** (`BeadRow.work`, only for `in_progress` beads, `server/bead-work.ts`): `br` records no start time and the Worker does not set `assignee`, so it is inferred from the trace store, from Worker turns only. `started` = the latest command that moved the bead to `in_progress` (`--status in_progress`, `--status=in_progress`, `-s in_progress`, `--claim`); `last` = the latest command or `BM-REPORT` that mentions the id (whole-id match: `x.1` does not match `x.12`). No command that set the status → "start not recorded"; when another Worker takes the bead later, the new Worker is shown with its activity time, without borrowing the old start time. Without a trace store, only the Worker's name is missing.

## 11. Surface "Beads Manager"

What each section shows is specified in the [autonomy design](./paseo-bm-autonomy.md) §A.12 (experience concept §4); this section says how the surface is put together.

### 11.1 Sections, views and the way back

The surface opens on the Inbox and a row of section tabs (`StatusTabs`) above every view switches **Inbox · Work · Insights · Settings** (`SURFACE_SECTIONS`); the Inbox tab carries the count of what needs the owner. `SurfaceView = "inbox" | "work" | "project-requests" | "project-beads" | "insights" | "settings"` (`client/surface-view.ts`, pure); `SURFACE_HOME_VIEW = "inbox"`.

| View | Section | `backOf` | `backLabelOf` (accessibility label of ←) |
|---|---|---|---|
| `inbox`, `work`, `insights`, `settings` | its own | `null` (no ←: the tabs reach it) | `null` |
| `project-requests`, `project-beads` (`projectTabOf` → `requests` / `beads`) | Work | `work` | "Back to Work" |

```
sidebar / Command Center "Open Beads Inbox"  → inbox
Work's project row or closed-history row     → project-requests ──(←)──> work
Command Center "Open Beads project"          → project-requests (this workspace)
Command Center "Open Beads Manager"          → the workspace's Manager chat (launch-manager.ts)
```

The Command Center and slash commands cannot pass anything into a surface, so each hand-off is a **one-place slot** `createSlot<T>()` (`slot.ts`): `launchRequests` (open the Manager), `sectionRequests` (open a section; "Open Beads Inbox", global), `projectRequests` (open a workspace's project page on Requests; "Open Beads project", `open-beads-project`, workspace), `launcherNotices` (slash command notices). `take()` notifies listeners **only when it actually removes a value**, so pressing to dismiss a notice dismisses it at once and there is no loop. `runPendingRequest` returns `null` **before** `take()` while the launcher is `pending`, and the surface's effect runs again when the launcher state changes, so a request to open the Manager that arrives midway is not dropped (one-place slot: the newest request wins).

The surface keeps the open project as a `SurfaceWorkspace` `{ id, label, closed? }`: `label` is `screenTitleOf(label, project)` (the project name is added when the workspace name differs from it, so that two bead stores are not confused), falling back to the workspace id; `closed` is the `traces.workspaces` state of a workspace Paseo no longer lists (`archived` or `orphaned`).

### 11.2 Status strip

`launcherStatusLines({ commandNotice, canOpenAgents, state })` returns, in order: the slash command notice (tone `muted`, `dismissable`, accessibility label `"<text>. Dismiss."`); `OLD_HOST_WARNING` when the host lacks `navigation.openAgent` (tone `warning`); the lines of `describeLauncherState(state)`: `pending` → "Opening Beads Manager…"; `opened` → "Started a new…" / "Reopened the existing Beads Manager…" (`muted`), then tone `warning` for other live Managers (`otherManagerIds`, "…nothing was archived or deleted."), `modeNotice`, `toolsNotice`, **(0.4.0)** `setupNotice` (the server's text verbatim, base design §7.3, §7.13.2); `error` → `danger` "Could not open Beads Manager (<code>). <message>", where `<message>` is the server's message with the daemon's wrapper stripped (`Request failed: … requestType=… code=…` of `DaemonRpcError`) and the leading code removed when the code is already in the parentheses (`withoutCode`); with no code, "Could not open Beads Manager. <message>". A line that cannot be dismissed is a `Text` with `accessibilityLiveRegion="polite"`. `LauncherStatus` is built **once** in `ManagerLauncherSurface` and placed on every view of the surface (the Inbox, Work's list, a project's page, Insights, Settings) — a slash command can open the surface at any view. The "Beads" tab (§14) has no such strip.

### 11.3 Work: projects and a project's page

`client/work.tsx` draws, `client/work-model.ts` decides (autonomy design §A.12 as built for the rows, the stage bar, the evidence lines and the timeline).

- **Project rows** — `workspaces.list` in exactly the order it returns (`activity_at desc`; no pinning), leaving out workspaces being archived (`archivingAt`); each row the name, the running dot, the current request, its stage, the M W R letters and when it last moved, from `orchestrator.state` (read every `WORK_POLL_MS` = 10,000 ms while the rows show) and `workspaces.overview` (read only while the view is `work`: `overviewPolling`, `OVERVIEW_POLL_MS` = 10,000 ms, because each read touches the bead store of every workspace). A row opens the project's page.
- **Running dot** (`RunningDot`, `runningDotState`, drawn bare on a row, the words in its accessibility label): total `runningAgents` > 0 → tone `success`, pulsing with `Animated.loop` opacity 1 ↔ `DIM_OPACITY` 0.3, each beat `PULSE_MS` = 900 ms (`useNativeDriver: false`), label `1 Worker, 1 Reviewer` (a running Orchestrator counts as `1 Orchestrator`; a server that does not send `orchestrator` counts none); = 0 → a dimmed dot at 0.3, tone `muted`, label "No Beads agent running"; no data yet → nothing drawn. `AccessibilityInfo.isReduceMotionEnabled()` true → a solid dot, no animation (a failed query counts as false). A poll that only changes the numbers does not restart the loop.
- **Closed workspaces with history**, after the rows: `closedWorkspaces(stored, listedIds)` — in `traces.workspaces` but no longer listed, state other than `unknown`, newest first, each with its state ("archived" / "no longer in Paseo"), last known folder, last activity and size. An entry opens that workspace's project page with `closed` set (§11.1): its Requests tab shows the history, and there is no **Chat** (no Manager to talk to).
- **A project's page** (`ProjectPage`): `ProjectHeader` — ← (on the surface), the project's title (`null` in the workspace's own "Beads" tab, §14), **Chat ▸** (the project's Manager through `managerLauncher`, only on a host with `navigation.openAgent`, "Opening…" while pending) — and the tabs **Requests · Beads · Agents** (`PROJECT_TABS`). Requests: `traces.list` merged per trace, a stage bar, evidence lines and a typed timeline per request (`traces.get` when opened, `decisions.list { scope: workspace }`), newest first, the newest open; ids only under **Details**, which open with the request's tokens and context (`traces.agents`, autonomy design §G.2), then name what each agent ran on — model, thinking, mode and turns per combination, and the tokens per model (`runtimeDetailLines`, REQ-058; the detail is read when the timeline or Details opens). Beads: the Beads board (§13). Agents: the agent tree of the "Beads agents" panel, without the role configuration, with each listed agent's tokens and context over its life under it (`traces.agents`, autonomy design §G.2).
- **History actions** (`dashboard-actions.tsx` `TraceActions`, the only irreversible thing on these screens): every path is a press, then the preview (`traces.delete` / `traces.reassign` with `dryRun: true`), then a confirmation that states what would be lost (`describeAction`, `createConfirmationGate`: nothing pending until the preview answered, Cancel "No, keep them" first, no default "Yes"), then the real call; nothing runs on mount, on a timer or on a refresh (REQ-054f).
  - **Per request**, under its **Details**: "Delete this request's history" (`scope: { traceId }`).
  - **A closed workspace**, above its requests: the card "History of a closed workspace" ("archived in Paseo" or "Paseo no longer has this workspace", and that the requests stay until deleted) with "Delete traces older than 30 days" (`OLDER_THAN_DAYS`), "Delete all traces here" and — only when `orphaned` (REQ-057d) — "Reassign to <workspace>" for each workspace Paseo lists.
  - **Every workspace with history**, in Settings → Data → Trace storage (§11.4).
  - After an action the page's request list and details are read again.

The page reads the first page of `traces.list` (at most 50) and says "Showing the <n> newest requests." when there are more; there is no load-more button yet (REQ-041 (c), REQ-049 (a)) although the server returns `nextCursor`. The server still infers the workflow steps of §8 for `traces.get` (the Orchestrator's workflow assessment reads them), but no screen draws them.

**Role icons** (`ROLE_MARK`, Lucide icons of `Icon` in `@getpaseo/plugin/client/react-native` on a round background of the same colour at `opacity: 0.16`): request/Manager `BotMessageSquare` tone `info`; Worker `Hammer` tone `success`; Reviewer `ScanEye` tone `warning`; Orchestrator `Compass` tone `muted`. They mark the roles in Settings → Roles & models, on chat cards and on an in-progress bead. The `danger` colour is reserved for errors; the icon shapes differ, so they can still be told apart when two colours are close. A wrong icon name makes Paseo draw nothing, with no error.

### 11.4 Settings

`client/settings-section.tsx` (one-line group states in `settings-model.ts`) arranges four groups, each folded to one line with its state: **Agents**, **Autonomy** (one line until Part B of the autonomy design), **Tools & skills**, **Data**. The blocks come from `client/settings-blocks.tsx` (`RolesSection`, `ToolCard`, `AgentToolsBlockView`, `SkillsInstallBlock`, `CleanupBlock`, `CommandLine`), with their wording in `settings-roles-model.ts` (roles, fallback chains) and `settings-machine-model.ts` (tools, skills, agent tools, sign-in, data folder, cleanup). The two Edit forms share one set of role fields (`RoleFields`); every confirmation is a `ConfirmBlock` over a `ConfirmDialog` (`ui-types.ts`), and every block's action runs through `useBusyAction`. Every confirmation puts Cancel first, and its confirm button reports disabled and busy to screen readers; an RPC error shows under the block it came from, with its code. No screen edits a role's additional instructions in Phase 1.

**Beads tools** (`setup.status`, `setup-tools.ts`):

- Looks for `br`, `bv` (and `bd`, information only) on the daemon's `PATH` plus `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/go/bin`; runs `--version` in parallel (timeout 5 s). Never runs a bare `bv` (TUI). `br` only counts as present when it is named exactly `br`.
- Each tool shows its status, path (the daemon's PATH may differ from the terminal's), version, the latest known version (`LATEST_KNOWN`, a constant with a check date, no network lookup), the install command and the update command with a Copy button (back to the word "Copy" after 2 s).
- Install command: with `brew` → `brew install dicklesworthstone/tap/<tool>`; without it, `br` → the script `beads_rust/main/install.sh | bash -s -- --skip-skills` (so paseo-bm does not write into the skill folders); without it, `bv` → the `beads_viewer` script pinned at commit `a43b8e85a39664381566abdfd85dc8fcbfdcb773`. The installer's `src/` that once had the same command is gone (ADR-022); a test locks the command's text.
- The Install button shows only when the tool is missing. The confirmation dialog states the command verbatim and warns that the command downloads code from the network. `setup.install-tool` runs the command in a login shell (`/bin/zsh -lc` if `SHELL` is zsh, otherwise `/bin/bash -lc`), timeout 300 s, and returns the exit code and the last 40 lines. Tool already present → `E_TOOL_PRESENT`; failure → `E_TOOL_INSTALL_FAILED`. Updates are not run from the screen. The plugin never installs anything on its own.

**Machine setup (0.4.0)** (the server contract is in base design §7.13). No text on the screen points to `npx paseo-bm` any more: the 0.3.x migration banner is deleted ([ADR-022](../adr/ADR-022-retirements-after-code-review.md) decision 2, base design §7.13.6).

- **When Settings opens:** call `setup.ensure-roles {}` and only then `setup.status` (one sequence, a shared spinner). A non-empty `created` → a `success` line "paseo-bm created its roles with defaults (<provider> · <model>). Change them in Agents." (dismissable) when all four roles were created; otherwise the line names the roles created, from the same function as `manager.ensure` (base design §7.13.2). `E_SETUP_ROLES_FAILED` → a `danger` line with the code and the server's words, and a "Try again" button that calls `setup.ensure-roles` again. `skipped: "cleaned-up"` → a `warning` line "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again." with a "Set up again" button (`setup.ensure-roles { resume: true }`).
- **Agent tools** (`AgentToolsBlockView`, in Agents): "On for every agent" (with "turned on by paseo-bm" when `setBy` is present) or "Off — no new Beads Manager starts until you allow them" with an "Allow agent tools…" button. Dialog: title "Allow Paseo's agent tools for every agent?". Body: "The Manager and the Worker need Paseo's agent tools to create and message other agents. Paseo has one switch for this (daemon.mcp.injectIntoAgents), and it applies to **every agent on this machine**, not only paseo-bm's: any agent can then create, message and stop other agents. paseo-bm records the current value so "Remove paseo-bm's settings" can turn it back off." Buttons "Cancel" (default) / "Allow for every agent". Calls `setup.grant-agent-tools { confirmed: true }`. Last new agents without Paseo tools (`paseoToolsWarnings`) are warned about above the roles.
- **Sign-in** (in Agents): one row per base provider of the roles: `<provider>` · "used by Manager, Worker" · "Signed in" / "Not signed in — sign in with `<command>`" (Copy) / "Unknown"; Pi shows `guidance`. No button runs a sign-in command.
- Every confirmation dialog: the cancel button is the default and takes the Escape key; the consent button is never focused in advance; only pressing consent sends the RPC (the schema requires `confirmed: true`).

**Agent skills** (in Tools & skills): `setup.status` reads (read only) the skill folders of the daemon process (`~/.agents/skills`, `~/.claude/skills` per `CLAUDE_CONFIG_DIR`, `~/.codex/skills` per `CODEX_HOME`, and the Pi/OpenCode folders when present). Claude Code counts only its own folder; Codex counts `~/.agents/skills` or its own folder. The **Test** button re-reads each `SKILL.md`: readable, with a frontmatter `name:` equal to the folder name → `ok` / `missing` / `broken`, with the check time. The block shows the equivalent `skills add` command and, when an agent is missing a required skill, an "Install skills…" button — title "Run the third-party skills CLI?", body the command verbatim (`status.skills.installCommand`) then "This downloads the skills from github.com/cuongntr/agent-skills (another author) with the `skills` CLI, a third-party tool with its own data collection. paseo-bm never writes to your skills folders itself. It can take up to 5 minutes.", buttons "Cancel" (default) / "Run it" → `setup.install-skills { confirmed: true }`; the result shows the exit code and the last 40 lines, then `setup.status` is read again; a line "Last run: <time> · exit <code>" from `setup.skillsRun`. The Pi/OpenCode columns stay read only.

**Roles & models** (in Agents; `RolesSection`, the server contract and validation rules are in base design §7.3.6):

- `RolesSection` reads `roles.settings` (key `ROLES_SETTINGS_KEY`) and `roles.options` of every base provider in the roles and the fallback chains (`rowOptionProviders`). One row per role: `RoleMark`, the role name, `roleSettingText` = `<Provider> · <model label> · thinking <id | provider default>[ · mode <label>]`, an Edit/Close button. Under the card: the `warnings` of `roles.settings` (tone `warning`, once for the whole card) and `ROLES_APPLY_NOTICE` "Changes apply to agents created after you save. Running agents keep their model and thinking."; `setup.roles.created` not `null` → a `muted` line "Created by paseo-bm on <date> with defaults (<provider> · <model>). Change them here."
- **Edit form** (`RoleEditForm`, `roleFormView`): Provider chips from `roles.settings.providers` (no `bm-*` alias; the saved provider is always present); Model from `roles.options`, with the price `~$<in> / $<out> per 1M tokens` below it when known; Thinking hidden when the model has no levels, the first choice "Provider default (<level>)"; Mode hidden when `capability: none`, the first choice "Not set", a Reviewer on `tiered` does not see `dangerous`/`planning` modes; `capability: unknown` with a mode currently set → a warning that saving will clear the mode. Save is enabled when the draft has both provider + model and differs from the saved version. The form keeps the `revision` from when it was opened: `E_ROLE_SETTINGS_CONFLICT` → "The configuration changed elsewhere; reopen Roles & models." and `roles.settings` is read again. After saving: "Saved." with each of the `warnings` under the row (`notified` is not shown).
- **Fallback chain** (`FallbackBlock`) under each role present in `roles.settings.fallback`: `On a usage limit:` chips Ask me / Off (the Auto switch was retired, ADR-022 decision 4). A chain whose `role-fallback.json` still stores `auto` comes back with `migratedFromAuto: true` and reads as Ask me; the block then shows `FALLBACK_AUTO_RETIRED_NOTICE` (tone `warning`: "Auto switch was retired: this role now asks you. Delegate the Environment class in Settings → Autonomy to let it answer by itself.") with a **Got it** button that saves the chain as shown. Any save of that chain writes Ask me or Off and ends the notice. Each entry `Fallback <n>  <Provider> · <model> · thinking …[ · mode …]`, buttons ↑ ↓ Edit Remove, a price line; "+ Add fallback" while under `MAX_FALLBACK_ENTRIES` (3). The entry form uses exactly the role form's rules. Edits stay on the client until "Save fallbacks" is pressed (`roles.save-fallback` for the whole chain, with the `revision` from when editing started) or "Discard".

**Additional instructions** — retired in Phase 2 (autonomy design §B.8, bead `bm-autonomy-phase2-t9lm.16`): the instructions are the role file, the runtime facts and the precedents; an earlier version's `role-extras.json` is never read, and the cleanup deletes it with the data.

**Data:**

- "Data folder: `<path>`" and its source (`default` / "set by PASEO_BM_HOME" / "from ~/.paseo-bm/home.json"); `path: null` → a `danger` line with the `reason`, and the buttons that need the folder (saving the fallback chain, enabling the agent tools) report `E_DATA_HOME_UNAVAILABLE` / their existing code when pressed.
- **Trace storage:** the total size and the threshold warning (§3.6), `HOST_SCOPE_NOTICE`, the privacy notice `PRIVACY_NOTICE` ("paseo-bm stores the agents' conversation of each request on this machine, and Work shows it. You can delete it at any time: here, or from a request's Details."), then one row per workspace with history (`traces.workspaces`), each folding out `TraceActions` for the whole workspace (older than 30 days, all, and reassign when `orphaned`, §11.3).
- **This install:** the `paseo-bm <version>` line and "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`." (when the plugin does not load no screen shows).
- The **"Remove paseo-bm's settings…"** button (`CleanupBlock`, tone `danger`, accessibility label "Remove paseo-bm's roles and settings from Paseo"). **First-level** confirmation: "This removes every bm-* provider and agent profile from Paseo (the four roles and their fallbacks)<, and turns Paseo's agent tools back off (paseo-bm turned them on)>. Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay." Buttons "Cancel" (default) / "Remove settings". **Second-level** confirmation (always asked, default keep): "Also delete paseo-bm's data in `<path>`: history (traces), extra instructions, fallback settings and incidents? One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay." Buttons "Keep my data" (default) / "Delete data". Sends `setup.cleanup { confirmed: true, deleteData }`. Result: the list of what was removed, what was kept (`data.kept`), the switch state ("left on — it was not turned on by paseo-bm" when `left-on`), then `paseo plugin remove paseo-bm` with a Copy button. The data deleted includes the files of retired features that earlier builds left (autonomy design §A.14): everything in `ui/` but the setup state, and the `orchestrator/` folder whole.

### 11.5 Inbox and Insights

The Inbox (`inbox.tsx`, `inbox-model.ts`) and Insights (`insights.tsx`, `insights-model.ts`, `insights.summary`) are specified in autonomy design §A.12. The Inbox's first line is the **Orchestrator line** (`orchestrator-line.tsx`, wording in `orchestrator-model.ts` `orchestratorLineView`): the agent's state ("Beads Orchestrator — running | idle | not open", from `orchestrator.state`, read once when the Inbox shows) and one button — **Orchestrator chat ▸** (opens `state.agent.id`, the newest Orchestrator), **Start the Orchestrator…** when there is none, or **Start a new Orchestrator…** when it lost its tools or runs on older instructions (the reason in `warning`). Starting reads `orchestrator.open-preview` and shows its dialog in place ("<provider> · <model or provider default>", "Reads the work of every paseo-bm project on this machine; uses tokens.", Cancel first; the recreate dialog adds "The old one stays in your agent list; …"); only the confirm calls `orchestrator.open { confirmed: true[, recreate: true] }`, then opens its chat (without `navigation.openAgent`: "The Orchestrator is ready. Open Beads Orchestrator from your agent list."). While a new Orchestrator is younger than 24 hours and an older one is still listed: "New Orchestrator since <span> ago — the old chat is no longer used." Insights shows the Beads board's overview figures (`BeadsOverviewSection`, §13.1) for the chosen project.

## 12. Screens retired by the autonomy programme

Phase 1 of the autonomy programme (autonomy design §A.14) replaced the screens this section used to describe: the Setup landing with its tabs and checklist became Settings (§11.4); the workspace list and the per-workspace Metric screen — overview cards, charts, request graphs and workflow-step chips — became Work (§11.3) and Insights (§11.5); the Orchestrator's own screen became the Inbox, Work and the Orchestrator's chat. Their history actions moved to Work and Settings (§11.3).

## 13. Beads screen

`BeadsScreen(props: WorkspaceScreenProps)`, the Beads tab of a project's page (§11.3), on the surface and in the workspace's "Beads" tab. The board comes first; its overview figures are drawn by `BeadsFigures` in Insights (`insights.tsx`), the one beads-overview component. The top of the screen: ← (when there is one) · `Beads · <name>` (when there is a name) · `doneText` (`✓ <closed> / <total> done`, accessibility label "`<closed> of <total> beads done, epics not counted`", shown only when there is data) · Refresh. Then the status strip and the line `Read from <file path>` (so that two workspaces on the same copy of beads do not look mixed up).

### 13.1 Overview (`beadsOverview`, shown in Insights)

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
- **Actions** go through the workspace's Manager, without creating a Worker directly: `beads.action` calls `ensureManager` then `paseo.agents.ref(managerId).send(actionMessage(...))`; the Manager creates a Worker per `manager.md`. That way the `requestId`, labels, reports, review budget and trace stay the same, and Work shows the request like any other request. The message sent (English, for the agent):

  ```
  [Beads screen] The user asks: <implement|delete|close> bead <id> ("<title>").
  <the action's instructions>
  The user confirmed this action on the Beads screen. Treat it as a new request from the user. Do not commit or push.
  ```

  Delete and Close are **requests for an assessment**: the Worker checks whether the bead is still needed / has met its criteria, does it if it can, and otherwise reports why. The plugin never writes the bead store. Every action goes through a confirmation gate (`actionSpec`: Assign a Worker / Close / Delete; cancel button "No, cancel"), because every action spends real quota.
- **The result line survives a column change.** Each status is a column (a separate parent), so when a bead changes status after a refresh React rebuilds the row. The action result (`"Sent to the Beads Manager… It will hand the bead to a Worker."` with an "Open the Beads Manager" button, or an error) therefore lives in `beadActionResults: SessionMap<{ text, managerId, tone }>`, keyed by `beadResultKey(workspaceId, beadId)` = `<workspaceId>:<beadId>` (two repos may share the same `br` prefix), read with `useSyncExternalStore`, `clear`ed when the user opens a new action. `SessionMap.get` returns exactly the stored object, so it is stable between renders and needs no snapshot. `pending`/`busy` remain panel state: they live only for the few seconds of confirmation, and losing them when the bead changes column erases no evidence (an open confirmation dialog closes).

### 13.5 How a bead shows its status

Many colours on one list tire the eyes, so **everywhere a bead is shown** (the Beads board, the "Beads in this chat" panel, bead chips on chat cards, the bead figures of a project row) the status is expressed only by **text and contrast**, not by hue:

- `STATUS_EMPHASIS`: `ready`, `in_progress`, `blocked` → `strong`; `closed` → `dim`. `beadEmphasis(bead)`; `emphasisTone`: `strong` → `plain`, `dim` → `muted`.
- `statusBadge(bead)` = `{ text: Ready | In progress | Blocked | Closed, tone: emphasisTone(beadEmphasis(bead)) }`: the chip and the title always have the same contrast, and the status always has text.
- `beadTitleStyle(styles, theme, emphasis | null)` = `sectionTitle` with `fontWeight: "400"` (not bold) and the colour `foreground`/`foregroundMuted`; `null` (a detail box opened from a chip) keeps `foreground`. Rows have no background fill and no left bar.
- Column titles use `sectionTitle` without colour. The `StatusTabs` row is buttons: the selected tab in the `button` style (accent background), the others `secondaryButton`, like the section tabs and a project's tabs; that colour says which tab is open, not a bead's status. `workSummary.tone`: `running` → `plain`, otherwise `muted`.
- Outside the places where beads are shown, colours stay as they are: RPC error lines (red), warnings (yellow), active filter chips and "+N more" (accent), Insights, chat cards, the Delete button.

## 14. The "Beads" tab and the header button

- **Panel** `client.addWorkspacePanel({ id: BEADS_TAB_PANEL_ID ("bm-beads"), title: "Beads", icon: "ListChecks", context: "workspace", Component: BeadsTabPanel })`, registered before the "Beads agents" panel; no `locations` declared (default `["workspace"]`). Paseo puts every `context: "workspace"` panel into the "+" menu of the tab bar and the "New tab" screen.
- `BeadsTabPanel`: the workspace's **project page** of Work (`ProjectPage`, §11.3) — Requests · Beads · Agents — opened on Beads (`BEADS_TAB_INITIAL`, owner decision Q2), with `label: null`: no ←, no title, no status strip, no Chat. A workspace panel cannot open the surface, so the page is drawn in the tab (experience concept §3: the Beads tab opens Work on its project). Its data sits in the React Query cache under Work's keys, so the tab and the surface share one read; two "Beads" tabs of the same workspace share the cache, each keeping its own tab; reopening an old tab or opening a new tab is Paseo's business.
- **Paseo 0.8's mobile app has no "+"** (the mobile tab bar only lists open tabs; `onCreateNewTab` is only handed to `WorkspaceDesktopTabsRow` and `SplitContainer`). The mobile entry point is the **header button**: `registerBeadsHeaderButtons(client)` (`beads-header-button.ts`) reads `client.paseo.workspaces.list({})` at start, every `BEADS_HEADER_POLL_MS` = 15,000 ms and whenever `workspaces.subscribe` reports an update (one read at a time; on error the buttons are kept; a client without `paseo` does not break loading). `planHeaderButtons(shown, listed)` → `{ add, remove }` by the open workspaces (no `archivingAt`). One `client.addHeaderButton({ id: BEADS_HEADER_BUTTON_ID ("bm-beads-open"), workspaceId, button })` per workspace, an icon-only button `ListChecks`, title "Open the Beads tab: this workspace's requests, beads and agents", pressing → `client.openPanel("bm-beads", { workspaceId })`. In the narrow form (`useIsCompactFormFactor` or width < 1100 px) Paseo shows the **first** plugin button directly on the header and later buttons in the "more" menu; desktop shows them on the right of the header. Paseo keys header buttons by `id` + `workspaceId` (a duplicate `id` within one workspace is an error), so every workspace uses the same `id`. `addButton(workspaceId)` takes the workspace as a parameter and does not capture the loop variable: on Hermes (mobile) every closure created in a loop sees the last value. The timer is `unref`ed; cleanup removes every button.
- **The "Beads agents" panel** (`tree.tsx`, logic in `agent-tree.ts`, registered after the "Beads" panel): the Manager → Worker → Reviewer tree from `agents.list` (base design §7.3), refreshed every `AGENT_TREE_POLL_MS` = 5,000 ms while the panel is shown; an agent that has been replaced reads `<role> · replaced by <id>`.

## 15. Chat

### 15.1 What Paseo provides

- `addTimelineTransformer({ query: { itemType }, transform({ item, phase }) })` runs for **every** chat item of **every** agent; returning `undefined` keeps the original item, returning `{ items }` replaces it with a `plugin` item. The transformer does not know which agent the chat belongs to.
- `addTimelineRenderer({ kind, version, schema, Component })` receives the chat pane's `agentId`, `timestamp`, `theme`, `layout`, and **no** `workspaceId` or `navigation`.
- Only the display changes; the history in the daemon and what the model reads stay the same. Undo = remove the two transformers and the renderer in `index.client.tsx`.

### 15.2 Chat cards v2

Two transformers, `bm-chat-received` (`user_message`) and `bm-chat-sent` (`assistant_message`), call `toChatCards(item, phase)`, which returns the cards of one item or `undefined` (the item stays Paseo's); the renderer `CHAT_CARD_KIND` = `"bm-message"`, `CHAT_CARD_VERSION` = 2, `ChatCardView`. `toChatCards` never throws. What each card shows is specified in autonomy design §A.12 (cards v2, as built); in short:

| Card | Made from |
|---|---|
| `decision` | one question of a `BM-QUESTIONS` block (`q:<requestId>:<Qn>`; a report that asks is one card per question, a `finished` report that asks is its `finished` card plus those), a `BM-FALLBACK` notice (`f:<incidentId>`), a `BM-ANSWER` notice (its `decisionId:`) |
| `progress` | a `BM-REPORT` that is not `finished` and asks nothing |
| `finished` | a `finished` `BM-REPORT` |
| `verdict` | a `BM-REVIEW` |
| `brief` | another agent's message that names a request (a request brief, a review request) |
| `action` | a delivered `BM-COMMAND` (v2; v1 still read) |
| `notice` | every other plugin notice, a Manager's copy of a Worker command and a `BM-EVENTS` batch: one compact line |

**When there is a card:** a `user_message` **without** `clientMessageId` (sent by an agent) that contains `BM-REPORT`, `BM-REVIEW` or a request id `req-YYYYMMDDTHHMMSSZ`; an **already complete** `assistant_message` (`phase: complete`, to avoid flicker while streaming) that contains `BM-REPORT` or `BM-REVIEW`; the plugin's own notices (prefixes in base design §7.5, `shared/notices.ts`), recognised by their first line whatever their `clientMessageId`. What the owner typed is left to Paseo. A block that lists the allowed values (`phase: … | …`) is a format template, not a report. A notice an earlier build sent and no build sends any more (the 0.4.x notice that told a Manager its Worker had been answered directly) is still recognised in stored history and shown as a compact line with its marker.

**One frame** (`CardFrame`, `ui.tsx`): actor → recipient · authority · time, one status chip, a title, at most `MAX_BODY_LINES` = 3 body lines, one primary action, **Details** (ids only there); a `notice` is `CompactLine`. The **`template error`** state (`formatIssues`, from `checkBlocks(text)`, the template checker of base design §7.6, on another agent's block or on the Reviewer's own `BM-REVIEW` in its own chat) lists each error under Details. The card is rebuilt from the message each time it is shown, and stored nowhere; a decision card's state comes only from the store (below).

**Who sends, who receives** (`partiesOf(card, owner, peers)`), with data from `chat.peers({ agentId })` → `{ owner, peers, workspaceId }` where `ChatPeer = { id, role, title, status, parentId, requestId, batchId, labelled, archived, replaced }`. A Worker's `requestId` comes from its label, and without the label from the trace store by the same rules as the request history (§6.1); the store is read at most once and only when a label is missing (`peersOfWorkspace`, `server/chat-peers.ts`).

- A received report → the Worker of the request; a received review → the Reviewer matching `requestId` and `batchId`; any other message in a Worker's chat → the Manager (the parent if it is a Manager); in a Reviewer's chat → the parent Worker; in a Manager's chat → the Worker of the request.
- A message it wrote itself: the sender is the owner of the chat pane; the receiver is the parent Worker (review) or the Manager.
- **The Worker of the request** = `soleWorkerOf(peers, requestId)` (`shared/sole-worker.ts`, shared by the cards and the delivery of answers, `decision-delivery.ts`): a `worker` agent that is **not archived**, not replaced (`replaced`), carries exactly the `requestId`, and is **the only one**; none or more than one → none. `partiesOf` is only used for naming, so it falls back to the only Worker even when archived.
- When it cannot be determined, the actor line names the role only (`actorName`), never an id.
- `drawAsCard(card, owner)`: the chat pane's owner is not a paseo-bm agent (`owner` null or `unknown`) → false; a received card is always drawn; a sent card is drawn only when the pane owner's role matches (review → Reviewer, otherwise → Worker), so a block quoted by the Manager shows verbatim. False → verbatim as Markdown, without the card frame.

**A decision card** (`DecisionCard`, `chat-card.tsx`) keeps only a seed of its decision (id, asker, the question and its options as the message wrote them); status, answer and delivery come only from the store: it reads `decisions.get` every `DECISION_POLL_MS` = 5,000 ms while the decision is `open` or `needs-confirmation` and stops once it is settled; one not recorded yet is looked for only `DECISION_LOOKUP_WINDOW_MS` = 10 minutes after its message. Every copy of one decision (the Worker's chat, the Manager's, the Orchestrator's, the Inbox) shares one query (`decisionQueryKey`), so an answer shows everywhere at the next read. Options are buttons (the recommended one primary) plus **Own words…**, answered through `decisions.answer` with `via: chat-card` (`via: inbox` in the Inbox); an answer whose effects are in `CONFIRM_EFFECTS` first shows the in-place confirmation, Cancel first; `needs-confirmation` shows **Keep open** / **Close as answered** (`decisions.confirm`). A fallback decision (`f:`) offers the incident's prepared actions (switch, wait, resend, dismiss; base design §7.10). There is no other question UI: no reply box, no answered chip, no "Mark as answered", no "Use recommendations".

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

`parseQuestions` is lenient because the input is written by a model: the opening `BM-QUESTIONS` line accepts `>`, `-`, `**`, a ``` fence; a question line is `Q<n>` followed by `:` `.` or `)` (also `**Q1:**`, `- Q1:`); an option must have a bullet or parentheses (`- a: …`, `- (a) …`, `a) …`, `(a) …`) — prose `a: …` is not an option; `(recommended)`/`[recommended]` is removed from the text, and more than one recommendation in one question → treated as none; a line indented by ≥ 2 spaces is joined to the line above; every line has its `>` quote prefix removed; a block ends at a line that opens another block, a closing fence (``` or `~~~`), or unindented prose **after** the first question (prose before the first question is a lead-in, ignored); a duplicate id/key keeps the first one. **Limits:** the whole message is scanned line by line (one regex anchored at the line start, no nested quantifiers, linear) to find the last opening line, then only 20,000 characters from there are read; at most 10 questions × 8 options; each piece of text is cut at 1,000 characters. A question with fewer than 2 options is still returned and can only be answered with "Other". A question may end with `[subject: <slug>]` and an option with `[effects: <list>]` (`worker.md`), which the decision keeps (autonomy design §A.3).

The Worker owns the numbering and the options; the plugin turns each question of the block into a stored decision (`q:<requestId>:<Qn>`, autonomy design §A.5), and delivers the owner's answers to the Worker as a `BM-ANSWERS` block (§A.6). The Manager writes a `BM-ANSWERS` block only when the owner answers in its chat.

### 15.4 Beads in the chat

- **No bead chips on a card** (code review 2026-09-30 §5, bead `bm-consolidation-81y2.12`): the chips were never drawn — `BeadChips` had no importer — and are deleted with `beadChipText`; beads a chat mentions are gathered in the panel below. `beads.lookup`, left with no caller, was removed with them (bead `bm-consolidation-81y2.23`).
- **The "Beads in this chat" panel** (`addWorkspacePanel`, `id: "bm-chat-beads"`, `context: "agent"`): a Worker's ordinary questions are chat text, and turning them into cards would change the chats of other agents too, so beads are gathered in a panel. `chat.beads` reads `CHAT_BEADS_PAGES` = 2 pages × `CHAT_BEADS_PAGE_SIZE` = 200, i.e. the 400 newest items, takes ids from messages and shell commands, keeps only ids that really exist, counts the mentions, sorts by most recent mention, at most `CHAT_BEADS_LIMIT` = 30. The panel refreshes every 15 s; a row is a `BeadRowCard`, no grouping, no eye button.
- Every chat RPC is in `server/chat-rpc.ts` (`registerChatRpcs`), separate from `dashboard-rpc.ts`; the shared timeline read loop is `readTimelinePages` (`live-timeline.ts`).

### 15.5 Fallback incident

The incident detection rules, the candidates, `BM-FALLBACK` and `fallback.incidents` / `fallback.act` are in base design §7.10. A pending incident is the owner's decision `f:<incidentId>` (autonomy design §A.5 d): it shows in the Inbox, and a `BM-FALLBACK` notice in a chat is that decision's card (§15.2), its options the incident's prepared actions — switch to the candidate, wait for the reset, resend a switched Reviewer's instructions, or handle it yourself. What became of a settled incident (a new agent running with **Open**, waiting, dismissed, failed) and **Resend to Worker** show in the Inbox (autonomy design §A.12).

## 16. Performance

| Where | How |
|---|---|
| Writing the trace | One `write` + `fsync` per turn; target under 50 ms; an error never blocks the agent |
| Reading the trace | By month file, newest to oldest, stopping at `limit` (50); `mtime`+`size` cache |
| Timeline | Only catches up the running turn, or when the store is off; capped at 2,000 entries per agent per read |
| Beads store | Capped at 32 MB; `(path, mtimeMs, size)` cache |
| Client | `useQuery` with keys that include `workspaceId`; trace detail loaded only on open; the polling intervals in §2.4, none of which runs while its screen is not shown (except the header button, which is tied to the app) |

## 17. Security & Privacy

- **Write boundary:** `<install home>/traces/**`, `<install home>/ui/**` (the retired `role-extras.json` is only deleted, by the cleanup). No writing into the workspace, `~/.paseo`, skill folders, `install.json`. **(0.4.0)** The data folder (base design §5.1) replaces `<install home>`; `ui/setup-state.json` is added; the Paseo configuration only through `config.patch` of base design §6.2; deletion only through `setup.cleanup` and only the entries listed in base design §7.13.7.
- **Reading disk outside its own part:** `<workspace>/.beads/issues.jsonl`, the plugin's `role-fallback-state.json`, and the skill folders (only `SKILL.md`, for Settings). **(0.4.0)** Plus `~/.paseo-bm/home.json` (the pointer).
- **Secrets are masked before writing**, not only before rendering: the rules came from the installer's `redact.ts` (at the `v0.4.0` tag); the plugin keeps its own constants, and `test/plugin-credentials-guard.test.ts` checks that no planted secret reaches a written file.
- `env` is not recorded: the collector does not use the `agent.create` hook.
- Permissions: folders `0700`, files `0600`.
- Deletion is the user's right: no path deletes traces on its own; the uninstall command must ask.
- Settings → Data states plainly that paseo-bm stores agent conversations and that Work shows them (`PRIVACY_NOTICE`).
- **No network** in any dashboard flow. Deliberate exception: `setup.install-tool` runs an installer downloaded from the network, only when the user presses and confirms the verbatim command (`confirmed: true` required by the schema); the `bv` script is pinned to a commit, the `br` script checks its own SHA256. **(0.4.0)** A second exception under the same rule: `setup.install-skills` runs the `skills` CLI (downloading from npm and GitHub); `providers.diagnostic` is the daemon asking its provider, not the plugin going out to the network.
- The Beads board **sends messages to agents** (bead actions): always through a confirmation, always to the workspace's Manager. A decision card sends nothing itself: it answers the stored decision (`decisions.answer`), and the plugin delivers the answer (autonomy design §A.6) — never into a running turn, never to a Reviewer. Work's Requests and Insights create, stop or send nothing to any agent.

## 18. Reliability

- An agent archived or deleted → the trace keeps everything already stored; `agentsMissing` with a notice.
- A trace write error → skipped, one line logged, the Dashboard shows "traces may be missing".
- A store with a newer `schemaVersion` → limited reading, no writing.
- A trace file with one broken line → exactly that line is skipped and counted in `skippedLines`.
- `reset`, `gap`, `staleCursor` from the timeline → read again once and attach a notice.
- A host lacking the timeline API or the `before`/`on` hooks → exactly that part is turned off, with a notice. A host lacking `navigation.openAgent` → the "Open …" buttons hide themselves.
- An RPC error → each screen shows a red line with the code; the rest (including the section and project tabs) stays usable.

## 19. Test strategy

| Layer | Principle |
|---|---|
| Logic | Every decision is in a pure module (`*-model.ts`, `chat-card-*.ts`, `format.ts`, `tone.ts`, `surface-view.ts`, `slot.ts`, `shared/*`, `server/*`), tested with Vitest without a renderer. Each behavioural criterion has a negative control that has been seen to fail |
| View | Hook-free views are rendered with `test/helpers/element-tree.ts`; views that hold state in hooks are checked on their source in `test/view-source.test.ts`; retired names are proven gone in `test/retired-names.test.ts`, deleted after 0.5.0. `react-native` and `@getpaseo/plugin/client/react-native` are aliased to `test/stubs/react-native.ts` and `test/stubs/paseo-react-native.ts`; files in `test/` do not import `react-native` as a value. Every test fakes Paseo with the one `test/helpers/fake-paseo.ts` (bead `bm-consolidation-81y2.16`) |
| Store | Write then read back; duplicate keys including reused turn ids and a rewrite stamped with the write time; broken lines, a half-written last line; symlinks at every level refused and the target unchanged by a single byte; a barrier for writes concurrent with delete/reassign |
| Contract | The exact RPC list in `test/plugin-bundle-cjs.test.ts` and `test/rpc-list-describe.test.ts`; the client entry does not import `server/`, `shared/` does not import Node |
| Negative | No writing outside the boundary of §17, no network, Work's Requests and Insights call no write function of the SDK |
| Real data | The readers are tried on strings written by real agents; acceptance runs on a real daemon write a run record in `docs/operations/`. The visual part (colours, layout, gestures) is checked by the owner on a real daemon, on desktop and phone |

## 20. Compatibility

- A new version reads an old version's store; an old version meeting a newer store reads it in limited mode and does not write. A version update does **not** delete the store, including `--prune`.
- Fields added to a payload (`errors`, `usageByModelRole`, `usageByModel`, `runtime`, `labelled`, `replaced`, …) are always optional or have a default.
- Data files and notices of features the autonomy programme retired (§12, autonomy design §A.14) are ignored when an earlier build left them, and the cleanup button deletes them; there is no compatibility path to the retired screens (PRD REQ-171).
- Agents created by an earlier version (without the `bm.requestId` label) still show, at the `inferred` level.
- The `BM-REPORT` reader reads the current format and the previous one; a report without `BM-QUESTIONS` gives an ordinary card; a `BM-COMMAND` v1 block still reads. Instructions are attached when the agent is created, so an agent on older instructions is flagged in the Inbox (autonomy design §A.11), and its cards are still drawn because the card is plugin code.

## 21. Open questions

| ID | Question | Affects |
|---|---|---|
| Q-042 | The size threshold is only machine-wide because Paseo only has `scope: "host"`; is a per-workspace threshold (stored in `meta.json` ourselves) needed? | §3.6 |

## 22. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | §5 `traces.list` rows carry the optional `verification` (bead `bm-autonomy-phase3-7gxw.4`) |
| 2026-09-30 | Claude (owner's delegation) | §4 record: optional shell evidence fields `status`, `exitCode`, `cwd`, `callId`; every detail masked (bead `bm-autonomy-phase3-7gxw.2`) |
| 2026-09-30 | Claude (owner's delegation) | §19 View: one fake Paseo, render tests, `view-source` and `retired-names` test files, the two test aliases (bead `bm-consolidation-81y2.16`) |
| 2026-09-30 | Claude (owner's delegation) | Dead code (bead `bm-consolidation-81y2.23`): `beads.lookup` and `E_TIMELINE_UNAVAILABLE` removed from §2.1, §5 and §15.4 |
| 2026-09-30 | Claude (owner's delegation) | §2.1, §2.4: one duration and one date style (`format.ts`), `client/errors.ts`, `shared/time.ts` and `text.ts`, `Button` and `ToneText` in the view kit (bead `bm-consolidation-81y2.13`) |
| 2026-09-30 | Claude (owner's delegation) | §2.1, §3.5, §7.4: `traces.ts` split (rebuild; `trace-timing`, `trace-usage`, `trace-views`), `paseo-directory.ts`, `trace-store-rewrite.ts` for delete and reassign; fallback counts in `fallback-state.ts`; `bm_request` builds as `traces.get` does without calling its handler (bead `bm-consolidation-81y2.15`) |
| 2026-09-30 | Claude (owner's delegation) | §4: the contracts live in `plugin/shared/contracts/*` behind the barrel `contracts.ts`; the error class is `RpcError` (alias `DashboardError`); one fallback status list (bead `bm-consolidation-81y2.10`) |
| 2026-09-30 | Claude (owner's delegation) | One home per rule (code review §3.5, §3.6, bead `bm-consolidation-81y2.9`): danger patterns in `shared/effectful-actions.ts`, check results in `interventions.ts` `namesFailingChecks`, `PREDICTORS` and the option caps in `decisions.ts`, derived `HARD_OWNER_CLASSES` / `GATE_CATEGORY_EFFECTS` / `ACTION_CATEGORY`, `currentPolicy`, `recentTracesOf`, `shared/shell.ts` |
| 2026-09-30 | Claude (owner's delegation) | §2.1 `rpc-kit.ts`, `coordination-rpc.ts`; §5 error codes: one coding rule for every RPC — no usable or unreadable data folder `E_DATA_HOME_UNAVAILABLE`, a store's own write code, `E_TRACE_STORE_UNWRITABLE` only for the trace store (bead `bm-consolidation-81y2.7`) |
| 2026-09-30 | Claude (owner's delegation) | Phase 2 retirements (bead `bm-autonomy-phase2-t9lm.16`): §2.1 `role-instructions.ts`; §3 `role-extras.json` retired; §5 `roles.instructions` and `roles.save-extra` removed; §11.4 additional instructions retired; `bm_request` content from `request-render.ts`; §17 write boundary |
| 2026-09-30 | Claude (owner decision, ADR-022) | The fallback chain's Auto switch is retired (decision 4, bead `bm-consolidation-81y2.21`): a role's policy is Ask me or Off; a stored `auto` reads as Ask me with a one-time notice; an incident is answered without the owner only by a precedent or the owner's policy for `environment` |
| 2026-09-30 | Claude (owner's delegation) | §3.8: every JSON store of the data folder is on the factory; only `ui/agent-tools.json` and the trace store use the file helpers directly (bead `bm-consolidation-81y2.6`) |
| 2026-09-30 | Claude (owner's delegation) | §2.1 file map, §11 Beads screen, §15.4, §19: `chat-cards.ts` and `dashboard-model.ts` split into pure modules (`chat-card-*.ts`, `format.ts`, `tone.ts`, `styles.ts`, `history-model.ts`); the never-drawn bead chips deleted; `BeadsFigures` in Insights is the one beads overview (code review §4, §5, bead `bm-consolidation-81y2.12`) |
| 2026-09-30 | Claude (owner's delegation) | §2.1 file map and §3.8: `data-files.ts` holds the data folder's file primitives and the JSON store factory the Orchestrator and fallback stores use (code review §2.3, §2.4, §3.1, bead `bm-consolidation-81y2.3`) |
| 2026-09-30 | Claude (owner decision, ADR-022) | Three references to the installer's `src/` (beads store path check, the tools' install command, secret masking) say where that code went; the credential guard is the plugin's own test (beads `bm-consolidation-81y2.18`, `.19`) |
| 2026-09-30 | Claude (owner's delegation) | The 0.3.x migration banner is deleted ([ADR-022](../adr/ADR-022-retirements-after-code-review.md) decision 2, bead `bm-consolidation-81y2.20`): §11.4 drops the banner and the Data group's "Installed by the old npx installer" state; §2.1 drops `server/install-home.ts`; §17 no longer reads `install.json` |
| 2026-09-30 | Claude (owner's delegation) | File map and Settings: `setup-model.ts` split into `settings-roles-model.ts` and `settings-machine-model.ts`; shared `RoleFields`, `ConfirmBlock`/`ConfirmDialog` and `useBusyAction` (code review §2.6, §3.7, bead `bm-consolidation-81y2.11`) |
| 2026-09-30 | Claude (owner's delegation) | §5, §11.3: `traces.agents`, tokens and context per agent for a request's Details and Work → Agents ([autonomy design](./paseo-bm-autonomy.md) §G.2, bead `bm-autonomy-phase2-t9lm.27`) |
| 2026-09-29 | Claude (owner's delegation) | Retirement sweep (autonomy design §A.14, bead bm-autonomy-phase1b-dbdv.6): §11 rewritten for the surface as built — sections Inbox · Work · Insights · Settings and their views (`surface-view.ts`), the "Open Beads project" and "Open Beads Inbox" hand-offs, Work's rows, closed-workspace history and a project's page, the history actions moved to a request's Details, a closed workspace's Requests and Settings → Data, Settings from `settings-blocks.tsx`, the Inbox's Orchestrator line; §12 now only names the retired screens; §13/§14: the board first, the overview in Insights, the "Beads" tab is the workspace's project page; §15 rewritten for cards v2 and live decision cards (the reply box, the question card, the waiting list and its pills, the answer marks and their file removed); §1, §2, §3.2, §5, §16–§20 brought in line; a request's Details keep what each agent ran on and the tokens per model (REQ-058), shown before on the retired request graph |
| 2026-09-29 | hieu.nt10 (written by Claude) | Trace records carry an optional `pluginVersion` (§ record fields), for the evaluation replay of the autonomy programme (bead bm-autonomy-phase0-m1ih.1) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | §15.2: the `command` card and the `event` compact line ([Design Orchestrator](./paseo-bm-orchestrator.md) §6B.2, ADR-016), with the fields `command` and `event`; an unparsable block falls back to the `notice` card |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | §11.3: the Orchestrator tab becomes a coordinator's dashboard ([Design Orchestrator](./paseo-bm-orchestrator.md) §9, §6B.7, ADR-016) — the summary line; Needs you oldest first, a decision's options as buttons behind a confirmation, Other…; one health card per project (colour, Allow… for the gate categories, stage bar, M W R dots, current request, progress, Worker signal chips, Details with interventions, notes, assessment bars and the actions); What the Orchestrator did as one list across projects, last, with → Manager / → Worker, who decided, the `re:` line and body of a `BM-COMMAND`, Override… and Pause Autopilot |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | §11.3, after real use ([Design Orchestrator](./paseo-bm-orchestrator.md) §9): **What the Orchestrator did** replaces the collapsed Activity — sent commands without the limit line and asked decisions with their status, by project, 4 lines with Show all, the last 24 hours with Show older; the header's Latest line and the new-Orchestrator notice; `orchestrator.state` read every 10 seconds while the tab is shown; the project rows drop the latest action |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | §11.3: the Orchestrator tab simplified ([Design Orchestrator](./paseo-bm-orchestrator.md) §9, ADR-015; REQ-071, REQ-082) — header with Open chat; Needs you only when not empty, with command cards (Send / Edit / Skip) and decision cards (Answer… through `orchestrator.ask` with `decisionId`, Skip); project rows with the state and its minutes, the Autopilot switch and its dialog, the latest action by source, Assess workflow, Ask… and Command… behind "…"; Activity collapsed; the Stalled and Interventions sections removed; the new empty sentence |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §11.3: the one-screen Orchestrator tab of [Design Orchestrator](./paseo-bm-orchestrator.md) §9 replaces the placeholder (REQ-071, REQ-076 c/e, REQ-078 a/c/d) — header with Open Orchestrator and the Watch for stalled work switch, Needs your approval, Stalled, Projects with the latest workflow assessment, Interventions, the empty state; read on open, on focus, after every action and on Refresh, no timer; every dialog defaults to Cancel |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | The first Orchestrator design's parts removed ([Design Orchestrator](./paseo-bm-orchestrator.md) §11, ADR-014, REQ-071 f): §12 drops the `· ⚑ N` of a row, the Flags chips, the nudge lines and the Assess/Assessments block — Metric gets nothing from the Orchestrator but opening one request (`initialTraceId`); §11.3 the Orchestrator tab is a placeholder until the one-screen tab of Orchestrator §9, keeping `onOpenTrace`, `RULE_LABELS` and the Add to <Role>'s instructions dialog |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §6.1 step 3: a Manager turn with no inbound message belongs to the request named before it (Orchestrator acceptance finding P1) |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §12: Assess and the Assessments block on an opened request ([Design Orchestrator](./paseo-bm-orchestrator.md) §5, §7, §8.2; REQ-075 a, b, e, f; REQ-076 a, b) — the Assess preview dialog from `orchestrator.assess-preview` (default Cancel), assessments newest first with state, model, the six scores, findings, suggestions, the "linked by turn" label, Assessing… with Open agent and Refresh (no polling), the error and raw reply of a failed one, and the "Add to <Role>'s instructions" dialog with the text after appending, `chars / 8,000` and `expectedHash` |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §12: opening one request from the Orchestrator tab ([Design Orchestrator](./paseo-bm-orchestrator.md) §8.1, REQ-071 c) — `onOpenTrace` switches the surface to that workspace's Metric, `DashboardPanel.initialTraceId` opens that trace's card; a trace beyond the first page is looked for on at most 10 more pages and drawn on its own under "Opened from the Orchestrator", else one "Could not find …" line |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §11.3: four Setup tabs — the Orchestrator tab ([Design Orchestrator](./paseo-bm-orchestrator.md) §8.1, REQ-071, REQ-078 a-b, f): the Nudge running agents switch behind `ConfirmBlock` (moved to `ui.tsx`), its two rule checkboxes, the 7/14/30-day overview with rows, most frequent flags, "Nudges sent: N", the table by size, truncation and the empty state, and one readable label per rule |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §12: the Orchestrator's flags and nudges on Metric ([Design Orchestrator](./paseo-bm-orchestrator.md) §8.2, REQ-073 a–c) — `· ⚑ N` on a row from one `orchestrator.flag-counts` call per page, and on an opened request the Flags chip group with its evidence, the "based on the agents that still exist" note and one "Orchestrator nudge: …" line per nudge |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | The fourth role on the client ([Design Orchestrator](./paseo-bm-orchestrator.md) §3.1): its role icon (`Compass`, `muted`, kept out of the graph legend), `1 Orchestrator` in the running dot, the "created its roles" line naming only the roles created (§11.3), and "the four roles" in the cleanup warning |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §5 `workspaces.overview`: `runningAgents.orchestrator` (optional) counts running Orchestrator assessment agents; the assessment agent is otherwise kept out of trace reconstruction ([Design Orchestrator](./paseo-bm-orchestrator.md) §3.2) |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | §3.5: `traces.delete` also removes the Orchestrator's assessments of the traces in scope, keyed by `requestId` or `traceId` ([Design Orchestrator](./paseo-bm-orchestrator.md) §5.3, REQ-075 e), before the traces; a preview removes none |
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
