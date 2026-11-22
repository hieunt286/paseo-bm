# ADR-045 — A mission runs as a supervised line of approved steps

| Field | Value |
|---|---|
| Status | Accepted; decision 10 amended by [ADR-046](ADR-046-rollover-now-is-never-deferred-for-a-review.md); decision 1 by [ADR-047](ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) |
| Date | 2026-11-10 |
| Owner | hieu.nt10 |
| Amends | [ADR-035](ADR-035-a-delivery-line.md) decision 1 ("Review batches never cross a request": a continuation now inherits the batches that did not pass) and decision 3 (a local fast-forward is added, merging on the forge stays the owner's; its Evidence clause no longer decides the gate, which reads local checks); [ADR-036](ADR-036-no-agent-waits-on-machines.md) the default of `rollover.contextTokens`; [ADR-038](ADR-038-parallel-lanes-and-a-held-queue.md) decisions 3 and 5; [ADR-039](ADR-039-new-work-never-into-a-busy-worker.md) decision 1's `lane: "new"` route; [ADR-041](ADR-041-incremental-review-and-affected-checks.md) decision 4's last sentence; [ADR-042](ADR-042-a-collected-agent-rests-and-a-failed-delivery-is-told.md) decisions 2, 5 and 6; [ADR-044](ADR-044-a-restart-does-not-revive-dormant-missions.md) decision 1 |
| Amended by | [ADR-046](ADR-046-rollover-now-is-never-deferred-for-a-review.md) (2026-11-10): decision 10's last sentence; `BM-ROLLOVER now` is never deferred for a review · [ADR-047](ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) (2026-11-11): decision 1, for a peer ask of the running request |
| Keeps | ADR-033's mission as the system of record; ADR-035's one push-and-merge-request yes; ADR-038's lanes, as the parallel path; ADR-039's `about` rule; ADR-041's incremental review; ADR-042's three presences; ADR-044 decision 3 |
| Sources | Owner's chat of 2026-11-10 (no requestId; the owner agreed the recommendations); mission AIX's record since 2026-11-03 |
| Plan | [Mission line](../plans/paseo-bm-mission-line.md) |
| Tracking | Beads labelled `feature:mission-line` |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** consumed tool and RPC contracts, stored formats (additively), agent-role behaviour, a new git write in the owner's repositories, an owner approval.
- **Required artifacts and gates:** this ADR, one plan with `plan-ready-for-beads`, beads, `feature-done` per phase.
- **Execution path:** plan, converter, then implementation bead by bead, with one verify per phase.
- **Exceptions:** no `prd-ready` or `design-ready` gate now: the owner's fourteen items are the requirements, and the PRD and designs are updated with the implementation, by each phase's closing bead. Owner's instruction, 2026-11-10.
- **Decided:** 2026-11-10 — hieu.nt10 agreed the recommendations; Claude made the technical choices.
- **Supersedes:** none.

## Context

Since 2026-11-03, mission AIX's owner sent 84 messages: 17 chased progress, 18 reported bugs found by running the product, 5 nagged for a commit or merge. 34 asks spawned 67 Workers, and 17 continuation Workers changed no file. 74% of the Workers' cached tokens are read at a context above 200k, and 27% re-read a fixed 57k baseline. Review is 13% of Medium and Large elapsed time and about 3% of tokens, with half its verdicts asking for changes, so review stays.

A mission runs message by message, and the Main, a model, does the job of a state machine: it decides what runs next, reads each result and starts the following work. Its plan text also carries facts that go stale: AIX's plan said "BM cannot create the BE Worker", which misled the next Main after the fix.

## Decision

Numbers follow the owner's list.

### Sequencing and proactivity

1. **Steps, and one sequential slot.** A larger ask becomes an ordered list of steps the owner approves once, on one owner card that shows each step's acceptance criteria. Each step fits one Worker session. A mission runs at most one sequential request at a time, across its repositories. Tools enforce this; the role only explains it. Work may follow a held entry as well as a request, and following a request means following the newest request of its continuation chain and its gate, at creation as at every pass. While a step runs, the owner's words about it go to it, a question is answered by reading, and new work is held and runs next: after the running step and before the rest of the line, so an owner's ask never starves. A parallel lane needs the owner's explicit word (for example "song song", "làm ngay"), quoted as its reason; an ordinary owner message is not that word.
2. **The gate.** The gate is read over the request's continuation chain. It passes when the newest request of the chain is `finished` with nothing left to continue; the chain's changes had their review passed where the tier needs one, with no inherited batch left without a pass; the checks named by the chain's newest report that names any are detected or reused, read from the full records of all its Workers; and the chain's newest reported commit is committed (and merged, where decision 4 is on). A request with no predecessor and no changed file passes; a continuation with none is judged on its chain. Whatever cannot be read fails: a request created on this build with no stored result fails, and the final result, a refused merge included, is stored before its roster entry turns finished. The gate reads local checks whether CI is on or off; with CI on, a red pipeline also fails it, and a green or pending one adds nothing, so nothing waits on a machine. The gate holds for every held entry, not only for steps. On a pass the next step starts with no Main turn. On anything else the line stops: a failed gate, a head with an open stall alert, an active head with no live Worker, a stopped request or a cancelled entry. A stall stop ends only when the head has new activity or has ended, not when its alert expires. A step that has started stays started: its stop is shown and told, and it clears through a continuation or a cancel, never a second Worker. The Main gets one notice per distinct failure, naming what it can do: a continuation that fixes it, or a release, only on the owner's word, with the reason journaled. On a line, the Main gets a turn for an exception or the last step.
3. **The result travels.** When a step starts, the previous step's commit, contract, summary and what it left go into its brief, read at that moment. The held entry keeps only what was written when it was held.
4. **Local merge.** With the owner's grant, once per mission and repository through an owner card, a request that passed the gate moves the local integration branch forward to its commit, by fast-forward only. Refused, by divergence or a conflict with uncommitted work, it changes nothing, stops and tells the Main. The grant is revocable. Push, tag and merging on the forge stay the owner's.
5. **What the page shows.** The mission page shows step n of m, what runs and where the line is blocked, with the parts that exist. The Main's turn at a stop or at the end is the owner's notification: no notification channel is added.

### Supervision and delegation

6. **Runtime proof.** A step carries what was run for real and what it showed, or why it could not be run. A code-changing Medium or Large `finished` without it is refused. "Could not run" is accepted and flagged, and no done criterion is met on it. The scope is what needs no login; no credential is read or stored for it.
7. **The goal is checked once.** Outside an approved step, a Medium or Large Worker restates the goal and the acceptance at `received`, and the Main compares them with the owner's words at that one point. A Small `received`, and a `received` inside an approved step, whose acceptance criteria the owner saw on the card, cost no Main turn.
8. **The plan holds only steps.** `mission.plan` lists steps. A fact belongs in memory or a contract. A plan written before this rule is shown as possibly stale.
9. **A quieter governor.** The governor no longer nudges for the `mess` and `drift` families; their figures are still computed and shown, and `stuck` keeps its ladder. A bound Main makes a Worker by hand only when the owner asks for one.

### Tokens across sessions

10. **Sessions stay small.** The soft rollover default falls from 250k to 180k context, so a session ends near 200k. A continuation inherits its predecessor's review batches that did not pass, so a re-review goes on rather than restarting. `BM-ROLLOVER now` waits for a running review's verdict, because `finished` is refused until the verdict arrives.
11. **The fixed baseline.** What the plugin contributes to a session's fixed context is measured first, then trimmed to what its measured share allows. What lies outside the plugin's reach is reported, not chased.
12. **Quiet checks.** Workers run checks in the quietest mode the tool offers, without pipes or redirections, so evidence detection still reads them.

### Debt from the recent changes

13. **Reused evidence.** A check the report names as reused, which the request's full records show passing earlier, whichever of its Workers ran it, is labelled `reused` and counts as verified. Without such a record it stays self-reported.
14. **One delivery rule.** At every delivery, the plugin asks whether the record needs a turn or is only a note. A message with no open work for a resting recipient becomes a settled note at any time, which replaces ADR-044's skip at start-up and leaves no record open forever. A record carrying the owner's decision or words is always open work: it is never a note, at a plugin start either; waking a dormant Main for it costs one turn, and ADR-044 decision 3 keeps that turn from making a successor or a workspace. Command copies and `beads-done` are notes. An open `delivery-dropped` alert gets exactly one notice. `undelivered` ranks below a question waiting for the owner.

### The switch

One owner setting beside the Coordination mechanisms turns the supervised line off, for every mission: held entries start on `finished` alone, the sequential slot refuses nothing, and reports are delivered normally. The gate is still recorded, and a local merge still needs its grant and a passed gate.

## Invariants

- Nothing is pushed, tagged or merged on a forge by the line.
- A step list and a local-merge grant take effect only on the owner's own answer on the card.
- The gate fails closed. No step starts without an approved list or a `bm_create_worker` the Main made.
- A local merge is a fast-forward or nothing.
- Stored additions are additive: an older reader ignores them, and an interrupted line resumes from its held entries.
- A role change is enforced where it matters by the tool: an outdated Main learns the rule from one refusal (ADR-039).

## Consequences and proof

- The owner approves a list once and hears at a stop or at the end; the Main is idle while a healthy line runs.
- Sequential work is slower than parallel lanes when steps are independent. The owner accepted this for control, and a parallel lane remains available on the owner's word.
- The gate can stop a healthy line: a second Worker dirtying a lane, or a repository with no placement. Each stop names its reason, and the switch above is the safety valve during acceptance.
- A governor that no longer nudges for `dropped` or an uncommitted tree leaves those to the alert, the page and the owner.
- An owner's stored settings file that already holds `rollover.contextTokens` keeps its value; the owner changes it in Settings.
- Rollback is reverting the source, the docs and the generated bundle together. A local merge already made stays in the owner's branch, which the owner can move back.

Code tests prove each rule, real-git tests prove the merge and its refusals, and the phase's closing bead runs the full verification. Behaviour on the owner's daemon is proved at the owner's acceptance after install. Release is the owner's decision after that.
