# ADR-005 — Beads Manager is an agent; the plugin is only the entry point and the observation board

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-15 |
| Owner | hieu.nt10 |
| Related | [PRD REQ-020, REQ-021, REQ-026](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-006](ADR-006-role-registration.md) · [Technical Design](../design/paseo-bm.md) |
| Extended by | [ADR-011](ADR-011-manager-coordinates-workers.md) — Manager coordinates Workers itself (Accepted 2026-09-25); decisions 3 and 5 here are unchanged |

## Context

The owner's requirement: the user **chats** with Beads Manager; Manager **immediately hands** the work down to a Beads Worker; Manager is responsible for managing and controlling the agents and answering about their progress; the user **can chat directly with Worker**; and **only the user** closes or deletes a Worker.

There are two ways to realise this, and they lead to two quite different products:

1. **Manager is the plugin's interface** — a panel with an input box, and daemon-side code that receives the request and calls the SDK to create a Worker.
2. **Manager is an agent** — the user chats with it like any other agent; it decides for itself and calls tools itself to create, follow and nudge.

Facts verified on a real daemon (Paseo 0.8.0, 2026-09-15):

- An agent created by another agent is still **a first-class agent in the workspace**: it appears in the agent list, carrying only an extra `paseo.parent-agent-id` label. `paseo agent open|send|stop|archive|delete` are available.
- That means the user can open, chat with, stop, archive or delete a child agent **directly** — the parent–child relation is only descriptive data, not a wall.
- Paseo gives an agent a set of tools to create and follow other agents when the permission is open (see ADR-006).

A Paseo plugin **cannot read the chat** of another agent; it receives only what the user actively sends to it. So option 1 would force the user to type requests into a separate box instead of chatting normally, and every back-and-forth clarification would have to be rebuilt from scratch in the plugin's interface.

## Decision

1. **Beads Manager is an agent**, running in the user's workspace, using the tools and model the user configured at install time.
2. **The plugin does not do Manager's work.** The plugin's role comes down to three things:
   - **Entry point:** a sidebar item and a Command Center item to open Manager for the current workspace; create it if there is none, reopen it if there is one.
   - **Observation board:** show paseo-bm's agent tree in the workspace (Manager → Worker → Reviewer) with states, so the user sees the whole picture without searching through the agent list.
   - **Setup:** register the roles and instructions (ADR-006).
3. **Manager hands off immediately and does not do the work itself.** Receiving a request means creating a Worker; Manager itself writes no documents and creates no beads.
4. **Worker and Reviewer are first-class agents.** The user can chat with them directly, stop, archive and delete them.
5. **The lifecycle is the user's decision.** No agent may **archive or delete** an agent. Manager **may stop** a Worker that has gone astray or hangs, because stopping can be recovered from whereas deleting loses the history; stopping a Worker must also stop the Reviewer it is running. When done, the Worker reports and then rests, waiting for the user to deal with it. *(Clarified 2026-09-15 after the review pass pointed out that REQ-020d and REQ-026f contradicted each other.)*
6. **Worker stops and asks** before decisive actions: editing a frozen document, expanding scope, deleting or merging existing beads.

## Consequences

**Positive**
- Clarifying exchanges happen naturally in the chat, where the user is already used to them, instead of in a home-made input box.
- Manager inherits for free everything Paseo already does well: conversation history, permission approvals, notifications, the mobile interface.
- A clear boundary of responsibility: the plugin handles setup and observation, the agent handles reasoning. Plugin-side code does not have to guess what the user means.
- The user can intervene at every level, including talking directly to Worker when Manager has misunderstood.

**Negative / to be accepted**
- **One more model session** for Manager, even though most of what it does is relaying and summarising. That is the price of being able to chat and decide.
- Behaviour is less deterministic than a piece of code: Manager may misinterpret a request. Mitigated by a prepackaged set of role instructions (REQ-032) instead of letting the user write them each time.
- The plugin must open the right tool permissions for Manager and Worker, and those are permissions to create and stop other agents — a real security boundary (ADR-006).
- Manager does not read other agents' conversations. So "knowing the progress" stands on two legs: **structured reports that Worker actively sends back** at each milestone (REQ-034), plus the state and activity lines that Paseo's tools return. Without the first leg, Manager only knows whether an agent is alive, not what it has done — this is the gap that the review pass of 2026-09-15 pointed out and REQ-034 fills.
- Cost grows with the number of requests: each request is at least three sessions (the existing Manager, plus Worker, plus Reviewer).

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Manager is the plugin's interface plus daemon-side code | Cheaper and more predictable, but the user must type requests into a separate box and cannot chat back and forth; every clarification of a request has to be rebuilt. Directly contrary to the owner's requirement |
| Manager is an agent but Worker is a hidden child agent that talks only through Manager | Loses the ability to chat directly with Worker that the owner requires; and in practice Paseo still exposes child agents as first-class agents, so hiding them only makes things harder |
| No Manager: the user creates Workers from a profile themselves | Loses the managing and progress-answering part entirely; the user again has to remember the process — exactly the problem this product wants to remove |
| Manager cleans up the Worker itself when done | Contrary to the owner's requirement, and deletes a work history the user may still need to read again |
