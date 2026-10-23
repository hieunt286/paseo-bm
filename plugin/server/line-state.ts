/**
 * The state of a mission's line (delivery line design §4.5, §4.6): what the
 * plugin reads of a placement's worktree with read-only git, the primary
 * source since spike S1 — Paseo's descriptor (`gitRuntime`,
 * `githubRuntime.pullRequest`) only fills what git could not read.
 *
 * - `lineStateOf`: dirty, ahead and behind the integration branch, the last
 *   commit's time, `HEAD`, whether the worktree is on the mission branch, and
 *   how far `HEAD` is ahead of its pushed branch.
 * - `committedOf`: a placement request's `finished` is committed when its
 *   reported sha is an ancestor of `HEAD`, the worktree is on the mission
 *   branch and its tree is clean apart from ignored files (§4.6).
 * - `verifiedOf` (pure): with `integration.ci` off (the default, ADR-036,
 *   §17.1), a check the plugin detected (`shared/evidence.ts`), CI never
 *   read; on, the merge request's checks passed on a pushed head that
 *   contains the sha, before a merge request a detected check, and a failure
 *   is CI red.
 *
 * Every git command is one of `bm_repo`'s read-only kind
 * (`GIT_READ_ONLY_PREFIX`, `runGit`): no write, no fetch — Paseo fetches.
 * Never throws.
 */
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import type { Placement } from "./mission-store";
import { placementOfWorkspace } from "./placements";
import { verificationOf, type ChecksVerdict, type VerificationInput } from "../shared/evidence";
import { evidenceFromItem } from "./collector";
import type { ParsedReport, ReportCiState } from "../shared/contracts";
import type { IntegrationCi } from "../shared/coordination";

/** What the plugin read of a placement's worktree; a field git and the descriptor both failed to give is null. */
export interface LineState {
  /** Changes not committed, ignored files apart (`status --porcelain`). */
  dirty: boolean | null;
  /** Commits of `HEAD` not in `origin/<target>`, and the other way (`rev-list --left-right --count`). */
  ahead: number | null;
  behind: number | null;
  /** The last commit's committer time, ISO (`log -1 --format=%cI`). */
  lastCommitAt: string | null;
  /** `rev-parse HEAD`. */
  head: string | null;
  /** The worktree is on the mission branch. */
  branchOk: boolean | null;
  /** Commits of `HEAD` not in `origin/<branch>`; null before the branch is pushed. */
  aheadOfOrigin: number | null;
}

/** The descriptor's fields of a worktree workspace (§4.5), when Paseo lists them. */
export interface LineDescriptor {
  currentBranch?: string | null;
  isDirty?: boolean | null;
  aheadBehind?: { ahead: number; behind: number } | null;
  aheadOfOrigin?: number | null;
  behindOfOrigin?: number | null;
  /** `mergeable` false: the merge request cannot merge for conflicts; null when Paseo does not know. */
  pullRequest?: { url?: string; state?: string; checksStatus?: string | null; mergeable?: boolean | null } | null;
}

export interface LineStateDeps {
  /** How git runs; `runGit` by default. */
  git?: GitRunner;
  /** Paseo's descriptor of the placement's workspace, when the caller has one. */
  descriptor?: LineDescriptor | null;
}

const MAX_BYTES = 256 * 1024;

/** One read-only git command's output, or null when it failed. */
async function gitOut(git: GitRunner, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes: MAX_BYTES })).stdout;
  } catch {
    return null;
  }
}

/** `<left>\t<right>` of `rev-list --left-right --count`, as numbers; null when unreadable. */
function countsOf(out: string | null): [number, number] | null {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(out?.trim() ?? "");
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A merge request's `mergeable`, as a boolean or GitHub's `MERGEABLE` / `CONFLICTING`; null when unknown. */
function mergeableOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const word = typeof value === "string" ? value.toLowerCase() : "";
  return word === "mergeable" ? true : word === "conflicting" ? false : null;
}

/** The descriptor's fields of one `workspaces.list` entry (§4.5): `gitRuntime` and `githubRuntime.pullRequest`; null when it has neither. Pure. */
export function descriptorOf(entry: unknown): LineDescriptor | null {
  const workspace = record(record(entry)["workspace"] ?? entry);
  const git = workspace["gitRuntime"];
  const pr = record(workspace["githubRuntime"])["pullRequest"];
  if (git === undefined && (pr === undefined || pr === null)) return null;
  const runtime = record(git);
  const counts = record(runtime["aheadBehind"]);
  const ahead = numberOrNull(counts["ahead"]);
  const behind = numberOrNull(counts["behind"]);
  const request = record(pr);
  return {
    ...(typeof runtime["currentBranch"] === "string" ? { currentBranch: runtime["currentBranch"] } : {}),
    ...(typeof runtime["isDirty"] === "boolean" ? { isDirty: runtime["isDirty"] } : {}),
    ...(ahead === null || behind === null ? {} : { aheadBehind: { ahead, behind } }),
    aheadOfOrigin: numberOrNull(runtime["aheadOfOrigin"]),
    behindOfOrigin: numberOrNull(runtime["behindOfOrigin"]),
    ...(pr === undefined || pr === null
      ? {}
      : {
          pullRequest: {
            ...(typeof request["url"] === "string" ? { url: request["url"] } : {}),
            ...(typeof request["state"] === "string" ? { state: request["state"] } : {}),
            checksStatus: typeof request["checksStatus"] === "string" ? request["checksStatus"] : null,
            ...(mergeableOf(request["mergeable"]) === null ? {} : { mergeable: mergeableOf(request["mergeable"]) }),
          },
        }),
  };
}

/** The placement record itself, or the one whose workspace is `placement`. */
function resolved(home: string | null, placement: Placement | string): Placement | null {
  return typeof placement === "string" ? placementOfWorkspace(home, placement) : placement;
}

/**
 * The line's state of a placement (§4.5), read with read-only git in its
 * worktree; a field git cannot give comes from the descriptor when it has
 * it. `placement` is the record or its workspace id. Null for a placement
 * with no worktree yet, or a workspace that is none. Never throws.
 */
export async function lineStateOf(home: string | null, placement: Placement | string, deps: LineStateDeps = {}): Promise<LineState | null> {
  const place = resolved(home, placement);
  const cwd = place?.directory ?? null;
  if (place === null || cwd === null) return null;
  const git = deps.git ?? runGit;
  const descriptor = deps.descriptor ?? null;
  const [counts, status, last, head, branch, origin] = await Promise.all([
    gitOut(git, cwd, ["rev-list", "--left-right", "--count", `origin/${place.target}...HEAD`]).then(countsOf),
    gitOut(git, cwd, ["status", "--porcelain"]),
    gitOut(git, cwd, ["log", "-1", "--format=%cI"]),
    gitOut(git, cwd, ["rev-parse", "HEAD"]),
    gitOut(git, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitOut(git, cwd, ["rev-list", "--count", `origin/${place.branch}..HEAD`]),
  ]);
  const current = branch?.trim() || (descriptor?.currentBranch ?? null);
  const pushedAhead = /^\d+$/.test(origin?.trim() ?? "") ? Number(origin!.trim()) : null;
  return {
    dirty: status === null ? (descriptor?.isDirty ?? null) : status.trim() !== "",
    ahead: counts?.[1] ?? descriptor?.aheadBehind?.ahead ?? null,
    behind: counts?.[0] ?? descriptor?.aheadBehind?.behind ?? null,
    lastCommitAt: last?.trim() || null,
    head: head?.trim() || null,
    branchOk: current === null ? null : current === place.branch,
    aheadOfOrigin: pushedAhead ?? descriptor?.aheadOfOrigin ?? null,
  };
}

/** Whether a reported finish is committed (§4.6), and why not. */
export type Committed = { committed: true; line: LineState } | { committed: false; why: string; line: LineState | null };

/**
 * Whether `sha` is committed on the placement's mission branch (§4.6): an
 * ancestor of `HEAD` (`merge-base --is-ancestor`), the worktree on the
 * mission branch, and its tree clean apart from ignored files. Never throws.
 */
export async function committedOf(home: string | null, placement: Placement | string, sha: string, deps: LineStateDeps = {}): Promise<Committed> {
  const place = resolved(home, placement);
  const line = place === null ? null : await lineStateOf(home, place, deps);
  if (place === null || line === null || line.head === null) return { committed: false, why: "paseo-bm could not read the git of the mission's worktree", line };
  if (line.branchOk !== true) return { committed: false, why: `the worktree is not on ${place.branch}`, line };
  const git = deps.git ?? runGit;
  // `merge-base --is-ancestor` answers by its exit status: 0 an ancestor, anything else not (or no such commit).
  if ((await gitOut(git, place.directory!, ["merge-base", "--is-ancestor", sha, "HEAD"])) === null) return { committed: false, why: `${sha} is not in the history of ${place.branch}`, line };
  if (line.dirty !== false) return { committed: false, why: "the worktree has changes not committed", line };
  return { committed: true, line };
}

/** Whether a committed finish is verified (§4.6): `ci-red` on a failure, `pending` while the merge request's checks owe it. */
export type Verified = "verified" | "ci-red" | "pending" | "unverified";

export interface VerifiedInput {
  /** The owner's `integration.ci` (ADR-036): off reads only `checks`; the report's `ci` and the descriptor's checks are ignored. */
  ci: IntegrationCi;
  committed: boolean;
  /** The report's git fields: its `mr` and `ci`, as the Worker read them with glab. */
  integration?: ParsedReport["integration"];
  /** `HEAD` ahead of its pushed branch (`LineState.aheadOfOrigin`): 0 when the pushed head contains the sha. */
  aheadOfOrigin: number | null;
  /** `githubRuntime.pullRequest` when Paseo filled it: it wins over the report's. */
  pullRequest?: LineDescriptor["pullRequest"];
  /** The request's checks as the plugin labels them (`shared/evidence.ts`), for a line with no merge request yet. */
  checks?: ChecksVerdict | null;
}

/** The forge's CI state: the descriptor's `checksStatus` first, else the report's `ci`. */
function ciOf(input: VerifiedInput): ReportCiState | null {
  const status = input.pullRequest?.checksStatus?.toLowerCase();
  if (status === "success" || status === "failure" || status === "pending") return status;
  return input.integration?.ci ?? null;
}

/** §4.6, §17.1: verified, CI red, pending or unverified, from what the report and the descriptor say; with CI off, verified or unverified by the detected checks. Pure. */
export function verifiedOf(input: VerifiedInput): Verified {
  if (input.ci === "off") return input.committed && input.checks === "detected" ? "verified" : "unverified";
  const ci = ciOf(input);
  if (ci === "failure") return "ci-red";
  if (!input.committed) return "unverified";
  const hasMr = (input.pullRequest !== undefined && input.pullRequest !== null) || input.integration?.mr !== undefined;
  if (hasMr) {
    if (ci === "success" && input.aheadOfOrigin === 0) return "verified";
    return ci === "none" || ci === "not-run" ? "unverified" : "pending";
  }
  return input.checks === "detected" ? "verified" : "unverified";
}

/**
 * The line a placement request's `finished` delivery gains (§4.6): what the
 * plugin confirmed of its commit — "finished, uncommitted" and why, or
 * committed with its CI. Pure.
 */
export function finishedLineOf(committed: Committed, branch: string, verified: Verified): string {
  if (!committed.committed) return `finished, uncommitted: ${committed.why}.`;
  const ci = verified === "ci-red" ? "; CI red" : verified === "verified" ? "; verified" : verified === "pending" ? "; CI pending" : "";
  return `finished, committed on ${branch}${ci}.`;
}

/**
 * What a placement request's `finished` delivery said of its commit
 * (`finishedLineOf`, written when the report arrived): committed or not, and
 * its CI then. Null for a text with no such line. Pure.
 */
export function finishedLineFactsOf(text: string): { committed: boolean; verified: Verified } | null {
  const match = /^finished, (?:uncommitted: .*|committed on \S+?(?:; (CI red|verified|CI pending))?)\.$/m.exec(text);
  if (match === null) return null;
  if (match[0].startsWith("finished, uncommitted")) return { committed: false, verified: "unverified" };
  const verified: Verified = match[1] === "CI red" ? "ci-red" : match[1] === "verified" ? "verified" : match[1] === "CI pending" ? "pending" : "unverified";
  return { committed: true, verified };
}

/** One page of an agent's live timeline, as `readTimelinePages` (`live-timeline.ts`) hands it. */
export type TimelineEntries = ReadonlyArray<{ item?: unknown; timestamp?: unknown }>;

/**
 * ADR-036 (§17.1): a request's checks as paseo-bm detects them in its
 * Worker's own turns (`shared/evidence.ts`), from the newest pages of the
 * Worker's live timeline: the turn that reports is not recorded yet. The tail
 * is enough, as a check proves only after the last edit: an edit older than
 * the tail moves nothing. `pages` newest first, as read. Pure.
 */
export function liveChecksOf(pages: readonly TimelineEntries[], agentId: string, report: VerificationInput["report"], workspaceDirectory: string | null): ChecksVerdict {
  const evidence = [...pages].reverse().flat().flatMap((entry) => {
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (at === null || entry.item === null || typeof entry.item !== "object") return [];
    return evidenceFromItem(entry.item as Parameters<typeof evidenceFromItem>[0], agentId, at);
  });
  return verificationOf({ report, records: [{ agentId, endedAt: evidence.at(-1)?.at ?? "", evidence }], workspaceDirectory }).checks;
}
