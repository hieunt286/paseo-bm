import { describe, expect, it, vi } from "vitest";
import {
  createAgentLabeller,
  registerAgentLabels,
  type LabelAgentSnapshot,
  type LabelPaseo,
  type ScanAgentSnapshot,
  type ScanPaseo,
} from "../plugin/server/agent-labels";
import type { CliOutcome, PaseoCliDeps } from "../plugin/server/paseo-cli";

/**
 * Labelling a bm-* agent created without its `bm.role` label (delta 20260918g
 * §4.5, REQ-061 d). No test here may start the real `paseo` binary.
 */

const ID = "f13a4e4e-18b6-4369-91c8-70c61460ef2d";

function fakeCli(answer: CliOutcome = { code: 0, output: "{}", timedOut: false }) {
  const runs: string[][] = [];
  const cli: PaseoCliDeps = {
    find: () => "/opt/fake/paseo",
    run: async (file, args) => {
      runs.push([file, ...args]);
      return answer;
    },
  };
  return { cli, runs };
}

function fakePaseo(snapshots: Record<string, LabelAgentSnapshot | Error | null>) {
  const refreshes: string[] = [];
  const paseo: LabelPaseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => {
          refreshes.push(agentId);
          const value = snapshots[agentId];
          if (value instanceof Error) throw value;
          return value === null || value === undefined ? null : { agent: value };
        },
      }),
    },
  };
  return { paseo, refreshes };
}

function setup(snapshots: Record<string, LabelAgentSnapshot | Error | null>, answer?: CliOutcome) {
  const log = vi.fn();
  const cliFake = fakeCli(answer);
  const labeller = createAgentLabeller({ cli: cliFake.cli, log });
  const paseoFake = fakePaseo(snapshots);
  return { log, runs: cliFake.runs, labeller, ...paseoFake };
}

describe("createAgentLabeller().labelAgent", () => {
  it("labels an unlabelled Manager with its role and the mode it runs in, in one command", async () => {
    const { labeller, paseo, runs, log } = setup({
      [ID]: { labels: {}, currentModeId: "default", runtimeInfo: { modeId: "bypassPermissions" } },
    });

    expect(await labeller.labelAgent(ID, "bm-manager/claude-opus-5", paseo)).toBe("labelled");
    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", ID, "--label", "bm.role=manager", "--label", "bm.modeSet=bypassPermissions", "--json"],
    ]);
    expect(log).toHaveBeenCalledWith(`[paseo-bm] labelled ${ID} as manager (it was created without bm.role).`);
  });

  it("falls back to currentModeId, and sets no bm.modeSet without any mode", async () => {
    const withCurrent = setup({ m1: { labels: {}, currentModeId: "auto" } });
    await withCurrent.labeller.labelAgent("m1", "bm-manager", withCurrent.paseo);
    expect(withCurrent.runs[0]).toContain("bm.modeSet=auto");

    const noMode = setup({ m2: { labels: {} } });
    await noMode.labeller.labelAgent("m2", "bm-manager", noMode.paseo);
    expect(noMode.runs).toEqual([["/opt/fake/paseo", "agent", "update", "m2", "--label", "bm.role=manager", "--json"]]);
  });

  it("gives a Worker only its role", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: { "paseo.parent-agent-id": "m1" }, currentModeId: "bypassPermissions" } });
    expect(await labeller.labelAgent("w1", "bm-worker", paseo)).toBe("labelled");
    expect(runs).toEqual([["/opt/fake/paseo", "agent", "update", "w1", "--label", "bm.role=worker", "--json"]]);
  });

  it("runs nothing for an agent that already has a valid bm.role", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: { "bm.role": "worker", "bm.requestId": "req-20260918T070348Z" } } });
    expect(await labeller.labelAgent("w1", "bm-worker/claude-opus-5", paseo)).toBe("already-labelled");
    expect(runs).toEqual([]);
  });

  it("does not even read an agent of another provider", async () => {
    const { labeller, paseo, runs, refreshes } = setup({ c1: { labels: {} } });
    expect(await labeller.labelAgent("c1", "claude", paseo)).toBe("not-bm");
    expect(refreshes).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("logs a failed command once and does not throw", async () => {
    const { labeller, paseo, log } = setup({ [ID]: { labels: {} } }, { code: 1, output: "Error: agent not found\n", timedOut: false });
    expect(await labeller.labelAgent(ID, "bm-manager", paseo)).toBe("failed");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(new RegExp(`^\\[paseo-bm\\] could not label ${ID} as manager: \`paseo agent update\` exited with 1: Error: agent not found`));
  });

  it("logs a failed re-read, or a missing snapshot, and does not throw", async () => {
    const { labeller, paseo, log, runs } = setup({ a: new Error("daemon busy"), b: null });
    expect(await labeller.labelAgent("a", "bm-worker", paseo)).toBe("failed");
    expect(await labeller.labelAgent("b", "bm-reviewer", paseo)).toBe("failed");
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "[paseo-bm] could not label a as worker: daemon busy",
      "[paseo-bm] could not label b as reviewer: Paseo returned no snapshot for it.",
    ]);
    expect(runs).toEqual([]);
  });

  it("handles one agent once, even when two events arrive together", async () => {
    const { labeller, paseo, runs } = setup({ [ID]: { labels: {} } });
    const outcomes = await Promise.all([labeller.labelAgent(ID, "bm-manager", paseo), labeller.labelAgent(ID, "bm-manager", paseo)]);
    expect(outcomes.sort()).toEqual(["already-handled", "labelled"]);
    expect(runs).toHaveLength(1);
  });
});

describe("registerAgentLabels", () => {
  it("labels from agent.created and swallows a broken event", async () => {
    const handlers: Record<string, (event: unknown, context: unknown) => Promise<void>> = {};
    const remove = vi.fn();
    const host = {
      on: vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
        handlers[name] = handler;
        return remove;
      }),
    };
    const cliFake = fakeCli();
    const { paseo } = fakePaseo({ [ID]: { labels: {} } });
    const cleanup = registerAgentLabels(host as never, createAgentLabeller({ cli: cliFake.cli, log: () => {} }));

    await handlers["agent.created"]!({ agent: { id: ID, provider: "bm-manager/claude-opus-5" } }, { paseo });
    expect(cliFake.runs).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handlers["agent.created"]!(null, { paseo })).resolves.toBeUndefined();
    warn.mockRestore();

    cleanup();
    // agent.created and agent.turn_started.
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("is a no-op on a host without on()", () => {
    expect(() => registerAgentLabels({})()).not.toThrow();
  });
});

describe("the once-per-run label scan (owner decision Q6 a, design §4.5 errata)", () => {
  function scanPaseo(agents: Array<ScanAgentSnapshot & LabelAgentSnapshot>, listError?: Error) {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const lists: unknown[] = [];
    const paseo: ScanPaseo = {
      agents: {
        list: async (options) => {
          lists.push(options);
          if (listError) throw listError;
          return { entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        ref: (agentId: string) => ({ refresh: async () => ({ agent: byId.get(agentId) ?? { labels: {} } }) }),
      },
    };
    return { paseo, lists };
  }

  function hooks() {
    const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
    const host = {
      on: vi.fn((name: string, handler: (event: unknown, context: unknown) => unknown) => {
        handlers[name] = handler;
        return () => {};
      }),
    };
    return { host, handlers };
  }

  it("starts at the first turn_started, labels each unlabelled bm-* agent once, and never scans again", async () => {
    const { paseo, lists } = scanPaseo([
      { id: "m-plain", provider: "bm-manager/claude-opus-5", labels: {}, runtimeInfo: { modeId: "bypassPermissions" } },
      { id: "r-plain", provider: "bm-reviewer", labels: { "paseo.parent-agent-id": "w1" } },
      { id: "w1", provider: "bm-worker", labels: { "bm.role": "worker" } },
      { id: "c1", provider: "claude", labels: {} },
      { id: "m-archived", provider: "bm-manager", labels: {}, archivedAt: "2026-09-18T00:00:00.000Z" },
    ]);
    const cliFake = fakeCli();
    const labeller = createAgentLabeller({ cli: cliFake.cli, log: () => {} });
    const { host, handlers } = hooks();
    registerAgentLabels(host as never, labeller);

    expect(handlers["agent.turn_started"]!({ agent: { id: "w1" }, turnId: null }, { paseo })).toBeUndefined();
    await labeller.scanOnce(paseo);
    handlers["agent.turn_started"]!({ agent: { id: "w1" }, turnId: null }, { paseo });
    await handlers["agent.created"]!({ agent: { id: "w1", provider: "bm-worker" } }, { paseo });
    await labeller.scanOnce(paseo);

    expect(lists).toHaveLength(1);
    expect(cliFake.runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", "m-plain", "--label", "bm.role=manager", "--label", "bm.modeSet=bypassPermissions", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r-plain", "--label", "bm.role=reviewer", "--json"],
    ]);
  });

  it("an agent.created first also starts it, and the new agent is labelled once", async () => {
    const { paseo, lists } = scanPaseo([{ id: "new-mgr", provider: "bm-manager", labels: {}, currentModeId: "auto" }]);
    const cliFake = fakeCli();
    const labeller = createAgentLabeller({ cli: cliFake.cli, log: () => {} });
    const { host, handlers } = hooks();
    registerAgentLabels(host as never, labeller);

    await handlers["agent.created"]!({ agent: { id: "new-mgr", provider: "bm-manager" } }, { paseo });
    await labeller.scanOnce(paseo);

    expect(lists).toHaveLength(1);
    expect(cliFake.runs).toHaveLength(1);
  });

  it("logs a listing failure once, labels nothing, and never throws into the hook", async () => {
    const { paseo } = scanPaseo([], new Error("directory unavailable"));
    const log = vi.fn();
    const labeller = createAgentLabeller({ cli: fakeCli().cli, log });
    const { host, handlers } = hooks();
    registerAgentLabels(host as never, labeller);

    expect(() => handlers["agent.turn_started"]!({ agent: { id: "x" }, turnId: null }, { paseo })).not.toThrow();
    await labeller.scanOnce(paseo);
    expect(log.mock.calls.map((call) => call[0])).toEqual(["[paseo-bm] could not list the agents to label: directory unavailable"]);
  });
});
