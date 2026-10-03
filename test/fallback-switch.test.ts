import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionStore } from "../plugin/server/decision-store";
import { syncFallbackDecisions } from "../plugin/server/fallback-decisions";
import { handleFallbackAct, type FallbackActions } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { FALLBACK_WORKER_TITLE, createWorkerSwitch } from "../plugin/server/fallback-switch";
import { AGENT_TOOLS_OFF_SWITCH_MESSAGE } from "../plugin/server/manager";
import { forgetModes } from "../plugin/server/role-mode";
import { REVIEWER_STOP_NOTICE } from "../plugin/server/stop-propagation";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { fakePaseo } from "./helpers/fake-paseo";
import { createBindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";

/**
 * Delta 20260921 §4.4.7 (REQ-065 d): "Switch" creates the replacement Worker on
 * the candidate's fallback alias. Fake daemon, temporary install home; the
 * handover is stubbed (its own tests cover it).
 */

const OLD = "wrk-1";
const NEW = "wrk-2";
const MANAGER = "mgr-1";
const REQ = "req-20260922T040000Z";
const HANDOVER = "BM-HANDOVER\nrole: worker\n…";

const CANDIDATE = { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: null };

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-0000000000cc",
  role: "worker",
  workspaceId: "wks_1",
  requestId: REQ,
  agentId: OLD,
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: MANAGER,
  managerId: MANAGER,
  class: "L1",
  signal: "failed",
  message: "usage limit",
  perModelWindow: false,
  resetsAt: null,
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: "2026-09-22T04:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

const MODES: Record<string, unknown[]> = {
  "bm-worker-fallback-1": [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ],
  "bm-worker-fallback-2": [
    { id: "build", label: "build" },
    { id: "plan", label: "plan" },
  ],
  "bm-worker-fallback-3": [],
};

/** The Worker `OLD` in /repo and its Reviewers; a creation makes `NEW`. */
function daemonWith(options: { oldLabels?: Record<string, string>; reviewers?: Array<{ id: string; status: string }>; create?: () => Promise<never>; available?: string[]; injectIntoAgents?: boolean } = {}) {
  const fake = fakePaseo({
    agents: [
      { id: OLD, cwd: "/repo", status: "idle", labels: { "bm.role": "worker", "bm.requestId": REQ, ...options.oldLabels } },
      ...(options.reviewers ?? []).map((reviewer) => ({
        ...reviewer,
        workspaceId: "wks_1",
        provider: "bm-reviewer",
        labels: { "bm.role": "reviewer", "paseo.parent-agent-id": OLD },
      })),
    ],
    providers: {
      available: options.available ?? ["claude", "codex", "opencode", "pi"],
      modes: MODES,
      features: () => [{ type: "toggle", id: "auto_accept", label: "Auto-accept", value: false }],
    },
    config: options.injectIntoAgents === undefined ? {} : { mcp: { injectIntoAgents: options.injectIntoAgents } },
    created: options.create ?? (() => ({ id: NEW })),
  });
  return { paseo: fake.paseo, create: fake.api.agents.create, sent: fake.sends };
}

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const write = (incidents: FallbackIncident[]) => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));
const NOW = () => new Date("2026-09-22T04:05:00.000Z");

function switcher(overrides: Parameters<typeof createWorkerSwitch>[0] = {}) {
  const setLabels = vi.fn(async () => ({ ok: true as const }));
  const stopReviewers = vi.fn(async () => []);
  const handover = vi.fn(async () => HANDOVER);
  const action = createWorkerSwitch({ log, now: NOW, setLabels, stopReviewers, handover, location: async () => null, ...overrides });
  return { action, setLabels, stopReviewers, handover };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-switch-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
  forgetModes();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("switch (Worker)", () => {
  it("creates exactly one Worker with the exact config, cwd, parent, title, labels and prompt, then records switched", async () => {
    write([incident()]);
    const { paseo, create } = daemonWith();
    const { action, setLabels, stopReviewers } = switcher();
    const after = await action(incident(), paseo, { home });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      config: { provider: "bm-worker-fallback-1/gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" },
      cwd: "/repo",
      parent: MANAGER,
      title: FALLBACK_WORKER_TITLE,
      labels: { "bm.role": "worker", "bm.requestId": REQ, "bm.version": PLUGIN_VERSION, "bm.replaces": OLD },
      prompt: HANDOVER,
    });
    expect(FALLBACK_WORKER_TITLE).toBe("Beads Worker (fallback)");
    expect(setLabels).toHaveBeenCalledWith(OLD, { "bm.replacedBy": NEW });
    expect(stopReviewers).toHaveBeenCalledWith(paseo, OLD, "wks_1");
    expect(after).toMatchObject({ status: "switched", replacementId: NEW, decidedAt: "2026-09-22T04:05:00.000Z" });
    expect(read()[0]).toMatchObject({ status: "switched", replacementId: NEW });
  });

  it("creates no replacement Worker while Paseo's agent tools are off, and leaves the incident pending", async () => {
    // Without the tools a Worker could neither send a BM-REPORT nor create a Reviewer.
    write([incident()]);
    const off = daemonWith({ injectIntoAgents: false });
    const { action, setLabels, stopReviewers } = switcher();
    await expect(action(incident(), off.paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_CREATE_FAILED", message: expect.stringContaining(AGENT_TOOLS_OFF_SWITCH_MESSAGE) });
    expect(off.create).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(stopReviewers).not.toHaveBeenCalled();
    expect(read()[0]).toMatchObject({ status: "pending" });

    const on = daemonWith({ injectIntoAgents: true });
    await expect(action(incident(), on.paseo, { home })).resolves.toMatchObject({ status: "switched", replacementId: NEW });
  });

  it("creates one Worker for two clicks at once: the second finds the incident decided", async () => {
    write([incident()]);
    const { paseo, create } = daemonWith();
    const { action } = switcher();
    const results = await Promise.allSettled([action(incident(), paseo, { home }), action(incident(), paseo, { home })]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "E_FALLBACK_NOT_PENDING" } });
  });

  it("only logs when the old Worker cannot be labelled", async () => {
    write([incident()]);
    const { paseo } = daemonWith();
    const { action } = switcher({ setLabels: vi.fn(async () => ({ ok: false as const, reason: "paseo: command not found" })) });
    await expect(action(incident(), paseo, { home })).resolves.toMatchObject({ status: "switched", replacementId: NEW });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] could not label Worker wrk-1 as replaced by wrk-2: paseo: command not found/));
  });

  it("stops the old Worker's running Reviewers, never its idle ones", async () => {
    write([incident()]);
    const { paseo, sent } = daemonWith({ reviewers: [{ id: "rev-running", status: "running" }, { id: "rev-idle", status: "idle" }] });
    const { action } = switcher({ stopReviewers: undefined });
    await action(incident(), paseo, { home });
    expect(sent).toEqual([{ id: "rev-running", text: REVIEWER_STOP_NOTICE }]);
  });

  it("records failed with the error when the creation fails, and never goes back to pending", async () => {
    write([incident()]);
    const { paseo, create } = daemonWith({
      create: async () => {
        throw new Error("provider codex is not logged in");
      },
    });
    const { action, setLabels } = switcher();
    await expect(action(incident(), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_CREATE_FAILED" });
    expect(read()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("provider codex is not logged in") });
    await expect(action(incident(), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NOT_PENDING" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(setLabels).not.toHaveBeenCalled();
  });

  it("refuses, creating nothing and leaving it pending, when the candidate's provider is gone or the Worker was already replaced", async () => {
    write([incident()]);
    const gone = daemonWith({ available: ["claude"] });
    await expect(switcher().action(incident(), gone.paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_CANDIDATE" });
    const replaced = daemonWith({ oldLabels: { "bm.replacedBy": "wrk-9" } });
    await expect(switcher().action(incident(), replaced.paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NOT_PENDING" });
    const noCandidate = daemonWith();
    write([incident({ candidate: null })]);
    await expect(switcher().action(incident({ candidate: null }), noCandidate.paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NO_CANDIDATE" });
    expect(gone.create).not.toHaveBeenCalled();
    expect(replaced.create).not.toHaveBeenCalled();
    expect(read()[0]).toMatchObject({ status: "pending" });
  });

  it("starts the Worker by the candidate provider's capability: OpenCode gets a listed mode and auto_accept, Pi gets neither", async () => {
    const opencode = { ...CANDIDATE, position: 2, alias: "bm-worker-fallback-2", baseProvider: "opencode", model: "big-pickle", thinkingOptionId: null };
    write([incident({ candidate: opencode })]);
    const first = daemonWith();
    await switcher().action(incident({ candidate: opencode }), first.paseo, { home });
    expect(first.create.mock.calls[0]![0].config).toEqual({ provider: "bm-worker-fallback-2/big-pickle", modeId: "build", featureValues: { auto_accept: true } });

    const pi = { ...CANDIDATE, position: 3, alias: "bm-worker-fallback-3", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null };
    write([incident({ candidate: pi })]);
    const second = daemonWith();
    await switcher().action(incident({ candidate: pi }), second.paseo, { home });
    expect(second.create.mock.calls[0]![0].config).toEqual({ provider: "bm-worker-fallback-3/pi-default" });
  });
});

describe("card actions against one another (review b6)", () => {
  const act = (action: "switch" | "wait" | "dismiss", paseo: unknown, actions: FallbackActions) =>
    handleFallbackAct({ incidentId: "fb-0000000000cc", action }, paseo, { home, log, now: NOW, actions });

  it("a Dismiss sent while a Switch is under way waits for it, then finds the incident decided", async () => {
    write([incident()]);
    const { paseo, create } = daemonWith();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { action } = switcher({ handover: async () => (await gate, HANDOVER) });
    const switching = act("switch", paseo, { switch: action });
    const dismissing = act("dismiss", paseo, { switch: action });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The Dismiss has not decided anything while the Switch waits for its handover.
    expect(read()[0]).toMatchObject({ status: "pending" });
    release();
    await expect(switching).resolves.toMatchObject({ incident: { status: "switched", replacementId: NEW } });
    await expect(dismissing).rejects.toMatchObject({ code: "E_FALLBACK_NOT_PENDING" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["dismiss", "wait"] as const)("a %s decided first means the Switch creates no agent at all", async (first) => {
    write([incident({ resetsAt: "2026-09-22T06:00:00.000Z" })]);
    const { paseo, create, sent } = daemonWith();
    const { action, setLabels, stopReviewers } = switcher();
    const wait = vi.fn(async (current: FallbackIncident) => {
      const { decidePending } = await import("../plugin/server/fallback-rpc");
      return decidePending(home, current.id, (entry) => ({ ...entry, status: "waiting" as const, waitUntil: "2026-09-22T06:01:00.000Z" }));
    });
    const actions = { switch: action, wait };
    const results = await Promise.allSettled([act(first, paseo, actions), act("switch", paseo, actions)]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "E_FALLBACK_NOT_PENDING" } });
    expect(create).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(stopReviewers).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(read()[0]!.status).toBe(first === "dismiss" ? "dismissed" : "waiting");
  });
});

describe("fallback.act switch", () => {
  it("sends the Manager no BM-FALLBACK, and withdraws the incident's open decision (autonomy design §A.5 d)", async () => {
    write([incident()]);
    syncFallbackDecisions(home, { log });
    const { paseo, sent } = daemonWith();
    const { action } = switcher();
    const { incident: after } = await handleFallbackAct({ incidentId: "fb-0000000000cc", action: "switch" }, paseo, { home, log, actions: { switch: action } });
    expect(after).toMatchObject({ status: "switched", replacementId: NEW });
    expect(sent.filter((entry) => entry.id === MANAGER || entry.text.startsWith("BM-FALLBACK"))).toEqual([]);
    expect(createDecisionStore(home).get("f:fb-0000000000cc")).toMatchObject({ status: "withdrawn" });
  });
});

describe("switch (Worker) — bound to its own tool path (design §16.5) and appended to its request (§16.4)", () => {
  const roleUrl = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;

  it("creates the replacement with a token URL, binds it once the hook attached it, and adds it to the request's Workers", async () => {
    write([incident()]);
    const bindings = createBindingStore(home);
    const binder = binderOf(roleUrl, bindings, () => {});
    // The daemon runs the creation hook before the agent exists: here, the hook's tool step.
    const hooked = (request: { config: Record<string, unknown> }) => {
      applyAgentTools({ config: { ...request.config, cwd: "/repo" } } as unknown as AgentCreateRequest, { urlFor: roleUrl, bindings }, "codex");
      return { id: NEW };
    };
    const { paseo, create } = daemonWith({ create: hooked as never });
    const { action } = switcher({ binder });
    await expect(action(incident(), paseo, { home })).resolves.toMatchObject({ status: "switched", replacementId: NEW });
    const config = create.mock.calls[0]![0].config as Record<string, unknown>;
    expect(config["mcpServers"]).toEqual({ "paseo-bm": { type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4567\/mcp\/worker\/[0-9a-f]{64}$/), alwaysLoad: true } });
    expect(bindings.bindingOfAgent(NEW)).toMatchObject({ state: "bound", role: "worker", workspaceId: "wks_1", requestId: REQ, parentId: MANAGER });
    // The token is in the creation config only, never in a log line.
    const token = String((config["mcpServers"] as Record<string, { url: string }>)["paseo-bm"]!.url).slice(-64);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    // Design §16.4: the request keeps its id, and the replacement is its newest Worker.
    expect(createRequestRegistry(home).get("wks_1", REQ)).toMatchObject({ source: "agent-typed", managerId: MANAGER, workerIds: [OLD, NEW] });
  });

  it("creates an unbound replacement on a provider without tools, and leaves no binding", async () => {
    const pi = { ...CANDIDATE, position: 3, alias: "bm-worker-fallback-3", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null };
    write([incident({ candidate: pi })]);
    const bindings = createBindingStore(home);
    const { paseo, create } = daemonWith();
    const { action } = switcher({ binder: binderOf(roleUrl, bindings, () => {}) });
    await action(incident({ candidate: pi }), paseo, { home });
    expect(create.mock.calls[0]![0].config).toEqual({ provider: "bm-worker-fallback-3/pi-default" });
    expect(bindings.list()).toEqual([]);
  });
});
