# Change Request — Design decisions settled while polishing the Phase 2–6 beads

| Field | Value |
|---|---|
| Change ID | `autonomy-change-003` |
| Short name | Decisions at conversion; bead polish |
| Original plans | [Phase 2](../../plans/paseo-bm-plan-autonomy-phase2.md), [Phase 3](../../plans/paseo-bm-plan-autonomy-phase3.md), [Phase 4](../../plans/paseo-bm-plan-autonomy-phase4.md), [Phase 5](../../plans/paseo-bm-plan-autonomy-phase5.md), [Phase 6](../../plans/paseo-bm-plan-autonomy-phase6.md) (Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-30 |
| Accepted | 2026-09-30 — approved by Claude under the owner's delegation; the owner asked for the beads to be polished |
| Applied | 2026-09-30 |

## 1. Change summary

The Phase 2–6 beads were converted with the design choices the design left open recorded as assumptions (about 40, Phase 2 alone 15). Polishing the beads settled the ones that are design choices rather than measurements, in the design (autonomy design §B.9, §C.6, §D.4, §E.4, §F.3; evaluation design §4 A-4, A-10). It also fixed the graph. Each phase's start bead still re-checks these decisions against what the previous phase measured.

## 2. Compelling reason

- A leaf with an open design choice is not "known enough" to implement (Execution Atom invariant 5).
- Bead `bm-autonomy-phase2-t9lm.5` had turned one open choice into a requirement that contradicts the owner's direction. It asserted that, once Autopilot is gone, an Orchestrator command answering no decision is refused **in every project, even a fully delegated one**. That would make the Orchestrator purely reactive; the owner's DQ-2 answer says coordination may be proactive, and the suite's E-2 equivalence relies on it.
- PRD REQ-130 labels three claims of a report (checks, files changed, beads closed); the design and the Phase 3 bead covered only checks.

## 3. What changes — Before / After

| Item | Before | After |
|---|---|---|
| Orchestrator command answering no decision (Phase 2) | Only the owner's word or a grant, in every project | Authorised by the policy when every class its declared effects map to is `delegate` for its project (`none`/`commit` count as `reversible-technical`), with `authority: policy:<class>`; a hard-owner effect always needs a grant (§B.9). New bead: *Policy authority for an Orchestrator command that answers no decision* (WP-202, `Split-from: bm-autonomy-phase2-t9lm.5`); `t9lm.5`, `t9lm.10` depend on it |
| A-4 and A-5 for delegated decisions | Inside the digest bead `t9lm.15` | Their own bead (WP-208, `Split-from: bm-autonomy-phase2-t9lm.15`); the Phase 2 exit depends on it |
| `bm_assessment` | Kept as a record-only tool unless the phase start retired it | Retired with the additional instructions (PRD Appendix B: precedents and replay findings replace it); `t9lm.16` |
| `owner` / `shadow` | Challenger predicted only in `shadow` cells | Both modes behave alike when a decision opens; `shadow` is what a demotion sets and counts eligibility from the demotion; the challenger predicts in both (§B.9); `t9lm.7`, `t9lm.9` |
| REQ-130 files changed and beads closed | Out of scope of `bm-autonomy-phase3-7gxw.3` | In it (§C.6) |
| Independent review family | The base provider | The model's vendor (§C.6); `bm-autonomy-phase3-7gxw.6` |
| Dependency `t9lm.14` (precedent resolution) | No edge to the ledger | Depends on `t9lm.6`, which introduces `answer.by: precedent` |
| Every other recorded assumption | "Assumption (design silent)" | "Decided (design §…, change-003)" in the bead; unchanged in substance |
| Phase 1 exit bead `bm-autonomy-phase1b-dbdv.7` | Judges "A-3 = 1" | Judges A-3 at its target (change-002) |

## 4. Impact

### Affected beads

| Bead ID | Action |
|---|---|
| `bm-autonomy-phase2-t9lm.5`, `.15` | Scope reduced by the split; `.5`'s negative test corrected |
| `bm-autonomy-phase2-t9lm.16`, `.7`, `.9`, `bm-autonomy-phase3-7gxw.3`, `.6` | Scope and criteria follow the decisions |
| Two new beads under `bm-autonomy-phase2-t9lm` | Created |
| Every leaf of Phases 2–6 with a recorded assumption | Wording: decided, with the design section |
| `bm-autonomy-phase1b-dbdv.7` | Criteria wording |
| Edges | `t9lm.14 → t9lm.6`; `t9lm.5`, `t9lm.10 → the policy-authority bead → t9lm.3`; the metrics bead → `t9lm.15`; `t9lm.18 → the metrics bead` |

### Other affected artifacts

- [x] Autonomy design §B.9, §C.6, §D.4, §E.4, §F.3 and its Revision History.
- [x] Evaluation design §4 (A-4, A-10).
- [ ] PRD: none — every decision stays within REQ-120–162.
- [ ] ADR: none — the policy authority of commands applies ADR-018 (autonomy per class) to what Autopilot did.

### Risk delta

Where the owner delegates `reversible-technical`, the Orchestrator may again send `none`/`commit` commands on its own, as Autopilot allowed. It is bounded by the class it earned and by the backstop gate. A hard-owner effect still needs a one-use grant.

## 5. Out of scope for this delta

The PRD's requirements and targets, the phase order, every work package's outcome.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10: "approve on my behalf … apply it"; the owner asked for the beads to be polished), 2026-09-30.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude (owner's delegation) | Created, accepted and applied while polishing the Phase 2–6 beads |
