# paseo-bm 0.3.1

**Less process for small work, and a Manager that does more of what it can already see.** This release changes only how the three agents behave (their role instructions) and one rule of the Metric screen; the installer, the configuration, the data on disk and the `BM-*` block formats are unchanged.

**Installing this version:** `npx paseo-bm`, or pin it with `npx paseo-bm@0.3.1`. As in every release, `paseo-bm` and `paseo-bm-plugin` carry the same version.

## The Worker: process follows the risk of the change

- **A Small change has no bead and no Reviewer unless you ask for one.** The Worker makes the change, runs the check that proves it, and reports the command and its result. Medium work gets beads written by hand and one review of the implementation; Large work also gets a review of its documents and beads before it builds. The review budget per request is unchanged (2 / 2 / 4) and is a ceiling, not a target: a Small request spends it only on a review you ask for.
- **The sizes are defined by consequence.** Large means hard to undo, or changing what others consume — an interface, a format or stored data that other code or people use, or a recorded decision. How something looks, reads or works inside is not one of these, so a screen or wording change is no longer sized Large.
- **Documents follow the change.** The Worker writes a document only where the change overturns something recorded (a decision, a contract, a schema). A document that only describes what it changes is corrected in place as part of the change, without asking you. Deviating from an approved decision, or editing a document your repository freezes, still waits for your answer.
- **A `BM-ANSWERS` entry may now be a fact the Manager verified**, with its source. Anything in it that reads as a decision rather than a fact is asked again under a new question number, so a Manager's mistake cannot close one of your decisions.

## The Manager: answers what it can read, and keeps the Workers moving

- **Rule 1 is now "you change nothing".** The Manager never writes a file, touches a bead, or runs a build or test, but it may read. A question it can answer by reading — where a request or a Worker stands, what the beads say, what a file or function does, what git shows — it answers itself, naming what it read, without starting a Worker. Every change still goes to a Worker.
- **It coordinates the Workers inside what you already decided** ([ADR-011](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/adr/ADR-011-manager-coordinates-workers.md)):
  - it wakes a waiting Worker as soon as it sees what that Worker waits for (another Worker's report, an agent's status, `git`, `br`), sending the fact and where it read it;
  - it answers a Worker's purely factual question ("has A committed?") in the `BM-ANSWERS` block; scope, approach, trade-offs and anything you must do stay yours;
  - when two Workers would write the same files, beads or history, it holds one — never by delaying its creation — and wakes it when the first is done;
  - it tells you before that it will wake a Worker and on what, and after, in one line, what it saw and sent, so you can overturn it; when unsure, it asks you.

## Metric: the workflow-step table

A Small request's bead, review and close steps now show as **grey "not needed"** (`– step`) instead of amber "unknown" (`? step`). If a Small request did have a bead or a review, the step still shows as done.

## What to know when upgrading

- **Only agents created after the upgrade get the new instructions.** Paseo does not let a plugin change an agent that already exists, so a Manager or Worker opened earlier keeps working as it did. To get the new Manager in a workspace, archive its old Manager in Paseo and open Beads Manager again.
- **No configuration, data or protocol change.** `~/.paseo-bm/`, `install.json`, the trace store, the `bm-*` roles and their tools keep their shape; the `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS` and `BM-REVIEW` formats are unchanged; no error code or exit code changed.
- Your own additional role instructions (Setup → Agents) are kept and still come after the built-in ones.

## Rollback

`npx paseo-bm@0.3.0` installs the previous version; it runs on the same Paseo versions (0.8 and 0.9.2). Agents created after the rollback get the 0.3.0 instructions back.

## Evidence

`npm run verify` (typecheck, plugin typecheck, lint, tests, build) exited 0 on the tagged tree: **124 test files passing**, build successful. The role-content tests pin the new rules (Small without bead or review, documents corrected in place, the Manager answering reads and coordinating), and the workflow-step tests pin the Small skips.

## Sources

[ADR-011](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/adr/ADR-011-manager-coordinates-workers.md) · [PRD](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/product/paseo-bm-prd.md) (REQ-020, REQ-022, REQ-024, REQ-025, REQ-026, REQ-036, REQ-037) · [Worker instructions](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/plugin/roles/worker.md) · [Manager instructions](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/plugin/roles/manager.md) · [Dashboard PRD](https://github.com/hieunt286/paseo-bm/blob/v0.3.1/docs/product/paseo-bm-dashboard-prd.md) (REQ-045)
