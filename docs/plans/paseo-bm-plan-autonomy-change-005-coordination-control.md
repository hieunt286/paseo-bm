# Change Request — Coordination control: measurement and advice (Phase 2), compaction and handoff (Phase 3)

| Field | Value |
|---|---|
| Change ID | `autonomy-change-005` |
| Short name | The Orchestrator as a measured coordination controller |
| Original plans | [Phase 2](./paseo-bm-plan-autonomy-phase2.md), [Phase 3](./paseo-bm-plan-autonomy-phase3.md) (Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-30 |
| Accepted | 2026-09-30 — decided by the owner (the four decisions below) |
| Applied | 2026-09-30 |

## 1. Change summary

After the Phase 1 field use, the owner asked the Orchestrator to do more than answer questions: advise, handle problems, intervene in coordination, and have agents compacted or handed over to save tokens and time, without losing quality.

The owner decided on 2026-09-30:
1. The Orchestrator may request handoff and compaction on its own initiative, without the owner's approval, configured in Settings.
2. The Manager coordinates a handoff; the Orchestrator may have both a Manager and a Worker compact.
3. The Orchestrator advises proactively after every few rounds of work, the number set in Settings.
4. The measurement is built in Phase 2, compaction and handoff in Phase 3.

Recorded as ADR-021, PRD REQ-126–128 and REQ-134–136 (A-8's Phase 3 target, A-12), design Part G.

## 2. Compelling reason

Field replay of 2026-09-30:
- The Worker spends 93 % of the tokens. The heaviest 10 % of requests use 50 % of the Worker's tokens, and the second half of their turns costs 59 %.
- Requests stop 3.2 times each to ask the owner (median 5 minutes of waiting, p90 53).
- Reviews find 1.35 blocking findings per batch, so review is not where time or tokens should be saved.

## 3. What changes — Before / After

| Plan | Before | After |
|---|---|---|
| Phase 2 | WP-201 → WP-208 | Plus **WP-209** (context and token measurement), **WP-210** (the intervention log and outcomes; the digest's intervention lines), **WP-211** (Settings → Coordination with the advice cadence; proactive advice as owner decisions with prepared changes). The exit adds the measurement and log in use, Phase 3 defaults derived, advice given |
| Phase 3 | WP-301 → WP-305 | Plus **WP-306** (compaction verified per provider), **WP-307** (Settings for compaction and handoff; auto-off under A-12), **WP-308** (compaction on the Orchestrator's request, with the state brief), **WP-309** (handoff through the Manager). The exit adds A-8 −20 % on the heaviest 20 % with no quality regression, and A-12 ≥ 80 % for compaction and handoff |
| Phase 2 retirement (`bm-autonomy-phase2-t9lm.16`) | `bm_assessment` retired, nothing in its place | Advice (WP-211) replaces it (§G.4) |

## 4. Impact

### Affected beads

- New beads under `bm-autonomy-phase2-t9lm` (WP-209 → WP-211) and `bm-autonomy-phase3-7gxw` (WP-306 → WP-309).
- The phase-exit beads `bm-autonomy-phase2-t9lm.18` and `bm-autonomy-phase3-7gxw.7` depend on their new terminals.
- `t9lm.15` (digest) comes before WP-210's digest lines.

### Other affected artifacts

- [x] PRD: REQ-126–128, REQ-134–136, A-8 target, A-12, the Orchestrator persona, §10, Appendix B.
- [x] ADR-021 (Accepted).
- [x] Design Part G; §B.9.
- [x] Evaluation design §4 (A-12).
- [x] docs/README.md.

### Risk delta

The Orchestrator changes context and structure without the owner's approval. This is bounded by:
- Settings (each mechanism switched off at once);
- safe points and idle moments;
- the Manager executing handoffs;
- successor verification;
- the intervention log, the digest and A-12's auto-off.

Compaction depends on a provider mechanism not yet verified (WP-306 comes first; handoff is the fallback for a Worker).

## 5. Out of scope for this delta

Parallel Workers and worktrees (Phase 6); rotating the Orchestrator; changes to the review budget other than as an owner decision.

## 6. Approval

- [x] Approved-by: hieu.nt10, 2026-09-30.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude | Created from the owner's decisions and applied the same day |
