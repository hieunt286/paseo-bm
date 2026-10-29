# ADR-038 — Parallel lanes in a repository, owner's words steered into a running turn, and a held queue

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-25) — the owner's answers: "at most 7 independent pieces of work, as many Workers each as the work needs; the Main steps in when Workers mix up or edit each other's files", "steer into the turn", "the plugin holds and starts it"; mockup Q, R approved as is; "steer with guards" after the spike |
| Date | 2026-10-25 |
| Owner | hieu.nt10 |
| Supersedes | ADR-035 decision 2's one worktree per mission and repository as the only place a mission writes in that repository; the delivery line design §3.7 rule "one live Worker per placement"; `manager.md`'s "a follow-up goes to its request's Worker while it runs" as the default for new work |
| Keeps | ADR-035's mission branch, its one push-and-merge-request yes per mission and repository, the integration stage and the owner's archive of worktrees; ADR-036; ADR-037 |
| Related | **Design:** [delivery line design](../design/paseo-bm-delivery-line.md) §19 · **PRD:** [missions PRD](../product/paseo-bm-missions-prd.md) REQ-217, M-44 · **Mockup:** [mission-lanes.html](../design/mockups/mission-lanes.html) artboards Q, R · **Evidence:** [queue review](../archive/operations/paseo-bm-mission-queue-review-20261025.md) |
| Lane | Designed: a stored format (placements, roster), agent tools (`bm_create_worker`, `bm_tell_worker`), agent-role behaviour (Main, Worker), git writes in the owner's repositories (more worktrees and branches, a local fast-forward), a screen |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:**
  - stored formats, additively;
  - agent tools;
  - role behaviour;
  - new git writes in the owner's repositories;
  - a new use of Paseo's message delivery;
  - a screen.
- **Required artifacts and gates:**
  - this ADR;
  - the delivery line design with §19 added (`design-ready`);
  - the missions PRD amended (`prd-ready`);
  - the mockup approved by the owner;
  - the steer spike passed;
  - a plan with phases, since the work has a dependency graph;
  - `feature-done`.
- **Execution path:** plan, then beads, then implement by phase, with one verify per phase.
- **Exceptions:** none.
- **Decided:** 2026-10-25. hieu.nt10 decided the three answers; Claude made the technical choices.
- **Supersedes:** none.

## Context

The [queue review](../archive/operations/paseo-bm-mission-queue-review-20261025.md) of mission AIX found that the owner's new goals waited 54 to 127 minutes before a Worker saw them:
- **One writer per repository.** A mission has one worktree per repository, so its Workers there share a tree. The Main gave every new ask to the Worker already running: 52 messages in three hours, every one queued.
- **Long turns.** A queued message waits for the target's turn to end. The backend Worker ran one turn of 152 minutes.
- **No triage.** A compile error, a one-flag change and a question that reading answers waited behind an audit of both repositories.
- **No visibility.** The owner could not see what waited, nor for what.

Paseo 0.12 can steer a message into a running turn (`activeTurnBehavior: "steer"`), on the Claude and Codex providers. Its general send path replaces the turn when a steer is unavailable.

## Decision

1. **Lanes.**
   - A mission may work in up to `MAX_LANES` (7) lanes per repository at once. Lane 1 is today's placement on the mission branch. Lane n ≥ 2 is a Paseo worktree of its own, on the branch `m/<CODE>/<repo>-<n>`, made from the mission branch's head.
   - A lane holds one independent piece of work. It may have as many Workers as that work needs, sharing its tree as a placement's Workers do today. The Main splits them by files.
   - **Merging.** When a lane's request finishes, its Worker commits, merges the mission branch into the lane and resolves conflicts there. paseo-bm then moves the mission branch forward by a local fast-forward (`git merge --ff-only` in lane 1's worktree). Push and the merge request stay on the mission branch, under the one yes per mission and repository.
   - **Reuse.** A merged lane becomes free and is reused for the next piece of work, so no worktree or dependency clone is made twice. The owner still removes worktrees when the mission closes.
2. **Overlap is watched.** paseo-bm compares the files each live lane changes. When two lanes change the same file, or a fast-forward is refused because lane 1's uncommitted work touches the same files, the Main is told at once, and the mission page shows it. The Main steps in: one lane waits, takes the file over, or the work is re-split.
3. **Triage.** For each new ask the Main decides, by rule in `manager.md`:
   - **same work** → the running Worker;
   - **independent** → a new request in a free or new lane (`bm_create_worker` with `lane: "new"`), started now;
   - **answerable by reading** → the Main answers itself;
   - **dependent** → a held request (`after: [requestId]`).
4. **The owner's words are steered.**
   - A tell that carries the owner's words is sent into the Worker's running turn with `activeTurnBehavior: "steer"`. This covers a `bm_tell_worker` marked `now`, the owner's command, and a `/bm-worker-new` follow-up.
   - **The spike** (§19.9) showed the steer accepted without replacement on Claude and Codex. It also showed that Paseo replaces the turn when a provider refuses the steer: during its own compaction, for a slash command, or when the turn changed meanwhile. No public API steers without that fallback.
   - **The guards** (the owner's choice: "steer with guards"). paseo-bm steers only to a Claude or Codex agent in a foreground turn, with text that does not start with `/`. It compares the turn id before and after, and records and reports a replacement. Everything else waits for the turn's end, as every other message still does.
   - **Upstream.** A strict "steer-only" mode is requested from Paseo.
5. **The held queue.**
   - A held request is registered at once, with its topic and what it waits for, but no Worker.
   - When every request it waits for is finished or stopped, paseo-bm creates its Worker in a free lane, briefed as the Main asked.
   - A held request whose request was stopped tells the Main instead of starting.
   - The Main may cancel a held request.
6. **Visible.** The mission page shows each repository's lanes, an overlap warning, and a **Waiting** list: held requests with what they wait for and since when, and tells waiting for a turn's end or steered into it (mockup Q, R).

## Consequences

- Independent work in one repository starts at once instead of after the running turn. The target is under 5 minutes; the field figure was 54–127 minutes.
- **The owner's words reach a busy Worker within its turn.**
- **More git writes in the owner's repositories:** up to six more worktrees and branches per mission and repository, and a local fast-forward of the mission branch. No push without the owner's yes, and no history rewrite.
- **Parallel lanes can conflict.** Conflicts surface at a lane's merge, where its Worker resolves them, and earlier through the overlap signal to the Main.
- **More tokens per hour** while lanes run, against less waiting and shorter chains. The Worker budget (`charter.budget.workers`) still caps live Workers.
- **Stored data is additive:** a placement's `lane`, `mergedAt` and `freeSince`; a roster entry's `held` state and `after`; the outbox's steered marker.
- **Role files change** (Main, Worker), so running agents are outdated once.

## Alternatives considered

- **Several Workers in the one worktree.** This needs no new worktree, but independent work writes one tree: the collisions ADR-035 removed between missions would return inside a mission.
- **One merge request per lane.** This needs no local merge, but means more merge requests and more push yeses. Not chosen: the owner's yes stays one per mission and repository.
- **Interrupt the Worker for the owner's words.** This is immediate, but a turn replaced mid-step loses work, and a Worker reads it as a stop.
- **The Main keeps the dependent work in its plan.** This is free, but the work is invisible and depends on the Main remembering. The owner chose the plugin.
