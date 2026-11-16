import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionStore } from "../plugin/server/decision-store";
import { createMissionRoster } from "../plugin/server/mission-roster";
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
  failedAnswersCovered,
  mainTargetOf,
  newRecordId,
  newestReportRecordOf,
  noTurnLeadOf,
  noTurnNoteOf,
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
const OTHER_REQ = "req-20261003T110000Z";
const T0 = new Date("2026-10-03T10:00:00.000Z");

afterEach(() => {
  clearRequestRegistryCache();
  removeDataFolders();
});

type Agent = { status: string; archivedAt?: string | null; persistence?: { sessionId: string } };

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

  it("delivers to a target Paseo closed after its idle hour: a report, a verdict or bm_tell_worker's message resumes it (ADR-042)", async () => {
    const home = dataFolder();
    const w = world({ "wrk-1": { status: "closed", persistence: { sessionId: "session-1" } } });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Continue." }, deps(home, w));
    expect(outcome).toBe("sent");
    expect(stored(home, record.id)).toMatchObject({ state: "delivered" });
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("a failed answer's alert outlives a report to the Main, and clears once a message reaches the request (ADR-042)", async () => {
    const home = dataFolder();
    const id = `q:${REQ}:Q1`;
    const store = createDecisionStore(home);
    store.open({
      id,
      workspaceId: WS,
      requestId: REQ,
      askedBy: { role: "worker", agentId: "wrk-1" },
      askedAt: T0.toISOString(),
      round: 1,
      question: "Which one?",
      subject: null,
      options: [
        { key: "a", label: "This", recommended: true, effects: [] },
        { key: "b", label: "That", recommended: false, effects: [] },
      ],
      status: "open",
      settledAt: null,
      needsConfirmation: null,
      answer: null,
      grant: null,
      delivery: null,
      supersedes: null,
      supersededBy: null,
    });
    store.transition(id, (current) => ({ ok: true, decision: { ...current, delivery: { to: "wrk-1", kind: `answers:${REQ}`, at: T0.toISOString(), outcome: "failed" } } }), WS);
    createAlertStore(home).raise({ workspaceId: WS, kind: "delivery-dropped", subject: REQ, detail: "the answers did not arrive" });
    const w = world({ "mgr-1": { status: "idle" }, "wrk-2": { status: "idle" } });
    await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, deps(home, w));
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toHaveLength(1);
    await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-2", text: "Continue with a." }, deps(home, w));
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toEqual([]);
  });

  it("a dropped record of an open request tells its Main, unless the Main is the target (ADR-042 decision 5)", async () => {
    const home = dataFolder();
    createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
    const w = world({ "mgr-1": { status: "idle" } });
    await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-gone", text: "Continue." }, deps(home, w));
    await vi.waitFor(() => expect(w.sends.map((send) => send.id)).toEqual(["mgr-1"]));
    expect(w.sends[0]!.text.split("\n")[0]).toBe("BM-DELIVERY-FAILED");

    const quiet = world({});
    await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, deps(home, quiet));
    expect(quiet.sends).toEqual([]);
  });

  it("sends one BM-DELIVERY-FAILED per open alert (ADR-045 decision 14): a second drop adds none; once the alert clears, the next drop sends one", async () => {
    const home = dataFolder();
    createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
    const w = world({ "mgr-1": { status: "idle" } });
    const notices = () => w.sends.filter((send) => send.text.startsWith("BM-DELIVERY-FAILED"));
    const drop = async () => {
      await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-gone", text: "Continue." }, { ...deps(home, w), newId: newRecordId });
      w.set("mgr-1", { status: "idle" });
    };
    await drop();
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await drop();
    await vi.waitFor(() => expect(createOutbox(home).list(WS).filter((record) => record.state === "dropped")).toHaveLength(2));
    expect(notices()).toHaveLength(1);
    // The alert still names the newest drop.
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toHaveLength(1);

    clearDroppedAlert(home, WS, REQ, null);
    await drop();
    await vi.waitFor(() => expect(notices()).toHaveLength(2));
  });

  it("a Main that is the target raises the alert and is sent no notice, however many drops", async () => {
    const home = dataFolder();
    createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
    const w = world({});
    for (let n = 0; n < 2; n += 1) await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: REPORT }, { ...deps(home, w), newId: newRecordId });
    expect(w.sends).toEqual([]);
    expect(createAlertStore(home).list({ open: true, kinds: ["delivery-dropped"] })).toHaveLength(1);
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
    // The test's own clock throughout: settled records are kept 7 days from now (OUTBOX_SETTLED_MS), so a real clock past T0 + 7 days would drop them.
    createOutbox(home, d).settle(WS, done.id, "delivered");
    expect(stored(home, queued.id)?.state).toBe("pending");

    // The reload: the queue forgot what it held; the outbox did not.
    before.queue.clear();
    const after = world({ "mgr-1": { status: "idle" }, "wrk-2": { status: "idle" } });
    const resend = createOutboxResend({ home: () => home, queue: after.queue, log: () => {}, now: () => T0 });
    await resend.run(after.paseo);
    expect(after.sends.map((send) => parseDelivery(send.text)?.recordId).sort()).toEqual([queued.id, pending.id].sort());
    expect(stored(home, queued.id)?.state).toBe("delivered");
    expect(stored(home, pending.id, "wks_2")?.state).toBe("delivered");
    expect(stored(home, withheld.id)?.state).toBe("withheld");

    await resend.run(after.paseo);
    expect(after.sends).toHaveLength(2);
  });

  describe("the start-up resend and a dormant mission (ADR-044, ADR-045 decision 14)", () => {
    const RESTING = { status: "closed", persistence: { sessionId: "session-1" } };
    const MID = "mis-0123456789";
    const CARD = `m:${MID}:1`;
    const OTHER = "req-20261003T090000Z";

    function missionOf(home: string, mainId: string, earlier: string[] = []) {
      const store = createMissionStore(home, { newId: () => MID, env: {} });
      const made = store.create({ code: "PAS", name: "Site", goal: "g", repos: [WS], createdBy: "owner", mainId });
      if (!made.ok) throw new Error(made.reasons.join("; "));
      if (earlier.length > 0) store.update(MID, (current) => ({ ...current, mainHistory: [...earlier.map((agentId) => ({ agentId, from: T0.toISOString(), to: T0.toISOString(), reason: "replaced" as const })), ...current.mainHistory] }));
    }
    const card = (home: string, to: string) => createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: CARD, from: "a", to, text: "old news" });
    const resend = (home: string, w: ReturnType<typeof world>) => createOutboxResend({ home: () => home, queue: w.queue, log: () => {} }).run(w.paseo);
    const active = (home: string) => createMissionRoster(home, { env: {} }).add(MID, { requestId: OTHER, workspaceId: WS, topic: "work", workerId: "wrk-9" });

    it("settles a card an older build left open, of a mission with no active request, as a note: nothing sent, dropped or alerted", async () => {
      const home = dataFolder();
      missionOf(home, "main-1");
      const record = card(home, "main-1");
      const w = world({ "main-1": RESTING });
      await resend(home, w);
      expect(w.sends).toEqual([]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: "no-turn" });
      expect(createAlertStore(home).list({ open: true })).toEqual([]);
    });

    it("wakes the Main of a mission that has an active request, however old the card is", async () => {
      const home = dataFolder();
      missionOf(home, "main-1");
      active(home);
      const record = card(home, "main-1");
      const w = world({ "main-1": RESTING });
      await resend(home, w);
      expect(w.sends.map((send) => send.id)).toEqual(["main-1"]);
      expect(stored(home, record.id)?.state).toBe("delivered");
    });

    it("wakes a resting Worker for a request still open, whatever its age: a verdict queued before a weekend", async () => {
      const home = dataFolder();
      createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
      const record = createOutbox(home, { now: () => new Date(T0.getTime() - 5 * 24 * 3_600_000) }).add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "go on" });
      const w = world({ "wrk-1": RESTING });
      await resend(home, w);
      expect(stored(home, record.id)?.state).toBe("delivered");
    });

    it("settles a message of a finished request for a resting agent as a note", async () => {
      const home = dataFolder();
      const registry = createRequestRegistry(home, { backfill: () => [] });
      registry.register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
      registry.noteReport(WS, REQ, { tier: "Small", phase: "finished", at: T0.toISOString() });
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "late" });
      const w = world({ "wrk-1": RESTING });
      await resend(home, w);
      expect(w.sends).toEqual([]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: "no-turn" });
    });

    it("wakes a resting Worker for a finished request a follow-up reopened on the roster", async () => {
      const home = dataFolder();
      missionOf(home, "main-1");
      const registry = createRequestRegistry(home, { backfill: () => [] });
      registry.register(WS, REQ, { source: "tool", managerId: "main-1", workerId: "wrk-1" });
      registry.noteReport(WS, REQ, { tier: "Small", phase: "finished", at: T0.toISOString() });
      createMissionRoster(home, { env: {} }).add(MID, { requestId: REQ, workspaceId: WS, topic: "work", workerId: "wrk-1" });
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: REQ, from: "main-1", to: "wrk-1", text: "follow-up" });
      const w = world({ "wrk-1": RESTING });
      await resend(home, w);
      expect(stored(home, record.id)?.state).toBe("delivered");
    });

    it("delivers a record of a request paseo-bm does not know, as ADR-042 says", async () => {
      const home = dataFolder();
      const unknown = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: REQ, from: "a", to: "wrk-1", text: "x" });
      const w = world({ "wrk-1": RESTING });
      await resend(home, w);
      expect(stored(home, unknown.id)?.state).toBe("delivered");
    });

    it.each([
      ["a finished report", "report", "mgr-1", REPORT],
      ["a peer record", "peer-message", "wrk-1", "x"],
    ] as const)("never settles %s as a note, even on a finished request: the Main must still learn the work ended", async (_name, kind, to, text) => {
      const home = dataFolder();
      const registry = createRequestRegistry(home, { backfill: () => [] });
      registry.register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
      registry.noteReport(WS, REQ, { tier: "Small", phase: "finished", at: T0.toISOString() });
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind, requestId: REQ, from: "wrk-1", to, text });
      const w = world({ [to]: RESTING });
      await resend(home, w);
      expect(stored(home, record.id)?.state).toBe("delivered");
    });

    it("judges the agent it would reach now: a resting current Main gets the note though the stored one is archived", async () => {
      const home = dataFolder();
      missionOf(home, "main-now", ["main-old"]);
      const record = card(home, "main-old");
      const w = world({ "main-old": { status: "idle", archivedAt: T0.toISOString() }, "main-now": RESTING });
      await resend(home, w);
      expect(w.sends).toEqual([]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: "no-turn", to: "main-now" });
    });

    it("judges the agent it would reach now: a live current Main gets it though the stored one rests", async () => {
      const home = dataFolder();
      missionOf(home, "main-now", ["main-old"]);
      const record = card(home, "main-old");
      const w = world({ "main-old": RESTING, "main-now": { status: "idle" } });
      await resend(home, w);
      expect(w.sends.map((send) => send.id)).toEqual(["main-now"]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", to: "main-now" });
    });

    it("settles a dormant card for a gone agent as before", async () => {
      const home = dataFolder();
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: CARD, from: "a", to: "mgr-gone", text: "old news" });
      const w = world({});
      await resend(home, w);
      expect(stored(home, record.id)?.state).toBe("dropped");
    });

    it("delivers as before when the target cannot be read", async () => {
      const home = dataFolder();
      missionOf(home, "main-1");
      const record = card(home, "main-1");
      const w = world({ "main-1": { status: "idle" } });
      let reads = 0;
      const flaky = { agents: { ref: (id: string) => ({ ...w.paseo.agents.ref(id), refresh: async () => {
        reads += 1;
        if (reads === 1) throw new Error("socket closed");
        return w.paseo.agents.ref(id).refresh();
      } }) } };
      await createOutboxResend({ home: () => home, queue: w.queue, log: () => {} }).run(flaky);
      expect(stored(home, record.id)?.state).toBe("delivered");
    });
  });

  describe("one delivery rule (ADR-045 decision 14): turn or note, at every attempt", () => {
    const RESTING = { status: "closed", persistence: { sessionId: "session-1" } };
    const MID = "mis-0123456789";
    const CARD = `m:${MID}:1`;
    const mission = (home: string) => {
      const made = createMissionStore(home, { newId: () => MID, env: {} }).create({ code: "PAS", name: "Site", goal: "g", repos: [WS], createdBy: "owner", mainId: "main-1" });
      if (!made.ok) throw new Error(made.reasons.join("; "));
    };
    const finishedRequest = (home: string) => {
      const registry = createRequestRegistry(home, { backfill: () => [] });
      registry.register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
      registry.noteReport(WS, REQ, { tier: "Small", phase: "finished", at: T0.toISOString() });
    };
    const init = (requestId: string, to: string, text = "old news", kind: "message" | "report" | "review" | "no-verdict" | "peer-message" = "message") => ({ kind, requestId, from: "plugin", to, text });

    it("a message of no open work to a resting recipient, sent while the plugin runs, is a note: nothing enqueued, no alert, no BM-DELIVERY-FAILED", async () => {
      const home = dataFolder();
      mission(home);
      const w = world({ "main-1": RESTING });
      const { record, outcome } = await storeAndDeliver(WS, init(CARD, "main-1"), deps(home, w));
      expect(outcome).toBe("no-turn");
      expect(w.sends).toEqual([]);
      expect(w.queue.pending("main-1")).toEqual([]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: "no-turn", to: "main-1" });
      expect(createAlertStore(home).list({ open: true })).toEqual([]);
    });

    it.each([
      ["the owner's answer on an m: card", "owner", CARD],
      ["the owner's change to the mission", "owner", MID],
      ["the Orchestrator's outcome on an m: card", "orchestrator", CARD],
    ] as const)("%s wakes a resting Main of a mission with no active request: never a silent note", async (_name, from, requestId) => {
      const home = dataFolder();
      mission(home);
      const w = world({ "main-1": RESTING });
      const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId, from, to: "main-1", text: "The owner answered your question." }, deps(home, w));
      expect(outcome).toBe("sent");
      expect(w.sends.map((send) => send.id)).toEqual(["main-1"]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: null });
      expect(noTurnLeadOf(home, "main-1")).toBeNull();
    });

    it("the owner's words sent at once wake a resting Worker of a finished request; the Main's own late message stays a note", async () => {
      const home = dataFolder();
      finishedRequest(home);
      const w = world({ "wrk-1": RESTING });
      const late = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "late" }, deps(home, w));
      expect(late.outcome).toBe("no-turn");
      expect(w.sends).toEqual([]);
      const { record } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr-1", to: "wrk-1", text: "Stop: the owner says so.", atOnce: true }, deps(home, w));
      expect(w.sends.map((send) => send.id)).toEqual(["wrk-1"]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: null });
    });

    it.each([
      ["the owner's answer", { from: "owner" }],
      ["the Orchestrator's outcome on a card", { from: "orchestrator" }],
      ["the owner's words sent at once", { from: "main-1", atOnce: true }],
    ] as const)("%s left open at a plugin start wakes a resting Main of a dormant mission: one rule, never a silent note", async (_name, sender) => {
      const home = dataFolder();
      mission(home);
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: CARD, to: "main-1", text: "The owner chose b.", ...sender });
      const w = world({ "main-1": RESTING });
      await createOutboxResend({ home: () => home, queue: w.queue, log: () => {} }).run(w.paseo);
      expect(w.sends.map((send) => send.id)).toEqual(["main-1"]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: null });
      expect(noTurnLeadOf(home, "main-1")).toBeNull();
    });

    it("a plugin's notice left open at a plugin start stays a note for a dormant mission (ADR-044's field case)", async () => {
      const home = dataFolder();
      mission(home);
      const record = createOutbox(home, { now: () => T0 }).add(WS, { kind: "message", requestId: MID, from: "plugin", to: "main-1", text: "Daily digest." });
      const w = world({ "main-1": RESTING });
      await createOutboxResend({ home: () => home, queue: w.queue, log: () => {} }).run(w.paseo);
      expect(w.sends).toEqual([]);
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: "no-turn" });
    });

    it.each([
      ["live", { status: "idle" }, "delivered", 1],
      ["gone", null, "dropped", 0],
    ] as const)("a dormant message to a %s recipient behaves as before", async (_name, agent, state, sent) => {
      const home = dataFolder();
      finishedRequest(home);
      const w = world(agent === null ? {} : { "wrk-1": agent });
      const { record } = await storeAndDeliver(WS, init(REQ, "wrk-1"), deps(home, w));
      expect(stored(home, record.id)?.state).toBe(state);
      expect(stored(home, record.id)?.reason).not.toBe("no-turn");
      expect(w.sends).toHaveLength(sent);
    });

    it.each(["report", "review", "no-verdict", "peer-message"] as const)("a %s to a resting recipient of a finished request is delivered as before", async (kind) => {
      const home = dataFolder();
      finishedRequest(home);
      const w = world({ "wrk-1": RESTING });
      const { record } = await storeAndDeliver(WS, init(REQ, "wrk-1", "x", kind), deps(home, w));
      expect(stored(home, record.id)).toMatchObject({ state: "delivered", reason: null });
      expect(w.sends.map((send) => send.id)).toEqual(["wrk-1"]);
    });

    it("a message of open work, and one about an unknown request, wake a resting recipient as before", async () => {
      const home = dataFolder();
      createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: "mgr-1", workerId: "wrk-1" });
      const w = world({ "wrk-1": RESTING, "wrk-2": RESTING });
      const open = await storeAndDeliver(WS, init(REQ, "wrk-1"), deps(home, w));
      const unknown = await storeAndDeliver(WS, init("req-20261003T090000Z", "wrk-2"), deps(home, w));
      expect(stored(home, open.record.id)).toMatchObject({ state: "delivered", reason: null });
      expect(stored(home, unknown.record.id)).toMatchObject({ state: "delivered", reason: null });
      expect(w.sends.map((send) => send.id)).toEqual(["wrk-1", "wrk-2"]);
    });

    it("unreadable presence delivers as before: a read that fails, and no Paseo handle", async () => {
      const home = dataFolder();
      mission(home);
      const w = world({ "main-1": { status: "idle" } });
      const flaky = { agents: { ref: (id: string) => ({ ...w.paseo.agents.ref(id), refresh: vi.fn().mockRejectedValueOnce(new Error("socket closed")).mockImplementation(() => w.paseo.agents.ref(id).refresh()) }) } };
      const read = await storeAndDeliver(WS, init(CARD, "main-1"), { ...deps(home, w), paseo: flaky });
      expect(stored(home, read.record.id)?.reason).not.toBe("no-turn");

      const enqueue = vi.fn(async () => "queued" as const);
      const unbound = await storeAndDeliver(WS, init(CARD, "main-1"), { home, now: () => T0, log: () => {}, newId: () => "out-0000000000c1", queue: { enqueue } });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(stored(home, unbound.record.id)).toMatchObject({ state: "pending", reason: null });
    });

    it("the next delivery to that recipient opens with the note, once", async () => {
      const home = dataFolder();
      mission(home);
      const w = world({ "main-1": RESTING });
      const d = deps(home, w);
      const { record: note } = await storeAndDeliver(WS, init(CARD, "main-1"), d);
      expect(noTurnLeadOf(home, "main-1")?.text).toBe(`noted: message ${note.id} from plugin: old news`);

      w.set("main-1", { status: "idle" });
      const report = await storeAndDeliver(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "main-1", text: REPORT }, d);
      expect(report.outcome).toBe("sent");
      expect(w.sends[0]!.text.split("\n").slice(0, 2)).toEqual([`BM-DELIVERY report ${report.record.id}`, `noted: message ${note.id} from plugin: old news`]);
      expect(stored(home, note.id)?.shownAt).toBe(T0.toISOString());
      expect(noTurnLeadOf(home, "main-1")).toBeNull();
    });

    it("writes a note of a record with no link as kind, id, sender and gist; a link's note keeps its line", () => {
      const of = (text: string, kind: OutboxRecord["kind"] = "message") => noTurnNoteOf({ kind, id: "out-0000000000a1", from: "wrk-1", text });
      expect(of("  Old\n\nnews  ")).toBe("noted: message out-0000000000a1 from wrk-1: Old news");
      expect(of("BM-REPORT\nphase: beads-done\ntier: Small", "report")).toBe("noted: report out-0000000000a1 from wrk-1: phase: beads-done tier: Small");
      expect(of("BM-COMMAND\nfrom: orchestrator\ncopy: yes\nre: Stop the push\nintent: stop\n\nStop.")).toBe("noted: message out-0000000000a1 from wrk-1: Stop the push");
      expect(of("x".repeat(300))).toBe(`noted: message out-0000000000a1 from wrk-1: ${"x".repeat(199)}…`);
      expect(of("")).toBe("noted: message out-0000000000a1 from wrk-1");
      expect(of("link: peer-0000000000a1\nact: ack\n> Seen.", "peer-message")).toBe("noted: peer-0000000000a1 from wrk-1 (act: ack): Seen.");
    });

    it("a note of a report or message covers no drop and no failed answer; a link's note covers as before", () => {
      const home = dataFolder();
      const outbox = createOutbox(home, { now: () => T0 });
      const dropped = outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "lost" });
      outbox.settle(WS, dropped.id, "dropped", "gone");
      outbox.add(WS, { kind: "report", requestId: REQ, from: "wrk-1", to: "mgr-1", text: "BM-REPORT\nphase: beads-done", noTurn: true });
      const failedAt = [T0.toISOString()];
      outbox.add(WS, { kind: "message", requestId: REQ, from: "orchestrator", to: "mgr-1", text: "a copy", noTurn: true });
      const records = outbox.list(WS);
      expect(dropsCovered(records, REQ)).toBe(false);
      expect(failedAnswersCovered(records, REQ, failedAt)).toBe(false);

      const peer = outbox.add(WS, { kind: "peer-message", requestId: OTHER_REQ, from: "wrk-1", to: "mgr-1", text: "lost" });
      outbox.settle(WS, peer.id, "dropped", "gone");
      outbox.add(WS, { kind: "peer-message", requestId: OTHER_REQ, from: "wrk-1", to: "mgr-1", text: "link: peer-0000000000a1\nact: ack", noTurn: true });
      expect(dropsCovered(outbox.list(WS), OTHER_REQ)).toBe(true);
    });

    it("settleAsNote settles an open record once and never a settled one", () => {
      const home = dataFolder();
      const outbox = createOutbox(home, { now: () => T0 });
      const { id } = outbox.add(WS, { kind: "message", requestId: REQ, from: "a", to: "b", text: "x" });
      expect(outbox.settleAsNote(WS, id)).toMatchObject({ changed: true, record: { state: "delivered", reason: "no-turn", outcomeAt: T0.toISOString() } });
      expect(outbox.settleAsNote(WS, id)).toMatchObject({ changed: false });
      expect(outbox.settleAsNote(WS, "out-ffffffffffff")).toBeNull();
    });
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
