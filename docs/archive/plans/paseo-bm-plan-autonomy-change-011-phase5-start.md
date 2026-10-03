# Change Request — Phase 5 start: the link layer on the code as built, and an A-10 fixed before sampling

| Field | Value |
|---|---|
| Change ID | `autonomy-change-011` |
| Short name | Phase 5 start re-check |
| Original plans | [Phase 5](../../plans/paseo-bm-plan-autonomy-phase5.md) (Active); the combined field period of [change-006](paseo-bm-plan-autonomy-change-006-build-then-field.md) (bead `bm-autonomy-phase6-i8fc.6`) |
| Status | Applied — approved by Claude under the owner's delegation; plan, design and the bead edits of §4 (made through `br`, 2026-10-01; new bead `bm-autonomy-phase5-3e5v.6`) |
| Owner | hieu.nt10 |
| Created | 2026-10-01, bead `bm-autonomy-phase5-3e5v.1` |
| Accepted | 2026-10-01 — Claude under the owner's delegation. No PRD target, owner decision or phase outcome changes: C2 builds what REQ-150 already names, C4 and C8 settle how A-10 is counted before any sample exists |
| Applied | 2026-10-01 |

## 1. Change summary

The Phase 5 start re-checked design Part E, its §E.4 decisions (change-003) and the Phase 5 beads against:
- **Phase 4 as built**: `loga.3` and `loga.4` closed on their tests (`npm run verify` green), `loga.5` closed as not applicable. Its live check (`loga.6`) runs on an isolated daemon and is not recorded yet. Part E does not depend on it: Part E reads the `h:` decisions as built, not the Codex column of §D.2.
- **The code as built** after Phases 1–4 and the consolidation.
- **The field data available now** (§2).

The re-check found three gaps that would stop Part E from working as the PRD means it:
- **Precedents are not in the chain** (C2). REQ-150 names them, and Part E did not.
- **Commits would decide A-10** (C4). The plan counts a commit that names no bead as an incomplete chain. In the field most agent commits name none, and under the Worker's rule 1 most changes are never committed by an agent at all.
- **Nothing builds the A-10 audit** (C8). The exit bead is documentation only, yet it must sample and judge 30 chains read-only, with a definition fixed before the draw.

Four more points follow from the code as built:
- **The chain reuses the rebuild the product already has** (C1). The beads described deriving it again from lower-level readers.
- **Checks have four verdicts, not three** (C3).
- **Handoffs are edges between Workers** (C5).
- **The consumers' placement** (C6, C7), **the exit's references and "in use"** (C9), and **the module and test names** (C10).

Every other decision is confirmed (§3.2).

## 2. Compelling reason

**The field.** Read-only replay of 2026-09-30T18:47Z over the whole store, numbers only. The data folder's files had the same paths, sizes and times before and after.
- **63 requests (60 finished), 2026-09-16 → 2026-09-30; 2,074 turn records.**
  - The Phase 1 build holds 2 requests.
  - A later build from the tree holds 1 of them. It reports context on 13 of 13 turns and asked no question.
  - No request records a `bm.boundary` label: the Phase 4 build is not installed, so A-6 reads 63 requests `unknown` for the boundary and 0 held decisions.
- **The sources Part E reads all exist**, with the fields it needs:
  - *Reports:* of the 59 requests with a `finished` report, 57 name files and 54 name beads.
  - *Bead ids:* 2,245 bead ids are named in reports; 2,123 (94.6 %) are in their workspace's `.beads/issues.jsonl` today.
  - *`Split-from:`:* 91 beads across 6 of the 7 workspaces' bead stores carry it.
  - *Reviews:* 285 reviews in 170 batches, 27 with an unknown blocking count.
  - *Decisions:* the decision store holds 5 decisions, all `q:` of the Phase 1 build's request; 1 supersedes another.
- **Commits.** Agents ran `git commit` 100 times; 35 of those commits name a bead that exists in the workspace's store.
- **Records with no request.** 365 of 2,074 records (17.6 %) carry no request.
- **Figures for the exit's references** (§C9), as of this replay:
  - A-8: median 41.5 M tokens per finished request;
  - A-11: median 36.3 min over 59 requests;
  - A-7: 19 wakes, 8 with no action;
  - A-6: 131 effectful actions, 11 not shown authorised, and 363 scratch deletions reported apart.

**The code as built:**
- **The rebuilt trace already carries most of a chain.**
  - `request-trace.ts` `workspaceTracesOf` / `traceOfRequest` rebuild a request from the records and the live agent list (`traces.ts` `reconstructTraces`, which de-duplicates records).
  - `trace-timing.ts` `beadActionsOf` gives its beads from the reports (exact) and from `br` commands (inferred).
  - `trace-views.ts` `verificationOf` → `shared/evidence.ts` labels its checks and claimed files. A handoff successor proves again, and `traces.ts` `handoffSuccessorsOf` finds successors by label.
- **The git runner is already shared.** `repo-tool.ts` exports `runGit`, `GIT_READ_ONLY_PREFIX` and `GitRunner`, so bead `3e5v.2`'s "move it to a server module both import" is done.
- **Check verdicts.** `CHECKS_VERDICTS` has four values: `detected`, `self-reported`, `unverified` and `not-checked` (change-008 C5).
- **Decisions.**
  - Every decision kind carries a `requestId`, which is nullable for a project-wide `o:`.
  - Phase 4 added `h:` held decisions, and Phase 2 added `r:` overrides that `supersedes` the decision they correct.
  - A precedent answer names `answer.precedentId`, and a precedent's `supersededBy` names a decision.
- **Beads.** `beads-store.ts` `readBeads` keeps each bead's `description`, cached by mtime and size, so `Split-from:` is readable there.
- **The Orchestrator's tools.**
  - `REQUEST_SUMMARY_MAX_CHARS` is 4,000 and `REQUEST_MAX_CHARS` is 60,000 (§A.9).
  - `orchestrator.md` has 80 of its 100 lines.
  - `test/orchestrator-boundary.test.ts` fails when a tool of the Orchestrator's endpoint is not covered.
  - The first prompt's tool list lacks `bm_handoff`. The Orchestrator design's served-tools list lacks `bm_findings`, `bm_compact` and `bm_handoff`.
  - GUIDE.md names no Orchestrator tool.
- **RPC contracts.**
  - They live in `plugin/shared/contracts/<group>.ts`, re-exported by `shared/contracts.ts`, with handlers registered by `register<Group>Rpcs` in `index.server.ts` and failures coded through `rpc-kit.ts`.
  - `test/plugin-bundle-cjs.test.ts` and `test/rpc-list-describe.test.ts` pin the RPC names.
  - The error registry already has `E_TRACE_NOT_FOUND`, `E_BEAD_NOT_FOUND`, `E_DECISION_NOT_FOUND` and `E_DATA_HOME_UNAVAILABLE`.
- **Work.** `work-model.ts` already draws a request's timeline (`timelineEvents`) and its check and claim labels (`verification-view.ts`), and polls every 10 s (`WORK_POLL_MS`).
- **Orchestrator turns are not recorded** in the trace store (0 in the field). Its wakes' tokens are. A field `bm_why` call therefore cannot be read from the data folder.
- **Test projects.** `default` already spawns git (`orchestrator-tools`, `orchestrator-boundary`). The replay's tests run in `eval`.

## 3. What changes — Before / After

### 3.1 Changes

| # | Item | Before | After |
|---|---|---|---|
| C1 | What the chain is built on (§E.1; `3e5v.2`) | Built from the sources directly: `managerRequestId`, `requestIdOfAgent`, the report fields, `br` evidence. "Share the git runner with `bm_repo` (move it to a server module both import)" | **The request is the rebuilt trace**: `workspaceTracesOf` / `traceOfRequest`. That is the one rebuild the Dashboard, `bm_request` and the watchers read. <br>• *Beads:* `beadActionsOf`, keeping its confidence (exact, inferred, unknown). <br>• *Checks and claimed files:* `verificationOf`. <br>• *The runner:* `links.ts` imports it from `repo-tool.ts`; nothing moves. <br>• *The workspace folder* is resolved as for `bm_repo`: Paseo's list, else the store's `lastKnownDirectory`. <br>• *Without Paseo's agent list* (the audit, C8), the request is rebuilt from the store alone. A link that needs a label, such as a handoff successor, is then missing with that reason |
| C2 | Decisions and precedents in the chain (§E.1; REQ-150) | `q:<requestId>:<Qn>`, `o:` of the request, `f:` incidents; supersession from `supersedes`/`supersededBy`. Precedents not named | **Every decision whose `requestId` is the request's:** `q:`, `o:`, `f:`, **`h:`** (held, §D.2) and **`r:`** (overrides, §B.7). `supersedes`/`supersededBy` are kept as edges. <br>• *Precedents:* a decision answered `by: precedent` links to its precedent (`answer.precedentId`, `autonomy/precedents.json`), with the precedent's own `supersededBy` as an edge. <br>• *A project-wide `o:`* (null `requestId`) is in no request's chain. Its lookup returns the decision alone and says so. <br>• `precedents.json` joins the cache keys |
| C3 | Checks (§E.1) | "Phase 3's classification: detected / self-reported / unverified" | **Four verdicts** (`CHECKS_VERDICTS`): `detected`, `self-reported`, `unverified`, `not-checked`. A handoff successor proves again (§G.6), as `verificationOf` already applies |
| C4 | Changes, and what a commit counts for (§E.1, §E.4; plan §5; `3e5v.2`, `3e5v.5`) | Changes = the reports' `filesChanged` plus commits naming a bead. "Commits that name no bead … link through `filesChanged` and time … counted as incomplete chains" | **A change is linked by the request's own records:** <br>• the reports' `filesChanged`; <br>• the turns' edit/write `file` evidence, matched by the path relative to the workspace folder and labelled detected or self-reported (§C.2). <br>**Commits add to it; they are not a required link.** <br>• A commit whose message names a bead of the request links to that bead (exact). <br>• One that names none links by path and time, marked as such. <br>**A-10 counts a change incomplete only when its only link is a commit by time** (the file is in no report and no file evidence of the request). <br>*Why:* under rule 1 an agent commits only on the owner's yes. The field's agents made 100 commits and 35 name a stored bead. Requiring a commit would measure the owner's commit habit, not traceability |
| C5 | Turns and handoffs (§E.1) | "Turns — the records themselves" | The trace's records, keyed by agent and time (never `(agentId, turnId)`). <br>• *A handoff* is an edge from the outgoing Worker to its successor (`bm.handoffFrom`, `bm.replacedBy`). The successor's turns belong to the same request. <br>• *A record with no request* (17.6 % of the field's) is in no chain and is never attached on a guess (`traces.ts` rule 1) |
| C6 | `bm_why` (§E.2, §E.4; `3e5v.3`) | ≤ 4,000 characters by default. Handler "in `server/orchestrator-tools.ts`". GUIDE.md "where it lists the Orchestrator's tools". The Orchestrator design's tool table | **The bound is confirmed:** `REQUEST_SUMMARY_MAX_CHARS` (4,000), cutting the longest parts first with a one-line note. Like every §A.9 read tool, it also takes **`detail: "full"` up to `REQUEST_MAX_CHARS` (60,000)**. <br>**Placement:** a read tool registered in the registry `orchestrator-tools.ts`, pre-approved like the others. `test/orchestrator-boundary.test.ts` covers it (read-only, no send). <br>**Tool lists:** <br>• The first prompt names `bm_why`, and `bm_handoff`, which it lacks today. <br>• The Orchestrator design's served-tools list and tool table add `bm_why`, and the Phase 2–3 tools they lack (`bm_findings`, `bm_compact`, `bm_handoff`). <br>• GUIDE.md names no tool: its Orchestrator section says in one sentence that the Orchestrator can show why a bead, a file or a decision exists. <br>**orchestrator.md:** 80 of 100 lines, so the line fits |
| C7 | `links.why` and the Why? view (§E.2, §E.4; `3e5v.4`) | The contract "in `plugin/shared/contracts.ts`". Error codes open. The view's content not placed against Work as built | **Contract and handler:** `plugin/shared/contracts/links.ts`, re-exported by `shared/contracts.ts`. The handler is `server/links-rpc.ts` (`registerLinksRpcs`, through `rpc-kit.ts`), and the base design's RPC table (§7.12) lists it. `plugin-bundle-cjs` and `rpc-list-describe` pin the name. <br>**Errors, no new code:** <br>• an unknown request → `E_TRACE_NOT_FOUND`; <br>• an unknown decision → `E_DECISION_NOT_FOUND`; <br>• a bead not in the bead store → `E_BEAD_NOT_FOUND`; <br>• a bead or a file that no request names → an empty list of chains with the reason; <br>• the data folder → `E_DATA_HOME_UNAVAILABLE`. <br>**The view:** <br>• It reads **once when opened and on Refresh**, never on Work's 10 s poll. <br>• It reuses `verification-view.ts`'s labels for checks and claims. <br>• It shows the turns **per agent** (role, count, first → last) rather than a second timeline, because the request's timeline already lists its events. <br>• Ids appear only under Details |
| C8 | The A-10 audit (§E.3, §E.4; evaluation design §4; new bead `3e5v.6`) | `3e5v.5` writes the definition, samples and judges, "through `bm_why` or a read-only script". Nothing builds the script. The sample is "about 10 / 10 / 10" | **New bead `bm-autonomy-phase5-3e5v.6` (WP-505), after `3e5v.2`, before `3e5v.5`:** <br>• *The definition* goes into evaluation design §4 before any sample. <br>• *The sampler and judge:* the replay gains a read-only links audit (`scripts/eval/`, tests in the `eval` project; nothing under `plugin/` changes). <br>**The definition:** <br>• *An output* is a bead a finished request created, updated or closed (`beadActionsOf`), a file it changed (C4), or a decision carrying its `requestId`. <br>• *The draw:* seeded, with the seed recorded before the draw, from the finished requests of the window, 10 of each kind. A kind with fewer than 10 is filled from the others, and the counts per kind are reported (the field holds 5 decisions today). <br>• *The required links* are the PRD's six: request, decisions, beads, change, review, turns. A link that does not apply is complete when the chain says why: no question asked, a Small request's beads and review, a report saying `filesChanged: none`. A link that should exist but is not found is incomplete. <br>• *Commits* count as C4 says. <br>• *The check verdict* is shown but not required: A-10 measures traceability, not verification. <br>**Output:** numbers and link kinds only. <br>**Why not `bm_why`:** the owner's Orchestrator is the owner's agent, so the audit reads the data folder the way the replay does |
| C9 | The Phase 5 exit (`3e5v.5`) | A-8 and A-11 "against the Phase 4 figures". "Both consumers shown in use (an Orchestrator `bm_why` call in the field …)". No live check, although the plan's review asked for "a small live check" | **References:** under change-006 every exit is judged on the same window, so no separate "Phase 4 figures" exist. A-8 and A-11 compare with the **pre-install reference** that `i8fc.6` records at the install (as change-008 C7 set for Phase 3). Until then, this delta's figures (§2) stand as of 2026-09-30. <br>**The live check:** a small one on the isolated daemon (`scripts/manual-test/`), run on the frozen build. <br>• An Orchestrator asked why a bead exists calls `bm_why` with no permission prompt and answers from its chain. <br>• Work → Why? draws the same request's chain. <br>**"In use":** that live check, plus the owner's word that they used Why? and saw the Orchestrator use `bm_why` in the field. Orchestrator turns are not in the trace store, so a field call cannot be counted read-only. <br>**The audit** runs `3e5v.6`'s tool on the window |
| C10 | Bead text against the code as built | Pre-consolidation names | • `traces.ts` → `request-trace.ts`, `trace-timing.ts`, `trace-views.ts`. <br>• The directory readers: `paseo-directory.ts`. <br>• The git runner: `repo-tool.ts`. <br>• The registry: `orchestrator-tools.ts`, with the tools in `orchestrator-read-tools.ts` and the others. <br>• Contracts: `shared/contracts/*`. Metrics: `shared/eval-metrics/*`. <br>• Stores on `data-files.ts`; RPC handling through `rpc-kit.ts`. <br>• Paseo fakes: `test/helpers/fake-paseo.ts`. <br>• Test projects: `test/links.test.ts` in `default` (a temporary git repository, as `orchestrator-tools` already does) and the audit's tests in `eval`. <br>• Work's timeline in `work-model.ts`. <br>• orchestrator.md: 80 of 100 lines |

### 3.2 Confirmed without change

| Decision | Verdict and figure |
|---|---|
| No new persistent store; links derived and cached by mtime (§E.1) | **Confirmed.** Every source exists (§2). The cache keys add `precedents.json` (C2). Paseo's agent list is a live read, not a file |
| Decisions' `supersedes`/`supersededBy` | **Confirmed.** In the schema for every kind; 1 of the field's 5 decisions supersedes another |
| Reports' `filesChanged` and bead fields | **Confirmed.** 57 and 54 of 59 requests with a `finished` report; 94.6 % of reported bead ids resolve in their bead store |
| Reviews' verdicts | **Confirmed.** 285 own reviews in 170 batches (`ownReviewsOf`, §6.6 of the baseline) |
| `Split-from:` from `readBeads` | **Confirmed.** `description` is kept and cached by mtime and size; 91 field beads carry it |
| orchestrator.md's 100-line budget | **Confirmed.** 80 lines |
| §E.4 `bm_why` ≤ 4,000 characters | **Confirmed** (C6 adds `detail: "full"` as §A.9) |
| §E.4 `links.why` name and input | **Confirmed** (C7 places it) |
| §E.4 A-10: 30 outputs, about 10 / 10 / 10, stated absence complete, missing incomplete, fixed before sampling | **Confirmed**, completed by C4 and C8 |
| REQ-152: two consumers | **Confirmed**: `bm_why` and Work → Why? |
| Phase 4 as built | **No conflict.** The boundary adds `h:` decisions to a request's chain (C2). It is off by default, so few field chains will hold one |
| The Phase 5 exit judged in the combined field period | **Unchanged** (change-006, `i8fc.6`) |

### 3.3 Considered and not changed

- **A persistent link index.** Rejected: §E.1 and REQ-150 derive links from the stores that exist, and the rebuild is already cached per source.
- **Requiring a commit for a complete change.** Rejected (C4): agents commit only on the owner's yes.
- **Counting the check verdict in A-10.** Not chosen: the PRD's chain has no check link. The verdict is shown, and Phase 3's own figures judge verification.
- **Attaching a record with no request by time.** Rejected: a confident wrong link is worse than an honest gap (`traces.ts` rule 1).
- **A counter of `bm_why` calls in the data folder to prove use.** Rejected: it would be a new persistent store for one exit figure. The live check and the owner's word show use (C9).
- **`bm_why` for the Manager or the Worker, and Why? outside Work.** Out of scope, as the beads already say.
- **Editing the Phase 6 beads.** Not here. `3e5v.6` is eval tooling and adds nothing to the frozen `plugin/` build, so the Phase 6 start (`i8fc.2`) need not wait for it. That start re-checks whether `i8fc.6`'s pre-install reference should name A-11 beside A-8.

## 4. Impact

### Affected beads (edits made through `br` on 2026-10-01)

| Bead | Action |
|---|---|
| `bm-autonomy-phase5-3e5v` (epic) | Scope names the audit tooling; the success criteria name the live check and "in use" (C8, C9) |
| `bm-autonomy-phase5-3e5v.2` | C1–C5, C10: built on the rebuilt trace, `beadActionsOf`, `verificationOf`; the runner imported from `repo-tool.ts`; every decision kind and precedents; four check verdicts; changes from reports and file evidence, commits optional; handoff edges; tests updated |
| `bm-autonomy-phase5-3e5v.3` | C6, C10: `detail: "full"`; the boundary test; the first prompt's list with `bm_handoff`; the Orchestrator design's lists; GUIDE.md's sentence |
| `bm-autonomy-phase5-3e5v.4` | C7, C10: the contract module, handler, registration, error codes, pinned name lists; read on open and Refresh; `verification-view.ts` labels; turns per agent |
| `bm-autonomy-phase5-3e5v.5` | C8, C9: runs `3e5v.6`'s audit (the definition already written), the pre-install references, the live check, "in use"; depends on `3e5v.6` |
| New `bm-autonomy-phase5-3e5v.6` (WP-505) | C8: the A-10 definition in evaluation design §4 and the read-only links audit in the replay; depends on `3e5v.2`, blocks `3e5v.5` |

No bead is closed or split. `3e5v.1` stays open for its own close.

### Other affected artifacts

- [x] Design Part E marked Active and rewritten from this delta (§E.1–§E.4); Revision History.
- [x] Plan Phase 5: WP-505, §5 risks, Revision History. Status stays Active.
- [x] docs/README.md: this delta listed.
- [ ] Evaluation design §4 A-10: written by `3e5v.6` before any sample.
- [ ] Orchestrator design, GUIDE.md, base design §7.12: by `3e5v.3` and `3e5v.4`.
- [ ] PRD: unchanged. REQ-150–152 and A-10's target stand.
- [ ] ADR: none.

### Risk delta

- **C4 makes A-10 easier to meet than the plan's wording.** It stays honest: a change still needs the request's own record of it. A commit by time alone is incomplete.
- **C8 fills a short kind from the others,** which weights the sample towards beads and files while decisions are few. The counts per kind are reported beside A-10.
- **Without these changes:**
  - A-10 would likely fall below 90 % on commits alone;
  - REQ-150's precedents would have no link;
  - the audit would have no tool;
  - the exit's "in use" could not be shown read-only.

## 5. Out of scope for this delta

Any code; PRD targets; the Phase 6 beads; the programme's one release.

## 6. Approval

- [x] Approved-by: Claude under the owner's delegation (hieu.nt10), 2026-10-01.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Claude (owner's delegation) | Created at the Phase 5 start (bead `bm-autonomy-phase5-3e5v.1`); applied to the plan, the design and the beads of §4 |
