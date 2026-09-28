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

## 0. Prepare

```bash
git fetch origin
git switch test/manual-0.4.1
npm install            # if node_modules is missing
npm run build          # regenerates plugin/server/*-instructions.ts and the version
npm run verify         # 107 test files, must be green
```

Needs: Paseo 0.9+ (the `paseo` CLI on PATH), Claude Code signed in; Codex signed in for section 3.

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

`node scripts/manual-test/rpc.mjs setup.status` shows the whole machine state the Setup screen displays (roles, agent tools, sign-in, skills, data folder).

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
