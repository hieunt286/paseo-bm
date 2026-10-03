# ADR-023 — The owner delegates a class whenever they choose: no eligibility gate

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-01) — decided by the owner |
| Date | 2026-10-01 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-018](ADR-018-calibrated-autonomy-per-class.md) decision 4's promotion rule — "proposed by evidence", and a cell may become `delegate` only at ≥ 90 % agreement over ≥ 20 decisions across two weeks with no reversal; its decision 5's "the predictor that earned it"; and its consequence "two weeks of data is the minimum before any cell can be delegated". Every other part of ADR-018 stands: the classes, the matrix, shadow and the agreement ledger, automatic demotion, the four hard-owner classes, precedents |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-121, REQ-122, REQ-123, Q-105 · [Autonomy design](../design/paseo-bm-autonomy.md) §B.2–§B.4, §B.9, §A.12, §G.4 · [change-013](../archive/plans/paseo-bm-plan-autonomy-change-013-delegation-without-eligibility.md) |
| The owner's decisions | 2026-10-01, on the eligibility gate: "Remove this condition from the product entirely; the machinery is too cumbersome. The user turns delegation on whenever they like." |

## Context

ADR-018 let a class become `delegate` only once a predictor had earned it: at least 90 % agreement over at least 20 of the owner's answers, spanning at least 14 days, with no reversal. The gate lived in three places:

- **Insights** offered **Delegate?** only on a cell that passed `eligibility`;
- **Settings → Autonomy** never offered `delegate`, only Owner and Shadow;
- **advice** refused a prepared `autonomy.set` to `delegate` on a cell that had not earned it.

The `autonomy.set` RPC itself never checked eligibility. A demoted class's alert also cleared once the class was eligible again, which needed a re-check after every settlement.

On the field data the gate was never met. The baseline counted 0 eligible cells: the recommended option agrees about 80 % on the delegable share. The owner could therefore not delegate a class they were willing to hand over. Meanwhile the product carried thresholds, a span rule, an "earned" offer, an extra refusal in advice and a renewal check, all to hold back a choice that is the owner's to make.

## Decision

1. **The owner can set any delegable class to `delegate` at any time**, with either predictor: the recommended option or the Orchestrator. There is no threshold of agreement, count, span or reversal.
2. **Settings → Autonomy is where it is set.** Each delegable row offers Owner, Shadow and Delegated. Delegated asks who decides and then one confirmation that says what changes; Cancel comes first and is the default.
3. **The agreement ledger is information.** Insights keeps showing agreement, counts and reversals per class and predictor. Its **Delegate?** stays as a shortcut to the same confirmation, on any delegable class not yet delegated, and is never required.
4. **Advice may prepare a delegation of any delegable class.** It is still applied only on the owner's own answer.
5. **The eligibility code is removed outright**, with no compatibility layer (REQ-171): the pure `eligibility`, its thresholds and reasons, the renewal check of demotion alerts, the "earned" refusal of prepared changes, and the `delegation-eligible` finding. That finding is replaced by a plain `agreement` figure.
6. **Unchanged.**
   - Release, data, security and cost are never delegable. That is a safety rule, not the gate.
   - `delegate` still needs `confirmed: true`.
   - A reversal or an override of a delegated decision demotes the class to `shadow` at once, with an Inbox alert. The alert now clears when the owner next sets that class or resets the project.
   - `owner` and `shadow`, the challenger, precedents, overrides, the action boundary, and owner-only prepared changes stay as they are.

## Consequences

- **The owner can hand over a class on day one.** The risk of a poor predictor is carried by demotion, by the digest's one-action override, and by **Return all to owner**, not by a waiting period. The confirmation says so.
- **Settings and the confirmation are the safety step.** The owner reads who decides and how it is taken back; agreement figures are in Insights for whoever wants them first.
- **Less code and fewer moving parts:**
  - no thresholds to tune;
  - no re-check of the ledger after every answer;
  - no difference between what Settings and Insights may set;
  - one confirmation text shared by both.
- **The field evaluation changes where it measured the gate** ([change-013](../archive/plans/paseo-bm-plan-autonomy-change-013-delegation-without-eligibility.md)):
  - A-4 and A-5 per delegated class count from that class's delegation;
  - the Phase 2 exit's checks of eligibility no longer exist;
  - the delegation window counts from the owner's first delegation.
- **The `demotions` times stay in `policy.json`.** The ledger and Insights still count a demoted class's agreement from its last demotion, as information.

## Alternatives considered

- **Keep the gate.** Rejected by the owner: on the field data no cell ever met it, and the machinery outweighed its benefit.
- **Lower the thresholds** (for example 80 % over 10 answers). Rejected: still a gate between the owner and their own choice, with the same machinery, only tuned.
- **Keep the gate only for the Orchestrator predictor.** Rejected: the owner asked for the condition to go from the product entirely. The Orchestrator's cost and accuracy are stated in the confirmation and measured in Insights, and demotion applies to it as to the recommended option.
