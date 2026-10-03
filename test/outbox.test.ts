import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTBOX_DIR_NAME,
  OUTBOX_SETTLED_LIMIT,
  OUTBOX_SETTLED_MS,
  capOutbox,
  createOutbox,
  createOutboxResend,
  deliverRecord,
  deliveryTextOf,
  newestReportRecordOf,
  storeAndDeliver,
  type OutboxRecord,
} from "../plugin/server/outbox";
import { createNoticeQueue, type NoticePaseo } from "../plugin/server/notice-queue";
import { createAlertStore } from "../plugin/server/alert-store";
import {
  MAX_REQUESTS_PER_WORKSPACE,
  clearRequestRegistryCache,
  createRequestRegistry,
  type RegisteredRequest,
} from "../plugin/server/request-registry";
import { REDACTED } from "../plugin/server/collector";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { NO_VERDICT_SENTENCE, OUTBOX_RECORD_ID_PATTERN, isPluginNotice, parseDelivery } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";

/**
 * The outbox (design §16.7, ADR-027 decision 4): every record is written
 * before it is delivered, goes through the notice queue under a kind of its
 * own, and keeps its outcome; a reload sends the open ones again. A fake
 * Paseo (scripted snapshots, a log of sends; a send starts a turn) and
 * temporary data folders only.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const T0 = new Date("2026-10-03T10:00:00.000Z");
const roots: string[] = [];

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-outbox-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

afterEach(() => {
  clearRequestRegistryCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Agent = { status: string; archivedAt?: string | null };

function world(initial: Record<string, Agent>) {
  const agents = new Map(Object.entries(initial).map(([id, agent]) => [id, { ...agent }]));
  const sends: Array<{ id: string; text: string }> = [];
  const paseo: NoticePaseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.get(id);
          return agent === undefined ? null : { agent: { ...agent } };
        },
        send: async (text: string) => {
          sends.push({ id, text });
          agents.set(id, { ...agents.get(id)!, status: "running" });
        },
      }),
    },
  };
  const set = (id: string, change: Partial<Agent>) => agents.set(id, { ...agents.get(id)!, ...change });
  const remove = (id: string) => agents.delete(id);
  const queue = createNoticeQueue({ log: () => {} });
  const turnEnded = (id: string) =>
    queue.turnEnded({ agent: { id, workspaceId: WS, parentAgentId: null, provider: "bm-manager", cwd: "/repo", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }, paseo);
  return { paseo, sends, set, remove, queue, turnEnded };
}

const REPORT = `BM-REPORT\nrequestId: ${REQ}\nphase: finished\ntier: Small (changed: no)\nblockers: none`;

function deps(home: string, w: ReturnType<typeof world>, logs: string[] = [], clock = () => T0) {
  let n = 0;
  return {
    home,
    queue: w.queue,
    paseo: w.paseo,
    now: clock,
    newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}`,
    log: (message: string) => logs.push(message),
  };
}

describe("the store", () => {
  it("writes a record pending first, 0600 in a 0700 folder, with its text masked", () => {
    const home = dataFolder();
    const outbox = createOutbox(home, { now: () => T0, env: { PASEO_PASSWORD: "hunter2" } as NodeJS.ProcessEnv });
    const record = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: `${REPORT}\nnote: hunter2` });
    expect(record).toMatchObject({ kind: "report", requestId: REQ, batchId: null, from: "wrk-1", to: "mgr-1", createdAt: T0.toISOString(), state: "pending", outcomeAt: null, reason: null });
    expect(record.id).toMatch(OUTBOX_RECORD_ID_PATTERN);
    expect(record.text).toContain(`note: ${REDACTED}`);
    const path = join(home, OUTBOX_DIR_NAME, `${WS}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, OUTBOX_DIR_NAME)).mode & 0o777).toBe(0o700);
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["schemaVersion", "records"]);
    expect(body["schemaVersion"]).toBe(1);
    expect(readFileSync(path, "utf8")).not.toContain("hunter2");
  });

  it("moves a state only forward, and never changes a settled record", () => {
    const home = dataFolder();
    const outbox = createOutbox(home, { now: () => T0 });
    const { id } = outbox.add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Continue." });
    expect(outbox.settle(WS, id, "delivered")?.changed).toBe(true);
    expect(outbox.settle(WS, id, "queued")).toMatchObject({ changed: false, record: { state: "delivered" } });
    expect(outbox.settle(WS, id, "dropped", "gone")).toMatchObject({ changed: false, record: { state: "delivered", reason: null } });
    expect(outbox.settle(WS, "out-ffffffffffff", "delivered")).toBeNull();
  });

  it("reads a newer schemaVersion as empty and never writes it", () => {
    const home = dataFolder();
    mkdirSync(join(home, OUTBOX_DIR_NAME), { mode: 0o700 });
    const path = join(home, OUTBOX_DIR_NAME, `${WS}.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, records: [] }), { mode: 0o600 });
    const outbox = createOutbox(home);
    expect(outbox.list(WS)).toEqual([]);
    expect(() => outbox.add(WS, { kind: "message", requestId: REQ, from: "a", to: "b", text: "x" })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(2);
  });

  it("keeps every open record, and of the settled ones at most 500 for 7 days, the newest", () => {
    const record = (index: number, state: OutboxRecord["state"], outcomeAt: string | null): OutboxRecord => ({
      id: `out-${index.toString(16).padStart(12, "0")}`,
      kind: "report",
      requestId: REQ,
      batchId: null,
      from: "w",
      to: "m",
      text: "x",
      createdAt: "2026-09-01T00:00:00.000Z",
      state,
      outcomeAt,
      reason: null,
    });
    const old = new Date(T0.getTime() - OUTBOX_SETTLED_MS - 1).toISOString();
    const records = [
      record(1, "pending", null),
      record(2, "queued", null),
      record(3, "delivered", old),
      ...Array.from({ length: OUTBOX_SETTLED_LIMIT + 2 }, (_, index) => record(10 + index, "delivered", new Date(T0.getTime() - (OUTBOX_SETTLED_LIMIT + 2 - index) * 1000).toISOString())),
    ];
    const kept = capOutbox(records, T0);
    expect(kept.slice(0, 2).map((entry) => entry.state)).toEqual(["pending", "queued"]);
    expect(kept.some((entry) => entry.id === records[2]!.id)).toBe(false);
    expect(kept.filter((entry) => entry.state === "delivered")).toHaveLength(OUTBOX_SETTLED_LIMIT);
    // The two oldest settled ones went.
    expect(kept.some((entry) => entry.id === records[3]!.id || entry.id === records[4]!.id)).toBe(false);
  });

  it("is deleted by setup.cleanup", () => {
    expect(CLEANUP_DELETES).toContain(OUTBOX_DIR_NAME);
  });
});

describe("delivery", () => {
  it("sends to an idle target with the BM-DELIVERY marker line, and marks the record delivered", async () => {
    const home = dataFolder();
    const w = world({ "mgr-1": { status: "idle" } });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, deps(home, w));
    expect(outcome).toBe("sent");
    expect(record.state).toBe("delivered");
    expect(w.sends).toEqual([{ id: "mgr-1", text: `BM-DELIVERY report ${record.id}\n${REPORT}` }]);
    expect(w.sends[0]!.text).toBe(deliveryTextOf(record));
    // The plugin's, never the owner's — though Paseo stores a clientMessageId on it.
    expect(isPluginNotice(w.sends[0]!.text)).toBe(true);
    expect(originOf({ text: w.sends[0]!.text, clientMessageId: "sdk-1" })).toBe("plugin-notice");
    expect(parseDelivery(w.sends[0]!.text)).toEqual({ kind: "report", recordId: record.id, body: REPORT });
  });

  it("holds a record for a running target as queued; the queue's onSent marks it delivered at the target's idle moment", async () => {
    const home = dataFolder();
    const w = world({ "wrk-1": { status: "running" } });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Continue." }, deps(home, w));
    expect(outcome).toBe("queued");
    expect(createOutbox(home).get(WS, record.id)?.state).toBe("queued");
    w.set("wrk-1", { status: "idle" });
    await w.turnEnded("wrk-1");
    expect(w.sends).toHaveLength(1);
    expect(createOutbox(home).get(WS, record.id)).toMatchObject({ state: "delivered", outcomeAt: T0.toISOString() });
  });

  it("never lets a newer record replace an older one: both go, in creation order, one per idle moment", async () => {
    const home = dataFolder();
    const w = world({ "mgr-1": { status: "running" } });
    const d = deps(home, w);
    const first = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: `${REPORT}\nfirst` }, d);
    const second = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: `${REPORT}\nsecond` }, d);
    expect([first.outcome, second.outcome]).toEqual(["queued", "queued"]);
    expect(w.queue.pending("mgr-1").map((notice) => notice.kind)).toEqual([`report:${first.record.id}`, `report:${second.record.id}`]);
    w.set("mgr-1", { status: "idle" });
    await w.turnEnded("mgr-1");
    w.set("mgr-1", { status: "idle" });
    await w.turnEnded("mgr-1");
    expect(w.sends.map((send) => parseDelivery(send.text)?.recordId)).toEqual([first.record.id, second.record.id]);
    expect(createOutbox(home).list(WS).map((record) => record.state)).toEqual(["delivered", "delivered"]);
  });

  it("drops a record whose target is gone, with its reason, one log line and the delivery-dropped Inbox alert naming the request", async () => {
    const home = dataFolder();
    const w = world({});
    const logs: string[] = [];
    const { record, outcome } = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-gone", text: REPORT }, deps(home, w, logs));
    expect(outcome).toBe("dropped");
    expect(record).toMatchObject({ state: "dropped", reason: "the target is archived, closed or gone", outcomeAt: T0.toISOString() });
    expect(logs.filter((line) => line.includes(record.id))).toHaveLength(1);
    const alerts = createAlertStore(home).list({ open: true });
    expect(alerts).toMatchObject([{ kind: "delivery-dropped", workspaceId: WS, subject: REQ, key: `delivery-dropped:${WS}:${REQ}` }]);
    expect(alerts[0]!.detail).toContain(record.id);
  });

  it("drops a queued record when its target is archived by its turn end", async () => {
    const home = dataFolder();
    const w = world({ "wrk-1": { status: "running" } });
    const { record } = await storeAndDeliver(
      WS,
      { kind: "no-verdict", requestId: REQ, batchId: "b1", from: "rev-1", to: "wrk-1", text: `requestId: ${REQ}\nbatchId: b1\nreviewer: rev-1\n${NO_VERDICT_SENTENCE}` },
      deps(home, w),
    );
    w.set("wrk-1", { status: "idle", archivedAt: "2026-10-03T10:01:00.000Z" });
    await w.turnEnded("wrk-1");
    expect(w.sends).toEqual([]);
    expect(createOutbox(home).get(WS, record.id)).toMatchObject({ state: "dropped", reason: "the target is archived, closed or gone" });
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.kind)).toEqual(["delivery-dropped"]);
  });

  it("sends nothing when the record cannot be written", async () => {
    const home = dataFolder();
    mkdirSync(join(home, OUTBOX_DIR_NAME), { mode: 0o700 });
    writeFileSync(join(home, OUTBOX_DIR_NAME, `${WS}.json`), "not json", { mode: 0o600 });
    const w = world({ "mgr-1": { status: "idle" } });
    await expect(storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, deps(home, w))).rejects.toThrow();
    expect(w.sends).toEqual([]);
  });
});

describe("after a reload", () => {
  it("enqueues every pending and queued record again at the first handle, once per run; delivered and dropped ones stay", async () => {
    const home = dataFolder();
    const before = world({ "mgr-1": { status: "running" } });
    const d = deps(home, before);
    const queued = (await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, d)).record;
    const pending = createOutbox(home, d).add("wks_2", { kind: "review", requestId: REQ, batchId: "b1", from: "rev-1", to: "wrk-2", text: "BM-REVIEW\nverdict: pass" });
    const done = createOutbox(home, d).add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Done." });
    createOutbox(home).settle(WS, done.id, "delivered");
    expect(queued.state).toBe("queued");

    // The reload: the queue forgot what it held; the outbox did not.
    before.queue.clear();
    const after = world({ "mgr-1": { status: "idle" }, "wrk-2": { status: "idle" } });
    const resend = createOutboxResend({ home: () => home, queue: after.queue, log: () => {} });
    await resend.run(after.paseo);
    expect(after.sends.map((send) => parseDelivery(send.text)?.recordId).sort()).toEqual([queued.id, pending.id].sort());
    expect(createOutbox(home).get(WS, queued.id)?.state).toBe("delivered");
    expect(createOutbox(home).get("wks_2", pending.id)?.state).toBe("delivered");

    await resend.run(after.paseo);
    expect(after.sends).toHaveLength(2);
  });

  it("waits for a handle: a call without one does nothing", async () => {
    const home = dataFolder();
    const w = world({ "mgr-1": { status: "idle" } });
    createOutbox(home).add(WS, { kind: "message", requestId: REQ, from: "a", to: "mgr-1", text: "x" });
    const resend = createOutboxResend({ home: () => home, queue: w.queue, log: () => {} });
    await resend.run(undefined);
    expect(w.sends).toEqual([]);
    await resend.run(w.paseo);
    expect(w.sends).toHaveLength(1);
  });

  it("a repeated delivery of one record is the same record: deliverRecord twice keeps one state", async () => {
    const home = dataFolder();
    const w = world({ "mgr-1": { status: "idle" } });
    const record = createOutbox(home).add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT });
    expect(await deliverRecord(WS, record, deps(home, w))).toBe("sent");
    w.set("mgr-1", { status: "idle" });
    expect(await deliverRecord(WS, record, deps(home, w))).toBe("sent");
    expect(createOutbox(home).list(WS)).toHaveLength(1);
    expect(createOutbox(home).get(WS, record.id)?.state).toBe("delivered");
  });
});

describe("readers", () => {
  it("finds a bound agent's newest report among its pending and delivered records", () => {
    const home = dataFolder();
    let clock = T0;
    const outbox = createOutbox(home, { now: () => clock });
    outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "old" });
    clock = new Date(T0.getTime() + 60_000);
    const newest = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "new" });
    clock = new Date(T0.getTime() + 120_000);
    const queued = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "queued" });
    outbox.settle(WS, queued.id, "queued");
    outbox.add(WS, { kind: "message", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "msg" });
    expect(newestReportRecordOf(home, WS, "wrk-1")?.id).toBe(newest.id);
    expect(newestReportRecordOf(home, WS, "wrk-1", new Date(T0.getTime() + 90_000).toISOString())).toBeNull();
    expect(newestReportRecordOf(home, WS, "wrk-2")).toBeNull();
  });
});

describe("the request registry's bound (design §16.4)", () => {
  it("never drops a request with a pending or queued outbox record when trimming to 2,000", () => {
    const home = dataFolder();
    const id = (index: number) => `req-20250101T${String(Math.floor(index / 3600)).padStart(2, "0")}${String(Math.floor(index / 60) % 60).padStart(2, "0")}${String(index % 60).padStart(2, "0")}Z`;
    const entry = (index: number): RegisteredRequest => ({
      requestId: id(index),
      workspaceId: WS,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      source: "backfill",
      managerId: null,
      workerIds: [],
      tier: null,
      finishedAt: "2025-02-01T00:00:00.000Z",
      reviews: { batches: [], grants: [] },
    });
    const outbox = createOutbox(home, { now: () => T0 });
    outbox.add(WS, { kind: "report", requestId: id(0), from: "w", to: "m", text: "pending" });
    const queued = outbox.add(WS, { kind: "report", requestId: id(1), from: "w", to: "m", text: "queued" });
    outbox.settle(WS, queued.id, "queued");
    const delivered = outbox.add(WS, { kind: "report", requestId: id(2), from: "w", to: "m", text: "delivered" });
    outbox.settle(WS, delivered.id, "delivered");

    const registry = createRequestRegistry(home, { now: () => T0, backfill: () => Array.from({ length: MAX_REQUESTS_PER_WORKSPACE }, (_, index) => entry(index)) });
    registry.generate(WS, { managerId: "mgr-1" });
    const kept = registry.list(WS).map((request) => request.requestId);
    expect(kept).toHaveLength(MAX_REQUESTS_PER_WORKSPACE);
    expect(kept).toContain(id(0));
    expect(kept).toContain(id(1));
    // The oldest finished request without an open record went instead.
    expect(kept).not.toContain(id(2));
    expect(existsSync(join(home, "requests", `${WS}.json`))).toBe(true);
  });
});
