# ADR-036 — No agent waits on machines: CI off, re-reviews of the fix diff by a fresh Reviewer, Workers capped by context

| Field | Value |
|---|---|
| Status | **Accepted** (2026-10-23) — the owner's three answers after a day of use: "turn CI off entirely", "a fresh Reviewer that checks only the diff", "a new Worker at about 250k context". Technical choices by Claude under the owner's delegation |
| Date | 2026-10-23 |
| Owner | hieu.nt10 |
| Supersedes | [ADR-035](ADR-035-a-delivery-line.md) decision 3's "the CI pipeline of the merge request is the check of record" (CI is not evidence); decision 4's re-review by the same Reviewer conversation (a fresh Reviewer with the fix diff); decision 1's size figures, which gain a context figure |
| Keeps | ADR-035's bounded requests, branch per mission, commits on the mission branch, the owner's one push-and-merge-request yes, the merge request on the forge, milestone review and its cap; ADR-005 (nothing archived by the plugin) |
| Related | **Design:** [delivery line design](../design/paseo-bm-delivery-line.md) §2.6, §4.5, §4.6, §5.2, §5.5, §17 · **PRD:** [missions PRD](../product/paseo-bm-missions-prd.md) REQ-209 (c), REQ-211 (d), M-38; [base PRD](../product/paseo-bm-prd.md) REQ-037 (b) |
| Lane | Designed: agent-role behaviour (Worker, Reviewer, Main), the evidence rule, the review contract, objects written into the repository's git store |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:**
  - role behaviour;
  - the evidence of "verified";
  - the review contract (`bm_rereview`);
  - git objects written in a repository (no ref, no index, no tree change).
- **Required artifacts and gates:**
  - this ADR;
  - the delivery line design amended in place, with §17 added (`design-ready`);
  - the PRDs amended;
  - manual beads under one epic (four independent outcomes, no plan needed);
  - `feature-done`.
- **Execution path:** manual beads, then implement in two waves, one verify per wave.
- **Exceptions:** none.
- **Decided:** 2026-10-23. hieu.nt10 decided the three answers; Claude made the technical choices.
- **Supersedes:** none.

## Context

The owner used the ADR-035 build for a day and said CI monitoring wasted time and tokens, and that re-reviews redid round one. A full read of the window found:
- 690 turns from the install (2026-10-21 01:40) to 2026-10-22;
- 33 review batches, holding 55 review calls;
- 24 requests.

**CI.**
- **Cost.** There were 93 `glab` calls (85 by Workers), costing about 16 million tokens and over an hour of waiting. One polling turn took 15 minutes and 13 million tokens, because each poll re-read a 508,000-token context.
- **Result.** 11 pipelines were watched, and none went green:
  - the backend failed five times on a Nexus 401 before any test ran;
  - the frontend `verify` job had never been green.

  Each cause was visible at its first failure.
- **The chain it set off.** The governor's `ciRed` figure counted infrastructure failures. A re-plan made "diagnose CI first" the mission's priority, and a 54-minute request diagnosed CI and fixed nothing.

**Re-reviews.**
- **Where the cost was.** The Reviewer kept to the fix: 0.33× the tool calls of a first review, and 21 of 22 re-reviews passed with no new finding. The cost was elsewhere:
  - **The base commit.** `since` was always the batch's base, so `git diff` showed the whole change. The fixes were uncommitted, so no commit marked the last review.
  - **The kept conversation.** Each re-review step re-read the Reviewer's ~125,000-token conversation, about 2/3 of a first review's tokens.
  - **The Worker's full suite.** The Worker re-ran the full suite before every re-review: 22 of 22 times, median 8.8 minutes.

**Context.**
- **Where the tokens went.** 72 % of Worker tokens (1.2 billion) were read in turns whose context was at least 400,000 tokens. One Worker reached 923,000.
- **Why nothing stopped it.** Compaction and handoff are off in the owner's settings, and rollover counts cumulative tokens, beads and turns, never the context size.

## Decision

1. **CI is not used.**
   - **Never evidence.** A merge request's pipeline is never evidence. "Verified" is a check paseo-bm detected in the request's own turns (`shared/evidence.ts`).
   - **Never waited on.**
     - The Worker never reads, waits for or polls CI.
     - The report's `ci` field is ignored.
     - The Main does not ask for CI.
     - The governor has no `ciRed` figure.
     - The screens show no CI.
   - **Kept:** the merge request is still opened and updated after the owner's one yes, and merging stays on the forge.
   - **The setting.** `integration.ci` (Coordination settings) holds this, default `off`. Turning it back on restores ADR-035 decision 3's reading of CI.
2. **A re-review checks the fix diff, with a fresh Reviewer.**
   - **Snapshots.** At every review call paseo-bm records a snapshot of the working tree as a git tree object. It writes the tree with a temporary index, as the checkpoint does: objects only, no ref, nothing of the owner's HEAD, index or files.
   - **What `bm_rereview` does.** It snapshots again and computes the diff between the two trees (the fixes). It then creates a **new** Reviewer, whose brief holds:
     - the previous result's blocking findings, verbatim;
     - the list of changed files;
     - the diff (inline up to a bound, else the command that shows it).
   - **What the new Reviewer does.** It checks each finding against that diff, and reports a new blocking finding only where the diff introduced it.
   - **Unchanged:** the call still counts against the cap. The old Reviewer is left idle.
   - **The Worker's checks.** Before a re-review the Worker runs only the checks that cover the files it fixed. The full suite runs once, before `finished`.
3. **A Worker rolls over by its real context.**
   - **The figure.** `rollover.contextTokens` (default 250,000) joins the size figures. It is read from the turn's `contextUsed`.
   - **Soft and hard.** At it, the Worker finishes the bead in progress and reports `finished` with `remaining`, and a fresh Worker continues. At `ceilingFactor` × it, the Worker finishes at once.
   - **Compaction** stays the owner's switch and is not changed.

## Consequences

- No agent turn is spent waiting on a pipeline. A repository whose CI is broken costs nothing.
- **Re-reviews:**
  - A re-review reads a small brief and the fix diff instead of a kept 125,000-token conversation plus the whole change.
  - Each fix cycle loses the full-suite run.
- **Worker turns** stay under about 500,000 tokens of context, and most stay under 250,000. Every step is cheaper and faster.
- **Git objects.** A repository's git store gains unreferenced tree objects, two per review call. `git gc` prunes them later, and the owner sees nothing.
- **Role files change** (Worker, Reviewer, Main). Running agents are outdated and replaced once.
- **Retired:**
  - the `ciRed` figure while CI is off;
  - the "verified only on CI success" reading;
  - the Worker's `glab ci status` step;
  - re-reviews in the first Reviewer's conversation.

## Alternatives considered

- **The plugin watches CI in the background.** It costs no tokens and raises only failures the mission caused. Not chosen by the owner: the target repositories' CI is broken for reasons outside the missions, so the signal would be noise for now. The `integration.ci` setting keeps the way back.
- **Keep the same Reviewer, send it only the diff.** This keeps round one's understanding, but every step re-reads about 125,000 tokens. The owner chose a fresh Reviewer.
- **Turn compaction back on for Workers.** The owner keeps it off. A fresh Worker from the report is a clean restart and loses nothing the stores hold.
