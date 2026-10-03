# paseo-bm — Orchestrator: a coordinating agent for the whole machine (feature PRD)

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-28) — rewritten after the owner rejected the first design (assess + nudge) before any release; approved by owner hieu.nt10; gate `prd-ready` PASS |
| Living document | Once Accepted, this PRD is **edited in place** like the repository's other PRDs, with one Revision History line per edit. The PRD states **outcomes**; tool names, thresholds' mechanics, notice formats, layouts and scoring criteria live in the Technical Design |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Programme | The [calibrated autonomy PRD](../../product/paseo-bm-autonomy-prd.md) (Accepted 2026-09-29) **supersedes** REQ-071 → REQ-087 as its Phase 1 MVP and Phase 2 MVP land. **Phase 1 MVP has landed in the code (2026-09-29, not released):** REQ-071 (the Orchestrator's own screen) is replaced by the Inbox, Work and Insights (autonomy REQ-118) — the Orchestrator is started and opened from the Inbox, and there is no tab, no Needs you of its own and no Watch switch; REQ-073 (a) is gone (stalled work is always watched and is an Inbox alert); REQ-076 and REQ-079 (a) now read: a command reaches a Manager as the prepared command of an option the owner picked on one of the Orchestrator's decisions, on the owner's word in its chat, or on Autopilot — there are no proposals and no commands typed on a screen (autonomy REQ-110 → REQ-113); REQ-078 (a) is asked in the Orchestrator's chat, and no screen applies a recommendation; REQ-087 is cards v2 (REQ-118 c). Autopilot (REQ-082), the gate's allowed categories (REQ-085) and the additional instructions stay until Phase 2, with no switch on a screen. Nothing here is released separately (one release for the programme) |
| Created | 2026-09-28 |
| Related PRDs | [Base PRD](../../product/paseo-bm-prd.md) (Accepted) · [Dashboard PRD](../../product/paseo-bm-dashboard-prd.md) (Accepted) — this feature **builds on** the Dashboard's trace store and amends one of its boundaries (REQ-047, see REQ-079) |
| Technical Design | [Orchestrator design](../../design/paseo-bm-orchestrator.md) (Active 2026-09-28) |
| ADR | [ADR-015](../../adr/ADR-015-orchestrator-autopilot-per-project.md) (Accepted 2026-09-29: Autopilot per project, approval in chat) amending [ADR-014](../../adr/ADR-014-orchestrator-agent-proposes-owner-approves.md) (Accepted 2026-09-28), which supersedes [ADR-013](../../adr/ADR-013-orchestrator-assess-and-nudge.md) |
| Routing decision | [§0](#0-routing-decision) (canonical owner of this feature) |

> **Why a separate PRD:** the feature has its own journey, actor (the Beads Orchestrator agent) and metrics, and it **changes a boundary** the Dashboard PRD committed to (the Dashboard never sends a prompt). Writing it separately keeps the Dashboard PRD lean, and it links back to the other two PRDs instead of copying them.

## 0. Routing Decision

- Variant preset: brownfield (extends a running plugin, builds on the Dashboard)
- Triggered risks:
  - **New product outcome:** a machine-wide coordinating agent the user chats with; stalled-work detection; commands to Managers approved by the user; workflow assessment with recommendations → this PRD + `prd-ready`
  - **New consumed contract:** new plugin RPCs, new plugin MCP tools, a new `BM-*` notice read by the Orchestrator → Technical Design + `design-ready`
  - **Writes to the user's Paseo configuration:** the `bm-orchestrator` role (provider alias + profile), and a dedicated workspace for the Orchestrator → Technical Design + `design-ready`
  - **Permission boundary:** the plugin creates a long-lived agent, lets it read every paseo-bm agent's work, and sends commands to Managers **after the user approves them**; a periodic watcher wakes the Orchestrator; contrary to the Dashboard's REQ-047 → Technical Design + **ADR-014** + negative tests
  - **Privacy:** conversation content of every project (secrets redacted) is read by the user's chosen model; proposals, interventions and assessments are written in the data folder → Technical Design
  - **Several independent outcomes:** agent, tools, watcher, approval flow, tab, assessment, removal of the first design's parts → Implementation Plan + `plan-ready-for-beads`
- Required artifacts/gates: this PRD [`prd-ready`] → Technical Design [`design-ready`] + ADR-014 → Implementation Plan [`plan-ready-for-beads`] → Beads → `feature-done` (standard, with one acceptance run on an isolated daemon)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-28 — hieu.nt10. First design (assess on click + nudges) built and tested, then **rejected by the owner** before any release: "it should be able to step in and give orders to every Manager when work stops, and assess how the Manager/Worker/Reviewer trio works and propose improvements when asked". Owner decisions: **one agent for the whole machine**, which the user chats with; it steps in on **unfinished requests with no agent running for 5 minutes**, **waiting for the user for 15 minutes**, and **review loops or broken reports**; its commands may say **anything the user could say**, but **every command waits for the user's click**; the display is **short and general** — which project, which Manager, what intervention, confirm — never the conversation's details
- Supersedes: the Routing Decision of 2026-09-28 for the first design (assess + nudge, ADR-013)

## 1. Context

The Dashboard (Metric screen) shows **what happened** with each request. It does not **move work forward** when it stalls, and it does not say **whether the trio works well**. Today the user is the only coordinator across projects: they notice that a Worker has been waiting for an answer for an hour, that a request stopped with nobody running, that a Reviewer loop went past its budget — and only by opening each project's chat.

The real workload shows the cost. On 2026-09-28 a Large migration request in `xspace-master-data` stopped four times for the user's answers; twice the user said "go on" instead of answering, and the Worker chose three options by itself; a report reached the Manager cut in half, so the Manager could not read four questions. Nothing outside the chat pointed at any of it.

The first design of this feature (rule flags, an assessment button, nudges sent by the plugin to a running Manager or Worker) was built and tested the same day. In the owner's own test the automatic nudge interrupted a Worker for a false positive and changed nothing, and the owner judged the whole shape wrong: what is needed is **a coordinator that acts on stalled work with the user's approval, and that the user can ask about the trio's workflow**.

## 2. Goals & success metrics

**Goals**

1. When work **stalls** in any project, the user learns it in one place — which project, which Manager, what is wrong — with a **ready command** to unblock it, and sends it with one click.
2. The user can **talk to one Orchestrator** about all their projects: what is going on, what stalled, what to tell a Manager.
3. On request, the Orchestrator **assesses how the trio works** in a project and recommends improvements the user can apply to the role instructions.

**Metrics**

| ID | Metric | Target | How measured |
|---|---|---|---|
| O-1 | Stalls are caught | Each of the three stall situations is detected on its fixture; a healthy running request raises none | Tests on trace fixtures |
| O-2 | Nothing reaches a Manager without the owner | 100 % of messages delivered to a Manager follow the owner's click, the owner's word in the Orchestrator's chat, or the project's Autopilot; none reaches a Worker or Reviewer | Negative test + acceptance |
| O-3 | Off means off | Watch switch off → no periodic task, no message to the Orchestrator agent | Negative test |
| O-4 | Costs nothing unused | No Orchestrator agent exists and no token is spent until the user clicks **Open Orchestrator** or **Assess workflow** | Negative test |
| O-5 | Short and general | The tab answers "which project, which Manager, what intervention" without opening a conversation; no conversation excerpt is shown by default | Acceptance review by the owner |

## 3. Out of scope

- Sending **anything** to a Manager, Worker or Reviewer without the user's click (no automatic command, no nudge).
- Commands to Workers or Reviewers directly: commands go to the **Manager**, who owns the conversation with the user and its Worker.
- Agent errors and usage limits: the Worker fallback feature already handles them.
- Observing agents that are **not** paseo-bm's.
- The Orchestrator editing code, documents, beads or configuration; archiving, stopping or deleting agents.
- Applying instruction recommendations without the user's click.
- Aggregating data across machines, exporting reports, charts over time.

## 4. Personas / Affected Actors

| Actor | Context | Wants | Pain today |
|---|---|---|---|
| paseo-bm user (machine owner) | Runs Beads Manager in several projects at once | To see at a glance where work stalled and unblock it quickly; to improve how the agents work | Has to open each project's chat to notice a stall; no advisor across projects |
| Beads Manager | Owns one project's conversation | To get the user's decision when it is needed | Waits silently when the user is away or answers vaguely |
| Beads Orchestrator (`bm-orchestrator`, new behaviour) | One long-lived agent for the machine | To read every paseo-bm project's state and propose commands; to assess a trio's workflow when asked | — |

## 5. User / Operational Journeys

- **J-O1 — Talking to the Orchestrator.** On Setup → **Orchestrator**, the user clicks **Open Orchestrator** (the first time, a dialog says which provider and model will run, and that it costs tokens). Its chat opens. The user asks "Which projects are stuck?" or "Is the migration going well?"; it answers from what it reads through the plugin's tools. When it thinks a Manager should be told something, it **proposes a command**; the proposal appears on the tab.
- **J-O2 — A stall, a proposal, one click.** The user turns on **Watch for stalled work**. In project A the Worker has waited 15 minutes for the user's answer. The tab shows under **Needs your approval**: *project A · Manager "Migration…" · waiting for your answer for 15 min*, and the command the Orchestrator proposes (for example the answers it recommends). The user clicks **Approve & send** (or edits it first, or dismisses it). The command reaches the Manager as the user's own message; the item moves to **Interventions**.
- **J-O3 — Assessing the trio's workflow.** On a project row the user clicks **Assess workflow**. The Orchestrator reads the project's recent requests and returns a short verdict: scores per criterion, the few findings that matter, and recommendations, each with **Add to <role>'s instructions**.
- **J-O4 — Stepping in directly.** On any project row the user writes a command to that project's Manager, or a question to the Orchestrator, without leaving the tab.

## 6. Functional Requirements

Priority: **P2** = required for Phase O1 MVP; **P3** = later.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-071 | Orchestrator tab, short and general | P2 | (a) Beads Manager's Setup screen has a fourth tab **Orchestrator**. (b) Top: the Orchestrator's state with **Open chat**, and the **Watch for stalled work** switch. (c) **Needs you**: one short card per pending proposal or decision the Orchestrator asks of the owner — project, Manager, one line, the command or question — with **Send** / **Skip** (and edit) for a proposal. (d) A **coordinator's dashboard**: a summary line, a decision queue with one button per option, a health card per project (status, stage, agent state, last progress, Autopilot and its allowed categories), and **What the Orchestrator did**, the log: per project, newest first, each command it (or the owner) sent to a Manager — when, to which Manager, who decided, and the text itself — and each decision it asked; a **Latest** line under the title shows the newest at a glance, and the tab refreshes itself while open. (e) **Projects**: one row per project — its state (running, waiting for you, stalled, idle), its **Autopilot** switch, **Assess workflow** and **Ask**. (f) No conversation excerpt, flag evidence or timeline is shown on the tab or added to the Metric screen. (g) With nothing to show, one sentence of explanation. (h) The tab reads plugin data and calls no model |
| REQ-072 | Rule-based signals | P2 | (a) A fixed catalogue of deterministic rules scores each request (no LLM), as the Orchestrator's and the stall watcher's input, with evidence kept for the Orchestrator's tools. (b) The same trace always yields the same signals; missing data means "unknown". (c) Signals are not shown per conversation (REQ-071 f) |
| REQ-073 | Watching work (stalls and Autopilot events) | P2 | (a) A **Watch for stalled work** switch, **off by default** (dialog, tokens). (b) Stall situations: an unfinished request with **no Worker or Reviewer of it running for 5 minutes**; a request **waiting for the owner's answer for 15 minutes**; **review calls over budget or a broken report**, while unfinished. Every request active in the last 24 hours is watched. (c) In a project with **Autopilot** on, the Orchestrator is also woken **as soon as** a request reports a question to the owner or a finished step. (d) Each situation or event wakes the Orchestrator **once**. (e) With the switch off and no Autopilot project → no periodic task and no wake-up (O-3) |
| REQ-074 | paseo-bm's agents only | P2 | (a) The data sources are the trace store and the timelines and status of paseo-bm's own agents (Manager, Worker, Reviewer). (b) Nothing reads the timeline, configuration or files of any other agent. There is a negative test |
| REQ-075 | The Orchestrator agent | P2 | (a) **One** Orchestrator agent for the machine, created only when the user clicks **Open Orchestrator** (after a dialog naming provider and model, cost in tokens; default is cancel); clicking again opens the existing one. (b) It lives in a workspace of its own, not in any project. (c) The user chats with it like with a Manager. (d) Through the plugin's read-only tools it sees every project's requests, their state, reports, signals, and the recent messages of paseo-bm's agents. (e) It changes nothing itself: no file, bead or configuration edit, no message to another agent; its only action is to **propose a command** (REQ-076). (f) Its role instructions say what it is for, and that the user's word always wins |
| REQ-076 | Commands to Managers | P2 | (a) A command names the project, the Manager and the text, with a one-line reason. (b) It may say anything the owner could say, within REQ-082 c. (c) **Autopilot on** for the project → the Orchestrator sends it itself. (d) **Autopilot off** → it is sent when the owner says so: **Send** on the tab, or the owner's own message in the Orchestrator's chat ("send it", "chốt"); otherwise it waits as a proposal, and a new proposal for the same Manager and request replaces the pending one. (e) The owner can also write a command to a project's Manager, or a question to the Orchestrator, from the tab. (f) Every sent command reaches the Manager as the owner's message, arrives when the Manager's turn ends if it is running, and is recorded (REQ-071 e) |
| REQ-077 | The `bm-orchestrator` role | P2 | (a) The role is created at the same time and under the same rules as the three existing ones (when Beads Manager or Setup is opened, default provider and model, an existing entry is left unchanged); a machine with 0.4.x gets it on the next open without touching the three. (b) Provider, model and thinking can be changed on Setup → Agents. (c) No Paseo agent tools; only the plugin's own Orchestrator tools; the mode follows the Reviewer's rule (never dangerous or planning). (d) The cleanup button removes it |
| REQ-078 | Workflow assessment and recommendations | P2 | (a) Each project row has **Assess workflow** (dialog: model, cost; default cancel). (b) The Orchestrator reads that project's recent requests and returns a short structured result: a score per criterion, at most a few findings, recommendations tied to a role (Manager, Worker, Reviewer). (c) The tab shows the latest result of each project briefly. (d) Each recommendation has **Add to <role>'s instructions**: preview the text after appending and its length against the limit, default no, append only; applies to agents created afterwards. (e) A malformed answer shows as an error, never guessed |
| REQ-079 | Action boundary | P2 | (a) Messages the plugin delivers to a Manager are only commands the owner sent, approved (tab or chat) or delegated by Autopilot; nothing is delivered to a Worker or Reviewer. (b) Messages to the Orchestrator are only stall situations, Autopilot events, and requests the owner clicked. (c) The plugin never stops, archives or deletes an agent, and writes role instructions only through REQ-078 d. (d) REQ-047 of the Dashboard PRD is amended accordingly. (e) Negative tests for each item and for O-2 → O-4 |
| REQ-080 | Privacy and storage | P2 | (a) Content the Orchestrator reads through the tools goes through the trace store's secret redaction. (b) Proposals, interventions, assessments and settings live in paseo-bm's data folder with permissions `0600`/`0700`, follow the cleanup button's rules, and are deleted with the traces they concern. (c) A version update does not delete them |
| REQ-082 | Autopilot per project | P2 | (a) Each project has an **Autopilot** switch, off by default; turning it on shows what it allows and asks for confirmation; the owner may also turn it on or off by telling the Orchestrator in its chat. (b) With it on, the Orchestrator answers the project's questions and commands its Manager without asking, and drives unfinished work to completion. (c) Always: no command asks to commit, push or deploy, or to touch real data, unless the owner said so — the plugin appends that limit to every command the Orchestrator sends; big decisions (security, cost, large scope change, anything irreversible) go to the owner as a **Needs you** card and a line in the chat. (d) Everything it sends or asks appears on the tab, with the text it sent (REQ-071 d) |
| REQ-083 | Live watch of running Workers | P2 | (a) In Autopilot projects, running Workers are watched while they work, at no model cost. (b) Stuck work, a waiting permission, a dangerous action, a failure loop, heavy process on a small request and writes outside the workspace are each reported to the Orchestrator once per Worker turn, with evidence |
| REQ-084 | Direct Worker coordination | P2 | (a) In Autopilot projects the Orchestrator may correct or answer a Worker directly; its Manager always receives a copy. (b) A running Worker is interrupted only while a dangerous action of that Worker is open. (c) Never a Reviewer |
| REQ-085 | Big decisions by rule | P2 | (a) A command touching security, release, real data, cost or dependencies never goes out on the Orchestrator's authority unless the owner allowed that category for the project; it becomes a decision for the owner. (b) The owner sets allowed categories per project |
| REQ-086 | Seeing for itself, remembering | P2 | (a) The Orchestrator can read repository state (status, diff summary, log, one file) inside a workspace, read-only. (b) It keeps short notes per project that survive a new Orchestrator |
| REQ-087 | Readable commands in the chats | P2 | (a) Every command the plugin delivers is a structured block rendered as a card: who, on whose behalf, to whom, about what, the instructions, why, the limits. (b) Plugin events show as compact lines in the Orchestrator's chat. (c) The Orchestrator answers the owner as Situation / Done / Needs you |
| REQ-081 | More situations and trends | P3 | More stall situations and rules as experience shows; trends over time to see whether an instruction change worked |

## 7. Non-Functional Requirements

| Group | Requirement |
|---|---|
| Performance | The stall watcher reads the trace store and the agent list only — no timeline read, no model call — at a fixed interval, and exists only while its switch is on. The tab opens without reading the whole store each time. |
| Cost | No token is spent until the user opens the Orchestrator or clicks Assess workflow (O-4). With the switch on, each stall situation wakes the Orchestrator at most once. |
| Correctness | Stall detection and rules are deterministic; missing data means "unknown". The Orchestrator's proposals and assessments are presented as **its opinion**, never applied without the user. |
| Safety and privacy | REQ-074, REQ-079, REQ-080; every message to a working agent follows the user's click. |
| Compatibility | Existing RPC contracts and `BM-*` formats do not change; new RPCs, tools and the stall notice are additions. Traces written by older releases are still read. |
| Interface | As the Dashboard: React Native primitives, colours from `theme.colors`, accessibility labels, interface text in English; one screen, no conversation details (O-5). |
| Testing | Stall detection, rules, the tab's model, proposals and the approval flow are pure or fake-SDK modules; plus one acceptance run on an isolated daemon. |

## 8. Boundaries & Dependencies

- **Builds on the Dashboard:** the trace store and secret redaction ([ADR-007](../../adr/ADR-007-dashboard-trace-store.md)), the `BM-REPORT` reader, the request reconstruction.
- **Builds on existing plugin mechanisms:** the plugin's own MCP endpoint ([ADR-010](../../adr/ADR-010-plugin-hosted-agent-tools.md)), the `before("agent.create")` hook, `config.patch` for the role, the notice queue (delivers to an agent when its turn ends), each role's "Additional instructions".
- **Depends on agent behaviour:** the quality of proposals and assessments depends on the model the user chooses for `bm-orchestrator`; the Manager acting on an approved command is the same as acting on the user's word.
- **Does not own:** role instruction content written by the user (only appended to on click), the user's agents, the beads store, Paseo internals.

## 9. Phase Scope

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase O1 MVP | REQ-071 → REQ-080, REQ-082 → REQ-087 | Every P2 AC met; O-1 → O-4 met by tests, O-5 accepted by the owner; ADR-014 Accepted; REQ-047 of the Dashboard PRD amended; typecheck, lint, test, build clean; one acceptance run on an isolated daemon with a run record in `docs/archive/operations/` |
| Phase O2 | REQ-081 | Does not block O1 |

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-077 | Can the plugin server open the Orchestrator's own workspace (`workspaces.open` on a folder in the data folder)? If not, where does the agent live? | hieu.nt10 | **answered (2026-09-28)** — the owner allows a workspace of its own; technical feasibility is verified first in implementation, with the design's fallback |
| Q-078 | How many recent requests does **Assess workflow** read, and within which size cap | hieu.nt10 | **answered (2026-09-28)** — the last 7 days, at most 10 requests, content capped at 60,000 characters |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | Phase 1 MVP landed (retirement sweep, bead `bm-autonomy-phase1b-dbdv.6`): the Programme row names the requirements it replaced and how they read now |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | The [calibrated autonomy PRD](../../product/paseo-bm-autonomy-prd.md) was accepted: a Programme row in the header says what it supersedes here and when |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | ADR-016 (owner decisions after reviewing the Orchestrator's role): REQ-083 live watch of running Workers, REQ-084 direct Worker coordination with a Manager copy, REQ-085 rule gate on big decisions, REQ-086 read-only repo and notes, REQ-087 structured command cards; REQ-071 (d) becomes a coordinator's dashboard |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | The owner could not see what the Orchestrator did: REQ-071 (d) makes "What the Orchestrator did" — every command with its text, and every decision asked — the tab's main block, with a Latest line and self-refresh; project rows lose the latest-action line; REQ-082 (d) follows |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | After the owner's first real session ("it does nothing on its own and makes me relay and confirm a lot"): **Autopilot per project** (REQ-082, ADR-015) — the Orchestrator answers questions and commands the Manager itself, woken at once on a question or a finished step; with Autopilot off, the owner's word in chat counts as approval and a new proposal replaces the pending one (REQ-076); limits kept: no commit/push/deploy, no real data, big decisions to the owner; the tab is simplified (REQ-071); every request active in 24 h is watched and the Manager's own activity no longer masks a stall (REQ-073) |
| 2026-09-28 | hieu.nt10 | **Accepted**, `prd-ready` PASS, with ADR-014 and the design; Q-077 (own workspace allowed) and Q-078 (7 days, 10 requests) answered |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | **Rewritten, status Review.** The owner rejected the first design after testing it (automatic nudges, an assessment per request, flags and assessments on the Metric screen): the Orchestrator becomes one agent for the machine that the user chats with, detects stalled work (5 min with nobody running, 15 min waiting for the user, review loops or broken reports), proposes commands to Managers that go out only on the user's click, and assesses a project's trio workflow on request; the tab is short and general. REQ-071 → REQ-080 redefined, O-1 → O-5 redefined, ADR-014 supersedes ADR-013. The first design was never released |
| 2026-09-28 | hieu.nt10 | Owner allows a more proactive Orchestrator, Workers included: REQ-078 (c) now watches running Workers of Small requests while the switch is on and may interrupt a running Worker to nudge it (never one waiting for the user or finished); NFR performance names that watcher as the only periodic task; O-5 adds "no periodic task" |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | REQ-078 (c) states the limit found when checking the design against the code: the plugin cannot break into a running turn, so a nudge for a Worker arrives only when the Worker pauses mid-work, and never wakes a Worker waiting for the user — confirmed by the owner at gate `design-ready` |
| 2026-09-28 | hieu.nt10 | **Accepted**: the owner approved the PRD and handed Q-071 → Q-074 to the Technical Design to propose (owner approves at gate `design-ready`); `prd-ready` PASS |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | PRD created in status Review, following the owner's decisions the same day: intervention yes, but behind a flag that is off by default and only as nudging a running agent; observe only paseo-bm's agents; LLM assessment only on click, run by a new role `bm-orchestrator`; a fourth tab on Setup |
