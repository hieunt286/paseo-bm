# paseo-bm — Coordination Dashboard (feature PRD)

| Field | Value |
|---|---|
| Status | **Accepted** — gate `prd-ready` PASS; shipped in 0.2.0, amended by the autonomy programme in 0.5.0 |
| Living document | Edited in place; always describes the current requirements, git is the audit trail. The PRD states **the outcome the user gets**; button names, theme colours, constants, row limits and layout live in the [Technical Design](../design/paseo-bm-dashboard.md) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Programme | The [calibrated autonomy PRD](./paseo-bm-autonomy-prd.md) **amends** this PRD: its screen and card requirements (the Metric screen, the Beads screen's layout, the Setup layout, chat cards, waiting pills) are replaced by REQ-118 (shipped in 0.5.0). The request history and its figures now live in the **Projects** section — a project's Requests, Beads, Metrics and Agents tabs — and set-up in **Settings** and **Tools & skills** ([autonomy design](../design/paseo-bm-autonomy.md) §A.12). The trace store, beads reading and request-history requirements stay |
| Base PRD | [paseo-bm PRD](./paseo-bm-prd.md) — Accepted; this feature belongs to **Phase 2** of [§9 Roadmap](./paseo-bm-prd.md#9-roadmap) |
| Technical Design | [paseo-bm — Coordination Dashboard](../design/paseo-bm-dashboard.md) (Active, living document) |
| ADR | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) — the trace is stored in paseo-bm's data folder, deletable by the user (Accepted) |
| Routing decision | [§0](#0-routing-decision) (canonical owner of this feature; the base PRD's [§0](./paseo-bm-prd.md#0-routing-decision) is the parent decision) |
| Parent requirements implemented | REQ-030 (work session history) and the "bead progress board and reporting in Paseo" part of Phase 2 |

This feature has its own journey and metrics (observing, not coordinating), so it has its own PRD, linking back to the base PRD instead of copying its content.

## 0. Routing Decision

- Variant preset: brownfield (extends a running plugin); routed **Designed**.
- Why — the risks it carries, which still shape every change to it:
  - **Public contract:** the `traces.*` and `beads.*` RPCs and their error codes.
  - **A consumed contract:** the `BM-REPORT` block in `roles/*.md` is parsed by the plugin as well as read by the Manager, so changing its format needs two-way backward compatibility (REQ-050).
  - **Data schema and write boundary:** the plugin **writes** a trace store to disk, with a schema version and a delete path, and the data contains the conversation verbatim ([ADR-007](../adr/ADR-007-dashboard-trace-store.md)).
  - **Data-read boundary:** the plugin server reads `.beads/issues.jsonl` in the user's repo and the agents' timelines.
  - **Privacy:** agent conversation content **lives on disk** → file permissions, secret redaction before writing, and the right to delete belongs to the user.
  - **Performance:** a long-lived Manager's timeline can be very long, and the trace store grows over time → paging, caps and a deletion path.
- Delivered through the full chain (PRD, Technical Design, ADR-007, plan, beads, an acceptance run on a real daemon: [run record](../archive/operations/paseo-bm-dashboard-run-20260916.md)); owner settled Q-030 → Q-041.
- Supersedes: none

## 1. Context

The coordination loop (chat with Beads Manager, Manager creates a Beads Worker, Worker calls a Reviewer) is visible only as conversation: to find out "which beads did yesterday's request create, how long did it run, which feature-workflow steps did it skip", you would have to open each agent, reread the conversation, and count by hand. The Manager can answer when asked, but that is one model's answer: not reproducible, not comparable across runs, and gone entirely if the agent is archived or deleted.

The data to answer those questions **already exists**, and it is structured:

- The Worker must send a `BM-REPORT` block at every milestone (REQ-034), containing `requestId`, phase, changed files, beads created/updated/closed/ready, build and test status, and the guardrail counters.
- The Reviewer returns a `BM-REVIEW` block.
- Paseo lets you read each agent's timeline with a `timestamp` and `turnId` for each entry, and lets you filter agents by the `bm.role` label.
- `.beads/issues.jsonl` at the repo root is the source of truth of the beads store.

This feature turns that data into a readable screen, and **keeps** it: the agent lifecycle belongs to the user (ADR-005), so the work history must not die with the agent. It is the Phase 2 part the base PRD promised (REQ-030 + bead progress board).

## 2. Goals & success metrics

**Goals**

1. Answer four questions by eye, without reading the conversation: *how many Workers and how many Reviewer rounds did a request break down into? what was sent, what was received, how long did it take, how much did it cost? did it create beads, and which? which feature-workflow steps did it go through?*
2. Show the state of the workspace's beads store right beside it, so the user can decide whether to hand over new work.
3. **Keep history** across plugin reloads, daemon restarts and even the user deleting agents — but let the user **delete it** when it is no longer needed.
4. Open no new risk: the Dashboard creates no agents, sends no prompts, goes to no network, and writes only to its own trace store.

**Metrics (measured in the acceptance run on a real daemon, using the existing orchestration acceptance kit)**

| ID | Metric | Threshold |
|---|---|---|
| D-1 | Opening the Dashboard from the Beads Manager screen | Exactly 1 click; the trace list shows in full within **≤ 3 seconds** for a workspace with ≤ 20 agents and a trace store of ≤ 500 traces |
| D-2 | Number of Workers and Reviewers per request | Matches **5/5** sample requests against a hand count in the Paseo interface; *the number of Reviewer agents* and *the number of review calls* are counted separately |
| D-3 | Processing time | Off by **≤ 1 second** from a hand calculation from the timeline's `timestamp`, on 5/5 requests; the screen states the measuring points |
| D-4 | Beads produced by the request | The list of beads created/updated/closed matches **5/5** against the before–after difference of `.beads/issues.jsonl` for that very request |
| D-5 | Feature-workflow step table | **0** cells marked "done" without specific evidence, and **0** cells marked "not done" without a Worker statement allowing that step to be skipped; the rest are marked "unknown" |
| D-6 | Beads statistics | Matches `br stats` (total, open, in_progress, blocked, closed) and `br ready` exactly on **3** different repos, one of which has no `.beads/` |
| D-7 | Negative evidence | Across the whole acceptance run: **0** files written outside paseo-bm's trace store, **0** agents created/stopped/archived by the Dashboard, **0** network calls, **0** writes to the user's repo |
| D-8 | Durable trace | The traces of 5/5 sample requests still read intact after: a plugin reload, a daemon restart, **and** the user archiving and then deleting the corresponding Worker |
| D-9 | Deleting traces | Delete 1 trace and delete all traces of a workspace: the trace disappears from the screen, the store size drops accordingly, and **0** other files on the machine change (file system snapshot before–after) |
| D-10 | Tokens and cost | Every money amount carries the label "estimated" with the date of the price table; a model without a price shows **only** tokens, no money; and **no** figure sums the cumulative session cost the provider reports |
| D-11 | Reassigning traces of a workspace that no longer exists | After reassigning: **100%** of records appear in the target workspace, **0** records lost or duplicated, and **0** files outside the trace store changed |

## 3. Out of scope

- **Creating or controlling agents.** No creating, stopping, archiving or deleting agents; no sending prompts; no editing beads; no changing the Paseo configuration. The agent lifecycle belongs to the user (ADR-005).
- **Writing to the user's repo.** The trace store lives in paseo-bm's data folder, never in the workspace.
- **Silent automatic deletion.** The trace store does not delete itself by age or by size; it **warns** and lets the user decide (REQ-055).
- **Clock-driven background tasks.** No cron, no watcher, no background loop. Collection happens only in the Paseo event hooks the plugin already uses, and when the user opens the screen.
- **Syncing the trace store across machines**, exporting reports, charts over time, push notifications, aggregating figures across workspaces. (**Reassigning** the traces of a workspace that no longer exists to an existing workspace **is in** scope — REQ-057.)
- **Invoices.** Money amounts are *estimates from the price table shipped with the release* or figures reported by the provider; they are not an invoice and the screen must say so.
- Editing or adding steps to feature-workflow. The Dashboard only **observes** the process.
- Showing a provider's internal sub-agents as full nodes. The Paseo SDK given to plugins cannot list them (only the internal `DaemonClient` can); the Dashboard only counts their traces in the timeline and says clearly that they are traces.

## 4. Personas / Affected Actors

No new persona. Two existing roles use this feature:

- **The person handing over work, as an observer** (the owner and colleagues)
  - *Context:* has just handed one or more requests to the Manager, comes back the next day.
  - *Goal:* know what each request turned into without rereading three conversations; and clean up old logs when the machine starts to feel heavy.
  - *Pain:* currently has to open each agent; an archived or deleted agent means the trail is lost; does not know whether the Worker skipped the review step.
- **The release maintainer, as a diagnostician**
  - *Goal:* when there is a bug report "the Worker runs forever and never finishes", see right away which request it is, which phase it stopped at, how many review rounds, how much it cost, what it is stuck on.

**Non-human actors (data sources, not users):** Manager, Worker, Reviewer. The new point to note: the Worker's `BM-REPORT` now has **two** consumers — the Manager and the Dashboard.

## 5. User / Operational Journeys

The journeys name "the Dashboard"; it is now a project's page in the **Projects** section (Requests, Beads, Metrics; deleting history also in Settings → More → Data), see [Dashboard Design](../design/paseo-bm-dashboard.md) §11.3. The outcomes are unchanged.

- **J-9 See how a request was broken down:**
  1. The owner opens the Beads Manager screen and clicks **Dashboard**.
  2. Picks a workspace; the screen shows the trace list, newest on top: time, request excerpt, status, 1 Worker, 3 Reviewers / 4 review rounds, 12 minutes, 2 beads created, ~0.42 USD (estimated).
  3. The owner clicks that row. The detail shows: the verbatim request sent to the Manager, the Worker's initial prompt, the `BM-REPORT`s by milestone, the final answer, and the Manager → Worker → each Reviewer tree with each one's own time and tokens.
- **J-10 Investigate a long-running request:**
  1. The owner sees a trace row with status "running", 2 hours 10 minutes.
  2. Opens it: the last `BM-REPORT` is `blocked`, and `blockers` records a question waiting for the user since 1 hour 50 minutes ago.
  3. The owner clicks the link to open the Worker and answers directly in the conversation. The Dashboard sends nothing on the owner's behalf.
- **J-11 Check the state of beads before handing over new work:**
  1. The owner opens the Dashboard and reads the statistics block: 93 beads in total, 4 in progress, 11 not started, 2 blocked, 76 closed, 3 ready to work, data read at 09:12 from `.beads/issues.jsonl`.
  2. Seeing 4 unfinished beads, the owner decides not to hand over a new request.
- **J-12 An old request whose agent has been deleted:**
  1. The owner opens a trace from last week; the Worker has been deleted from Paseo.
  2. The trace still shows **in full** the part that was recorded while it ran, with the note "agent no longer on this machine; nothing new can be read".
  3. No error, no unexplained empty cell.
- **J-13 Clean up logs to lighten the load:**
  1. The Dashboard screen shows the trace store size: "412 traces · 86 MB", with a warning because the threshold has been exceeded.
  2. The owner chooses to delete: one trace, or every trace older than a point in time, or all traces of this workspace.
  3. The tool shows **exactly what will be deleted** with counts and size, and asks for confirmation; the default is "No".
  4. After confirmation, the traces are really deleted; the screen updates the new size. Beads, documents, agents and conversations in Paseo are **not** affected — only paseo-bm's trace copy is gone.
- **J-14 An old workspace reopened:**
  1. The owner removed a repo's workspace from Paseo last month, but its traces are still in the store.
  2. The Dashboard shows them in the group **"workspace no longer exists"**, with the last known name and path, so the owner can recognise which repo it was.
  3. The next month the owner reopens a workspace for that same repo. In the "workspace no longer exists" group, the owner chooses to **reassign** to the new workspace.
  4. The tool shows beforehand how many traces will be reassigned and asks for confirmation. After consent, the traces sit together with that workspace's new traces, with no record lost or duplicated.

## 6. Functional Requirements

Priority: **P2** = required for Phase 2a MVP; **P3** = later, not blocking.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-040 | Entry to the Dashboard | P2 | Replaced by REQ-118 ([autonomy PRD](./paseo-bm-autonomy-prd.md), change-014): a project's page is opened from the Projects section or the Command Center item "Open Beads project"; Dashboard Design §11.1 |
| REQ-041 | Trace list by request | P2 | (a) One row = **one request the user sent to the Manager**; a report the Worker sends back to the Manager is never a row of its own. (b) Each row has: time received, a one-line request excerpt, `requestId` when known, status (`running` / `completed` / `waiting for the user` / `stopped` / `error` / `unknown`), number of Workers, number of Reviewer agents, number of review calls, total time, number of beads created/updated/closed, and tokens with cost. (c) Newest first, paged, with a cap on the number of traces read each time (REQ-049) and a load-more button. *(Not implemented yet: the load-more button; currently, when the cap is hit, the screen only says that older requests are not shown.)* (d) Each row states **the confidence of the grouping**: `requestId match` / `inferred` / `unknown`; never presents an inference as fact. |
| REQ-042 | Breakdown of a request | P2 | (a) Shows the Manager → Worker → Reviewer tree of that very request. (b) Clearly separates two numbers: **the number of Reviewer agents** and **the number of review calls** (one Reviewer can be reused, and guardrail REQ-037 counts by call). (c) Shows the guardrail counter the Worker reports itself (`guardrail` in `BM-REPORT`) next to the observed count; if the two differ, shows both and marks the mismatch, without picking one. (d) An orphaned Worker (its Manager deleted) still shows, under the "no Manager" branch. (e) Traces of a provider's internal sub-agents, if present in the timeline, are counted separately and labelled clearly as "the tool's sub-agent, not a Paseo agent". |
| REQ-043 | Detail of a trace row | P2 | (a) **Information sent:** the user's verbatim request, the Worker's initial prompt, and each review request the Worker sent to a Reviewer. (b) **Information received:** the `BM-REPORT` blocks by milestone (work accepted → documents → beads → each bead implemented → stuck → finished), the `BM-REVIEW` blocks, and the Manager's final answer to the user. (c) **Time:** total time of the request, time of each Manager turn, lifetime of each Worker and each Reviewer; each number comes with **the definition of its measuring points shown right on the screen**, and states clearly that this is wall-clock time, including time spent waiting for the user to answer. (d) A running turn shows "running" with the elapsed time, not a fake total. (e) Long text is truncated with an expand button; there is a way to copy it verbatim. |
| REQ-044 | Did this request create beads | P2 | (a) Shows the list of beads **created / updated / closed / ready to work** for the request, each bead with id, title and current status read from the beads store. (b) The preferred source is `BM-REPORT`; when missing, infer from the evidence of `br` commands in the timeline and **mark it as inferred**. (c) "**No** beads created" may be concluded only when a `BM-REPORT` says exactly that (for example `beadsCreated: none` in phase `finished`). No evidence → record "**unknown**", never infer "not created". (d) A bead in a report but no longer in the beads store shows with the note "no longer in the store", without breaking the screen. |
| REQ-045 | Which feature-workflow steps were done, which were not | P2 | (a) A fixed table of steps: size classification (Small/Medium/Large), PRD, Technical Design, ADR, Implementation Plan, plan review, conversion into beads, bead polishing, implement, review per batch, build and test, closing beads with evidence. (b) Each step has exactly one of three states: **done** / **not done (valid for the size)** / **unknown**, with traceable **evidence** (changed files, bead ids, report phase, number of review rounds, build or test commands run). (c) "Done" must have at least one specific piece of evidence. (d) "Not done" is used only when the Worker has stated the request's size **and** that size allows skipping the step: at every size, the documentation, plan, plan review and bead polishing steps (documentation follows the change, not the size); at Small, also the beads, review and bead-closing steps (a Small change has no beads and no review unless the user asks). Implement and build/test are never "not done"; missing evidence means "unknown". (e) The table states the request's size classification and who set it (the Worker classifying itself, or the user overriding). (The table is computed for `traces.get` and read by the Orchestrator; no screen draws it since REQ-118, Dashboard Design §8.) |
| REQ-046 | Beads statistics of the workspace | P2 | (a) Shows: **total beads**, **in progress** (`in_progress`), **not started** (`open`), **blocked** (`blocked`), **closed** (`closed`), and **ready to work** (open with every blocking dependency closed). (b) The figures match `br stats` and `br ready` at the same moment. (c) The only data source is `<workspace>/.beads/issues.jsonl`, without calling `br`; the screen clearly shows the path and the time of reading. (d) A workspace without `.beads/` → empty state with an explanation, not an error. (e) A file with broken lines skips exactly those lines, still computes statistics for the rest, and reports the number of lines skipped. |
| REQ-047 | Writes only its own part, no network | P2 | The request history, its figures and the beads reading are read-only. The plugin's other actions — the Orchestrator, decisions and their delivery, coordination, the action boundary — are required by the [autonomy PRD](./paseo-bm-autonomy-prd.md), which replaced the Orchestrator PRD's exceptions that used to be listed here; a bead action from the Beads board sends a request to the workspace's Manager only after the user confirms (Dashboard Design §13.4). Apart from those, there is a negative test proving that in every flow of the request history, figures and Beads board: **no** agent is created/stopped/archived/deleted, **no** prompt is sent, **no** Paseo configuration is changed, **no** network call is made, **nothing** is written to the workspace or the skills directories, and all writing happens only inside paseo-bm's own data folder. The disk **read** surface outside the data folder is `<workspace>/.beads/issues.jsonl` (plus the data folder pointer, Dashboard Design §17); no configuration file, credential file or any other file is read. |
| REQ-048 | Limits on sensitive data | P2 | (a) The Dashboard neither shows nor stores environment variables, does not read agent configuration files, and reads no file in `~/.paseo` beyond the plugin's existing paths. (b) Secret redaction is applied **before writing** to the trace store, not only before rendering — data already on disk cannot be fixed afterwards. (c) Trace files have permissions `0600`, directories `0700`. (d) The screen says clearly that the content shown and stored is agent conversation, so the user knows what they are sharing when they take a screenshot. |
| REQ-049 | Caps, paging and fault tolerance | P2 | (a) There are caps on the number of traces per page, the number of timeline entries read per agent each time, and the size of `issues.jsonl` read at once (values in the Technical Design). When a cap is hit, show "older data remains" with a load-more button, never cut silently. *(Not implemented yet: the load-more button; the "older data remains" notice exists.)* (b) Agent archived or deleted → show the recorded part with a note. (c) Timeline replaced by Paseo or with gaps (`reset`, `gap`) → read again and record "data may be incomplete". (d) RPC error → a message with the error code, the rest of the screen remains usable. |
| REQ-050 | `BM-REPORT` is a consumed contract | P2 | (a) The `BM-REPORT` reader must be tolerant: missing fields, unknown extra fields, a different order, several blocks in one message, different letter case — none may break the trace; a field that cannot be read is reported as "unknown". (b) Changing the block format in `roles/*.md` is a **contract change**: the reader must be updated in the same change, and it must still read blocks from the previous instructions. (c) There are tests for both block versions. |
| REQ-051 | The `bm.requestId` label when creating agents | P2 | (a) `roles/manager.md` requires the Manager to set the `bm.requestId` label when creating a Worker; `roles/worker.md` requires the Worker to set `bm.requestId` and `bm.batchId` when creating a Reviewer. (b) The payload version and the instructions version are bumped accordingly, and a new agent's `bm.version` reflects the new version. (c) Agents created by an old version (without the label) can still be grouped at the "inferred" level; new agents are grouped at the "requestId match" level. (d) A missing or malformed label never loses a trace. |
| REQ-052 | Tokens and cost | P2 | (a) Each trace and each agent in the trace shows: input tokens, cached input tokens, output tokens, and cost. (b) The cost of a request is always an **estimate** from each turn's tokens; the cost figure the provider reports is the running total of the whole agent session, so it must never be added to a request. (c) The estimate uses **the price table shipped with the release**, prices cached tokens separately at the cache rate, and is labelled "estimated" with **the date of the price table** and the model id. (d) A model not in the price table → show **only** tokens, no money. (e) Never call the network to fetch prices. (f) The screen states clearly that this is not an invoice. |
| REQ-053 | Durable trace store | P2 | (a) A trace is recorded at the moment it happens, so it can still be read after a plugin reload, a daemon restart, and after the agent is archived or deleted (D-8). (b) The store lives in paseo-bm's data folder, split by workspace, with permissions `0600`/`0700`, atomic writes, and a **schema version**: a schema version higher than the one understood is read in a restricted mode with a notice, never overwritten. (c) A write error (disk full, insufficient permission) must not break a running agent: the hook skips, logs one line, and the Dashboard shows the warning "traces may be missing". (d) The store contains no secrets (REQ-048b) and no repo file content beyond what the agents said. |
| REQ-054 | Deleting traces | P2 | (a) The user can delete: **one trace**, **every trace older than a point in time**, or **all traces of a workspace**. (b) Before deleting, show exactly the number of traces and the size that will be lost; the confirmation defaults to "No". (c) Deleting really deletes on disk, it does not hide. (d) Deletion does **not** touch beads, documents, agents, Paseo conversations or any file outside the trace store (D-9). (e) Deleting the trace of a running request must first warn that the rest of the request will be recorded as a new trace. (f) No function deletes on the user's behalf. |
| REQ-055 | Size, warnings and settings | P2 | (a) The Dashboard shows the number of traces and the store size of the workspace being viewed, and the total of the whole store. *(Not implemented yet: the number of traces; currently only the size, measured with `stat` without reading content.)* (b) Above the threshold, show a warning with an entry to the delete function. (c) **No automatic deletion, no automatic compression, no automatic rotation.** This is a deliberate decision: this data is the user's work history. (d) The threshold is **configured by the user in the plugin's settings** right inside Paseo, with a default value; changing the threshold takes effect immediately, with no reinstall or reload. (e) Paseo's settings mechanism has only a **machine-wide** scope, so the threshold is one shared value for every workspace; the screen says so clearly. (f) An invalid setting value (negative, zero, not a number) is rejected with a message, and the threshold in use does not change.
| REQ-056 | Uninstall, update and ownership of the trace store | P2 | (a) The trace store is data created by paseo-bm but **belongs to the user**: removing paseo-bm's settings (Settings → More → Data) asks separately before deleting it, and keeps it by default. (b) **A version update never deletes the store**, even when the store schema needs migrating — a migration reads and writes the new version, and does not delete the old one before the write is finished. (c) The data folder's layout and ownership are described in the base design (§5.1). The installer's uninstall command and `--prune`, which carried these rules until 0.4.0, are retired (ADR-012) |
| REQ-057 | Traces of a workspace that no longer exists, and reassignment | P2 | (a) Traces whose `workspaceId` no longer appears in Paseo's workspace list are shown in a separate group **"workspace no longer exists"**, with the last name and path paseo-bm knew, so the user can recognise which repo it was. (b) A workspace that is only **archived** (still listed) does not go into this group; it is labelled "archived" and stays in its place. (c) Traces in this group can be read and deleted like any other trace. (d) The user can **reassign** all traces of a workspace that no longer exists to an existing workspace: there is a preview step stating the number of traces, a confirmation, and after reassignment the traces sit together with the target workspace's traces. (e) Reassignment must not lose or duplicate records: a turn present in both places ends up as a single copy. (f) Only the user reassigns; there is **no** mechanism that automatically guesses which workspace is the old one. (g) Reassignment touches no file outside the trace store.
| REQ-058 | Which model, thinking level and mode each agent runs with | P2 | (a) Each agent in a request's diagram (Worker, Reviewer; the Manager is in the request detail) shows the **model**, **thinking/effort level** and **mode** it actually ran with, taken from the recorded turns — not from the profile configuration. (b) A value that changes between turns shows every value with the number of turns for each, without picking one. (c) A turn recorded by an old version without this field shows **"not recorded"**, without guessing; a thinking level that is not set shows "provider default". (d) The request detail has a **tokens and cost by model** row, under the same pricing rule as REQ-052 (a model without a price shows only tokens); cost is grouped by the model the agent **actually ran**. (e) Replaced by REQ-118: no screen draws the model × role card; the server still returns `usageByModelRole`. (f) No network calls, and no additional read permission beyond what the collector already reads. |
| REQ-060 | The workspace's "Beads" tab, Setup as Beads Manager's main screen, how a bead states its status | P2 | Replaced by REQ-118 ([autonomy PRD](./paseo-bm-autonomy-prd.md), change-014). What stays — the workspace's "Beads" tab and its header button, and a bead's status told by text and weight, not colour — is specified in Dashboard Design §13.5 and §14 |
| REQ-069 | Kanban by status, bead status not relying on colour, Setup split into sections, error count on Metric | P2 | Replaced by REQ-118 ([autonomy PRD](./paseo-bm-autonomy-prd.md), change-014). The kanban by status and the failure count per request stay, specified in Dashboard Design §13.3 and §7.4 |

## 7. Non-Functional Requirements

| Group | Requirement |
|---|---|
| Performance | Meet D-1. Recording a trace is an append operation, must not slow an agent's turn noticeably (target: under 50 ms per turn) and never blocks the agent on error. Reads are paged and capped. No cron, no watcher, no background loop. |
| Accuracy over completeness | When unsure, say "unknown". One wrong figure that looks trustworthy destroys trust in the whole screen; an "unknown" cell does not. |
| Storage | The trace store has a schema version and a migration path; data from an old version is not lost on upgrade. Atomic writes so that a half-written record does not corrupt a file. |
| Safety and privacy | Redact secrets **before writing**; permissions `0600`/`0700`; no credentials; no environment variables; no writes outside the store; no network. |
| Compatibility | The three existing RPCs (`manager.ensure`, `agents.list`, `roles.describe`) do not change; the structure of `install.json` does not change in a way that breaks older versions; no plugin reinstall is needed to use this feature (updating the payload per REQ-010 is enough). A Paseo host missing an API switches off exactly that part with a notice, without crashing the plugin. |
| Interface | React Native primitives only, every colour from `theme.colors`, accessibility labels on every pressable element, usable in `compact` mode. Interface text is written in **English**, like the existing interface. |
| Testing | Trace grouping logic, `BM-REPORT` reading, time computation, process step inference, reading and writing the trace store, deleting traces, and cost computation all live in pure modules, testable without a renderer. Plus one acceptance run on a real daemon for D-2 → D-10. |
| Observability | Every error message in the interface carries an error code from the shared code registry. |

## 8. Boundaries & Dependencies

- **Depends on Paseo:** filtering agents by label, reading the timeline by page with `timestamp` and `turnId`, agent snapshots with `lastUsage`, the `agent.turn_started` / `agent.turn_ended` hooks, and `config.get()` to find the registered plugin directory. Details and verification sources in [§11](#11-appendix--verified-facts-about-paseo-08).
- **Depends on the role instructions:** the quality of REQ-044 and REQ-045 is proportional to the Worker sending complete `BM-REPORT`s, and REQ-051 depends on agents setting labels as instructed. This is a behavioural constraint, like guardrail REQ-037: the Dashboard cannot enforce it, only show "unknown" when something is missing. A known and accepted limitation.
- **Depends on `br`:** the format of `.beads/issues.jsonl` (the fields `status`, `labels`, `dependencies`, `updated_at`). The Dashboard only **reads**; it never writes, in line with the "never hand-edit issues.jsonl" convention. It does not depend on `br` being installed on the machine.
- **Depends on the model price table** for REQ-052: the table ships with the release, is dated, and will age. The source of truth is each provider's published price page; figures on Bedrock or Vertex differ from the direct API's. This is why money amounts always carry the "estimated" label.
- **Does not own:** machine setup, how agents are created, the content of `roles/*.md` (this document only asks for the label in REQ-051), Paseo internals, `br`'s data format.
- **Related to other Phase 2 REQs:** REQ-030 and the bead progress board part are implemented by this feature. REQ-016, REQ-017, REQ-028, REQ-029 do **not** belong to this feature.

## 9. Phase Scope

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 2a MVP | REQ-040 → REQ-057 | Met and shipped in 0.2.0: every P2 AC, D-1 → D-11 in one acceptance run on a real daemon ([run record](../archive/operations/paseo-bm-dashboard-run-20260916.md)), ADR-007 Accepted |
| Phase 2b MVP | Grouping by the `phase:*` and `wp:*` labels, aggregating several workspaces, exporting reports, charts over time | Not built |

## 10. Open Questions

Every question is answered; the rows are kept for their ids.

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-030 | Should traces be stored separately on disk? | hieu.nt10 | **answered** — **Yes, store traces**, with a trace deletion function so the store does not grow over time. See REQ-053, REQ-054, REQ-055 and [ADR-007](../adr/ADR-007-dashboard-trace-store.md) |
| Q-031 | Source of the beads statistics | hieu.nt10 | **answered** — read `.beads/issues.jsonl` directly, without calling `br` (REQ-046c) |
| Q-032 | Source of truth for REQ-044 and REQ-045 | hieu.nt10 | **answered** — `BM-REPORT` plus inferred evidence, always stating the confidence |
| Q-033 | Add the `bm.requestId` / `bm.batchId` labels? | hieu.nt10 | **answered** — yes, and a bump of the instructions version is accepted (REQ-051) |
| Q-034 | The concrete caps | hieu.nt10 | **answered** — take the maximum levels proposed: 50 traces per page, 2,000 timeline entries per agent, 32 MB per read of `issues.jsonl` (REQ-049a) |
| Q-035 | Show tokens and cost? | hieu.nt10 | **answered** — yes; cost is always **estimated by model** from tokens, since the provider's figure is a session total (REQ-052) |
| Q-036 | Where does the Dashboard live | hieu.nt10 | **answered** — on the "Beads Manager" surface; now a project's page in Projects (REQ-118) |
| Q-037 | Is an ADR needed | hieu.nt10 | **answered** — yes: [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (Accepted) |
| Q-039 | How the uninstall and update commands handle the trace store | hieu.nt10 | **answered** — a version update never deletes the store (REQ-056b); the uninstall command is retired, and removing paseo-bm's settings asks separately before deleting the data, keeping it by default (REQ-056a) |
| Q-040 | Size warning threshold | hieu.nt10 | **answered** — configured by the user in the plugin's settings, default 200 MB (REQ-055d). Technical consequence: Paseo's settings mechanism has only a machine-wide scope, so the threshold is one shared value for every workspace (REQ-055e) |
| Q-041 | Where do the traces of a workspace removed from Paseo go | hieu.nt10 | **answered** — into the "workspace no longer exists" group, and the user can reassign them to an existing workspace when the repo is reopened (REQ-057) |

## 11. Appendix — verified facts about Paseo 0.8

Checked against `@getpaseo/plugin`, `@getpaseo/client` and `@getpaseo/protocol` 0.8.0 type declarations, and on a real daemon where stated. Facts that [AGENTS.md](../../AGENTS.md) *Verified facts about Paseo* holds are only pointed to here.

| Fact | Meaning for the feature |
|---|---|
| `paseo.agents.list({ filter: { labels, includeArchived }, page: { limit ≤ 200, cursor } })`; the filter has **no** workspace key | Agents can be filtered by `bm.role`, including archived agents; the workspace must be matched by hand on `agent.workspaceId`, as `manager.ts` already does |
| `paseo.agents.ref(id).timeline.refetch({ direction, cursor, limit, projection })` returns entries each with `item`, **`timestamp`**, **`turnId`**, `seqStart`/`seqEnd`, plus `epoch`, `reset`, `gap`, `hasOlder`, `hasNewer` | The conversation can be read by page, and **time can be measured** from each entry's real timestamps; there are flags to tell whether data was replaced or has gaps |
| An agent snapshot has `createdAt`, `updatedAt`, `lastUserMessageAt`, `activeTurn.startedAt`, `status`, `labels`, `parentAgentId`, `archivedAt`, **`lastUsage`** (`inputTokens`, `cachedInputTokens`, `outputTokens`, `totalCostUsd`, `contextWindowUsedTokens`) | Enough to build the tree, know which turn is running, and show tokens (REQ-052). The token fields are per turn but `totalCostUsd` is the session's running total (AGENTS.md, *Verified facts*), so the cost of a request is **always** an estimate from tokens |
| Timeline entry types include `user_message`, `assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `notification`, `compaction`, `plugin`; `tool_call.detail` comes in the forms `shell` (with `command`, `output`, `exitCode`), `edit`/`write` (with `filePath`), `search`, `sub_agent`, `plan` | Source of evidence for REQ-044 and REQ-045: which `br` commands ran, which document files were written, which sub-agent traces exist |
| The hooks `on("agent.turn_started")` and `on("agent.turn_ended")` provide `turnId` and `outcome`; the ended event's `timeline` is the agent's **whole** timeline with the timestamps stripped (verified on the 0.8.0 daemon, A-2) | This is the collection path for REQ-053: record the trace as soon as a turn ends, so the trace survives even when the agent is deleted; the turn's own entries, with timestamps, come from one `timeline.refetch` call. It is an **event hook**, not a background task; the plugin also uses it to propagate the stop command |
| The `before("agent.create")` hook sees no label and no initial prompt (AGENTS.md, *Verified facts*) | The plugin **cannot** set the `requestId` label itself, so REQ-051 must go through `roles/*.md` |
| `paseo.config.get()` returns the daemon configuration, in which `plugins["paseo-bm"]` is `{ source: "directory", path }` | No longer used: since 0.4.0 the data folder is resolved by `resolveDataHome()` (base design §5.1). The server bundle still **has no cwd** and cannot read `import.meta.url` |
| `registerSettings({ id, scope: "host", version, schema })` on the server, `addSettingsScreen(...)` and the `useSettings(definition)` hook on the client, plus three read/write/reset RPCs managed by Paseo (writes carry a `revision` to prevent concurrent overwrites). The only scope is **`"host"`** — there is no per-workspace scope | The place for the size warning threshold (REQ-055d) without writing a configuration file of our own; and the reason the threshold is just one shared value for the whole machine (REQ-055e) |
| `paseo.workspaces.list()` returns workspaces with `archivingAt`; `workspaces.archive(...)` is how Paseo drops a workspace | "Archived" (still listed) can be told apart from "no longer in the list" — exactly the two states REQ-057a and REQ-057b need |
| `listProviderSubagents` exists only on the internal `DaemonClient`, **not** on the `PaseoApi` the plugin receives | A provider's internal sub-agents can only be counted through the `tool_call.detail.type === "sub_agent"` traces in the timeline |
| The plugin's client entry cannot read the file system; the server entry is Node | Reading `.beads/issues.jsonl` and writing the trace store must live in the server entry, reaching the interface through RPC |
| Each line of `.beads/issues.jsonl` has `id`, `status`, `issue_type`, `labels`, `dependencies` (including the `blocks` and `parent-child` types), `created_at`, `updated_at`, `closed_at` | Every figure of REQ-046 can be computed, including "ready to work" |

**Assumptions (both checked):**

- **A-1:** a report the Worker sends to the Manager with `send_agent_prompt` appears in the Manager's timeline as a `user_message` entry — confirmed (AGENTS.md, *Verified facts*).
- **A-2:** the `timeline` of the `agent.turn_ended` hook carries no `timestamp` — confirmed, so the collector makes one `timeline.refetch` call per turn (Dashboard Design §2.3).

## 12. Revision History

Rows up to 2026-10-02 are archived in [paseo-bm-dashboard-prd-revision-history-to-20261002.md](../archive/product/paseo-bm-dashboard-prd-revision-history-to-20261002.md); git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-02 | Claude (owner request) | Documentation restructure: earlier rows moved to the archive; stale, retired and duplicated content condensed to the current state (section numbers and REQ ids kept) |
