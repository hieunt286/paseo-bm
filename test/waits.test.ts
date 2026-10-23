import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createDeliveringTools, type DeliveringToolDeps } from "../plugin/server/deliver-tools";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { createPeerLinkStore, type PeerLink } from "../plugin/server/peer-links";
import { REQUESTS_DIR_NAME, clearRequestRegistryCache, createRequestRegistry, type RegisteredRequest } from "../plugin/server/request-registry";
import { settleDeadWaitItems, settleLinkWait, settleRequestWaits, settleWaitItem, waitingOf } from "../plugin/server/waits";
import { checkBlocks } from "../plugin/shared/bm-format";
import { parseReports } from "../plugin/shared/bm-report";
import { parsedReportSchema } from "../plugin/shared/contracts";
import { answerDecision, expireDecision, withdrawDecision } from "../plugin/shared/decisions";
import { reportSummaryOf, requestFactOf, requestIdsInText, settleItemsOf, waitMet, waitRefsOf, waitingSchema, type Waiting } from "../plugin/shared/waits";
import { fakePaseo } from "./helpers/fake-paseo";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { WORKER_CALLER } from "./helpers/bindings";

/**
 * Structured waits (delivery line design §6.2, §6.3; WP-7.4): a bound
 * Worker's blocked report names what it waits on by id, the registry keeps it
 * as `waiting`, and each kind of item is settled by its own hook.
 */

const WS = "wks_1";
const BACK = "wks_back";
const REQ = "req-20261003T100000Z";
const OTHER = "req-20261003T110000Z";
const NEXT = "req-20261003T120000Z";
const REQ_BACK = "req-20261003T090000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const WORKER_2 = "agent-worker-2";
const T0 = new Date("2026-10-03T10:05:00.000Z");
const AT = T0.toISOString();

afterEach(() => {
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearJsonFileCache();
  removeDataFolders();
});

const AGENTS = [
  { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
  { id: WORKER_2, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": OTHER, "paseo.parent-agent-id": MANAGER } },
  { id: "mgr-back", provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: BACK, labels: { "bm.role": "manager" } },
  { id: "wrk-back", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: BACK, labels: { "bm.role": "worker", "bm.requestId": REQ_BACK, "paseo.parent-agent-id": "mgr-back" } },
];
const WORKER_2_CALLER: ToolCaller = { ...WORKER_CALLER, agentId: WORKER_2, requestId: OTHER };
const BACK_CALLER: ToolCaller = { agentId: "wrk-back", role: "worker", workspaceId: BACK, requestId: REQ_BACK, parentId: "mgr-back", batchId: null };

function setup() {
  const home = dataFolder();
  const fake = fakePaseo({ agents: AGENTS });
  let clock = T0;
  let n = 0;
  const deps: DeliveringToolDeps = {
    paseo: () => fake.paseo,
    home: () => home,
    log: () => {},
    now: () => clock,
    queue: createNoticeQueue({ log: () => {} }),
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    turnStartOf: () => T0.toISOString(),
    stopReviewers: async () => {},
  };
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  registry.register(WS, OTHER, { source: "tool", managerId: MANAGER, workerId: WORKER_2 });
  const idle = () => {
    for (const agent of [MANAGER, "mgr-back"]) fake.byId(agent)!.status = "idle";
  };
  return { home, fake, tools: createDeliveringTools(deps), tick: (ms: number) => (clock = new Date(clock.getTime() + ms)), idle };
}

const REPORT = { requestId: REQ, phase: "blocked", tier: { level: "Medium" }, buildAndTests: "not run" };
const QUESTION = { text: "Which table?", subject: "user-list-storage", class: "data", options: [{ key: "a", text: "users", effects: ["none"], recommended: true }, { key: "b", text: "accounts", effects: ["none"] }] };
const parsed = (answer: { text: string }) => JSON.parse(answer.text) as unknown;
/** The wake a met wait's release sends the Worker (design §6.4): its facts block. */
/** Lets the release the report started (not awaited) reach the Worker. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const wake = (...facts: string[]) => ["BM-DELIVERY wait", `Continue ${REQ}: what you waited on is settled.`, ...facts].join("\n");

/** Writes one workspace's registry file as it is stored. */
function writeRegistry(home: string, workspaceId: string, requests: Array<Partial<RegisteredRequest> & { requestId: string }>): void {
  mkdirSync(join(home, REQUESTS_DIR_NAME), { recursive: true, mode: 0o700 });
  const full = requests.map((request) => ({ workspaceId, createdAt: AT, source: "tool", managerId: MANAGER, workerIds: [], tier: null, finishedAt: null, reviews: { batches: [], grants: [] }, ...request }));
  writeFileSync(join(home, REQUESTS_DIR_NAME, `${workspaceId}.json`), JSON.stringify({ schemaVersion: 1, requests: full }), { mode: 0o600 });
  clearRequestRegistryCache();
}

const waiting = (items: Waiting["items"], wakeOn: Waiting["wakeOn"] = "all"): Waiting => ({ since: AT, reportRecordId: "out-000000000001", wakeOn, items });

// ---------------------------------------------------------------------------
// The pure rules (design §6.2).
// ---------------------------------------------------------------------------

describe("a structured wait's rules (design §6.2)", () => {
  it("names each item once, questions, requests, batches, then links", () => {
    expect(waitRefsOf({ waitingOnPeers: ["peer-0000000000a1"], waitingOn: [`q:${REQ}:Q1`, `q:${REQ}:Q1`], waitingOnBatches: ["b2"], waitingOnRequests: [OTHER] })).toEqual([
      { kind: "question", id: `q:${REQ}:Q1` },
      { kind: "request", id: OTHER },
      { kind: "batch", id: "b2" },
      { kind: "link", id: "peer-0000000000a1" },
    ]);
  });

  it("wakeOn all is met when every item is settled, any at the first; a wait with no items holds nothing", () => {
    const one = { kind: "request" as const, id: OTHER, settled: true };
    const two = { kind: "batch" as const, id: "b1", settled: false };
    expect(waitMet(waiting([one, two]))).toBe(false);
    expect(waitMet(waiting([one, two], "any"))).toBe(true);
    expect(waitMet(waiting([{ ...two }], "any"))).toBe(false);
    expect(waitMet(waiting([one, { ...two, settled: true }]))).toBe(true);
    expect(waitMet(waiting([]))).toBe(true);
  });

  it("settles only unsettled matching items, with their fact cut to one line; nothing matched is null", () => {
    const before = waiting([{ kind: "request", id: OTHER, settled: false }, { kind: "batch", id: "b1", settled: false }]);
    const after = settleItemsOf(before, (item) => item.kind === "request", { at: AT, fact: `${OTHER} finished:\n${"x".repeat(400)}` })!;
    expect(after.items[0]).toMatchObject({ settled: true, settledAt: AT });
    expect(after.items[0]!.fact).toHaveLength(300);
    expect(after.items[0]!.fact).not.toContain("\n");
    expect(after.items[1]).toEqual({ kind: "batch", id: "b1", settled: false });
    expect(settleItemsOf(after, (item) => item.kind === "request", { at: AT })).toBeNull();
  });

  it("finds the req- ids of free text, each once, without the Worker's own", () => {
    expect(requestIdsInText(`${OTHER} (Worker w2) to merge, then ${REQ} and ${OTHER} again`, REQ)).toEqual([OTHER]);
    expect(requestIdsInText(undefined)).toEqual([]);
  });

  it("states a settled request's fact, through its chain's head when that is another", () => {
    expect(requestFactOf(OTHER, "finished", "build and tests: npm test pass")).toBe(`${OTHER} finished: build and tests: npm test pass`);
    expect(requestFactOf(OTHER, "finished", null, NEXT)).toBe(`${OTHER} finished as ${NEXT}`);
    expect(reportSummaryOf("finished", { buildAndTests: "npm test pass", filesChanged: ["a.ts", "b.ts"] })).toBe("build and tests: npm test pass; files: a.ts, b.ts");
    expect(reportSummaryOf("finished", { forPeer: "GET /api/orders is live", buildAndTests: "pass" })).toBe("GET /api/orders is live");
    expect(reportSummaryOf("stopped", {})).toBeNull();
  });

  it("an older registry entry and an older report keep their shapes; a stored wait parses", () => {
    expect(waitingSchema.parse(waiting([{ kind: "link", id: "peer-0000000000a1", settled: true, settledAt: AT, fact: "peer-0000000000a1 answered: yes" }]))).toBeTruthy();
    const old = parseReports(`BM-REPORT\nrequestId: ${REQ}\nphase: blocked\nblockers: waiting for: ${OTHER}`, { agentId: WORKER, at: AT })[0]!;
    expect(old).not.toHaveProperty("waitingOnRequests");
    expect(old).not.toHaveProperty("wakeOn");
    expect(parsedReportSchema.parse(old)).toEqual(old);
  });
});

// ---------------------------------------------------------------------------
// The report sets and clears the wait (design §6.2).
// ---------------------------------------------------------------------------

describe("bm_report blocked sets the registry's waiting; any other report clears it (design §6.2)", () => {
  it("writes the waits into blockers, parses them back, and stores the items with the req- id of waitingFor promoted", async () => {
    const { home, tools } = setup();
    createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "c1", kind: "create", reviewerId: "agent-reviewer", at: AT }, "brief");
    const [q1] = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION] }, WORKER_CALLER)) as Array<{ decisionId: string }>;
    const result = await tools.worker.call(
      "bm_report",
      { ...REPORT, waitingOn: [q1!.decisionId], waitingOnRequests: [OTHER], waitingOnBatches: ["b1"], waitingFor: `${NEXT} and ${OTHER}; ${REQ_BACK} is unknown`, wakeOn: "any" },
      WORKER_CALLER,
    );
    expect(result.ok, result.text).toBe(true);
    const record = createOutbox(home).list(WS).find((entry) => entry.kind === "report")!;
    expect(record.text).toContain(`blockers: waiting on the owner: Q1. waiting on requests: ${OTHER}. waiting on review: b1. waiting for: ${NEXT} and ${OTHER}; ${REQ_BACK} is unknown. wake on: any`);
    expect(checkBlocks(record.text).flatMap((block) => block.issues)).toEqual([]);
    expect(parseReports(record.text, { agentId: WORKER, at: AT })[0]).toMatchObject({ waitingOnRequests: [OTHER], waitingOnBatches: ["b1"], wakeOn: "any" });
    // NEXT and REQ_BACK are not registered: they stay text; OTHER is named once.
    expect(waitingOf(home, WS, REQ)).toEqual({
      since: AT,
      reportRecordId: record.id,
      wakeOn: "any",
      items: [
        { kind: "question", id: q1!.decisionId, settled: false },
        { kind: "request", id: OTHER, settled: false },
        { kind: "batch", id: "b1", settled: false },
      ],
    });
  });

  it("promotes a known req- id of waitingFor alone, and a later report clears the wait", async () => {
    const { home, tools, idle } = setup();
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingFor: `the API of ${OTHER}` }, WORKER_CALLER)).ok).toBe(true);
    expect(waitingOf(home, WS, REQ)).toMatchObject({ wakeOn: "all", items: [{ kind: "request", id: OTHER, settled: false }] });
    idle();
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done" }, WORKER_CALLER)).ok).toBe(true);
    expect(waitingOf(home, WS, REQ)).toBeNull();
    expect(createRequestRegistry(home).get(WS, REQ)).not.toHaveProperty("waiting");
  });

  it("a text-only wait stores no items, and an awaited request already finished is settled at once: the wait is met, so the Worker is woken with its fact (design §6.4)", async () => {
    const { home, fake, tools, idle } = setup();
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingFor: "the owner's designer" }, WORKER_CALLER)).ok).toBe(true);
    expect(waitingOf(home, WS, REQ)!.items).toEqual([]);
    createRequestRegistry(home).noteReport(WS, OTHER, { tier: "Small", phase: "finished", at: AT });
    idle();
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingOnRequests: [OTHER] }, WORKER_CALLER)).ok).toBe(true);
    // The wake cleared the met wait; its fact went to the Worker.
    await flush();
    expect(waitingOf(home, WS, REQ)).toBeNull();
    expect(fake.sends.filter((send) => send.id === WORKER).map((send) => send.text)).toEqual([wake(`${OTHER} finished`)]);
  });

  it("refuses an unknown request, its own request, a batch whose verdict is not owed, and the new fields outside blocked; nothing is stored", async () => {
    const { home, tools } = setup();
    const refusals = [
      [{ ...REPORT, waitingOnRequests: [NEXT] }, `input.waitingOnRequests: ${NEXT} is not a request paseo-bm knows; name it in waitingFor, or leave it out`],
      [{ ...REPORT, waitingOnRequests: [REQ] }, `input.waitingOnRequests[0]: ${REQ} is your own request`],
      [{ ...REPORT, waitingOnBatches: ["b3"] }, "input.waitingOnBatches: batch b3 has no review awaiting its verdict; leave it out"],
      [{ ...REPORT, phase: "beads-done", waitingOnRequests: [OTHER] }, "input.waitingOnRequests: only a blocked report waits; leave it out"],
      [{ ...REPORT, phase: "beads-done", wakeOn: "any" }, "input.wakeOn: only a blocked report waits; leave it out"],
    ] as const;
    for (const [input, line] of refusals) {
      const result = await tools.worker.call("bm_report", input, WORKER_CALLER);
      expect(result.ok, line).toBe(false);
      expect(result.text).toContain(line);
    }
    expect(createOutbox(home).list(WS)).toEqual([]);
    expect(waitingOf(home, WS, REQ)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What settles each kind of item (design §6.3).
// ---------------------------------------------------------------------------

describe("what settles an item (design §6.3)", () => {
  it("question: its decision answered, expired or withdrawn, in the decision store's transition", async () => {
    const { home, tools } = setup();
    const asked = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION, { ...QUESTION, text: "Which column?", subject: "user-list-column" }, { ...QUESTION, text: "Which index?", subject: "user-list-index" }] }, WORKER_CALLER)) as Array<{ decisionId: string }>;
    const ids = asked.map((entry) => entry.decisionId);
    const blocked = await tools.worker.call("bm_report", { ...REPORT, waitingOn: ids }, WORKER_CALLER);
    expect(blocked.ok, `${JSON.stringify(asked)} ${blocked.text}`).toBe(true);
    const store = createDecisionStore(home);
    expect(store.transition(ids[0]!, (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: AT }), WS).status).toBe("updated");
    expect(waitingOf(home, WS, REQ)!.items.map((item) => item.settled)).toEqual([true, false, false]);
    store.transition(ids[1]!, (decision) => expireDecision(decision, { at: AT }), WS);
    store.transition(ids[2]!, (decision) => withdrawDecision(decision, { at: AT }), WS);
    const wait = waitingOf(home, WS, REQ)!;
    expect(wait.items.every((item) => item.settled && item.settledAt === AT && item.fact === undefined)).toBe(true);
    expect(waitMet(wait)).toBe(true);
  });

  it("batch: a review or a no-verdict record of it, in outbox add", async () => {
    const { home, tools } = setup();
    const registry = createRequestRegistry(home);
    registry.addReviewCall(WS, REQ, "b1", { callId: "c1", kind: "create", reviewerId: "agent-reviewer", at: AT }, "brief");
    registry.addReviewCall(WS, REQ, "b2", { callId: "c2", kind: "create", reviewerId: "agent-reviewer-2", at: AT }, "brief");
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingOnBatches: ["b1", "b2"] }, WORKER_CALLER)).ok).toBe(true);
    const outbox = createOutbox(home);
    outbox.add(WS, { kind: "message", requestId: REQ, from: MANAGER, to: WORKER, text: "unrelated" });
    expect(waitingOf(home, WS, REQ)!.items.map((item) => item.settled)).toEqual([false, false]);
    outbox.add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: "agent-reviewer", to: WORKER, text: "BM-REVIEW\nverdict: approve" });
    expect(waitingOf(home, WS, REQ)!.items.map((item) => item.settled)).toEqual([true, false]);
    outbox.add(WS, { kind: "no-verdict", requestId: REQ, batchId: "b2", from: "agent-reviewer-2", to: WORKER, text: "no verdict" }, "the Reviewer turn was canceled");
    expect(waitMet(waitingOf(home, WS, REQ)!)).toBe(true);
  });

  it("request: it reports finished, with its fact; stopped too; another request's wait on it settles, its own stays", async () => {
    const { home, fake, tools, idle, tick } = setup();
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingOnRequests: [OTHER] }, WORKER_CALLER)).ok).toBe(true);
    tick(60_000);
    const finished = { ...REPORT, requestId: OTHER, phase: "finished", buildAndTests: "npm test pass", filesChanged: ["api.ts"] };
    expect((await tools.worker.call("bm_report", finished, WORKER_2_CALLER)).ok).toBe(true);
    // Met, so released (design §6.4): the wait is cleared and the Worker woken with the fact.
    await flush();
    expect(waitingOf(home, WS, REQ)).toBeNull();
    expect(fake.sends.filter((send) => send.id === WORKER).map((send) => send.text)).toEqual([wake(`${OTHER} finished: build and tests: npm test pass; files: api.ts`)]);

    // Stopped settles as well, with its blockers.
    writeRegistry(home, WS, [
      { requestId: REQ, workerIds: [WORKER], waiting: waiting([{ kind: "request", id: OTHER, settled: false }]) },
      { requestId: OTHER, workerIds: [WORKER_2] },
    ]);
    idle();
    fake.byId(WORKER)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...REPORT, requestId: OTHER, phase: "stopped", blockers: "the owner stopped it" }, WORKER_2_CALLER)).ok).toBe(true);
    await flush();
    expect(waitingOf(home, WS, REQ)).toBeNull();
    expect(fake.sends.filter((send) => send.id === WORKER).at(-1)?.text).toBe(wake(`${OTHER} stopped: the owner stopped it`));
  });

  it("request: the head of its chain finishing settles a wait on a request it continues; a wait elsewhere on another id stays", () => {
    const home = dataFolder();
    writeRegistry(home, WS, [
      { requestId: OTHER, finishedAt: AT, continuedBy: NEXT },
      { requestId: NEXT, continuationOf: OTHER, chainRootId: OTHER },
      { requestId: REQ, waiting: waiting([{ kind: "request", id: OTHER, settled: false }]) },
    ]);
    writeRegistry(home, BACK, [{ requestId: REQ_BACK, waiting: waiting([{ kind: "request", id: REQ, settled: false }]) }]);
    const changed = settleRequestWaits(home, WS, NEXT, "finished", "done", AT, () => {});
    expect(changed).toEqual([{ workspaceId: WS, requestId: REQ, met: true, waiting: expect.objectContaining({ items: [{ kind: "request", id: OTHER, settled: true, settledAt: AT, fact: `${OTHER} finished as ${NEXT}: done` }] }) }]);
    expect(waitingOf(home, BACK, REQ_BACK)!.items[0]!.settled).toBe(false);
  });

  it("link: a word or reply from the answering side, or the link closed; the asker's own word settles nothing", async () => {
    const { home, tools, idle } = setup();
    const links = createPeerLinkStore(home, { newId: () => "peer-0000000000a1", now: () => T0 });
    const asked = links.createLink({ kind: "question", from: { workspaceId: WS, requestId: REQ, agentId: WORKER, role: "worker" }, to: { workspaceId: BACK, managerId: "mgr-back" }, text: "Which date format?" });
    expect(asked.ok).toBe(true);
    links.takeLink("peer-0000000000a1", { workspaceId: BACK, requestId: REQ_BACK, workerId: "wrk-back" });
    createRequestRegistry(home, { backfill: () => [] }).register(BACK, REQ_BACK, { source: "tool", managerId: "mgr-back", workerId: "wrk-back" });
    expect((await tools.worker.call("bm_report", { ...REPORT, waitingOnPeers: ["peer-0000000000a1"] }, WORKER_CALLER)).ok).toBe(true);
    const link = links.get("peer-0000000000a1")!;
    expect(settleLinkWait(home, link, { kind: "message", side: "asker", text: "any news?" }, AT, () => {})).toEqual([]);
    expect(waitingOf(home, WS, REQ)!.items[0]!.settled).toBe(false);

    // The answering Worker's finished report replies on the link: the asker's wait settles with the reply.
    idle();
    const reply = await tools.worker.call("bm_report", { ...REPORT, requestId: REQ_BACK, phase: "finished", forPeer: "ISO 8601, UTC." }, BACK_CALLER);
    expect(reply.ok, reply.text).toBe(true);
    expect(waitingOf(home, WS, REQ)!.items[0]).toMatchObject({ kind: "link", settled: true, fact: "peer-0000000000a1 answered: ISO 8601, UTC." });

    // Closed by the answering side.
    writeRegistry(home, WS, [{ requestId: REQ, waiting: waiting([{ kind: "link", id: "peer-0000000000a1", settled: false }]) }]);
    expect(settleLinkWait(home, link, { kind: "closed", by: "answerer" }, AT, () => {})[0]).toMatchObject({ met: true, waiting: { items: [{ fact: "peer-0000000000a1 closed by the answering side" }] } });
  });

  it("the stall pass: a link past its ceiling or closed, and a request whose Worker is gone or whose chain finished, settle as facts", () => {
    const home = dataFolder();
    writeRegistry(home, WS, [
      { requestId: OTHER, workerIds: [WORKER_2] },
      { requestId: NEXT, workerIds: ["agent-w3"], finishedAt: AT },
      {
        requestId: REQ,
        waiting: waiting([
          { kind: "request", id: OTHER, settled: false },
          { kind: "request", id: NEXT, settled: false },
          { kind: "link", id: "peer-0000000000a1", settled: false },
          { kind: "link", id: "peer-0000000000b1", settled: false },
          { kind: "question", id: `q:${REQ}:Q1`, settled: false },
        ]),
      },
    ]);
    const link = (linkId: string, state: PeerLink["state"]) => ({ linkId, state, closedBy: state === "closed" ? "answerer" : null, from: { workspaceId: WS, requestId: REQ } }) as unknown as PeerLink;
    const facts = {
      links: [link("peer-0000000000a1", "taken"), link("peer-0000000000b1", "closed")],
      ceilingOf: (entry: PeerLink) => (entry.linkId === "peer-0000000000a1" ? "peer-0000000000a1: no word from project wks_back for 2 hours" : null),
      isLive: () => false,
    };
    const [changed] = settleDeadWaitItems(home, facts, AT, () => {});
    expect(changed!.met).toBe(false);
    expect(changed!.waiting.items.map((item) => [item.id, item.settled, item.fact])).toEqual([
      [OTHER, true, `${OTHER} has no live Worker left`],
      [NEXT, true, `${NEXT} finished`],
      ["peer-0000000000a1", true, "peer-0000000000a1: no word from project wks_back for 2 hours"],
      ["peer-0000000000b1", true, "peer-0000000000b1 closed by the answering side"],
      [`q:${REQ}:Q1`, false, undefined],
    ]);
    // A live Worker and a link within its ceiling settle nothing; nothing settles twice.
    expect(settleDeadWaitItems(home, { ...facts, isLive: () => true }, AT, () => {})).toEqual([]);
  });

  it("settleWaitItem reaches every wait naming the item when no request is given, and reports whether each is met", () => {
    const home = dataFolder();
    writeRegistry(home, WS, [
      { requestId: REQ, waiting: waiting([{ kind: "request", id: REQ_BACK, settled: false }, { kind: "batch", id: "b1", settled: false }], "any") },
      { requestId: OTHER, waiting: waiting([{ kind: "request", id: REQ_BACK, settled: false }, { kind: "batch", id: "b1", settled: false }]) },
    ]);
    const changed = settleWaitItem(home, { kind: "request", id: REQ_BACK }, { at: AT, fact: `${REQ_BACK} finished` }, null, () => {});
    expect(changed.map((entry) => [entry.requestId, entry.met])).toEqual([
      [REQ, true],
      [OTHER, false],
    ]);
  });
});
