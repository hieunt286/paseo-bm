# paseo-bm — Missions and their Mains: PRD

| Field | Value |
|---|---|
| Status | Accepted (2026-10-09) — the owner's decisions of the discussion of 2026-10-09; `prd-ready` by Claude under the owner's delegation |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Routing decision | [ADR-029 § Routing Decision](../adr/ADR-029-missions-mains-and-a-process-governor.md#routing-decision); for REQ-197 → REQ-201, [ADR-032 § Routing Decision](../adr/ADR-032-one-governor-a-mission-per-wake.md#routing-decision); for REQ-202 → REQ-208, [ADR-033 § Routing Decision](../adr/ADR-033-the-mission-is-the-system-of-record.md#routing-decision) |
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
| M-28 | Governor acts aimed at a mission the wake did not carry | 0 (more than 1 in a field period reopens ADR-032 decision 1) | `orchestrator/wakes.json` `offMission` (A-13) |
| M-29 | Time from a `danger` alert to the Worker no longer running | median ≤ 5 minutes on the acceptance drill, with the Main told within the first minute | `orchestrator/dangers.json` (A-13) |
| M-30 | Input tokens read per governor wake (input + cached, closing turn) | median ≤ 350,000, twice the 2026-10-09 acceptance's 175,000 | `orchestrator/wakes.json` `usage` (A-8, A-13) |
| M-31 | Work lost when a Main is replaced: requests, follow-ups, questions, the Main's asks or links missing from the successor's brief | 0 (XAI 2026-10-10: a handed-over request and its follow-up missing) | A property test replacing the Main after every event of a scripted mission; the isolated-daemon drill |
| M-32 | Main replacements for context while its real context is below the hard figure | 0 (XAI: replaced at 110,000 tokens of context) | The journal's `main` lines with the traces' `contextUsed` |
| M-33 | Share of a Main's turns started by the owner | ≥ 50 % on the acceptance scenario (XAI: 5 of 20) | A-14 over the Missions home's trace records |
| M-34 | Questions reaching the owner at Full auto other than `ownerOnly` and those beyond the delegated caps | 0 (XAI: review budgets, every time) | The decision store |
| M-35 | Open legacy missions overlapping an owner's mission after its merge card was applied | 0 (XAI: AIAS and XSPA beside XAI) | The mission index |

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
- **Orchestrator** — one for the machine; governs the process across missions, one mission per wake; arbitrates between missions; may create a Main to split one; may stop a Worker on real risk, as the backup of its Main.

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
| REQ-197 | One governor, a mission per wake | P4 | (a) One Orchestrator governs every mission; none is created per mission. (b) Each wake carries the events of one mission, or of the two missions of a conflict, and opens with that mission's brief read at delivery: goal, open done criteria, repos, Main, ladder families above step 0 with their figures, open cards, notes, newest governor journal lines and arbitrations. (c) A wake carrying a `danger` signal goes before the others. |
| REQ-198 | The governor's conversation is disposable | P4 | (a) An idle Orchestrator the owner has not written to for 2 hours is replaced after 24 hours, after its wakes touched 4 missions, or after 10 wakes. (b) The owner's conversation with it is never cut while they wrote in the last 2 hours. (c) Nothing the governor needs is lost: it lives in the stores and the brief. |
| REQ-199 | `danger` follows the chain of command | P4 | (a) When a Worker of a mission's request raises `danger`, its Main is told at once, with the evidence and that it may stop the Worker. (b) The governor is woken as the backup 3 minutes later if the danger still holds, or at once when no Main could be told. (c) For a mission's Worker neither depends on the repo level. (d) The owner's Inbox alert is unchanged, and the plugin itself stops nobody. (e) The governor's stop keeps its authority: a delegated class, the owner's word, or an answered decision; else it asks the owner. |
| REQ-200 | No project-era residue in the governor | P4 | (a) A note the Orchestrator keeps about a repo goes to that repo's project memory as the owner's word, so Mains and Workers carry it. (b) The governor's own notes are per mission; older project notes stay readable. (c) Its first prompt and home README describe the governor of missions. |
| REQ-201 | The governor's scale is measured | P4 | (a) Wake records name their missions and count off-mission acts. (b) A danger log records when each danger was raised, its Main and the governor told, and when it ended. (c) The replay reports A-13 (wakes per mission, off-mission acts, danger-to-end time, Main told within a minute, tokens per wake). (d) ADR-032 decision 6 names the figures that reopen a per-mission governor. |
| REQ-202 | The mission is the system of record | P5 | (a) Every event that changes what is in flight — a follow-up, a report's phase, a question and its answer, the Main's question to the owner, a link asked, taken, answered or closed, a transfer, a Main replaced — is written by the plugin where it happens. (b) One mission state ("in flight, waiting on whom") is the only source of the Main's brief, its state after compaction, the governor's brief and the Missions screen. |
| REQ-203 | The Main is long-lived | P5 | (a) A Main's context is maintained in place by compaction at the owner's threshold on its real context; its chat with the owner stays. (b) A new Main is created only when compaction is impossible, failed twice, or left the context above the hard figure, and loses nothing (M-31). (c) One function replaces a Main; opening the Main during a replacement joins it. (d) Workers are not told when their Main changes; a replaced Main's tools refuse and name the current Main. |
| REQ-204 | One authority names who decides | P5 | (a) When a decision opens, one rule set names its decider: code, the Main, the Orchestrator or the owner. (b) Review budgets within the code cap at a level delegating `cost` are not questions; the Main decides within its cap; beyond it, the owner. (c) The owner may answer any open decision. (d) The decider is told at once. |
| REQ-205 | The Main asks the owner with stored decisions | P5 | (a) What the owner must decide is a decision in the Inbox, opened by the Main, answered on the card or in the Main's chat. (b) The answer reaches the Main and the journal. |
| REQ-206 | One owner per thing | P5 | (a) Requests move between missions only through one transfer, on the owner's card (splits included). (b) A legacy one-repo mission on a repo of the owner's mission is offered for merging, on a card. (c) A mission closes while its Workers sit idle. (d) Entry points open the Main of the request's mission; by workspace, the owner's mission before a legacy one. |
| REQ-207 | A signal budget | P5 | (a) A notice is sent only when its recipient has something to do. (b) Everything for a Main pending at its idle moment arrives as one message, each item its own card. (c) No notice for a Main replacement or a review budget. (d) The governor treats a request waiting on another request of its mission, or stopped, as waiting. |
| REQ-208 | The Missions screen shows what is in flight and the Main's history | P5 | (a) A mission page lists requests by state, questions by who decides, the Main's asks and live links. (b) It lists the mission's Mains with when and why each changed and opens a previous one. (c) Matches an approved mockup. |

## 7. Non-functional requirements

- **Safety:** a Worker still works only in its repository, under its repo level and action boundary; a Main changes nothing; the governor may only stop. No agent answers an `ownerOnly` question.
- **Cost:** the governor's wakes are signal-driven (M-26), one mission each, with a bounded brief (M-30); Mains compact in place (M-32) and the plugin wakes an agent only when it has something to do (M-33).
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
| Phase 4 — One governor at mission scale (ADR-032) | REQ-197 → REQ-201 | The automated checks pass; an acceptance drill on an isolated daemon (two missions signalling together, a danger at a Hands-on repo) meets M-28 and M-29 — the drill is the owner's step after install |
| Phase 5 — The mission runtime (ADR-033) | REQ-202 → REQ-208 | The automated checks pass, including the M-31 property test and the M-32, M-34, M-35 scripts; the mission page matches an approved mockup; the isolated-daemon drill (a forced Main replacement mid-work, a review budget at Full auto, a legacy merge) is the owner's step after install |

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
| 2026-10-10 | hieu.nt10 (owner request; written by Claude) | REQ-197 → REQ-201, M-28 → M-30, Phase 4 and the Orchestrator's actor line: one governor, a mission per wake, a disposable conversation, `danger` to the Main first, notes into project memory, the governor's scale measured ([ADR-032](../adr/ADR-032-one-governor-a-mission-per-wake.md)). `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-10 | hieu.nt10 (owner approval of the five changes; written by Claude) | REQ-202 → REQ-208, M-31 → M-35, Phase 5: the mission runtime — state of record, a long-lived Main, one authority, the Main's asks as decisions, one owner, a signal budget, the mission page's in-flight part ([ADR-033](../adr/ADR-033-the-mission-is-the-system-of-record.md)); REQ-199 (a)'s `BM-SIGNAL` now arrives through the Main's channel (REQ-207). `prd-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-10 | Claude (as built) | Phase 5 built: the automated checks pass (the M-31 property test, the M-32, M-34 and M-35 unit tests, A-14 in the replay); the mission page matches the approved mockup ([mission-runtime.html](../design/mockups/mission-runtime.html)). REQ-206 (d): no client entry point opens a Manager for one request yet; `manager.ensure` takes `requestId`, and by workspace the owner's mission comes first. What remains is the owner's isolated-daemon drill |
