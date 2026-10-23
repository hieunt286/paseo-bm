# paseo-bm 0.6.0

**A delivery line for missions.** Each mission now works on its own branch, in its own worktree of each repository, and its Workers commit there; pushing and opening the merge request takes your yes once per mission and repository. A request ends at its first `finished`, and more work continues in a fresh Worker. No agent waits on a CI pipeline any more, a re-review checks only the diff of the fixes, and a waiting Worker is woken only for what it waits on. You get fewer cards, and each says what was really done.

Update with:

```bash
paseo plugin update paseo-bm
```

## What changed

### A branch per mission

- **A worktree per mission and repository.** At a mission's first Worker in a repository, paseo-bm creates a Paseo worktree workspace on the branch `m/<CODE>/<repo>`, off the repository's upstream. The mission's Workers and Reviewers work there; a mission Worker no longer writes your own checkout. Dependencies are prepared by the repository's `paseo.json` `worktree.setup`, else `node_modules` is cloned from the root checkout in the background.
- **Commits on the mission branch.** A Worker commits its request's changes at `finished` and at a rollover, and its report carries the branch and the commit. A `finished` with changed files means committed.
- **One yes to push.** At a mission's first committed finish in a repository, one card asks to push its branch and open its merge request. "Yes" covers later pushes of that branch and updates of its merge request. **Revoke** and **Ask me again** are on the mission page. Merging stays on the forge.
- **Conflicts surface at integration.** Before a push the Worker updates the mission branch from the integration branch and resolves conflicts; beads are merged line by line. The governor warns of an expected merge conflict when two missions' branches change the same files, instead of missions negotiating hunks in one checkout.
- **The mission page** shows each repository's branch, ahead/behind, uncommitted files, merge request and "Push & MR allowed · Revoke". When a mission closes, one card lists its worktrees and offers to archive them; archiving is always your action.

### Bounded requests

- **A request ends at `finished`.** More work on a finished request opens a **continuation**: a new request linked to it, with a fresh Worker briefed from the stores. `bm_tell_worker` on a finished request opens it by itself.
- **Rollover by size.** A request also rolls over at a number of closed beads, turns, tokens, or a real context of 250,000 tokens (Settings → Coordination → Rollover). The Worker finishes the bead in progress and reports `finished` with what remains; at twice the figure it finishes at once.
- **The chain is visible** on the mission page ("continues …", "finished → …") and on Projects → Requests, with the chain's tokens.

### No agent waits on machines

- **CI is not used.** A merge request's pipeline is never evidence and never waited on: after a push the Worker reports and ends its turn. "Verified" means a check paseo-bm saw pass in the request's own turns. The governor has no CI figure and the screens show none. Settings → Coordination → **CI** turns the reading of pipelines back on.
- **Waits by structure.** A `blocked` report names what it waits on: questions, links, review batches, other requests. Until one of them settles, deliveries that settle none of them are held, then arrive as one message. Your own words, stops, commands, safety settings and a tell marked `now` are always delivered at once. A Worker waiting this way is neither reported as stalled nor woken again.
- **A maintenance ceiling.** Compaction, handoff and rollover run at the next turn end once far past their threshold, ahead of queued items.

### Review by milestone

- **Milestones, not beads.** A large request is reviewed at its plan-and-beads batch and once per planned wave or at `finished`. No bead has a review of its own.
- **Re-reviews check the fix diff, with a fresh Reviewer.** paseo-bm snapshots the working tree at every review call (git objects only: no ref, nothing of your HEAD, index or files) and gives a new Reviewer the previous blocking findings and the diff of the fixes. It reports a new blocking finding only where that diff introduced it. Before a re-review the Worker runs only the checks that cover the files it fixed; the full suite runs once, before `finished`.
- **Review converges by itself.** A batch is re-reviewed while its blocking findings strictly fall, up to `review.maxRereviews` (3). Each request has a cap computed from its milestones (`review.callsPerBatch`); past it, you get **one** question for that request. The review-budget question, its grants and precedents are gone.

### Fewer, clearer cards

- **One card per question.** A Main's question that repeats a Worker's open question is refused; its recommendation is attached to that card instead.
- **A decider who can decide.** paseo-bm names the Main or the Orchestrator as decider only when one of the options it may choose settles the question.
- **Effects stated by what was done.** Every sentence about an effect on a card, notice or tool result comes from the code that applied it. One list of subjects decides where a precedent may answer.

### The governor

- Its commands are counted in separate pools (code nudges, re-plans, arbitrations, others); a repeat arbitration or re-plan returns the standing one and costs nothing; a spent pool turns into a daily digest to the Main. It reaches you about a mission's process only at the last step of its ladder.
- **Drift** counts only Main turns started by you or by a Worker report, and resets on a done criterion met with evidence; **stalled** clears only on progress. An older Orchestrator agent is relabelled `retired`; it is never archived.

### Typed messages

- Messages between projects and between missions carry an act (`ask`, `answer`, `agree`, `ack`, `close`, `supersede`) and references; `ack` and `close` start no turn. Contracts gain a status and who agreed to which version, and the state brief after creation or compaction carries the open contracts and each live link's latest message.

### Screens

- **New mission** and the mission page's **+ Add** choose **Paseo projects**, named as Paseo's sidebar names them, with their folder underneath and a search past six projects, instead of workspaces whose titles were chat titles.
- **`/bm-worker-new`** shows where the request went in the Beads tab, with **Open Main**, instead of opening the Manager chat.

### Agent roles

- **Worker (`worker.md`)**: commits on the mission branch and reports the commit; updates the branch before a push; reviews by milestone and re-reviews while blocking findings fall; finishes on `BM-ROLLOVER`; carries on from a `continues:` brief; names what it waits on; never reads, waits for or polls a pipeline; runs targeted checks before a re-review and the full suite once before `finished`.
- **Reviewer (`reviewer.md`)**: the implementation scope, and a re-review that checks the previous findings against the fix diff only.
- **Manager (`manager.md`)**: more work on a finished request goes through `bm_tell_worker`; a waiting Worker is woken by paseo-bm; recommends on a Worker's open card instead of asking again; never asks for CI; typed messages and agreements.
- **Orchestrator (`orchestrator.md`)**: never asks about reviews; advises on the review settings; reaches you about a process only at ladder step 4.
- Running agents show as outdated; **Replace** gives each the new instructions.

## What to know when upgrading

- **The cut-over is automatic.** At the first start the plugin writes `~/.paseo-bm/missions/placement-mode.json`. From then on a mission's new Worker in a repository gets the mission's worktree; Workers already running in the shared checkout finish there.
- **The checkpoint card is yours.** For each repository that open missions share, a card offers **Checkpoint now** once no mission Worker runs a turn there. It makes the branch `bm/checkpoint-<date>` holding the checkout's current state, uncommitted files included, and leaves your HEAD, index and files untouched; the missions then branch from it. Push and merge that branch's own merge request first, so each mission's merge request shows only its own changes. Until you answer, the mission's Workers keep working in the root checkout.
- **Writes in your repositories are new.** paseo-bm creates worktrees and branches, and agents commit on mission branches. Pushes happen only after your yes for that mission and repository. Review snapshots add unreferenced tree objects to the repository's git store, which `git gc` prunes later.
- **`issue_prefix`.** Where a repository leaves `issue_prefix` commented out in `.beads/config.yaml`, `br` in a fresh worktree guesses the prefix from the first id; uncommenting it settles that.
- **Settings.** New Coordination keys start at their defaults: `integration.ci` (`off`), `rollover.*` (with `contextTokens` 250,000), `maintenance.ceilingFactor`, `review.maxRereviews`, `review.callsPerBatch` and the governor's pools. The old `review.*Budget` keys are ignored, and open review-budget cards are withdrawn.
- Every stored format is additive; nothing needs a migration.
- **Not yet:** choosing a mission's integration branch and the list of cloned folders on the mission page (the default is the root checkout's upstream and `node_modules`), and reading GitLab's merge-request mergeability.

## Rollback

Run `paseo plugin update paseo-bm --version 0.5.6`. Version 0.5.6 ignores placements, so new Workers go back to the shared checkout; the mission branches, their commits and the worktree workspaces stay where they are. Deliveries held for a waiting Worker stay held under 0.5.6, so tell that Worker yourself what it was waiting for. Returning to 0.6.0 finds everything as it was.

## Evidence

- The full repository suite passes on the release tree: 6,231 unit tests in 221 files, the benchmark and the 137 evaluation tests, the generated bundle under paseo.cafe's 2,000,000 bytes.
- A seeded scenario test drives bounded requests, held deliveries and wakes end to end; property and unit tests cover the placements and their resolver, the checkpoint, the integration grant and the action boundary, the review cap and convergence, the fix-diff re-review, the rollover figures and the typed messages. The screens were checked against their approved mockups.
- Paseo's worktree behaviour, the beads merge and the dependency clone were measured on an isolated daemon before the build. The build has run on the owner's daemon since 2026-10-21, and the CI and re-review changes since 2026-10-23; the GitHub release workflow verifies it on Linux and macOS before trusted publishing.
- The replay reports the delivery line's figures M-36 → M-42: request size, tokens in blocked turns, maintenance dropped, files written by two missions, unverified finishes, review questions and owner cards.

## Sources

[ADR-035](https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/adr/ADR-035-a-delivery-line.md) · [ADR-036](https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/adr/ADR-036-no-agent-waits-on-machines.md) · [Delivery line design](https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/design/paseo-bm-delivery-line.md) · [Missions PRD](https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/product/paseo-bm-missions-prd.md) · [Missions design](https://github.com/hieunt286/paseo-bm/blob/v0.6.0/docs/design/paseo-bm-missions.md)
