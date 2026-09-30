# paseo-bm — Calibrated autonomy: the programme PRD

| Field | Value |
|---|---|
| Status | **Accepted** (2026-09-29) — approved by owner hieu.nt10; gate `prd-ready` PASS |
| Living document | Once Accepted, edited in place with one Revision History line per edit. This PRD states **outcomes**; mechanisms, formats, limits, labels and layouts live in the Technical Designs and the [experience concept](../design/paseo-bm-experience-concept.md) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-29 |
| Scope | The whole product: the four roles, how they hand work to each other, how the owner is involved, how the product is measured, and the management screens. It is a **programme**: seven phases, each with its own design, plan and gate |
| Related PRDs | [Base PRD](./paseo-bm-prd.md), [Dashboard PRD](./paseo-bm-dashboard-prd.md), [Orchestrator PRD](./paseo-bm-orchestrator-prd.md) — see §9 for what this PRD supersedes or amends in each on acceptance |
| Experience concept | [paseo-bm-experience-concept.md](../design/paseo-bm-experience-concept.md) (Draft) — the fresh-eye proposal for the management screens and the cards of the four roles |
| Technical Designs | [Evaluation](../design/paseo-bm-evaluation.md) (Phase 0, Active) · [Calibrated autonomy](../design/paseo-bm-autonomy.md) (Phases 1–6, Active) |
| ADRs | [ADR-017](../adr/ADR-017-decisions-are-stored-objects.md) · [ADR-018](../adr/ADR-018-calibrated-autonomy-per-class.md) (Accepted) · [ADR-019](../adr/ADR-019-action-boundary-permission-events.md) (Proposed, decided by the Phase 4 spike) |
| Plans | [Phase 0](../archive/plans/paseo-bm-plan-autonomy-phase0.md) (Completed) · [1a](../archive/plans/paseo-bm-plan-autonomy-phase1a.md) · [1b](../plans/paseo-bm-plan-autonomy-phase1b.md) · [2](../plans/paseo-bm-plan-autonomy-phase2.md) · [3](../plans/paseo-bm-plan-autonomy-phase3.md) · [4](../plans/paseo-bm-plan-autonomy-phase4.md) · [5](../plans/paseo-bm-plan-autonomy-phase5.md) · [6](../plans/paseo-bm-plan-autonomy-phase6.md) (Draft) |
| References | Andrew Ng's agentic design patterns and the synthesis note *Graph Engineering for Multi-Agentic Systems: The Andrew Ng Playbook* (independent compilation, July 2026: principles used, its illustrative numbers are not); Anthropic, *Building Effective Agents* (Dec 2024); the `paseo-room` Supervisor design (attention letters, context succession), reviewed 2026-09-29 |
| Routing decision | [§0](#0-routing-decision) |

## 0. Routing Decision

- Variant preset: brownfield (a running product whose goal changed; large parts are rebuilt or removed)
- Triggered risks:
  - **New product outcome:** agents decide within a policy the owner calibrates from evidence, instead of the owner approving each step → this PRD + `prd-ready`
  - **Consumed contracts change or are removed:** the `BM-*` blocks, plugin RPCs, MCP tools, stored formats, the role instruction files → Technical Design per phase + `design-ready`
  - **Permission boundary:** decisions made on the owner's behalf; effectful actions (git push, publish, deploy, data, outside the workspace) authorised by policy or by a one-time grant → ADRs + negative tests
  - **Architecture:** decisions become stored objects; typed handoffs replace relayed text; a policy engine; an evaluation harness → ADRs (expected: decision objects, calibrated autonomy, action boundary, traceability)
  - **Removal of shipped surfaces:** screens, notices, tools and instructions superseded by this programme are deleted, not kept beside it → retirement list per phase (§11), owner-confirmed
  - **Several independent outcomes in an order, over many sessions:** seven phases → one plan per phase + `plan-ready-for-beads`
- Required artifacts/gates: this PRD [`prd-ready`] → per phase: Technical Design (and ADR where triggered) [`design-ready`] → Implementation Plan [`plan-ready-for-beads`] → Beads → `feature-done` with an evaluation run (§10)
- Execution path: plan → converter, one phase at a time; a phase starts only after the previous phase's exit gate
- Exceptions: none
- Decided: 2026-09-29 — hieu.nt10, from the owner's direction ("the project's goal has moved far; do not stay bound to old consequences; accept deleting what no longer fits"); proposed by Claude, approved by the owner at `prd-ready`
- Supersedes: on acceptance, the Routing Decision of the [Orchestrator PRD](./paseo-bm-orchestrator-prd.md#0-routing-decision) (its open work folds into Phase 1 MVP)

## 1. Context

### 1.1 The goal moved

paseo-bm began as "hand a feature request in words, get reviewed documents and beads back", with the owner approving every step and a metric of **zero** decisions the Worker makes on its own (base PRD M-16). Each release since has moved decisions from the owner to the agents: the Worker decides what it can undo (2026-09-24), the Manager answers facts and coordinates Workers (ADR-011, 2026-09-25), and the Orchestrator went in two days from "propose, the owner clicks" to "Autopilot answers and commands" to "correct a Worker directly" (ADR-014 → ADR-016).

The owner's goal is now explicit: **give the agents the authority to decide, to work with each other, and to bring the right expertise, so that they can carry software development work end to end — with the owner setting the limits and handling the exceptions.**

### 1.2 Why a programme, and why now

Every step toward that goal was built by adding an agent layer or a paragraph of instructions, not by changing the mechanism underneath. The evidence from the owner's own machine (trace store, 2026-09-15 → 2026-09-29, Appendix A):

- **The owner is used as an approval machine.** 74 requests raised about 380 questions to the owner; 54 of 74 requests stopped at least once; **the owner picked the Worker's recommended option in 269 of 339 answered questions (79 %)**. The rest cluster in four classes: scope, git/release, environment and access, product preference.
- **Coordination travels as relayed text.** A question is copied from the Worker's chat to the Manager's, to the Orchestrator's, to a card on the tab. On 2026-09-29 the same push question appeared twice on the tab, the owner answered both, and the Orchestrator's command was then refused by its own gate and asked again. Earlier repeated-question diagnoses (2026-09-23, 2026-09-24) and a report cut in half (2026-09-28) share the cause.
- **The relay costs more turns than the work.** Manager 1,041 turns, Worker 860, Reviewer 313 — while the Worker spends about 92 % of the tokens.
- **Safety relies on instructions and after-the-fact detection.** The Worker runs without permission prompts ("these five are the only barrier"); a `git push` is detected by the live watch *after* it ran; big decisions are found by regular expressions over prose, patched after each incident (F1–F7 of 2026-09-29).
- **Nothing is measured before it is promoted.** There is no repeatable evaluation; a new layer is judged by one acceptance run.

The references agree on the remedy: agents should communicate **through typed artifacts and shared state, not conversation**; use a **workflow before an agent** wherever the path is known; **match control to risk**; and **measure before adding complexity** — each stage earns the next by fixing a measured failure of the one before.

## 2. Goals and success metrics

**Goals**

1. The owner is asked **only** what the owner's policy reserves, **once**, and one action settles it everywhere.
2. Autonomy grows by **evidence**: a class of decisions moves to the agents only after they are shown to decide it as the owner would, and moves back as soon as they do not.
3. An effectful action (release, real data, outside the workspace) **cannot happen** without the policy or the owner's grant — stopped before it runs, not reported after.
4. Every important output can be traced to its request, its decisions, its plan, its evidence and its review.
5. The product gets simpler as it gets more capable: what a new mechanism supersedes is deleted.

**Metrics** (field baselines from the replay of 2026-09-29, [baseline report](../operations/paseo-bm-eval-baseline.md); targets confirmed at the Phase 0 exit, approved by Claude under the owner's delegation (2026-09-29); the suite figures come from the programme evaluation)

| ID | Metric | Baseline | Target | Measured by |
|---|---|---|---|---|
| A-1 | Questions reaching the owner per finished request | 4.83 (5.37 asked) — field replay | ≤ 1.5 at Phase 2 exit — checked at the Phase 2 start against the class mix measured in Phase 1; re-set with that evidence if the delegable classes cannot reach it | Evaluation replay (REQ-100) |
| A-2 | Duplicate or re-asked owner decisions | 21 — field replay | 0 | Replay + suite |
| A-3 | Owner actions to settle one decision | 1–4 | 1; 2 when the answer grants a release, data, security or cost effect (the deliberate confirmation, X-4) | Suite + experience review |
| A-4 | Owner override rate of delegated decisions | n/a | < 5 % per class | Agreement ledger (REQ-122) |
| A-5 | Reversal rate of delegated decisions (later reopened, overridden or contradicted) | owner's own: 5 of 339 answers re-answered (field; the reopen signal is noisy, see the baseline report) | not higher than the owner's | Outcome tracking (REQ-103) |
| A-6 | Unauthorised effectful actions executed | 203 executed, 75 with no owner text naming them first (field, heuristic) | 0 — exact from Phase 1 on (every effect carries its authority: grant, decision or policy) | Field replay, live checks, the programme evaluation |
| A-7 | Orchestrator wakes that end with no action | 5 of 13 (38 %) — field replay, approximate | < 20 % | Replay |
| A-8 | Tokens per finished request, all roles | median 22.9 M, mean 86.4 M (Worker 93 %) — field replay | no regression > 10 % in any phase; a reduction target is set only with a mechanism aimed at the Worker's context (a Phase 6 candidate such as a read-only scout), since no earlier phase acts on the Worker's 93 % | Replay |
| A-9 | Evaluation suite: correct outcome and boundary-clean | 0.4.1, measured at the programme evaluation | the final build not below 0.4.1 | Suite (REQ-101), once at the programme's end |
| A-10 | Sampled outputs whose full chain (request → decision → bead → change → review → run) can be shown | not possible | ≥ 90 % at Phase 5 exit | Traceability audit |
| A-11 | Median time from request to finished, owner wait excluded | 35 min — field replay | not worse | Replay |

## 3. Commitments that bind every phase

1. **Artifacts, not conversation.** A handoff between agents, or between an agent and the owner, is a typed record with one identity. Text in a chat is a view of it, never its copy.
2. **Workflow before agent.** What code can decide from facts (routing, ordering, deduplication, limits) is decided by code. A model is woken only for judgement.
3. **Control matches risk.** The owner's policy, not the agent's wording, decides who may decide what.
4. **Measure before promoting.** No new role, signal, layer or autonomy level ships without a measured failure it fixes and a metric that shows it did.
5. **Delete what is superseded.** A phase removes the surfaces it replaces in the same phase (§11). Two ways to do the same thing are not kept.

## 4. Out of scope

- A hosted service, telemetry, or any data leaving the owner's machine (no external classifier or "attention sensor").
- A separate graph database. Traceability is built on the stores that exist (beads, trace store, decision store) until a measured need says otherwise.
- Changing Paseo itself; working around a missing Paseo capability with an unsupported hack.
- Releases, versions and publishing: each plan stops at acceptance; the owner tests, picks the version and releases.
- Native Windows; remote daemons.
- Keeping compatibility with agents created by earlier releases beyond detecting them and offering to replace them (Q-106).

## 5. Personas and affected actors

| Actor | Context | Wants | Pain today |
|---|---|---|---|
| **Owner** (hieu.nt10) | Runs several repositories at once through paseo-bm; writes in Vietnamese; accepts more risk than the agents assume (overrides favour "do it now", "push to dev") | Be asked only what matters, once; see what was decided for them and undo it; trust that nothing dangerous runs without them | Answers ~5 questions per request, 4 in 5 of which confirm the recommendation; the same question in several places; approvals refused by the product's own gate |
| **Adopter** (a colleague installing paseo-bm) | New to beads and to the roles | Safe defaults; understand what the agents may do | Many switches (Watch, Autopilot, Allow…, per-role settings) with overlapping meaning |
| **Beads Orchestrator** (redefined) | One per machine | Decide the delegated classes as the owner would, across projects; answer the owner's questions about all projects | Woken for events that need no judgement; reads whole transcripts; relays |
| **Beads Manager** (redefined, kept — Q-100) | One per workspace; the owner's contact for that project | Keep the project's context for its Workers (the owner's goals, standing decisions, what every request is doing), keep all work aligned with the owner's goals, and face the owner for that project | Spends its turns relaying questions and answers as text instead of keeping context and alignment |
| **Beads Worker** (redefined) | One per request | Deliver the change, plan it in beads, prove it, ask only what it may not decide | Asks what it could decide; 400-line instructions that also describe mechanisms |
| **Beads Reviewer** (redefined) | One per review batch | Judge a batch against the request with evidence | Its effect on outcomes is not measured |

## 6. Journeys

- **J-1 — Asked once.** A Worker needs a scope decision. One decision appears in the owner's Inbox, in the Worker's chat and in the Manager's chat — the same object. The owner taps an option in any of them; all three show it answered, and the prepared action runs at once with the owner's authority. Nobody asks again.
- **J-2 — Decided for the owner, visibly.** A reversible technical choice matches a class the owner has delegated. It is decided by policy and appears in the daily digest with who decided, why and the precedent it followed; the owner overrides it in one action and the class is demoted.
- **J-3 — Earning autonomy.** In shadow mode the product records what the agents would have answered beside what the owner answered. When the `preference` class reaches the threshold, Insights proposes delegating it; the owner confirms.
- **J-4 — Stopped before it runs.** A Worker tries `git push`. The action is held before it runs and becomes a `release` decision with a prepared "push these commits" action; the owner approves once, the push runs, the grant is spent.
- **J-5 — Why is this line here?** The owner asks why a file changed. The product shows the request, the decision that authorised it, the bead, the check that proved it and the review verdict.
- **J-6 — A release the owner can trust.** Before releasing, the owner runs the evaluation suite; the scorecard compares with the previous version and no metric regressed.

## 7. Functional requirements

Priority: **P1** = required for the phase it belongs to; **P2** = in that phase if its design finds room, else next phase. Requirement IDs start at REQ-100 to stay clear of the existing PRDs.

### Phase 0 — Baseline

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-100 | **Evaluation replay** | P1 | (a) A command reads the trace store read-only and computes A-1…A-11 plus: rounds blocked, recommended-option agreement, format problems, cancelled turns, review findings (blocking, acted on), Orchestrator wakes and actions, tokens by role. (b) Same store in → same numbers out. (c) Reads stores written by 0.4.x and by the current tree. (d) Writes nothing outside its output |
| REQ-101 | **Evaluation suite** | P1 | (a) At least 7 scripted scenarios on scratch repositories on an isolated daemon: one Small, two Medium, one touching a public contract, one duplicating an open bead, two Workers on the same files, one needing a release decision. (b) A scorecard per run: outcome correct, checks green, bead lint clean, boundaries respected (base PRD M-13), questions to the owner, tokens, time. (c) Never touches the owner's Paseo configuration or repositories |
| REQ-102 | **Baseline report** | P1 | A report for 0.4.1 and for the current tree, with the owner's targets for Phases 1–3 recorded in this PRD (§2) |
| REQ-103 | **Decision outcome tracking** | P1 | For every owner decision in the store: whether it was later reversed (a bead reopened because of it, an overriding command, an answer contradicted). The owner's own reversal rate is the reference for A-5 |

### Phase 1 MVP — One source of truth for decisions and handoffs

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-110 | **Decision objects** | P1 | (a) Every question that needs the owner or a delegate is one stored record with an identity, the request it belongs to, who asks, its options with one recommendation, the effects each option would have, and a lifecycle (open, answered, decided-by-policy, superseded, expired, withdrawn). (b) It survives a plugin reload. (c) A new question on the same subject of the same request supersedes the open one; a second open copy cannot exist |
| REQ-111 | **One question, one card, everywhere** | P1 | (a) The Inbox, the asking agent's chat, the Manager's chat and the Orchestrator's chat show the same decision. (b) Answered in any of them → shown answered in all within 5 s. (c) No agent relays a question or an answer as text. (d) An answer the owner types in an agent's chat about an open decision settles it (confirmed by the owner in one tap if ambiguous) |
| REQ-112 | **One action settles a decision** | P1 | (a) Each option may carry a prepared action; choosing it runs the action at once with the owner's authority. (b) The answer grants exactly the effects of that action, for one use, within 60 minutes (owner decision 2026-09-29), and the delivered instruction states it as approved, never beside a contradicting limit. (c) "Own words" is always available and goes to the asker as the answer |
| REQ-113 | **Typed handoffs** | P1 | (a) The request brief, the Worker's reports, review requests and verdicts, commands and answers are typed records validated when they are created; free text is only their body. (b) An invalid handoff is refused to its author at once; nothing is corrected after delivery. (c) Providers that cannot use the plugin's tools get a documented degraded mode, not a second format |
| REQ-114 | **Declared intent and effects** | P1 | (a) Every command and prepared action declares its intent (answer, continue, redirect, stop, release, …) and its effects. (b) Authority is decided from the declared effects and the policy. (c) Text heuristics remain only as a backstop: a mismatch between text and declared effects becomes a decision, never a silent send |
| REQ-115 | **Bounded context for coordinators** | P1 | (a) The Orchestrator and the Manager receive bounded, typed summaries by default and full content only when they ask for it. (b) The Orchestrator is woken only by typed events that need judgement (a delegated decision, a request from the owner, a safety event); A-7 < 20 % on the suite |
| REQ-116 | **Capability limits by configuration** | P1 | Each role's Paseo tools are limited by configuration to what it needs (the Reviewer and the Orchestrator get no Paseo agent tools; no role can archive or delete agents, answer another agent's permission or change another agent's mode). (b) Only the Manager creates Workers and only a Worker creates Reviewers: enforced at creation where Paseo lets the creation hook refuse, otherwise raised as an Inbox alert (design §A.10). A negative test per role |
| REQ-117 | **Roles redefined, instructions rewritten from zero** | P1 | (a) The four instruction files are rewritten for the redefined roles (§5) with a size budget each, set in the design. (b) No instruction describes a mechanism the plugin enforces (formats, relays, limits already in code). (c) **The Manager keeps the project's context** (Q-100): each Worker's brief carries the context it needs — the owner's goals for the project, the precedents and decisions that bear on the request, the other requests it may touch — and the Manager answers the owner about the project from that context. (d) **The Manager keeps the work aligned**: it checks each request's plan and result against the owner's stated goals and raises a misalignment as a decision (REQ-110); it does not approve or reject technical choices. (e) The Manager relays no question, answer or report as text: decisions and typed records carry them (REQ-111, REQ-113) |
| REQ-118 | **New management experience** | P1 | (a) Beads Manager opens on **Inbox** (what needs the owner) with **Work**, **Insights** and **Settings** beside it, as in the experience concept. (b) Setup is configuration only. (c) Every card of the four roles follows one card grammar: who → whom, on whose authority, one status, one primary action, details on demand. (d) Tested on a phone width and a desktop width |
| REQ-119 | **Retirement, Phase 1** | P1 | Every surface in Appendix B marked "Phase 1" is deleted in this phase — code, tests, notices, instructions, docs; none survives to the programme release (Q-101) |

### Phase 2 MVP — Calibrated autonomy

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-120 | **Decision classes** | P1 | (a) Every decision has a class from a fixed list (at least: reversible-technical, scope, preference, environment, release, data, security, cost). (b) The asker proposes the class; the plugin checks it against the declared effects; on conflict the riskier class wins |
| REQ-121 | **Autonomy policy** | P1 | (a) Per project and per class: `owner`, `shadow` or `delegate`. (b) Defaults for a new install: every class `owner`, shadow recording on. (c) `release`, `data`, `security` and `cost` can never be `delegate`; they pass only through a grant (REQ-112). (d) One action returns every class of a project to `owner` |
| REQ-122 | **Shadow and the agreement ledger** | P1 | (a) For every owner decision, the product records the recommended option and the delegate's prediction next to the owner's answer. (b) Insights shows agreement and reversal per class and project |
| REQ-123 | **Promotion and demotion** | P1 | (a) Promotion to `delegate` is proposed only when agreement ≥ 90 % over ≥ 20 decisions with no reversal (thresholds in the design), and applied only when the owner confirms. (b) An owner override or a reversal of a delegated decision demotes that class to `shadow` at once and says so |
| REQ-124 | **Precedents** | P1 | (a) An owner decision can become a precedent with a scope (project or all), its source decision, and an expiry. (b) Agents consult precedents before asking; a question a precedent answers is resolved by it within the policy and cites it. (c) A new decision on the same subject supersedes the precedent |
| REQ-125 | **Delegated decisions are visible and reversible** | P1 | (a) A digest in the Inbox lists what was decided for the owner since they last looked, with the precedent or reason. (b) Each can be overridden in one action, which reaches the agent concerned as a decision |

### Phase 3 — Evidence-grounded reflection

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-130 | **Detected evidence** | P1 | Each claim of a report (checks run, files changed, beads closed) is labelled *detected* (the plugin saw it in the timeline or the repository), *self-reported* or *unverified* |
| REQ-131 | **Finished means proven** | P1 | A request whose code changed is shown finished only with detected evidence of its checks; otherwise it is "finished — unverified" and a delegate may not act on it as done |
| REQ-132 | **Review lift** | P1 | The replay reports, per tier and project, blocking findings per batch, findings acted on, and tokens per review; review budgets can be tuned per tier from that data |
| REQ-133 | **Independent review by default** | P2 | When more than one model family is available, the Reviewer defaults to a family other than the Worker's, and Setup says when they are the same |

### Phase 4 — The action boundary (gated by a spike)

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-140 | **Spike** | P1 | A report on whether Paseo's permission events can hold an action before it runs, per provider (Claude, Codex, OpenCode): reliability, added latency, behaviour when the plugin is down |
| REQ-141 | **Held before it runs** | P1 (if the spike passes) | Release, real-data, outside-the-workspace, dependency-install and network actions are held before they run and become decisions, unless a grant or the policy covers them; A-6 = 0 on the suite |
| REQ-142 | **Fallback** | P1 (if the spike fails) | Detection signals plus capability limits stay, documented as detection, not prevention |

### Phase 5 — Traceability

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-150 | **Links** | P1 | Requests, decisions, precedents, beads, changes, checks, reviews and runs are linked by identity across the existing stores; supersession is recorded, never an overwrite |
| REQ-151 | **"Why"** | P1 | For a bead, a changed file or a decision, the product shows the chain behind it, in the UI and as a tool for the Orchestrator; A-10 ≥ 90 % |
| REQ-152 | **The link layer earns itself** | P1 | Built only when at least two consumers use it (REQ-151 and one more named in its design) |

### Phase 6 — Specialisation and parallel work, on evidence only

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-160 | **Admission rule for a new specialist** | P1 | A new agent role (security reviewer, independent tester, read-only scout, design committee, …) is added only with replay or suite evidence of an error class the current roles miss, a token budget, and its own evaluation scenario |
| REQ-161 | **Parallel isolation on measured collisions** | P1 | Collision detection (two agents writing the same files in overlapping turns) comes first; isolated workspaces per Worker only if the detection shows real collisions |
| REQ-162 | **Model choice per role by evaluation** | P2 | A role's default model changes only on a suite run showing no quality loss |

### Cross-cutting

| ID | Requirement | Pri | Acceptance criteria |
|---|---|---|---|
| REQ-170 | **Safety floor** | P1 | Unchanged in every phase: agents belong to the owner (no archive or delete by any agent or the plugin); no credential is read, stored or printed; the plugin writes only its data folder and its own Paseo configuration entries |
| REQ-171 | **No rollback path between phases** | P1 | (owner decision 2026-09-29) A phase replaces what it supersedes outright; no runtime switch keeps an old path. A phase that goes wrong is fixed forward after a clean reinstall of the plugin |
| REQ-172 | **Docs follow the product** | P1 | GUIDE, README and the living docs describe only what exists after each phase; retired parts disappear from them |

## 8. Non-functional requirements

| Group | Requirement |
|---|---|
| Latency | An answered decision shows answered everywhere within 5 s; a prepared action starts within 5 s of the tap; the action-boundary hold adds no more than the design's stated budget |
| Cost | No phase raises tokens per finished request by more than 10 % (A-8); the Orchestrator is not woken without a judgement to make (A-7) |
| Reliability | Decisions, grants, precedents and the policy are stored on disk and survive a plugin reload or daemon restart; nothing that matters is held only in memory |
| Security and privacy | Everything stays on the machine; content shown to agents goes through the trace store's redaction; grants are single-use and expire; negative tests for every authority path |
| Compatibility | Paseo ≥ 0.9.2; full behaviour on Claude, Codex and OpenCode; other providers get the documented degraded mode. Trace stores from 0.4.x stay readable (the baseline depends on them). Agents created by earlier releases are detected and offered replacement, not supported |
| Interface | English interface text; content in the owner's language; theme colours only; accessible labels; phone and desktop widths |
| Testing | Pure modules for policy, classes, promotion, supersession; fake-SDK tests for every delivery path; the evaluation suite at every phase exit |

## 9. Boundaries and dependencies

- **Paseo** is the control plane (agents, workspaces, timelines, permission events, tool policy). This programme depends on capabilities read from Paseo 0.9.2 (inventory 2026-09-29): `before("agent.create")`, `before("agent.session_open")`, `agent.permission_requested` + `respondToPermission`, `paseoTools.disabledTools`, workspace creation with worktrees, per-agent context telemetry. Phase 4 depends on the first two being reliable (REQ-140).
- **Beads (`br`)** stays the plan and work graph; this programme reads it and links to it, it does not replace it.
- **Skills** (`feature-workflow` and the bead skills) stay the Worker's method; the plugin never installs them itself.
- **On acceptance of this PRD:**
  - [Orchestrator PRD](./paseo-bm-orchestrator-prd.md) → **Superseded**: REQ-071–087 are replaced by this PRD (Autopilot, Watch, Allow…, proposals, stall and worker signals become policy, decisions and typed events).
  - [Dashboard PRD](./paseo-bm-dashboard-prd.md) → amended: its screen requirements (Metric, Beads, Setup layout, chat cards, pills) are replaced by REQ-118 and the experience concept; the trace store requirements stay.
  - [Base PRD](./paseo-bm-prd.md) → amended: "Worker does not touch git" becomes "effectful actions only through the policy or a grant" (REQ-112, REQ-141); M-16 is kept for the `owner` classes.
- **Does not own:** the owner's repositories and their protocols; Paseo's own agents, providers or plugins; the skill content.

## 10. Phase scope

Each phase ends with its exit gate: its tests, the replay of the owner's own use of the new build (field), a small live check on an isolated daemon where the phase changes live behaviour, and the owner's acceptance. **The full evaluation suite runs once, after every other piece of work is done** (owner decision 2026-09-29): on `paseo-bm-plugin@0.4.1` and on the final build, as the programme's closing gate (Phase 6, programme evaluation). A phase whose field metrics did not improve is not followed by the next one until its design is revisited.

**One release for the programme** (Q-101, owner 2026-09-29): phases are internal milestones, run and accepted on the owner's machine from the working tree. Nothing is released per phase; the programme is released once, after every phase below has met its exit criteria and the owner has accepted the whole. The version and the release itself stay the owner's.

| Phase | Scope | Exit criteria |
|---|---|---|
| **Phase 0 — Baseline** | REQ-100–103 | The evaluation tooling built; the field baseline reported; targets in §2 confirmed by the owner. The suite baseline moves to the programme evaluation (owner decision 2026-09-29) |
| **Phase 1 MVP — One source of truth** | REQ-110–119, REQ-170–172 | A-2 = 0, A-3 at target (1, or 2 with a confirmation), A-7 < 20 % in the field replay of the owner's use of the new build and in a live check; A-8 no regression; the Phase 1 retirement list deleted; owner accepts the new screens |
| **Phase 2 MVP — Calibrated autonomy** | REQ-120–125 | At least two weeks of shadow data; A-1 ≤ 1.5 in the field; A-4 < 5 %, A-5 within the owner's rate for every delegated class |
| **Phase 3 — Evidence** | REQ-130–133 | Every finished request in the field after the phase carries detected evidence or is shown unverified; review lift reported; A-8 no regression > 10 % |
| **Phase 4 — Action boundary** | REQ-140–142 | Spike report accepted; then A-6 = 0 in a live check of held actions and in the field (REQ-141), or the fallback documented (REQ-142) |
| **Phase 5 — Traceability** | REQ-150–152 | A-10 ≥ 90 % on a sample of 30 outputs |
| **Phase 6 — Specialisation and programme evaluation** | REQ-160–162, REQ-101–102 (suite) | Only what passed REQ-160 or REQ-161 ships, each with its own scenario green; then the full suite on 0.4.1 and on the final build: A-9 and every target of §2 judged before the single release |

## 11. Retirement policy

The owner accepts deleting what no longer fits (2026-09-29). Rules:

1. A surface superseded by a phase is deleted **in that phase**: code, tests, notices, RPCs, tools, instruction paragraphs, GUIDE sections.
2. Stored data that older releases wrote is read only where the baseline needs it (trace store); other old files are ignored and removed by the cleanup button.
3. No compatibility layer for agents created before the phase: they are detected by their instruction hash and the owner is offered to replace them.
4. Appendix B is the candidate list; each phase's design confirms or corrects it.

## 12. Open questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-100 | Keep the Manager, or fold intake into the Orchestrator and the plugin and remove the Manager role? | hieu.nt10 | **answered (2026-09-29)** — keep the Manager: it keeps the context for its Workers, keeps all work aligned with the owner's goals, and still faces the owner (§5, REQ-117 c–e) |
| Q-101 | Version and release | hieu.nt10 | **answered (2026-09-29)** — one release when every feature of this PRD is closed, not per phase (§10); the version stays the owner's |
| Q-102 | Defaults for a new install: every class `owner` with shadow on, or a more permissive preset? | hieu.nt10 | **answered (2026-09-29)** — every class `owner`, shadow on (REQ-121 b) |
| Q-103 | Grant: one action within 60 minutes | hieu.nt10 | **answered (2026-09-29)** — yes |
| Q-104 | Token budget for running the evaluation suite (≈ 7 real requests per run) at each phase exit | hieu.nt10 | **answered (2026-09-29)** — accepted |
| Q-105 | Are two weeks of shadow data enough before the first promotion? | hieu.nt10 | **answered (2026-09-29)** — yes, two weeks, together with the count threshold of REQ-123 |
| Q-106 | No support for agents created by earlier releases beyond "replace"? | hieu.nt10 | **answered (2026-09-29)** — yes (§11 rule 3) |
| Q-107 | One Orchestrator per machine, or one per group of projects? | hieu.nt10 | **answered (2026-09-29)** — one per machine |

## 13. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Claude (owner's delegation) | A-3 target refined at the Phase 1 live check: the in-place confirmation X-4 requires for a release, data, security or cost effect is a real tap and counts, so such a decision's target is 2 and every other decision's stays 1 (§2, §10) |
| 2026-09-29 | Claude (owner's delegation) | Phase 0 exit: targets confirmed, approved by Claude under the owner's delegation (2026-09-29). Two amendments from a critical review: A-8 drops "−20 % by Phase 3" (no phase before 6 has a mechanism acting on the Worker's 93 % of tokens — a target needs a mechanism); A-1 is checked at the Phase 2 start against the measured class mix. A-6 is measured exactly from Phase 1 on |
| 2026-09-29 | hieu.nt10 | Owner decision: the full evaluation suite runs once, after all other work (programme evaluation, Phase 6); phase exits use tests, the field replay and small live checks (§10, A-9). The Reviewer/Orchestrator Paseo-tools gap of the shipped release is not verified or patched separately; REQ-116 delivers the target configuration |
| 2026-09-29 | hieu.nt10 | REQ-171 amended: no rollback path between phases, a clean reinstall and a fix forward (design DQ-1); REQ-111 delivery is immediate (DQ-2); the sidebar badge is dropped, the Inbox handles it (DQ-3) |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | REQ-116 made precise after the code survey: the Reviewer and Orchestrator get no Paseo agent tools (their aliases carry no `paseoTools` policy today, which Paseo 0.9.2 reads as enabled), and the role pairing is enforced at creation where Paseo allows it, else alerted; header links the autonomy design, ADR-017 → ADR-019 and the phase plans |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | §2 Baseline column filled from the field replay (bead `bm-autonomy-phase0-m1ih.8`): A-1 is now the stricter "reached the owner" figure (4.83; 5.37 asked); targets unchanged until the Phase 0 exit |
| 2026-09-29 | hieu.nt10 | **Accepted**, `prd-ready` PASS. The experience concept's open questions X-1 → X-4 answered the same day (Inbox badge on the sidebar item only; per-role additional instructions removed; the digest shown only in the Inbox; confirmation only for release, data, security and cost); Appendix B gains the removal of additional instructions |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Owner answered Q-100 → Q-107: the Manager is kept as the project's context keeper and alignment guard facing the owner (§5, REQ-117 c–e); one release when the whole programme is closed (§10, REQ-119, REQ-171); new installs start with every class `owner` and shadow on; two weeks of shadow; replace-only for older agents; one Orchestrator per machine. Status stays Review until the owner accepts the PRD |
| 2026-09-29 | hieu.nt10 (drafted by Claude) | Created in status Review from the owner's direction and three reviews of the same day: the comparison with `paseo-room`'s Supervisor, the evaluation of the trace store, and the *Andrew Ng Playbook* note. Owner decisions already taken: a prepared action per option, a one-use 60-minute grant, an answer typed in a chat closes the card (Q-103, REQ-111, REQ-112) |

## Appendix A — Baseline evidence (trace store, 2026-09-15 → 2026-09-29)

Computed read-only from `~/.paseo-bm/traces` on the owner's machine; REQ-100 turns these one-off queries into the replay.

| Figure | Value |
|---|---|
| Requests with activity / finished | 74 / 70 |
| Tier (last reported) | Large 26, Small 25, Medium 13, changed during the request 10 |
| Requests blocked at least once | 54 |
| Distinct questions to the owner | ≈ 380 (≈ 5.1 per request; max 57 in one request, 21 blocked rounds) |
| Answers equal to the recommended option | 269 / 339 (79 %); another option 56; own words 14 |
| Question wait | median 5 min, p90 53 min |
| Turns by role | Manager 1,041 · Worker 860 · Reviewer 313 |
| Cached input tokens by role | Worker ≈ 92 %, Manager ≈ 4 %, Reviewer ≈ 4 % |
| Worker turns cancelled | 75 of 860 |
| Orchestrator, 2026-09-29, one project | 6 wakes, 4 ended with no action; 2 identical decisions open at once |
| Role models on the owner's machine | Manager, Worker, Orchestrator: `claude-opus-5-5`; Reviewer: `gpt-5.6-sol` (another family) |

## Appendix B — Retirement candidates

Confirmed or corrected by each phase's design (§11).

| Today | Replaced by | Phase |
|---|---|---|
| Questions relayed as text: the Manager's `A6 a` letters, `BM-ANSWERS` relays, `BM-ANSWERED`, the question–answer ledger, waiting pills, "Mark as answered", answer state in `ui/` | Decision objects and one card (REQ-110–112) | 1 |
| `bm_propose_command`, proposals, the pending-proposal replacement rule, approve/dismiss RPCs | A decision with prepared actions | 1 |
| `limits:` text in `BM-COMMAND`, the stop-word exemption, the regex gate as the authority | Declared effects + policy; regex as backstop (REQ-114) | 1 |
| `BM-STALL`, `manager-turn` wake-ups, `autopilot-on` takeover prompt, the "Watch for stalled work" switch | Typed events that need judgement (REQ-115) | 1 |
| Orchestrator tools returning whole transcripts (60,000 / 12,000-character reads) as the default | Bounded summaries; full on request | 1 |
| The Orchestrator tab inside Setup; Setup as the landing screen; the Workspaces list behind a button | Inbox / Work / Insights / Settings (REQ-118) | 1 |
| The twelve workflow-step chips, the Metric text dump, the stats-first Beads overview | Request timeline and stage bar; Insights; board-first Beads | 1 |
| Instruction paragraphs that describe mechanisms (report formats, relay rules, limits restated) | Tools and code; role files rewritten (REQ-117) | 1 |
| Autopilot switch, **Allow…** categories | Autonomy policy per class (REQ-121) | 2 |
| "Assess workflow" suggestions appended to one role's instructions for every project | Precedents per project; replay findings (REQ-124, REQ-100) | 2 |
| Setup → Agents → per-role "additional instructions" (`role-extras.json`, Preview, `apply-suggestion`) | Precedents per project and the rewritten roles (experience concept X-2, owner 2026-09-29) | 2 |
| Runtime rule flags used only for assessment (`process.small-heavy`, `manager.language-mismatch`, …) | Metrics in the replay | 2 |
| Worker-signal regexes as the safety mechanism (`danger`, `outside`) | Hold before execution (REQ-141), or kept as documented fallback (REQ-142) | 4 |
| The `npx paseo-bm` migration CLI in `src/` | Removed from the repository after the owner confirms no 0.3.x install remains | owner's call |
