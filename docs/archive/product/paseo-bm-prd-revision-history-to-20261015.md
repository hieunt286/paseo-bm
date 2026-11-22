# paseo-bm (Beads Management) — PRD — Revision History, 2026-10-02 to 2026-10-15

Moved verbatim out of [paseo-bm-prd.md](../../product/paseo-bm-prd.md) on 2026-11-16, during the documentation review; links were only re-pointed. Earlier rows are in [paseo-bm-prd-revision-history-to-20261002.md](paseo-bm-prd-revision-history-to-20261002.md). A historical record: never edited. Git holds the full audit trail.

| Date | Author | Change |
|---|---|---|
| 2026-10-02 | Claude (owner request) | Documentation restructure: earlier rows moved to the archive; stale, retired and duplicated content condensed to the current state (section numbers and REQ ids kept) |
| 2026-10-02 | hieu.nt10 (owner decision; written by Claude) | REQ-032 (d) is met again: Settings shows each role's instructions as a new agent gets them |
| 2026-10-02 | hieu.nt10 (owner decision; written by Claude) | §2: M-14 (a review round every time Worker touches documents or beads) removed; it contradicted the risk-sized review of REQ-024, which is the rule, and REQ-024 (g) now measures that rule |
| 2026-10-03 | hieu.nt10 (owner decisions Q1 a, Q2 b of ADR-027; written by Claude) | REQ-037: review rounds and the budget enforced in code for Workers whose tools know their caller, a behavioural guardrail for the rest; REQ-025 (c): a stopped run reports `stopped`; M-17's method; §9's Phase 3 row. `prd-ready` re-run on the amended requirements: PASS |
| 2026-10-04 | hieu.nt10 (owner request; written by Codex) | REQ-021 (g): plugin-created Workers use concise request-derived titles while preserving the Worker role marker and colour; handoff successors use the same rule. `prd-ready`: PASS |
| 2026-10-09 | hieu.nt10 (owner request; written by Claude) | REQ-175 → REQ-183, M-19 → M-21, §3 and §9 rows: projects ask each other through the plugin, every Manager is bound, the noise that cost owner turns removed ([ADR-028](../../adr/ADR-028-projects-ask-each-other-through-the-plugin.md)). `prd-ready`: PASS (approved by Claude under the owner's delegation, 2026-10-09) |
| 2026-10-09 | Claude (owner's delegation) | §9: "Projects ask each other" built and accepted (M-19 = 0, M-20 = 0.1 s, M-21 = 0); not yet released |
| 2026-10-09 | hieu.nt10 (owner decisions; written by Claude) | §0: amended by ADR-029 and the missions PRD (REQ-020 b, REQ-021 a, REQ-176 → REQ-178 for Workers of a mission) |
