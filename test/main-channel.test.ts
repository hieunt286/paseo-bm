import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAIN_UPDATES, enqueueNotice, isMissionMain } from "../plugin/server/main-channel";
import { createMissionRoster, clearRequestIndexCache } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createNoticeQueue, type NoticePaseo } from "../plugin/server/notice-queue";
import { createOutbox, storeAndDeliver } from "../plugin/server/outbox";
import { clearRequestRegistryCache } from "../plugin/server/request-registry";
import { isPluginNotice, updatesItemsOf, updatesNoticeOf } from "../plugin/shared/notices";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The Main's channel (mission runtime design §6.2, ADR-033 decision 5,
 * REQ-207): what is pending for a mission's Main at its idle moment goes as
 * one `BM-UPDATES` message; each item keeps its own outcome; a `danger` item
 * goes first. A fake Paseo (scripted snapshots, a log of sends; a send starts
 * a turn) and temporary data folders only.
 */

const MISSION = "mis-0123456789";
const MAIN = "main-1";
const NEXT = "main-2";
const REPO = "wks_repo";
const REQ = "req-20261010T080000Z";
const NOW = new Date("2026-10-10T08:00:00.000Z");
let home: string;

type Agent = { status: string; archivedAt?: string | null };

function world(initial: Record<string, Agent>, failSend = false) {
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
          if (failSend) throw new Error("no route");
          sends.push({ id, text });
          agents.set(id, { ...agents.get(id)!, status: "running" });
        },
      }),
    },
  };
  const set = (id: string, change: Partial<Agent>) => agents.set(id, { ...agents.get(id)!, ...change });
  const queue = createNoticeQueue({ log: () => {} });
  const turnEnded = async (id: string) => {
    set(id, { status: "idle" });
    await queue.turnEnded({ agent: { id } }, paseo);
  };
  return { paseo, sends, set, queue, turnEnded };
}

beforeEach(() => {
  home = dataFolder("bm-main-channel-");
  clearRequestIndexCache();
  clearRequestRegistryCache();
  const made = createMissionStore(home, { newId: () => MISSION, env: {}, now: () => NOW }).create({ code: "XAI", name: "XAI", goal: "g", repos: [REPO], createdBy: "owner", mainId: MAIN });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  createMissionRoster(home).add(MISSION, { requestId: REQ, workspaceId: REPO, topic: "G14", workerId: "w-1" });
});

afterEach(() => {
  clearRequestIndexCache();
  clearRequestRegistryCache();
  removeDataFolders();
});

const report = (n: number) => `BM-REPORT\nrequestId: ${REQ}\nphase: implementing\nnote: ${n}`;
const deliver = (w: ReturnType<typeof world>, n: number, to = MAIN) =>
  storeAndDeliver(REPO, { kind: "report", requestId: REQ, from: "w-1", to, text: report(n) }, { home, queue: w.queue, paseo: w.paseo, log: () => {} });

describe("the Main's channel (design §6.2)", () => {
  it("three records pending for a busy Main go as one BM-UPDATES message, oldest first; each record is delivered", async () => {
    const w = world({ [MAIN]: { status: "running" } });
    const stored = [await deliver(w, 1), await deliver(w, 2), await deliver(w, 3)];
    expect(stored.map((entry) => entry.outcome)).toEqual(["queued", "queued", "queued"]);
    expect(w.queue.pending(MAIN).map((entry) => entry.kind)).toEqual(stored.map((entry) => `BM-UPDATES:report:${entry.record.id}`));
    await w.turnEnded(MAIN);
    expect(w.sends).toHaveLength(1);
    const text = w.sends[0]!.text;
    expect(text.split("\n").slice(0, 3)).toEqual(["BM-UPDATES 3", "From the paseo-bm plugin, not the owner: 3 items, oldest first. Act on each as its block says.", "BM-ITEM 1"]);
    expect(isPluginNotice(text)).toBe(true);
    expect(updatesItemsOf(text)).toEqual(stored.map((entry) => `BM-DELIVERY report ${entry.record.id}\n${report(stored.indexOf(entry) + 1)}`));
    expect(createOutbox(home).list(REPO).map((record) => record.state)).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("one item alone goes as its block; a Worker's notice never rides the channel", async () => {
    const w = world({ [MAIN]: { status: "idle" }, "w-1": { status: "idle" } });
    const one = await deliver(w, 1);
    expect(w.sends.map((send) => send.text)).toEqual([`BM-DELIVERY report ${one.record.id}\n${report(1)}`]);
    await storeAndDeliver(REPO, { kind: "message", requestId: REQ, from: MAIN, to: "w-1", text: "Continue." }, { home, queue: w.queue, paseo: w.paseo, log: () => {} });
    w.set("w-1", { status: "running" });
    await storeAndDeliver(REPO, { kind: "message", requestId: REQ, from: MAIN, to: "w-1", text: "And this." }, { home, queue: w.queue, paseo: w.paseo, log: () => {} });
    expect(w.queue.pending("w-1").map((entry) => entry.kind)).toEqual([expect.stringMatching(/^message:out-/)]);
    expect(isMissionMain(home, MAIN)).toBe(true);
    expect(isMissionMain(home, "w-1")).toBe(false);
  });

  it("per item: a failed send drops each item; a gone target drops each; a queue retarget carries each to the next Main", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const told: string[] = [];
    const callbacks = (key: string) => ({ onSent: () => told.push(`sent ${key}`), onDropped: (_t: string, _k: string, reason: string) => told.push(`dropped ${key}: ${reason}`) });
    const items = ["a", "b"].map((key) => ({ key, line: `BM-DELIVERY message ${key}`, callbacks: callbacks(key) }));

    const failing = world({ [MAIN]: { status: "idle" } }, true);
    await queue.enqueueBatch(MAIN, MAIN_UPDATES, items, failing.paseo);
    expect(told).toEqual(["dropped a: the send failed: no route", "dropped b: the send failed: no route"]);

    told.length = 0;
    const gone = world({ [MAIN]: { status: "running" } });
    await queue.enqueueBatch(MAIN, MAIN_UPDATES, items, gone.paseo);
    gone.set(MAIN, { status: "idle", archivedAt: NOW.toISOString() });
    await queue.turnEnded({ agent: { id: MAIN } }, gone.paseo);
    expect(told).toEqual(["dropped a: the target is archived, closed or gone", "dropped b: the target is archived, closed or gone"]);

    told.length = 0;
    const moved = world({ [MAIN]: { status: "running" }, [NEXT]: { status: "idle" } });
    await queue.enqueueBatch(MAIN, MAIN_UPDATES, items, moved.paseo);
    expect(await queue.retarget(MAIN, NEXT, moved.paseo)).toBe(2);
    expect(moved.sends.map((send) => [send.id, send.text.split("\n")[0]])).toEqual([[NEXT, "BM-UPDATES 2"]]);
    expect(told).toEqual(["sent a", "sent b"]);
  });

  it("records waiting for a Main that is archived go to the mission's next Main, each settled delivered", async () => {
    const w = world({ [MAIN]: { status: "running" }, [NEXT]: { status: "running" } });
    const stored = [await deliver(w, 1), await deliver(w, 2)];
    createMissionStore(home).setMain(MISSION, NEXT, "replaced");
    w.set(MAIN, { archivedAt: NOW.toISOString() });
    await w.turnEnded(MAIN);
    expect(createOutbox(home).list(REPO).map((record) => [record.to, record.state])).toEqual([
      [NEXT, "pending"],
      [NEXT, "pending"],
    ]);
    await w.turnEnded(NEXT);
    expect(w.sends.map((send) => [send.id, send.text.split("\n")[0]])).toEqual([[NEXT, "BM-UPDATES 2"]]);
    expect(updatesItemsOf(w.sends[0]!.text)?.map((item) => item.split("\n")[0])).toEqual(stored.map((entry) => `BM-DELIVERY report ${entry.record.id}`));
    expect(createOutbox(home).list(REPO).map((record) => record.state)).toEqual(["delivered", "delivered"]);
  });

  it("a danger item goes before every other notice queued for the Main", async () => {
    const w = world({ [MAIN]: { status: "running" } });
    await w.queue.enqueue(MAIN, "BM-SETTINGS", "BM-SETTINGS the start settings changed", w.paseo);
    await deliver(w, 1);
    const outcome = await enqueueNotice({ home, queue: w.queue, targetId: MAIN, kind: "BM-SIGNAL:w-1", text: "BM-SIGNAL danger\nYour Worker w-1 ran a command.", paseo: w.paseo, first: true });
    expect(outcome).toBe("queued");
    await w.turnEnded(MAIN);
    expect(w.sends.map((send) => send.text.split("\n")[0])).toEqual(["BM-UPDATES 2"]);
    expect(updatesItemsOf(w.sends[0]!.text)?.map((item) => item.split("\n")[0])).toEqual([expect.stringMatching(/^BM-DELIVERY report /), "BM-SIGNAL danger"]);
    await w.turnEnded(MAIN);
    expect(w.sends.at(-1)?.text).toBe("BM-SETTINGS the start settings changed");
  });

  it("updatesNoticeOf and updatesItemsOf read each other back", () => {
    const blocks = ["BM-DELIVERY message out-0123456789ab\nline one\n\nline three", "BM-COMMAND\nto: manager"];
    expect(updatesItemsOf(updatesNoticeOf(blocks))).toEqual(blocks);
    expect(updatesItemsOf("BM-UPDATESX 2")).toBeNull();
    expect(updatesItemsOf("hello")).toBeNull();
  });
});
