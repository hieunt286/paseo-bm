import { afterEach, describe, expect, it } from "vitest";
import { missionGetRpc } from "../plugin/shared/contracts";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createAlertStore } from "../plugin/server/alert-store";
import { applyLine, heldRequestsOf, holdRequest, proposeLine, startHeldRequests } from "../plugin/server/held-requests";
import { MISSION_WAITING_SHOWN, STEERED_SHOWN_MS, lineOf, overlapsOf } from "../plugin/server/mission-page-lanes";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { handleMissionGet } from "../plugin/server/missions-rpc";
import { createOutbox } from "../plugin/server/outbox";
import { MAX_LANES } from "../plugin/server/placement-create";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * `mission.get`'s lanes and Waiting part (delivery line design §19.8,
 * mockup `mission-lanes.html` artboards Q and R): each placed repo's live
 * lanes with their requests, "n of 7", the overlaps the Main was told of,
 * and the held requests and tells to busy Workers. Temporary data folders
 * only; no git and no Paseo.
 */

const NOW = new Date("2026-10-25T04:40:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const REPO = "wks_repo";
const REQ_A = "req-20261025T021049Z";
const REQ_B = "req-20261025T040712Z";
const REQ_C = "req-20261025T030000Z";

afterEach(() => {
  clearJsonFileCache();
  clearRequestIndexCache();
  clearRequestRegistryCache();
  removeDataFolders();
});

function lane(number: number, over: Partial<Placement> = {}): Placement {
  return {
    repo: REPO,
    workspaceId: `wks_lane${number}`,
    directory: `/tmp/worktrees/m-abc-repo-${number}`,
    branch: number === 1 ? "m/ABC/repo" : `m/ABC/repo-${number}`,
    target: "dev",
    base: number === 1 ? "origin/dev" : "m/ABC/repo",
    worktreeSlug: `m-abc-repo-${number}`,
    state: "ready",
    requestKey: `key-${number}`,
    createdAt: at(200),
    deps: { cloned: [], at: null, note: null },
    integration: null,
    ...(number === 1 ? {} : { lane: number }),
    ...over,
  };
}

/** A mission with lane 1 and lane 2 at work, lane 3 free, a retired lane 4; requests A (lane 1, two Workers), B (lane 2) and C (lane 3, finished). */
function world(placements?: Placement[]) {
  const home = dataFolder();
  const store = createMissionStore(home, { now: () => NOW });
  const made = store.create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  const missionId = made.mission.missionId;
  store.update(missionId, (mission) => ({
    ...mission,
    placements: placements ?? [
      lane(1),
      lane(2, { overlapTold: { "1": ["src/OpsMenu.tsx"] }, overlapToldAt: { "1": at(2) } }),
      lane(3, { freeSince: at(42), mergedAt: at(42) }),
      lane(4, { state: "retired" }),
    ],
  }));
  const roster = (minutesAgo: number) => createMissionRoster(home, { now: () => new Date(NOW.getTime() - minutesAgo * 60_000) });
  roster(132).add(missionId, { requestId: REQ_A, workspaceId: "wks_lane1", topic: "Audit both repos", workerId: "w-aaaaaaa1" });
  roster(132).add(missionId, { requestId: REQ_A, workspaceId: "wks_lane1", topic: "Audit both repos", workerId: "w-aaaaaaa2" });
  roster(6).add(missionId, { requestId: REQ_B, workspaceId: "wks_lane2", topic: "Keep only the bypass-authz flag", workerId: "w-bbbbbbb1" });
  roster(60).add(missionId, { requestId: REQ_C, workspaceId: "wks_lane3", topic: "Done work", workerId: "w-ccccccc1" });
  createMissionRoster(home).setState(missionId, REQ_C, "finished");
  return { home, missionId };
}

const read = async (home: string, missionId: string) => missionGetRpc.output.parse(await handleMissionGet({ missionId }, undefined, { home, now: () => NOW, log: () => {} }));

describe("mission.get's lanes (§19.8)", () => {
  it("carries each live lane, lane 1 first, with its active requests, their Workers and since when; a free lane's merge; n of 7; the overlap told", async () => {
    const { home, missionId } = world();
    const page = await read(home, missionId);
    const placement = page.summary.repos[0]!.placement!;
    expect(placement.maxLanes).toBe(MAX_LANES);
    expect(placement.lanes).toEqual([
      { lane: 1, branch: "m/ABC/repo", workspaceId: "wks_lane1", state: "ready", requests: [{ requestId: REQ_A, topic: "Audit both repos", workerIds: ["w-aaaaaaa2"], since: at(132) }], freeSince: null, mergedAt: null, mergePending: null },
      { lane: 2, branch: "m/ABC/repo-2", workspaceId: "wks_lane2", state: "ready", requests: [{ requestId: REQ_B, topic: "Keep only the bypass-authz flag", workerIds: ["w-bbbbbbb1"], since: at(6) }], freeSince: null, mergedAt: null, mergePending: null },
      { lane: 3, branch: "m/ABC/repo-3", workspaceId: "wks_lane3", state: "ready", requests: [], freeSince: at(42), mergedAt: at(42), mergePending: null },
    ]);
    expect(placement.overlaps).toEqual([{ lanes: [1, 2], files: ["src/OpsMenu.tsx"], toldAt: at(2) }]);
  });

  it("leaves out an overlap told before the higher lane took its current work, or with a lane no longer in use", () => {
    const roster = [
      { requestId: REQ_B, workspaceId: "wks_lane2", createdAt: at(6), workerIds: ["w"], topic: "t", state: "active" as const },
    ];
    const mission = (two: Partial<Placement>) => ({ placements: [lane(1), lane(2, { overlapTold: { "1": ["a.ts"] }, ...two })] });
    expect(overlapsOf(mission({ overlapToldAt: { "1": at(30) } }), REPO, roster)).toEqual([]);
    expect(overlapsOf(mission({ overlapToldAt: { "1": at(1) } }), REPO, roster)).toEqual([{ lanes: [1, 2], files: ["a.ts"], toldAt: at(1) }]);
    // An older build stored no time: shown, without one.
    expect(overlapsOf(mission({}), REPO, roster)).toEqual([{ lanes: [1, 2], files: ["a.ts"], toldAt: null }]);
    // Lane 2 free again: no overlap.
    expect(overlapsOf(mission({ freeSince: at(1) }), REPO, roster)).toEqual([]);
  });
});

describe("mission.get's Waiting part (§19.8)", () => {
  it("lists held requests with what they wait for and where they start, and tells still waiting or steered lately, oldest first", async () => {
    const { home, missionId } = world();
    const held = holdRequest(home, missionId, { after: [REQ_B], input: { request: "Wire the ops screens", project: REPO, lane: "new" }, topic: "Wire the ops screens to the new endpoints", by: "main-1" }, new Date(at(31)));
    if (!held.ok) throw new Error(held.reason);
    const outbox = (minutesAgo: number) => createOutbox(home, { now: () => new Date(NOW.getTime() - minutesAgo * 60_000) });
    const queued = outbox(3).add("wks_lane1", { kind: "message", requestId: REQ_A, from: "main-1", to: "w-aaaaaaa2", text: `Continue ${REQ_A}.\nalso list the four routes in the menu\nsource: chat` });
    const steered = outbox(7).add("wks_lane1", { kind: "message", requestId: REQ_A, from: "main-1", to: "w-aaaaaaa2", text: `Continue ${REQ_A}.\ncheck why the UI shows nothing new`, atOnce: true });
    outbox(7).settle("wks_lane1", steered.id, "delivered");
    outbox(7).markSteered("wks_lane1", steered.id, at(7), false);
    // Not shown: delivered at a turn's end, steered too long ago, a report, and a tell to a finished request.
    const delivered = outbox(5).add("wks_lane1", { kind: "message", requestId: REQ_A, from: "main-1", to: "w-aaaaaaa2", text: `Continue ${REQ_A}.\nold` });
    outbox(5).settle("wks_lane1", delivered.id, "delivered");
    const old = outbox(90).add("wks_lane1", { kind: "message", requestId: REQ_A, from: "main-1", to: "w-aaaaaaa2", text: `Continue ${REQ_A}.\nolder`, atOnce: true });
    outbox(90).markSteered("wks_lane1", old.id, at(STEERED_SHOWN_MS / 60_000 + 5), false);
    outbox(1).add("wks_lane1", { kind: "report", requestId: REQ_A, from: "w-aaaaaaa2", to: "main-1", text: "BM-REPORT" });
    outbox(1).add("wks_lane3", { kind: "message", requestId: REQ_C, from: "main-1", to: "w-ccccccc1", text: `Continue ${REQ_C}.\nlate` });

    const page = await read(home, missionId);
    expect(page.waiting).toEqual([
      { kind: "held", id: held.entry.holdId, topic: "Wire the ops screens to the new endpoints", after: [{ requestId: REQ_B, topic: "Keep only the bypass-authz flag" }], state: "held", since: at(31), repo: expect.any(String), newLane: true },
      { kind: "tell", id: steered.id, requestId: REQ_A, workerId: "w-aaaaaaa2", owner: true, text: "check why the UI shows nothing new", state: "steered", since: at(7) },
      { kind: "tell", id: queued.id, requestId: REQ_A, workerId: "w-aaaaaaa2", owner: false, text: "also list the four routes in the menu", state: "queued", since: at(3) },
    ]);
  });

  it("shows the topic of a held entry another one waits for", async () => {
    const { home, missionId } = world();
    const first = holdRequest(home, missionId, { after: [REQ_B], input: { request: "Step two" }, topic: "Step two of the line", by: "main-1" }, new Date(at(31)));
    if (!first.ok) throw new Error(first.reason);
    const second = holdRequest(home, missionId, { after: [first.entry.holdId, REQ_B], input: { request: "Step three" }, topic: "Step three of the line", by: "main-1" }, new Date(at(30)));
    if (!second.ok) throw new Error(second.reason);
    const line = (await read(home, missionId)).waiting!.find((entry) => entry.id === second.entry.holdId)!;
    expect(line).toMatchObject({ kind: "held", after: [{ requestId: first.entry.holdId, topic: "Step two of the line" }, { requestId: REQ_B, topic: "Keep only the bypass-authz flag" }] });
  });

  it("keeps the newest few, and says replaced when Paseo replaced the turn", async () => {
    const { home, missionId } = world();
    for (let n = 0; n < MISSION_WAITING_SHOWN + 3; n += 1) {
      createOutbox(home, { now: () => new Date(NOW.getTime() - (30 - n) * 60_000) }).add("wks_lane2", { kind: "message", requestId: REQ_B, from: "main-1", to: "w-bbbbbbb1", text: `Continue ${REQ_B}.\ntell ${n}` });
    }
    const replaced = createOutbox(home).add("wks_lane2", { kind: "message", requestId: REQ_B, from: "main-1", to: "w-bbbbbbb1", text: `Continue ${REQ_B}.\nnow`, atOnce: true });
    createOutbox(home).markSteered("wks_lane2", replaced.id, NOW.toISOString(), true);
    const waiting = (await read(home, missionId)).waiting!;
    expect(waiting).toHaveLength(MISSION_WAITING_SHOWN);
    expect(waiting.map((line) => (line.kind === "tell" ? line.text : line.topic))).toEqual([...Array.from({ length: MISSION_WAITING_SHOWN - 1 }, (_, index) => `tell ${index + 4}`), "now"]);
    expect(waiting.at(-1)).toMatchObject({ kind: "tell", state: "replaced", owner: true });
  });
});

describe("mission.get's line (ADR-045 decision 5)", () => {
  const QUIET = { enqueue: async () => "sent" as const, enqueueBatch: async (_target: string, _batch: unknown, items: unknown[]) => items.map(() => "sent" as const) } as never;

  /** A mission with an approved line of `titles`; `start` is one pass of the plugin, whose Worker creation lands on the roster. */
  function lineWorld(titles: string[], approve = true) {
    const home = dataFolder();
    const made = createMissionStore(home, { now: () => NOW }).create({ code: "LIN", name: "Line", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    const missionId = made.mission.missionId;
    const registry = createRequestRegistry(home, { log: () => {} });
    const roster = createMissionRoster(home, { now: () => NOW });
    const proposed = proposeLine(home, missionId, { lineId: "line-1", by: "main-1", steps: titles.map((title) => ({ title, request: title, acceptance: ["Done"] })) }, NOW);
    if (!proposed.ok) throw new Error(proposed.reason);
    if (approve) applyLine(home, missionId, "line-1");
    const started: string[] = [];
    const create = async () => {
      const { requestId } = registry.generate(REPO, { managerId: "main-1", missionId });
      roster.add(missionId, { requestId, workspaceId: REPO, topic: "The work", workerId: `w-${requestId}` });
      started.push(requestId);
      return { ok: true, text: JSON.stringify({ requestId, workerId: `w-${requestId}` }) };
    };
    const pass = (paseo?: unknown) => startHeldRequests(home, { create, queue: QUIET, log: () => {}, ...(paseo === undefined ? {} : { paseo: paseo as never }) });
    const finish = (requestId: string, gate: { passed: boolean; reasons?: string[] }) => {
      registry.noteFinishGate(REPO, requestId, { passed: gate.passed, reasons: gate.reasons ?? [], at: at(1), commit: null });
      roster.setState(missionId, requestId, "finished");
    };
    return { home, missionId, entries: proposed.entries, started, pass, finish, registry, roster };
  }

  const lineOfPage = async (home: string, missionId: string) => (await read(home, missionId)).line;

  it("is null with no line, and while a line is only proposed", async () => {
    const { home, missionId } = world();
    expect(await lineOfPage(home, missionId)).toBeNull();
    const proposed = lineWorld(["One", "Two"], false);
    expect(await lineOfPage(proposed.home, proposed.missionId)).toBeNull();
  });

  it("reads the step that runs, on the newest request of its chain, and blocked while its request waits for someone", async () => {
    const { home, missionId, pass, finish, started, registry, roster } = lineWorld(["One", "Two", "Three", "Four"]);
    await pass();
    expect(await lineOfPage(home, missionId)).toEqual({ n: 1, of: 4, title: "One", state: "running", requestId: started[0], why: null });
    finish(started[0]!, { passed: true });
    // Passed and not yet started: the next step waits for its turn.
    expect(await lineOfPage(home, missionId)).toMatchObject({ n: 2, state: "blocked", requestId: null, why: "starts when the request running now ends" });
    await pass();
    expect(await lineOfPage(home, missionId)).toEqual({ n: 2, of: 4, title: "Two", state: "running", requestId: started[1], why: null });

    const { requestId: next } = registry.generate(REPO, { managerId: "main-1", missionId, continuationOf: started[1]! });
    roster.add(missionId, { requestId: next, workspaceId: REPO, topic: "The rest", workerId: "w-next", continuationOf: started[1]! });
    registry.noteContinuedBy(REPO, started[1]!, next, { reason: "size", figure: "180k", at: at(1) });
    roster.setState(missionId, started[1]!, "finished");
    expect(await lineOfPage(home, missionId)).toMatchObject({ n: 2, state: "running", requestId: next });

    const waitingFor = (state: string, waitingOn: string | null = null) => lineOf(home, missionId, [{ requestId: next, state, waitingOn } as never]);
    expect(waitingFor("waiting-owner")).toMatchObject({ state: "blocked", why: "waiting for you" });
    expect(waitingFor("waiting-main")).toMatchObject({ state: "blocked", why: "waiting for the Main" });
    expect(waitingFor("waiting-other", "the login API")).toMatchObject({ state: "blocked", why: "waiting for the login API" });
    expect(waitingFor("undelivered")).toMatchObject({ state: "blocked", why: "a delivery failed" });
  });

  it("reads a stalled step as stopped with its reason, and a stop stays on the started step, off the Waiting list", async () => {
    const { home, missionId, entries, pass, started } = lineWorld(["One", "Two"]);
    await pass();
    createAlertStore(home, { now: () => new Date(at(30)) }).raise({ workspaceId: REPO, kind: "request-stalled", subject: started[0]! });
    const reason = `${started[0]} has stalled since ${at(30)}`;
    // Before any pass the alert is enough; a pass then stores it as the step's stopNote.
    expect(await lineOfPage(home, missionId)).toEqual({ n: 1, of: 2, title: "One", state: "stopped", requestId: started[0], why: reason });
    await pass();
    const step = heldRequestsOf(home, missionId).find((entry) => entry.holdId === entries[0]!.holdId)!;
    expect(step).toMatchObject({ state: "started", stopNote: reason });
    expect(await lineOfPage(home, missionId)).toEqual({ n: 1, of: 2, title: "One", state: "stopped", requestId: started[0], why: reason });
    expect((await read(home, missionId)).waiting!.map((line) => line.id)).toEqual([entries[1]!.holdId]);
  });

  it("reads a step with no live Worker as stopped with its reason, from its stopNote", async () => {
    const { home, missionId, entries, pass, started } = lineWorld(["One", "Two"]);
    await pass();
    await pass({ agents: { list: async () => ({ entries: [{ id: "main-1", provider: "bm-manager", status: "running", labels: { "bm.role": "manager" } }], pageInfo: { hasMore: false } }) } });
    expect(heldRequestsOf(home, missionId).find((entry) => entry.holdId === entries[0]!.holdId)).toMatchObject({ state: "started", stopNote: `${started[0]} has no live Worker` });
    expect(await lineOfPage(home, missionId)).toEqual({ n: 1, of: 2, title: "One", state: "stopped", requestId: started[0], why: `${started[0]} has no live Worker` });
  });

  it("reads a failed gate at the step that failed it, and gives the step waiting on it its place and the reason", async () => {
    const { home, missionId, entries, pass, finish, started } = lineWorld(["One", "Two"]);
    await pass();
    finish(started[0]!, { passed: false, reasons: ["review batch b1 has not passed"] });
    await pass();
    const reason = `${started[0]} did not pass its finish gate: review batch b1 has not passed`;
    expect(await lineOfPage(home, missionId)).toEqual({ n: 1, of: 2, title: "One", state: "stopped", requestId: started[0], why: reason });
    expect((await read(home, missionId)).waiting!.find((line) => line.id === entries[1]!.holdId)).toMatchObject({ kind: "held", state: "waiting-stopped", step: { n: 2, of: 2, title: "Two" }, why: reason });
  });

  it("is done when every step passed, and never done on a last step whose gate failed", async () => {
    const passing = lineWorld(["One", "Two"]);
    await passing.pass();
    passing.finish(passing.started[0]!, { passed: true });
    await passing.pass();
    passing.finish(passing.started[1]!, { passed: true });
    expect(await lineOfPage(passing.home, passing.missionId)).toEqual({ n: 2, of: 2, title: "Two", state: "done", requestId: passing.started[1], why: null });

    const failing = lineWorld(["Only"]);
    await failing.pass();
    failing.finish(failing.started[0]!, { passed: false, reasons: ["the changed files are not committed"] });
    expect(await lineOfPage(failing.home, failing.missionId)).toMatchObject({ state: "stopped", why: `${failing.started[0]} did not pass its finish gate: the changed files are not committed` });
  });
});
