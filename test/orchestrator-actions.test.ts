import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleOrchestratorSetAutopilot,
  handleOrchestratorState,
  workPhaseOf,
  type OrchestratorActionsDeps,
  type OrchestratorActionsPaseo,
} from "../plugin/server/orchestrator-actions";
import { toolsStaleSince } from "../plugin/server/agent-tools";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore, type OrchestratorStore, type SentCommandInput } from "../plugin/server/orchestrator-store";
import { createAlertStore } from "../plugin/server/alert-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { registerOrchestratorRpcs } from "../plugin/server/orchestrator-rpc";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { ASSESSMENT_CRITERIA } from "../plugin/shared/bm-assessment";
import { DASHBOARD_ERROR_CODES, DashboardError, orchestratorSetAutopilotRpc, type TraceRecord } from "../plugin/shared/contracts";
import { WORKFLOW_ASSESSMENT_TRACE_ID } from "../plugin/shared/orchestrator";
import { msg, report, turn } from "./fixtures/orchestrator-traces";

/**
 * The Orchestrator's read and switch RPCs (Orchestrator design §8): `state`
 * and `set-autopilot`, against a fake Paseo SDK, a private notice queue and a
 * temporary data folder named by `PASEO_BM_HOME` — never the real HOME or a
 * daemon. The tab's approve, dismiss, command, ask and assess-workflow are
 * retired with the tab (autonomy design §A.14).
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
/** A time on 2026-09-26 at 10:mm UTC. */
const at = (minute: number): string => `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`;

const WS = "wks_invoice";
const MANAGER = "agent-manager";
const ORCHESTRATOR = "agent-orchestrator";

interface FakeAgent {
  id: string;
  provider: string;
  status: string;
  workspaceId: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
  title?: string;
  createdAt?: string;
}

const managerAgent = (id: string, workspaceId: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id,
  provider: "bm-manager",
  status: "idle",
  workspaceId,
  labels: { "bm.role": "manager" },
  title: `Manager of ${workspaceId}`,
  createdAt: at(0),
  ...extra,
});

const orchestratorAgent = (extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id: ORCHESTRATOR,
  provider: "bm-orchestrator/claude-opus-5-5",
  status: "idle",
  workspaceId: "wks-own",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.version": "0.5.0" },
  createdAt: at(1),
  ...extra,
});

/** A fake SDK: `send` records, `refresh` answers from the table, `list` counts its calls. */
function fakePaseo(initial: FakeAgent[], workspaces: Array<Record<string, unknown>> = []) {
  const agents = [...initial];
  const sends: Array<{ id: string; text: string }> = [];
  const byId = (id: string) => agents.find((agent) => agent.id === id);
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent: { ...agent } })) })),
      ref: vi.fn((id: string) => ({
        refresh: async () => {
          const agent = byId(id);
          return { agent: agent === undefined ? null : { status: agent.status, archivedAt: agent.archivedAt ?? null } };
        },
        send: vi.fn(async (text: string) => {
          sends.push({ id, text });
        }),
      })),
    },
    workspaces: { list: vi.fn(async () => ({ entries: workspaces })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
  return { paseo: paseo as unknown as OrchestratorActionsPaseo, raw: paseo, agents, sends, byId };
}

let root: string;
let home: string;
let deps: OrchestratorActionsDeps;

const location = () => ({ tracesDir: join(home, "traces") });
const storeOf = (): OrchestratorStore => createOrchestratorStore(home, { now: () => NOW });

function codeOf(error: unknown): string | null {
  return error instanceof DashboardError ? error.code : null;
}

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** A command the Orchestrator sent itself, recorded in its store. */
function sentCommand(store: OrchestratorStore, over: Partial<SentCommandInput> = {}) {
  return store.appendCommand({
    workspaceId: WS,
    managerId: MANAGER,
    requestId: null,
    situation: "",
    command: "Go on.",
    reason: "",
    source: "autopilot",
    sentText: "Go on.",
    outcome: "sent",
    ...over,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-actions-"));
  home = join(root, "data");
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: () => {} };
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

// ── Error codes ─────────────────────────────────────────────────────────────

describe("error codes and registration (design §8)", () => {
  it("registers E_AUTOPILOT_NOT_CONFIRMED", () => {
    expect(DASHBOARD_ERROR_CODES).toContain("E_AUTOPILOT_NOT_CONFIRMED");
  });

  it("the contract refuses Autopilot on without its dialog, and a workspace id the store would refuse", () => {
    expect(orchestratorSetAutopilotRpc.input.safeParse({ workspaceId: WS, enabled: true, confirmed: false }).success).toBe(false);
    expect(orchestratorSetAutopilotRpc.input.safeParse({ workspaceId: "../x", enabled: false }).success).toBe(false);
  });

  it("registers state, set-autopilot, open-preview, open and apply-suggestion, and none of the retired tab's RPCs", () => {
    const names: string[] = [];
    registerOrchestratorRpcs({ handle: (rpc: { name: string }) => names.push(rpc.name) } as never, deps);
    expect(names.sort()).toEqual([
      "orchestrator.apply-suggestion",
      "orchestrator.open",
      "orchestrator.open-preview",
      "orchestrator.set-autopilot",
      "orchestrator.state",
    ]);
  });
});

// ── set-autopilot ───────────────────────────────────────────────────────────

describe("orchestrator.set-autopilot (design §6A, §8)", () => {
  const settingsPath = () => join(home, "orchestrator", "settings.json");

  it("refuses to turn Autopilot on without confirmed: E_AUTOPILOT_NOT_CONFIRMED, nothing written", async () => {
    const error = await failure(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true }, deps));
    expect(codeOf(error)).toBe("E_AUTOPILOT_NOT_CONFIRMED");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("turns it on with confirmed and off without, per project, recording it from the tab", async () => {
    await expect(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true }, deps)).resolves.toEqual({
      workspaceId: WS,
      autopilot: true,
      since: NOW.toISOString(),
      allow: [],
    });
    await handleOrchestratorSetAutopilot({ workspaceId: "wks_other", enabled: true, confirmed: true }, deps);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      version: 3,
      autopilot: {
        [WS]: { enabled: true, since: NOW.toISOString(), by: "tab" },
        wks_other: { enabled: true, since: NOW.toISOString(), by: "tab" },
      },
    });
    await expect(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: false }, deps)).resolves.toEqual({
      workspaceId: WS,
      autopilot: false,
      since: null,
      allow: [],
    });
    expect(storeOf().isAutopilot(WS)).toBe(false);
    expect(storeOf().isAutopilot("wks_other")).toBe(true);
  });

  it("sends nothing when turned on through the RPC: turning Autopilot on wakes nobody (design §A.8)", async () => {
    const fake = fakePaseo([managerAgent(MANAGER, WS), orchestratorAgent()], [{ id: WS, name: "invoice-app", directory: "/work/invoice-app" }]);
    const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
    registerOrchestratorRpcs({ handle: (rpc: { name: string }, handler: (input: unknown, context: unknown) => unknown) => handlers.set(rpc.name, handler) } as never, deps);
    await handlers.get("orchestrator.set-autopilot")!({ workspaceId: WS, enabled: true, confirmed: true }, { paseo: fake.paseo });
    expect(storeOf().isAutopilot(WS)).toBe(true);
    expect(fake.sends).toEqual([]);
  });

  it("allow: sets the gate categories with the switch on, keeps them when absent, forgets them when turned off (design §6B.5, §9 Allow…)", async () => {
    await expect(
      handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true, allow: ["dependency", "cost", "dependency"] }, deps),
    ).resolves.toEqual({ workspaceId: WS, autopilot: true, since: NOW.toISOString(), allow: ["cost", "dependency"] });
    expect(storeOf().allowedCategories(WS)).toEqual(["cost", "dependency"]);
    // Already on: absent `allow` keeps what is stored.
    await expect(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true }, deps)).resolves.toMatchObject({
      allow: ["cost", "dependency"],
    });
    // An empty list allows none.
    await expect(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true, allow: [] }, deps)).resolves.toMatchObject({ allow: [] });
    await handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true, allow: ["release"] }, deps);
    // Turning off ignores `allow` and forgets the categories; on again starts with none.
    await expect(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: false, allow: ["cost"] }, deps)).resolves.toEqual({
      workspaceId: WS,
      autopilot: false,
      since: null,
      allow: [],
    });
    await handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, confirmed: true }, deps);
    expect(storeOf().allowedCategories(WS)).toEqual([]);
    // Behind the same confirmation, and only known categories pass the contract.
    expect(codeOf(await failure(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: true, allow: ["cost"] }, deps)))).toBe("E_AUTOPILOT_NOT_CONFIRMED");
    expect(orchestratorSetAutopilotRpc.input.safeParse({ workspaceId: WS, enabled: true, confirmed: true, allow: ["everything"] }).success).toBe(false);
  });

  it("fails E_DATA_HOME_UNAVAILABLE without a usable data folder", async () => {
    const error = await failure(handleOrchestratorSetAutopilot({ workspaceId: WS, enabled: false }, { ...deps, env: { PASEO_BM_HOME: "relative/path" } }));
    expect(codeOf(error)).toBe("E_DATA_HOME_UNAVAILABLE");
  });
});

describe("workPhaseOf (autonomy design §A.12)", () => {
  it("is the last report phase that names a stage, skipping blocked; null without one", () => {
    const trace = (...phases: Array<string | null>) => ({ reports: phases.map((phase) => ({ phase })) }) as unknown as Parameters<typeof workPhaseOf>[0];
    expect(workPhaseOf(trace("received", "beads-done", "blocked"))).toBe("beads-done");
    expect(workPhaseOf(trace("received", null))).toBe("received");
    expect(workPhaseOf(trace("blocked"))).toBeNull();
    expect(workPhaseOf(trace())).toBeNull();
    expect(workPhaseOf(null)).toBeNull();
  });
});

describe("orchestrator.state (design §8)", () => {
  const REQ = (ws: string) => `req-${ws}`;
  type Phase = "received" | "bead-implemented" | "blocked" | "finished";

  /** One request of a workspace: the user's message, then a Worker report of `phase` at `minute`. */
  function requestRecords(ws: string, manager: string, phase: Phase, minute: number, day = "2026-09-26"): TraceRecord[] {
    const when = (m: number) => `${day}T10:${String(m).padStart(2, "0")}:00.000Z`;
    const requestId = REQ(ws);
    return [
      turn({
        workspaceId: ws,
        agentId: manager,
        at: when(minute - 2),
        endedAt: when(minute - 2),
        turnId: "m-1",
        requestId,
        sent: [msg(manager, when(minute - 3), `Fix ${ws}.\nSecond line.`, "user")],
      }),
      turn({
        workspaceId: ws,
        agentId: manager,
        at: when(minute),
        endedAt: when(minute),
        turnId: "m-2",
        requestId,
        sent: [msg(manager, when(minute), `BM-REPORT\nrequestId: ${requestId}\nphase: ${phase}\ntier: Small`, "agent")],
        reports: [report({ agentId: "agent-worker-x", at: when(minute), requestId, phase, tier: "Small" })],
      }),
    ];
  }

  async function seed(ws: string, manager: string, phase: Phase, minute: number, day?: string): Promise<void> {
    for (const record of requestRecords(ws, manager, phase, minute, day)) await appendRecord(location(), record);
    const lastSeenAt = `${day ?? "2026-09-26"}T10:${String(minute).padStart(2, "0")}:00.000Z`;
    writeWorkspaceMeta(location(), ws, { lastKnownName: `${ws}-app`, lastKnownDirectory: `/work/${ws}`, lastSeenAt });
  }

  it("answers an empty machine: no agent, no project", async () => {
    const fake = fakePaseo([]);
    await expect(handleOrchestratorState(fake.paseo, deps)).resolves.toEqual({
      agent: null,
      previousCount: 0,
      toolsStale: false,
      outdated: false,
      projects: [],
    });
  });

  it("agent.createdAt and previousCount: the newest Orchestrator, and how many older non-archived ones it replaced (design §3.3, §9)", async () => {
    const labels = { "bm.role": "orchestrator", "bm.orchestrator": "main" };
    const fake = fakePaseo([
      orchestratorAgent({ id: "orch-old", createdAt: at(1), labels }),
      orchestratorAgent({ id: "orch-older", createdAt: at(0), labels }),
      orchestratorAgent({ id: "orch-archived", createdAt: at(0), labels, archivedAt: at(2) }),
      // Not the main Orchestrator: an agent with the role label only is not counted.
      orchestratorAgent({ id: "orch-other", createdAt: at(0), labels: { "bm.role": "orchestrator" } }),
      orchestratorAgent({ id: "orch-new", createdAt: at(3), labels }),
    ]);
    const state = await handleOrchestratorState(fake.paseo, deps);
    expect(state.agent).toEqual({ id: "orch-new", status: "idle", workspaceId: "wks-own", createdAt: at(3) });
    expect(state.previousCount).toBe(2);
    const single = await handleOrchestratorState(fakePaseo([orchestratorAgent()]).paseo, deps);
    expect(single).toMatchObject({ agent: { id: ORCHESTRATOR, createdAt: at(1) }, previousCount: 0 });
    const unknown = await handleOrchestratorState(fakePaseo([orchestratorAgent({ createdAt: undefined })]).paseo, deps);
    expect(unknown.agent!.createdAt).toBeNull();
  });

  it("toolsStale: true for an Orchestrator created before the endpoint's secret, false for one created after (design §5.1)", async () => {
    const isToolsStale = toolsStaleSince(new Date(at(5)));
    const before = fakePaseo([orchestratorAgent({ createdAt: at(1) })]);
    await expect(handleOrchestratorState(before.paseo, { ...deps, isToolsStale })).resolves.toMatchObject({ agent: { id: ORCHESTRATOR }, toolsStale: true });
    const after = fakePaseo([orchestratorAgent({ createdAt: at(6) })]);
    await expect(handleOrchestratorState(after.paseo, { ...deps, isToolsStale })).resolves.toMatchObject({ agent: { id: ORCHESTRATOR }, toolsStale: false });
    const none = fakePaseo([]);
    await expect(handleOrchestratorState(none.paseo, { ...deps, isToolsStale })).resolves.toMatchObject({ agent: null, toolsStale: false });
  });

  it("outdated: true for an Orchestrator without the current instructions label, false for a current one or none (design §3.3)", async () => {
    const unlabelled = fakePaseo([orchestratorAgent()]);
    await expect(handleOrchestratorState(unlabelled.paseo, deps)).resolves.toMatchObject({ agent: { id: ORCHESTRATOR }, outdated: true });
    const older = fakePaseo([orchestratorAgent({ labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": "000000000000" } })]);
    await expect(handleOrchestratorState(older.paseo, deps)).resolves.toMatchObject({ outdated: true });
    const current = fakePaseo([
      orchestratorAgent({ labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH } }),
    ]);
    await expect(handleOrchestratorState(current.paseo, deps)).resolves.toMatchObject({ agent: { id: ORCHESTRATOR }, outdated: false });
    await expect(handleOrchestratorState(fakePaseo([]).paseo, deps)).resolves.toMatchObject({ agent: null, outdated: false });
  });

  it("builds every section from fixtures with one agents.list and one workspaces.list", async () => {
    await seed("wks_running", "mgr-running", "received", 50);
    await seed("wks_waiting", "mgr-waiting", "blocked", 40);
    await seed("wks_stalled", "mgr-stalled", "received", 30);
    await seed("wks_idle", "mgr-idle", "finished", 20);
    await seed("wks_old", "mgr-old", "finished", 10, "2026-09-10");

    const store = storeOf();
    // Stalled requests are Inbox alerts (autonomy design §A.8); a project row reads them as stalls.
    const alerts = createAlertStore(home, { now: () => NOW });
    alerts.raise({ workspaceId: "wks_stalled", kind: "request-stalled", subject: REQ("wks_stalled"), detail: "idle-unfinished" });
    alerts.raise({ workspaceId: "wks_waiting", kind: "request-stalled", subject: REQ("wks_waiting"), detail: "review-over-budget" });
    // A cleared stall is not listed.
    const cleared = alerts.raise({ workspaceId: "wks_idle", kind: "request-stalled", subject: REQ("wks_idle"), detail: "idle-unfinished" });
    alerts.clear(cleared.alert.key);
    store.setAutopilot("wks_running", true, "tab");
    sentCommand(store, { workspaceId: "wks_idle", managerId: "mgr-idle", command: "Thanks.", sentText: "Thanks.", source: "chat", outcome: "queued" });
    const rubric = ASSESSMENT_CRITERIA.map((criterion, index) => ({ criterion, score: index === 5 ? null : index < 2 ? 5 : 4, note: "Seen." }));
    const suggestions = [{ role: "worker" as const, text: "Keep Small requests free of beads.", why: "A bead on a Small request." }];
    store.appendAssessment("wks_idle", {
      v: 1,
      assessmentId: "as-1",
      requestId: null,
      traceId: WORKFLOW_ASSESSMENT_TRACE_ID,
      agentId: ORCHESTRATOR,
      at: at(25),
      status: "done",
      provider: "bm-orchestrator",
      model: null,
      result: { rubric, findings: [], suggestions },
      scope: { requestIds: [REQ("wks_idle")] },
    });

    const fake = fakePaseo(
      [
        managerAgent("mgr-running", "wks_running"),
        { ...managerAgent("worker-running", "wks_running"), provider: "bm-worker", labels: { "bm.role": "worker" }, status: "running" },
        managerAgent("mgr-waiting", "wks_waiting"),
        managerAgent("mgr-stalled", "wks_stalled"),
        managerAgent("mgr-idle", "wks_idle"),
        managerAgent("mgr-old", "wks_old"),
        orchestratorAgent({ status: "running" }),
      ],
      [{ id: "wks_running", directory: "/work/wks_running" }],
    );
    const isToolsStale = vi.fn(() => true);
    const state = await handleOrchestratorState(fake.paseo, { ...deps, isToolsStale });

    expect(fake.raw.agents.list).toHaveBeenCalledTimes(1);
    expect(fake.raw.workspaces.list).toHaveBeenCalledTimes(1);
    expect(fake.sends).toEqual([]);

    expect(state.agent).toEqual({ id: ORCHESTRATOR, status: "running", workspaceId: "wks-own", createdAt: at(1) });
    expect(state.previousCount).toBe(0);
    expect(state.toolsStale).toBe(true);
    expect(isToolsStale).toHaveBeenCalledWith({ id: ORCHESTRATOR, createdAt: at(1) });

    expect(state.projects.map((project) => [project.workspaceId, project.state])).toEqual([
      ["wks_running", "running"],
      ["wks_waiting", "stalled"],
      ["wks_stalled", "stalled"],
      ["wks_idle", "idle"],
    ]);
    const idle = state.projects.find((project) => project.workspaceId === "wks_idle")!;
    expect(idle).toMatchObject({
      workspaceLabel: "wks_idle-app",
      managerId: "mgr-idle",
      managerTitle: "Manager of wks_idle",
      managerStatus: "idle",
      lastActivityAt: at(20),
      requests: 1,
      autopilot: false,
      lastAction: { at: NOW.toISOString(), text: "Thanks.", source: "chat" },
    });
    expect(state.projects.find((project) => project.workspaceId === "wks_running")).toMatchObject({ autopilot: true, lastAction: null });
    // (5 + 5 + 4 + 4 + 4) / 5, the null score left out.
    expect(idle.assessment).toEqual({ assessmentId: "as-1", at: at(25), status: "done", average: 4.4, scores: rubric, recommendations: suggestions });
    expect(state.projects.find((project) => project.workspaceId === "wks_running")!.assessment).toBeNull();
  });

  it("lastAction is each project's newest command the Orchestrator sent, first line only; the proposal era's entries are not actions", async () => {
    await seed("wks_a", "mgr-a", "finished", 20);
    await seed("wks_b", "mgr-b", "finished", 30);
    let clock = NOW.getTime();
    const store = createOrchestratorStore(home, { now: () => new Date((clock += 60_000)) });
    const sent = (workspaceId: string, managerId: string, text: string, source: "autopilot" | "chat") =>
      sentCommand(store, { workspaceId, managerId, command: text, sentText: text, source });
    sent("wks_a", "mgr-a", "Older command.", "chat");
    const newestA = sent("wks_a", "mgr-a", "Answer Q23: use option B.\nThen run the tests.", "autopilot");
    const onlyB = sent("wks_b", "mgr-b", "Go on with the export.", "chat");
    store.setAutopilot("wks_a", true);
    // A command sent from the retired tab, newer than wks_b's own: ignored.
    const file = join(home, "orchestrator", "proposals.json");
    const entries = (JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] }).entries;
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [...entries, { ...onlyB, id: "from-tab", source: "user", command: "From the tab.", sentText: "From the tab.", settledAt: at(59) }] }),
    );

    const state = await handleOrchestratorState(fakePaseo([managerAgent("mgr-a", "wks_a"), managerAgent("mgr-b", "wks_b")]).paseo, deps);
    expect(state.projects.find((project) => project.workspaceId === "wks_a")).toMatchObject({
      autopilot: true,
      lastAction: { at: newestA.settledAt, text: "Answer Q23: use option B.", source: "autopilot" },
    });
    expect(state.projects.find((project) => project.workspaceId === "wks_b")).toMatchObject({
      autopilot: false,
      lastAction: { at: onlyB.settledAt, text: "Go on with the export.", source: "chat" },
    });
  });

  it("says waiting-user for a project whose newest request is blocked and nothing is raised", async () => {
    await seed("wks_waiting", "mgr-waiting", "blocked", 40);
    const fake = fakePaseo([managerAgent("mgr-waiting", "wks_waiting")]);
    const state = await handleOrchestratorState(fake.paseo, deps);
    expect(state.projects).toEqual([expect.objectContaining({ workspaceId: "wks_waiting", state: "waiting-user", managerId: "mgr-waiting" })]);
  });

  it("the per-project facts (design §6B.7): health, stage, agents, progress, request, signals, allow, notes", async () => {
    await seed("wks_impl", "mgr-impl", "received", 50);
    await seed("wks_rev", "mgr-rev", "bead-implemented", 45);
    await seed("wks_wait", "mgr-wait", "blocked", 40);
    await seed("wks_ask", "mgr-ask", "finished", 35);
    await seed("wks_sig", "mgr-sig", "received", 30);
    await seed("wks_idle", "mgr-idle", "finished", 20);

    const store = storeOf();
    store.setAutopilot("wks_impl", true, "tab");
    store.setAutopilotAllow("wks_impl", ["cost"]);
    store.setAutopilot("wks_sig", true, "tab");
    // The live watch's signals are Inbox alerts (autonomy design §A.8).
    const alerts = createAlertStore(home, { now: () => NOW });
    alerts.raise({ workspaceId: "wks_sig", kind: "stuck", subject: "worker-sig" });
    // A cleared signal is not open.
    alerts.raise({ workspaceId: "wks_idle", kind: "danger", subject: "worker-idle" });
    alerts.clear(alertKeyOf("danger", "wks_idle", "worker-idle"));
    store.appendNote("wks_ask", "The owner prefers SQLite.");

    const agent = (id: string, workspaceId: string, role: "worker" | "reviewer", status: string, extra: Partial<FakeAgent> = {}): FakeAgent => ({
      ...managerAgent(id, workspaceId),
      provider: `bm-${role}`,
      labels: { "bm.role": role },
      title: `${role} ${id}`,
      status,
      ...extra,
    });
    const fake = fakePaseo([
      managerAgent("mgr-impl", "wks_impl"),
      agent("worker-impl", "wks_impl", "worker", "running"),
      // An old idle Worker of the project that has nothing to do with the newest request: not listed.
      agent("worker-old", "wks_impl", "worker", "idle"),
      agent("worker-gone", "wks_impl", "worker", "running", { archivedAt: at(1) }),
      managerAgent("mgr-rev", "wks_rev", { status: "running" }),
      agent("reviewer-rev", "wks_rev", "reviewer", "running"),
      managerAgent("mgr-wait", "wks_wait"),
      managerAgent("mgr-ask", "wks_ask"),
      managerAgent("mgr-sig", "wks_sig"),
      agent("worker-sig", "wks_sig", "worker", "idle"),
      managerAgent("mgr-idle", "wks_idle"),
    ]);
    const state = await handleOrchestratorState(fake.paseo, { ...deps, redactEnv: {} });
    const row = (ws: string) => state.projects.find((project) => project.workspaceId === ws)!;

    expect(state.projects.map((project) => [project.workspaceId, project.health, project.stage])).toEqual([
      ["wks_impl", "ok", "implementing"],
      ["wks_rev", "ok", "reviewing"],
      ["wks_wait", "waiting", "waiting-user"],
      ["wks_ask", "idle", "finished"],
      ["wks_sig", "risk", "received"],
      ["wks_idle", "idle", "finished"],
    ]);
    expect(row("wks_impl")).toMatchObject({
      allow: ["cost"],
      agents: {
        manager: { id: "mgr-impl", title: "Manager of wks_impl", status: "idle" },
        workers: [{ id: "worker-impl", title: "worker worker-impl", status: "running" }],
        reviewers: [],
      },
      lastProgressAt: at(50),
      currentRequest: { requestId: REQ("wks_impl"), title: "Fix wks_impl." },
      openSignals: [],
      notes: [],
    });
    expect(row("wks_rev").agents).toEqual({
      manager: { id: "mgr-rev", title: "Manager of wks_rev", status: "running" },
      workers: [],
      reviewers: [{ id: "reviewer-rev", title: "reviewer reviewer-rev", status: "running" }],
    });
    expect(row("wks_sig")).toMatchObject({
      allow: [],
      openSignals: [{ signal: "stuck", workerId: "worker-sig", since: NOW.toISOString() }],
      agents: { workers: [{ id: "worker-sig", status: "idle" }] },
    });
    expect(row("wks_idle").openSignals).toEqual([]);
    expect(row("wks_ask").notes).toEqual([{ at: NOW.toISOString(), text: "The owner prefers SQLite." }]);
    expect(fake.sends).toEqual([]);
  });

  it("a request's title is its first line, redacted; a project without a request has none", async () => {
    await seed("wks_a", "mgr-a", "received", 20);
    const secret = "sk-test-0123456789abcdef";
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(
      location,
      turn({
        workspaceId: "wks_b",
        agentId: "mgr-b",
        at: at(30),
        endedAt: at(30),
        turnId: "m-1",
        requestId: "req-b",
        sent: [msg("mgr-b", at(29), `Deploy with ${secret} today.`, "user")],
      }),
    );
    writeWorkspaceMeta(location, "wks_b", { lastKnownName: "b-app", lastKnownDirectory: "/work/b", lastSeenAt: at(30) });
    const state = await handleOrchestratorState(fakePaseo([managerAgent("mgr-a", "wks_a"), managerAgent("mgr-b", "wks_b")]).paseo, {
      ...deps,
      redactEnv: { PASEO_PASSWORD: secret },
    });
    const title = state.projects.find((project) => project.workspaceId === "wks_b")!.currentRequest!.title!;
    expect(title).not.toContain(secret);
    expect(title.startsWith("Deploy with ")).toBe(true);
    expect(state.projects.find((project) => project.workspaceId === "wks_a")!.currentRequest).toEqual({ requestId: REQ("wks_a"), title: "Fix wks_a." });
  });

  it("lists at most 30 projects, the most recent first", async () => {
    for (let index = 0; index < 32; index += 1) await seed(`wks_${String(index).padStart(2, "0")}`, `mgr-${index}`, "finished", 10 + index);
    const state = await handleOrchestratorState(fakePaseo([]).paseo, deps);
    expect(state.projects).toHaveLength(30);
    expect(state.projects[0]!.workspaceId).toBe("wks_31");
    expect(state.projects.map((project) => project.workspaceId)).not.toContain("wks_00");
  });

  it("fails E_DATA_HOME_UNAVAILABLE without a usable data folder", async () => {
    const error = await failure(handleOrchestratorState(fakePaseo([]).paseo, { ...deps, env: { PASEO_BM_HOME: "relative/path" } }));
    expect(codeOf(error)).toBe("E_DATA_HOME_UNAVAILABLE");
  });
});
