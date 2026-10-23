# ADR-035 — A delivery line: bounded requests, a branch per mission, integration as a stage, limits that hold

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-20) — the owner's answers to the four questions of the 2026-10-20 field review: a worktree and branch per mission, commits on the mission branch with one push-and-MR yes per mission and repo, review by milestone that converges by itself, checkpoint the shared tree then branch. The owner asked for structural fixes of the general problems, not incident patches. Technical choices are Claude's, under the owner's delegation |
| Date | 2026-10-20 |
| Owner | hieu.nt10 |
| Supersedes | The parts below; each is named again at the decision that replaces it. **[ADR-027](ADR-027-agents-write-content-code-carries-it.md)** decision 10's budget figures and grants (the counter stays) — decision 4. **[ADR-029](ADR-029-missions-mains-and-a-process-governor.md)** decision 4's "the Worker's `cwd` … are those of the repo" — decision 2. **[ADR-033](ADR-033-the-mission-is-the-system-of-record.md)** decision 3's review budget within the code and Main caps — decision 4. **[ADR-034](ADR-034-each-mission-has-its-own-workspace.md)**'s silence on Workers, who still wrote the owner's checkout — decision 2. The missions PRD §3 line "no commits or pushes beyond the existing autonomy" — decision 3 |
| Keeps | [ADR-005](ADR-005-manager-as-agent.md) (the plugin never archives or stops an agent); [ADR-019](ADR-019-action-boundary-permission-events.md) (the action boundary); ADR-025's levels (the five levels are unchanged; only review leaves the `cost` class); [ADR-028](ADR-028-projects-ask-each-other-through-the-plugin.md) decision 8 ("nobody relays", now enforced by structure); ADR-029's missions, Mains, two autonomy layers and governor; [ADR-031](ADR-031-orchestrator-decisions-grant-no-effects.md); ADR-032; ADR-033 decisions 1, 2, 4, 5; ADR-034's Mission-List workspaces for Mains |
| Related | **Evidence:** [field review 2026-10-20](../archive/operations/paseo-bm-field-review-20261020.md). **PRD:** [missions PRD](../product/paseo-bm-missions-prd.md) REQ-209 → REQ-216 and M-36 → M-42; [base PRD](../product/paseo-bm-prd.md) REQ-037 and M-17. **Design:** [delivery line design](../design/paseo-bm-delivery-line.md). **Plan:** [delivery line plan](../archive/plans/paseo-bm-plan-delivery-line.md) (completed 2026-10-21) |
| Lane | Designed. It changes: git writes in the owner's repositories (worktrees, branches, commits, pushes); the action boundary's grants; consumed contracts (`bm_report`, `bm_tell_worker`, `bm_create_reviewer`, `bm_rereview`, peer and mission links); stored formats (all additive); and the behaviour of every role |

## Routing Decision

- **Variant preset:** brownfield. A running system is restructured after a field review.
- **Triggered risks:**
  - writes outside the install home, in the owner's repositories: worktrees, branches, commits and, with the owner's yes, pushes;
  - the action boundary and the grants that cover effects;
  - consumed contracts and stored formats;
  - the behaviour of every role;
  - two screen sections, the mission's line state and the request chains, which need an approved mockup first.
- **Required artifacts and gates:**
  - this ADR;
  - the missions PRD amended and base REQ-037 reworded (`prd-ready`);
  - one design for the line (`design-ready`), with the designs it amends edited in place;
  - a phased plan (`plan-ready-for-beads`), then beads;
  - one spike before decision 2's build;
  - an approved mockup before any screen change;
  - `feature-done`.
- **Execution path:** plan → beads → implement, one phase at a time, with one full verify per wave. Releasing stays out of the plan.
- **Exceptions:** none.
- **Decided:** 2026-10-20. hieu.nt10 decided the four answers; Claude, under the owner's delegation, made the technical choices and passes the gates.
- **Supersedes:** none. This is the programme's first decision.

## Context

The owner asked whether the flow runs to a software factory's standard. Read against a delivery line, it does not. The [field review of 2026-10-20](../archive/operations/paseo-bm-field-review-20261020.md) covers 2026-10-02 → 20, with the trace store, decisions, outbox, missions and both target repositories read in full. It found six general causes. Each one feeds the next.

1. **A request never ends.**
   - Four requests read 89 % of the tokens. Each had 232–643 turns and 53–99 beads.
   - 94.3 % of Worker tokens were read after a request's first `finished`.
   - Any later report reopens a finished request. `bm_tell_worker` sends more work to its Worker whatever the phase.
   - So every limit counted per request is meaningless: the review budget, the handoff and the loop guard.
2. **Three missions write one checkout and one branch.**
   - Nothing isolates writers, so the Mains negotiated hunk-by-hunk "writer" grants in prose.
   - Measured results: 404 Main↔Main messages in two days; 30 % of outbox records about hunks; 16 arbitrations.
   - 51 % of blocked hours were spent waiting on the other mission.
   - Commits mix missions.
3. **There is no integration stage.**
   - 90 % of requests since 10-15 finished unverified.
   - 233 BE and 319 FE entries are uncommitted, and 79 commits are unpushed.
   - The repositories' CI runs only on a merge request, so it never ran.
4. **Every delivery wakes the Worker.**
   - Turns that ended `blocked` read 47 % of the Worker's tokens. A blocked Worker was woken again after a median of about 0 minutes.
   - Compaction and handoff need a quiet queue. 15 of 19 compactions and 18 of 28 handoffs were dropped.
5. **Limits are layered and the party asked often cannot lift them.**
   - Review budgets: a delegated `untilClean` is converted into calls and never lifts the one-re-review rule.
   - The Main is named decider when it can only refuse.
   - A precedent on `review-budget` is saved, promised to auto-answer, and never applied.
   - 49 % of owner cards were not product decisions.
   - The governor's single command pool was spent on arbitrations and code nudges. Every later command became an owner card.
6. **Communication runs through the Main, in free text.**
   - 93 % of Main turns were started by the plugin. Mains relayed Worker reports to other Mains.
   - With no act or reference field, messages degraded into space-stripped shorthand.
   - The state brief carries no contracts, so a Worker acted on a stale agreement.

Patching each symptom would add a mechanism per incident, which the owner rejected for ADR-033 and again here. The common structure is a delivery line:

- a bounded unit of work;
- an isolated place to write;
- a stage that integrates and proves;
- limits counted on the right unit, enforced by the party that can act on them.

## Decision

1. **A request is a bounded unit.**
   - A request created through the plugin's tools ends at its `finished` (or `stopped`) report. A later report on it is refused and names its continuation.
   - More work for a finished request opens a **continuation**: a new request linked to it (`continuationOf`, `chainRootId`), with a new Worker briefed from the stores. This covers a follow-up, the next wave, or the owner's next ask in that area.
   - The plugin opens the continuation by itself when `bm_tell_worker` names a finished request.
   - A request also **rolls over** at a size boundary (closed beads, turns or tokens, in Coordination settings):
     - **soft:** the Worker finishes the bead in progress and reports `finished` with `remaining`, then the plugin opens the continuation;
     - **hard:** at twice the figure, it does so at the next turn end.
   - Review batches never cross a request.
   - Handoff stays the backstop for one oversized step.
2. **Each mission works on its own branch, in its own worktree of each repo.**
   - The plugin creates a Paseo worktree workspace per mission and repo of the charter. It branches off the repo's integration branch onto `m/<code>/<repo>`.
   - The mission's Workers and Reviewers work there. A mission Worker never writes the owner's checkout.
   - Policy follows the repository, not the placement. Every store keyed by a repo (levels, action boundary, memory, decisions, registry) is reached through one resolver from the placement to its repo.
   - Writers in different missions no longer share files. Their overlap surfaces as a merge conflict at integration (decision 3), not as a negotiation.
   - Removing a mission's worktree when the mission closes is the owner's action, on a card (ADR-005).
3. **Integration is a stage of the line.**
   - **Commits.** A Worker commits its request's changes on the mission branch at `finished` and at a rollover. This is a standing authority, because the branch is the mission's alone. `bm_report` carries the branch and the commit.
   - **Push and merge request.** Pushing a mission branch and opening its merge request into the integration branch takes the owner's yes **once per mission and repo**: a standing grant scoped to that branch, recorded and revocable. Later pushes of that branch and updates of its merge request are covered. Merging the merge request stays on the forge, done by the owner or the CI.
   - **Evidence.** The CI pipeline of the merge request is the check of record wherever the forge reports it. A local check the plugin detects is the fallback.
   - **Conflicts.** Before a push, a Worker updates the mission branch from the integration branch and resolves conflicts, as a step of its request.
   - **Visibility.** The mission state, the governor's figures and the Missions screen show each branch's state: uncommitted, ahead, merge request, CI.
   - **Migration of the shared tree.** New Workers stop going to the shared checkout. The owner confirms one checkpoint commit of the current state on a card. Each open mission then branches from that point. Running Workers finish where they are, and their successors start in the mission's worktree.
4. **Review happens at milestones and converges by itself.**
   - **Milestones.** A Large request's plan-and-beads batch, and one implementation batch per planned wave or at `finished`. No bead has a review of its own.
   - **Re-reviews.** A batch is re-reviewed without asking anyone while its blocking findings strictly decrease, up to `review.maxRereviews` (default 3). When it stops converging, the Worker goes on or finishes, with the open findings listed.
   - **The cap.** Each request has a cap computed by code: `review.callsPerBatch` × its milestone batches, bounded by tier. Past it, the plugin opens **one** owner-only decision per request.
   - **Retired:** the `review-budget` question, the code and Main review grants, `untilClean` and precedents on review.
   - **Re-review scope.** A re-review checks the previous findings against the diff since, not the whole change again.
5. **An agent is woken for what it waits for.**
   - A `blocked` report names what it waits on by id: questions, links, review batches, other requests.
   - While those are unsettled, deliveries that settle none of them are held in the outbox. When the wait is met, the agent receives one message with everything held.
   - Always delivered at once: the owner's words, stops, commands, safety settings, maintenance, and a tell marked `now`.
   - A Worker waiting by structure is neither stalled nor re-woken.
   - Compaction, handoff and rollover get a hard ceiling. Past a set multiple of their threshold, or half their window, each one runs at the next turn end, ahead of queued items.
6. **One decider who can decide, one card per question, and effects stated by what code did.**
   - **Deciders.** The resolver names a decider other than the owner only if one of the options it may choose settles the question.
   - **One card per question.** A Main's question that repeats a Worker's open question is refused, and the Main's recommendation is attached to that question instead.
   - **Precedents.** One registry of the subjects a precedent may answer is used by every place that saves or applies one.
   - **Effect sentences.** Every sentence a tool, card or notice gives about an effect comes from the function that applied it, never from intent.
7. **The governor spends by kind and measures causes.**
   - **Command pools.** Commands to a mission are counted in separate pools: code nudges, re-plans, arbitrations, others.
   - **Repeats are free.** A repeat arbitration of an area already decided, or a repeat re-plan, returns the standing one and spends nothing.
   - **A spent pool degrades.** Its figures go into a daily digest to the Main. The governor reaches the owner on a mission's process only at ladder step 4.
   - **Drift** counts only Main turns started by the owner or by a Worker report. It resets on a done criterion met with evidence.
   - **`stalled`** clears only on progress.
   - **Older governors.** An older Orchestrator agent is relabelled `retired` and retitled; it is never archived.
8. **Messages are typed, and the brief holds the agreements.**
   - **Typed messages.** Peer and mission messages carry an act (`ask`, `answer`, `agree`, `ack`, `close`, `supersede`) and references (contract versions, records, decisions).
   - **`ack` and `close`** start no turn.
   - **Contracts** gain a status and who agreed to which version.
   - **The state brief** after creation and after compaction carries the open contracts and each live link's latest message.
   - **Role files** ask for full sentences, with ids in references.
   - **Workers of two missions** still talk through their Mains (REQ-187 d). With decision 2 they rarely need to.

## Consequences

- **Per-request limits mean something again.** A request is about the size of its first `finished`: a median of 3.75 million tokens and at most 46 million in the field window, against 1.27 billion today.
- **Missions stop negotiating hunks.**
  - Arbitration becomes rare. It applies to an area two missions both change, and it shows up as a conflict when they merge.
  - The Mains' relay traffic, and the shorthand it produced, lose their cause.
- **Work reaches CI.** Every mission has a branch, its commits and, after one yes, a merge request whose pipeline is the evidence. "Finished" with changed files means committed.
- **The owner no longer answers review budgets.** At most one review question reaches the owner per request, and only past a cap computed from its milestones.
- **Owner cards about the governor's process come only from ladder step 4.**
- **Worker tokens drop in the largest class:**
  - turns ending `blocked`, because a waiting Worker is not woken;
  - turns after a first `finished`, because a continuation starts with a fresh context.
- **New stored data is additive.** An older build ignores it. The data added:
  - registry: chain fields, `waiting`, batch milestones and results;
  - outbox: a `held` state;
  - Coordination settings: rollover, maintenance, review and governor pool keys. The old `review.*Budget` keys are ignored.
  - mission: worktree placements and the standing push grant;
  - criteria: `metAt`;
  - contracts: status and agreements;
  - link messages: act and references;
  - trace records: a turn's `trigger`.
- **Every role file changes**, so running agents are outdated and are replaced once, as for every role-file change.
- **Retired mechanisms:**
  - the `review-budget` question and its grants, caps and precedent path;
  - `untilClean`;
  - the single governor pool;
  - a finished request reopening on a later report;
  - `bm_tell_worker` waking a Worker on a finished request;
  - hunk negotiation as a practice. The Mains invented it; no code implemented it.
- **Writes in the owner's repositories are new for the plugin.** It creates worktrees and branches. Agents commit on mission branches. Pushes happen only under the owner's per-mission yes. The owner's own checkout is no longer written by mission Workers.

## Alternatives considered

- **Patch each finding.** For example: stop converting `untilClean`, refuse the `review-budget` precedent, raise the budget cap, add hysteresis. Each is needed, and each is folded into a decision above. Alone, they leave the cause in place: unbounded requests on a shared tree, with no integration.
- **A writer lease per repository on the shared tree.** No disk cost. But it serialises missions and keeps the owner's checkout changing under them. The owner chose worktrees.
- **A worktree per request.** The strongest isolation, but an install and a cold build per request. A mission branch already gives one writer per branch. Within a mission, `writers-observed` still watches the placement.
- **A review pool per mission.** One owner touch per mission, but requests compete for the pool and repository-only work needs a default pool. The owner chose convergence per batch with a computed cap.
- **Let Workers of two missions talk directly.** That would weaken the chain of command (REQ-187 d) to cure a symptom of the shared tree. Decision 2 removes most of the need. This is reconsidered only if the field still shows Main relays after decision 2.
- **Let the Main's answer cover effects when the mission delegates `answer-effects`.** That widens a safety boundary and needs its own decision. Here the Main is simply not named as decider where its answer covers nothing (decision 6).
