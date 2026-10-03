# ADR-013 — Orchestrator: the plugin creates an assessment agent when asked, and nudges running agents when switched on

| Field | Value |
|---|---|
| Status | **Superseded** by [ADR-014](ADR-014-orchestrator-agent-proposes-owner-approves.md) (2026-09-28) — was Accepted 2026-09-28; built and tested, rejected by the owner before any release |
| Date | 2026-09-28 |
| Owner | hieu.nt10 |
| Related | [Orchestrator PRD](../archive/product/paseo-bm-orchestrator-prd.md) (REQ-075, REQ-078, REQ-079) · [Orchestrator Design](../design/paseo-bm-orchestrator.md) · [ADR-005](ADR-005-manager-as-agent.md) (agents belong to the user) · [ADR-007](ADR-007-dashboard-trace-store.md) (trace store) · [ADR-010](ADR-010-plugin-hosted-agent-tools.md) (MCP tools with no side effects — unchanged) · [ADR-012](ADR-012-plugin-is-the-product.md) (the plugin creates roles) |
| Amends | REQ-047 of the [Dashboard PRD](../product/paseo-bm-dashboard-prd.md): the Dashboard stays read-only; the two actions below are the only exception and belong to the Orchestrator |
| The owner's decisions | 2026-09-28: intervention yes, but behind a flag that is off by default, and only in the form of nudging running agents; observe only paseo-bm's agents; assessment by an LLM only on a click, with a new role `bm-orchestrator` |

## Context

Up to 0.4.1 the plugin **observes** the agents' work (the trace store, the Metric screen) and **acts** on agents only in a few narrow places, all needed by paseo-bm's own flow: injecting instructions and choosing the mode when an agent is created, `BM-FORMAT` when a report has the wrong format, `BM-BUDGET` when the review budget is exceeded, `BM-SETTINGS`/`BM-FALLBACK` when the settings change or a usage limit is reached. The Dashboard promises never to send a prompt or create an agent (REQ-047).

The owner wants a role that assesses how the agents coordinate and helps that improve. Two capabilities need an architecture decision because they expand what the plugin does to agents by itself: **creating an agent** to assess with a model, and **sending a message** into the chat of a running Manager/Worker when a rule detects a deviation.

## Decision

1. **Rule-based assessment is the default and has no effect on anything.** Flags are computed by a pure function from the stored traces of paseo-bm agents; no model, no network, no messages sent.
2. **The plugin may create exactly one `bm-orchestrator` agent each time the user clicks Assess and confirms.** That agent has no Paseo tools (it cannot create or message agents); the plugin's MCP server gives it only `bm_assessment`, with no side effects as in ADR-010 decision 3; the provider's own tools remain, and read-only behaviour relies on the role instructions together with Reviewer's mode-selection rule — exactly like Reviewer today. It receives the redacted traces and runs one turn. The plugin does not archive or delete it (ADR-005).
3. **The plugin may send a `BM-NUDGE` notice to the Manager or Worker of a running request, only when the user has turned on the "Nudge running agents" switch (off by default) and selected that rule.** Each rule at most once per request. A Manager nudge goes through the existing notice queue. For a Worker, the owner allowed a more proactive Orchestrator (2026-09-28): while the switch is on, the plugin watches the running Workers of Small requests (a bounded timer, the plugin's only periodic task), and sends a Worker nudge at once — which **replaces the Worker's running turn**; the nudge tells the Worker to check the state of what it was doing before it continues. A Worker whose latest report is `blocked` (waiting for the user) or `finished` is never nudged. Turning the switch off stops the watcher and drops every pending nudge.
4. **No other action.** The Orchestrator does not stop, cancel a turn (other than the running Worker turn a nudge replaces, decision 3), archive or delete an agent; does not answer on the user's behalf; does not edit beads, documents, settings or role instructions — a proposed instruction change is only added to "Additional instructions" when the user clicks and confirms.
5. **The user's words always win.** `BM-NUDGE` states itself that it is a suggestion from the plugin; the role instructions of Manager and Worker say so.

## Consequences

- There is an improvement loop with a human reviewer: a rule reports a deviation → Assess gives an opinion and proposals → the user decides to apply → fewer deviations next time.
- A fourth role is added to the Paseo configuration, and a new kind of notice that agents must understand; agents created by an older version do not know `BM-NUDGE` (the flag being off by default reduces this risk).
- Conversation content (redacted) is sent to the provider the user chose for `bm-orchestrator`, on every Assess click; the confirmation dialog says so plainly, and it costs the user's tokens.
- Each Assess leaves an agent in the workspace; the user archives it themselves.
- A Worker nudge interrupts the Worker's current step, and a shell command it was running may be cut short (a partial `npm install`, a half-written file). The nudge tells the Worker to check its state first; the risk is limited to Small requests, one nudge per rule and request, and only while the user keeps the switch on.
- While the switch is on, the plugin reads the live timeline of up to 5 running Workers every 30 seconds — its only periodic task.
- The "Dashboard is read-only" boundary has two named exceptions, each behind a confirmation or a flag, each with negative tests.

## Alternatives considered

- **A continuously running orchestrating agent that reads every conversation and intervenes on its own** — rejected: overlaps with Manager's role (two parties giving orders), costs tokens all the time, is not deterministic, and someone would have to assess it in turn.
- **No intervention at all, only reporting** — the owner chose intervention behind a flag (2026-09-28).
- **Stronger intervention (stopping stuck turns, applying proposals automatically)** — the owner chose only nudging; stopping a turn may cut off correct work, and applying automatically bypasses the human reviewer.
- **Assessment by the plugin calling a model API itself** — rejected: the plugin never reads or holds credentials; running through a Paseo agent uses exactly the provider and login the user already has.
- **Reuse the Reviewer profile for assessment** — rejected (the owner chose a new role): the instructions and cost of assessment would mix with the real Reviewer's, and the hook cannot tell the two kinds of agent apart on the same provider.
- **Store the assessment result right inside the tool call** — rejected, as ADR-010 already rejected it (the endpoint does not know which agent is calling): the plugin reads the tool call's input from the agent's timeline at the end of the turn.
