# Change Request — The Orchestrator answers through the decision store (field finding, Phase 1)

| Field | Value |
|---|---|
| Change ID | `autonomy-change-004` |
| Short name | `bm_decide` in Phase 1; decision options that wrap |
| Original plans | [Phase 1b](./paseo-bm-plan-autonomy-phase1b.md) (Active), [Phase 2](./paseo-bm-plan-autonomy-phase2.md) (Active) |
| Status | Applied |
| Owner | hieu.nt10 |
| Created | 2026-09-30 |
| Accepted | 2026-09-30 — hieu.nt10 approved the proposed fix ("Đồng ý phương án đề xuất") |
| Applied | 2026-09-30 |

## 1. Change summary

In the owner's field use of the Phase 1 build (commit `df6b182`, installed 2026-09-30 03:02 UTC), the Orchestrator answered a Worker's three open questions under Autopilot. It sent `bm_direct_worker` with `intent: answer` and a `BM-ANSWERS` block, as its instructions said. The plugin relayed the answers but never settled the three decisions, so the chat cards and the Inbox's Needs you kept them open. The owner answered two of them again, and the Worker received those two answers twice (03:15:14 from the Orchestrator, 03:16:41 as `BM-DELIVERY`).

That is the duplicate-answer class Phase 1 exists to remove (ADR-017: one source of truth, nobody relays). The same screen showed a second fault: a sentence-long option widened its button past the card.

## 2. Compelling reason

- Field evidence: decision store `q:req-20260930T031055Z:Q1…Q3`, Orchestrator command `2fa6a8c9…` (`via: autopilot`, `intent: answer`), and the Worker's timeline turns 3 and 4.
- Design §B.5/§B.9 already defines `bm_decide`. Bringing it forward removes the second answer path now, instead of in Phase 2.

## 3. What changes — Before / After

| Item | Before | After |
|---|---|---|
| The Orchestrator answering a Worker's question | `bm_direct_worker` with a `BM-ANSWERS` block, relayed; the decision stays open | **WP-113**: `bm_decide { decisionId, optionKey, reason }` settles the `q:` decision `by: orchestrator` (first answer wins) and the plugin delivers it as it delivers an owner answer. Phase 1 authority: the project's Autopilot. The chosen option carries no release, data, security, cost, `network` or `outside-workspace` effect, and `dependency-install` needs Allow…'s `dependency`. A hand-written `BM-ANSWERS` for a question that has a decision is refused. Bead `bm-autonomy-phase1b-dbdv.9` |
| `answer.by` | `owner` | `owner \| orchestrator` (additive; Phase 2 adds `policy \| precedent`) |
| Decision options on a card | One row of chips; a long label overflowed | Short answers stay side by side. Once one label is a sentence (> 32 characters), every option takes the card's width and wraps. A Direct fix in `plugin/client/chat-card.tsx`, test `test/plugin-decision-options-layout.test.ts` |
| Phase 2 bead `bm-autonomy-phase2-t9lm.11` | Builds `bm_decide` for the policy | Keeps the tool built here and swaps its authority from Autopilot to the policy (a `delegate` cell whose predictor is `orchestrator`) |
| Phase 1 exit | Field window from 2026-09-30 03:02 UTC | The window restarts when the owner installs the fixed build; bead `.7` depends on `.9` |

## 4. Impact

### Affected beads

| Bead ID | Action |
|---|---|
| `bm-autonomy-phase1b-dbdv.9` | Created (WP-113) |
| `bm-autonomy-phase1b-dbdv.7` | Now depends on `.9`; the field window restarts at the new install |
| `bm-autonomy-phase2-t9lm.11` | Note: the tool exists; the bead changes its authority only |

### Other affected artifacts

- [x] Autonomy design §A.6, §A.9, §B.9 (as built with `.9`).
- [x] Evaluation design §4 (A-1, A-7: an answer `by: orchestrator` is answered by agents and is a wake's action).
- [ ] PRD: none — REQ-110/111/115 are what this restores.
- [ ] ADR: none — this applies ADR-017.

### Risk delta

The Orchestrator can no longer reach a Worker with an answer the store does not know. An Orchestrator that keeps writing `BM-ANSWERS` by hand is refused with a message pointing at `bm_decide`.

## 5. Out of scope for this delta

The Phase 2 policy; `o:` and `f:` decisions (the owner's); the "Decided for you" digest (Phase 2).

## 6. Approval

- [x] Approved-by: hieu.nt10, 2026-09-30 (the proposal of the field-finding review).

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-30 | Claude | Created from the owner's field report and approved by the owner the same day |
