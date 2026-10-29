/**
 * Two lanes changing the same files (delivery line design §19.3, ADR-038
 * decision 2): the Main is told, and steps in.
 *
 * A lane in use is lane 1 (the mission branch) and every lane n ≥ 2 that is
 * not free. What a lane changes:
 * - **lane 1:** its uncommitted files (its commits are the mission branch the
 *   others start from);
 * - **lane n ≥ 2:** the files of `<base>...<branch>` (since it left the
 *   mission branch) and its uncommitted files.
 *
 * Read with read-only git, at the governor's pass. For each pair of lanes in
 * use of one repo that share files, the Main gets one `BM-SIGNAL overlap` on
 * its channel. It is said again only when the shared files grow: the files
 * already told are kept on the higher lane (`overlapTold`). Never throws.
 */
import { SIGNAL_NOTICE_MARKER } from "../shared/notices";
import { statusPathsOf } from "./checkpoint";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import { createMissionRoster } from "./mission-roster";
import { createMissionStore, type Mission, type Placement } from "./mission-store";
import type { NoticePaseo } from "./notice-queue";
import { laneOf } from "./placements";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import { errorText } from "./rpc-kit";

/** The most files one signal names. */
const FILES_SHOWN = 12;

export interface LaneOverlapDeps {
  git?: GitRunner;
  now?: () => Date;
  log: (message: string) => void;
  paseo?: NoticePaseo;
  queue?: ChannelQueue;
}

/** One lane's changed files, or null when git could not read them. */
export async function laneFilesOf(git: GitRunner, lane: Placement): Promise<string[] | null> {
  if (lane.directory === null) return null;
  const read = async (args: readonly string[]) => {
    try {
      return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd: lane.directory!, maxBytes: 1024 * 1024 })).stdout;
    } catch {
      return null;
    }
  };
  const status = await read(["status", "--porcelain=v1", "-z"]);
  if (status === null) return null;
  const files = new Set(statusPathsOf(status));
  if (laneOf(lane) >= 2) {
    const diff = await read(["diff", "--name-only", `${lane.base}...${lane.branch}`]);
    if (diff === null) return null;
    for (const file of diff.split("\n").map((line) => line.trim())) if (file !== "") files.add(file);
  }
  return [...files].sort();
}

/** The `BM-SIGNAL overlap` to a Main. Pure. */
export function overlapSignalOf(input: { repo: string; lanes: [number, number]; requests: [string[], string[]]; files: string[] }): string {
  const [a, b] = input.lanes;
  const work = (lane: number, requests: string[]) => `lane ${lane}: ${requests.join(", ") || "no live request"}`;
  const shown = input.files.slice(0, FILES_SHOWN).join(", ") + (input.files.length > FILES_SHOWN ? `, and ${input.files.length - FILES_SHOWN} more` : "");
  return [
    `${SIGNAL_NOTICE_MARKER} overlap`,
    `From the paseo-bm plugin, not the owner: lanes ${a} and ${b} of ${input.repo} both change ${shown} (${work(a, input.requests[0])}; ${work(b, input.requests[1])}).`,
    "Step in now: tell one lane to wait, give the files to one of them, or split the work again (bm_tell_worker to each). Their merges would otherwise conflict.",
  ].join("\n");
}

/** The lanes in use of each repo of `mission`: lane 1 when ready, and every ready lane n ≥ 2 that is not free. Pure. */
export function lanesInUseOf(mission: Pick<Mission, "placements">): Map<string, Placement[]> {
  const newest = new Map<string, Placement>();
  for (const placement of mission.placements ?? []) newest.set(`${placement.repo}#${laneOf(placement)}`, placement);
  const byRepo = new Map<string, Placement[]>();
  for (const placement of newest.values()) {
    if (placement.state !== "ready" || placement.directory === null) continue;
    if (laneOf(placement) >= 2 && typeof placement.freeSince === "string") continue;
    byRepo.set(placement.repo, [...(byRepo.get(placement.repo) ?? []), placement]);
  }
  for (const lanes of byRepo.values()) lanes.sort((a, b) => laneOf(a) - laneOf(b));
  return byRepo;
}

/** Reads the lanes in use of every open mission and tells each Main of new shared files (see the module comment). Never throws. */
export async function checkLaneOverlaps(home: string, deps: LaneOverlapDeps): Promise<void> {
  const git = deps.git ?? runGit;
  try {
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    for (const entry of store.list().filter((mission) => mission.state === "open")) {
      const mission = store.get(entry.missionId);
      if (mission === null || mission.mainId === null) continue;
      const active = createMissionRoster(home)
        .list(mission.missionId)
        .filter((request) => request.state === "active");
      for (const [repo, lanes] of lanesInUseOf(mission)) {
        if (lanes.length < 2) continue;
        const files = new Map<string, string[] | null>();
        for (const lane of lanes) files.set(lane.requestKey, await laneFilesOf(git, lane));
        for (let i = 0; i < lanes.length; i += 1) {
          for (let j = i + 1; j < lanes.length; j += 1) {
            const [a, b] = [lanes[i]!, lanes[j]!];
            const left = files.get(a.requestKey);
            const right = files.get(b.requestKey);
            if (!left || !right) continue;
            const shared = left.filter((file) => right.includes(file));
            const told = new Set(b.overlapTold?.[String(laneOf(a))] ?? []);
            if (shared.length === 0 || shared.every((file) => told.has(file))) continue;
            const requestsOf = (lane: Placement) => active.filter((request) => request.workspaceId === lane.workspaceId).map((request) => request.requestId);
            const name = a.directory?.split("/").at(-1) ?? repo;
            const text = overlapSignalOf({ repo: name, lanes: [laneOf(a), laneOf(b)], requests: [requestsOf(a), requestsOf(b)], files: shared });
            await enqueueNotice({
              home,
              targetId: mission.mainId,
              kind: `signal-overlap:${b.requestKey}:${laneOf(a)}`,
              text,
              ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }),
              ...(deps.queue === undefined ? {} : { queue: deps.queue }),
            });
            const toldAt = (deps.now?.() ?? new Date()).toISOString();
            store.update(mission.missionId, (current) => ({
              ...current,
              placements: (current.placements ?? []).map((placement) =>
                placement.requestKey === b.requestKey
                  ? { ...placement, overlapTold: { ...(placement.overlapTold ?? {}), [String(laneOf(a))]: shared }, overlapToldAt: { ...(placement.overlapToldAt ?? {}), [String(laneOf(a))]: toldAt } }
                  : placement,
              ),
            }));
            deps.log(`[paseo-bm] lanes ${laneOf(a)} and ${laneOf(b)} of mission ${mission.code} in ${name} share ${shared.length} file(s); the Main was told.`);
          }
        }
      }
    }
  } catch (error) {
    deps.log(`[paseo-bm] the lanes' shared files could not be checked: ${errorText(error)}`);
  }
}
