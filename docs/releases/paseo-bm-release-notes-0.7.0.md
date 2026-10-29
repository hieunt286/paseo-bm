# paseo-bm 0.7.0

Missions can run independent work in parallel lanes, keep their context bounded, and recover delegated provider failures through their Main without another owner confirmation.

## What this version brings

### Context and memory

- Memory has explicit mission and project scope. Briefs and summary reads leave closed missions' entries out while keeping those entries retrievable; superseded facts no longer compete with current ones.
- Briefs use bounded context, preserve owner decisions and active contracts, and carry the latest peer agreements. Mains read summaries before asking for detail.
- A Main is compacted when its context reaches either its configured token threshold or window share. Coordination exposes **Compact a Main at**, with a default of 150,000 context tokens, including when the general compaction switch is off.

### Parallel work and delivery

- Independent requests can start in a free or new worktree lane, up to seven live lanes per mission and repository. Finished lanes merge locally into the mission branch and become reusable; overlapping files and pending merges are reported to the Main.
- Dependent requests can wait in a stored queue until their prerequisites finish. The mission page shows lanes, overlaps and held requests, including cancellation.
- New lane allocation skips branch names occupied by unmanaged or unmerged draft work. It preserves those branches and tries the next available number.
- A new request cannot be sent into a busy Worker's current request. Corrections to that request may still be steered with the existing turn guards; independent work gets its own request and lane.
- Outdated Mains are handed over at an idle point after an instruction update. Their old conversations remain available; Workers and Reviewers finish their existing requests.
- A **Beads** composer pill opens the workspace's requests, beads and agents on hosts that support composer pills, restoring the mobile entry point in Paseo 0.12.

### Provider recovery

- A mission's current Main receives delegated Worker or Reviewer fallback incidents through its durable channel and can choose the configured recovery with `bm_answer_fallback`. It records the answer and follows the replacement without asking the owner to repeat an existing delegation.
- Recovery keeps the original request, brief and workspace, resolves the current Main after a handover, and prevents duplicate replacements. Pending notifications recover after a plugin reload.
- Detection recognises the weekly-limit response and refetches an empty ended-turn timeline. An unresolved fallback appears blocked on the mission page.
- Owner-only decisions and effectful permissions keep their existing authority. A Main's own fallback and incidents outside a mission request retain the Orchestrator/owner path.

### Agent roles

- **Manager (`manager.md`):** reads bounded summaries, triages independent and dependent work, identifies corrections to current work, and resolves delegated configured fallback through its own tool.
- **Worker (`worker.md`):** uses scoped memory and bounded handovers, follows the lane integration rules, and reports updates without repeating unchanged content.
- **Orchestrator (`orchestrator.md`):** leaves delegated mission-request fallback to that mission's Main; keeps its existing authority for other incidents.
- **Reviewer (`reviewer.md`):** no instruction changes in this release.

## What to know when upgrading

- No store migration or new dependency is required. Memory scope, lane and coordination fields are additive; held requests are stored separately from the roster.
- A Main with outdated instructions is handed over when idle. Existing Worker and Reviewer conversations keep the instructions they launched with.
- Changing a saved Worker profile applies to newly created Workers; it does not switch an existing agent's provider. This release preserves your configured providers, models, fallback chains and permission boundaries.
- `bm_memory read` and `bm_mission` return bounded summaries by default, with detail available explicitly. `bm_tell_worker` requires `about` for a live request: `current` for that request's work, `new` for independent work, which must get its own request.
- Lane merges remain local. Pushes, publication, deployment and owner-only actions still require their existing authority.

## Rollback

Use `paseo plugin update paseo-bm --version 0.6.0`. Existing branches, commits, workspaces and stored records remain. Version 0.6.0 ignores the new context and lane metadata, does not drain the held-request queue, and does not let a Main answer delegated fallback. Finish or explicitly coordinate active lane and held work before downgrading. Older role instructions may require manual replacement. Returning to 0.7.0 reads the additive records again.

## Evidence

- Release verification covers type checks, lint, product tests, benchmarks, evaluation tooling and the generated package; the release workflow repeats these checks on Linux and macOS before trusted npm publication.
- Regression coverage includes scoped memory, bounded briefs, lane creation/reuse/caps, preserved draft branches, held work, overlap signals, guarded steering, idle Main handovers and delegated fallback authority with duplicate/reload protection.
- Live AIX recovery confirmed a Main-authored fallback answer and a Codex replacement in the original backend workspace. A later frontend request launched directly in Codex in a safe new lane and completed; the draft branch was preserved. This is recovery evidence, not acceptance of every downstream application's live API journey.

## Sources

[ADR-037](https://github.com/hieunt286/paseo-bm/blob/v0.7.0/docs/adr/ADR-037-agents-are-given-a-bounded-context.md) · [ADR-038](https://github.com/hieunt286/paseo-bm/blob/v0.7.0/docs/adr/ADR-038-parallel-lanes-and-a-held-queue.md) · [ADR-039](https://github.com/hieunt286/paseo-bm/blob/v0.7.0/docs/adr/ADR-039-new-work-never-into-a-busy-worker.md) · [ADR-040](https://github.com/hieunt286/paseo-bm/blob/v0.7.0/docs/adr/ADR-040-the-main-resolves-its-requests-fallback.md) · [Delivery line design](https://github.com/hieunt286/paseo-bm/blob/v0.7.0/docs/design/paseo-bm-delivery-line.md)
