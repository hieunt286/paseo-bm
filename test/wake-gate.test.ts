import { afterEach, describe, expect, it } from "vitest";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { createDeliveringTools } from "../plugin/server/deliver-tools";
import { createNoticeQueue, type NoticePaseo } from "../plugin/server/notice-queue";
import { createOutbox, createOutboxResend, deliveryTextOf, isOpenRecord, storeAndDeliver, type OutboxDeliveryDeps, type OutboxRecord } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { settleDeadWaitItems, settleRequestWaits, settleWaitItem, waitingOf } from "../plugin/server/waits";
import { AT_ONCE_KINDS, heldTellText, holdsAtSend, isReleasing, releaseSettledWaits, waitFactsBlockOf, wakeGate } from "../plugin/server/wake-gate";
import { updatesItemsOf, updatesNoticeOf } from "../plugin/shared/notices";
import type { WaitItemKind, WakeOn } from "../plugin/shared/waits";
import { fakePaseo } from "./helpers/fake-paseo";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { MANAGER_CALLER, TOOL_MANAGER, TOOL_REQ, TOOL_WORKER, TOOL_WS } from "./helpers/bindings";

/**
 * The wake gate (delivery line design §6.4; WP-7.5): a bound Worker waiting
 * by structure gets no delivery that settles none of its items; what was held
 * goes as ONE message once the wait is met, the settling item first. A fake
 * Paseo, a private queue and temporary data folders only.
 */

const WS = TOOL_WS;
const REQ = TOOL_REQ;
const OTHER = "req-20261003T110000Z";
const MANAGER = TOOL_MANAGER;
const WORKER = TOOL_WORKER;
const WORKER_2 = "agent-worker-2";
const REVIEWER = "agent-reviewer";
const T0 = new Date("2026-10-03T10:05:00.000Z");
const AT = T0.toISOString();
const LATER = new Date(T0.getTime() + 60_000).toISOString();

afterEach(() => {
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  removeDataFolders();
});

const AGENTS = [
  { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
];

function setup() {
  const home = dataFolder();
  const fake = fakePaseo({ agents: AGENTS });
  const queue = createNoticeQueue({ log: () => {} });
  let n = 0;
  const deps: OutboxDeliveryDeps = {
    home,
    queue,
    paseo: fake.paseo as unknown as NoticePaseo,
    now: () => T0,
    newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}`,
    log: () => {},
  };
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  registry.register(WS, OTHER, { source: "tool", managerId: MANAGER, workerId: WORKER_2 });
  /** The Worker's blocked report set this wait. */
  const wait = (items: Array<{ kind: WaitItemKind; id: string }>, wakeOn: WakeOn = "all") =>
    registry.setWaiting(WS, REQ, { since: AT, reportRecordId: "out-0000000000ff", wakeOn, items: items.map((item) => ({ ...item, settled: false })) });
  const message = (text: string) => storeAndDeliver(WS, { kind: "message", requestId: REQ, from: MANAGER, to: WORKER, text: `Continue ${REQ}.\n${text}` }, deps);
  const review = (batchId: string) => storeAndDeliver(WS, { kind: "review", requestId: REQ, batchId, from: REVIEWER, to: WORKER, text: "BM-REVIEW\nverdict: pass" }, deps);
  const stored = (id: string): OutboxRecord => createOutbox(home).list(WS).find((record) => record.id === id)!;
  const idle = () => (fake.byId(WORKER)!.status = "idle");
  return { home, fake, queue, deps, registry, wait, message, review, stored, idle };
}

const Q = (n: number) => `q:${REQ}:Q${n}`;
const factsOf = (...facts: string[]) => ["BM-DELIVERY wait", `Continue ${REQ}: what you waited on is settled.`, ...facts].join("\n");

describe("the gate (delivery line design §6.4)", () => {
  it("lets each always-at-once kind through to a waiting Worker, and holds the rest", () => {
    const { home, wait } = setup();
    wait([{ kind: "question", id: Q(2) }]);
    expect([...AT_ONCE_KINDS]).toEqual(["owner-chat", "stop", "command", "replaced", "settings-mode", "rollover-now", "maintenance", "tell-now"]);
    for (const kind of AT_ONCE_KINDS) expect(wakeGate(home, WORKER, kind)).toEqual({ action: "deliver", release: null, settles: false });
    for (const kind of ["message", "review", "peer-reply", "answers", "override"] as const) expect(wakeGate(home, WORKER, kind).action).toBe("hold");
  });

  it("never gates an unbound Worker, a wait without items, or an agent that waits on nothing", () => {
    const { home, registry, wait } = setup();
    wait([]);
    expect(wakeGate(home, WORKER, "message")).toMatchObject({ action: "deliver", release: null });
    registry.register(WS, "req-20261003T120000Z", { source: "agent-typed", managerId: MANAGER, workerId: "agent-typed-worker" });
    registry.setWaiting(WS, "req-20261003T120000Z", { since: AT, reportRecordId: "out-0000000000fe", wakeOn: "all", items: [{ kind: "question", id: "q:x:Q1", settled: false }] });
    expect(wakeGate(home, "agent-typed-worker", "message")).toMatchObject({ action: "deliver", release: null });
    expect(wakeGate(home, MANAGER, "report")).toMatchObject({ action: "deliver", release: null });
  });

  it("names what a held tell waits on", () => {
    const items = [
      { kind: "question" as const, id: Q(1), settled: true },
      { kind: "question" as const, id: Q(2), settled: false },
      { kind: "question" as const, id: Q(3), settled: false },
    ];
    expect(heldTellText({ wakeOn: "all", items })).toBe("The Worker waits on Q2 and Q3; it gets this with them.");
    expect(heldTellText({ wakeOn: "all", items: items.slice(0, 2) })).toBe("The Worker waits on Q2; it gets this with it.");
    expect(heldTellText({ wakeOn: "any", items: [...items, { kind: "batch", id: "b1", settled: false }] })).toBe("The Worker waits on Q2, Q3 or b1; it gets this with the first of them.");
  });
});

describe("holding and the release", () => {
  it("holds a message that settles none of the items; the settling item releases ONE BM-UPDATES, itself first, the facts, then what was held", async () => {
    const { home, fake, registry, wait, message, review, stored } = setup();
    wait([
      { kind: "batch", id: "b1" },
      { kind: "request", id: OTHER },
    ]);
    const held = await message("Use dd/mm/yyyy.");
    expect(held.outcome).toBe("held");
    expect(stored(held.record.id)).toMatchObject({ state: "held", outcomeAt: null });
    expect(isOpenRecord(stored(held.record.id))).toBe(true);
    // The awaited request finished: one item settled, the wait not met yet, nobody woken.
    expect(settleRequestWaits(home, WS, OTHER, "finished", "the API is live", LATER, () => {})).toMatchObject([{ met: false }]);
    expect(fake.sends).toEqual([]);

    const settling = await review("b1");
    expect(settling.outcome).toBe("sent");
    expect(fake.sends).toHaveLength(1);
    const text = fake.sends[0]!.text;
    expect(text).toBe(updatesNoticeOf([deliveryTextOf(settling.record), factsOf(`${OTHER} finished: the API is live`), deliveryTextOf(held.record)]));
    expect(text.split("\n")[0]).toBe("BM-UPDATES 3");
    expect(updatesItemsOf(text)).toHaveLength(3);
    expect(stored(settling.record.id).state).toBe("delivered");
    expect(stored(held.record.id).state).toBe("delivered");
    // The wake cleared the wait: the next delivery goes at once.
    expect(registry.get(WS, REQ)?.waiting).toBeUndefined();
    expect(isReleasing(WORKER, `message:${held.record.id}`)).toBe(false);
  });

  it("a held message survives a reload, is gated again then, and goes once the wait is met", async () => {
    const { home, fake, deps, wait, message, stored } = setup();
    wait([{ kind: "question", id: Q(2) }]);
    const held = await message("Keep the old name.");
    expect(held.outcome).toBe("held");

    // A reload: a new queue; the resend gates the held record again and still holds it.
    const reloaded = { ...deps, queue: createNoticeQueue({ log: () => {} }) };
    await createOutboxResend({ home: () => home, queue: reloaded.queue, log: () => {} }).run(fake.paseo);
    expect(stored(held.record.id).state).toBe("held");
    expect(fake.sends).toEqual([]);

    // Q2 settled while nothing delivered it; the next run's resend meets the wait and releases it.
    expect(settleWaitItem(home, { kind: "question", id: Q(2) }, { at: LATER }, null, () => {})).toMatchObject([{ met: true }]);
    await createOutboxResend({ home: () => home, queue: createNoticeQueue({ log: () => {} }), log: () => {} }).run(fake.paseo);
    expect(fake.sends.map((send) => send.text)).toEqual([deliveryTextOf(held.record)]);
    expect(stored(held.record.id).state).toBe("delivered");
    expect(waitingOf(home, WS, REQ)).toBeNull();
  });

  it("wakeOn any: the first settled item releases what was held, though other items stay open", async () => {
    const { fake, wait, message, review, registry } = setup();
    wait(
      [
        { kind: "question", id: Q(2) },
        { kind: "batch", id: "b1" },
      ],
      "any",
    );
    const held = await message("Note this.");
    expect(held.outcome).toBe("held");
    const settling = await review("b1");
    expect(fake.sends.map((send) => send.text)).toEqual([updatesNoticeOf([deliveryTextOf(settling.record), deliveryTextOf(held.record)])]);
    expect(registry.get(WS, REQ)?.waiting).toBeUndefined();
  });

  it("a dead item the stall pass settles wakes the Worker once, its fact first; a wait not met wakes nobody", async () => {
    const { home, fake, deps, wait, message } = setup();
    wait([{ kind: "request", id: OTHER }]);
    const held = await message("When it lands, wire it up.");
    expect(held.outcome).toBe("held");
    // The stall pass: the awaited request's Worker is gone.
    const settled = settleDeadWaitItems(home, { links: [], ceilingOf: () => null, isLive: (agentId) => agentId !== WORKER_2 }, LATER, () => {});
    expect(settled).toMatchObject([{ requestId: REQ, met: true }]);
    await releaseSettledWaits(home, settled, deps);
    expect(fake.sends.map((send) => send.text)).toEqual([updatesNoticeOf([factsOf(`${OTHER} has no live Worker left`), deliveryTextOf(held.record)])]);
    // Settled once, so it wakes once.
    await releaseSettledWaits(home, settled, deps);
    expect(fake.sends).toHaveLength(1);
  });

  it("a dead item alone wakes with its fact as the one block; an unmet wait releases nothing", async () => {
    const { home, fake, deps, wait } = setup();
    wait([
      { kind: "request", id: OTHER },
      { kind: "question", id: Q(1) },
    ]);
    const partly = settleWaitItem(home, { kind: "request", id: OTHER }, { at: LATER, fact: `${OTHER} stopped: no access` }, null, () => {});
    await releaseSettledWaits(home, partly, deps);
    expect(fake.sends).toEqual([]);
    const met = settleWaitItem(home, { kind: "question", id: Q(1) }, { at: LATER }, null, () => {});
    await releaseSettledWaits(home, met, deps);
    expect(fake.sends.map((send) => send.text)).toEqual([factsOf(`${OTHER} stopped: no access`)]);
    expect(waitFactsBlockOf(REQ, { items: [{ kind: "question", id: Q(1), settled: true }] }, true)).toBe(factsOf("Settled: Q1."));
  });
});

describe("the gate at the send (delivery line design §6.4: what was queued while the Worker ran)", () => {
  const SUCCESSOR = "agent-worker-successor";
  const turnEnd = (queue: ReturnType<typeof createNoticeQueue>, paseo: unknown, id = WORKER) => queue.turnEnded({ agent: { id } }, paseo);

  it("a record queued while the Worker ran is held at that turn's end when its blocked report set a wait, then released with it", async () => {
    const { fake, queue, wait, message, review, stored, idle } = setup();
    fake.byId(WORKER)!.status = "running";
    const queued = await message("Use dd/mm/yyyy.");
    expect(queued.outcome).toBe("queued");
    // The running turn reports `blocked` on b1.
    wait([{ kind: "batch", id: "b1" }]);
    idle();
    await turnEnd(queue, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(WORKER)).toEqual([]);
    expect(stored(queued.record.id).state).toBe("held");

    const settling = await review("b1");
    expect(fake.sends.map((send) => send.text)).toEqual([updatesNoticeOf([deliveryTextOf(settling.record), deliveryTextOf(queued.record)])]);
    expect(stored(queued.record.id).state).toBe("delivered");
  });

  it("a record that settles the new wait still goes at the send; an always-at-once one is never asked", async () => {
    const { home, fake, queue, wait, review, stored, idle } = setup();
    fake.byId(WORKER)!.status = "running";
    const queued = await review("b1");
    expect(queued.outcome).toBe("queued");
    wait([{ kind: "batch", id: "b1" }]);
    idle();
    await turnEnd(queue, fake.paseo);
    expect(fake.sends.map((send) => send.text)).toEqual([deliveryTextOf(queued.record)]);
    expect(stored(queued.record.id).state).toBe("delivered");
    wait([{ kind: "question", id: Q(2) }]);
    expect(holdsAtSend(home, WORKER, "maintenance")()).toBe(false);
    expect(holdsAtSend(home, WORKER, "message")()).toBe(true);
    expect(holdsAtSend(home, WORKER, "answers", [{ kind: "question", id: Q(2) }])()).toBe(false);
  });

  it("a release queued while the Worker ran is gated again item by item under its newer wait; its facts go with the next release", async () => {
    const { home, fake, queue, deps, registry, wait, message, review, stored, idle } = setup();
    wait([{ kind: "request", id: OTHER }]);
    const held = await message("When it lands, wire it up.");
    expect(held.outcome).toBe("held");
    fake.byId(WORKER)!.status = "running";
    await releaseSettledWaits(home, settleRequestWaits(home, WS, OTHER, "finished", "the API is live", LATER, () => {}), deps);
    expect(queue.pending(WORKER)).toHaveLength(2);
    expect(isReleasing(WORKER, `message:${held.record.id}`)).toBe(true);
    // The running turn reports `blocked` on b1: a newer wait, unmet.
    registry.setWaiting(WS, REQ, { since: LATER, reportRecordId: "out-0000000000fd", wakeOn: "all", items: [{ kind: "batch", id: "b1", settled: false }] });
    idle();
    await turnEnd(queue, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(WORKER)).toEqual([]);
    expect(stored(held.record.id).state).toBe("held");
    expect(isReleasing(WORKER, `message:${held.record.id}`)).toBe(false);

    const settling = await review("b1");
    expect(fake.sends).toHaveLength(1);
    expect(updatesItemsOf(fake.sends[0]!.text)).toEqual([deliveryTextOf(settling.record), deliveryTextOf(held.record), factsOf(`${OTHER} finished: the API is live`)]);
    expect(stored(held.record.id).state).toBe("delivered");
  });

  it("gates only the request's newest Worker; what was held for the Worker a handoff replaced goes to its successor", async () => {
    const { home, fake, deps, registry, wait, message, stored } = setup();
    wait([{ kind: "batch", id: "b1" }]);
    const held = await message("Keep the old column names.");
    expect(held.outcome).toBe("held");
    // A handoff: the successor is the request's newest Worker.
    registry.addWorker(WS, REQ, SUCCESSOR);
    fake.agents.push({ id: SUCCESSOR, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ } });
    expect(wakeGate(home, WORKER, "message").action).toBe("deliver");
    expect(wakeGate(home, SUCCESSOR, "message").action).toBe("hold");

    const verdict = await storeAndDeliver(WS, { kind: "review", requestId: REQ, batchId: "b1", from: REVIEWER, to: SUCCESSOR, text: "BM-REVIEW\nverdict: pass" }, deps);
    expect(verdict.outcome).toBe("sent");
    expect(fake.sends.map((send) => send.id)).toEqual([SUCCESSOR]);
    expect(updatesItemsOf(fake.sends[0]!.text)).toEqual([deliveryTextOf(verdict.record), deliveryTextOf(held.record)]);
    expect(stored(held.record.id)).toMatchObject({ state: "delivered", to: SUCCESSOR });
  });
});

describe("bm_tell_worker and the gate", () => {
  it("a held tell answers delivery held and names the wait; now: true delivers at once", async () => {
    const { home, fake, wait } = setup();
    let n = 100;
    const tools = createDeliveringTools({
      paseo: () => fake.paseo,
      home: () => home,
      log: () => {},
      now: () => T0,
      queue: createNoticeQueue({ log: () => {} }),
      outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
      workerOf: async () => WORKER,
    });
    wait([
      { kind: "question", id: Q(2) },
      { kind: "question", id: Q(3) },
    ]);
    const held = await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "Also the footer." }, MANAGER_CALLER);
    expect(JSON.parse(held.text)).toEqual({ workerId: WORKER, delivery: "held", note: "The Worker waits on Q2 and Q3; it gets this with them." });
    expect(fake.sends).toEqual([]);
    const now = await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "Stop waiting on Q3: use the default.", now: true }, MANAGER_CALLER);
    expect(JSON.parse(now.text)).toEqual({ workerId: WORKER, delivery: "sent" });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text).toContain("Stop waiting on Q3");
    expect(createOutbox(home).list(WS).map((record) => [record.state, record.atOnce ?? false])).toEqual([
      ["held", false],
      ["delivered", true],
    ]);
  });
});
