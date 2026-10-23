import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createQuestionDecisionDelivery, soleWorkerOfRequest } from "../plugin/server/decision-delivery";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createDeliveringTools } from "../plugin/server/deliver-tools";
import { clearRequestIndexCache } from "../plugin/server/mission-roster";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { rolloverCrossingOf, rolloverFiguresOf, rolloverTurnRecorded } from "../plugin/server/rollover";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { answerDecision } from "../plugin/shared/decisions";
import { report, turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { WORKER_CALLER } from "./helpers/bindings";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * Size rollover (delivery line design §2.6, §2.7): one `BM-ROLLOVER soft` per
 * request at a figure, `BM-ROLLOVER now` at `ceilingFactor` × one; a
 * `finished` with `remaining` after either opens a size continuation, which
 * the Main's delivery names; at the hard figure the request's questions and
 * links carry over. Temporary data folders and the one fake daemon only.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T12:00:00.000Z");
const BRIEF = [`BM-BRIEF worker requestId: ${REQ}`, "The owner's request, verbatim:", "> Export the orders.", ">", "> As CSV.", "", `requestId: ${REQ}`].join("\n");

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearBeadsCache();
  clearJsonFileCache();
  forgetModes();
  removeDataFolders();
});

function setup() {
  const home = dataFolder();
  const repo = join(dirname(home), "repo");
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const store: BindingStore = createBindingStore(home);
  const worker: FakeAgent = { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, cwd: repo, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } };
  const fake = fakePaseo({
    agents: [{ id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, cwd: repo, labels: { "bm.role": "manager" } }, worker],
    workspaces: [{ id: WS, directory: repo }],
    timelines: { [WORKER]: [{ item: { type: "user_message", text: BRIEF } }] },
    config: {
      agentProfiles: [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }],
      providers: { "bm-worker": { extends: "claude" }, "bm-manager": { extends: "claude" } },
      mcp: { injectIntoAgents: true },
    },
    created: (request: FakeCreateRequest) => {
      applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "claude");
      return {};
    },
  });
  const logs: string[] = [];
  let n = 0;
  const queue = createNoticeQueue({ log: () => {} });
  const tools = createDeliveringTools({
    paseo: () => fake.paseo,
    home: () => home,
    log: (line) => logs.push(line),
    now: () => T0,
    queue,
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    binder: () => binderOf(ROLE_URL, store, (line) => logs.push(line)),
  });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  const finish = (input: Record<string, unknown> = {}) =>
    tools.worker.call("bm_report", { requestId: REQ, phase: "finished", tier: { level: "Medium" }, buildAndTests: "`npm test` pass", ...input }, WORKER_CALLER);
  const asked = (level: "soft" | "now") => createRequestRegistry(home).noteRolloverAsked(WS, REQ, { level, figure: level === "soft" ? "10 turns" : "20 turns", at: T0.toISOString() });
  return { home, repo, fake, logs, queue, finish, asked };
}

describe("the rollover figures and notices (delivery line design §2.6)", () => {
  it("counts beads closed in the request's reports, its Worker turns and its tokens; soft at a figure, now at ceilingFactor × one, nothing while off", () => {
    const records = [
      turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t1", reports: [report({ requestId: REQ, beadsClosed: ["bd-1", "bd-2"] })] }),
      turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t2", reports: [report({ requestId: REQ, beadsClosed: ["bd-2", "bd-3"] })] }),
      turn({ workspaceId: WS, agentId: "agent-reviewer", role: "reviewer", requestId: REQ, turnId: "t3" }),
      turn({ workspaceId: WS, agentId: "agent-other", role: "worker", requestId: "req-20261003T110000Z", turnId: "t4" }),
    ];
    expect(rolloverFiguresOf(records, REQ)).toEqual({ beads: 3, turns: 2, tokens: 0, context: null });
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(rolloverCrossingOf({ beads: 14, turns: 39, tokens: 49_000_000, context: 249_999 }, settings)).toBeNull();
    expect(rolloverCrossingOf({ beads: 15, turns: 0, tokens: 0, context: null }, settings)).toEqual({ level: "soft", figure: "15 beads closed" });
    expect(rolloverCrossingOf({ beads: 16, turns: 80, tokens: 0, context: null }, settings)).toEqual({ level: "now", figure: "80 turns" });
    expect(rolloverCrossingOf({ beads: 0, turns: 0, tokens: 100_400_000, context: null }, settings)).toEqual({ level: "now", figure: "100M tokens read" });
    expect(rolloverCrossingOf({ beads: 99, turns: 99, tokens: 0, context: 900_000 }, { rollover: { ...settings.rollover, enabled: false } })).toBeNull();
  });

  it("ADR-036 §17.3: the judged turn's own context is a figure — soft at rollover.contextTokens (250k), now at ceilingFactor × it; never a sum over turns", () => {
    const usage = (contextUsed?: number) => ({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, costUsd: null, costBasis: "unavailable" as const, model: "claude-opus-5", pricesUpdatedAt: null, ...(contextUsed === undefined ? {} : { contextUsed }) });
    const t1 = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t1", usage: usage(200_000) });
    const t2 = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t2", usage: usage(180_000) });
    // Two turns at 200k and 180k: the second turn's context is 180k, not 380k.
    expect(rolloverFiguresOf([t1, t2], REQ, t2).context).toBe(180_000);
    expect(rolloverFiguresOf([t1, t2], REQ, turn({ usage: usage() })).context).toBeNull();
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(settings.rollover.contextTokens).toBe(250_000);
    const at = (context: number) => rolloverCrossingOf({ beads: 0, turns: 0, tokens: 0, context }, settings);
    expect(at(249_999)).toBeNull();
    expect(at(250_000)).toEqual({ level: "soft", figure: "context 250k" });
    expect(at(262_400)).toEqual({ level: "soft", figure: "context 262k" });
    expect(at(499_999)).toEqual({ level: "soft", figure: "context 500k" });
    expect(at(500_000)).toEqual({ level: "now", figure: "context 500k" });
    expect(rolloverCrossingOf({ beads: 0, turns: 0, tokens: 0, context: 300_000 }, { rollover: { ...settings.rollover, contextTokens: 100_000, ceilingFactor: 3 } })).toEqual({ level: "now", figure: "context 300k" });
  });

  it("at a recorded Worker turn, BM-ROLLOVER soft at 250k context and now at 500k (ADR-036 §17.3)", async () => {
    const { home } = setup();
    const sent: string[] = [];
    const queue = { enqueue: async (_to: string, _kind: string, text: string) => (sent.push(text), "sent" as const) };
    const location = { tracesDir: join(home, "traces") };
    const turnAt = async (i: number, contextUsed: number) => {
      const record = turn({
        workspaceId: WS,
        agentId: WORKER,
        role: "worker",
        requestId: REQ,
        turnId: `t${i}`,
        at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z`,
        usage: { inputTokens: 10, cachedInputTokens: contextUsed, outputTokens: 10, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null, contextUsed },
      });
      await appendRecord(location, record);
      return rolloverTurnRecorded(home, record, null, { queue, now: () => T0 });
    };
    expect(await turnAt(1, 240_000)).toBeNull();
    expect(await turnAt(2, 262_000)).toBe("soft");
    expect(await turnAt(3, 400_000)).toBeNull();
    expect(await turnAt(4, 510_000)).toBe("now");
    expect(sent.map((text) => text.split("\n").slice(0, 2).join(" | "))).toEqual([
      `BM-ROLLOVER soft | From the paseo-bm plugin, not the owner: request ${REQ} reached context 262k.`,
      `BM-ROLLOVER now | From the paseo-bm plugin, not the owner: request ${REQ} reached context 510k.`,
    ]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "context 510k", at: T0.toISOString() });
  });

  it("queues one BM-ROLLOVER soft per request, then BM-ROLLOVER now at twice the figure, to the request's newest Worker", async () => {
    const { home } = setup();
    createCoordinationStore(home).set({ key: "rollover.turns", value: 10 });
    const sent: Array<{ to: string; kind: string; text: string; first: boolean }> = [];
    const queue = {
      enqueue: async (to: string, kind: string, text: string, _paseo?: unknown, _callbacks?: unknown, options?: { first?: boolean }) => (
        sent.push({ to, kind, text, first: options?.first === true }), "sent" as const
      ),
    };
    const location = { tracesDir: join(home, "traces") };
    const turnAt = async (i: number) => {
      const record = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: `t${i}`, at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z` });
      await appendRecord(location, record);
      return rolloverTurnRecorded(home, record, null, { queue, now: () => T0 });
    };
    const levels: Array<string | null> = [];
    for (let i = 1; i <= 21; i += 1) levels.push(await turnAt(i));
    expect(levels.filter((level) => level !== null)).toEqual(["soft", "now"]);
    expect(levels.indexOf("soft")).toBe(9);
    expect(levels.indexOf("now")).toBe(19);
    // Design §6.6: the hard notice goes ahead of what is queued for the Worker; the soft one in its turn.
    expect(sent.map((entry) => [entry.to, entry.kind, entry.first])).toEqual([
      [WORKER, "BM-ROLLOVER", false],
      [WORKER, "BM-ROLLOVER", true],
    ]);
    expect(sent[0]!.text.split("\n")).toEqual([
      "BM-ROLLOVER soft",
      `From the paseo-bm plugin, not the owner: request ${REQ} reached 10 turns.`,
      "Finish the bead in progress, review as your tier says, and report `finished` with `remaining`; paseo-bm opens the continuation.",
    ]);
    expect(sent[1]!.text.split("\n")).toEqual([
      "BM-ROLLOVER now",
      `From the paseo-bm plugin, not the owner: request ${REQ} reached 20 turns.`,
      "Report `finished` with `remaining` at the end of this turn; put the work in progress in `remaining`.",
    ]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "20 turns", at: T0.toISOString() });
    // A Reviewer's turn, and an older Worker of the request, are never asked.
    expect(await rolloverTurnRecorded(home, turn({ workspaceId: WS, agentId: "agent-reviewer", role: "reviewer", requestId: REQ }), null, { queue })).toBeNull();
  });
});

describe("BM-ROLLOVER soft and the gate at the send (delivery line design §6.4)", () => {
  it("queued while the Worker ran, it is held when that turn reported blocked, forgotten, and asked again once the Worker waits on nothing", async () => {
    const { home } = setup();
    createCoordinationStore(home).set({ key: "rollover.turns", value: 10 });
    const fake = fakePaseo({ agents: [{ id: WORKER, provider: "bm-worker/claude-opus-5", status: "running", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ } }] });
    const queue = createNoticeQueue({ log: () => {} });
    const turnOf = (i: number) => turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: `t${i}`, at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z` });
    for (let i = 1; i <= 10; i += 1) await appendRecord({ tracesDir: join(home, "traces") }, turnOf(i));
    const record = turnOf(10);
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBe("soft");
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked?.level).toBe("soft");
    // The running turn reports `blocked` on Q1.
    createRequestRegistry(home).setWaiting(WS, REQ, { since: T0.toISOString(), reportRecordId: "out-0000000000ff", wakeOn: "all", items: [{ kind: "question", id: `q:${REQ}:Q1`, settled: false }] });
    fake.byId(WORKER)!.status = "idle";
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toBeUndefined();
    // Still waiting: not asked; once the wait is gone, asked again.
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBeNull();
    createRequestRegistry(home).setWaiting(WS, REQ, null);
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBe("soft");
    expect(fake.sends.map((send) => send.text.split("\n")[0])).toEqual(["BM-ROLLOVER soft"]);
  });
});

describe("a finished with remaining after a rollover notice opens a size continuation (delivery line design §2.4 item 2, §2.6, §2.7)", () => {
  it("at the soft figure: the root's request verbatim and Remaining, the brief's remaining line, the Main's continued line; questions expire as on any finish", async () => {
    const { home, fake, finish, asked } = setup();
    asked("soft");
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q2`, workspaceId: WS, requestId: REQ, question: "Which locale?" }));

    const answer = await finish({ beadsClosed: ["bd-1"], remaining: ["bd-3: the CSV export", "b1 finding: rename the column"] });
    expect(answer.ok, answer.text).toBe(true);

    const registry = createRequestRegistry(home);
    const next = registry.get(WS, REQ)!.continuedBy!;
    expect(registry.get(WS, REQ)).toMatchObject({ rollover: { reason: "size", figure: "10 turns", at: T0.toISOString() } });
    expect(registry.get(WS, REQ)!.finishedAt).not.toBeNull();
    expect(registry.get(WS, next)).toMatchObject({ continuationOf: REQ, chainRootId: REQ, workerIds: ["created-1"], finishedAt: null });

    const lines = fake.creates[0]!.options.prompt!.split("\n");
    expect(lines.slice(0, 10)).toEqual([
      `BM-BRIEF worker requestId: ${next}`,
      "The owner's request, verbatim:",
      "> Export the orders.",
      ">",
      "> As CSV.",
      ">",
      "> Remaining:",
      "> - bd-3: the CSV export",
      "> - b1 finding: rename the column",
      "",
    ]);
    expect(lines).toContain(`continues: ${REQ} (size: 10 turns)`);
    expect(lines).toContain(`${REQ} last reported: finished at ${T0.toISOString()}`);
    expect(lines).toContain("remaining: bd-3: the CSV export; b1 finding: rename the column");

    // §2.7: the Main's delivery of the finished report names the continuation, before the block.
    const delivered = fake.sends.filter((send) => send.id === MANAGER);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text.split("\n").slice(0, 3)).toEqual(["BM-DELIVERY report out-000000000001", `continued: ${next} by Worker created-1 (size: 10 turns)`, "BM-REPORT"]);
    // At the soft figure the Worker settled its questions itself: what is left expires as on any finish.
    expect(createDecisionStore(home).get(`q:${REQ}:Q2`, WS)?.status).not.toBe("open");
  });

  it("at the hard figure: the open question stays, its answer reaches the continuation's Worker, and the request's live links move to it", async () => {
    const { home, fake, finish, asked, queue } = setup();
    asked("now");
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q2`, workspaceId: WS, requestId: REQ, question: "Which locale?", options: [{ key: "a", label: "en", recommended: true, effects: ["none"] }, { key: "b", label: "de", recommended: false, effects: ["none"] }] }));
    const links = createPeerLinkStore(home);
    const taken = links.createLink({ kind: "question", from: { workspaceId: "wks_other", requestId: "req-20261003T090000Z", agentId: "agent-other", role: "worker" }, to: { workspaceId: WS, managerId: MANAGER, requestId: REQ, workerId: WORKER }, text: "What format?" });
    const mine = links.createLink({ kind: "question", from: { workspaceId: WS, requestId: REQ, agentId: WORKER, role: "worker" }, to: { workspaceId: "wks_third", managerId: "agent-third-manager" }, text: "Which schema?" });
    if (!taken.ok || !mine.ok) throw new Error("links not created");

    // No forPeer: the link it answers carries over instead of getting a reply.
    const answer = await finish({ remaining: ["bd-4: the totals, half done"] });
    expect(answer.ok, answer.text).toBe(true);
    const next = createRequestRegistry(home).get(WS, REQ)!.continuedBy!;

    expect(createDecisionStore(home).get(`q:${REQ}:Q2`, WS)?.status).toBe("open");
    expect(createPeerLinkStore(home).get(taken.link.linkId)).toMatchObject({ state: "taken", to: { requestId: next, workerId: "created-1" }, messages: [] });
    expect(createPeerLinkStore(home).get(mine.link.linkId)).toMatchObject({ state: "open", from: { requestId: next, agentId: "created-1" } });
    expect(await soleWorkerOfRequest({ workspaceId: WS, requestId: REQ, home }, fake.paseo as unknown as DashboardPaseo)).toBe("created-1");

    // The owner answers q:A:Q2: the answers go to B's Worker.
    createDecisionStore(home).transition(`q:${REQ}:Q2`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", words: null, at: T0.toISOString() }), WS);
    await createQuestionDecisionDelivery({ home: () => home, now: () => T0, log: () => {}, queue }).resume(fake.paseo);
    const toNext = fake.sends.filter((send) => send.id === "created-1");
    expect(toNext).toHaveLength(1);
    expect(toNext[0]!.text).toContain("Q2: b — de");
  });

  it("a finished with remaining but no rollover notice opens nothing; remaining is only for finished", async () => {
    const { home, fake, finish } = setup();
    const received = await finish({ phase: "received", remaining: ["bd-3"] });
    expect(received.ok).toBe(false);
    expect(received.text).toContain("input.remaining: only a finished report lists what remains; leave it out");
    expect((await finish({ remaining: ["bd-3"] })).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)!.continuedBy).toBeUndefined();
    expect(fake.creates).toEqual([]);
  });

  it("a review batch never crosses requests: finished with a verdict in flight is still refused, and nothing opens", async () => {
    const { home, fake, finish, asked } = setup();
    asked("now");
    createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "call-1", kind: "create", reviewerId: "agent-reviewer", at: T0.toISOString() }, "Review the export.");
    const answer = await finish({ remaining: ["bd-3"] });
    expect(answer).toEqual({ ok: false, text: "a review of batch b1 has no verdict yet: wait for its delivery, then report finished\nNothing was stored or sent." });
    expect(fake.creates).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.finishedAt).toBeNull();
  });
});
