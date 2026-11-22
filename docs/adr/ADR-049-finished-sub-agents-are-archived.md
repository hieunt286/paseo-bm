# ADR-049 — Finished sub-agents are archived when nothing touched them for the owner's window

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-16 |
| Owner | hieu.nt10 |
| Amends | [ADR-005](ADR-005-manager-as-agent.md) decision 5 ("No agent may archive or delete an agent"), for Workers and Reviewers whose work is finished for good; the "keeps ADR-005" lines of [ADR-011](ADR-011-manager-coordinates-workers.md), [ADR-034](ADR-034-each-mission-has-its-own-workspace.md) and [ADR-035](ADR-035-a-delivery-line.md) for the same case; [ADR-021](ADR-021-orchestrator-measured-coordination-controller.md)'s "never archived" for a replaced Worker, which is archived like any other once its request is finished for good |
| Keeps | Deleting stays the owner's alone; Mains, Orchestrators and agents with no request paseo-bm knows are never archived by paseo-bm; ADR-042's presences |
| Sources | Owner's chat of 2026-11-16 (no requestId): "Hãy có thêm cơ chế orchestrator thực hiện dọn dẹp archive các sub agent sau khi công việc đã xong dứt điểm và lâu không đụng vào" |
| Tracking | The bead labelled `feature:agent-cleanup` |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** agent lifecycle (a recorded safety boundary), agent-role behaviour, one additive coordination setting.
- **Required artifacts and gates:** this ADR, the delivery line design §20, PRD REQ-221 and REQ-026 (f), one manual bead; `design-ready` self-checked under the owner's delegation; one code review.
- **Execution path:** design section, then implementation and its tests in one bead, then review and verify. No plan: the work has no prerequisite graph.
- **Decided:** 2026-11-16 — the owner asked for the mechanism; Claude chose the eligibility rule, the default window and the switch, after checking on an isolated daemon that an archived agent comes back, history kept, when it is sent a message.

## Context

A mission creates many sub-agents: AIX created 67 Workers in eight days, each with Reviewers. When a request ends, its Workers and Reviewers stay listed for good, because ADR-005 left their lifecycle to the owner, so the sidebar fills with agents nobody will use again. Paseo's archive is a soft delete: the agent leaves the list, keeps its conversation, and comes back when it is sent a message.

## Decision

1. **The governor archives finished sub-agents.** A paseo-bm pass, run by the plugin under the Orchestrator's governance and costing no agent turn, archives every Worker and Reviewer that is finished for good and was left alone for the owner's window. The Orchestrator agent itself still archives nothing by hand.
2. **Finished for good** means all of these:
   - the agent carries paseo-bm's `worker` or `reviewer` label and a request paseo-bm knows;
   - that request is finished, and so is the newest request of its continuation chain;
   - no outbox record waiting for the agent or for any request of that chain;
   - no open decision of that chain;
   - no open or taken peer link with the agent or a request of the chain at either end;
   - the agent is not running or starting and has no pending permission.
3. **Left alone** means that neither its activity nor the owner's last message to it is newer than the window: three days by default, from one to thirty.
4. **Archive, never delete.** paseo-bm uses Paseo's archive. Each archive is written in its mission's journal, or logged for a request of no mission. The owner restores an agent by opening it and sending a message. Its paseo-bm tool binding is revoked as for any archived agent, so new work goes through its Main as a new request.
5. **The owner's switch.** **Settings → Coordination → Archive finished agents** turns the pass off, and sets the window. It is on by default. The pass runs at most once an hour.

## Consequences and proof

- The sidebar keeps only live work and the agents the owner touched recently; nothing is lost, because an archived agent keeps its history and can be restored.
- A late delivery for an archived agent finds it gone and is told as ADR-042 says. The eligibility rule leaves none waiting when it archives.
- Tests prove each eligibility condition both ways, that the window and the switch are read, that only one pass an hour runs, that Mains, Orchestrators and unlabelled agents are never archived, that unreadable settings or stores archive nothing, and that each archive is journaled.
