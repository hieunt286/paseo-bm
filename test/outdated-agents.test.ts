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
import { fakePaseo } from "./helpers/fake-paseo";
import { boundaryConfigOf, boundaryOffAgentOf, detectBoundaryOff, type BoundaryConfig } from "../plugin/server/boundary-off";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { handleAutonomySetBoundary } from "../plugin/server/autonomy-rpc";
import { EMPTY_AUTONOMY_POLICY, autonomyPolicyOf } from "../plugin/shared/autonomy";

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

/** The shared fake SDK holding these agents; with `listError`, every listing rejects with it. */
function daemonWith(agents: OutdatedAgentSnapshot[], listError?: Error) {
  const fake = fakePaseo<OutdatedPaseo>({ agents });
  if (listError) fake.api.agents.list.mockRejectedValue(listError);
  return fake;
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
    // A bm.role label alone is no role (design §16.3).
    expect(outdatedAgentOf(agent({ id: "c2", provider: "claude", labels: { "bm.role": "worker" } }), NOW)).toBeNull();
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
    const { paseo } = daemonWith([
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
    const { paseo } = daemonWith([
      agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager" } }),
      agent({ id: "w-old" }),
    ]);
    await detectOutdatedAgents(paseo, store(), NOW);
    const detail = Object.fromEntries(store().list().map((alert) => [alert.subject, alert.detail]));
    expect(detail["m-old"]).toMatch(/^This Beads Manager .* Replace it .* the old one stays until you archive it\.$/);
    expect(detail["w-old"]).toMatch(/^This Beads Worker .* It keeps its request/);
  });

  it("clears the alert once the agent is replaced, archived or gone, and never touches the others", async () => {
    const fake = daemonWith([
      agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager" } }),
      agent({ id: "w-old" }),
      agent({ id: "r-old", provider: "bm-reviewer", labels: { "bm.role": "reviewer" } }),
    ]);
    const { paseo } = fake;
    const s = store();
    s.raise({ workspaceId: WS, kind: "stuck", subject: "w-old" });
    await detectOutdatedAgents(paseo, s, NOW);
    expect(s.list({ open: true, kinds: ["outdated-agent"] })).toHaveLength(3);

    fake.setAgents([agent({ id: "m-old", provider: "bm-manager", labels: { "bm.role": "manager", "bm.replacedBy": "m-new" } }), agent({ id: "w-old", archivedAt: OLD })]);
    const pass = await detectOutdatedAgents(paseo, s, NOW);
    expect(pass.cleared.sort()).toEqual([`outdated-agent:${WS}:m-old`, `outdated-agent:${WS}:r-old`, `outdated-agent:${WS}:w-old`]);
    expect(s.list({ open: true }).map((alert) => alert.kind)).toEqual(["stuck"]);
  });

  it("a listing that fails rejects before touching the store", async () => {
    const { paseo } = daemonWith([], new Error("directory unavailable"));
    const s = store();
    s.raise({ workspaceId: WS, kind: "outdated-agent", subject: "w-old" });
    await expect(detectOutdatedAgents(paseo, s, NOW)).rejects.toThrow("directory unavailable");
    expect(s.isOpen(`outdated-agent:${WS}:w-old`)).toBe(true);
  });
});

describe("createOutdatedAgentsPass", () => {
  it("runs at most once per interval, and one run at a time", async () => {
    let clock = NOW;
    const { paseo, lists } = daemonWith([agent({ id: "w-old" })]);
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
    await expect(pass.run(daemonWith([], new Error("busy")).paseo)).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => call[0])).toEqual(["[paseo-bm] could not check the agents for older instructions: busy"]);
  });

  it("writes nothing without a usable data folder", async () => {
    const pass = createOutdatedAgentsPass({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root, now: () => NOW, log: () => {} });
    await pass.run(daemonWith([agent({ id: "w-old" })]).paseo);
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
    const { paseo } = daemonWith([agent({ id: "w-old" })]);

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

/**
 * The `boundary-off` alert (autonomy design §D.2, change-009 C3, change-010
 * C6): in a project whose action boundary is on, a live Worker or Reviewer on
 * Claude or Codex created after it was turned on, on this build's
 * instructions, not labelled `bm.boundary=on` and on a profile with no
 * hand-set mode. Cleared when that stops being true or the switch goes off.
 */
describe("the boundary-off alert (§D.2, change-010 C6)", () => {
  const ON_AT = "2026-09-29T10:00:00.000Z";
  const AFTER = "2026-09-29T11:00:00.000Z";
  const BEFORE = "2026-09-29T09:00:00.000Z";
  const policy = autonomyPolicyOf({ projects: {}, challenger: {}, boundary: { [WS]: { enabled: true, at: ON_AT } } });
  const config: BoundaryConfig = { bases: { "bm-worker": "claude", "bm-reviewer": "codex", "bm-worker-fallback-1": "opencode" }, handSet: new Set() };
  const off = (overrides: Partial<OutdatedAgentSnapshot> & { id: string }) =>
    agent({ createdAt: AFTER, labels: { ...current("worker"), "bm.boundary": "off" }, ...overrides });

  it("raises it only in an on project, for an agent created after it was turned on, current, not labelled on, on Claude or Codex, not hand-set", () => {
    expect(boundaryOffAgentOf(off({ id: "w1" }), policy, config)).toEqual({ agentId: "w1", workspaceId: WS, role: "worker" });
    expect(boundaryOffAgentOf(off({ id: "r1", provider: "bm-reviewer", labels: current("reviewer") }), policy, config)?.role).toBe("reviewer");
    for (const [why, snapshot, own] of [
      ["project off", off({ id: "a", workspaceId: "wks_2" }), config],
      ["created before it was turned on", off({ id: "b", createdAt: BEFORE }), config],
      ["no creation time", off({ id: "c", createdAt: "not a time" }), config],
      ["labelled on", off({ id: "d", labels: { ...current("worker"), "bm.boundary": "on" } }), config],
      ["outdated instructions (an outdated-agent alert instead)", off({ id: "e", labels: { "bm.role": "worker", "bm.boundary": "off" } }), config],
      ["a provider on detection", off({ id: "f", provider: "bm-worker-fallback-1/qwen" }), config],
      ["a base that cannot be read", off({ id: "g" }), { bases: {}, handSet: new Set<string>() }],
      ["a hand-set profile mode", off({ id: "h" }), { ...config, handSet: new Set(["bm-worker"]) }],
      ["a Manager", off({ id: "i", provider: "bm-manager", labels: current("manager") }), { ...config, bases: { "bm-manager": "claude" } }],
      ["archived", off({ id: "j", archivedAt: AFTER }), config],
      ["replaced", off({ id: "k", labels: { ...current("worker"), "bm.replacedBy": "w2" } }), config],
      ["a bm.role label alone (design §16.3)", off({ id: "l", provider: "claude" }), { ...config, bases: { ...config.bases, claude: "claude" } }],
    ] as const) {
      expect(boundaryOffAgentOf(snapshot, policy, own), why).toBeNull();
    }
    expect(boundaryOffAgentOf(off({ id: "w1" }), EMPTY_AUTONOMY_POLICY, config)).toBeNull();
  });

  // Live check 2026-10-01 F1: until bm.boundary is written, an agent whose prompt says it runs under the boundary is not off.
  it("reads the prompt's facts line while the agent carries no bm.boundary; a label wins over it", () => {
    const prompt = (line: string) => ({ metadata: { systemPrompt: `Role text.\n\n## Runtime facts\n\n${line}\n` } });
    const unlabelled = { ...current("worker") };
    expect(boundaryOffAgentOf(off({ id: "w1", labels: unlabelled, persistence: prompt("Action boundary: on") }), policy, config)).toBeNull();
    expect(boundaryOffAgentOf(off({ id: "w2", labels: unlabelled, persistence: prompt("Action boundary: off — the project's boundary is off") }), policy, config)?.agentId).toBe("w2");
    expect(boundaryOffAgentOf(off({ id: "w3", labels: unlabelled, persistence: null }), policy, config)?.agentId).toBe("w3");
    expect(boundaryOffAgentOf(off({ id: "w4", persistence: prompt("Action boundary: on") }), policy, config)?.agentId).toBe("w4");
  });

  it("a pass raises one alert per agent, and clears it once the agent is labelled on, gone, or the project is off", () => {
    const agents = [off({ id: "w1" }), off({ id: "w2" }), agent({ id: "w3", createdAt: BEFORE, labels: current("worker") })];
    const first = detectBoundaryOff(agents, store(), policy, config);
    expect(first.raised).toEqual([`boundary-off:${WS}:w1`, `boundary-off:${WS}:w2`]);
    expect(store().list({ open: true }).find((alert) => alert.subject === "w1")?.detail).toMatch(/started without the action boundary/);
    expect(detectBoundaryOff(agents, store(), policy, config).raised).toEqual([]);
    const next = detectBoundaryOff([off({ id: "w1", labels: { ...current("worker"), "bm.boundary": "on" } })], store(), policy, config);
    expect(next.cleared).toEqual([`boundary-off:${WS}:w1`, `boundary-off:${WS}:w2`]);
    detectBoundaryOff([off({ id: "w1" })], store(), policy, config);
    expect(detectBoundaryOff([off({ id: "w1" })], store(), EMPTY_AUTONOMY_POLICY, config).cleared).toEqual([`boundary-off:${WS}:w1`]);
  });

  it("turning the switch off clears the project's alerts at once; turning it on raises nothing for agents already running", async () => {
    const deps = { home, now: () => new Date(NOW) };
    handleAutonomySetBoundary({ workspaceId: WS, enabled: true, confirmed: true }, deps);
    const policyNow = createAutonomyStore(home).read();
    // Created before the switch went on (NOW): nothing.
    expect(detectBoundaryOff([off({ id: "w0", createdAt: OLD })], store(), policyNow, config).raised).toEqual([]);
    detectBoundaryOff([off({ id: "w1", createdAt: new Date(NOW + 60_000).toISOString() })], store(), policyNow, config);
    store().raise({ workspaceId: "wks_2", kind: "boundary-off", subject: "w9" });
    handleAutonomySetBoundary({ workspaceId: WS, enabled: false, confirmed: true }, deps);
    expect(store().list({ open: true }).map((alert) => alert.key)).toEqual(["boundary-off:wks_2:w9"]);
  });

  it("rides on the outdated pass with its listing and the config; archiving clears it; an unreadable config changes nothing", async () => {
    createAutonomyStore(home).setBoundary({ workspaceId: WS, enabled: true, confirmed: true }, ON_AT);
    const agents = [off({ id: "w1" })];
    const fake = fakePaseo<OutdatedPaseo>({ agents, config: { providers: { "bm-worker": { extends: "claude" } }, agentProfiles: [] } });
    const pass = createOutdatedAgentsPass({ ...homeDeps(), now: () => NOW, log: () => {} });
    await pass.run(fake.paseo);
    expect(fake.lists).toHaveLength(1);
    expect(store().list({ open: true }).map((alert) => alert.key)).toEqual([`boundary-off:${WS}:w1`]);
    pass.clearAgent("w1");
    expect(store().list({ open: true })).toEqual([]);
    expect(await boundaryConfigOf({ config: { get: async () => { throw new Error("busy"); } } })).toBeNull();
    expect(await boundaryConfigOf({})).toBeNull();
    expect(await boundaryConfigOf(fake.paseo)).toEqual({ bases: { "bm-worker": "claude" }, handSet: new Set() });
    const blind = fakePaseo<OutdatedPaseo>({ agents, config: new Error("busy") });
    await createOutdatedAgentsPass({ ...homeDeps(), now: () => NOW, log: () => {} }).run(blind.paseo);
    expect(store().list({ open: true })).toEqual([]);
  });
});
