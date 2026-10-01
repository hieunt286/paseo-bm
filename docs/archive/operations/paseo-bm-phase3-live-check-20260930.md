# paseo-bm — Phase 3 live check: handoff through the Manager, and compaction on request (run note, 2026-09-30)

| Field | Value |
|---|---|
| Beads | `bm-autonomy-phase3-7gxw.11` (plan WP-309, "a run note of the live check"); in the same run, the compaction path of `bm-autonomy-phase3-7gxw.10` (WP-308) |
| Build under test | The working tree at `a92d8d5` plus the uncommitted Phase 3 changes; `PLUGIN_VERSION` 0.4.1. The generated role instructions were checked equal to `plugin/roles/*.md` before the run. A copy of `plugin/` (241 files) was made; its tree SHA-256 `17128478…0ae07` equals the repository's, before and after the run. That copy got **one harness patch** (Setup §2), which made its hash `03ed8aae…c9d8`, the same before and after the run. It was installed with `paseo plugin add <copy>` |
| Environment | Paseo 0.9.2. An isolated daemon on `127.0.0.1:6943` (supervisor pid 15161, daemon pid 15162), started with `scripts/manual-test/start-daemon.sh`, with its own `PASEO_HOME` and `PASEO_BM_HOME` under the session scratchpad. All four roles were set to Claude `claude-haiku-4-5` with `roles.save-settings`: Manager, Worker, Orchestrator, and the Reviewer, which was never created. Modes: Manager and Workers `bypassPermissions`; the Orchestrator `default`, as it resolved for Haiku |
| Run by | Claude, under the owner's delegation, 16:14:33 to 16:34:39 UTC |

## Setup

1. `start-daemon.sh <run> 6943`, then `paseo plugin add <copy>` → `status: running` (log: Loading plugin 16:15:29.126 → Plugin ready 16:15:35.493). `setup.ensure-roles` created four roles; `roles.save-settings` ran four times (Haiku); `setup.grant-agent-tools { confirmed: true }` → `injectIntoAgents: true`.
2. **Thresholds lowered for a cheap run (test harness, isolated data folder only).**
   - **What was written.** Before the Manager and the Orchestrator existed, `<data>/coordination/settings.json` was written directly (0600, replaced atomically) and read back unchanged with `coordination.settings`:
     - `version: 1`, `advice.everyFinished` 5;
     - `compact { enabled: true, managerTokensPerTurn: 50000, workerTokensPerTurn: 100000000, contextShare: 0.9, maxPerAgent: 1 }`;
     - `handoff { enabled: true, requestTokens: 200000, maxPerRequest: 1 }`;
     - `review` 2 / 2 / 4, and both `guard` entries `{ countsFrom: null, switchedOff: null }`.
   - **Later writes.** `compact.contextShare` was set to 0.1 at 16:18:58, as a fallback for path A (A.1), and back to 0.9 at 16:22:14, before path B.
   - **Why the copy was patched.** The store reads each setting on its own and treats a value outside its bounds as the default (`coordinationSettingsOf` → `valueOr`; design §G.7). So a `handoff.requestTokens` below its 10,000,000 minimum would have read as 150,000,000. The copy's `plugin/shared/coordination.ts` was therefore changed on one line: `HANDOFF_REQUEST_TOKENS.min` 10,000,000 → 100,000. Nothing else was changed. Every compaction value used is inside its bounds.
   - **Why these values.** `maxPerAgent` 1 and `maxPerRequest` 1 allow one cycle per agent and per request. `workerTokensPerTurn` at its maximum and `contextShare` 0.9 kept the Workers out of compaction, so the two paths stayed apart.
3. **The fixture.** `new-workspace.sh demo` created workspace `wks_b27b9697182ee35c` (a `math.js` with one function and a `node --test` script). Then `br init --prefix demo` ran, and `.beads/` was committed with its database files ignored: HEAD `cec1a7f`.
4. **The agents.** `manager.ensure` created Manager `9f123210-537a-48a6-9ce0-7dd589b6c65c` (16:16:34). `orchestrator.open { confirmed: true }` created Orchestrator `e7d4f335-cd60-48ff-a6c6-ecf70ccd535a` (16:16:36); its opening turn ended before 16:16:49.
5. **Owner messages.** Every one was sent as the app sends it (`send.mjs`, with a `messageId`). No permission request came up in the whole run (`pendingPermissions` 0), and there was no `AskUserQuestion`.

The requests are described here, not quoted:
- **Path A:** two read-only questions about the fixture's files.
- **Path B:** a Medium request for two functions in two beads written by hand: bead 1 first; then a question to the owner about which function bead 2 adds (class `preference`, both options `effects: none`); then bead 2. No Reviewer and no commit.

## Path A — compaction (Claude Manager)

| Step | Time (UTC) | Observed |
|---|---|---|
| Owner's question 1 | 16:17:28.485 | Manager `foreground-turn-1`: 3 tool calls; tokens read 26,947 (input 18 + cached 26,929); context 27,726 of 200,000. Below 50,000: no event |
| Owner's question 2 | 16:19:03.790 | `foreground-turn-2`, ended 16:19:09.110: 1 tool call; tokens read 55,399; context 28,295 |
| `threshold.crossed` raised / delivered | 16:19:09.110 / 16:19:09.145 | One `BM-EVENTS` message (`fromApp: true`) with 1 event: kind `compact`, Manager `9f123210…`, request none, figure `tokensPerTurn` 55,399 against 50,000, cycle 0. The line names `bm_compact` |
| Wake 1 | 16:19:09.165–16:19:23.450 | `bm_projects` (16:19:15.607), then **`bm_note`** (16:19:21.873, 147 characters). The Orchestrator judged the crossing marginal (about 11 % over) and did not call `bm_compact` |
| The owner asks | 16:20:41 | An owner message in the Orchestrator's chat, asking for that Manager's compaction with `bm_compact` |
| `bm_compact` | entry 16:20:44.384, answered 16:20:44.462 | Compaction `83d57d58-c84c-4858-bbff-c46e73d96f3f`, provider `claude`, reason 94 characters. Intervention `303f6cdc-9028-47dc-a34d-4a15c9c4e78e`: kind `compact`, trigger `owner`, expected `tokens-per-turn-down`, window 60 min. The Manager was idle with nothing queued, so the `/compact` went at once |
| `/compact <focus>` | sent 16:20:44.450 | Timeline `user_message` 16:20:44.445: 295 characters (`/compact ` + `COMPACT_FOCUS`), `clientMessageId` set. Send-log entry 1 at 16:20:44.456, hash `39cce0c1…0281` |
| Compaction item | 16:20:44.454 → 16:21:00.145 | `loading` → `completed` in 15.7 s; `trigger: manual`; `preTokens` 28,313 |
| `BM-STATE` | 16:21:00.206–16:21:00.223 | Send-log entry 2 at 16:21:00.206 (hash `ac2302c4…43ad9`). Entry `done`, `briefAt` 16:21:00.211. Timeline `user_message` 16:21:00.223: 872 characters, `clientMessageId` set. It holds `requests: none recorded` and the owner's 2 messages, not the `/compact`; 0 `[redacted]`. The Manager replied in one word (16:21:02.040) |

**How the collector recorded the Manager's turns** (trace store):

| Turn | Started | Ended | Tokens read | Context | Its message recorded as |
|---|---|---|---|---|---|
| 1 | 16:17:28.485 | 16:17:39.433 | 26,947 | 27,726 | the owner's (`origin: user`) |
| 2 | 16:19:03.790 | 16:19:09.110 | 55,399 | 28,295 | the owner's |
| 3 (compaction) | 16:20:44.445 | 16:21:00.146 | 0 | 2,984 | **the plugin's** (`origin: agent`): the text's hash equals send-log entry 1; evidence `compaction` at 16:21:00.145 |
| 4 (`BM-STATE`) | 16:21:00.223 | 16:21:02.052 | 21,493 | 26,683 | the plugin's: the hash equals send-log entry 2 |

- The compaction turn's figures (0 and 2,984) understate, as §G.5 says; such a turn is never judged.
- The Manager was then at `compact.maxPerAgent`, so none of its later turns raised an event, although turns 6 and 8 read 120,251 and 157,664.

**Outcome.** The `compact` intervention settled **`missed`** at 16:24:19.821.
- *Before:* the 2 measured turns before the send, 26,947 and 55,399 (mean 41,173).
- *After:* the next 3 measured turns, 21,493, 26,571 and 120,251 (mean 56,105). That is above 60 % of before (24,704).
- *The fixture's part:* the third turn after is the one that created the Worker, while the turns before were two read-only questions. The context at the compaction was 28,295, most of it the system prompt; at the next turn it was 26,683 (−6 %).

**Path A verdict: pass for the mechanism, with one deviation.**
- *What passed:* the threshold event woke the Orchestrator; `bm_compact` was accepted; `/compact` with the focus went at the Manager's idle moment; the compaction completed; `BM-STATE` was built from the stores; the collector classified both messages as the plugin's through the send log; the outcome was judged.
- *The deviation:* the threshold wake ended with `bm_note`, the Orchestrator's own judgement that the crossing was marginal, so `bm_compact` came on the owner's word (trigger `owner`), not on `threshold.crossed`.
- *No second wake:* the event is deduplicated once per cycle, in memory (F6), so that Manager raised no second event. The run did not reload the plugin to force one.

## Path B — handoff through the Manager

| Step | Time (UTC) | Observed |
|---|---|---|
| Owner's request | 16:22:32.702 | 678 characters. The Haiku Manager asked the owner to choose between two ways instead of delegating (turn 5, ended 16:23:02.672; F5) |
| The owner picks the Manager's first option | 16:23:27.177 | Manager turn 6: `list_profiles` 16:23:39.310, `create_agent` 16:24:16.166 → Worker **`c31e9027-0957-4af8-9d47-3541a3881cf7`** (created 16:24:15.882). Labels `bm.role` worker, `bm.requestId` **`req-20260930T162000Z`** (the Manager's own time stamp). Mode `bypassPermissions` |
| Worker turn 1 | 16:24:16.161–16:25:28.939 | 19 tool calls. Beads `demo-di4` and `demo-c47` created (16:24:45.636, 16:24:47.958); `demo-di4` `in_progress` 16:24:59.164; `npm test` completed 16:25:07.899; **`br close demo-di4` completed 16:25:11.285** (the safe point). `bm_report` built a `received` block (16:24:51) and a `blocked` block with the question (16:25:25), but neither was sent or posted as a block: no report was recorded and no decision stored (F5) |
| `threshold.crossed` raised / delivered | 16:25:28.939 / 16:25:28.970 | Kind `handoff`, Worker `c31e9027…`, request `req-20260930T162000Z`, figure `requestTokens` 595,958 against 200,000, cycle 0. The line names `bm_handoff` |
| Wake 2 | 16:25:28.972–16:25:42.571 | `bm_request` (16:25:33.939), then **`bm_handoff`** (answered 16:25:40.524), reason 211 characters |
| Handoff accepted | 16:25:40.447 | Handoff **`99d4f1e7-a7aa-44c3-b565-6d9ed0c69e9a`**, Manager `9f123210…`. Intervention **`0ce4ae3e-9baf-4899-a2c5-c16418af4ead`**: kind `handoff`, **trigger `threshold.crossed`**, expected `successor-progresses`, window 60 min |
| Note request (`BM-HANDOFF`) | `noteAskedAt` 16:25:40.500 | The Worker was idle and its newest turn had closed a bead, so it was asked at once. Timeline 16:25:40.497: 556 characters, `clientMessageId` set, recorded `origin: agent` |
| The note | Worker turn 2, 16:25:40.497–16:25:55.276 | `bm_report` with `handoffNote` (one refusal, then built at 16:25:51.389), posted as a block and recorded: phase `blocked`, `beadsClosed` `demo-di4`, `handoffNote` 562 characters |
| Brief | `briefAt` 16:25:55.363 | `handoffs/99d4f1e7….json` (0600). The brief is 2,701 characters (bound 3,200 = `MAX_COMMAND_BODY_CHARS` − 800) and the note 562 (bound 1,500). Masked with `redactText`, 0 `[redacted]`: nothing secret-shaped was in its inputs |
| Command | `commandSentAt` 16:25:55.387 | Command `60799464-43c6-4ede-86af-6940386a5ea1` in `proposals.json` (`source: chat`, `status: sent`). The Manager's timeline at 16:25:55.379 shows a `BM-COMMAND` of 3,759 characters, `clientMessageId` set, recorded `origin: agent`. Header: `from: orchestrator`, `via: chat`, `to: manager`, `requestId: req-20260930T162000Z`, `intent: handoff`, `effects: none`, `authority: coordination:handoff`, `approved: none`, `limits: no-commit-push-deploy, no-real-data` |
| Successor created | `create_agent` 16:26:06.507 | Worker **`ceac98db-6380-4a39-83e2-411b8b5a2558`** (created 16:26:06.474). Labels `bm.role` worker, `bm.requestId` `req-20260930T162000Z`, **`bm.handoffFrom` `c31e9027…`**; parent `9f123210…`; its instructions label equals its predecessor's. First message: 2,647 characters, the stored brief byte for byte **without its first line** `BM-HANDOFF-BRIEF 99d4f1e7…` (F2) |
| Successor linked | `successorAt` 16:26:07.052 | Handoff `done`. The outgoing Worker got **`bm.replacedBy` = `ceac98db…`** (its snapshot updated 16:26:07.489) and was **not archived** (`archivedAt` null at the end) |
| Replacement notice | 16:26:15.212 | The Manager used Claude Code's own `SendMessage`, which answered that no such agent is reachable. Nothing reached the outgoing Worker (F4): it received no message after the note request, and stayed idle |
| Successor turn 1 | 16:26:06.502–16:26:43.084 | `git status` 16:26:18.436, `git diff math.js` 16:26:20.452, `npm test` 16:26:24.777. It built a `received` block (16:26:29.547) and sent it with Claude Code's `SendMessage` to the Manager's id (16:26:36.512, not reachable). It then posted the block in its chat as `**BM-REPORT**` inside a code fence, which the collector does not parse (F4, F5) |
| The owner answers the question | 16:29:43.860 | In the successor's chat: the question had never been stored as a decision, so there was no card |
| Successor turn 2 | 16:29:43.860–16:30:11.802 | Second function added (edits 16:29:47–16:29:59.590); **`npm test` 16:30:01.813**. A `finished` block built at 16:30:08.057 and posted as `**BM-REPORT**` (not parsed). `demo-c47` left open |
| Owner's correction | 16:31:33.064 | In the successor's chat: close `demo-c47`, and send the report with Paseo's `send_agent_prompt` |
| Successor turn 3 | 16:31:33.065–16:31:46.634 | `br close demo-c47` 16:31:37.262; `send_agent_prompt` 16:31:43.341. The Manager's turn recorded the **`finished`** report at 16:31:43.334: `requestId` `req-20260930T162000Z`, `beadsClosed` `demo-c47`, `filesChanged` `math.js`, `test/math.test.js`, `buildAndTests` `` `npm test` pass `` |

**The request kept its id.** Every Worker record, both Workers' labels and the finished report carry `req-20260930T162000Z`. `traces.list` shows one trace, `req:req-20260930T162000Z`, with `workerIds` [`ceac98db…`, `c31e9027…`] and state `completed`.

**No pairing alert.** `inbox.alerts` was empty at 16:29 and at 16:32; the run raised no alert of any kind.

**The finish was verified by the successor's own checks.**
- `traces.list` → `verification`: `reportAt` 16:31:43.334; `checks: detected` (`npm test` detected); files `math.js` and `test/math.test.js` detected; bead `demo-c47` detected; `changedFiles: true`; `unverified: false`.
- The only `npm test` after the last edit (the successor's, 16:29:59.590) is the successor's own, at 16:30:01.813. The outgoing Worker's run at 16:25:07.899 came before any of the successor's edits.
- *Caveat (F2):* with the marker missing, `shared/evidence.ts` finds no handoff for this request (`lastHandoff` null), so the rule that counts only a successor's own checks was not in force. It changed nothing here, because the successor edited after the handoff.

**No further events.** After the handoff the Orchestrator received no `BM-EVENTS` (2 in all):
- the request was at `maxPerRequest` 1;
- the Manager was at `maxPerAgent` 1;
- the Workers stayed below `workerTokensPerTurn` and `contextShare`.

**Outcome.** The `handoff` intervention settled **`missed`** at 16:31:46.681, right after the successor's third turn.
- *Before:* the outgoing Worker's measured turns before `successorAt`, 595,958 and 121,022 (mean 358,490).
- *After:* the successor's first three, 292,850, 347,080 and 166,531 (mean 268,820). That is above 50 % of before (179,245), so it is missed on tokens; the report part of the check is not reached.
- *The fixture's part:* the outgoing Worker's context at the handoff was 42,393 of 200,000, so a fresh context had little to save.

**Work's timeline (F2).** `client/work-model.ts` draws a handoff only when a Worker's first message holds the brief's marker. Here the recorded first message has no marker, so the request would read "The Manager handed it to …" and not the handoff. This is read from the code and the recorded message; no app was attached.

**Path B verdict: pass for the plugin's sequence, with two gaps.**
- *What passed:* the threshold wake; the Orchestrator's own `bm_handoff`; the note at the safe point; the brief, masked and bounded; the command on `coordination:handoff` through the command log; the successor with `bm.handoffFrom`, created by the Manager; the outgoing Worker labelled `bm.replacedBy` and not archived; the request's id kept; no pairing alert; the finish verified by the successor's own checks; the outcome judged.
- *Not as specified:* Work's timeline does not show the handoff (F2).
- *Owner messages needed:* the successor finished only after two owner messages that made up for the models' slips (F4, F5).

## Figures

**A-7, the Orchestrator's wakes** (`orchestrator/wakes.json`): 2 wakes, each with 1 event, both in project `wks_b27b9697182ee35c`.

| Wake | Event | Action | Tokens (input / cached / output) |
|---|---|---|---|
| 16:19:09.165–16:19:23.450 | `threshold.crossed` compact | `bm_note` | 26 / 100,902 / 1,142 |
| 16:25:28.972–16:25:42.571 | `threshold.crossed` handoff | `bm_handoff` | 26 / 110,308 / 1,032 |

- By §G.7 both wakes were acted on, a no-action share of 0. The replay reads 1 acted on and 1 without action (0.5): see F3.
- Outside the wakes, the Orchestrator called `bm_compact` once, on the owner's message.
- The Orchestrator itself sent no command. The one command of the run is the handoff's, which the plugin sent on `bm_handoff`.

**Interventions:**

| Id | Kind | Trigger | Outcome | Checked |
|---|---|---|---|---|
| `303f6cdc…` | `compact` | `owner` | missed | 16:24:19.821 |
| `0ce4ae3e…` | `handoff` | `threshold.crossed` | missed | 16:31:46.681 |

A-12: `compact` 0 of 1, `handoff` 0 of 1. Each kind has fewer than 10 entries, so the guard did not judge: both mechanisms stayed on and both `guard` entries are unchanged.

**Replay** (`node .eval-dist/replay.js --home <run data folder> --json`; the bundle was built at 15:45 UTC, before the run, and `plugin/shared/eval-metrics/` has not changed since):
- 1 request in the window, 1 finished.
- A-1: 0 asked (the question was never stored, F5).
- A-8: 1,741,050 tokens (Manager 203,467; Worker 1,537,583); the Orchestrator's 2 wakes 213,436.

**Tokens read per turn** (trace store):
- Manager (10 turns): 26,947; 55,399; 0 (compaction); 21,493; 26,571; 120,251; 36,274; 157,664; 42,531; 43,166.
- Outgoing Worker: 595,958; 121,022.
- Successor: 292,850; 347,080; 166,531.

**Spend** (`totalCostUsd`, each agent's session total at the end): Manager $0.2269, outgoing Worker $0.1953, successor $0.1474, Orchestrator $0.1199; **$0.6895 in all**, Claude Haiku 4.5 throughout, no Reviewer. The compaction's own cost was not separated: the Manager's total was not read just before it; after the `BM-STATE` turn it was $0.0942.

## Findings

1. **F1 — harness: a threshold below its bound cannot be set through the file.**
   - The store reads a value outside its bounds as the default (§G.7, as designed). A cheap run with a lower `handoff.requestTokens` therefore needs either a patched copy, as here (one line, Setup §2), or a request that reads 10,000,000 tokens.
   - The compaction values used (50,000, 100,000,000, 0.1, 0.9, 1) are inside their bounds and needed no patch.
   - Nothing in the product was wrong. The kit has no documented way to do this.
2. **F2 — product gap (robustness): the successor is recognised only by the brief's marker line.**
   - *Expected (§G.6 steps 4–5):* Work's timeline shows the handoff, and detected evidence holds the successor to checks it runs.
   - *Seen:* the Manager (Haiku) passed the brief byte for byte except its first line `BM-HANDOFF-BRIEF 99d4f1e7…`, which the command carried and told it to keep. `shared/evidence.ts` (`lastHandoff`) and `client/work-model.ts` (`timelineEvents`) look only for that line in a Worker's first message. So neither recognises successor `ceac98db…`.
   - *Why it is a gap:* the plugin knows the successor independently. The `bm.handoffFrom` label is checked on `agent.created`, and the handoff store holds `successorId` and `successorAt`.
   - *Effect here:* none on the verdict (see "The finish was verified"). With a successor that makes no edit of its own, the outgoing Worker's checks would count.
   - Not fixed.
3. **F3 — metric bug: A-7 does not count `bm_compact` or `bm_handoff` as a wake's action.**
   - *Where:* `orchestratorActionsOf` (`plugin/shared/eval-metrics/orchestrator.ts`), and the list in §4 A-7 of the evaluation design, count commands, `o:` decisions, answers, predictions and notes, but not the intervention log.
   - *What happened:* wake 2 ended with `bm_handoff` (intervention at 16:25:40.447). The handoff's command went out at 16:25:55.380, after the wake ended at 16:25:42.571, because it waits for the note. So the replay reads that wake as no action, and A-7 reads 0.5 instead of 0. The same would happen to any threshold wake answered with `bm_compact`.
   - *Expected:* §G.7 makes `threshold.crossed` a judgement wake, and §G.8 keeps A-7's target over such wakes.
   - Not fixed.
4. **F4 — environment and model: Claude Code's own `SendMessage` and `ListAgents` compete with Paseo's tools.**
   - The Manager's replacement notice (16:26:15.212) and the successor's `received` report (16:26:36.512) went through Claude Code's built-in `SendMessage`, which cannot reach a Paseo agent, and not through `mcp__paseo__send_agent_prompt`. So the outgoing Worker was never told it was replaced (the plugin's label still marks it), and the successor's first report went nowhere.
   - **The successor's `ListAgents` (16:26:37.727) listed 12 peer Claude Code sessions of the owner's own HOME.** An agent under the isolated daemon can therefore see, and could message, the owner's real sessions, since provider logins share the real HOME. Nothing was sent to any of them: both `SendMessage` calls targeted Paseo agent ids and failed.
   - Not a paseo-bm defect, but a risk for the roles' reporting and for the isolation of test runs.
5. **F5 — model slips (Haiku), and one weakness they exposed.**
   - *The Manager* asked the owner to choose instead of delegating.
   - *The outgoing Worker* built its `received` and `blocked` reports but never sent or posted them. So the question was never stored as a decision (no card, A-1 0), and the owner answered in the successor's chat.
   - *The successor* posted its blocks as `**BM-REPORT**` inside a code fence, which the collector does not parse (`^\s*(?:```\s*)?BM-REPORT`).
   - *The weakness:* the brief's bead state comes from recorded reports only. `demo-c47` was open in `.beads/` but appears nowhere in the brief (`beadsCreated`, `beadsReady` none), so the successor did not close it until the owner named it.
   - Two owner messages made up for these slips. An Opus profile may not need them.
6. **F6 — observations.**
   - **A declined crossing is not offered again.** The event is deduplicated once per cycle (`threshold.crossed:compact:<agent>#0`, in memory). After a wake that ends in `bm_note`, that agent raises no new `threshold.crossed` until it compacts or the plugin reloads, however heavy its later turns get. As designed ("one per cycle"), but for the owner's judgement.
   - The Orchestrator's opening message (`orchestrator-agent.ts`) lists its tools up to `bm_compact` and omits `bm_handoff`; it used `bm_handoff` anyway.
   - A cost gap on the Manager's first turn: the plugin's own estimate from the reported tokens is $0.0056, while `totalCostUsd` is $0.0608. Cache-creation tokens, which `lastUsage` does not carry, would explain it; not examined further.
   - The send log re-stamps its `at` when the send goes out (16:20:44.456), 11 ms after the timeline stamped the message (16:20:44.445). The matcher's window (60 s before, 30 min after) covers it.
   - `traces.list` groups the Manager's two earlier read-only turns, which carry no request id, into this request's trace, as turns 1–2 of 4.
7. **F7 — the owner's `~/.paseo/config.json` changed during the run, and not by it.** See "The owner's machine".

## Acceptance criteria

| Criterion | Result |
|---|---|
| Handoff: `threshold.crossed` (handoff) wakes the Orchestrator, which calls `bm_handoff` | Met: wake 2; the model called it itself, so no endpoint fallback was used |
| The outgoing Worker's note is asked; the brief is built, masked and bounded; `coordination:handoff` goes to the Manager | Met (masking applied; nothing to mask in the inputs) |
| The Manager creates the successor with `bm.handoffFrom`; the outgoing Worker gets `bm.replacedBy` and is not archived | Met |
| The request keeps its id; no pairing alert | Met |
| The successor continues; its finish is verified only by checks it ran | Met, with caveats: F2 (the evidence reset was not in force); F4 and F5 (two owner messages) |
| Work's timeline shows the handoff | Not met in this run (F2) |
| The `handoff` outcome is judged | Met: `missed` |
| Compaction: `threshold.crossed` (compact) wakes the Orchestrator | Met: wake 1, ended with `bm_note` |
| `bm_compact` → `/compact <focus>` at a safe point, then `BM-STATE` | Met, on the owner's word (trigger `owner`) |
| The collector records the plugin's `/compact` as the plugin's, through the send log | Met |
| The `compact` outcome is judged | Met: `missed` |
| The bead's scope, "a Large request handed over at a bead boundary" | Partly: a Medium two-bead request, handed over at a bead boundary (after `demo-di4` closed); Large was not used, to keep the spend small |
| The owner's config hash unchanged | **Not met**: changed by another client of the owner's daemon, not by this run (F7) |
| `npm run verify` green | Not run by this check (the caller runs it); this run changed no code in the repository |

## The owner's machine

- **The hash of `~/.paseo/config.json` changed.** SHA-256, hashed read-only with the contents never printed: before (16:14:33) `90fc8099c13e75fd1ba9612f0c0d9faceabe5b74cdcaf1dc3dd49cafd86f778d`, after (16:34:39) `772e708e1a92cd0322e7c389fdbaa80a5186eb6398fe4ecba9a4e5532d4f4d0b`.
- **What changed.** The file was modified at 16:27:30 UTC. The owner's backup `config.json.bak-20260930T1627` carries the "before" hash, so the two could be compared, printing JSON paths only, never values. Exactly one path differs: `plugins.paseo-bm.path`, the directory the owner's daemon loads paseo-bm from.
- **Who changed it.** The owner's daemon (pid 1274) logged "Loaded from / Saved to ~/.paseo/config.json" at 16:27:30.178/.179 and 16:27:30.779/.781, for a client that connected at 16:27:30.070. It then logged "Loaded plugin" for paseo-bm at 16:27:33.953.
- **Why it was not this run:**
  - the new path lies outside this run's scratch folder, outside `/tmp` and outside the repository;
  - no kit client (`bm-manual-*`) appears in the owner's daemon log;
  - every `paseo` CLI call of this run carried the isolated `PASEO_HOME`, and after the 16:15:28 install they were read-only (`plugin logs`, `logs`, `daemon status`). They appear on the isolated daemon's log at 16:27:03 and 16:27:13, none at 16:27:30.
  - The CLI's client id (`cid_…`, from `~/.paseo/cli-client-id`) is the same for every CLI call on this machine, so it does not tell callers apart.
- **The owner should check** what re-pointed their paseo-bm plugin at 16:27:30 UTC.
- **The owner's daemon and data.** The daemon (port 6767) was not contacted, stopped or restarted by this run; it was still listening at the end. `PASEO_BM_HOME` pointed at the run folder throughout, and `~/.paseo-bm` holds nothing of this run's workspace or agents (searched by id).
- **The isolated daemon** was stopped by its supervisor pid (15161), after its status reported the run's home and `127.0.0.1:6943`; never with `paseo daemon stop` or `restart`. Its daemon (15162) exited with it, and nothing listened on 6943 afterwards. Its 4 agents (1 Orchestrator, 1 Manager, 2 Workers) died with it; none was archived or deleted.
- **The repository** did not change except for this note: the `plugin/` tree hash was the same before and after. No `npx`, `npm install`, publish, commit or push was run.
- **Kept:** the run folder, the patched copy and the fixture repository stay in the session scratchpad and go with it.
