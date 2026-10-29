import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { sendCommand } from "../plugin/server/command-send";
import { createNoticeQueue, type NoticeCallbacks, type NoticePaseo, type EnqueueOptions, type NoticeOutcome } from "../plugin/server/notice-queue";
import { createOutbox, storeAndDeliver } from "../plugin/server/outbox";
import { clearTurnReplacedAlert, isOwnerWords, turnReplacedKindOf, turnReplacedSignalOf } from "../plugin/server/owner-words";
import { clearRequestRegistryCache } from "../plugin/server/request-registry";
import { deliveryOf } from "../plugin/server/tool-kit";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The owner's words to a running Worker (delivery line design §19.5, ADR-038
 * decision 4; WP-11.6): which deliveries they are, the outbox's steered
 * record, and what a replaced turn tells. A fake Paseo with Paseo's
 * `activeTurn` and the provider on each snapshot; temporary data folders.
 */

const WS = "wks_1";
const REQ = "req-20261025T100000Z";
const T0 = new Date("2026-10-25T10:00:00.000Z");

afterEach(() => {
  clearRequestRegistryCache();
  removeDataFolders();
});

describe("isOwnerWords", () => {
  it("is a bm_tell_worker with now: true", () => {
    expect(isOwnerWords({ via: "tell", now: true })).toBe(true);
    expect(isOwnerWords({ via: "tell", now: false })).toBe(false);
  });

  it("is a BM-COMMAND to a Worker from the option the owner chose, never the policy's, a precedent's or one to a Manager", () => {
    expect(isOwnerWords({ via: "command", to: "worker", answeredBy: "owner" })).toBe(true);
    expect(isOwnerWords({ via: "command", to: "manager", answeredBy: "owner" })).toBe(false);
    expect(isOwnerWords({ via: "command", to: "worker", answeredBy: "policy" })).toBe(false);
    expect(isOwnerWords({ via: "command", to: "worker", answeredBy: "precedent" })).toBe(false);
    expect(isOwnerWords({ via: "command", to: "worker", answeredBy: null })).toBe(false);
  });
});

describe("deliveryOf (bm_tell_worker's delivery)", () => {
  it("answers steered for a steer, and sent for a turn Paseo replaced", () => {
    expect(deliveryOf("steered")).toBe("steered");
    expect(deliveryOf("turn-replaced")).toBe("sent");
    expect(deliveryOf("queued")).toBe("queued");
  });
});

type Agent = { status: string; provider: string; activeTurn?: { turnId: string } | null };

function world(initial: Record<string, Agent>, options: { replaces?: boolean } = {}) {
  const agents = new Map(Object.entries(initial).map(([id, agent]) => [id, { ...agent }]));
  const sends: Array<{ id: string; text: string; options: unknown }> = [];
  const paseo: NoticePaseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.get(id);
          return agent === undefined ? null : { agent: { ...agent } };
        },
        send: async (text: string, sendOptions?: unknown) => {
          sends.push({ id, text, options: sendOptions });
          const steer = (sendOptions as { activeTurnBehavior?: string } | undefined)?.activeTurnBehavior === "steer";
          if (!steer || options.replaces === true) agents.set(id, { ...agents.get(id)!, status: "running", activeTurn: { turnId: `turn-new-${sends.length}` } });
        },
      }),
    },
  };
  const logs: string[] = [];
  const queue = createNoticeQueue({ log: (message) => logs.push(message), now: () => T0, newMessageId: () => "msg-1", baseOf: async (_paseo, provider) => (provider === "bm-worker" ? "claude" : null) });
  return { paseo, sends, logs, queue };
}

const RUNNING_WORKER: Agent = { status: "running", provider: "bm-worker", activeTurn: { turnId: "turn-1" } };
const IDLE_MAIN: Agent = { status: "idle", provider: "bm-manager", activeTurn: null };

describe("the outbox: a bm_tell_worker with now: true", () => {
  it("is steered into the running Worker's turn and records steeredAt", async () => {
    const home = dataFolder();
    const { paseo, sends, queue } = world({ wrk: RUNNING_WORKER, mgr: IDLE_MAIN });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr", to: "wrk", text: "Continue req.\nUse blue.", atOnce: true }, { home, queue, paseo, now: () => T0, log: () => {} });
    expect(outcome).toBe("steered");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.options).toEqual({ messageId: "msg-1", activeTurnBehavior: "steer" });
    const stored = createOutbox(home).list(WS).find((entry) => entry.id === record.id)!;
    expect(stored.state).toBe("delivered");
    expect(stored.steeredAt).toBe(T0.toISOString());
    expect(stored.replaced).toBeUndefined();
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("without now: true waits for the turn end, unsteered and unmarked", async () => {
    const home = dataFolder();
    const { paseo, sends, queue } = world({ wrk: RUNNING_WORKER });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr", to: "wrk", text: "A fact." }, { home, queue, paseo, now: () => T0, log: () => {} });
    expect(outcome).toBe("queued");
    expect(sends).toEqual([]);
    expect(createOutbox(home).list(WS).find((entry) => entry.id === record.id)!.steeredAt).toBeUndefined();
  });

  it("a replaced turn: the record says replaced, the Main gets one BM-SIGNAL replaced, the owner's Inbox one alert", async () => {
    const home = dataFolder();
    const { paseo, sends, logs, queue } = world({ wrk: RUNNING_WORKER, mgr: IDLE_MAIN }, { replaces: true });
    const { record, outcome } = await storeAndDeliver(WS, { kind: "message", requestId: REQ, from: "mgr", to: "wrk", text: "Stop and wait.", atOnce: true }, { home, queue, paseo, now: () => T0, log: () => {} });
    expect(outcome).toBe("turn-replaced");
    const stored = createOutbox(home).list(WS).find((entry) => entry.id === record.id)!;
    expect(stored).toMatchObject({ state: "delivered", steeredAt: T0.toISOString(), replaced: true });
    expect(logs.filter((line) => line.includes("Paseo replaced wrk's running turn"))).toHaveLength(1);
    await vi.waitFor(() => expect(sends.filter((send) => send.id === "mgr")).toHaveLength(1));
    const toMain = sends.find((send) => send.id === "mgr")!;
    expect(toMain.text).toBe(turnReplacedSignalOf({ workerId: "wrk", requestId: REQ, workspaceId: WS, what: `the owner's words (message ${record.id})` }));
    expect(toMain.text.split("\n")[0]).toBe("BM-SIGNAL replaced");
    expect(toMain.options).toBeUndefined();
    const alerts = createAlertStore(home).list({ open: true });
    expect(alerts.map((alert) => [alert.kind, alert.subject, alert.workspaceId])).toEqual([["turn-replaced", "wrk", WS]]);
    expect(alerts[0]!.detail).toContain("turn-1 → turn-new-1");

    // The request's end clears it.
    clearTurnReplacedAlert(home, WS, "wrk");
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });
});

describe("sendCommand: the owner's chosen option to a Worker", () => {
  const command = { from: "orchestrator" as const, via: "tab" as const, to: "worker" as const, requestId: REQ, re: "Owner's choice", body: "Use option B.", intent: "answer" as const };

  /** A queue that steers every `steer` notice, replacing the turn when told. */
  const steeringQueue = (replaced: boolean) =>
    vi.fn(async (_target: string, kind: string, _text: string, _paseo?: NoticePaseo, callbacks?: NoticeCallbacks, options?: EnqueueOptions): Promise<NoticeOutcome> => {
      if (options?.steer !== true) return "sent";
      callbacks?.onSteered?.(_target, kind, { at: T0.toISOString(), messageId: "m", replaced, turnBefore: "turn-1", turnAfter: replaced ? "turn-2" : "turn-1" });
      callbacks?.onSent?.(_target, kind);
      return replaced ? "turn-replaced" : "steered";
    });

  const send = (home: string, enqueue: ReturnType<typeof steeringQueue>, steer: boolean) =>
    sendCommand({
      home,
      now: T0,
      paseo: { agents: { ref: () => ({ refresh: async () => null, send: async () => {} }) } },
      workspaceId: WS,
      command,
      targetId: "wrk",
      copyTo: "mgr",
      backstop: false,
      loopGuard: "count",
      intervention: null,
      queue: { enqueue },
      store: { newId: () => "cmd-1" },
      redactEnv: {},
      ...(steer ? { steer: true } : {}),
      log: () => {},
    });

  it("is steered: sent, steer steered, and nothing is reported", async () => {
    const home = dataFolder();
    const enqueue = steeringQueue(false);
    const result = await send(home, enqueue, true);
    expect(result).toMatchObject({ ok: true, outcome: "sent", steer: "steered", copy: "sent" });
    expect(enqueue.mock.calls[0]![5]).toEqual({ steer: true });
    expect(enqueue.mock.calls.map((call) => call[1])).not.toContain(turnReplacedKindOf("wrk"));
    expect(createAlertStore(home).list({ open: true })).toEqual([]);
  });

  it("a replaced turn: steer replaced, the Main told and the owner's Inbox alerted", async () => {
    const home = dataFolder();
    const enqueue = steeringQueue(true);
    const result = await send(home, enqueue, true);
    expect(result).toMatchObject({ ok: true, outcome: "sent", steer: "replaced" });
    const signal = enqueue.mock.calls.find((call) => call[1] === turnReplacedKindOf("wrk"))!;
    expect(signal[0]).toBe("mgr");
    expect(signal[2].split("\n")[0]).toBe("BM-SIGNAL replaced");
    expect(createAlertStore(home).list({ open: true }).map((alert) => [alert.kind, alert.subject])).toEqual([["turn-replaced", "wrk"]]);
  });

  it("without steer goes as before: no steer option, no steer field", async () => {
    const home = dataFolder();
    const enqueue = steeringQueue(true);
    const result = await send(home, enqueue, false);
    expect(result.ok && result.steer).toBe(undefined);
    expect(enqueue.mock.calls[0]!.length).toBe(4);
  });
});
