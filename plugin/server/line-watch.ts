/**
 * The lines of the open missions, read at most once a minute (delivery line
 * design §4.7, §4.9): what the mission state, the governor's figures and its
 * early merge-conflict signal read of each placement, without running git on
 * every recorded turn.
 *
 * - `refreshLines` — the governor's 60-second pass (and the conflict pass
 *   after it): for each ready placement of an open mission whose line is
 *   older than `LINE_REFRESH_MS`, `lineStateOf` (read-only git), when it is
 *   ahead the time of its oldest commit not in `origin/<target>`, and, only
 *   for a repo two open placements share, `git diff --name-only
 *   origin/<target>...<branch>`. One `workspaces.list` gives Paseo's
 *   descriptor when the caller has a handle. Concurrent calls share one run.
 * - `cachedLineOf` — synchronous, no git: the last read of a placement, or
 *   null before its first read of the run.
 * - `placementStateOf` (pure) — a placement's line as the mission state
 *   holds it (§4.9), from that read and the newest report's git fields
 *   (§4.4): the descriptor first, then git, then the report; with
 *   `integration.ci` off (ADR-036, §17.1) its CI is never read (null).
 *
 * The cache lives in memory only: a reload reads every line again at its
 * first pass. Never throws.
 */
import { parseReports } from "../shared/bm-report";
import type { ParsedReport } from "../shared/contracts";
import type { MissionStatePlacement } from "../shared/mission-state";
import type { IntegrationCi } from "../shared/coordination";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import { descriptorOf, lineStateOf, type LineDescriptor, type LineState } from "./line-state";
import { createMissionStore, type Mission, type Placement } from "./mission-store";
import { laneOf } from "./placements";

/** How old a line may be before the next pass reads it again. */
export const LINE_REFRESH_MS = 60_000;
/** The most changed files one placement keeps for the overlap (§4.7). */
export const MAX_CHANGED_FILES = 2_000;

/** One placement's line as last read. */
export interface PlacementLine {
  at: string;
  line: LineState | null;
  descriptor: LineDescriptor | null;
  /** Committer time of its oldest commit not in `origin/<target>`; null when not ahead or unreadable. */
  firstAheadAt: string | null;
  /** Since when the descriptor's checks read `failure`; null while they do not. */
  redSince: string | null;
  /** The files its branch changes against `origin/<target>` (§4.7); null when not read: no other open placement shares its repo. */
  changed: string[] | null;
}

/** The SDK slice a refresh reads: `workspaces.list`, when the handle has it. */
export interface LinePaseo {
  workspaces?: { list?: (options?: unknown) => Promise<{ entries: ReadonlyArray<Record<string, unknown>> }> };
}

export interface LineWatchDeps {
  now?: () => Date;
  git?: GitRunner;
  paseo?: LinePaseo | null;
  log?: (message: string) => void;
}

const cache = new Map<string, Map<string, PlacementLine>>();
const running = new Map<string, Promise<void>>();

/** The last read of the placement whose workspace is `workspaceId`; null before its first read of the run. No git. */
export function cachedLineOf(home: string, workspaceId: string | null): PlacementLine | null {
  return workspaceId === null ? null : (cache.get(home)?.get(workspaceId) ?? null);
}

/** Forgets every read line (tests). */
export function clearLineCache(): void {
  cache.clear();
  running.clear();
}

/** A mission's newest placement of each repo (§3.2: a retry appends a record), in charter order of first appearance. Pure. */
export function newestPlacementsOf(mission: Pick<Mission, "placements">): Placement[] {
  const byRepo = new Map<string, Placement>();
  // Delivery line design §19.1: the line is the mission branch, lane 1; other lanes merge into it.
  for (const placement of mission.placements ?? []) if (laneOf(placement) === 1) byRepo.set(placement.repo, placement);
  return [...byRepo.values()];
}

/** The ready placements of every open mission, each with its mission. */
function openPlacementsOf(home: string): Array<{ missionId: string; placement: Placement }> {
  const store = createMissionStore(home);
  return store
    .list()
    .filter((entry) => entry.state === "open")
    .flatMap((entry) => {
      const mission = store.get(entry.missionId);
      if (mission === null) return [];
      return newestPlacementsOf(mission)
        .filter((placement) => placement.state === "ready" && placement.workspaceId !== null && placement.directory !== null)
        .map((placement) => ({ missionId: mission.missionId, placement }));
    });
}

async function gitLines(git: GitRunner, cwd: string, args: readonly string[]): Promise<string[] | null> {
  try {
    const { stdout } = await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes: 256 * 1024 });
    return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  } catch {
    return null;
  }
}

async function readOne(placement: Placement, deps: { git: GitRunner; descriptor: LineDescriptor | null; shared: boolean; before: PlacementLine | null; at: Date }): Promise<PlacementLine> {
  const line = await lineStateOf(null, placement, { git: deps.git, descriptor: deps.descriptor });
  const cwd = placement.directory!;
  // `log` lists newest first: the last line is the oldest commit the line is ahead with.
  const firstAheadAt = line !== null && (line.ahead ?? 0) > 0 ? ((await gitLines(deps.git, cwd, ["log", "--format=%cI", `origin/${placement.target}..HEAD`]))?.at(-1) ?? null) : null;
  const changed = deps.shared ? ((await gitLines(deps.git, cwd, ["diff", "--name-only", `origin/${placement.target}...${placement.branch}`]))?.slice(0, MAX_CHANGED_FILES) ?? null) : null;
  const red = deps.descriptor?.pullRequest?.checksStatus?.toLowerCase() === "failure";
  return {
    at: deps.at.toISOString(),
    line,
    descriptor: deps.descriptor,
    firstAheadAt,
    redSince: red ? (deps.before?.redSince ?? deps.at.toISOString()) : null,
    changed,
  };
}

async function refresh(home: string, deps: LineWatchDeps): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const git = deps.git ?? runGit;
  const open = openPlacementsOf(home);
  const known = cache.get(home) ?? new Map<string, PlacementLine>();
  cache.set(home, known);
  // A placement no longer open and ready is no longer read, nor kept.
  const live = new Set(open.map(({ placement }) => placement.workspaceId!));
  for (const workspaceId of [...known.keys()]) if (!live.has(workspaceId)) known.delete(workspaceId);
  const due = open.filter(({ placement }) => {
    const before = known.get(placement.workspaceId!);
    return before === undefined || at.getTime() - (Date.parse(before.at) || 0) >= LINE_REFRESH_MS;
  });
  if (due.length === 0) return;
  // §4.7: the diff is read only where two open missions share a repo.
  const missionsOfRepo = new Map<string, Set<string>>();
  for (const { missionId, placement } of open) missionsOfRepo.set(placement.repo, (missionsOfRepo.get(placement.repo) ?? new Set()).add(missionId));
  let descriptors: Map<string, LineDescriptor> | null = null;
  const list = deps.paseo?.workspaces?.list;
  if (typeof list === "function") {
    try {
      const { entries } = await list.call(deps.paseo!.workspaces);
      descriptors = new Map(
        entries.flatMap((entry) => {
          const workspace = (entry["workspace"] ?? entry) as Record<string, unknown>;
          const descriptor = descriptorOf(entry);
          return descriptor === null ? [] : [[String(workspace["id"] ?? ""), descriptor] as const];
        }),
      );
    } catch (error) {
      deps.log?.(`[paseo-bm] the lines of the missions could not read Paseo's workspaces: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await Promise.all(
    due.map(async ({ placement }) => {
      const workspaceId = placement.workspaceId!;
      const before = known.get(workspaceId) ?? null;
      // Without a handle, the descriptor last read stays.
      const descriptor = descriptors === null ? (before?.descriptor ?? null) : (descriptors.get(workspaceId) ?? null);
      known.set(workspaceId, await readOne(placement, { git, descriptor, shared: (missionsOfRepo.get(placement.repo)?.size ?? 0) > 1, before, at }));
    }),
  );
}

/**
 * Reads again every line of the open missions older than `LINE_REFRESH_MS`
 * (see the module comment). A call while one runs for `home` waits for it.
 * Never throws.
 */
export async function refreshLines(home: string, deps: LineWatchDeps = {}): Promise<void> {
  const current = running.get(home);
  if (current !== undefined) return current;
  const run = refresh(home, deps)
    .catch((error: unknown) => deps.log?.(`[paseo-bm] the lines of the missions could not be read: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => running.delete(home));
  running.set(home, run);
  return run;
}

/** The git fields of the newest report of a placement's requests that names some (§4.4), and when it came. */
export interface ReportedLine {
  at: string;
  integration: NonNullable<ParsedReport["integration"]>;
}

/** The git fields of a report record's text; null when it names none. Pure. */
export function reportedLineOf(record: { text: string; at: string }): ReportedLine | null {
  const integration = parseReports(record.text, { agentId: "", at: record.at }).find((report) => report.integration !== undefined)?.integration;
  return integration === undefined ? null : { at: record.at, integration };
}

/** A placement's line with what the governor reads besides (§4.9): since when it is ahead, and since when CI is red. */
export interface PlacementFacts extends MissionStatePlacement {
  firstAheadAt: string | null;
  ciSince: string | null;
}

const CI_OF_CHECKS = new Set(["success", "failure", "pending"]);

/** The forge's CI from Paseo's descriptor, when its checks name one; else null. */
function checksCiOf(cached: PlacementLine | null): string | null {
  const checks = cached?.descriptor?.pullRequest?.checksStatus?.toLowerCase() ?? null;
  return checks !== null && CI_OF_CHECKS.has(checks) ? checks : null;
}

/**
 * A placement's line (§4.9) from its last read (`cachedLineOf`) and its
 * requests' newest reported git fields: the merge request and CI from
 * Paseo's descriptor when it has them, else from the report; pushed from git
 * (`origin/<branch>` holds `HEAD`), else from the report. With CI off
 * (§17.1) its `ci` is null: neither the descriptor's checks nor the report's
 * `ci` is read. Pure.
 */
export function placementStateOf(placement: Placement, cached: PlacementLine | null, reported: ReportedLine | null, name: string | null, ci: IntegrationCi): MissionStatePlacement {
  const line = cached?.line ?? null;
  const read = line !== null && line.head !== null;
  const pr = cached?.descriptor?.pullRequest ?? null;
  const mrUrl = pr?.url ?? reported?.integration.mr ?? placement.integration?.mr?.url ?? null;
  return {
    repo: placement.repo,
    name,
    workspaceId: placement.workspaceId,
    branch: placement.branch,
    target: placement.target,
    state: placement.state,
    dirty: line?.dirty ?? null,
    ahead: line?.ahead ?? null,
    behind: line?.behind ?? null,
    lastCommitAt: line?.lastCommitAt ?? null,
    pushed: read ? line.aheadOfOrigin === 0 : (reported?.integration.pushed ?? null),
    mr: mrUrl === null ? null : { url: mrUrl, state: pr?.state ?? null, mergeable: pr?.mergeable ?? null },
    ci: ci === "off" ? null : (checksCiOf(cached) ?? reported?.integration.ci ?? null),
    grant: placement.integration?.state === "granted" ? { at: placement.integration.grantedAt } : null,
    readAt: cached?.at ?? null,
  };
}

/** `placementStateOf` with since when the line is ahead and since when its CI is red: the descriptor's first red read, else the report's time. Pure. */
export function placementFactsOf(placement: Placement, cached: PlacementLine | null, reported: ReportedLine | null, name: string | null, ci: IntegrationCi): PlacementFacts {
  const state = placementStateOf(placement, cached, reported, name, ci);
  const fromChecks = checksCiOf(cached) !== null;
  return {
    ...state,
    firstAheadAt: cached?.firstAheadAt ?? null,
    ciSince: state.ci !== "failure" ? null : fromChecks ? (cached?.redSince ?? null) : (reported?.at ?? null),
  };
}
