# ADR-024 — Structure, not words, tells a stop from a cut and a wait from a stall

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-01) — approved by the owner |
| Date | 2026-10-01 |
| Owner | hieu.nt10 |
| Related | [Base design](../design/paseo-bm.md) §7.5 · [Orchestrator design](../design/paseo-bm-orchestrator.md) §6 · [Autonomy design](../design/paseo-bm-autonomy.md) §A.8 · `plugin/server/interruption-watch.ts`, `plugin/server/stall-watcher.ts` |
| The owner's decisions | 2026-10-01: the cut must be judged from structure — "if it is only text, would other text later do the same?" — and the product must tell work that is truly done from a flow that broke while the work is unfinished. "I agree to do it." |

## Context

On 2026-10-01 the owner's project `paseo-bm-site` stopped moving after the Orchestrator's commands:

1. The Manager called `cancel_agent` on a Worker. The call worked, but the Worker's finish notice reached the Manager while that call was still running. Paseo delivers a message to a running agent by **replacing its turn**, so the call was cut.
2. Claude Code reported the cut call as "The user doesn't want to proceed with this tool use … STOP what you are doing and wait for the user".
3. The Manager said "I've stopped, as you asked. I didn't cancel the Worker" (it had) and waited for the owner.
4. The other Worker was `blocked` on a question the policy had already answered, and waited for the Manager's go.
5. Nobody ran, nothing was finished, and the stall pass said nothing: a `blocked` report counted as "waiting on the owner".

The trace store held 126 such cuts over two weeks. In at least 10 of them the agent believed the owner had stopped it or declined something. One Worker told the Orchestrator that the owner had "declined" an e2e run; in fact a Reviewer had finished. That claim then went into the Orchestrator's next command.

Two readings of words were failing:

- The **agent** read Claude Code's words as the owner's stop.
- The **stall pass** read the Worker's `phase: blocked` as a question waiting in the Inbox.

Teaching agents to recognise the words instead would be just as fragile:

- The wording is the provider's to change.
- The cause differs from one cut to the next.
- Any agent can write the same words to make another agent ignore a real stop.

## Decision

1. **A cut is recognised from what Paseo records, never from text** (`isPaseoInterruption`). All four signals must hold:
   - the agent's turn ended `canceled`;
   - its next turn started within 3 s of that;
   - the next turn holds no owner-typed message (`clientMessageId`, `origin: user`);
   - there was no `agent.permission_resolved` deny for the agent in between.

   The owner's own Stop starts no turn by itself. The owner's message is owner-typed. The owner's deny is reported.
2. **The plugin tells the agent, with a notice: `BM-INTERRUPTED`**, through the notice queue, to a Manager or Worker on `claude` or `codex`.
   - It is sent only if, 20 s after that turn ended, the agent is idle, has started no newer turn, and no agent it created is running. An agent that carried on has one of these.
   - At most one notice per agent per 10 minutes.
   - The text says the cut was Paseo's. The agent checks whether the cut call took effect, does it again if not, and carries on. The owner's later message always wins.
   - It is a plugin notice (`isPluginNotice`), never the owner's words.
3. **Waiting on the owner means an unsettled decision of the request**, read from the decision store (`q:`, `o:`, `h:`, `f:`), not from a report.
   - `idle-unfinished` holds when the last report is not `finished`, no decision of the request is unsettled, and nothing happened for 5 minutes.
   - A Worker that waits on another agent, or that asked only in chat words, therefore stalls. The stall raises an Inbox alert, and an event for the Orchestrator where the policy's scope covers the project.
   - When the store cannot be read, a `blocked` report counts as waiting, as before.
4. **The role files point at the structure, not at the words.**
   - `worker.md` counts `BM-INTERRUPTED` among the messages that are no stop.
   - Its `blockers` line says that the owner is waited on only through `BM-QUESTIONS`.
   - The Manager's existing rule — a `BM-` notice says what to do — covers the notice.

## Consequences

- **The stop that broke the site project ends within about 20 s.** The agent still writes its mistaken "I stopped" once, because a plugin cannot change a turn that is running. The next turn is the notice.
- **The stall pass now catches every flow that broke while the work is unfinished**, including kinds not seen yet: a circular wait, a question asked only in chat, a misunderstanding. A request is either done (`finished`), working (an agent of it runs), waiting on the owner (a decision in the Inbox), or stalled.
- **Some notices land on an agent that had already gone on**, for example a Worker that read a Reviewer's pass and reported. It replies `noted`: one short turn, which also wakes its Manager once. The cooldown keeps that from repeating.
- **What the plugin cannot see:**
  - OpenCode reports no `permission_resolved`, so a cut there is never claimed.
  - After a plugin reload the first cut of each agent is missed, because the previous turn is kept in memory.
  - The Orchestrator's turns are not recorded by the collector, so it is not watched.

  In each case the stall pass is the safety net.
- **No on-disk schema changes.** `BM-INTERRUPTED` is a new notice. An agent created before it reads the text, which says by itself what to do.
