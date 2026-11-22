# paseo-bm 0.9.0

Finished Workers and Reviewers leave the agent list on their own, a rollover that waits too long is asked again, and a replaced Main always learns who holds its mission.

## What this version brings

### Finished agents are archived

- Once an hour, paseo-bm archives the Workers and Reviewers that are finished for good, with no agent turn. A request is finished for good when it and the newest request of its chain are finished, nothing still waits for its agent (a queued delivery, an open decision, an open or taken peer link), and nobody touched the agent for the owner's window.
- **Settings → Coordination → Archive finished agents** turns it off and sets the window: three days by default, from one to thirty.
- Mains, Orchestrators and agents with no request paseo-bm knows, such as your own, are never archived. Nothing is deleted: open an archived agent and send it a message to bring it back, its history kept.
- Each archive is written in its mission's journal. A pass that cannot read the settings, the stores or the bindings archives nothing.

### Rollover and replaced Mains

- A `BM-ROLLOVER soft` that waited 30 minutes without the request rolling over becomes `BM-ROLLOVER now`, as compaction and handoff already did at their ceiling. A later Worker of the request is asked `now` again.
- Every tool of a Main that another Main replaced now refuses with the name of the Main that holds the mission, reading tools included.
- The guard that would have kept a delegate from acting on a request that finished unverified is removed. It never applied, because nothing fed it. "Finished — unverified" still shows on reports, cards and figures.

### Fixes

- A `BM-DELIVERY-FAILED` notice to a Main is recognised as paseo-bm's own, so it is never read as the owner's words.

### Agent roles

- **Manager (`manager.md`):** rule 4 says that paseo-bm itself archives the Workers and Reviewers whose work finished for good, after the owner's window; any other archiving or deleting stays the owner's.
- **Worker, Reviewer and Orchestrator:** no instruction changes in this release.

## What to know when upgrading

- No migration or new dependency is required. The two new coordination settings, `cleanup.archive` and `cleanup.idleDays`, are additive.
- Archiving is on by default. Within an hour of the update, the first pass archives every Worker and Reviewer that already meets the rule, up to 25 an hour. Turn it off first in Settings if you want to keep them listed.
- Right after the update, a running request whose soft rollover notice is older than 30 minutes gets `now` at its Worker's next turn.
- The product documentation was reviewed against the code: designs, PRDs, ADRs and the guide describe the product as it runs now.

## Rollback

Use `paseo plugin update paseo-bm --version 0.8.0`. Agents this version archived stay archived: open one and send it a message to bring it back. Version 0.8.0 ignores the cleanup settings and archives nothing. Returning to 0.9.0 reads them again.

## Evidence

- Release verification covers type checks, lint, product tests, benchmarks, evaluation tooling and the generated package; the release workflow repeats these checks on Linux and macOS before trusted npm publication.
- Each rule of the archive pass, the rollover wait and the replaced-Main refusal has a test that fails without it; each change passed an independent code review.
- On an isolated Paseo daemon, an archived agent left the list with its history kept, reading its timeline kept it archived, a message brought it back, and its workspace was left as it was.

## Sources

[ADR-049](https://github.com/hieunt286/paseo-bm/blob/v0.9.0/docs/adr/ADR-049-finished-sub-agents-are-archived.md) · [ADR-050](https://github.com/hieunt286/paseo-bm/blob/v0.9.0/docs/adr/ADR-050-decisions-the-code-took-without-an-adr.md) · [ADR-051](https://github.com/hieunt286/paseo-bm/blob/v0.9.0/docs/adr/ADR-051-three-owner-decisions-from-the-documentation-review.md) · [Delivery line design](https://github.com/hieunt286/paseo-bm/blob/v0.9.0/docs/design/paseo-bm-delivery-line.md)
