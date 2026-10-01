# Change Request — Build the remaining phases continuously; judge every phase exit in one field period at the end

| Field | Value |
|---|---|
| Change ID | `autonomy-change-006` |
| Short name | Build continuously, measure together at the end |
| Original plans | [Phase 1b](./paseo-bm-plan-autonomy-phase1b.md), [Phase 2](./paseo-bm-plan-autonomy-phase2.md), [Phase 3](./paseo-bm-plan-autonomy-phase3.md), [Phase 4](./paseo-bm-plan-autonomy-phase4.md), [Phase 5](./paseo-bm-plan-autonomy-phase5.md), [Phase 6](./paseo-bm-plan-autonomy-phase6.md) (Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-30 |
| Accepted | 2026-09-30 — decided by the owner ("Xây liên tục, đo gộp cuối") |
| Applied | 2026-09-30 |

## 1. Change summary

The owner asked for the remaining beads to be implemented continuously until all are closed. Every remaining bead waited on a phase exit that needs real use and real time:
- Phase 1: at least 10 owner requests;
- Phase 2: two weeks of shadow;
- Phase 3 and Phase 4: field use each;
- Phase 5: a 30-output audit;
- Phase 6: the owner's admission judgement and a 6–10 hour suite.

The owner chose to build continuously and to judge every phase exit together, in **one combined field period on the final build**.

## 2. Compelling reason

- The programme ships once (Q-101), so each phase's field gate only delayed the build; it did not gate a release.
- Each phase keeps its tests, its negative tests and its live checks on an isolated daemon while it is built.

## 3. What changes — Before / After

| Item | Before | After |
|---|---|---|
| A phase's code beads | Wait for the previous phase's **exit** (field replay, owner acceptance) | Wait only for the code they build on: the previous phase's **code terminals** and its isolated live check where one exists |
| A phase-start bead (`t9lm.1`, `7gxw.1`, `loga.2`, `3e5v.1`, `i8fc.2`) | Reads the previous phase's field figures and exit verdict; stays open if they did not improve | Reads the previous phase **as built** (its tests and live check) and the **field data available now**; re-checks its design part and decisions; changes beads only through a delta |
| The Phase 3 defaults for compaction and handoff | Derived at the Phase 2 exit | Derived at the Phase 3 start from the Phase 2 measurement over the field data available now, and re-checked at the Phase 2 exit in the combined period |
| The Phase 4 spike (`loga.1`) | After the Phase 1 exit | Now: it touches no product code and runs on an isolated daemon |
| Phase exits (`1b.7`, `t9lm.18`, `7gxw.7`, `loga.6`, `3e5v.5`) | One per phase, each gating the next | All wait for a new bead, **the combined field period**: the owner installs the final build (a frozen copy of a commit), and the field window starts. Each exit is then judged on that window: Phase 1's 10 requests, Phase 2's two weeks, and the audits. A metric that did not improve is fixed forward before the programme evaluation |
| Phase 6 admission review (`i8fc.4`) and programme evaluation (`i8fc.5`) | After the Phase 5 exit | After every exit of the combined period; the evaluation still needs the owner's go-ahead |

## 4. Impact

### Affected beads

| Bead | Action |
|---|---|
| `t9lm.1`, `loga.1` | Edge to `1b.7` removed |
| `7gxw.1` | Edge to `t9lm.18` replaced by the Phase 2 code terminals and live check (`t9lm.17`, `.20`, `.23`, `.25`, `.27`) |
| `loga.2` | Edge to `7gxw.7` replaced by the Phase 3 code terminals (`7gxw.4`, `.5`, `.6`, `.10`, `.11`) |
| `3e5v.1` | Edge to `loga.6` replaced by `loga.4`, `loga.5` (the path not taken is closed as not applicable) |
| `i8fc.2` | Edge to `3e5v.5` replaced by `3e5v.3`, `3e5v.4` |
| `i8fc.1` | Edge to `7gxw.7` replaced by `7gxw.2` |
| New: the combined field period (Phase 6 epic) | Depends on `i8fc.3` (and through it every code bead) |
| `1b.7`, `t9lm.18`, `7gxw.7`, `loga.6`, `3e5v.5` | Depend on the combined field period |
| `i8fc.4` | Also depends on those five exits |
| Start and exit beads | Descriptions reworded as above |

### Other affected artifacts

- [x] PRD §10 (the exit gates judged together; the phase order and targets unchanged).
- [x] Plans 1b, 2–6: "Starts after" and a Revision History line.

### Risk delta

A later phase is built before the earlier one is proven in the field. A wrong assumption is therefore found later, and fixed forward before the programme evaluation. This is mitigated by each phase's tests and isolated live checks, by start beads that read the data already available, and by one release only after every exit is met.

## 5. Out of scope for this delta

The targets, the scope of every phase, the one release, the owner's go-ahead for the programme evaluation.

## 6. Approval

- [x] Approved-by: hieu.nt10, 2026-09-30.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude | Created from the owner's decision and applied |
