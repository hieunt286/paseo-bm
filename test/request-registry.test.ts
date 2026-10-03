import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_REQUESTS_PER_WORKSPACE,
  REQUESTS_DIR_NAME,
  REQUEST_ID_PATTERN,
  clearRequestRegistryCache,
  createRequestRegistry,
  creatorIsBound,
  knownRequestIdOf,
  requestIdAt,
  sightRequestId,
  type RegisteredRequest,
} from "../plugin/server/request-registry";
import { clearBindingCache, createBindingStore } from "../plugin/server/agent-bindings";
import { settleCreatedAgent } from "../plugin/server/creation-settle";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { collectTurn } from "../plugin/server/collector";
import { bmAgentsOf } from "../plugin/server/paseo-directory";
import { soleWorkerOfRequest } from "../plugin/server/decision-delivery";
import { workingAgents } from "../plugin/server/orchestrator-tool-context";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { checkBlocks } from "../plugin/shared/bm-format";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { bindAgent } from "./helpers/bindings";

/**
 * The request registry (design §16.4, ADR-027 decisions 2 and 7): the store,
 * the one backfill from the trace store, the hand path's `agent-typed`
 * registration at first sight, and `knownRequestIdOf` — the one way the
 * plugin reads `bm.requestId`. Temporary data folders only; the trace store
 * of the backfill is a fixture written here, never field data.
 */

const WS = "wks_1";
const T0 = new Date("2026-10-03T10:00:00.400Z");

afterEach(() => {
  clearRequestRegistryCache();
  clearBindingCache();
  clearTraceStoreCache();
  removeDataFolders();
});

function request(requestId: string, overrides: Partial<RegisteredRequest> = {}): RegisteredRequest {
  return {
    requestId,
    workspaceId: WS,
    createdAt: "2026-09-01T00:00:00.000Z",
    source: "agent-typed",
    managerId: null,
    workerIds: [],
    tier: null,
    finishedAt: null,
    reviews: { batches: [], grants: [] },
    ...overrides,
  };
}

function traceRecord(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-20T10:00:00.000Z",
    workspaceId: WS,
    agentId: "agent-manager",
    role: "manager",
    // No turn id: every fixture record is kept by the reader's de-duplication.
    turnId: null,
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-20T10:00:00.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

/** Binds `agentId` in the data folder's binding store, as a plugin creation does. */
function bind(home: string, agentId: string, role: "manager" | "worker" | "reviewer" = "manager"): void {
  bindAgent(createBindingStore(home), agentId, { role, workspaceId: WS });
}

describe("the store (design §16.4)", () => {
  it("generates req-<UTC second>, one second on when taken, in the format checkBlocks accepts", () => {
    const home = dataFolder();
    const registry = createRequestRegistry(home, { now: () => T0, backfill: () => [] });
    registry.register(WS, "req-20261003T100000Z", { source: "agent-typed" });
    registry.register(WS, "req-20261003T100001Z", { source: "agent-typed" });
    const made = registry.generate(WS, { managerId: "mgr-1" });
    expect(made).toMatchObject({ requestId: "req-20261003T100002Z", source: "tool", managerId: "mgr-1", workerIds: [], createdAt: T0.toISOString() });
    expect(registry.generate(WS, { managerId: "mgr-1" }).requestId).toBe("req-20261003T100003Z");
    expect(requestIdAt(T0)).toBe("req-20261003T100000Z");
    expect(made.requestId).toMatch(REQUEST_ID_PATTERN);
    const block = `BM-REPORT\nrequestId: ${made.requestId}\nphase: received\ntier: Small\nbuildAndTests: not run\nfilesChanged: none\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: none\nbeadsReady: none\nreviewFindingsOpen: none\nskillsUsed: none\ndecided: none\nblockers: none`;
    const [checked] = checkBlocks(block);
    expect(checked?.requestId).toBe(made.requestId);
    expect(checked?.issues.filter((issue) => issue.field === "requestId")).toEqual([]);
  });

  it("writes atomically: the folder 0700, the file 0600, no temporary file left, schemaVersion first", () => {
    const home = dataFolder();
    const registry = createRequestRegistry(home, { now: () => T0, backfill: () => [] });
    registry.generate(WS, { managerId: null });
    const dir = join(home, REQUESTS_DIR_NAME);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${WS}.json`)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([`${WS}.json`]);
    const body = JSON.parse(readFileSync(join(dir, `${WS}.json`), "utf8"));
    expect(Object.keys(body)).toEqual(["schemaVersion", "requests"]);
    expect(body.schemaVersion).toBe(1);
    expect(body.requests[0]).toEqual(request("req-20261003T100000Z", { createdAt: T0.toISOString(), source: "tool" }));
  });

  it("never writes a file a newer paseo-bm wrote, nor one it cannot read, and refuses a workspace id that is not a file name", () => {
    const home = dataFolder();
    mkdirSync(join(home, REQUESTS_DIR_NAME), { mode: 0o700 });
    const path = join(home, REQUESTS_DIR_NAME, `${WS}.json`);
    for (const body of [JSON.stringify({ schemaVersion: 2, requests: [] }), "{not json"]) {
      writeFileSync(path, body, { mode: 0o600 });
      const registry = createRequestRegistry(home, { now: () => T0, backfill: () => [] });
      expect(registry.list(WS)).toEqual([]);
      expect(() => registry.generate(WS, { managerId: null })).toThrow();
      expect(readFileSync(path, "utf8")).toBe(body);
    }
    expect(() => createRequestRegistry(home).generate("..", { managerId: null })).toThrow();
    expect(createRequestRegistry(home).list("../x")).toEqual([]);
  });

  it("keeps at most 2,000 requests: the oldest finished go first, then the oldest; a request the outbox holds is never dropped", () => {
    const home = dataFolder();
    mkdirSync(join(home, REQUESTS_DIR_NAME), { mode: 0o700 });
    const id = (n: number) => `req-202609${String(1 + Math.floor(n / 1440)).padStart(2, "0")}T${String(Math.floor((n % 1440) / 60)).padStart(2, "0")}${String(n % 60).padStart(2, "0")}00Z`;
    const at = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString();
    const requests = Array.from({ length: MAX_REQUESTS_PER_WORKSPACE }, (_, n) => request(id(n), { createdAt: at(n), finishedAt: n === 0 || n === 5 || n === 7 ? at(n + 1) : null }));
    writeFileSync(join(home, REQUESTS_DIR_NAME, `${WS}.json`), JSON.stringify({ schemaVersion: 1, requests }), { mode: 0o600 });
    // Request 0 has a pending outbox record: kept; 5 is the oldest finished one left.
    const registry = createRequestRegistry(home, { now: () => T0, backfill: () => [], keepRequest: (_ws, requestId) => requestId === id(0) });
    registry.register(WS, "req-20261003T100000Z", { source: "agent-typed" });
    let ids = registry.list(WS).map((entry) => entry.requestId);
    expect(ids).toHaveLength(MAX_REQUESTS_PER_WORKSPACE);
    expect(ids).toContain(id(0));
    expect(ids).not.toContain(id(5));
    expect(ids).toContain(id(7));
    registry.register(WS, "req-20261003T100001Z", { source: "agent-typed" });
    registry.register(WS, "req-20261003T100002Z", { source: "agent-typed" });
    ids = registry.list(WS).map((entry) => entry.requestId);
    expect(ids).not.toContain(id(7));
    // No finished one left to drop: the oldest unfinished goes, never the kept one.
    expect(ids).not.toContain(id(1));
    expect(ids).toContain(id(0));
    expect(ids.slice(-3)).toEqual(["req-20261003T100000Z", "req-20261003T100001Z", "req-20261003T100002Z"]);
  });
});

describe("the backfill (design §16.4)", () => {
  it("fills a new workspace file once from a copy of the trace store, and never again", async () => {
    const home = dataFolder();
    const location = { tracesDir: join(home, "traces") };
    // A fixture store: two requests over three agents, one record without a request, and another workspace's request.
    await appendRecord(location, traceRecord({ requestId: "req-20260920T090000Z", agentId: "mgr-1", startedAt: "2026-09-20T09:00:00.000Z", at: "2026-09-20T09:01:00.000Z" }));
    await appendRecord(location, traceRecord({ requestId: "req-20260920T090000Z", agentId: "wrk-1", role: "worker", parentAgentId: "mgr-1", at: "2026-09-20T09:05:00.000Z", endedAt: "2026-09-20T09:05:00.000Z" }));
    await appendRecord(location, traceRecord({ requestId: "req-20260920T090000Z", agentId: "wrk-2", role: "worker", parentAgentId: "mgr-1", at: "2026-09-20T09:30:00.000Z", endedAt: "2026-09-20T09:30:00.000Z" }));
    await appendRecord(location, traceRecord({ requestId: "req-20260921T080000Z", agentId: "mgr-1", at: "2026-09-21T08:00:00.000Z" }));
    await appendRecord(location, traceRecord({ requestId: null, agentId: "mgr-1", at: "2026-09-21T08:10:00.000Z" }));
    await appendRecord(location, traceRecord({ requestId: "req-20260922T080000Z", workspaceId: "wks_2", at: "2026-09-22T08:00:00.000Z" }));
    const before = readdirSync(join(home, "traces"), { recursive: true }).map(String).sort();

    const registry = createRequestRegistry(home, { now: () => T0 });
    expect(registry.list(WS)).toEqual([]);
    registry.register(WS, "req-20261003T100000Z", { source: "agent-typed", managerId: "mgr-1" });
    expect(registry.list(WS)).toEqual([
      request("req-20260920T090000Z", { source: "backfill", createdAt: "2026-09-20T09:00:00.000Z", managerId: "mgr-1", workerIds: ["wrk-1", "wrk-2"] }),
      request("req-20260921T080000Z", { source: "backfill", createdAt: "2026-09-21T08:00:00.000Z", managerId: "mgr-1" }),
      request("req-20261003T100000Z", { createdAt: T0.toISOString(), managerId: "mgr-1" }),
    ]);
    // The trace store is only read.
    expect(readdirSync(join(home, "traces"), { recursive: true }).map(String).sort()).toEqual(before);

    // A request recorded after the file exists is never backfilled.
    await appendRecord(location, traceRecord({ requestId: "req-20261001T080000Z", agentId: "mgr-1", at: "2026-10-01T08:00:00.000Z" }));
    clearTraceStoreCache();
    registry.generate(WS, { managerId: "mgr-1" });
    expect(registry.has(WS, "req-20261001T080000Z")).toBe(false);
    expect(registry.list(WS)).toHaveLength(4);
  });
});

describe("the hand path and the bound path (design §16.4)", () => {
  it("registers an unbound Manager's id agent-typed at its first sighting: a recorded turn, and agent.created of its Worker", async () => {
    const home = dataFolder();
    const registry = createRequestRegistry(home);
    // The Manager's own record: its id, no Worker yet.
    expect(sightRequestId({ workspaceId: WS, requestId: "req-20261003T090000Z", role: "manager", agentId: "mgr-1", parentAgentId: null }, { home })).toBe(true);
    expect(registry.get(WS, "req-20261003T090000Z")).toMatchObject({ source: "agent-typed", managerId: "mgr-1", workerIds: [] });
    // agent.created of a Worker it made by hand.
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { labels: { "bm.requestId": "req-20261003T090000Z", "paseo.parent-agent-id": "mgr-1" } } }) }) } };
    await settleCreatedAgent({ id: "wrk-1", provider: "bm-worker/claude-opus-5", parentAgentId: "mgr-1", workspaceId: WS }, paseo, { home, bindings: null, log: () => {} });
    expect(registry.get(WS, "req-20261003T090000Z")?.workerIds).toEqual(["wrk-1"]);
    // Not a Worker, a Reviewer's sighting, an id of another shape: nothing.
    await settleCreatedAgent({ id: "rev-1", provider: "bm-reviewer", parentAgentId: "wrk-1", workspaceId: WS }, paseo, { home, bindings: null, log: () => {} });
    expect(registry.get(WS, "req-20261003T090000Z")?.workerIds).toEqual(["wrk-1"]);
    expect(sightRequestId({ workspaceId: WS, requestId: "req-20261003T090001Z", role: "reviewer", agentId: "rev-1", parentAgentId: "wrk-1" }, { home })).toBe(false);
    expect(sightRequestId({ workspaceId: WS, requestId: "req-A", role: "worker", agentId: "wrk-1", parentAgentId: "mgr-1" }, { home })).toBe(false);
    expect(registry.list(WS).map((entry) => entry.requestId)).toEqual(["req-20261003T090000Z"]);
  });

  it("the collector's record registers the id it carries, once", async () => {
    const home = dataFolder();
    const location = { tracesDir: join(home, "traces") };
    const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [], agent: { labels: { "bm.requestId": "req-20261003T090000Z" } } }) } }) } };
    const event = {
      agent: { id: "wrk-1", workspaceId: WS, parentAgentId: "mgr-1", provider: "bm-worker/claude-opus-5", cwd: "/repo", title: "Beads Worker" },
      turnId: "turn-1",
      outcome: { kind: "completed" },
      timeline: [],
    };
    const logs: string[] = [];
    const record = await collectTurn(event as never, { location, paseo: paseo as never, log: (line) => logs.push(line) });
    expect(record?.requestId).toBe("req-20261003T090000Z");
    // Created by this first write, after the backfill of the store, which already holds this turn's record.
    expect(createRequestRegistry(home).get(WS, "req-20261003T090000Z")).toMatchObject({ managerId: "mgr-1", workerIds: ["wrk-1"] });
    await collectTurn({ ...event, turnId: "turn-2" } as never, { location, paseo: paseo as never, log: (line) => logs.push(line) });
    expect(createRequestRegistry(home).list(WS)).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("under a bound creator an unregistered label is null and logged once, and is never registered", async () => {
    const home = dataFolder();
    bind(home, "mgr-bound", "manager");
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const worker = { id: "wrk-1", workspaceId: WS, labels: { "bm.requestId": "req-20261003T090000Z", "paseo.parent-agent-id": "mgr-bound" } };
    expect(knownRequestIdOf(worker, { home, log })).toBeNull();
    expect(knownRequestIdOf(worker, { home, log })).toBeNull();
    expect(logs).toEqual([
      "[paseo-bm] agent wrk-1 carries bm.requestId=req-20261003T090000Z, which no tool of its bound creator registered; it is read as no request.",
    ]);
    // Its sightings register nothing: the bound path's ids come only from the tools.
    expect(sightRequestId({ workspaceId: WS, requestId: "req-20261003T090000Z", role: "worker", agentId: "wrk-1", parentAgentId: "mgr-bound" }, { home })).toBe(false);
    expect(sightRequestId({ workspaceId: WS, requestId: "req-20261003T090000Z", role: "manager", agentId: "mgr-bound", parentAgentId: null }, { home })).toBe(false);
    expect(existsSync(join(home, REQUESTS_DIR_NAME))).toBe(false);
    // A registered id is read.
    const made = createRequestRegistry(home, { backfill: () => [] }).generate(WS, { managerId: "mgr-bound" });
    expect(knownRequestIdOf({ ...worker, labels: { "bm.requestId": made.requestId, "paseo.parent-agent-id": "mgr-bound" } }, { home, log })).toBe(made.requestId);
    // The plugin's own creation counts as bound too; an unbound creator's label is read as before.
    bind(home, "wrk-own", "worker");
    expect(creatorIsBound({ id: "wrk-own", labels: {} }, createBindingStore(home).list())).toBe(true);
    expect(knownRequestIdOf({ id: "wrk-own", workspaceId: WS, labels: { "bm.requestId": "req-20261003T090500Z" } }, { home, log })).toBeNull();
    expect(knownRequestIdOf({ id: "wrk-hand", workspaceId: WS, labels: { "bm.requestId": "req-A" }, parentAgentId: "mgr-hand" }, { home, log })).toBe("req-A");
    expect(knownRequestIdOf({ id: "wrk-none", workspaceId: WS, labels: {} }, { home, log })).toBeNull();
    // A revoked parent binding is not a live one: its Workers are read as the hand path.
    createBindingStore(home).revokeAgent("mgr-bound");
    expect(knownRequestIdOf(worker, { home, log })).toBe("req-20261003T090000Z");
  });
});

describe("every label-trusting site reads knownRequestIdOf (design §16.4)", () => {
  const LABELS = (requestId: string, parent: string) => ({ "bm.role": "worker", "bm.requestId": requestId, "paseo.parent-agent-id": parent });
  const paseoWith = (agents: Array<Record<string, unknown>>) => ({
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } }) },
    workspaces: { list: async () => ({ entries: [] }) },
  });
  const agents = [
    { id: "wrk-hand", provider: "bm-worker", workspaceId: WS, status: "idle", labels: LABELS("req-20261003T080000Z", "mgr-hand") },
    { id: "wrk-bound", provider: "bm-worker", workspaceId: WS, status: "idle", labels: LABELS("req-20261003T090000Z", "mgr-bound") },
  ];

  it("the facts every reader shares: trace linking, soleWorkerOfRequest, the materialiser's asker and the format-check sender", async () => {
    const home = dataFolder();
    bind(home, "mgr-bound");
    const listed = await bmAgentsOf(paseoWith(agents) as never, { home });
    expect(Object.fromEntries(listed.map(({ facts }) => [facts.id, facts.requestIdLabel]))).toEqual({ "wrk-hand": "req-20261003T080000Z", "wrk-bound": null });
    expect(await soleWorkerOfRequest({ workspaceId: WS, requestId: "req-20261003T080000Z", home }, paseoWith(agents) as never)).toBe("wrk-hand");
    expect(await soleWorkerOfRequest({ workspaceId: WS, requestId: "req-20261003T090000Z", home }, paseoWith(agents) as never)).toBeNull();
  });

  it("the Orchestrator's tool scope", async () => {
    const home = dataFolder();
    bind(home, "mgr-bound");
    process.env["PASEO_BM_HOME"] = home;
    try {
      const working = await workingAgents(paseoWith(agents) as never);
      expect(Object.fromEntries(working.map((agent) => [agent.id, agent.requestIdLabel]))).toEqual({ "wrk-hand": "req-20261003T080000Z", "wrk-bound": null });
    } finally {
      delete process.env["PASEO_BM_HOME"];
    }
  });

  it("no server module reads the label but through it, except where it only compares or writes", () => {
    const dir = fileURLToPath(new URL("../plugin/server", import.meta.url));
    const direct = /labels\??\.?\[\s*["']bm\.requestId["']\s*\]|labels\[REQUEST_ID_LABEL\]|labels\?\.\[REQUEST_ID_LABEL\]/;
    const readers = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith("-instructions.ts"))
      .filter((name) => direct.test(readFileSync(join(dir, name), "utf8")))
      .sort();
    // The registry itself; the collector's raw read, handed to knownRequestIdOf in the same function;
    // a replacement Reviewer's and a handoff successor's match against what the plugin recorded;
    // a late-settled creation's match against the pending binding the plugin issued (creation-settle.ts).
    expect(readers).toEqual(["collector.ts", "creation-settle.ts", "fallback-reviewer.ts", "handoff.ts", "request-registry.ts"]);
    for (const site of ["paseo-directory.ts", "orchestrator-tool-context.ts", "fallback-state.ts", "action-boundary.ts", "collector.ts"]) {
      expect(readFileSync(join(dir, site), "utf8"), site).toContain("knownRequestIdOf(");
    }
    for (const site of ["decision-delivery.ts", "decision-materialiser.ts", "format-check.ts", "traces.ts"]) {
      expect(readFileSync(join(dir, site), "utf8"), site).not.toMatch(direct);
    }
  });
});

describe("cleanup (design §16.4, §7.13.7)", () => {
  it("setup.cleanup deletes requests/ with the data", () => {
    expect(CLEANUP_DELETES).toContain(REQUESTS_DIR_NAME);
    expect(REQUESTS_DIR_NAME).toBe("requests");
  });
});
