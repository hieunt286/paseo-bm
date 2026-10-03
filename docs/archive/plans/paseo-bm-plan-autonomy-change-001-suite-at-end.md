# Change Request — The suite at the programme's end, and the plan review of 2026-09-29

| Field | Value |
|---|---|
| Change ID | `autonomy-change-001` |
| Short name | Suite at the end; review fixes for the Active plans |
| Original plans | [Phase 0](paseo-bm-plan-autonomy-phase0.md), [Phase 1a](paseo-bm-plan-autonomy-phase1a.md), [Phase 1b](../../plans/paseo-bm-plan-autonomy-phase1b.md) (all Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-29 |
| Accepted | 2026-09-29 — approved by Claude under the owner's delegation, after review |
| Applied | 2026-09-29 |

## 1. Change summary

The plans ran the full evaluation suite at Phase 0 and at every phase exit. The owner decided the suite runs **once, after all other work** (on `paseo-bm-plugin@0.4.1` and on the final build), and that the Reviewer/Orchestrator Paseo-tools gap of the shipped release is **not verified or patched separately**. A review of all plans the same day also found five gaps in the Active plans. This delta applies both.

## 2. Compelling reason

- Owner decisions, 2026-09-29: "the Phase 0 test suite will run after all the work is done"; "forget the Reviewer/Orchestrator gap, no fix needed — the product is changing as a whole".
- Plan review (`reviewing-plan`), 2026-09-29: gaps in coverage of the design (A.9 Manager tool face; PRD §11 rule 3 older agents; §11 rule 2 retired data files) and two work packages whose split points a converter would otherwise guess.

## 3. What changes — Before / After

| Plan · item | Before | After |
|---|---|---|
| Phase 0 · exit 2 | Suite S1–S8 twice on 0.4.1 and the tree | Moved to Phase 6 WP-604 (programme evaluation). Bead `m1ih.9` stays deferred and is converted there |
| Phase 0 · exit 3 / bead `m1ih.10` | Targets confirmed after the suite; `.10` depends on `.9` | Targets confirmed from the field baseline now; `.10` no longer depends on `.9`; Phase 0 closes with `.10` |
| 1a · WP-101 exit | Live check records which tools a Reviewer/Orchestrator can call **before and after** | Live check proves the **target** configuration only: a new Reviewer and Orchestrator get no Paseo tools, a new Manager and Worker lack exactly the disabled ones; the hook's view of the creator and a hook throw verified. No investigation of the current release |
| 1a · MVP exit | "the (verify) items of §A.10 settled" | "the target capability configuration and the pairing check verified on an isolated daemon" |
| 1a · WP-104 | One row with four outcomes | Same scope plus the **Manager's read-only `bm_decisions` face** (design §A.9); split guidance for the converter: (i) `BM-COMMAND` v2 with authority and grants, (ii) Orchestrator decision tools (prepared actions, supersession, `bm_decisions`), (iii) bounded defaults of the read tools |
| 1a · WP-107 | Role files rewritten | Plus **agents created with older instructions**: every role's agents carry an instruction-hash label (as the Orchestrator does); an older one raises an Inbox alert offering replacement; `manager.ensure` replaces an outdated Manager on the owner's tap (PRD §11 rule 3, NFR compatibility) |
| 1a · risks | "measured in the suite" | "measured in the field replay" |
| 1b · WP-108 | One row | Split guidance: (i) the surface shell and Inbox, (ii) Work, (iii) Settings, (iv) Insights |
| 1b · WP-110 exit | Retired code and docs deleted | Plus retired **data files** (`ui/qa-ledger.json`, `ui/answer-marks.json`, command entries of `orchestrator/proposals.json`, event keys of `orchestrator/stalls.json`, the Watch field of `orchestrator/settings.json`) ignored by the new build and removed by the cleanup button (PRD §11 rule 2) |
| 1b · WP-111 and MVP exit | The suite on the tree with the `decision-rpc` channel | The `decision-rpc` adapter built and unit-tested (the programme evaluation uses it); the Phase 1 exit uses the **field replay** of the owner's use of the new build (at least 10 requests) and a **live check** on the isolated daemon of S1 and S7 with `decision-rpc` (two requests, one run) |

## 4. Impact

### Affected beads

| Bead ID | Action | Reason |
|---|---|---|
| `bm-autonomy-phase0-m1ih.10` | UPDATE description; DEP remove `m1ih.9` | Targets confirmed from the field baseline |
| `bm-autonomy-phase0-m1ih.9` | CLOSE as moved (amended at approval: closing it lets Phase 0 close; the Phase 6 WP-604 bead carries `Supersedes: bm-autonomy-phase0-m1ih.9`) | Suite at the programme's end |
| Phase 1a/1b beads | none yet | Not converted |

### Other affected artifacts

- [x] PRD §10 and A-9 — amended 2026-09-29 (owner decision).
- [x] Evaluation design §7 — amended 2026-09-29.
- [x] Autonomy design §E.3 — amended 2026-09-29.
- [x] Draft plans 2–6 — edited in place by the same review (WP-604 added to Phase 6).
- [ ] ADR: none.

### Risk delta

A regression is seen later (at the programme evaluation) instead of at each phase; each phase's field replay and live checks are the early warning (Phase 6 risks).

## 5. Out of scope for this delta

Any change of PRD goals, of the design, or of the phase order.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10: "approve on my behalf … apply it"), 2026-09-29 — with one amendment: bead `.9` closed as moved rather than kept deferred

## 7. Apply plan

1. Edit Phase 0, 1a and 1b as §3 says; add a Revision History line to each referencing this delta.
2. Update beads `m1ih.9` and `m1ih.10` as §4 says; `br lint -s all`, `br dep cycles`.
3. Mark this delta Applied with the date.

## 8. Things deliberately NOT changed

- The phase order, the scope of every phase, and the one release at the end.
- REQ-116's target configuration stays in Phase 1 (only the separate investigation and patch of the current release were dropped).
- The evaluation tooling of Phase 0 stays as built.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | Accepted with one amendment (`.9` closed as moved) and Applied: plans 1a/1b edited, Phase 0 completed and archived, beads updated |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Created, status Review |
