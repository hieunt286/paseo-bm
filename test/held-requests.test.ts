import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { createAlertStore } from "../plugin/server/alert-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { MAX_HELD, applyLine, cancelHeld, dropLine, heldRequestsOf, holdRequest, holdStateOf, liveLineOf, proposeLine, releaseHeld, startHeldRequests } from "../plugin/server/held-requests";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { shell, turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The held queue's reading of `after` (mission line plan §5.8, ADR-045
 * decision 1): a hold id through its `startedAs`, a request at the head of its
 * chain, that head's stored finish gate, and what the pass starts. Temporary
 * data folders only; no Paseo.
 */

const REPO = "wks_back";
const NOW = new Date("2026-11-10T08:00:00.000Z");
const GATE_AT = "2026-11-10T07:59:00.000Z";

afterEach(() => {
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearJsonFileCache();
  removeDataFolders();
});

function world() {
  const home = dataFolder();
  const made = createMissionStore(home).create({ code: "SHOP", name: "Shop", goal: "Orders.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  const missionId = made.mission.missionId;
  const registry = createRequestRegistry(home, { log: () => {} });
  const roster = createMissionRoster(home);
  /** A request of the mission: registered as this build does, and on the roster. */
  const request = (continuationOf?: string) => {
    const { requestId } = registry.generate(REPO, { managerId: "main-1", missionId, ...(continuationOf === undefined ? {} : { continuationOf }) });
    roster.add(missionId, { requestId, workspaceId: REPO, topic: `work of ${requestId}`, workerId: `w-${requestId}`, ...(continuationOf === undefined ? {} : { continuationOf }) });
    if (continuationOf !== undefined) registry.noteContinuedBy(REPO, continuationOf, requestId, { reason: "size", figure: "180k", at: GATE_AT });
    return requestId;
  };
  const finish = (requestId: string, gate: { passed: boolean; reasons?: string[] } | null) => {
    if (gate !== null) registry.noteFinishGate(REPO, requestId, { passed: gate.passed, reasons: gate.reasons ?? [], at: GATE_AT, commit: null });
    roster.setState(missionId, requestId, "finished");
  };
  /** A request from before this build: on the registry with no `gated` stamp. */
  const older = (requestId: string) => {
    registry.register(REPO, requestId, { source: "backfill", managerId: "main-1" });
    roster.add(missionId, { requestId, workspaceId: REPO, topic: "older work", workerId: "w-older" });
    return requestId;
  };
  const hold = (after: string[], topic = "Wire the screens") => {
    const held = holdRequest(home, missionId, { after, input: { request: topic, context: [] }, topic, by: "main-1" }, NOW);
    if (!held.ok) throw new Error(held.reason);
    return held.entry.holdId;
  };
  return { home, missionId, roster, registry, request, finish, older, hold };
}

describe("holdStateOf reads each id of after (§5.8)", () => {
  it("a finished head passes only with a passing gate; a failed one names its reasons and the gate's time", () => {
    const { home, missionId, request, finish } = world();
    const passing = request();
    const failing = request();
    finish(passing, { passed: true });
    finish(failing, { passed: false, reasons: ["its checks are self-reported, neither detected nor reused"] });
    expect(holdStateOf(home, missionId, { after: [passing] })).toEqual({ kind: "passed" });
    expect(holdStateOf(home, missionId, { after: [failing] })).toEqual({ kind: "gate-failed", requestId: failing, reasons: ["its checks are self-reported, neither detected nor reused"], at: GATE_AT });
  });

  it("an active head is waiting; a stopped head is stopped", () => {
    const { home, missionId, roster, request } = world();
    const running = request();
    expect(holdStateOf(home, missionId, { after: [running] })).toEqual({ kind: "waiting" });
    roster.setState(missionId, running, "stopped");
    expect(holdStateOf(home, missionId, { after: [running] })).toEqual({ kind: "stopped", requestId: running });
  });

  it("a request is read at the head of its chain: a rolled-over request waits for its continuation, and passes only when the head does", () => {
    const { home, missionId, request, finish } = world();
    const first = request();
    // Finished with a size continuation: its own gate failed for the work it left, and the continuation runs.
    finish(first, { passed: false, reasons: ["it left work for a continuation"] });
    const second = request(first);
    expect(holdStateOf(home, missionId, { after: [first] })).toEqual({ kind: "waiting" });
    finish(second, { passed: false, reasons: ["review batch b1 has not passed"] });
    expect(holdStateOf(home, missionId, { after: [first] })).toEqual({ kind: "gate-failed", requestId: second, reasons: ["review batch b1 has not passed"], at: GATE_AT });
    const third = request(second);
    expect(holdStateOf(home, missionId, { after: [first] })).toEqual({ kind: "waiting" });
    finish(third, { passed: true });
    expect(holdStateOf(home, missionId, { after: [first] })).toEqual({ kind: "passed" });
  });

  it("a gated head with no stored result fails with a named reason; a head from before this build passes", () => {
    const { home, missionId, request, finish, older, roster } = world();
    const gated = request();
    finish(gated, null);
    expect(holdStateOf(home, missionId, { after: [gated] })).toEqual({ kind: "gate-failed", requestId: gated, reasons: [`request ${gated} has no stored finish gate result`], at: null });
    const before = older("req-20261001T010000Z");
    roster.setState(missionId, before, "finished");
    expect(holdStateOf(home, missionId, { after: [before] })).toEqual({ kind: "passed" });
  });

  it("a finished roster entry no registry holds fails closed", () => {
    const { home, missionId, roster } = world();
    roster.add(missionId, { requestId: "req-20261002T010000Z", workspaceId: REPO, topic: "unregistered", workerId: "w" });
    roster.setState(missionId, "req-20261002T010000Z", "finished");
    expect(holdStateOf(home, missionId, { after: ["req-20261002T010000Z"] })).toEqual({ kind: "gate-failed", requestId: "req-20261002T010000Z", reasons: ["request req-20261002T010000Z could not be read"], at: null });
  });

  it("a hold id not started waits; a cancelled or unknown one stops", () => {
    const { home, missionId, request, hold } = world();
    const running = request();
    const earlier = hold([running], "Earlier step");
    expect(holdStateOf(home, missionId, { after: [earlier] })).toEqual({ kind: "waiting" });

    const cancelled = hold([running], "Dropped step");
    expect(cancelHeld(home, missionId, cancelled, "not needed", NOW)).toBeNull();
    expect(holdStateOf(home, missionId, { after: [cancelled] })).toEqual({ kind: "stopped", requestId: cancelled });
    expect(holdStateOf(home, missionId, { after: ["hold-20261110T010101Z"] })).toEqual({ kind: "stopped", requestId: "hold-20261110T010101Z" });
  });

  it("a stop outranks a failed gate, a failed gate outranks waiting, and passed needs every id", () => {
    const { home, missionId, roster, request, finish } = world();
    const passed = request();
    finish(passed, { passed: true });
    const running = request();
    const failed = request();
    finish(failed, { passed: false, reasons: ["no"] });
    const stopped = request();
    roster.setState(missionId, stopped, "stopped");
    expect(holdStateOf(home, missionId, { after: [passed, running] }).kind).toBe("waiting");
    expect(holdStateOf(home, missionId, { after: [running, failed] }).kind).toBe("gate-failed");
    expect(holdStateOf(home, missionId, { after: [failed, stopped] }).kind).toBe("stopped");
  });
});

describe("the pass reads after the same way (§5.8)", () => {
  const passOf = (home: string, created: Array<Record<string, unknown>>) =>
    startHeldRequests(home, {
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        return { ok: true, text: JSON.stringify({ requestId: `req-20261110T1${created.length}0000Z`, workerId: `w-${created.length}` }) };
      },
      queue: { enqueue: vi.fn(async () => "sent" as const), enqueueBatch: vi.fn(async (_target: string, _batch: unknown, items: unknown[]) => items.map(() => "sent" as const)) } as never,
      log: () => {},
    });

  it("a failed gate does not start the entry, and a continuation that passes does", async () => {
    const { home, missionId, request, finish, hold } = world();
    const first = request();
    const holdId = hold([first]);
    const created: Array<Record<string, unknown>> = [];
    finish(first, { passed: false, reasons: ["review batch b1 has not passed"] });
    await passOf(home, created);
    expect(created).toEqual([]);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId, state: "waiting-stopped" });

    const second = request(first);
    await passOf(home, created);
    expect(created).toEqual([]);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId, state: "held" });
    finish(second, { passed: true });
    await passOf(home, created);
    expect(created).toHaveLength(1);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId, state: "started" });
  });

  it("an entry after a hold starts only once that hold started and its request finished and passed", async () => {
    const { home, missionId, roster, registry, request, finish, hold } = world();
    const first = request();
    const earlier = hold([first], "Step two");
    const later = hold([earlier], "Step three");
    finish(first, { passed: true });
    const created: Array<Record<string, unknown>> = [];
    await passOf(home, created);
    // The pass reads the earlier entry first: it starts; the later one follows a request still running.
    expect(created.map((input) => input["request"])).toEqual(["Step two"]);
    const startedAs = heldRequestsOf(home, missionId).find((entry) => entry.holdId === earlier)!.startedAs!;
    registry.register(REPO, startedAs, { source: "tool", managerId: "main-1" });
    roster.add(missionId, { requestId: startedAs, workspaceId: REPO, topic: "Step two", workerId: "w-1" });
    await passOf(home, created);
    expect(created).toHaveLength(1);
    expect(heldRequestsOf(home, missionId).find((entry) => entry.holdId === later)!.state).toBe("held");
    registry.noteFinishGate(REPO, startedAs, { passed: true, reasons: [], at: GATE_AT, commit: null });
    roster.setState(missionId, startedAs, "finished");
    await passOf(home, created);
    expect(created.map((input) => input["request"])).toEqual(["Step two", "Step three"]);
  });
});

describe("the owner's switch off (line.supervised, ADR-045)", () => {
  const off = (home: string) => createCoordinationStore(home).set({ key: "line.supervised", value: false });
  const queue = () => ({ enqueue: vi.fn(async () => "sent" as const), enqueueBatch: vi.fn(async (_target: string, _batch: unknown, items: unknown[]) => items.map(() => "sent" as const)) }) as never;
  const create = (created: Array<Record<string, unknown>>) => async (input: Record<string, unknown>) => {
    created.push(input);
    return { ok: true, text: JSON.stringify({ requestId: `req-20261110T1${created.length}0000Z`, workerId: `w-${created.length}` }) };
  };

  it("a head satisfies after at finished alone: a failed gate, and a gated head with no result, pass; no gate is read", () => {
    const { home, missionId, request, finish } = world();
    const failing = request();
    const unstored = request();
    finish(failing, { passed: false, reasons: ["review batch b1 has not passed"] });
    finish(unstored, null);
    expect(holdStateOf(home, missionId, { after: [failing] }).kind).toBe("gate-failed");
    off(home);
    expect(holdStateOf(home, missionId, { after: [failing, unstored] })).toEqual({ kind: "passed" });
  });

  it("an active head waits with no stall or no-Worker stop; a stopped head and a cancelled entry still stop", () => {
    const { home, missionId, roster, request, hold } = world();
    const stalled = request();
    createAlertStore(home, { now: () => new Date(GATE_AT) }).raise({ workspaceId: REPO, kind: "request-stalled", subject: stalled });
    const facts = { workers: { ids: new Set<string>(), at: Date.now() + 1_000 } };
    expect(holdStateOf(home, missionId, { after: [stalled] }, facts).kind).toBe("stalled");
    off(home);
    expect(holdStateOf(home, missionId, { after: [stalled] }, facts)).toEqual({ kind: "waiting" });
    roster.setState(missionId, stalled, "stopped");
    expect(holdStateOf(home, missionId, { after: [stalled] }, facts).kind).toBe("stopped");
    const holdId = hold([stalled]);
    cancelHeld(home, missionId, holdId, "no longer wanted", NOW);
    expect(holdStateOf(home, missionId, { after: [holdId] }, facts).kind).toBe("stopped");
  });

  it("the pass starts an entry at finished even with a failed gate, a stopped entry too", async () => {
    const { home, missionId, request, finish, hold } = world();
    const failing = request();
    const entry = hold([failing], "After the failed one");
    finish(failing, { passed: false, reasons: ["review batch b1 has not passed"] });
    const seen = queue();
    const created: Array<Record<string, unknown>> = [];
    const pass = () => startHeldRequests(home, { create: create(created), queue: seen, log: () => {} });
    await pass();
    expect(created).toEqual([]);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId: entry, state: "waiting-stopped" });
    off(home);
    await pass();
    expect(created.map((input) => input["request"])).toEqual(["After the failed one"]);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId: entry, state: "started" });
  });

  it("a running head still holds its entry, silently, until it finishes", async () => {
    const { home, missionId, request, finish, hold } = world();
    const running = request();
    const entry = hold([running], "After the running one");
    off(home);
    const created: Array<Record<string, unknown>> = [];
    const pass = () => startHeldRequests(home, { create: create(created), queue: queue(), log: () => {} });
    await pass();
    expect(created).toEqual([]);
    expect(heldRequestsOf(home, missionId)[0]).toMatchObject({ holdId: entry, state: "held" });
    finish(running, { passed: true });
    await pass();
    expect(created).toHaveLength(1);
  });
});

describe("a step list in the held queue (ADR-045 decision 1)", () => {
  const STEPS = [
    { title: "Build the API", request: "Add the orders endpoint.", acceptance: ["GET /orders answers 200", "It is documented"], project: REPO, context: [{ fact: "Totals are in cents.", source: "owner" }] },
    { title: "Wire the screens", request: "Show the orders.", acceptance: ["The page lists them"] },
    { title: "Write the docs", request: "Describe the page.", acceptance: ["The guide names it"] },
  ];
  const propose = (home: string, missionId: string) => {
    const proposed = proposeLine(home, missionId, { lineId: "line-1", by: "main-1", steps: STEPS }, NOW);
    if (!proposed.ok) throw new Error(proposed.reason);
    return proposed.entries;
  };
  const noPass = async (home: string) => {
    const create = vi.fn(async () => ({ ok: true, text: "{}" }));
    await startHeldRequests(home, { create, queue: { enqueue: vi.fn(async () => "sent" as const), enqueueBatch: vi.fn(async () => []) } as never, log: () => {} });
    return create;
  };

  it("stores proposed entries in order, each after the previous one and the first after nothing, and no pass starts them", async () => {
    const { home, missionId } = world();
    const entries = propose(home, missionId);
    expect(entries.map((entry) => entry.state)).toEqual(["proposed", "proposed", "proposed"]);
    expect(entries.map((entry) => entry.step)).toEqual([
      { lineId: "line-1", n: 1, of: 3, title: "Build the API", acceptance: ["GET /orders answers 200", "It is documented"] },
      { lineId: "line-1", n: 2, of: 3, title: "Wire the screens", acceptance: ["The page lists them"] },
      { lineId: "line-1", n: 3, of: 3, title: "Write the docs", acceptance: ["The guide names it"] },
    ]);
    expect(entries.map((entry) => entry.after)).toEqual([[], [entries[0]!.holdId], [entries[1]!.holdId]]);
    expect(new Set(entries.map((entry) => entry.holdId)).size).toBe(3);
    expect(heldRequestsOf(home, missionId)).toEqual(entries);
    expect((await noPass(home)).mock.calls).toEqual([]);
  });

  it("keeps each entry's input as bm_create_worker's: planStep and the request followed by its criteria", () => {
    const { home, missionId } = world();
    expect(propose(home, missionId)[0]!.input).toEqual({
      request: "Add the orders endpoint.\n\nAcceptance criteria:\n- GET /orders answers 200\n- It is documented",
      context: [{ fact: "Totals are in cents.", source: "owner" }],
      planStep: "Step 1 of 3: Build the API",
      project: REPO,
    });
  });

  it("the owner's apply makes them held, and the first is due on the slot alone", async () => {
    const { home, missionId, request } = world();
    // An unrelated running request does not stop the first step by its gate: the slot orders it.
    request();
    const entries = propose(home, missionId);
    expect(applyLine(home, missionId, "line-1")).toBe(3);
    expect(heldRequestsOf(home, missionId).map((entry) => entry.state)).toEqual(["held", "held", "held"]);
    expect(holdStateOf(home, missionId, entries[0]!)).toEqual({ kind: "passed" });
    expect(holdStateOf(home, missionId, entries[1]!)).toEqual({ kind: "waiting" });
  });

  it("keep as is cancels them with the reason; what is no longer proposed is left alone", () => {
    const { home, missionId } = world();
    propose(home, missionId);
    expect(dropLine(home, missionId, "line-1", "the owner kept the mission as it is", NOW)).toBe(3);
    expect(heldRequestsOf(home, missionId).map((entry) => [entry.state, entry.note])).toEqual(Array.from({ length: 3 }, () => ["cancelled", "the owner kept the mission as it is"]));
    expect(applyLine(home, missionId, "line-1")).toBe(0);
    expect(heldRequestsOf(home, missionId).every((entry) => entry.state === "cancelled")).toBe(true);
  });

  it("MAX_HELD still bounds the entries: a list that does not fit stores nothing", () => {
    const { home, missionId, hold, request } = world();
    const running = request();
    for (let n = 0; n < MAX_HELD - 1; n += 1) hold([running], `Held ${n}`);
    const before = heldRequestsOf(home, missionId);
    const refused = proposeLine(home, missionId, { lineId: "line-1", by: "main-1", steps: STEPS }, NOW);
    expect(refused).toEqual({ ok: false, reason: `mission holds ${MAX_HELD - 1} requests and takes at most ${MAX_HELD}; cancel some with bm_hold_cancel` });
    expect(heldRequestsOf(home, missionId)).toEqual(before);
  });

  it("a line is live while a step waits or a started step's head is at work", async () => {
    const { home, missionId, request, finish } = world();
    expect(liveLineOf(home, missionId)).toBeNull();
    const proposed = proposeLine(home, missionId, { lineId: "line-1", by: "main-1", steps: [STEPS[0]!, STEPS[1]!] }, NOW);
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(liveLineOf(home, missionId)).toBe("line-1");
    applyLine(home, missionId, "line-1");
    expect(liveLineOf(home, missionId)).toBe("line-1");

    let startedAs = "";
    const create = async () => {
      startedAs = request();
      return { ok: true, text: JSON.stringify({ requestId: startedAs, workerId: "w-1" }) };
    };
    await startHeldRequests(home, { create, queue: { enqueue: vi.fn(async () => "sent" as const), enqueueBatch: vi.fn(async () => []) } as never, log: () => {} });
    expect(heldRequestsOf(home, missionId).map((entry) => entry.state)).toEqual(["started", "held"]);
    expect(cancelHeld(home, missionId, proposed.entries[1]!.holdId, "not needed", NOW)).toBeNull();
    // Only the started step is left: live while its request works, not once it has ended.
    expect(liveLineOf(home, missionId)).toBe("line-1");
    finish(startedAs, { passed: true });
    expect(liveLineOf(home, missionId)).toBeNull();
  });
});

/** Mission line plan §5.8, ADR-045 decision 2: what stops a held entry or a running step, told once per failure. */
describe("stops (§5.8)", () => {
  const SINCE = "2026-11-10T07:00:00.000Z";
  const LATER = "2026-11-10T07:40:00.000Z";

  function queueOf() {
    const told: string[] = [];
    const queue = {
      enqueue: vi.fn(async (_target: string, _kind: string, text: string) => {
        told.push(text);
        return "sent" as const;
      }),
      enqueueBatch: vi.fn(async (_target: string, _batch: unknown, items: Array<{ line: string; callbacks?: { onSent?: () => void } }>) => {
        for (const item of items) {
          told.push(item.line);
          item.callbacks?.onSent?.();
        }
        return items.map(() => "sent" as const);
      }),
    };
    return { told, queue: queue as never };
  }

  type Listed = { id: string; status?: string; archivedAt?: string; persistence?: unknown };
  /** A Paseo that lists the Main and `workers`. */
  const paseoWith = (workers: Listed[]) => ({
    agents: { list: async () => ({ entries: [{ id: "main-1", provider: "bm-manager", status: "running", labels: { "bm.role": "manager" } }, ...workers.map((worker) => ({ provider: "bm-worker", status: "running", labels: { "bm.role": "worker" }, ...worker }))] }) },
  });

  function runner(home: string, paseo?: unknown) {
    const { told, queue } = queueOf();
    const created: Array<Record<string, unknown>> = [];
    const pass = (times = 1, on: unknown = paseo) =>
      (async () => {
        for (let n = 0; n < times; n += 1) {
          await startHeldRequests(home, {
            create: async (input: Record<string, unknown>, caller: ToolCaller) => {
              created.push({ ...input, released: (caller as { released?: true }).released === true });
              return { ok: true, text: JSON.stringify({ requestId: `req-20261110T2${created.length}0000Z`, workerId: `w-new-${created.length}` }) };
            },
            queue,
            ...(on === undefined ? {} : { paseo: on as never }),
            log: () => {},
          });
        }
      })();
    return { told, created, pass };
  }

  const stall = (home: string, requestId: string) => createAlertStore(home, { now: () => new Date(SINCE) }).raise({ workspaceId: REPO, kind: "request-stalled", subject: requestId });
  /** What the stall watcher does when a request leaves its 24-hour window. */
  const windowEnds = (home: string, requestId: string) => expect(createAlertStore(home).clear(alertKeyOf("request-stalled", REPO, requestId))).toBe(true);
  /** A bead the head's Worker closed: progress, as the stall watcher counts it. */
  async function activity(home: string, requestId: string, at = LATER) {
    await appendRecord(
      { tracesDir: join(home, "traces") },
      turn({ workspaceId: REPO, agentId: `w-${requestId}`, role: "worker", turnId: `t-${at}`, requestId, at, endedAt: at, evidence: [{ ...shell("br close bm-1 --reason done", at, `w-${requestId}`), status: "completed" }] }),
    );
    clearTraceStoreCache();
  }
  /** A step the pass started as `requestId`, alone in its line: a last step. */
  async function startedStep(home: string, missionId: string, requestId: string) {
    const proposed = proposeLine(home, missionId, { lineId: `line-${requestId}`, by: "main-1", steps: [{ title: "The step", request: "Do it.", acceptance: ["Done"] }] }, NOW);
    if (!proposed.ok) throw new Error(proposed.reason);
    applyLine(home, missionId, `line-${requestId}`);
    await startHeldRequests(home, { create: async () => ({ ok: true, text: JSON.stringify({ requestId, workerId: `w-${requestId}` }) }), queue: queueOf().queue, log: () => {} });
    const holdId = proposed.entries[0]!.holdId;
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "started", startedAs: requestId });
    return holdId;
  }
  const entryOf = (home: string, missionId: string, holdId: string) => heldRequestsOf(home, missionId).find((entry) => entry.holdId === holdId)!;

  it("a failed gate stops the entry with its reasons, told exactly once over many passes, with the real options and never bm_create_worker", async () => {
    const { home, missionId, request, finish, hold } = world();
    const first = request();
    const holdId = hold([first]);
    finish(first, { passed: false, reasons: ["review batch b1 has not passed", "its checks are self-reported"] });
    const { told, created, pass } = runner(home);
    await pass(5);
    expect(created).toEqual([]);
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${first} did not pass its finish gate: review batch b1 has not passed; its checks are self-reported`, toldKey: `${first}:${GATE_AT}` });
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("review batch b1 has not passed");
    expect(told[0]).toContain(`bm_tell_worker on ${first}`);
    expect(told[0]).toContain(`bm_hold_release on ${holdId} only on the owner's word`);
    expect(told[0]).toContain(`bm_hold_cancel on ${holdId}`);
    expect(told[0]).not.toContain("bm_create_worker");
  });

  it("a continuation that fails again gets its own notice, and one that passes starts the entry", async () => {
    const { home, missionId, request, finish, registry, roster, hold } = world();
    const first = request();
    const holdId = hold([first]);
    finish(first, { passed: false, reasons: ["first"] });
    const { told, created, pass } = runner(home);
    await pass(2);
    expect(told).toHaveLength(1);

    const second = request(first);
    await pass();
    expect(entryOf(home, missionId, holdId).state).toBe("held");
    expect(told).toHaveLength(1);
    registry.noteFinishGate(REPO, second, { passed: false, reasons: ["second"], at: "2026-11-10T07:59:30.000Z", commit: null });
    roster.setState(missionId, second, "finished");
    await pass(3);
    expect(told).toHaveLength(2);
    expect(told[1]).toContain("second");
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", toldKey: `${second}:2026-11-10T07:59:30.000Z` });

    const third = request(second);
    finish(third, { passed: true });
    await pass(3);
    expect(created).toHaveLength(1);
    expect(entryOf(home, missionId, holdId).state).toBe("started");
    expect(told).toHaveLength(2 + 1);
  });

  it("a stopped request and a cancelled entry each stop it, once; the cancelled one offers no bm_tell_worker", async () => {
    const { home, missionId, request, roster, hold } = world();
    const running = request();
    const afterStopped = hold([running], "After the stopped request");
    const dropped = hold([running], "Dropped");
    const afterDropped = hold([dropped], "After the dropped one");
    roster.setState(missionId, running, "stopped");
    expect(cancelHeld(home, missionId, dropped, "not needed", NOW)).toBeNull();
    const { told, pass } = runner(home);
    await pass(3);
    expect(entryOf(home, missionId, afterStopped)).toMatchObject({ state: "waiting-stopped", note: `${running} stopped`, toldKey: `${running}:stopped` });
    expect(entryOf(home, missionId, afterDropped)).toMatchObject({ state: "waiting-stopped", note: `${dropped} was cancelled`, toldKey: `${dropped}:cancelled` });
    expect(told).toHaveLength(2);
    const cancelled = told.find((text) => text.includes("was cancelled"))!;
    expect(cancelled).not.toContain("bm_tell_worker");
    expect(cancelled).not.toContain("bm_create_worker");
  });

  it("a stalled head stops the entry, one notice, and a passed gate later starts it", async () => {
    const { home, missionId, request, finish, hold } = world();
    const first = request();
    const holdId = hold([first]);
    stall(home, first);
    const { told, created, pass } = runner(home, paseoWith([{ id: `w-${first}` }]));
    await pass(3);
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${first} has stalled since ${SINCE}`, toldKey: `${first}:stall:${SINCE}` });
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`bm_tell_worker on ${first}, about: "current"`);
    expect(told[0]).not.toContain("bm_create_worker");
    expect(created).toEqual([]);
    finish(first, { passed: true });
    await pass();
    expect(created).toHaveLength(1);
    expect(entryOf(home, missionId, holdId).state).toBe("started");
  });

  it("an active head with no unarchived Worker stops the entry, one notice, and the notice sends nobody to tell a Worker it does not have", async () => {
    const { home, missionId, request, hold } = world();
    const first = request();
    const holdId = hold([first]);
    const { told, created, pass } = runner(home, paseoWith([{ id: `w-${first}`, archivedAt: "2026-11-10T06:00:00.000Z" }]));
    await pass(3);
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${first} has no live Worker`, toldKey: `${first}:no-worker` });
    expect(told).toHaveLength(1);
    expect(told[0]).not.toContain("bm_tell_worker");
    expect(told[0]).toContain("bm_hold_release");
    expect(told[0]).not.toContain("bm_create_worker");
    expect(created).toEqual([]);
  });

  it("a resting Worker is live, an active head reads as waiting when Paseo cannot be read, and a stop that no longer holds returns to held", async () => {
    const { home, missionId, request, hold } = world();
    const first = request();
    const holdId = hold([first]);
    const { told, pass } = runner(home);
    await pass(1, paseoWith([{ id: `w-${first}`, status: "closed", persistence: { sessionId: "s-1" } }]));
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "held" });
    await pass(1, { agents: { list: async () => { throw new Error("offline"); } } });
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "held" });
    expect(told).toEqual([]);

    await pass(1, paseoWith([]));
    expect(entryOf(home, missionId, holdId).state).toBe("waiting-stopped");
    await pass(1, paseoWith([{ id: `w-${first}` }]));
    expect(entryOf(home, missionId, holdId).state).toBe("held");
    expect(entryOf(home, missionId, holdId).note).toBeUndefined();
    expect(told).toHaveLength(1);
  });

  it("a stall stop survives the alert's 24-hour window, stays releasable, and only new activity on the head ends it", async () => {
    const { home, missionId, request, hold } = world();
    const first = request();
    const holdId = hold([first]);
    stall(home, first);
    const { told, pass } = runner(home, paseoWith([{ id: `w-${first}` }]));
    await pass();
    expect(entryOf(home, missionId, holdId).state).toBe("waiting-stopped");

    windowEnds(home, first);
    await pass(3);
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", toldKey: `${first}:stall:${SINCE}` });
    expect(told).toHaveLength(1);

    // Activity from before the stall is not new.
    await activity(home, first, "2026-11-10T06:30:00.000Z");
    await pass();
    expect(entryOf(home, missionId, holdId).state).toBe("waiting-stopped");

    await activity(home, first);
    await pass();
    expect(entryOf(home, missionId, holdId).state).toBe("held");
    expect(entryOf(home, missionId, holdId).toldKey).toBeUndefined();
    expect(told).toHaveLength(1);
  });

  it("releasing an entry whose stall outlived its alert starts it", async () => {
    const { home, missionId, request, hold } = world();
    const first = request();
    const holdId = hold([first]);
    stall(home, first);
    const { created, pass } = runner(home, paseoWith([{ id: `w-${first}` }]));
    await pass();
    windowEnds(home, first);
    await pass();
    expect(releaseHeld(home, missionId, holdId)).toBeNull();
    await pass(3);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ released: true });
    expect(entryOf(home, missionId, holdId).state).toBe("started");
  });

  it("a due entry whose slot is held by a stalled head stops with it, and starts when the head has ended", async () => {
    const { home, missionId, request, finish, hold } = world();
    const running = request();
    const holdId = hold([], "New work");
    const { told, created, pass } = runner(home, paseoWith([{ id: `w-${running}` }]));
    // Silent while the head is merely at work.
    await pass(2);
    expect(entryOf(home, missionId, holdId).state).toBe("held");
    expect(told).toEqual([]);

    stall(home, running);
    await pass(3);
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${running} has stalled since ${SINCE}` });
    expect(told).toHaveLength(1);
    expect(created).toEqual([]);

    finish(running, { passed: true });
    await pass();
    expect(created).toHaveLength(1);
  });

  it.each([
    ["a stalled head", true, [{ id: "w" }]],
    ["a head with no unarchived Worker", false, [{ id: "w", archivedAt: "2026-11-10T06:00:00.000Z" }]],
  ])("%s stops a last step: it stays started, shows its note, one notice, and no second Worker over many passes", async (_name, stalls, listedWorkers) => {
    const { home, missionId, request } = world();
    const head = request();
    const holdId = await startedStep(home, missionId, head);
    if (stalls) stall(home, head);
    const { told, created, pass } = runner(home, paseoWith(listedWorkers.map((worker) => ({ ...worker, id: `w-${head}` }))));
    await pass(5);
    const entry = entryOf(home, missionId, holdId);
    expect(entry.state).toBe("started");
    expect(entry.stopNote).toBe(stalls ? `${head} has stalled since ${SINCE}` : `${head} has no live Worker`);
    expect(entry.toldKey).toBe(stalls ? `${head}:stall:${SINCE}` : `${head}:no-worker`);
    expect(created).toEqual([]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("step 1 of 1");
    expect(told[0]).toContain(`bm_hold_cancel on ${holdId}`);
    expect(told[0]).not.toContain("bm_hold_release");
    expect(told[0]).not.toContain("bm_create_worker");
  });

  it("bm_hold_release refuses a started step; a continuation that takes over its chain clears the stop; it is never created again", async () => {
    const { home, missionId, request } = world();
    const head = request();
    const holdId = await startedStep(home, missionId, head);
    stall(home, head);
    const { told, created, pass } = runner(home, paseoWith([{ id: `w-${head}` }]));
    await pass();
    expect(releaseHeld(home, missionId, holdId)).toBe(`held request ${holdId} is started, and only a waiting-stopped one is released`);

    const next = request(head);
    await pass(1, paseoWith([{ id: `w-${head}` }, { id: `w-${next}` }]));
    const entry = entryOf(home, missionId, holdId);
    expect(entry.state).toBe("started");
    expect(entry.stopNote).toBeUndefined();
    expect(created).toEqual([]);
    expect(told).toHaveLength(1);
  });

  it("bm_hold_cancel settles a started step with a stop as cancelled, and is refused for one with none", async () => {
    const { home, missionId, request } = world();
    const quiet = request();
    const unstopped = await startedStep(home, missionId, quiet);
    expect(cancelHeld(home, missionId, unstopped, "not needed", NOW)).toBe(`held request ${unstopped} is already started`);

    const head = request();
    const holdId = await startedStep(home, missionId, head);
    stall(home, head);
    const { created, pass } = runner(home, paseoWith([{ id: `w-${head}` }, { id: `w-${quiet}` }]));
    await pass();
    expect(cancelHeld(home, missionId, holdId, "the owner dropped it", NOW)).toBeNull();
    expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "cancelled", note: "the owner dropped it" });
    expect(entryOf(home, missionId, holdId).stopNote).toBeUndefined();
    await pass(2);
    expect(created).toEqual([]);
    expect(entryOf(home, missionId, holdId).state).toBe("cancelled");
  });

  it("new activity on a started step's head ends its stall stop, and the alert's window does not", async () => {
    const { home, missionId, request } = world();
    const head = request();
    const holdId = await startedStep(home, missionId, head);
    stall(home, head);
    const { told, pass } = runner(home, paseoWith([{ id: `w-${head}` }]));
    await pass();
    windowEnds(home, head);
    await pass(2);
    expect(entryOf(home, missionId, holdId).stopNote).toBe(`${head} has stalled since ${SINCE}`);
    await activity(home, head);
    await pass();
    expect(entryOf(home, missionId, holdId).stopNote).toBeUndefined();
    expect(told).toHaveLength(1);
  });

  it("one failure is one notice: a stalled step and the held step after it", async () => {
    const { home, missionId, request, hold } = world();
    const head = request();
    const stepId = await startedStep(home, missionId, head);
    const afterStep = hold([stepId], "The next step");
    stall(home, head);
    const { told, created, pass } = runner(home, paseoWith([{ id: `w-${head}` }]));
    await pass(3);
    expect(entryOf(home, missionId, afterStep).state).toBe("waiting-stopped");
    expect(entryOf(home, missionId, stepId).stopNote).toBeDefined();
    expect(told).toHaveLength(1);
    expect(created).toEqual([]);
  });

  it("releases only a waiting-stopped entry: past a failed gate, a stopped request, a stall and the slot", async () => {
    const { home, missionId, roster, request, finish, hold } = world();
    const failed = request();
    finish(failed, { passed: false, reasons: ["no"] });
    const stopped = request();
    roster.setState(missionId, stopped, "stopped");
    const afterFailed = hold([failed], "After failed");
    const afterStopped = hold([stopped], "After stopped");
    const running = request();
    const afterRunning = hold([running], "After running");
    const { created, pass } = runner(home, paseoWith([{ id: `w-${running}` }]));
    await pass();
    expect(releaseHeld(home, missionId, afterRunning)).toBe(`held request ${afterRunning} is held, and only a waiting-stopped one is released`);
    expect(releaseHeld(home, missionId, "hold-20261110T010101Z")).toBe("no held request hold-20261110T010101Z in this mission (bm_mission lists them)");
    expect(releaseHeld(home, missionId, afterFailed)).toBeNull();
    expect(releaseHeld(home, missionId, afterStopped)).toBeNull();
    // Both start past the running request's slot, and each carries the release to bm_create_worker.
    await pass();
    expect(created.map((input) => [input["request"], input["released"]])).toEqual([["After failed", true], ["After stopped", true]]);
    expect(entryOf(home, missionId, afterRunning).state).toBe("held");
  });

  it("a step's start is a no-turn note that heads the Main's next notice, once; a plain held entry keeps its notice", async () => {
    const { home, missionId, request, finish, hold } = world();
    const proposed = proposeLine(home, missionId, { lineId: "line-n", by: "main-1", steps: [{ title: "The step", request: "Do it.", acceptance: ["Done"] }] }, NOW);
    if (!proposed.ok) throw new Error(proposed.reason);
    applyLine(home, missionId, "line-n");
    const { told, pass } = runner(home);
    await pass();
    expect(told).toEqual([]);
    expect(entryOf(home, missionId, proposed.entries[0]!.holdId).state).toBe("started");
    const [note] = createOutbox(home).list(REPO);
    expect(note).toMatchObject({ kind: "message", to: "main-1", state: "delivered", reason: "no-turn" });
    expect(note!.text).toContain("Step 1 of 1");

    const first = request();
    const plain = hold([first], "Plain work");
    finish(first, { passed: false, reasons: ["no"] });
    await pass(2);
    expect(entryOf(home, missionId, plain).state).toBe("waiting-stopped");
    expect(told).toHaveLength(1);
    expect(told[0]!.startsWith(`BM-DELIVERY held\nnoted: message ${note!.id} from plugin: Step 1 of 1`)).toBe(true);
    expect(told[0]).toContain("Plain work");

    const later = request();
    const next = hold([later], "Later work");
    finish(later, { passed: false, reasons: ["again"] });
    await pass();
    expect(told).toHaveLength(2);
    expect(told[1]).not.toContain("noted:");
    expect(told[1]).toContain(next);
  });

  /** Review b3: what used to read a request as gone, or a notice as heard, when neither was so. */
  describe("a slot that cannot be read (ADR-045 decision 1)", () => {
    const unreadable = { agents: { list: async () => { throw new Error("offline"); } } };

    it("holds a due entry: nothing is created beside the running request, and a list that reads again frees the slot", async () => {
      const { home, missionId, request, hold } = world();
      const running = request();
      const holdId = hold([], "New work");
      const { told, created, pass } = runner(home);
      await pass(2, unreadable);
      expect(created).toEqual([]);
      expect(entryOf(home, missionId, holdId).state).toBe("held");
      expect(told).toEqual([]);

      await pass(1, paseoWith([{ id: `w-${running}`, archivedAt: "2026-11-10T06:00:00.000Z" }]));
      expect(created).toHaveLength(1);
    });

    it("leaves a stopped entry as it is: same stop, same key, no second notice", async () => {
      const { home, missionId, request, hold } = world();
      const running = request();
      const holdId = hold([], "New work");
      stall(home, running);
      const { told, created, pass } = runner(home, paseoWith([{ id: `w-${running}` }]));
      await pass();
      expect(told).toHaveLength(1);
      const stopped = entryOf(home, missionId, holdId);
      expect(stopped.state).toBe("waiting-stopped");
      await pass(2, unreadable);
      expect(entryOf(home, missionId, holdId)).toEqual(stopped);
      await pass();
      expect(told).toHaveLength(1);
      expect(created).toEqual([]);
    });
  });

  describe("a stop's notice that does not reach the Main (ADR-045 decision 2)", () => {
    type Item = { line: string; callbacks?: { onDropped?: (target: string, kind: string, reason: string) => void } };
    /** A queue that answers each notice with the next of `outcomes`, then `sent`; `last` is what was queued last. */
    function answering(outcomes: string[]) {
      const told: string[] = [];
      const seen: { last?: Item } = {};
      const queue = {
        enqueue: vi.fn(async () => "sent" as const),
        enqueueBatch: vi.fn(async (_target: string, _batch: unknown, items: Item[]) => {
          told.push(items[0]!.line);
          seen.last = items[0]!;
          return [outcomes.shift() ?? "sent"];
        }),
      };
      return { told, seen, queue: queue as never };
    }
    const passWith = (home: string, queue: never) => startHeldRequests(home, { create: async () => ({ ok: true, text: "{}" }), queue, log: () => {} });

    function failedWith(hold: (after: string[], topic?: string) => string, finish: (requestId: string, gate: { passed: boolean; reasons?: string[] } | null) => void, request: () => string) {
      const first = request();
      const entry = hold([first]);
      finish(first, { passed: false, reasons: ["review batch b1 has not passed"] });
      return { first, entry };
    }

    it("a notice the queue answers dropped is told again at a later pass, and once it went out, never again", async () => {
      const { home, missionId, request, finish, hold } = world();
      const { first, entry } = failedWith(hold, finish, request);
      const { told, queue } = answering(["dropped"]);
      await passWith(home, queue);
      expect(told).toHaveLength(1);
      expect(entryOf(home, missionId, entry).toldKey).toBeUndefined();
      expect(entryOf(home, missionId, entry).state).toBe("waiting-stopped");
      await passWith(home, queue);
      expect(told).toHaveLength(2);
      expect(entryOf(home, missionId, entry).toldKey).toBe(`${first}:${GATE_AT}`);
      await passWith(home, queue);
      expect(told).toHaveLength(2);
    });

    it("a queued notice dropped later is told again, and what is queued or sent is not", async () => {
      const { home, missionId, request, finish, hold } = world();
      const { first, entry } = failedWith(hold, finish, request);
      const { told, seen, queue } = answering(["queued"]);
      await passWith(home, queue);
      await passWith(home, queue);
      expect(told).toHaveLength(1);
      expect(entryOf(home, missionId, entry).toldKey).toBe(`${first}:${GATE_AT}`);

      seen.last!.callbacks!.onDropped!("main-1", "BM-UPDATES", "the send failed");
      expect(entryOf(home, missionId, entry).toldKey).toBeUndefined();
      await passWith(home, queue);
      expect(told).toHaveLength(2);
    });

    it("one failure stopping two entries is forgotten for both: each tries in its turn until one reaches the Main, then no more", async () => {
      const { home, missionId, request, finish, hold } = world();
      const { first, entry } = failedWith(hold, finish, request);
      const other = hold([first], "The other work");
      const { told, queue } = answering(["dropped", "dropped"]);
      await passWith(home, queue);
      expect(told).toHaveLength(2);
      expect([entryOf(home, missionId, entry).toldKey, entryOf(home, missionId, other).toldKey]).toEqual([undefined, undefined]);
      await passWith(home, queue);
      expect(told).toHaveLength(3);
      await passWith(home, queue);
      expect(told).toHaveLength(3);
      expect(entryOf(home, missionId, other).toldKey).toBe(`${first}:${GATE_AT}`);
    });
  });

  describe("an abandoned request (ADR-045 decision 2)", () => {
    const OCTOBER = "2026-10-05T09:00:00.000Z";
    const RESTING = { status: "closed", persistence: { sessionId: "s-old" } };

    /** A request from October nobody finished, on the roster with no alert: its Worker is `w-<request id>`. */
    function abandoned(home: string, missionId: string, requestId = "req-20261005T090000Z") {
      createRequestRegistry(home, { log: () => {} }).register(REPO, requestId, { source: "backfill", managerId: "main-1" });
      createMissionRoster(home, { now: () => new Date(OCTOBER) }).add(missionId, { requestId, workspaceId: REPO, topic: "work from October", workerId: `w-${requestId}` });
      return requestId;
    }
    const listing = (requestId: string, worker: object = RESTING) => paseoWith([{ id: `w-${requestId}`, ...worker }]);

    it("holding the slot, it stops a next entry with one notice, the entry can be released, and it then starts past the slot", async () => {
      const { home, missionId, hold } = world();
      const old = abandoned(home, missionId);
      const holdId = hold([], "New work");
      const { told, created, pass } = runner(home, listing(old));
      await pass(3);
      expect(created).toEqual([]);
      expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${old} has stalled since ${OCTOBER}`, toldKey: `${old}:stall:${OCTOBER}` });
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(`bm_tell_worker on ${old}, about: "current"`);
      expect(told[0]).toContain(`bm_hold_release on ${holdId} only on the owner's word`);
      expect(told[0]).toContain(`bm_hold_cancel on ${holdId}`);
      expect(told[0]).not.toContain("bm_create_worker");

      expect(releaseHeld(home, missionId, holdId)).toBeNull();
      await pass();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ released: true });
      expect(entryOf(home, missionId, holdId).state).toBe("started");
    });

    it("as the head an entry follows, it stops that entry with one notice, and the entry can be cancelled", async () => {
      const { home, missionId, hold } = world();
      const old = abandoned(home, missionId);
      const holdId = hold([old], "After October");
      const { told, created, pass } = runner(home, listing(old));
      await pass(3);
      expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", toldKey: `${old}:stall:${OCTOBER}` });
      expect(told).toHaveLength(1);
      expect(cancelHeld(home, missionId, holdId, "no longer wanted", NOW)).toBeNull();
      expect(entryOf(home, missionId, holdId).state).toBe("cancelled");
      await pass(2);
      expect(created).toEqual([]);
      expect(told).toHaveLength(1);
    });

    it("as a started step's head, it stops the step: it stays started, shows its note, one notice, no second Worker", async () => {
      const { home, missionId } = world();
      const old = abandoned(home, missionId);
      const holdId = await startedStep(home, missionId, old);
      const { told, created, pass } = runner(home, listing(old));
      await pass(3);
      expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "started", stopNote: `${old} has stalled since ${OCTOBER}`, toldKey: `${old}:stall:${OCTOBER}` });
      expect(told).toHaveLength(1);
      expect(created).toEqual([]);
      expect(cancelHeld(home, missionId, holdId, "the owner dropped it", NOW)).toBeNull();
    });

    it("is idle since its newest record, whichever is later than the roster's time", async () => {
      const { home, missionId, hold } = world();
      const old = abandoned(home, missionId);
      const holdId = hold([], "New work");
      const newest = "2026-10-20T10:00:00.000Z";
      await activity(home, old, newest);
      const { pass } = runner(home, listing(old));
      await pass();
      expect(entryOf(home, missionId, holdId)).toMatchObject({ state: "waiting-stopped", note: `${old} has stalled since ${newest}` });
    });

    it.each([
      ["a Worker in a live turn", { status: "running" }, false],
      ["a Worker starting up", { status: "initializing" }, false],
      ["activity inside the window", RESTING, true],
    ])("%s is not abandoned: the entry waits, silently", async (_name, worker, recent) => {
      const { home, missionId, hold } = world();
      const old = abandoned(home, missionId);
      const holdId = hold([], "New work");
      if (recent) await activity(home, old, new Date(Date.now() - 3_600_000).toISOString());
      const { told, created, pass } = runner(home, listing(old, worker));
      await pass(3);
      expect(entryOf(home, missionId, holdId).state).toBe("held");
      expect(told).toEqual([]);
      expect(created).toEqual([]);
    });

    it("a request made inside the window is not abandoned, however idle it reads", async () => {
      const { home, missionId, request, hold } = world();
      const fresh = request();
      const holdId = hold([], "New work");
      const { told, pass } = runner(home, listing(fresh));
      await pass(2);
      expect(entryOf(home, missionId, holdId).state).toBe("held");
      expect(told).toEqual([]);
    });

    it("a cancel tells again what the failure still stops", async () => {
      const { home, missionId, hold } = world();
      const old = abandoned(home, missionId);
      const first = hold([], "First new work");
      const second = hold([], "Second new work");
      const { told, pass } = runner(home, listing(old));
      await pass(2);
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(first);
      expect(cancelHeld(home, missionId, first, "no longer wanted", NOW)).toBeNull();
      await pass(2);
      expect(told).toHaveLength(2);
      expect(told[1]).toContain(`bm_hold_release on ${second}`);
    });

    it("a release tells again what the failure still stops: a sibling, then the next step, never wait unseen", async () => {
      const { home, missionId, registry, roster, hold } = world();
      const old = abandoned(home, missionId);
      const first = hold([], "First new work");
      const second = hold([], "Second new work");
      const { told, created, pass } = runner(home, listing(old));
      const stops = () => told.filter((text) => text.includes("What you can do"));
      await pass(3);
      expect(stops()).toHaveLength(1);
      expect(stops()[0]).toContain(first);

      expect(releaseHeld(home, missionId, first)).toBeNull();
      await pass(2);
      expect(created).toHaveLength(1);
      expect(entryOf(home, missionId, second).state).toBe("waiting-stopped");
      expect(stops()).toHaveLength(2);
      expect(stops()[1]).toContain(`bm_hold_release on ${second}`);
      await pass(2);
      expect(stops()).toHaveLength(2);

      // A line behind it: its next step, due later, is told in its turn.
      const proposed = proposeLine(home, missionId, { lineId: "line-z", by: "main-1", steps: [{ title: "One", request: "One.", acceptance: ["a"] }, { title: "Two", request: "Two.", acceptance: ["b"] }] }, NOW);
      if (!proposed.ok) throw new Error(proposed.reason);
      applyLine(home, missionId, "line-z");
      expect(releaseHeld(home, missionId, second)).toBeNull();
      await pass(2);
      const [one, two] = proposed.entries;
      expect(entryOf(home, missionId, one!.holdId).state).toBe("waiting-stopped");
      expect(releaseHeld(home, missionId, one!.holdId)).toBeNull();
      await pass();
      const startedAs = entryOf(home, missionId, one!.holdId).startedAs!;
      registry.register(REPO, startedAs, { source: "tool", managerId: "main-1" });
      roster.add(missionId, { requestId: startedAs, workspaceId: REPO, topic: "One", workerId: "w-1" });
      registry.noteFinishGate(REPO, startedAs, { passed: true, reasons: [], at: GATE_AT, commit: null });
      roster.setState(missionId, startedAs, "finished");
      const before = stops().length;
      await pass(3);
      expect(entryOf(home, missionId, two!.holdId).state).toBe("waiting-stopped");
      expect(stops()).toHaveLength(before + 1);
      expect(stops().at(-1)).toContain(two!.holdId);
    });
  });

  describe("the previous step's result (ADR-045 decision 3)", () => {
    function twoSteps(home: string, missionId: string) {
      const proposed = proposeLine(home, missionId, { lineId: "line-r", by: "main-1", steps: [{ title: "First", request: "First.", acceptance: ["a"] }, { title: "Second", request: "Second.", acceptance: ["b"], context: [{ fact: "Kept from the plan.", source: "owner" }] }] }, NOW);
      if (!proposed.ok) throw new Error(proposed.reason);
      applyLine(home, missionId, "line-r");
      return proposed.entries;
    }

    it("a started step's brief carries the four facts read at that moment, each within 500 characters, and the stored entry is unchanged", async () => {
      const { home, missionId, registry, request } = world();
      const [first, second] = twoSteps(home, missionId);
      const head = request();
      await startHeldRequests(home, { create: async () => ({ ok: true, text: JSON.stringify({ requestId: head, workerId: `w-${head}` }) }), queue: queueOf().queue, log: () => {} });
      expect(entryOf(home, missionId, first!.holdId).state).toBe("started");
      const before = entryOf(home, missionId, second!.holdId);

      registry.noteFinishGate(REPO, head, { passed: true, reasons: [], at: GATE_AT, commit: "abc1234" });
      registry.noteForNextStep(REPO, head, { summary: "Built the API.", contract: `GET /orders ${"x".repeat(900)}`, remaining: "Pagination.", branch: "mission/SHOP" });
      createMissionRoster(home).setState(missionId, head, "finished");

      const { created, pass } = runner(home);
      await pass();
      expect(created).toHaveLength(1);
      const context = created[0]!["context"] as Array<{ fact: string; source: string }>;
      expect(context[0]!.fact).toBe("The previous step's commit: abc1234 on branch mission/SHOP.");
      expect(context[1]!.fact).toBe("What the previous step did: Built the API.");
      expect(context[2]!.fact.startsWith("The contract the previous step left: GET /orders")).toBe(true);
      expect(context[3]!.fact).toBe("What the previous step left to do: Pagination.");
      expect(context[4]).toEqual({ fact: "Kept from the plan.", source: "owner" });
      expect(context.slice(0, 4).every((entry) => entry.source === "the previous step's finished report" && entry.fact.length <= 500)).toBe(true);
      expect(context[2]!.fact.length).toBe(500);
      expect(entryOf(home, missionId, second!.holdId).input).toEqual(before.input);
    });

    it("the previous step is read at the head of its chain, and a first step gets no facts", async () => {
      const { home, missionId, registry, request } = world();
      const [, second] = twoSteps(home, missionId);
      const root = request();
      const firstRun = runner(home);
      await startHeldRequests(home, { create: async () => ({ ok: true, text: JSON.stringify({ requestId: root, workerId: `w-${root}` }) }), queue: queueOf().queue, log: () => {} });
      expect(firstRun.created).toEqual([]);

      registry.noteFinishGate(REPO, root, { passed: false, reasons: ["it left work for a continuation"], at: GATE_AT, commit: null });
      createMissionRoster(home).setState(missionId, root, "finished");
      const head = request(root);
      registry.noteFinishGate(REPO, head, { passed: true, reasons: [], at: GATE_AT, commit: "def5678" });
      registry.noteForNextStep(REPO, head, { summary: "The rest of it." });
      createMissionRoster(home).setState(missionId, head, "finished");

      const { created, pass } = runner(home);
      await pass();
      expect((created[0]!["context"] as Array<{ fact: string }>).map((entry) => entry.fact)).toEqual(["The previous step's commit: def5678.", "What the previous step did: The rest of it.", "Kept from the plan."]);
      expect(entryOf(home, missionId, second!.holdId).state).toBe("started");
    });
  });
});
