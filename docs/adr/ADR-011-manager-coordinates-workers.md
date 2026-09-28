# ADR-011 — Manager coordinates Workers itself within what the user has decided

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-25 |
| Owner | hieu.nt10 |
| Related | [PRD REQ-021, REQ-025, REQ-026](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-005](ADR-005-manager-as-agent.md) (extends decisions 3 and 5) · [Technical Design §10](../design/paseo-bm.md) · `plugin/roles/manager.md` |
| The owner's decisions | 2026-09-25: Q1 (c), Q2 (a) of `req-20260925T051841Z` |

## Context

Manager is the only agent that sees all the Workers of a workspace, and it is already allowed to read both their state and their activity lines (the owner's decision P2-3, 2026-09-24). But it is not allowed to **do anything** with what it sees besides telling the user.

On 2026-09-25 that became a real bug. The user decided `B7 a` for Worker B (`req-20260925T045037Z`): postpone until Worker A is done and has committed. Worker B sent a `finished` report in the postponed state and then rested. Worker A (`req-20260925T033834Z`) finished the 0.3.0 release and sent a `finished` report. Manager **could read** that report, said correctly that the condition was met — and then still wrote "send me a line and I will wake it up" and stood waiting for the user to type "Go on". The user became the relay for a fact Manager already held in its hands.

The cause lay in the role instructions themselves, not in the facts: rule 2 (`YOU ARE A RELAY, NOT A DECIDER`) was read as "never send a Worker anything the user has not typed", and the "Talking to the user" section said to leave a `finished` Worker resting. Manager lacked the permission, not the information.

## Decision

1. **Manager is a coordinator, not only a relay.** It may message a Worker itself to continue the work: wake a waiting Worker, and order the Workers that touch the same files, beads or git history — even when the user has not stated any condition.
2. **Act only on what has been verified.** The condition must be seen through a readable source: another Worker's report, `get_agent_status`, `git`, or `br`. A guess, or "it must be done by now", is not a basis.
3. **Answer facts yourself, ask about decisions.** A Worker's question that only asks for a fact Manager can read is answered by Manager itself (a `BM-ANSWERS` block, with the source). Scope, approach, trade-offs, work the user must do themselves, and everything in REQ-026 (d) still go to the user — Manager never chooses in their place.
4. **Handing off is still immediate.** Coordination applies only to waking and continuing; it does not delay creating a Worker (REQ-021, metric M-10 ≤ 60 seconds unchanged). Holding a Worker back means **telling it at creation time** whom it is waiting for and what for — not holding the request back; while waiting it decides for itself what it can do.
5. **Say it before and after.** When it sees that a Worker will have to wait, Manager says at once that it will wake it itself, and on which condition — never "send me a line and I will do it". Once it has sent, one line: what it saw, what it sent. The user can look back over every wake-up.
6. **The rest is unchanged.** Manager still does not do the work itself (ADR-005 decision 3), does not archive or delete agents, does not approve permissions on the user's behalf, does not add requests of its own to the user's words, and does not send into a turn a Worker is running.

**Where the rule is written, and its budget.** The new permission lives in `plugin/roles/manager.md` and only there. That file's `## RULES` block keeps its existing budget — exactly 5 numbered limits, at most 30 lines: the part that belongs to the rules is **one sentence** in rule 2 (what Manager has read about the state of the work it may send, with the source), paid for by tightening the wording of rule 2 itself; the how-to lives in a separate section below. That budget is what keeps the top of the file readable at the tenth turn; adding a permission is no reason to loosen it. Worker's instructions must also accept a `BM-ANSWERS` block written by Manager: an `other` entry may now be the user's words **or** a fact Manager has verified with a source, and anything that reads like scope or approach the Worker asks again under a new number instead of treating it as the user's decision.

## Consequences

**Positive**
- The user stops being the relay for facts Manager already holds; the exact 2026-09-25 case now runs to the end without them typing anything.
- Several Workers in one workspace have someone keeping their order. They share one working tree and one bead store, so ordering is a real job, and Manager is the only place that sees enough to keep it.
- The right to decide the content of the work does not move: the new boundary lies between **fact** and **decision**, not between Manager and Worker.

**Negative / to be accepted**
- Manager may wake a Worker by mistake because it misread a report or a `git log` line. Mitigated by three constraints: there must be readable evidence, the user must be told right after sending, and when unsure, ask.
- Manager spends extra turns reading state, so extra tokens for every request with several Workers.
- This is a behavioural guardrail in the instructions, not code: no Paseo layer prevents Manager from sending a sentence it should not send (REQ-026 c).
- A Worker woken by Manager's words rather than the user's, so the Worker's chat history is no longer made up only of the user's words. Manager must state the source in the very sentence it sends.

## Alternatives considered

- **Keep the absolute relay.** Simple and easy to check, but that is exactly the bug the user reported: the product makes them type again what the machine already knows.
- **Only enforce conditions the user has stated** (Q1 a of this request). Enough for the 2026-09-25 case and less risky, but still leaves Manager standing still when two Workers collide in a way the user has not thought of yet. The owner chose (c).
- **The plugin wakes Workers itself in code** (a hook that counts conditions and sends on their behalf). More deterministic, but contrary to ADR-005 decision 2: the plugin does not guess what the user means; the reasoning belongs to the agent.
