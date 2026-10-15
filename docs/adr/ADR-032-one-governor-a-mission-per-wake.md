# ADR-032 — One governor, a mission per wake; danger goes to the Main first

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-10); decision 4's separate `BM-SIGNAL` notice and decision 2's brief source amended by [ADR-033](ADR-033-the-mission-is-the-system-of-record.md) (same day, before release) — the owner asked for every recommendation of the 2026-10-10 assessment ("Tôi muốn cập nhật lại hết các mục theo khuyến nghị"); technical choices by Claude under the owner's delegation |
| Date | 2026-10-10 |
| Owner | hieu.nt10 |
| Keeps | [ADR-014](ADR-014-orchestrator-agent-proposes-owner-approves.md) decision 1 (one Orchestrator per machine) and [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) decision 8 (the Orchestrator governs the process); [ADR-005](ADR-005-manager-as-agent.md) (the plugin never archives or stops an agent) |
| Amends | [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) decision 9 (how the governor's wakes are delivered); the Orchestrator design §6B.6 (when a fresh Orchestrator replaces a current one); [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) as narrowed by ADR-029 (who hears of a `danger` signal first, and in which projects) |
| Related | **PRD: [missions PRD](../product/paseo-bm-missions-prd.md) REQ-197 → REQ-201, M-28 → M-30** · **Design: [missions design](../design/paseo-bm-missions.md) §20** · [Orchestrator design](../design/paseo-bm-orchestrator.md) §6, §6B · [evaluation design](../design/paseo-bm-evaluation.md) A-13 |
| Lane | Designed: agent-role behaviour (Orchestrator, Main), who may stop a Worker and when they hear of it, stored formats (wake records, a danger log) |

## Routing Decision

- Variant preset: brownfield (a change to the running governor).
- Triggered risks: agent-role behaviour (both role files), the authority path of a stop (a new notice to the Main, the Orchestrator's allowance outside the repo-level scope), consumed stored formats (additive fields).
- Required artifacts and gates: this ADR; the missions PRD amended (`prd-ready`); the missions design §20 and the Orchestrator design updated in place (`design-ready`); `feature-done` (standard profile).
- Execution path: manual tracking — one epic with a leaf per outcome. No plan: the leaves share no prerequisite graph beyond "docs first", and one session carries them.
- Exceptions: the live acceptance drill on an isolated daemon is not part of this work; it is the owner's next step with the build installed (plans stop at acceptance).
- Decided: 2026-10-10 — hieu.nt10 (scope: all recommendations), Claude under the owner's delegation (technical choices, gates).
- Supersedes: none.

## Context

ADR-029 moved the unit of work from a project to a mission. The governor's figures and the first two steps of its ladder already run per mission, in code. The model is still one long-lived agent, and the 2026-10-10 assessment found where that shape no longer fits:

- **Missions share one conversation.** Every `BM-EVENTS` message joins one chat, and the notice queue merges every pending event into one message, so a wake can carry the events of several missions. Mission A's notes and figures can be applied to mission B. A fresh Orchestrator comes only after 24 hours, whatever load it carried.
- **Missions queue behind each other.** Nothing is sent into a running turn. A `danger` stop for one mission waits for a long re-plan of another to end.
- **`danger` is gated by the repo level, not the mission.** A repo at Hands-on never wakes the governor on `danger`. The Worker's own Main, who may stop it, is not told either; only the owner's Inbox alert is raised.
- **Project-era residue.** `bm_note` on a project writes a note only the Orchestrator reads, beside a project memory that Mains and Workers read. A new Orchestrator rereads project notes through `bm_projects`. The Orchestrator home's README still describes it as telling Managers what to do.

The 2026-10-09 governor acceptance shows the per-mission design pays off: 4 wakes, about 697,000 input tokens, none ending without an action, against 33 wakes and 3.6 million tokens before. Splitting the governor per mission would multiply agents and quota and still need an arbiter above them. What needs to change is how the one governor works.

## Decision

1. **One governor for the machine.** The Orchestrator stays one agent that governs every mission. Arbitration and splits need the view across missions, and the Main is already the per-mission agent. No Orchestrator is created per mission.
2. **A mission per wake.** A `BM-EVENTS` message carries the events of one mission, or of the two missions of a conflict, and opens with that mission's **brief**, read when it is delivered. The brief holds the charter's goal and open done criteria, its repos and Main, its ladder families above step 0 with their figures, open cards, the governor's notes, and the newest governor journal lines and arbitrations. The governor can judge the wake from the brief and reads `bm_missions` only for more. Another mission's events wait for the next idle moment. A wake that carries a `danger` signal goes before the others.
3. **The conversation is disposable.** Every fact the governor needs lives in the stores. An idle Orchestrator whose chat the owner has left alone for 2 hours makes way for a fresh one after 24 hours, as before, or once its wakes have touched 4 missions, or after 10 wakes, whichever comes first. The owner's own conversation with it is never cut: while the owner wrote in the last 2 hours, it stays.
4. **`danger` follows the chain of command.** For a Worker of a mission's request:
   - the plugin tells the Worker's **Main** at once (`BM-SIGNAL`: the Worker, the request, the redacted evidence, and to stop it with `cancel_agent` unless the owner asked for it). The Main already stops its own Workers (ADR-029 decision 5).
   - the governor is the **backup**: its `danger` event goes out 3 minutes after the alert, only if the alert still holds. If no Main could be told, it goes at once.
   - neither the event nor the governor's 10-minute interrupt allowance depends on the repo level. For a request of no mission, the repo-level scope stays as it is.
   - the governor's stop keeps its authority rule: a class the owner delegated, the owner's own latest word in its chat, or a decision the owner answered. Without one, it asks the owner with `bm_ask_owner` and stops on the answer. This change widens who hears of a danger, not who may stop a Worker.
   - the plugin itself still stops nobody, and the owner's Inbox alert is unchanged.
5. **No project-era residue.** `bm_note` on a project writes a `decision` entry to that repo's project memory, as the owner's word with the Orchestrator's chat as its source (the note holds a decision, preference or standing instruction of the owner's), so Mains and Workers carry it in their briefs. The governor's own notes are per mission. Older project notes stay readable and are no longer written. The Orchestrator's first prompt and its home README describe the governor of missions.
6. **Measure before splitting.** Wake records name their missions and count the acts aimed at another mission (`offMission`). A danger log records when each danger alert was raised, when its Main and the governor were told, and when it ended. The evaluation replay reports these as A-13. Decision 1 is revisited, and a per-mission governor run considered, only when a field period of at least 7 days with at least 3 open missions shows any of these:
   - more than one off-mission act;
   - a median danger-to-end time above 5 minutes on dangers that needed the backup;
   - M-26 above 20 %;
   - a median of the input tokens read per wake above twice the acceptance baseline of 175,000.

## Consequences

- One mission's events no longer share a governor turn with another's, and a danger is not held behind a long re-plan.
- A Worker's dangerous command reaches the agent that runs it within the same minute, at any repo level, and the governor steps in only when the Main does not.
- More, shorter wakes: up to one per mission per idle moment instead of one merged message. Each wake reads one brief instead of every mission.
- The Orchestrator is replaced more often. Its chat with the owner is kept, because the owner-silence rule holds for every reason.
- Stored formats grow additively: `missionIds` and `offMission` on a wake, and `orchestrator/dangers.json`. An older build ignores both. Project memory keeps its format: an Orchestrator's note is an owner entry whose source names the Orchestrator's chat.

## Alternatives considered

- **One Orchestrator per mission.** It would duplicate the Main's context, blur who runs the mission, multiply quota use, and still need an arbiter for conflicts and splits. Rejected.
- **A short-lived governor run per mission signal** (a one-shot agent under the Orchestrator). It isolates context and runs missions in parallel, but adds agents to the owner's list and creation cost on every signal. Deferred to decision 6's evidence.
- **Keep one merged message and only shorten the 24-hour refresh.** The mixing within a wake and the queueing behind other missions would remain. Rejected.
- **Wake the governor first on `danger`, and tell the Main only of the stop.** The governor is the farther authority and may be busy with another mission. Rejected in favour of the chain of command.
