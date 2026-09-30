# Implementation Plan — Orchestrator Autopilot (ADR-015)

| Field | Value |
|---|---|
| Status | Completed (2026-09-29) |
| Plan-ready | PASS — 2026-09-29 — hieu.nt10 (owner decided Autopilot per project, reaction on questions/finished steps and the limits, and asked to optimise flow and UI) |
| Owner | hieu.nt10 |
| Decision | [ADR-015](../../adr/ADR-015-orchestrator-autopilot-per-project.md) |
| Requirements | [Orchestrator PRD](../../product/paseo-bm-orchestrator-prd.md) REQ-071, REQ-073, REQ-076, REQ-079, REQ-082 (2026-09-29) |
| Technical Design | [paseo-bm-orchestrator.md](../../design/paseo-bm-orchestrator.md) §6, §6A, §8, §9, §10 |
| Target release | None — the owner tests on the real daemon, then decides |

## 1. MVP-Lock

In: Autopilot per project, events on questions/finished steps, `bm_send_command` / `bm_ask_owner` / `bm_set_autopilot`, approval by the owner's chat message, proposal replacement, the limit line, longer messages, the watcher fix, the simplified tab. Out: anything to Workers/Reviewers, releasing. Exit: every AC of the requirements above with tests; the boundary suite updated (O-2 as rewritten); `npm run verify` and `smoke:packed` green; a short acceptance on an isolated daemon (an Autopilot project answers a Worker question by itself; a chat "send it" delivers a proposal) with a run record. Posture: all reversible with git; Autopilot off by default.

## 2. Work packages

| WP | Outcome | Design | Needs |
|---|---|---|---|
| WP-701 | Store and RPCs: settings v3 (autopilot map), decision entries, proposal replacement, `set-autopilot`, `state` additions, `ask` with `decisionId` | §5.4, §6A, §8 | — |
| WP-702 | Watcher: every request of 24 h, Manager left out of "running", timer when watch or Autopilot, `BM-EVENT` on questions/finished steps of Autopilot projects | §6, §6A | WP-701 |
| WP-703 | Tools and instructions: `bm_send_command` (Autopilot or chat check, limit line, delivery), `bm_ask_owner`, `bm_set_autopilot`, message caps, `roles/orchestrator.md` | §6A, §3.2 | WP-701 |
| WP-704 | Tab: Needs you / Projects (Autopilot switch, state, latest action, Assess, Ask) / Activity | §9 | WP-701 |
| WP-705 | Boundary suite, user documents, REQ-047 wording, acceptance run | §10, §12 | WP-702, WP-703, WP-704 |

## 3. Risks

A wrong Autopilot answer costs a Worker turn (limit line + instructions guard commits, deploys and real data); a chat approval is recognised only by `clientMessageId` on the latest inbound message; events are deduplicated per report.

## 4. Revision History

| Date | Who | Change |
|---|---|---|
| 2026-09-29 | hieu.nt10 (drafted by Claude) | **Completed.** 5 beads under `bm-orchestrator-autopilot-muzh` closed; `npm run verify` (125 files, 3,412 tests) and `smoke:packed` green; acceptance on an isolated daemon passed ([run record](../operations/paseo-bm-orchestrator-autopilot-run-20260929.md)); its findings (chat approval wording, the Manager repeating the limit line, the watch dialog sentence) fixed the same day. Archived |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Plan for ADR-015 |
