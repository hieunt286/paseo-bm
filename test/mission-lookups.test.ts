import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { clearRequestIndexCache, createMissionRoster, missionManagerOf } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { reconstructTraces, type AgentFacts } from "../plugin/server/traces";
import { workspaceTracesOf } from "../plugin/server/request-trace";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "../plugin/server/review-budget";
import { createBudgetTold } from "../plugin/server/budget-told";
import { stateBriefOf } from "../plugin/server/compaction";
import { relayUnboundBlocks } from "../plugin/server/unbound-relay";
import { createBindingStore } from "../plugin/server/agent-bindings";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { recordIncident } from "../plugin/server/fallback-state";
import { peersOfWorkspace } from "../plugin/server/chat-peers";
import { listWorkspaceAgents, type AgentDirectoryPaseo } from "../plugin/server/manager";
import { OUTDATED_MAIN_DETAIL, outdatedAgentAlertOf, outdatedAgentOf } from "../plugin/server/outdated-agents";
import { buildRecord } from "../plugin/server/collector";
import { toChatCards } from "../plugin/client/chat-card-parse";
import { linkIntroText, missionAskText } from "../plugin/server/peer-tools";
import { TRACE_STORE_SCHEMA_VERSION, type ParsedReport, type TraceRecord } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * Missions design §6 and §3.4 step 4: the Main-side lookups find a request's
 * Main through the request index and the registry, wherever the Main lives;
 * a request without a mission is read as before. Temporary data folders only.
 */

const MISSION = "mis-00000000a1";
const HOME_WS = "wks_home";
const REPO = "wks_repo";
const LOCAL = "wks_local";
const REQ = "req-20261009T100000Z";
const OTHER = "req-20261009T110000Z";
const MAIN = "agent-main";
const OLD_MAIN = "agent-main-old";
const WORKER = "agent-worker";
const T0 = "2026-10-09T10:00:00.000Z";

afterEach(() => {
  clearJsonFileCache();
  clearRequestIndexCache();
  clearRequestRegistryCache();
  removeDataFolders();
});

/** A data folder whose mission holds REQ in REPO, its registry entry naming MAIN and WORKER. */
function missionHome(): string {
  const home = dataFolder();
  createMissionRoster(home, { now: () => new Date(T0) }).add(MISSION, { requestId: REQ, workspaceId: REPO, topic: "Export the contacts", workerId: WORKER });
  createRequestRegistry(home, { now: () => new Date(T0), backfill: () => [] }).register(REPO, REQ, { source: "tool", managerId: MAIN, workerId: WORKER });
  return home;
}

const facts = (overrides: Partial<AgentFacts> & { id: string }): AgentFacts => ({
  role: "worker",
  status: "idle",
  parentAgentId: OLD_MAIN,
  createdAt: "2026-10-09T10:01:00.000Z",
  requestIdLabel: REQ,
  batchIdLabel: null,
  archived: false,
  ...overrides,
});

const report = (requestId: string, phase: string, at: string): ParsedReport => ({
  agentId: WORKER,
  at,
  requestId,
  phase: phase as ParsedReport["phase"],
  tier: "Small",
  filesChanged: [],
  beadsCreated: [],
  beadsUpdated: [],
  beadsClosed: [],
  beadsReady: ["bd-2"],
  reviewFindingsOpen: null,
  buildAndTests: null,
  decided: [],
  blockers: null,
  guardrail: null,
  unparsedFields: [],
  incompleteFields: [],
  skillsUsed: [],
});

const turn = (overrides: Partial<TraceRecord>): TraceRecord => ({
  v: TRACE_STORE_SCHEMA_VERSION,
  kind: "turn",
  at: "2026-10-09T10:05:00.000Z",
  workspaceId: REPO,
  agentId: WORKER,
  role: "worker",
  turnId: "t1",
  requestId: REQ,
  parentAgentId: OLD_MAIN,
  agentCreatedAt: null,
  startedAt: null,
  endedAt: "2026-10-09T10:05:00.000Z",
  outcome: "completed",
  sent: [],
  received: [],
  reports: [],
  reviews: [],
  evidence: [],
  usage: null,
  ...overrides,
});

describe("missionManagerOf (§3.4 step 4)", () => {
  it("names the registry's Manager of a mission's request, and nothing for a request of no mission", () => {
    const home = missionHome();
    createRequestRegistry(home, { backfill: () => [] }).register(LOCAL, OTHER, { source: "tool", managerId: "agent-local" });
    expect(missionManagerOf(home, REQ)).toBe(MAIN);
    expect(missionManagerOf(home, OTHER)).toBeNull();
    expect(missionManagerOf(home, null)).toBeNull();
    expect(missionManagerOf(null, REQ)).toBeNull();
  });
});

describe("traces of a mission's request in its repo (§6)", () => {
  it("open from the registry with its Main and topic, and take its Worker and records", () => {
    const traces = reconstructTraces({
      records: [turn({ reports: [report(REQ, "received", "2026-10-09T10:05:00.000Z")] })],
      agents: [facts({ id: WORKER })],
      requests: [{ requestId: REQ, workerIds: [WORKER], reviews: { batches: [] }, missionId: MISSION, managerId: MAIN, createdAt: T0, topic: "Export the contacts" }],
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ requestId: REQ, managerAgentId: MAIN, requestText: "Export the contacts", requestedAt: T0, workerIds: [WORKER], linking: "exact" });
    expect(traces[0]!.reports.map((entry) => entry.phase)).toEqual(["received"]);
  });

  it("a Main's own turns in the repo (a one-repo mission) keep their row, with the registry's current Main", () => {
    const manager = turn({ agentId: OLD_MAIN, role: "manager", parentAgentId: null, at: "2026-10-09T10:00:30.000Z", sent: [{ agentId: OLD_MAIN, at: T0, text: "Export the contacts.", truncated: false, origin: "user" }] });
    const [trace] = reconstructTraces({
      records: [manager],
      agents: [facts({ id: WORKER })],
      requests: [{ requestId: REQ, workerIds: [WORKER], reviews: { batches: [] }, missionId: MISSION, managerId: MAIN }],
    });
    expect(trace).toMatchObject({ requestId: REQ, managerAgentId: MAIN, requestText: "Export the contacts." });
  });

  it("a request of no mission is rebuilt as before: no row without a Manager turn", () => {
    const traces = reconstructTraces({
      records: [turn({ workspaceId: LOCAL, requestId: OTHER })],
      agents: [facts({ id: WORKER, requestIdLabel: OTHER })],
      requests: [{ requestId: OTHER, workerIds: [WORKER], reviews: { batches: [] }, managerId: "agent-local" }],
    });
    expect(traces.map((trace) => trace.traceId)).toEqual(["unknown"]);
  });

  it("workspaceTracesOf reads the mission and the topic from the roster when the entry carries no missionId", async () => {
    const home = missionHome();
    const { traces } = await workspaceTracesOf(
      { location: { tracesDir: join(home, "traces") }, paseo: {} as never, home, allAgents: [{ workspaceId: REPO, facts: facts({ id: WORKER }) }], replacementIds: new Set() },
      REPO,
    );
    expect(traces).toEqual([expect.objectContaining({ requestId: REQ, managerAgentId: MAIN, requestText: "Export the contacts", workerIds: [WORKER] })]);
  });
});

describe("the review budget notice of a mission's request (§6)", () => {
  it("is flushed at its Main's turn end in the home, under the repo's key", async () => {
    const home = missionHome();
    const location = { tracesDir: join(home, "traces") };
    const { paseo, sends } = fakePaseo<BudgetPaseo>({ agents: [{ id: MAIN, workspaceId: HOME_WS, status: "idle", provider: "bm-manager", labels: { "bm.role": "manager" } }] });
    const over: BudgetOverrun = { requestId: REQ, tier: "Small", calls: 3, budget: 2, managerAgentId: MAIN };
    const pending = new Map([[`${REPO}::${REQ}`, over]]);
    const told = createBudgetTold(() => {});
    const ended = { agent: { id: MAIN, workspaceId: HOME_WS, parentAgentId: null, provider: "bm-manager", cwd: "/home", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never;
    expect(await checkReviewBudget(ended, { location, paseo, told, pending, home, log: () => {} })).toBe("sent");
    expect(sends.map((send) => send.id)).toEqual([MAIN]);
    expect(pending.size).toBe(0);
    expect(told.claim(location, `${REPO}::${REQ}`, 3)).toBe("told");
  });

  it("is never sent to the Main of an open mission (mission runtime design §4.3, §6.1)", async () => {
    const home = missionHome();
    const created = createMissionStore(home).create({ code: "CRM", name: "Contacts export", goal: "Export", repos: [REPO], createdBy: "owner", mainId: MAIN });
    expect(created.ok).toBe(true);
    const location = { tracesDir: join(home, "traces") };
    const { paseo, sends } = fakePaseo<BudgetPaseo>({ agents: [{ id: MAIN, workspaceId: HOME_WS, status: "idle", provider: "bm-manager", labels: { "bm.role": "manager" } }] });
    const over: BudgetOverrun = { requestId: REQ, tier: "Small", calls: 3, budget: 2, managerAgentId: MAIN };
    const pending = new Map([[`${REPO}::${REQ}`, over]]);
    const told = createBudgetTold(() => {});
    const ended = { agent: { id: MAIN, workspaceId: HOME_WS, parentAgentId: null, provider: "bm-manager", cwd: "/home", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never;
    expect(await checkReviewBudget(ended, { location, paseo, told, pending, home, log: () => {} })).toBe("ignored");
    expect(sends).toEqual([]);
    expect(pending.size).toBe(0);
  });
});

describe("a Main's compaction brief reads its mission (§6)", () => {
  it("lists the mission's open requests in their repos", () => {
    const home = missionHome();
    const created = createMissionStore(home).create({ code: "CRM", name: "Contacts export", goal: "Export", repos: [REPO], createdBy: "owner", mainId: MAIN });
    expect(created.ok).toBe(true);
    const missionId = created.ok ? created.mission.missionId : "";
    createMissionRoster(home).add(missionId, { requestId: OTHER, workspaceId: REPO, topic: "Import the contacts", workerId: WORKER });
    const brief = stateBriefOf(
      {
        id: "cmp-1",
        workspaceId: HOME_WS,
        requestId: null,
        agentId: MAIN,
        role: "manager",
        provider: "claude",
        interventionId: null,
        reason: "long",
        state: "compacting",
        requestedAt: T0,
        sentAt: T0,
        compactedAt: null,
        briefAt: null,
        endedAt: null,
        ending: null,
      },
      home,
      {},
    );
    // Mission runtime design §2.2: the Main's BM-STATE is its mission state's rendering.
    expect(brief).toContain("role: manager, the Main of mission CRM");
    expect(brief).toContain(`In flight:\n- ${OTHER} in ${REPO}: working; Worker ${WORKER}; no report yet; asked: Import the contacts`);
    expect(brief).toContain("Read the whole mission with bm_mission.");
    expect(brief).not.toContain("requests: none recorded");
  });
});

describe("an unbound Worker of a mission's request reports to its current Main (§3.4 step 4)", () => {
  it("not to the Main its parent label names", async () => {
    const home = missionHome();
    const fake = fakePaseo({
      agents: [
        { id: MAIN, provider: "bm-manager", status: "idle", workspaceId: HOME_WS, labels: { "bm.role": "manager" } },
        { id: WORKER, provider: "bm-worker", status: "idle", workspaceId: REPO, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": OLD_MAIN } },
      ],
    });
    const text = ["BM-REPORT", `requestId: ${REQ}`, "phase: received", "tier: Small (changed: no)", "buildAndTests: not run", "blockers: none"].join("\n");
    const outcome = await relayUnboundBlocks(
      {
        agent: { id: WORKER, provider: "bm-worker", workspaceId: REPO, parentAgentId: OLD_MAIN, cwd: "/repo", title: null },
        turnId: "t",
        outcome: { kind: "completed" },
        timeline: [{ type: "user_message", text: `Export. requestId: ${REQ}` }, { type: "assistant_message", text }],
      } as never,
      { home, paseo: fake.paseo, bindings: createBindingStore(home), now: () => new Date(T0), log: () => {}, queue: createNoticeQueue({ log: () => {} }), outbox: { newId: () => "out-00000000000a" } },
    );
    expect(outcome.status).toBe("done");
    expect(createOutbox(home).list(REPO)).toEqual([expect.objectContaining({ kind: "report", from: WORKER, to: MAIN })]);
  });
});

describe("a fallback incident of a mission's Worker (§3.4 step 4)", () => {
  it("names its current Main as parent and Manager, and its repo", async () => {
    const home = missionHome();
    const fake = fakePaseo({
      agents: [{ id: WORKER, workspaceId: REPO, model: "claude-opus-5", labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": OLD_MAIN } }],
      providers: { available: ["claude"], usage: { requestId: "r", fetchedAt: T0, providers: [] } },
      config: { providers: { "bm-worker": { extends: "claude" } } },
    });
    const incident = await recordIncident(
      { agent: { id: WORKER, provider: "bm-worker/claude-opus-5", workspaceId: REPO } },
      { class: "L1", signal: "failed", message: "usage limit" },
      { paseo: fake.paseo, home, log: () => {}, now: () => new Date(T0), randomHex: () => "00000000000b" },
    );
    expect(incident).toMatchObject({ workspaceId: REPO, requestId: REQ, parentId: MAIN, managerId: MAIN });
  });
});

describe("chat peers and the agents panel show a Worker's Main as its parent (§6)", () => {
  it("chat peers: the Worker's parent is the registry's Main, and the Main in the home is a peer", async () => {
    const home = missionHome();
    const all = [
      { workspaceId: REPO, facts: facts({ id: WORKER }) },
      { workspaceId: HOME_WS, facts: facts({ id: MAIN, role: "manager", parentAgentId: null, requestIdLabel: null, title: "CRM Contacts export" }) },
      { workspaceId: HOME_WS, facts: facts({ id: "agent-other-main", role: "manager", parentAgentId: null, requestIdLabel: null }) },
    ];
    const peers = await peersOfWorkspace(all, REPO, async () => [], new Map(), home);
    expect(peers.map((peer) => [peer.id, peer.role, peer.parentId])).toEqual([
      [WORKER, "worker", MAIN],
      [MAIN, "manager", null],
    ]);
    // No mission: the label, and no Manager of another workspace.
    const local = await peersOfWorkspace([{ workspaceId: LOCAL, facts: facts({ id: "w-local", requestIdLabel: OTHER, parentAgentId: "m-local" }) }, ...all.slice(1)], LOCAL, async () => [], new Map(), home);
    expect(local.map((peer) => [peer.id, peer.parentId])).toEqual([["w-local", "m-local"]]);
  });

  it("agents.list: the Main joins the repo's tree as the Worker's parent", async () => {
    const home = missionHome();
    const agent = (id: string, workspaceId: string, labels: Record<string, string>, provider: string) => ({
      id,
      workspaceId,
      title: id,
      status: "idle",
      provider,
      createdAt: T0,
      updatedAt: T0,
      labels,
      archivedAt: null,
    });
    const { paseo } = fakePaseo<AgentDirectoryPaseo>({
      agents: [
        agent(MAIN, HOME_WS, { "bm.role": "manager", "bm.missionId": MISSION }, "bm-manager"),
        agent(WORKER, REPO, { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": OLD_MAIN }, "bm-worker"),
      ],
    });
    const { agents } = await listWorkspaceAgents({ workspaceId: REPO }, { paseo, home });
    expect(agents.map((node) => [node.id, node.role, node.parentId])).toEqual([
      [MAIN, "manager", null],
      [WORKER, "worker", MAIN],
    ]);
  });
});

describe("an outdated Main (§6 outdated-agents row)", () => {
  it("carries its mission, and its alert names the mission remedy and offers no Manager replacement", () => {
    const main = outdatedAgentOf({ id: MAIN, workspaceId: HOME_WS, provider: "bm-manager", labels: { "bm.role": "manager", "bm.missionId": MISSION } }, Date.parse(T0));
    expect(main).toEqual({ agentId: MAIN, workspaceId: HOME_WS, role: "manager", missionId: MISSION });
    expect(outdatedAgentAlertOf(main!)).toEqual({ workspaceId: HOME_WS, kind: "outdated-agent", subject: MAIN, detail: OUTDATED_MAIN_DETAIL, missionId: MISSION });
    expect(outdatedAgentAlertOf({ agentId: "m-local", workspaceId: LOCAL, role: "manager" })).toMatchObject({ role: "manager" });
  });
});

describe("a Main's turn reads its records from its requests' repo outboxes (§6 collector row)", () => {
  it("reads the repo's outbox for a Main, and none for another Manager", async () => {
    const home = missionHome();
    const location = { tracesDir: join(home, "traces") };
    const read: string[] = [];
    const outboxRecords = (workspaceId: string) => {
      read.push(workspaceId);
      return [];
    };
    const event = (id: string) =>
      ({ agent: { id, workspaceId: HOME_WS, parentAgentId: null, provider: "bm-manager", cwd: "/home", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }) as never;
    await buildRecord(event(MAIN), { location, outboxRecords });
    expect(read).toEqual([REPO]);
    await buildRecord(event("agent-local"), { location, outboxRecords });
    expect(read).toEqual([REPO]);
  });
});

describe("the chat cards of the new peer deliveries (WP-107)", () => {
  const delivered = (kind: string, body: string) => toChatCards({ type: "user_message", text: `BM-DELIVERY ${kind} out-0123456789ab\n${body}`, clientMessageId: "sdk" }, "complete")![0];

  it("another mission's ask names its mission", () => {
    const link = { linkId: "pl-0123456789ab", kind: "question" as const, from: { workspaceId: HOME_WS, requestId: null, role: "manager" as const, agentId: MAIN } };
    const card = delivered("peer", missionAskText({ link: link as never, code: "CRM", name: "Contacts export", text: "Which schema?" }));
    expect(card).toMatchObject({ type: "notice", requestId: null, gist: "Which schema?", notice: { what: "From mission CRM Contacts export" } });
  });

  it("a Main's link of two Workers is its own line", () => {
    const text = linkIntroText({ linkId: "pl-0123456789ab", workerId: "agent-w2", title: "api", requestId: OTHER, topic: "the schema" });
    const card = delivered("peer-message", text);
    expect(card).toMatchObject({ type: "notice", requestId: null, notice: { what: "Your Main linked you with another Worker" } });
    expect(card!.gist).toContain("agent-w2 (api");
  });
});
