# ADR-046 — `BM-ROLLOVER now` is never deferred for a review

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Owner | hieu.nt10 |
| Amends | [ADR-045](ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 10's last sentence; [ADR-035](ADR-035-a-delivery-line.md) decision 1 further, for a batch with no verdict |
| Sources | The coordinator's decision of 2026-11-10, after the seeded scenario's failure in bead `bm-mission-line-tplg.1.17` |
| Tracking | Beads labelled `feature:mission-line` (`bm-mission-line-tplg.1.12`, `.1.17`) |

## Context

ADR-045 decision 10 made `BM-ROLLOVER now` wait for a running review's verdict, because `finished` is refused until the verdict arrives. The seeded scenario showed that the wait cannot keep the hard limit. The notice can be asked only at a turn end after the verdict is delivered, so the turn that receives the verdict is never the finishing turn. Over 40 seeds of 250 Worker turns, 8 overran the limit of one slack turn and the finishing turn. Rechecking the wait at the send, as the decision's letter asks, left 8 red and made one seed longer.

The same runs showed the notice lost across a handoff: it reached the outgoing Worker, `rolloverAsked` then stopped any further ask, and the successor worked 153 turns past the figure.

## Decision

1. **`now` never waits for a review.** It is judged and sent as if no review were running.
2. **A size finish is not held for a verdict.** Under `now`, a `finished` with `remaining` is accepted while a batch has no verdict delivered. A `finished` without `remaining`, or after only the soft notice, is refused as before.
3. **The batch follows the work.** Such a batch is copied onto the continuation as ADR-045 decision 10 copies an unpassed one, its newest call marked `awaited`. Its Reviewer keeps its binding to the predecessor. `noteReviewResult` stores the verdict on every copy down the chain, and `verdictTargetOf` delivers it to the chain head's Worker. The continuation's own `finished` waits for that verdict, and a `now` there carries the batch on again.
4. **`now` belongs to the request's current Worker.** `rolloverAsked.workerId` names who was asked, and a later Worker of the request is asked again. A Worker whose handoff has asked for its note is not asked: its successor is.

## Invariants

- A request stops within one slack turn and its finishing turn of a hard figure, whatever its reviews.
- No verdict is lost: it is stored on the predecessor and on each copy, and delivered to the newest Worker.
- Stored additions are additive: `awaited` and `workerId` are optional, and a `now` stored by an older build, naming no Worker, is not asked again.

## Consequences and proof

- A Worker can end its session with a review running. Its verdict reaches a Worker that did not ask for it; the brief says it is on its way.
- A carried batch has no pass until its verdict does, so the finish gate holds the chain until then.
- ADR-045's reason for waiting, that the refusal would otherwise orphan the verdict, no longer applies: the verdict has somewhere to go.

`test/rollover.test.ts` proves each rule, including a verdict that lands after its batch moved, on the real tools. The seeded scenario's limit of 2 is unchanged and holds over 40 seeds.
