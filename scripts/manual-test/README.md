# Testing paseo-bm by hand on an isolated Paseo daemon

These scripts start a **separate** Paseo daemon (its own home, its own port, its own paseo-bm data folder), install the plugin from the `plugin/` folder of the branch you have checked out, and let you call RPCs and send messages the way the app does. Your real daemon (`~/.paseo`, port 6767) and `~/.paseo-bm` are not touched; every Node script refuses to run without `BM_TEST_WS`, or when it points at port 6767.

This is how 0.4.0 was accepted (run record `docs/archive/operations/paseo-bm-install-run-20260926.md`), with one difference: here the plugin is installed **from a folder** (`paseo plugin add <repo>/plugin`) to test unpublished code; the install path from npm was accepted with the real package.

| Script | What it does |
|---|---|
| `start-daemon.sh <work-dir> [port]` | builds and starts the isolated daemon (default port 6899), writes `<work-dir>/env.sh` |
| `stop-daemon.sh <work-dir>` | stops exactly that daemon (checks its home and port before stopping it) |
| `new-workspace.sh <name>` | creates a small git repo under `<work-dir>`, registers a project + workspace, prints the `workspaceId` |
| `rpc.mjs <method> ['<json>']` | calls a plugin RPC the way the app does (`manager.ensure`, `setup.status`, …) |
| `send.mjs <agentId> "<text>"` | sends a message the way the user types it in the app |
| `agents.mjs` | lists agents: provider, running model, status, mode, labels |
| `create-agent.mjs …` | creates an agent directly, to see what the `before("agent.create")` hook does |
| `wait-idle.mjs [minutes]` | waits until no agent is running |
| `prompts.mjs <agentId> [prefix]` | lists the user messages of an agent's timeline (typed in the app or sent by an agent or the plugin); with a prefix, only those that start with it, and their count |
| `json.mjs <path>` | prints one value of the JSON on stdin (`traces.0.traceId`); fails instead of printing an empty value |
| `bm-config.mjs` | prints the `bm-*` providers and profiles and the agent-tools switch of the test daemon's `config.json`, sorted, for `diff` |
| `wait-stall.mjs <reason> [minutes]` | waits until the test daemon's stall pass has an open `request-stalled` alert for that reason (`idle-unfinished`, `review-over-budget`) in `inbox/alerts.json`, and prints it (section 5.5) |

## 0. Prepare

```bash
git fetch origin
git switch <branch>    # the branch whose plugin/ you want to test, e.g. main
npm install            # if node_modules is missing
npm run build          # regenerates plugin/server/*-instructions.ts and the version
npm run verify         # must be green
```

Needs: Paseo 0.9+ (the `paseo` CLI on PATH), Claude Code signed in; Codex signed in for section 2.3; `br` on PATH and network access to npmjs.org for section 5.

## 1. Start the daemon and install the branch's plugin

```bash
WORK=$HOME/bm-manual-test        # working folder, delete it afterwards
scripts/manual-test/start-daemon.sh "$WORK"
source "$WORK/env.sh"            # every shell you test from must source this file

paseo plugin add "$PWD/plugin" --json    # expected: "status": "running"
paseo plugin logs paseo-bm               # expected: Loading plugin → Plugin ready
WS_ID=$(scripts/manual-test/new-workspace.sh demo); echo "$WS_ID"
```

## 2. Scenarios

### 2.1 Fresh install: no Manager is created while the agent tools are off

```bash
node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}"
```
Expected — first time (the roles were just created): the error `E_PROVIDER_UNAVAILABLE: paseo-bm created its roles with defaults (claude · …). Change them in Setup → Agents. Paseo's agent tools are off, and a Beads Manager created now would never get them, …`

```bash
node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}"
node scripts/manual-test/agents.mjs
```
Expected — second time: only the agent-tools sentence is left (no roles sentence); `agents.mjs` prints `[]` (no agent was created).

```bash
node scripts/manual-test/rpc.mjs setup.grant-agent-tools '{}'                    # without confirmation → refused
node scripts/manual-test/rpc.mjs setup.grant-agent-tools '{"confirmed":true}'    # → injectIntoAgents: true
MGR=$(node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agentId))'); echo "$MGR"
```
Expected: the Manager is created (`created: true`).

`node scripts/manual-test/rpc.mjs setup.status` shows the whole machine state the Settings section displays (roles, agent tools, sign-in, skills, data folder).

### 2.2 One request end to end (uses provider tokens)

```bash
node scripts/manual-test/send.mjs "$MGR" "Add subtract, multiply and divide functions to math.js (divide throws when dividing by 0), with node:test unit tests in test/math.test.js. Treat this as Medium and have a Reviewer look at it."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/agents.mjs
paseo logs "$MGR"
(cd "$BM_TEST_WORK/demo" && git status --short && npm test)
```
Expected: a Manager, a Worker and a Reviewer; the Worker creates and closes beads; the tests in the `demo` repo pass; the Manager reports `finished` in the language you wrote in, and lists the choices the Worker made on its own. If an agent waits for a permission, `wait-idle.mjs` stops and says so.

### 2.3 Move the Worker to Codex: a stale model is corrected to the profile's

```bash
REV=$(node scripts/manual-test/rpc.mjs roles.settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).revision))')
node scripts/manual-test/rpc.mjs roles.options '{"provider":"codex"}'     # see which Codex models exist
node scripts/manual-test/rpc.mjs roles.save-settings "{\"revision\":\"$REV\",\"role\":\"worker\",\"baseProvider\":\"codex\",\"model\":\"gpt-5.6-sol\",\"thinkingOptionId\":null,\"modeId\":null}"

# Act as an old Manager that still remembers the Claude model, with a Claude thinking level:
AGENT=$(node scripts/manual-test/create-agent.mjs bm-worker claude-opus-5-5 max full-access "$BM_TEST_WORK/demo" "$WS_ID" "Reply with the single word OK. Do not run any tool.")
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/agents.mjs        # agent "manual create-agent check": model gpt-5.6-sol
paseo inspect "$AGENT"                    # Thinking is Codex's level, not "max"
paseo logs "$AGENT"                       # answers "OK", no model error
paseo plugin logs paseo-bm                # [paseo-bm] bm-worker was asked for model "claude-opus-5-5", but its profile names "gpt-5.6-sol"; …
```
(Replace `gpt-5.6-sol` with a model that `roles.options` lists on your machine.)

To see the real flow: send `$MGR` (the Manager created before the change) a new request that does **not** name a model, then run `agents.mjs` — the new Worker runs on Codex.

### 2.4 Remove the settings and the plugin

```bash
node scripts/manual-test/rpc.mjs setup.cleanup '{"confirmed":true,"deleteData":false}'
cat "$PASEO_HOME/config.json"             # no bm-* entries left, injectIntoAgents back to false
paseo plugin reload paseo-bm --json
node scripts/manual-test/rpc.mjs setup.ensure-roles    # skipped: "cleaned-up" — not recreated by itself
paseo plugin remove paseo-bm
```

## 3. What cannot be run by hand — covered by tests

| Behaviour | Test |
|---|---|
| A fallback Switch (Manager, Worker) refuses while the agent tools are off, and the incident stays `pending`; the Auto policy | `npx vitest run test/fallback-manager.test.ts test/fallback-switch.test.ts test/fallback-auto.test.ts` — triggering it on a daemon needs a real usage-limit hit |
| The agent-tools status line on Setup; the launcher error line without `Request failed: … requestType=…` and without a repeated code | `npx vitest run test/plugin-setup-model.test.ts test/plugin-launcher.test.ts test/agent-tree.test.ts` — these are screens in the app; the isolated daemon has no app attached |
| The hook: model, thinking, OpenCode features | `npx vitest run test/plugin-role-hook.test.ts` |

## 4. Clean up

```bash
scripts/manual-test/stop-daemon.sh "$WORK"
rm -rf "$WORK"
```
Never use `paseo daemon stop` here: without the right `--home` it stops your real daemon.

## 5. Orchestrator

The scenarios of the Orchestrator agent (`docs/design/paseo-bm-orchestrator.md`, ADR-014, ADR-015, ADR-016): one Beads Orchestrator for the machine that reads every paseo-bm project with its plugin tools and tells Managers — and, on Autopilot or your word, Workers — what to do. A command reaches a Manager in three ways only: an option you pick on one of the Orchestrator's decisions in the Inbox (`decisions.answer`: the plugin delivers the command prepared on it), your own message in the Orchestrator's chat ("Send it."), or the project's **Autopilot**; a Worker only through `bm_direct_worker` on the last two, always with a copy to its Manager. You talk to the Orchestrator in its chat (`send.mjs "$ORCH" …`, as the app sends). Every command arrives as a `BM-COMMAND` block; the Orchestrator's carry `limits: no-commit-push-deploy, no-real-data`. They start from a machine that **0.4.1 set up**, so they need a daemon of their own: run section 4 first if you ran sections 1–2, or use another work dir and port. 5.2 → 5.6 use provider tokens (a Manager, its Workers and the Orchestrator). 5.3 and 5.4 take a few minutes each; 5.5 waits for the **real** 15-minute threshold — there is no test setting that shortens it — so plan about 20 minutes for it, or skip it. Run the scenarios in order, in one shell: each one uses the variables the previous ones set (`WS_ID`, `MGR`, `ORCH`).

### 5.1 A machine set up by 0.4.1, then the branch's plugin: the fourth role appears, the three stay as they were

```bash
WORK=$HOME/bm-manual-orch
scripts/manual-test/start-daemon.sh "$WORK"
source "$WORK/env.sh"

paseo plugin add npm:paseo-bm-plugin@0.4.1 --json       # "status": "running", installation.identity.kind "npm", currentRevision 0.4.1
node scripts/manual-test/rpc.mjs setup.ensure-roles     # created: ["manager","worker","reviewer"]
node scripts/manual-test/rpc.mjs roles.settings | node scripts/manual-test/json.mjs roles    # three roles
node scripts/manual-test/bm-config.mjs > "$WORK/config-0.4.1.json"

paseo plugin remove paseo-bm --json
paseo plugin add "$PWD/plugin" --json                   # "status": "running"
paseo plugin logs paseo-bm                              # Loading plugin → Plugin ready
node scripts/manual-test/rpc.mjs setup.ensure-roles     # what Settings calls when it opens
node scripts/manual-test/rpc.mjs setup.ensure-roles     # second time: created: []
node scripts/manual-test/rpc.mjs roles.settings | node scripts/manual-test/json.mjs roles
node scripts/manual-test/bm-config.mjs > "$WORK/config-branch.json"
diff "$WORK/config-0.4.1.json" "$WORK/config-branch.json"
cat "$PASEO_BM_HOME/ui/setup-state.json"
```
Expected:
- the first `setup.ensure-roles` of the branch's plugin returns `created: ["orchestrator"]` and `skipped: null`;
- `roles.settings` lists four roles in the order manager, worker, reviewer, orchestrator; the fourth has `providerId: "bm-orchestrator"`;
- `diff` prints only added lines (`>`), all inside a `bm-orchestrator` provider and a `bm-orchestrator` profile: not one line of `bm-manager`, `bm-worker` or `bm-reviewer` changed, and `injectIntoAgents` is the same;
- `setup-state.json` keeps three roles in `rolesCreated.roles` and has an `orchestratorCreatedAt`.

Then give the Manager its tools and a repo with a bead database, as in section 2.1:

```bash
node scripts/manual-test/rpc.mjs setup.grant-agent-tools '{"confirmed":true}'
WS_ID=$(scripts/manual-test/new-workspace.sh demo); echo "$WS_ID"
(cd "$BM_TEST_WORK/demo" && br init --prefix demo)
MGR=$(node scripts/manual-test/rpc.mjs manager.ensure "{\"workspaceId\":\"$WS_ID\"}" | node scripts/manual-test/json.mjs agentId); echo "$MGR"
```

### 5.2 Open the Orchestrator in its own workspace, and ask it about a project

```bash
node scripts/manual-test/rpc.mjs orchestrator.open-preview                  # exists: false, provider "claude", the profile's model, workspace "own"
node scripts/manual-test/rpc.mjs orchestrator.open '{}'                     # without confirmed → refused
ORCH=$(node scripts/manual-test/rpc.mjs orchestrator.open '{"confirmed":true}' | node scripts/manual-test/json.mjs agentId); echo "$ORCH"
node scripts/manual-test/rpc.mjs orchestrator.open '{"confirmed":true}'     # the same agentId, created: false
node scripts/manual-test/rpc.mjs orchestrator.open-preview                  # exists: true
node scripts/manual-test/agents.mjs                                         # "Beads Orchestrator", bm-orchestrator, mode auto, labels bm.role=orchestrator, bm.orchestrator=main
paseo inspect "$ORCH"                                                       # Cwd: <PASEO_BM_HOME>/orchestrator/home
paseo workspace ls --json                                                   # demo, and a workspace "home" at that folder
```

Give the project one finished request, then ask about it:

```bash
node scripts/manual-test/send.mjs "$MGR" "Add a one-line comment above add() in math.js that says it returns the sum of a and b. This is a Small change."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/send.mjs "$ORCH" "About project demo ($WS_ID): how does it stand, and what did its last request do?"
node scripts/manual-test/wait-idle.mjs
paseo logs "$ORCH"
paseo plugin logs paseo-bm
```
Expected: `paseo logs` shows your question, then tool calls `[mcp__paseo-bm__bm_projects]` and `[mcp__paseo-bm__bm_request] {"workspaceId":…,"requestId":"req-…"}`, then a short answer that matches the request (the comment, Small, no bead, not committed); no decision is asked and nothing is sent; the plugin log has `bm_projects answered for the orchestrator` and `bm_request answered for the orchestrator`. The Orchestrator ran no shell or file tool.

### 5.3 Autopilot on: the Orchestrator answers a Worker's question and checks the finished step by itself

```bash
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":true}"                    # E_AUTOPILOT_NOT_CONFIRMED, nothing saved
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":true,\"confirmed\":true}"   # autopilot: true, since
cat "$PASEO_BM_HOME/orchestrator/settings.json"                           # version 3, autopilot.<WS_ID>: { enabled: true, since, by: "tab" }
node scripts/manual-test/send.mjs "$MGR" "Add a subtract function to math.js. Before changing anything, the Worker must ask me one question and wait for my answer: should the function be named subtract (option A) or sub (option B)? This is a Small change."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/prompts.mjs "$ORCH" BM-EVENTS
paseo logs "$ORCH" | tail -30
node scripts/manual-test/prompts.mjs "$MGR" | tail -20
node scripts/manual-test/rpc.mjs orchestrator.state
(cd "$BM_TEST_WORK/demo" && git status --short && git log --oneline | head -2)
```
Do nothing yourself between the `send` and the checks: that is the point. Expected, within a minute or two:
- `prompts.mjs "$ORCH" BM-EVENTS` → one message per idle moment of the Orchestrator (autonomy design §A.8): a `BM-EVENTS` message with a `- decision.opened — project <WS_ID>, request req-…, decision q:req-…:Q1 …` line, and later one with `- request.finished — project <WS_ID>, request req-…, Manager <MGR> …`; each line names ids only, the Orchestrator reads the rest with its tools (turning Autopilot on sends nothing by itself);
- after the question, the Orchestrator reads the Manager's messages (`bm_agent_messages` or `bm_request`) and calls `[mcp__paseo-bm__bm_send_command]` once, then tells you in one line what it answered; after the finished step it checks the result and, when nothing you asked for remains, tells you so without sending anything;
- `prompts.mjs "$MGR"` shows the command with `fromApp: true` as a `BM-COMMAND` block (`from: orchestrator`, `via: autopilot`, `to: manager`, `limits: no-commit-push-deploy, no-real-data`); the Manager passes the answer to the Worker (`BM-ANSWERS`), the Worker adds the function and reports `finished`;
- `orchestrator.state`: `projects.0` has `autopilot: true` and `lastAction: { source: "autopilot", text: <the command's first line> }`; `orchestrator/proposals.json` has that command as its one entry, `source "autopilot"`, `status "sent"`, `sentText` the whole block; `inbox.alerts` has no `request-stalled` alert;
- the demo repo has the change **uncommitted**; no Worker or Reviewer timeline has a `fromApp: true` message (`prompts.mjs <worker id>`).

### 5.4 Autopilot off: nothing wakes the Orchestrator; it asks you in the Inbox, and your option or your "Send it." sends

```bash
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":false}"                   # autopilot: false; no dialog needed
node scripts/manual-test/send.mjs "$MGR" "Add a multiply function to math.js. Before changing anything, the Worker must ask me one question and wait for my answer: should the function be named multiply (option A) or mul (option B)? This is a Small change."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/prompts.mjs "$ORCH" BM-EVENTS                    # no new message: no event for a project without Autopilot
node scripts/manual-test/rpc.mjs orchestrator.state | node scripts/manual-test/json.mjs projects.0.state   # "waiting-user"
node scripts/manual-test/send.mjs "$ORCH" "About project demo ($WS_ID): what is it waiting for? Ask me before you send anything."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}'
node scripts/manual-test/send.mjs "$ORCH" "Send it."                      # you, typing in the Orchestrator's chat
node scripts/manual-test/wait-idle.mjs
paseo logs "$ORCH" | tail -12
node scripts/manual-test/prompts.mjs "$MGR" | tail -12
cat "$PASEO_BM_HOME/orchestrator/proposals.json"
```
Expected: the Orchestrator reads the project and asks you with `bm_ask_owner` — `decisions.list` has one open `o:…` decision about the request, its options each with their `effects` and, on the one that answers Q1, a prepared `command` action — and sends nothing to the Manager; after "Send it." it calls `bm_send_command` and the Manager receives the command once as a `BM-COMMAND` block with `via: chat` and the limits (`fromApp: true`); the Worker finishes. `proposals.json` lists both commands the Orchestrator sent (`autopilot`, then `chat`); `projects.0.lastAction.source` of `orchestrator.state` is `"chat"`.

Your option on a decision (what the Inbox's button does): the plugin delivers the command prepared on it, `from: orchestrator`, `via: tab`, on the decision's authority:

```bash
node scripts/manual-test/send.mjs "$ORCH" "About project demo ($WS_ID): ask me whether to ask the Manager which files the multiply request changed, with that question prepared on the yes option. Do not send it."
node scripts/manual-test/wait-idle.mjs
DECISION=$(node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}' | node scripts/manual-test/json.mjs decisions.0.id); echo "$DECISION"
OPTION=$(node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}' | node scripts/manual-test/json.mjs decisions.0.options.0.key); echo "$OPTION"
node scripts/manual-test/rpc.mjs decisions.answer "$(node -e 'console.log(JSON.stringify({ id: process.argv[1], optionKey: process.argv[2], via: "inbox" }))' "$DECISION" "$OPTION")"
node scripts/manual-test/rpc.mjs decisions.answer "$(node -e 'console.log(JSON.stringify({ id: process.argv[1], optionKey: process.argv[2], via: "inbox" }))' "$DECISION" "$OPTION")"   # again → E_DECISION_SETTLED
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/prompts.mjs "$MGR" BM-COMMAND | tail -14           # the prepared command, fromApp: true, via: tab, authority: decision:o:…
```
Expected: the answer settles the decision `answered` with its option; the Manager gets the prepared command once, as a `BM-COMMAND` block with `authority: decision:<id>` and the limits its approval leaves; an option whose effects need your confirmation (push, publish, deploy, real data, migration, security, cost) is refused without `"confirmed": true`.

### 5.5 A stalled request: an Inbox alert, and an event only with Autopilot on (optional, ~10 min)

The stall pass always runs (autonomy design §A.8), and a stalled request is a `request-stalled` Inbox alert in `inbox/alerts.json`, never a message to you.

```bash
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":false}"
node scripts/manual-test/send.mjs "$MGR" "Add a divide function to math.js. The Worker must stop right after sizing the request, report received, and do nothing more until I write again. This is a Small change."
node scripts/manual-test/wait-idle.mjs
node scripts/manual-test/wait-stall.mjs idle-unfinished 15                 # polls inbox/alerts.json; ~6 min
node scripts/manual-test/prompts.mjs "$ORCH" BM-EVENTS                     # no new message: Autopilot is off
node scripts/manual-test/rpc.mjs inbox.alerts
node scripts/manual-test/rpc.mjs orchestrator.state | node scripts/manual-test/json.mjs projects.0.state
```
Expected: `wait-stall.mjs` prints `request-stalled:<WS_ID>:req-…` with `detail: "idle-unfinished"`, `since` about 5 minutes after the last turn, `clearedAt: null`; the Orchestrator gets nothing; `inbox.alerts` lists that alert, and the project's `state` is `stalled`. With Autopilot on for the project, the pass that raises the alert also sends the Orchestrator one `BM-EVENTS` message with a `- request.stalled idle-unfinished — …` line; once a Worker of the request runs again, the alert is cleared (`clearedAt` set).

### 5.6 Assess the project's workflow; apply one recommendation

```bash
node scripts/manual-test/send.mjs "$ORCH" "Assess the workflow of project demo ($WS_ID)."
node scripts/manual-test/wait-idle.mjs
paseo logs "$ORCH" | tail -30                                   # bm_projects / bm_request reads, then one [mcp__paseo-bm__bm_assessment]
node scripts/manual-test/rpc.mjs orchestrator.state | node scripts/manual-test/json.mjs projects.0.assessment
```
Expected: the `assessment` of the demo project has `status "done"`, six `scores` (sizing, process-weight, coordination, user-communication, report-quality, review-quality; 1–5 or null, each with a note), `average` = the mean of the non-null scores to one decimal, and `recommendations` (possibly none). The Orchestrator may also read a Manager turn that belongs to no request by its trace id, `<MGR>:foreground-turn-N`. Apply one (no screen offers this in Phase 1; the RPC stays until Phase 2 retires additional instructions):

```bash
ASSESSMENT=$(node scripts/manual-test/rpc.mjs orchestrator.state | node scripts/manual-test/json.mjs projects.0.assessment)
ROLE=$(printf '%s' "$ASSESSMENT" | node scripts/manual-test/json.mjs recommendations.0.role)
TEXT=$(printf '%s' "$ASSESSMENT" | node scripts/manual-test/json.mjs recommendations.0.text)
# No recommendation? Use ROLE=worker and TEXT='Keep a Small request free of beads unless the user asks for one.'
HASH=$(node scripts/manual-test/rpc.mjs roles.instructions "{\"role\":\"$ROLE\"}" | node scripts/manual-test/json.mjs hash); echo "$HASH"
APPLY=$(node -e 'console.log(JSON.stringify({ role: process.argv[1], text: process.argv[2], expectedHash: process.argv[3], confirmed: true }))' "$ROLE" "$TEXT" "$HASH")
node scripts/manual-test/rpc.mjs orchestrator.apply-suggestion "$APPLY"      # extra ends with the text, chars, maxChars 8000, a new hash
node scripts/manual-test/rpc.mjs orchestrator.apply-suggestion "$APPLY"      # the old hash again → E_ROLE_EXTRA_CHANGED, nothing written
node scripts/manual-test/rpc.mjs roles.instructions "{\"role\":\"$ROLE\"}" | node scripts/manual-test/json.mjs extra   # the text, once
```
(`node -e … JSON.stringify` builds the input, so a recommendation with quotes cannot break the JSON. A call without `confirmed` fails input validation.)

### 5.7 Coordinating running work (ADR-016): a Worker signal, a direct Worker command with the Manager's copy, the gate, `bm_repo`, the project facts

Needs the Orchestrator open (5.2) and `$WS_ID`, `$MGR`, `$ORCH` set; it can run right after 5.6, or on a fresh isolated daemon set up with section 1, `setup.grant-agent-tools` of 2.1, `br init` and `manager.ensure` of 5.1, and the first block of 5.2. Uses provider tokens; about 15 minutes. The Worker watch looks every **2 minutes**, and only at a Worker that is still running, so each request keeps its Worker busy after the command that raises the signal. On Claude a long foreground `sleep` is refused by the provider's own tool, so the wait is `node -e "setTimeout(() => {}, 110000)"`. The demo repository has **no remote**, so `git push` fails and nothing leaves the machine.

Turn Autopilot on, and tell the Orchestrator — as the owner — what to do on a Worker signal:

```bash
(cd "$BM_TEST_WORK/demo" && git remote -v | wc -l)   # 0: no remote
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":true,\"confirmed\":true}"
node scripts/manual-test/send.mjs "$ORCH" "Standing instruction for the demo project: whenever a running Worker there raises any worker signal, tell that Worker directly (bm_direct_worker) to stop what it is doing and report, even if I asked for the command myself; interrupt it when the plugin allows. Keep this as a note."
node scripts/manual-test/wait-idle.mjs
```

(a) A `git push` raises `worker-signal danger`; the gate stops the Orchestrator's stop command until `release` is allowed (b); then the Orchestrator interrupts the Worker directly, and the Manager gets the copy:

```bash
SEND_PUSH='Small diagnostic task, no code change. The repository has no remote, so a push cannot go anywhere; I want to see what git says. The Worker must run the exact command git push three times, as three separate foreground tool calls (it fails each time). Then, as a wait for my coordinator, run the exact command node -e "setTimeout(() => {}, 110000)" three times, each as its own foreground tool call. Then report what git said. Change nothing.'
node scripts/manual-test/send.mjs "$MGR" "$SEND_PUSH"
node scripts/manual-test/wait-idle.mjs 20
node scripts/manual-test/prompts.mjs "$ORCH" BM-EVENTS
paseo logs "$ORCH" | tail -30
```
Expected: within about 2 minutes of the push, a `BM-EVENTS` message with a `- worker.signal danger — project <WS_ID>, Worker <worker>, …` line ending "You may interrupt this Worker until …"; `inbox/alerts.json` has an open `danger:<WS_ID>:<worker>` alert whose `detail` is `git push: git push`, and `orchestrator/stalls.json` has `…::<worker>::danger-open@<time>`. The Orchestrator's `bm_direct_worker` with `interrupt: true` is refused while `release` is not allowed — the stop names the push — and it asks you instead: go on with (b), then allow `release` and run the same request again:

```bash
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":true,\"confirmed\":true,\"allow\":[\"release\"]}"
node scripts/manual-test/send.mjs "$MGR" "$SEND_PUSH"
node scripts/manual-test/wait-idle.mjs 20
WORKER=$(node scripts/manual-test/agents.mjs | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).filter(x=>String(x.provider).startsWith("bm-worker"));console.log(a[0].id)})'); echo "$WORKER"   # the newest Worker
node scripts/manual-test/prompts.mjs "$WORKER" BM-COMMAND
node scripts/manual-test/prompts.mjs "$MGR" BM-COMMAND | tail -14
tail -c 1200 "$PASEO_BM_HOME/orchestrator/proposals.json"
```
Expected: the Orchestrator calls `bm_direct_worker` with `interrupt: true` right after the signal ("Sent at once"); the Worker's `BM-COMMAND` has `from: orchestrator`, `via: autopilot`, `to: worker`, the limits and the stop, and its running wait is cancelled; the Manager's block is the same with `copy: yes`, at the same time; the last entry of `proposals.json` has `to: "worker"`, `workerId` the Worker, `managerId` `$MGR`, `source "autopilot"`, `outcome "sent"`. Nothing reaches a Reviewer.

A **`failing`** signal (the same command failing 3 times) counts a shell call whose `status` is `failed` (Claude's timeline has no exit code) or whose exit code is non-zero — fixed after the 2026-09-29 coordination run (finding F1), not yet re-run here. The Worker must run the command itself three times as three calls: a piped command (`npm test | tail`) ends as its last part does and is not seen as failing.

(b) The refused stop of (a) is a decision with options (run this between the two requests of (a)):

```bash
paseo plugin logs paseo-bm | grep -E "bm_direct_worker|bm_ask_owner" | tail -4
node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}'
DECISION=$(node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}' | node scripts/manual-test/json.mjs decisions.0.id)
OPTION=$(node scripts/manual-test/rpc.mjs decisions.list '{"scope":"inbox"}' | node scripts/manual-test/json.mjs decisions.0.options.0.key)
node scripts/manual-test/rpc.mjs decisions.answer "$(node -e 'console.log(JSON.stringify({ id: process.argv[1], optionKey: process.argv[2], via: "inbox", confirmed: true }))' "$DECISION" "$OPTION")"
```
Expected: the refusal `… declare the effect or ask the owner with bm_ask_owner`, nothing sent to the Worker or the Manager; `decisions.list` has an open `o:…` decision with 2–5 options, each with its `effects`. Answering with an option (what the Inbox's button does) settles it `answered`, and its prepared command, if it has one, goes out once on the decision's grant. A command you ask for yourself ("Tell the demo Manager to push its branch to origin now.") is refused the same way.

(c) `bm_repo` verifies a claim; nothing in the repository changes:

```bash
(cd "$BM_TEST_WORK/demo" && git status --porcelain=v2 --branch > "$BM_TEST_WORK/before.txt" && ls -l .git/index >> "$BM_TEST_WORK/before.txt")
node scripts/manual-test/send.mjs "$ORCH" "About project demo ($WS_ID): check the git status of its repo. Is anything uncommitted?"
node scripts/manual-test/wait-idle.mjs
paseo logs "$ORCH" | tail -15
(cd "$BM_TEST_WORK/demo" && git status --porcelain=v2 --branch > "$BM_TEST_WORK/after.txt" && ls -l .git/index >> "$BM_TEST_WORK/after.txt"); diff "$BM_TEST_WORK/before.txt" "$BM_TEST_WORK/after.txt" && echo unchanged
```
Expected: `[mcp__paseo-bm__bm_repo] {"workspaceId":…,"action":"status"}` and an answer that matches `git status`; the plugin log has `bm_repo answered for the orchestrator`; `unchanged`.

(d) The project's facts that Work's rows read:

```bash
node scripts/manual-test/rpc.mjs orchestrator.state | node scripts/manual-test/json.mjs projects.0
```
Expected: `projects.0` has `health`, `stage`, `agents { manager, workers, reviewers }`, `lastProgressAt`, `currentRequest`, `openSignals` (empty once the Worker's turn ended), `allow`, and `notes` with the standing instruction when the Orchestrator kept it.

### 5.8 Remove the settings and the data

```bash
node scripts/manual-test/rpc.mjs orchestrator.set-autopilot "{\"workspaceId\":\"$WS_ID\",\"enabled\":false}"
node scripts/manual-test/rpc.mjs setup.cleanup '{"confirmed":true,"deleteData":true}'
node scripts/manual-test/bm-config.mjs            # providers: {}, profiles: [], injectIntoAgents: false
ls -A "$PASEO_BM_HOME"                             # no orchestrator/, no traces/, no inbox/
paseo plugin reload paseo-bm --json
node scripts/manual-test/rpc.mjs setup.ensure-roles    # skipped: "cleaned-up"
paseo plugin remove paseo-bm --json
```
Expected: `removedProviders` and `removedProfiles` list the four `bm-*` ids, `bm-orchestrator` included; `agentTools: "restored"`; `data.deleted` names `orchestrator` (and `traces`, `decisions`, `inbox`, `role-extras.json`, `ui/agent-tools.json`, and the retired `ui/qa-ledger.json` that 0.4.1 wrote in 5.1), `ui/setup-state.json` is kept; `bm-config.mjs` finds no `bm-*` entry; `$PASEO_BM_HOME` has no `orchestrator` folder (the Orchestrator's home folder and its settings — the Autopilot projects included —, its command log, interrupt allowances and assessments go with it); the roles are not recreated by themselves. The agents stay (paseo-bm never archives one), the Orchestrator included, although its working folder `orchestrator/home` is gone: archive them in the app if you keep the daemon.

Then stop the daemon and delete `$WORK` as in section 4.
