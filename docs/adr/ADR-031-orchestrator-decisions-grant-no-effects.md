# ADR-031 — An answer to an Orchestrator decision grants no effect

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-09) — Claude under the owner's delegation; the owner may reverse it |
| Date | 2026-10-09 |
| Owner | hieu.nt10 |
| Amends | [ADR-017](ADR-017-decisions-are-stored-objects.md) decision 4 ("an answer in the owner's own words grants the effects the decision declared, for one use within 60 minutes"), for `o:` decisions only |
| Related | [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) decision 8 · [missions design](../design/paseo-bm-missions.md) §9.1, §17 · `plugin/shared/decisions.ts` `answerDecision` · `plugin/server/orchestrator-decisions.ts` |
| Lane | Designed: the Orchestrator's authority |

## Context

ADR-017 let an owner's answer to an Orchestrator decision (`o:`) grant the effects it declared, so the Orchestrator could then send one command carrying them. ADR-029 made the Orchestrator a process governor: it sends a Main commands without effects (`governor:*`), stops a Worker only on real risk, and no longer briefs, corrects or answers Workers. After that change, the grant could still be spent by the Orchestrator's own command, which gave it an authority path to effects that ADR-029 took away.

## Decision

1. An answer to an `o:` decision, or an override of one, grants nothing, whether it comes from the owner, a precedent or the policy.
2. An option may still name effects, as information for the owner. A prepared command the owner taps goes to the Main with `approved: none` and every limit.
3. A Worker's effects come only from the owner's answers to that Worker's own questions and from the repo's action boundary. Worker (`q:`) and mission (`m:`) decisions are unchanged.
4. `BM-ANSWER` names no grant.

## Consequences

- The Orchestrator has no path to an effect. Its commands are governor steps, prepared commands without approvals, or a stop.
- Stored grants from an earlier build stay readable and can no longer be spent by an Orchestrator command.
- The Inbox shows no grant tag on an `o:` card.

## Alternatives considered

- **Keep the grant for prepared commands only.** That would leave one path for the Orchestrator to carry effects to a Main, which then passes them to a Worker. Rejected: effects stay with the request's owner and its repo.
