# Run note — Paseo-tools policy per role, 2026-09-29

| Field | Value |
|---|---|
| Bead | `bm-autonomy-phase1a-odkl.1` (WP-101) |
| Requirement / design | PRD REQ-116 (a), REQ-170; autonomy design §A.10 |
| Paseo | CLI and daemon 0.9.2 |
| Daemon | isolated, `scripts/manual-test/start-daemon.sh` on port 6901, home and data folder under the session scratchpad; the owner's `~/.paseo`, `~/.paseo-bm` and port 6767 untouched; stopped with `stop-daemon.sh` at the end |
| Plugin | the working tree's `plugin/` (`paseo plugin add <repo>/plugin` → `status: running`) |
| Models | every probe agent on `claude-haiku-4-5`, one short prompt each |

## 1. What the plugin writes

| Alias | `paseoTools` |
|---|---|
| `bm-reviewer`, `bm-orchestrator`, `bm-reviewer-fallback-<n>` | `{ enabled: false }` |
| `bm-manager`, `bm-manager-fallback-<n>` | `{ enabled: true, disabledTools: [kill_agent, archive_agent, archive_workspace, respond_to_permission, list_pending_permissions, set_agent_mode, update_agent, create_schedule, update_schedule, delete_schedule, run_schedule_once, pause_schedule, resume_schedule, create_heartbeat, delete_heartbeat] }` |
| `bm-worker`, `bm-worker-fallback-<n>` | the Manager's list plus `create_workspace`, `rename_workspace` |

Every name is one that Paseo 0.9.2 registers in `paseo-tools.js`. None of them is used by `plugin/roles/manager.md` or `worker.md` (they use `create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, `list_agents`, `list_profiles`, `cancel_agent`).

## 2. Upgrade of a machine that already has the roles

The test daemon was seeded through `DaemonClient.patchDaemonConfig` with the entries a 0.4.x machine has: `bm-manager` and `bm-worker` with `paseoTools: { enabled: true }`, `bm-reviewer` and `bm-reviewer-fallback-1` with no `paseoTools`, a key added by the user on `bm-worker` (`additionalModels`), and no Orchestrator. Then:

```
paseo plugin add <repo>/plugin --json                 # "status": "running"
node scripts/manual-test/rpc.mjs setup.ensure-roles   # created: ["orchestrator"]
node scripts/manual-test/rpc.mjs setup.ensure-roles   # created: [] — nothing written
```

Plugin log:

```
[paseo-bm] set the Paseo-tools policy of bm-manager, bm-worker, bm-reviewer, bm-reviewer-fallback-1
[paseo-bm] created roles bm-orchestrator on claude · claude-opus-5-5
```

`bm-config.mjs` before and after: the only change to the four existing aliases is their `paseoTools` (Manager and Worker gain `disabledTools`, Reviewer and its fallback gain `enabled: false`); `extends`, `label` and the user's `additionalModels` on `bm-worker` are unchanged; `bm-orchestrator` is created with `paseoTools: { enabled: false }`.

`roles.save-settings` for the Orchestrator (model → `claude-haiku-4-5`) then left every `paseoTools` exactly as written.

## 3. What each role could see and call

`setup.grant-agent-tools` (confirmed) turned `daemon.mcp.injectIntoAgents` on in the test daemon. Six agents were created with `create-agent.mjs` in one workspace, each with the prompt "list the exact name of every tool whose name starts with `mcp__paseo__`, deferred ones included, or NONE". One is a control on the plain `claude` provider, which has no policy.

| Agent's provider | `mcp__paseo__*` tools it listed | Missing compared with the control |
|---|---|---|
| `claude` (control) | 39 | — |
| `bm-manager` | 24 | exactly the Manager's 15 disabled tools |
| `bm-worker` | 22 | exactly the Worker's 17 disabled tools |
| `bm-reviewer` | NONE | all 39 |
| `bm-orchestrator` | NONE | all 39 |
| `bm-reviewer-fallback-1` | NONE | all 39 |

The set differences were computed by script from the answers, not read by eye. There is also a deterministic sign in each agent's stored launch config (`$PASEO_HOME/agents/<workspace>/<id>.json`): the Manager, the Worker and the control carry the `paseo` MCP server (`/mcp/agents?callerAgentId=…`), but the Reviewer, the Orchestrator and the Reviewer fallback carry only the plugin's own `paseo-bm` server. With `enabled: false`, Paseo does not attach its server at all (`agent-manager.js`: `mcpBaseUrl` is `null` when `isPaseoToolPolicyEnabled` is false).

Then four of the agents were asked to call `mcp__paseo__list_agents` once and to try `mcp__paseo__kill_agent`:

| Agent | `list_agents` | `kill_agent` |
|---|---|---|
| `bm-manager` | called: 6 agents | not available |
| `bm-worker` | called: 6 agents | not available |
| `bm-reviewer` | not available | not available |
| `bm-orchestrator` | not available | not available |

The Manager probe was created directly in the `default` mode, not in the no-prompt mode that `manager.ensure` gives a real Manager, so its `list_agents` call raised a permission prompt. It was allowed with `paseo permit allow` on the test daemon. The Worker probe ran in `bypassPermissions` (set by the creation hook) and made the call without a prompt.

## 4. Cleanup

`setup.cleanup {"confirmed":true,"deleteData":false}` returned `removedProviders: [bm-manager, bm-worker, bm-reviewer, bm-reviewer-fallback-1, bm-orchestrator]` and `agentTools: "restored"`. `bm-config.mjs` then showed `providers: {}` and `profiles: []`, and `config.json` contained no `paseoTools`.

## 5. Findings

- **F1 — the policy is read at every session launch, not only at creation.** `AgentManager.prepareSessionConfig` resolves `paseoTools` for `create`, `resume`, `import` and `refresh`. So an agent that already exists gets the new policy the next time its session is opened, for example after a daemon restart or a reload. The design's line that existing agents keep their tools until they are replaced is not quite right. This run did not test it.
- **F2 — `speak` is exempt.** `isPaseoToolEnabled` always allows `speak`, but Paseo registers it only for voice sessions, so it did not appear for any probe.
- **F3 — Paseo merges `paseoTools` one level deep** (`applyMutableProviderConfigToOverrides`). If an alias had a `disabledTools` list before it was given `{ enabled: false }`, it keeps that list next to `enabled: false`. This has no effect, because `enabled: false` turns off every tool, and the plugin does not write it again: its check only compares the keys of the policy.
