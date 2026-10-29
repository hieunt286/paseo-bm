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

### 2.1 Today

- `noteReport` (`server/request-registry.ts`) sets `finishedAt` on `finished` and clears it on any later report. The roster reopens on a follow-up (`server/mission-roster.ts` `noteRosterReport`, `noteFollowUp`).
- `bm_tell_worker` (`server/deliver-tools.ts`) sends `Continue <requestId>.` to the request's Worker whatever its phase.
- `manager.md` sends "more work on an area a Worker holds" to that Worker.

So a request is never closed. In the field window, 94.3 % of Worker tokens were read after a request's first `finished`.

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

- For a request created through the plugin's tools (a bound request), `finished` and `stopped` are terminal:
  - `noteReport` never clears `finishedAt`;
  - the roster never reopens;
  - a later `bm_report` on the request is refused with: "Request X is finished; its work goes on as Y" (or "…ask your Main").
- The hand-written path of unbound agents keeps today's reopening. The plugin cannot redirect it.

### 2.4 Continuations

There is one function: `openContinuation(home, prev, { reason, text, figure })` in `server/continuation.ts`. It goes through the existing creation path (`create-worker.ts`: `generate` → `workerBriefOf` → `createPluginWorker` → registry and roster `add` → a journal `worker` line), into the predecessor's placement.

1. **The Main tells a finished request more.**
   - `bm_tell_worker` on a finished request opens a continuation with that text. It returns `{ requestId, continuationOf, workerId, delivery, opened: "follow-up" }`.
   - This is chosen over refusing. A refusal costs a full Main turn, after which the Main creates the Worker anyway. The plugin knows the phase and the Main often does not (ADR-027).
2. **Size rollover (§2.6).** A `finished` that carries `remaining`, after the plugin asked for a rollover, opens a continuation with reason `size`. Its text is the chain root's request, verbatim, followed by "Remaining:" and the list.
3. **Always a new Worker.**
   - A bound Worker's `bm.requestId` label and binding are the authority for its tools, its action boundary, fallback and answer delivery. Re-binding a live agent would move that authority mid-life.
   - A fresh Worker starts at about 130,000 tokens of context anyway (field p50), so reuse would save little. Reuse is not built.
4. **Staffing.** The rule of one live Worker per placement is unchanged. The predecessor's request is finished, so it no longer counts.

### 2.5 The continuation's brief

`workerBriefOf` gains a block after the Main's line. It is built from the stores with the handoff brief's helper (`fallback-handover.ts` `workerHandoverFacts`), masked, and capped at the handoff brief's size. The block holds:

- `continues: <prev> (<reason>: <figure>)` and `chain: root <id>, request <n>`;
- from the predecessor's final report: tier, `beadsClosed`, `beadsReady`, `reviewFindingsOpen`, `decided`, `suggestions`, `buildAndTests`, and `remaining` (for a size rollover);
- the `feature:<slug>` labels of the chain's beads, which are still in `.beads/`;
- the chain's unsettled questions ("their answers come to you") and live links (§2.7);
- the placement and its branch (§3.4);
- the mission lines, as today.

### 2.6 Size rollover

*Since 2026-10-23 ([ADR-036](../adr/ADR-036-no-agent-waits-on-machines.md)):* a context figure, `rollover.contextTokens`, joins the figures below (§17.3).

New Coordination settings (`shared/coordination.ts`):

| Key | Default | Bounds | Basis (field 2026-10-15 → 20) |
|---|---|---|---|
| `rollover.enabled` | true | — | the owner's switch |
| `rollover.beads` (closed in the request) | 15 | 3–100 | the most closed at a first `finished`; equals `governor.beadsPerRequest` |
| `rollover.turns` | 40 | 10–500 | twice the p95 turns at a first `finished` (18) |
| `rollover.tokens` (read) | 50,000,000 | 10M–1G | just above the most read at a first `finished` (46M) |
| `rollover.ceilingFactor` | 2 | 1.5–5 | where soft becomes hard |

- **Soft.** At a Worker's recorded turn end (the hook the handoff uses), once a figure is reached, the plugin queues `BM-ROLLOVER soft` once per request: "Finish the bead in progress, review as your tier says, and report `finished` with `remaining`; paseo-bm opens the continuation."
- **Hard.** At `ceilingFactor` × any figure, it queues `BM-ROLLOVER now`: "Report `finished` with `remaining` at the end of this turn; put the work in progress in `remaining`." This is delivered at once (§6.4).
- **What carries over:**
  - A review batch never crosses requests. `finished` with a verdict in flight is still refused, as today. Open findings become `remaining` items.
  - At the soft figure, the Worker settles its open questions and links before it finishes.
  - At the hard figure they move instead:
    - a `size` finish skips expiring its questions and closing its links;
    - decision delivery and peer links resolve a request to its chain head (`chainHeadOf`);
    - `peer-links` gains `moveRequest`.
- **Handoff stays the backstop** for one oversized step. Its 150M threshold sits above the hard rollover ceiling of 100M.

### 2.7 The chain everywhere

- **The Main.** The `finished` delivery gains `continued: <new> by Worker <id> (<reason>: <figure>)`. No new notice.
- **Mission state.** A request carries `continuationOf`/`continuedBy`. A finished request with `continuedBy` reads "finished → `<id>`".
- **One resolver for chains.** `chainHeadOf(requestId)` is used by everything that resolves a request to its live Worker:
  - decision delivery;
  - peer delivery;
  - fallback;
  - `bm_tell_worker`;
  - the action boundary's request lookup.

  Every `soleWorkerOfRequest` caller is audited.
- **Governor.**
  - `stalled` leaves out a request with `continuedBy`.
  - Figures per request count a chain's members separately, while `finishedSinceCriterion` counts a chain once.
- **Screens.**
  - Missions › In flight shows "continues `<id>`".
  - Projects › Requests shows the chain on its head, with the chain's total tokens.
  - This needs an update of the approved mockup (`docs/design/mockups/mission-runtime.html`, artboards G and H) before code (§12).

### 2.8 As built (Phase 7, 2026-10-21)

**Terminal finished (WP-7.1)**
- **Bound** means the registry's `source: "tool"` (`isBoundRequest`).
- **Refusal texts:** "Request X is finished; its work goes on as Y. Nothing was stored or sent." and "…; ask your Main. Nothing was stored or sent."
- **Stopped** is final on the roster. A late report is refused only after `finished`.

**Continuations (WP-7.2)**
- **Who opens one.** `bm_tell_worker` on a **finished or stopped** bound request opens it, with the figure "a follow-up after finished" or "…stopped".
- **Order of writes.** `continuedBy` is written only after the new Worker exists, and `noteContinuedBy` stores `rollover` on the old request.
- **Journal line:** "Worker `<id>` for request `<B>` in `<ws>` (continues `<A>`): `<topic>`".
- **Chain resolution.**
  - `chainHeadOf` and `chainOf` live in `server/waits.ts`, and `soleWorkerOfRequest` resolves `chainHeadOf` first. So the chain is followed by decision delivery, the Ask's asker, overrides, the review-budget sweep, and peer askers and answerers.
  - The action boundary keeps the binding as its authority.
  - `bm_link_workers` refuses a continued request.

**Size rollover (WP-7.3)**
- **When a finish counts as a size finish.** The registry records `rolloverAsked { level, figure, at }`, and a `finished` with `remaining` is a size finish only when it is set.
- **Figures** read "16 beads closed", "41 turns" or "100M tokens read".
- **Who gets the notice.** It goes to the newest Worker, once per level.
  - The soft notice is not sent to a Worker waiting by structure; it is retried later.
  - The hard notice passes the wake gate as `rollover-now`.
- **`remaining`** is accepted only on a bound `finished`, at most 30 items.
- **The continuation's request** is the root's request, read from its first Worker's brief, followed by "Remaining:". When those words cannot be read it says "The request of `<root>`; paseo-bm could not read its words."
- **The `continued:` line** is added to the Main's delivery right after `BM-DELIVERY report <id>`, at delivery time. It is not stored.
- **A size finish settles no waits.** They settle when the chain's head ends ("req-A finished as req-B").

**The screens (WP-7.11)**
- **Data.** A request carries `chainPosition` (mission state, `traces.list`).
- **"continues …"** shows only on a request that nothing continues yet, and "nth of its chain" only from the third.
- **Projects › Requests** is a list of cards, not the table artboard K drew. The chain line sits under the card title and the chain's tokens join the cost line. "hide the chain" shows when the chain is open. The chain total shows only when the earlier requests are on the loaded page.

## 3. A branch per mission (REQ-210, ADR-035 decision 2)

### 3.1 Identity: the repo key and the placement

- Request-level mechanics follow the **placement**:
  - bindings, the registry (`requests/<placement>.json`), the roster entry's `workspaceId`, the outbox, traces, `writers-watch`, decisions and `h:` grants.
  - Paseo reports an agent's workspace as the placement, and request ids are unique across workspaces, so these need no change.
- Owner-level settings follow the **repo key**:
  - policy cells, levels and the action boundary;
  - precedents, project memory and charter membership;
  - contracts and peer links.

There is one resolver, `server/placements.ts`:

- `repoKeyOf(home, workspaceId) → string`:
  - the repo key of a placement, else the id itself;
  - synchronous, memoised on the mission index's stamp.
- `placementOf(home, missionId, repo) → Placement | null`.
- `inCharter(mission, workspaceId)` = `charter.repos.includes(repoKeyOf(workspaceId))`.

The resolver is fed by `missions/index.json` `placements: { [placementId]: { missionId, repo } }`, rebuilt with the index.

Readers that change (each passes its workspace id through `repoKeyOf`):

| Reader | Change |
|---|---|
| Precedent resolution (`precedent-resolve.ts`; `precedents.ts` `activeFor`) | by repo key |
| Policy, levels, challenger, boundary | A new `effectivePolicy(home)`: the stored policy plus a read-only alias from each placement to its repo's cells. Used in the enforcement readers only: `action-boundary.ts` `decide`, `boundary-off.ts`, the Worker watch's scope, `role-instructions.ts` `creationProjectOf`. Settings keeps `currentPolicy`, so a placement never shows as a project |
| `creationProjectOf` | returns `{ workspaceId, repoKey, boundary }` |
| Memory (`memory-store.ts` file, `memory-tools.ts` checks, the brief) | by repo key |
| Charter membership (`missionRepoOf`, `outsideCharterOf`, the governor's `outsideCharter`, `memory-tools`) | `inCharter`. Without it, every placement request reads as outside its mission |
| Contracts' `providerRepo` / `consumerRepos`, peer links `to.workspaceId`, `bm_mission_update` repos, `bm_ask_project` | normalised to the repo key where they are written and compared |
| The Main's `bm_repo` | reads the mission's placement of the repo (its own branch); the Orchestrator's keeps the root |
| `missionOfWorkspace` | an exact placement match returns its mission, so a Manager opened in a worktree never starts a legacy mission |
| Work launcher, `classifyWorkspaces` | a placement shows nested under its repo |

### 3.2 The record (additive, on the mission)

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
}>
```

### 3.3 Creation

- **When.**
  - A placement is created lazily, at the first `bm_create_worker` for a repo of the mission that has no `ready` placement. It is not created when the mission starts: cloning a 1.3 GB dependency tree is wasted on a repo the mission never touches.
  - From the cut-over (§4.8), no mission request is created in a repo's root.
- **The integration branch.**
  - Default: the root checkout's upstream, read with read-only git: `git rev-parse --abbrev-ref @{upstream}`, then the remote prefix is removed.
  - If that fails, it is `git symbolic-ref refs/remotes/origin/HEAD`. If that also fails, the creation is refused with "set the integration branch on the mission page".
  - It shows on the mission page and can be changed there. The integration card (§4.3) names it, so the owner's yes confirms it.
- **The call:**

  ```ts
  paseo.workspaces.create({
    requestId: `bm-place-${missionId}-${repoKey}`,
    title: `${code} · ${repoName}`,
    source: { kind: "worktree", cwd: rootDirectory, projectId: root.projectId,
              action: "branch-off", baseBranch: base, branchName: branch, worktreeSlug } })
  ```

  Paseo runs `git worktree add -b <branch> --no-track <base>` under `~/.paseo/worktrees/`.
- **Idempotence** (checked by spike S1, [spikes record](../archive/operations/paseo-bm-delivery-line-spikes-20261020.md)):
  - Paseo de-duplicates only a byte-identical body under the same `requestId`. The same `requestId` with any other change returns `workspace_request_key_conflict`.
  - A taken branch name is not suffixed: Paseo silently uses the slug as the branch, and only folders get `-N`.
  - A branch that exists only on origin is not detected.

  So:
  1. Write `state: "creating"` with the fixed `requestKey` and the exact body before the call. A retry resends that body.
  2. Before the call, check `refs/heads/<branch>` and `refs/remotes/origin/<branch>` with read-only git. If either exists and is not ours, the branch becomes `m/<code>-<missionId tail 4>/<slug>`.
  3. After the call, the create response's `gitRuntime.currentBranch` (always filled) must equal `branch`, and its `projectId` must be the root's. Otherwise the placement is `failed` and the owner gets one line.
  4. On a reload, a `creating` placement is adopted from `workspaces.list` (same folder, or `project.checkout.currentBranch`), or retried with the same `requestId` and body.
  5. If the branch is recorded but its workspace was archived, it is re-created with `action: "checkout"`, `refName` the branch, and a new `requestId`. The archived one's `requestId` answers `directory_not_found`.
  6. The title is part of the body. A rename later uses `setTitle`, never a new create.
- **Agents.**
  - `bm_create_worker` resolves `project` (a repo key) to the placement and creates the Worker there.
  - The Reviewer of a placement's request is created in the same placement.
  - A handoff successor uses the request's placement, as today.

### 3.4 What agents are told

- **The Worker brief** gains these lines:
  - `worktree: <dir> on branch m/ABC/fe (integration: develop)`;
  - `commit: on this branch at finished and rollover`;
  - `push and merge request: allowed since <time>`, or `ask the owner (paseo-bm does, at your first finished)`.
- **Runtime facts** gain `Integration: <branch> → <target>; commit: yes; push/MR: yes|no`. A `BM-SETTINGS` notice refreshes it when the grant changes.
- **`bm_mission`** shows each repo's placement: folder, branch, target, state.

### 3.5 Dependencies in a fresh worktree

These facts about Paseo 0.8.0 were read in the daemon:
- `paseo.json` `worktree.setup` runs in the background after a worktree workspace is created through the API. There is no trust gate for branch-off; there is one only for fork checkouts.
- A failed setup leaves the workspace in place.
- The plugin cannot read the setup status: it is not on `PaseoApi`.

The plugin's rules:

1. **The repository's own setup wins.** The setup Paseo runs comes from the base's committed `paseo.json`, else from the root's working-tree file, which Paseo copies in (spike S1). If either has `worktree.setup` (`git show <base>:paseo.json`, then the root's file), the plugin does nothing more and never writes that file.
2. **Otherwise the plugin clones.**
   - Right after creation, the plugin's server makes a copy-on-write clone (`cp -c -R`, APFS) of each path on the repo's list. The default list is `node_modules`, plus `.nx/cache` when present. The owner can edit the list on the mission page.
   - It clones only when the dependency manifest at the base equals the root's: `git show <base>:<lockfile>` hashed against `<root>/<lockfile>`, for `yarn.lock`, `package-lock.json` and `pnpm-lock.yaml`.
   - This is part of creating the placement, not a Worker step. It is local, with no network and no package manager, so it is not a dependency install under Worker rule 1.
   - The result goes in `placement.deps` and the journal.
   - Measured: 73 s for the frontend's 1.3 GB, with a passing project test afterwards (spike S3). The brief says `dependencies: being prepared` until it ends.
3. **Fallback.** No plain copy and no symlink. A symlink would let an install write the owner's checkout.
   - The cases: the clone fails (another volume, clone unsupported) or the manifests differ.
   - The brief then says `dependencies: not prepared — installing them is a dependency install`.
   - The Worker asks, or the repo's `dependency` class covers it.
4. **Gradle and similar tools** keep their caches in the user's home. Nothing is cloned for them.

### 3.6 Lifecycle

- **A repo leaves the charter.** Its placement is `retired`: no new agents, history kept. The owner gets an archive card.
- **The mission closes.** Every placement is `retired`. One owner card lists each with its uncommitted, unpushed and merge-request state.
- **Archiving is the owner's, never the plugin's.**
  - Paseo's archive archives every agent of the workspace, which ADR-005 forbids the plugin.
  - It also runs `git worktree remove --force`, which drops uncommitted changes.
  - The card warns when the tree has uncommitted changes and offers "commit first" as the default.
  - `on("workspace.archived")` sets the placement to `archived`.
- **On a reload**, placements are reconciled with `workspaces.list`. An archived placement with active requests refuses new agents and offers "re-create from the branch".

### 3.7 Within a placement

- **Staffing** is one live Worker per placement, the same count as today's per repo. Delegated `staffing` lets a second Worker share the worktree. *Since 2026-10-25 (§19.1):* independent work takes a lane of its own, up to 7 per repository, instead of sharing lane 1's tree.
- **`writers-observed`** keeps watching inside a placement.
- **Cross-mission writer collisions retire** (`governor-conflicts.ts` `writerConflictsOf`). They can no longer happen.

### 3.8 As built (Phase 8, 2026-10-21)

**The resolver (WP-8.1)**
- **Functions:** `placements.ts` provides `repoKeyOf`, `placementOf` (the newest record, in any state), `inCharter(home, mission, ws)`, `effectivePolicy`, `placementOfWorkspace` and `placementBlockOf`. It is memoised on the index file's stamp.
- **Policy readers.** `effectivePolicy` serves every reader that decides who answers or what is covered:
  - the action boundary, the boundary-off check and the event scope;
  - `authority-facts`, `command-authority`, `decision-override` and `orchestrator-decide-tools`;
  - the findings and the `BM-SETTINGS` boundary line.

  Settings keeps `currentPolicy`. Prepared changes check and write by repo key.
- **Project lists.** Placements are left out of the project lists rather than drawn as a nested row. `bm_projects` folds a placement into its repo, and its requests name their `workspaceId`.

**Creation (WP-8.2)**
- **Names.** The branch is `m/<CODE>/<slug>`, where the slug is the root folder's name in lower case. The worktree slug is `m-<code>-<slug>`, or `m-<code>-<tail>-<slug>` when the branch name was taken. Later records of a repo use the request ids `bm-place-<mission>-<repo>-2`, `-3`, and so on.
- **Records.** A retry after an archive or a failure appends a new record. The base is the upstream exactly as git reports it.
- **Brief lines** also read "the repository's own setup (paseo.json worktree.setup) prepares them" and "cloned from the root (node_modules)".
- **The archive card** is an owner-only `m:` decision, subject `worktree-archive`, class `data`:
  - with uncommitted changes: a "Commit first" (recommended), b "Archive it as it is", c "Keep it";
  - with a clean tree: a "Archive it in Paseo" (recommended), b "Keep it".
- **An archived placement** refuses new agents for its own requests. The next `bm_create_worker` re-creates it from the branch.
- **Reconciliation** runs at the first handle, then at most every 10 minutes. The owner's `mission.change` opens archive cards and retitles placements at once.
- **Not built:** setting the integration branch and editing the clone list on the mission page. The default is the root checkout's upstream.

**Migration (WP-8.6)**
- **Files.** `missions/checkpoints.json` records the offers and their outcomes, `placement-mode.json` is `{ since }`, and registry entries gain `movedFrom`.
- **The card** is subject `worktree-checkpoint`, class `data`, `ownerOnly`, effects none. Its options:
  - idle root: a "Checkpoint now" (recommended) or b "Not now";
  - busy root: a "Ask me again once they finish" (recommended) or b "Checkpoint now anyway", with the warning "Still working in it: …".

  "Not now" is final.
- **The checkpoint itself.** It runs on a temporary index in the OS temp folder (`read-tree`, `add -A`, `write-tree`, `commit-tree`, `git branch`), with split index, untracked cache and auto gc off. Its environment is `repo-tool.ts` `gitEnv`. Git runs before the answer is stored, so a git failure leaves the card open.
- **Waiting for the card.** A mission from before the cut-over gets no first placement while its repo's card is unanswered, "later" or failed. *Since 2026-10-21* its Workers then work in the root (`ensurePlacement` returns `inRoot`), and `bm_create_worker` answers `worktree: "not yet: …"` instead of refusing.
- **When the card asks again.** The offer counts a root Worker as busy only while it runs a turn (`busyRequestsOf`). An idle Worker lets the card come back as "Checkpoint now".
- **Handoffs.** A request handed off moves only when the root equals the checkpoint.
- **Identity.** The commit falls back to `paseo-bm <paseo-bm@localhost>` when the repository has no identity, and `commit.gpgSign` is honoured.

## 4. Integration (REQ-211, ADR-035 decision 3)

### 4.1 Commit authority on the mission branch

Worker rule 1 is reworded: "…in a mission's worktree, commit your request's changes on the mission branch at `finished` and at a rollover. Push that branch and create or update its merge request only when Integration says yes. Merge, force-push, rewriting pushed history, deleting a branch, and committing anywhere else stay the owner's."

The Main's line that "one repo's Workers share" the tree becomes "a placement's Workers share it; another mission's work is on its own branch".

### 4.2 What the action boundary classifies

`BoundaryContext` gains `mission?: { directory, branch, target, remote: "origin" }`. It is built from the request's placement in `action-boundary.ts` `decide` and in the Worker watch. `classifyCommand` (`effectful-actions.ts`) adds these rows:

| Command | Finding |
|---|---|
| `git push`, in the placement, to `origin`; destination the mission branch, `HEAD`, or none while on the branch; no `-f`, `--force*`, `--delete`, `--mirror`, `--all`, `--tags` | `git push <branch>` · `push` · `integration: true` |
| any other `git push` | as today: `push` |
| `git commit`, `merge`, `cherry-pick` or `revert`, in the placement, on the mission branch | none |
| the same outside the placement (`-C`, or `cd` into another checkout) | `outside-workspace` |
| the same on another branch; `git switch`/`checkout` to another branch, `rebase`, `reset --hard`, `branch -D`/`-m` in the placement | `git <sub> off the mission branch` · `commit`, held |
| `glab mr create` or `glab mr update` with source the mission branch (or omitted) and target the integration branch | `glab mr <sub>` · `push` · `integration: true` |
| `glab mr merge`, `approve`, `close`, `delete`, `rebase`; `glab ci run`, `retry`, `cancel`, `delete`; `glab api` | `push` (merge) or `network`. Never covered by the standing grant |
| `glab mr view`, `list`, `diff`; `glab ci status`, `view`, `list`, `get`, `trace`; `glab pipeline list`, `status`, `view` | `glab (read)` · `network` · `forgeRead: true` |

`gh pr create`/`edit` get the same treatment as `glab mr create`/`update`. The new actions join `EFFECTFUL_ACTIONS` and `ACTION_EFFECTS`, so the Worker watch's `danger` and A-6 see them. A command whose destination cannot be parsed stays held, never covered.

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

- **Asked once.** The first time a placement's request reports `finished` with a commit and the placement has no grant, the plugin opens an `m:` decision.
  - Card text: "Push `m/ABC/fe` and open its merge request into `develop`? Later pushes and updates of this merge request are then covered; merging stays on GitLab."
  - Options: a "Yes, for this mission and repository"; b "Not now — keep committing locally".
  - It is `ownerOnly`. No policy, level, Main, Orchestrator or precedent answers it.
  - Answer a carries the prepared change `integration.grant { missionId, repo }`. The decision is reopened only by the owner, from the mission page.
- **The boundary.** In `decide`, after the one-time grants and before the policy, a new step `integrationCoverOf(findings, placement)` runs:
  - it allows only findings with `integration: true` or `forgeRead: true`;
  - only while the grant is `granted` and its scope matches the context;
  - each use is written to the journal, and nothing is spent.
- **The Worker watch** passes the grant as covering `push` only for findings marked `integration`. A push to any other branch still raises `danger`.
- **Shown and revoked.**
  - The mission page's repo row reads "Push & MR: allowed since 10:42 · Revoke".
  - `mission.integration.revoke { missionId, repo }` sets `revokedAt`, sends `BM-SETTINGS` to the placement's live Workers and journals a `decision` line.
- **With the boundary off** (the default, autonomy design §D.5), rule 1 and `danger` are the guards, as for every push today. The grant is what makes a push allowed: a push without it is a `danger`.

### 4.4 The report's git fields

These are additive. `bm_report` is a consumed contract, so the old shape is still read.

- `ReportInput` and `REPORT_SCHEMA` (`shared/bm-tools.ts`) gain `integration?: { branch, commit /* 7–40 hex */, pushed: boolean, mr?: url, ci?: "none" | "pending" | "success" | "failure" | "not-run" }`.
  - `buildReport` writes the lines `branch:`, `commit:`, `pushed:`, `mr:` and `ci:`.
  - `REPORT_KEYS`, `parseReports` and `parsedReportSchema` read them.
- **Refusal.** A bound Worker in a placement that sends `finished` with `filesChanged` and no `integration.commit` is refused with "commit on `m/ABC/fe` and report its sha". Nothing is stored.

### 4.5 Reading the line's state

*Since 2026-10-23 (ADR-036):* with `integration.ci` off (the default), CI is not read, shown or waited on (§17.1).

- **Paseo's descriptor.** `paseo-directory.ts` `listedWorkspaces`, the one reader, also keeps these fields of each worktree workspace:
  - `projectId` and `workspaceKind`;
  - `gitRuntime { currentBranch, isDirty, aheadBehind, aheadOfOrigin, behindOfOrigin }`;
  - `githubRuntime.pullRequest { url, state, mergeable, isMerged, checksStatus, checks }`.

  Facts about how the daemon fills them:
  - Paseo fetches every 180 s and polls checks every 20 s while they are pending.
  - `aheadBehind` is measured against the stored base branch.
  - `aheadOfOrigin` stays empty until the first `push -u`.
  - GitLab's merge request and CI fields are filled only through the `glab` CLI, installed and logged in.
- **The primary source is read-only git**, because the descriptor's `gitRuntime` disappears from `workspaces.list` after a git change unless some client holds a `workspace_update` subscription (spike S1).
  - The plugin's read-only git in the placement: `rev-list --left-right --count origin/<target>...HEAD`, `status --porcelain`, `log -1 --format=%cI` and `rev-parse HEAD`.
  - The descriptor's fields are used when present.
  - Merge request and CI come from the Worker's `glab mr view -F json` and `glab ci status` (`forgeRead`), or from `githubRuntime.pullRequest` when it is filled. Spike S4 could not observe a GitLab merge request without opening one, so the first real merge request settles which source applies.

### 4.6 Finished → committed → verified

*Since 2026-10-23 (ADR-036):* with `integration.ci` off, verified means a check paseo-bm detected in the request's own turns; a pipeline is never evidence (§17.1).

- **Committed.** A placement request's `finished` counts as committed when the plugin confirms all of these: the reported sha is an ancestor of `HEAD` (`merge-base --is-ancestor`), the current branch is the mission branch, and the tree is clean apart from ignored files. Otherwise the Main's delivery reads "finished, uncommitted".
- **Verified.** It is verified when the merge request's `checksStatus` is `success` on a head that contains the sha (pushed, with `aheadOfOrigin` 0). Before a merge request exists, a check the plugin detects (`shared/evidence.ts`, unchanged) is enough. `failure` reads **CI red**.
- The target repositories' CI runs only on a merge request or a tag. So the CI of record exists once the merge request exists.

### 4.7 Conflicts surface at integration

- **The Worker's "update the branch" step**, in `worker.md` "Proving a change". It runs before a push, and when the brief or `BM-SETTINGS` says the branch is behind or conflicting:
  1. `git merge origin/<target>` in the placement. Paseo has already fetched.
  2. Resolve conflicts inside the request's scope, run the checks, and commit the merge. That commit is covered: it is on the mission branch.
  3. Never rebase pushed history.
  4. If a conflict needs a choice about another mission's merged change, send `blocked` with a question for the Main.
- **The governor's early signal.**
  - It is computed from a read-only `git diff --name-only origin/<target>...<branch>` for every open placement of one repo, keyed by repo key. An overlap between two of them is an "expect a merge conflict" `mission.conflict`.
  - It replaces the trace-area source `charterConflictsOf`. `linkConflictsOf` stays.
  - `bm_arbitrate` is unchanged. The other mission's Worker merges after the winner's merge request lands.
- **Beads.** `.beads/issues.jsonl` is tracked in the target repositories and sorted by id (spike S2, proved by `test/beads-merge.test.ts`, WP-8.7).
  - New beads merge cleanly only when they land in different gaps of the file.
  - Two new beads in one gap, or a new bead next to a line both sides changed, fall in one conflict hunk.
  - The rule at the "update the branch" step, **per line, never per hunk:**
    1. In a conflict hunk keep one line per id: the integration branch's line for an id both sides have, and each side's own line for an id only it has. Keep the file sorted.
    2. Commit the merge.
    3. Run `br sync --rebuild`, so the committed file replaces the worktree's database. Without this, br's next write exports the request's older row and drops the integration branch's change.
    4. Re-apply the request's own change with `br`.

  Taking the integration side of a whole hunk loses beads. Rebuilding before step 1 holds deletes them for good. `br` imports the file in a fresh worktree. No merge driver is needed.
- **Retired.** Cross-mission writer collisions, and file negotiation between missions' Workers. The Mains invented that practice; no code implemented it.

### 4.8 Migration of missions on a shared checkout

1. **Cut-over.** On its first start, the build writes `missions/placement-mode.json { since }`.
   - A mission created after it gets its worktree at its first Worker.
   - A Worker already running in a root keeps its request and finishes in place.
   - *Since 2026-10-21 (field case):* a mission from before the cut-over is never stalled by the checkpoint. While its repository has no usable checkpoint, its new Workers are created in the root, as before the cut-over. The brief says "worktree: not yet — this mission works in the shared checkout until its checkpoint is made; paseo-bm moves new Workers to the mission's worktree after it.", and there is no Integration line. Once the checkpoint exists, new Workers go to the worktree.
2. **The checkpoint card** (owner only).
   - It is offered once no mission Worker runs in the repo's root. "Checkpoint now anyway" is an option, with the warning that later shared-tree edits need a follow-up checkpoint.
   - A tap creates the branch `bm/checkpoint-<yyyymmdd>` without touching the owner's HEAD, index or working tree. A temporary index is used for `read-tree HEAD`, `add -A`, `write-tree` and `commit-tree -p HEAD`, then `git branch`. This respects `.gitignore` and writes only objects and one ref.
   - It is the plugin's only write into the owner's repository, done on the owner's explicit tap (ADR-035 decision 3).
3. **Placements from the checkpoint.** Each open mission with that repo gets a placement with `base = bm/checkpoint-…` and `target` = the integration branch. The base is the checkpoint **branch**, never its sha: Paseo measures `aheadBehind` only against a branch (spike S1).
4. **The card's advice** (the owner's action, not the plugin's): push the checkpoint branch and merge its own merge request first. Each mission's merge request then shows only its own changes. The owner tidies the shared checkout afterwards; the plugin never does.
5. **Successors.**
   - A new request uses the placement.
   - A handoff of a request from before the cut-over moves it: `registry.move(fromWs, toWs, requestId)` plus the roster's `workspaceId`. This is safe because ids are unique.
   - If a shared-tree Worker finished with changed files after the checkpoint, the plugin offers a follow-up checkpoint, parented on the previous one.

### 4.9 Mission state, governor and screen

- **Mission state.** `MissionState.placements[]` holds `{ repo, name, workspaceId, branch, target, state, dirty, ahead, behind, lastCommitAt, pushed, mr: { url, state, mergeable } | null, ci, grant: { at } | null }`.
  - It is drawn as one line per repo in the Main's state text, within the 6,000-character cap.
  - A request carries `committed` and `verified` (§4.6).
- **Governor figures** (`shared/governor-figures.ts`; thresholds in the governor settings):

| Figure | Family | Rule (default) |
|---|---|---|
| `uncommittedHours` | mess | dirty with no live Worker, ≥ 4 h after the last `finished` |
| `unpushedNoMr` | stuck | ahead > 0 with no merge request, ≥ 24 h |
| `ciRed` | stuck | `checksStatus` failure, ≥ 30 min |
| `mrConflicting` | stuck | the merge request is not mergeable for conflicts |
| `behindIntegration` | drift | behind the target by ≥ 50 commits |

- **Screen.**
  - The mission page's repo row shows: the branch, ↑ahead ↓behind, an uncommitted dot, the merge request link and state, CI, and "Push & MR allowed · Revoke".
  - The contracts get `missionRepoSchema.placement`.
  - A mockup comes before the code (§12).

### 4.10 As built (Phase 8, 2026-10-21)

**The boundary and the grant (WP-8.3)**
- **The grant action.** `integration.grant` is a mission action kind, not a prepared change, so only the owner's tap answers it.
- **The card:** subject `integration`, class `release`, `ownerOnly`. Option a "Yes, for this mission and repository" declares `push`; option b "Not now — keep committing locally" declares `none`. It is never reopened.
- **New actions, all `push`:** `glab mr create`/`update`/`merge`, and `gh pr create`/`edit`/`merge`.
- **When a push is covered.** It must name `origin`, and only harmless flags are kept. `-c`, `--git-dir`, `--work-tree` and `GIT_*` assignments are never covered.
- **Held as `outside-workspace` in a placement:** `git remote` and `git config remote.*`/`url.*`/`push.*`.
- **Every `glab` command** is classified (network, push or forge read), so `glab` is no longer invisible to the boundary.
- **The result** is `allowed-integration`, and each use is journaled.
- **`BM-SETTINGS`** goes to the placement's Workers on a grant and on a revoke. The Main is told on a grant and on "Not now". The RPC is `mission.integration.revoke { missionId, repo } → { revokedAt, notified }`.

**The report (WP-8.4)**
- **The refusal** uses the field-issue form, "commit on `<branch>` and report its sha".
- **The Main's line** reads "finished, committed on `<branch>`[; verified | ; CI red | ; CI pending]." or "finished, uncommitted: `<why>`."
- **`line-state.ts`** provides `lineStateOf` (adding `aheadOfOrigin`), `committedOf`, `verifiedOf` and `descriptorOf`. A committed finish costs about seven read-only git calls.

**State and governor (WP-8.5)**
- **The cache.** `line-watch.ts` refreshes each placement at most once a minute, on the governor's 60-second pass. Turns and the mission state read the cache.
- **Settings:** `governor.uncommittedHours` (4), `unpushedHours` (24), `ciRedMinutes` (30) and `behindCommits` (50). `mrConflicting` fires at ≥ 1, but only where the descriptor reports it, which on GitLab is not yet.
- **The Main's state** gains a "Lines:" section after In flight.
- **Conflict evidence** reads "expect a merge conflict: PAY (m/PAY/repo-a) and WEB (m/WEB/repo-a) both change … against origin/develop".

## 5. Review by milestone (base REQ-037, ADR-035 decision 4)

### 5.1 Milestone batches

| Milestone | Tier | Stages | Scope | When |
|---|---|---|---|---|
| `plan` | Large | `plan`, `beads`, plus `documents` if written | the plan, its documents, the bead graph | once, before `beads-done` |
| `wave` | Medium, Large | `implementation` | the diff since the previous implementation batch's base commit (for the first, the request's base), the beads closed in it, the checks run | after the last bead of a planned wave, when more waves follow |
| `finished` | Medium, Large; Small only on the owner's ask | `implementation` | the diff since the previous implementation batch, and every check of the request | before `finished` |

- **No bead has a review of its own.** A bead closes on its checks. Where the `implementing-beads` skill asks for a review before a close, the milestone batch is that review (`worker.md`).
- **`bm_create_reviewer`** gains optional `milestone` and `since` (a commit). When `milestone` is absent it is derived: `plan` when the stages include `plan` or `beads`, else `finished`. It is stored on `batches[].milestone`.
- **Refused:**
  - a second `plan` batch after one passed;
  - a `plan` batch below Large ("Only a Large request reviews its plan; nothing was created").

### 5.2 Convergence

*Since 2026-10-23 (ADR-036):* a re-review is done by a fresh Reviewer on the diff of the fixes, from tree snapshots paseo-bm records at each review call (§17.2).

`bm_rereview` is allowed, asking no one, when all of these hold:
1. the batch's latest result is `changes-required`. A `pass` refuses: "Batch b2 passed: nothing to re-review".
2. the batch has had fewer than `review.maxRereviews` re-reviews (1–6, default **3**).
3. from the second re-review on, the latest blocking count is **strictly lower** than the one before it. An unknown count never counts as lower.
4. the request is under its cap (§5.3).

- **Blocking counts.**
  - They are stored on the batch: `batches[].results: [{ at, recordId, verdict, blocking: number | null }]`, appended by `bm_review` from the report's `blockingCount`, by the unbound final-answer path, and as `null` on no-verdict.
  - They are not read from the outbox, which keeps records for 7 days.
  - An older batch falls back to the trace's `reviews[]` by `batchId`.
- **When it stops converging**, the refusal reads: "Batch b2 stopped converging (blocking 3 → 3)" or "Batch b2 had its 3 re-reviews". It goes on: "Fix what you can and open the next milestone batch, or send `finished` with the open blocking findings in `reviewFindingsOpen`. Nothing was sent."
  - No question is asked.
  - A finding that would remove asked-for work stays a scope question.
- **Why K = 3.** At the field rates (first round passes 20 %, a re-review 68 %), 2.6 % of batches are left unconverged by chance. The mean is about 2.1 calls per batch.

### 5.3 The cap

```
cap(request) = review.callsPerBatch × min(M, Mmax[tier])
  review.callsPerBatch : 2–6, default 3 (the p92 calls of one batch at the field rates)
  M                    : the request's milestone batches, counting the one being opened
  Mmax                 : Small 1, Medium 2, Large 4
```

- The defaults give at most 3 / 6 / 12 calls, never below the old 2 / 2 / 4. The calls are pooled across the request's batches.
- The count is the Dashboard's (`requestReviewCountOf`).
- One function, `reviewCapOf(tier, milestones, settings)`, is used by the tools, the `review.over-budget` rule (its id is kept), the stall reason, `overrunOf` and the governor.

### 5.4 Past the cap: one owner decision per request

The tool opens the decision through the materialiser before it refuses:
- Id `q:<requestId>:Qn`, subject `review-cap`, class `cost`, **`ownerOnly: true`**. No policy, precedent, Main or Orchestrator answers it.
- Options:
  - a "Allow one more round of batches (+`callsPerBatch` calls)" grants `{ calls }` in the existing grant format;
  - b "Finish as it stands, open blocking findings listed" is recommended when the last batch stopped converging;
  - c "Stop this request".
- `applyReviewCapAnswer` replaces `applyReviewBudgetGrants` in the settlement hook, and acts on the owner's answers only.
- **Once per request.** A second cap hit opens nothing: "The request's review cap is spent and the owner answered Qn; send `finished` with the open blocking findings. Nothing was created or sent."
- **The first refusal:** "Review cap reached for `<req>`: `<calls>` of `<cap>` calls (`<tier>`, `<M>` milestone batches). paseo-bm asked the owner as Qn. Send `blocked` with `waitingOn: [q:…:Qn]`. Nothing was created or sent."

### 5.5 What the Reviewer is told

*Since 2026-10-23 (ADR-036):* the re-review brief is §17.2's.

- **The implementation stage** reviews exactly the milestone's scope: the diff since the commit the brief names, the beads closed in it, and the checks reported. The Reviewer runs the tests itself when it can.
- **A re-review** of the same `batchId` checks the previous blocking findings against the diff since the last review, and that the fixes broke nothing. A new blocking finding is reported only where a fix introduced it. A finding still open keeps its location and wording.
- `rereviewLineOf` adds `since: <commit>` from an optional `bm_rereview.since`.

### 5.6 Settings and retirements

- **Settings.** `review { smallBudget, mediumBudget, largeBudget }` becomes `review { maxRereviews, callsPerBatch }`. No migration is needed:
  - unknown keys are ignored and dropped on write, and `version` stays 1;
  - an older build reading a new file falls back to its 2 / 2 / 4;
  - `coordination.set` refuses an old key;
  - a stored prepared change on an old key applies honestly: "this setting no longer exists; nothing was changed" (§7.3).
- **The Settings screen** shows two steppers and the computed caps, read-only.
- **Registry.** `grants` is unchanged. `untilCleanBatch` is read, never written, and no longer exempts calls.
- **The upgrade sweep.** At plugin start, open `review-budget` decisions are withdrawn ("review budgets are retired: paseo-bm asks once, at the request's review cap"). The sweep is idempotent, and the Worker gets the usual withdrawal delivery.
- **Retired:**
  - `REVIEW_BUDGET_SUBJECT`, kept only as `LEGACY_REVIEW_BUDGET_SUBJECT` for the sweep and §7.2;
  - `MAX_REVIEW_GRANT_CALLS`, `policyGrantCapOf`, `policyMayGrant` and the `untilClean` branch;
  - `authority.ts` rules 3–4 for review and `grantWithin`;
  - `reviewGrantRefusalOf` and `grantCap`;
  - `authority-facts.ts` `reviewCapsOf`;
  - in `review-tools.ts`: `liveUntilCleanBatchesOf`, `exemptCallsOf`, `policyGrantCapAt` and `applyReviewBudgetGrants`;
  - `decision-materialiser.ts` `answerBudgetByPolicy`;
  - the "share leaves" refusal;
  - `reviewBudgetLine`, which becomes `reviewCapLine`: "Review: up to 3 re-reviews per batch while blocking findings fall; cap per request: Small 3, Medium 6, Large 12 calls";
  - the tool texts on `untilClean` and "one re-review".
- **Governor.**
  - `reviewBudgetExhausted` becomes `reviewCapReached`, and a new `unconvergedBatches` counts batches stopped by the rule in 24 h. The setting key `governor.reviewExhausted` is kept.
  - The Orchestrator's advice reports pass shares and unconverged batches per tier, against `review.callsPerBatch` and `review.maxRereviews`.

### 5.7 As built (Phase 6, 2026-10-20)

**Tool texts and refusals**
- **No verdict yet.** A re-review whose last review has no verdict yet is refused: "Batch b1 has no verdict on its last review yet: wait for it to reach you. Nothing was sent."
- **After a no-verdict.** A re-review is allowed. An unknown count then fails "strictly lower" ("blocking 3 → unknown").
- **A second `plan` batch** reads: "Plan batch b2 passed, and a request reviews its plan once: open a wave or finished batch instead. Nothing was created."
- **A stage list that does not fit its milestone** is refused, for example: "A plan batch reviews plan or beads, never implementation: the stages … do not fit it; nothing was created."
- **The `review-cap` question** reads "Request `<req>` reached its review cap: …. How should it go on?"
- **Option a declares the effect `cost`**, so the owner's tap asks for confirmation. Options b and c declare none.

**Stored data and counting**
- **Older batches.** A batch from an older build gets no `results`; the trace stays its source. Withheld no-verdicts are recorded too.
- **M** is never counted below 1.
- **Older stored grants.** `reviewGrantSchema` still parses an older `{ untilClean }` grant, which grants nothing.

**Settings and Runtime facts**
- **`coordination.set` on an old key** answers: "`<key>` no longer exists: review.maxRereviews and review.callsPerBatch set the review cap; nothing was saved".
- **Owner texts for a prepared change:** "sets at most N re-reviews per batch" and "sets N review calls per milestone batch". An old-key change answers "change: not applied (this setting no longer exists); nothing was changed".
- **The Settings review card:** steppers "Re-reviews per batch" and "Calls per milestone batch", and the line "Cap per request: Small 3, Medium 6, Large 12 calls".
- **The Runtime facts line** ends with a period.

**The upgrade sweep**
- It runs at the first Paseo handle of a run.
- Its withdrawal delivery, a new notice of kind `withdrawn:<requestId>`, reads: "Qn is withdrawn: review budgets are retired: paseo-bm asks once, at the request's review cap. Do not wait for it."

**Questions and notices**
- **`bm_questions`** refuses the subjects `review-cap` and `review-budget` and has no `grant` field.
- **Worker questions.** A Worker's `review-budget` or `review-cap` question is not opened by the materialiser. Only paseo-bm opens `review-cap`.
- **The `BM-BUDGET` notice** reads "…For your information only: paseo-bm asks the owner itself, once, at the request's review cap…".

## 6. Waits by structure (REQ-212, ADR-035 decision 5)

### 6.1 Today

- An idle Worker gets every delivery at once (`notice-queue.ts`), one message each.
- Each settled question is delivered at once (`decision-delivery.ts`), so an answer to Q1 of three wakes a Worker that only reports `blocked` again.
- `waitingFor` is free text, read back by a regex (`mission-state.ts`, `governor-figures.ts`).

In the field, 278 turns ended `blocked` and read 44.8 % of Worker tokens. The next delivery came a median 0.1 minutes later; 164 of those deliveries were Main messages.

### 6.2 A structured wait

- **The report.** `blocked` keeps `waitingOn` (questions) and `waitingOnPeers` (links), and gains:
  - `waitingOnRequests` (request ids, ≤ 10);
  - `waitingOnBatches` (`^b\d+$`, ≤ 5, each awaiting a verdict);
  - `wakeOn: "all" | "any"` (default `all`).

  `waitingFor` stays free text for the reason. A `req-…` id in it is promoted to structure.
- **The registry's `waiting`:**

  ```ts
  { since, reportRecordId, wakeOn,
    items: [{ kind: "question" | "link" | "request" | "batch", id, settled: boolean }] }
  ```

  It is set by `blocked`, and cleared by any other report or by the wake. A wait with no items (text only) holds nothing, as today.

### 6.3 What settles an item

| Item | Settled by | Where |
|---|---|---|
| question | the decision answered, decided, expired or withdrawn | the decision settlement path |
| link | a reply or message from the other side; the link closed; the link past its ceiling | `peer-tools.ts` `appendMessage`; the stall pass |
| batch | a review or no-verdict record of it | outbox `add` |
| request | it, or its chain head, reports `finished` or `stopped`; its Worker is archived | report `before`; the stall pass |

A settled request or link puts its fact in the wake ("req-X finished: `<summary>`"). The Main therefore stops relaying it.

### 6.4 The hold

- **The gate.** `wakeGate(home, targetId, kind, ref)` returns `deliver` or `hold`. It holds only for a bound Worker whose `waiting` has unsettled items, and only a delivery that settles none of them and is not in the always-at-once list. It is called in:
  - outbox `deliverRecord`;
  - decision delivery;
  - command send;
  - override delivery.
- **Holding.** A held outbox record gets the new state `held`, an open state that survives a reload and is gated again then. A held answer is recorded as `delivery.outcome: "held"`.
- **The release** is one message through a Worker channel that reuses the Main's: `BM-UPDATES <n>`, with the settling item first. One held item alone goes as its own block.
- **Always at once:**
  - the owner's chat, which Paseo delivers directly;
  - `BM-STOP` and stop propagation;
  - every `BM-COMMAND`;
  - `BM-REPLACED`;
  - `BM-SETTINGS` mode changes;
  - `BM-ROLLOVER now`;
  - maintenance (§6.6);
  - `bm_tell_worker` with the new optional `now: true`, for owner words that change the wait.

  A held tell answers `delivery: "held"` with "The Worker waits on Q2 and Q3; it gets this with them."

### 6.5 Stall watcher and governor

- **No stall.** `structuralWaitOf(request, facts)` is shared by the stall watcher and the governor's `waitingOrStoppedOf`. When every unsettled item is live, there is no `idle-unfinished`, no event and no re-wake. Live means:
  - an open question;
  - a running Reviewer, or a call younger than the pending window;
  - an active request with a live Worker;
  - a link under its ceiling.
- **A dead item**, such as a Reviewer gone with no verdict, an awaited request stopped, or a link past its ceiling, settles as a fact and wakes the Worker once.
- **Older reports.** The governor reads `waiting.items` first, and the regex only for older reports.

### 6.6 The maintenance ceiling

- **The rule.** At a recorded turn end (never inside a turn), a pending compaction, handoff or rollover runs **without the safe-point and quiet-queue checks** once one of these holds:
  - its figure is ≥ `maintenance.ceilingFactor` (1.5–5, default 2) × its threshold;
  - it has waited 30 minutes, half its window.
- **Order.** Its item goes as the `first` group of the queue. Queued items wait until after it, and `BM-STATE` goes first.
- **Retries.** A `no-safe-point` drop counts toward `handoff.maxPerRequest`, so a handoff no longer re-arms without end.
- **A Worker waiting by structure** is a natural safe point: its last turn sent a report, and its held items are outside the in-memory queue.

### 6.7 The signal budget (amends mission runtime design §6)

- **§6.1 gains three rows:**
  - `BM-UPDATES` to a Worker: act on each block;
  - `BM-ROLLOVER soft` and `now`: finish, with what remains listed;
  - `BM-DELIVERY message` to a Worker: held while it waits by structure.
- **§6.2:** records to Workers keep one message each, except the release of a waiting Worker.
- **§6.3:** reads `waiting.items`.

### 6.8 As built (Phase 7, 2026-10-21)

**Structured waits (WP-7.4)**
- **Where the waits are written.** They go into the report's `blockers` line ("waiting on requests: …", "waiting on review: b1", "wake on: any"), and `ParsedReport` gains `waitingOnRequests`, `waitingOnBatches` and `wakeOn`.
- **Items** keep `settledAt` and a `fact` of at most 300 characters.
- **Fact texts:**
  - "req-X finished: …" and "req-X stopped: …";
  - "req-A finished as req-B: …";
  - "peer-x answered: …" and "peer-x closed by the asking/answering side";
  - "req-X has no live Worker left";
  - "b1 got no verdict: no Reviewer of it is running".
- **Where questions settle.** In the decision store's `transition`. A superseded question settles nothing.

**The wake gate (WP-7.5)**
- **Kinds always delivered at once:** `owner-chat`, `stop`, `command`, `replaced`, `settings-mode`, `rollover-now`, `maintenance`, `tell-now`. Commands never pass the gate.
- **The release** goes through `main-channel` `enqueueUpdates`, in this order: the settling delivery (if it settles an item), then the facts block, then the held items, oldest first. The facts block reads `BM-DELIVERY wait` / `Continue <req>: what you waited on is settled.`, with one fact per line, newest first.
- **What is held.** Answers and overrides record `delivery.outcome: "held"`. The decision card shows "Held for X: it goes with what the agent waits on."
- **The held tell's note:** "The Worker waits on Q2 and Q3; it gets this with them." With `wakeOn: "any"` it reads "…Q2 or Q3; it gets this with the first of them."
- **Who releases.** `bm_report` releases after storing, and the stall pass's `onWaitsSettled` releases what it settled.

**Structural waits in the watchers (WP-7.6)**
- `shared/structural-wait.ts` holds `structuralWaitOf`. An unknown item counts as not live.
- An open stall alert also clears once the request waits by structure on live items.

**The maintenance ceiling (WP-7.7)**
- **Names:** `maintenance { ceilingFactor }`, `atMaintenanceCeiling()` and `MAINTENANCE_WAIT_MS` (30 min).
- **Order.** The `/compact`, the handoff note request and `BM-ROLLOVER now` go first through `enqueue({ first })`, and `BM-STATE` is always queued first.
- **Retries.** `handoffTriesOf` counts completed handoffs plus no-safe-point drops.
- **No gate call.** Compaction and handoff go through the notice queue, which the wake gate never sees, so a waiting Worker already gets them.
- **A context-share figure** effectively reaches its ceiling by the 30-minute rule.
- **Settings › Coordination** has a Rollover card between Handoff and Review, with the rollover keys and `maintenance.ceilingFactor`.

**Found by the scenario test and fixed (WP-7.9)**

The seeded scenario test found three bugs in this phase's own build, and each one is fixed.

1. **Gate at send time.** The wake gate now also decides when the notice queue sends an item, not only when the item is queued.
   - An item the gate holds at that point goes back to its held state.
   - A `BM-ROLLOVER soft` held this way has its `rolloverAsked` cleared, so it is asked again later.
   - A queued release whose wait was replaced by a newer one is gated again, item by item.
   - An item that meets the wait at send time goes, and the wait is released at the Worker's next report or delivery.
   - A re-held release keeps its facts in memory only, so a reload loses them.
2. **Verdicts after a handoff.** A review or no-verdict goes to the request's current Worker (`verdictTargetOf`) when the Reviewer's parent is no longer the chain head's newest Worker.
   - Only that newest Worker is gated.
   - Records held for a replaced Worker are re-addressed to its successor when the successor's wait is released.
3. **Maintenance at the ceiling.**
   - A `/compact` or note request queued at its ceiling does not expire after 60 seconds; it goes at the agent's next turn end.
   - A compaction keeps `ceilingAt` once it reaches its ceiling, and stays at ceiling until it runs.

**Test sizes.** The scenario runs 3 seeds × 250 Worker turns in the default project, and 2 seeds × 800 in the bench project.

## 7. One question, one decider, honest effects (REQ-213, ADR-035 decision 6)

### 7.1 A decider who can decide

- **The rule in `deciderOf`** (`shared/authority.ts`): a decider other than the owner is named only if at least one option it may choose settles the question without leaving a held effect for the owner.
- **The cases that remain** once the review rules are gone (§5.6):
  1. **The Main on effect classes.** When only the mission delegates `answer-effects`, the Main's answer covers no effect (`grantCoverOf` counts owner answers only), so a push would become a held card anyway.
     - The Main is named only for options with no effects, or when the repo cell delegates the class.
     - Otherwise the owner decides, with the Main's recommendation attached.
     - Letting the Main's answer cover effects would widen a safety boundary. It is not done here.
  2. **The Orchestrator on `f:` incidents.** When `unverifiedFinishRefusalOf` refuses every acting option, the owner is named.

### 7.2 One card per question

- `bm_owner_question` gains optional `about: { requestId?, decisionId? }`.
- **The check.** Before storing, the question is refused when an unsettled `q:` of the mission's roster matches it:
  - explicitly, through `about.decisionId`;
  - or implicitly: the same request (named, or the roster's only active one) and an equal subject or equal normalised text. The materialiser's text match is extracted as `sameQuestionText`.
- **Instead,** the Main's recommended option (matched by key or exact label, else the reason only) is written as `prediction.main` on that `q:`, at every level. The text reads: "Refused: the Worker's question q:`<req>`:Q3 already asks the owner this. Your recommendation (b — `<reason>`) is attached to it. Nothing new was stored."

### 7.3 Effects are stated by what was done

- **`server/effects.ts`** has one function per effect kind: `answerEffect`, `grantEffect`, `changeEffect` (applied, already, failed), `deliveryEffect` (delivered, held, queued, dropped, nothing sent), `recommendationEffect` and `arbitrationEffect`.
  - Each returns `{ applied: EffectRecord | null, sentence }`, built from what was written, never from intent.
- **The call sites that change:**
  - `mission-tools.ts`: "it grants nothing" is false today for a review grant;
  - `decision-delivery.ts`;
  - the tool faces in `shared/bm-tools.ts`;
  - `orchestrator-decisions.ts` and `orchestrator-decide-tools.ts`;
  - `governor-tools.ts`;
  - `decision-rpc.ts`;
  - `command-authority.ts`;
  - `server/prepared-changes.ts`.
- **A guard test** checks that these modules build no "grant", "applied" or "nothing was" sentence outside `effects.ts`.

### 7.4 Precedent-eligible subjects

`shared/question-subjects.ts` holds the one registry:

```ts
export const CODE_SUBJECTS = {
  "review-cap":    { precedent: false, askedBy: "plugin" },
  "review-budget": { precedent: false, askedBy: "retired" },
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
- **Stored precedents** on an ineligible subject stay. `precedents.list` marks each `inert: "<why>"`, and Settings shows it.

### 7.5 As built (Phase 6, 2026-10-20)

**Deciders**
- The mission-only case is rule `mission-effects`. Under it, `bm_answer_worker` refuses an option with effects: "Refused: option `<k>` of `<qn>` declares `<effects>`, which only the owner's answer covers here; choose an option without effects or leave it to the owner. Nothing was answered."
- The `f:` rule needs the fact `finishedUnverified`, which the server does not supply yet. Today's `f:` options never act on a finish, so nothing changes in practice.

**One card per question**
- A recommendation is matched by exact label first, then by key. The reason written is the option's label.
- With no match, nothing is attached: "…Your recommendation (`<label>`) names none of its options, so nothing is attached; give it in your reply to the owner. Nothing new was stored."
- An earlier recommendation stays: "Your earlier recommendation (`<key>` — `<reason>`) stays attached to it."

**Precedent eligibility**
- **Why texts:**
  - `review-cap` "is a question paseo-bm asks you itself, each time; no precedent answers it";
  - `review-budget` "is a retired question; no precedent answers it";
  - each `ownerOnly`, override, held or prepared-change decision has its own text.
- **Refusal endings:** Settings and RPC refusals end "; nothing was saved", and `bm_ask_owner` refusals end "; nothing was stored". Settings shows "Answers nothing: `<why>`."
- **New refusals.** `ownerOnly`, override and held decisions can no longer be saved as precedents from a card.
- **Runtime facts.** Inert precedents are left out of the Runtime facts' "Owner precedents".

**Effect sentences**
- **The functions.** `effects.ts` also exports `citedAnswerEffect`, `missionCardEffect` (with a journal line), `commandDeliveryEffect`, `incidentActionEffect` and `nothingWas`.
- **`bm_answer_worker`'s `said`** is built from the stored decision after delivery: delivered, queued, not delivered, or not delivered yet.
- **Prepared changes.** A prepared change is checked against what the store holds after the write.
- **The guard test** scans the listed modules and `shared/bm-tools.ts`, with five named tool-face exceptions.

## 8. The governor (REQ-214, ADR-035 decision 7; amends orchestrator design §6A, missions design §9)

### 8.1 Pools

- A command entry gains optional `governorStep: "nudge" | "replan" | "arbitrate"` and `by: "code" | "model"`.
- Each pool is counted per mission per 24 h:

  | Pool | Setting | Default (bounds) |
  |---|---|---|
  | Code nudges | `governor.quotaCodeNudge` | 6 (1–50) |
  | Re-plans | `governor.quotaReplan` | 3 (1–20) |
  | Arbitrations (charged to each mission) | `governor.quotaArbitrate` | 4 (1–20) |
  | Others (model nudges) | `governor.quotaOther` | 4 (1–20) |

- No kind spends another's pool. Old entries without a step count in `other`.

### 8.2 Repeats cost nothing

- **Arbitration.** `bm_arbitrate` first checks `isArbitrated(area)`. If a standing arbitration covers the area and both missions, it returns that arbitration, sends nothing and spends nothing: "Area `<area>` was arbitrated as A3 on `<date>` (owner: `<mission>`); nothing was sent."
- **Re-plan.** A re-plan of a family whose last action was a re-plan within the window, with figures no worse, returns that re-plan.

### 8.3 A spent pool degrades

- **Code nudges.** When the code-nudge pool is spent, the family records `held: { pool, until }` and writes one journal line. It stays at its step; the 10-minute retry loop is gone.
- **Daily digest.** Once a day, the Main gets a digest through its channel: the held families, their figures and the charter line. It is not a command and costs no pool.
- **The refusal** reads: "This mission's `<pool>` commands are spent until `<time>`; paseo-bm puts the figures in the Main's daily digest. Nothing was sent."
- **`bm_ask_owner`** with a mission refuses unless one of these holds:
  - a family of that mission is at ladder step 4;
  - the ask carries a goal change or a split;
  - the class is not process.

  The refusal reads: "The governor reaches the owner from step 4; this mission is at step `<n>`. Nothing was stored."

### 8.4 Drift and stalled

- **The trace record** gains optional `trigger: "owner" | "report" | "plugin" | "agent" | null`. The collector sets it from the turn's first received message:
  - the owner's words → `owner`;
  - a report delivery → `report`;
  - other notices, peer messages, relays and governor commands → `plugin`;
  - anything else → `agent`.
- **Drift** counts the Main's turns triggered by `owner` or `report`. Older records count as today.
- **The drift reset** reads a criterion's new `metAt`, which is set only when it is met with evidence (older entries: `at`, when met). A criterion moved back to open, or a status sent again, no longer resets it.
- **`stalled`.**
  - It never applies to a structural wait (§6.5).
  - The alert clears only on progress: a report, a bead closed, a review result.
  - A family returns to step 0 only after its figure stays under its threshold for the 30-minute window.

### 8.5 Older governors

- When it finds more than one Orchestrator agent labelled `main`, the plugin relabels each older one `bm.orchestrator=retired` and retitles it "Beads Orchestrator (retired)". It does this at `agent.created` of a new Orchestrator and once at start.
- It is idempotent, like `REPLACED_BY_LABEL`. Nothing is archived or stopped (ADR-005).

### 8.6 As built (Phase 6, 2026-10-20)

**Command pools**
- Pools are stored as `codeNudge`, `replan`, `arbitrate` and `other`. A model's nudge counts in `other`.
- `by` comes from the send's `governorBy`: the ladder passes `code`, and the default is `model`.
- Only a spent pool holds a family. A missing Main or a failed delivery still retries every 10 minutes.

**Repeats**
- **A repeat re-plan** is one within `governor.windowMinutes` with no crossed figure higher or newly crossed. It is free only when every family it concerns repeats. It answers: "Mission `<code>` was re-planned at `<at>` (command `<id>`) and its figures are no worse; nothing was sent."
- **A repeat arbitration** names the arbitration by its `arb-…` id and dates it `YYYY-MM-DD`.

**The daily digest** is a `message` record from `plugin`, sent through `storeAndDeliver`, at most once per 24 h. Its times are kept in `governor.json` `digests`.

**The step-4 gate**
- The process classes are `scope`, `preference` and `reversible-technical`.
- A goal change or split is recognised by the words `goal` or `split` in the subject.
- The mission is found through the request, a Main the ask names, or the mission's workspace.
- The owner-wrote-recently exemption is `ownerWroteRecently` (2 h, the REQ-198 figure). The `bm_ask_owner` face states the gate.

**Trigger and drift**
- **The trigger** comes from `eval-metrics/mains.ts` `turnTriggerOf`, so it agrees with A-14. A review delivery counts as `report`, and `BM-UPDATES` counts by its first item.
- **`stalled`** also clears when the request starts waiting on the owner or on another project's link.
- **A family's reset** waits on `underSince`, an additive field. The intervention outcome is measured from that point.
- **`metAt`** is carried over from an older met criterion's `at` when its status is next written.

**Older governors.** The relabel runs at the first Paseo handle and at `agent.created` of a `bm-orchestrator`. The title is set before the label.

## 9. Typed messages (REQ-215, ADR-035 decision 8)

### 9.1 Acts and references

- **On `bm_peer_reply` and `bm_ask_mission`:**
  - `act` is one of `ask`, `answer`, `agree`, `ack`, `close`, `supersede`. Defaults: `ask` on `bm_ask_mission`; on `bm_peer_reply`, `answer` from the answering side and `ask` from the asking side. `close: true` stays an alias.
  - `refs: { contracts?: ["C2@v3"], records?: ["out-…"], decisions?: ["q:…", "m:…", "A3"] }`, at most 10 each. They are checked against the mission store, the outbox and the decision stores, with one refusal line for each unknown id.
- **`bm_tell_worker` and `bm_link_workers`** take `refs` only.
- **Rules:**
  - `agree` needs a contract reference.
  - `supersede` needs the replaced record.
  - `ack` and `close` start no turn. They are stored with outbox outcome `delivered`, reason `no-turn`, and appended to the link. The receiver sees them in `BM-STATE` and as the first line of its next delivery.
  - `close` closes the link.
- **The link message** gains optional `act` and `refs`. The delivered text gains one header line: `act: agree · refs: C2@v3`.

### 9.2 Contracts

- **Fields.** A contract gains `status: "proposed" | "agreed" | "superseded" | "withdrawn"` (absent = `agreed`) and `agreedBy: { side, agentId, version, at }[]`.
- **Writing a version.** `bm_mission_update.contracts` accepts `status`. A new version is `proposed` unless stated `agreed`.
- **Agreeing.**
  - An `agree` act with `Cn@vk` at the current version appends to `agreedBy`.
  - When both sides have agreed, the contract becomes `agreed` and a journal `contract` line is written.
  - A stale version is refused: "C2 is at v4; agree to C2@v4 or reply."

### 9.3 The brief holds the agreements

- **Contracts.** `renderMissionState` gains a **Contracts** section after In flight. It lists live contracts, `proposed` first, at most 10: `- C2 v3 proposed: <title> (provider <repo>; consumers <repos>)`.
- **Links.** A link shows its latest message, not its original ask: `- peer-… to mission B (question, open, waiting 2h): last answer by B 40m ago: <gist> · refs C2@v3`.
- **Space.** Within the 6,000-character fit, Contracts is dropped after Recently and before Links.

### 9.4 Writing for a reader

The Main's and the Worker's role files each gain one line: "Write every message to another agent in full sentences a newcomer to the work understands; name what you mean by its id in `refs`. A message that needs no answer is `act: ack`: it wakes no one."

*As built:* a Worker-to-Worker link has only its two Workers as sides, so the Main records the contract with `bm_mission_update` and tells each Worker to answer on the link with `act: agree` and its `Cn@vk`. The Main agrees with another mission on that mission's link.

Workers of two missions still talk through their Mains (REQ-187 d).

### 9.5 As built (Phase 9, 2026-10-21)

**References**
- **Decision refs** accept `q:`, `o:`, `f:`, `r:`, `h:`, `m:` and `arb-…` ids. Arbitrations are stored as `arb-…`, not `A3`.
- **`C2@v3`** is known when v3 is at or below the current version. `agree` needs exactly the current version.
- **Refusals:** agreeing to a superseded or withdrawn contract answers "C1 is withdrawn; there is nothing to agree to: reply instead"; a stale version answers "C1 is at v2; agree to C1@v2 or reply."

**Acts**
- **"Both sides"** of an agreement are the link's asker and answerer.
- **`bm_ask_mission`** refuses `answer` and `close`, because there is no link yet. An `ack` there opens the link and starts no turn.
- **`ack` and `close`** answer `delivery: "no-turn"` with a note from `effects.ts` `noTurnEffect`. At the head of the receiver's next outbox delivery they read `noted: <link> from <agent> (act: ack · refs: …): <gist>`, at most 5, and are marked `shownAt` once shown.
- **A `close` that meets a wait** wakes the waiting Worker with the facts block.

**Contracts**
- `bm_mission_update` accepts a status-only contract change, which keeps the version and journals "The Main marked C1 withdrawn."
- `bm_mission` shows each contract's status.

**The Worker's compaction brief** (`compaction.ts`) gains `links:` and `contracts:` blocks after `decisions:`, within `WORKER_LINKS_BLOCK_MAX_CHARS` (2,400), built by the shared `linkLineOf` and `contractLineOf`. The continuation and handoff briefs keep their own lists.

## 10. Role files

Each role is written as positive instructions, at the step that needs it. `manager.md` is at its pinned 100 lines, so each new line replaces one. `worker.md` has room up to its 180.

| File | Change |
|---|---|
| `worker.md` | Rule 1 (§4.1). "What you do next": milestone batches, no bead review (§5.1); a request ends at `finished`; `BM-ROLLOVER` (§2.6); a brief with `continues:` carries on from its chain (§2.5). "Proving a change": the update-the-branch step (§4.7); commit and report the sha (§4.4). "Reviewing": re-reviews while blocking findings fall, the stop, the cap (§5.2–§5.4). "Reporting": waits by id, `wakeOn`, `BM-UPDATES` (§6.2). Messages (§9.4) |
| `reviewer.md` | The implementation scope and the re-review scope (§5.5) |
| `manager.md` | More work on a finished request goes through `bm_tell_worker`, which opens its continuation; this replaces "an area a Worker holds goes to that Worker" (§2.4). A waiting Worker is woken by paseo-bm, so tell it only what paseo-bm cannot see, and use `now: true` for owner words (§6.4). A Worker's open question is already the owner's card: recommend on it (§7.2). A placement's Workers share its tree (§4.1). Agreements and messages (§9) |
| `orchestrator.md` | Reviews past a cap are paseo-bm's one question, so never ask about reviews; advice goes on `review.callsPerBatch` and `review.maxRereviews` (§5.6). The owner is reached on a mission's process from ladder step 4 (§8.3) |

Every running agent is outdated after these changes and is replaced once, as for every role-file change.

## 11. Stored formats and compatibility

Every change is additive. No `v` changes.

| Store | Change | Older data and older builds |
|---|---|---|
| Registry | chain fields, `waiting`, `batches[].milestone`, `batches[].results` | absent = not a chain, no structured wait; results fall back to the trace |
| Outbox | state `held` | an older build reads `held` as an unknown state and leaves it |
| Coordination settings | `rollover.*`, `maintenance.ceilingFactor`, `review.maxRereviews`, `review.callsPerBatch`, `governor.quota*` | old `review.*Budget` ignored and dropped on write |
| Decisions | subject `review-cap` (`ownerOnly`); `prediction.main` from §7.2 | open `review-budget` withdrawn by the sweep |
| Missions | `placements[]`, criteria `metAt`, contracts `status` and `agreedBy` | absent = no placement (root), `at` when met, `agreed` |
| Mission index | `placements` map | rebuilt |
| `missions/placement-mode.json` | new | absent = before the cut-over |
| Commands log | `governorStep`, `by` | counted in `other` |
| Trace record | `trigger` | counted as today |
| Peer link messages | `act`, `refs` | `answer` and none |
| Reports | `integration`, `remaining`, `waitingOnRequests`, `waitingOnBatches`, `wakeOn` | old shape parsed as today |

## 12. Screens

Each change needs the approved mockup updated first: an approved mockup is the contract for the screen. **Approved by the owner on 2026-10-20:** [`docs/design/mockups/delivery-line.html`](mockups/delivery-line.html), artboards I (desktop mission page), J (phone mission page) and K (Projects › Requests), beside `mission-runtime.html` artboards G and H. Nothing else on the screens changes.

1. **Mission page, In flight:** a request's chain ("continues `<id>`", and "finished → `<id>`").
2. **Mission page, repos:** a placement row with branch, ahead/behind, uncommitted, merge request, CI, and "Push & MR allowed · Revoke".
3. **Projects › Requests:** the chain on its head, with the chain's tokens.
4. **Settings › Coordination:** the review steppers with the computed caps, the rollover figures and the governor pools. This uses existing controls, so no mockup is needed.

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
  - **A seeded scenario.** 500–2,000 scripted Worker turns (bead closes, follow-ups, reviews, questions, peer asks) run through the real tools and hooks over a fake Paseo and a temporary home. The invariants:
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
- **Changed tests:** every test that pins the retired behaviour (listed per bead in the plan). The largest groups:
  - review budget, `untilClean` and the authority rules;
  - the finished-then-reopened roster;
  - "at once" delivery;
  - the single governor pool;
  - the role-file wording.

## 14. Spikes before Phase 8

Each spike runs on an isolated `--home` daemon or on scratch clones, never on the owner's daemon or checkouts. All four ran on 2026-10-20 ([spikes record](../archive/operations/paseo-bm-delivery-line-spikes-20261020.md)):
- **S1 passed**, with the corrections in §3.3 and §4.5;
- **S2** gave the beads rule in §4.7, corrected by WP-8.7's proof (per line, then `br sync --rebuild`);
- **S3 passed**, in 73 s;
- **S4 is not verified**, so the fallback source of §4.5 stands.

| Spike | Question | Pass |
|---|---|---|
| S1 worktree via the plugin API | Does `workspaces.create` branch-off accept `baseBranch: "origin/<x>"` and a local branch such as a checkpoint? Is the descriptor's `gitRuntime` filled? Does `requestId` de-duplicate? | A worktree on the expected branch, adopted again on a second call |
| S2 beads in a mission branch | `.beads/issues.jsonl` is tracked in the target repositories. Do two branches that each `br create` merge cleanly? Does `br` work in a fresh worktree? | A rule for beads at integration: union merge driver, a beads-only step, or `br` import after the merge |
| S3 dependency clone | Time and validity of `cp -c -R` of the frontend's 1.3 GB `node_modules` and nx cache. Do tests run in the worktree? | A clone under 60 s and a passing project test, or the fallback chosen |
| S4 GitLab state | With `glab` installed and logged in, is `pullRequest.checksStatus` filled for a merge request? | Filled, or the Worker's `glab ci status` is the source |

## 15. Phases

| Phase | Decisions | Content |
|---|---|---|
| 6 — Limits that hold | 4, 6, 7 | §5, §7, §8 |
| 7 — Bounded requests and waits | 1, 5 | §2, §6, the chain mockup and UI |
| 8 — A branch per mission and integration | 2, 3 | S1–S4, §3, §4, the placement mockup and UI |
| 9 — Typed messages | 8 | §9 |

Each phase ends with one full `npm run verify` and its automated acceptance (PRD §9). The isolated-daemon drills and the shared-tree migration are the owner's steps after install.

## 17. No agent waits on machines (ADR-036)

### 17.1 CI is not used

- **The setting.** `integration.ci` in the Coordination settings is `"off"` (the default) or `"on"`. When on, §4.5 and §4.6 apply as built.
- **What off means:**
  - **Verified.** A finished request is verified when paseo-bm detected a check in its own turns (`shared/evidence.ts`). The report's `ci` field and the descriptor's checks are ignored.
  - **The Main's line** reads "finished, committed on `<branch>`[; verified]." or "finished, uncommitted: …".
  - **The governor** computes no `ciRed`.
  - **The mission state and the Repositories row** show the merge request without CI.
- **The Worker's role.** Push and create or update the merge request when Integration says yes. Read the merge request's state with `glab mr view` only when needed. Never read, wait for or poll a pipeline: report and end the turn.
- **The Main** does not ask a Worker for CI.
- **The boundary is unchanged.** `glab ci …` stays classified.

### 17.2 A re-review checks the fix diff, with a fresh Reviewer

- **The snapshot.** At every review call (`bm_create_reviewer` and `bm_rereview`) in a repository with git, paseo-bm writes the working tree as a tree object and stores its id on the call (`calls[].tree`). It uses the checkpoint's helper (§4.8): a temporary index outside the repository, `read-tree HEAD`, `add -A`, `write-tree`. Objects only: no ref, and the owner's HEAD, index and files are untouched.
- **What `bm_rereview` does:**
  1. Snapshots the tree.
  2. Reads the batch's previous call's tree.
  3. Computes `git diff --stat` and `git diff` between the two trees.
  4. **Creates a new Reviewer** for the batch (the same creation path, a new `callId`, counted against the cap) with the brief below. The earlier Reviewer is left idle.
- **The brief:**

  ```
  Re-review batch <bN> of request <req>: a fresh Reviewer checks only the fixes.
  Previous blocking findings (verbatim):
  <the previous result's blocking findings>
  Fixes — files changed since the last review:
  <git diff --stat>
  The diff (up to 40,000 characters; else: git diff <tree1> <tree2>):
  <diff>
  Checks the Worker ran for these files: <fixed>
  ```
- **When there is no snapshot** (a repository without git, or a git failure), the brief falls back to the Worker's `since` and `fixed` texts, and the Reviewer is still new.
- **The Reviewer's role.**
  - Check each previous blocking finding against this diff.
  - Report a new blocking finding only where this diff introduced it.
  - Run only the checks that cover the changed files.
  - Read nothing outside the diff unless a finding names it.
- **The Worker's role.** Before `bm_rereview`, run only the checks that cover the files you fixed. The full suite runs once, before `finished`.

### 17.3 A Worker rolls over by its real context

- **The setting.** `rollover.contextTokens`: default 250,000, bounds 100,000–900,000.
- **When it applies.** At a Worker's recorded turn end, the turn's `contextUsed` at or above it is a size figure like the others of §2.6. The soft notice fires at the figure, and the `now` notice at `rollover.ceilingFactor` × it.
- **The figure** reads "context 262k".
- **Compaction** is untouched (the owner's switch).

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
- **Rollover:** at 250,000 context, the soft notice; at 2×, `now`.
- **Role-content tests** for the three role changes.

### 17.5 As built (2026-10-23)

**CI**
- **The setting.** `integration.ci` is `"off"` (default) or `"on"`. A file without it reads as off, and a bad value is refused: "integration.ci must be "off" or "on"; nothing was saved".
- **Settings › Coordination** has a CI card between Rollover and Review: "Read a merge request's pipeline as evidence and show it. Off: verified is a check paseo-bm saw pass, and no agent waits on a pipeline." Its switch takes effect at once.
- **With CI off:**
  - **Verified at report time.** `bm_report` reads the Worker's live timeline (`liveChecksOf`, 3 pages of 200 entries) for its named checks, because the reporting turn is not recorded yet.
  - **The Main's line** reads "finished, committed on `<branch>`; verified." or without "; verified".
  - **Placements** carry `ci: null`, and `ciRed` is not in the figure list.
  - **The screen.** `mission.get`'s summary has `ci`, and the Repositories column reads "Merge request".

**Re-reviews**
- **Snapshots.** `calls[].tree` comes from `checkpoint.ts`'s temporary-index helper, with up to 60 seconds per git command.
- **What `bm_rereview` does.**
  - It creates the fresh Reviewer through `bm_create_reviewer`'s path and answers `{ reviewerId, reviewCalls }`.
  - Its findings are the `- severity: blocking` items of the batch's newest result's review record, verbatim; when none are marked that way, the whole review is quoted.
  - The stat is cut at 8,000 characters and the diff at 40,000, and both are redacted.
  - When every earlier result is a no-verdict, the fresh Reviewer gets the batch's original brief.
- **Refusals.**
  - Added: agent tools off; a blocked placement.
  - Retired: "Reviewer … is archived".
  - `rereviewLineOf` is removed.
- **Late creation.** An empty re-review call (Paseo's late error) is settled or cleared like a creation's.
- **Not built:** a fresh re-reviewer that fails on its provider gets the batch's first brief from the fallback replacement.

**Rollover and tokens**
- **The context figure.** `rollover.contextTokens` reads the recorded turn's own `usage.contextUsed`, never a sum. The Settings row is "Or its context reaches".
- **Codex accounting.** `inputIncludesCached` (`eval-metrics/helpers.ts`) is the one rule:
  - Codex input includes the cache, so its tokens read are its input;
  - Claude and OpenCode report the cache apart;
  - for an unknown provider, the cache counts as included only when `contextUsed` = input + output.

  Orchestrator wake usage stores `includesCached` for Codex. Per-step Codex usage reaches no plugin hook, so Codex stays last-step.

## 18. Agents are given a bounded context (ADR-037)

The evidence is the [context review](../archive/operations/paseo-bm-context-review-20261025.md). Every figure below is a constant in code; none is a setting except `main.contextTokens`.

### 18.1 Memory has a scope and a life

- **Stored, additively.** An entry of `memory/<repo>.json` gains `scope?: "repo" | "mission"` and `subject?: string` (≤ 80 characters, compared case aside). `schemaVersion` stays 1.
- **Default scope** (`scopeOf`): the stored `scope`; else `mission` for a `fact` or `decision` whose `by.missionId` is set; else `repo`. So an entry stored before ADR-037 reads by the same rule.
- **The owner's answers.** The plugin's entry for an owner's answer to a request's question carries that request's mission (`decision-store.ts`). One stored before, with no mission, is read with the mission its request belongs to (`resolvedMemory`, from the rosters), so it leaves with that mission; an answer to a request of no mission stays `repo`.
- **Live** (`liveMemoryOf(entries, missionStates, now)`, pure): an `active` entry is live unless it is retired for one of these reasons, the first that holds:
  1. `mission-closed`: its scope is `mission` and its mission is closed, or has no mission file (a file paseo-bm cannot read, such as a newer build's, reads as open, so nothing is retired or pruned for it);
  2. `superseded`: its `subject` is named by a newer active, not otherwise retired, entry of the repo that may replace it — a `repo` entry only by a `repo` one, a `mission` entry by a `repo` one or one of its own mission. So a mission's entry never hides a lasting rule that would come back, or be lost, when the mission closes;
  3. `stale`: its scope is `mission`, its kind is `fact`, and it is older than `MEMORY_FACT_DAYS` (14).
- **Reversible.** Retirement is computed at each read and never stored. A retired entry is shown by `bm_memory read` with `retired: true`, with its reason. Re-adding its text with `scope: "repo"` (and `supersedes` its id) makes it live.
- **Pruning.** At a write, an entry retired since more than `MEMORY_RETIRED_DAYS` (30) becomes `removed`: since its mission closed (the mission's `closedAt`), since the entry that superseded it, or since it turned stale. The newest 300 removed entries are kept, as before.
- **The bound.** `MAX_ACTIVE_MEMORY` (300) counts live entries. The governor's bloat signal (missions design §9.2) counts them too.

### 18.2 A brief has a budget

- **Relevance** (`briefMemoryOf(live, request, planStep, missionId)`): the features an entry shares with the request and the plan step — its words of two letters or more and each pair of neighbouring words, case aside, so a Vietnamese compound such as "nhập liệu" counts — each weighted ln(1 + N / n), where N is the live entries and n those holding the feature. A word every entry holds counts little.
- **Order and shares.** The owner's own entries (`by.role: "owner"`, such as the Orchestrator's notes of the owner's word) first, newest first; then this mission's own entries, by relevance then newest, up to `BRIEF_MEMORY_OWN_SHARE` (half) of the budget; then the repo's other entries, by relevance, then conventions before contracts, decisions and facts, then newest; then whatever budget is left takes the rest of either in the same order. So a long mission's own history cannot push the repo's conventions out.
- **How much.** Entries are added while the section stays within `BRIEF_MEMORY_CHARS` (6,000); each line is cut at `BRIEF_MEMORY_ENTRY_CHARS` (400).
- **The rest** is one line: `- N more entries in this repo's memory: bm_memory read with a query.`
- **Text.** Both sides are NFC-normalised before matching, so a request typed with decomposed accents still matches.
- **Where.** The brief of `bm_create_worker` (`missionBriefLines`) and of a continuation (`continuation.ts`). The mission's own contracts touching the repo keep their lines in full: they are the agreements the Worker builds to, never ranked or cut.

### 18.3 Reads return a summary first

- **`bm_memory read`** (Main and Worker):
  - no `query` and no `id`: `{ project, live, retired, limit, index }` — the live entries newest first, at most `MEMORY_INDEX_ENTRIES` (80), each `{ id, kind, scope, at, text }` with `text` cut at 160; the owner's precedents follow as before;
  - `query`: the matching live entries in full, newest first, at most `MEMORY_QUERY_ENTRIES` (20), and `more` when there are others;
  - `id`: that entry in full, live or retired;
  - `retired: true`: retired entries are included, each with its `retired` reason.
- **`bm_memory add`** takes `scope` and `subject`. Its answer names the entries its subject retires (`retires`), and, for a `mission` entry, the `repo` entries of the same subject that stay live (`stillLive`, with a note to add as `repo` to replace them).
- The index read shows the newest `MEMORY_INDEX_PRECEDENTS` (20) of the owner's precedents, with `precedentsMore`; a query finds the others. The agent's `## Owner precedents` carries them all as before.
- **`bm_mission`**:
  - `requests`: each `active` request in full (as before); each `finished` or `stopped` one as `{ requestId, repo, topic, state, workerId }`, the newest `MISSION_SETTLED_SHOWN` (20), with `settledMore` when there are others. A settled request with a question still open is always shown, with its `openQuestions`;
  - `journal`: the newest `MISSION_JOURNAL_SHOWN` (now 20) lines; input `journal` (1–50) asks for more;
  - input `requestId`: that request in full, settled or not.

### 18.4 A Main is compacted by its tokens

- **Crossing** (`mainContextCrossingOf`): the window share reaches `main.contextShare`, **or** the context reaches `main.contextTokens`, whichever comes first. The figure named is the one that crossed (the share when both).
- **Hard** (`mainContextHardOf`): the share reaches the hard share, or the context reaches `main.contextTokens / main.contextShare × hard share` (212,500 at the defaults), never below `MAIN_HARD_TOKENS_FLOOR` (1.25) × `main.contextTokens`, so a high share setting cannot bring the hard figure next to the compaction figure. The hard figure only counts on the first turn after a compaction (mission runtime design §3.5), so a Main is not replaced more often.
- **Settings → Coordination → Compaction** has a row "Compact a Main at" for `main.contextTokens`, with the token stepper the other token rows use.

### 18.5 An update says each thing once

`updatesNoticeOf` composes the blocks of one `BM-UPDATES`:
- **Repeats.** A block whose text equals an earlier block's, once its `out-…` and `peer-…` ids and its `link:` line are taken out, is dropped. When it came over another link, the kept block ends `also on link: <ids> (the same message; one bm_peer_reply on each link that asks)`, so an answer owed on each link is not lost.
- **Status replies.** Of the `BM-DELIVERY peer-reply` blocks that carry the same `request <id>, phase:`, only the newest is kept.
- Every item's callbacks still run, so the outbox settles each record as before. The count in `BM-UPDATES <n>` is the blocks sent.

### 18.6 Roles

- **`manager.md`**: the memory line becomes "add to a repo's memory only what a later Worker there must know beyond this mission — a convention, a contract, a lasting fact (`scope: repo`, a `subject` when it replaces one); what this mission settled stays in its plan and journal. paseo-bm keeps closed missions' entries out of briefs."
- **`worker.md`**: "the project memory in your brief" now says `bm_memory read` with a query reads more; what it adds is a lasting fact, convention or contract, with a `subject` when it replaces one.

### 18.7 Tests

- `liveMemoryOf`: each retirement reason, its order, an entry with no scope, reversal by a `repo` re-add, pruning after 30 days.
- `briefMemoryOf`: the budget, the mission's share, rarity weights and word pairs, the overflow line; the field brief's memory falls from 34,535 characters to at most 6,000.
- `resolvedMemory`: an owner's answer stored with no mission takes its request's mission.
- `bm_memory read`: index, query, id, retired; `bm_mission`: settled lines, `requestId`, `journal`.
- `mainContextCrossingOf` and `mainContextHardOf` with a window: 150,000 tokens of 475,000 crosses.
- `updatesNoticeOf`: repeats across links and status replies.

### 18.8 As built (2026-10-25)

- **Memory.** `memory-store.ts` gives `scopeOf`, `retirementsOf`, `liveMemoryOf` and `prunedMemory`; the store gains `live` and `retired`, and reads a mission's state from the mission store (an unreadable mission reads as unknown, so its mission entries are retired). Pruning runs inside every write.
- **`bm_memory`.** Both roles may give `scope` and `subject`; only a Main may give `supersedes`. A read by `id` refuses an id that is not active. An index read returns `index` (no `source`), `precedents` beside it, and `more` as a sentence when entries are left out; a query read returns `entries` with the precedents that match.
- **Not built:** the governor's bloat signal of missions design §9.2 was never in code; nothing counts it.
- **Updates.** Repeats are compared with `out-…` and `peer-…` ids taken out, since a peer message repeats its link id in its closing line. Of two copies of one status reply, the newest is kept.
- **Settings.** The Compaction card's note now says a mission's Main is compacted at "Compact a Main at" or its window share even with the card's switch off.
- **Review (2026-10-25).** An independent review and Claude's own field checks led to: the scope rule for `superseded`; an unreadable mission read as open; the owner's entries first; the mission's own share; rarity weights, word pairs and NFC in matching; contracts kept in full; the owner's answers tied to their request's mission; `stillLive`; precedents capped in the index; a settled request's open questions; the hard figure's floor; `also on link`.
- **On the field data** (a copy of the owner's data folder, 2026-10-25, after the review): the backend's 216 active entries read as 83 live (133 retired, a closed mission's), the frontend's 207 as 93 (114); AIX's brief memory is 5,912 and 5,986 characters, from 34,535, and holds the repo's conventions and contracts on widgets and forms beside AIX's own.

## 19. Parallel lanes, steered words and a held queue (ADR-038)

*Accepted 2026-10-25: the owner approved mockup [mission-lanes.html](mockups/mission-lanes.html) artboards Q, R as is, and chose "steer with guards" after the spike (§19.9).* Evidence: [queue review](../archive/operations/paseo-bm-mission-queue-review-20261025.md).

### 19.1 Lanes (stored additively on the placement)

- **Record.** A placement gains `lane?: number` (absent = 1), `mergedAt?: string` and `freeSince?: string`. Lane 1 is today's placement; it keeps the mission branch `m/<CODE>/<slug>` checked out. Lane n ≥ 2 is a Paseo worktree workspace on `m/<CODE>/<slug>-<n>`, worktree slug `m-<code>-<slug>-<n>`, request key `bm-place-<mission>-<repo>-lane<n>`, made by `ensurePlacement` from the mission branch's local head, with the same dependency clone (§3.5).
- **Bound.** `MAX_LANES` = 7 live lanes per mission and repository (lane 1 included). `charter.budget.workers`, when set, still caps the mission's live Workers.
- **Choosing a lane** (`laneFor(mission, repo, wish)`): `wish` absent → lane 1 (today's rule); `"new"` → the free lane with the lowest number, else a new lane while fewer than `MAX_LANES` are live, else refused with the lanes' work and "hold it with after, or stop one". When allocating a new lane, skip branch names occupied by unmanaged or unmerged work and try the next number; preserved branches do not consume live lanes.
- **Several Workers in a lane** are allowed when `staffing` is delegated (as today for a placement); the Main splits them by files.
- **Resolver.** `repoKeyOf` maps every lane's workspace to its repo, so policy, memory, decisions and the registry read the repo as for lane 1.

### 19.2 Merging a lane

1. **The Worker, at `finished`** (`worker.md`): commit on the lane branch; `git merge m/<CODE>/<slug>` into the lane; resolve conflicts; run the checks for what the merge touched; commit; report `finished` with `integration.lane`.
2. **paseo-bm** (`lane-merge.ts`, at the report): in lane 1's worktree, `git merge --ff-only m/<CODE>/<slug>-<n>`. Git refuses when lane 1's uncommitted changes would be overwritten; then the merge is kept as `pending`, retried at each lane 1 turn end and at most every 10 minutes, and the Main is told once with the files.
3. **After the fast-forward,** the lane is free (`freeSince`). Before its next request, paseo-bm resets the free lane to the mission branch's head (`git switch -C m/<CODE>/<slug>-<n> m/<CODE>/<slug>`) only when the lane's tree is clean; a dirty free lane is reported to the Main and not reused.
4. **Lane 1** merges nothing: it is the mission branch.
5. **Push and the merge request** stay on the mission branch (§4.3), under the one grant.

### 19.3 Overlap

- **When.** At each lane Worker's turn end, `line-watch.ts` reads the lane's changed files: the diff of its branch against the merge base with the mission branch, plus its uncommitted files.
- **What it signals.** When a file is changed by two live lanes of one repository, the Main gets one `BM-SIGNAL overlap` per file set: the lanes, their requests and the files. It is repeated only when the set grows. A refused fast-forward (§19.2) is the same signal.
- **Display and figures.** The signal shows on the mission page; the governor's figures count it.

### 19.4 Triage tools

- **`bm_create_worker`** gains:
  - `lane?: "new"`: run in a free or new lane of `project` (§19.1);
  - `after?: string[]`: hold the request until the named requests of this mission are finished or stopped (§19.6).
- **`bm_tell_worker`**'s answer gains:
  - `delivery: "steered"`, besides `"sent"` and `"queued"`;
  - for `"queued"`, `turnMinutes`: how long the target's turn has run, so the Main can choose a lane instead.

### 19.5 The owner's words are steered

- **Which messages.** A tell is the owner's words when:
  - it is a `bm_tell_worker` with `now: true` whose text the Main took from the owner's message in this turn;
  - or it is a `BM-COMMAND` from the owner's option;
  - or it is a `/bm-worker-new` follow-up.
- **How it is sent.** The notice queue sends it to a running Worker with `send(text, { messageId, activeTurnBehavior: "steer" })`, and records `steeredAt` on the outbox record.
- **Guards** (§19.9; the owner's choice). It is steered only when all of these hold:
  - the target's provider is Claude or Codex (by `PROVIDER_BASES`);
  - the target has a foreground turn (`activeTurn` set);
  - the text does not start with `/`.

  Otherwise it waits for the turn's end, as every other message still does.
- **Checking the turn.** paseo-bm reads the turn id before the send and after it. A different id means Paseo replaced the turn. The outbox record says `replaced`, the Main is told, and the owner's Inbox gets one notice.
- **A side effect.** Any delivered owner message denies the agent's pending permission requests (Paseo's `clearPendingPermissions`), as it does today.
- **Unchanged.** The other notices, `BM-UPDATES` and deliveries keep the turn-end rule (§6.4).

### 19.6 The held queue

- **Record.** A roster entry gains the state `held` and `after: string[]`. A held request has a request id, a topic and the Main's brief, but no Worker.
- **Start.**
  - When every named request is `finished`, paseo-bm creates its Worker as `bm_create_worker` would, in a free lane (`lane: "new"`), and journals it.
  - When a named request is `stopped`, the Main is told and the held request stays held.
- **Cancel.** The Main cancels with `bm_hold_cancel` (`requestId`, `why`).
- **Display.** `bm_mission` lists held requests with what they wait for.

### 19.7 Roles

- **`manager.md`** — "What you do next", step 2: classify each new ask as same work, independent, answerable by reading or dependent, and act as §19.4 says. "Keeping the work aligned": on `BM-SIGNAL overlap`, step in — one lane waits, takes the file over, or the work is re-split.
- **`worker.md`** — in a lane (`lane: n` in the brief), at `finished`:
  - merge the mission branch into the lane;
  - resolve the conflicts;
  - check what the merge touched;
  - commit and report.

  Keep to the files of the request; tell the Main before changing a file another lane owns.

### 19.8 The screen (mockup Q, R)

- **Repositories:** per repository, its lanes with branch, work and Workers, state and age, a free lane's last merge, and the overlap line.
- **In flight:** the lane in the repository column, and a **Waiting** part listing:
  - held requests, with what they wait for and since when;
  - tells: steered into a turn, or waiting for the end of a turn, and since when.

### 19.9 The steer spike (2026-10-25)

This was run on an isolated daemon (Paseo 0.12.0, port 6964) and in the app bundle's code.

**The path.** The plugin's `agents.ref(id).send(text, options)` forwards to `sendAgentMessage`, and from there to `send_agent_message_request`. With `activeTurnBehavior: "steer"` the daemon calls `AgentManager.steerOrReplaceActiveTurn`:
- **accepted:** the message joins the turn;
- **anything else:** `replaceAdmittedForegroundTurn` cancels the turn and starts a new one.

`steerAgentRun`, which never replaces, has no reachable caller. Omitting the option means `interrupt`, which replaces the turn.

**Live.** Claude and Codex both accepted a steer: one turn, every step ran, and the agent acted on the text at its next model step. The text appears as a `user_message` with `clientMessageId` and `messageId` equal to the sent id. Omitting the option replaced the turn.

**When it is refused.**
- **Claude:** compaction in progress, a slash command, a turn id mismatch, or a stale stream.
- **Codex:** no thread or turn, a slash command, an admission mismatch, or a definitive rejection.

Those are the cases a replacement can follow, so §19.5's guards cover all but a compaction, which no public signal shows.

### 19.10 Measures and tests

- **M-44.** The minutes from an owner's message to a Worker acting on it: for an independent ask, under 5 (field: 54–127); for the owner's words to a busy Worker, under 2.
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

- **Lanes** (`placement-create.ts`).
  - `ensureLane` makes lane 1 first. It reuses a free lane only when the lane's tree is clean, resetting it with `git switch -C <lane branch> <mission branch>`. Otherwise it makes a new lane: branch `m/<CODE>/<slug>-<n>`, worktree slug `<lane 1's slug>-<n>`, request key `bm-place-<mission>-<repo>-lane<n>`, title `<CODE> · <repo> · <n>`.
  - A lane branch left by an archived lane is moved to the mission branch only when the mission branch already holds it. Unmerged or unmanaged branches are preserved and skipped when choosing a new lane number; they no longer block allocation of other lanes. Merging or deleting the preserved work remains the owner's decision.
  - `placementOf`, `newestPlacementsOf`, the Repositories row and `ensurePlacement` read lane 1 only.
  - A lane's brief has no push line: "lane: at finished, merge … into …; never push this branch".
- **Merging** (`lane-merge.ts`).
  - `bm_report` refuses a lane's `finished` until the mission branch is an ancestor of the lane.
  - At `finished`, paseo-bm runs `git merge --ff-only` in lane 1. When the mission branch moved on, it first runs `git merge --no-edit` of the mission branch in the lane; a conflicting merge is aborted.
  - A refusal is kept as `mergePending`, told to the Main in the report's last line, and retried every 10 minutes from the governor's pass.
  - Git runs with a 2-minute timeout. The report needs no `integration.lane`: the lane is the placement.
- **Overlap** (`lane-overlap.ts`). This runs from the governor's minute pass.
  - Lane 1 counts its uncommitted files; lane n counts `diff base...branch` plus its uncommitted files. Free lanes are skipped.
  - The Main gets `BM-SIGNAL overlap` once per pair and file set; `overlapTold` sits on the higher lane.
  - **Not built:** a governor figure for overlaps.
- **Held queue** (`held-requests.ts`). *Changed from §19.6:* held work lives in `missions/<id>.held.json`, under ids `hold-<time>`, not as a roster state, so no reader of the roster changes.
  - `bm_create_worker` with `after` refuses an unknown or stopped request, creates at once when every named request has finished, and otherwise holds the work.
  - `startHeldRequests` runs from the minute pass (`index.server.ts`), through `bm_create_worker` called as the Main, and tells the Main when a held request starts.
  - A stopped request is told once, and the held request waits.
  - The Main cancels with `bm_hold_cancel`, a new Main tool; `bm_mission` lists `held`.
- **Steer** (`notice-queue.ts`, `owner-words.ts`).
  - The owner's words are a `now: true` tell, or a `BM-COMMAND` to a Worker from an option the owner answered personally. A `/bm-worker-new` request never reaches a running Worker, so it is no class.
  - The guards are: a Worker, a Claude or Codex base, `activeTurn.turnId`, and text not starting with `/`.
  - A changed turn id gives the outcome `turn-replaced`, a `BM-SIGNAL replaced` to the Main, and a `turn-replaced` Inbox alert, cleared at the request's `finished` or `stopped`.
  - Support is read from the agent snapshot, since the plugin API gives no daemon version.
- **`bm_tell_worker`** answers `delivery: "steered"`, and for a queued delivery `turnMinutes`.
- **The screen** (`mission-page-lanes.ts`, `missions-model.ts`, `missions.tsx`).
  - `mission.get`'s repositories gain `lanes`, `maxLanes` and `overlaps`, and `mission.get` gains `waiting`: held requests, and tells to busy Workers, queued or steered, a steered one shown for 30 minutes; the newest 10. Nothing reads git on a page read.
  - Overlaps come from `overlapTold`, with `overlapToldAt` (a stored field added for "the Main was told 04:38"). A reused lane drops both.
  - Checked against mockup Q, R in a static react-native-web render.
  - **Departures, kept on purpose:**
    - the phone keeps artboard J's push line with Revoke, which R does not draw;
    - "· N Workers" shows from two Workers;
    - "merges into the mission branch at finished" shows on every working lane n ≥ 2;
    - states the mockup does not draw have their own words (a waiting merge, "being made", a replaced turn, a held tell, a held request on a stopped one, "Nothing waiting.").
  - An owner's steered `BM-COMMAND` is not in the outbox, so Waiting cannot list it.
- **M-44** in the replay (`eval-store.ts` reads `outbox/*.json` without texts). It counts tells to Workers (records of kind `message` not from the plugin, the owner or the Orchestrator):
  - their wait until delivered (or steered), p50 and p90 minutes;
  - steered, replaced, and still queued at the window's end.

  The owner's message time in the Main's timeline is not joined.

### 19.12 New work never into a busy Worker; outdated Mains handed over (ADR-039)

- **`bm_tell_worker` `about`** (`"current"` | `"new"`). It is required while the request is at work, that is, not finished or stopped.
  - A missing `about` gets `fixThese` with how to choose.
  - `"new"` is refused (`newWorkRefusalOf`): for a mission's Main, `bm_create_worker` with `lane: "new"` or `after: ["<request>"]`; otherwise `bm_create_worker` with `after`.
  - A finished or stopped request opens its continuation as before, whatever `about` says.
- **Steer** (§19.5) needs `now: true` together with `about: "current"`. `now: true` alone on a live request is refused for the missing `about`.
- **`manager.md` step 2.** Words about a running request's own work (a fix, a stop, an answer) go to it with `about: "current"`. A new ask, a bug or a feature is new work, never a busy Worker's: it goes to `lane: "new"` or `after`.
- **Outdated Mains** (`main-upgrade.ts`). This runs in the minute pass (`index.server.ts`).
  - **What qualifies:** each open mission's Main that is live, idle (not `running` or `initializing`), not replaced, and on another `bm.instructions` hash than this build's. A Main with no label qualifies only once `STAMP_GRACE_MS` has passed.
  - **The handover:** `handOverMain` with `upgradeHandoffLineOf`, which tells the successor to say in one line that it took over after the update. The reason recorded is `handoff`, so an older build still reads the mission.
  - One try per Main per process. Workers and Reviewers are untouched.

## 16. Revision History

| Date | Author | Change |
|---|---|---|
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
