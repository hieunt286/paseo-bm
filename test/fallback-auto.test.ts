import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_FALLBACK_FILE } from "../plugin/server/fallback-settings";
import { AUTO_WAIT_WINDOW_MS, autoActionOf, decidePending, decideAutomatically, registerFallbackRpcs, type FallbackAction } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE, recordIncident } from "../plugin/server/fallback-state";
import { createWorkerSwitch } from "../plugin/server/fallback-switch";
import { noticeQueue } from "../plugin/server/notice-queue";
import type { FallbackIncident } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.6 (REQ-067, phase 2a-18, owner decision Q17 b): with a
 * role's policy on "Auto switch", the plugin decides a new incident at once —
 * wait when the reset is at most 30 minutes away, else switch through the
 * role's own path, else leave it pending — through the same `fallback.act`
 * path as a click. Fake daemon, temporary install home.
 */

const NOW = new Date("2026-09-22T07:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const CANDIDATE = { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null };

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-000000000a01",
  role: "worker",
  workspaceId: "wks_1",
  requestId: "req-20260922T070000Z",
  agentId: "wrk-1",
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: "mgr-1",
  managerId: "mgr-1",
  class: "L1",
  signal: "failed",
  message: "usage limit",
  perModelWindow: false,
  resetsAt: null,
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: NOW.toISOString(),
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

let root: string;
let home: string;
const log = vi.fn();
const read = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const write = (incidents: FallbackIncident[]) => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));

/** Actions that only record their decision, as the real ones do at their last step. */
function actions() {
  const roles: string[] = [];
  const decide = (status: "switched" | "waiting"): FallbackAction =>
    vi.fn(async (current: FallbackIncident, _paseo: unknown, deps: { home?: string | null }) => {
      roles.push(`${status}:${current.role}`);
      return decidePending(deps.home!, current.id, (entry) => ({ ...entry, status, decidedAt: NOW.toISOString() }));
    });
  return { roles, switch: decide("switched"), wait: decide("waiting") };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-auto-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  log.mockReset();
});

afterEach(() => {
  noticeQueue.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("autoActionOf", () => {
  it("waits for a reset at most 30 minutes away, a past one included", () => {
    expect(AUTO_WAIT_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(autoActionOf(incident({ resetsAt: at(30) }), NOW)).toBe("wait");
    expect(autoActionOf(incident({ resetsAt: at(5) }), NOW)).toBe("wait");
    expect(autoActionOf(incident({ resetsAt: at(-10) }), NOW)).toBe("wait");
    expect(autoActionOf(incident({ resetsAt: at(30), candidate: null }), NOW)).toBe("wait");
  });

  it("switches when the reset is further or unknown and there is a candidate, else leaves it pending", () => {
    expect(autoActionOf(incident({ resetsAt: at(31) }), NOW)).toBe("switch");
    expect(autoActionOf(incident({ resetsAt: null }), NOW)).toBe("switch");
    expect(autoActionOf(incident({ resetsAt: at(31), candidate: null }), NOW)).toBeNull();
    expect(autoActionOf(incident({ resetsAt: null, candidate: null }), NOW)).toBeNull();
  });
});

describe("decideAutomatically", () => {
  it.each(["worker", "reviewer", "manager"] as const)("switches a %s through the role's own switch path, then tells the chat the chosen state", async (role) => {
    write([incident({ role })]);
    const acts = actions();
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    expect(await decideAutomatically(incident({ role }), {}, { home, log, now: () => NOW, enqueue, actions: acts })).toBe(true);
    expect(acts.roles).toEqual([`switched:${role}`]);
    expect(read()[0]!.status).toBe("switched");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![2]).toContain("\nstatus: switched\n");
  });

  it("waits when the reset is 30 minutes away or less", async () => {
    write([incident({ resetsAt: at(20) })]);
    const acts = actions();
    await decideAutomatically(incident({ resetsAt: at(20) }), {}, { home, log, now: () => NOW, enqueue: async () => "sent", actions: acts });
    expect(acts.roles).toEqual(["waiting:worker"]);
  });

  it("chooses nothing without a near reset or a candidate: the incident stays pending", async () => {
    write([incident({ candidate: null })]);
    const acts = actions();
    expect(await decideAutomatically(incident({ candidate: null }), {}, { home, log, now: () => NOW, enqueue: async () => "sent", actions: acts })).toBe(false);
    expect(acts.roles).toEqual([]);
    expect(read()[0]!.status).toBe("pending");
  });

  it("leaves the incident pending and tells the chat once when Paseo's agent tools are off (real Worker switch)", async () => {
    write([incident()]);
    const create = vi.fn();
    const paseo = {
      agents: { create, ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/repo", status: "idle", labels: { "bm.role": "worker" } } }) }) },
      providers: { listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }) },
      config: { get: async () => ({ config: { mcp: { injectIntoAgents: false } } }) },
    };
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    const worker = createWorkerSwitch({ log, now: () => NOW, setLabels: vi.fn(), stopReviewers: vi.fn(), handover: vi.fn(), location: async () => null });
    expect(await decideAutomatically(incident(), paseo, { home, log, now: () => NOW, enqueue, actions: { switch: worker } })).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(read()[0]!.status).toBe("pending");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![2]).toContain("\nstatus: pending\n");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not switch .*agent tools are off/));
  });

  it("tells the chat the state a failed switch left, instead of throwing", async () => {
    write([incident()]);
    const failing: FallbackAction = async (current, _paseo, deps) => {
      await decidePending(deps.home!, current.id, (entry) => ({ ...entry, status: "failed", error: "provider not logged in" }));
      throw new Error("E_FALLBACK_CREATE_FAILED: provider not logged in");
    };
    const enqueue = vi.fn<(target: string, kind: string, text: string) => Promise<"sent">>(async () => "sent");
    expect(await decideAutomatically(incident(), {}, { home, log, now: () => NOW, enqueue, actions: { switch: failing } })).toBe(true);
    expect(enqueue.mock.calls[0]![2]).toContain("\nstatus: failed\n");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] the Auto switch policy could not switch/));
  });
});

describe("a new incident on a role with Auto switch", () => {
  function fakeDaemon() {
    const sent: Array<{ id: string; text: string }> = [];
    const paseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: id === "wrk-1" ? { id, labels: { "bm.role": "worker", "bm.requestId": "req-20260922T070000Z", "paseo.parent-agent-id": "mgr-1" } } : { id, status: "idle" },
          }),
          send: async (text: string) => void sent.push({ id, text }),
        }),
      },
      providers: { listAvailable: async () => ({ providers: [{ provider: "codex", available: true }, { provider: "claude", available: true }] }) },
      config: { get: async () => ({ config: { providers: { "bm-worker": { extends: "claude" }, "bm-worker-fallback-1": { extends: "codex" } } } }) },
    };
    return { paseo, sent };
  }

  function register(acts: ReturnType<typeof actions>) {
    const server = { handle: vi.fn() };
    return registerFallbackRpcs(server as never, { switch: acts.switch, wait: acts.wait });
  }

  it("is switched at once, and the Manager chat hears only the chosen state", async () => {
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "auto", entries: [CANDIDATE] } } }));
    const acts = actions();
    const remove = register(acts);
    const { paseo, sent } = fakeDaemon();
    try {
      await recordIncident({ agent: { id: "wrk-1", provider: "bm-worker/claude-opus-5", workspaceId: "wks_1" } }, { class: "L2", signal: "failed", message: "credit balance too low" }, { paseo, home, log, now: () => NOW });
    } finally {
      remove();
    }
    expect(acts.roles).toEqual(["switched:worker"]);
    expect(read()[0]!.status).toBe("switched");
    // One notice, with the chosen state: never a "pending" first.
    expect(sent.map((entry) => entry.id)).toEqual(["mgr-1"]);
    expect(sent[0]!.text).toContain("\nstatus: switched\n");
  });

  it("with Ask me, stays pending and the Manager chat hears pending (no automatic action)", async () => {
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "ask", entries: [CANDIDATE] } } }));
    const acts = actions();
    const remove = register(acts);
    const { paseo, sent } = fakeDaemon();
    try {
      await recordIncident({ agent: { id: "wrk-1", provider: "bm-worker/claude-opus-5", workspaceId: "wks_1" } }, { class: "L2", signal: "failed", message: "credit balance too low" }, { paseo, home, log, now: () => NOW });
    } finally {
      remove();
    }
    expect(acts.roles).toEqual([]);
    expect(read()[0]!.status).toBe("pending");
    expect(sent.map((entry) => entry.id)).toEqual(["mgr-1"]);
    expect(sent[0]!.text).toContain("\nstatus: pending\n");
  });
});
