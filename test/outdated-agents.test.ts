import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { currentInstructionsHash } from "../plugin/server/instructions-label";
import {
  OUTDATED_PASS_INTERVAL_MS,
  STAMP_GRACE_MS,
  createOutdatedAgentsPass,
  detectOutdatedAgents,
  outdatedAgentOf,
  registerOutdatedAgents,
  type OutdatedAgentSnapshot,
  type OutdatedPaseo,
} from "../plugin/server/outdated-agents";

/**
 * Agents on older role instructions (autonomy PRD §11 rule 3, design §A.11):
 * detected by their `bm.instructions` label, flagged as `outdated-agent` Inbox
 * alerts. A temporary data folder named by `PASEO_BM_HOME`; never the real HOME.
 */

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const OLD = "2026-09-20T08:00:00.000Z";
const WS = "wks_1";
const current = (role: "manager" | "worker" | "reviewer") => ({ "bm.role": role, "bm.instructions": currentInstructionsHash(role) });

function agent(overrides: Partial<OutdatedAgentSnapshot> & { id: string }): OutdatedAgentSnapshot {
  return { workspaceId: WS, provider: "bm-worker", labels: { "bm.role": "worker" }, status: "idle", createdAt: OLD, archivedAt: null, ...overrides };
}

function fakePaseo(agents: OutdatedAgentSnapshot[] | (() => OutdatedAgentSnapshot[]), listError?: Error) {
  const lists: unknown[] = [];
  const paseo: OutdatedPaseo = {
    agents: {
      list: async (options) => {
        lists.push(options);
        if (listError) throw listError;
        const all = typeof agents === "function" ? agents() : agents;
        return { entries: all.map((entry) => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } };
      },
    },
  };
  return { paseo, lists };
}

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-outdated-"));
  home = join(root, "data");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const store = () => createAlertStore(home, { now: () => new Date(NOW) });
const homeDeps = () => ({ env: { PASEO_BM_HOME: home }, homedir: () => root });

describe("outdatedAgentOf", () => {
  it("flags a Manager, Worker or Reviewer without the label or with another hash", () => {
    expect(outdatedAgentOf(agent({ id: "m1", provider: "bm-manager", labels: { "bm.role": "manager" } }), NOW)).toEqual({
      agentId: "m1",
      workspaceId: WS,
      role: "manager",
    });
    expect(outdatedAgentOf(agent({ id: "w1", labels: { "bm.role": "worker", "bm.instructions": "0123456789ab" } }), NOW)?.role).toBe("worker");
    // Recognised by its provider alone (created from the app before this build).
    expect(outdatedAgentOf(agent({ id: "r1", provider: "bm-reviewer/gpt-5.6-sol", labels: {} }), NOW)?.role).toBe("reviewer");
  });

  it("leaves out current, replaced, archived, closed, Orchestrator and non-bm agents", () => {
    expect(outdatedAgentOf(agent({ id: "w1", labels: current("worker") }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "m1", labels: { "bm.role": "manager", "bm.replacedBy": "m2" } }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "w2", archivedAt: OLD }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "w3", status: "closed" }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "o1", provider: "bm-orchestrator", labels: { "bm.role": "orchestrator" } }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "c1", provider: "claude", labels: {} }), NOW)).toBeNull();
  });

  it("gives a new agent without the label time for its stamp, but not one with another hash", () => {
    const fresh = new Date(NOW - STAMP_GRACE_MS + 1_000).toISOString();
    expect(outdatedAgentOf(agent({ id: "w1", createdAt: fresh }), NOW)).toBeNull();
    expect(outdatedAgentOf(agent({ id: "w2", createdAt: new Date(NOW - STAMP_GRACE_MS).toISOString() }), NOW)).not.toBeNull();
    expect(outdatedAgentOf(agent({ id: "w3", createdAt: fresh, labels: { "bm.role": "worker", "bm.instructions": "0123456789ab" } }), NOW)).not.toBeNull();
  });

  it("keeps the project unknown for an agent outside a workspace", () => {
    expect(outdatedAgentOf(agent({ id: "w1", workspaceId: null }), NOW)?.workspaceId).toBeNull();
  });
});

describe("detectOutdatedAgents", () => {
  it("an agent with an older hash raises one alert, however many passes see it", async () => {
    const { paseo } = fakePaseo([
      agent({ id: "w-old", labels: { "bm.role": "worker", "bm.instructions": "0123456789ab" } }),
      agent({ id: "w-new", labels: current("worker") }),
    ]);
    const first = await detectOutdatedAgents(paseo, store(), NOW);
    const second = await detectOutdatedAgents(paseo, store(), NOW);

    expect(first.raised).toEqual([`outdated-agent:${WS}:w-old`]);
    expect(second.raised).toEqual([]);
    const open = store().list({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "outdated-agent", workspaceId: WS, subject: "w-old", clearedAt: null, role: "worker" });
    expect(open[0]!.detail).toMatch(/older paseo-bm/);
  });

  it("offers a Manager's replacement and only flags a Worker", async () => {
    const { paseo } = fakePaseo([
      agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager" } }),
      agent({ id: "w-old" }),
    ]);
    await detectOutdatedAgents(paseo, store(), NOW);
    const detail = Object.fromEntries(store().list().map((alert) => [alert.subject, alert.detail]));
    expect(detail["m-old"]).toMatch(/^This Beads Manager .* Replace it .* the old one stays until you archive it\.$/);
    expect(detail["w-old"]).toMatch(/^This Beads Worker .* It keeps its request/);
  });

  it("clears the alert once the agent is replaced, archived or gone, and never touches the others", async () => {
    let agents = [
      agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager" } }),
      agent({ id: "w-old" }),
      agent({ id: "r-old", provider: "bm-reviewer", labels: { "bm.role": "reviewer" } }),
    ];
    const { paseo } = fakePaseo(() => agents);
    const s = store();
    s.raise({ workspaceId: WS, kind: "stuck", subject: "w-old" });
    await detectOutdatedAgents(paseo, s, NOW);
    expect(s.list({ open: true, kinds: ["outdated-agent"] })).toHaveLength(3);

    agents = [agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager", "bm.replacedBy": "m-new" } }), agent({ id: "w-old", archivedAt: OLD })];
    const pass = await detectOutdatedAgents(paseo, s, NOW);
    expect(pass.cleared.sort()).toEqual([`outdated-agent:${WS}:m-old`, `outdated-agent:${WS}:r-old`, `outdated-agent:${WS}:w-old`]);
    expect(s.list({ open: true }).map((alert) => alert.kind)).toEqual(["stuck"]);
  });

  it("a listing that fails rejects before touching the store", async () => {
    const { paseo } = fakePaseo([], new Error("directory unavailable"));
    const s = store();
    s.raise({ workspaceId: WS, kind: "outdated-agent", subject: "w-old" });
    await expect(detectOutdatedAgents(paseo, s, NOW)).rejects.toThrow("directory unavailable");
    expect(s.isOpen(`outdated-agent:${WS}:w-old`)).toBe(true);
  });
});

describe("createOutdatedAgentsPass", () => {
  it("runs at most once per interval, and one run at a time", async () => {
    let clock = NOW;
    const { paseo, lists } = fakePaseo([agent({ id: "w-old" })]);
    const pass = createOutdatedAgentsPass({ ...homeDeps(), now: () => clock, log: () => {} });

    const a = pass.run(paseo);
    const b = pass.run(paseo);
    expect(b).toBe(a);
    await a;
    await pass.run(paseo);
    expect(lists).toHaveLength(1);

    clock += OUTDATED_PASS_INTERVAL_MS;
    await pass.run(paseo);
    expect(lists).toHaveLength(2);
    expect(store().list({ open: true }).map((alert) => alert.subject)).toEqual(["w-old"]);
  });

  it("ignores a missing Paseo handle, and logs a failed listing without throwing", async () => {
    const log = vi.fn();
    const pass = createOutdatedAgentsPass({ ...homeDeps(), now: () => NOW, log });
    await expect(pass.run(undefined)).resolves.toBeUndefined();
    await expect(pass.run(fakePaseo([], new Error("busy")).paseo)).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => call[0])).toEqual(["[paseo-bm] could not check the agents for older instructions: busy"]);
  });

  it("writes nothing without a usable data folder", async () => {
    const pass = createOutdatedAgentsPass({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root, now: () => NOW, log: () => {} });
    await pass.run(fakePaseo([agent({ id: "w-old" })]).paseo);
    expect(store().list()).toEqual([]);
  });
});

describe("registerOutdatedAgents", () => {
  it("a turn start starts a pass, not waited for; an archived agent's alert clears at once", async () => {
    const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
    const remove = vi.fn();
    const host = {
      on: vi.fn((name: string, handler: (event: unknown, context: unknown) => unknown) => {
        handlers[name] = handler;
        return remove;
      }),
    };
    const pass = createOutdatedAgentsPass({ ...homeDeps(), now: () => NOW, log: () => {} });
    const run = vi.spyOn(pass, "run");
    const cleanup = registerOutdatedAgents(host as never, pass);
    const { paseo } = fakePaseo([agent({ id: "w-old" })]);

    expect(handlers["agent.turn_started"]!({ agent: { id: "w-old" }, turnId: null }, { paseo })).toBeUndefined();
    expect(run).toHaveBeenCalledWith(paseo);
    await run.mock.results[0]!.value;
    expect(store().isOpen(`outdated-agent:${WS}:w-old`)).toBe(true);

    handlers["agent.archived"]!({ agent: { id: "w-old" }, archivedAt: OLD }, { paseo });
    expect(store().isOpen(`outdated-agent:${WS}:w-old`)).toBe(false);

    cleanup();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(() => registerOutdatedAgents({}, pass)()).not.toThrow();
  });
});
