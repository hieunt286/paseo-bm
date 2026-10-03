# Run note — ADR-027 spikes S1, S2, S4 and S5, 2026-10-03

| Field | Value |
|---|---|
| Bead | `bm-agent-tools-1upv.4` (WP-703) |
| Requirement / design | [ADR-027](../../adr/ADR-027-agents-write-content-code-carries-it.md) "Spikes and open questions"; base design §16.1 (spike table), §16.5, §16.10, §16.12 |
| Paseo | CLI and daemon **0.10.2** |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh` on port 6911, home and data folder under the session scratchpad, `daemon.mcp.injectIntoAgents` on in that test config only; the owner's `~/.paseo`, `~/.paseo-bm` and port 6767 untouched. Stopped with `stop-daemon.sh` and its home deleted at the end |
| Plugin | a throwaway probe plugin `bm-probe` (scratchpad only, never in the repo), the only plugin on the daemon: RPC `probe.create` calls `paseo.workspaces.ref(ws).agents.create({ config: { provider, modeId, mcpServers }, parent, title, labels, prompt })`, with a fresh 32-byte token in the `bm-probe-tools` URL `http://127.0.0.1:<port>/mcp/worker/<64 hex>`; `before("agent.create")` logs what it sees and, for a URL carrying a token it issued, keeps the URL and adds `alwaysLoad` plus a `toolPolicy` grant for `probe_ping` (what §16.5's hook does); a tiny MCP endpoint on `127.0.0.1` logs every request by path shape and token label; `on("agent.created" / "agent.turn_started" / "agent.turn_ended")` log the event; `probe.stop` runs `paseo agent stop <id> --json` with `execFile`, no shell, as `plugin/server/paseo-cli.ts` runs the CLI, and refuses unless `PASEO_HOME` is the test home. The probe logs tokens only as a SHA-256 prefix and returns none |
| Agents | `claude/claude-haiku-4-5` for every turn (4 short turns in all), one `codex/gpt-5.6-luna` agent created with no prompt |

Every scan below looks for three things anywhere in a JSON value: a string matching `mcp/<role>/<64 hex>`, the probe endpoint's port, and a key named `mcpServers`.

## 1. S1 — a plugin-chosen MCP URL survives creation

**Passed.**

A parent agent (no prompt, idle), then a child created by the SDK with `withMcp`, `parent` = the parent, mode `default`, prompt "Call the tool probe_ping once, then reply with the single word DONE.":

```
before agent.create {"requestKeys":["config","env"],"configKeys":["provider","cwd","modeId","model","featureValues","title","mcpServers"],"provider":"claude","modeId":"default","title":"probe child S1","mcpServerNames":["bm-probe-tools"],"probeEntry":{"type":"http","url":{"shape":"http://127.0.0.1:<port>/mcp/worker/<64hex>","issued":"child-S1","portIsProbe":true},"alwaysLoad":null},"toolPolicy":null,"envKeys":[]}
agent.created {"id":"d25b6b91-…","parentAgentId":"372846bf-…","provider":"claude",…,"title":"probe child S1"}
agent.turn_started {"id":"d25b6b91-…","turnId":"foreground-turn-1"}                 08:41:28.452
mcp request {"httpMethod":"POST","path":{"shape":"…/mcp/worker/<64hex>","issued":"child-S1"},"rpc":"server/discover"}   .918
mcp request … "rpc":"initialize" · "notifications/initialized" · GET (answered 405, tolerated) · "tools/list"            .929–.941
mcp request {"httpMethod":"POST","path":{…,"issued":"child-S1"},"rpc":"tools/call","tool":"probe_ping"}                 08:41:33.616
agent.turn_ended {"outcome":{"kind":"completed"},"timelineKinds":{"user_message":1,"tool_call":1,"assistant_message":1}}
```

- The SDK accepts `config.mcpServers`; the hook receives it unchanged (with the plugin's token URL), and `agents.create` returned in 115 ms.
- The created agent used exactly that URL: every request reached the token path the plugin issued, and it called the tool once, with no permission request in Claude's `default` mode (the hook's pre-approval held).
- **The creation `prompt` has no `clientMessageId`.** Its `user_message` has the keys `messageId`, `text`, `type`. (`PaseoAgentCreateOptions` does accept a `clientMessageId`; the probe did not pass one.)

Consequence: §16.5 as written. The plugin puts the token URL in the creation config and the hook keeps it; the nonce fallback is not needed. The `clientMessageId` answer changes nothing (§16.2 checks markers first).

## 2. S2 — wake-ups of a plugin-created agent's parent

**Passed: Paseo does not wake the parent, and `agent.created` carries `parentAgentId`.**

| Creation | Child turn ended | Parent's next `agent.turn_started` |
|---|---|---|
| SDK `agents.create({ parent, prompt })` (the S1 child) | 08:41:34.606 | **none** — the parent stayed idle until the control below, 108 s later, and its timeline held no message |
| Control: Paseo's MCP `create_agent` called as the parent (`POST /mcp/agents?callerAgentId=<parent>`, `notifyOnFinish: true`, prompt "Reply with the single word OK.") | 08:43:27.413 | 08:43:27.437 — **24 ms later**, a turn with one `assistant_message` and no `user_message` |

- Both children's `agent.created` carry `parentAgentId` = the parent, and both have the label `paseo.parent-agent-id`.
- The daemon source agrees (0.10.2, `agent/create-agent/create.js`): `setupFinishNotification` runs only when `input.kind === "mcp" && input.notifyOnFinish && input.callerAgentId`; a client or plugin creation is `kind: "session"` and never registers it. The same holds for a Worker and a Reviewer the plugin creates.

Consequence: §16.10 and ADR-027 decision 11 as written. Role pairing (`role-pairing.ts`) sees the creator the plugin names as `parent`, so a Manager-parented Worker and a Worker-parented Reviewer pair correctly with no exception.

## 3. S4 — can other agents see a token?

**Passed on the four surfaces the spike names. The token is nevertheless readable outside them (below).**

Read for the S1 child (Claude, with a token URL) and for the Codex agent (token URL, no prompt):

| Surface | How it was read | Hits |
|---|---|---|
| Agent snapshot through the SDK | `paseo.agents.ref(id).refresh()`, `.current()`, `paseo.agents.list()`, `.timeline.refetch({ direction: "tail" })` | 0 token URLs, 0 `mcpServers` keys |
| `get_agent_status` | the agent MCP endpoint as the parent agent calls it | 0 |
| `list_agents` (`includeArchived: true`) | same | 0 |
| `get_agent_activity` | same | 0 |
| `paseo inspect --json`, `paseo agent inspect --json` | CLI | 0 |

- What the snapshot does show: `persistence.metadata` keys `cwd, modeId, model, provider, title, toolPolicy`. `toolPolicy.preapproved` names the MCP server and tool (`{ kind, server, tool }`), never the URL. `get_agent_activity` shows the tool name (`mcp__bm-probe-tools__probe_ping`).
- Positive control: the same scan flags the URL in the hook's request, so a URL in any surface would have been found.

**Outside the named surfaces** (a fact, not a fail of S4 as defined):

- **The agent record on disk**, `$PASEO_HOME/agents/<cwd slug>/<agent id>.json`, mode `0644`, holds the URL at `config.mcpServers.<name>.url` and `persistence.metadata.mcpServers.<name>.url`, for Claude and Codex alike. Any agent that can read files under the Paseo home can read it; the agent id is the file name.
- **Claude Code's process arguments** carry it: the provider is started with `--mcp-config {"mcpServers":{…}}` (beside `--allowedTools mcp__<server>__<tool>`), visible to any process of the same user with `ps -axww`. The Codex app-server's arguments do not carry it.
- Claude Code's transcript under the real `~/.claude/projects/` did not contain it (0 files).

So a token is not secret from an agent that has a shell or a file-read tool. The spike's second factor (`PASEO_AGENT_ID` passed as input and compared with the binding) would not close this path either, since the reader also learns the agent id from the same file name or `list_agents`.

## 4. S5 — a real cancel

**Passed.** The command is `paseo agent stop <id> --json` ("Interrupt an agent if it is running (no-op for idle agents)").

An agent in `bypassPermissions` was told to run `node -e "setTimeout(() => {}, 120000)"` in the foreground; once its timeline showed the running `[Shell]` call, `probe.stop` ran the CLI from the plugin process:

```
probe.stop → {"code":0,"output":"{\"stoppedCount\":1,\"agentIds\":[\"5ea413fa-…\"]}","ms":577,"timedOut":false}
agent.turn_ended {"id":"5ea413fa-…","turnId":"foreground-turn-1","outcome":{"kind":"canceled","reason":"Interrupted"},"timelineKinds":{"user_message":1,"tool_call":1}}
```

- The turn ended `canceled` (reason `Interrupted`) within the CLI call's 577 ms; the shell child process was gone; no new turn started. Claude Code then added a `[Task notification]` timeline item about the killed shell task, without a turn.
- The daemon was not touched: the same daemon pid before and after, `bm-probe` still `running`, the three other agents idle and unchanged.
- On an idle agent the same command is a no-op: exit 0, `{"stoppedCount":0,"agentIds":[]}`.
- The plugin process inherits the daemon's `PASEO_HOME`, so the CLI reaches the daemon the plugin runs in, as `paseo agent mode` / `update` already do.
- The CLI takes an id **or a prefix**, and also `--all` / `--cwd`: the plugin must pass a full id checked by `isSafeAgentId`, and never those flags.
- A plugin cancel ends the turn exactly as the owner's Stop does (`canceled`, `Interrupted`); nothing in the outcome tells them apart.

Consequence: step 5 removes the Worker's `cancel_agent` step and the Reviewer's `BM-REVIEW STOPPED`; `stop-propagation.ts` and the off-tool Reviewer handling cancel through `paseo-cli.ts` (bead `bm-agent-tools-1upv.16`).

## 5. Decision

S1, S2, S4 and S5 passed. No amendment of ADR-027, design §16 or the plan follows from them. The on-disk and process-argument exposure of a token (section 3) is outside S4's question; it is recorded here and in AGENTS.md for the owner to weigh before ship point C.

## 6. Clean-up

The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh` (it checks the home and port before stopping) and its folder deleted; afterwards no process held a token URL in its arguments. The probe plugin stays in the session scratchpad only. Claude Code wrote its own transcripts of the four test turns under the real `~/.claude/projects/`, as every run of this kit does.
