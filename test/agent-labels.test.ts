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
import { currentInstructionsHash, instructionsHashOf } from "../plugin/server/instructions-label";
import { MANAGER_INSTRUCTIONS } from "../plugin/server/manager-instructions";
import { REVIEWER_INSTRUCTIONS } from "../plugin/server/reviewer-instructions";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { CREATED_BOUNDARY_MS, forgetCreatedBoundaries, rememberCreatedBoundary, takeCreatedBoundary } from "../plugin/server/created-boundary";
import { fakePaseo } from "./helpers/fake-paseo";

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

/** The shared fake Paseo holding these agents; an Error is what that agent's refresh rejects with. */
function daemonWith(snapshots: Record<string, LabelAgentSnapshot | Error | null>) {
  const fake = fakePaseo<LabelPaseo>({
    agents: Object.entries(snapshots).flatMap(([id, value]) => (value === null || value instanceof Error ? [] : [{ ...value, id }])),
  });
  for (const [id, value] of Object.entries(snapshots)) if (value instanceof Error) fake.handle(id).refresh.mockRejectedValue(value);
  return fake;
}

function setup(snapshots: Record<string, LabelAgentSnapshot | Error | null>, answer?: CliOutcome) {
  const log = vi.fn();
  const cliFake = fakeCli(answer);
  const labeller = createAgentLabeller({ cli: cliFake.cli, log });
  const paseoFake = daemonWith(snapshots);
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

  it("gives an Orchestrator only its role", async () => {
    const { labeller, paseo, runs } = setup({ o1: { labels: {}, currentModeId: "default" } });
    expect(await labeller.labelAgent("o1", "bm-orchestrator/claude-opus-5", paseo)).toBe("labelled");
    expect(runs).toEqual([["/opt/fake/paseo", "agent", "update", "o1", "--label", "bm.role=orchestrator", "--json"]]);
  });

  it("runs nothing for an agent that already has a valid bm.role", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: { "bm.role": "worker", "bm.requestId": "req-20260918T070348Z" } } });
    expect(await labeller.labelAgent("w1", "bm-worker/claude-opus-5", paseo)).toBe("already-labelled");
    expect(runs).toEqual([]);
  });

  it("leaves a valid bm.role that disagrees with the provider as it is: the label is display only (design §16.3)", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: { "bm.role": "reviewer" } } });
    expect(await labeller.labelAgent("w1", "bm-worker", paseo)).toBe("already-labelled");
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

describe("bm.instructions on a new agent (autonomy design §A.11, PRD §11 rule 3)", () => {
  it("is the first 12 hex digits of the SHA-256 of the role text, one per role, the Orchestrator's included", () => {
    expect(currentInstructionsHash("manager")).toBe(instructionsHashOf(MANAGER_INSTRUCTIONS));
    expect(currentInstructionsHash("manager")).toMatch(/^[0-9a-f]{12}$/);
    expect(currentInstructionsHash("orchestrator")).toBe(ORCHESTRATOR_INSTRUCTIONS_HASH);
    const all = (["manager", "worker", "reviewer", "orchestrator"] as const).map((role) => currentInstructionsHash(role));
    expect(new Set(all).size).toBe(4);
  });

  it("an unlabelled new Manager gets its role, its mode and its instructions hash in one command", async () => {
    const { labeller, paseo, runs, log } = setup({ [ID]: { labels: {}, runtimeInfo: { modeId: "bypassPermissions" } } });
    expect(await labeller.labelAgent(ID, "bm-manager/claude-opus-5", paseo, { created: true })).toBe("labelled");
    expect(runs).toEqual([
      [
        "/opt/fake/paseo", "agent", "update", ID,
        "--label", "bm.role=manager",
        "--label", "bm.modeSet=bypassPermissions",
        "--label", `bm.instructions=${currentInstructionsHash("manager")}`,
        "--json",
      ],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("a labelled new Worker gets only the hash, and says nothing", async () => {
    const { labeller, paseo, runs, log } = setup({ w1: { labels: { "bm.role": "worker", "paseo.parent-agent-id": "m1" } } });
    expect(await labeller.labelAgent("w1", "bm-worker", paseo, { created: true })).toBe("labelled");
    expect(runs).toEqual([["/opt/fake/paseo", "agent", "update", "w1", "--label", `bm.instructions=${currentInstructionsHash("worker")}`, "--json"]]);
    expect(log).not.toHaveBeenCalled();
  });

  it("a fallback Reviewer is stamped with the Reviewer's hash", async () => {
    const { labeller, paseo, runs } = setup({ r1: { labels: { "bm.role": "reviewer" } } });
    await labeller.labelAgent("r1", "bm-reviewer-fallback-1/gpt-5.6-sol", paseo, { created: true });
    expect(runs[0]).toContain(`bm.instructions=${currentInstructionsHash("reviewer")}`);
  });

  it("runs nothing when the agent already carries this build's hash", async () => {
    const { labeller, paseo, runs } = setup({
      m1: { labels: { "bm.role": "manager", "bm.instructions": currentInstructionsHash("manager") } },
    });
    expect(await labeller.labelAgent("m1", "bm-manager", paseo, { created: true })).toBe("already-labelled");
    expect(runs).toEqual([]);
  });

  it("does not stamp an agent whose system prompt lacks this build's role text", async () => {
    const { labeller, paseo, runs, log } = setup({
      r1: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: "some other prompt" } } },
      r2: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: `${REVIEWER_INSTRUCTIONS}\n\n## Runtime facts\n- x` } } },
    });
    // Not stamped current; only its `bm.boundary=off` (no `Action boundary: on` line, autonomy design §D.2).
    expect(await labeller.labelAgent("r1", "bm-reviewer", paseo, { created: true })).toBe("labelled");
    expect(log.mock.calls[0]![0]).toBe("[paseo-bm] r1 was created without this build's reviewer instructions, so it is not marked as current.");
    expect(await labeller.labelAgent("r2", "bm-reviewer", paseo, { created: true })).toBe("labelled");
    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", "r1", "--label", "bm.boundary=off", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r2", "--label", `bm.instructions=${currentInstructionsHash("reviewer")}`, "--label", "bm.boundary=off", "--json"],
    ]);
  });

  it("without created (the scan), an older agent is never stamped", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: {} } });
    await labeller.labelAgent("w1", "bm-worker", paseo);
    expect(runs).toEqual([["/opt/fake/paseo", "agent", "update", "w1", "--label", "bm.role=worker", "--json"]]);
  });

  it("a new agent the scan reached first is still stamped once by agent.created", async () => {
    const { labeller, paseo, runs } = setup({ w1: { labels: {} } });
    expect(await labeller.labelAgent("w1", "bm-worker", paseo)).toBe("labelled");
    expect(await labeller.labelAgent("w1", "bm-worker", paseo, { created: true })).toBe("labelled");
    expect(await labeller.labelAgent("w1", "bm-worker", paseo, { created: true })).toBe("already-handled");
    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", "w1", "--label", "bm.role=worker", "--json"],
      ["/opt/fake/paseo", "agent", "update", "w1", "--label", `bm.instructions=${currentInstructionsHash("worker")}`, "--json"],
    ]);
  });
});

/**
 * `bm.boundary` (autonomy design §D.2, change-009 C3): a new Worker or
 * Reviewer is labelled `on` or `off` from the `Action boundary` line of its
 * Runtime facts, in the same command as its `bm.instructions`.
 */
describe("bm.boundary on a new Worker or Reviewer (autonomy design §D.2)", () => {
  const facts = (line: string) => `${REVIEWER_INSTRUCTIONS.trimEnd()}\n\n## Runtime facts\n\n${line}\n`;

  it("labels on from `Action boundary: on`, off from an off line or none, and never a Manager or an Orchestrator", async () => {
    const { labeller, paseo, runs } = setup({
      r1: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: facts("Action boundary: on") } } },
      r2: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: facts("Action boundary: off — the project's boundary is off") } } },
      r3: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: REVIEWER_INSTRUCTIONS } } },
      m1: { labels: { "bm.role": "manager" }, persistence: { metadata: { systemPrompt: `${MANAGER_INSTRUCTIONS}\n\n## Runtime facts\n\nAction boundary: on\n` } } },
    });
    for (const id of ["r1", "r2", "r3"]) expect(await labeller.labelAgent(id, "bm-reviewer", paseo, { created: true }), id).toBe("labelled");
    await labeller.labelAgent("m1", "bm-manager", paseo, { created: true });
    const hash = currentInstructionsHash("reviewer");
    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", "r1", "--label", `bm.instructions=${hash}`, "--label", "bm.boundary=on", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r2", "--label", `bm.instructions=${hash}`, "--label", "bm.boundary=off", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r3", "--label", `bm.instructions=${hash}`, "--label", "bm.boundary=off", "--json"],
      ["/opt/fake/paseo", "agent", "update", "m1", "--label", `bm.instructions=${currentInstructionsHash("manager")}`, "--json"],
    ]);
  });

  it("writes nothing when the snapshot shows no prompt, or the label is already right; the scan never labels it", async () => {
    const { labeller, paseo, runs } = setup({
      w1: { labels: { "bm.role": "worker" } },
      r1: { labels: { "bm.role": "reviewer", "bm.instructions": currentInstructionsHash("reviewer"), "bm.boundary": "on" }, persistence: { metadata: { systemPrompt: facts("Action boundary: on") } } },
      r2: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: facts("Action boundary: on") } } },
    });
    await labeller.labelAgent("w1", "bm-worker", paseo, { created: true });
    expect(await labeller.labelAgent("r1", "bm-reviewer", paseo, { created: true })).toBe("already-labelled");
    expect(await labeller.labelAgent("r2", "bm-reviewer", paseo)).toBe("already-labelled");
    expect(runs.flat().filter((arg) => arg.startsWith("bm.boundary"))).toEqual([]);
  });
});

/**
 * Live check 2026-10-01 F1: at `agent.created` the snapshot carries no system
 * prompt yet (`persistence` is null until the session starts), so 0 of 11 new
 * Workers and Reviewers got `bm.boundary`. The creation hook's record is used.
 */
describe("bm.boundary from the creation hook's record (live check 2026-10-01 F1)", () => {
  function created() {
    const handlers: Record<string, (event: unknown, context: unknown) => Promise<void>> = {};
    const host = {
      on: vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
        handlers[name] = handler;
        return () => {};
      }),
    };
    return { host, handlers };
  }

  it("labels a new Worker and Reviewer whose snapshot has no prompt yet from the hook's record, matched by alias and folder", async () => {
    forgetCreatedBoundaries();
    // The live shape: no bm.role, no labels, `persistence: null`.
    const { paseo } = daemonWith({ w1: { labels: {}, persistence: null }, r1: { labels: {}, persistence: null }, w2: { labels: {}, persistence: null } });
    const cliFake = fakeCli();
    const { host, handlers } = created();
    registerAgentLabels(host as never, createAgentLabeller({ cli: cliFake.cli, log: () => {} }));
    rememberCreatedBoundary("bm-worker/gpt-5.6-luna", "/work/on", "on");
    rememberCreatedBoundary("bm-reviewer", "/work/off", "off");
    await handlers["agent.created"]!({ agent: { id: "w1", provider: "bm-worker", cwd: "/work/on", parentAgentId: null, workspaceId: null } }, { paseo });
    await handlers["agent.created"]!({ agent: { id: "r1", provider: "bm-reviewer/claude-haiku-4-5", cwd: "/work/off", parentAgentId: null, workspaceId: null } }, { paseo });
    // No record for this one (the hook ran in another plugin run): no bm.boundary, as before.
    await handlers["agent.created"]!({ agent: { id: "w2", provider: "bm-worker", cwd: "/work/on", parentAgentId: null, workspaceId: null } }, { paseo });
    const labelRuns = cliFake.runs.filter((run) => run[2] === "update");
    expect(labelRuns).toEqual([
      ["/opt/fake/paseo", "agent", "update", "w1", "--label", "bm.role=worker", "--label", `bm.instructions=${currentInstructionsHash("worker")}`, "--label", "bm.boundary=on", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r1", "--label", "bm.role=reviewer", "--label", `bm.instructions=${currentInstructionsHash("reviewer")}`, "--label", "bm.boundary=off", "--json"],
      ["/opt/fake/paseo", "agent", "update", "w2", "--label", "bm.role=worker", "--label", `bm.instructions=${currentInstructionsHash("worker")}`, "--json"],
    ]);
  });

  it("the prompt's facts line wins when the snapshot shows it, and the record is used up either way", async () => {
    forgetCreatedBoundaries();
    const facts = `${REVIEWER_INSTRUCTIONS.trimEnd()}\n\n## Runtime facts\n\nAction boundary: on\n`;
    const { labeller, paseo, runs } = setup({ r1: { labels: { "bm.role": "reviewer" }, persistence: { metadata: { systemPrompt: facts } } } });
    rememberCreatedBoundary("bm-reviewer", "/work/on", "off");
    await labeller.labelAgent("r1", "bm-reviewer", paseo, { created: true, cwd: "/work/on" });
    expect(runs[0]).toContain("bm.boundary=on");
    expect(takeCreatedBoundary("bm-reviewer", "/work/on")).toBeNull();
  });

  it("a record is taken oldest first, once, and expires after CREATED_BOUNDARY_MS", () => {
    forgetCreatedBoundaries();
    rememberCreatedBoundary("bm-worker", "/w", "on", 1_000);
    rememberCreatedBoundary("bm-worker", "/w", "off", 2_000);
    expect(takeCreatedBoundary("bm-worker", "/w", 3_000)).toBe("on");
    expect(takeCreatedBoundary("bm-worker", "/w", 3_000)).toBe("off");
    expect(takeCreatedBoundary("bm-worker", "/w", 3_000)).toBeNull();
    rememberCreatedBoundary("bm-worker", "/w", "on", 0);
    expect(takeCreatedBoundary("bm-worker", "/w", CREATED_BOUNDARY_MS + 1)).toBeNull();
    // Nothing is kept without a provider or a folder.
    rememberCreatedBoundary(undefined, "/w", "on");
    rememberCreatedBoundary("bm-worker", "", "on");
    expect(takeCreatedBoundary("bm-worker", "/w")).toBeNull();
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
    const { paseo } = daemonWith({ [ID]: { labels: {} } });
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

  it("hands every turn_started agent to the title marker (a cleared conversation loses its marker)", () => {
    const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
    const host = { on: vi.fn((name: string, handler: (event: unknown, context: unknown) => unknown) => ((handlers[name] = handler), () => {})) };
    const titles = { remark: vi.fn(async () => "marked" as const) };
    const { paseo } = daemonWith({});
    registerAgentLabels(host as never, createAgentLabeller({ cli: fakeCli().cli, log: () => {} }), {}, undefined, titles);

    handlers["agent.turn_started"]!({ agent: { id: "m1", provider: "bm-manager", title: null }, turnId: null }, { paseo });
    handlers["agent.turn_started"]!(null, { paseo });
    expect(titles.remark).toHaveBeenCalledTimes(1);
    expect(titles.remark).toHaveBeenCalledWith({ id: "m1", provider: "bm-manager", title: null }, paseo);
  });

  it("is a no-op on a host without on()", () => {
    expect(() => registerAgentLabels({})()).not.toThrow();
  });
});

describe("the once-per-run label scan (owner decision Q6 a, design §7.1)", () => {
  /** The shared fake SDK holding these agents; with `listError`, every listing rejects with it. */
  function scanPaseo(agents: Array<ScanAgentSnapshot & LabelAgentSnapshot>, listError?: Error) {
    const fake = fakePaseo<ScanPaseo>({ agents });
    if (listError) fake.api.agents.list.mockRejectedValue(listError);
    return fake;
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
      // A label alone is no role, and a disagreeing label is display only (design §16.3): neither is written.
      { id: "c-labelled", provider: "claude", labels: { "bm.role": "worker" } },
      { id: "w-mislabelled", provider: "bm-worker", labels: { "bm.role": "reviewer" } },
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
    // The scan never stamps bm.instructions; agent.created (w1 here) does, once.
    expect(cliFake.runs).toEqual([
      ["/opt/fake/paseo", "agent", "update", "m-plain", "--label", "bm.role=manager", "--label", "bm.modeSet=bypassPermissions", "--json"],
      ["/opt/fake/paseo", "agent", "update", "r-plain", "--label", "bm.role=reviewer", "--json"],
      ["/opt/fake/paseo", "agent", "update", "w1", "--label", `bm.instructions=${currentInstructionsHash("worker")}`, "--json"],
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
