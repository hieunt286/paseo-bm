import { afterEach, describe, expect, it } from "vitest";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { CUT_NOTE_LINE, clearSeenTurns, createInterruptionWatch } from "../plugin/server/interruption-watch";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { settleCreatedAgent } from "../plugin/server/creation-settle";
import { handSentReportKeysOf, relayUnboundBlocks, writtenReportsOf } from "../plugin/server/unbound-relay";
import { parseDelivery } from "../plugin/shared/notices";
import type { Decision } from "../plugin/shared/decisions";
import type { TraceRecord } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { bindAgent } from "./helpers/bindings";

/**
 * The relay of an unbound Worker's blocks (ADR-027 decision 9 as amended
 * 2026-10-03, review finding K7): what an unbound Worker writes in its reply
 * reaches the agent that created it as a `report` outbox record, its questions
 * open as decisions, and nothing is relayed twice.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const T0 = new Date("2026-10-03T10:00:00.000Z");

afterEach(() => {
  clearBindingCache();
  clearDecisionStoreCache();
  clearRequestRegistryCache();
  clearSeenTurns();
  removeDataFolders();
});

const REPORT_RECEIVED = [`BM-REPORT`, `requestId: ${REQ}`, `phase: received`, `tier: Small (changed: no)`, `buildAndTests: not run`, `blockers: none`].join("\n");
const REPORT_BLOCKED = [`BM-REPORT`, `requestId: ${REQ}`, `phase: blocked`, `tier: Small (changed: no)`, `buildAndTests: not run`, `blockers: waiting on the owner: Q1`].join("\n");
const QUESTIONS = [
  "BM-QUESTIONS",
  `requestId: ${REQ}`,
  "Q1: Greeting — with a comma or without? [subject: greeting-comma] [class: preference]",
  "- a: Hi, Ann! (recommended) [effects: none]",
  "- b: Hi Ann! [effects: none]",
].join("\n");
const REPORT_FINISHED = [`BM-REPORT`, `requestId: ${REQ}`, `phase: finished`, `tier: Small (changed: no)`, "buildAndTests: `npm test` pass", `blockers: none`].join("\n");

function setup(options: { bound?: boolean; parent?: string | null; labels?: Record<string, string> } = {}) {
  const home = dataFolder();
  const store: BindingStore = createBindingStore(home);
  if (options.bound === true) bindAgent(store, WORKER, { role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER });
  const fake = fakePaseo({
    agents: [
      { id: MANAGER, provider: "bm-manager/claude-haiku-4-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
      { id: WORKER, provider: "bm-worker/claude-haiku-4-5", status: "idle", workspaceId: WS, labels: options.labels ?? { "bm.role": "worker", "bm.requestId": REQ } },
    ],
  });
  const queue = createNoticeQueue({ log: () => {} });
  let n = 0;
  const opened: Decision[][] = [];
  const settled: Decision[][] = [];
  const relay = (event: unknown) =>
    relayUnboundBlocks(event as never, {
      home,
      paseo: fake.paseo,
      bindings: store,
      now: () => T0,
      log: () => {},
      queue,
      outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
      onOpened: (decisions) => {
        opened.push([...decisions]);
      },
      onSettled: (decisions) => {
        settled.push([...decisions]);
      },
    });
  const parent = options.parent === undefined ? MANAGER : options.parent;
  const turn = (replies: string[], extra: unknown[] = []) => ({
    agent: { id: WORKER, provider: "bm-worker/claude-haiku-4-5", workspaceId: WS, parentAgentId: parent, cwd: "/repo", title: null },
    turnId: "t",
    outcome: { kind: "completed" },
    timeline: [{ type: "user_message", text: `Fix the greeting. requestId: ${REQ}` }, ...extra, ...replies.map((text) => ({ type: "assistant_message", text }))],
  });
  return { home, store, fake, relay, turn, opened, settled };
}

const reports = (home: string) => createOutbox(home).list(WS).filter((record) => record.kind === "report");

describe("an unbound Worker's blocks reach its parent (ADR-027 decision 9, amended; K7)", () => {
  it("a BM-REPORT written in its reply is stored and delivered to its Manager as a report record", async () => {
    const { home, fake, relay, turn } = setup();
    const outcome = await relay(turn([`Sized it as Small.\n\n${REPORT_RECEIVED}\n\nStarting now.`]));
    expect(outcome).toMatchObject({ status: "done", skipped: 0 });
    const [record] = reports(home);
    expect(outcome.relayed).toEqual([record!.id]);
    expect(record).toMatchObject({ kind: "report", requestId: REQ, from: WORKER, to: MANAGER, state: "delivered", text: REPORT_RECEIVED });
    expect(fake.sends).toEqual([{ id: MANAGER, text: `BM-DELIVERY report ${record!.id}\n${REPORT_RECEIVED}` }]);
    expect(parseDelivery(fake.sends[0]!.text)?.kind).toBe("report");
  });

  it("end to end: a Worker an unbound Manager made by hand is registered agent-typed, and the report in its reply reaches that Manager", async () => {
    const { home, store, fake, relay, turn } = setup();
    // agent.created: no binding to settle; the request id on its label is registered with the Manager and the Worker (§16.4).
    await settleCreatedAgent({ id: WORKER, provider: "bm-worker/claude-haiku-4-5", parentAgentId: MANAGER, workspaceId: WS }, fake.paseo, { home, bindings: store, log: () => {} });
    expect(store.bindingOfAgent(WORKER)).toBeNull();
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ source: "agent-typed", managerId: MANAGER, workerIds: [WORKER] });
    // The Worker's turn end: the block in its reply goes to that Manager as a delivery, with no id in any brief.
    const outcome = await relay(turn([`Sized it as Small.\n\n${REPORT_RECEIVED}`]));
    const [record] = reports(home);
    expect(outcome.relayed).toEqual([record!.id]);
    expect(fake.sends).toEqual([{ id: MANAGER, text: `BM-DELIVERY report ${record!.id}\n${REPORT_RECEIVED}` }]);
  });

  it("its BM-QUESTIONS opens the questions, asked by the Worker, and goes with the report", async () => {
    const { home, relay, turn, opened } = setup();
    await relay(turn([`${REPORT_BLOCKED}\n${QUESTIONS}`]));
    const [record] = reports(home);
    expect(record!.text).toBe(`${REPORT_BLOCKED}\n${QUESTIONS}`);
    const q1 = createDecisionStore(home).get(`q:${REQ}:Q1`, WS);
    expect(q1).toMatchObject({ status: "open", requestId: REQ, askedBy: { role: "worker", agentId: WORKER }, subject: "greeting-comma", class: "preference" });
    expect(opened.flat().map((decision) => decision.id)).toEqual([`q:${REQ}:Q1`]);
  });

  it("a finished report expires the request's unsettled questions, as the Manager's turn end did for a hand-sent one", async () => {
    const { home, relay, turn } = setup();
    await relay(turn([`${REPORT_BLOCKED}\n${QUESTIONS}`]));
    await relay(turn([REPORT_FINISHED]));
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("expired");
    // The first delivery started a Manager turn: the second waits for its idle moment, never cutting it.
    expect(reports(home).map((record) => record.state)).toEqual(["delivered", "pending"]);
  });

  it("relays a block once: the same turn end read again, and a block the turn sent by hand, are skipped", async () => {
    const { home, fake, relay, turn } = setup();
    await relay(turn([REPORT_RECEIVED]));
    expect(await relay(turn([REPORT_RECEIVED]))).toMatchObject({ status: "done", relayed: [], skipped: 1 });
    // An agent on older instructions that also sent the block with send_agent_prompt: that copy already arrived.
    const handSent = { type: "tool_call", name: "mcp__paseo__send_agent_prompt", detail: { input: { agentId: MANAGER, prompt: REPORT_FINISHED } } };
    expect(await relay(turn([REPORT_FINISHED], [handSent]))).toMatchObject({ relayed: [], skipped: 1 });
    expect(reports(home)).toHaveLength(1);
    expect(fake.sends).toHaveLength(1);
  });

  it("relays only the newest report of a request in one turn; the earlier one's questions still open (design §7.17.8 d)", async () => {
    const { home, fake, relay, turn, opened } = setup();
    const OTHER = "req-20261003T110000Z";
    const q2 = QUESTIONS.replace("Q1: Greeting — with a comma or without? [subject: greeting-comma]", "Q2: Exclamation mark? [subject: greeting-mark]");
    const otherReport = REPORT_RECEIVED.replace(REQ, OTHER);
    // Streamed replies join into one message, as a turn writes them.
    const event = turn([[`${REPORT_BLOCKED}\n${QUESTIONS}`, `Asked again.\n\n${REPORT_BLOCKED}\n${q2}`, `The other one:\n\n${otherReport}`].join("\n\n")]);
    const outcome = await relay(event);
    expect(outcome).toMatchObject({ status: "done", skipped: 1 });
    // One delivery per request: the newest of REQ, and OTHER's own.
    expect(reports(home).map((record) => [record.requestId, record.text])).toEqual([
      [REQ, `${REPORT_BLOCKED}\n${q2}`],
      [OTHER, otherReport],
    ]);
    expect(fake.sends).toHaveLength(1);
    // Both blocks' questions opened, asked by the Worker.
    const store = createDecisionStore(home);
    expect([store.get(`q:${REQ}:Q1`, WS)?.status, store.get(`q:${REQ}:Q2`, WS)?.status]).toEqual(["open", "open"]);
    expect(opened.flat().map((decision) => decision.id)).toEqual([`q:${REQ}:Q1`, `q:${REQ}:Q2`]);
    // Read again: nothing more is delivered or opened.
    expect(await relay(event)).toMatchObject({ relayed: [], skipped: 3 });
    expect(reports(home)).toHaveLength(2);
  });

  it("finds the parent by its label when the event names none, and leaves a Worker without one in its chat", async () => {
    const labelled = setup({ parent: null, labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER } });
    await labelled.relay(labelled.turn([REPORT_RECEIVED]));
    expect(reports(labelled.home)).toMatchObject([{ to: MANAGER }]);

    const orphan = setup({ parent: null });
    expect(await orphan.relay(orphan.turn([REPORT_RECEIVED]))).toMatchObject({ status: "no-parent", relayed: [] });
    expect(orphan.fake.sends).toEqual([]);
  });

  it("a bound Worker delivers through bm_report: nothing is relayed; template echoes and other agents neither", async () => {
    const bound = setup({ bound: true });
    expect(await bound.relay(bound.turn([REPORT_RECEIVED]))).toMatchObject({ status: "not-unbound-worker" });
    expect(bound.fake.sends).toEqual([]);

    const { home, relay, turn } = setup();
    const echo = ["BM-REPORT", "requestId: <requestId>", "phase: received | beads-done | blocked | finished | stopped"].join("\n");
    expect(await relay(turn([echo]))).toMatchObject({ status: "done", relayed: [] });
    const manager = { ...turn([REPORT_RECEIVED]), agent: { ...turn([]).agent, id: MANAGER, provider: "bm-manager/claude-haiku-4-5" } };
    expect(await relay(manager)).toMatchObject({ status: "not-unbound-worker" });
    expect(reports(home)).toEqual([]);
  });

  it("reads streamed and fenced blocks, and the questions of a blocked report only", () => {
    const timeline = [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Here:\n```\nBM-REPORT\nrequestId: " },
      { type: "assistant_message", text: `${REQ}\nphase: received\ntier: Small\n\`\`\`` },
    ];
    expect(writtenReportsOf(timeline)).toEqual([{ requestId: REQ, phase: "received", text: expect.stringMatching(/^BM-REPORT\nrequestId: req-/), questions: null }]);
    expect(handSentReportKeysOf([{ type: "user_message", text: "go" }, { type: "tool_call", name: "paseo.send_agent_prompt", input: { prompt: REPORT_FINISHED } }])).toEqual(
      new Set([`${REQ}|finished`]),
    );
  });
});

describe("a relayed stopped report after a Paseo cut (design §7.17.8 g)", () => {
  const REPORT_STOPPED = [`BM-REPORT`, `requestId: ${REQ}`, `phase: stopped`, `tier: Small (changed: no)`, `buildAndTests: not run`, `blockers: none`].join("\n");

  it("carries the note line when the turn followed a Paseo cut, once; not after the owner's message, and never on another phase", async () => {
    const cutAt = Date.parse("2026-10-03T10:04:00.000Z");
    const watch = createInterruptionWatch({ now: () => cutAt + 1_500, setTimer: () => undefined });
    watch.turnRecorded({ agentId: WORKER, role: "worker", outcome: "canceled", startedAt: "2026-10-03T10:00:00.000Z", endedAt: new Date(cutAt).toISOString(), sent: [] } as unknown as TraceRecord, undefined);
    watch.turnStarted(WORKER);

    const { home, fake, relay, turn } = setup();
    // The turn's opening message is the agent's (no clientMessageId): Paseo's delivery, not the owner.
    const event = turn([REPORT_STOPPED]);
    expect((await relay(event)).relayed).toHaveLength(1);
    const [stopped] = reports(home);
    expect(stopped!.text).toBe(`${REPORT_STOPPED}\n\n${CUT_NOTE_LINE}`);
    expect(fake.sends).toEqual([{ id: MANAGER, text: `BM-DELIVERY report ${stopped!.id}\n${REPORT_STOPPED}\n\n${CUT_NOTE_LINE}` }]);
    // Read again: relayed once.
    expect(await relay(event)).toMatchObject({ relayed: [], skipped: 1 });
    // Another phase in the same turn carries no note.
    const other = setup();
    await other.relay(other.turn([REPORT_RECEIVED]));
    expect(reports(other.home)[0]!.text).toBe(REPORT_RECEIVED);

    // The owner typed the message that opened the turn: their stop, no note.
    const owner = setup();
    const typed = { ...owner.turn([REPORT_STOPPED]), timeline: [{ type: "user_message", text: "Stop.", clientMessageId: "m-1" }, { type: "assistant_message", text: REPORT_STOPPED }] };
    await owner.relay(typed);
    expect(reports(owner.home)[0]!.text).toBe(REPORT_STOPPED);
  });
});
