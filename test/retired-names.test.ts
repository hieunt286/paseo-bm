import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../plugin/index.server";
import { toChatCards } from "../plugin/client/chat-card-parse";
import { eventLineOf, eventsMessageOf } from "../plugin/server/event-bus";
import { isPluginNotice, noticeMarkerOf } from "../plugin/server/notices";
import { ORCHESTRATOR_FIRST_PROMPT, ORCHESTRATOR_HOME_README } from "../plugin/server/orchestrator-agent";
import { ORCHESTRATOR_INSTRUCTIONS } from "../plugin/server/orchestrator-instructions";
import { handleOrchestratorState, type OrchestratorStatePaseo } from "../plugin/server/orchestrator-state";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import * as setupRpc from "../plugin/server/setup-rpc";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { ORCHESTRATOR_SERVER_TOOLS, toolFacesFor, toolNamed } from "../plugin/shared/bm-tools";
import { DASHBOARD_ERROR_CODES } from "../plugin/shared/contracts";
import * as autonomyRpc from "../plugin/server/autonomy-rpc";
import * as autonomyStore from "../plugin/server/autonomy-store";
import * as policyResolve from "../plugin/server/policy-resolve";
import { ALERT_KINDS } from "../plugin/shared/alerts";
import * as autonomy from "../plugin/shared/autonomy";
import * as decisions from "../plugin/shared/decisions";
import * as gate from "../plugin/shared/decision-gate";
import { RULE_IDS } from "../plugin/shared/orchestrator";
import { MANAGER, WORKSPACE_DIRECTORY, WORKSPACE_ID, msg, smallWithBead, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Retired names, proven gone — in this one file (bead 81y2.16, code review
 * 2026-09-30 §7).
 *
 * Every check that a retired RPC, tool, error code, field, store method,
 * notice, word or source identifier is absent lives here, once, instead of
 * beside the tests of what replaced it. They only guard the move away from
 * those names: DELETE THIS FILE once the release that retires them (0.5.0)
 * has shipped.
 *
 * How the plugin treats a file an earlier build left on disk (settings.json,
 * the assessments, role-extras.json, model-corrections.json) is behaviour, not
 * a name: it is tested in retired-data-files.test.ts and beside each store.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
const ROLE_FILES = ["manager.md", "worker.md", "reviewer.md", "orchestrator.md"] as const;

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const roleFile = (name: string) => source(`../plugin/roles/${name}`);
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Every RPC the server entry registers (the list itself is pinned in rpc-list-describe.test.ts). */
function registeredRpcNames(): string[] {
  const handle = vi.fn();
  contribute({ handle, registerSettings: vi.fn() } as unknown as Parameters<typeof contribute>[0]);
  const names = handle.mock.calls.map(([contract]) => (contract as { name: string }).name);
  expect(names).toContain("orchestrator.state");
  return names;
}

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-retired-names-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home, { recursive: true });
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

/** The Orchestrator's server-run tools on the temporary data folder, with the agents of `smallWithBead`. */
function orchestratorTools() {
  const fixture = smallWithBead();
  const fake = fakePaseo({
    agents: fixture.agents.map((facts) => ({
      id: facts.id,
      provider: `bm-${facts.role}`,
      status: facts.status,
      workspaceId: WORKSPACE_ID,
      labels: {
        "bm.role": facts.role,
        ...(facts.parentAgentId === null ? {} : { "paseo.parent-agent-id": facts.parentAgentId }),
        ...(facts.requestIdLabel === null ? {} : { "bm.requestId": facts.requestIdLabel }),
      },
    })),
    workspaces: [{ id: WORKSPACE_ID, directory: WORKSPACE_DIRECTORY }],
  });
  const tools = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {} });
  tools.usePaseo(fake.paseo);
  return { tools, fixture, fake };
}

describe("Autopilot, its Allow… and its stop exemption (autonomy design §B.8)", () => {
  it("is no tool: no face offers or names it, bm_decide's authority is the owner's policy, and the server answers it as unknown", async () => {
    const faces = toolFacesFor("orchestrator");
    expect(faces.map((tool) => tool.name)).not.toContain("bm_set_autopilot");
    for (const tool of faces) expect(JSON.stringify(tool), tool.name).not.toMatch(/autopilot/i);
    const decide = ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === "bm_decide")!;
    expect(decide.description).not.toMatch(/autopilot|allowed dependency|This build delegates no question/i);

    const { tools, fake } = orchestratorTools();
    expect(tools.has("bm_set_autopilot")).toBe(false);
    expect(await tools.call("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: true })).toEqual({ ok: false, text: "Unknown tool: bm_set_autopilot" });
    expect(fake.calls).toEqual([]);
  });

  it("is no RPC and no error code", () => {
    expect(registeredRpcNames()).not.toContain("orchestrator.set-autopilot");
    expect(DASHBOARD_ERROR_CODES).not.toContain("E_AUTOPILOT_NOT_CONFIRMED");
  });

  it("is no method of the Orchestrator's store", () => {
    const store = createOrchestratorStore(home) as unknown as Record<string, unknown>;
    for (const retired of ["readSettings", "isAutopilot", "setAutopilot", "allowedCategories", "setAutopilotAllow"]) expect(store[retired], retired).toBeUndefined();
  });

  it("is named by no event message, first prompt, home README, role file, or event source", () => {
    const line = eventLineOf({ type: "request.finished", workspaceId: WORKSPACE_ID, requestId: "req-1", managerId: MANAGER, at: NOW.toISOString() });
    expect(eventsMessageOf([line, "- x"])).not.toMatch(/autopilot/i);
    expect(ORCHESTRATOR_FIRST_PROMPT).not.toMatch(/autopilot/i);
    expect(ORCHESTRATOR_HOME_README).not.toMatch(/autopilot/i);
    for (const name of ROLE_FILES) {
      expect(roleFile(name), name).not.toMatch(/autopilot/i);
      expect(roleFile(name), name).not.toMatch(/bm_set_autopilot/);
    }
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toMatch(/autopilot/i);
    for (const file of ["event-bus.ts", "stall-watcher.ts", "worker-watch.ts"]) {
      expect(source(`../plugin/server/${file}`), file).not.toMatch(/autopilot/i);
    }
  });

  it("leaves the decision gate no stop exemption to export", () => {
    expect(Object.keys(gate)).not.toEqual(expect.arrayContaining(["DANGER_STOP_CATEGORIES"]));
    expect(Object.keys(gate).filter((name) => /stop/i.test(name))).toEqual([]);
  });

  it("is no field of an orchestrator.state row, nor is the workflow assessment, whatever an earlier build stored", async () => {
    // What earlier builds left: Autopilot with Allow… cost for the project, and an assessment of it.
    mkdirSync(join(home, "orchestrator", "assessments"), { recursive: true });
    writeFileSync(join(home, "orchestrator", "settings.json"), JSON.stringify({ version: 3, autopilot: { [WORKSPACE_ID]: { enabled: true, since: NOW.toISOString(), by: "tab", allow: ["cost"] } } }));
    const assessment = { v: 1, assessmentId: "as-1", requestId: null, traceId: "workspace", agentId: null, at: NOW.toISOString(), status: "done", provider: "bm-orchestrator", model: null, result: { rubric: [], findings: [], suggestions: [] }, scope: { requestIds: ["req-1"] } };
    writeFileSync(join(home, "orchestrator", "assessments", `${WORKSPACE_ID}.jsonl`), `${JSON.stringify(assessment)}\n`);
    // One project with one request, and its Manager.
    const location = { tracesDir: join(home, "traces") };
    const when = "2026-09-26T11:00:00.000Z";
    await appendRecord(location, turn({ requestId: "req-1", at: when, endedAt: when, sent: [msg(MANAGER, when, "Fix the dates.", "user")] }));
    writeWorkspaceMeta(location, WORKSPACE_ID, { lastKnownName: "invoice-app", lastKnownDirectory: WORKSPACE_DIRECTORY, lastSeenAt: when });
    const fake = fakePaseo<OrchestratorStatePaseo>({ agents: [{ id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" } }] });

    const state = await handleOrchestratorState(fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: () => {} });

    expect(state.projects.map((project) => project.workspaceId)).toEqual([WORKSPACE_ID]);
    for (const project of state.projects) {
      for (const retired of ["autopilot", "allow", "assessment"]) expect(project, retired).not.toHaveProperty(retired);
    }
  });
});

describe("the workflow assessment, its suggestions and its rule flags (autonomy design §B.9)", () => {
  it("is no tool: none is named bm_assessment, no face mentions it or the plugin's signals, and the server answers it as unknown", async () => {
    expect(toolNamed("bm_assessment")).toBeUndefined();
    for (const tool of toolFacesFor("orchestrator")) expect(JSON.stringify(tool), tool.name).not.toMatch(/signal of the plugin|plugin's signals|with signals|bm_assessment/i);
    const { tools } = orchestratorTools();
    expect(tools.has("bm_assessment")).toBe(false);
    expect(await tools.call("bm_assessment", { workspaceId: WORKSPACE_ID, rubric: [] })).toEqual({ ok: false, text: "Unknown tool: bm_assessment" });
    // Nothing was recorded.
    expect(readdirSync(home, { recursive: true })).toEqual([]);
  });

  it("is no RPC and no error code: apply-suggestion is gone", () => {
    expect(registeredRpcNames()).not.toContain("orchestrator.apply-suggestion");
    expect(DASHBOARD_ERROR_CODES).not.toContain("E_SUGGESTION_TOO_LONG");
  });

  it("leaves no store method for assessments or model corrections", () => {
    const store = createOrchestratorStore(home) as unknown as Record<string, unknown>;
    for (const retired of ["appendAssessment", "readAssessments", "deleteAssessmentsFor", "appendCorrection", "readCorrections"]) expect(store[retired], retired).toBeUndefined();
  });

  it("leaves none of its rules in the catalogue", () => {
    for (const retired of ["process.small-heavy", "process.no-review", "agent.failed-first-turn", "agent.model-corrected", "report.malformed", "manager.language-mismatch"]) {
      expect(RULE_IDS as readonly string[], retired).not.toContain(retired);
    }
  });

  it("flags nothing: bm_projects gives a Small request with a bead no signals, and bm_request no flags section", async () => {
    const { tools, fixture } = orchestratorTools();
    for (const record of fixture.records) await appendRecord({ tracesDir: join(home, "traces") }, record);

    const listed = await tools.call("bm_projects", { detail: "full" });
    const { projects } = JSON.parse(listed.text.slice(listed.text.indexOf("{"))) as { projects: Array<{ requests: Array<Record<string, unknown>> }> };
    const request = await tools.call("bm_request", { workspaceId: WORKSPACE_ID, requestId: fixture.requestId });

    expect(projects[0]?.requests[0]).toBeDefined();
    expect(Object.keys(projects[0]!.requests[0]!)).not.toContain("signals");
    expect(request.ok).toBe(true);
    expect(request.text).not.toContain("Flags the plugin's rules");
    expect(request.text).not.toMatch(/process\.small-heavy|manager\.language-mismatch|· warning · raised/);
  });

  it("is offered by no first prompt, and named by no role text or served tool", () => {
    expect(ORCHESTRATOR_FIRST_PROMPT).not.toMatch(/bm_assessment|assessment/);
    expect(toolFacesFor("orchestrator").map((face) => face.name)).not.toContain("bm_assessment");
    for (const text of [roleFile("orchestrator.md"), ORCHESTRATOR_INSTRUCTIONS]) expect(text).not.toMatch(/bm_assessment|Assessing a workflow|assess the workflow|suggestion/);
  });
});

describe("the additional instructions and role-extras.json (autonomy design §B.8)", () => {
  it("are no RPC and no error code; the read-only roles.instructions is back (base PRD REQ-032 d)", () => {
    const names = registeredRpcNames();
    expect(names).not.toContain("roles.save-extra");
    expect(names).toContain("roles.instructions");
    for (const code of ["E_ROLE_EXTRA_CHANGED", "E_ROLE_EXTRA_INVALID"]) expect(DASHBOARD_ERROR_CODES).not.toContain(code);
  });

  it("have no RPC left in the setup module, and setup.status carries no extras (nor the 0.3.x install kind, ADR-022 decision 2); an old file stays as it was", async () => {
    expect(Object.keys(setupRpc).sort()).toEqual(["handleSetupStatus", "registerSetupRpcs"]);
    const old = JSON.stringify({ version: 1, roles: { manager: "", worker: "Use pnpm.", reviewer: "" } });
    writeFileSync(join(home, "role-extras.json"), old);
    const status = await setupRpc.handleSetupStatus(fakePaseo().paseo, {
      homedir: () => root,
      env: { PATH: "" },
      isExecutable: () => false,
      run: async () => ({ code: 0, output: "" }),
    });
    expect(status).not.toHaveProperty("extras");
    expect(status.setup).not.toHaveProperty("install");
    expect(readFileSync(join(home, "role-extras.json"), "utf8")).toBe(old);
  });

  it("have no editor or Orchestrator tab left in Settings", () => {
    const code = source("../plugin/client/settings-section.tsx").replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/OrchestratorTab|orchestrator-tab|RoleCard|rolesSaveExtra|rolesInstructions|Additional instructions|SETUP_TABS|StatusTabs/);
  });
});

describe("proposals, relays, answer marks and the old notices (ADR-017, design §A.14)", () => {
  it.each(ROLE_FILES)("%s names no retired notice, proposal, relay or gate", (name) => {
    const text = flat(roleFile(name));
    const retired: Array<[string, RegExp]> = [
      ["BM-ANSWERED", /BM-ANSWERED/],
      ["BM-STALL", /BM-STALL/],
      ["BM-EVENT (singular)", /BM-EVENT(?!S)/],
      ["proposals", /propos(e|al)|bm_propose_command|dismiss/i],
      ["waiting pills and answer marks", /waiting pill|mark(ed)? as answered|answer mark/i],
      ["the Manager's answer letters", /`A6 a|A · <name>|under a letter/],
      ["relays", /\brelay/i],
      // The plan-ready-for-beads gate is a skill's; the Orchestrator's regex gate is folklore.
      ["gate folklore", /the gate\b|decision gate|Allow…|big decision/i],
      ["retired Autopilot wake-ups", /autopilot-on|manager-turn|waiting-user/],
    ];
    const found = retired.filter(([, pattern]) => pattern.test(text)).map(([label, pattern]) => `${label}: ${text.match(pattern)?.[0]}`);
    expect(found, name).toEqual([]);
  });

  it("offers no proposal in the Orchestrator's first prompt", () => {
    expect(ORCHESTRATOR_FIRST_PROMPT).not.toContain("bm_propose_command");
  });

  it("makes BM-STALL and BM-EVENT no plugin notices, and no card: they are left to Paseo", () => {
    expect(isPluginNotice("BM-STALL idle-unfinished")).toBe(false);
    expect(isPluginNotice("BM-EVENT question")).toBe(false);
    expect(noticeMarkerOf("BM-EVENT worker-signal stuck")).toBeNull();
    const received = (text: string) => toChatCards({ type: "user_message", text, clientMessageId: "sdk-message-id" }, "complete");
    expect(received("BM-EVENT finished\nProject: Checkout (ws-a)")).toBeUndefined();
    expect(received("BM-STALL idle-unfinished\nProject: Checkout (ws-a)")).toBeUndefined();
  });

  it("leaves the chat code none of the retired question UI: answer marks, chat.waiting, the session answer state, fallback.act", () => {
    const modules = ["parse", "events", "parties", "frame", "decision", "precedent", "markdown"].map((part) => `chat-card-${part}.ts`);
    for (const file of ["chat-card.tsx", ...modules]) {
      const text = source(`../plugin/client/${file}`);
      for (const retired of ["answersMark", "chatWaiting", "answer-state", "fallbackAct", "fallbackIncidents", "sendReply", "QuestionForm", "replyText"]) {
        expect(text, `${file}: ${retired}`).not.toContain(retired);
      }
    }
  });
});

describe("retired pieces of the screens", () => {
  it("has no pinning left on the workspace list (delta 20260918f §4.5)", () => {
    expect(source("../plugin/client/launcher.tsx")).not.toMatch(/orderRows|pinnedOrder|savePinned|PinControls|DragHandle|PanResponder/);
  });

  it("has no hand-made confirmation left beside the grant blocks", () => {
    expect(source("../plugin/client/settings-blocks.tsx")).not.toMatch(/Cancel: do not install|Cancel: keep paseo-bm's settings/);
  });

  it("has neither the old flat bead list nor a second overview component on the Beads screen (code review 2026-09-30 §5)", () => {
    const screen = source("../plugin/client/beads-screen.tsx");
    expect(screen).not.toMatch(/beadListItems/);
    expect(screen).not.toMatch(/BeadsOverviewSection/);
  });
});

describe("the owner-only classes, the recommended predictor and demotion (ADR-025, change-014)", () => {
  it("are gone: their error code, alert kind, exports and store method", () => {
    expect(DASHBOARD_ERROR_CODES).not.toContain("E_AUTONOMY_OWNER_ONLY");
    expect(ALERT_KINDS).not.toContain("autonomy-demoted");
    for (const name of ["HARD_OWNER_CLASSES", "isHardOwnerClass"]) expect(decisions, name).not.toHaveProperty(name);
    for (const name of ["recommendedDelegationOf", "policyReasonOf", "predictorOf", "DEFAULT_AUTONOMY_PREDICTOR", "withDemotion", "demotedAtOf", "autonomyDemotionsSchema"]) {
      expect(autonomy, name).not.toHaveProperty(name);
    }
    expect(policyResolve).not.toHaveProperty("resolveByPolicy");
    expect(autonomyRpc).not.toHaveProperty("demoteOnReversal");
    expect(autonomyStore.createAutonomyStore("/nonexistent-home")).not.toHaveProperty("demote");
  });

  it("leave Settings no matrix, predictor choice, challenger switch or Return all to owner (change-014 outcome 5)", async () => {
    const model = await import("../plugin/client/settings-autonomy-model");
    for (const name of ["autonomyMatrixView", "autonomyGroupState", "AUTONOMY_ROW_ORDER", "OWNER_ONLY_REASONS", "RETURN_ALL_LABEL", "CHALLENGER_LABEL", "CHALLENGER_MEANING", "PREDICTOR_LABELS", "DECIDED_BY_LABEL"]) {
      expect(model, name).not.toHaveProperty(name);
    }
    const code = source("../plugin/client/settings-autonomy.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/autonomySetRpc|autonomyResetRpc|autonomySetChallengerRpc|Return all to owner|Orchestrator predictions/);
  });
});

