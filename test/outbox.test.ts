import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTBOX_DIR_NAME,
  OUTBOX_SETTLED_LIMIT,
  OUTBOX_SETTLED_MS,
  PEER_RETARGETS,
  capOutbox,
  clearDroppedAlert,
  createOutbox,
  createOutboxResend,
  deliverRecord,
  deliveryTextOf,
  dropsCovered,
  mainTargetOf,
  newestReportRecordOf,
  reportPhaseOf,
  storeAndDeliver,
  usePeerTargets,
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
import { createMissionStore } from "../plugin/server/mission-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { NO_VERDICT_SENTENCE, OUTBOX_RECORD_ID_PATTERN, isPluginNotice, parseDelivery } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

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

afterEach(() => {
  clearRequestRegistryCache();
  removeDataFolders();
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

/** A record as the outbox holds it now. */
const stored = (home: string, id: string, workspaceId = WS) => createOutbox(home).list(workspaceId).find((record) => record.id === id);

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

  it("settles a pending record once, and never changes a settled record", () => {
    const home = dataFolder();
    const outbox = createOutbox(home, { now: () => T0 });
    const { id } = outbox.add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Continue." });
    expect(outbox.settle(WS, id, "delivered")?.changed).toBe(true);
    expect(outbox.settle(WS, id, "dropped", "gone")).toMatchObject({ changed: false, record: { state: "delivered", reason: null } });
    expect(outbox.settle(WS, "out-ffffffffffff", "delivered")).toBeNull();
  });

  it("stores a withheld record settled at once, with its reason; nothing settles it again and a reload never sends it", async () => {
    const home = dataFolder();
    const outbox = createOutbox(home, { now: () => T0 });
    const record = outbox.add(WS, { kind: "no-verdict", requestId: REQ, batchId: "b1", from: "rev-1", to: "wrk-1", text: "no verdict" }, "the turn was canceled");
    expect(record).toMatchObject({ state: "withheld", outcomeAt: T0.toISOString(), reason: "the turn was canceled" });
    expect(outbox.settle(WS, record.id, "delivered")).toMatchObject({ changed: false, record: { state: "withheld" } });
    const w = world({ "wrk-1": { status: "idle" } });
    await createOutboxResend({ home: () => home, queue: w.queue, log: () => {} }).run(w.paseo);
    expect(w.sends).toEqual([]);
    // No drop: it never holds a delivery-dropped alert open.
    expect(dropsCovered(createOutbox(home).list(WS), REQ)).toBe(true);
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
      record(2, "pending", null),
      record(3, "delivered", old),
      ...Array.from({ length: OUTBOX_SETTLED_LIMIT + 2 }, (_, index) => record(10 + index, "delivered", new Date(T0.getTime() - (OUTBOX_SETTLED_LIMIT + 2 - index) * 1000).toISOString())),
    ];
    const kept = capOutbox(records, T0);
    expect(kept.slice(0, 2).map((entry) => entry.state)).toEqual(["pending", "pending"]);
    expect(kept.some((entry) => entry.id === records[2]!.id)).toBe(false);
    expect(kept.filter((entry) => entry.state === "delivered")).toHaveLength(OUTBOX_SETTLED_LIMIT);
    // The two oldest settled ones went.
    expect(kept.some((entry) => entry.id === records[3]!.id || entry.id === records[4]!.id)).toBe(false);
  });

  it("skips a record of a kind it does not know, as an older build skips the peer kinds, and keeps the rest (design §7.17.4)", () => {
    const home = dataFolder();
    mkdirSync(join(home, OUTBOX_DIR_NAME), { mode: 0o700 });
    const known = { id: "out-000000000001", kind: "report", requestId: REQ, batchId: null, from: "w", to: "m", text: "x", createdAt: T0.toISOString(), state: "pending", outcomeAt: null, reason: null };
    const future = { ...known, id: "out-000000000002", kind: "peer-future" };
    writeFileSync(join(home, OUTBOX_DIR_NAME, `${WS}.json`), JSON.stringify({ schemaVersion: 1, records: [known, future] }), { mode: 0o600 });
    const outbox = createOutbox(home);
    expect(outbox.list(WS).map((record) => record.id)).toEqual([known.id]);
    expect(() => outbox.add(WS, { kind: "message", requestId: REQ, from: "a", to: "b", text: "x" })).not.toThrow();
  });

  it("takes a link id as a peer record's requestId, and writes a new target only on a pending record", () => {
    const home = dataFolder();
    const outbox = createOutbox(home, { now: () => T0 });
    const record = outbox.add(WS, { kind: "peer-message", requestId: "peer-0123456789ab", from: "mgr-b", to: "wrk-a", text: "link: peer-0123456789ab\n> hi" });
    expect(record).toMatchObject({ kind: "peer-message", requestId: "peer-0123456789ab", state: "pending" });
    expect(outbox.retarget(WS, record.id, "wrk-a2")).toMatchObject({ id: record.id, to: "wrk-a2" });
    expect(stored(home, record.id)?.to).toBe("wrk-a2");
    outbox.settle(WS, record.id, "delivered");
    expect(outbox.retarget(WS, record.id, "wrk-a3")?.to).toBe("wrk-a2");
    expect(outbox.retarget(WS, "out-ffffffffffff", "x")).toBeNull();
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
    expect(stored(home, record.id)?.state).toBe("delivered");
    expect(w.sends).toEqual([{ id: "mgr-1", text: `BM-DELIVERY report ${record.id}\n${REPORT}` }]);
    expect(w.sends[0]!.text).toBe(deliveryTextOf(record));
    // The plugin's, never the owner's — though Paseo stores a clientMessageId on it.
    expect(isPluginNotice(w.sends[0]!.text)).toBe(true);
    expect(originOf({ text: w.sends[0]!.text, clientMessageId: "sdk-1" })).toBe("plugin-notice");
    expect(parseDelivery(w.sends[0]!.text)).toEqual({ kind: "report", recordId: record.id, body: REPORT });
  });

  it("keeps a record for a running target pending while the queue holds it; the queue's onSent marks it delivered at the target's idle moment", async () => {
    const home = dataFolder();
    const w = world({ "wrk-1": { status: "running" } });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Continue." }, deps(home, w));
    expect(outcome).toBe("queued");
    expect(stored(home, record.id)?.state).toBe("pending");
    w.set("wrk-1", { status: "idle" });
    await w.turnEnded("wrk-1");
    expect(w.sends).toHaveLength(1);
    expect(stored(home, record.id)).toMatchObject({ state: "delivered", outcomeAt: T0.toISOString() });
  });

  it("runs the step before delivery once the record is stored; a throw there is one log line and the record still goes", async () => {
    const home = dataFolder();
    const w = world({ "mgr-1": { status: "idle" } });
    const logs: string[] = [];
    const seen: string[] = [];
    const { record } = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, deps(home, w, logs), (made) => {
      seen.push(stored(home, made.id)?.state ?? "missing");
      throw new Error("registry unwritable");
    });
    expect(seen).toEqual(["pending"]);
    expect(logs).toEqual([`[paseo-bm] after storing the report ${record.id}: registry unwritable`]);
    expect(stored(home, record.id)?.state).toBe("delivered");
  });

  it("an input the queue refuses is dropped at once, without a callback", async () => {
    const home = dataFolder();
    const w = world({});
    const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT });
    expect(await deliverRecord(WS, record, { ...deps(home, w), queue: { enqueue: async () => "dropped" } })).toBe("dropped");
    expect(stored(home, record.id)).toMatchObject({ state: "dropped", reason: "the notice queue refused it" });
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
    expect(stored(home, record.id)).toMatchObject({ state: "dropped", reason: "the target is archived, closed or gone", outcomeAt: T0.toISOString() });
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
    expect(stored(home, record.id)).toMatchObject({ state: "dropped", reason: "the target is archived, closed or gone" });
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.kind)).toEqual(["delivery-dropped"]);
  });

  it("clears the request's delivery-dropped alert only when a later record with the dropped one's target and kind is delivered (K4)", async () => {
    const home = dataFolder();
    let clock = T0;
    const w = world({ "mgr-1": { status: "running" }, "wrk-1": { status: "idle" } });
    const d = { ...deps(home, w, [], () => clock) };
    // An earlier report, still waiting in the queue, then a report the queue drops (its send fails).
    const earlier = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, d);
    expect(earlier.outcome).toBe("queued");
    clock = new Date(T0.getTime() + 60_000);
    const failing = { enqueue: async (_to: string, kind: string, _text: string, _paseo: unknown, callbacks?: { onDropped?: (to: string, kind: string, reason: string) => void }) => {
      callbacks?.onDropped?.("mgr-1", kind, "the send failed: socket closed");
      return "dropped" as const;
    } };
    const lost = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: `${REPORT}\nlost` }, { ...d, queue: failing });
    expect(stored(home, lost.record.id)).toMatchObject({ state: "dropped", reason: "the send failed: socket closed" });
    const open = () => createAlertStore(home).list({ open: true }).map((alert) => `${alert.kind}:${alert.subject}`);
    expect(open()).toEqual([`delivery-dropped:${REQ}`]);
    // The earlier report reaches the Manager after the drop: it was created before it, so the alert stays.
    clock = new Date(T0.getTime() + 120_000);
    w.set("mgr-1", { status: "idle" });
    await w.turnEnded("mgr-1");
    expect(stored(home, earlier.record.id)?.state).toBe("delivered");
    expect(open()).toEqual([`delivery-dropped:${REQ}`]);
    // A message to the Worker, of this request or another, never clears a report lost on its way to the Manager.
    await storeAndDeliver(WS, { kind: "message", requestId: "req-20261003T110000Z", from: "mgr-1", to: "wrk-1", text: "Go on." }, d);
    w.set("wrk-1", { status: "idle" });
    await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Go on." }, d);
    expect(open()).toEqual([`delivery-dropped:${REQ}`]);
    // A later report of the request delivered to the same Manager clears it.
    w.set("mgr-1", { status: "idle" });
    await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, d);
    expect(open()).toEqual([]);
  });

  it("dropsCovered: every drop of the request needs a delivered record with its target and kind, created at or after the drop", () => {
    const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();
    const base = { kind: "report" as const, requestId: REQ, batchId: null, from: "wrk-1", to: "mgr-1", text: "x", reason: null };
    const drop: OutboxRecord = { ...base, id: "out-000000000001", createdAt: at(0), state: "dropped", outcomeAt: at(1), reason: "gone" };
    const delivered = (id: string, minutes: number, over: Partial<OutboxRecord> = {}): OutboxRecord => ({ ...base, id, createdAt: at(minutes), state: "delivered", outcomeAt: at(minutes), ...over });
    expect(dropsCovered([drop], REQ)).toBe(false);
    expect(dropsCovered([drop, delivered("out-000000000002", 0)], REQ)).toBe(false);
    expect(dropsCovered([drop, delivered("out-000000000003", 2, { kind: "message" })], REQ)).toBe(false);
    expect(dropsCovered([drop, delivered("out-000000000004", 2, { to: "wrk-1" })], REQ)).toBe(false);
    expect(dropsCovered([drop, delivered("out-000000000005", 2, { requestId: "req-20261003T110000Z" })], REQ)).toBe(false);
    expect(dropsCovered([drop, delivered("out-000000000006", 2)], REQ)).toBe(true);
    expect(dropsCovered([drop], "req-20261003T110000Z")).toBe(true);
  });

  it("clearDroppedAlert clears the request's alert outright when its request finished or stopped", () => {
    const home = dataFolder();
    createAlertStore(home).raise({ workspaceId: WS, kind: "delivery-dropped", subject: REQ, detail: "x" });
    expect(clearDroppedAlert(home, WS, REQ, null)).toEqual([`delivery-dropped:${WS}:${REQ}`]);
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
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

describe("peer records the queue drops (design §7.17.4)", () => {
  const LINK_TEXT = "link: peer-0123456789ab\nfrom: project \"back\" (wks_b), request req-20261003T100000Z, phase: finished\n> Done.";
  /** A scripted resolver: the targets it gives in turn (the last repeats), and how often it was asked. */
  const resolver = (...targets: Array<string | null | undefined>) => {
    const asked: string[] = [];
    const delivered: OutboxRecord[] = [];
    usePeerTargets(
      async (_workspaceId, record) => {
        asked.push(record.to);
        return targets.length > 1 ? targets.shift() : targets[0];
      },
      (_workspaceId, record) => void delivered.push(record),
    );
    return { asked, delivered };
  };

  afterEach(() => usePeerTargets(async () => undefined));

  it("a record dropped while queued for a replaced asker is resolved again and goes to the successor; the delivered hook sees it", async () => {
    const home = dataFolder();
    const w = world({ "wrk-a": { status: "running" }, "wrk-a2": { status: "idle" } });
    const peers = resolver("wrk-a", "wrk-a2");
    const { record, outcome } = await storeAndDeliver(WS, { kind: "peer-reply", requestId: REQ, from: "wrk-b", to: "wrk-a", text: LINK_TEXT }, deps(home, w));
    expect(outcome).toBe("queued");
    // The asker is archived (handed off) while the reply waits in the queue.
    w.set("wrk-a", { status: "idle", archivedAt: "2026-10-03T10:01:00.000Z" });
    await w.turnEnded("wrk-a");
    await vi.waitFor(() => expect(stored(home, record.id)?.state).toBe("delivered"));
    expect(stored(home, record.id)?.to).toBe("wrk-a2");
    expect(w.sends).toEqual([{ id: "wrk-a2", text: `BM-DELIVERY peer-reply ${record.id}\n${LINK_TEXT}` }]);
    expect(peers.asked).toEqual(["wrk-a", "wrk-a"]);
    expect(peers.delivered).toMatchObject([{ id: record.id, to: "wrk-a2", state: "delivered" }]);
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("resolves again at most PEER_RETARGETS times per delivery, then drops it with the queue's reason", async () => {
    const home = dataFolder();
    const w = world({});
    const peers = resolver("wrk-1", "wrk-2", "wrk-3", "wrk-4");
    const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "peer-message", requestId: REQ, from: "mgr-b", to: "wrk-0", text: LINK_TEXT });
    expect(await deliverRecord(WS, record, deps(home, w))).toBe("dropped");
    expect(peers.asked).toHaveLength(1 + PEER_RETARGETS);
    expect(stored(home, record.id)).toMatchObject({ to: "wrk-3", state: "dropped", reason: "the target is archived, closed or gone" });
    expect(peers.delivered).toEqual([]);
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.kind)).toEqual(["delivery-dropped"]);
  });

  it("drops it at once when the side resolves to the same agent or to none, and never resolves a report again", async () => {
    const home = dataFolder();
    const w = world({});
    const same = resolver("wrk-a");
    const first = createOutbox(home, { now: () => T0 }).add(WS, { kind: "peer-reply", requestId: REQ, from: "wrk-b", to: "wrk-a", text: LINK_TEXT });
    expect(await deliverRecord(WS, first, deps(home, w))).toBe("dropped");
    expect(same.asked).toEqual(["wrk-a", "wrk-a"]);
    expect(stored(home, first.id)).toMatchObject({ to: "wrk-a", state: "dropped", reason: "the target is archived, closed or gone" });

    const none = resolver("wrk-a", null);
    const second = createOutbox(home, { now: () => T0 }).add(WS, { kind: "peer-reply", requestId: REQ, from: "wrk-b", to: "wrk-a", text: LINK_TEXT });
    expect(await deliverRecord(WS, second, deps(home, w))).toBe("dropped");
    expect(none.asked).toHaveLength(2);
    expect(stored(home, second.id)).toMatchObject({ state: "dropped", reason: "the target is archived, closed or gone" });

    const report = resolver("mgr-2");
    const third = createOutbox(home, { now: () => T0 }).add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-gone", text: REPORT });
    expect(await deliverRecord(WS, third, deps(home, w))).toBe("dropped");
    expect(report.asked).toEqual([]);
    expect(report.delivered).toEqual([]);
  });
});

describe("after a reload", () => {
  it("enqueues every pending record again at the first handle, once per run, one the queue held included; settled ones stay", async () => {
    const home = dataFolder();
    const before = world({ "mgr-1": { status: "running" } });
    const d = deps(home, before);
    const queued = (await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, d)).record;
    const withheld = createOutbox(home, d).add(WS, { kind: "no-verdict", requestId: REQ, batchId: "b1", from: "rev-1", to: "wrk-1", text: "no verdict" }, "canceled");
    const pending = createOutbox(home, d).add("wks_2", { kind: "review", requestId: REQ, batchId: "b1", from: "rev-1", to: "wrk-2", text: "BM-REVIEW\nverdict: pass" });
    const done = createOutbox(home, d).add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Done." });
    createOutbox(home).settle(WS, done.id, "delivered");
    expect(stored(home, queued.id)?.state).toBe("pending");

    // The reload: the queue forgot what it held; the outbox did not.
    before.queue.clear();
    const after = world({ "mgr-1": { status: "idle" }, "wrk-2": { status: "idle" } });
    const resend = createOutboxResend({ home: () => home, queue: after.queue, log: () => {} });
    await resend.run(after.paseo);
    expect(after.sends.map((send) => parseDelivery(send.text)?.recordId).sort()).toEqual([queued.id, pending.id].sort());
    expect(stored(home, queued.id)?.state).toBe("delivered");
    expect(stored(home, pending.id, "wks_2")?.state).toBe("delivered");
    expect(stored(home, withheld.id)?.state).toBe("withheld");

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
    expect(stored(home, record.id)?.state).toBe("delivered");
  });
});

describe("readers", () => {
  it("finds a bound agent's newest report among its pending and delivered records, one the queue holds included (K5)", async () => {
    const home = dataFolder();
    let clock = T0;
    const outbox = createOutbox(home, { now: () => clock });
    const old = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "old" });
    outbox.settle(WS, old.id, "delivered");
    clock = new Date(T0.getTime() + 60_000);
    // Held by the queue while the Manager runs: still pending.
    const w = world({ "mgr-1": { status: "running" } });
    const held = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "held" }, { ...deps(home, w, [], () => clock), newId: () => "out-0000000000b1" });
    expect(held.outcome).toBe("queued");
    clock = new Date(T0.getTime() + 120_000);
    const lost = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "lost" });
    outbox.settle(WS, lost.id, "dropped", "gone");
    outbox.add(WS, { kind: "message", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "msg" });
    expect(newestReportRecordOf(home, WS, "wrk-1")?.id).toBe(held.record.id);
    expect(newestReportRecordOf(home, WS, "wrk-1", new Date(T0.getTime() + 90_000).toISOString())).toBeNull();
    expect(newestReportRecordOf(home, WS, "wrk-2")).toBeNull();
  });

  it("newest is by createdAt, a tie broken by the phase's rank, not by the file's order (missions acceptance 2026-10-09)", () => {
    const home = dataFolder();
    let clock = T0;
    const outbox = createOutbox(home, { now: () => clock });
    const block = (phase: string) => ["BM-REPORT", `requestId: ${REQ}`, `phase: ${phase}`, "tier: Small"].join("\n");
    // Two reports in one second: finished written first, received after it in the file.
    const finished = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: block("finished") });
    outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: block("received") });
    expect(newestReportRecordOf(home, WS, "wrk-1")?.id).toBe(finished.id);
    expect(reportPhaseOf(newestReportRecordOf(home, WS, "wrk-1")!.text)).toBe("finished");
    // blocked outranks beads-done, which outranks received; stopped ranks with finished.
    outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-2", to: "mgr-1", text: block("beads-done") });
    const blocked = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-2", to: "mgr-1", text: block("blocked") });
    outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-2", to: "mgr-1", text: block("received") });
    expect(newestReportRecordOf(home, WS, "wrk-2")?.id).toBe(blocked.id);
    // A later report wins whatever its phase: a follow-up reopened the work.
    clock = new Date(T0.getTime() + 1_000);
    const later = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: block("received") });
    expect(newestReportRecordOf(home, WS, "wrk-1")?.id).toBe(later.id);
    expect(reportPhaseOf("no phase here")).toBeNull();
  });
});

describe("records addressed to a Main (missions design §3.4)", () => {
  it("a record tellMain stored under an m: card or the mission id goes to the mission's current Main", () => {
    const home = dataFolder();
    const missions = createMissionStore(home, { now: () => T0, newId: () => "mis-00000000a1" });
    const created = missions.create({ code: "WEB", name: "Website", goal: "", repos: [WS], createdBy: "owner", mainId: "main-old" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    missions.setMain("mis-00000000a1", "main-new", "replaced");
    expect(mainTargetOf(home, "wks_home", { requestId: "m:mis-00000000a1:3", to: "main-old" })).toEqual({ to: "main-new", hold: true });
    expect(mainTargetOf(home, "wks_home", { requestId: "mis-00000000a1", to: "main-old" })).toEqual({ to: "main-new", hold: true });
    // Never a record to an agent that was not the mission's Main, nor one naming no mission.
    expect(mainTargetOf(home, "wks_home", { requestId: "m:mis-00000000a1:3", to: "wrk-1" })).toBeNull();
    expect(mainTargetOf(home, "wks_home", { requestId: "m:mis-ffffffffff:1", to: "main-old" })).toBeNull();
    expect(mainTargetOf(home, "wks_home", { requestId: "m:not-a-mission:1", to: "main-old" })).toBeNull();
  });
});

describe("the request registry's bound (design §16.4)", () => {
  it("never drops a request with a pending outbox record when trimming to 2,000", () => {
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
    outbox.add(WS, { kind: "report", requestId: id(1), from: "w", to: "m", text: "held by the queue" });
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
