# ADR-021 — The Orchestrator is a measured coordination controller: it may compact agents and have the Manager hand work over

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-30) — decided by the owner |
| Date | 2026-09-30 |
| Owner | hieu.nt10 |
| Supersedes | The workflow assessment of ADR-014/ADR-016 as a way to change the process (its suggestions appended to instructions); Appendix B of the autonomy PRD already retires it |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-126–128, REQ-134–136, A-8, A-12 · [Autonomy design](../design/paseo-bm-autonomy.md) Part G · [ADR-017](ADR-017-decisions-are-stored-objects.md) · [ADR-018](ADR-018-calibrated-autonomy-per-class.md) · [ADR-020](ADR-020-paseo-tools-policy-per-role.md) |
| The owner's decisions | 2026-09-30: (1) the Orchestrator may request handoff and compaction on its own initiative, without the owner's approval, configured in Settings; (2) the Manager coordinates a handoff; the Orchestrator may have both a Manager and a Worker compact; (3) the Orchestrator advises proactively after every few rounds of work, the number set in Settings; (4) the measurement is built in Phase 2, compaction and handoff in Phase 3 |

## Context

The field replay of 2026-09-30 (75 requests with a Worker, 71 finished) shows three things.

- **Tokens.** The Worker spends 93 % of all tokens. The heaviest 10 % of requests use 50 % of the Worker's tokens, and in those requests the second half of the turns costs 59 %: every model call re-reads a context that keeps growing.
- **Speed.** Requests stop to ask the owner 3.2 times each, and the owner's answer takes a median 5 minutes (p90 53).
- **Quality.** Reviews find 1.35 blocking findings per batch, so review is catching real faults and must not be cut to go faster.

Phase 1 made the Orchestrator a judge woken only for judgement, and it now answers questions through the decision store. But it cannot act on context size, and its "workflow assessment" changed the process by appending unmeasured prose to instructions.

Paseo gives a plugin no call to compact an agent. Its timeline records compactions, manual ones included (`compaction` items with `trigger: auto | manual` and `preTokens`), and its usage type carries `contextWindowUsedTokens` / `contextWindowMaxTokens` where a provider reports them. The Orchestrator has no Paseo tools (ADR-020), and the Manager is the role that creates Workers (the role-pairing check, ADR-020 decision 3).

## Decision

1. **A control loop, not a chat partner.**
   - Code observes (traces, reports, decisions, tokens) and detects (thresholds, events). It wakes the Orchestrator only when a trigger fires.
   - The Orchestrator diagnoses and chooses the lightest intervention that will do. The intervention ladder is: advise the Manager → correct the Worker (the Manager copied) → change the structure (compaction, handoff, re-plan) → stop → the owner.
   - Code records each intervention with its expected outcome and checks it after a window.
2. **Compaction.**
   - The Orchestrator may have a Manager or a Worker compact its context on its own initiative, within Settings. It uses a plugin tool, because it has no Paseo tools.
   - The plugin sends the provider's compaction command at the agent's next idle moment after a safe point, then a state brief built from the stores.
   - Whether and how each provider compacts on request is verified before it is relied on. A provider that cannot compact falls back to a handoff (Worker) or to nothing (Manager).
3. **Handoff through the Manager.**
   - The Orchestrator may ask a Manager, on its own initiative and within Settings, to hand a Worker's request over at a safe point. The Manager creates the successor with a handoff brief the plugin built from the stores (the artifacts, not the conversation), plus the outgoing Worker's short note.
   - The outgoing Worker is marked replaced, never archived (agents belong to the owner).
   - The successor verifies again before it reports anything done.
4. **Settings bound it.** Compaction and handoff are switched on or off, each on its own, with their thresholds and limits. The Orchestrator may propose a change to them only as an owner decision.
5. **Advice replaces assessment.**
   - After every N finished requests of a project (Settings, default 5, 0 = off), and whenever the owner asks, the Orchestrator turns the project's measured findings into owner decisions with a prepared change: a precedent, a policy, a threshold or a review budget.
   - Nothing is appended to an agent's instructions.
6. **Measured before trusted.** A-12 (interventions that reached their expected outcome) is kept per intervention kind. A kind below its target is off by default until it recovers. The measurement of context and tokens (Phase 2) comes before compaction and handoff (Phase 3) and sets their default thresholds.

## Consequences

- The Orchestrator acts without the owner's approval on context and structure. That is bounded by Settings, by safe points, by the Manager executing handoffs, and by every intervention being logged, shown in the Inbox digest and measured.
- Quality gates are untouched: no review or check is skipped to save tokens or time; blocking review findings are never waived by the Orchestrator; hard-owner effects keep their grants (ADR-017).
- A-8 gets a reduction target for Phase 3 on the heaviest requests.
- The workflow assessment, its tool and its section of the Orchestrator's instructions go in Phase 2 (autonomy design §B.9).

## Alternatives considered

- **The owner approves each compaction or handoff.** Rejected by the owner: it would add owner waits, the delay the programme is removing.
- **The plugin creates the successor Worker itself.** Rejected: the Manager owns its Workers and the request's context, and a plugin-created Worker trips the role-pairing check.
- **Rely on the provider's own compaction near the window's end.** Rejected as the only mechanism: a Claude Worker's window is 1,000,000 tokens, so it rarely triggers, and the cost is the re-reading long before that.
- **Keep the workflow assessment.** Rejected: its suggestions were unmeasured and drifted into every project's instructions.
