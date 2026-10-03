# Change-014 — Autonomy levels, Ask back, and a flat management surface

| Field | Value |
|---|---|
| Status | Active |
| Date | 2026-10-01 |
| Owner | hieu.nt10 (decided; the owner delegated the build to Claude: "I give you the right to decide on your own; carry it through to completion") |
| Decisions | [ADR-025](../../adr/ADR-025-autonomy-levels.md) |
| Mockup | the owner's approved design canvas "Beads Manager — flat redesign" (2026-10-01): Inbox, Projects (Overview · Requests · Beads · Metrics · Agents), Settings, Tools & skills |
| Plan-ready | PASS — 2026-10-01 — Claude under the owner's delegation |

## Outcomes

1. **Levels** (ADR-025).
   - `autonomy.set-level { workspaceId, level 0–4, confirmed? }` writes the nine cells and the prediction switch as the level's pattern; `autonomy.policy` reports each project's `level` (0–4 or `custom`).
   - No class is owner-only:
     - `canDelegate` is true for every class;
     - policy, precedent, advice, command authority and the action boundary drop their owner-only refusals;
     - a policy answer may grant any effect its option declares.
   - The `recommended` autonomy predictor is removed, along with the policy's instant recommended answer; a stored `recommended` cell reads as `orchestrator`. The agreement ledger keeps its own prediction keys (`recommended` and `orchestrator` are measured, not chosen).
   - Demotion on reversal or override is removed (store field, alert kind, ledger window): an override is recorded only.
2. **Co-pilot shows the proposal.**
   - While a project's level is ≥ 1 and the Orchestrator predicted an unsettled decision, `decisions.get` and `decisions.list` return the prediction (`prediction.orchestrator { optionKey, reason }`).
   - The card marks that option "Orchestrator suggests", with its reason, as the primary action. The asker's recommended option keeps its ★.
3. **Ask back.**
   - The owner asks the asker of an open `q:` or `o:` decision a question from its card (`decisions.ask { id, text }`). It is stored in a thread beside the decision (a new store file; the decision stays open) and delivered as a plugin notice `BM-ASK` through the notice queue.
   - The asker answers with the tool `bm_reply { decisionId, text }` (Worker and Orchestrator), which appends to the thread.
   - The card shows the thread. Held (`h:`) decisions have no Ask back: their Worker is mid-call.
4. **Skill usage.** A read-only RPC returns, per project or for all projects, how many recorded reports named each skill (`skillsUsed`).
5. **Surface.**
   - The sections are **Inbox · Projects · Settings · Tools & skills**.
   - **Projects** lists projects, and a project page has tabs **Overview · Requests · Beads · Metrics · Agents**. Metrics carries what Insights showed for one project; Insights as a section is retired.
   - **Settings:**
     - **Autonomy** is one slider per project: Hands-on, Co-pilot, Cruise, Turbo, Full auto. Turbo and Full auto ask for a confirmation, Cancel first.
     - The Hold-risky-actions switch (the action boundary) sits under the slider.
     - **Coordination** is expanded: compaction, handoff, review budget and advice.
     - **More** folds Agents, Precedents and Data.
   - **Tools & skills** lists skills with their use counts and install state, the agent tools by role, and `br`/`bv`.
6. **Flat style.**
   - Square corners (radius ≤ 2), 1 px borders, no pill chips.
   - The kind of an item is a 3 px left bar.
   - Colour only in small marks (bars, dots, the left bar); text stays foreground or muted.
   - All colours come from the theme. Chat cards share the style.

## Work packages and order

| Wave | Bead | Files (disjoint within a wave) |
|---|---|---|
| 1 | levels-server (outcome 1, 2 server side) | shared/autonomy.ts, shared/decisions.ts, shared/precedents.ts, shared/prepared-changes.ts, shared/orchestrator-command.ts, shared/alerts.ts, shared/autonomy-ledger.ts, shared/bm-tools.ts, shared/contracts/{autonomy,errors}.ts, server/{autonomy-store,autonomy-rpc,policy-resolve,event-bus,action-boundary,command-authority,decision-override,decision-materialiser,orchestrator-decide-tools,orchestrator-findings,decision-rpc,prepared-changes,fallback-decisions,orchestrator-decisions}.ts, scripts/eval/suite.ts, their tests |
| 1 | skills-usage (outcome 4) | a new server module and RPC, shared/contracts/dashboard.ts addition, index.server.ts registration, its test |
| 2 | ask-back-server (outcome 3 server) | a new thread store, RPC module, notice marker, `bm_reply` tool, contracts/decisions.ts, role-hook grants, tests |
| 2 | settings-and-tools-ui (outcome 5 Settings, Tools screen) | client/settings-*.tsx/ts, a new client/tools-screen.tsx, their tests |
| 2 | projects-ui (outcome 5 navigation, Projects) | client/{surface-view,launcher,work,work-model,insights,insights-model,beads-screen,beads-tab}, their tests |
| 3 | flat-and-inbox-ui (outcomes 2, 3 client, 6) | client/{styles,tone,ui,chat-card*,inbox,inbox-model,chat-beads-panel,agent-tree,launch-manager,markdown-view}, their tests |
| 3 | docs (coordinator) | PRD, designs, GUIDE, README, baseline |

Each wave ends with the coordinator's full `npm run verify`.

## Out of scope

The work-order ledger and SQLite (brainstorm of 2026-10-01). Worker reuse. A plugin release.
