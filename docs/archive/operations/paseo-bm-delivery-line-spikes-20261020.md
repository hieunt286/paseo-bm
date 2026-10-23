# paseo-bm — delivery line spikes S1–S4, 2026-10-20

Run record of WP-8.0 of the [delivery line plan](../plans/paseo-bm-plan-delivery-line.md): the four spikes of the [delivery line design](../../design/paseo-bm-delivery-line.md) §14.

Where they ran:
- an isolated daemon (`--home /tmp/bm-spike/s1/paseo-home`, port 6911, Paseo 0.11.2; the repository's client packages are 0.8.0);
- scratch repositories and clones under `/tmp/bm-spike`.

The owner's daemon (6767), `~/.paseo`, `~/.paseo-bm` and the owner's checkouts were not written. The isolated daemon was stopped with `scripts/manual-test/stop-daemon.sh`.

## S1 — a worktree through the workspace API

The scratch setup:
- a bare `origin.git` with `main` and `develop`;
- a clone on `develop`, registered as a project (`prj_e6fdd31b553e21a7`, root workspace `wks_47ef79d107434068`).

Requests were sent with `DaemonClient.createWorkspace(input, requestId)`, and once through `createPaseoApi(client).workspaces.create`, the plugin's path.

| # | Request | Result |
|---|---|---|
| 1 | branch-off, `baseBranch: "origin/develop"`, `branchName: "m/abc/repo"`, `worktreeSlug: "m-abc-repo"`, `requestId: "bm-place-abc-repo"` | **Succeeds.** `workspaceKind: "worktree"`, the root's `projectId`, folder `$PASEO_HOME/worktrees/<project hash>/m-abc-repo`. HEAD is at `origin/develop` with no upstream (`--no-track`). The stored base is `refs/remotes/origin/develop` |
| 1 | descriptor in the create response | `gitRuntime { currentBranch: "m/abc/repo", isPaseoOwnedWorktree: true, isDirty: false, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null }`, `githubRuntime: null`, and `creation { kind, idempotencyKey, revision, phase: "completed", workspaceId }` |
| 1 | descriptor from `list` seconds later | `aheadBehind { ahead: 0, behind: 0 }`, `githubRuntime { featuresEnabled: false, pullRequest: null, error: null }` |
| 2a | `baseBranch` a local-only branch (`bm/checkpoint-x`) | **Accepted.** Stored base `refs/heads/bm/checkpoint-x` |
| 2b | `baseBranch` a commit sha | **Accepted**, but `aheadBehind` stays `null`, even after a commit |
| 3a | same body, same `requestId` (raw client and the plugin's path) | the same workspace; no duplicate |
| 3c | same `requestId`, only the title changed | `workspace_request_key_conflict`, no workspace |
| 3d | new `requestId`, same branch and slug | succeeds: folder `m-abc-repo-1`, **branch `m-abc-repo` (the slug)**, not a suffixed `m/abc/repo` |
| 3e–3h | other collisions | a taken branch name always falls back to the slug as the branch (`m-q3e-repo`, `m-abc-repo-1`); folders get `-N` |
| 3g | the branch exists only on origin | not detected: a new local branch is created from the base |
| 4 | archive a worktree with one commit, a modification and an untracked file | the folder and **every uncommitted change are deleted**; the workspace leaves `git worktree list`; **the branch and its commit remain** |
| 4b | replay the archived workspace's `requestId` | `directory_not_found` |
| 4c | `action: "checkout"`, `refName` the kept branch, new `requestId` | a new workspace on the branch, its commit restored |
| 5a | the base has a committed `paseo.json` with `worktree.setup` | setup runs, **with no trust prompt**; `fetchWorkspaceSetupStatus` shows `completed`, exit code 0 |
| 5b | the root has an untracked `paseo.json`, the base none | the root's file is copied into the worktree and run |
| 5c | both have one | the base's committed file wins |
| 6 | a commit in a worktree, nothing pushed | `aheadBehind` counts against the stored base, about 1.3 s after each commit, **but only while some client holds a `workspace_update` subscription**. A plain `fetchWorkspaces` returns no `gitRuntime` key after a git change, still none after 6 minutes. Without it, `project.checkout { cwd, currentBranch, remoteUrl, worktreeRoot, isGit, isPaseoOwnedWorktree, mainRepoRoot }` is present. `aheadOfOrigin` and `behindOfOrigin` stay `null` until `push -u` |

**What this changes in the design:**

- **§3.3 Idempotence.** A taken branch name is not suffixed: Paseo uses the slug as the branch.
  - Step 2's pre-check of `refs/heads/<branch>` and `refs/remotes/origin/<branch>` is required, because Paseo ignores remote branches.
  - Step 3's `currentBranch` check must read the create response's `gitRuntime.currentBranch`, which is always filled, or `project.checkout.currentBranch`.
  - A retry must send a byte-identical body. The title is part of the body, so it is fixed at creation and changed later with `setTitle`.
  - After an archive, re-creating uses `action: "checkout"` with a new `requestId`.
- **§3.5 Dependencies.** The setup that runs comes from the base's committed `paseo.json`, else from the root's working-tree file. The check is `git show <base>:paseo.json`, or the root's file.
- **§4.5 The line's state.** `gitRuntime` from `workspaces.list` is not reliable without a subscription. The plugin reads its state with read-only git in the placement (the design's fallback becomes the primary source), and uses the descriptor only when present.
- **§4.8 Checkpoint.** The checkpoint must be a branch, not a sha, for `aheadBehind` to be measured.
- **§3.6 Archiving.** Confirmed: archiving deletes uncommitted and untracked work, and keeps the branch and its commits.

## S2 — beads on two mission branches

This ran in a scratch clone of the frontend repository at its `HEAD`, where `.beads/issues.jsonl` is tracked.

- `br` works in a fresh clone. It imports `issues.jsonl` into a new database on the first command.
- **New beads on two branches merge cleanly.** Each branch ran one `br create`, then both branches were merged into a third. The JSONL is sorted by id, so the new lines land apart. `br show` finds both after the merge.
- **The same bead edited on two branches conflicts**, as a line conflict in `issues.jsonl`. In the test, both branches changed the priority of one bead.

**Rule (design §4.7).** Beads are merged like code at the Worker's "update the branch" step:
1. On a conflicting line in `issues.jsonl`, take the integration branch's line.
2. Commit the merge.
3. Re-apply the request's own change with `br`.

Missions work on their own feature beads, so a shared bead edited by two missions is rare. A merge driver is not needed.

## S3 — dependency clone

This ran on the same APFS volume (`/dev/disk3s5` holds both `~/.paseo` and `/Users/Shared/work`).

- `cp -c -R` of the frontend's `node_modules` (1.3 GB, nx + yarn) took **72.8 s** of wall time (44.8 s system). The copy kept relative `.bin` symbolic links.
- The `node_modules` cloned into a scratch clone at `HEAD` ran a project spec: `jest --config libs/ui-ai-assistant/jest.config.ts --runTestsByPath libs/ui-ai-assistant/src/lib/actions/actions.spec.tsx` gave **14 of 14 passed**.
- It is above the 60 s aim, but it runs once per mission and repository, in the background, at placement creation. **It is kept as the default.** The brief says "dependencies: being prepared" until it finishes.

## S4 — GitLab state

- `glab` is installed (`/opt/homebrew/bin/glab`).
- The scratch daemon has no forge, so `githubRuntime.featuresEnabled` was false.
- No merge request exists on the owner's repositories, so the forge figures could not be observed without opening one, which is an outward-facing act.

**Result: not verified.** The plan keeps the design's fallback as the source. The Worker reads merge-request and CI state with `glab mr view -F json` and `glab ci status`, classified `forgeRead` (design §4.2). The descriptor's `pullRequest` is used when it is filled. The first real merge request, after the owner's integration yes, confirms which source applies.
