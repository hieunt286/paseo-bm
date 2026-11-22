# paseo-bm — The delivery line: technical design

| Field | Value |
|---|---|
| Status | **Active** (2026-10-20). `design-ready`: PASS, by Claude under the owner's delegation |
| Decision | [ADR-035](../adr/ADR-035-a-delivery-line.md) |
| PRD | [Missions PRD](../product/paseo-bm-missions-prd.md) REQ-209 → REQ-215, M-36 → M-42; [base PRD](../product/paseo-bm-prd.md) REQ-037, M-17 |
| Evidence | [Field review 2026-10-20](../archive/operations/paseo-bm-field-review-20261020.md) |
| Amends | [Base design](paseo-bm.md) §7.7, §7.17.8, §16.8 · [mission runtime design](paseo-bm-mission-runtime.md) §2, §4.1, §4.3, §4.5, §5.4, §6 · [missions design](paseo-bm-missions.md) §2.1, §9.2 → §9.6 · [orchestrator design](paseo-bm-orchestrator.md) §6A · [autonomy design](paseo-bm-autonomy.md) §D.2, §D.4, §F.1 — each in place, pointing here |
| Plan | [Delivery line plan](../archive/plans/paseo-bm-plan-delivery-line.md) (completed 2026-10-21) |

Code cites this document as "delivery line design §N". Its section numbers never change.

## 1. Principles

1. **One unit, bounded.** A request is the unit every limit counts. It ends, and more work starts a new one (§2).
2. **One writer per branch.** A mission writes on its own branch, in its own worktree. Overlap between missions becomes a merge, not a conversation (§3).
3. **Integration is a stage.** Committed, pushed and checked are states the plugin reads. They are not claims (§4).
4. **A limit is enforced by the party that can act on it.** Code bounds what code can bound: review rounds, the cap, command pools. A question reaches a decider only if that decider can settle it (§5, §7, §8).
5. **Wake for a reason.** An agent is woken only when it has something to do. What it waits for is named by id (§6).
6. **Effects are stated by what was done.** No sentence promises an effect that code did not apply (§7.3).
7. **Additive formats.** Every stored change is optional and new. An older build ignores it, and nothing is migrated in place (§11).

Terms:
- **Repo:** the owner's checkout, a root workspace. Its id is the **repo key**.
- **Placement:** the workspace a request's agents run in. For a mission, that is the mission's worktree of the repo.
- **Integration branch** (`target`): the branch a mission's merge requests go into.

## 2. Bounded requests (REQ-209, ADR-035 decision 1)

### 2.1 Before the delivery line

Retired by ADR-035 decision 1: a request used to reopen at every follow-up, so it never ended. The evidence is the [field review](../archive/operations/paseo-bm-field-review-20261020.md).

### 2.2 Data (additive, registry `v` stays 1)

These optional fields go on a request entry (`requestSchema`):

```ts
continuationOf?: RequestId   // the request this one continues
chainRootId?:    RequestId   // the first of the chain; absent = itself
continuedBy?:    RequestId   // set on the predecessor
rollover?: { reason: "follow-up" | "size"; figure: string; at: string }
waiting?:  Waiting | null    // §6.2
```

A roster entry gains `continuationOf?`. A continuation is a new entry of the same mission.

### 2.3 A finished request is final

- A **bound** request — one created through the plugin's tools, the registry's `source: "tool"` (`isBoundRequest`) — is final at `finished` and at `stopped`:
  - `noteReport` never clears `finishedAt`, and the roster never reopens it (`noteRosterReport`, `noteFollowUp`);
  - a later `bm_report` after `finished` is refused (`finishedRequestRefusal`): "Request X is finished; its work goes on as Y. Nothing was stored or sent.", or "Request X is finished; ask your Main. Nothing was stored or sent." when nothing continues it.
- The hand-written path of unbound agents keeps the old reopening. The plugin cannot redirect it.

### 2.4 Continuations

One function opens a continuation: `openContinuation(home, prev, init, deps)` in `server/continuation.ts`, where `init` holds `reason`, `text`, `figure` and the `managerId` the new Worker reports to. It goes through the creation path of `bm_create_worker` (`create-worker.ts` `createRequestWorker`: `generate` → `workerBriefOf` → `createPluginWorker` → registry and roster `add` → a journal `worker` line), into the predecessor's placement, and refuses, creating nothing, where `bm_create_worker` would.

1. **The Main tells a finished request more.** `bm_tell_worker` on a finished or stopped bound request opens a continuation with that text, whatever its `about` says (§19.12), with the figure "a follow-up after finished" (or "…stopped"). It returns `{ requestId, continuationOf, workerId, delivery, opened: "follow-up" }`.
2. **Size rollover (§2.6).** A `finished` that carries `remaining`, after the plugin asked for a rollover, opens a continuation with reason `size`.
3. **Always a new Worker.** A bound Worker's `bm.requestId` label and binding are the authority for its tools, its action boundary, fallback and answer delivery, so a live agent is never re-bound.
4. **Staffing.** The staffing rule (§3.7) is unchanged. The predecessor's request is finished, so it no longer counts.
5. **Order of writes.** `continuedBy` is written on the predecessor only after the new Worker exists, and `noteContinuedBy` stores `rollover` there too. The journal line reads "Worker `<id>` for request `<B>` in `<ws>` (continues `<A>`): `<topic>`".

### 2.5 The continuation's brief

`workerBriefOf` gains a block after the Main's line. It is built from the stores (`continuation.ts`, with the handoff brief's `workerHandoverFacts`), masked, and cut at the handoff brief's size (`HANDOFF_BRIEF_MAX_CHARS`). The block holds:

- `continues: <prev> (<reason>: <figure>)` and `chain: root <id>, request <n>`;
- what the predecessor last reported, and when;
- from its final report: `tier`, `beadsClosed`, `beadsReady`, `reviewFindingsOpen`, `decided`, `suggestions`, `buildAndTests`, and `remaining` (for a size rollover);
- the batches it inherits (§2.6): `open review batches: b1 (changes-required, 2 blocking): use bm_rereview`, and `review batches with a verdict on its way: …: it comes to you`;
- `features:` — the `feature:<slug>` labels of the beads that final report names (closed, ready or created);
- the chain's open questions ("their answers come to you") and its live links.

The rest is a Worker's usual brief: the placement (§3.4), the mission lines and the project memory (§18.2).

### 2.6 Size rollover

Coordination settings (`shared/coordination.ts`):

| Key | Default | Bounds |
|---|---|---|
| `rollover.enabled` | true | — |
| `rollover.beads` (closed in the request) | 15 | 3–100 |
| `rollover.turns` (recorded Worker turns) | 40 | 10–500 |
| `rollover.tokens` (read) | 50,000,000 | 10M–1G |
| `rollover.contextTokens` (§17.3) | 180,000 | 100,000–900,000 |
| `rollover.ceilingFactor` | 2 | 1.5–5 |

- **Soft.** At a Worker's recorded turn end (the hook the handoff uses), once a figure is reached, the plugin queues `BM-ROLLOVER soft` once per request: "Finish the bead in progress, review as your tier says, and report `finished` with `remaining`; paseo-bm opens the continuation." It is not sent to a Worker waiting by structure (§6.2); it is asked again later.
- **Hard.** At `ceilingFactor` × any figure, or once the soft notice has waited `MAINTENANCE_WAIT_MS.rollover` (30 minutes) without the request rolling over (not finished, no continuation; the time ceiling of §6.6, ADR-051 decision 2), it queues `BM-ROLLOVER now`, once: "Report `finished` with `remaining` at the end of this turn; put the work in progress in `remaining`." This is delivered at once (§6.4) and never waits for a review: under it, a `finished` with `remaining` is accepted while a review has no verdict delivered (`batchesAwaitingVerdict`). It belongs to the request's current Worker: `rolloverAsked.workerId` names who heard it, a later Worker of the request is asked again in the same words whatever its own figures (a context figure is measured per turn), and a Worker whose handoff has asked for its note is not asked.
- **Asked.** The registry records `rolloverAsked { level, figure, at, workerId? }`, and a `finished` with `remaining` is a size finish only when it is set. Figures read "16 beads closed", "41 turns", "100M tokens read" or "context 192k"; a `now` of the time ceiling reads the soft figure and the wait, "41 turns, then 30 minutes without rolling over". `remaining` is accepted only on a bound `finished`, at most 30 items.
- **The continuation's request** is the chain root's request, read from its first Worker's brief, followed by "Remaining:" and the list. When those words cannot be read it says "The request of `<root>`; paseo-bm could not read its words."
- **What carries over:**
  - A continuation inherits its predecessor's review batches that did not pass (`openBatchesOf`, `server/continuation.ts`; amends ADR-035 decision 1), so its Worker goes on with `bm_rereview` (§5.2). A batch is copied when its newest real verdict is no pass and a result answers its newest call, with its `results`, `calls`, `brief` and Reviewers; `adoptedFrom` names the predecessor and each call is marked `adopted`. A passed batch, one with no verdict, one from an older build with no `results`, and one whose verdict is still in flight stay behind, except that a finish at `BM-ROLLOVER now` also carries each batch still awaiting its verdict, its newest call marked `awaited`. That verdict's record keeps naming the predecessor: `noteReviewResult` stores it on every copy down the chain, and `verdictTargetOf` delivers it to the chain head's Worker.
  - `finished` with a verdict in flight is still refused, as today, for a call of the request's own and for an `awaited` one, except a `finished` with `remaining` at `now`: any other inherited call waits for nothing. Open findings become `remaining` items.
  - At the soft figure, the Worker settles its open questions and links before it finishes.
  - At the hard figure they move instead:
    - a `size` finish skips expiring its questions and closing its links;
    - decision delivery and peer links resolve a request to its chain head (`chainHeadOf`);
    - `peer-links` gains `moveRequest`.
- **A size finish settles no waits.** They settle when the chain's head ends ("req-A finished as req-B", §6.3).
- **Handoff stays the backstop** for one oversized step. Its `handoff.requestTokens` default of 150M sits above the hard rollover ceiling of 100M.

### 2.7 The chain everywhere

- **The Main.** The `finished` delivery gains `continued: <new> by Worker <id> (<reason>: <figure>)`. It is added at delivery time, after any no-turn notes (§9.1), and is not stored. No new notice.
- **Mission state.** A request carries `continuationOf`, `continuedBy` and `chainPosition` (mission state, `traces.list`). A finished request with `continuedBy` reads "finished → `<id>`".
- **One resolver for chains.** `chainHeadOf(home, requestId, hint?)` and `chainOf` live in `server/waits.ts`. `soleWorkerOfRequest` (`decision-delivery.ts`) resolves the chain head first, so decision delivery, the Ask's asker, overrides, the review-budget sweep, peer askers and answerers, and `bm_tell_worker` reach the chain's live Worker; the held queue (§19.6) and the archive pass (§20) read the head too. The action boundary keeps the Worker's binding as its authority. `bm_link_workers` takes only a request with a live Worker, so a continued request is refused.
- **Governor.**
  - `stalled` leaves out a request with `continuedBy`.
  - Figures per request count a chain's members separately, while `finishedSinceCriterion` counts a chain once.
- **Screens** (mockups `mission-runtime.html` G, H and `delivery-line.html` K, §12).
  - Missions › In flight shows "continues `<id>`" on a request that nothing continues yet, and "nth of its chain" from the third.
  - Projects › Requests is a list of cards: the chain line sits under the card title, and the chain's tokens join the cost line when the earlier requests are on the loaded page. "hide the chain" shows when the chain is open.

### 2.8 As built (Phase 7, 2026-10-21)

Folded into §2.3–§2.7 on 2026-11-16.

## 3. A branch per mission (REQ-210, ADR-035 decision 2)

### 3.1 Identity: the repo key and the placement

- Request-level mechanics follow the **placement**:
  - bindings, the registry (`requests/<placement>.json`), the roster entry's `workspaceId`, the outbox, traces, `writers-watch`, decisions and `h:` grants.
  - Paseo reports an agent's workspace as the placement, and request ids are unique across workspaces, so these need no change.
- Owner-level settings follow the **repo key**:
  - policy cells, levels and the action boundary;
  - precedents, project memory and charter membership;
  - contracts and peer links.

There is one resolver, `server/placements.ts`, memoised on the mission index file's stamp:

- `repoKeyOf(home, workspaceId) → string`: the repo key of a placement (any lane) or an alias, else the id itself; synchronous.
- `placementOf(home, missionId, repo) → Placement | null`: the newest lane-1 record of the repo, in any state. `placementOfWorkspace` and `placementBlockOf` sit beside it.
- `inCharter(home, mission, workspaceId)`: true when a charter repo has the workspace's repo key.
- `effectivePolicy(home)`: the stored policy plus a read-only alias from each placement to its repo's cells.

The resolver is fed by `missions/index.json` `placements: { [placementId]: { missionId, repo } }`, rebuilt with the index.

Readers that change (each passes its workspace id through `repoKeyOf`):

| Reader | Change |
|---|---|
| Precedent resolution (`precedent-resolve.ts`; `precedents.ts` `activeFor`) | by repo key |
| Policy, levels, challenger, boundary | `effectivePolicy` serves every reader that decides who answers or what is covered: `action-boundary.ts` `decide`, `boundary-off.ts`, the Worker watch's event scope, `authority-facts`, `command-authority`, `decision-override`, `orchestrator-decide-tools` and the findings. `role-instructions.ts` `creationProjectOf` and the `BM-SETTINGS` boundary line read the stored policy under the repo key. Settings keeps `currentPolicy`, so a placement never shows as a project. Prepared changes check and write by repo key |
| `creationProjectOf` | returns `{ workspaceId, repoKey, boundary }` |
| Memory (`memory-store.ts` file, `memory-tools.ts` checks, the brief) | by repo key |
| Charter membership (`missionRepoOf`, `outsideCharterOf`, the governor's `outsideCharter`, `memory-tools`) | `inCharter`. Without it, every placement request reads as outside its mission |
| Contracts' `providerRepo` / `consumerRepos`, peer links `to.workspaceId`, `bm_mission_update` repos, `bm_ask_project` | normalised to the repo key where they are written and compared |
| The Main's `bm_repo` | reads the mission's placement of the repo (its own branch); the Orchestrator's keeps the root |
| `missionOfWorkspace` | an exact placement match returns its mission, so a Manager opened in a worktree never starts a legacy mission |
| Work launcher, `classifyWorkspaces`, `bm_projects` | a placement is folded into its repo, never listed as a project; its requests name their `workspaceId` |

**A repo outlives its root workspace (ADR-043).** Archiving the root and opening the folder again gives a new workspace id; the repo key does not change.

- `Mission.repoAliases` (additive, optional) maps a live root workspace to the repo key. The index keeps them in their own `repoAliases` map, so `repoKeyOf` and `effectivePolicy` read through them and a reader of `placements` never takes a root for a placement. In the effective policy an alias reads exactly as its repo (`policyWithAliases`), never with cells of its own.
- `withLiveRoots` (`repo-aliases.ts`) runs in `bm_create_worker`. For a charter repo whose root is gone and that has a placement, it looks for a live root, no worktree or directory workspace, at exactly the folder and project a placement recorded in its `requestBody`, whose git holds one of the mission's branches of the repo.
- Workspaces of one folder are aliased together. Two recorded folders with the proof are ambiguous, and neither is taken.
- The proved root then answers under the old key for that call. A repo with no proved root refuses with what the owner can do.
- A charter repo is matched by its key ([ADR-047](../adr/ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) decision 1): `inCharter` compares keys and `charterKeysOf` counts repos by key. A live charter workspace that is another key's alias adds that key to the charter, so a later mission on the live workspace is staffed under the key; `repos.remove` removes every id of the key.
- Peer links store the key and Paseo is addressed at `liveRootOf`; `bm_peers` lists one project per repo by it.

### 3.2 The record (additive, on the mission)

The schema is `placementSchema` (`server/mission-store.ts`):

```ts
placements?: Array<{
  repo: string;                    // repo key
  workspaceId: string | null;      // the Paseo worktree workspace
  directory: string | null;
  branch: string;                  // m/<code>/<repo-slug>
  target: string;                  // the integration branch, e.g. "develop"
  base: string;                    // what it branched from: origin/<target>, or a checkpoint (§4.8)
  worktreeSlug: string;            // m-<code>-<repo-slug>
  state: "creating" | "ready" | "failed" | "retired" | "archived";
  requestKey: string;              // the fixed creation requestId
  createdAt: string;
  deps: { cloned: string[]; at: string | null; note: string | null };
  integration: IntegrationGrant | null;   // §4.3
  localMerge?: LocalMergeGrant;           // §4.3
  requestBody?: string;            // the exact create body (§3.3)
  note?: string;                   // why it failed
  archiveCard?: string;            // the owner's archive card (§3.6)
  lane?: number; mergedAt?: string | null; freeSince?: string | null;            // §19.1, §19.2
  mergePending?: { since: string; triedAt: string; reason: string; files: string[] };   // §19.2
  overlapTold?: Record<string, string[]>; overlapToldAt?: Record<string, string>;      // §19.3
}>
```

### 3.3 Creation

- **When.**
  - A placement is created lazily (`ensurePlacement`), at the first `bm_create_worker` for a repo of the mission that has no `ready` placement, never when the mission starts.
  - From the cut-over (§4.8), no mission request is created in a repo's root.
- **Names.** The branch is `m/<CODE>/<slug>`, where the slug is the root folder's name in lower case. The worktree slug is `m-<code>-<slug>`, or `m-<code>-<tail>-<slug>` when the branch name was taken. Later records of a repo use the request ids `bm-place-<mission>-<repo>-2`, `-3`, and so on.
- **The integration branch.**
  - Default: the root checkout's upstream, read with read-only git: `git rev-parse --abbrev-ref @{upstream}`, then the remote prefix is removed. The base is that upstream exactly as git reports it.
  - If that fails, it is `git symbolic-ref refs/remotes/origin/HEAD`. If that also fails, the creation is refused with "set the integration branch on the mission page" (`INTEGRATION_BRANCH_REFUSAL`).
  - It shows on the mission page; setting it there is not built. The integration card (§4.3) names it, so the owner's yes confirms it.
- **The call:**

  ```ts
  paseo.workspaces.create({
    requestId: `bm-place-${missionId}-${repoKey}`,
    title: `${code} · ${repoName}`,
    source: { kind: "worktree", cwd: rootDirectory, projectId: root.projectId,
              action: "branch-off", baseBranch: base, branchName: branch, worktreeSlug } })
  ```

  Paseo runs `git worktree add -b <branch> --no-track <base>` under `~/.paseo/worktrees/`.
- **Idempotence.** What Paseo does ([spikes record](../archive/operations/paseo-bm-delivery-line-spikes-20261020.md), S1):
  - Paseo de-duplicates only a byte-identical body under the same `requestId`. The same `requestId` with any other change returns `workspace_request_key_conflict`.
  - A taken branch name is not suffixed: Paseo silently uses the slug as the branch, and only folders get `-N`.
  - A branch that exists only on origin is not detected.

  So:
  1. Write `state: "creating"` with the fixed `requestKey` and the exact body (`requestBody`) before the call. A retry resends that body.
  2. Before the call, check `refs/heads/<branch>` and `refs/remotes/origin/<branch>` with read-only git. If either exists and is not ours, the branch becomes `m/<code>-<missionId tail 4>/<slug>`.
  3. After the call, the create response's `gitRuntime.currentBranch` (always filled) must equal `branch`, and its `projectId` must be the root's. Otherwise the placement is `failed` and the owner gets one line.
  4. On a reload, a `creating` placement is adopted from `workspaces.list` (same folder, or `project.checkout.currentBranch`), or retried with the same `requestId` and body.
  5. If the branch is recorded but its workspace was archived, it is re-created with `action: "checkout"`, `refName` the branch, and a new `requestId`. The archived one's `requestId` answers `directory_not_found`. A retry after an archive or a failure appends a new record.
  6. The title is part of the body. A rename later uses `setTitle`, never a new create.
- **Agents.**
  - `bm_create_worker` resolves `project` (a repo key) to the placement and creates the Worker there.
  - The Reviewer of a placement's request is created in the same placement.
  - A handoff successor uses the request's placement, as today.

### 3.4 What agents are told

- **The Worker brief** gains these lines:
  - `worktree: <dir> on branch m/ABC/fe (integration: develop)`;
  - `commit: on this branch at finished and rollover`;
  - `push and merge request: allowed since <time>`, or `ask the owner (paseo-bm does, at your first finished)`;
  - `dependencies:` "being prepared", "the repository's own setup (paseo.json worktree.setup) prepares them", "cloned from the root (node_modules)", or "not prepared — installing them is a dependency install" (§3.5).
- **Runtime facts** gain `Integration: <branch> → <target>; commit: yes; push/MR: yes|no`. A `BM-SETTINGS` notice refreshes it when the grant changes.
- **`bm_mission`** shows each repo's placement: folder, branch, target, state.

### 3.5 Dependencies in a fresh worktree

These facts about Paseo were read in the daemon (0.8.0):
- `paseo.json` `worktree.setup` runs in the background after a worktree workspace is created through the API. There is no trust gate for branch-off; there is one only for fork checkouts.
- A failed setup leaves the workspace in place.
- The plugin cannot read the setup status: it is not on `PaseoApi`.

The plugin's rules:

1. **The repository's own setup wins.** The setup Paseo runs comes from the base's committed `paseo.json`, else from the root's working-tree file, which Paseo copies in. If either has `worktree.setup` (`git show <base>:paseo.json`, then the root's file), the plugin does nothing more and never writes that file.
2. **Otherwise the plugin clones.**
   - Right after creation, the plugin's server makes a copy-on-write clone (`cp -c -R`, APFS) of each path on the repo's list. The default list (`DEPENDENCY_PATHS`) is `node_modules`, plus `.nx/cache` when present; editing it on the mission page is not built.
   - It clones only when the dependency manifest at the base equals the root's: `git show <base>:<lockfile>` hashed against `<root>/<lockfile>`, for `yarn.lock`, `package-lock.json` and `pnpm-lock.yaml`.
   - This is part of creating the placement, not a Worker step. It is local, with no network and no package manager, so it is not a dependency install under Worker rule 1.
   - The result goes in `placement.deps` and the journal. The brief says `dependencies: being prepared` until it ends.
3. **Fallback.** No plain copy and no symlink. A symlink would let an install write the owner's checkout.
   - The cases: the clone fails (another volume, clone unsupported) or the manifests differ.
   - The brief then says `dependencies: not prepared — installing them is a dependency install`.
   - The Worker asks, or the repo's `dependency` class covers it.
4. **Gradle and similar tools** keep their caches in the user's home. Nothing is cloned for them.

### 3.6 Lifecycle

- **A repo leaves the charter.** Its placement is `retired`: no new agents, history kept. The owner gets an archive card.
- **The mission closes.** Every placement is `retired`. One owner card lists each with its uncommitted, unpushed and merge-request state.
- **The archive card** is an owner-only `m:` decision, subject `worktree-archive`, class `data`:
  - with uncommitted changes: a "Commit first" (recommended), b "Archive it as it is", c "Keep it";
  - with a clean tree: a "Archive it in Paseo" (recommended), b "Keep it".
- **Archiving is the owner's, never the plugin's.**
  - Paseo's archive archives every agent of the workspace, which ADR-005 forbids the plugin.
  - It also runs `git worktree remove --force`, which drops uncommitted changes.
  - `on("workspace.archived")` sets the placement to `archived`.
- **Reconciliation** with `workspaces.list` runs at the first handle, then at most every 10 minutes; the owner's `mission.change` opens archive cards and retitles placements at once. An archived placement refuses new agents for its own requests (`placementBlockOf`), and the next `bm_create_worker` re-creates it from the branch (§3.3 step 5).

### 3.7 Within a placement

- **Staffing** (`create-worker.ts` `staffingReasons`): without `staffing` delegated, one live Worker per repository, counted across its lanes; a new lane adds a live Worker, and needs `staffing` delegated unless the owner's word (`parallel`, §19.6) or a release covers it. Independent work takes a lane of its own (§19.1), up to 7 per repository. The mission's `charter.budget.workers` caps its live Workers in all.
- **`writers-observed`** keeps watching inside a placement.
- **Cross-mission writer collisions** cannot happen: each mission writes on its own branch. Their governor source is retired.

### 3.8 As built (Phase 8, 2026-10-21)

Folded into §3.1–§3.6 and §4.8 on 2026-11-16.

## 4. Integration (REQ-211, ADR-035 decision 3)

### 4.1 Commit authority on the mission branch

Worker rule 1 (`worker.md`): in a mission's worktree (an `Integration:` line in the Runtime facts), the Worker commits its request's changes on the mission branch at `finished` and at a rollover, and pushes that branch and creates or updates its merge request only when that line says `push/MR: yes` (paseo-bm asks the owner itself). Merging, force-pushing, rewriting pushed history, deleting a branch and committing anywhere else stay the owner's.

`manager.md` tells the Main that a lane's Workers share its tree: when another Worker writes the same files, one fact names it in the brief. Another mission's work is on its own branch.

### 4.2 What the action boundary classifies

`BoundaryContext` gains `mission?: { directory, branch, target, remote: "origin" }`. It is built from the request's placement in `action-boundary.ts` `decide` and in the Worker watch. `classifyCommand` (`shared/effectful-actions.ts`) adds these rows:

| Command | Finding |
|---|---|
| `git push`, in the placement, to `origin`; destination the mission branch, `HEAD`, or none while on the branch; no `-f`, `--force*`, `--delete`, `--mirror`, `--all`, `--tags` | `git push <branch>` · `push` · `integration: true` |
| any other `git push` | `push` |
| `git commit`, `merge`, `cherry-pick` or `revert`, in the placement, on the mission branch | none |
| the same outside the placement (`-C`, or `cd` into another checkout) | `outside-workspace` |
| the same on another branch; `git switch`/`checkout` to another branch, `rebase`, `reset --hard`, `branch -D`/`-m` in the placement | `git <sub> off the mission branch` · `commit`, held |
| in the placement: `git remote add`, `set-url`, `rename`, `remove`/`rm`; `git config` writes of `remote.*`, `url.*`, `push.*` | `outside-workspace`, held |
| `glab mr create` or `glab mr update` with source the mission branch (or omitted) and target the integration branch | `glab mr <sub>` · `push` · `integration: true` |
| `glab mr merge`, `approve`, `close`, `delete`, `rebase`; `glab ci run`, `retry`, `cancel`, `delete`; `glab api` | `push` (merge) or `network`. Never covered by the standing grant |
| `glab mr view`, `list`, `diff`; `glab ci status`, `view`, `list`, `get`, `trace`; `glab pipeline list`, `status`, `view` | `glab (read)` · `network` · `forgeRead: true` |

- `gh pr create`/`edit` get the same treatment as `glab mr create`/`update`. The new actions, all `push`, are `glab mr create`/`update`/`merge` and `gh pr create`/`edit`/`merge`; they join `EFFECTFUL_ACTIONS` and `ACTION_EFFECTS`, so the Worker watch's `danger` and A-6 see them.
- Every `glab` command is classified (network, push or forge read).
- A covered push must name `origin`, with only harmless flags; `-c`, `--git-dir`, `--work-tree` and `GIT_*` assignments are never covered. A command whose destination cannot be parsed stays held, never covered.

### 4.3 The standing integration grant

```ts
IntegrationGrant = {
  state: "granted" | "revoked";
  decisionId: string;              // m:<missionId>:<n>
  grantedAt: string; revokedAt: string | null;
  scope: { remote: "origin"; branch: string; target: string };
  mr: { url: string; iid: number | null } | null;
}
```

- **Asked once** (`server/integration-grant.ts`). The first time a placement's request reports `finished` with a commit and the placement has no grant, the plugin opens an `m:` decision: subject `integration`, class `release`, `ownerOnly`.
  - Card text: "Push `m/ABC/fe` and open its merge request into `develop`? Later pushes and updates of this merge request are then covered; merging stays on GitLab."
  - Options: a "Yes, for this mission and repository" (effect `push`); b "Not now — keep committing locally" (none).
  - No policy, level, Main, Orchestrator or precedent answers it (§7.4).
  - Option a carries the mission action `integration.grant { missionId, repo }`, not a prepared change, so only the owner's tap applies it. paseo-bm never opens the card twice; the owner asks again from the mission page (`mission.integration.ask`, `askIntegrationAgain`).
- **The boundary.** In `decide`, after the one-time grants and before the policy, a new step `integrationCoverOf(findings, placement)` runs:
  - it allows only findings with `integration: true` or `forgeRead: true`;
  - only while the grant is `granted` and its scope matches the context;
  - the result is `allowed-integration`, each use is written to the journal, and nothing is spent.
- **The Worker watch** passes the grant as covering `push` only for findings marked `integration`. A push to any other branch still raises `danger`.
- **Shown and revoked.**
  - The mission page's repo row reads "allowed" with a Revoke button on a desktop, and "Push & MR allowed · Revoke" on a phone.
  - `mission.integration.revoke { missionId, repo, what? } → { revokedAt, notified }` sets `revokedAt`, sends `BM-SETTINGS` to the placement's live Workers and journals a `decision` line.
  - `BM-SETTINGS` also goes to those Workers on a grant. The Main is told on a grant and on "Not now".
- **With the boundary off** (the default, autonomy design §D.5), rule 1 and `danger` are the guards, as for every push today. The grant is what makes a push allowed: a push without it is a `danger`.

**The local merge** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 4) is a second grant, on the same route: `Placement.localMerge { state, decisionId, grantedAt, revokedAt, target }` on the mission branch's placement.

- **Asked once** per mission and repository, at the first `finished` that passes the finish gate (§4.6) with a commit: one `ownerOnly` `m:` card, subject `local-merge`: "Merge `m/ABC/fe` into your local `develop` by fast-forward whenever a request passes its checks? Nothing is pushed; push and tag stay yours." Option a "Yes, for this mission and repository" (effect `commit`) carries the mission action `integration.local-merge { missionId, repo }`; b is "Not now — keep the work on its branch". Only the owner's own tap grants it. `mission.integration.ask` and `.revoke` take `what: "push" | "local-merge"`, `push` by default.
- **What it does.** After a passed gate, while the grant is `granted` and names the placement's target, `localMergeRefusalOf` (`server/lane-merge.ts`) moves the target to the newest commit reported in the chain, never the branch head: `git merge --ff-only <sha>` where the target is checked out in a worktree, else `git update-ref refs/heads/<target> <sha> <old>` after `merge-base --is-ancestor <old> <sha>`. A lane n ≥ 2 merges only once `mergeLane` merged it.
- **Refused**, by divergence or a conflict with uncommitted work, it changes nothing: a journal line, `finishGate.passed` false with the reason, and the Main told in the delivery. No retry, no push, no tag.
- **Shown and revoked** on the mission page's repo row, beside push and merge request. Its Yes journals and tells the Main; its Revoke only journals. Workers have nothing to change.

### 4.4 The report's git fields

These are additive. `bm_report` is a consumed contract, so the old shape is still read.

- `ReportInput` and `REPORT_SCHEMA` (`shared/bm-tools.ts`) gain `integration?: { branch, commit /* 7–40 hex */, pushed: boolean, mr?: url, ci?: "none" | "pending" | "success" | "failure" | "not-run" }`.
  - `buildReport` writes the lines `branch:`, `commit:`, `pushed:`, `mr:` and `ci:`.
  - `REPORT_KEYS`, `parseReports` and `parsedReportSchema` read them.
- **Refusal.** A bound Worker in a placement that sends `finished` with `filesChanged` and no `integration` commit gets `fixThese` with "input.integration.commit: commit on <branch> and report its sha". Nothing is stored.
- **What reads it.** The newest `integration.commit` reported in the chain is the commit the finish gate (§4.6) checks and the local merge (§4.3) moves to.
- **Added by the mission line** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decisions 3, 6, 7; optional fields a report built before ignores):
  - `runtimeProof { kind: "ran" | "could-not-run", what, showed? }`, masked, required on a `finished` with a Medium or Large tier whose `filesChanged` holds a non-document path and no size-rollover `remaining`; the registry notes it, and "could not run" is shown and blocks a `met` done criterion on that request (missions design §4).
  - `goal` and `acceptance[]`, required on a Medium or Large `received` outside a step and rendered as lines for the Main.
  - `forNextStep { summary, contract?, remaining? }`, required on a step's `finished` that has a next step, stored beside the finish gate for that step's brief (§19.6).

### 4.5 Reading the line's state

With `integration.ci` off (the default), CI is not read, shown or waited on (§17.1).

- **The primary source is read-only git** in the placement (`line-state.ts`): `rev-list --left-right --count origin/<target>...HEAD`, `status --porcelain`, `log -1 --format=%cI` and `rev-parse HEAD`. Paseo's descriptor alone is not enough: its `gitRuntime` disappears from `workspaces.list` after a git change unless some client holds a `workspace_update` subscription (spike S1).
- **Paseo's descriptor** is used when present. `descriptorOf` (`line-state.ts`) reads, from a `workspaces.list` entry, `gitRuntime { currentBranch, isDirty, aheadBehind, aheadOfOrigin, behindOfOrigin }` and `githubRuntime.pullRequest { url, state, checksStatus, mergeable }`. How the daemon fills them:
  - Paseo fetches every 180 s and polls checks every 20 s while they are pending.
  - `aheadBehind` is measured against the stored base branch.
  - `aheadOfOrigin` stays empty until the first `push -u`.
  - GitLab's merge request and CI fields are filled only through the `glab` CLI, installed and logged in.
- **Merge request and CI** come from the report's `integration.mr` and `ci` (the Worker's `glab mr view -F json` and `glab ci status`, `forgeRead`), or from `githubRuntime.pullRequest` when it is filled.
- `line-state.ts` provides `lineStateOf`, `committedOf`, `verifiedOf` and `descriptorOf`. A committed finish costs about seven read-only git calls.
- **The finish gate** (§4.6) reads committed from this same read-only git (`committedOf`).
- **Could not run.** A request whose `runtimeProof` is `could-not-run` shows it in the mission state ("could not run", §4.4).

### 4.6 Finished → committed → verified

- **Committed.** A placement request's `finished` counts as committed when the plugin confirms all of these: the reported sha is an ancestor of `HEAD` (`merge-base --is-ancestor`), the current branch is the mission branch, and the tree is clean apart from ignored files.
- **Verified.** With `integration.ci` off (the default), it is verified when paseo-bm detected a check in the request's own turns (`shared/evidence.ts`, §17.1); a pipeline is never evidence. A check the report names as reused, which the request's full records show passing earlier, is labelled `reused` and counts as verified ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 13). With `integration.ci` on, it is verified when the merge request's `checksStatus` is `success` on a head that contains the sha (pushed, with `aheadOfOrigin` 0); before a merge request exists, a detected check is enough, and `failure` reads **CI red**.
- **The Main's line** reads "finished, committed on `<branch>`[; verified]." (with CI on, also "; CI red" or "; CI pending"), or "finished, uncommitted: `<why>`."
- **The finish gate** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 2; amends ADR-035 decision 3's Evidence clause). Every `finished` records `finishGate { passed, reasons, at, commit }` on its registry entry, as the first act of storing it, so whatever sees `finished` sees the final result; the delivery gains one line when it failed. It reads the continuation chain, root to head (`finishGateOf`, `server/finish-gate.ts`), and fails on:
  - the head's `finished` with `remaining`;
  - a Medium or Large chain with changed files whose newest `wave` or `finished` batch has no passing latest result;
  - any adopted batch without a passing latest result (§2.6);
  - `reviewFindingsOpen`;
  - changed files with checks neither `detected` nor `reused`, from the newest report of the chain that names checks, read against every record of every Worker of the chain and the reporter's live tail;
  - changed files not committed by the chain's newest reported commit, or changed outside a placement;
  - with `integration.ci` on, a CI `failure`. A green or pending pipeline adds nothing: the checks are local either way.

  A reported commit counts as a change even with no file named or edited: a shell-only merge, cherry-pick or generated commit goes through the same review, checks and commit reading before its sha can reach the local merge. A Reviewer's file or run counts for nothing, only the chain's Workers do. A request with no predecessor and no changed file passes; a continuation with none is judged on its chain. Every request created on this build is stamped `gated: true`, so a head with no stored result fails with a named reason; only a head from before this build reads as passed. A refused local merge (§4.3) is a failure of the gate.

### 4.7 Conflicts surface at integration

- **The Worker's "update the branch" step**, in `worker.md` "Proving a change". It runs before a push, and when the brief or `BM-SETTINGS` says the branch is behind or conflicting:
  1. `git merge origin/<target>` in the placement. Paseo has already fetched.
  2. Resolve conflicts inside the request's scope, run the checks, and commit the merge. That commit is covered: it is on the mission branch.
  3. Never rebase pushed history.
  4. If a conflict needs a choice about another mission's merged change, send `blocked` with a question for the Main.
- **The governor's early signal.**
  - `line-watch.ts` reads a read-only `git diff --name-only origin/<target>...<branch>` for every open placement of one repo, keyed by repo key, and `overlapConflictsOf` (`governor-conflicts.ts`) turns an overlap between two of them into an "expect a merge conflict" `mission.conflict`.
  - `linkConflictsOf` stays; the trace-area source is retired.
  - `bm_arbitrate` is unchanged. The other mission's Worker merges after the winner's merge request lands.
- **Beads.** `.beads/issues.jsonl` is tracked in the target repositories and sorted by id (proved by `test/beads-merge.test.ts`).
  - New beads merge cleanly only when they land in different gaps of the file.
  - Two new beads in one gap, or a new bead next to a line both sides changed, fall in one conflict hunk.
  - The rule at the "update the branch" step, **per line, never per hunk:**
    1. In a conflict hunk keep one line per id: the integration branch's line for an id both sides have, and each side's own line for an id only it has. Keep the file sorted.
    2. Commit the merge.
    3. Run `br sync --rebuild`, so the committed file replaces the worktree's database. Without this, br's next write exports the request's older row and drops the integration branch's change.
    4. Re-apply the request's own change with `br`.

  Taking the integration side of a whole hunk loses beads. Rebuilding before step 1 holds deletes them for good. `br` imports the file in a fresh worktree. No merge driver is needed.
- **Retired:** cross-mission writer collisions, and file negotiation between missions' Workers.

### 4.8 Migration of missions on a shared checkout

`server/checkpoint.ts` and `checkpoint-card.ts`. Files: `missions/placement-mode.json` is `{ since }`, `missions/checkpoints.json` records each offer and its outcome, and registry entries gain `movedFrom`.

1. **Cut-over.** On its first start, the build writes `missions/placement-mode.json { since }`.
   - A mission created after it gets its worktree at its first Worker.
   - A Worker already running in a root keeps its request and finishes in place.
   - A mission from before the cut-over is never stalled by the checkpoint. While its repository has no usable checkpoint (its card unanswered, "later" or failed), its new Workers are created in the root (`ensurePlacement` returns `inRoot`, `bm_create_worker` answers `worktree: "not yet: …"`). The brief says "worktree: not yet — this mission works in the shared checkout until its checkpoint is made; paseo-bm moves new Workers to the mission's worktree after it.", and there is no Integration line. Once the checkpoint exists, new Workers go to the worktree.
2. **The checkpoint card**: subject `worktree-checkpoint`, class `data`, `ownerOnly`, effects none.
   - Idle root: a "Checkpoint now" (recommended) or b "Not now". Busy root, while a root Worker runs a turn (`busyRequestsOf`): a "Ask me again once they finish" (recommended) or b "Checkpoint now anyway", with the warning "Still working in it: …"; later shared-tree edits then need a follow-up checkpoint. An idle Worker lets the card come back as "Checkpoint now". "Not now" is final.
   - A tap creates the branch `bm/checkpoint-<yyyymmdd>` (`-2`, `-3` when taken) without touching the owner's HEAD, index or working tree. A temporary index in the OS temp folder takes `read-tree HEAD`, `add -A` and `write-tree`, then `commit-tree -p HEAD` and `git branch` follow, with split index, untracked cache and auto gc off and the environment of `repo-tool.ts` `gitEnv`. This respects `.gitignore` and writes only objects and one ref. Git runs before the answer is stored, so a git failure leaves the card open.
   - The commit falls back to `paseo-bm <paseo-bm@localhost>` when the repository has no identity, and `commit.gpgSign` is honoured.
   - It is done only on the owner's explicit tap (ADR-035 decision 3). The local merge (§4.3) is the other write into the owner's own checkout, on its own grant.
3. **Placements from the checkpoint.** Each open mission with that repo gets a placement with `base = bm/checkpoint-…` and `target` = the integration branch. The base is the checkpoint **branch**, never its sha: Paseo measures `aheadBehind` only against a branch (spike S1).
4. **The card's advice** (the owner's action, not the plugin's): push the checkpoint branch and merge its own merge request first. Each mission's merge request then shows only its own changes. The owner tidies the shared checkout afterwards; the plugin never does.
5. **Successors.**
   - A new request uses the placement.
   - A handoff of a request from before the cut-over moves it, only when the root equals the checkpoint: `registry.move(fromWs, toWs, requestId)` plus the roster's `workspaceId`. This is safe because ids are unique.
   - If a shared-tree Worker finished with changed files after the checkpoint, the plugin offers a follow-up checkpoint, parented on the previous one.

### 4.9 Mission state, governor and screen

- **Mission state.** `MissionState.placements[]` holds `{ repo, name, workspaceId, branch, target, state, dirty, ahead, behind, lastCommitAt, pushed, mr: { url, state, mergeable } | null, ci, grant: { at } | null, readAt }`.
  - It is drawn as a "Lines:" section after In flight in the Main's state text, one line per repository, within the 6,000-character cap.
  - A request carries `committed` and `verified` (§4.6).
  - **The cache.** `line-watch.ts` refreshes each placement at most once a minute, on the governor's 60-second pass. Turns and the mission state read the cache.
- **Governor figures** (families in `shared/governor-figures.ts`, rules in `server/governor-figures.ts`; thresholds in the governor settings):

| Figure | Family | Rule (setting, default) |
|---|---|---|
| `uncommittedHours` | mess | dirty with no live Worker after the last `finished` (`governor.uncommittedHours`, 4 h) |
| `unpushedNoMr` | stuck | ahead with no merge request (`governor.unpushedHours`, 24 h) |
| `ciRed` | stuck | only with `integration.ci` on: CI red (`governor.ciRedMinutes`, 30 min) |
| `mrConflicting` | stuck | a merge request not mergeable for conflicts, ≥ 1; only where the descriptor reports it, which on GitLab is not yet |
| `behindIntegration` | drift | behind the target (`governor.behindCommits`, 50 commits) |

- **Conflict evidence** reads "expect a merge conflict: PAY (m/PAY/repo-a) and WEB (m/WEB/repo-a) both change … against origin/develop" (§4.7).
- **Screen.** The mission page's repo row shows the branch, ↑ahead ↓behind, an uncommitted dot, the merge request link and state, CI when it is on, and the push grant with Revoke (§4.3). The contracts get `missionRepoSchema.placement`.

### 4.10 As built (Phase 8, 2026-10-21)

Folded into §4.2–§4.9 on 2026-11-16.

## 5. Review by milestone (base REQ-037, ADR-035 decision 4)

### 5.1 Milestone batches

| Milestone | Tier | Stages | Scope | When |
|---|---|---|---|---|
| `plan` | Large | `plan`, `beads`, plus `documents` if written | the plan, its documents, the bead graph | once, before `beads-done` |
| `wave` | Medium, Large | `implementation` | the first implementation's requested scope; later, the diff since the last completed implementation review, its open blocking findings and affected checks | after the last bead of a planned wave, when more waves follow |
| `finished` | Medium, Large; Small only on the owner's ask | `implementation` | the same incremental rule as `wave`; reuse still-valid check results | before `finished` |

- **No bead has a review of its own.** A bead closes on its checks. Where the `implementing-beads` skill asks for a review before a close, the milestone batch is that review (`worker.md`).
- **`bm_create_reviewer`** gains optional `milestone` and `since` (a commit). When `milestone` is absent it is derived: `plan` when the stages include `plan` or `beads`, else `finished`. It is stored on `batches[].milestone`.
- **Incremental implementation (ADR-041).** The first implementation review receives the declared scope and base. Later batches receive a snapshot diff from the latest implementation call with a verdict, plus that result's open blocking findings. A plan-only batch and a no-verdict attempt establish no implementation coverage. The recorded snapshot overrides a repeated request-wide `since` or scope. Without a usable snapshot, the brief restricts review to changed paths/hunks and findings named by the Worker; missing evidence goes in `notChecked`, never a full-request fallback. The optional `calls[].brief` keeps a re-review’s exact bounded scope for replacements; old calls fall back to the batch brief.
- **Refused:**
  - a second `plan` batch after one passed: "Plan batch b2 passed, and a request reviews its plan once: open a wave or finished batch instead. Nothing was created.";
  - a `plan` batch below Large: "Only a Large request reviews its plan; nothing was created.";
  - a stage list that does not fit its milestone, for example: "A plan batch reviews plan or beads, never implementation: the stages … do not fit it; nothing was created."

### 5.2 Convergence

`bm_rereview` is allowed, asking no one, when all of these hold; it creates a fresh Reviewer on the diff of the fixes (§17.2):
1. the batch's latest result is `changes-required`. A `pass` refuses: "Batch b2 passed: nothing to re-review. Nothing was sent." A last review with no verdict yet refuses: "Batch b1 has no verdict on its last review yet: wait for it to reach you. Nothing was sent."
2. the batch has had fewer than `review.maxRereviews` re-reviews (1–6, default **3**).
3. from the second re-review on, the latest blocking count is **strictly lower** than the one before it. An unknown count never counts as lower ("blocking 3 → unknown"), though a re-review after a no-verdict is allowed.
4. the request is under its cap (§5.3).

- **Blocking counts.**
  - They are stored on the batch: `batches[].results: [{ at, recordId, verdict, blocking: number | null }]`, appended by `bm_review` from the report's `blockingCount`, by the unbound final-answer path, and as `null` on no-verdict (withheld ones too).
  - They are not read from the outbox, which keeps records for 7 days.
  - A batch from an older build has no `results`: it falls back to the trace's `reviews[]` by `batchId`.
- **An adopted batch** (§2.6, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 10) keeps its results and calls, so the rule counts its earlier re-reviews and the next re-review's diff starts from its last completed snapshot.
- **When it stops converging**, the refusal reads: "Batch b2 stopped converging (blocking 3 → 3)" or "Batch b2 had its 3 re-reviews". It goes on: "Fix what you can and open the next milestone batch, or send `finished` with the open blocking findings in `reviewFindingsOpen`. Nothing was sent."
  - No question is asked.
  - A finding that would remove asked-for work stays a scope question.

### 5.3 The cap

```
cap(request) = review.callsPerBatch × min(M, Mmax[tier])
  review.callsPerBatch : 2–6, default 3 (the p92 calls of one batch at the field rates)
  M                    : the request's milestone batches, counting the one being opened, never below 1
  Mmax                 : Small 1, Medium 2, Large 4
```

- The defaults give at most 3 / 6 / 12 calls, never below the old 2 / 2 / 4. The calls are pooled across the request's batches.
- The count is the Dashboard's (`requestReviewCountOf`). An adopted batch's inherited calls are not in it: the request that made them paid for them (`ownCallsOf`, ADR-045 decision 10). The batch still counts in M.
- One function, `reviewCapOf(tier, milestones, settings)`, is used by the tools, the `review.over-budget` rule (its id is kept), the stall reason, `overrunOf` and the governor.

### 5.4 Past the cap: one owner decision per request

The tool opens the decision through the materialiser before it refuses:
- Id `q:<requestId>:Qn`, subject `review-cap`, class `cost`, **`ownerOnly: true`**. No policy, precedent, Main or Orchestrator answers it. The question reads "Request `<req>` reached its review cap: …. How should it go on?"
- Options:
  - a "Allow one more round of batches (+`callsPerBatch` calls)" grants `{ calls }` in the existing grant format; it declares the effect `cost`, so the owner's tap asks for confirmation;
  - b "Finish as it stands, open blocking findings listed" is recommended when the last batch stopped converging;
  - c "Stop this request".
- `applyReviewCapAnswer` is the settlement hook, and acts on the owner's answers only.
- **Once per request.** A second cap hit opens nothing: "The request's review cap is spent and the owner answered Qn; send `finished` with the open blocking findings. Nothing was created or sent."
- **The first refusal:** "Review cap reached for `<req>`: `<calls>` of `<cap>` calls (`<tier>`, `<M>` milestone batches). paseo-bm asked the owner as Qn. Send `blocked` with `waitingOn: [q:…:Qn]`. Nothing was created or sent."

### 5.5 What the Reviewer is told

- **The implementation stage** reviews the initial scope once, then the incremental scope above. The Reviewer reuses valid Worker evidence, rerunning affected checks only for missing, stale, failed or suspect evidence or a concrete finding; it never repeats an unchanged suite just to certify it again.
- **A re-review** of the same `batchId` checks the previous blocking findings against the diff since the last review, and that the fixes broke nothing. A new blocking finding is reported only where a fix introduced it. A finding still open keeps its location and wording. Its brief is §17.2's.
- `bm_rereview` needs no `since`: paseo-bm finds the diff from its snapshots. A `since` given is only context, when there is no snapshot (§17.2).

### 5.6 Settings and retirements

- **Settings.** `review { maxRereviews, callsPerBatch }` replaced `review { smallBudget, mediumBudget, largeBudget }`. No migration is needed:
  - unknown keys are ignored and dropped on write, and `version` stays 1;
  - an older build reading a new file falls back to its 2 / 2 / 4;
  - `coordination.set` refuses an old key: "`<key>` no longer exists: review.maxRereviews and review.callsPerBatch set the review cap; nothing was saved";
  - a stored prepared change on an old key applies honestly: "change: not applied (this setting no longer exists); nothing was changed" (§7.3). A prepared change on the new keys reads "sets at most N re-reviews per batch" or "sets N review calls per milestone batch".
- **The Settings review card** shows the steppers "Re-reviews per batch" and "Calls per milestone batch", and the computed caps read-only: "Cap per request: Small 3, Medium 6, Large 12 calls".
- **The Runtime facts line** (`reviewCapLine`): "Review: up to 3 re-reviews per batch while blocking findings fall; cap per request: Small 3, Medium 6, Large 12 calls."
- **Registry.** `grants` is unchanged. `untilCleanBatch` is written only as `null` and no longer exempts calls; `reviewGrantSchema` still parses an older `{ untilClean }` grant, which grants nothing.
- **The upgrade sweep** (`review-budget-sweep.ts`), at the first Paseo handle of a run, withdraws open `review-budget` decisions. It is idempotent, and the Worker gets the withdrawal as a notice of kind `withdrawn:<requestId>`: "Qn is withdrawn: review budgets are retired: paseo-bm asks once, at the request's review cap. Do not wait for it."
- **Questions and notices.**
  - `bm_questions` refuses the subjects `review-cap` and `review-budget` and has no `grant` field. The materialiser opens no Worker question on them: only paseo-bm opens `review-cap`.
  - `REVIEW_BUDGET_SUBJECT` survives only as `LEGACY_REVIEW_BUDGET_SUBJECT`, for the sweep and §7.4.
  - The `BM-BUDGET` notice reads "…For your information only: paseo-bm asks the owner itself, once, at the request's review cap…". A mission's Main never gets it (mission runtime design §6.4).
- **Retired** with the review budgets: the policy and Main grant caps, delegated `untilClean`, `authority.ts`'s review rules, and every helper that served them.
- **Governor.**
  - `reviewBudgetExhausted` becomes `reviewCapReached`, and a new `unconvergedBatches` counts batches stopped by the rule in 24 h. The setting key `governor.reviewExhausted` is kept.
  - The Orchestrator's advice reports pass shares and unconverged batches per tier, against `review.callsPerBatch` and `review.maxRereviews`.

### 5.7 As built (Phase 6, 2026-10-20)

Folded into §5.1–§5.6 on 2026-11-16.

## 6. Waits by structure (REQ-212, ADR-035 decision 5)

### 6.1 Before the delivery line

Retired by ADR-035 decision 5: every delivery used to wake an idle Worker at once, one message each, and a wait was free text read back by a regex. The evidence is the [field review](../archive/operations/paseo-bm-field-review-20261020.md).

### 6.2 A structured wait

- **The report.** `blocked` keeps `waitingOn` (questions) and `waitingOnPeers` (links), and gains:
  - `waitingOnRequests` (request ids, ≤ 10);
  - `waitingOnBatches` (`^b\d+$`, ≤ 5, each awaiting a verdict);
  - `wakeOn: "all" | "any"` (default `all`).

  `waitingFor` stays free text for the reason. A `req-…` id in it is promoted to structure. The waits are written into the report's `blockers` line ("waiting on requests: …", "waiting on review: b1", "wake on: any"), and `ParsedReport` reads `waitingOnRequests`, `waitingOnBatches` and `wakeOn`.
- **The registry's `waiting`:**

  ```ts
  { since, reportRecordId, wakeOn,
    items: [{ kind: "question" | "link" | "request" | "batch", id, settled: boolean, settledAt?, fact? }] }
  ```

  It is set by `blocked`, and cleared by any other report or by the wake. A wait with no items (text only) holds nothing. An item's `fact` is at most 300 characters.

### 6.3 What settles an item

| Item | Settled by | Where |
|---|---|---|
| question | the decision answered, decided, expired or withdrawn | the decision store's `transition`; a superseded question settles nothing |
| link | a reply or message from the other side; the link closed; the link past its ceiling | `peer-tools.ts` `appendMessage`; the stall pass |
| batch | a review or no-verdict record of it | outbox `add` |
| request | it, or its chain head, reports `finished` or `stopped`; its Worker is archived | report `before`; the stall pass |

A settled request or link puts its fact in the wake, so the Main stops relaying it. The facts read:
- "req-X finished: …" and "req-X stopped: …";
- "req-A finished as req-B: …";
- "peer-x answered: …" and "peer-x closed by the asking/answering side";
- "req-X has no live Worker left";
- "b1 got no verdict: no Reviewer of it is running".

### 6.4 The hold

`server/wake-gate.ts`.

- **The gate.** `wakeGate(home, targetId, kind, refs, hint?)` returns `deliver` or `hold`. It holds only for a bound Worker whose `waiting` has unsettled items, and only a delivery that settles none of them and is not in the always-at-once list. It is called in outbox `deliverRecord`, decision delivery and override delivery. Every `BM-COMMAND` is always at once, so command send never asks it.
- **At the send too.** The gate also decides when the notice queue sends an item, not only when the item is queued:
  - an item it then holds goes back to its held state, and a held `BM-ROLLOVER soft` has its `rolloverAsked` cleared, so it is asked again later;
  - a queued release whose wait a newer one replaced is gated again, item by item, and its facts are kept in memory only, so a reload loses them;
  - an item that meets the wait at send time goes, and the wait is released at the Worker's next report or delivery.
- **Only the newest Worker is gated.** A review or no-verdict goes to the request's current Worker (`verdictTargetOf`) when the Reviewer's parent is no longer the chain head's newest Worker. Records held for a replaced Worker are re-addressed to its successor when the successor's wait is released.
- **Holding.** A held outbox record gets the new state `held`, an open state that survives a reload and is gated again then. A held answer or override is recorded as `delivery.outcome: "held"`, and its card shows "Held for X: it goes with what the agent waits on."
- **The release** (`releaseWait`) is one `BM-UPDATES <n>` message through a Worker channel that reuses the Main's (`main-channel.ts` `enqueueUpdates`), in this order: the settling delivery (if it settles an item), then the facts block — `BM-DELIVERY wait` / `Continue <req>: what you waited on is settled.`, one fact per line, newest first — then the held items, oldest first. One held item alone goes as its own block. `bm_report` releases after storing, and the stall pass releases what it settled (`onWaitsSettled`).
- **No turn at all** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decisions 2, 7, 14). A step's `finished` that has a next step and a Small or a step's `received`, like `beads-done`, are stored as notes with `noTurn`; the Main reads them at the head of its next delivery. The owner's switch (§19.6) delivers the first three normally.
- **Always at once** (`AT_ONCE_KINDS`: `owner-chat`, `stop`, `command`, `replaced`, `settings-mode`, `rollover-now`, `maintenance`, `tell-now`):
  - the owner's chat, which Paseo delivers directly;
  - `BM-STOP` and stop propagation;
  - every `BM-COMMAND`;
  - `BM-REPLACED`;
  - `BM-SETTINGS` mode changes;
  - `BM-ROLLOVER now`;
  - maintenance (§6.6);
  - `bm_tell_worker` with the optional `now: true`, for owner words that change the wait.

  A held tell answers `delivery: "held"` with "The Worker waits on Q2 and Q3; it gets this with them." With `wakeOn: "any"` it reads "…Q2 or Q3; it gets this with the first of them."

### 6.5 Stall watcher and governor

- **No stall.** `structuralWaitOf(request, facts)` (`shared/structural-wait.ts`) is shared by the stall watcher and the governor's `waitingOrStoppedOf`. When every unsettled item is live, there is no `idle-unfinished`, no event and no re-wake, and an open stall alert clears. Live means:
  - an open question;
  - a running Reviewer, or a call younger than the pending window;
  - an active request with a live Worker;
  - a link under its ceiling.

  An unknown item counts as not live.
- **A dead item**, such as a Reviewer gone with no verdict, an awaited request stopped, or a link past its ceiling, settles as a fact and wakes the Worker once.
- **Older reports.** The governor reads `waiting.items` first, and the regex only for older reports.

### 6.6 The maintenance ceiling

- **The rule.** At a recorded turn end (never inside a turn), a pending compaction or handoff runs **without the safe-point and quiet-queue checks** (`atMaintenanceCeiling`) once one of these holds:
  - its figure is ≥ `maintenance.ceilingFactor` (1.5–5, default 2) × its threshold;
  - it has waited `MAINTENANCE_WAIT_MS`, 30 minutes, half its window. A context-share figure in effect reaches its ceiling by this rule.

  A rollover has both ceilings ([ADR-051](../adr/ADR-051-three-owner-decisions-from-the-documentation-review.md) decision 2): at `rollover.ceilingFactor` × a figure, or once it has waited `MAINTENANCE_WAIT_MS.rollover` (30 minutes) without the request rolling over, the soft notice becomes `BM-ROLLOVER now`, which is delivered at once (§2.6).
- **Order.** The `/compact`, the handoff note request and `BM-ROLLOVER now` go first through `enqueue({ first })`; queued items wait until after them, and `BM-STATE` is always queued first.
- **At the ceiling,** a queued `/compact` or note request does not expire after 60 seconds: it goes at the agent's next turn end. A compaction keeps `ceilingAt` once it reaches its ceiling, and stays at its ceiling until it runs.
- **Retries.** `handoffTriesOf` counts completed handoffs plus `no-safe-point` drops toward `handoff.maxPerRequest`, so a handoff no longer re-arms without end.
- **A Worker waiting by structure** is a natural safe point: its last turn sent a report, and its held items are outside the in-memory queue. Compaction and handoff go through the notice queue, which the wake gate never sees, so a waiting Worker gets them.
- **Settings › Coordination** shows `maintenance.ceilingFactor` ("Skip the safe point at, × a threshold") on the Rollover card, with the rollover keys.

### 6.7 The signal budget (amends mission runtime design §6)

Applied in place in mission runtime design §6.1–§6.3.

### 6.8 As built (Phase 7, 2026-10-21)

Folded into §6.2–§6.6 on 2026-11-16. The scenario test runs 3 seeds × 250 Worker turns in the default project, and 2 seeds × 800 in the bench project (§13).

## 7. One question, one decider, honest effects (REQ-213, ADR-035 decision 6)

### 7.1 A decider who can decide

- **The rule in `deciderOf`** (`shared/authority.ts`): a decider other than the owner is named only if at least one option it may choose settles the question without leaving a held effect for the owner.
- **The cases that remain** once the review rules are gone (§5.6):
  1. **The Main on effect classes.** When only the mission delegates the class, the Main's answer covers no effect (`grantCoverOf` counts owner answers only), so a push would become a held card anyway.
     - The Main decides (rule `delegated-main`, `withoutEffects`) only when an option settles with no effect, and `bm_answer_worker` refuses an option with effects: "Refused: option `<k>` of `<qn>` declares `<effects>`, which only the owner's answer covers here; choose an option without effects or leave it to the owner. Nothing was answered."
     - When every option has an effect, the owner decides and the Main recommends (rule `mission-effects`); `bm_answer_worker` records the Main's choice as its recommendation.
     - A repo cell that delegates the class names the Main for every option.
     - Letting the Main's answer cover effects would widen a safety boundary. It is not done here.
  2. **The Orchestrator on `f:` incidents.** *Retired by [ADR-051](../adr/ADR-051-three-owner-decisions-from-the-documentation-review.md) decision 1:* the unverified-finish guard is gone, so an unverified finish names no owner here.

### 7.2 One card per question

- `bm_owner_question` gains optional `about: { requestId?, decisionId? }`.
- **The check.** Before storing, the question is refused when an unsettled `q:` of the mission's roster matches it:
  - explicitly, through `about.decisionId`;
  - or implicitly: the same request (named, or the roster's only active one) and an equal subject or equal normalised text. The materialiser's text match is extracted as `sameQuestionText`.
- **Instead,** the Main's recommended option — matched by exact label first, then by key — is written as `prediction.main` on that `q:` (`withMainPrediction`), at every level; the reason written is the option's label. The text reads: "Refused: the Worker's question q:`<req>`:Q3 already asks the owner this. Your recommendation (b — `<reason>`) is attached to it. Nothing new was stored."
  - With no match, nothing is attached: "…Your recommendation (`<label>`) names none of its options, so nothing is attached; give it in your reply to the owner. Nothing new was stored."
  - An earlier recommendation stays: "Your earlier recommendation (`<key>` — `<reason>`) stays attached to it."

### 7.3 Effects are stated by what was done

- **`server/effects.ts`** has one function per effect kind: `answerEffect`, `citedAnswerEffect`, `grantEffect`, `changeEffect` (applied, already, written but inert, failed), `deliveryEffect` (delivered, held, queued, dropped, failed, nothing sent), `noTurnEffect`, `recommendationEffect`, `missionCardEffect` (with a journal line), `commandDeliveryEffect`, `incidentActionEffect` and `arbitrationEffect`; `nothingWas` and `nothingWasSentence` write the closing sentence.
  - Each effect returns `{ applied: EffectRecord | null, sentence }`, built from what was written, never from intent.
  - `bm_answer_worker`'s `said` is built from the stored decision after delivery: delivered, held, queued, not delivered, or not delivered yet. A prepared change is checked against what the store holds after the write.
- **The call sites:**
  - `mission-tools.ts`;
  - `decision-delivery.ts`;
  - the tool faces in `shared/bm-tools.ts`;
  - `orchestrator-decisions.ts` and `orchestrator-decide-tools.ts`;
  - `governor-tools.ts`;
  - `decision-rpc.ts`;
  - `command-authority.ts`;
  - `server/prepared-changes.ts`.
- **A guard test** scans these modules and `shared/bm-tools.ts`: none builds a "grant", "applied" or "nothing was" sentence outside `effects.ts`, with five named tool-face exceptions.

### 7.4 Precedent-eligible subjects

`shared/question-subjects.ts` holds the one registry:

```ts
export const CODE_SUBJECTS = {
  "review-cap":    { precedent: false, askedBy: "plugin" },
  "review-budget": { precedent: false, askedBy: "retired" },
  integration:     { precedent: false, askedBy: "plugin", when: "once per mission and repository" },
  "local-merge":   { precedent: false, askedBy: "plugin", when: "once per mission and repository" },
} as const;
export function precedentEligibility(subject, decision?): { eligible: true } | { eligible: false; why: string }
```

- It also covers what is ineligible by flag: `ownerOnly`, prepared changes, and the decision kinds that precedents never answer.
- **Every caller refuses with the same `why`:**
  - `whyNotPrecedent`, used by the save card and its RPC;
  - `checkPrecedentSaveInput`, used by Settings;
  - the prepared `precedent.save`;
  - `precedent-resolve.ts`, so saving and applying cannot disagree;
  - the `bm_ask_owner` guard, which refuses a `CODE_SUBJECTS` subject.
- **Why texts:** `"review-cap"` "is a question paseo-bm asks you itself, each time; no precedent answers it" (`integration` and `local-merge`: "…, once per mission and repository; …"); `"review-budget"` "is a retired question; no precedent answers it"; each `ownerOnly`, override, held or prepared-change decision has its own text. Settings and RPC refusals end "; nothing was saved", and `bm_ask_owner` refusals end "; nothing was stored". `ownerOnly`, override and held decisions cannot be saved as precedents from a card.
- **Stored precedents** on an ineligible subject stay. `precedents.list` marks each `inert: "<why>"`, Settings shows "Answers nothing: `<why>`.", and they are left out of the Runtime facts' "Owner precedents".

### 7.5 As built (Phase 6, 2026-10-20)

Folded into §7.1–§7.4 on 2026-11-16.

## 8. The governor (REQ-214, ADR-035 decision 7; amends orchestrator design §6A, missions design §9)

### 8.1 Pools

- A command entry gains optional `governorStep: "nudge" | "replan" | "arbitrate"` and `by: "code" | "model"`. `by` comes from the send's `governorBy`: the ladder passes `code`, and the default is `model`.
- Each pool is counted per mission per 24 h, stored as `codeNudge`, `replan`, `arbitrate` and `other`:

  | Pool | Setting | Default (bounds) |
  |---|---|---|
  | Code nudges | `governor.quotaCodeNudge` | 6 (1–50) |
  | Re-plans | `governor.quotaReplan` | 3 (1–20) |
  | Arbitrations (charged to each mission) | `governor.quotaArbitrate` | 4 (1–20) |
  | Others (model nudges) | `governor.quotaOther` | 4 (1–20) |

- No kind spends another's pool. Old entries without a step count in `other`.

### 8.2 Repeats cost nothing

- **Arbitration.** Once the two missions check out, `bm_arbitrate` looks for a standing arbitration (`standingArbitrationOf`, `governor-conflicts.ts`). If one covers the area and both missions, it returns that arbitration, sends nothing and spends nothing: "Area `<area>` was arbitrated as `<arb-…>` on `<YYYY-MM-DD>` (owner: `<mission>`); nothing was sent."
- **Re-plan.** A re-plan of a family whose last action was a re-plan within `governor.windowMinutes`, with no crossed figure higher or newly crossed, returns that re-plan. It is free only when every family it concerns repeats: "Mission `<code>` was re-planned at `<at>` (command `<id>`) and its figures are no worse; nothing was sent."

### 8.3 A spent pool degrades

- **Code nudges.** When the code-nudge pool is spent, the family records `held: { pool, until }` and writes one journal line; it stays at its step. Only a spent pool holds a family: a missing Main or a failed delivery still retries every 10 minutes.
- **Daily digest.** Once a day, the Main gets a digest: the held families, their figures and the charter line. It is a `message` record from `plugin`, sent through `storeAndDeliver`, at most once per 24 h, with its times kept in `governor.json` `digests`. It is not a command and costs no pool.
- **The refusal** reads: "This mission's `<pool>` commands are spent until `<time>`; paseo-bm puts the figures in the Main's daily digest. Nothing was sent."
- **`bm_ask_owner`** with a mission refuses unless one of these holds:
  - a family of that mission is at ladder step 4;
  - the ask carries a goal change or a split: `goal` or `split` as a hyphen-separated part of its subject;
  - the class is not a process class (`scope`, `preference`, `reversible-technical`).

  The mission is found through the request, a Main the ask names, or the mission's workspace. The owner-wrote-recently exemption is `ownerWroteRecently` (2 h, the REQ-198 figure). The refusal reads: "The governor reaches the owner from step 4; this mission is at step `<n>`. Nothing was stored." The `bm_ask_owner` face states the gate.

### 8.4 Drift and stalled

- **The trace record** gains optional `trigger: "owner" | "report" | "plugin" | "agent" | null`. The collector sets it from the turn's first received message with `turnTriggerOf` (`shared/eval-metrics/mains.ts`), so it agrees with A-14:
  - the owner's words → `owner`;
  - a report delivery, or a review delivery → `report`;
  - other notices, peer messages, relays and governor commands → `plugin`;
  - anything else → `agent`.

  A `BM-UPDATES` message counts by its first item.
- **Drift** counts the Main's turns triggered by `owner` or `report`. Older records count as today.
- **The drift reset** reads a criterion's new `metAt`, which is set only when it is met with evidence; an older met criterion's `at` is carried into `metAt` when its status is next written. A criterion moved back to open, or a status sent again, no longer resets it.
- **`stalled`.**
  - It never applies to a structural wait (§6.5).
  - The alert clears only on progress — a report, a bead closed, a review result — or when the request starts waiting on the owner or on another project's link.
  - A family returns to step 0 only after its figure stays under its threshold for the 30-minute window, from `underSince` (additive). The intervention outcome is measured from that point.

### 8.5 Older governors

- When it finds more than one Orchestrator agent labelled `main`, the plugin relabels each older one `bm.orchestrator=retired` and retitles it "Beads Orchestrator (retired)", the title first. It does this at the first Paseo handle and at `agent.created` of a `bm-orchestrator`.
- It is idempotent, like `REPLACED_BY_LABEL`. Nothing is archived or stopped (ADR-005).

### 8.6 As built (Phase 6, 2026-10-20)

Folded into §8.1–§8.5 on 2026-11-16.

## 9. Typed messages (REQ-215, ADR-035 decision 8)

### 9.1 Acts and references

- **On `bm_peer_reply` and `bm_ask_mission`:**
  - `act` is one of `ask`, `answer`, `agree`, `ack`, `close`, `supersede`. Defaults: `ask` on `bm_ask_mission`; on `bm_peer_reply`, `answer` from the answering side and `ask` from the asking side. `close: true` stays an alias.
  - `refs: { contracts?: ["C2@v3"], records?: ["out-…"], decisions?: ["q:…", "m:…", "arb-…"] }`, at most 10 each. They are checked against the mission store, the outbox and the decision stores, with one refusal line for each unknown id. Decision refs accept `q:`, `o:`, `f:`, `r:`, `h:`, `m:` and `arb-…` ids. `C2@v3` is known when v3 is at or below the contract's current version.
- **`bm_tell_worker` and `bm_link_workers`** take `refs` only.
- **Rules:**
  - `agree` needs a contract reference at exactly its current version.
  - `supersede` needs the replaced record.
  - `bm_ask_mission` refuses `answer` and `close`, because there is no link yet. An `ack` there opens the link and starts no turn.
  - `ack` and `close` start no turn. They are stored with outbox outcome `delivered`, reason `no-turn`, appended to the link, and answered `delivery: "no-turn"` with a note from `effects.ts` `noTurnEffect`. The receiver sees them in `BM-STATE` and at the head of its next outbox delivery: `noted: <link> from <agent> (act: ack · refs: …): <gist>`, at most 5, each marked `shownAt` once shown.
  - `close` closes the link. A `close` that meets a wait wakes the waiting Worker with the facts block (§6.4).
- **The link message** gains optional `act` and `refs`. The delivered text gains one header line: `act: agree · refs: C2@v3`.
- **One delivery rule** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 14). At every delivery the plugin asks whether the record needs a turn or is only a note.
  - A `beads-done` report and a command's `copy: yes` block are stored as notes, like `ack` and `close`, and never enqueued.
  - A `message` of no open work (`isDormantRecord`) whose recipient, as resolved now, reads `resting` is settled at once as `delivered`, reason `no-turn`, with no alert and no drop (`settleAsNote`). This replaces ADR-044's skip at start-up: `createOutboxResend` simply delivers again, so a record an older build left open becomes a note at the next start. A record that carries the owner's decision or words (`from` `owner` or `orchestrator`, or `atOnce`) is never such a message, at a plugin start either: it wakes its reader, since nothing else would, and ADR-044 decision 3 keeps a woken dormant Main from making a successor or a workspace. A presence that cannot be read delivers as before.
  - A note with no link reads `noted: <kind> <id> from <agent>: <gist>` at the head of its target's next delivery (`noTurnNoteOf`).
  - An open `delivery-dropped` alert gets exactly one `BM-DELIVERY-FAILED`, sent when the alert opens; `undelivered` ranks below a question waiting for the owner (mission runtime design §2.1).

### 9.2 Contracts

- **Fields.** A contract gains `status: "proposed" | "agreed" | "superseded" | "withdrawn"` (absent = `agreed`) and `agreedBy: { side, agentId, version, at }[]`.
- **Writing a version.** `bm_mission_update.contracts` accepts `status`. A new version is `proposed` unless stated `agreed`. A status-only change keeps the version and journals "The Main marked C1 withdrawn."
- **Agreeing.**
  - An `agree` act with `Cn@vk` at the current version appends to `agreedBy`. The two sides are the link's asker and answerer.
  - When both sides have agreed, the contract becomes `agreed` and a journal `contract` line is written.
  - A stale version is refused: "C2 is at v4; agree to C2@v4 or reply." A superseded or withdrawn contract answers "C1 is withdrawn; there is nothing to agree to: reply instead".
- `bm_mission` shows each contract's status.

### 9.3 The brief holds the agreements

- **Contracts.** `renderMissionState` has a **Contracts** section after In flight and Lines. It lists live contracts, `proposed` first, at most 10: `- C2 v3 proposed: <title> (provider <repo>; consumers <repos>)`.
- **Links.** A link shows its latest message, not its original ask: `- peer-… to mission B (question, open, waiting 2h): last answer by B 40m ago: <gist> · refs C2@v3`.
- **Space.** Within the 6,000-character fit, Contracts is dropped after Recently and before Links.
- **The Worker's compaction brief** (`compaction.ts`) gains `links:` and `contracts:` blocks after `decisions:`, within `WORKER_LINKS_BLOCK_MAX_CHARS` (2,400), built by the shared `linkLineOf` and `contractLineOf`. The continuation and handoff briefs keep their own lists.

### 9.4 Writing for a reader

The Main's and the Worker's role files each gain one line: "Write every message to another agent in full sentences a newcomer to the work understands; name what you mean by its id in `refs`. A message that needs no answer is `act: ack`: it wakes no one."

*As built:* a Worker-to-Worker link has only its two Workers as sides, so the Main records the contract with `bm_mission_update` and tells each Worker to answer on the link with `act: agree` and its `Cn@vk`. The Main agrees with another mission on that mission's link.

Workers of two missions still talk through their Mains (REQ-187 d).

### 9.5 As built (Phase 9, 2026-10-21)

Folded into §9.1–§9.3 on 2026-11-16.

## 10. Role files

Each role is written as positive instructions, at the step that needs it. The role files are pinned at their sizes (`test/roles-content.test.ts`): `manager.md` 100 lines, `worker.md` 180, `reviewer.md` 95 and `orchestrator.md` 100, so a new line replaces one.

| File | Where the delivery line's rules sit |
|---|---|
| `worker.md` | Rule 1: commits on the mission branch, push and merge request only with `push/MR: yes` (§4.1). "What you do next": milestone batches, no bead review (§5.1); a request ends at `finished`; `BM-ROLLOVER` (§2.6); a brief with `continues:` carries on from its chain (§2.5). "Proving a change": the integration commit in the report (§4.4), no pipeline waits (§17.1), update the branch (§4.7), a lane merges the mission branch in at `finished` (§19.2). "Reviewing": re-reviews while blocking findings fall, the stop, the cap (§5.2–§5.4). "Reporting": waits by id, `wakeOn`, `BM-UPDATES` (§6.2). Messages (§9.4) |
| `reviewer.md` | The implementation scope and the re-review scope (§5.5, §17.2) |
| `manager.md` | A finished or stopped request goes on as a new request that paseo-bm staffs (§2.4); new work never into a busy Worker: `next`, `after`, `parallel` (§19.12). A waiting Worker is woken by paseo-bm, so tell it only what paseo-bm cannot see, and use `now: true` for owner words (§6.4). A Worker's open question is already the owner's card: recommend on it (§7.2). A lane's Workers share its tree (§4.1); `BM-SIGNAL overlap` (§19.3). Agreements and messages (§9) |
| `orchestrator.md` | Reviews past a cap are paseo-bm's one question, so never ask about reviews; advice goes on `review.callsPerBatch` and `review.maxRereviews` (§5.6). The owner is reached on a mission's process from ladder step 4 (§8.3) |

A role-file change makes every running agent of that role outdated, and it is replaced once.

## 11. Stored formats and compatibility

Every change is additive. No `v` changes.

| Store | Change | Older data and older builds |
|---|---|---|
| Registry | chain fields, `waiting`, `rolloverAsked`, `batches[].milestone`, `batches[].results`, `batches[].adoptedFrom`, `calls[].tree`, `calls[].brief`, `movedFrom`, `gated`, `finishGate`, `forNextStep` | absent = not a chain, no structured wait; results fall back to the trace; a head without `gated` reads as passed |
| Outbox | state `held`; `steeredAt` | an older build reads `held` as an unknown state and leaves it |
| Coordination settings | `rollover.*`, `maintenance.ceilingFactor`, `review.maxRereviews`, `review.callsPerBatch`, `governor.quota*`, `integration.ci`, `line.supervised`, `cleanup.archive`, `cleanup.idleDays` | old `review.*Budget` ignored and dropped on write; a missing key reads at its default |
| Decisions | subjects `review-cap`, `integration`, `local-merge` (`ownerOnly`); `prediction.main` from §7.2 | open `review-budget` withdrawn by the sweep |
| Missions | `placements[]` (with `localMerge` and the lane fields), `repoAliases`, criteria `metAt`, contracts `status` and `agreedBy` | absent = no placement (root), `at` when met, `agreed` |
| Mission index | `placements` and `repoAliases` maps | rebuilt |
| `missions/placement-mode.json`, `missions/checkpoints.json` | new | absent = before the cut-over, no offer |
| `missions/<id>.held.json` | new (§19.6) | absent = nothing held |
| Commands log | `governorStep`, `by` | counted in `other` |
| Trace record | `trigger` | counted as today |
| Peer link messages | `act`, `refs` | `answer` and none |
| Reports | `integration`, `remaining`, `waitingOnRequests`, `waitingOnBatches`, `wakeOn`, `runtimeProof`, `goal`, `acceptance`, `forNextStep` | old shape parsed as today |
| Memory | entries' `scope` and `subject` (§18.1) | read by `scopeOf` |

## 12. Screens

Each change needs the approved mockup updated first: an approved mockup is the contract for the screen. **Approved by the owner on 2026-10-20:** [`docs/design/mockups/delivery-line.html`](mockups/delivery-line.html), artboards I (desktop mission page), J (phone mission page) and K (Projects › Requests), beside `mission-runtime.html` artboards G and H. Lanes and the Waiting part follow [`mission-lanes.html`](mockups/mission-lanes.html) artboards Q and R (§19.8).

1. **Mission page, In flight:** a request's chain ("continues `<id>`", and "finished → `<id>`").
2. **Mission page, repos:** a placement row with branch, ahead/behind, uncommitted, merge request, CI when it is on, and the push grant with Revoke.
3. **Projects › Requests:** the chain on its head, with the chain's tokens.
4. **Settings › Coordination:** the review steppers with the computed caps, and the Rollover, CI, Supervised line and Archive finished agents cards. These use existing controls, so no mockup is needed. The governor settings, the pools included, have no control on this screen.

## 13. Measures and tests

- **New figures in the replay:**
  - M-36: the largest request's tokens;
  - M-37: files written by two missions in one placement;
  - M-38: committed and verified finishes;
  - M-39: review questions per request;
  - M-40: turns started while waiting by structure, and the token share of turns that end blocked;
  - M-41: owner cards by kind;
  - M-42: maintenance dropped after its ceiling.
- **New tests:**
  - **Continuations:** links set on both sides, a new Worker, the brief block, staffing, a refused creation, the unbound path unchanged.
  - **Rollover:** one soft notice; the hard notice at 2×; `remaining` opens a `size` continuation; an answer to an open question reaches the chain head.
  - **The wake gate:** each always-at-once kind passes; a held message survives a reload; the settling item releases one `BM-UPDATES`; `wakeOn: any`; a dead item wakes with a fact.
  - **A seeded scenario.** Scripted Worker turns (bead closes, follow-ups, reviews, questions, peer asks) run through the real tools and hooks over a fake Paseo and a temporary home: 3 seeds × 250 turns in the default project and 2 seeds × 800 in the bench project (`test/mission-scenario-bounded.test.ts`, `mission-scenario-bounded-benchmark.test.ts`). The invariants:
    - no request exceeds the hard figures;
    - the chains' closed beads equal the beads closed;
    - a Worker with an unsettled wait gets no send until an item settles, then exactly one;
    - no maintenance waits past its ceiling plus one turn end.
  - **Placements:** `repoKeyOf`; policy, memory and precedents through a placement; idempotent creation, the suffix guard, adoption on reload, re-creating from the branch; the dependency clone's lockfile gate and fallback.
  - **The boundary:** the integration cover, a scope mismatch, a revoke, `glab` reads and merges, commits outside or off the branch, and `danger` for a push elsewhere while a grant is live.
  - **The report:** the `integration` round trip, the old shape still parsed, the refusal of a `finished` without a commit.
  - **The checkpoint:** it leaves HEAD, the index and the tree unchanged (a temporary repository); `registry.move`.
  - **Review:** convergence (a pass refuses; 3 → 2 allowed; 3 → 3, unknown and K refused); the cap per tier × milestones; one owner-only question per request; old keys ignored; the sweep.
  - **One card and effects:** an `m:` duplicate refused with the recommendation attached; the precedent registry agreeing across every caller; effect sentences against applied state; decider resolvability.
  - **The governor:** pools; a repeat arbitration spends nothing; the step-4 gate; the digest; drift by trigger; reset on a met criterion; stalled hysteresis; the Orchestrator relabel.
  - **Messages:** act and refs validation; `ack` and `close` start no turn; contract agreement; BM-STATE contracts and latest-message links.

## 14. Spikes before Phase 8

Spikes S1–S4 ran on 2026-10-20 on an isolated daemon and scratch clones. Their results are folded into §3.3, §3.5, §4.5, §4.7 and §4.8; the record is the [spikes record](../archive/operations/paseo-bm-delivery-line-spikes-20261020.md). S4 (a GitLab merge request's state through `glab`) was not verified, so §4.5 reads it from the Worker's report.

## 15. Phases

Built in Phases 6–9 of the [delivery line plan](../archive/plans/paseo-bm-plan-delivery-line.md), completed 2026-10-21.

## 17. No agent waits on machines (ADR-036)

### 17.1 CI is not used

- **The setting.** `integration.ci` in the Coordination settings is `"off"` (the default) or `"on"`. A file without it reads as off, and a bad value is refused: "integration.ci must be "off" or "on"; nothing was saved". When on, §4.5 and §4.6 read the pipeline.
- **Settings › Coordination** has a CI card after Rollover: "Read a merge request's pipeline as evidence and show it. Off: verified is a check paseo-bm saw pass, and no agent waits on a pipeline." Its switch takes effect at once.
- **What off means:**
  - **Verified.** A finished request is verified when paseo-bm detected a check in its own turns (`shared/evidence.ts`), or a reused one (§4.6). At report time `bm_report` reads the Worker's live timeline (`liveChecksOf`, 3 pages of 200 entries) for its named checks, because the reporting turn is not recorded yet. The report's `ci` field and the descriptor's checks are ignored.
  - **The Main's line** reads "finished, committed on `<branch>`; verified." or the same without "; verified", or "finished, uncommitted: …".
  - **The governor** computes no `ciRed`.
  - **The mission state and the Repositories row** show the merge request without CI: placements carry `ci: null`, `mission.get`'s summary has `ci`, and the Repositories column reads "Merge request · push".
- **The Worker's role.** Push and create or update the merge request when Integration says yes. Read the merge request's state with `glab mr view` only when needed. Never read, wait for or poll a pipeline: report and end the turn.
- **The Main** does not ask a Worker for CI.
- **The boundary is unchanged.** `glab ci …` stays classified.

### 17.2 A re-review checks the fix diff, with a fresh Reviewer

- **The snapshot.** At every review call (`bm_create_reviewer` and `bm_rereview`) in a repository with git, paseo-bm writes the working tree as a tree object and stores its id on the call (`calls[].tree`). It uses the checkpoint's helper (§4.8, `checkpoint.ts`): a temporary index outside the repository, `read-tree HEAD`, `add -A`, `write-tree`, with up to 60 seconds per git command. Objects only: no ref, and the owner's HEAD, index and files are untouched.
- **What `bm_rereview` does:**
  1. Snapshots the tree.
  2. Reads the snapshot of the batch’s last call with a verdict, skipping no-verdict attempts (ADR-041). Results select the most recent call no later than the verdict; missing or legacy trees use the bounded account fallback.
  3. Computes `git diff --stat` and `git diff` between the two trees, read-only and redacted (`fixDiffOf`).
  4. **Creates a new Reviewer** for the batch through `bm_create_reviewer`'s path (a new `callId`, counted against the cap) with the brief below, and answers `{ reviewerId, reviewCalls }`. The earlier Reviewer is left idle.
- **The brief** (`rereviewBriefOf`, `review-tools.ts`):

  ```
  Re-review batch <bN> of request <req>: a fresh Reviewer checks only the fixes.
  Previous blocking findings (verbatim):
  <the previous result's blocking findings>
  Fixes — files changed since the last review:
  <git diff --stat>
  The diff (up to 40,000 characters; else: git diff <tree1> <tree2>):
  <diff>
  Checks the Worker ran for these files: <fixed>
  Validation: reuse still-valid Worker results. Run only affected checks for missing, stale, failed or suspect evidence, or a concrete finding; no automatic full-suite run.
  requestId: <req>
  batchId: <bN>
  ```

  - The findings are the `- severity: blocking` items of the review record of the batch's newest result with a verdict, verbatim; when none is marked that way, the whole review is quoted.
  - The stat is cut at 8,000 characters. A diff longer than 40,000 characters is left out, and the brief says "(longer than 40,000 characters: run git diff <from> <to> in your folder)".
- **When there is no usable snapshot** (no Git, a Git failure, or a legacy call), the brief names only the changed paths/hunks and findings in the Worker’s `fixed` account, and missing evidence is `notChecked`. Legacy `since` is context only; never run a whole-request diff as the fallback. When every earlier result is a no-verdict, the fresh Reviewer gets the batch's original brief. A re-review’s exact brief is saved on `calls[].brief` and used unchanged when a provider fallback replaces the Reviewer (`fallback-reviewer.ts`); old records use the batch brief.
- **Refusals** besides §5.2: agent tools off, and a blocked placement. An empty re-review call (Paseo's late error) is settled or cleared like a creation's.
- **The Reviewer's role** (`reviewer.md`).
  - Check each previous blocking finding against this diff.
  - Report a new blocking finding only where this diff introduced it.
  - Reuse valid Worker check evidence; independently rerun affected checks only for missing, stale, failed or suspect evidence, or a concrete finding.
  - Read outside the delta only for named findings or affected dependencies.
- **The Worker's role (ADR-041).** At every stage, run the smallest checks covering the changed behaviour and affected consumers. After a fix, rerun only checks whose evidence the fix invalidates. Keep prior passing results while their code, dependencies and configuration remain unchanged. No full suite is required at `finished`, after review, or merely after a merge. Run broader checks only on the owner's explicit request or for a concrete affected behaviour that narrower checks cannot prove, and state that reason. Evidence detection remains conservative: an older reused result may stay self-reported, and `bm_report` asks never to rerun a suite only to obtain a detected label.

### 17.3 A Worker rolls over by its real context

- **The setting.** `rollover.contextTokens`: default 180,000 ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decision 10, so a session ends near 200k), bounds 100,000–900,000; the Settings row is "Or its context reaches". A settings file that holds the figure keeps it.
- **When it applies.** At a Worker's recorded turn end, the turn's own `usage.contextUsed` (never a sum) at or above it is a size figure like the others of §2.6. The soft notice fires at the figure, and the `now` notice at `rollover.ceilingFactor` × it.
- **The figure** reads "context 192k".
- **Compaction** is untouched (the owner's switch).
- **Codex accounting.** `inputIncludesCached` (`shared/eval-metrics/helpers.ts`) is the one rule:
  - Codex input includes the cache, so its tokens read are its input;
  - Claude and OpenCode report the cache apart;
  - for an unknown provider, the cache counts as included only when there is cached input and `contextUsed` = input + output.

  Orchestrator wake usage stores `includesCached` for Codex. Per-step Codex usage reaches no plugin hook, so Codex stays last-step.

### 17.4 Tests

- **CI off:**
  - verified from detected checks only;
  - no `ciRed`;
  - the Main's line has no CI;
  - the report's `ci` is ignored;
  - turning the setting on restores §4.6.
- **Snapshots and re-reviews:**
  - a snapshot leaves HEAD, the index bytes and the tree unchanged (temporary repository);
  - the re-review creates a new Reviewer with the brief;
  - the diff is bounded;
  - the fallback without git;
  - the call is counted.
- **Rollover:** the soft notice at the context figure (180,000), and `now` at 2× (360,000).
- **Role-content tests** for the three role changes.

### 17.5 As built (2026-10-23)

Folded into §17.1–§17.3 on 2026-11-16.

## 18. Agents are given a bounded context (ADR-037)

The evidence is the [context review](../archive/operations/paseo-bm-context-review-20261025.md). Every figure below is a constant in code; none is a setting except the `main.*` settings of §18.4.

### 18.1 Memory has a scope and a life

- **Stored, additively.** An entry of `memory/<repo>.json` gains `scope?: "repo" | "mission"` and `subject?: string` (≤ 80 characters, compared case aside). `schemaVersion` stays 1.
- **Default scope** (`scopeOf`): the stored `scope`; else `mission` for a `fact` or `decision` whose `by.missionId` is set; else `repo`. So an entry stored before ADR-037 reads by the same rule.
- **The owner's answers.** The plugin's entry for an owner's answer to a request's question carries that request's mission (`decision-store.ts`). One stored before, with no mission, is read with the mission its request belongs to (`resolvedMemory`, from the rosters), so it leaves with that mission; an answer to a request of no mission stays `repo`.
- **Live** (`liveMemoryOf(entries, missionOf, now)`, pure, in `memory-store.ts`; `missionOf` reads each mission's life from the mission store): an `active` entry is live unless it is retired for one of these reasons, the first that holds:
  1. `mission-closed`: its scope is `mission` and its mission is closed, or has no mission file (a file paseo-bm cannot read, such as a newer build's, reads as open, so nothing is retired or pruned for it);
  2. `superseded`: its `subject` is named by a newer active, not otherwise retired, entry of the repo that may replace it — a `repo` entry only by a `repo` one, a `mission` entry by a `repo` one or one of its own mission. So a mission's entry never hides a lasting rule that would come back, or be lost, when the mission closes;
  3. `stale`: its scope is `mission`, its kind is `fact`, and it is older than `MEMORY_FACT_DAYS` (14).
- **Reversible.** Retirement is computed at each read (`retirementsOf`) and never stored; the store gives `live` and `retired`. A retired entry is shown by `bm_memory read` with `retired: true`, with its reason. Re-adding its text with `scope: "repo"` (and `supersedes` its id) makes it live.
- **Pruning** (`prunedMemory`, inside every write). An entry retired since more than `MEMORY_RETIRED_DAYS` (30) becomes `removed`: since its mission closed (the mission's `closedAt`), since the entry that superseded it, or since it turned stale. The newest 300 removed entries are kept, as before.
- **The bound.** `MAX_ACTIVE_MEMORY` (300) counts live entries. The governor's bloat signal of missions design §9.2 was never built; nothing counts it.

### 18.2 A brief has a budget

- **Relevance** (`briefMemoryOf({ live, request, planStep?, missionId })`, `create-worker.ts`): the features an entry shares with the request and the plan step — its words of two letters or more and each pair of neighbouring words, case aside, so a Vietnamese compound such as "nhập liệu" counts — each weighted ln(1 + N / n), where N is the live entries and n those holding the feature. A word every entry holds counts little.
- **Order and shares.** The owner's own entries (`by.role: "owner"`, such as the Orchestrator's notes of the owner's word) first, newest first; then this mission's own entries, by relevance then newest, up to `BRIEF_MEMORY_OWN_SHARE` (half) of the budget; then the repo's other entries, by relevance, then conventions before contracts, decisions and facts, then newest; then whatever budget is left takes the rest of either in the same order. So a long mission's own history cannot push the repo's conventions out.
- **How much.** Entries are added while the section stays within `BRIEF_MEMORY_CHARS` (6,000); each line is cut at `BRIEF_MEMORY_ENTRY_CHARS` (400).
- **The rest** is one line: `- N more entries in this repo's memory: bm_memory read with a query.`
- **Text.** Both sides are NFC-normalised before matching, so a request typed with decomposed accents still matches.
- **Where.** The brief of `bm_create_worker` (`missionBriefLines`) and of a continuation (`continuation.ts`). The mission's own contracts touching the repo keep their lines in full: they are the agreements the Worker builds to, never ranked or cut.

### 18.3 Reads return a summary first

- **`bm_memory read`** (Main and Worker):
  - no `query` and no `id`: `{ project, live, retired, limit, index }` — the live entries newest first, at most `MEMORY_INDEX_ENTRIES` (80), each `{ id, kind, scope, by, at, text }` with `text` cut at 160, plus `subject` and `retired` when set — with `precedents` beside it and `more` as a sentence when entries are left out;
  - `query`: the matching live entries in full (`entries`), newest first, at most `MEMORY_QUERY_ENTRIES` (20), `more` when there are others, and the precedents that match;
  - `id`: that entry in full, live or retired; an id that is not active is refused;
  - `retired: true`: retired entries are included, each with its `retired` reason.
- **`bm_memory add`** takes `scope` and `subject` from either role; only a Main may give `supersedes`. Its answer names the entries its subject retires (`retires`), and, for a `mission` entry, the `repo` entries of the same subject that stay live (`stillLive`, with a note to add as `repo` to replace them).
- The index read shows the newest `MEMORY_INDEX_PRECEDENTS` (20) of the owner's precedents, with `precedentsMore`; a query finds the others. The agent's `## Owner precedents` carries them all as before.
- **`bm_mission`**:
  - `requests`: each `active` request in full (as before); each `finished` or `stopped` one as `{ requestId, repo, topic, state, workerId }`, the newest `MISSION_SETTLED_SHOWN` (20), with `settledMore` when there are others. A settled request with a question still open is always shown, with its `openQuestions`;
  - `journal`: the newest `MISSION_JOURNAL_SHOWN` (20) lines; input `journal` (1–50) asks for more;
  - input `requestId`: that request in full, settled or not.

### 18.4 A Main is compacted by its tokens

- **Crossing** (`mainContextCrossingOf`): the window share reaches `main.contextShare`, **or** the context reaches `main.contextTokens`, whichever comes first. The figure named is the one that crossed (the share when both).
- **Hard** (`mainContextHardOf`): the share reaches the hard share, or the context reaches `main.contextTokens / main.contextShare × hard share` (212,500 at the defaults), never below `MAIN_HARD_TOKENS_FLOOR` (1.25) × `main.contextTokens`, so a high share setting cannot bring the hard figure next to the compaction figure. The hard figure only counts on the first turn after a compaction (mission runtime design §3.5), so a Main is not replaced more often.
- **Settings → Coordination → Compaction** has a row "Compact a Main at" for `main.contextTokens`, with the token stepper the other token rows use. The card's note says a mission's Main is compacted at "Compact a Main at" or its window share even with the card's switch off.

### 18.5 An update says each thing once

`updatesNoticeOf` composes the blocks of one `BM-UPDATES` through `updatesBlocksOf` (`shared/notices.ts`):
- **Repeats.** A block whose text equals an earlier block's, once its `out-…` and `peer-…` ids and its `link:` line are taken out (a peer message repeats its link id in its closing line), is dropped. When it came over another link, the kept block ends `also on link: <ids> (the same message; one bm_peer_reply on each link that asks)`, so an answer owed on each link is not lost.
- **Status replies.** Of the `BM-DELIVERY peer-reply` blocks that carry the same `request <id>, phase:`, only the newest is kept.
- Every item's callbacks still run, so the outbox settles each record as before. The count in `BM-UPDATES <n>` is the blocks sent.

### 18.6 Roles

- **`manager.md`**: "`bm_memory` keeps only what later Workers in a repo need beyond this mission (`scope: repo`, a `subject` to replace one, its source)."
- **`worker.md`**: the project memory in the brief notes that `bm_memory` with a query reads more; "Lasting facts, conventions and contracts later Workers here need go to `bm_memory` (its source, `scope: "repo"`, a `subject` to replace one)".

### 18.7 Tests

- `liveMemoryOf`: each retirement reason, its order, an entry with no scope, reversal by a `repo` re-add, pruning after 30 days.
- `briefMemoryOf`: the budget, the mission's share, rarity weights and word pairs, the overflow line; the field brief's memory falls from 34,535 characters to at most 6,000.
- `resolvedMemory`: an owner's answer stored with no mission takes its request's mission.
- `bm_memory read`: index, query, id, retired; `bm_mission`: settled lines, `requestId`, `journal`.
- `mainContextCrossingOf` and `mainContextHardOf` with a window: 150,000 tokens of 475,000 crosses.
- `updatesNoticeOf`: repeats across links and status replies.

### 18.8 As built (2026-10-25)

Folded into §18.1–§18.5 on 2026-11-16.

## 19. Parallel lanes, steered words and a held queue (ADR-038)

*Accepted 2026-10-25: the owner approved mockup [mission-lanes.html](mockups/mission-lanes.html) artboards Q, R as is, and chose "steer with guards" after the spike (§19.9).* Evidence: [queue review](../archive/operations/paseo-bm-mission-queue-review-20261025.md). ADR-039 and ADR-045 amend the triage and the held queue (§19.6, §19.12).

### 19.1 Lanes (stored additively on the placement)

- **Record.** A placement gains `lane?: number` (absent = 1), `mergedAt?` and `freeSince?`. Lane 1 is the mission branch's placement; it keeps `m/<CODE>/<slug>` checked out. Lane n ≥ 2 is a Paseo worktree workspace on `m/<CODE>/<slug>-<n>`, worktree slug `<lane 1's slug>-<n>`, request key `bm-place-<mission>-<repo>-lane<n>`, title `<CODE> · <repo> · <n>`. `ensureLane` (`placement-create.ts`) makes it from the mission branch's local head, with the same dependency clone (§3.5), after making lane 1 with `ensurePlacement` if needed.
- **Bound.** `MAX_LANES` = 7 live lanes per mission and repository (lane 1 included). `charter.budget.workers`, when set, still caps the mission's live Workers.
- **Choosing a lane** (`create-worker.ts`). With no `lane`, `parallel` or peer answer, the work goes to lane 1. `lane: "new"` (still accepted; `parallel` replaced it, §19.6), `parallel`, or a Worker for a peer answer takes the free lane with the lowest number, else a new lane while fewer than `MAX_LANES` are live, else it is refused with the lanes' work: "…: hold the request with after, or stop one".
  - A free lane is reused only when its tree is clean, after `git switch -C <lane branch> <mission branch>`. A dirty free lane is not reused, and shows as "not reused: …" in that refusal.
  - A new lane skips branch names occupied by unmanaged or unmerged work and tries the next number; those preserved branches take no live lane. A lane branch left by an archived lane is moved to the mission branch only when the mission branch already holds it. Merging or deleting the preserved work remains the owner's decision.
- **Several Workers in a lane** are allowed when `staffing` is delegated (as today for a placement); the Main splits them by files.
- **Resolver.** `repoKeyOf` maps every lane's workspace to its repo, so policy, memory, decisions and the registry read the repo as for lane 1. `placementOf`, `newestPlacementsOf` (`line-watch.ts`), the Repositories row and `ensurePlacement` read lane 1 only.
- **The brief** of a lane has no push line: "lane: at finished, merge `<mission branch>` into `<lane branch>`, resolve conflicts, check what the merge touched, commit, then report finished; paseo-bm moves `<mission branch>` forward. Never push this branch."

### 19.2 Merging a lane

1. **The Worker, at `finished`** (`worker.md` and the brief's lane line): commit on the lane branch; `git merge m/<CODE>/<slug>` into the lane; resolve conflicts; run the checks for what the merge touched; commit; report `finished`. The report needs no lane field: the lane is the placement. `bm_report` refuses a lane's `finished` until the mission branch is an ancestor of the lane.
2. **paseo-bm** (`lane-merge.ts`, at the report): in lane 1's worktree, `git merge --ff-only m/<CODE>/<slug>-<n>`. When the mission branch moved on, it first runs `git merge --no-edit` of the mission branch in the lane; a conflicting merge is aborted. Git runs with a 2-minute timeout. A refusal, such as lane 1's uncommitted changes that the merge would overwrite, is kept as `mergePending`, told to the Main in the report's last line (`laneMergeLineOf`), and retried from the governor's pass every 10 minutes.
3. **After the fast-forward,** the lane is free (`freeSince`, `mergedAt`) and is reused as §19.1 says.
4. **Lane 1** merges nothing: it is the mission branch.
5. **Push and the merge request** stay on the mission branch (§4.3), under the one grant.

### 19.3 Overlap

- **When.** `checkLaneOverlaps` (`lane-overlap.ts`) runs from the governor's minute pass. Lane 1 counts its uncommitted files; lane n ≥ 2 counts `git diff --name-only <base>...<branch>` plus its uncommitted files. Free lanes are skipped.
- **What it signals.** When a file is changed by two live lanes of one repository, the Main gets one `BM-SIGNAL overlap` per pair and file set: the lanes, their requests and the files. It is repeated only when the set grows. `overlapTold` and `overlapToldAt` sit on the higher lane, and a reused lane drops both. A refused fast-forward (§19.2) is told in the report instead.
- **Display.** The signal shows on the mission page (§19.8). No governor figure counts it.

### 19.4 Triage tools

- **`bm_create_worker`** gains:
  - `after?: string[]`: hold the request until the named requests of this mission pass (§19.6);
  - `next?: true` and `parallel?: string`, for new work while a request runs (§19.6);
  - `lane?: "new"`: a lane of its own (§19.1); replaced by `parallel`, and still accepted.
- **`bm_tell_worker`**'s answer gains:
  - `delivery: "steered"`, besides `"sent"` and `"queued"`;
  - for `"queued"`, `turnMinutes`: how long the target's turn has run.

### 19.5 The owner's words are steered

- **Which messages** (`owner-words.ts`). A tell is the owner's words when it is a `bm_tell_worker` with `now: true` and `about: "current"` (§19.12) whose text the Main took from the owner's message in this turn, or a `BM-COMMAND` to a Worker from an option the owner answered personally. A `/bm-worker-new` request never reaches a running Worker, so it is no class.
- **How it is sent.** The notice queue sends it to a running Worker with `send(text, { messageId, activeTurnBehavior: "steer" })`, and records `steeredAt` on the outbox record.
- **Guards** (§19.9; the owner's choice; `steerRefusalOf`, `notice-queue.ts`). It is steered only when all of these hold:
  - the target is a Worker whose provider's base is Claude or Codex (`STEER_PROVIDERS`);
  - the target is `running` with a foreground turn id (`activeTurn.turnId`);
  - the text does not start with `/`.

  Otherwise it waits for the turn's end, as every other message still does. Support is read from the agent snapshot, since the plugin API gives no daemon version.
- **Checking the turn.** paseo-bm reads the turn id before the send and after it. A different id means Paseo replaced the turn: the outbox outcome is `turn-replaced`, the Main gets `BM-SIGNAL replaced`, and the owner's Inbox gets a `turn-replaced` alert, cleared at the request's `finished` or `stopped`.
- **A side effect.** Any delivered owner message denies the agent's pending permission requests (Paseo's `clearPendingPermissions`), as it does today.
- **Unchanged.** The other notices, `BM-UPDATES` and deliveries keep the turn-end rule (§6.4).

### 19.6 The held queue

- **Record** (`server/held-requests.ts`). Held work is kept in `<data>/missions/<missionId>.held.json` = `{ schemaVersion: 1, entries: [{ holdId, after, input, by, at, state, startedAs?, note? }] }`, under ids `hold-<time>`, not on the roster: a held request has the Main's `bm_create_worker` input, but no request id and no Worker until it starts.
- **Holding.** `bm_create_worker` with `after` refuses an unknown or stopped request, creates at once when every named request has passed, and otherwise holds the work. It refuses `after` from a Manager with no mission.
- **Start.** `startHeldRequests` runs from the governor's minute pass (`index.server.ts`). When every id of `after` passes (`holdStateOf`), it creates the Worker through `bm_create_worker` called as the mission's Main, so staffing, lanes and the brief apply as for any request, and tells the Main.
- **Stop.** A named request that stopped makes the entry `waiting-stopped`, with its reasons in `note`; the Main is told once.
- **Cancel.** The Main cancels with `bm_hold_cancel` (`holdId`, `why`).
- **Display.** `bm_mission` lists held requests (`held`) with what they wait for.
- **The supervised line** ([ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) decisions 1, 2, 3 and The switch; mission line plan §5.8, §5.9, §5.12).
  - **Reading `after`.** Each id is a `req-…` or a `hold-…`, read through the newest request of its continuation chain and that head's stored finish gate (§4.6), at creation as at every pass. A `gated` head with no stored result fails; only a head without the stamp, from before this build, reads as passed.
  - **One sequential slot.** A mission runs one sequential request at a time, across its repositories. While one runs, `bm_create_worker` takes `next: true` (held, runs when the slot is free, ahead of the remaining steps, on no request's result), `after` (it needs that request's result) or `parallel` (a double-quoted span the owner typed, checked on the Main's newest timeline page; a new lane, journalled and marked on the roster); a Worker for an open peer link of the mission that a running request's chain asked is created at once, marked parallel, in a lane of its own ([ADR-047](../adr/ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md) decision 2); anything else, `lane: "new"` included, is refused, with the choices named. A slot Paseo's agent list cannot show is held, never free: `bm_create_worker` refuses and the pass leaves the entry as it is.
  - **A step list.** `bm_mission_update.steps`, 2 to 12 of `{ title ≤ 70, request, acceptance[] 1–6 ≤ 200, project?, context? ≤ 16 }`, stores `proposed` entries and opens one owner card whose details list the criteria; the owner's apply makes them `held` and writes the plan from the titles, "keep as is" cancels them. While a line is live, `plan` is refused. A first step has an empty `after`: the slot orders it.
  - **The pass.** Due entries that are not steps first, oldest first, then steps, oldest first, one at a time; a due entry waits silently while a sequential request runs. On a pass a step starts with no Main turn; its start is a note.
  - **Stops.** A failed gate, a stopped request, a cancelled entry, an active head with an open `request-stalled` alert or no unarchived Worker, or one idle past the stall window (24 hours) with no alert and no live turn, since the stall watcher looks no further back and an abandoned request would otherwise hold the slot unseen. A held entry is `waiting-stopped` with its reasons, and returns to `held` when the stop no longer holds; a stall stop ends only when the head has new activity or has ended. A `started` step stays `started`, with a `stopNote` the page reads, and clears through a continuation or `bm_hold_cancel`. The Main gets one notice per distinct failure (`toldKey`) that names the real options. A notice that comes back dropped, at once or later from the queue, clears the key, so a later pass tells it again.
  - **Release.** `bm_hold_release { holdId, why }`, on the owner's word, lets a `waiting-stopped` entry start past the gate, the slot and the staffing rule's one-live-Worker line; the budget cap holds; the why is journalled. A release or a cancel is for one entry: it clears the failure's `toldKey`, so whatever else that failure stops, now or later, is told rather than left to wait unseen. A `started` step is never released.
  - **The result travels.** A step that starts gets, as context facts prepended to what it is given, the previous step's commit and branch, summary, contract and what it left, each cut to 500 characters, source `the previous step's finished report`; the stored entry is not changed.
  - **The owner's switch** (`line.supervised`, default on, machine-wide, Settings → Coordination, `coordination.set`). Off, for every mission: a head satisfies `after` at `finished` alone (`holdStateOf` skips the gate and the stall and no-Worker stops; a stopped request and a cancelled entry still stop), the pass and `bm_create_worker` wait for nothing at the slot and a satisfied `after` starts at once, and `bm_report` delivers `received` and a step's `finished` normally. The gate is still recorded, and a local merge still needs its grant and a passed gate; the staffing rule, `beads-done` and command copies are unchanged.

### 19.7 Roles

- **`manager.md`** — "What you do next", step 2, "A change: sort it, then delegate now": words about a running request's own work go to it with `bm_tell_worker`, `about: "current"`; anything else is new work, through `next: true`, `after` or `parallel` (§19.6, §19.12). Answering by reading is step 1. "Keeping the work aligned": on `BM-SIGNAL overlap`, step in at once — one lane waits, one takes the files over, or the work is split again.
- **`worker.md`** — "In a lane (`lane:` in the brief): never push; merge the mission branch in at `finished`; ask your Main before changing a file another lane changes." The brief's lane line names the steps (§19.1).

### 19.8 The screen (mockup Q, R)

- **Repositories:** per repository, its lanes with branch, work and Workers, state and age, a free lane's last merge, and the overlap line.
- **In flight:** the lane in the repository column, and a **Waiting** part listing:
  - held requests, with what they wait for and since when;
  - tells: steered into a turn, or waiting for the end of a turn, and since when.
- **Data** (`mission-page-lanes.ts`, `missions-model.ts`, `missions.tsx`). `mission.get`'s repositories gain `lanes`, `maxLanes` and `overlaps`, and `mission.get` gains `waiting`: held requests, and tells to busy Workers, queued or steered, a steered one shown for 30 minutes; the newest 10. Nothing reads git on a page read. An owner's steered `BM-COMMAND` is not in the outbox, so Waiting cannot list it.
- **Departures from the mockup, kept on purpose:**
  - the phone keeps artboard J's push line with Revoke, which R does not draw;
  - "· N Workers" shows from two Workers;
  - "merges into the mission branch at finished" shows on every working lane n ≥ 2;
  - states the mockup does not draw have their own words (a waiting merge, "being made", a replaced turn, a held tell, a held request on a stopped one, "Nothing waiting.").

### 19.9 The steer spike (2026-10-25)

The spike ran on an isolated daemon (Paseo 0.12.0). With `activeTurnBehavior: "steer"`, the plugin's `agents.ref(id).send` reaches the daemon's `steerOrReplaceActiveTurn`. Claude and Codex accept a steer into the running turn, and the agent acts on the text at its next model step. A steer the provider refuses — Claude: compaction in progress, a slash command, a turn id mismatch or a stale stream; Codex: no thread or turn, a slash command, an admission mismatch or a definitive rejection — makes Paseo replace the turn instead, as omitting the option does. §19.5's guards cover all of these but a compaction, which no public signal shows.

### 19.10 Measures and tests

- **M-44.** The minutes from an owner's message to a Worker acting on it: for an independent ask, under 5; for the owner's words to a busy Worker, under 2. The replay (`eval-store.ts` reads `outbox/*.json` without texts) counts tells to Workers — records of kind `message` not from the plugin, the owner or the Orchestrator:
  - their wait until delivered (or steered), p50 and p90 minutes;
  - steered, replaced, and still queued at the window's end.

  The owner's message time in the Main's timeline is not joined.
- **Overlap.** Overlap signals per lane-hour.
- **Tests.**
  - lane choice and bounds;
  - lane creation and reuse;
  - the merge and a refused fast-forward;
  - overlap detection;
  - the held queue's start, stop and cancel;
  - the steer path and its fallback;
  - the triage lines in the roles;
  - the screen against the mockup.

### 19.11 As built (2026-10-25)

Folded into §19.1–§19.10 on 2026-11-16.

### 19.12 New work never into a busy Worker; outdated Mains handed over (ADR-039)

- **`bm_tell_worker` `about`** (`"current"` | `"new"`). It is required while the request is at work, that is, not finished or stopped.
  - A missing `about` gets `fixThese` with how to choose.
  - `"new"` is refused (`newWorkRefusalOf`, `deliver-tools.ts`): "New work never goes into request X, which is still at work: give it its own Worker with bm_create_worker: …. Nothing was sent." For a mission's Main the choices are those of `slotChoicesOf`: `next: true` for new work, `after: ["<id>"]` when it needs that request's result, and `parallel` only with the owner's explicit word quoted. A Manager with no mission is told to use `after`.
  - A finished or stopped request opens its continuation as before, whatever `about` says.
- **Steer** (§19.5) needs `now: true` together with `about: "current"`. `now: true` alone on a live request is refused for the missing `about`.
- **`manager.md` step 2.** Words about a running request's own work (a fix, a stop, an answer) go to it with `about: "current"`. A new ask, a bug or a feature is new work, never a busy Worker's: `next: true`, `after` or `parallel` (§19.6).
- **Outdated Mains** (`main-upgrade.ts`). This runs in the minute pass (`index.server.ts`).
  - **What qualifies:** each open mission's Main that is live, idle (not `running` or `initializing`), not replaced, and on another `bm.instructions` hash than this build's. A Main with no label qualifies only once `STAMP_GRACE_MS` has passed.
  - **The handover:** `handOverMain` with `upgradeHandoffLineOf`, `mainHandoffLineOf` with the reason and "with the current ones, after the update": the successor says in one line that it took over and what is in flight. The reason recorded is `handoff`, so an older build still reads the mission.
  - **Only while the mission has work (ADR-044):** the mission needs an active request on its roster. A dormant mission keeps its Main until it next has an active request, so neither a successor nor a workspace appears for it.
  - One try per Main per process. Workers and Reviewers are untouched.

## 20. Finished sub-agents are archived (ADR-049)

[ADR-049](../adr/ADR-049-finished-sub-agents-are-archived.md) lets the governor archive the Workers and Reviewers whose work is finished for good and that nobody touched for the owner's window. Module: `server/agent-cleanup.ts`.

### 20.1 The setting

- Two coordination keys, additive:
  - `cleanup.archive`: a switch, `true` by default.
  - `cleanup.idleDays`: an integer from 1 to 30, `3` by default.
- A settings file written by an older build reads both at their defaults. `coordination.set` validates them as it validates the other keys.
- **Settings → Coordination** shows one card, "Archive finished agents", with the switch and the window in days, drawn with the controls of the other cards.

### 20.2 The pass

- **When it runs.** In the stall watcher's `beforePass`, after `replaceOutdatedMains`, at most once an hour per plugin process (an in-memory stamp), and only when `cleanup.archive` is on. The first pass of a run may archive at once.
- **What it reads.** Paseo's unarchived agents, read raw through `listAllAgents`. The role and the request come from the same readers `bmAgentsOf` uses: `roleOfAgent`, and `knownRequestIdOf` for a request paseo-bm trusts. An agent's last touch is the newest of its `updatedAt` and `lastUserMessageAt`; with neither, its `createdAt`.
- **Eligible.** A `worker` or `reviewer` that is labelled, is not `running` or `initializing`, and has no `pendingPermissions`. Its request must be located (`locateRequest`) and finished. The head of its chain (`chainHeadOf`) must be finished too. Its last touch must be older than `cleanup.idleDays` days.
- **Blocked by work still waiting.** Any of these keeps the agent:
  - an open outbox record (`isOpenRecord`) whose `to` is the agent, or whose `requestId` is in the chain (`chainOf` of the head);
  - an open decision of a request of the chain;
  - a peer link in state `open` or `taken` that has the agent or a request of the chain at either end.
- **Never.** Mains (`manager`), Orchestrators, agents with no `bm.role` label, archived agents, and an agent whose request paseo-bm does not trust or cannot locate; the trusted request is the real guard, since the plugin labels every `bm-*` agent with its role. When anything cannot be read, the agent is kept, and a pass that cannot read the bindings store archives nothing.
- **Archive.** At most 25 agents a pass, oldest last touch first, each with `paseo.agents.ref(id).archive()`. A failure is one log line; the next pass tries again. Nothing is ever deleted.
- **What Paseo does (checked 2026-11-16 on an isolated daemon, Paseo 0.15.3).** An archived agent leaves the default list with its history kept. Reading its timeline leaves it archived, so a continuation brief can still read a predecessor's Worker. Sending it a message restores it. Archiving a workspace's last agent leaves the workspace as it is.
- **Told.** For each mission, `note` journal entries by `plugin`, as few per pass as the journal's line limit (`MAX_JOURNAL_TEXT`) allows (`archivedNotesOf`): `Archived <n> finished agents left alone for <d> days: <role> <id8> (<requestId>), ….`, in the singular for one. A request of no mission gets a log line.
- **Unreadable.** Settings that cannot be read archive nothing. An outbox, decision or peer-link file that cannot be read archives nothing in that pass, because a broken file reads as empty and would hide waiting work. The binding sweep then revokes each archived agent's tool binding, as for any archived agent.

### 20.3 Roles

- `manager.md` rule 4: archiving and deleting stay the owner's, except the finished Workers and Reviewers that paseo-bm archives after the owner's window.
- The Orchestrator archives nothing by hand (its rule 1). The pass is the plugin's, so it needs no role text.

### 20.4 Tests

- Each eligibility and blocking condition, both ways.
- The window and the switch are read from the settings.
- Only one pass an hour runs, and the per-pass cap holds.
- Mains, Orchestrators and unlabelled agents are never archived.
- One journal entry per mission per pass, and an archive failure leaves the rest of the pass going.
- The setting's defaults, bounds and older-file reads; the settings card.

## 16. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-11-10 | Claude (as built, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) Phase 2) | §4.4, §4.5, §6.4, §19.6: runtime proof, the goal restated at `received`, what the next step needs; steps and reports that cost no turn; the supervised line (steps, the slot, stops, release, the result that travels) and the owner's switch |
| 2026-11-10 | Claude (coordinator's decision, [ADR-046](../adr/ADR-046-rollover-now-is-never-deferred-for-a-review.md)) | §2.6: `BM-ROLLOVER now` is never deferred for a review; a batch with no verdict goes onto the continuation; the notice follows the current Worker |
| 2026-11-10 | Claude (as built, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md) Phase 1) | §2.5, §2.6, §4.3–§4.6, §5.2, §5.3, §9.1, §17.3: finish gate and `reused` checks, the owner's local-merge grant, one delivery rule, a 180k soft default, batches adopted by a continuation, `BM-ROLLOVER now` held for a verdict |
| 2026-11-10 | Claude (owner request, ADR-044) | §19.12: an outdated Main is handed over only while its mission has work |
| 2026-11-11 | Claude (owner request, [ADR-047](../adr/ADR-047-a-repo-alias-reaches-later-missions-and-a-peer-answer-takes-no-slot.md)) | §3.1: a charter repo is matched by its key; the supervised line: a peer answer of the running request takes no slot |
| 2026-11-16 | Claude (owner request, [ADR-049](../adr/ADR-049-finished-sub-agents-are-archived.md)) | §20 added: finished Workers and Reviewers are archived after the owner's window |
| 2026-11-06 | Claude (owner request, ADR-043) | §3.1: a repo outlives its root workspace, through a proved alias |
| 2026-10-27 | Codex (authorised AIX recovery) | §19.1, §19.11: skip branch names occupied by unmanaged or unmerged draft work when allocating a new lane, preserving those branches and the seven-live-lane cap |
| 2026-10-20 | Claude (owner's decisions and delegation) | Created from ADR-035 and the field review of 2026-10-20. `design-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-20 | Claude (WP-8.0 spikes) | §3.3 idempotence, §3.5 setup source, §4.5 read-only git as the primary source, §4.7 the beads rule, §4.8 the checkpoint as a branch, §14 results, from spikes S1–S4 |
| 2026-10-20 | Claude (as built) | Phase 6 built (beads `bm-delivery-line-p6-1eda.1` → `.11`): §5.7, §7.5, §8.6 record the texts and choices made while building |
| 2026-10-20 | hieu.nt10 (approval; written by Claude) | §12: the mockup `mockups/delivery-line.html` (artboards I, J, K) approved by the owner as is |
| 2026-10-21 | Claude (as built) | Phase 7 built (beads `bm-delivery-line-p7-0iur.1` → `.12`): §2.8, §6.8 record the texts, choices and the three bugs the scenario test found and that were fixed |
| 2026-10-21 | Claude (WP-8.7) | §4.7 the beads rule made per line, with `br sync --rebuild` after the merge commit, from `test/beads-merge.test.ts` |
| 2026-10-21 | Claude (as built) | Phase 8 built (beads `bm-delivery-line-p8-1u4q.1` → `.12`): §3.8, §4.10; Phase 9 built (`bm-delivery-line-p9-fnoe.1` → `.3`): §9.5 |
| 2026-10-21 | Claude (field case; owner-approved fix) | §4.8 and §3.8: a mission from before the cut-over is no longer refused a Worker while its checkpoint waits — the Worker works in the root until the checkpoint exists; busy means a running turn. Base design: `/bm-worker-new` shows where the request went (the Beads tab's notice, Open Main) |
| 2026-10-23 | hieu.nt10 (owner's three answers; written by Claude) | §17 added; pointers in §2.6, §4.5, §4.6, §5.2, §5.5: CI not used, re-reviews of the fix diff by a fresh Reviewer, rollover by context ([ADR-036](../adr/ADR-036-no-agent-waits-on-machines.md)). `design-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-23 | Claude (as built) | §17.5: ADR-036 as built (beads `bm-no-wait-96so.1` → `.3`) |
| 2026-10-25 | hieu.nt10 (owner's four answers; written by Claude) | §18 added: scoped memory with computed retirement, budgeted briefs, summary reads, a Main compacted by tokens, updates without repeats ([ADR-037](../adr/ADR-037-agents-are-given-a-bounded-context.md), [context review](../archive/operations/paseo-bm-context-review-20261025.md)). `design-ready`: PASS (Claude under the owner's delegation) |
| 2026-10-25 | Claude (as built) | §18.8: ADR-037 as built (beads `bm-bounded-context-sfca.1` → `.5`) |
| 2026-10-25 | Claude (review of ADR-037) | §18.1–§18.5, §18.8: fixes from an independent review and field checks (scope rule for supersede, owner entries first, mission share, rarity ranking, contracts in full, owner answers by mission, settled open questions, hard floor, links kept) |
| 2026-10-25 | hieu.nt10 (owner's answers; written by Claude) | §19 added, proposed: parallel lanes, overlap signal, triage tools, steered owner words, the held queue ([ADR-038](../adr/ADR-038-parallel-lanes-and-a-held-queue.md), [queue review](../archive/operations/paseo-bm-mission-queue-review-20261025.md), mockup [mission-lanes.html](mockups/mission-lanes.html)) |
| 2026-10-25 | Claude (as built) | §19.11: ADR-038 as built, WP-11.1 → WP-11.7 (beads `bm-lanes-9cjg.1` → `.7`) |
| 2026-10-25 | Claude (as built) | §19.11: the screen (WP-11.8), M-44 and the close of ADR-038 Phase 11 (beads `bm-lanes-9cjg.8`, `.9`) |
| 2026-10-25 | hieu.nt10 (owner's three answers after a field case; written by Claude) | §19.12 added: `bm_tell_worker` `about`, steer only for corrections, outdated Mains handed over when idle ([ADR-039](../adr/ADR-039-new-work-never-into-a-busy-worker.md)) |
| 2026-11-05 | hieu.nt10 (owner request; written by Codex) | §5.1, §5.5, §17.2: completed-review baselines across implementation batches, fix-only fallback briefs, optional per-call brief persistence, and affected checks without a full-suite finish gate ([ADR-041](../adr/ADR-041-incremental-review-and-affected-checks.md), `bm-eb46`). `design-ready`: PASS; backward compatibility and isolated Git/role/contract proof specified. |
| 2026-11-10 | Claude (review b2 of the mission line, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md)) | §4.6: a reported commit counts as a change, and only the chain's Workers' records are read; §9.1: a record carrying the owner's decision or words is never a note |
| 2026-11-10 | Claude (review b3 of the mission line, [ADR-045](../adr/ADR-045-a-mission-runs-as-a-supervised-line-of-approved-steps.md)) | §19.6: an unreadable agent list holds the slot; a head idle past the stall window is a stall stop; a dropped notice is told again; a release or a cancel re-tells what its failure still stops |
| 2026-11-16 | Claude (owner request: documentation review) | Checked against the code and condensed. The "As built" sections (§2.8, §3.8, §4.10, §5.7, §6.8, §7.5, §8.6, §9.5, §17.5, §18.8, §19.11) are folded into the sections they describe and left as pointers; §2.1, §6.1, §6.7, §14 and §15 are pointers; §19.9 is summarised; rejected alternatives and field narratives are cut. Corrected to the code: the chain resolver's users, `openContinuation`'s signature and the brief block; `inCharter`, `placementOf` (lane 1), placements folded into their repo; the descriptor read by `line-state.ts` `descriptorOf`; the integration grant as a mission action that the owner can ask again, the local merge's Revoke; `git remote` holds; the maintenance ceiling for compaction and handoff only; `wakeGate`'s callers; `CODE_SUBJECTS` with `integration` and `local-merge`; the decider rules; the re-review brief and diff bound; lanes by `ensureLane` (no `laneFor`), a merge retried from the governor's pass, no governor figure for overlaps; the held queue in `missions/<id>.held.json` with `bm_hold_cancel { holdId }`; `/bm-worker-new` never steered; `newWorkRefusalOf` and the role-file quotes; the Settings card order; the scenario test sizes; the governor pools have no screen control |
| 2026-11-17 | Claude (owner decision, ADR-051) | §2.6, §6.6: rollover gets the time ceiling, a soft notice that waited `MAINTENANCE_WAIT_MS.rollover` (30 minutes) without the request rolling over becomes `BM-ROLLOVER now`, and a stored `now` is asked again of a later Worker whatever its own figures; §7.1 case 2: the unverified-finish guard retired |
