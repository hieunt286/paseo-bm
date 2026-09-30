# ADR-019 — Effectful actions are held before they run, through Paseo's permission events

| Field | Value |
|---|---|
| Status | **Proposed** (2026-09-29) — direction approved by the owner with the autonomy design; decided by the Phase 4 spike (PRD REQ-140): Accepted only if the spike passes, otherwise Rejected in favour of the documented fallback |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Supersedes (if accepted) | [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) decision 1's `danger` and `outside` signals as the safety mechanism (they stay as detection) |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-140 → REQ-142 · [Autonomy design](../design/paseo-bm-autonomy.md) Part D · [ADR-017](ADR-017-decisions-are-stored-objects.md) (grants) · [ADR-018](ADR-018-calibrated-autonomy-per-class.md) (policy) |

## Context

Workers run without permission prompts; their five rules are the only barrier, and a `git push` is seen by the live watch only after it ran. The field replay counts 203 effectful actions in two weeks, 75 of them with no owner text naming them first. Paseo emits `agent.permission_requested` to plugins and lets a plugin answer with `respondToPermission` — a boundary before execution, if it is reliable for each provider.

## Decision (proposed)

1. Workers (and Reviewers) run in a mode that asks for permission; the plugin answers every request itself, at once, from a fixed classification of the requested action.
2. Actions in the classes `release`, `data`, `dependency`, `network` and writes outside the workspace are **held**: the request stays pending and becomes a decision (ADR-017), unless a grant or the policy (ADR-018) covers it; everything else is allowed without delay.
3. If the plugin is not running, requests fall back to Paseo's own permission UI for the owner — nothing is allowed silently.
4. Adopted only if the spike shows, per provider (Claude, Codex, OpenCode), that holding is reliable, that the added latency stays within the design's budget, and that the fallback in 3 holds.

## Consequences (if accepted)

- A-6 (unauthorised effectful actions executed) can reach 0 by prevention, not detection.
- Worker speed depends on the plugin answering permissions; a slow or crashed plugin shows as waiting permissions.
- Providers whose permission requests do not carry the command or path cannot be classified; they keep detection only.

## Alternatives considered

- **Detection only (today)** — kept as the fallback (PRD REQ-142).
- **Regex on the Worker's intent before it acts** — not possible: the plugin does not see a tool call before it runs except through the permission request.
