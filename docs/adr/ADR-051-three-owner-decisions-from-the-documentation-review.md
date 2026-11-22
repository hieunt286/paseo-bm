# ADR-051 — Three owner decisions from the documentation review: no unverified-finish guard, the ceiling for rollover too, a replaced Main told who holds its mission

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-17 |
| Owner | hieu.nt10 |
| Amends | [ADR-040](ADR-040-the-main-resolves-its-requests-fallback.md), the sentence keeping the "unverified-finish" guard |
| Keeps | [ADR-035](ADR-035-a-delivery-line.md) decision 5, a hard ceiling for compaction, handoff and rollover, now met by the code; [ADR-033](ADR-033-the-mission-is-the-system-of-record.md) decision 2, a replaced Main's tools refuse and name the current Main, now met for every tool |
| Sources | Owner's chat of 2026-11-17 answering the three questions of the 2026-11-16 documentation review: "1. bỏ luật 2. cho tất cả 3. sửa đi" |
| Tracking | The bead labelled `feature:review-decisions` |

## Context

The documentation review of 2026-11-16 found three places where the code and the recorded rules disagreed:

- The autonomy design kept a rule from the autonomy plan's change-008 (C4): a delegate may not act on a request that finished unverified. The resolver could apply it, but no caller ever supplied the request's state, so it never applied.
- ADR-035 decision 5 gives compaction, handoff and rollover a hard ceiling: past a set multiple of their threshold, or half their window, each runs at the next turn end. Rollover had the multiple (`rollover.ceilingFactor`, which turns the soft notice into `BM-ROLLOVER now`) but not the time.
- ADR-033 decision 2 says a replaced Main's tools refuse and name the current Main. Its writing tools did; its reading tools refused with a message that named no one.

## Decision

1. **The unverified-finish guard is retired.** A delegate's answer, a Main's or the Orchestrator's, is never refused because its request finished unverified. The code that could apply it (`finishedUnverified`, `actsOnFinish`, `unverifiedFinishRefusalOf`) is removed. "Finished unverified" stays what the reports, cards and metrics show.
2. **The ceiling applies to rollover as to the others.** A `BM-ROLLOVER soft` that has waited `MAINTENANCE_WAIT_MS.rollover` (30 minutes) without the request rolling over becomes `BM-ROLLOVER now`, as when a figure reaches `rollover.ceilingFactor` × its threshold. It is asked once and goes first, as `now` does today.
3. **Every tool of a replaced Main names the current Main.** Every writing tool refuses as before, including the four that used to refuse with their own words (`bm_mission_start`, `bm_answer_fallback`, `bm_hold_cancel`, `bm_hold_release`). The reading tools refuse the same way, naming the Main that holds the mission and where to find it, instead of saying the caller is no Main.

## Consequences and proof

- Nothing a delegate could do changes with decision 1, because the guard never applied. Its tests go with it.
- A Worker that sits on a soft rollover is asked again, as `now`, after 30 minutes of wall-clock time, whatever it was waiting on: the request ends sooner and its work goes on in a continuation. Right after the update, a running request whose soft notice is older than 30 minutes gets `now` at its Worker's next turn. A later Worker of the request is asked `now` again, as ADR-046 says.
- A replaced Main that reads learns at once who holds its mission.
- Tests prove the soft notice turns into `now` after the wait and not before, and that it is asked once. They prove that each reading tool of a replaced Main names the current Main, and that a Main of no mission is unaffected.
