# paseo-bm 0.8.0

A mission runs as a supervised line of approved steps, one request at a time, and agents that rest, repositories that move and failed deliveries no longer stop work silently.

## What this version brings

### The supervised mission line

- A larger ask becomes an ordered list of steps that the owner approves once, on one card showing each step's acceptance criteria. A mission runs one sequential request at a time across its repositories. paseo-bm starts the next step itself when the previous one passes its finish gate, with no Main turn.
- The finish gate reads the whole continuation chain: the request finished with nothing left to continue, its review passed where its tier needs one, its named checks were detected or reused, and its commit exists. What cannot be read fails, and the line stops, telling the Main once per failure what it can do.
- New work while a step runs is held to run next (`next: true`) or after the requests it needs (`after`). A parallel lane needs the owner's explicit word, quoted. A Worker that answers the running request's own peer question runs beside it in its own lane, without the owner's word.
- With the owner's grant, given once per mission and repository on a card, a request that passed the gate moves the local integration branch forward, by fast-forward only. Pushing and merging on the forge stay the owner's.
- The mission page shows step n of m, what runs, and where the line is blocked. **Settings → Coordination → Supervised line** turns the line off for every mission.

### Reviews, checks and context

- A review covers the completed implementation once; later reviews cover only the new changes and the open blocking findings. Passing evidence is reused while the code it covers is unchanged, and a check named as reused is labelled `reused` when the request's records show it passing.
- A Medium or Large code change reports what was run for real and what it showed, or why it could not be run.
- The soft rollover default falls from 250k to 180k context tokens. A continuation inherits its predecessor's review batches that did not pass, and `BM-ROLLOVER now` is never deferred for a review.
- The governor no longer nudges for the mess and drift figures; they are still computed and shown.

### Agents, deliveries and repositories

- An agent that Paseo collects rests and is woken for what someone waits on. A delivery that reaches nobody raises a `delivery-dropped` alert and tells the request's Main once, and the request shows it.
- A plugin start no longer revives a dormant mission, and an outdated Main is handed over only while its mission has work.
- A repository keeps its identity when its root workspace is archived and its folder opened again: a proved alias keeps its key, its policy and its memory, also for later missions that name the new workspace.

### Agent roles

- **Manager (`manager.md`):** gives work through steps, `next`, `after` or the owner's quoted `parallel`; compares a Medium or Large `received` with the owner's words once; keeps only steps in the plan; makes a Worker by hand only when the owner asks.
- **Worker (`worker.md`):** restates goal and acceptance at a Medium or Large `received` outside a step; runs only checks covering changed behaviour and reuses valid evidence; reports runtime proof; ends a step with `forNextStep`.
- **Reviewer (`reviewer.md`):** reviews the full scope once, then only deltas and previous blocking findings; reuses passing Worker evidence; runs no automatic full suite.
- **Orchestrator (`orchestrator.md`):** asks the owner for stuck work, overengineering and budget from step 4; drift and mess figures become notes.

## What to know when upgrading

- No migration or new dependency is required. The step, gate, presence, alias and grant records are additive.
- The supervised line is on by default. While a request runs, new work is held, not refused for good; turn the line off in Settings to go back to creating Workers freely.
- Each mission's Main with older instructions is handed over at its first idle minute while the mission has work. Workers and Reviewers keep the instructions they started with.
- A stored `rollover.contextTokens` keeps its value. Local merge stays off until the owner grants it on a mission's card.
- paseo-bm no longer depends on paseo.cafe: install with `paseo plugin add npm:paseo-bm-plugin` and update with `paseo plugin update paseo-bm`. The published bundle has no size limit any more.

## Rollback

Use `paseo plugin update paseo-bm --version 0.7.0`. Branches, commits, workspaces and stored records remain. Version 0.7.0 knows neither the sequential slot nor the finish gate, so finish or cancel a live line (`bm_hold_cancel`) before downgrading. It ignores repo aliases, so a mission that relies on one may again refuse its repository. Returning to 0.8.0 reads the additive records again.

## Evidence

- Release verification covers type checks, lint, product tests, benchmarks, evaluation tooling and the generated package; the release workflow repeats these checks on Linux and macOS before trusted npm publication.
- Every step of the line passed plan and code review, and each field fix has a test that fails without it.
- On the owner's daemon, mission AIX created its backend Worker in lane 2 for the frontend's open question after the repo-alias and peer-answer fixes, where the previous build refused it. The full multi-step line has not yet been accepted live.

## Sources

[ADR-041](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-041-incremental-review-and-affected-checks.md) · [ADR-042](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-042-a-collected-agent-rests-and-a-failed-delivery-is-told.md) · [ADR-043](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-043-a-repository-outlives-its-root-workspace.md) · [ADR-044](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-044-a-restart-does-not-revive-dormant-missions.md) · [ADR-045](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) · [ADR-046](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-046-rollover-now-is-never-deferred-for-a-review.md) · [ADR-047](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) · [ADR-048](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/adr/ADR-048-no-dependency-on-paseo-cafe-and-no-bundle-size-limit.md) · [Delivery line design](https://github.com/hieunt286/paseo-bm/blob/v0.8.0/docs/design/paseo-bm-delivery-line.md)
