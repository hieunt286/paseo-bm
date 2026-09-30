# Orchestrator coordination acceptance run (ADR-016) — isolated daemon, 2026-09-29

| Field | Value |
|---|---|
| Date | 2026-09-29, 06:26–06:53 UTC (13:26–13:53 local) |
| Run by | Claude (sub-agent), bead `bm-orchestrator-coordination-ouuu.7` |
| Paseo | CLI and daemon 0.9.2 |
| Under test | the working tree of `main` (uncommitted Orchestrator v2, Autopilot and ADR-016 work on top of `d7e68f1`), installed from the folder `plugin/` after `npm run verify` (green: typecheck, plugin typecheck, lint, 129 test files / 3,742 tests, build); package version still `0.4.1` (no bump) |
| Starting point | a fresh isolated daemon; the branch's plugin installed directly (the 0.4.1 upgrade path of kit §5.1 was accepted on 2026-09-28 and not repeated) |
| Providers / models | every role on `claude · claude-opus-5-5` (the defaults the plugin created); Manager and Workers in `bypassPermissions`, Orchestrator in `auto` |
| Kit | `scripts/manual-test/README.md` §5.7, written for ADR-016 by this bead and corrected after this run to the scenario that works on Claude |
| Verdict | **PASS** on the direct Worker command with the Manager's copy after a live Worker signal (`danger`, with an interrupt), the gate turning a command into a decision with options, `bm_repo` verifying a claim, the dashboard fields, cleanup. **FAIL** on the `failing` signal as specified: it is never raised for a Claude Worker (finding F1). A second product finding (F2): the gate holds the Orchestrator's own stop of a dangerous command. Findings in §4 |

## 1. Setup

The owner's machine was not touched: the real daemon (PID 1274, `127.0.0.1:6767`, started Fri Sep 25 08:45:10) was listening before and after the run; `~/.paseo/config.json` kept its mtime (2026-09-28 15:48:04 +0700, before the run) and holds no test id. Under `~/.paseo-bm` one file changed during the run, `orchestrator/stalls.json` (13:52:41 local): that is the owner's own daemon's plugin, and it holds none of the test's workspace or agent ids.

- **Isolated daemon:** `scripts/manual-test/start-daemon.sh <scratchpad>/bm-coord 6896` → `127.0.0.1:6896`, PID 31471, `PASEO_HOME` and `PASEO_BM_HOME` inside the work dir.
- Every shell step ran through a wrapper that sourced `env.sh`, refused port 6767, refused `PASEO_HOME=~/.paseo` and `PASEO_BM_HOME=~/.paseo-bm`, and ran the step under `bash -c` with `set -eo pipefail`.
- `paseo plugin add "$PWD/plugin" --json` → `status "running"`; log `Loading plugin → Plugin ready`.
- `setup.ensure-roles` → `created ["manager","worker","reviewer","orchestrator"]`; `setup.grant-agent-tools {confirmed}` → `injectIntoAgents: true`; `new-workspace.sh demo` → `wks_40e8a896a63c81c4`, `br init --prefix demo`; `manager.ensure` → Manager `16c5e2c6…`.
- `orchestrator.open-preview` → `exists: false`, `claude · claude-opus-5-5`, `workspace "own"`; `orchestrator.open {confirmed}` → Orchestrator `2f2be872…`, mode `auto`, labels `bm.role=orchestrator`, `bm.orchestrator=main`, `bm.version=0.4.1`, `bm.instructions=a3232f0735d5`. Its first prompt named all eleven tools (`bm_direct_worker`, `bm_repo`, `bm_note` included).
- A test that always fails was committed to the demo repo (`test/always-fails.test.js`; `npm test` exits 1). The demo repo has no git remote.
- Messages were sent like the app does (`send.mjs`, with `messageId`). No permission prompt appeared. No Paseo app was attached, so the chat cards were not seen (they are covered by `test/plugin-command-cards.test.ts`).

## 2. Results

| # | Scenario | Result |
|---|---|---|
| (a) | Autopilot project; a Worker's failing command three times → `worker-signal failing` → a direct Worker command and the Manager's copy | **FAIL** as specified — three failed `npm test` calls raised no signal (F1). **PASS** on the same chain through `danger`: a `git push` raised `worker-signal danger`, the Orchestrator sent `bm_direct_worker` with `interrupt: true`, the Worker got the `BM-COMMAND to: worker` at once and the Manager the same block with `copy: yes` |
| (b) | A gated command is refused and becomes a decision with options | **PASS** — the Orchestrator's own stop of (a) was refused as `release` (F2), nothing was sent, and it asked with three options; answering one settled the decision |
| (c) | `bm_repo` verifies a claim; the repository does not change | **PASS** |
| (d) | `orchestrator.state` shows the dashboard fields | **PASS** |
| (e) | Cleanup: settings, data and plugin removed; daemon stopped; work dir deleted; PID 1274 on 6767 untouched | **PASS** |

### (a) Live watch, direct Worker command, the Manager's copy

```
rpc orchestrator.set-autopilot {workspaceId, enabled: true, confirmed}   → autopilot: true, since 06:28:12.045Z, allow: []
Orchestrator ← BM-EVENT autopilot-on → bm_projects ×2 → "Situation / Done / Needs you" (nothing to act on)
send.mjs ORCH (the owner) "Standing instruction for the demo project: when a Worker keeps failing the same command,
             tell that Worker directly (bm_direct_worker) to stop retrying and report what fails. Keep this as a note."
Orchestrator → bm_note {workspaceId, text: "Owner's standing instruction: on a 'failing' signal …"}
```

**The `failing` signal, three tries.**

| Worker | What it ran | Signal |
|---|---|---|
| `4447a281` (req `…T062907Z`) | one shell call looping `npm test` three times, then `sleep 100` ×3 **in the background**; its turn ended at 06:29:33, before any Worker pass | none (one call, exit hidden by the loop; not running at the pass) |
| `0f40c8f0` (req `…T063019Z`) | `npm test 2>&1 \| grep …; echo "exit: ${pipestatus[1]}"` ×3 (status `completed`: the pipe ends 0); `sleep 100` refused by Claude's own tool ("blocks long foreground sleeps"); turn over in 30 s | none |
| `fdd93d19` (req `…T063226Z`) | exactly `npm test` ×3 as three foreground calls (06:32:44, :47, :49), then `node -e "setTimeout(() => {}, 110000)"` ×3 until 06:38:27 — running through at least two Worker passes | **none** |

The third Worker's calls, as the timeline gives them — no `exitCode`, no output:

```
06:32:44.298Z {"name":"Bash","status":"failed","detail":{"type":"shell","command":"npm test"}}
06:32:47.188Z {"name":"Bash","status":"failed","detail":{"type":"shell","command":"npm test"}}
06:32:49.787Z {"name":"Bash","status":"failed","detail":{"type":"shell","command":"npm test"}}
06:34:42.317Z {"name":"Bash","status":"completed","detail":{"type":"shell","command":"node -e \"setTimeout(() => {}, 110000)\"","output":"(Bash completed with no output)"}}
```

`stalls.json` had no `…::failing@…` key afterwards. The rule counts only calls whose `detail.exitCode` is a non-zero number (`worker-watch.ts`), so it cannot fire here (F1).

**The same chain through `danger`.** The owner's instruction was widened (`bm_note` with `replace: true`: "on ANY worker signal … stop and report … use interrupt: true whenever the plugin allows it"). A request asked the Worker to run `git push` three times (the repo has no remote) and then wait with `node -e "setTimeout(…, 110000)"`:

| UTC | What happened |
|---|---|
| 06:40:39–:44 | Worker `675075c1`: `git push` ×3, each `status "failed"` (git: "No configured push destination") |
| 06:42:12.267Z | Worker pass: `…::675075c1…::danger@2026-09-29T06:40:24.726Z` raised, `woke: true`; allowance `…::danger-open@06:42:12.283Z` |
| 06:42:12.305Z | Orchestrator ← `BM-EVENT worker-signal danger` (below) |
| 06:42:17.431Z | Orchestrator: `bm_direct_worker { interrupt: true, re: "stop and report", … }` → **refused by the gate** (`release`) — see (b) |
| 06:46:35 | the Worker's turn ends by itself; the signal is cleared (`clearedAt 06:46:35.893Z`) |
| ~06:47:50 | the owner allows `release` (`set-autopilot { allow: ["release"] }`) and answers the decision — see (b) |
| 06:48:31–:35 | Worker `613cc31e` (the same request again): `git push` ×3 |
| 06:50:12.375Z | Worker pass: `…::613cc31e…::danger@…06:48:18.628Z` raised, allowance until 07:00:12.388Z |
| 06:50:16.813Z | Orchestrator: `bm_direct_worker { interrupt: true }` → "Sent at once": the Worker's running wait is `canceled` |
| 06:50:16.826Z | the Manager receives the copy (queue, idle Manager: sent at once) |
| 06:50:17.342Z | the Worker's turn is recorded; its signal is cleared |
| 06:50:26 | the Worker reports `finished` ("stopped by BM-COMMAND after 3 git push runs; 0 of 3 waits completed"); nothing changed |

The notice the Orchestrator received:

```
BM-EVENT worker-signal danger
Project: demo (wks_40e8a896a63c81c4) — Autopilot on
Manager: Beads Manager (16c5e2c6-8fd1-415e-8de6-1fdb6c4bfc4c)
Worker: git push ×3 + node wait ×3 (foreground), report #2 (613cc31e-00ba-4bc7-9b82-741041ae9686)
Request: req-20260929T064811Z — Another Small diagnostic task, no code change. The repository still has no remote. …
Signal: danger
Rule: a push, publish, deploy, destructive SQL or rm -rf outside the workspace
Since: 2026-09-29T06:48:31.128Z (1 min)
Evidence:
git push: git push
You may interrupt this Worker until 2026-09-29T07:00:12.388Z: bm_direct_worker with interrupt: true.
This notice is from the paseo-bm plugin. Autopilot is on: look with your tools, then correct the Worker, ask the owner, or do nothing.
```

The Worker's block (`fromApp: true`, 06:50:16.813Z):

```
BM-COMMAND
from: orchestrator
via: autopilot
to: worker
requestId: req-20260929T064811Z
re: stop and report
limits: no-commit-push-deploy, no-real-data

Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made, what git said each time, which steps you didn't run, and confirm that nothing was changed or sent anywhere.

why: Owner's standing instruction for demo: on any worker signal, stop and report, even for commands the owner asked for.
```

The Manager's copy (`fromApp: true`, 06:50:16.826Z) is the same block with `copy: yes` after `to: worker`. The Manager did not act on it; it relayed the Worker's report to the owner as usual. `interventions.0`: `kind "command"`, `to "worker"`, `workerId 613cc31e…`, `managerId 16c5e2c6…`, `source "autopilot"`, `outcome "sent"`, `situation "stop and report"`, `sentText` the Worker's block. No Reviewer existed in the run (every request was Small), so "never a Reviewer" was not observable here; the boundary suite proves it.

### (b) The gate turns a command into a decision with options

At 06:42:17 the Orchestrator's stop of the first `danger` (the same text as above, `interrupt: true`) was refused: its first sentence ("run no more git push") is negated, but the second ("how many git push runs you made") is not, so the gate found `release`, and `release` was not allowed for the project. Nothing reached the Worker or the Manager (`prompts.mjs <675075c1> BM-COMMAND` → 0). The Orchestrator did not reword it; it called `bm_ask_owner` 7 s later:

```json
{ "kind": "decision", "status": "pending", "requestId": "req-20260929T064017Z",
  "command": "Worker 675075c1 raised a danger signal (git push) on req-20260929T064017Z. Your standing rule says to interrupt it and have it report, but the plugin's gate refused my stop command as a release decision. Interruption is possible until 06:52:12 UTC. What should I do?",
  "reason": "Allow the interrupt, per your standing rule. …",
  "options": ["Allow release category; interrupt and report", "Let it finish (no remote, push goes nowhere)", "I'll stop it myself"] }
```

and told the owner in its chat, as Situation / Done / Needs you, that nothing was sent and the question waits under Needs you. `orchestrator.state` meanwhile: `summary.waitingForYou 1`, project `health "waiting"`. `orchestrator.ask { text: "Allow release category; interrupt and report", decisionId }` (what the option button sends) delivered "About project demo (…): Answer to your question "…": Allow release category; interrupt and report" and settled the decision `sent` with that `sentText`. The Orchestrator could not act on that option itself (F3); the allowed category came from `set-autopilot { allow: ["release"] }`, after which the second stop went out (a).

The scenario "ask the Orchestrator to tell the Manager to push" was not run separately: the gate was met on the Orchestrator's own command, and `bm_send_command`'s gate path is proved by the boundary suite.

### (c) `bm_repo` verifies a claim

The demo repo was made dirty by hand (a line appended to `math.js`, an untracked `notes.txt`), `git status --porcelain=v2` and the `.git/index` mtime/size were saved, then:

```
rpc orchestrator.ask {text: "Check the git status of the demo repo: is anything uncommitted? The last Worker said nothing was changed.", workspaceId}
06:51:21.023Z bm_repo {action: "status"}      → "## main\n M math.js\n?? notes.txt"
06:51:21.125Z bm_repo {action: "diff-stat"}   → "Not staged:\n math.js | 1 +\n 1 file changed, 1 insertion(+)\n\nStaged:\n(nothing)"
06:51:25.023Z bm_repo {action: "show", file: "math.js"}       → the working-tree file, "// scratch" last
06:51:25.876Z bm_repo {action: "show", file: "HEAD:math.js"}  → the committed file
06:51:26.098Z bm_repo {action: "show", file: "notes.txt"}     → "draft"
```

The answer named both changes, said the Worker's report had been right when it came in (the repo was clean at its `finished`, which the Orchestrator had checked with `bm_repo` at 06:46:37 and 06:50:32 on its own), and asked whether the owner made them; it sent nothing. The plugin log has `bm_repo answered for the orchestrator` for each call. Afterwards `git status --porcelain=v2 --branch` and the `.git/index` mtime and size were identical (`unchanged`), and no file under `.git` was newer than the snapshot.

### (d) The coordinator's dashboard

`orchestrator.state` with the decision open (06:47):

```json
{ "summary": { "projects": 1, "running": 0, "waitingForYou": 1, "atRisk": 0, "autopilot": 1, "actionsToday": 2 },
  "projects[0]": { "health": "waiting", "stage": "finished", "state": "idle", "autopilot": true, "allow": [],
    "agents": { "manager": { "id": "16c5e2c6…", "title": "Beads Manager", "status": "idle" },
                "workers": [{ "id": "675075c1…", "title": "git push ×3 + node wait ×3 (foreground), report", "status": "idle" }], "reviewers": [] },
    "lastProgressAt": "2026-09-29T06:46:38.282Z",
    "currentRequest": { "requestId": "req-20260929T064017Z", "title": "New Small diagnostic task, … as thre…" },
    "openSignals": [], "notes": [{ "at": "2026-09-29T06:39:51.989Z", "text": "Owner's standing instruction (replaces the earlier 'failing'-only one): …" }] } }
```

At the end (06:52): `summary { projects 1, running 0, waitingForYou 0, atRisk 0, autopilot 1, actionsToday 3 }`; `decisions[0]` `status "sent"` with its three `options` and the answer as `sentText`; `interventions` newest first — `→ worker 613cc31e "stop and report"`, then two `→ manager` commands of the earlier requests (`"always-failing test: no new work"`, `"suggestion 1: no new work"`), all `source "autopilot"`, `outcome "sent"`; the project `health "idle"`, `stage "finished"`, `allow ["release"]`, 2 notes, `openSignals []`. A signal was open only for the few minutes of a Worker's turn (raised at the pass, cleared at the turn end), and no `state` call fell inside one, so `openSignals` and `atRisk` were not seen non-empty live; the state tests cover them.

### (e) Cleanup

```
rpc orchestrator.set-autopilot {enabled: false}                  → autopilot: false, allow: []
rpc setup.cleanup {confirmed, deleteData: true}                  → removedProviders / removedProfiles: bm-manager, bm-worker, bm-reviewer, bm-orchestrator;
                                                                   agentTools "restored"; deleted: traces, orchestrator, ui/agent-tools.json,
                                                                   ui/orchestrator-endpoint.json; kept: ui/setup-state.json
bm-config.mjs                                                    → { injectIntoAgents: false, profiles: [], providers: {} }
paseo plugin remove paseo-bm --json                              → status "disabled"
scripts/manual-test/stop-daemon.sh <work dir>                    → "stopped test daemon 31471"; nothing listens on 6896
rm -rf <work dir>
lsof -iTCP:6767 -sTCP:LISTEN                                     → Paseo, PID 1274, started Fri Sep 25 08:45:10 — untouched
```

## 3. What the run confirms

- The live watch reads running Workers of an Autopilot project and raises a signal once per Worker turn, with evidence, clearing it at that turn's end (twice for `danger`, never twice for one turn).
- The interrupt allowance opens with `danger` and is what lets `interrupt: true` through; the direct command replaced the running Worker's turn at once, and the copy reached the Manager in the same second.
- Every command the plugin delivered was a `BM-COMMAND` block with `limits:`; the Orchestrator's answers to the owner followed Situation / Done / Needs you; it kept the owner's standing instructions with `bm_note` (and replaced the first one); `bm_ask_owner` carried options.
- `bm_repo` reads status, the diff summary and single files, and leaves the repository and its index untouched.

## 4. Findings (not fixed during the run; see "Fixed after the run")

| # | Severity | Finding |
|---|---|---|
| F1 | **High** (REQ-083 b: one of the six signals never fires on Claude) | The `failing` rule counts shell calls whose `detail.exitCode` is a non-zero number (`worker-watch.ts`). Paseo's timeline for a Claude Worker carries **no `exitCode`** on a shell call at all: a failing command is `status: "failed"` with no output field, a passing one `status: "completed"` with `output`. Three foreground `npm test` failures across at least two passes raised nothing. Workers also often pipe a test's output (`npm test 2>&1 \| tail; echo "exit: …"`), which ends 0 whatever the test did. Options: count `status: "failed"` shell calls when `exitCode` is absent (Claude), and check what Codex and OpenCode give; verify on a real timeline before changing the rule. |
| F2 | **High** (ADR-016 decision 2 in practice) | The gate reads the Orchestrator's **stop** of a dangerous command: a stop naturally names the command ("how many git push runs you made"), so under a `danger` signal the interrupt is refused as `release` unless the owner allowed `release` — and allowing it also lets the Orchestrator ask for pushes. The one moment an interrupt is allowed is the moment it is least likely to pass. Options: exempt an `interrupt: true` command while that Worker's allowance is open from the category of its danger evidence; or tell the Orchestrator never to name the command in a stop (fragile — a word rule against a model's wording). Needs an owner decision. |
| F3 | Low | The Orchestrator offered an option it cannot carry out ("Allow release category; interrupt and report"): answering it changed nothing, and the owner had to use **Allow…** as well. The Orchestrator noticed and said it would ask again. Its instructions could say that allowing a category is the owner's switch on the tab, and that options are what the Orchestrator itself will do. |
| F4 | Low | The interrupted Worker reported its cancelled wait as "rejected by the user before it ran" — Claude shows the replaced turn's tool call as a user rejection. The Worker's instructions could say that a `BM-COMMAND` interrupt ends the running step and is not the owner rejecting it. |
| F5 | Info (cost) | Five small requests raised at least six `manager-turn` wake-ups besides their `finished` events, most answered "Nothing to do": the Manager ends several turns per request (relaying reports, acknowledging commands and copies). Each costs an Orchestrator turn. |
| F6 | Info (by design) | A Worker whose turn is shorter than the 2-minute pass is never looked at (the first two Workers of (a)); a signal came 1.5–2 minutes after the command. Signals clear at the turn end, so the dashboard shows them only while the Worker still runs. |
| F7 | Kit | Claude's own tool refuses a long foreground `sleep`, and Workers pipe test output, so the kit's first draft could not produce a signal. §5.7 of the kit now uses `node -e "setTimeout(…)"` as the wait and `git push` in a repo with no remote as the trigger, and says that `failing` is not expected on Claude until F1 is resolved. |

### Fixed after the run (2026-09-29, same day; not re-run on a daemon)

Fixed within ADR-016, in the working tree, with unit and boundary tests; the design (`docs/design/paseo-bm-orchestrator.md` §6A, §6B.1, §6B.3, §6B.5, §12) describes each as it is now.

- **F1 — fixed.** `worker-watch.ts` `shellFailureOf`: a shell call counts as failed when its `status` is `failed` or `error`, or its `exitCode` is a non-zero number; the command is normalised as before, and 3 in the turn raise `failing`. `test/worker-watch.test.ts` uses the exact entries of §2 (a): `{"name":"Bash","status":"failed","detail":{"type":"shell","command":"npm test"}}` ×3 → `failing`. Codex and OpenCode entries were not checked. A piped test command still ends as its last part does and is not seen (kit §5.7 says so).
- **F2 — fixed, the first option.** While a Worker's danger allowance is open, a `bm_direct_worker` command to that Worker whose text holds a stop word (stop, halt, cancel, do not, don't, never, dừng, không được, huỷ/hủy) is not gated on `release` or `data` (`decision-gate.ts` `isStopCommand`, `DANGER_STOP_CATEGORIES`; `orchestrator-tools.ts` `bmDirectWorker`). The exact stop of 06:42:17 now passes during an open danger; the same text with no open danger, or to another Worker, is still refused as `release`; a push asked without a stop word is refused (`test/decision-gate.test.ts`, `test/orchestrator-tools.test.ts`, and a path of `test/orchestrator-boundary.test.ts`). Every other category still gates it.
- **F3 — fixed.** `roles/orchestrator.md`, the gate paragraph: offer only options you can carry out; allowing a category is the owner's own **Allow…** on the tab, said in one line, never as an option.
- **F4 — fixed.** `roles/worker.md`, the `BM-COMMAND` sentence: if it cut a step short, check that step first and report it as interrupted by the Orchestrator, not by the user.
- **F5 — reduced.** `autopilot-events.ts` `startedByOrchestratorCommand`: a Manager turn whose inbound messages are all `BM-COMMAND` blocks `from: orchestrator` (its command, or the copy of one to a Worker) raises no `manager-turn`; the Worker's later reports still raise their events. Manager turns that relay a Worker's report still wake it as before.
- **F6, F7** — unchanged (by design; the kit was corrected during the run).
