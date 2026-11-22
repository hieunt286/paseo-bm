# ADR-050 — Decisions the code took without an ADR, recorded by the 2026-11-16 review

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-11-16 |
| Owner | hieu.nt10 |
| Amends | [ADR-018](ADR-018-calibrated-autonomy-per-class.md) decision 3, the Orchestrator's prediction in shadow; [ADR-028](ADR-028-projects-ask-each-other-through-the-plugin.md) decision 2, a bound Manager asking with `bm_ask_project`; [ADR-038](ADR-038-parallel-lanes-and-a-held-queue.md) decision 5, how a held request is kept |
| Sources | The owner's decisions of 2026-10-10 in the missions programme (missions design §19; autonomy design §B, *Retired*; `plugin/server/peer-tools.ts` header); `plugin/server/held-requests.ts`; the documentation review the owner asked for on 2026-11-16 |

## Context

The documentation review of 2026-11-16 compared every accepted ADR with the code. Three decisions run in the code and the designs but in no ADR, so ADR-018, ADR-028 and ADR-038 still read as if the older choice were current. On 2026-10-10 the owner retired the Orchestrator's challenger prediction (`bm_predict`) and `bm_ask_project` for a Main, while the missions programme was built; and the held queue was built as a store of its own rather than as registered requests.

## Decision

1. **The Orchestrator predicts nothing.** `bm_predict` is retired. In shadow, the only predictions recorded are the Worker's recommendation and, on a mission, the Main's (`prediction.main`). A stored `prediction.orchestrator` from before is still read and shown.
2. **A Main does not ask another project with `bm_ask_project`.** It gives the work a Worker in a repository of its mission, adds the repository to its mission, or asks the other mission with `bm_ask_mission`. `bm_ask_project` belongs to Workers: inside a mission it reaches the Worker's own Main (`ask-main`). A link a Manager asked before stays readable and writable on its asking side.
3. **A held request is kept in its mission's held queue.** It is stored in `missions/<missionId>.held.json` with a `hold-…` id and the Main's `bm_create_worker` input, and gets a request id only when paseo-bm creates its Worker. When it starts and when it stops follow ADR-045's finish gate.

## Consequences

- Nothing changes in the product: this records what has run since 2026-10-10.
- ADR-018, ADR-028 and ADR-038 keep their other decisions.
