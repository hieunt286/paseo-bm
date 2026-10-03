# ADR-015 — Orchestrator: Autopilot per project, and the owner's word in chat counts as approval

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — owner decisions of the same day; decision 4's "commands go to Managers only" and its limit sentence **amended** by [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-014](ADR-014-orchestrator-agent-proposes-owner-approves.md) decisions 4 ("only the owner's click sends") and 5 (wake only on stalls); ADR-014's other decisions stand |
| Related | [Orchestrator PRD](../archive/product/paseo-bm-orchestrator-prd.md) · [Orchestrator Design](../design/paseo-bm-orchestrator.md) · [ADR-011](ADR-011-manager-coordinates-workers.md) |
| The owner's decisions | 2026-09-29, after using ADR-014 on the real daemon ("it does nothing on its own and makes me relay and confirm a lot"): **Autopilot per project** — the Orchestrator answers its agents' questions and commands the Manager without asking; it reacts **as soon as** an agent asks the owner something or reports a step finished; limits kept: **no commit, push or deploy for the owner**, **no touching real data**, **ask the owner on big decisions**; nothing else limited |

## Context

In the owner's first real session with ADR-014 the owner said "decide it yourself", "send it", "go on and decide" in the Orchestrator's chat five times; each time the Orchestrator answered that only a click on the tab could send, and a merged, corrected command could not even be proposed because one proposal was already pending. The watcher, meanwhile, missed the request that was waiting (a defect of its newest-request rule). The approval-per-command model turned the owner into a relay.

## Decision

1. **Autopilot is set per project, by the owner.** On the Orchestrator tab each project has an **Autopilot** switch (off by default; turning it on asks for confirmation). The owner may also ask the Orchestrator in its chat to turn it on or off; the plugin accepts that only right after a message the owner typed in the app (decision 3).
2. **With Autopilot on, the Orchestrator acts on its own in that project:** it answers the Worker's and Manager's questions and sends commands to the Manager directly, and the plugin wakes it **as soon as** a request of that project reports a question to the owner (`blocked`) or a finished step (`finished`), besides the stall situations. Everything it sends is recorded and shown on the tab.
3. **With Autopilot off, the owner's word in the Orchestrator's chat is an approval.** The Orchestrator may send a command when the most recent message in its own chat is one the owner typed in the app (it carries `clientMessageId`), so "send it" / "chốt" in chat is enough; the tab's **Send** button stays. Otherwise it proposes, and a new proposal for the same Manager and request **replaces** the pending one.
4. **Limits that always hold, whatever the mode:** every command the Orchestrator sends ends with a fixed line telling the Manager not to commit, push, deploy or touch real data unless the owner said so; the Orchestrator's instructions forbid asking for those, and require it to **ask the owner** (a "Needs you" card and a line in its chat) on big decisions — security, cost, a large change of scope, anything irreversible. Commands still go to Managers only; the plugin still never stops, archives or deletes an agent.
5. **Seeing enough to decide:** the Orchestrator's tools return agents' messages and reports long enough to read a question with all its options.

## Consequences

- The owner can hand a project to the Orchestrator and only hear back on big decisions; for other projects a word in chat replaces the trip to the tab.
- Messages now reach Managers without a click: by the owner's standing Autopilot delegation, or by the owner's word in chat. The fixed limit line and the instructions are the guard; a wrong answer by the Orchestrator costs a Worker turn, not data (it cannot commit, push, deploy or touch real data on its own authority).
- Each question and finished step in an Autopilot project costs one Orchestrator turn.
- An approval in chat is recognised by the latest inbound message in the Orchestrator's chat carrying `clientMessageId`; a plugin notice (`BM-STALL`, `BM-EVENT`) never does.

## Alternatives considered

- **Keep click-only approval (ADR-014)** — rejected by the owner after using it.
- **One Autopilot switch for all projects** — rejected by the owner; delegation is a per-project decision.
- **React only to stalls (5/15 min)** — rejected by the owner; a question should be answered as soon as it is asked.
- **Give the Orchestrator Paseo's `send_agent_prompt`** — rejected: the plugin could no longer enforce the mode, the limit line or the record of what was sent.
