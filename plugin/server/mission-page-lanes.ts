/**
 * What the mission page shows of parallel lanes and of the Waiting list
 * (delivery line design §19.8, ADR-038 decision 6; mockup
 * `mission-lanes.html`, artboards Q and R), read for `mission.get`.
 *
 * - **Lanes** (`laneViewsOf`): lane 1 (the mission branch) and every live
 *   lane n ≥ 2 of a repo (`creating`, or `ready` and still listed by Paseo),
 *   each with the active roster requests in its workspace, their live Workers,
 *   and its free and merge state as the placement stores it (§19.1, §19.2).
 * - **Overlap** (`overlapsOf`): the shared files the Main was told of
 *   (`overlapTold` on the higher lane, §19.3), between lanes still in use. A
 *   line told before the higher lane took its current work is left out.
 * - **Waiting** (`waitingOf`): held requests (§19.6) with what they wait for,
 *   and tells to the mission's busy Workers — a `bm_tell_worker` message
 *   still open in the outbox (waiting for its turn's end, or held by the wake
 *   gate), or steered into a turn within the last `STEERED_SHOWN_MS` (§19.5).
 *   The newest `MISSION_WAITING_SHOWN`, oldest first.
 * - **The line** (`lineOf`, ADR-045 decision 5): the step the newest approved
 *   line is at, what it waits for or why it stopped; a `started` step's stop
 *   reads from its `stopNote`.
 *
 * Reads only, and runs no git: the git state is the cached line the
 * Repositories row already reads. Never throws.
 */
import type { MissionGetOutput, MissionLane, MissionLine, MissionOverlap, MissionWaiting } from "../shared/contracts";
import { afterStateOf, heldRequestsOf, stopNoteOf, type HeldRequest } from "./held-requests";
import { lanesInUseOf } from "./lane-overlap";
import type { RosterEntry } from "./mission-roster";
import type { Mission, Placement } from "./mission-store";
import { createOutbox, isOpenRecord } from "./outbox";
import type { ListedWorkspace } from "./paseo-directory";
import { lanesOf } from "./placement-create";
import { charterKeysOf, laneOf, repoKeyOf } from "./placements";
import { firstLine } from "./request-trace";
import { chainHeadOf } from "./waits";

/** The Waiting lines `mission.get` carries, the newest. */
export const MISSION_WAITING_SHOWN = 10;
/** How long a steered tell stays on the Waiting list. */
export const STEERED_SHOWN_MS = 30 * 60_000;

const oneLine = (text: string): string => firstLine(text, process.env) ?? text;

/** The live lanes of `repo`, lane 1 first (see the module comment). Pure but for the topic's masking. */
export function laneViewsOf(mission: Pick<Mission, "placements">, repo: string, roster: readonly RosterEntry[], live: ReadonlySet<string>, listed: readonly ListedWorkspace[] | null): MissionLane[] {
  const first = (mission.placements ?? []).filter((placement) => placement.repo === repo && laneOf(placement) === 1).at(-1);
  const shown = (placement: Placement) =>
    placement.state === "creating" || (placement.state === "ready" && (listed === null || listed.some((entry) => entry.id === placement.workspaceId && !entry.archived)));
  const others = [...lanesOf(mission, repo)].sort((a, b) => a[0] - b[0]).map(([, lane]) => lane).filter(shown);
  return [...(first === undefined ? [] : [first]), ...others].map((placement) => ({
    lane: laneOf(placement),
    branch: placement.branch,
    workspaceId: placement.workspaceId,
    state: placement.state,
    requests: roster
      .filter((entry) => entry.state === "active" && placement.workspaceId !== null && entry.workspaceId === placement.workspaceId)
      .map((entry) => {
        const workers = entry.workerIds.filter((id) => live.has(id));
        const newest = entry.workerIds.at(-1);
        return { requestId: entry.requestId, topic: oneLine(entry.topic), workerIds: workers.length > 0 ? workers : newest === undefined ? [] : [newest], since: entry.createdAt };
      }),
    freeSince: typeof placement.freeSince === "string" ? placement.freeSince : null,
    mergedAt: typeof placement.mergedAt === "string" ? placement.mergedAt : null,
    mergePending: placement.mergePending === undefined ? null : { since: placement.mergePending.since, reason: placement.mergePending.reason, files: placement.mergePending.files },
  }));
}

/** The overlaps of `repo` the Main was told of, between lanes still in use (see the module comment). Pure. */
export function overlapsOf(mission: Pick<Mission, "placements">, repo: string, roster: readonly RosterEntry[]): MissionOverlap[] {
  const inUse = lanesInUseOf(mission).get(repo) ?? [];
  const workSince = (lane: Placement): string | null =>
    roster
      .filter((entry) => entry.state === "active" && entry.workspaceId === lane.workspaceId)
      .map((entry) => entry.createdAt)
      .sort()[0] ?? null;
  const overlaps: MissionOverlap[] = [];
  for (const higher of inUse.filter((lane) => laneOf(lane) >= 2)) {
    for (const [number, files] of Object.entries(higher.overlapTold ?? {})) {
      const lower = inUse.find((lane) => String(laneOf(lane)) === number);
      if (lower === undefined || files.length === 0) continue;
      const toldAt = higher.overlapToldAt?.[number] ?? null;
      // Told about earlier work of a lane that was freed and reused since: not about what runs there now.
      const stale = [lower, higher].some((lane) => {
        const since = laneOf(lane) >= 2 ? workSince(lane) : null;
        return toldAt !== null && since !== null && Date.parse(toldAt) < Date.parse(since);
      });
      if (!stale) overlaps.push({ lanes: [laneOf(lower), laneOf(higher)], files: [...files], toldAt });
    }
  }
  return overlaps.sort((a, b) => a.lanes[0] - b.lanes[0] || a.lanes[1] - b.lanes[1]);
}

/** The words of a tell: its text without the `Continue <request>.` line paseo-bm puts first. */
function tellTextOf(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body = /^Continue \S+\.$/.test(lines[0]?.trim() ?? "") ? lines.slice(1) : lines;
  return firstLine(body.join("\n"), process.env) ?? "";
}

/** In flight's Waiting part (see the module comment). `repoName` names a repo key. Never throws. */
export function waitingOf(home: string, mission: Pick<Mission, "missionId" | "charter">, roster: readonly RosterEntry[], repoName: (workspaceId: string) => string, now: Date): MissionWaiting[] {
  const heldEntries = heldRequestsOf(home, mission.missionId);
  // An `after` names a request or a held entry that has no request id yet.
  const topicOf = new Map([...roster.map((entry) => [entry.requestId, oneLine(entry.topic)] as const), ...heldEntries.map((entry) => [entry.holdId, oneLine(entry.topic)] as const)]);
  const lines: MissionWaiting[] = [];
  const keys = charterKeysOf(home, mission);
  for (const entry of heldEntries) {
    if (entry.state !== "held" && entry.state !== "waiting-stopped") continue;
    const project = entry.input["project"];
    const repo = typeof project === "string" && project !== "" ? repoName(repoKeyOf(home, project)) : keys.length === 1 ? repoName(keys[0]!) : null;
    lines.push({
      kind: "held",
      id: entry.holdId,
      topic: oneLine(entry.topic),
      after: entry.after.map((requestId) => ({ requestId, topic: topicOf.get(requestId) ?? null })),
      state: entry.state,
      since: entry.at,
      repo,
      newLane: entry.input["lane"] === "new",
      ...(entry.step === undefined ? {} : { step: { n: entry.step.n, of: entry.step.of, title: oneLine(entry.step.title) } }),
      ...(entry.state === "waiting-stopped" && entry.note !== undefined ? { why: oneLine(entry.note) } : {}),
    });
  }
  const active = roster.filter((entry) => entry.state === "active");
  const ids = new Set(active.map((entry) => entry.requestId));
  try {
    const outbox = createOutbox(home);
    for (const workspaceId of new Set(active.map((entry) => entry.workspaceId))) {
      for (const record of outbox.list(workspaceId)) {
        if (record.kind !== "message" || !ids.has(record.requestId)) continue;
        const owner = record.atOnce === true;
        const base = { kind: "tell" as const, id: record.id, requestId: record.requestId, workerId: record.to, owner, text: tellTextOf(record.text) };
        if (record.steeredAt !== undefined) {
          if (now.getTime() - (Date.parse(record.steeredAt) || 0) > STEERED_SHOWN_MS) continue;
          lines.push({ ...base, state: record.replaced === true ? "replaced" : "steered", since: record.steeredAt });
        } else if (isOpenRecord(record)) {
          lines.push({ ...base, state: record.state === "held" ? "held" : "queued", since: record.createdAt });
        }
      }
    }
  } catch {
    // An outbox that cannot be read shows no tells; the held requests stay.
  }
  return lines.sort((a, b) => (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0)).slice(-MISSION_WAITING_SHOWN);
}

type InFlightRequest = NonNullable<MissionGetOutput["inFlight"]>["requests"][number];

/** What a started step's request waits for, when it is not simply at work; null when it is. Pure. */
function blockedWhyOf(request: InFlightRequest | undefined): string | null {
  switch (request?.state) {
    case "waiting-owner":
      return "waiting for you";
    case "waiting-main":
      return "waiting for the Main";
    case "waiting-other":
      return `waiting for ${request.waitingOn ?? "other work"}`;
    case "undelivered":
      return "a delivery failed";
    default:
      return null;
  }
}

/** The step the mission's newest approved line is at (see the module comment); null with no line. `requests` are In flight's. Never throws. */
export function lineOf(home: string, missionId: string, requests: readonly InFlightRequest[]): MissionLine | null {
  try {
    const approved = heldRequestsOf(home, missionId).filter((entry) => entry.step !== undefined && entry.state !== "proposed");
    const lineId = approved.filter((entry) => entry.state !== "cancelled").at(-1)?.step!.lineId;
    if (lineId === undefined) return null;
    const lineAt = (entry: HeldRequest, state: MissionLine["state"], requestId: string | null, why: string | null): MissionLine => ({ n: entry.step!.n, of: entry.step!.of, title: oneLine(entry.step!.title), state, requestId, why });
    const steps = approved.filter((entry) => entry.state !== "cancelled" && entry.step!.lineId === lineId).sort((a, b) => a.step!.n - b.step!.n);
    // Steps run in order, so the newest started one is where the line is; one before it was passed or released past.
    const started = steps.filter((entry) => entry.state === "started").at(-1);
    let head: string | null = null;
    if (started !== undefined) {
      head = started.startedAs === undefined ? null : (chainHeadOf(home, started.startedAs)?.request.requestId ?? started.startedAs);
      if (started.stopNote !== undefined) return lineAt(started, "stopped", head, oneLine(started.stopNote));
      const state = afterStateOf(home, missionId, started.holdId);
      if (state.kind === "waiting") {
        const why = blockedWhyOf(requests.find((request) => request.requestId === head));
        return lineAt(started, why === null ? "running" : "blocked", head, why);
      }
      if (state.kind !== "passed") return lineAt(started, "stopped", head, oneLine(stopNoteOf(state)));
    }
    const next = steps.find((entry) => entry.state !== "started" && entry.step!.n > (started?.step!.n ?? 0));
    if (next === undefined) return started === undefined ? null : lineAt(started, "done", head, null);
    return next.state === "waiting-stopped" ? lineAt(next, "stopped", null, oneLine(next.note ?? "stopped")) : lineAt(next, "blocked", null, "starts when the request running now ends");
  } catch {
    return null;
  }
}
