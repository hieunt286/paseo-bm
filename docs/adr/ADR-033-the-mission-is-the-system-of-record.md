# ADR-033 — The mission is the system of record; the Main is long-lived; one authority, one owner, a signal budget

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-10) — the owner approved the five structural changes of the 2026-10-10 review of mission XAI ("Tôi đồng ý với tất cả các đề xuất"); technical choices by Claude under the owner's delegation |
| Date | 2026-10-10 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-029](ADR-029-missions-mains-and-a-process-governor.md) decision 1's assumption that "a successor reads the mission and continues" holds with today's stores (made true here, decision 1); ADR-029 decision 9's "compaction and handoff run in code" for Mains (decision 2); the missions design §2.2 rule "the journal is not the source of any state" (decision 1); [ADR-032](ADR-032-one-governor-a-mission-per-wake.md) decision 4's separate `BM-SIGNAL` notice (it becomes an item of the Main's channel, decision 5) and decision 2's brief source (the mission state, decision 1) |
| Keeps | ADR-027 (agents write content, code carries it); ADR-029's missions, Mains, two autonomy layers and governor; ADR-031 (an `o:` answer grants nothing); ADR-032 decisions 1, 3, 5, 6; ADR-019's action boundary; ADR-005 (the plugin never archives or stops an agent) |
| Related | **PRD: [missions PRD](../product/paseo-bm-missions-prd.md) REQ-202 → REQ-208, M-31 → M-35** · **Design: [mission runtime design](../design/paseo-bm-mission-runtime.md)** · **Plan: [mission runtime plan](../archive/plans/paseo-bm-plan-mission-runtime.md)** · [missions design](../design/paseo-bm-missions.md) · [base design](../design/paseo-bm.md) §7.16 (outbox) · [autonomy design](../design/paseo-bm-autonomy.md) Part B |
| Lane | Designed: stored formats, agent-role behaviour (Main, Worker, Orchestrator), who decides a question, agent replacement, consumed contracts (deliveries, RPCs, chat cards) |

## Routing Decision

- Variant preset: brownfield (consolidation of a running system).
- Triggered risks: consumed contracts (deliveries to the Main, `mission.get`, `manager.ensure`), stored formats (additive fields), agent authority (who answers a question), role behaviour of the Main, agent replacement, a Missions screen section (needs an approved mockup).
- Required artifacts and gates: this ADR; the missions PRD amended (`prd-ready`); one design for the runtime (`design-ready`); a phased plan (`plan-ready-for-beads`); beads; an approved mockup before the Missions screen section is coded; `feature-done`.
- Execution path: plan → beads → implement, phase by phase; one verify per phase; releasing stays out of the plan.
- Exceptions: none.
- Decided: 2026-10-10 — hieu.nt10 (the five changes), Claude under the owner's delegation (technical choices, gates).
- Supersedes: none (this is the first decision of this programme).

## Context

The 2026-10-10 trace of mission XAI (backend `ai-assistant`, frontend `xspace-ai-assistant`) showed three owner-visible failures: the mission's work broke off, a handover lost its thread when the owner opened the Main from the management screen, and Workers asked again and again while the Main did not know. They share one cause, measured on the owner's machine:

- **Work state lived in an agent's conversation.** A mission's state is spread over about fifteen stores, labels, an in-memory notice queue and the Main's chat. The successor's brief read two of them; it said "Open requests: none" while a Worker had just been given XSPA's handed-over work, and the successor told the owner nothing was pending. `bm_tell_worker`, peer asks and replies wrote nothing to the mission; the roster changed only on a Worker's report; the Main asked the owner in prose, which no store keeps.
- **The Main was replaced, not maintained.** The handoff fired at 427,000 tokens read in one turn — four model calls over a real context of 110,000 tokens — because the trace knew no window and the only figure was the sum per turn. Compaction had been switched off by its guard on 2026-10-05, so a fresh agent was the only remedy. The XAI Main lived 65 minutes. An `Open Main` from the Missions screen during the successor's creation ran a second replacement (`mission.ensure` adopted the successor before `createMain` finished): two journal lines, the Workers told twice.
- **Questions had no single decider.** Since missions, the policy no longer answers delegated `q:` questions except a review budget's recommended option within its cap; the Main answers within ten minutes, but never an option with a grant. A review-budget option "until clean" carries a grant, so at Full auto every such question reached the owner, and the Main told the owner "only you can decide". Review budgets were asked five times per request.
- **Two missions owned one repo.** The migration made one-repo missions AIAS and XSPA; the owner then created XAI on the same repos. Nothing merges them; entry points choose the newest mission of a workspace; the governor arbitrated `CHANGELOG.md` between XAI and XSPA; closing XSPA was refused while an idle Worker of an unfinished request existed.
- **The plugin woke agents for bookkeeping.** 14 of the XAI Main's 20 turns (67 % of its tokens) were started by plugin notices: 11 report deliveries, 2 governor nudges for a Worker that was waiting by the owner's own plan, 1 peer delivery. Each Main replacement sent `BM-SETTINGS` to every Worker of the old Main, waking five idle Workers of XSPA.

These feed each other: notices grow the Main's context, the per-turn sum crosses early, the replacement loses state and sends more notices, the lost state makes questions land on the owner.

## Decision

1. **The mission is the system of record.** Every event that changes what is in flight is written by code where it happens: a Worker created or told more work, a report's phase, a question opened or answered, a Main's question to the owner, a peer or mission link asked, taken, answered or closed, a request moved between missions, a Main replaced. One read function, the **mission state** ("what is in flight, waiting on whom": requests and their real state, open questions with their decider, the Main's open asks, live links, the owner's recent exchange with the Main, the governor's raised families), is the only source for the Main's brief at creation, replacement and after compaction, for the governor's wake brief, and for the Missions screen. The journal is the mission's history; the stores keep their records; the mission state composes them.
2. **The Main is long-lived.** A Main's context is maintained in place: when its real context (the turn's `contextUsed`, against `contextMax` when Paseo reports it, else an absolute figure) reaches the owner's threshold, the plugin compacts it at an idle moment and sends the mission state as `BM-STATE`; the agent and the owner's chat stay. A new Main is created only when the provider cannot compact, compaction failed twice, or the context stays above the hard figure right after a compaction. One function changes a mission's Main, single-flight per mission and compare-and-set on the old Main; creating a Main never journals or re-points by itself. Replacing a Main sends nothing to Workers: their bindings and labels are re-pointed, and every delivery is resolved to the current Main when it is sent. A replaced Main's tools refuse and name the current Main.
3. **One authority resolver.** When a decision opens, one pure function names its decider: **code** (a precedent; a review budget within the code cap where the repo or mission delegates `cost`), **the Main role** (any class the repo or the mission level delegates, review grants included), **the Orchestrator** (an `f:` incident whose class is delegated to it), or **the owner** (everything else, `ownerOnly`, `o:`, `r:`, `h:` and prepared changes). The owner may answer any open decision at any time. The ten-minute window and the "a grant is the owner's" rule for the Main are retired. The decider is told at once: a question for the Main reaches it through its channel. The Main's own questions to the owner are stored decisions (`m:` questions) shown in the Inbox, never prose only.
4. **One owner per thing.** A request belongs to one mission; requests move between missions only through one transfer function (the split's primitive), on the owner's card. When an owner's mission holds a repo that a legacy one-repo mission holds, the plugin offers the owner a card to merge the legacy mission into it. A mission closes while Workers sit idle; only a running Worker blocks it. Entry points resolve the Main by request where they have one; by workspace they prefer the owner's mission over a legacy one, and the most recently active.
5. **A signal budget.** The plugin sends an agent a notice only when that agent has something to do, and says what. Everything addressed to a Main — report, message, peer, governor command, danger — goes through one channel: the items pending at its idle moment go as one message, each item a block the chat draws as its own card. Notices without an action are removed: the replacement notice to Workers, the review-budget notice to the Main. The governor counts a request waiting on another request of its mission, or stopped, as waiting, not stuck.

## Consequences

- A Main replacement — rare now — loses nothing: the successor's brief is the same mission state the owner sees.
- The owner's conversation with a mission stays in one chat for as long as compaction works.
- At Full auto the owner is asked only `ownerOnly` facts and what exceeds the delegation; review budgets within the cap are not questions.
- Fewer Main turns are started by the plugin; several items arriving together cost one turn.
- New stored data is additive: mission decisions gain a `question` kind, roster entries are set active on a follow-up, the journal gains lines for follow-ups, links and transfers, Coordination settings gain a `main` block. An older build ignores them.
- The Main's role file changes (ask with a tool, answer within delegation without a time window, the channel's blocks), so running Mains are outdated and replaced once, as for every role-file change.
- Mechanisms retired: the per-turn token sum as a Main trigger, the Main's ten-minute window, the grant rule for the Main, the second replacement path, `BM-SETTINGS` on replacement, `BM-BUDGET` to the Main, a separate `BM-SIGNAL` notice, the governor's own brief text.

## Alternatives considered

- **Patch each symptom** (raise the threshold, add the journal lines, allow review grants, add a Main history link). Rejected by the owner: each patch adds a mechanism and the cause — state in the conversation — remains.
- **Event-source every store into one log.** Cleanest model, but a rewrite of stores that work; the mission state as one read function over complete writes gives the same guarantee at a fraction of the change.
- **Keep handoff and add an outgoing note, as Workers have.** Still moves the owner's conversation to a new chat every hour; in-place compaction keeps it. The note is not needed when the brief is the complete mission state.
- **Let code answer every delegated question.** The Main holds the goal's context (ADR-029 decision 6); code takes only what settings decide.
