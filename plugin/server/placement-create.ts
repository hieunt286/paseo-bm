/**
 * A mission's placements made and kept (delivery line design §3.3–§3.6,
 * ADR-035 decision 2; spikes S1 and S3).
 *
 * - **When.** Only once the cut-over file `missions/placement-mode.json`
 *   exists (`placementModeOn`, written by the migration, §4.8); before it, a
 *   mission's Workers keep each repo's root. Then a placement is made lazily,
 *   at the first `bm_create_worker` for a repo with no `ready` one
 *   (`ensurePlacement`). While its repo has no usable checkpoint yet, a
 *   mission from before the cut-over keeps working in the repo's root, as
 *   before it (`inRoot`); a mission open at a checkpoint branches from the
 *   checkpoint branch (§4.8, `checkpoint.ts`).
 * - **The call.** `workspaces.create` of a worktree branched off the
 *   integration branch (the root's upstream, else `origin/HEAD`), under the
 *   fixed `requestId` `bm-place-<missionId>-<repo>`; the exact body is
 *   written (`state: "creating"`) before it is sent, so a retry resends it
 *   byte for byte (Paseo de-duplicates nothing else). A taken branch name —
 *   local or on origin, read first: Paseo silently uses the slug instead —
 *   becomes `m/<code>-<missionId tail 4>/<slug>`; the answer's branch and
 *   project are checked after. A placement archived in Paseo is re-created
 *   from its branch (`action: "checkout"`, a new `requestId`) as a new record.
 * - **Dependencies** (§3.5): the repository's own `worktree.setup` wins;
 *   otherwise, when every lockfile at the base equals the root's, the plugin
 *   clones the root's `node_modules` (and `.nx/cache`) copy-on-write
 *   (`cp -c -R`), in the background. Never a plain copy, never a symlink.
 * - **Lifecycle** (§3.6): a repo leaving the charter or the mission closing
 *   retires its placements (`mission-tools.ts` `applyMissionChange`); the
 *   owner gets one archive card per event. `workspace.archived` and a
 *   reconciliation with `workspaces.list` at the first handle of a run (then
 *   every ten minutes) keep the records true. Archiving stays the owner's.
 *
 * - **Successors** (§4.8 step 5): a handoff of a request from before the
 *   cut-over moves into the mission's placement (`successorPlacementOf`,
 *   `moveRequestToPlacement`) once a checkpoint holds all of the root's work.
 *
 * Every git command is read-only (`GIT_READ_ONLY_PREFIX`); the plugin runs
 * no git write here. Nothing here throws into a caller.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_DECISION_TEXT_CHARS, type Decision, type DecisionOption } from "../shared/decisions";
import { createMissionDecisionStore } from "./mission-decisions";
import { MISSIONS_DIR_NAME, createMissionStore, journalQuietly, type Mission, type Placement } from "./mission-store";
import { listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { PLACEMENT_MODE_FILE_NAME, checkpointBaseOf, checkpointWaitOf, isCheckpointBranch, rootDiffersFrom } from "./checkpoint";
import { createMissionRoster } from "./mission-roster";
import { laneOf, placementEntryOf } from "./placements";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import { createRequestRegistry } from "./request-registry";
import { dataHome, errorText } from "./rpc-kit";

export { PLACEMENT_MODE_FILE_NAME };
/** What is cloned from the root when present (§3.5). */
export const DEPENDENCY_PATHS: readonly string[] = ["node_modules", ".nx/cache"];
/** The dependency manifests compared between the base and the root. */
export const LOCKFILES: readonly string[] = ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"];
/** `deps.note` when the repository's own setup prepares them. */
export const SETUP_NOTE = "the repository's own setup (paseo.json worktree.setup) prepares them";
export const INTEGRATION_BRANCH_REFUSAL = "set the integration branch on the mission page";
/** The brief line of a Worker that works in the repo's root while its mission waits for the checkpoint (§4.8). */
export const ROOT_WAIT_BRIEF_LINE = "worktree: not yet — this mission works in the shared checkout until its checkpoint is made; paseo-bm moves new Workers to the mission's worktree after it.";
const LOCKFILE_MAX_BYTES = 64 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 30 * 60_000;
const RECONCILE_EVERY_MS = 10 * 60_000;

/** True once the cut-over file exists. Never throws. */
export function placementModeOn(home: string | null): boolean {
  if (home === null) return false;
  try {
    return lstatSync(join(home, MISSIONS_DIR_NAME, PLACEMENT_MODE_FILE_NAME)).isFile();
  } catch {
    return false;
  }
}

/** Clones `source` to `target` copy-on-write; rejects when it cannot. */
export type CloneRunner = (source: string, target: string) => Promise<void>;

/** `cp -c -R` (APFS `clonefile`): fails on another volume or where cloning is unsupported, never falling back to a copy. */
export const cloneCopyOnWrite: CloneRunner = (source, target) =>
  new Promise((done, fail) => {
    execFile("cp", ["-c", "-R", source, target], { timeout: CLONE_TIMEOUT_MS, windowsHide: true }, (error) => (error === null ? done() : fail(error)));
  });

export interface PlacementDeps {
  log: (message: string) => void;
  /** Read-only git; `runGit` by default. */
  git?: GitRunner;
  clone?: CloneRunner;
  now?: () => Date;
}

/** What `workspaces.create` answers: `PaseoWorkspaceHandle` is structurally assignable. */
interface CreatedWorkspace {
  readonly id: string;
  readonly projectId?: string | null;
  readonly directory?: string | null;
  current?(): Record<string, unknown> | null;
}

/** The SDK slice placements use; `PaseoApi` is structurally assignable. */
export interface PlacementPaseo {
  workspaces: DashboardPaseo["workspaces"] & {
    create?(options: Record<string, unknown>): Promise<CreatedWorkspace>;
    ref?(workspaceId: string): { setTitle?(title: string | null): Promise<unknown> };
  };
}

/**
 * A ready placement; or, with `inRoot`, no worktree yet because a mission from
 * before the cut-over waits for its repo's checkpoint (§4.8): its Worker works
 * in the repo's root, as before the cut-over; or why nothing can be made.
 */
export type PlacementResult = { ok: true; placement: Placement; deps: Promise<void> } | { ok: false; reasons: string[]; inRoot?: true };

/** The placements whose dependency clone runs in this process (a pending one not here was cut short by a reload). */
const preparing = new Set<string>();

async function gitOut(git: GitRunner, cwd: string, args: readonly string[], maxBytes = 64 * 1024): Promise<string | null> {
  try {
    return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes })).stdout;
  } catch {
    return null;
  }
}

const hasRef = async (git: GitRunner, cwd: string, ref: string): Promise<boolean> => (await gitOut(git, cwd, ["rev-parse", "--verify", "--quiet", ref])) !== null;

/** The integration branch of the root checkout (§3.3): its upstream, else `origin/HEAD`; null when neither reads. */
export async function integrationBranchOf(git: GitRunner, root: string): Promise<{ target: string; base: string } | null> {
  const upstream = (await gitOut(git, root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))?.trim() ?? "";
  if (/^[^/\s]+\/\S+$/.test(upstream)) return { target: upstream.slice(upstream.indexOf("/") + 1), base: upstream };
  const head = /^refs\/remotes\/origin\/(\S+)$/.exec((await gitOut(git, root, ["symbolic-ref", "refs/remotes/origin/HEAD"]))?.trim() ?? "");
  return head === null ? null : { target: head[1]!, base: `origin/${head[1]}` };
}

/** A folder name as a branch and slug part: lower case, `[a-z0-9-]`. Pure. */
export function repoSlugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "repo"
  );
}

/** The fixed creation `requestId` of a mission's `n`th record of a repo (0-based). Pure. */
export const placementRequestKeyOf = (missionId: string, repo: string, n: number): string => `bm-place-${missionId}-${repo}${n === 0 ? "" : `-${n + 1}`}`;

/** The brief lines of a Worker in `placement` (§3.4, §3.5). Pure. */
export function placementBriefLines(placement: Placement): string[] {
  const grant = placement.integration;
  const { deps } = placement;
  const dependencies =
    deps.note === SETUP_NOTE
      ? `dependencies: ${SETUP_NOTE}`
      : deps.note !== null
        ? "dependencies: not prepared — installing them is a dependency install"
        : deps.at === null
          ? "dependencies: being prepared"
          : deps.cloned.length > 0
            ? `dependencies: cloned from the root (${deps.cloned.join(", ")})`
            : null;
  // Delivery line design §19.2: a lane n ≥ 2 merges into the mission branch locally; it never pushes.
  if (laneOf(placement) >= 2) {
    return [
      `worktree: ${placement.directory ?? "(not known)"} on branch ${placement.branch} (lane ${laneOf(placement)}; the mission branch is ${placement.base})`,
      "commit: on this branch at finished and rollover",
      `lane: at finished, merge ${placement.base} into ${placement.branch}, resolve conflicts, check what the merge touched, commit, then report finished; paseo-bm moves ${placement.base} forward. Never push this branch.`,
      ...(dependencies === null ? [] : [dependencies]),
    ];
  }
  return [
    `worktree: ${placement.directory ?? "(not known)"} on branch ${placement.branch} (integration: ${placement.target})`,
    "commit: on this branch at finished and rollover",
    `push and merge request: ${grant?.state === "granted" ? `allowed since ${grant.grantedAt}` : "ask the owner (paseo-bm does, at your first finished)"}`,
    ...(dependencies === null ? [] : [dependencies]),
  ];
}

interface Context {
  home: string;
  paseo: PlacementPaseo;
  mission: Mission;
  repo: string;
  name: string;
  root: { directory: string; projectId: string };
  git: GitRunner;
  clone: CloneRunner;
  now: () => Date;
  log: (message: string) => void;
}

const fail = (...reasons: string[]): PlacementResult => ({ ok: false, reasons });

/** Writes `placement` over the mission's record of the same `requestKey`, else appends it. Throws when the store refuses or cannot write. */
function save(home: string, missionId: string, placement: Placement, now: () => Date): Placement {
  const result = createMissionStore(home, { now }).update(missionId, (mission) => {
    const list = mission.placements ?? [];
    const at = list.findIndex((entry) => entry.requestKey === placement.requestKey);
    return { ...mission, placements: at === -1 ? [...list, placement] : list.map((entry, index) => (index === at ? placement : entry)) };
  });
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return placement;
}

function journal(ctx: Pick<Context, "home" | "mission" | "log" | "now">, text: string, ref?: string): void {
  journalQuietly(createMissionStore(ctx.home, { now: ctx.now }), ctx.mission.missionId, { kind: "note", by: "plugin", text, ...(ref === undefined ? {} : { ref }) }, ctx.log);
}

/**
 * The mission's ready placement of `repo` (a repo key, a charter repo), made
 * now when it has none (see the module comment). `listed` is what
 * `listedWorkspaces` read. The placement and its dependency preparation (a
 * promise that never rejects), or one line per reason — with `inRoot` while
 * the mission works in the repo's root until its checkpoint. Never throws.
 */
/** The context a placement of `repo` is made in, or why there is none. */
function contextOf(home: string, paseo: unknown, mission: Mission, repo: string, listed: readonly ListedWorkspace[], deps: PlacementDeps): Context | PlacementResult {
  const root = listed.find((entry) => entry.id === repo);
  if (root?.directory === undefined || root.directory === null) return fail(`paseo-bm could not read the folder of project ${repo} from Paseo; try again in a moment`);
  if (root.projectId === undefined) return fail(`paseo-bm could not read the Paseo project of ${repo}; try again in a moment`);
  return {
    home,
    paseo: paseo as PlacementPaseo,
    mission,
    repo,
    name: basename(root.directory),
    root: { directory: root.directory, projectId: root.projectId },
    git: deps.git ?? runGit,
    clone: deps.clone ?? cloneCopyOnWrite,
    now: deps.now ?? (() => new Date()),
    log: deps.log,
  };
}

export async function ensurePlacement(home: string, paseo: unknown, mission: Mission, repo: string, listed: readonly ListedWorkspace[], deps: PlacementDeps): Promise<PlacementResult> {
  const made = contextOf(home, paseo, mission, repo, listed, deps);
  if ("ok" in made) return made;
  const ctx = made;
  try {
    const records = (mission.placements ?? []).filter((placement) => placement.repo === repo && laneOf(placement) === 1);
    const current = records.at(-1);
    if (current === undefined) {
      // Delivery line design §4.8: a mission from before the cut-over branches from its repo's checkpoint; until it exists, its Workers work in the root.
      const wait = await checkpointWaitOf(home, ctx.git, mission, repo, ctx.root.directory, ctx.name);
      if (wait !== null) return { ok: false, reasons: [wait], inRoot: true };
      return await branchOff(ctx, 0, records);
    }
    const shown = current.workspaceId === null ? undefined : listed.find((entry) => entry.id === current.workspaceId);
    const live = shown !== undefined && !shown.archived;
    switch (current.state) {
      case "ready":
        if (live) return { ok: true, placement: current, deps: Promise.resolve() };
        // Archived in Paseo while its hook was missed (§3.6): recorded so, then re-created from its branch.
        save(home, mission.missionId, { ...current, state: "archived" }, ctx.now);
        return await recreate(ctx, current, records);
      case "creating": {
        const adopted = adoptionOf(current, listed, ctx.root.projectId);
        return adopted === null ? await send(ctx, current) : finish(ctx, current, adopted);
      }
      case "failed":
        if (live) return fail(`mission ${mission.code}'s worktree of ${ctx.name} failed (${current.note ?? "no reason recorded"}): the owner archives workspace ${current.workspaceId} in Paseo first. Tell the owner in one line`);
        return await recreate(ctx, current, records);
      default:
        // Retired (its repo came back to the charter) or archived: a new record from its branch.
        return await recreate(ctx, current, records);
    }
  } catch (error) {
    return fail(`paseo-bm could not make mission ${mission.code}'s worktree of ${ctx.name}: ${errorText(error)}`);
  }
}

/** A new record branched off the integration branch (§3.3 steps 1–2). */
async function branchOff(ctx: Context, n: number, records: readonly Placement[]): Promise<PlacementResult> {
  const { mission, git, root } = ctx;
  const line = await integrationBranchOf(git, root.directory);
  if (line === null) return fail(`paseo-bm cannot tell the integration branch of ${ctx.name} (its checkout has no upstream and origin has no HEAD): ${INTEGRATION_BRANCH_REFUSAL}`);
  const slug = repoSlugOf(ctx.name);
  const code = mission.code.toLowerCase();
  const ours = (branch: string) => records.some((placement) => placement.branch === branch);
  const taken = async (branch: string) => !ours(branch) && ((await hasRef(git, root.directory, `refs/heads/${branch}`)) || (await hasRef(git, root.directory, `refs/remotes/origin/${branch}`)));
  let branch = `m/${mission.code}/${slug}`;
  let worktreeSlug = `m-${code}-${slug}`;
  if (await taken(branch)) {
    // Spike S1: Paseo would silently take the slug as the branch.
    const tail = mission.missionId.slice(-4);
    branch = `m/${mission.code}-${tail}/${slug}`;
    worktreeSlug = `m-${code}-${tail}-${slug}`;
    if (await taken(branch)) return fail(`the branches m/${mission.code}/${slug} and ${branch} both exist in ${ctx.name}, and neither is this mission's; the owner renames or deletes one`);
  }
  // §4.8 step 3: a mission open at the repo's checkpoint branches from the checkpoint branch (never its sha, spike S1).
  const checkpoint = checkpointBaseOf(ctx.home, mission, ctx.repo);
  const base = checkpoint !== null && (await hasRef(git, root.directory, `refs/heads/${checkpoint}`)) ? checkpoint : line.base;
  const source = { kind: "worktree", cwd: root.directory, projectId: root.projectId, action: "branch-off", baseBranch: base, branchName: branch, worktreeSlug };
  return send(ctx, record(ctx, n, { branch, target: line.target, base, worktreeSlug, integration: null }, source));
}

/** A new record of a known branch (§3.3 step 5): `checkout` when the branch is still there, else a new branch-off. */
async function recreate(ctx: Context, previous: Placement, records: readonly Placement[]): Promise<PlacementResult> {
  if (!(await hasRef(ctx.git, ctx.root.directory, `refs/heads/${previous.branch}`))) return branchOff(ctx, records.length, records);
  const source = { kind: "worktree", cwd: ctx.root.directory, projectId: ctx.root.projectId, action: "checkout", refName: previous.branch, worktreeSlug: previous.worktreeSlug };
  const { branch, target, base, worktreeSlug, integration } = previous;
  return send(ctx, record(ctx, records.length, { branch, target, base, worktreeSlug, integration }, source));
}

/** A `creating` record and its exact body; `lane` (§19.1) names a lane n ≥ 2, its own request key and title. */
function record(ctx: Context, n: number, fields: Pick<Placement, "branch" | "target" | "base" | "worktreeSlug" | "integration">, source: Record<string, unknown>, lane?: number): Placement {
  const requestKey = lane === undefined ? placementRequestKeyOf(ctx.mission.missionId, ctx.repo, n) : laneRequestKeyOf(ctx.mission.missionId, ctx.repo, lane, n);
  // The title is part of the body: fixed here, renamed later with setTitle (§3.3 step 6).
  const body = { requestId: requestKey, title: `${ctx.mission.code} · ${ctx.name}${lane === undefined ? "" : ` · ${lane}`}`, source };
  return {
    repo: ctx.repo,
    workspaceId: null,
    directory: null,
    ...fields,
    state: "creating",
    requestKey,
    createdAt: ctx.now().toISOString(),
    deps: { cloned: [], at: null, note: null },
    requestBody: JSON.stringify(body),
    ...(lane === undefined ? {} : { lane }),
  };
}

interface Made {
  id: string;
  projectId: string | null;
  directory: string | null;
  branch: string | null;
}

/** A `creating` record's workspace as Paseo lists it after a reload (§3.3 step 4): its slug's folder, or its branch, in the root's project. */
function adoptionOf(placement: Placement, listed: readonly ListedWorkspace[], projectId: string): Made | null {
  const found = listed.find(
    (entry) =>
      !entry.archived &&
      entry.projectId === projectId &&
      entry.kind === "worktree" &&
      (entry.worktreeSlug === placement.worktreeSlug || (entry.directory !== null && basename(entry.directory) === placement.worktreeSlug) || entry.branch === placement.branch),
  );
  return found === undefined ? null : { id: found.id, projectId: found.projectId ?? null, directory: found.directory, branch: found.branch ?? null };
}

/** Writes the record, then sends its body (§3.3 step 1). */
async function send(ctx: Context, placement: Placement): Promise<PlacementResult> {
  const { home, mission } = ctx;
  save(home, mission.missionId, placement, ctx.now);
  const create = ctx.paseo.workspaces.create;
  if (typeof create !== "function") return fail("this Paseo cannot create a worktree workspace; the owner updates Paseo");
  if (placement.requestBody === undefined) return fail(`mission ${mission.code}'s worktree of ${ctx.name} has no stored creation; tell the owner in one line`);
  let created: CreatedWorkspace;
  try {
    created = await ctx.paseo.workspaces.create!(JSON.parse(placement.requestBody) as Record<string, unknown>);
  } catch (error) {
    const reason = errorText(error);
    // Spike S1 4b: an archived workspace's requestId answers directory_not_found.
    if (reason.includes("directory_not_found")) {
      save(home, mission.missionId, { ...placement, state: "archived" }, ctx.now);
      return fail(`mission ${mission.code}'s worktree of ${ctx.name} was archived before paseo-bm recorded it; call bm_create_worker again to re-create it from its branch`);
    }
    return fail(`Paseo refused to create mission ${mission.code}'s worktree of ${ctx.name}: ${reason}`);
  }
  const descriptor = created.current?.() ?? null;
  const field = (value: unknown, key: string): string | null => {
    const found = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    return typeof found === "string" && found !== "" ? found : null;
  };
  const checkout = descriptor?.["project"] !== undefined ? (descriptor["project"] as Record<string, unknown> | null)?.["checkout"] : undefined;
  return finish(ctx, placement, {
    id: created.id,
    projectId: created.projectId ?? field(descriptor, "projectId"),
    directory: created.directory ?? field(descriptor, "workspaceDirectory"),
    branch: field(descriptor?.["gitRuntime"], "currentBranch") ?? field(checkout, "currentBranch"),
  });
}

/** The post-check (§3.3 step 3), then `ready` and the dependency preparation; `failed` with one owner line otherwise. */
function finish(ctx: Context, placement: Placement, made: Made): PlacementResult {
  const { home, mission } = ctx;
  if (made.branch !== placement.branch || made.projectId !== ctx.root.projectId || made.directory === null) {
    const note = `Paseo made workspace ${made.id} on branch ${made.branch ?? "unknown"} in project ${made.projectId ?? "unknown"}, not ${placement.branch} in ${ctx.root.projectId}`;
    save(home, mission.missionId, { ...placement, workspaceId: made.id, directory: made.directory, state: "failed", note }, ctx.now);
    journal(ctx, `The worktree of ${ctx.name} failed: ${note}.`);
    return fail(`mission ${mission.code}'s worktree of ${ctx.name} failed: ${note}. Tell the owner in one line; they archive workspace ${made.id} in Paseo`);
  }
  const ready = save(home, mission.missionId, { ...placement, workspaceId: made.id, directory: made.directory, state: "ready" }, ctx.now);
  journal(ctx, `Worktree ${made.directory} of ${ctx.name} on branch ${placement.branch} (integration: ${placement.target}), workspace ${made.id}.`, made.id);
  return { ok: true, placement: ready, deps: prepareDependencies(ctx, ready) };
}

/** The setup Paseo runs (spike S1): the base's committed `paseo.json`, else the root's file; true when it has `worktree.setup`. */
async function hasSetup(git: GitRunner, root: string, base: string): Promise<boolean> {
  let text = await gitOut(git, root, ["show", "--no-textconv", `${base}:paseo.json`], 1024 * 1024);
  if (text === null) {
    try {
      text = readFileSync(join(root, "paseo.json"), "utf8");
    } catch {
      return false;
    }
  }
  try {
    const setup = (JSON.parse(text) as { worktree?: { setup?: unknown } }).worktree?.setup;
    return (typeof setup === "string" && setup.trim() !== "") || (Array.isArray(setup) && setup.length > 0);
  } catch {
    return false;
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** What §3.5 prepares in a fresh worktree: `{ cloned, note }`. Throws only what the file system throws. */
async function dependenciesOf(ctx: Context, placement: Placement): Promise<{ cloned: string[]; note: string | null }> {
  const { git, root } = ctx;
  if (await hasSetup(git, root.directory, placement.base)) return { cloned: [], note: SETUP_NOTE };
  const paths = DEPENDENCY_PATHS.filter((path) => existsSync(join(root.directory, path)));
  if (paths.length === 0) return { cloned: [], note: null };
  const lockfiles = LOCKFILES.filter((name) => existsSync(join(root.directory, name)));
  if (lockfiles.length === 0) return { cloned: [], note: "no lockfile at the root to compare with the base" };
  for (const name of lockfiles) {
    const atBase = await gitOut(git, root.directory, ["show", "--no-textconv", `${placement.base}:${name}`], LOCKFILE_MAX_BYTES);
    if (atBase === null || sha256(atBase) !== sha256(readFileSync(join(root.directory, name), "utf8"))) return { cloned: [], note: `${name} at ${placement.base} differs from the root's` };
  }
  const cloned: string[] = [];
  for (const path of paths) {
    const target = join(placement.directory!, path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    try {
      await ctx.clone(join(root.directory, path), target);
    } catch (error) {
      // What a failed clone left is the plugin's own, half made: removed, never completed by a copy.
      rmSync(target, { recursive: true, force: true });
      return { cloned, note: `the copy-on-write clone of ${path} failed: ${errorText(error)}` };
    }
    cloned.push(path);
  }
  return { cloned, note: null };
}

/** Runs §3.5 for a new placement and records `deps` and a journal line. Never rejects. */
async function prepareDependencies(ctx: Context, placement: Placement): Promise<void> {
  preparing.add(placement.requestKey);
  try {
    let result: { cloned: string[]; note: string | null };
    try {
      result = await dependenciesOf(ctx, placement);
    } catch (error) {
      result = { cloned: [], note: `the dependencies could not be prepared: ${errorText(error)}` };
    }
    const current = createMissionStore(ctx.home).get(ctx.mission.missionId)?.placements?.find((entry) => entry.requestKey === placement.requestKey) ?? placement;
    save(ctx.home, ctx.mission.missionId, { ...current, deps: { cloned: result.cloned, at: ctx.now().toISOString(), note: result.note } }, ctx.now);
    const what =
      result.note === SETUP_NOTE
        ? SETUP_NOTE
        : result.note !== null
          ? `not prepared: ${result.note}`
          : result.cloned.length > 0
            ? `cloned copy-on-write from the root: ${result.cloned.join(", ")}`
            : "none at the root to clone";
    journal(ctx, `Dependencies of the worktree of ${ctx.name}: ${what}.`, placement.workspaceId ?? undefined);
  } catch (error) {
    ctx.log(`[paseo-bm] the dependencies of mission ${ctx.mission.code}'s worktree of ${ctx.name} could not be recorded: ${errorText(error)}`);
  } finally {
    preparing.delete(placement.requestKey);
  }
}

// ---------------------------------------------------------------------------
// Lanes (delivery line design §19.1, ADR-038).
// ---------------------------------------------------------------------------

/** The most live lanes a mission has in one repo, lane 1 included (§19.1; the owner's figure). */
export const MAX_LANES = 7;

/** The fixed creation `requestId` of a lane's `n`th record (0-based). Pure. */
export const laneRequestKeyOf = (missionId: string, repo: string, lane: number, n: number): string => `bm-place-${missionId}-${repo}-lane${lane}${n === 0 ? "" : `-${n + 1}`}`;

/** The states a lane is live in: it holds or may hold work. */
const LIVE_STATES: ReadonlySet<Placement["state"]> = new Set(["creating", "ready"]);

/** The newest record of each lane n ≥ 2 of `repo`, by lane number. Pure. */
export function lanesOf(mission: Pick<Mission, "placements">, repo: string): Map<number, Placement> {
  const lanes = new Map<number, Placement>();
  for (const placement of mission.placements ?? []) if (placement.repo === repo && laneOf(placement) >= 2) lanes.set(laneOf(placement), placement);
  return lanes;
}

/** Why a reused lane cannot be reset to the mission branch, or null once it is (§19.2 step 3). */
async function resetLane(ctx: Context, lane: Placement, missionBranch: string): Promise<string | null> {
  if (lane.directory === null) return "its folder is not known";
  const status = await gitOut(ctx.git, lane.directory, ["status", "--porcelain"]);
  if (status === null) return "git could not read it";
  if (status.trim() !== "") return "it has uncommitted changes";
  try {
    await ctx.git(["switch", "-C", lane.branch, missionBranch], { cwd: lane.directory, maxBytes: 64 * 1024 });
    return null;
  } catch (error) {
    return `git could not reset it: ${errorText(error)}`;
  }
}

/**
 * A lane of `repo` for a new piece of independent work (§19.1): lane 1 made
 * first when it has none; then a free lane n ≥ 2 (its request merged, its tree
 * clean, nothing live in it), reset to the mission branch's head; else a new
 * lane while fewer than `MAX_LANES` are live; else one line naming each
 * lane's work. Never throws.
 */
export async function ensureLane(home: string, paseo: unknown, mission: Mission, repo: string, listed: readonly ListedWorkspace[], deps: PlacementDeps): Promise<PlacementResult> {
  const first = await ensurePlacement(home, paseo, mission, repo, listed, deps);
  if (!first.ok) return first;
  const made = contextOf(home, paseo, mission, repo, listed, deps);
  if ("ok" in made) return made;
  const ctx = made;
  const missionBranch = first.placement.branch;
  try {
    const current = createMissionStore(home).get(mission.missionId) ?? mission;
    const lanes = lanesOf(current, repo);
    const busy = new Set(
      createMissionRoster(home)
        .list(mission.missionId)
        .filter((entry) => entry.state === "active")
        .map((entry) => entry.workspaceId),
    );
    const shown = (placement: Placement) => placement.workspaceId !== null && listed.some((entry) => entry.id === placement.workspaceId && !entry.archived);
    const notReused: string[] = [];
    for (const [number, lane] of [...lanes].sort((a, b) => a[0] - b[0])) {
      const free = lane.state === "ready" && typeof lane.freeSince === "string" && shown(lane) && !busy.has(lane.workspaceId!);
      if (!free) continue;
      const why = await resetLane(ctx, lane, missionBranch);
      if (why !== null) {
        notReused.push(`lane ${number}: ${why}`);
        continue;
      }
      // New work starts with nothing told: the overlaps told belonged to the lane's last request.
      const fresh: Placement = { ...lane, freeSince: null, base: missionBranch };
      delete fresh.overlapTold;
      delete fresh.overlapToldAt;
      const reused = save(home, mission.missionId, fresh, ctx.now);
      journal(ctx, `Lane ${number} of ${ctx.name} (${lane.branch}) takes new work, reset to ${missionBranch}.`, lane.workspaceId ?? undefined);
      return { ok: true, placement: reused, deps: Promise.resolve() };
    }
    const live = [...lanes].filter(([, lane]) => LIVE_STATES.has(lane.state) && (lane.state === "creating" || shown(lane)));
    if (live.length + 1 >= MAX_LANES) {
      const work = createMissionRoster(home)
        .list(mission.missionId)
        .filter((entry) => entry.state === "active");
      const lines = [first.placement, ...live.map(([, lane]) => lane)].map((lane) => {
        const doing = work.filter((entry) => entry.workspaceId === lane.workspaceId).map((entry) => `${entry.requestId} ${entry.topic.slice(0, 60)}`);
        return `lane ${laneOf(lane)}: ${doing.join("; ") || (lane.freeSince ? "free but not reusable" : "no live request")}`;
      });
      return fail(
        `mission ${mission.code} already has ${MAX_LANES} lanes in ${ctx.name} (${lines.join(" | ")})${notReused.length === 0 ? "" : `; not reused: ${notReused.join("; ")}`}: hold the request with after, or stop one`,
      );
    }
    const taken = new Set(live.map(([number]) => number));
    for (let number = 2; ; number += 1) {
      if (taken.has(number)) continue;
      const previous = lanes.get(number);
      const branch = `${missionBranch}-${number}`;
      const worktreeSlug = `${first.placement.worktreeSlug}-${number}`;
      const records = (current.placements ?? []).filter((placement) => placement.repo === repo && laneOf(placement) === number).length;
      const fields = { branch, target: first.placement.target, base: missionBranch, worktreeSlug, integration: null };
      if (await hasRef(ctx.git, ctx.root.directory, `refs/heads/${branch}`)) {
        // Preserve unmanaged or unmerged branches; their names do not consume a live lane.
        if (previous === undefined) continue;
        const merged = (await gitOut(ctx.git, ctx.root.directory, ["merge-base", "--is-ancestor", branch, missionBranch])) !== null;
        if (!merged) continue;
        await ctx.git(["branch", "-f", branch, missionBranch], { cwd: ctx.root.directory, maxBytes: 64 * 1024 });
        const source = { kind: "worktree", cwd: ctx.root.directory, projectId: ctx.root.projectId, action: "checkout", refName: branch, worktreeSlug };
        return await send(ctx, record(ctx, records, fields, source, number));
      }
      const source = { kind: "worktree", cwd: ctx.root.directory, projectId: ctx.root.projectId, action: "branch-off", baseBranch: missionBranch, branchName: branch, worktreeSlug };
      return await send(ctx, record(ctx, records, fields, source, number));
    }
  } catch (error) {
    return fail(`paseo-bm could not make a lane of mission ${mission.code} in ${ctx.name}: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Where a new Worker appears (`/bm-worker-new`, `manager.ensure { forNewRequest }`).
// ---------------------------------------------------------------------------

/** Where a Worker the Main creates for a workspace's repo appears; `worktreeTitle` names the mission's worktree workspace when known. */
export interface NewWorkerPlace {
  workerIn: "here" | "shared-checkout" | "worktree";
  worktreeTitle: string | null;
}

/** A placement's workspace title as `retitlePlacements` keeps it: `<code> · <repo folder>`. Pure. */
function placementTitleOf(placement: Placement, code: string): string | null {
  try {
    const title = String((JSON.parse(placement.requestBody ?? "{}") as { title?: unknown }).title ?? "");
    return title.includes(" · ") ? `${code} · ${title.slice(title.indexOf(" · ") + 3)}` : null;
  } catch {
    return null;
  }
}

/**
 * Where the next Worker of `mission` for the repo of `workspaceId` appears
 * (delivery line design §3.3, §4.8), as `bm_create_worker` would place it:
 * the workspace itself before the cut-over or when it is a placement; the
 * repo's root (`shared-checkout`) while a mission from before the cut-over
 * waits for its checkpoint; otherwise the mission's worktree. Read-only;
 * `here` when it cannot tell. Never throws.
 */
export async function newWorkerPlaceOf(home: string, paseo: unknown, mission: Mission, workspaceId: string, deps: { git?: GitRunner } = {}): Promise<NewWorkerPlace> {
  const here: NewWorkerPlace = { workerIn: "here", worktreeTitle: null };
  try {
    if (!placementModeOn(home) || placementEntryOf(home, workspaceId) !== null || !mission.charter.repos.includes(workspaceId)) return here;
    const current = (mission.placements ?? []).filter((placement) => placement.repo === workspaceId && laneOf(placement) === 1).at(-1);
    if (current?.state === "ready") return { workerIn: "worktree", worktreeTitle: placementTitleOf(current, mission.code) };
    const root = (await listedWorkspaces(paseo as DashboardPaseo))?.find((entry) => entry.id === workspaceId);
    if (root?.directory === undefined || root.directory === null) return { workerIn: "worktree", worktreeTitle: null };
    const name = basename(root.directory);
    if (current === undefined && (await checkpointWaitOf(home, deps.git ?? runGit, mission, workspaceId, root.directory, name)) !== null) return { workerIn: "shared-checkout", worktreeTitle: null };
    return { workerIn: "worktree", worktreeTitle: `${mission.code} · ${name}` };
  } catch {
    return here;
  }
}

// ---------------------------------------------------------------------------
// Successors of requests from before the cut-over (§4.8 step 5).
// ---------------------------------------------------------------------------

/**
 * Where the successor of a handed-off request of a mission works (§4.8 step
 * 5): its mission's placement of the repo when the request still lives in
 * the repo's root after the cut-over and a checkpoint holds all of the
 * root's work — the placement's base, or the checkpoint a new one would
 * branch from, is a checkpoint branch and the root differs from it in
 * nothing. Null keeps it in place (the root), as before. Never throws.
 */
export async function successorPlacementOf(
  home: string,
  paseo: unknown,
  request: { workspaceId: string; missionId: string | null },
  deps: PlacementDeps,
): Promise<{ workspaceId: string; directory: string } | null> {
  if (!placementModeOn(home) || request.missionId === null || placementEntryOf(home, request.workspaceId) !== null) return null;
  try {
    const mission = createMissionStore(home).get(request.missionId);
    const repo = request.workspaceId;
    if (mission === null || mission.state !== "open" || !mission.charter.repos.includes(repo)) return null;
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    const root = listed?.find((entry) => entry.id === repo);
    if (listed === null || root?.directory === undefined || root.directory === null) return null;
    const current = (mission.placements ?? []).filter((placement) => placement.repo === repo && laneOf(placement) === 1).at(-1);
    const base = current?.state === "ready" ? current.base : checkpointBaseOf(home, mission, repo);
    if (base === null || !isCheckpointBranch(base)) return null;
    // What the root's Worker did after the checkpoint is not in it: the request then finishes in place.
    if ((await rootDiffersFrom(deps.git ?? runGit, root.directory, base)) !== false) return null;
    const made = await ensurePlacement(home, paseo, mission, repo, listed, deps);
    if (!made.ok) {
      deps.log(`[paseo-bm] the successor of a request of mission ${mission.code} stays in ${repo}: ${made.reasons.join("; ")}`);
      return null;
    }
    return made.placement.workspaceId === null || made.placement.directory === null ? null : { workspaceId: made.placement.workspaceId, directory: made.placement.directory };
  } catch (error) {
    deps.log(`[paseo-bm] could not tell where the successor of a request in ${request.workspaceId} works: ${errorText(error)}`);
    return null;
  }
}

/**
 * Moves a request from the repo's root into its mission's placement (§4.8
 * step 5): `registry.move` and the roster's `workspaceId`, then a journal
 * line. True when it lives in `to` now (already moved included). Never throws.
 */
export function moveRequestToPlacement(home: string, request: { requestId: string; missionId: string; from: string; to: string }, deps: Pick<PlacementDeps, "log" | "now">): boolean {
  const now = deps.now ?? (() => new Date());
  try {
    const registry = createRequestRegistry(home, { log: deps.log, now });
    const moved = registry.move(request.from, request.to, request.requestId);
    if (moved === "no-request" && !registry.has(request.to, request.requestId)) return false;
    createMissionRoster(home, { now }).moveWorkspace(request.missionId, request.requestId, request.to);
    if (moved === "moved") {
      journalQuietly(createMissionStore(home, { now }), request.missionId, { kind: "worker", by: "plugin", text: `${request.requestId} moved from the shared checkout ${request.from} into the mission's worktree ${request.to}.`, ref: request.requestId }, deps.log);
    }
    return true;
  } catch (error) {
    deps.log(`[paseo-bm] request ${request.requestId} could not move into the mission's worktree ${request.to}: ${errorText(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (§3.6).
// ---------------------------------------------------------------------------

/** `placements` with those of `removed` repos, or all when `closing`, retired (§3.6). Pure. */
export function retiredPlacements(placements: readonly Placement[], removed: ReadonlySet<string>, closing: boolean): Placement[] {
  return placements.map((placement): Placement =>
    (closing || removed.has(placement.repo)) && placement.state !== "archived" && placement.state !== "retired" ? { ...placement, state: "retired" } : placement,
  );
}

/** One placement's line of an archive card: uncommitted, unpushed and merge-request state, read with read-only git. */
async function stateLineOf(git: GitRunner, placement: Placement): Promise<{ text: string; dirty: boolean }> {
  const where = `${placement.directory ?? placement.workspaceId} on ${placement.branch}`;
  const directory = placement.directory;
  if (directory === null || !existsSync(directory)) return { text: `${where}: its folder is gone`, dirty: false };
  const status = await gitOut(git, directory, ["status", "--porcelain"]);
  const changed = status === null ? null : status.split("\n").filter((line) => line.trim() !== "").length;
  const pushed = await hasRef(git, directory, `refs/remotes/origin/${placement.branch}`);
  const ahead = (await gitOut(git, directory, ["rev-list", "--count", `${pushed ? `refs/remotes/origin/${placement.branch}` : placement.base}..HEAD`]))?.trim() ?? null;
  const uncommitted = changed === null ? "unknown" : changed === 0 ? "none" : `${changed} files`;
  const unpushed = ahead === null ? "unknown" : pushed ? (ahead === "0" ? "none" : `${ahead} commits`) : `${ahead} commits, the branch was never pushed`;
  const mr = placement.integration?.mr?.url ?? "none";
  return { text: `${where}: uncommitted changes ${uncommitted}; not pushed ${unpushed}; merge request ${mr}`, dirty: changed !== 0 };
}

/**
 * The owner's archive card (§3.6) for the mission's retired placements no
 * card named yet: one `m:` card, `ownerOnly`, listing each with its state;
 * "Commit first" is the default when a tree has uncommitted changes. Archiving
 * is the owner's in Paseo. Returns the card id, or null. Never throws.
 */
export async function openArchiveCards(home: string, missionId: string, deps: PlacementDeps): Promise<string | null> {
  const now = deps.now ?? (() => new Date());
  try {
    const mission = createMissionStore(home).get(missionId);
    const due = (mission?.placements ?? []).filter((placement) => placement.state === "retired" && placement.workspaceId !== null && placement.archiveCard === undefined);
    if (mission === null || due.length === 0) return null;
    const lines = await Promise.all(due.map((placement) => stateLineOf(deps.git ?? runGit, placement)));
    const dirty = lines.some((line) => line.dirty);
    const option = (key: string, label: string, recommended = false): DecisionOption => ({ key, label, recommended, effects: [] });
    const store = createMissionDecisionStore(home);
    const card: Decision = {
      id: store.nextId(missionId),
      workspaceId: missionId,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      askedAt: now().toISOString(),
      round: null,
      question: [
        `Mission ${mission.code}${mission.state === "closed" ? " is closed" : ""}: ${due.length === 1 ? "this worktree is" : "these worktrees are"} retired, and archiving is yours, in Paseo.`,
        ...lines.map((line) => `- ${line.text}`),
        "Archiving a worktree deletes its uncommitted changes; its branch and commits stay.",
      ]
        .join("\n")
        .slice(0, MAX_DECISION_TEXT_CHARS),
      subject: "worktree-archive",
      class: "data",
      options: dirty ? [option("a", "Commit first", true), option("b", "Archive it as it is"), option("c", "Keep it")] : [option("a", "Archive it in Paseo", true), option("b", "Keep it")],
      status: "open",
      settledAt: null,
      needsConfirmation: null,
      answer: null,
      grant: null,
      delivery: null,
      supersedes: null,
      supersededBy: null,
      ownerOnly: true,
    };
    store.open(card);
    for (const placement of due) save(home, missionId, { ...placement, archiveCard: card.id }, now);
    journalQuietly(createMissionStore(home, { now }), missionId, { kind: "decision", by: "plugin", text: `The owner's archive card ${card.id} names ${due.length} retired worktree${due.length === 1 ? "" : "s"}.`, ref: card.id }, deps.log);
    return card.id;
  } catch (error) {
    deps.log(`[paseo-bm] the archive card of mission ${missionId} could not be opened: ${errorText(error)}`);
    return null;
  }
}

/** `workspace.archived` (§3.6): the placement of `workspaceId`, if any, becomes `archived`. Never throws. */
export function placementArchived(home: string | null, workspaceId: string, deps: PlacementDeps): boolean {
  const entry = placementEntryOf(home, workspaceId);
  if (home === null || entry === null) return false;
  const now = deps.now ?? (() => new Date());
  try {
    const placement = (createMissionStore(home).get(entry.missionId)?.placements ?? []).find((candidate) => candidate.workspaceId === workspaceId);
    if (placement === undefined || placement.state === "archived") return false;
    save(home, entry.missionId, { ...placement, state: "archived" }, now);
    journalQuietly(createMissionStore(home, { now }), entry.missionId, { kind: "note", by: "plugin", text: `The worktree ${placement.directory ?? workspaceId} on ${placement.branch} was archived in Paseo; its branch keeps its commits.`, ref: workspaceId }, deps.log);
    return true;
  } catch (error) {
    deps.log(`[paseo-bm] the archived worktree ${workspaceId} could not be recorded: ${errorText(error)}`);
    return false;
  }
}

/**
 * The reload reconciliation (§3.3 step 4, §3.6): every mission's placements
 * against `workspaces.list` — a `creating` one Paseo lists is adopted, a
 * `ready` one it no longer lists (or lists archived) is `archived`, one of a
 * repo out of the charter or a closed mission is `retired`, a dependency
 * preparation a reload cut short is recorded as not prepared — then the
 * archive cards. Never throws.
 */
export async function reconcilePlacements(home: string, paseo: unknown, deps: PlacementDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  try {
    const store = createMissionStore(home);
    const missions = store.list().flatMap((entry) => {
      const mission = store.get(entry.missionId);
      return mission !== null && (mission.placements ?? []).length > 0 ? [mission] : [];
    });
    if (missions.length === 0) return;
    const listed = await listedWorkspaces(paseo as DashboardPaseo);
    if (listed === null) return;
    for (const mission of missions) {
      for (const placement of mission.placements ?? []) {
        const shown = placement.workspaceId === null ? undefined : listed.find((entry) => entry.id === placement.workspaceId);
        const out = mission.state === "closed" || !mission.charter.repos.includes(placement.repo);
        let next: Placement = placement;
        if (placement.state === "creating") {
          const root = listed.find((entry) => entry.id === placement.repo);
          const made = root?.projectId === undefined ? null : adoptionOf(placement, listed, root.projectId);
          if (made !== null && root?.directory !== undefined && root.directory !== null && root.projectId !== undefined) {
            const ctx: Context = {
              home,
              paseo: paseo as PlacementPaseo,
              mission,
              repo: placement.repo,
              name: basename(root.directory),
              root: { directory: root.directory, projectId: root.projectId },
              git: deps.git ?? runGit,
              clone: deps.clone ?? cloneCopyOnWrite,
              now,
              log: deps.log,
            };
            finish(ctx, placement, made);
            continue;
          }
        }
        if (placement.state === "ready" && (shown === undefined || shown.archived)) next = { ...next, state: "archived" };
        if (out && next.state !== "archived" && next.state !== "retired") next = { ...next, state: "retired" };
        if (next.state === "ready" && next.deps.at === null && next.deps.note === null && !preparing.has(next.requestKey)) {
          next = { ...next, deps: { cloned: [], at: now().toISOString(), note: "a plugin reload cut the dependency preparation short" } };
        }
        if (next !== placement) save(home, mission.missionId, next, now);
      }
      await openArchiveCards(home, mission.missionId, deps);
    }
  } catch (error) {
    deps.log(`[paseo-bm] the mission worktrees could not be reconciled: ${errorText(error)}`);
  }
}

/** After the owner's new code (§3.3 step 6): each live placement retitled with `setTitle`, never a new create. Never throws. */
export async function retitlePlacements(paseo: unknown, mission: Pick<Mission, "code" | "placements">, log: (message: string) => void): Promise<void> {
  const ref = (paseo as Partial<PlacementPaseo> | null | undefined)?.workspaces?.ref;
  if (typeof ref !== "function") return;
  for (const placement of mission.placements ?? []) {
    if (placement.state !== "ready" || placement.workspaceId === null || placement.requestBody === undefined) continue;
    try {
      const title = String((JSON.parse(placement.requestBody) as { title?: unknown }).title ?? "");
      const repoName = title.includes(" · ") ? title.slice(title.indexOf(" · ") + 3) : title;
      await ref(placement.workspaceId).setTitle?.(`${mission.code} · ${repoName}`);
    } catch (error) {
      log(`[paseo-bm] the worktree ${placement.workspaceId} could not be retitled: ${errorText(error)}`);
    }
  }
}

/**
 * The lifecycle the server registers (§3.6): `archived` for the
 * `workspace.archived` hook, and `run` at each shared Paseo handle — the
 * reconciliation at the first of a run, then at most every ten minutes.
 */
export function createPlacementLifecycle(deps: Partial<PlacementDeps> & { home?: () => string | null } = {}): { archived(workspaceId: unknown): void; run(paseo: unknown): Promise<void> } {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const homeOf = deps.home ?? (() => dataHome());
  const now = deps.now ?? (() => new Date());
  let last: number | null = null;
  let running = false;
  return {
    archived(workspaceId) {
      if (typeof workspaceId === "string" && workspaceId !== "") placementArchived(homeOf(), workspaceId, { ...deps, log });
    },
    async run(paseo) {
      const home = homeOf();
      if (home === null || running || (last !== null && now().getTime() - last < RECONCILE_EVERY_MS)) return;
      running = true;
      last = now().getTime();
      try {
        await reconcilePlacements(home, paseo, { ...deps, log });
      } finally {
        running = false;
      }
    },
  };
}
