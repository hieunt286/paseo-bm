# Run note — role pairing at agent creation, 2026-09-29

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase1a-odkl.2` (WP-101) |
| Requirement / design | PRD REQ-116 (b), autonomy design §A.10 |
| Paseo | CLI and daemon 0.9.2 |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh` on port 6902, home and data folder under the session scratchpad; the owner's `~/.paseo`, `~/.paseo-bm` and port 6767 untouched |
| Plugin | a throwaway probe plugin `bm-probe` (scratchpad only, never in the repo): `before("agent.create")` logs the request's keys and throws when `config.title` contains `PROBE-REFUSE`; `on("agent.created")` logs the event's agent |
| Caller | a parent agent (`claude` / `claude-haiku-4-5`, created with no prompt), then the daemon's agent MCP endpoint `POST /mcp/agents?callerAgentId=<parent>` with `tools/call create_agent` — exactly what an agent's `create_agent` call reaches, with no model turn. `daemon.mcp.injectIntoAgents` was turned on in the test daemon's config only (without it the endpoint lists no tools: `Method not found`) |

## 1. Question 1 — does `before("agent.create")` see the creating agent?

**No.**

Probe log, for the parent (created by a client) and for two MCP creations by that parent:

```
[bm-probe] before agent.create {"requestKeys":["config","env"],"configKeys":["provider","cwd","modeId","model","featureValues","title"],"envKeys":[],"provider":"claude","title":"probe parent"}
[bm-probe] before agent.create {"requestKeys":["config","env"],"configKeys":["provider","cwd","modeId","model","thinkingOptionId","title"],"envKeys":[],"provider":"claude","title":"PROBE-REFUSE worker"}
[bm-probe] before agent.create {"requestKeys":["config","env"],"configKeys":["provider","cwd","modeId","model","thinkingOptionId","title"],"envKeys":[],"provider":"claude","title":"PROBE-ALLOW child"}
```

The daemon source agrees (Paseo 0.9.2 app bundle, `AgentManager.createAgentInternal`): it calls `pluginLifecycle.before("agent.create", { config, env: options.env })` and nothing else. The creator is known to `resolveMcpCreateAgent` (`callerAgentId`), but it only reaches the create options as the `paseo.parent-agent-id` label, which the hook never sees; the MCP `create_agent` path passes no `env`.

The `agent.created` event does carry the creator:

```
[bm-probe] agent.created {"id":"fdd3e8d4-…","workspaceId":"wks_b83131418f28166c","parentAgentId":null,"provider":"claude",…,"title":"probe parent"}
[bm-probe] agent.created {"id":"a7f3da46-…","workspaceId":"wks_b83131418f28166c","parentAgentId":"fdd3e8d4-8c68-4ece-be90-460a753aa1a1","provider":"claude",…,"title":"PROBE-ALLOW child"}
```

(`describeHookAgent` reads `parentAgentId` from the `paseo.parent-agent-id` label.)

## 2. Question 2 — does a throw from the hook surface cleanly to `create_agent`?

**Yes.** The MCP answer to the `PROBE-REFUSE` creation:

```json
{"result":{"content":[{"type":"text","text":"Plugin bm-probe before agent.create failed: bm-probe refuses this creation: only a Beads Manager may create a Beads Worker."}],"isError":true},"jsonrpc":"2.0","id":2}
```

No agent was created: the agent list afterwards held the parent only (then the allowed child). The daemon runs every plugin's `before` hook in plugin-id order and wraps the first throw as `Plugin <id> before <name> failed: <message>`; the hook runs before any agent state is written.

## 3. Decision

The refusal path needs both facts; the first does not hold. So the pairing is enforced **after** creation: `on("agent.created")` (wired in `plugin/server/agent-labels.ts`) reads the new agent's `parentAgentId`, looks up the creator's **provider** (a label can be changed later, the provider cannot) and, on a mismatch, calls `raiseRolePairingAlert` in `plugin/server/role-pairing.ts`. Until the Inbox alerts store exists (event-bus bead, design §A.8) that function logs one line:

```
[paseo-bm] role pairing: Beads Worker <id> was created by Beads Worker <id>; only a Beads Manager creates a Beads Worker.
```

The event-bus bead passes its store as `raiseAlert` to `registerAgentLabels(server, labeller, { raiseAlert })`. An agent with no creator agent (created from the app, or by the plugin: the Manager, the Orchestrator, its assessment agent) is not subject to the rule; a creator Paseo cannot return costs one log line, never an alert.

## 4. Clean-up

The probe's allowed child answered one haiku turn; the test daemon was stopped with `scripts/manual-test/stop-daemon.sh`. The probe plugin and the test daemon's home stay in the session scratchpad only.
