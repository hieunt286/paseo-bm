# ADR-029 — Missions and their Mains; the Orchestrator governs the process

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-09) — the owner's decisions of the discussion of 2026-10-09; technical choices by Claude under the owner's delegation |
| Date | 2026-10-09 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-005](ADR-005-manager-as-agent.md) decision "one Manager per workspace" (REQ-020 b); [ADR-011](ADR-011-manager-coordinates-workers.md) "the Manager coordinates the Workers of its workspace" (a Main coordinates the Workers of its mission, in any repo of it); [ADR-016](ADR-016-orchestrator-coordinates-workers-live.md) decision 2 (the Orchestrator corrects and answers Workers directly) — it may only stop one; [ADR-021](ADR-021-orchestrator-measured-coordination-controller.md)'s ladder step "correct the Worker" and its model-decided compaction and handoff — they run in code; [ADR-025](ADR-025-autonomy-levels.md) decision 5 ("the Orchestrator is the only predictor") — a Main decides its Workers' questions; [ADR-028](ADR-028-projects-ask-each-other-through-the-plugin.md) decision 3 (another project's Manager receives an ask) — the asker's own Main routes it |
| Keeps | ADR-027 (agents write content, code carries it); ADR-028's link store, deliveries, `forPeer`, waits, bounds and the hook binding; ADR-025's per-project levels, now the **repo** level; ADR-019's action boundary |
| Related | **PRD: [missions PRD](../product/paseo-bm-missions-prd.md)** · **Design: [missions design](../design/paseo-bm-missions.md)** · [Orchestrator design](../design/paseo-bm-orchestrator.md) · [autonomy design](../design/paseo-bm-autonomy.md) Parts A, B, G |
| Lane | Designed: new stored formats, new and changed agent tools, role behaviour, agent creation across workspaces, the Orchestrator's authority |

## Routing Decision

- Variant preset: brownfield (a product-shape change of a running system).
- Triggered risks: consumed contracts (tools, `BM-*` deliveries, RPCs, stored formats), agent permissions and authority (who briefs, decides and creates agents), role behaviour of every role, architecture (supersedes parts of five ADRs), a new UI screen.
- Required artifacts and gates: this ADR; the missions PRD (`prd-ready`); the missions design (`design-ready`, checked against the code by an independent review); a phased plan with beads (`plan-ready-for-beads`); an approved mockup before the Missions screen is coded; `feature-done`.
- Execution path: plan → converter → implement, in three phases. Releasing stays out of the plan.
- Exceptions: none.
- Decided: 2026-10-09 — hieu.nt10 (product decisions), Claude under the owner's delegation (technical choices).

## Context

The 2026-10-07 → 09 field traces of a frontend (`xspace-ai-assistant`) and a backend (`ai-assistant`) project, before and after ADR-028:

- **The owner thinks per goal, the plugin per repo.** The owner typed "ask the backend …" six times, twice into the backend's own chat; asked "what is left per the PRD" in both projects at once; and still opened every cross-project exchange.
- **The hop through another project's Manager only fragments.** Four asks from one frontend feature became four backend Workers that re-read the PRD four times, duplicated investigation and edited `01-prd.md` over each other. The one useful thing at that hop — routing to the Worker already on it — one Manager did and the other did not. After a link was taken, all 27 follow-up messages were Worker ↔ Worker and worked well.
- **Managers churn and drop work.** Four Managers in a day across two projects; a prepared command failed ("no longer a live manager"), an owner decision never reached its Worker ("request belongs to another Manager").
- **The Orchestrator was busy in the wrong place.** 33 wakes, ~3.6 M input tokens; it decided 20 Worker questions, one by fabricating an owner fact ("I filled in the userId") and one passed to the other project as the owner's choice; the owner overturned 4 of its 7 recommendations; 11 of 18 `request.finished` wakes did nothing. Meanwhile nobody tracked progress against the goal, nobody noticed four Workers on one feature or a growing pile of unapproved documents.

## Decision

1. **A mission is stored data; a Main is the agent carrying it.** A mission (`<data>/missions/`) holds its **charter** — a name and a short code the owner gives, the goal, the repos in scope, non-goals, done criteria and a rough budget — its plan, a cross-repo contract register, its decisions, its Worker roster and a journal. A **Main** is a Beads Manager (`bm-manager`, role `manager`) labelled with the mission. A Main is replaceable: a successor reads the mission and continues, so a mission may run for months. Many missions run at once, one per goal.

2. **All Mains live in one shared home.** The plugin opens `<data>/missions/home` as a workspace (as it does the Orchestrator's), and every Main is created there, titled `🟣 M · <CODE> <name>` from the mission store, kept in sync on a rename or a cleared conversation. The home is not a project: project views, `bm_projects`, `bm_peers` and event scopes leave it out.

3. **The owner creates and closes missions.** A mission is created by the owner — from the Missions screen, or in words to a new Main that records it with a tool, settled only on the owner's own message. Only the owner closes a mission; a Main never closes itself, and the Orchestrator only points at a mission that has been idle long.

4. **A request lives in the repo of its Worker; a Main owns requests in many repos.** A Main creates Workers in any repo of its mission's scope, several per repo when the work splits: the Worker's `cwd`, binding, request registry entry, outbox, decisions, autonomy level and action boundary are those of **the repo**. The registry entry names the Main (`managerId`) and the mission (`missionId`); a mission roster maps each request to its repo. Every Main-side lookup goes through the roster, never through the Main's own workspace. Request ids are unique machine-wide.

5. **One chain of command.** Each Worker belongs to exactly one Main and one repo; only its Main briefs, wakes or stops it (the owner and, on real risk, the Orchestrator may stop it too). A Main links its own Workers with each other — Worker ↔ Worker peer links, opened by the Main, on which they then talk directly. A Worker's ask for another repo goes to **its own Main**, which links it to the Worker already on that work or creates one (`peerLink`); there is no hop through another project's Manager. Workers of two missions never talk directly: their Mains talk (a Main ↔ Main link). A Main touches only the repos of its charter; adding one is a mission-level decision. A Main changes nothing itself.

6. **Two autonomy layers.** The **repo level** (ADR-025's per-project levels, unchanged in form) governs the work in that repo: a Worker's question whose class the repo delegates is decided by **the request's Main**, which holds the goal's context, instead of the Orchestrator. A new **mission level** governs what the Main does on its own: going on to the next step (`proceed`), creating Workers (`staffing`), adding a repo (`scope-repo`), letting the governor split the mission (`split`), and deciding Workers' questions the repo keeps for the owner (`answer-technical`, `answer-effects`). Above its level the Main asks the owner; a mission change that needs the owner is a card the plugin applies on the owner's tap. The effective authority for an effect is the lower of the mission cell and the repo cell where the effect lands. A question whose answer is **a fact only the owner knows** (a login, an id, a port, a personal choice) is marked `ownerOnly` and goes to the owner from every layer: no policy, Main or Orchestrator answers it.

7. **Project memory.** Each repo has a memory in the plugin's data (`memory/<workspaceId>.json`): the owner's decisions and precedents recorded automatically, facts a Worker adds with their source, curated by the Main. A Main briefing a Worker into a repo includes that repo's memory; it replaces the per-project Manager's role as keeper of the project's context.

8. **The Orchestrator governs the process.** It checks each mission's work against its charter and watches, through figures code computes from the stores, for **mess** (several Workers on one area, two writers on a file, repeated questions, dropped commands), **overengineering** (documents, ADRs and beads growing past the charter's need, tier inflation, review budgets exhausted), **drift** (Main turns or finished requests that move no done criterion, work outside the charter) and **stuck** work (stalls, unanswered links, stale cards). It intervenes on a ladder — record, nudge the Main with the numbers, require the Main to re-plan, escalate to the owner — and may stop a Worker on real risk. It **arbitrates between missions** (two charters on one area; work that belongs to another mission) and **may create a Main** to split a mission, on the owner's answered decision or the source mission's level. It no longer briefs, corrects or answers Workers, decides no business question, and speaks to Mains, not around them.

9. **Code carries the routine, the model is woken on signals.** Compaction and handoff run in code within the owner's Coordination settings and inform the Main; the governor's figures and ladder state are stored; the Orchestrator is woken only when a signal reaches the step that needs judgement, a conflict appears, or a periodic mission review is due. `decision.opened`, `request.finished`, `advice.due` and `threshold.crossed` stop being wakes.

10. **Existing per-workspace Managers become one-repo missions.** A live Manager of a repo, and a Manager the owner opens from Paseo's composer in a repo, become a mission whose only repo is that workspace (named after it until the owner renames it), and keep running where they are. `manager.ensure` remains as a wrapper. A one-repo mission is today's Manager; a user of one repo sees no other change.

## Consequences

- The owner talks to one Main per goal, across repos; cross-repo work no longer needs the owner to carry or start it, and no longer fragments into a Worker per ask.
- The Orchestrator's cost moves from per-event wakes to signal-driven wakes; its decisions become fewer and of a different kind (process, conflicts, splits).
- Workers' questions above the repo level are decided by the agent that holds the mission's context, and owner-only facts can no longer be invented by any agent.
- Large code churn: every place that found "the Manager of a workspace" now finds "the Main of a request" through the roster; the Missions screen is new UI and waits for an approved mockup.
- Workers of one Main across repos appear in their repos' workspaces in Paseo, with a parent in the Missions home; the plugin's own views show them under their Main.

## Alternatives considered

- **Keep per-project Managers with peer links (ADR-028 alone).** Field evidence: fragmentation, owner still starts every exchange, Manager churn. Rejected.
- **One Main for the whole machine.** One conversation for unrelated goals; a context that never ends. Rejected in favour of one Main per mission.
- **A Main per Space (a fixed group of projects).** Ties a Main to a project group rather than a goal; two goals on the same projects would share one chat. Rejected for missions with their own charter.
- **The Orchestrator keeps deciding Workers' questions.** It lacks the mission's context; the field trace shows fabricated owner facts and overturned choices. Rejected: the Main decides, the Orchestrator governs.
