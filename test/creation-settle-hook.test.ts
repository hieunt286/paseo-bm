import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { PENDING_TTL_MS, clearBindingCache, createBindingStore, hookTagOf, type BindingStore } from "../plugin/server/agent-bindings";
import { createAlertStore } from "../plugin/server/alert-store";
import { recoverHookBindings, settleCreatedAgent } from "../plugin/server/creation-settle";
import { UNBOUND_MANAGER_DETAIL, detectOutdatedAgents, hasUnboundManagerAlert } from "../plugin/server/outdated-agents";
import { currentInstructionsHash } from "../plugin/server/instructions-label";
import { createStallWatcher } from "../plugin/server/stall-watcher";
import { alertKeyOf } from "../plugin/shared/alerts";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * A Manager the owner opens from Paseo's composer (design §7.17.7, ADR-028
 * decision 10): its hook binding settles at `agent.created`, or later in the
 * recovery pass on the stall pass's minute, only to the agent whose session
 * claimed it (the one holding its token); one that expires unsettled raises
 * `outdated-agent` for that Manager, which stays open while it lives. A
 * binding no session claimed settles to nobody. Temporary data folders only.
 */

const T0 = new Date("2026-10-09T10:00:00.000Z");
const WS = "wks_1";
const later = (ms: number): Date => new Date(T0.getTime() + ms);
const CURRENT = { "bm.role": "manager", "bm.instructions": currentInstructionsHash("manager") };

afterEach(() => {
  clearBindingCache();
  removeDataFolders();
});

/** A store with an attached hook binding of `WS`, issued at `T0` and claimed by `claimedBy`'s session (none when null). */
function hookStore(home: string, clock: { now: Date }, claimedBy: string | null = "mgr-1"): { store: BindingStore; token: string; tokenSha256: string } {
  const store = createBindingStore(home, { now: () => clock.now, log: () => {} });
  const issued = store.issue({ role: "manager", workspaceId: WS, origin: "hook" });
  store.attach(issued.token, "manager");
  if (claimedBy !== null) store.claimHook(hookTagOf(issued.tokenSha256), claimedBy);
  return { store, ...issued };
}

/** A Paseo handle listing `agents` and refreshing each one's labels. */
function paseoWith<A extends { id: string }>(agents: A[]) {
  return {
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null, hasMore: false } }),
      ref: (id: string) => ({ refresh: async () => ({ agent: agents.find((agent) => agent.id === id) ?? null }) }),
    },
    workspaces: { list: async () => ({ entries: [] }) },
  };
}

const managerAgent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: "bm-manager",
  workspaceId: WS,
  status: "idle",
  createdAt: later(1_000).toISOString(),
  labels: { ...CURRENT },
  ...over,
});

describe("agent.created of a Manager the hook bound (design §7.17.7)", () => {
  it("binds a Manager without bm.version to the hook binding it claimed", async () => {
    const home = dataFolder();
    const { store, token } = hookStore(home, { now: T0 });
    const lines: string[] = [];
    await settleCreatedAgent({ id: "mgr-1", provider: "bm-manager", parentAgentId: null, workspaceId: WS }, paseoWith([managerAgent("mgr-1")]), { home, bindings: store, log: (line) => lines.push(line) });
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: "mgr-1" });
    expect(lines).toEqual(["[paseo-bm] Manager mgr-1 is bound to its own tool path; the creation hook bound it."]);
  });

  it("two concurrent creations: the second Manager's agent.created, handled first, never takes the first one's binding", async () => {
    const home = dataFolder();
    const { store, token } = hookStore(home, { now: T0 }, "mgr-1");
    const agents = [managerAgent("mgr-1"), managerAgent("mgr-2")];
    await settleCreatedAgent({ id: "mgr-2", provider: "bm-manager", parentAgentId: null, workspaceId: WS }, paseoWith(agents), { home, bindings: store, log: () => {} });
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: null });
    expect(store.bindingOfAgent("mgr-2")).toBeNull();
    await settleCreatedAgent({ id: "mgr-1", provider: "bm-manager", parentAgentId: null, workspaceId: WS }, paseoWith(agents), { home, bindings: store, log: () => {} });
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: "mgr-1" });
  });

  it("a creation that failed before its session opened leaves an unclaimed binding the next Manager never takes, at creation or in recovery", async () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const { store, token } = hookStore(home, clock, null);
    // The owner opens a second Manager within ten minutes; it went unbound, with no token.
    const agents = [managerAgent("mgr-2")];
    await settleCreatedAgent({ id: "mgr-2", provider: "bm-manager", parentAgentId: null, workspaceId: WS }, paseoWith(agents), { home, bindings: store, log: () => {} });
    expect(store.bindingOfAgent("mgr-2")).toBeNull();
    clock.now = later(60_000);
    let listed = 0;
    const counting = { ...paseoWith(agents), agents: { ...paseoWith(agents).agents, list: async () => ((listed += 1), { entries: agents.map((agent) => ({ agent })) }) } };
    const deps = { home, bindings: store, now: () => clock.now, log: () => {} };
    expect(await recoverHookBindings(counting, deps)).toEqual({ settled: [], flagged: [] });
    expect(listed).toBe(0);
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: null });
    // Expired: it goes without an alert for anyone.
    clock.now = later(PENDING_TTL_MS + 60_000);
    expect(await recoverHookBindings(counting, deps)).toEqual({ settled: [], flagged: [] });
    expect(store.expiredHooks()).toEqual([]);
    expect(hasUnboundManagerAlert(home, WS, "mgr-2")).toBe(false);
  });

  it("never gives the hook binding to the plugin's own Manager (bm.version)", async () => {
    const home = dataFolder();
    const { store, token } = hookStore(home, { now: T0 }, "mgr-own");
    const own = managerAgent("mgr-own", { labels: { ...CURRENT, "bm.version": "0.6.0" } });
    await settleCreatedAgent({ id: "mgr-own", provider: "bm-manager", parentAgentId: null, workspaceId: WS }, paseoWith([own]), { home, bindings: store, log: () => {} });
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: null });
  });
});

describe("the recovery pass of the hook bindings (design §7.17.7)", () => {
  it("settles a still-pending hook binding to the Manager that claimed it, and lists nothing without one", async () => {
    const home = dataFolder();
    const clock = { now: later(60_000) };
    const empty = createBindingStore(home, { now: () => clock.now });
    let listed = 0;
    const counting = { agents: { list: async () => ((listed += 1), { entries: [] }) } };
    expect(await recoverHookBindings(counting, { home, bindings: empty, now: () => clock.now, log: () => {} })).toEqual({ settled: [], flagged: [] });
    expect(listed).toBe(0);

    const { store, token } = hookStore(home, { now: T0 });
    const agents = [
      managerAgent("mgr-1"),
      // Any other Manager of the workspace, the plugin's own, replaced, archived, or elsewhere: never the one.
      managerAgent("mgr-other"),
      managerAgent("mgr-own", { labels: { ...CURRENT, "bm.version": "0.6.0" } }),
      managerAgent("mgr-replaced", { labels: { ...CURRENT, "bm.replacedBy": "mgr-x" } }),
      managerAgent("mgr-archived", { archivedAt: later(2_000).toISOString() }),
      managerAgent("mgr-elsewhere", { workspaceId: "wks_2" }),
      { id: "wrk-1", provider: "bm-worker", workspaceId: WS, createdAt: later(1_000).toISOString(), labels: {} },
    ];
    const lines: string[] = [];
    const result = await recoverHookBindings(paseoWith(agents), { home, bindings: store, now: () => clock.now, log: (line) => lines.push(line) });
    expect(result).toEqual({ settled: ["mgr-1"], flagged: [] });
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: "mgr-1" });
    expect(lines).toEqual(["[paseo-bm] Manager mgr-1 is bound to its own tool path; its creation hook's binding was settled late."]);
  });

  it("settles nothing when the Manager that claimed it is not live, or was the plugin's own", async () => {
    const home = dataFolder();
    for (const claimer of [managerAgent("mgr-1", { archivedAt: later(2_000).toISOString() }), managerAgent("mgr-1", { labels: { ...CURRENT, "bm.version": "0.6.0" } }), managerAgent("mgr-1", { workspaceId: "wks_2" })]) {
      const { store, token } = hookStore(home, { now: T0 });
      const result = await recoverHookBindings(paseoWith([claimer, managerAgent("mgr-2")]), { home, bindings: store, now: () => later(60_000), log: () => {} });
      expect(result).toEqual({ settled: [], flagged: [] });
      expect(store.callerOf(token, "manager")).toMatchObject({ agentId: null });
      clearBindingCache();
    }
  });

  it("an expired hook binding raises outdated-agent for the Manager that claimed it, once, and goes; the outdated pass keeps it open while the Manager lives", async () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const { store } = hookStore(home, clock);
    clock.now = later(PENDING_TTL_MS + 60_000);
    const agents = [managerAgent("mgr-1"), managerAgent("mgr-2")];
    const deps = { home, bindings: store, now: () => clock.now, log: () => {} };
    expect(await recoverHookBindings(paseoWith(agents), deps)).toEqual({ settled: [], flagged: ["mgr-1"] });
    const alerts = createAlertStore(home, { now: () => clock.now });
    const key = alertKeyOf("outdated-agent", WS, "mgr-1");
    expect(alerts.get(key)).toMatchObject({ kind: "outdated-agent", subject: "mgr-1", detail: UNBOUND_MANAGER_DETAIL, role: "manager", clearedAt: null });
    expect(hasUnboundManagerAlert(home, WS, "mgr-1")).toBe(true);
    expect(store.expiredHooks()).toEqual([]);
    expect(await recoverHookBindings(paseoWith(agents), deps)).toEqual({ settled: [], flagged: [] });

    // Current instructions: the outdated pass alone would clear it; it stays while the Manager is live.
    await detectOutdatedAgents(paseoWith(agents), alerts, clock.now.getTime(), agents);
    expect(alerts.isOpen(key)).toBe(true);
    await detectOutdatedAgents(paseoWith([]), alerts, clock.now.getTime(), []);
    expect(alerts.isOpen(key)).toBe(false);
    expect(hasUnboundManagerAlert(home, WS, "mgr-1")).toBe(false);
  });

  it("an older-instructions alert of a current Manager is still cleared", async () => {
    const home = dataFolder();
    const alerts = createAlertStore(home);
    alerts.raise({ workspaceId: WS, kind: "outdated-agent", subject: "mgr-1", detail: "older", role: "manager" });
    const agents = [managerAgent("mgr-1")];
    await detectOutdatedAgents(paseoWith(agents), alerts, Date.now(), agents);
    expect(alerts.isOpen(alertKeyOf("outdated-agent", WS, "mgr-1"))).toBe(false);
  });

  it("runs before each stall pass; a failure is one log line and the pass goes on", async () => {
    const home = dataFolder();
    const seen: unknown[] = [];
    const lines: string[] = [];
    const watcher = createStallWatcher({
      env: { PASEO_BM_HOME: home },
      homedir: () => join(home, ".."),
      log: (line) => lines.push(line),
      beforePass: async (handle) => {
        seen.push(handle);
        throw new Error("boom");
      },
    });
    const paseo = paseoWith([]);
    watcher.usePaseo(paseo);
    const result = await watcher.pass();
    expect(seen).toEqual([paseo]);
    expect(result.status).toBe("done");
    expect(lines).toContain("[paseo-bm] the step before a stall pass failed: boom");
  });
});
