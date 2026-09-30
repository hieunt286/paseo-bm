# ADR-018 — Autonomy is set per project and decision class, and earned from measured agreement

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — approved by the owner with the autonomy design |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-015](ADR-015-orchestrator-autopilot-per-project.md) decisions 1–2 (Autopilot, one switch per project); [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) decision 3's "Allow…" categories |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-120 → REQ-125 · [Autonomy design](../design/paseo-bm-autonomy.md) Part B · [ADR-017](ADR-017-decisions-are-stored-objects.md) |
| The owner's decisions | 2026-09-29: new installs start with every class `owner` and shadow on; two weeks of shadow before the first promotion; release, data, security and cost never delegated |

## Context

Autopilot hands a whole project to the Orchestrator or nothing. The field replay shows the owner took the Worker's recommended option in 267 of 339 answers (79 %), and chose otherwise mostly on scope, release, environment and preference — so some kinds of decisions could be delegated safely and others could not, and a project-wide switch cannot tell them apart. Agreement alone can also hide anchoring: an owner may take the recommendation because it is recommended.

## Decision

1. **Every decision has a class** from a fixed list (reversible-technical, scope, preference, environment, dependency, release, data, security, cost). The asker proposes it; the plugin checks it against the declared effects; on conflict the riskier class wins.
2. **The policy is a matrix of project × class**, each cell `owner`, `shadow` or `delegate`. `release`, `data`, `security` and `cost` are fixed to `owner` (they pass only through a one-use grant, ADR-017).
3. **Shadow records predictions** next to the owner's answer: the Worker's recommendation (free) and, where the owner turns it on, the Orchestrator's prediction. The agreement ledger and the reversal tracking (later reopened, overridden or contradicted) are computed from the decision store.
4. **Promotion is proposed by evidence and applied by the owner:** a cell may become `delegate` only when its predictor agreed on at least 90 % of at least 20 decisions over at least two weeks with no reversal; the owner confirms. **Demotion is automatic** on an override or a reversal.
5. **A delegated decision is decided by the predictor that earned it** — the recommendation by code, or the Orchestrator — and is visible in the Inbox digest with its reason and a one-action override.
6. **Precedents:** an owner decision can be saved as a precedent (project or all projects, with an expiry); agents are given the active precedents when they are created, and a question that cites or matches a precedent by subject is resolved by it within the policy.

## Consequences

- The Autopilot switch, **Allow…** and the Watch switch are removed; the settings screen shows one matrix per project.
- Decisions the owner keeps still reach the owner exactly as ADR-017 describes.
- The Orchestrator's prediction in shadow costs tokens; it is off unless the owner turns it on per project.
- Two weeks of data is the minimum before any cell can be delegated.

## Alternatives considered

- **Keep Autopilot per project** — rejected: it cannot separate a safe class from an unsafe one.
- **Delegate by a model's self-reported confidence** — rejected: not calibrated, not verifiable; agreement with the owner is measurable.
- **Promote automatically when the threshold is met** — rejected: the owner keeps the decision to hand over authority.
