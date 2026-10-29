# paseo-bm — why a mission's new goals queue, field review 2026-10-25

A read-only review asked by the owner: "when I add a new goal to a mission, it does not arrange the work but puts it in a very long queue, even work that could run at the same time. Look at mission AIX." It is the evidence of [ADR-038](../../adr/ADR-038-parallel-lanes-and-a-held-queue.md). Nothing was changed while measuring.

**What was read:**
- mission AIX (`mis-05679b1444`): its record, plan, roster (34 requests) and autonomy (level 4, every class delegated, `staffing` included; no Worker budget);
- the AIX Main `cf5db8be`'s whole timeline through the daemon's read-only timeline API (699 items);
- the trace turns of the Workers `3729405b` (backend), `8234c60c` and `9b40933b` (frontend);
- `create-worker.ts` `staffingReasons`, `manager.md`, the notice queue, and the Paseo 0.12.0 app and daemon code for message delivery.

## 1. One live Worker per repository, by practice

- AIX has one placement per repository: `m/AIX/xspace-ai-assistant` and `m/AIX/ai-assistant`. Every request since 10-24 ran in one of them, and never two at once in the same repository.
- `staffingReasons` refuses a second live Worker in a placement unless staffing is delegated. AIX delegates it, so code did not block a second Worker. The Main chose not to start one:
  - `manager.md` says a follow-up goes to its request with `bm_tell_worker`, to its Worker while it runs, and that a placement's Workers share its tree;
  - the mission plan the Main wrote says "one writer per file per wave".
- From 02:10 to 05:00 the Main sent **52 `bm_tell_worker` messages; every one answered `delivery: "queued"`**, and it called `bm_create_worker` 8 times in two days, never refused.

## 2. A queued message waits for the end of a long turn

The notice queue sends to a running agent only at its next turn end, because a plain send replaces the turn. The Workers' turns were long:

| Worker | Turn | Length |
|---|---|---|
| backend `3729405b` | 02:28 → 05:00 | 152 minutes |
| frontend `8234c60c` | 02:40 → 03:39 | 59 minutes |
| frontend `9b40933b` | 04:29 → 05:00 | 30 minutes |

| The owner's ask | To | Told | Reached the Worker | Waited |
|---|---|---|---|---|
| more audit items | backend | 02:53 | 05:00 | 127 min |
| more audit items | backend | 03:17 | 05:00 | 103 min |
| "keep only the bypass-authz flag" | backend | 04:06 | 05:00 | 54 min |
| frontend menu and screens | frontend | 04:33–04:37 | about 05:00 | about 25 min |

At 04:59 the owner wrote: "I asked you to check the menu, but no Worker seems to be doing it."

## 3. No triage

From 02:10 to 04:59 the owner sent nine messages:
- a whole-mission audit;
- a question on the `ai-assistant-ops` module;
- "the UI shows nothing new";
- "too many flags";
- a TypeScript compile error;
- "where are the screens";
- "the menu is missing";
- a complaint that nobody worked on the menu.

All went to the two Workers already running the audit. A compile error, a one-flag change and a question that reading answers waited behind an audit of both repositories.

## 4. What Paseo 0.12 offers

- `sendAgentMessage(id, text, { activeTurnBehavior: "steer" })` joins a running turn on providers that support it. The Claude and Codex providers implement `steerActiveTurn`.
- The daemon's `steerOrReplaceActiveTurn` falls back to replacing the turn when a steer is unavailable. The plugin's `agents.ref(id).send(text, options)` forwards its options to `sendAgentMessage`.
