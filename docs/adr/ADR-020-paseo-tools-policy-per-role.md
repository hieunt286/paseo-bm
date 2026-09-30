# ADR-020 — Every role's Paseo-tools policy is written explicitly

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — approved by Claude under the owner's delegation |
| Date | 2026-09-29 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-006](ADR-006-role-registration.md) decision 9 (the Reviewer constrained by leaving `paseoTools` unset) and the "Reviewer: key omitted" part of decision 3 |
| Related | [Calibrated autonomy PRD](../product/paseo-bm-autonomy-prd.md) REQ-116 · [Autonomy design](../design/paseo-bm-autonomy.md) §A.10 · run note [paseo-bm-role-tools-run-20260929](../archive/operations/paseo-bm-role-tools-run-20260929.md) |

## Context

ADR-006 left `paseoTools` unset on the Reviewer and relied on its instructions, noting the configuration layer "may have no effect" while `daemon.mcp.injectIntoAgents` is on. Paseo 0.9.2 reads an absent policy as enabled, so a Reviewer — and later the Orchestrator — received every Paseo tool. A live run on an isolated daemon (2026-09-29) showed that an explicit policy works: `enabled: false` attaches no Paseo MCP server at all, and `disabledTools` removes exactly the named tools.

## Decision

1. Every `bm-*` alias and fallback alias carries an explicit policy: Reviewer and Orchestrator `{ enabled: false }`; Manager `{ enabled: true, disabledTools: [kill_agent, archive_agent, archive_workspace, respond_to_permission, list_pending_permissions, set_agent_mode, update_agent, and the schedule and heartbeat tools] }`; Worker the Manager's list plus `create_workspace`, `rename_workspace`.
2. `ensureRoles` applies the policy to existing aliases (only the `paseoTools` key changes); a policy Paseo does not keep fails the setup (`E_SETUP_ROLES_FAILED`) rather than letting a Manager be created without limits.
3. The role pairing (Manager → Worker, Worker → Reviewer) is checked on `agent.created` and raised as an Inbox alert: the creation hook cannot see the creator (verified 2026-09-29).

## Consequences

- Paseo re-reads the policy at every session open, so existing agents also get the limits at their next resume — safer than the "until replaced" the design first assumed.
- A role that needs a new Paseo tool must be added to the policy deliberately.

## Alternatives considered

- Keep the key unset and rely on instructions (ADR-006 d9) — rejected: measured to grant every tool.
- Refuse a mismatched creation in the hook — not possible: the hook does not see the creator.
