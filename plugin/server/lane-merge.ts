/**
 * Merging a finished lane into the mission branch (delivery line design
 * §19.2, ADR-038 decision 1).
 *
 * A lane n ≥ 2 works on `m/<CODE>/<slug>-<n>`, made from the mission branch
 * `m/<CODE>/<slug>`, which lane 1's worktree has checked out. At `finished`
 * the lane's Worker has merged the mission branch into its lane
 * (`laneMergeIssueOf` checks it), so paseo-bm moves the mission branch
 * forward with `git merge --ff-only <lane branch>` in lane 1's worktree:
 *
 * - **Fast-forward:** the lane is free (`mergedAt`, `freeSince`).
 * - **Refused because the mission branch moved on** (another lane merged
 *   meanwhile): the mission branch is merged into the lane again when git can
 *   do it without conflicts (`--no-edit`), then the fast-forward is retried;
 *   with conflicts the merge is aborted.
 * - **Refused because lane 1's uncommitted changes touch the same files:**
 *   the merge waits.
 *
 * A waiting merge is `mergePending` on the lane, retried by
 * `retryPendingMerges` at most every `MERGE_RETRY_MS`; the Main is told by
 * the report line `laneMergeLineOf` returns. Nothing is pushed, no history is
 * rewritten, and nothing outside the two worktrees is written. Never throws.
 *
 * **The local merge** (ADR-045 decision 4, mission line plan §5.3) is the one
 * write outside them: under the owner's grant, a request that passed the finish
 * gate moves the local integration branch forward to the chain's newest
 * reported commit (`localMergeRefusalOf`). Checked out in a worktree: `git merge
 * --ff-only <sha>` there. Otherwise `git update-ref refs/heads/<target> <sha>
 * <old>` after `merge-base --is-ancestor <old> <sha>`. Those are its only git
 * writes: a fast-forward or nothing, no retry, and a refusal fails the gate.
 */
import { execFile } from "node:child_process";
import { localMergeHolds } from "./integration-grant";
import { createMissionStore, journalQuietly, type Placement } from "./mission-store";
import { laneOf, placementEntryOf, placementOf } from "./placements";
import { gitEnv, type GitRunner } from "./repo-tool";

/** How often a waiting merge is tried again. */
export const MERGE_RETRY_MS = 10 * 60_000;
/** The longest one git command of a merge may run. */
const MERGE_GIT_TIMEOUT_MS = 120_000;

/** `execFile("git")` with the plugin's git environment, no shell, stopped after two minutes; its error carries `stderr`. */
export const mergeGit: GitRunner = (args, { cwd, maxBytes }) =>
  new Promise((done, fail) => {
    execFile("git", [...args], { cwd, env: gitEnv(), timeout: MERGE_GIT_TIMEOUT_MS, maxBuffer: maxBytes, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) done({ stdout });
      else fail(Object.assign(error, { stderr }));
    });
  });

export interface LaneMergeDeps {
  git?: GitRunner;
  now?: () => Date;
  log: (message: string) => void;
}

/** What a merge did. */
export type LaneMergeOutcome = { merged: true; into: string } | { merged: false; reason: string; files: string[] };

const BYTES = 1024 * 1024;

const stderrOf = (error: unknown): string => {
  const text = (error as { stderr?: unknown } | null)?.stderr;
  return typeof text === "string" ? text : error instanceof Error ? error.message : String(error);
};

/** The tab-indented file names git lists under "would be overwritten by merge". Pure. */
export function overwrittenFilesOf(stderr: string): string[] {
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => line.includes("would be overwritten by merge"));
  if (start === -1) return [];
  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    files.push(line.trim());
  }
  return files;
}

/** Why `lane`'s Worker cannot report finished yet: the mission branch is not merged into its lane (§19.2 step 1); null when it is. */
export async function laneMergeIssueOf(lane: Placement, deps: Pick<LaneMergeDeps, "git"> = {}): Promise<string | null> {
  if (laneOf(lane) < 2 || lane.directory === null) return null;
  const git = deps.git ?? mergeGit;
  try {
    await git(["merge-base", "--is-ancestor", lane.base, lane.branch], { cwd: lane.directory, maxBytes: BYTES });
    return null;
  } catch {
    return `merge ${lane.base} into ${lane.branch} (git merge ${lane.base}), resolve the conflicts, check what the merge touched and commit, then report finished`;
  }
}

/** Records `change` on the lane whose request key is `requestKey`. Never throws. */
function saveLane(home: string, missionId: string, requestKey: string, change: (lane: Placement) => Placement, deps: LaneMergeDeps): void {
  try {
    createMissionStore(home, deps.now === undefined ? {} : { now: deps.now }).update(missionId, (mission) => ({
      ...mission,
      placements: (mission.placements ?? []).map((placement) => (placement.requestKey === requestKey ? change(placement) : placement)),
    }));
  } catch (error) {
    deps.log(`[paseo-bm] lane ${requestKey} could not be recorded: ${stderrOf(error)}`);
  }
}

/** The fast-forward of the mission branch to `lane` in lane 1's worktree, or why git refused it. */
async function fastForward(git: GitRunner, lane1: Placement, lane: Placement): Promise<{ ok: true } | { ok: false; moved: boolean; files: string[]; text: string }> {
  try {
    await git(["merge", "--ff-only", lane.branch], { cwd: lane1.directory!, maxBytes: BYTES });
    return { ok: true };
  } catch (error) {
    const text = stderrOf(error);
    return { ok: false, moved: /not possible to fast-forward|cannot fast-forward|Diverging branches/i.test(text), files: overwrittenFilesOf(text), text };
  }
}

/**
 * Moves the mission branch forward to `lane`'s branch (see the module
 * comment) and records the outcome on the lane. Never throws.
 */
export async function mergeLane(home: string, missionId: string, lane: Placement, deps: LaneMergeDeps): Promise<LaneMergeOutcome> {
  const git = deps.git ?? mergeGit;
  const now = deps.now ?? (() => new Date());
  const lane1 = placementOf(home, missionId, lane.repo);
  const pending = (reason: string, files: string[]): LaneMergeOutcome => {
    const at = now().toISOString();
    saveLane(home, missionId, lane.requestKey, (current) => ({ ...current, mergePending: { since: current.mergePending?.since ?? at, triedAt: at, reason, files } }), deps);
    return { merged: false, reason, files };
  };
  if (lane1 === null || lane1.directory === null || lane1.state !== "ready") return pending(`lane 1 of this repo is not ready, so ${lane1?.branch ?? "the mission branch"} cannot move`, []);
  if (lane.directory === null) return pending(`lane ${laneOf(lane)}'s folder is not known`, []);
  let result = await fastForward(git, lane1, lane);
  if (!result.ok && result.moved) {
    // Another lane merged meanwhile: bring the mission branch into this lane when git can do it alone.
    try {
      await git(["merge", "--no-edit", lane.base], { cwd: lane.directory, maxBytes: BYTES });
      result = await fastForward(git, lane1, lane);
    } catch (error) {
      let conflicted: string[] = [];
      try {
        conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], { cwd: lane.directory, maxBytes: BYTES })).stdout.split("\n").filter((line) => line !== "");
      } catch {
        conflicted = [];
      }
      try {
        await git(["merge", "--abort"], { cwd: lane.directory, maxBytes: BYTES });
      } catch {
        // Nothing to abort: the merge refused before it started.
      }
      return pending(`${lane.base} moved on and does not merge into ${lane.branch} without conflicts (${stderrOf(error).split("\n")[0]}): a Worker resolves them in lane ${laneOf(lane)}`, conflicted);
    }
  }
  if (!result.ok) {
    if (result.files.length > 0) return pending(`lane 1 has uncommitted changes to files lane ${laneOf(lane)} changed`, result.files);
    return pending(`git refused the fast-forward: ${result.text.split("\n")[0]}`, []);
  }
  const at = now().toISOString();
  saveLane(
    home,
    missionId,
    lane.requestKey,
    (current) => {
      const merged: Placement = { ...current, mergedAt: at, freeSince: at };
      delete merged.mergePending;
      return merged;
    },
    deps,
  );
  journalQuietly(createMissionStore(home), missionId, { kind: "note", by: "plugin", text: `Lane ${laneOf(lane)} (${lane.branch}) merged into ${lane.base} by fast-forward.`, ref: lane.workspaceId ?? lane.requestKey }, deps.log);
  return { merged: true, into: lane.base };
}

/** The worktree with `branch` checked out, from `git worktree list --porcelain`; null when none has. Pure. */
export function worktreeOfBranch(porcelain: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/** What the local merge did (ADR-045 decision 4). */
export type LocalMergeOutcome = { merged: true } | { merged: false; reason: string };

const firstLineOf = (error: unknown): string => stderrOf(error).split("\n")[0] ?? "";

/**
 * Moves the local branch `target` forward to `sha`, by fast-forward or not at
 * all (see the module comment); `cwd` is any worktree of the repository. A
 * target that already contains `sha` needs no write. Never throws.
 */
export async function fastForwardLocalTarget(target: string, sha: string, cwd: string, deps: Pick<LaneMergeDeps, "git"> = {}): Promise<LocalMergeOutcome> {
  const git = deps.git ?? mergeGit;
  const out = async (args: readonly string[], where = cwd): Promise<string> => (await git(args, { cwd: where, maxBytes: BYTES })).stdout.trim();
  const isAncestor = async (older: string, newer: string): Promise<boolean> => out(["merge-base", "--is-ancestor", older, newer]).then(() => true, () => false);
  let commit: string;
  let old: string;
  let worktree: string | null;
  try {
    commit = await out(["rev-parse", "--verify", `${sha}^{commit}`]);
    old = await out(["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
    worktree = worktreeOfBranch(await out(["worktree", "list", "--porcelain"]), target);
  } catch (error) {
    return { merged: false, reason: `git could not read ${target} and ${sha}: ${firstLineOf(error)}` };
  }
  if (await isAncestor(commit, old)) return { merged: true };
  if (!(await isAncestor(old, commit))) return { merged: false, reason: `${target} and ${sha} have diverged, so it is not a fast-forward` };
  try {
    if (worktree !== null) await out(["merge", "--ff-only", commit], worktree);
    else await out(["update-ref", `refs/heads/${target}`, commit, old]);
    return { merged: true };
  } catch (error) {
    const files = overwrittenFilesOf(stderrOf(error));
    if (files.length > 0) return { merged: false, reason: `uncommitted changes in ${target}'s worktree would be overwritten: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""}` };
    return { merged: false, reason: `git refused it: ${firstLineOf(error)}` };
  }
}

/**
 * The local merge after a passed finish gate (ADR-045 decision 4, plan §5.3):
 * under the mission's grant for the repo, moves its integration branch to
 * `sha` and journals the outcome. `laneMerged` is `mergeLane`'s outcome for a
 * lane n ≥ 2, which goes only once merged. Null when there is no grant or it
 * moved; otherwise the gate's new reason. Git is not touched without the
 * grant. Never throws.
 */
export async function localMergeRefusalOf(home: string, placement: Placement, sha: string, laneMerged: boolean, deps: LaneMergeDeps): Promise<string | null> {
  try {
    const entry = placement.workspaceId === null ? null : placementEntryOf(home, placement.workspaceId);
    const holder = entry === null ? null : placementOf(home, entry.missionId, entry.repo);
    if (entry === null || holder === null || !localMergeHolds(holder)) return null;
    const journal = (text: string): void => {
      journalQuietly(createMissionStore(home, deps.now === undefined ? {} : { now: deps.now }), entry.missionId, { kind: "note", by: "plugin", text, ref: holder.workspaceId ?? holder.requestKey }, deps.log);
    };
    const refuse = (reason: string): string => {
      journal(`The local merge of ${sha} into ${holder.target} changed nothing: ${reason}.`);
      return `the local merge into ${holder.target} was refused: ${reason}`;
    };
    if (laneOf(placement) >= 2 && !laneMerged) return refuse(`lane ${laneOf(placement)} is not merged into ${placement.base} yet`);
    if (placement.directory === null) return refuse("the worktree's folder is not known");
    const outcome = await fastForwardLocalTarget(holder.target, sha, placement.directory, deps);
    if (!outcome.merged) return refuse(outcome.reason);
    journal(`${holder.target} moved forward to ${sha} by fast-forward.`);
    return null;
  } catch (error) {
    return `the local merge was refused: ${stderrOf(error)}`;
  }
}

/** The line the Main's delivery of a lane's `finished` gains (§19.2 step 2). Pure. */
export function laneMergeLineOf(lane: Placement, outcome: LaneMergeOutcome): string {
  if (outcome.merged) return `Lane ${laneOf(lane)} merged into ${outcome.into}; the lane is free for the next independent work.`;
  const files = outcome.files.length === 0 ? "" : ` Files: ${outcome.files.slice(0, 10).join(", ")}${outcome.files.length > 10 ? ", …" : ""}.`;
  return `Lane ${laneOf(lane)} is NOT merged into ${lane.base} yet: ${outcome.reason}.${files} paseo-bm tries again; step in if two lanes edit the same files.`;
}

/** Tries every waiting merge of the open missions whose last try is older than `MERGE_RETRY_MS`. Never throws. */
export async function retryPendingMerges(home: string, deps: LaneMergeDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  try {
    const store = createMissionStore(home);
    for (const entry of store.list().filter((mission) => mission.state === "open")) {
      const mission = store.get(entry.missionId);
      for (const lane of (mission?.placements ?? []).filter((placement) => placement.mergePending !== undefined && placement.state === "ready")) {
        if (now().getTime() - Date.parse(lane.mergePending!.triedAt) < MERGE_RETRY_MS) continue;
        const outcome = await mergeLane(home, entry.missionId, lane, deps);
        if (outcome.merged) deps.log(`[paseo-bm] lane ${laneOf(lane)} of mission ${entry.code} merged into ${outcome.into} on a retry.`);
      }
    }
  } catch (error) {
    deps.log(`[paseo-bm] waiting lane merges could not be tried: ${stderrOf(error)}`);
  }
}
