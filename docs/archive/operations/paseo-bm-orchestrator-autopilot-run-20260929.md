# Orchestrator Autopilot acceptance run (ADR-015) — isolated daemon, 2026-09-29

| Field | Value |
|---|---|
| Date | 2026-09-28, 18:49–18:56 UTC (2026-09-29 local) |
| Run by | Claude (sub-agent), bead `bm-orchestrator-autopilot-muzh.5` |
| Paseo | CLI and daemon 0.9.2 |
| Under test | the working tree of `main` (uncommitted Orchestrator v2 and Autopilot work on top of `d7e68f1`), installed from the folder `plugin/` after `npm run verify` (green: typecheck, plugin typecheck, lint, 125 test files / 3,412 tests, build); package version still `0.4.1` (no bump) |
| Starting point | a fresh isolated daemon; the branch's plugin installed directly (the 0.4.1 upgrade path of kit §5.1 was accepted on 2026-09-28 and not repeated) |
| Providers / models | every role on `claude · claude-opus-5-5` (the defaults the plugin created); Manager and Workers in `bypassPermissions`, Orchestrator in `auto` |
| Kit | `scripts/manual-test/README.md` §5, rewritten for ADR-015 by this bead; §5.3 and the first half of §5.4 run here |
| Verdict | **PASS** on (a) Autopilot answers a question and checks the finished step with no owner action, (b) Autopilot off → "Send it." in the Orchestrator's chat sends, (c) the state shows both, (d) cleanup. No blocking product bug; findings in §4 |

## 1. Setup

The owner's machine was not touched: the real daemon (PID 1274, `127.0.0.1:6767`, started Fri Sep 25 08:45:10) was listening before and after the run; `~/.paseo/config.json` kept its mtime (2026-09-28 15:48:04 +0700, before the run); `find ~/.paseo-bm -newermt '2026-09-29 01:49:00' -type f` found nothing, and neither test id appears under `~/.paseo-bm` or in `~/.paseo/config.json`.

- **Isolated daemon:** `scripts/manual-test/start-daemon.sh <scratchpad>/bm-autopilot 6897` → `127.0.0.1:6897`, PID 72466, `PASEO_HOME` and `PASEO_BM_HOME` inside the work dir.
- Every shell step ran through a wrapper that sourced `env.sh`, refused port 6767 and refused `PASEO_HOME=~/.paseo` (`bash` with `set -eo pipefail`).
- `paseo plugin add "$PWD/plugin" --json` → `status "running"`; log `Loading plugin → Plugin ready`.
- `setup.ensure-roles` → `created ["manager","worker","reviewer","orchestrator"]`; `setup.grant-agent-tools {confirmed}` → `injectIntoAgents: true`; `new-workspace.sh demo` → `wks_492448a5773b0c5d`, `br init --prefix demo`; `manager.ensure` → Manager `301ecbe6…` (`created: true`).
- `orchestrator.open-preview` → `exists: false`, `claude · claude-opus-5-5`, `workspace "own"`; `orchestrator.open {confirmed}` → Orchestrator `90c096d4…` (`created: true`), mode `auto`, labels `bm.role=orchestrator`, `bm.orchestrator=main`, `bm.version=0.4.1`.
- The Orchestrator's first prompt named all eight tools (`bm_projects`, `bm_request`, `bm_agent_messages`, `bm_propose_command`, `bm_send_command`, `bm_ask_owner`, `bm_set_autopilot`, `bm_assessment`); it answered one line and waited. Its home `README.md` carried the ADR-015 text (Autopilot, "send it" in chat, the limits).
- Messages were sent like the app does (`send.mjs`, with `messageId`). No permission prompt appeared.

## 2. Results

| # | Scenario | Result |
|---|---|---|
| (a) | Autopilot on: the Worker's question is answered by the Orchestrator with `bm_send_command`, the Manager gets it with the limit line once, the Worker finishes, `BM-EVENT finished` follows; no owner action | **PASS** |
| (b) | Autopilot off: no event; the Orchestrator proposes; the owner's "Send it." in its chat sends it (`source "chat"`) | **PASS** |
| (c) | `orchestrator.state` shows both commands, `lastAction`, no approval left | **PASS** |
| (d) | Cleanup: settings, data and plugin removed; daemon stopped; work dir deleted; PID 1274 on 6767 untouched | **PASS** |

### (a) Autopilot answers a question by itself

```
rpc orchestrator.set-autopilot {workspaceId, enabled: true}             → E_AUTOPILOT_NOT_CONFIRMED (no settings.json written)
rpc orchestrator.set-autopilot {workspaceId, enabled: true, confirmed}  → { autopilot: true, since: 18:50:48.246Z }
settings.json → { version: 3, watch: { enabled: false }, autopilot: { wks_492448a5773b0c5d: { enabled: true, since, by: "tab" } } }
send.mjs MGR "Add a subtract function to math.js. Before changing anything, the Worker must ask me one question …
              should the function be named subtract (option A) or sub (option B)? This is a Small change."   (18:50:49)
```

Timeline, all without any owner action after the send:

| UTC | What happened |
|---|---|
| 18:51:12 | Worker → Manager `BM-REPORT received`, tier Small |
| 18:51:17.893 | Worker → Manager `BM-REPORT blocked` + `BM-QUESTIONS` Q1 (a: subtract (recommended), b: sub) |
| 18:51:20.133 | Orchestrator receives `BM-EVENT question` — `Project: demo (wks_…) — Autopilot on`, the Manager, `Request: req-20260928T185055Z — …` (cut with `…`), `Report:` with Q1 and both options, `(recommended)` kept |
| 18:51:22 | Orchestrator: `bm_agent_messages` on the Manager (limit 10) |
| 18:51:28.130 | Orchestrator: `bm_send_command` — `"A1 a — name it subtract, to match the style of add(a, b). Go ahead with the change."`, reason "Autopilot: answered the naming question with the recommended option … a small naming choice, not a big decision." The Manager receives it with `fromApp: true`, ending with the limit line exactly once |
| 18:51:36 | Manager → Worker `Continue req-… BM-ANSWERS Q1: a` (after `bm_answers`) |
| 18:51:46.708 | Worker → Manager `BM-REPORT finished`, `filesChanged: math.js`, check by `node` passed |
| 18:51:49.879 | Orchestrator receives `BM-EVENT finished` — `Report: finished — build and tests: …; files changed: 1; blockers: none. Suggestion (not done): …` |
| 18:51:53 | Orchestrator: `bm_request`; tells the owner in its chat the request is done, nothing committed, and that it did **not** send the Worker's unrequested suggestion (a test file) |

The command as the Manager received it:

```
A1 a — name it subtract, to match the style of add(a, b). Go ahead with the change.

— Sent by the Beads Orchestrator for the owner. Do not commit, push or deploy, and do not touch real data (production databases, live services), unless the owner has said so.
```

`stalls.json` held two event keys, `…::question@2026-09-28T18:51:17.893Z` and `…::finished@2026-09-28T18:51:46.708Z`, both `woke: true`, `clearedAt: null`. `orchestrator.state`: `approvals: []`, `stalls: []`, project `state "idle"`, `autopilot: true`, `lastAction { at 18:51:28.139Z, source "autopilot", text <the command without the limit line> }`; `interventions.0` `source "autopilot"`, `status "sent"`, `outcome "sent"`, `sentText` with the limit line. The demo repo: `math.js` modified, **not committed** (`git log` still only `init`).

### (b) Autopilot off: "Send it." in the chat

```
rpc orchestrator.set-autopilot {workspaceId, enabled: false}   → { autopilot: false, since: null }; settings.json autopilot: {}
send.mjs MGR "Add a multiply function to math.js. … multiply (option A) or mul (option B)? This is a Small change."   (18:52:37)
```

- The Worker asked Q1 (`blocked` at 18:53:0x); the Manager showed it to the owner. `prompts.mjs ORCH BM-` stayed at **2** (the two events of (a)): no event for a project without Autopilot, and the watch switch was off. `orchestrator.state` → the project `waiting-user`, `approvals: []`.
- `orchestrator.ask { text: "What is this project waiting for? Propose the answer, but do not send it yet.", workspaceId }` → the Orchestrator ran `bm_projects`, `bm_agent_messages`, then `bm_propose_command` once (18:53:49): one `pending` proposal `17206090…`, `source "orchestrator"`, `requestId req-20260928T185242Z`, command `"A1 a — name it multiply, to match add and subtract. Go ahead with the change."`. Nothing reached the Manager.
- `send.mjs ORCH "Send it."` (18:54:17, `fromApp: true` — the owner typing in the chat) → the Orchestrator called `bm_send_command` with the same command (18:54:20); the Manager received it with the limit line once (`fromApp: true`); the Worker finished at 18:54:36.

### (c) The state shows both

```
approvals: []   stalls: []
projects.0: { state "idle", autopilot false, requests 2, lastAction { at 18:54:20.795Z, source "chat", text "A1 a — name it multiply, …" } }
interventions:
  17206090… at 18:53:49.611Z settledAt 18:54:20.795Z source "chat"      status "sent" outcome "sent" req-20260928T185242Z
  496d08c1… at 18:51:28.139Z settledAt 18:51:28.139Z source "autopilot" status "sent" outcome "sent" req-20260928T185055Z
```

The chat send settled the pending proposal instead of adding a second entry (one Activity line). The Orchestrator's inbound messages, in order: the first prompt (`fromApp: false`), `BM-EVENT question`, `BM-EVENT finished`, the `ask` text, "Send it." — nothing else. The two Workers' timelines hold only the Manager's messages (`fromApp: false`): nothing reached a Worker or a Reviewer from the Orchestrator or the plugin. The plugin log shows exactly the tool calls above (`bm_agent_messages`, `bm_send_command`, `bm_request`, `bm_projects`, `bm_agent_messages`, `bm_propose_command`, `bm_send_command`, each "answered for the orchestrator").

### (d) Cleanup

```
rpc setup.cleanup {confirmed, deleteData: true} → removedProviders/Profiles: the four bm-* ids; agentTools "restored";
                                                  data.deleted [traces, orchestrator, ui/agent-tools.json, ui/qa-ledger.json]; kept ui/setup-state.json
bm-config.mjs → injectIntoAgents false, profiles [], providers {}
paseo plugin remove paseo-bm --json → status "disabled"
scripts/manual-test/stop-daemon.sh <work dir> → stopped test daemon 72466; port 6897 closed within 30 s; no process left
rm -rf <work dir>
```

PID 1274 still listening on `127.0.0.1:6767` afterwards.

## 3. Not run here

- Kit §5.1 (upgrade from 0.4.1), §5.5 (the real 15-minute stall), §5.6 (Assess workflow) and the second half of §5.4 (Send on the tab, a typed command): unchanged by ADR-015 apart from wording, accepted on 2026-09-28 (`paseo-bm-orchestrator-agent-run-20260928.md`), and covered by `test/orchestrator-boundary.test.ts`, `test/orchestrator-actions.test.ts` and `test/stall-watcher.test.ts`.
- `bm_ask_owner` (a big decision) and `bm_set_autopilot` from the chat were not provoked on the daemon; both are covered by `test/orchestrator-tools.test.ts` and the boundary suite.

## 4. Findings

### Product (new work in its own lane; not fixed here)

1. **The Orchestrator told the owner only half of the approval rule.** After proposing in (b) it said "It goes to the Manager only when you press Send on the Orchestrator tab." — yet ADR-015 decision 3 makes "send it" in its chat enough, and it did send on "Send it." a minute later. Both sources it read name only the tab: `bm_propose_command` answers with `PROPOSED_SENTENCE` = "Proposed. It is sent only if the user approves it on the Orchestrator tab." (`plugin/server/orchestrator-tools.ts:86`, design §5.3), and `plugin/roles/orchestrator.md:41` describes the tool as "a command the owner sends from the Orchestrator tab". Owner-visible, harmless, misleading.
2. **The Manager comments on the limit line to the owner.** On receiving the Autopilot command it replied "I only sent the answer, not the Orchestrator's note about not committing, pushing or deploying. The Worker already commits only when you ask." The behaviour is right (the line binds the Manager; the Worker keeps its own limits), but the line is noise in the owner's Manager chat; `roles/manager.md` could say to act on it silently.
3. **`BM-EVENT finished` keeps `blockers: none`.** Design §6A says the `Report:` line leaves empty fields out; the Worker writes `none`, which is not empty, so `…; blockers: none. Suggestion (not done): …` appears. Harmless; the Worker's suggestion was useful to the Orchestrator here.

### Observations

- The question-to-answer latency on Autopilot was **~10 s** (report 18:51:17.9 → command 18:51:28.1), and the whole Autopilot request took under a minute; each event cost one Orchestrator turn, as ADR-015 says.
- On `BM-EVENT finished` the Orchestrator correctly did not turn the Worker's unrequested suggestion into work, and reported "nothing committed" — the limits held without being tested by an adversarial request.
- The Worker saw the uncommitted `subtract` change of (a) during (b) and said it would leave it alone.
- `orchestrator.ask` text counts as the owner's word for the chat check (it is typed by the owner on the tab and carries `clientMessageId`); the kit's §5.4 therefore tells the Orchestrator "do not send it yet" when it only wants a proposal.

## 5. Tokens

Two small requests (Manager, two Workers, no Reviewer) and five Orchestrator turns (first prompt, two events, one ask, one "Send it."), all on `claude-opus-5-5`.
