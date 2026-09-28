# paseo-bm — Orchestrator: assessing and nudging agent coordination (feature PRD)

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-28) — approved by owner hieu.nt10; gate `prd-ready` PASS |
| Living document | Once Accepted, this PRD is **edited in place** like the repository's other PRDs, with one Revision History line per edit. The PRD states **outcomes**; the concrete list of rules, thresholds, button names, notice formats and scoring criteria live in the Technical Design |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-28 |
| Related PRDs | [Base PRD](./paseo-bm-prd.md) (Accepted) · [Dashboard PRD](./paseo-bm-dashboard-prd.md) (Accepted) — this feature **builds on** the Dashboard's trace store and Metric screen, and amends one of its boundaries (REQ-047, see REQ-079) |
| Technical Design | [Orchestrator design](../design/paseo-bm-orchestrator.md) (Active 2026-09-28), with pointers from the [Dashboard design](../design/paseo-bm-dashboard.md) and the [base design](../design/paseo-bm.md) |
| ADR | [ADR-013](../adr/ADR-013-orchestrator-assess-and-nudge.md) (Accepted 2026-09-28): the plugin may create an assessment agent when the user clicks, and may nudge a running agent — interrupting a running Worker — when the user turns the nudge switch on |
| Routing decision | [§0](#0-routing-decision) (canonical owner of this feature) |

> **Why a separate PRD:** the feature has its own journey, actor (the `bm-orchestrator` role) and metrics, and it **changes a boundary** the Dashboard PRD committed to (the Dashboard never sends a prompt). Writing it separately keeps the Dashboard PRD lean, and it links back to the other two PRDs instead of copying them.

## 0. Routing Decision

- Variant preset: brownfield (extends a running plugin, builds on the Dashboard)
- Triggered risks:
  - **New product outcome:** the Orchestrator tab, rule-based assessment flags, an LLM assessment on click, nudging agents when the nudge switch is on → this PRD + `prd-ready`
  - **New consumed contract:** new plugin RPCs; a new `BM-*` notice type that Manager and Worker must understand, so `roles/manager.md` and `roles/worker.md` change behaviour → Technical Design + `design-ready`
  - **Writes to the user's Paseo configuration:** a fourth role `bm-orchestrator` (provider alias + profile) is created, edited on Setup and removed by the cleanup button → Technical Design + `design-ready`
  - **Permission boundary:** for the first time the plugin actively sends a message to a running agent (behind a flag, off by default), and creates an agent when the user clicks; contrary to the Dashboard's current REQ-047 → Technical Design + **ADR-013** + negative tests
  - **Privacy:** conversation content (with secrets redacted) is sent to the user's model for assessment; assessment results are written in the data folder → Technical Design
  - **Several independent outcomes:** rules, tab, new role, assessment, agent nudge, cleanup → Implementation Plan + `plan-ready-for-beads`
- Required artifacts/gates: this PRD [`prd-ready`] → Technical Design (extending the two existing designs) [`design-ready`] + ADR-013 → Implementation Plan [`plan-ready-for-beads`] → Beads → `feature-done` (standard, with one acceptance run on an isolated daemon following `scripts/manual-test/`)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-28 — hieu.nt10 (Claude proposed; the owner settled: intervention yes but behind a flag, observe only paseo-bm's agents, LLM assessment only on click; intervention is only **nudging a running agent**; a fourth tab on Setup; a new role `bm-orchestrator`)
- Supersedes: none

## 1. Context

The Dashboard (Metric screen) shows **what happened** with each request: the Manager → Worker → Reviewer tree, what was sent and received, tokens and cost, which feature-workflow steps were done. It does not say **whether the work was done well**. Assessment currently lives entirely in the head of whoever reads the timeline.

The two acceptance runs of 0.4.0 and 0.4.1 (2026-09-26 → 28, run record `docs/archive/operations/paseo-bm-install-run-20260926.md`) showed the price of that gap: every coordination slip was found by **reading** the timeline **by hand** —

- a Manager without Paseo tools improvised a `paseo run` command in the shell to create a Worker;
- a Manager remembered the old model after the user changed provider, and the Worker failed on its first turn;
- a Worker asked for a Reviewer with the model `"default"`;
- a Manager switched to English after a `BM-REPORT` although the user wrote in Vietnamese;
- a Manager passed the user a connector notice unrelated to the request.

No screen reports any of this, and no loop turns them into a change to the instructions. Coordination quality only improves when someone sits down and reads.

**Why now:** 0.4 is the first release installed directly from paseo.cafe, so new users will not read timelines the way a developer does. The data needed for assessment is already in the trace store (ADR-007), and the plugin already has a precedent for nudging agents by rule (`BM-FORMAT`, `BM-BUDGET`) through a queue that does not interrupt a running turn.

## 2. Goals & success metrics

**Goals**

1. See in one place **which requests were coordinated poorly and why**, with evidence, without reading the conversation.
2. When needed, get an **in-depth assessment** of a request, ending with suggested changes to the role instructions that the user decides whether to apply.
3. If the user turns it on, the plugin **nudges** a running Manager or Worker when a rule sees a slip, so the agent corrects itself within that same request.

**Metrics**

| ID | Metric | Target | How measured |
|---|---|---|---|
| O-1 | Rules catch the known slips | Each rule of the first catalogue catches its case on the sample trace set, 0 false positives on the "clean" sample trace | Tests on trace fixtures, including the cases from the 2026-09-26 run record |
| O-2 | Transparent assessment cost | 100 % of "Assess" clicks show the model that will run and the size of the content to be sent **before** creating the agent; cancelling creates nothing | Tests + acceptance |
| O-3 | Off means off | Nudge switch off → 0 Orchestrator messages sent to agents, in every flow | Negative test |
| O-4 | Nudges do not become noise | At most one nudge per rule per request; every nudge shows in the trace | Tests + acceptance |
| O-5 | Costs nothing when unused | No "Assess" click and the nudge switch off → no agent created, no extra token spent, no periodic task running | Negative test |

## 3. Out of scope

- Observing agents that are **not** paseo-bm's (other main agents in the projects).
- LLM assessment that **runs in the background or on a schedule**; every LLM assessment is triggered by the user's click.
- **Applying** instruction suggestions **automatically**; only the user applies them, with a button that asks for confirmation.
- Any intervention other than **nudging**: no stopping, no cancelling a turn, no archiving or deleting agents, no answering questions on the user's behalf, no editing beads, no creating Workers.
- Nudging the **Reviewer**: the Reviewer only reads and runs one short turn; its slips are reported to the Worker.
- Aggregating data across machines, exporting reports, long-term charts over time.

## 4. Personas / Affected Actors

| Actor | Context | Wants | Pain today |
|---|---|---|---|
| paseo-bm user (machine owner) | Hands work to Beads Manager in several workspaces | To know whether the agents coordinate properly, and to adjust so the next time goes better | Has to read each agent's timeline to see a slip; has no way to turn what they see into a change |
| Beads Manager, Beads Worker | Running a request | To get an early signal when it drifts off the process | Only finds out when the user notices and says so |
| `bm-orchestrator` (new) | Read-only agent, created each time the user clicks "Assess" | To read the trace of one request and return a structured assessment | — |

## 5. User / Operational Journeys

- **J-O1 — Overview.** The user opens Beads Manager → Setup → the **Orchestrator** tab. They see the recent requests of every workspace, each with its flag count; the most frequently recurring flags; the average time, cost and number of review rounds by size. Clicking a request → opens its trace on the Metric screen, with the flags shown next to the evidence.
- **J-O2 — In-depth assessment of a request.** On a request, the user clicks **Assess**. The confirmation dialog says which model will run (the `bm-orchestrator` profile), what content will be sent (the redacted trace, estimated size) and that this costs tokens. On consent → one `bm-orchestrator` agent runs once. The result shows next to the trace: scores against a fixed set of criteria, findings with evidence, and instruction suggestions per role. For each suggestion the user can click **Add to <role>'s instructions**: preview the change, confirm, and the passage is appended to that role's "Additional instructions".
- **J-O3 — Turning on agent nudges.** On the Orchestrator tab the user turns on **Nudge running agents**. A warning dialog says the plugin will send messages into the Manager/Worker chat when it sees a slip, and lets the user choose which rules may nudge. In a running request, the Worker starts creating beads for a Small task → at the next end of turn, the Worker receives a short notice saying what was observed and what it should do; the Worker corrects itself. The nudge shows in the trace and on the tab. Turning the switch off → no more nudges.

## 6. Functional Requirements

Priority: **P2** = required for Phase O1 MVP; **P3** = later.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-071 | Orchestrator tab | P2 | (a) Beads Manager's Setup screen has a fourth tab **Orchestrator** beside Beads tools, Agent skills, Agents. (b) The tab shows: the recent requests of every workspace that has traces, each row with workspace, time, size, status and flag count per level; the flags that occur most often in the period being viewed, each with the number of requests it hit; the average time, estimated cost and number of review rounds by size (Small/Medium/Large). (c) Clicking a request opens its trace on the Metric screen of the right workspace. (d) With no traces yet, it shows an empty state with a sentence of explanation. (e) The tab reads from the trace store, calls no model and goes to no network |
| REQ-072 | Rule-based flags | P2 | (a) Each request is scored by a **fixed catalogue of rules** (no LLM): each flag has a code, a level (`info` / `warning`), one sentence saying what was observed, one sentence saying why it deserves attention, and **evidence** pointing at a specific entry in the trace. (b) The first catalogue covers at least these groups: process weight against size (a Small task with beads, new documents or a Reviewer not asked for; a Medium/Large task with no review); number of review rounds against the budget; an agent failing on its first turn; an agent created on a model other than its profile's (corrected by the hook); a `BM-*` report missing or in the wrong format; a Manager answer in a different language from the one the user wrote in. The concrete list and thresholds are in the Technical Design. (c) The same trace always yields the same set of flags. (d) When the trace lacks the data to conclude, that flag is "unknown", not "pass" |
| REQ-073 | Flags on the Metric screen | P2 | (a) A request's detail on the Metric screen shows its flags, each opening onto its evidence. (b) The trace list shows the number of `warning` flags on each row. (c) Orchestrator's nudges to agents (REQ-078) show in the trace as an event of their own, distinguishable from user messages and Worker reports |
| REQ-074 | paseo-bm's agents only | P2 | (a) The only data source is the traces the trace store has recorded for paseo-bm's Manager, Worker, Reviewer. (b) It does not read the timeline, configuration or files of any other agent, including agents running in the same workspace. There is a negative test |
| REQ-075 | In-depth assessment on click | P2 | (a) Each request has an **Assess** button. (b) Before doing anything, a confirmation dialog states: the provider and model of the `bm-orchestrator` profile, that the trace content (redacted) will be sent to that provider, the estimated size of the content and that this costs tokens; the default choice is to do nothing. (c) On consent → create **one** `bm-orchestrator` agent in the request's workspace, read-only, with no Paseo tools, writing no files, receiving only the redacted trace. (d) The result is structured: scores against a fixed set of criteria (size, process weight, coordination between agents, communication with the user, report quality, review quality), findings with evidence, and instruction suggestions tied to a role (Manager/Worker/Reviewer) with the suggested passage. (e) The result is stored next to the trace, shown again when the trace is opened, and deleted when the trace is deleted. Clicking again creates a new assessment; the old one can still be viewed. (f) If the agent does not return a correctly structured result, show an error with the raw answer, without guessing. (g) The plugin does not archive or delete the assessment agent itself (ADR-005): the agent belongs to the user like every other agent |
| REQ-076 | Applying a suggestion | P2 | (a) Each suggestion has a button that appends the suggested passage to the right role's "Additional instructions". (b) Before writing, show the text after appending and its character count against the limit; the default of the confirmation is no. (c) Append only; never edit or delete what the user has written. (d) Applies only to agents created afterwards, like every existing instruction change. (e) There is no path that applies a suggestion without going through this button |
| REQ-077 | The `bm-orchestrator` role | P2 | (a) A fourth role is created at the same time and under the same rules as the three existing ones (when Beads Manager or Setup is opened, default provider and model as for the other three, an existing entry is left unchanged). (b) Provider, model and thinking can be changed on Setup → Agents like the other three. (c) No Paseo tools; the mode is chosen by the Reviewer's rule (never a dangerous or planning mode), and the role's instructions say it only reads and changes nothing. (d) The cleanup button removes this role too. (e) A machine with 0.4.x installed: the role is created on the next open after the update, with nothing more to do, and without touching the three existing roles |
| REQ-078 | Nudging a running agent (behind a switch) | P2 | (a) A **Nudge running agents** switch on the Orchestrator tab, **off by default**; turning it on goes through a warning dialog saying the plugin will send messages into the Manager/Worker chat. (b) The user chooses which rules may nudge, among the rules the Technical Design marks as nudgeable. (c) When on: a nudging rule detects a slip in a **running** request → the plugin sends **one** `BM-*` notice to the Manager or Worker concerned. To reach a Worker while it works, the plugin watches the running Workers of Small requests (only while the switch is on), and a nudge to a running Worker **interrupts its current step**; the Worker then checks the state of what it was doing and continues. A Worker that is waiting for the user, or has finished, is never nudged. (d) At most one nudge per rule per request. (e) The notice says what was observed and what should be done; the role instructions tell the agent to treat it as a suggestion from the plugin, and the user's word always wins over it. (f) Every nudge is recorded in the trace (REQ-073c) and counted on the tab. (g) Switch off → no new nudge, including notices still waiting in the queue |
| REQ-079 | Action boundary | P2 | (a) The only things Orchestrator does to agents: **create** a `bm-orchestrator` agent after the user confirms (REQ-075), and **send a nudge notice** when the switch is on (REQ-078). (b) No stopping, cancelling a turn, archiving or deleting agents; no answering a Worker's questions; no editing beads, documents, configuration or role instructions other than through the button of REQ-076. (c) REQ-047 of the Dashboard PRD is amended accordingly: the Dashboard part stays read-only; the two actions in (a) are the only exceptions and both belong to Orchestrator. (d) There is a negative test for each item in (b) and for O-3, O-5 |
| REQ-080 | Privacy and storage | P2 | (a) Content sent to the assessment agent goes through the same secret redaction as the trace store. (b) Assessment results and Orchestrator settings (flag, nudging rules) live in paseo-bm's data folder with permissions `0600`/`0700`, can be deleted together with the traces, and follow the cleanup button's rules exactly (keep or delete data according to the choice). (c) A version update does not delete assessment results |
| REQ-081 | More rules and trends | P3 | Extend the rule catalogue according to what LLM assessments often find; trends of flags over time, to see whether an instruction change worked |

## 7. Non-Functional Requirements

| Group | Requirement |
|---|---|
| Performance | Flags are computed from stored traces, with a cap like the Dashboard's REQ-049; the tab opens without reading the whole store each time. Checking rules for nudges runs on the existing end-of-turn hook and does not slow an agent's turn noticeably. The only periodic task is the watcher of running Workers, which exists only while the nudge switch is on: bounded in how many Workers it watches, how often it reads and how much it reads. |
| Cost | No extra token is spent when Assess is not clicked and the nudge switch is off (O-5). Each Assess is exactly one agent, one turn. |
| Correctness | Rules are deterministic; missing data means "unknown" (REQ-072d). An LLM assessment is always presented as **one model's opinion**, with evidence, not a verdict. |
| Safety and privacy | REQ-074, REQ-079, REQ-080; every action with an effect comes after a confirmation or behind a flag that is off by default. |
| Compatibility | No existing RPC contract changes; new RPCs are additions. Existing `BM-*` formats do not change; the nudge notice is a new type. Traces written by older releases are still scored (a flag lacking data is "unknown"). |
| Interface | As the Dashboard: React Native primitives, colours from `theme.colors`, accessibility labels, interface text in English. |
| Testing | Rules, tab aggregation, building the content sent to the assessment agent, reading the structured result, applying suggestions and the nudge decision are all pure modules, testable without a renderer; plus one acceptance run on an isolated daemon. |

## 8. Boundaries & Dependencies

- **Builds on the Dashboard:** the trace store and secret redaction ([ADR-007](../adr/ADR-007-dashboard-trace-store.md)), the `BM-REPORT` reader, feature-workflow step inference (REQ-045), the Metric screen. Flag quality is proportional to trace quality.
- **Builds on existing plugin mechanisms:** the notice queue (delivers messages when an agent ends a turn), the `before("agent.create")` hook (injects instructions for the new role), `config.patch` to create and remove roles (ADR-006, ADR-008, ADR-012), each role's "Additional instructions".
- **Depends on agent behaviour:** Manager/Worker following a nudge is a behavioural constraint, like `BM-FORMAT` and `BM-BUDGET`; the plugin can only nudge, not enforce. The LLM assessment depends on the model the user chooses for `bm-orchestrator`.
- **Does not own:** role instruction content written by the user (only appended to when the user clicks), the user's agents, the beads store, Paseo internals.

## 9. Phase Scope

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase O1 MVP | REQ-071 → REQ-080 | Every P2 AC met; O-1 → O-5 met; ADR-013 Accepted; REQ-047 of the Dashboard PRD amended accordingly; typecheck, lint, test, build clean; one acceptance run on an isolated daemon with a run record in `docs/archive/operations/` |
| Phase O2 MVP | REQ-081 | Does not block O1 |

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-071 | The first rule catalogue: the exact list, each rule's threshold, and which rules are "nudgeable" | hieu.nt10 | open — Claude proposes in the Technical Design, the owner approves at `design-ready` |
| Q-072 | The scoring criteria of the LLM assessment and the scale | hieu.nt10 | open — proposed in the Technical Design |
| Q-073 | The tab's default period (for example 7 or 30 days) | hieu.nt10 | open — does not block the design |
| Q-074 | Whom to nudge when the slip belongs to the Worker but the Worker is waiting for the user: the Worker (when it runs again) or the Manager | hieu.nt10 | open — proposed in the Technical Design |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-28 | hieu.nt10 | Owner allows a more proactive Orchestrator, Workers included: REQ-078 (c) now watches running Workers of Small requests while the switch is on and may interrupt a running Worker to nudge it (never one waiting for the user or finished); NFR performance names that watcher as the only periodic task; O-5 adds "no periodic task" |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | REQ-078 (c) states the limit found when checking the design against the code: the plugin cannot break into a running turn, so a nudge for a Worker arrives only when the Worker pauses mid-work, and never wakes a Worker waiting for the user — confirmed by the owner at gate `design-ready` |
| 2026-09-28 | hieu.nt10 | **Accepted**: the owner approved the PRD and handed Q-071 → Q-074 to the Technical Design to propose (owner approves at gate `design-ready`); `prd-ready` PASS |
| 2026-09-28 | hieu.nt10 (drafted by Claude) | PRD created in status Review, following the owner's decisions the same day: intervention yes, but behind a flag that is off by default and only as nudging a running agent; observe only paseo-bm's agents; LLM assessment only on click, run by a new role `bm-orchestrator`; a fourth tab on Setup |
