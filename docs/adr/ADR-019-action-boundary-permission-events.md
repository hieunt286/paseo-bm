# ADR-019 — Effectful actions are held before they run, through Paseo's permission events

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-30) for Claude and Codex, OpenCode keeping detection — decided by Claude under the owner's delegation, 2026-09-30, from the [spike report](../archive/operations/paseo-bm-action-boundary-spike-20260930.md) (see "Decision record"). Proposed 2026-09-29, direction approved by the owner with the autonomy design |
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

## Decision record (2026-09-30)

Decided by Claude under the owner's delegation, 2026-09-30, from the spike report ([run note](../archive/operations/paseo-bm-action-boundary-spike-20260930.md), bead `bm-autonomy-phase4-loga.1`, isolated daemon, Paseo 0.9.2). Decision 4 was applied per provider:

- **Claude — Accepted.** In `default` and `acceptEdits` every representative of the five classes raised `agent.permission_requested` with its command, path or URL before it ran, and nothing ran before the answer; added latency p90 201 ms; requests waited 15 min with no timeout, and waited for the owner while the plugin was stopped. `auto` does not qualify (its classifier decides; the plugin saw no request).
- **Codex — Accepted, in one configuration only:** mode `auto` with `providerOptions { approval_policy: "untrusted", sandbox_mode: "danger-full-access", web_search: "disabled" }` set at creation (`sandbox_mode: "workspace-write"` for a role that never releases), a file change's path read from its pending timeline item (the request carries none), and an unreadable request held. Added latency p90 163 ms; holding and plugin-down as for Claude. The two modes §D.1 named do not qualify: `auto` alone asks only when the model escalates, and `auto-review` routes approvals to Codex's auto-reviewer.
- **OpenCode — Rejected; it keeps detection** (decision 4 fails): with the user's own OpenCode config nothing is asked; with a permission config injected at creation, tools from OpenCode plugins and MCP servers still raise nothing, and `permission_resolved` never reaches the plugin. Every provider not measured keeps detection too.
- **Decision 3 holds as measured, with one limit:** requests raised while the plugin is down wait for the owner in Paseo's UI and nothing runs, but what the plugin sets at creation (the Codex options) is absent from an agent created while it is down; that agent runs its mode preset and is covered by detection only.

The Phase 4 start revises design Part D from the report (its §9 holds the proposed text), including the classification patterns and the modes per role.

## Consequences (if accepted)

- A-6 (unauthorised effectful actions executed) can reach 0 by prevention, not detection.
- Worker speed depends on the plugin answering permissions; a slow or crashed plugin shows as waiting permissions.
- Providers whose permission requests do not carry the command or path cannot be classified; they keep detection only.

## Alternatives considered

- **Detection only (today)** — kept as the fallback (PRD REQ-142).
- **Regex on the Worker's intent before it acts** — not possible: the plugin does not see a tool call before it runs except through the permission request.
