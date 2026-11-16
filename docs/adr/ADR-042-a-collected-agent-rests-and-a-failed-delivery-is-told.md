# ADR-042 — A collected agent rests, and a failed delivery is told

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-06 |
| Owner | hieu.nt10 |
| Clarifies | [ADR-005](ADR-005-manager-as-agent.md) decision 5: the lifecycle stays the owner's; a runtime the daemon collected is not a lifecycle decision |
| Sources | Owner's 2026-11-06 request; [technical design](../design/paseo-bm.md) notice queue, §7.17.4, §16.7; [mission runtime design](../design/paseo-bm-mission-runtime.md) §2.1 |
| Tracking | The beads labelled `feature:resting-agents` hold the Routing Decision and acceptance proof |

## Context

Paseo 0.14 closes the runtime of an agent that has been idle for 60 minutes. The agent keeps its
session and is not archived: its status reads `closed`, and a send resumes it from storage. The
plugin was written when an idle agent stayed idle, so it reads `closed` as gone.

A Worker that reports `blocked` ends its turn and goes idle, so every wait longer than an hour ends
on a target the plugin refuses. Of the 24 questions answered after the upgrade, the 21 answered
within an hour reached their Worker or needed no delivery, and all 3 answered later failed. The
failure was silent: `delivery.outcome` read `failed`, nobody was told, and the request kept showing
`working`. The Main, a mission's other long waits and a provider-limit wait meet the same refusal.

## Decision

1. **Three presences.** An agent is `live`, `resting` (status `closed`, not archived, with a
   persisted session) or `gone` (missing, archived, or closed with no session). A snapshot that
   does not carry the session reads `gone`, as before.
2. **Who wakes a resting agent.** The notice queue sends to a resting target only for a notice
   queued with `wake: true`, the mark of a notice someone waits on: every delivery through
   `enqueueNotice` and `enqueueUpdates` (each outbox record after its hold and no-turn rules, so a
   report, a verdict, a peer message and `bm_tell_worker`, `now` or not; a Worker's release; an
   owner's command or words; a Main's signal), answers, an owner's question on a card, a
   review-budget withdrawal, an answer to the Orchestrator, and the Orchestrator's `BM-EVENTS`,
   which are already only the events that wake it. Other notices (a rollover, a handoff note, a
   state brief) are dropped for a resting target, so nothing wakes an agent only to inform it.
3. **Who counts a resting agent as present.** The two direct sends (a provider-limit resume, a
   review-budget notice), peer routing and the stall pass's live set treat resting as present.
   `findMain` counts a resting agent only when it is the mission's current `mainId`, so a replaced
   Main that was closed when its `bm.replacedBy` label would have been written stays retired.
   `findLiveManagers`, the governor's live Workers, the Main handover's Worker list and
   `mission-replace` keep reading `closed` as absent: they count what runs now, and widening them
   would make old Managers extra or wake every past Worker.
4. **An archived agent is never sent to.** That is ADR-005 decision 5, unchanged. Waking does not
   archive, delete or stop anything, and it leaves the owner's lifecycle actions as they are.
5. **A failed delivery is told.** Failed answers raise the `delivery-dropped` alert as a dropped
   outbox record does and count in the governor's `dropped` figure, whose ladder reaches the
   Orchestrator. For an open request, the Main also gets one `BM-DELIVERY-FAILED` notice unless the
   Main itself is what could not be reached.
6. **The state shows it.** An open `delivery-dropped` alert makes an active request `undelivered`,
   ahead of the waiting states, and `blocked` on the mission row. The alert clears as today, when a
   later delivery covers the drop or the request finishes or stops; a failed answer is covered only
   by a `message` delivered on the request after it, which is what the notice asks the Main to send.

## Consequences and proof

A wait of any length ends with its delivery. A resumed agent keeps its tools: bindings are revoked
at `agent.archived`, not at a close, and Worker `228fad1f` called `bm_` tools for hours after being
collected and resumed. Answers already marked `failed` stay failed, so an install replays nothing.

`undelivered` is a new value of the `requests[].state` enum in the missions contract. Client and
server ship in one bundle, and stored data does not hold it, so no migration is needed. Rollback is
reverting the source, the docs and the generated bundle together.

Queue tests prove the wake rule and the drop of other notices; store tests prove the alert, the
figure and the state; existing tests keep proving that archived, unknown and session-less agents
are refused. The delivery into a real collected agent is proved on the daemon after install, which
is the owner's step.
