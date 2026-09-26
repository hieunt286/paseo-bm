import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagerSwitch } from "../plugin/server/fallback-manager";
import { handleFallbackAct } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { ensureManager } from "../plugin/server/manager";
import { forgetModes } from "../plugin/server/role-mode";
import { managerIdNotice } from "../plugin/server/settings-notices";
import { fallbackStatusLine } from "../plugin/client/chat-cards";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { PLUGIN_VERSION } from "../plugin/shared/version";

/**
 * Delta 20260921 §4.5.2 (REQ-066 c): "Switch" for a stopped Manager creates the
 * replacement Manager in the same workspace, through `createManager`, and
 * points every live Worker at it. Fake daemon, temporary install home; the
 * handover is stubbed (its own tests cover it).
 */

const WS = "wks_mgr";
const OLD = "mgr-1";
const NEW = "mgr-2";
const HANDOVER = "BM-HANDOVER\nrole: manager\n…";
const INSTRUCTIONS = "You are Beads Manager.";

const CANDIDATE = { position: 1, alias: "bm-manager-fallback-1", baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: "high", modeId: null };

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-0000000000ff",
  role: "manager",
  workspaceId: WS,
  requestId: null,
  agentId: OLD,
  agentProvider: "bm-manager/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: null,
  managerId: OLD,
  class: "L2",
  signal: "failed",
  message: "credit balance too low",
  perModelWindow: false,
  resetsAt: null,
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: "2026-09-22T06:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

type Agent = { id: string; workspaceId: string; status: string; provider: string; labels: Record<string, string>; createdAt?: string; archivedAt?: string | null };

function fakeDaemon(options: { create?: () => Promise<unknown>; oldLabels?: Record<string, string> } = {}) {
  const agents: Agent[] = [
    { id: OLD, workspaceId: WS, status: "idle", provider: "bm-manager", labels: { "bm.role": "manager", "bm.modeSet": "bypassPermissions", ...options.oldLabels }, createdAt: "2026-09-22T01:00:00.000Z" },
    { id: "wrk-idle", workspaceId: WS, status: "idle", provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": "req-1", "paseo.parent-agent-id": OLD } },
    { id: "wrk-busy", workspaceId: WS, status: "running", provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": "req-2", "paseo.parent-agent-id": OLD } },
    { id: "wrk-old", workspaceId: WS, status: "idle", provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": "req-3", "bm.replacedBy": "wrk-new" } },
    { id: "wrk-other", workspaceId: "wks_other", status: "idle", provider: "bm-worker", labels: { "bm.role": "worker" } },
  ];
  const create = vi.fn(
    options.create ??
      (async (request: { labels: Record<string, string> }) => {
        agents.push({ id: NEW, workspaceId: WS, status: "idle", provider: "bm-manager-fallback-1", labels: request.labels, createdAt: "2026-09-22T06:05:00.000Z" });
        return { id: NEW, current: () => ({ id: NEW, status: "idle", capabilities: { supportsMcpServers: true } }), archive: async () => {} };
      }),
  );
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } })),
      ref: (id: string) => ({ refresh: async () => ({ agent: agents.find((agent) => agent.id === id) ?? null }) }),
    },
    workspaces: { ref: () => ({ agents: { create } }), list: async () => ({ entries: [] }) },
    providers: {
      listAvailable: async () => ({ providers: ["claude", "codex"].map((provider) => ({ provider, available: true })) }),
      listModes: async (provider: string) => ({
        provider,
        modes: [
          { id: "default", label: "Default", colorTier: "safe" },
          { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
        ],
        error: null,
      }),
    },
    config: {
      // A machine that is already set up, so `ensureRoles` (0.4.0) finds
      // nothing missing when `manager.ensure` runs below.
      get: async () => ({
        config: {
          providers: { "bm-manager": { extends: "claude" }, "bm-worker": { extends: "claude" }, "bm-reviewer": { extends: "claude" } },
          agentProfiles: [
            { id: "bm-manager", provider: "bm-manager", model: "claude-sonnet-5" },
            { id: "bm-worker", provider: "bm-worker", model: "claude-sonnet-5" },
            { id: "bm-reviewer", provider: "bm-reviewer", model: "claude-sonnet-5" },
          ],
        },
      }),
    },
  };
  return { paseo, create, agents };
}

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const write = (incidents: FallbackIncident[]) => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));
const NOW = () => new Date("2026-09-22T06:05:00.000Z");

function switcher(overrides: Parameters<typeof createManagerSwitch>[0] = {}) {
  const setLabels = vi.fn(async () => ({ ok: true as const }));
  const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent" | "queued">>(async (target) => (target === "wrk-busy" ? "queued" : "sent"));
  const action = createManagerSwitch({
    log,
    now: NOW,
    setLabels,
    enqueue,
    readInstructions: async () => INSTRUCTIONS,
    handover: async () => HANDOVER,
    location: async () => null,
    ...overrides,
  });
  return { action, setLabels, enqueue };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-manager-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
  forgetModes();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("switch (Manager)", () => {
  it("creates one Manager through createManager with the exact provider, mode, labels and prompt, then records switched", async () => {
    write([incident()]);
    const { paseo, create } = fakeDaemon();
    const { action, setLabels } = switcher();
    const after = await action(incident(), paseo, { home });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      config: { provider: "bm-manager-fallback-1/claude-sonnet-5", modeId: "bypassPermissions", thinkingOptionId: "high", systemPrompt: INSTRUCTIONS },
      title: expect.any(String),
      labels: { "bm.role": "manager", "bm.version": PLUGIN_VERSION, "bm.replaces": OLD, "bm.modeSet": "bypassPermissions" },
      prompt: HANDOVER,
    });
    expect(setLabels).toHaveBeenCalledWith(OLD, { "bm.replacedBy": NEW });
    expect(after).toMatchObject({ status: "switched", replacementId: NEW, decidedAt: "2026-09-22T06:05:00.000Z" });
    expect(read()[0]).toMatchObject({ status: "switched", replacementId: NEW });
  });

  it("tells every live, non-replaced Worker of the workspace the new Manager's id (queued for a running one)", async () => {
    write([incident()]);
    const { paseo } = fakeDaemon();
    const { action, enqueue } = switcher();
    await action(incident(), paseo, { home });
    expect(enqueue.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["wrk-idle", "BM-SETTINGS"],
      ["wrk-busy", "BM-SETTINGS"],
    ]);
    expect(enqueue.mock.calls[0]![2]).toBe(managerIdNotice(NEW));
    expect(managerIdNotice(NEW)).toContain("\nManager agent id: `mgr-2` — send every BM-REPORT to this agent from now on.\n");
    await expect(enqueue.mock.results[1]!.value).resolves.toBe("queued");
  });

  it("creates one Manager for two clicks at once through fallback.act", async () => {
    write([incident()]);
    const { paseo, create } = fakeDaemon();
    const { action } = switcher();
    const act = () => handleFallbackAct({ incidentId: "fb-0000000000ff", action: "switch" }, paseo, { home, log, enqueue: async () => "sent", actions: { switch: action } });
    const results = await Promise.allSettled([act(), act()]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "E_FALLBACK_NOT_PENDING" } });
  });

  it("records failed when the creation fails, and never goes back to pending", async () => {
    write([incident()]);
    const { paseo } = fakeDaemon({
      create: async () => {
        throw new Error("provider not logged in");
      },
    });
    const { action, setLabels, enqueue } = switcher();
    await expect(action(incident(), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_CREATE_FAILED" });
    expect(read()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("provider not logged in") });
    expect(setLabels).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a Manager already replaced, creating nothing", async () => {
    write([incident()]);
    const { paseo, create } = fakeDaemon({ oldLabels: { "bm.replacedBy": "mgr-9" } });
    await expect(switcher().action(incident(), paseo, { home })).rejects.toMatchObject({ code: "E_FALLBACK_NOT_PENDING" });
    expect(create).not.toHaveBeenCalled();
  });

  it("makes manager.ensure open the new Manager afterwards", async () => {
    write([incident()]);
    const { paseo } = fakeDaemon();
    await switcher({ setLabels: vi.fn(async () => ({ ok: false as const, reason: "label failed" })) }).action(incident(), paseo, { home });
    // The old Manager has no bm.replacedBy label (labelling failed); the switched incident still hides it.
    const result = await ensureManager({ workspaceId: WS }, { paseo: paseo as never, readInstructions: async () => INSTRUCTIONS, home });
    expect(result).toMatchObject({ agentId: NEW, created: false, otherManagerIds: [] });
  });
});

describe("the card of a switched Manager", () => {
  it("points the user at the usual entries, since a timeline card cannot open an agent", () => {
    const line = fallbackStatusLine(incident({ status: "switched", replacementId: NEW }), new Date("2026-09-22T06:10:00.000Z"));
    expect(line?.text).toBe(
      "A new Beads Manager is running on bm-manager-fallback-1 · Claude · claude-sonnet-5. Open Beads Manager from the sidebar or Command Center to continue with it.",
    );
  });
});
