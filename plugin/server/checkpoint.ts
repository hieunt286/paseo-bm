/**
 * The migration of missions on a shared checkout (delivery line design §4.8,
 * ADR-035 decision 3; owner decision 2026-10-20 "checkpoint, then split").
 *
 * - **Cut-over** (`writeCutOver`): the build's first start writes
 *   `missions/placement-mode.json { since }`; from then on a mission's Workers
 *   work in placements (`placement-create.ts` `placementModeOn`). A Worker
 *   already in a repo's root keeps its request and finishes in place.
 * - **The checkpoint** (`makeCheckpoint`): the plugin's only write into the
 *   owner's repository, run on the owner's own tap on the checkpoint card
 *   (`checkpoint-card.ts`). A temporary index outside the repository
 *   (`GIT_INDEX_FILE` in the OS temp folder) takes `read-tree HEAD`, `add -A`
 *   and `write-tree`; `commit-tree -p HEAD` (a follow-up: `-p` the previous
 *   checkpoint) and `git branch bm/checkpoint-<yyyymmdd>` (`-2`, `-3` when
 *   taken) follow. Objects and one ref only: the owner's HEAD, index and
 *   working tree are never touched, `.gitignore` holds, nothing is pushed.
 * - **What it is for**: `missions/checkpoints.json` records each offer and
 *   its outcome. A placement of a mission open at the checkpoint branches
 *   from the checkpoint **branch**, never its sha (spike S1:
 *   `checkpointBaseOf`); while its repo's offer is unsettled, a mission from
 *   before the cut-over keeps working in the repo's root (`checkpointWaitOf`).
 * - **A review call's snapshot** (`snapshotTree`, §17.2): the same temporary
 *   index up to `write-tree`, objects only — no commit, no ref.
 *
 * Every other git command here is read-only (`GIT_READ_ONLY_PREFIX`, with
 * `GIT_OPTIONAL_LOCKS=0`). Readers never throw.
 */
import { gitEnv } from "./repo-tool";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { UNSETTLED_STATUSES } from "../shared/decisions";
import { createJsonFileStore, ensureDataDir, writeFileAtomically, type JsonFileStore } from "./data-files";
import { createMissionDecisionStore } from "./mission-decisions";
import { MISSIONS_DIR_NAME, type Mission } from "./mission-store";
import { GIT_READ_ONLY_PREFIX, type GitRunner } from "./repo-tool";

/** The cut-over file (§4.8): from it on, a mission's Workers work in placements. */
export const PLACEMENT_MODE_FILE_NAME = "placement-mode.json";
export const CHECKPOINTS_FILE_NAME = "checkpoints.json";
/** Every checkpoint branch starts so (§4.8). */
export const CHECKPOINT_BRANCH_PREFIX = "bm/checkpoint-";
const CHECKPOINT_GIT_TIMEOUT_MS = 5 * 60_000;
/** Beyond this many changed paths the read-only comparison gives up (unknown). */
const MAX_COMPARED_PATHS = 2_000;
const UNWRITABLE = "E_TRACE_STORE_UNWRITABLE" as const;

// ---------------------------------------------------------------------------
// The cut-over.
// ---------------------------------------------------------------------------

/**
 * Writes `missions/placement-mode.json { since }` when it is missing (the
 * build's first start, §4.8); an existing file is never rewritten. Returns
 * true when it wrote it. Never throws: a failure is one log line.
 */
export function writeCutOver(home: string | null, now: Date, log: (message: string) => void): boolean {
  if (home === null) return false;
  const dir = join(home, MISSIONS_DIR_NAME);
  const path = join(dir, PLACEMENT_MODE_FILE_NAME);
  try {
    if (existsSync(path)) return false;
    ensureDataDir(home, dir, UNWRITABLE);
    writeFileAtomically(home, path, `${JSON.stringify({ since: now.toISOString() }, null, 2)}\n`, UNWRITABLE);
    return true;
  } catch (error) {
    log(`[paseo-bm] the cut-over to mission worktrees could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * When the cut-over happened: the file's `since`; null before it, and for a
 * file without a readable one (no build writes such a file: no mission then
 * counts as from before the cut-over). Never throws.
 */
export function cutOverSince(home: string | null): string | null {
  if (home === null) return null;
  try {
    const since = (JSON.parse(readFileSync(join(home, MISSIONS_DIR_NAME, PLACEMENT_MODE_FILE_NAME), "utf8")) as { since?: unknown } | null)?.since;
    return typeof since === "string" && !Number.isNaN(Date.parse(since)) ? since : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The offers and their outcomes.
// ---------------------------------------------------------------------------

const outcomeSchema = z.object({
  at: z.string(),
  /** made: the branch exists; declined: the owner said no; later: ask again once no Worker runs in the root; failed: git refused. */
  kind: z.enum(["made", "declined", "later", "failed"]),
  branch: z.string().optional(),
  commit: z.string().optional(),
  note: z.string().optional(),
});

const offerSchema = z.object({
  /** The repo key: the repo's root workspace. */
  repo: z.string().min(1),
  /** The root checkout's folder and name, as Paseo listed them at the offer. */
  directory: z.string().min(1),
  name: z.string(),
  /** The owner's `m:` card. */
  card: z.string().min(1),
  /** The open missions of the repo it was for. */
  missionIds: z.array(z.string()),
  openedAt: z.string(),
  /** The previous checkpoint branch a follow-up is parented on; null for the first. */
  parent: z.string().nullable(),
  /** Opened while a mission Worker still ran in the root: a "now anyway" card. */
  busy: z.boolean(),
  outcome: outcomeSchema.optional(),
});

export type CheckpointOffer = z.infer<typeof offerSchema>;
export type CheckpointOutcome = z.infer<typeof outcomeSchema>;

function offersFile(home: string): JsonFileStore<{ offers: CheckpointOffer[] }> {
  return createJsonFileStore<{ offers: CheckpointOffer[] }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: CHECKPOINTS_FILE_NAME,
    version: 1,
    parse: (body) => ({
      offers: (Array.isArray(body["offers"]) ? (body["offers"] as unknown[]) : []).flatMap((entry) => {
        const valid = offerSchema.safeParse(entry);
        return valid.success ? [valid.data] : [];
      }),
    }),
    empty: () => ({ offers: [] }),
    codes: { unwritable: UNWRITABLE },
    keepUnusable: true,
    cached: true,
  });
}

/** Every offer, oldest first; none when the file cannot be read. Never throws. */
export function checkpointOffers(home: string, repo?: string): CheckpointOffer[] {
  try {
    const offers = offersFile(home).read().offers;
    return repo === undefined ? offers : offers.filter((offer) => offer.repo === repo);
  } catch {
    return [];
  }
}

/** Records a new offer. Throws when the file cannot be written. */
export function addCheckpointOffer(home: string, offer: CheckpointOffer): void {
  offersFile(home).update((current) => ({ offers: [...current.offers, offerSchema.parse(offer)] }));
}

/** Sets the outcome of the offer of `card`; false when no offer names it. Throws when the file cannot be written. */
export function settleCheckpointOffer(home: string, card: string, outcome: CheckpointOutcome): boolean {
  let found = false;
  offersFile(home).update((current) => {
    const index = current.offers.findIndex((offer) => offer.card === card);
    if (index === -1) return null;
    found = true;
    return { offers: current.offers.map((offer, at) => (at === index ? { ...offer, outcome } : offer)) };
  });
  return found;
}

/** The offer whose card is `card`, or null. Never throws. */
export function offerOfCard(home: string, card: string): CheckpointOffer | null {
  return checkpointOffers(home).find((offer) => offer.card === card) ?? null;
}

/** True while an offer waits on the owner: no outcome and its card still unsettled. Never throws. */
export function isOfferOpen(home: string, offer: CheckpointOffer): boolean {
  if (offer.outcome !== undefined) return false;
  const card = createMissionDecisionStore(home).get(offer.card);
  return card !== null && UNSETTLED_STATUSES.includes(card.status);
}

/** The repo's newest checkpoint made: its branch, commit and time; null when none was. Never throws. */
export function latestCheckpointOf(home: string, repo: string): { branch: string; commit: string; at: string } | null {
  const made = checkpointOffers(home, repo)
    .filter((offer) => offer.outcome?.kind === "made" && offer.outcome.branch !== undefined)
    .at(-1)?.outcome;
  return made === undefined ? null : { branch: made.branch!, commit: made.commit ?? "", at: made.at };
}

/** True for a checkpoint branch name. Pure. */
export function isCheckpointBranch(name: string): boolean {
  return name.startsWith(CHECKPOINT_BRANCH_PREFIX);
}

/**
 * The base of a new placement of `repo` for `mission` (§4.8 step 3): the
 * repo's newest checkpoint **branch** when the mission was open at it; null
 * otherwise (the integration branch then). Never throws.
 */
export function checkpointBaseOf(home: string, mission: Pick<Mission, "createdAt">, repo: string): string | null {
  const checkpoint = latestCheckpointOf(home, repo);
  return checkpoint !== null && Date.parse(mission.createdAt) <= Date.parse(checkpoint.at) ? checkpoint.branch : null;
}

/**
 * Why a mission from before the cut-over has no usable checkpoint of `repo`
 * yet (§4.8, "checkpoint, then split"): the owner's checkpoint card for the
 * repo waits, was answered "later", or failed, or — none opened yet — the
 * root still holds work a checkpoint is offered for. Its Workers then work in
 * the repo's root, as before the cut-over (`ensurePlacement`). Null when its
 * worktree may be made. Never throws.
 */
export async function checkpointWaitOf(home: string, git: GitRunner, mission: Pick<Mission, "createdAt">, repo: string, root: string, name: string): Promise<string | null> {
  const since = cutOverSince(home);
  if (since === null || Date.parse(mission.createdAt) >= Date.parse(since)) return null;
  const offers = checkpointOffers(home, repo);
  const open = offers.find((offer) => isOfferOpen(home, offer));
  if (open !== undefined) return `the owner's checkpoint card ${open.card} for the shared checkout of ${name} waits for their answer`;
  const last = offers.at(-1);
  if (last?.outcome?.kind === "failed") return `the checkpoint of the shared checkout of ${name} failed and paseo-bm asks the owner again`;
  if (last?.outcome?.kind === "later") return `the owner asked to checkpoint the shared checkout of ${name} once no mission Worker works in it`;
  if (offers.length === 0 && (await rootHasWork(git, root))) return `paseo-bm asks the owner to checkpoint the shared checkout of ${name} first`;
  return null;
}

// ---------------------------------------------------------------------------
// Read-only git.
// ---------------------------------------------------------------------------

async function gitOut(git: GitRunner, cwd: string, args: readonly string[], maxBytes = 1024 * 1024): Promise<string | null> {
  try {
    return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes })).stdout;
  } catch {
    return null;
  }
}

/** True when the root has uncommitted or untracked (not ignored) files, or commits its upstream lacks. Never throws. */
export async function rootHasWork(git: GitRunner, root: string): Promise<boolean> {
  const status = await gitOut(git, root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status !== null && status.trim() !== "") return true;
  const ahead = (await gitOut(git, root, ["rev-list", "--count", "@{upstream}..HEAD"]))?.trim() ?? "0";
  return /^\d+$/.test(ahead) && ahead !== "0";
}

/** The paths of `git status --porcelain=v1 -z`: both sides of a rename. Pure. */
export function statusPathsOf(output: string): string[] {
  const tokens = output.split("\0");
  const paths: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at]!;
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    if (token[0] === "R" || token[0] === "C") {
      const from = tokens[at + 1];
      if (from !== undefined && from !== "") paths.push(from);
      at += 1;
    }
  }
  return paths;
}

/** Git's blob id of `content` (sha1 repositories). Pure. */
const blobIdOf = (content: Buffer): string => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/**
 * Whether the root's working tree (tracked and untracked, ignored files left
 * out) differs from `ref` (§4.8 step 5): true, false, or null when it cannot
 * tell. Read-only: `status`, `diff` of two commits, `ls-tree` and
 * `hash-object` without `-w`; nothing is written. Never throws.
 */
export async function rootDiffersFrom(git: GitRunner, root: string, ref: string): Promise<boolean | null> {
  const status = await gitOut(git, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 16 * 1024 * 1024);
  const diff = await gitOut(git, root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ref, "--"], 16 * 1024 * 1024);
  if (status === null || diff === null) return null;
  const paths = [...new Set([...statusPathsOf(status), ...diff.split("\0").filter((path) => path !== "")])];
  if (paths.length === 0) return false;
  if (paths.length > MAX_COMPARED_PATHS) return null;
  const listing = await gitOut(git, root, ["--literal-pathspecs", "ls-tree", "-z", "-r", "--full-tree", ref, "--", ...paths], 16 * 1024 * 1024);
  if (listing === null) return null;
  const inTree = new Map<string, { mode: string; type: string; id: string }>();
  for (const line of listing.split("\0")) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    if (match !== null) inTree.set(match[4]!, { mode: match[1]!, type: match[2]!, id: match[3]! });
  }
  const files: Array<{ path: string; id: string }> = [];
  for (const path of paths) {
    const entry = inTree.get(path);
    let stat: Stats;
    try {
      stat = lstatSync(join(root, path));
    } catch {
      if (entry !== undefined) return true;
      continue;
    }
    if (entry === undefined || entry.type !== "blob" || entry.id.length !== 40) return entry === undefined ? true : null;
    if (stat.isSymbolicLink()) {
      if (entry.mode !== "120000" || blobIdOf(Buffer.from(readlinkSync(join(root, path)))) !== entry.id) return true;
    } else if (stat.isFile()) {
      if ((entry.mode === "100755") !== ((stat.mode & 0o111) !== 0) || entry.mode === "120000") return true;
      files.push({ path, id: entry.id });
    } else return true;
  }
  for (let at = 0; at < files.length; at += 200) {
    const chunk = files.slice(at, at + 200);
    const ids = await gitOut(git, root, ["hash-object", "--", ...chunk.map((file) => file.path)]);
    if (ids === null) return null;
    const lines = ids.split("\n").filter((line) => line !== "");
    if (lines.length !== chunk.length) return null;
    if (chunk.some((file, index) => lines[index] !== file.id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The one write (§4.8 step 2).
// ---------------------------------------------------------------------------

/** Runs one git command of the checkpoint with `env`; rejects on a non-zero exit. */
export type CheckpointGit = (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;

/** A `CheckpointGit` over `execFile("git")`, no shell, stopped after `timeoutMs`. */
function checkpointGitOf(timeoutMs: number): CheckpointGit {
  return (args, { cwd, env }) =>
    new Promise((done, fail) => {
      execFile("git", [...args], { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error === null) done(stdout);
        else fail(new Error(`git ${args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? ""} failed: ${(stderr || error.message).trim().split("\n")[0]}`));
      });
    });
}

export const runCheckpointGit: CheckpointGit = checkpointGitOf(CHECKPOINT_GIT_TIMEOUT_MS);
/** A review call's snapshot (§17.2) waits at most a minute per git command. */
export const runSnapshotGit: CheckpointGit = checkpointGitOf(60_000);

/** The environment of the checkpoint's git: the temporary index, no prompt, no repository named by the plugin's own environment. */
function checkpointEnv(index: string, identity: boolean): NodeJS.ProcessEnv {
  // The read tool's environment (`repo-tool.ts` gitEnv: the GIT_* variables that would redirect git removed), plus the temporary index.
  const fallback = identity ? {} : { GIT_AUTHOR_NAME: "paseo-bm", GIT_AUTHOR_EMAIL: "paseo-bm@localhost", GIT_COMMITTER_NAME: "paseo-bm", GIT_COMMITTER_EMAIL: "paseo-bm@localhost" };
  return { ...gitEnv(), ...fallback, GIT_INDEX_FILE: index };
}

/** `bm/checkpoint-<yyyymmdd>` of `at` (UTC). Pure. */
export function checkpointBranchOf(at: Date): string {
  return `${CHECKPOINT_BRANCH_PREFIX}${at.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

export interface MadeCheckpoint {
  branch: string;
  commit: string;
  /** The commits it is parented on: HEAD, or the previous checkpoint (and HEAD when it moved on since). */
  parents: string[];
}

/**
 * Makes the checkpoint of the checkout at `root` (§4.8 step 2): its state as
 * it is — HEAD, uncommitted and untracked files, ignored ones left out — as a
 * commit on a new branch `bm/checkpoint-<yyyymmdd>` (`-2`, `-3` when taken),
 * parented on HEAD, or for a follow-up on the `parent` branch. The temporary
 * index lives in the OS temp folder and is removed on every path; the
 * owner's HEAD, `.git/index` and working tree are never touched, and nothing
 * is pushed. Rejects with the reason when git refuses (nothing but objects
 * may then be left).
 */
export async function makeCheckpoint(root: string, options: { now: Date; message: string; parent?: string | null; git?: CheckpointGit }): Promise<MadeCheckpoint> {
  return onTemporaryIndex(root, options.git ?? runCheckpointGit, async (run) => {
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => {
      throw new Error("the checkout has no commit yet, so there is nothing to branch from");
    });
    const parents = [head];
    if (options.parent !== undefined && options.parent !== null) {
      const previous = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${options.parent}^{commit}`]).catch(() => {
        throw new Error(`the previous checkpoint branch ${options.parent} no longer exists`);
      });
      // The owner's own commits since the previous checkpoint stay in the history as a second parent.
      const contained = await run(["merge-base", "--is-ancestor", head, previous]).then(
        () => true,
        () => false,
      );
      parents.splice(0, 1, previous, ...(contained ? [] : [head]));
    }
    const tree = await workingTreeOf(run);
    const identity = (await run(["config", "--get", "user.email"]).catch(() => "")) !== "";
    const commit = await run(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", options.message], identity);
    const stem = checkpointBranchOf(options.now);
    for (let n = 1; n < 100; n += 1) {
      const branch = n === 1 ? stem : `${stem}-${n}`;
      const taken = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
        () => true,
        () => false,
      );
      if (taken) continue;
      await run(["branch", branch, commit]);
      return { branch, commit, parents };
    }
    throw new Error(`the branches ${stem} to ${stem}-99 all exist`);
  });
}

/** One git command on the temporary index, its output trimmed; `identity` false adds the fallback author (§3.8). */
type TemporaryIndexGit = (args: readonly string[], identity?: boolean) => Promise<string>;

/**
 * Runs `work` with git in `root` on a temporary index (§4.8, §17.2): a
 * `GIT_INDEX_FILE` in a new folder of the OS temp folder, removed on every
 * path, the environment `repo-tool.ts` `gitEnv`'s, and no background
 * maintenance, split index or untracked cache (those would write files beside
 * `.git/index`).
 */
async function onTemporaryIndex<T>(root: string, git: CheckpointGit, work: (run: TemporaryIndexGit) => Promise<T>): Promise<T> {
  const temp = mkdtempSync(join(tmpdir(), "bm-checkpoint-"));
  try {
    const index = join(temp, "index");
    const prefix = [...GIT_READ_ONLY_PREFIX, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.splitIndex=false", "-c", "core.untrackedCache=false"];
    return await work((args, identity = true) => git([...prefix, ...args], { cwd: root, env: checkpointEnv(index, identity) }).then((out) => out.trim()));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The working tree as a tree object on the temporary index: `read-tree HEAD`, `add -A` (`.gitignore` holds), `write-tree`. */
async function workingTreeOf(run: TemporaryIndexGit): Promise<string> {
  await run(["read-tree", "HEAD"]);
  await run(["add", "-A"]);
  return run(["write-tree"]);
}

/**
 * The snapshot of a review call (delivery line design §17.2, ADR-036): the
 * working tree at `root` — HEAD, uncommitted and untracked files, ignored
 * ones left out — written as a tree object on a temporary index, and its id.
 * Objects only: no ref, and the owner's HEAD, `.git/index` and files are never
 * touched. Rejects when git refuses (no repository, no commit yet).
 */
export async function snapshotTree(root: string, options: { git?: CheckpointGit } = {}): Promise<string> {
  return onTemporaryIndex(root, options.git ?? runSnapshotGit, workingTreeOf);
}
