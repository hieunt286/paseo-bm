import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
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
 * path as a click. Autonomy design §A.5 d: an incident the policy decides
 * opens no decision; one it leaves pending, or one under "Ask me", opens
 * exactly one; nothing is sent to the Manager. Fake daemon, temporary install home.
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
const decisions = () => createDecisionStore(home).list();

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
  clearDecisionStoreCache();
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
  it.each(["worker", "reviewer", "manager"] as const)("switches a %s through the role's own switch path, opening no decision", async (role) => {
    write([incident({ role })]);
    const acts = actions();
    expect(await decideAutomatically(incident({ role }), {}, { home, log, now: () => NOW, actions: acts })).toBe(true);
    expect(acts.roles).toEqual([`switched:${role}`]);
    expect(read()[0]!.status).toBe("switched");
    expect(decisions()).toEqual([]);
  });

  it("waits when the reset is 30 minutes away or less", async () => {
    write([incident({ resetsAt: at(20) })]);
    const acts = actions();
    await decideAutomatically(incident({ resetsAt: at(20) }), {}, { home, log, now: () => NOW, actions: acts });
    expect(acts.roles).toEqual(["waiting:worker"]);
  });

  it("chooses nothing without a near reset or a candidate: the incident stays pending", async () => {
    write([incident({ candidate: null })]);
    const acts = actions();
    expect(await decideAutomatically(incident({ candidate: null }), {}, { home, log, now: () => NOW, actions: acts })).toBe(false);
    expect(acts.roles).toEqual([]);
    expect(read()[0]!.status).toBe("pending");
  });

  it("leaves the incident pending when Paseo's agent tools are off (real Worker switch), so it becomes the owner's decision", async () => {
    write([incident()]);
    const create = vi.fn();
    const paseo = {
      agents: { create, ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/repo", status: "idle", labels: { "bm.role": "worker" } } }) }) },
      providers: { listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }) },
      config: { get: async () => ({ config: { mcp: { injectIntoAgents: false } } }) },
    };
    const worker = createWorkerSwitch({ log, now: () => NOW, setLabels: vi.fn(), stopReviewers: vi.fn(), handover: vi.fn(), location: async () => null });
    expect(await decideAutomatically(incident(), paseo, { home, log, now: () => NOW, actions: { switch: worker } })).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(read()[0]!.status).toBe("pending");
    expect(decisions().map((decision) => [decision.id, decision.status])).toEqual([["f:fb-000000000a01", "open"]]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not switch .*agent tools are off/));
  });

  it("logs a failed switch instead of throwing, and opens no decision for the failed incident", async () => {
    write([incident()]);
    const failing: FallbackAction = async (current, _paseo, deps) => {
      await decidePending(deps.home!, current.id, (entry) => ({ ...entry, status: "failed", error: "provider not logged in" }));
      throw new Error("E_FALLBACK_CREATE_FAILED: provider not logged in");
    };
    expect(await decideAutomatically(incident(), {}, { home, log, now: () => NOW, actions: { switch: failing } })).toBe(true);
    expect(read()[0]!.status).toBe("failed");
    expect(decisions()).toEqual([]);
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

  it("is switched at once, with no decision and nothing sent to the Manager", async () => {
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
    expect(decisions()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("when the policy cannot act, the incident is held until it has tried, then opens exactly one decision", async () => {
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "auto", entries: [CANDIDATE] } } }));
    const refusing: FallbackAction = async () => {
      throw new Error("E_FALLBACK_CREATE_FAILED: agent tools are off");
    };
    // The policy's failure is logged after fallback.act has aligned the decisions, before the hold ends.
    const seenWhenLogged: string[][] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => void seenWhenLogged.push(decisions().map((decision) => decision.id)));
    const server = { handle: vi.fn() };
    const remove = registerFallbackRpcs(server as never, { switch: refusing });
    const { paseo, sent } = fakeDaemon();
    try {
      await recordIncident({ agent: { id: "wrk-1", provider: "bm-worker/claude-opus-5", workspaceId: "wks_1" } }, { class: "L2", signal: "failed", message: "credit balance too low" }, { paseo, home, log, now: () => NOW, randomHex: () => "000000000a01" });
    } finally {
      remove();
      warn.mockRestore();
    }
    expect(seenWhenLogged).toEqual([[]]);
    expect(read()[0]!.status).toBe("pending");
    expect(decisions().map((decision) => [decision.id, decision.status])).toEqual([["f:fb-000000000a01", "open"]]);
    expect(sent).toEqual([]);
  });

  it("with Ask me, stays pending and opens exactly one decision with the card's options (no automatic action, nothing sent)", async () => {
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
    const [decision, ...others] = decisions();
    expect(others).toEqual([]);
    expect(decision).toMatchObject({ id: `f:${read()[0]!.id}`, status: "open", workspaceId: "wks_1", requestId: "req-20260922T070000Z", askedBy: { role: "plugin", agentId: null } });
    expect(decision!.options.map((option) => [option.key, option.recommended, option.action])).toEqual([
      ["switch", true, { kind: "fallback", action: "switch", target: read()[0]!.id }],
      ["dismiss", false, { kind: "fallback", action: "dismiss", target: read()[0]!.id }],
    ]);
    expect(sent).toEqual([]);
  });
});
