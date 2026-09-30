# Implementation Plan — Orchestrator coordination (ADR-016)

| Field | Value |
|---|---|
| Status | Completed (2026-09-29) |
| Plan-ready | PASS — 2026-09-29 — hieu.nt10 (owner approved items 1–6 of the role review) |
| Owner | hieu.nt10 |
| Decision | [ADR-016](../../adr/ADR-016-orchestrator-coordinates-workers-live.md) |
| Requirements | [Orchestrator PRD](../../product/paseo-bm-orchestrator-prd.md) REQ-071 (d), REQ-083 → REQ-087 |
| Technical Design | [paseo-bm-orchestrator.md](../../design/paseo-bm-orchestrator.md) §6B, §9 |
| Target release | None — the owner tests on the real daemon, then decides |

## 1. MVP-Lock

In: §6B.1–§6B.7 and §9 of the design. Out: releasing; the plugin interrupting by itself. Exit: every AC of REQ-083 → REQ-087 and REQ-071 (d) with tests; boundary suite updated (direct Worker commands only in Autopilot with a Manager copy; interrupt only with an open danger; gate refusals send nothing; `bm_repo` never writes); `npm run verify` and `smoke:packed` green; an acceptance run on an isolated daemon with a run record. Posture: reversible with git; Autopilot off by default.

## 2. Work packages

| WP | Outcome | Design | Needs |
|---|---|---|---|
| WP-901 | Foundations: `BM-COMMAND` builder/parser, the decision gate, `BM-COMMAND` in `PREFIXES`, store additions (notes, allowed categories, decision options, Worker-signal keys), additive contracts | §6B.1, §6B.4 (store parts), §6B.5 | — |
| WP-902 | Live watch of running Workers: six signals, `BM-EVENT worker-signal`, interrupt allowance | §6B.3 | WP-901 |
| WP-903 | Tools and delivery: every delivered command as `BM-COMMAND` (tools and tab), `bm_direct_worker`, the gate on sends, `bm_repo`, `bm_note`, `bm_ask_owner` options, fresh Orchestrator after a day | §6B.1, §6B.4–§6B.6, §7 | WP-901 |
| WP-904 | Role files: Orchestrator (template, direct Worker rules, repo, notes, gate), Manager and Worker (`BM-COMMAND`, copies) | §6B.1, §3.2 | WP-901 |
| WP-905 | Chat cards: `BM-COMMAND` card, compact event lines | §6B.2 | WP-901 |
| WP-906 | Dashboard: state additions and the coordinator's tab | §6B.7, §9 | WP-901 |
| WP-907 | Boundary suite, documents, acceptance | §10, §12 | WP-902 → WP-906 |

## 3. Risks

The gate's false positives go to the owner (safe side); a direct Worker command could conflict with the Manager's plan — the copy keeps the Manager informed; timeline polling is bounded (5 Workers, 300 entries, 2 minutes).

## 4. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-29 | hieu.nt10 (drafted by Claude) | **Completed.** 7 beads under `bm-orchestrator-coordination-ouuu` closed; `npm run verify` (129 files, 3,755 tests) and `smoke:packed` green; acceptance on an isolated daemon ([run record](../operations/paseo-bm-orchestrator-coordination-run-20260929.md)) passed the direct-Worker chain via `danger`, the gate, `bm_repo`, the dashboard fields and cleanup; its findings F1 (`failing` on Claude timelines) and F2 (the gate holding a stop during danger) and F3–F5 fixed the same day with tests, not re-run on a daemon. Archived |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for ADR-016 |
