# ADR-025 — Autonomy as five levels per project; no class is the owner's by rule

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-01) — decided by the owner |
| Date | 2026-10-01 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-018](ADR-018-calibrated-autonomy-per-class.md) decision 3, that release, data, security and cost are never delegable. Also its automatic demotion on reversal, which [ADR-023](ADR-023-delegation-without-eligibility.md) decision 6 kept. And the predictor choice in ADR-018 decision 5 and ADR-023 decision 1. ADR-018's classes, the decision store, shadow, the agreement ledger and precedents stand. |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) · [Autonomy design](../design/paseo-bm-autonomy.md) Part B · [Dashboard design](../design/paseo-bm-dashboard.md) · [change-014](../plans/paseo-bm-plan-autonomy-change-014-levels-and-flat-surface.md) |
| The owner's decisions | 2026-10-01, on the Settings screen: "a simple slider per project for delegating to the Orchestrator". Level 0: no intervention. Level 1: it may intervene, but it goes to the Inbox for approval before it runs. Level 2: it decides technical, preference, scope, environment and dependency questions. Level 3: as level 2, plus cost, release and data. Level 4: as level 3, plus security. Further: "When I override, just record it; do not lower the project." "Levels 3 and 4: agreed, drop the constraint." "Agreed: drop the choice of who predicts." |

## Context

Autonomy was set as a matrix: nine decision classes per project, each `owner`, `shadow` or `delegate`. A delegated class also chose who answers it, the recommended option or the Orchestrator. A separate "Orchestrator predictions" switch existed per project. Four classes could never be delegated. An override of a delegated answer demoted its class to `shadow`.

The owner found this too heavy to operate. In the field the matrix was never set to anything but the defaults. On 2026-10-01 the owner saw the Orchestrator "not decide" on a project where every class sat in `shadow`.

## Decision

1. **One level per project, 0–4**, set on a slider in Settings. Each level has a short English name:

   | Level | Name | The Orchestrator decides | Every other question |
   |---|---|---|---|
   | 0 | **Hands-on** | nothing | the owner's, as asked |
   | 1 | **Co-pilot** | nothing | the Orchestrator proposes an answer; the owner approves it in the Inbox |
   | 2 | **Cruise** | reversible-technical, preference, scope, environment, dependency | proposed, for the owner's approval |
   | 3 | **Turbo** | as Cruise, plus cost, release, data | proposed, for the owner's approval |
   | 4 | **Full auto** | every class, security included | — |

2. **The level is written as the existing per-class cells**, not as a new store:
   - a delegated class is `delegate` with the Orchestrator as predictor;
   - a proposed class is `shadow` with the Orchestrator's prediction on;
   - Hands-on is every class `owner` with predictions off.

   `autonomy.set-level` writes all nine cells and the prediction switch in one write. The level read back is the one whose pattern the cells match. Cells that match no level read as **Custom** until a level is set.
3. **No class is the owner's by rule.** At Turbo and Full auto the Orchestrator answers questions and held actions that allow a push, publish, deploy, migration, real data or a cost, as the option it picks declares. Choosing either level asks for one confirmation that says so, with Cancel first.
4. **An override is recorded, nothing more.** It is stored with the decision and counted in the agreement ledger, and it never changes a level or a class. Demotion on reversal and its Inbox alert are removed.
5. **The Orchestrator is the only predictor.**
   - The `recommended` predictor is removed, along with the policy's instant answer by the recommended option that never woke the Orchestrator.
   - A stored cell that names it reads as the Orchestrator.
   - The recommended option stays on each card as the asker's advice.
6. **Unchanged.**
   - Every decided-for-you answer shows under Decided for you, where it can be overridden.
   - The action boundary stays per project, off by default.
   - Precedents, the agreement ledger and the decision store are untouched.
   - Credentials are never read, stored or printed by any agent or the plugin, at any level.

## Consequences

- **Setting autonomy is one control per project.** The per-class matrix, the predictor choice, the challenger switch and Insights' **Delegate?** leave the surface.
- **At Turbo and Full auto a release or a security trade-off can happen without the owner.** The owner accepted this in writing.
  - It needs an explicit level and a confirmation.
  - Each answer is visible under Decided for you, and the owner can override it.
  - The owner can lower the level at any moment.
- **Without demotion, a poor answer does not throttle itself.** The owner lowers the level by hand. The agreement figures per class stay in Metrics.
- **The field period's A-4/A-5 per delegated class count from the level change** that delegated the class, as change-013 counted from a delegation.
