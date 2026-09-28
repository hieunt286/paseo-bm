# ADR-010 — The plugin serves schema-backed tools to its own agents over MCP HTTP

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-24 |
| Owner | hieu.nt10 |
| Related | [design-delta-20260924b-agent-tools](../archive/design/paseo-bm-delta-20260924b-agent-tools.md); [ADR-004](ADR-004-paseo-config-mutation.md) (the plugin does not edit the Paseo config); [ADR-006](ADR-006-role-registration.md) (roles registered through provider aliases) |
| The owner's decisions | 2026-09-24: Q1 (a), Q2 (a), Q3 (a) of the delta above |

## Context

Agents write `BM-*` blocks by hand, and the plugin reads them back with a regex. The instructions and the checker are two descriptions of one format, they drift apart, and every drift costs a `BM-FORMAT` turn. The owner wants to fix this at the root, and wants the fix to be **available as soon as the user installs the plugin**, with no additional install step.

Paseo 0.8 lets a plugin attach an MCP server to an agent about to be created (`before("agent.create")` → `config.mcpServers`) and pre-approve tools (`config.toolPolicy.preapproved`). Paseo delivers its own tools to agents over MCP `http`.

## Decision

1. **paseo-bm's server process serves an HTTP MCP endpoint** on `127.0.0.1`. The port is chosen once and stored in the install home, so that a live agent keeps its tools across plugin reloads.
2. `before("agent.create")` attaches that endpoint **only to `bm-*` agents** and pre-approves exactly the tools of that role. It does not touch the Paseo config (ADR-004 stays unchanged), and does not touch other agents on the machine.
3. **The tools have no side effects:** they validate input with a Zod schema in `shared/` and return a `BM-*` block built from the schema, or per-field errors. The agent sends the block itself, as before. So the endpoint needs to know neither who is calling nor any authentication.
4. **The schema is the single source of the format.** The block text does not change, so every party that reads the text (the chat card, the Dashboard, traces, the qa-ledger) does not change.
5. **The hand-written path is kept permanently** as a fallback; the checker and `BM-FORMAT` stay unchanged for it.

## Consequences

- Agents created before this version have no tools (the `agent.session_open` hook can only change `env`); they keep writing by hand.
- The plugin opens a listening port on loopback. The tools read, write and send nothing, so another process on the machine calling in gets nothing but the text it put in itself.
- If the old port cannot be kept (it is taken), the plugin picks a new port; old agents lose the tools and go back to writing by hand.
- Paseo **refuses to create an agent** when the request has a `toolPolicy` and the provider cannot pre-approve MCP tools (only claude, codex, opencode can). So the tools are attached only when the alias's base provider is in that list; for Pi, Copilot or a provider that cannot be read, nothing is attached, and the agent writes blocks by hand as today.

## Alternatives considered

- **The tool sends the block itself** (Q1 b): saves one step but has to identify the calling agent, keep the rule "do not send into a running turn", and change how the chat card recognises the sender. Can be done later, on top of this decision.
- **A `stdio` script in the payload** (Q2 b): does not depend on a port, but needs a runnable `node` path; Paseo Desktop does not guarantee `node` on the `PATH`.
- **Drop the hand-written path after the migration** (Q3 b): a provider that does not support MCP would be unable to report.
