> Ghi chú: tài liệu này viết bằng tiếng Anh (ngoại lệ của quy tắc `docs/` tiếng Việt) vì người đọc là maintainer của Paseo.

# Upstream request: let a plugin cancel an agent's current run

| Field | Value |
|---|---|
| Status | **Draft — not sent** |
| Target | Paseo maintainers (`@getpaseo/plugin`, `@getpaseo/client`) |
| Checked against | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, Paseo daemon 0.8.0 |
| Origin | paseo-bm bead `bm-wq6` (orchestration acceptance run 4, fixture F-8a); design errata in `docs/design/paseo-bm.md` §2.6 D |
| Date | 2026-09-15 |

## Summary

A Paseo plugin can observe that an agent's turn was canceled, but it cannot
cancel another agent's run. A plugin that coordinates parent and child agents
therefore cannot propagate a user's Stop to the children. We ask for a minimal,
explicit cancel capability on the plugin-facing API.

## Use case

paseo-bm is a plugin that runs three agent roles in one workspace:

- **Beads Manager** creates a **Beads Worker** with the `create_agent` MCP tool.
- The Worker creates short-lived **Reviewer** agents for each batch of changes.
  Each Reviewer carries the `paseo.parent-agent-id` label pointing at the Worker.

When the user presses Stop on the Worker (app Stop button or `paseo stop`),
the user expects the whole unit of work to stop, including the Reviewers the
Worker started. Today:

1. Paseo interrupts only the Worker's current turn.
2. The Worker has no turn left in which to cancel its Reviewers.
3. Each Reviewer keeps running until its review ends on its own.
4. When the Reviewer goes idle, Paseo sends a "finished" notification to its
   parent, which starts a new turn on the Worker the user just stopped.

The plugin sees step 1 happen, but has no API to act on it.

## What is missing

### The plugin can detect a canceled turn

`@getpaseo/plugin` 0.8.0, `dist/server/lifecycle.d.ts`:

- `PluginLifecycleEvents["agent.turn_ended"]` carries
  `{ agent: PluginHookAgent; turnId; outcome: PluginTurnOutcome; timeline }`.
- `PluginTurnOutcome` includes `{ kind: "canceled"; reason: string }`.
- `PluginHookAgent` includes `parentAgentId`, so the plugin can find children.

### The plugin cannot cancel an agent

The plugin receives `PluginHookContext.paseo` / `PluginHandlerContext.paseo`,
typed `PaseoApi` (`@getpaseo/client` 0.8.0, `dist/index.d.ts`).

- `PaseoApi.agents` is `PaseoAgentActions`: `list`, `ref`, `create`, `subscribe`.
- `PaseoAgentHandle` offers `current`, `refresh`, `send`, `respondToPermission`,
  `run`, `waitForFinish`, `commands`, `archive`, `detach`, `subscribe`.
  **There is no `cancel`.**
- `DaemonClient.cancelAgent(agentId: string): Promise<void>` exists in
  `dist/daemon-client.d.ts`, but it is only exported under
  `@getpaseo/client/internal/daemon-client`, and a plugin receives a `PaseoApi`,
  not a `DaemonClient`.

### The workarounds are not equivalent

- `PaseoAgentHandle.send()` to a running child interrupts its run but **starts a
  new turn**, so the child still runs once more and must be told, in natural
  language, to end it.
- `PaseoAgentHandle.archive()` ends the child but destroys what the user may
  want to inspect. It also breaks a product rule: only the user may archive or
  delete an agent.
- The `canceled` reason does not say **who** canceled the turn. A user's Stop and
  a turn replaced by a new message look alike, so the plugin must re-read the
  agent's status and guess.

## Proposed minimal API

Any one of these would solve the use case; the first is the smallest.

### Option 1 — cancel on the agent handle (preferred)

```ts
export interface PaseoAgentHandle {
  // ...existing members
  /**
   * Cancels the agent's current run, like the app's Stop button.
   * Resolves when the run is canceled, or immediately when the agent is idle.
   * Does not archive the agent and does not start a new turn.
   */
  cancel(): Promise<void>;
}
```

It would delegate to the existing `DaemonClient.cancelAgent(agentId)`.

### Option 2 — say who initiated a cancel

Either extend the existing outcome:

```ts
export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | {
      kind: "canceled";
      reason: string;
      initiator?: "user" | "agent" | "plugin" | "replaced";
      initiatorAgentId?: string | null;
    };
```

or add a dedicated event, or a before-hook:

```ts
"agent.canceled": {
  agent: PluginHookAgent;
  initiator: "user" | "agent" | "plugin";
  initiatorAgentId: string | null;
};

// PluginBeforeRequests
"agent.cancel": { agentId: string; initiator: "user" | "agent" | "plugin" };
```

Option 2 alone does not let a plugin cancel children, so it complements Option 1
rather than replacing it.

## How paseo-bm would use it

```ts
on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
  if (!isWorker(agent.provider) || outcome.kind !== "canceled") return;
  // With Option 2: return unless outcome.initiator === "user".
  const { entries } = await paseo.agents.list(/* this workspace */);
  for (const child of runningReviewersOf(entries, agent.id)) {
    await paseo.agents.ref(child.id).cancel(); // Option 1
  }
});
```

With this, a Stop on the Worker would cancel its running Reviewers at once: no
extra Reviewer turn, no reliance on the Reviewer obeying a text notice, and no
guessing from a status re-read. Children would never be archived, so the user
could still open them.

The remaining side effect, the "finished" notification that wakes a stopped
parent, is a separate topic. We mention it only as context: an option to skip
that notification for a child canceled because its parent was canceled would
remove it.

## What paseo-bm does until then (for context)

- The plugin detects a canceled `bm-worker` turn, re-reads the Worker's status,
  and if it is not running sends a fixed stop notice to its running
  `bm-reviewer` children. The Reviewer's instructions tell it to reply with one
  line and end its turn.
- The Worker's instructions tell it, when woken right after an interrupted turn,
  to cancel running Reviewers with the `cancel_agent` MCP tool, send a final
  report and stay idle.

Both paths depend on agents following their instructions, which is why we
would like a real cancel.

---

*Revision 2026-09-25: still open and not sent. The workaround described above is what paseo-bm 0.3.0 ships (`plugin/server/stop-propagation.ts`; the Worker's Stop section in `plugin/roles/worker.md`). Not re-checked against the Paseo 0.9.x plugin SDK.*
