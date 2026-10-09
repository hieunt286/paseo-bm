# paseo-bm — Missions and their Mains: PRD

| Field | Value |
|---|---|
| Status | Accepted (2026-10-09) — the owner's decisions of the discussion of 2026-10-09; `prd-ready` by Claude under the owner's delegation |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Routing decision | [ADR-029 § Routing Decision](../adr/ADR-029-missions-mains-and-a-process-governor.md#routing-decision) |
| Amends | [Base PRD](./paseo-bm-prd.md) REQ-020 (one Manager per workspace) and REQ-021 (a Worker in the open workspace); REQ-176 → REQ-178 (asks go to the asker's own Main); [autonomy PRD](./paseo-bm-autonomy-prd.md) §5 (the Orchestrator's role) and the per-project levels (now the repo level) |
| Design | [Missions design](../design/paseo-bm-missions.md) |

## 1. Context

An owner works toward goals, not repositories. A goal such as "the AI Assistant answers through xOne" spans a frontend, a backend and sometimes a third repository, and lasts weeks or months. Until now paseo-bm gave each repository its own Beads Manager. The field traces of 2026-10-07 → 09 ([ADR-029](../adr/ADR-029-missions-mains-and-a-process-governor.md), Context) show what that costs:

- the owner chose which project's chat to type into, started every cross-project exchange, and asked "what is left" in each project separately;
- asks between projects fragmented one feature into a Worker per ask (four backend Workers for one frontend feature, editing one file over each other);
- Managers were replaced four times in a day and work tied to the old one was lost;
- the Orchestrator decided Workers' questions without the goal's context — once inventing an owner fact — while nothing watched for drift, sprawl or a growing pile of unapproved documents.

## 2. Goals and success metrics

**Goal:** the owner opens one conversation per goal; its Main runs the work across every repository the goal needs, for as long as it takes, and the owner is asked only what is theirs. A process governor keeps the work on the charter.

| ID | Metric | Target | How measured |
|---|---|---|---|
| M-22 | Owner messages that only carry information, permission or "go ask the other repo" between repositories, per mission | 0 on the acceptance scenario (field baseline: 6 in a day) | The Main's and Workers' timelines of the acceptance run |
| M-23 | Workers created per repository per workstream when one Worker would do (one feature, sequential asks) | 1 (field baseline: 4) | The mission roster of the acceptance run |
| M-24 | Answers to `ownerOnly` questions given by anyone but the owner | 0 | The decision store |
| M-25 | Owner messages that only tell the Main to take the next planned step | 0 on the acceptance scenario at a mission level that delegates `proceed` (field: "bắt đầu làm tài liệu design và adr") | The Main's timeline |
| M-26 | Orchestrator wakes that end with no action | ≤ 20% of wakes (field: 11 of 18 `request.finished` wakes) | `orchestrator/wakes.json` with the intervention log |
| M-27 | Work lost when a Main is replaced (commands, decisions or deliveries that fail because their Main changed) | 0 | Outbox and command records of a replacement drill in acceptance |

## 3. Out of scope

- Releasing (the owner tests, then picks the version).
- Missions across machines or daemons.
- A plan or board editor; the plan is text the Main keeps, shown read-only.
- Automatic merging of repositories, commits or pushes beyond what the existing autonomy and action boundary allow.
- Agents on providers without the plugin's tools (Pi) as Mains.

## 4. Actors

- **Owner** — creates, names and closes missions; answers what is theirs; sets the mission and repo levels.
- **Main** — a Beads Manager carrying one mission; faces the owner; plans; creates, wakes, links and stops its Workers; decides within the mission level; changes nothing itself.
- **Worker** — does the work in one repository for one Main; decides within the repo level; talks to its sibling Workers on links its Main opened.
- **Reviewer** — unchanged.
- **Orchestrator** — governs the process across missions; arbitrates between missions; may create a Main to split one; may stop a Worker on real risk.

## 5. Journeys

- **J-11 A goal across two repositories.**
  1. The owner creates the mission "AI Assistant ↔ xOne" (code `AIX`) with the frontend and backend repositories in scope, and tells its Main the goal.
  2. The Main writes the charter for the owner to confirm, plans, and creates a frontend Worker. When that Worker needs a backend API, the Main creates a backend Worker and links the two; they agree the contract on the link and the backend Worker's `finished` carries it.
  3. Later asks for the backend go to that same Worker; the Main records the contract in the mission's register.
  4. The owner asks "what is left?"; the Main answers from the charter's done criteria.
- **J-12 A long mission.** Weeks later the Main's context is full; code hands the mission to a successor Main that reads the mission store and continues; the owner's chat continues under the same mission name and code.
- **J-13 Governance.** The governor sees five Workers on one area and a design document set three times the charter's estimate; it nudges the Main with the figures; the Main re-plans; when the drift persists the owner gets one card with options.
- **J-14 Two missions on one repository.** Two missions write the same backend module; the governor arbitrates (which mission owns the area), tells both Mains, and asks the owner when the call changes a goal; when one mission holds two goals it proposes a split and, on the owner's answer, creates a second Main.

## 6. Functional requirements

| ID | Requirement | Phase | Acceptance criteria |
|---|---|---|---|
| REQ-184 | A mission is stored and named by the owner | P1 | (a) A mission has a name and a short code the owner gives (code unique among open missions), a goal, the repositories in scope, non-goals, done criteria and an optional budget. (b) It is created from the Missions screen or in words to a new Main, recorded only on the owner's own message. (c) Renaming changes the Main's title. (d) Only the owner closes a mission. |
| REQ-185 | Mains live in one shared home | P1 | (a) Every Main is created in one plugin-managed workspace, titled `🟣 M · <CODE> <name>`, the title kept after a rename or a cleared conversation. (b) That workspace is not shown or counted as a project. |
| REQ-186 | A Main works across the repositories of its mission | P1 | (a) A Main creates Workers in any repository in scope, several per repository when the work splits, each working only in its repository under that repository's level and boundary. (b) A Main reaches a repository outside the scope only after it is added (mission level `scope-repo`, else the owner). (c) The Main changes nothing itself. |
| REQ-187 | One chain of command | P1 | (a) Each Worker belongs to one Main; only that Main briefs, wakes or stops it (the owner may; the Orchestrator may stop it on risk). (b) A Main links two of its Workers, who then talk directly; the Main sees the exchange. (c) A Worker's ask for another repository goes to its own Main, which links it to the Worker already on that work or creates one. (d) Workers of two missions talk only through their Mains. |
| REQ-188 | Nothing is lost when a Main changes | P1 | (a) A Main successor continues the mission from the stored mission; its Workers, commands, decisions and deliveries follow it. (b) A Main may be replaced for context, fallback or the owner's wish, with no owner relay. |
| REQ-189 | Two autonomy layers | P1 | (a) The repo level governs the work in a repository: a Worker's question whose class the repo delegates is decided by the request's Main, which holds the goal's context. (b) A mission level governs the Main's own decisions — `proceed`, `staffing`, `scope-repo`, `split` — and lets it decide Workers' questions the repo keeps for the owner (`answer-technical`, `answer-effects`); above its level the Main asks the owner. (c) An effect's authority is the lower of the mission and repo layers: the repo's action boundary still holds it. (d) `ownerOnly` questions are answered only by the owner, from every path. |
| REQ-190 | Project memory | P1 | (a) Each repository has a memory: owner decisions and precedents automatically, facts Workers add with sources, curated by the Main. (b) Briefs into a repository carry its memory. (c) Memory can be read by any Main or Worker working there. |
| REQ-191 | The Main keeps the goal | P1 | (a) The Main keeps the charter, a plan, the done criteria's status and the cross-repo contract register in the mission store. (b) It answers "what is left" from them. (c) At a level that delegates `proceed` it takes the next planned step without being told. |
| REQ-192 | Existing Managers keep working | P1 | (a) A live Manager of a repository, and one opened from Paseo's composer in a repository, become a one-repository mission. (b) The sidebar, Command Center and Work entry points open that mission's Main. |
| REQ-193 | The governor watches the process | P2 | (a) Figures computed in code for mess, overengineering, drift, stuck work and budget, per mission, against the charter. (b) A ladder: record, nudge the Main with the figures, require a re-plan, escalate to the owner; stop a Worker on real risk. (c) It never briefs, corrects or answers a Worker, and decides no business question. |
| REQ-194 | The governor arbitrates between missions | P2 | (a) Detects two missions on one area (charters, writers, links). (b) Records who owns the area, tells both Mains, asks the owner when a goal changes. (c) Proposes splitting a mission and, on the owner's answer or the mission's `split` level, creates a Main for the new mission. |
| REQ-195 | Routine runs in code | P2 | (a) Compaction and handoff of Workers and Mains run in code within the Coordination settings and inform the Main. (b) The Orchestrator is woken only on a signal step that needs judgement, a conflict, or a periodic mission review. |
| REQ-196 | The Missions screen | P3 | (a) Lists missions with name, code, Main, repositories, state, done criteria progress, Workers, open questions and governor signals. (b) Creates, renames and closes a mission; sets its level. (c) Matches an approved mockup. |

## 7. Non-functional requirements

- **Safety:** a Worker still works only in its repository, under its repo level and action boundary; a Main changes nothing; the governor may only stop. No agent answers an `ownerOnly` question.
- **Cost:** the governor's wakes are signal-driven (M-26); Mains compact and hand off in code.
- **Durability:** missions survive a plugin reload and a Main replacement; every store follows `data-files.ts`.
- **Bundle:** the published entries stay under paseo.cafe's 2,000,000-byte scan limit.

## 8. Boundaries and dependencies

- Paseo creates a child agent wherever its `cwd` is; the plugin keeps per-repository stores keyed by the Worker's workspace.
- The Orchestrator keeps its home workspace; the Missions home is a second plugin-owned workspace.

## 9. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 0 | The published bundle minifies identifiers, keeps names ([ADR-030](../adr/ADR-030-published-bundle-minifies-identifiers.md)) | The entries build under the 2,000,000-byte limit with stack traces naming functions |
| Phase 1 MVP — Missions | REQ-184 → REQ-192 | A two-repository mission on an isolated daemon meets M-22, M-23, M-24, M-25, M-27 |
| Phase 2 MVP — The governor | REQ-193 → REQ-195 | The governor's scenario (sprawl, drift, a two-mission conflict, a split) meets M-26 and resolves each case without the owner relaying |
| Phase 3 MVP — The Missions screen | REQ-196 | The screen matches the approved mockup at phone and desktop widths |

## 10. Open questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-200 | Default mission level for a new mission | hieu.nt10 | answered: the Main may go on to next steps and create Workers, several when the work splits (owner, 2026-10-09) → level 2: `proceed` and `staffing` delegated |
| Q-201 | Should a mission ever close by itself? | hieu.nt10 | answered: no; the owner closes it (2026-10-09) |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-09 | hieu.nt10 (owner decisions; written by Claude) | Created from the discussion of 2026-10-09. `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-09 | Claude (owner's delegation) | After the design review: REQ-189 states who decides a Worker's question at each layer; Q-200 at level 2; Phase 0 (ADR-030) |
