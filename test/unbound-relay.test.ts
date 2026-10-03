import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { handSentReportKeysOf, relayUnboundBlocks, writtenReportsOf } from "../plugin/server/unbound-relay";
import { parseDelivery } from "../plugin/shared/notices";
import type { Decision } from "../plugin/shared/decisions";
import { fakePaseo } from "./helpers/fake-paseo";

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
const roots: string[] = [];

afterEach(() => {
  clearBindingCache();
  clearDecisionStoreCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-unbound-relay-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

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
  if (options.bound === true) {
    const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER });
    store.attach(token, "worker");
    store.settle(tokenSha256, WORKER);
  }
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
