# paseo-bm — Missions and their Mains PRD — Revision History up to 2026-10-15

Moved verbatim out of [paseo-bm-missions-prd.md](../../product/paseo-bm-missions-prd.md) on 2026-11-16, during the documentation review; links were only re-pointed. A historical record: never edited. Git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-09 | hieu.nt10 (owner decisions; written by Claude) | Created from the discussion of 2026-10-09. `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-09 | Claude (owner's delegation) | After the design review: REQ-189 states who decides a Worker's question at each layer; Q-200 at level 2; Phase 0 (ADR-030) |
| 2026-10-10 | hieu.nt10 (owner request; written by Claude) | REQ-197 → REQ-201, M-28 → M-30, Phase 4 and the Orchestrator's actor line: one governor, a mission per wake, a disposable conversation, `danger` to the Main first, notes into project memory, the governor's scale measured ([ADR-032](../../adr/ADR-032-one-governor-a-mission-per-wake.md)). `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-10 | hieu.nt10 (owner approval of the five changes; written by Claude) | REQ-202 → REQ-208, M-31 → M-35, Phase 5: the mission runtime — state of record, a long-lived Main, one authority, the Main's asks as decisions, one owner, a signal budget, the mission page's in-flight part ([ADR-033](../../adr/ADR-033-the-mission-is-the-system-of-record.md)); REQ-199 (a)'s `BM-SIGNAL` now arrives through the Main's channel (REQ-207). `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-10 | Claude (as built) | Phase 5 built: the automated checks pass (the M-31 property test, the M-32, M-34 and M-35 unit tests, A-14 in the replay); the mission page matches the approved mockup ([mission-runtime.html](../../design/mockups/mission-runtime.html)). REQ-206 (d): no client entry point opens a Manager for one request yet; `manager.ensure` takes `requestId`, and by workspace the owner's mission comes first. What remains is the owner's isolated-daemon drill |
