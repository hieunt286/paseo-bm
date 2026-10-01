# Specialist admission — candidate spec (template)

A new agent role, or a new model for a role, enters paseo-bm only on evidence (autonomy design §F.2; PRD REQ-160, REQ-162). Copy this page once per candidate and fill every section: **no evidence, no candidate**. The candidate enters as a change-delta of the Phase 6 plan, and only when the owner accepts the evidence in §5.

| Field | Value |
|---|---|
| Candidate | *one of: security reviewer · independent tester · read-only scout · design committee of two model families · per-Worker worktrees · a cheaper model for a role — or a new one* |
| Written by / on | *name, date* |
| Status | Draft · Evidence gathered · Decided |

## 1. The error class it catches

*One sentence: the mistake the current roles make, or the cost they carry, that this candidate removes. Take the class from the table below. A class that is not there is written here **first**, before any query is built for it; if no replay or suite figure can measure it, write "not measured" and stop — the candidate is not admitted on it.*

## 2. The evidence that the class is missed today

*Numbers only (never message text, paths or bead titles). Give the command exactly as run, so anyone can run it again:*

- *Field:* `npm run -s eval:replay -- --since <ISO> --until <ISO> --json` — the class's row of `admission.classes` (and `admission.verification` / `admission.workerReading` in full when the class uses them), over *n* finished requests.
- *Suite (when the class needs it):* `npm run eval:suite -- --version tree [--role-model <role>=<baseProvider>/<model>]` — the scorecard's A-9 and the metrics it names; for a model, both runs of each scenario.
- *The comparison:* what the figure would read if the class were caught (the target), and the reference it is set against (the pre-install reference of the combined field period, or the suite's run without the candidate).

## 3. Its token budget

*Tokens per finished request the candidate may add (or, for a cheaper model, must save), from A-8 by role, and the cap it runs under. A candidate aimed at the Worker's context names the Worker figure it lowers (PRD A-8).*

## 4. Its evaluation scenario

*The suite scenario that shows the class caught (an existing S1–S8, or a new `scripts/eval/scenarios/<id>.json` specified here: fixture, requests, what it expects). It runs twice, like every scenario (evaluation design §6.4).*

## 5. Decision record

| Field | Value |
|---|---|
| Decision | Admitted · Not admitted · Deferred until *…* |
| Date | |
| Decided by | *the owner (or Claude under the owner's recorded delegation)* |
| Evidence cited | *§2's commands and figures, the window and the scorecard* |
| Change-delta | *link, when admitted* |
| Reason | *one or two sentences* |

## The error classes and their queries

Each class a candidate claims, and the replay figure that measures it (`eval-metrics/admission.ts`, the replay's `admission` section). A figure that is unknown reads `null` / "unknown", never 0.

| Class | Candidate | Missed today when | Figures (`admission.classes[…].figures`) |
|---|---|---|---|
| `unverified-finish` | independent tester | finished requests changed code without their named checks detected | `changedCode`, `finishedUnverified`, `share` (of those whose checks could be judged), `detected` / `selfReported` / `unverified`, `changedCodeNotChecked` |
| `worker-exploration` | read-only scout | the Worker spends its context reading before its first change | `requests`, `workerTokensRead`, `beforeFirstWrite`, `share` (a lower bound: the writing turn is not counted), `medianBeforeFirstWrite`, `workerShareOfTokens`, `requestsWithoutUsage` |
| `concurrent-writes` | per-Worker worktrees | two agents write one file in overlapping turns (`writers-observed`, §F.1) | `pairs`, `files`, `unknownPairs` |
| `blocking-at-review` | design committee of two model families | Medium and Large work reaches review with blocking findings; the owner reverses decisions | `mediumBatches`, `mediumBlockingPerBatch`, `largeBatches`, `largeBlockingPerBatch`, `ownerDecisions`, `ownerReversed`, `ownerReversalRate` |
| `security-effect` | security reviewer | effectful actions run without the owner's authorisation; calls the action boundary would hold as security (A-6) | `effectful`, `notShownAuthorised`, `estimateCalls`, `estimateSecurity` |
| `security-flaw-after-review` | security reviewer | a security flaw passes review | **not measured**: a review carries counts, not the kind of finding, and the replay reads no text |
| `role-cost` | a cheaper model for a role | a role's tokens per finished request (A-8); quality is the suite's A-9 under `--role-model` (REQ-162: no quality loss) | `managerPerFinishedRequest`, `workerPerFinishedRequest`, `reviewerPerFinishedRequest`, `orchestratorPerFinishedRequest`, `medianPerFinishedRequest`, `finishedRequestsWithMissingUsage` |
