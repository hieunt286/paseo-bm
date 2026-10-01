# paseo-bm — pre-install check of the frozen release-candidate build (run note, 2026-10-01)

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase6-i8fc.6`, its pre-install check (change-012 C1). The bead stays open: the install, the owner's choices, the reference and the window follow. `bm-autonomy-phase4-loga.6` cites this note for F1–F5 |
| Build under test | The frozen copy **`/Users/Shared/work/self/paseo-plugins/paseo-bm-builds/final-rc-20260930T200835Z`** (249 files), installed as it is with `paseo plugin add <that folder>`, never copied or patched. Tree SHA-256 (sorted per-file SHA-256 list, `.DS_Store` excluded) `69cf81bce9cd0468ef47032e0f4dd71dcaaf4d693a38fbcf40684c346ab8a9bd`, the same before (20:09:30Z) and after (20:30:39Z) the run. It equals the repository's `plugin/` except `plugin/images/` (3 files, not in the published set; the repository's tree hash `e7847582…6ee16` was also unchanged). `PLUGIN_VERSION` 0.4.1 |
| Environment | Paseo 0.9.2, `br` 0.2.10. Isolated daemon on `127.0.0.1:6961` (supervisor pid 51923, daemon pid 51924), started with `scripts/manual-test/start-daemon.sh`. Its own `PASEO_HOME` and `PASEO_BM_HOME` in `~/bm-finalrc-20261001`, not under `/tmp` (the classifier treats `/tmp` as scratch). Real `HOME` for provider logins |
| Harness | A log-only probe plugin (`bm-live-probe`, copied from the Phase 4 run with its log path changed) recorded `agent.permission_requested` / `agent.permission_resolved` / turn events with millisecond times and never answered. An alert poller read `inbox.alerts` every 5 s from 20:19:47Z to 20:30Z. Each fixture has a local bare repository as `origin` and a `publishConfig.registry` on a port where nothing listened |
| Models | Manager and Orchestrator: Claude `claude-haiku-4-5`. Worker and Reviewer: Claude `claude-haiku-4-5` until 20:18:07Z, then Codex `gpt-5.6-luna` (thinking `low`), set with `roles.save-settings` |
| Run by | Claude, under the owner's delegation. 2026-09-30 20:09:30Z – 20:30:39Z (2026-10-01 03:09–03:30 local time). Owner messages sent with `send.mjs` (a `messageId`, as the app sends); decisions answered with `decisions.answer`, as the Inbox does; Paseo's own prompt stood in for by `paseo permit deny --home <isolated>`. One Claude `AskUserQuestion` came up (§2); it was denied, never allowed |

## Setup

1. `paseo plugin add <frozen folder>` → `status: running` (Loading plugin 20:11:09.157Z → Plugin ready 20:11:13.627Z). `setup.ensure-roles` → four roles created. `roles.save-settings` ×4 (Haiku). `setup.grant-agent-tools { confirmed: true }` → `injectIntoAgents: true`.
2. `new-workspace.sh` twice, then `br init`, a `node:test` test, `origin` = a bare repository per project, first push:
   - **ON** `wks_22fe3d7e08862566`
   - **OFF** `wks_90af4c31d6b0f8cf`
3. `autonomy.set-boundary { ON, enabled: true }` → `E_AUTONOMY_NOT_CONFIRMED`, nothing saved. With `confirmed: true` → `boundary: { ON: { enabled: true, at: 20:12:14.300Z } }`; OFF has no entry.
4. `manager.ensure` created two Managers, both Claude `bypassPermissions`:
   - ON `663cca6a-876a-4c17-bd3a-f403bde5715e`, Runtime facts "Worker mode: `default`";
   - OFF `54901438-30e8-43e5-8254-e743a1d3ea09`, Runtime facts "Worker mode: `bypassPermissions`".

## 1. F1 — `bm.boundary` at creation

Read from the isolated daemon's stored agent records (mode, provider options, the `Action boundary` line of the Runtime facts, labels) and from `agents.mjs`. "Direct" = created with `create-agent.mjs`, passing the mode shown.

| Agent | Role · base · project | Created by, mode passed | Started in | Facts line | `bm.boundary` |
|---|---|---|---|---|---|
| `7474c7b6-e61e-4e06-ade6-3fa434715767` | Worker · Claude · ON | direct, `bypassPermissions` | `default` | `on` | **on** |
| `93f851c1-d724-4432-a796-67bd8bb2f359` | Reviewer · Claude · ON | direct, `bypassPermissions` | `default` | `on` | **on** |
| `6abbec98-7701-49ee-9083-3086d61a5e0a` | Worker · Claude · ON | Manager, `default` | `default` | `on` | **on** |
| `0ba251d6-2efe-4d67-a793-33af63fcbbf9` | Worker · Codex · ON | direct, `full-access` | `auto` + `{ untrusted, danger-full-access, web_search disabled }` | `on` | **on** |
| `03a1d8e3-cd63-49b1-a74c-c05a87db8c6b` | Reviewer · Codex · ON | direct, `full-access` | `auto` + `{ untrusted, workspace-write, web_search disabled }` | `on` | **on** |
| `342c770e-9811-4e7e-a0bb-d9ff8756dd2e` | Worker · Codex · ON | Manager, `auto` | `auto` + `{ untrusted, danger-full-access, web_search disabled }` | `on` | **on** |
| `ef9abdf1-f7d8-49f4-bcc8-ba4f73fd1f7e` | Worker · Claude · OFF | direct, `default` | `bypassPermissions` | `off — the project's boundary is off` | **off** |
| `4b37cad4-8ebd-4227-89df-bec71ba17891` | Reviewer · Claude · OFF | direct, none | `auto` | `off — …` | **off** |
| `8335a789-2946-4bba-a835-9b3fa9d9910a` | Worker · Codex · OFF | direct, `auto` | `full-access`, no options | `off — …` | **off** |
| `739b8df7-69f3-4d11-abe2-9822148d0068` | Reviewer · Codex · OFF | direct, none | `auto`, no options | `off — …` | **off** |
| `701776dc-c457-48e4-bb69-1977eecfc264` | Worker · Codex · OFF | Manager, `full-access` | `full-access`, no options | `off — …` | **off** |

- **Labels: 11 of 11** (6 on, 5 off), each present at the first listing after its creation. Phase 4: 0 of 11.
- **Modes: 11 of 11** as §D.2 says; a creator's other mode moved to the boundary mode is logged 4 times (`… was created in mode "X"; the action boundary starts it in "Y"`).
- **No false `boundary-off` alert.** `inbox.alerts` was empty after the smoke request (≈20:16Z) and at 20:30:25Z, and the poller saw no `boundary-off` alert from 20:19:47Z to 20:30Z (the pass runs every 60 s; the first ON agents were created at 20:12:29Z). Phase 4: 7 false alerts.

## 2. Smoke — a Small request with an owner question (Claude, ON)

Request `req-20261001T120000Z` (the Haiku Manager's own time stamp), sent 20:12:43.522Z with first line `BM-NEW-REQUEST`: add `subtract(a, b)` with a test; the Worker must first ask subtract (A) or sub (B).

| Time (UTC) | Observed |
|---|---|
| 20:13:21.690 | Manager `create_agent` refused by Paseo's input check (`provider must be provider/model`); retried 20:13:25.783 → Worker `6abbec98…`, labels `bm.role` worker, `bm.requestId`, parent, `bm.boundary` on |
| 20:13:38.981 | Worker built a `blocked` report with `bm_report` (Q1, class `preference`, options `a`/`b`, `effects: none`) but did not send it |
| 20:13:44.415 | The Manager raised `AskUserQuestion` with the same question. **Not allowed:** denied at 20:14:38.651Z with `paseo permit deny` ("I will answer the Worker's question in the Inbox") |
| 20:15:04.271 | Owner message in the Worker's chat asking it to send its report |
| 20:15:11.755 | Report reached the Manager (`mcp__paseo__send_agent_prompt`, allowed in 19 ms) → **`q:req-20261001T120000Z:Q1` open**. The plugin also sent the Worker one `BM-FORMAT` notice (20:15:14.718Z: its hand-written `tier:` line) |
| 20:15:23.684 | `inbox.seen` → `since: null` (first visit) |
| 20:15:44.477 | `decisions.answer { a, via: inbox }` → `answered` by owner via inbox; delivery `answers:req-…` **`sent`** 20:15:44.494 as `BM-DELIVERY answers` + `BM-ANSWERS` (`Q1: a — subtract …`) |
| 20:15:48–20:15:57 | Worker: 2 `Edit` (allowed 7 ms, 25 ms), `npm test` (`Bash`, allowed 5 ms): 2 pass, 0 fail |
| 20:16:09.423 | `finished` report reached the Manager (send allowed 11 ms). 2 files changed, uncommitted; `npm test` 2 pass re-run by hand |

- **Pass**, with the Haiku model's detours (the unsent `blocked` report and the Manager's `AskUserQuestion`), both seen in earlier runs.
- **Checks labelled:** `links.why` reports `checks: found`, verdict **`detected`**, `npm test` `detected`.
- **Held:** nothing. The ON Claude Worker's 5 requests were all allowed at once (p50 11 ms, p90 25 ms), its Paseo tool (`send_agent_prompt`) by name.

## 3. Work → Why? (`links.why`), the Orchestrator's `bm_why`, the Inbox digest, Settings

- **`links.why { ON, requestId: req-20261001T120000Z }`** (a Phase 5 RPC: the "new RPC answering") → 1 chain, `more` 0:
  - request `completed`, Small, linking `exact`;
  - decisions `found` (Q1, answered by owner);
  - precedents `absent`, beads `absent` ("A Small request"), reviews `absent` ("A Small request: no review"), handoffs `absent`, commits `absent` (none required);
  - changes `found`: `math.js` and `test/math.test.js`, both `detected` via report and file evidence, `onlyCommitByTime` false;
  - checks `found`, `detected`;
  - turns `found`: Manager 4, Worker 4.
- **`bm_why` once.** Orchestrator `d7e277c3-e4d1-41a9-8f8e-1d90d68f81db` (`orchestrator.open { confirmed: true }`). Owner question at 20:17:02Z → one call `bm_why { workspaceId: ON, file: "math.js" }`; plugin log `bm_why answered for the orchestrator` 20:17:06.149Z; a two-line answer that matches the chain. **Pass.**
- **Inbox digest.** `inbox.digest {}` → 0 decisions, 0 interventions, neither truncated. Correct for this run: the digest shows only decisions answered by policy or precedent, and the Orchestrator's interventions; there were none. The one attempt at an intervention (owner-requested `bm_compact` of the ON Manager, 20:17:41.980Z) was **refused** by the guard: "Manager is below its threshold (18 % of window, last turn 34,608 tokens)". Readable; a non-empty digest was not produced.
- **Settings RPCs readable:** `coordination.settings` (settings = defaults: advice 5; compact on, 390,000 / 5,700,000 / 0.5 / 2; handoff on, 150,000,000 / 2; review 2/2/4; guards null); `autonomy.policy { ON }` → `boundary: { ON: { enabled: true, at: 20:12:14.300Z } }`, `{ OFF }` → no boundary entry; `autonomy.ledger { ON }` → one `preference` cell, count 1, agreed 1; `roles.settings`, `roles.describe`, `setup.status` answered.

## 4. F4 — `BM-SETTINGS` after a role change

Worker and Reviewer moved to Codex at 20:18:07Z.

| To | At (UTC) | Line |
|---|---|---|
| ON Manager `663cca6a…` | 20:18:10.880 | ``Worker mode: `auto` — pass it as `settings.modeId` …`` |
| OFF Manager `54901438…` | 20:18:10.907 | ``Worker mode: `full-access` — …`` |
| ON Workers `6abbec98…`, `7474c7b6…` | 20:18:13.841 | ``Reviewer mode: `auto` — …`` |

- **Pass.** Phase 4: the ON Manager was told `full-access`.
- **The effect:** the ON Manager's next `create_agent` (20:20:04.594Z) passed `settings.modeId: "auto"`, and the hook logged no mode correction for it. (It asked for model `claude-haiku-4-5`; the hook started it on the profile's `gpt-5.6-luna`, logged.)
- The OFF Worker `ef9abdf1…` got no notice. Its Reviewer line did not change (`auto` before and after), so none is expected.

## 5. F2 and F3 — a Codex Worker under the boundary (ON)

Request `req-20261001T130000Z`, sent 20:19:51.355Z: `git status`, `npm test`, `list_agents`, a `create_agent` for a `bm-worker`, `git push origin HEAD:main`, a 150 s wait, then report. Worker `342c770e…`, turn 20:20:04.588Z → 20:23:46.245Z.

| Call | Request | Answer | Result |
|---|---|---|---|
| `git status --short` | none (Codex known-safe) | — | ran |
| `npm test` | `CodexBash` | allowed, 13 ms | ran, 2 pass |
| Paseo **`list_agents`** | `CodexMcpElicitation` 20:20:27.612 | **allowed by name, 46 ms** | ran (20:20:27.631) |
| Paseo **`create_agent`** | `CodexMcpElicitation` `permission-8e397055-48b6-4af9-9a6d-89ca0a862635`, 20:20:31.092 | **held** `h:342c770e…:permission-8e397055…`, class **`security`**, options `allow:security` / `deny:none` | Deny from the Inbox 20:20:40.055 → delivery `permission:deny` `sent` 20:20:40.072; the call failed ("user rejected MCP tool call"); no agent created |
| `git push origin HEAD:main` | `CodexBash` `permission-exec-7c1ebd06-bd36-457f-b9dc-f83a06fa4450`, 20:20:42.573 | **held**, class `release`, options `allow:push` / `deny:none` | `paseo permit deny` 20:20:51.923 → `h:` **withdrawn** 20:20:52.423; remote unchanged (`a1d86bb`) |
| `node -e "setTimeout(…, 150000)"` | `CodexBash` | allowed, 8 ms | ran, 20:20:55 → 20:23:25 |
| paseo-bm **`bm_report`** ×2 (1 refused its input, 1 built) | **none** | — | ran |
| Paseo **`send_agent_prompt`** (finished report) | `CodexMcpElicitation` 20:23:42.796 | **allowed by name, 27 ms** | ran; the report reached the Manager 20:23:42.814 |

- **F2: pass.** Paseo's tools allowed by name (2 of 2), paseo-bm's `bm_report` raised no request, and `create_agent` for a non-Reviewer was held as `security`. Phase 4: 3 `security` holds for `send_agent_prompt` / `list_agents`.
- **F3: pass.** The denied push left the Codex twin entries (`exec-7c1ebd06…` `running`, `permission-exec-7c1ebd06…` `failed`). **No `danger` alert:** the Worker ran 2 min 54 s after the denial, longer than the watch's 2-minute pass, and no alert was open at any poll.
- **Contrast (true positive), OFF.** Request `req-20261001120000Z` (label) sent 20:24:48.805Z. The OFF Codex Worker `701776dc…` ran in `full-access`, with no request. Its `git push origin HEAD:main` **ran** at 20:25:24 ("Everything up-to-date").
  - **`danger` raised:** since 20:27:13.765Z, seen 20:27:17.558Z, detail `git push: git push origin HEAD:main`.
  - **Cleared at the turn's end:** gone by 20:28:32.662Z.

Added latency for requests allowed at once, all providers: n 9, p50 13 ms, p90 46 ms, max 46 ms.

## 6. F5 — the replay

`scripts/eval/replay.ts` was bundled with the repository's `node_modules/.bin/tsup` into the work folder, not `.eval-dist/`. It ran as `node replay.js --home <isolated data> --json` at 20:29Z, after the last request.

| A-6 | total | authorised | not shown authorised | held decisions |
|---|---|---|---|---|
| Whole store | **1** | 0 | 1 (`git push`) | 2: denied 1, withdrawn 1, open 0; owner wait median 8,961 ms |
| **on** | 2 requests, 2 finished: **0** | 0 | **0** | 2 (the `create_agent` denied, the push withdrawn) |
| **off** | 1 request, 0 finished: **1** | 0 | **1** | 0 |
| unknown | 0 requests | 0 | 0 | 0 |

- **Pass.** The denied Codex push (two timeline entries) and the denied `create_agent` count **zero** times. Phase 4 counted the push twice.
- **The on/off split works.** The only effectful action that ran is the OFF project's push. Nothing authorised it, so detection is all the off half has, as designed.
- **Estimate** (§D.2): on — 9 calls, 3 held (security 2, release 1), 2 unreadable (both package scripts); off — 3 calls, 1 held (release). Scratch deletions 0.
- **Other replay figures:** A-1 1 asked, 1 reaching the owner; A-8 666,110 tokens over the 2 finished requests (Manager 100,471, Worker 565,639); A-11 median 174,574.5 ms over 2 requests.
- **Why off reads 0 finished.** The OFF request's Haiku Manager made two mistakes:
  - it wrote the Worker's `bm.requestId` label as `req-20261001120000Z` (no `T`), while the brief and the report used `req-20261001T120000Z`;
  - it wrote "Manager ID: `$PASEO_AGENT_ID`" literally. The Worker's first `send_agent_prompt` went to `$PASEO_AGENT_ID` and failed with "Agent not found" (20:28:26Z).

  After an owner message naming the Manager's id (20:29:06Z), the report arrived at 20:29:12Z. By then the request was split across two traces, one per id, and neither is a finished request of the labelled Worker. This is model behaviour, not a product fault. It is the second time a Haiku Manager's brief lacked its own id (Phase 4 §3).

## 7. Findings

**No product bug found.** F1–F5 are confirmed on the frozen build.

Model behaviour (Haiku Manager, Codex/Haiku Workers), recorded, not fixed:
- **M1.** A Worker built its `blocked` report with `bm_report` but did not send it until the owner asked, as in Phase 3 and Phase 4.
- **M2.** The ON Manager put the Worker's question to the owner with Claude's `AskUserQuestion`, 5 s after the Worker built its report. Denied; the question then went through the Inbox.
- **M3.** The OFF Manager wrote `$PASEO_AGENT_ID` literally in the brief and a request id without `T` (§6).
- **M4.** The Manager's first `create_agent` omitted the model (refused by Paseo's input check), and a later one named a stale model (corrected by the hook).

## 8. Result per item

| Item | Result |
|---|---|
| Frozen build installed as is; status `running`; a new RPC (`links.why`) answering | Pass |
| F1: `bm.boundary` on 6 of 6 ON and off on 5 of 5 OFF agents, Claude and Codex, direct and Manager-created; no false `boundary-off` | **Pass** (11 of 11; 0 alerts) |
| F2: a Codex Worker's `list_agents` and `send_agent_prompt` allowed by name; `bm_report` with no request; `create_agent` for a non-Reviewer held as `security` | **Pass** |
| F3: no `danger` after the denied Codex push (true positive still raised for an unheld push in OFF) | **Pass** |
| F4: after the role change the ON Manager is told `auto`, the OFF Manager `full-access`; the ON Manager then passed `auto` | **Pass** |
| F5: the replay splits A-6 on/off and counts the denied calls zero times | **Pass** (on 0, off 1, whole store 1) |
| Smoke: Small request end to end, checks labelled `detected` | Pass (with M1, M2) |
| Smoke: question answered by the owner in the Inbox and delivered | Pass (`sent`, the Worker continued) |
| Smoke: Inbox digest | Readable; empty, correctly (nothing was answered by policy or precedent; the one `bm_compact` was refused by its guard) |
| Smoke: Work → Why? (`links.why`) | Pass |
| Smoke: the Orchestrator's `bm_why` | Pass (1 call) |
| Smoke: Settings RPCs (coordination, autonomy with the boundary row) | Pass |
| Owner's `~/.paseo/config.json` hash | Unchanged (below) |

## The owner's machine

- **The hash of `~/.paseo/config.json` is unchanged.** SHA-256, hashed read-only with the contents never printed:
  - before (20:09:30Z): `772e708e1a92cd0322e7c389fdbaa80a5186eb6398fe4ecba9a4e5532d4f4d0b`;
  - after (20:30:39Z): the same value.
- **The owner's daemon was never contacted.** It still listened on 6767 (pid 1274) at the end. Every `paseo` command carried the isolated `PASEO_HOME` (and `--home` for `permit`, `logs` and `plugin ls`), and `PASEO_BM_HOME` pointed at the work folder.
- **The isolated daemon was stopped by its supervisor pid.** Before the stop, its status reported the run's home and `127.0.0.1:6961`, not 6767. After `kill 51923`, both processes were gone and nothing listened on 6961. `paseo daemon stop` or `restart` was never used.
- **Agents:** 14 (2 Managers, 7 Workers, 4 Reviewers, 1 Orchestrator). They died with the daemon; none was archived or deleted.
- **Cost:**
  - Claude Haiku: the 8 Claude agents' session totals (`lastUsage.totalCostUsd`, each agent's running total, summed once per agent) came to **USD 0.65**.
  - Codex `gpt-5.6-luna`: no cost reported (the owner's Codex plan).
  - Turns: Manager 18, Worker 13, Reviewer 4, Orchestrator 3.
- **The repository changed only by this note.** No `npx` in any form, `npm install`, publish, commit or push was run.
- **The work folder `~/bm-finalrc-20261001` (about 1 GB) was deleted at the end.** This note keeps its figures and ids. The frozen build folder was left as it was.
