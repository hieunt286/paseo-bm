# ADR-044 — A plugin start does not revive a dormant mission

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Owner | hieu.nt10 |
| Amends | [ADR-042](ADR-042-a-collected-agent-rests-and-a-failed-delivery-is-told.md) decision 2, for records resent at a plugin start; [ADR-039](ADR-039-new-work-never-into-a-busy-worker.md), the handover of an outdated Main |
| Sources | Owner's 2026-11-10 report and request; [delivery line design](../design/paseo-bm-delivery-line.md) §19.12; [technical design](../design/paseo-bm.md) §16.7 |
| Tracking | The bead labelled `feature:dormant-missions` holds the Routing Decision and acceptance proof |

## Context

Installing the ADR-042 build on 2026-11-09 put missions on the owner's sidebar that nobody had opened.
At the plugin's start the outbox resends every open record. Two checkpoint notices had waited since
2026-10-21 for the closed Mains of PASE and PASE2, and under ADR-042 they resumed those agents. Idle
again, each read as an outdated Main, so the handover made a successor and, because these older
missions had none, a workspace for the mission.

Each rule was right alone. Together, starting the plugin revived missions with no work.

## Decision

1. **Work decides, not age.** At the plugin's start, the resend leaves an open `message` record as it
   is when no work is open on it and the agent it would reach now rests. It is not sent or dropped, and
   raises no alert or `BM-DELIVERY-FAILED`.
   - No work is open on a message about a mission when the mission has no active request, and on one
     about a request when the request has finished.
   - The agent it would reach now is the mission's current Main for a record addressed to a Main, as
     `deliverRecord` resolves it, and otherwise the record's `to`.
2. **Everything else is unchanged.** A record of open work wakes a resting agent however old it is, so a
   verdict queued before a weekend still arrives. So does a message about a request paseo-bm does not
   know. A report, a verdict and a peer record are never left: a `finished` report belongs to a request
   that has finished, and the Main must still receive it. Deliveries made while the plugin runs, answers the owner gave, a live target and
   a gone target behave as ADR-042 says. ADR-034's start-up migration, which makes a workspace for a
   mission that is not legacy, is not changed.
3. **An outdated Main is handed over only while its mission has work.** The minute pass requires an
   active request on the mission's roster. A mission with none keeps its Main, on its older
   instructions, until it next has an active request; the pass then hands it over as before. So a Main
   woken for any reason makes no successor and no workspace in a dormant mission.

## Consequences and proof

- A dormant Main answers on older instructions until its mission has work again. The first request of
  that return is staffed by it. The Inbox's outdated-agent alert still offers the owner what it did.
- An active roster entry counts as work even if the request was abandoned, so such a mission can still
  hand its Main over. This errs towards today's behaviour.
- A skipped record stays open. It goes out at a later start if work has opened by then, or to a
  successor Main, as old news. That is accepted: it is rare and harmless, and dropping it would alert
  the owner about nothing.

Outbox tests prove the skip and its silence, open work waking however old, a finished report and a
peer record still arriving, the current-Main cases in both directions, and unknown requests. Handover tests prove that a mission with no active request is
left alone and is handed over once it has one. The sidebar itself is proved on the daemon after the
owner's install.
