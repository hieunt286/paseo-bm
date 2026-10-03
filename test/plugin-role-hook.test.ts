import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import contribute from "../plugin/index.server";
import { ROLE_PROMPT_SEPARATOR, applyAgentTools, applyRoleInstructions, applyRoleModel, chooseModeId, registerRoleHook, workspaceOfFolder, type AgentCreateRequest, type ProviderMode } from "../plugin/server/role-hook";
import { LOOKUP_TIMEOUT_MS, ROLE_GETS_MODE, TIMED_OUT, capabilityOf, forgetModes, modesFor, runPostureOf, withTimeout } from "../plugin/server/role-mode";
import { OWNER_PRECEDENTS_HEADING, currentInstructions } from "../plugin/server/role-instructions";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { BOUNDARY_MODES, boundaryPostureOf, creatorModeOffBoundary } from "../plugin/server/role-mode";
import { currentInstructionsHash, instructionsHashOf, roleTextOf } from "../plugin/server/instructions-label";
import { forgetCreatedBoundaries, takeCreatedBoundary } from "../plugin/server/created-boundary";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";

// The entry resolves the install home from $HOME when Paseo's config names no
// plugin path; point it at an empty directory so this machine's real
// ~/.paseo-bm never leaks into the test.
const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-isolated-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * bm-hld: every paseo-bm agent gets its role instructions, whoever creates it.
 * Paseo's `create_agent` tool has no system-prompt parameter, so the plugin
 * injects it through `before("agent.create")`, keyed by provider id.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const roleMd = (role: string) => readFileSync(join(repoRoot, "plugin", "roles", `${role}.md`), "utf8");
const managerMd = roleMd("manager");
const workerMd = roleMd("worker");
const reviewerMd = roleMd("reviewer");
const orchestratorMd = roleMd("orchestrator");
/**
 * What a Worker gets on a host that cannot read the bm-reviewer modes: its role
 * text plus the fallback Reviewer mode `auto` (delta 20260918g §4.9, owner
 * decisions Q4 a and Q9 a), because Paseo refuses a Reviewer created without
 * a mode. Before that delta it got the role text alone.
 */
/** The owner's review budget a new Worker is told, at its defaults (autonomy design §G.7, bead 7gxw.12). */
const BUDGET_LINE = "Review calls per request: Small 2, Medium 2, Large 4.";
/**
 * A Worker's and a Reviewer's own `Action boundary` facts line (autonomy design
 * §D.2, change-010): off, with why, unless the project's switch is on. A host
 * that lists no workspace cannot tell the project.
 */
const BOUNDARY_UNKNOWN = "Action boundary: off — the project could not be told from the agent's folder";
const BOUNDARY_OFF = "Action boundary: off — the project's boundary is off";
const workerFacts = (reviewerMode: string, boundary = BOUNDARY_UNKNOWN) =>
  `${workerMd.trimEnd()}\n\n## Runtime facts\n\nReviewer mode: \`${reviewerMode}\` — pass it as \`settings.modeId\` when you create a Reviewer.\n${BUDGET_LINE}\n${boundary}\n`;
const workerWithFallback = workerFacts("auto");
const reviewerWith = (boundary = BOUNDARY_UNKNOWN) => `${reviewerMd.trimEnd()}\n\n## Runtime facts\n\n${boundary}\n`;

// The fallback prefers a list read earlier in the run; start every test without one.
beforeEach(() => forgetModes());

type Request = { config?: Record<string, unknown>; env?: Record<string, string> };
type BeforeHandler = (input: { request: Request }, context: unknown) => unknown;

function fakeServer(options: { withBefore?: boolean } = {}) {
  const hooks = new Map<string, BeforeHandler>();
  const removers: string[] = [];
  const server: Record<string, unknown> = {
    handle: vi.fn(),
    registerSettings: vi.fn(),
  };
  if (options.withBefore !== false) {
    server.before = vi.fn((name: string, handler: BeforeHandler) => {
      hooks.set(name, handler);
      return () => {
        removers.push(name);
        hooks.delete(name);
      };
    });
  }
  return { server, hooks, removers };
}

function setup(paseo: unknown = {}) {
  const fake = fakeServer();
  const cleanup = contribute(fake.server as unknown as Parameters<typeof contribute>[0]);
  const hook = fake.hooks.get("agent.create");
  expect(hook).toBeTypeOf("function");
  const run = (request: Request) =>
    Promise.resolve(hook!({ request }, { paseo, signal: new AbortController().signal })) as Promise<Request | undefined>;
  return { ...fake, cleanup, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("before(\"agent.create\") role hook", () => {
  it("registers exactly one agent.create hook", async () => {
    const { server, hooks } = setup();
    expect(server.before).toHaveBeenCalledTimes(1);
    expect([...hooks.keys()]).toEqual(["agent.create"]);
  });

  it("gives bm-worker the text of roles/worker.md and keeps the rest of the request", async () => {
    const { run } = setup();
    const request = { config: { provider: "bm-worker", cwd: "/repo", modeId: "default", model: "gpt-5.6-sol" }, env: { A: "1" } };
    const result = (await run(request));
    // This host lists no modes, so the Worker also gets the fallback Reviewer mode.
    expect(result).toEqual({ config: { ...request.config, systemPrompt: workerWithFallback }, env: { A: "1" } });
    expect(request.config).not.toHaveProperty("systemPrompt");
  });

  it("recognises a provider given as <id>/<model>", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-worker/gpt-5.6-sol", cwd: "/repo" } }))?.config?.systemPrompt).toBe(workerWithFallback);
  });

  it("gives a fallback Worker bm-worker-fallback-1/<model> the Worker's instructions (delta 20260921 §4.4.1)", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-worker-fallback-1/qwen3-coder", cwd: "/repo" } }))?.config?.systemPrompt).toBe(workerWithFallback);
    expect(await run({ config: { provider: "bm-worker-fallback-4/qwen3-coder", cwd: "/repo" } })).toBeUndefined();
  });

  it("marks a paseo-bm agent's title with its role, and leaves another provider's alone", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo", title: "Fix login" } }))?.config?.title).toBe("🔵 W · Fix login");
    expect(await run({ config: { provider: "claude/opus", cwd: "/repo", title: "Mine" } })).toBeUndefined();
  });

  it("gives bm-reviewer the text of roles/reviewer.md", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-reviewer", cwd: "/repo" } }))?.config?.systemPrompt).toBe(reviewerWith());
  });

  it("puts the role instructions first and keeps a different existing system prompt after them", async () => {
    const { run } = setup();
    const result = (await run({ config: { provider: "bm-reviewer", cwd: "/repo", systemPrompt: "Review only src/." } }));
    expect(result?.config?.systemPrompt).toBe(`${reviewerWith()}${ROLE_PROMPT_SEPARATOR}Review only src/.`);
  });

  it("does not duplicate instructions that are already in the system prompt", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo", systemPrompt: workerWithFallback } }))).toBeUndefined();
    const once = (await run({ config: { provider: "bm-worker", cwd: "/repo", systemPrompt: "extra" } }));
    expect((await run(once!))).toBeUndefined();
  });

  it("sets roles/manager.md for a bm-manager created without it", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-manager/opus", cwd: "/repo" } }))?.config?.systemPrompt).toBe(managerMd);
    expect((await run({ config: { provider: "bm-manager", cwd: "/repo", systemPrompt: "   " } }))?.config?.systemPrompt).toBe(managerMd);
  });

  it("leaves a bm-manager created by manager.ensure unchanged", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-manager/opus", cwd: "/repo", systemPrompt: managerMd } }))).toBeUndefined();
  });

  it("does not touch agents of other providers", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "claude", cwd: "/repo" } }))).toBeUndefined();
    expect((await run({ config: { provider: "codex/gpt-5", cwd: "/repo", systemPrompt: "x" } }))).toBeUndefined();
    expect((await run({ config: { provider: "bm-workers", cwd: "/repo" } }))).toBeUndefined();
    expect((await run({ config: { provider: "toString", cwd: "/repo" } }))).toBeUndefined();
  });

  it.each([
    ["no request", undefined],
    ["null request", null],
    ["empty request", {}],
    ["null config", { config: null }],
    ["config without provider", { config: { cwd: "/repo" } }],
    ["non-string provider", { config: { provider: 42 } }],
    ["non-string systemPrompt", { config: { provider: "bm-worker", systemPrompt: 7 } }],
  ])("never throws on a malformed request (%s)", (_name, request) => {
    const fake = fakeServer();
    contribute(fake.server as unknown as Parameters<typeof contribute>[0]);
    const hook = fake.hooks.get("agent.create")!;
    expect(() => hook({ request: request as Request }, {})).not.toThrow();
    expect(() => hook(undefined as unknown as { request: Request }, {})).not.toThrow();
  });

  it("replaces a non-string systemPrompt with the instructions", async () => {
    expect(applyRoleInstructions({ config: { provider: "bm-worker", systemPrompt: 7 } } as never)?.config.systemPrompt).toBe(workerMd);
  });

  it("removes the hook on cleanup", async () => {
    const { cleanup, hooks, removers } = setup();
    cleanup();
    expect(removers).toEqual(["agent.create"]);
    expect(hooks.size).toBe(0);
  });

  it("skips the hook safely, with one log line, on a host without before()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = fakeServer({ withBefore: false });
    let cleanup: () => void = () => {};
    expect(() => {
      cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/agent\.create/);
    expect(() => cleanup()).not.toThrow();
  });
});

/**
 * delta 20260917c §4.6: the hook chooses the start mode, so no role file has to
 * teach it. The two lists below are what `providers.listModes` returned on the
 * owner's daemon on 2026-09-17 (read-only probe) for `bm-worker` (Claude) and
 * `bm-reviewer` (Codex).
 */
const m = (id: string, colorTier: string, label = id): ProviderMode => ({ id, label, colorTier });
const CLAUDE_MODES = [m("plan", "planning"), m("default", "safe"), m("acceptEdits", "moderate"), m("auto", "moderate"), m("bypassPermissions", "dangerous")];
const CODEX_MODES = [m("auto", "moderate"), m("auto-review", "moderate"), m("full-access", "dangerous")];

describe("chooseModeId (owner decision bm-msy)", () => {
  it("starts a Worker in the mode that runs without approval prompts", () => {
    expect(chooseModeId("worker", CLAUDE_MODES, undefined)).toBe("bypassPermissions");
    expect(chooseModeId("worker", CODEX_MODES, undefined)).toBe("full-access");
  });

  it("falls back to moderate, then safe, and never picks planning for a Worker", () => {
    expect(chooseModeId("worker", [m("plan", "planning"), m("default", "safe"), m("acceptEdits", "moderate")], undefined)).toBe("acceptEdits");
    expect(chooseModeId("worker", [m("plan", "planning"), m("default", "safe")], undefined)).toBe("default");
    expect(chooseModeId("worker", [m("plan", "planning")], undefined)).toBeUndefined();
  });

  it("keeps a mode the Worker's creator already chose", () => {
    expect(chooseModeId("worker", CLAUDE_MODES, "default")).toBeUndefined();
    expect(chooseModeId("worker", CLAUDE_MODES, "plan")).toBeUndefined();
  });

  it("starts a Reviewer in auto on both providers", () => {
    expect(chooseModeId("reviewer", CODEX_MODES, undefined)).toBe("auto");
    expect(chooseModeId("reviewer", CLAUDE_MODES, undefined)).toBe("auto");
  });

  it("without auto, gives a Reviewer the first moderate mode that opens neither full access nor the network, else safe", () => {
    const modes = [m("net", "moderate", "Network access"), m("fully", "moderate"), m("edits", "moderate"), m("ro", "safe")];
    expect(chooseModeId("reviewer", modes, undefined)).toBe("edits");
    expect(chooseModeId("reviewer", [m("net", "moderate", "Network access"), m("ro", "safe"), m("all", "dangerous")], undefined)).toBe("ro");
    expect(chooseModeId("reviewer", [m("all", "dangerous"), m("plan", "planning")], undefined)).toBeUndefined();
  });

  it("downgrades a Reviewer created in a dangerous or planning mode, and keeps any other choice", () => {
    expect(chooseModeId("reviewer", CODEX_MODES, "full-access")).toBe("auto");
    expect(chooseModeId("reviewer", CLAUDE_MODES, "bypassPermissions")).toBe("auto");
    expect(chooseModeId("reviewer", CLAUDE_MODES, "plan")).toBe("auto");
    expect(chooseModeId("reviewer", CODEX_MODES, "auto-review")).toBeUndefined();
    expect(chooseModeId("reviewer", CODEX_MODES, "auto")).toBeUndefined();
  });

  it("does not guess about a mode the provider does not list", () => {
    expect(chooseModeId("reviewer", CODEX_MODES, "yolo")).toBeUndefined();
  });

  it("leaves the Manager's mode to manager.ensure, and ignores empty or malformed lists", () => {
    expect(chooseModeId("manager", CLAUDE_MODES, undefined)).toBeUndefined();
    expect(chooseModeId("worker", [], undefined)).toBeUndefined();
    expect(chooseModeId("worker", [{ id: "" }, null as unknown as ProviderMode], undefined)).toBeUndefined();
  });
});

describe("before(\"agent.create\") start mode", () => {
  function paseoWith(listModes: (provider: string) => unknown) {
    const spy = vi.fn(listModes);
    return { spy, paseo: { providers: { listModes: spy } } };
  }

  // Errata 2026-09-18 of delta 20260917c §4.6 (owner decision Q1a): a Worker's
  // instructions carry the Reviewer mode it must pass, as the Manager's carry
  // the Worker mode.
  const workerWithReviewerMode = (mode: string) => workerFacts(mode);

  it("starts a Worker created without a mode in the no-prompt mode, looking up the bare provider id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, paseo } = paseoWith(async () => ({ provider: "bm-worker", modes: CLAUDE_MODES, error: null }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo" }, env: { A: "1" } });
    // The bare provider id, plus the cwd hint so the daemon can answer from the
    // snapshot it already warmed for this directory (review b2).
    expect(spy.mock.calls[0]).toEqual(["bm-worker", { cwd: "/repo" }]);
    expect(spy.mock.calls[1]).toEqual(["bm-reviewer", { cwd: "/repo" }]);
    expect(result).toEqual({
      config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", systemPrompt: workerWithReviewerMode("auto"), modeId: "bypassPermissions" },
      env: { A: "1" },
    });
  });

  it("looks up a fallback Worker's modes by its own alias, not the main one (delta 20260921 §4.4.1)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, paseo } = paseoWith(async (provider: string) => ({ provider, modes: CLAUDE_MODES, error: null }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker-fallback-1/claude-opus-5", cwd: "/repo" } });
    expect(spy.mock.calls[0]).toEqual(["bm-worker-fallback-1", { cwd: "/repo" }]);
    expect(result?.config).toMatchObject({ systemPrompt: workerWithReviewerMode("auto"), modeId: "bypassPermissions" });
  });

  it("gives a Worker the Reviewer mode it must pass, as Runtime facts after its role text (errata K10, Q1a)", async () => {
    // Delta 20260921 §4.2.1: an empty list now means "a provider without modes"
    // (Pi), whose mode is removed; the Worker's own list is Claude's here.
    const { paseo } = paseoWith(async (provider) => ({ modes: provider === "bm-reviewer" ? CODEX_MODES : CLAUDE_MODES }));
    const { run } = setup(paseo);
    // The Manager passes the Worker mode, as it always must.
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config).toEqual({ provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions", systemPrompt: workerWithReviewerMode("auto") });
    // Written once: a Worker whose prompt already carries it is left alone.
    expect(await run(result!)).toBeUndefined();
  });

  it("creates the Worker with its role text and the fallback Reviewer mode, and logs both, when the Reviewer's modes cannot be read", async () => {
    // Before delta 20260918g the Worker got its role text alone here, and its
    // first Reviewer creation was refused (owner decisions Q4 a, Q9 a).
    const { paseo } = paseoWith(async () => ({ modes: [], error: "provider not ready" }));
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions" } }))?.config?.systemPrompt).toBe(workerWithFallback);
    // Delta 20260921 §4.2.1: the Worker's own modes are looked up too (its
    // capability class decides its auto-approve), and that failure is logged
    // first; the Worker keeps the mode its creator chose.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toMatch(/modes of bm-worker.*provider not ready/);
    expect(String(warn.mock.calls[1]![0])).toMatch(/bm-reviewer.*provider not ready/);
    expect(String(warn.mock.calls[2]![0])).toBe('[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "auto" (static fallback).');
  });

  it("gives a Worker the mode its own profile sets, over the plugin's pick (bm-msy)", async () => {
    const { paseo } = paseoWith(async () => ({ modes: CLAUDE_MODES }));
    const withProfile = { ...paseo, config: { get: async () => ({ config: { agentProfiles: [{ id: "bm-worker", modeId: "acceptEdits" }] } }) } };
    const { run } = setup(withProfile);
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.modeId).toBe("acceptEdits");
  });

  it("ignores a dangerous profile mode for the Reviewer", async () => {
    const { paseo } = paseoWith(async () => ({ modes: CODEX_MODES }));
    const withProfile = { ...paseo, config: { get: async () => ({ config: { agentProfiles: [{ id: "bm-reviewer", modeId: "full-access" }] } }) } };
    const { run } = setup(withProfile);
    expect((await run({ config: { provider: "bm-reviewer", cwd: "/repo" } }))?.config?.modeId).toBe("auto");
  });

  it("still creates the agent with its instructions when the lookups are too slow (review b2)", async () => {
    // The plugin host fails the whole creation if a before hook exceeds 30 s.
    const never = new Promise(() => {});
    const { run } = setup({ providers: { listModes: () => never }, config: { get: () => never } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo" } });
    expect(result?.config?.systemPrompt).toBe(workerMd);
    expect(result?.config).not.toHaveProperty("modeId");
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/took longer than \d+ ms/);
  }, 20000);

  it("keeps a Worker's chosen mode, looking up its own modes only to learn the provider's class (delta 20260921 §4.2.1)", async () => {
    const { spy, paseo } = paseoWith(async () => ({ modes: CLAUDE_MODES }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "default" } });
    // Before delta 20260921 such a Worker cost only the REVIEWER's lookup; it
    // now also costs its own, because on an untiered provider (OpenCode) the
    // chosen mode is kept but auto-approve must be turned on.
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["bm-worker", "bm-reviewer"]);
    expect(result?.config?.modeId).toBe("default");
    expect(result?.config).not.toHaveProperty("featureValues");
  });

  it("starts a Reviewer in auto, and downgrades one created in full-access with one log line", async () => {
    const { paseo } = paseoWith(async () => ({ modes: CODEX_MODES }));
    const { run } = setup(paseo);
    // After setup: the fake host has no on(), so contribute() itself logs twice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await run({ config: { provider: "bm-reviewer", cwd: "/repo" } }))?.config?.modeId).toBe("auto");
    expect(warn).not.toHaveBeenCalled();
    const downgraded = await run({ config: { provider: "bm-reviewer", cwd: "/repo", modeId: "full-access" } });
    expect(downgraded?.config).toMatchObject({ modeId: "auto", systemPrompt: reviewerWith() });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/full-access.*auto/);
  });

  it("changes only the mode when the instructions are already in place", async () => {
    const { paseo } = paseoWith(async () => ({ modes: CODEX_MODES }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-reviewer", cwd: "/repo", systemPrompt: reviewerWith() } });
    expect(result?.config).toEqual({ provider: "bm-reviewer", cwd: "/repo", systemPrompt: reviewerWith(), modeId: "auto" });
  });

  it("never sets the Manager's own mode, and never looks anything up for other providers", async () => {
    const { spy, paseo } = paseoWith(async () => ({ modes: CLAUDE_MODES }));
    const { run } = setup(paseo);
    expect(await run({ config: { provider: "claude", cwd: "/repo" } })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const manager = await run({ config: { provider: "bm-manager", cwd: "/repo" } });
    expect(manager?.config).not.toHaveProperty("modeId");
    // Q22: the only lookup a Manager costs is the WORKER's modes, for its Runtime facts.
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["bm-worker"]);
  });

  it("gives a new Manager the Worker mode it must pass, as Runtime facts after its role text (Q22, K10)", async () => {
    const { paseo } = paseoWith(async (provider) => ({ modes: provider === "bm-worker" ? CLAUDE_MODES : [] }));
    const { run } = setup(paseo);
    const prompt = String((await run({ config: { provider: "bm-manager", cwd: "/repo" } }))?.config?.systemPrompt);
    expect(prompt).toBe(
      `${managerMd.trimEnd()}\n\n## Runtime facts\n\nWorker mode: \`bypassPermissions\` — pass it as \`settings.modeId\` when you create a Worker.\n`,
    );
    // Written once: a Manager whose prompt already carries it is left alone.
    expect(await run({ config: { provider: "bm-manager", cwd: "/repo", systemPrompt: prompt } })).toBeUndefined();
  });

  it("creates the Manager with its role text alone, and one log line, when the Worker's modes cannot be read", async () => {
    const { paseo } = paseoWith(async () => ({ modes: [], error: "provider not ready" }));
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await run({ config: { provider: "bm-manager", cwd: "/repo" } }))?.config?.systemPrompt).toBe(managerMd);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/bm-worker.*provider not ready/);
  });

  it.each([
    ["listModes rejects", { providers: { listModes: async () => { throw new Error("daemon busy"); } } }, /daemon busy/],
    ["listModes reports an error", { providers: { listModes: async () => ({ modes: [], error: "provider not ready" }) } }, /provider not ready/],
    ["listModes returns nothing", { providers: { listModes: async () => undefined } }, /no modes listed/],
    ["the host has no providers api", {}, /cannot list provider modes/],
  ])("still creates the agent, with its instructions and a log line per lookup, when %s", async (_name, paseo, logged) => {
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo" } });
    // The Runtime facts carry the fallback Reviewer mode (delta 20260918g §4.9).
    expect(result?.config?.systemPrompt).toBe(workerWithFallback);
    expect(result?.config).not.toHaveProperty("modeId");
    // One line for the Worker's own mode, one for the Reviewer mode of its Runtime facts, one for the fallback used.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toMatch(logged);
    expect(String(warn.mock.calls[0]![0])).toMatch(/bm-worker/);
    expect(String(warn.mock.calls[1]![0])).toMatch(logged);
    expect(String(warn.mock.calls[1]![0])).toMatch(/bm-reviewer/);
    expect(String(warn.mock.calls[2]![0])).toMatch(/fallback Reviewer mode "auto" \(static fallback\)/);
  });
});

describe("withTimeout", () => {
  it("returns the value when it arrives in time, even when the value is null", async () => {
    expect(await withTimeout(Promise.resolve(null), 1000)).toBeNull();
    expect(await withTimeout(Promise.resolve("x"), 1000)).toBe("x");
  });

  it("returns the sentinel, not null, when the work is too slow", async () => {
    expect(await withTimeout(new Promise(() => {}), 10)).toBe(TIMED_OUT);
  });

  it("waits well under the host's 30 s hook budget by default", () => {
    expect(LOOKUP_TIMEOUT_MS).toBeLessThan(30000);
  });
});

describe("before(\"agent.create\") profile thinking and features (delta 20260921 §4.1.1, REQ-062 a/b)", () => {
  type Profile = Record<string, unknown>;
  function paseoWithProfiles(profiles: Profile[], listModes: (provider: string) => unknown = async () => ({ modes: CLAUDE_MODES })) {
    const get = vi.fn(async () => ({ config: { agentProfiles: profiles } }));
    return { get, paseo: { providers: { listModes: vi.fn(listModes) }, config: { get } } };
  }
  const workerProfile = (extra: Profile = {}) => ({ id: "bm-worker", name: "Worker", provider: "bm-worker", model: "claude-opus-5", ...extra });

  it("gives a Worker created with its mode the thinking set on its profile, when the model is the profile's", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config?.thinkingOptionId).toBe("max");
    expect(result?.config?.modeId).toBe("bypassPermissions");
  });

  it("reads the model from config.model when the provider carries none", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const { run } = setup(paseo);
    const same = await run({ config: { provider: "bm-worker", model: "claude-opus-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(same?.config?.thinkingOptionId).toBe("max");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = await run({ config: { provider: "bm-worker", model: "claude-sonnet-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(other?.config?.model).toBe("claude-opus-5");
    expect(other?.config?.thinkingOptionId).toBe("max");
  });

  it("keeps a thinking level the creator passed", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", modeId: "bypassPermissions", thinkingOptionId: "low" } });
    expect(result?.config?.thinkingOptionId).toBe("low");
  });

  it("starts a Worker asked for another model on the profile's model, with the profile's thinking", async () => {
    // Clean-install run 2026-09-26: a Manager created before the user moved the
    // Worker to Codex still asked for bm-worker/claude-opus-5-5.
    const { paseo } = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker/claude-sonnet-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config?.provider).toBe("bm-worker/claude-opus-5");
    expect(result?.config?.thinkingOptionId).toBe("max");
    expect(warn.mock.calls.some((call) => /asked for model "claude-sonnet-5", but its profile names "claude-opus-5"/.test(String(call[0])))).toBe(true);
  });

  it("drops a thinking level chosen for the model it replaces, and uses the profile's instead", async () => {
    const withThinking = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const first = setup(withThinking.paseo);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const replaced = await first.run({ config: { provider: "bm-worker/claude-sonnet-5", cwd: "/repo", modeId: "bypassPermissions", thinkingOptionId: "low" } });
    expect(replaced?.config?.provider).toBe("bm-worker/claude-opus-5");
    expect(replaced?.config?.thinkingOptionId).toBe("max");

    const without = paseoWithProfiles([workerProfile()]);
    const second = setup(without.paseo);
    const cleared = await second.run({ config: { provider: "bm-worker/claude-sonnet-5", cwd: "/repo", modeId: "bypassPermissions", thinkingOptionId: "low" } });
    expect(cleared?.config?.provider).toBe("bm-worker/claude-opus-5");
    expect(cleared?.config).not.toHaveProperty("thinkingOptionId");
  });

  it("starts a Reviewer on its profile's model after the user moved it to another provider", async () => {
    const { paseo } = paseoWithProfiles([{ id: "bm-reviewer", name: "Reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" }], async () => ({ modes: CODEX_MODES }));
    const { run } = setup(paseo);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-reviewer/claude-opus-5-5", cwd: "/repo", modeId: "auto" } });
    expect(result?.config?.provider).toBe("bm-reviewer/gpt-5.6-sol");
  });

  it("leaves the model alone when it is the profile's, when the request names none, and on a fallback alias", async () => {
    const { paseo } = paseoWithProfiles([workerProfile()]);
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const same = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(same?.config?.provider).toBe("bm-worker/claude-opus-5");
    const none = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(none?.config?.provider).toBe("bm-worker");
    expect(none?.config).not.toHaveProperty("model");
    const fallback = await run({ config: { provider: "bm-worker-fallback-1/gpt-5.5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(fallback?.config?.provider).toBe("bm-worker-fallback-1/gpt-5.5");
    expect(warn.mock.calls.some((call) => /asked for model/.test(String(call[0])))).toBe(false);
  });

  it("sets the profile's thinking when the request names no model", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ thinkingOptionId: "max" })]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config?.thinkingOptionId).toBe("max");
  });

  it("treats everything after the first slash as the model (OpenCode ids contain a slash)", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ model: "anthropic/claude-sonnet-4-6", thinkingOptionId: "high" })]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/anthropic/claude-sonnet-4-6", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config?.thinkingOptionId).toBe("high");
  });

  it("merges the profile's feature values under the creator's, whose keys win", async () => {
    const { paseo } = paseoWithProfiles([workerProfile({ featureValues: { fast_mode: true, shared: "profile" } })]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions", featureValues: { shared: "creator" } } });
    expect(result?.config?.featureValues).toEqual({ fast_mode: true, shared: "creator" });
  });

  it("gives a Reviewer the thinking of the bm-reviewer profile and still applies the Reviewer mode rule", async () => {
    const { paseo } = paseoWithProfiles([{ id: "bm-reviewer", name: "Reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" }], async () => ({ modes: CODEX_MODES }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-reviewer/gpt-5.6-sol", cwd: "/repo" } });
    expect(result?.config?.thinkingOptionId).toBe("high");
    // A dangerous profile mode never reaches the Reviewer (REQ-062 b).
    expect(result?.config?.modeId).toBe("auto");
  });

  it("never touches a Manager: manager.ensure already passes its profile", async () => {
    const { paseo } = paseoWithProfiles([{ id: "bm-manager", name: "Manager", provider: "bm-manager", model: "claude-opus-5", thinkingOptionId: "max", featureValues: { fast_mode: true } }]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-manager/claude-opus-5", cwd: "/repo" } });
    expect(result?.config).not.toHaveProperty("thinkingOptionId");
    expect(result?.config).not.toHaveProperty("featureValues");
  });

  it("creates the Worker as before, without the profile's settings, when the profile cannot be read in time", async () => {
    const never = new Promise(() => {});
    const { run } = setup({ providers: { listModes: async () => ({ modes: CLAUDE_MODES }) }, config: { get: () => never } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config?.systemPrompt).toContain(workerMd.trimEnd());
    expect(result?.config).not.toHaveProperty("thinkingOptionId");
    expect(warn.mock.calls.some((call) => /took longer than \d+ ms/.test(String(call[0])))).toBe(true);
  }, 20000);
});

describe("run posture by provider capability (delta 20260921 §4.2.1–§4.2.2, REQ-063)", () => {
  // OpenCode's modes are the user's own OpenCode agents: no colorTier (design F1).
  const OPENCODE_MODES = [{ id: "bytes", label: "Bytes" }, { id: "review", label: "Review" }];
  const OPENCODE_FEATURES = [{ type: "toggle", id: "auto_accept", label: "Auto Accept", value: false }];
  const CLAUDE_FEATURES = [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }];

  it("classifies providers as tiered, untiered, none or unknown", () => {
    expect(capabilityOf(CLAUDE_MODES)).toBe("tiered");
    expect(capabilityOf(OPENCODE_MODES)).toBe("untiered");
    expect(capabilityOf([])).toBe("none");
    expect(capabilityOf(null)).toBe("unknown");
  });

  it("tells a provider with no modes (an empty list without error) from a list that cannot be read", async () => {
    const log = vi.fn();
    expect(await modesFor({ providers: { listModes: async () => ({ modes: [] }) } }, "bm-worker", log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(await modesFor({ providers: { listModes: async () => ({ modes: [], error: "not ready" }) } }, "bm-worker", log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("gives every cell of the posture table (3 roles × 4 classes)", () => {
    for (const role of ["manager", "worker", "reviewer"] as const) {
      expect(runPostureOf(role, "tiered", CLAUDE_MODES, CLAUDE_FEATURES, null)).toBeUndefined();
      expect(runPostureOf(role, "unknown", [], null, null)).toBeUndefined();
      expect(runPostureOf(role, "none", [], [], null)).toEqual({});
      expect(runPostureOf(role, "none", [], [], null, { modeId: "x", featureValues: { a: 1 } })).toEqual({ modeId: null, featureValues: null });
    }
    expect(runPostureOf("manager", "untiered", OPENCODE_MODES, OPENCODE_FEATURES, null)).toEqual({ modeId: "bytes", featureValues: { auto_accept: true } });
    expect(runPostureOf("worker", "untiered", OPENCODE_MODES, OPENCODE_FEATURES, null)).toEqual({ modeId: "bytes", featureValues: { auto_accept: true } });
    expect(runPostureOf("reviewer", "untiered", OPENCODE_MODES, OPENCODE_FEATURES, null)).toEqual({ modeId: "bytes", featureValues: { auto_accept: false } });
  });

  it("on an untiered provider always passes a listed mode: the creator's, else the profile's, else the first (design F11)", () => {
    expect(runPostureOf("worker", "untiered", OPENCODE_MODES, [], "review")).toEqual({ modeId: "review" });
    expect(runPostureOf("worker", "untiered", OPENCODE_MODES, [], "gone")).toEqual({ modeId: "bytes" });
    expect(runPostureOf("worker", "untiered", OPENCODE_MODES, [], "review", { modeId: "bytes" })).toEqual({});
  });

  it("leaves an auto_accept the Worker's profile or creator set, but never lets a Reviewer auto-approve", () => {
    expect(runPostureOf("worker", "untiered", OPENCODE_MODES, OPENCODE_FEATURES, null, { modeId: "bytes", featureValues: { auto_accept: false } })).toEqual({});
    expect(
      runPostureOf("reviewer", "untiered", OPENCODE_MODES, OPENCODE_FEATURES, null, { modeId: "bytes", featureValues: { auto_accept: true, other: 1 } }),
    ).toEqual({ featureValues: { auto_accept: false, other: 1 } });
    // The daemon may turn it on by itself (proposal P10) even when the features could not be read.
    expect(runPostureOf("reviewer", "untiered", OPENCODE_MODES, null, null, { modeId: "bytes", featureValues: { auto_accept: true } })).toEqual({
      featureValues: { auto_accept: false },
    });
  });

  function openCodePaseo(profiles: Array<Record<string, unknown>> = []) {
    const listModes = vi.fn(async () => ({ modes: OPENCODE_MODES }));
    const listFeatures = vi.fn(async () => ({ features: OPENCODE_FEATURES }));
    return { listModes, listFeatures, paseo: { providers: { listModes, listFeatures }, config: { get: async () => ({ config: { agentProfiles: profiles } }) } } };
  }

  it("creates a Worker on OpenCode with a listed mode and auto-approve on, reading the features of its own selection", async () => {
    const { listFeatures, paseo } = openCodePaseo();
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/anthropic/claude-sonnet-4-6", cwd: "/repo" } });
    expect(result?.config).toMatchObject({ modeId: "bytes", featureValues: { auto_accept: true } });
    expect(listFeatures).toHaveBeenCalledWith({ provider: "bm-worker/anthropic/claude-sonnet-4-6", cwd: "/repo" });
  });

  it("reads the features of the profile's model when the Worker was asked for another one", async () => {
    const { listFeatures, paseo } = openCodePaseo([{ id: "bm-worker", name: "Worker", provider: "bm-worker", model: "anthropic/claude-sonnet-4-6" }]);
    const { run } = setup(paseo);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker/openai/gpt-5.5", cwd: "/repo" } });
    expect(listFeatures).toHaveBeenCalledWith({ provider: "bm-worker/anthropic/claude-sonnet-4-6", cwd: "/repo" });
    expect(result?.config).toMatchObject({ provider: "bm-worker/anthropic/claude-sonnet-4-6", modeId: "bytes", featureValues: { auto_accept: true } });
  });

  it("keeps the mode the Manager passed to an OpenCode Worker and still turns auto-approve on", async () => {
    const { paseo } = openCodePaseo();
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "review" } });
    expect(result?.config).toMatchObject({ modeId: "review", featureValues: { auto_accept: true } });
  });

  it("NEGATIVE: never lets a Reviewer on OpenCode auto-approve, even when its profile says so", async () => {
    const { paseo } = openCodePaseo([{ id: "bm-reviewer", name: "Reviewer", provider: "bm-reviewer", featureValues: { auto_accept: true } }]);
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-reviewer", cwd: "/repo" } });
    expect(result?.config?.featureValues).toEqual({ auto_accept: false });
    expect(result?.config?.modeId).toBe("bytes");
  });

  it("creates Workers and Reviewers on Pi (no modes) without any mode or feature", async () => {
    const listFeatures = vi.fn();
    const { run } = setup({ providers: { listModes: async () => ({ modes: [] }), listFeatures } });
    for (const provider of ["bm-worker", "bm-reviewer"]) {
      const result = await run({ config: { provider, cwd: "/repo" } });
      expect(result?.config).not.toHaveProperty("modeId");
      expect(result?.config).not.toHaveProperty("featureValues");
    }
    expect(listFeatures).not.toHaveBeenCalled();
  });

  it("costs no features round trip on a tiered provider", async () => {
    const listFeatures = vi.fn();
    const { run } = setup({ providers: { listModes: async () => ({ modes: CLAUDE_MODES }), listFeatures } });
    await run({ config: { provider: "bm-worker", cwd: "/repo" } });
    await run({ config: { provider: "bm-reviewer", cwd: "/repo" } });
    expect(listFeatures).not.toHaveBeenCalled();
  });
});

describe("run posture — review b4 fixes (delta 20260921 §4.2.2)", () => {
  const OPENCODE_MODES = [{ id: "bytes" }, { id: "review" }];

  it("NEGATIVE: gives an untiered Reviewer auto_accept false even when its features cannot be read or omit the toggle", () => {
    expect(runPostureOf("reviewer", "untiered", OPENCODE_MODES, null, null)).toEqual({ modeId: "bytes", featureValues: { auto_accept: false } });
    expect(runPostureOf("reviewer", "untiered", OPENCODE_MODES, [], null, { modeId: "bytes" })).toEqual({ featureValues: { auto_accept: false } });
  });

  it("NEGATIVE: an OpenCode Reviewer whose features lookup fails still leaves the hook with auto_accept false", async () => {
    const { run } = setup({
      providers: { listModes: async () => ({ modes: OPENCODE_MODES }), listFeatures: async () => ({ error: "not ready" }) },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-reviewer", cwd: "/repo" } });
    warn.mockRestore();
    expect(result?.config?.featureValues).toEqual({ auto_accept: false });
  });

  it("removes a creator's mode and a profile's features on Pi (no modes)", async () => {
    const { run } = setup({
      providers: { listModes: async () => ({ modes: [] }) },
      config: { get: async () => ({ config: { agentProfiles: [{ id: "bm-worker", featureValues: { fast_mode: true } }] } }) },
    });
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "bypassPermissions" } });
    expect(result?.config).not.toHaveProperty("modeId");
    expect(result?.config).not.toHaveProperty("featureValues");
  });
});

/**
 * The fourth role (orchestrator design §3.1, REQ-077 c): a `bm-orchestrator`
 * creation gets roles/orchestrator.md, its profile's model and thinking, and a
 * mode under the Reviewer's rule — never a dangerous or planning one, never
 * auto-approve — no Paseo tools, and on a provider that can pre-approve MCP
 * tools its own tools, all pre-approved, at `/mcp/orchestrator/<secret>`
 * (§5.1, WP-603).
 */
describe("before(\"agent.create\") for bm-orchestrator (orchestrator design §3.1)", () => {
  const orchestratorProfile = (extra: Record<string, unknown> = {}) => ({
    id: "bm-orchestrator",
    name: "Beads Orchestrator",
    provider: "bm-orchestrator",
    model: "claude-opus-5",
    ...extra,
  });
  function paseoFor(options: { base?: string; modes?: ProviderMode[]; profile?: Record<string, unknown> | null; features?: unknown[] } = {}) {
    const listModes = vi.fn(async () => ({ modes: options.modes ?? CLAUDE_MODES }));
    const listFeatures = vi.fn(async () => ({ features: options.features ?? [] }));
    const get = vi.fn(async () => ({
      config: {
        providers: { "bm-orchestrator": { extends: options.base ?? "claude", label: "Beads Orchestrator" } },
        agentProfiles: options.profile === null ? [] : [options.profile ?? orchestratorProfile()],
      },
    }));
    return { listModes, paseo: { providers: { listModes, listFeatures }, config: { get } } };
  }
  const SECRET = "ab".repeat(32);
  /** The endpoint's URLs: the Orchestrator's carries the secret (§5.1). */
  const urlFor = (role: string) => `http://127.0.0.1:4567/mcp/${role}${role === "orchestrator" ? `/${SECRET}` : ""}`;
  const ORCHESTRATOR_URL = `http://127.0.0.1:4567/mcp/orchestrator/${SECRET}`;
  const ORCHESTRATOR_GRANTS = ["bm_projects", "bm_request", "bm_agent_messages", "bm_send_command", "bm_decisions", "bm_ask_owner", "bm_decide", "bm_predict", "bm_direct_worker", "bm_repo", "bm_note", "bm_findings", "bm_compact", "bm_handoff", "bm_why", "bm_reply"].map((tool) => ({ kind: "mcp", server: "paseo-bm", tool }));
  /** The hook as index.server registers it, with a tool endpoint serving every role. */
  function hookWithTools(paseo: unknown, usePaseo?: (paseo: unknown) => void) {
    let hook: ((input: { request: AgentCreateRequest }, context: unknown) => unknown) | undefined;
    registerRoleHook({ before: ((_name: string, handler: typeof hook) => ((hook = handler), () => {})) as never }, { urlFor, ...(usePaseo === undefined ? {} : { usePaseo }) });
    return async (config: Record<string, unknown>) =>
      (await hook!({ request: { config } as unknown as AgentCreateRequest }, { paseo })) as AgentCreateRequest | undefined;
  }

  it("chooses its mode by the Reviewer's rule", () => {
    expect(ROLE_GETS_MODE.orchestrator).toBe(true);
    expect(chooseModeId("orchestrator", CLAUDE_MODES, undefined)).toBe("auto");
    expect(chooseModeId("orchestrator", CODEX_MODES, "full-access")).toBe("auto");
    expect(chooseModeId("orchestrator", CLAUDE_MODES, "plan")).toBe("auto");
    expect(chooseModeId("orchestrator", CLAUDE_MODES, "bypassPermissions", "bypassPermissions")).toBe("auto");
    expect(chooseModeId("orchestrator", CLAUDE_MODES, "default")).toBeUndefined();
  });

  it("gets roles/orchestrator.md, its profile's model and thinking, and auto, with its own tools and no Paseo tools", async () => {
    const { listModes, paseo } = paseoFor({ profile: orchestratorProfile({ thinkingOptionId: "high" }) });
    const create = hookWithTools(paseo);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await create({ provider: "bm-orchestrator/claude-haiku-5", cwd: "/repo" });
    expect(result?.config).toMatchObject({
      provider: "bm-orchestrator/claude-opus-5",
      systemPrompt: orchestratorMd,
      thinkingOptionId: "high",
      modeId: "auto",
      cwd: "/repo",
    });
    expect(listModes).toHaveBeenCalledWith("bm-orchestrator", { cwd: "/repo" });
    // No Paseo tools (it cannot create or message agents); only its own tool server, at the secret path (WP-603).
    expect(result?.config).not.toHaveProperty("paseoTools");
    expect(result?.config?.mcpServers).toEqual({ "paseo-bm": { type: "http", url: ORCHESTRATOR_URL, alwaysLoad: true } });
    expect(result?.config?.toolPolicy).toEqual({ preapproved: ORCHESTRATOR_GRANTS });
  });

  it("hands the endpoint the context's Paseo handle on every paseo-bm creation, and a failing hand-over costs nothing", async () => {
    const { paseo } = paseoFor();
    const given: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = hookWithTools(paseo, (handle) => given.push(handle));
    await create({ provider: "bm-orchestrator/claude-opus-5", cwd: "/repo" });
    await create({ provider: "claude/opus", cwd: "/repo" });
    expect(given).toEqual([paseo]);
    const broken = hookWithTools(paseo, () => {
      throw new Error("boom");
    });
    expect((await broken({ provider: "bm-orchestrator/claude-opus-5", cwd: "/repo" }))?.config?.toolPolicy).toEqual({ preapproved: ORCHESTRATOR_GRANTS });
  });

  it.each([
    ["dangerous", "bypassPermissions"],
    ["planning", "plan"],
  ])("replaces a %s mode, from its creator or from its profile, with the Reviewer's pick", async (_tier, modeId) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fromCreator = await hookWithTools(paseoFor().paseo)({ provider: "bm-orchestrator/claude-opus-5", cwd: "/repo", modeId });
    expect(fromCreator?.config?.modeId).toBe("auto");
    expect(warn.mock.calls.some(([line]) => String(line).includes(`"${modeId}"`))).toBe(true);
    const fromProfile = await hookWithTools(paseoFor({ profile: orchestratorProfile({ modeId }) }).paseo)({ provider: "bm-orchestrator/claude-opus-5", cwd: "/repo" });
    expect(fromProfile?.config?.modeId).toBe("auto");
  });

  it("keeps auto-approve off on an untiered provider, even when its profile turns it on", async () => {
    const { paseo } = paseoFor({
      base: "opencode",
      modes: [{ id: "build", label: "Build" }, { id: "review", label: "Review" }],
      features: [{ type: "toggle", id: "auto_accept", value: false }],
      profile: orchestratorProfile({ model: "anthropic/claude-sonnet-4-6", featureValues: { auto_accept: true } }),
    });
    const result = await hookWithTools(paseo)({ provider: "bm-orchestrator/anthropic/claude-sonnet-4-6", cwd: "/repo" });
    expect(result?.config?.featureValues).toEqual({ auto_accept: false });
    expect(result?.config?.modeId).toBe("build");
    expect(runPostureOf("orchestrator", "untiered", [{ id: "build" }], null, null)).toEqual({ modeId: "build", featureValues: { auto_accept: false } });
  });

  it("still gets its instructions when no profile or mode can be read", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-orchestrator", cwd: "/repo" } }))?.config?.systemPrompt).toBe(orchestratorMd);
  });

  it("gets its tools at /mcp/orchestrator/<secret> on Claude, Codex and OpenCode only, and no other role gets any of them", () => {
    const tools = { urlFor };
    const request = { config: { provider: "bm-orchestrator/m", cwd: "/repo" } } as unknown as AgentCreateRequest;
    for (const base of ["claude", "codex", "opencode"]) {
      const out = applyAgentTools(request, tools, base);
      expect(out?.config.mcpServers).toEqual({ "paseo-bm": { type: "http", url: ORCHESTRATOR_URL, alwaysLoad: true } });
      expect(out?.config.toolPolicy).toEqual({ preapproved: ORCHESTRATOR_GRANTS });
      expect(out?.config).not.toHaveProperty("paseoTools");
      for (const provider of ["bm-manager/m", "bm-worker/m", "bm-reviewer/m", "bm-worker-fallback-2/m"]) {
        const other = applyAgentTools({ config: { provider, cwd: "/repo" } } as unknown as AgentCreateRequest, tools, base);
        expect(other?.config.mcpServers?.["paseo-bm"]).not.toMatchObject({ url: expect.stringContaining("orchestrator") });
        // The Manager's bm_decisions is its own read-only face at /mcp/manager (autonomy design §A.9), not the Orchestrator's;
        // the Worker's bm_reply is its own face at /mcp/worker (change-014 outcome 3).
        const orchestratorOnly = ORCHESTRATOR_GRANTS.map((entry) => entry.tool).filter((tool) => tool !== "bm_decisions" && tool !== "bm_reply");
        for (const grant of other?.config.toolPolicy?.preapproved ?? []) expect(orchestratorOnly).not.toContain(grant.tool);
      }
    }
    // Paseo refuses a toolPolicy on Pi, Oh My Pi, Copilot and other ACP providers: the agent must still be created.
    for (const base of ["pi", "omp", "copilot", null]) expect(applyAgentTools(request, tools, base)).toBeUndefined();
  });

  it("the registered hook gives it no tool server when its base provider cannot pre-approve tools", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await hookWithTools(paseoFor({ base: "pi" }).paseo)({ provider: "bm-orchestrator/claude-opus-5", cwd: "/repo" });
    expect(result?.config?.systemPrompt).toBe(orchestratorMd);
    expect(result?.config).not.toHaveProperty("mcpServers");
    expect(result?.config).not.toHaveProperty("toolPolicy");
    expect(result?.config).not.toHaveProperty("paseoTools");
  });
});

/**
 * A model the hook replaces is one `[paseo-bm]` log line: its log file,
 * `model-corrections.json`, went with its only reader, the
 * `agent.model-corrected` rule (autonomy design §B.9).
 */
describe("applyRoleModel logs its corrections and writes nothing", () => {
  const profile = { model: "claude-opus-5", modeId: null, thinkingOptionId: null, featureValues: null };
  const request = (provider: string) => ({ config: { provider, cwd: "/repo/one" } }) as unknown as AgentCreateRequest;
  let dataHome: string;
  beforeEach(() => {
    dataHome = mkdtempSync(join(isolatedHome, "bm-data-"));
    process.env.PASEO_BM_HOME = dataHome;
  });
  afterEach(() => {
    delete process.env.PASEO_BM_HOME;
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("corrects the model with one log line, and leaves the data folder empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyRoleModel(request("bm-worker/claude-sonnet-5"), profile);
    expect(result?.config?.provider).toBe("bm-worker/claude-opus-5");
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      '[paseo-bm] bm-worker was asked for model "claude-sonnet-5", but its profile names "claude-opus-5"; starting it on "claude-opus-5".',
    ]);
    expect(readdirSync(dataHome)).toEqual([]);
  });

  it("changes nothing when the model is already the profile's, or on a Manager", () => {
    expect(applyRoleModel(request("bm-worker/claude-opus-5"), profile)).toBeUndefined();
    expect(applyRoleModel(request("bm-manager/claude-sonnet-5"), profile)).toBeUndefined();
  });
});

/**
 * Autonomy design §B.6, §B.9 (PRD REQ-124 b, REQ-117 c): a new Manager or
 * Worker is given the owner's active precedents of the workspace whose folder
 * is its `cwd`, and the global ones, newest 20, as `## Owner precedents`
 * after its Runtime facts. A Reviewer and the Orchestrator get none.
 */
describe("before(\"agent.create\") — the owner's precedents (design §B.6)", () => {
  let dataHome: string;
  const listing = {
    workspaces: {
      list: async () => ({
        entries: [
          { workspace: { id: "ws-1", directory: "/repo" } },
          { workspace: { id: "ws-2", directory: "/other" } },
          { workspace: { id: "ws-old", directory: "/repo", archivedAt: "2026-09-01T00:00:00.000Z" } },
        ],
      }),
    },
  };
  const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: `p:${id}`,
    scope: "ws-1",
    subject: `subject-${id}`,
    text: `Answer ${id}.`,
    sourceDecisionId: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2099-10-20T10:00:00.000Z",
    supersededBy: null,
    ...overrides,
  });
  // 21 of the workspace's, one global (the newest), one of another workspace, one expired, one superseded.
  const mine = Array.from({ length: 21 }, (_, i) => entry(`mine-${i}`, { createdAt: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z` }));
  const entries = [
    ...mine,
    entry("global", { scope: "all", createdAt: "2026-09-29T10:00:00.000Z" }),
    entry("theirs", { scope: "ws-2", createdAt: "2026-09-29T11:00:00.000Z" }),
    entry("expired", { createdAt: "2026-09-29T12:00:00.000Z", expiresAt: "2000-01-01T00:00:00.000Z" }),
    entry("superseded", { createdAt: "2026-09-29T13:00:00.000Z", supersededBy: "p:mine-20" }),
  ];
  const writePrecedents = (list: unknown[]) => {
    mkdirSync(join(dataHome, "autonomy"), { recursive: true });
    writeFileSync(join(dataHome, "autonomy", "precedents.json"), JSON.stringify({ version: 1, entries: list }));
  };
  const section = (prompt: unknown) => {
    const text = String(prompt);
    const at = text.indexOf(`${OWNER_PRECEDENTS_HEADING}\n\n`);
    return at === -1 ? null : text.slice(at).split("\n").filter((line) => line.startsWith("- `"));
  };

  beforeEach(() => {
    dataHome = mkdtempSync(join(isolatedHome, "bm-precedents-"));
    process.env.PASEO_BM_HOME = dataHome;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PASEO_BM_HOME;
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("never gives a new agent the additional instructions of an old role-extras.json, and leaves the file as it was (autonomy design §B.8)", async () => {
    // What an earlier build wrote: the file is retired, never read and never written.
    const old = `${JSON.stringify({ version: 1, roles: { manager: "HIDDEN-EXTRA-manager", worker: "HIDDEN-EXTRA-worker", reviewer: "HIDDEN-EXTRA-reviewer", orchestrator: "HIDDEN-EXTRA-orchestrator" } })}\n`;
    writeFileSync(join(dataHome, "role-extras.json"), old);
    const { run } = setup(listing);
    for (const provider of ["bm-manager", "bm-worker", "bm-reviewer"]) {
      const prompt = String((await run({ config: { provider, cwd: "/repo" } }))?.config?.systemPrompt);
      expect(prompt).not.toMatch(/HIDDEN-EXTRA/);
    }
    const manager = await currentInstructions("manager", listing, { workspaceId: "ws-1" });
    expect(manager).not.toMatch(/HIDDEN-EXTRA|Additional instructions/);
    expect(readFileSync(join(dataHome, "role-extras.json"), "utf8")).toBe(old);
  });

  it("gives a new Worker the workspace's and the global active ones, newest 20, after its Runtime facts", async () => {
    writePrecedents(entries);
    const { run } = setup(listing);
    const prompt = String((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.systemPrompt);
    const lines = section(prompt);
    expect(lines).toHaveLength(20);
    expect(lines![0]).toBe("- `subject-global` — Answer global. (all projects, until 2099-10-20)");
    expect(lines![1]).toBe("- `subject-mine-20` — Answer mine-20. (this project, until 2099-10-20)");
    // The two oldest of the workspace's fall past the 20 newest.
    expect(lines!.slice(1).map((line) => /`(subject-mine-\d+)`/.exec(line)?.[1])).toEqual(mine.slice(2).reverse().map((p) => p.subject));
    for (const other of ["subject-theirs", "subject-expired", "subject-superseded"]) expect(prompt).not.toContain(other);
    // After the role text and its Runtime facts, which keep their order.
    expect(prompt.startsWith(`${workerFacts("auto", BOUNDARY_OFF).trimEnd()}\n\n${OWNER_PRECEDENTS_HEADING}\n\n`)).toBe(true);
    // The bm.instructions label is the role file's hash, and agent-labels.ts still finds the role text in the prompt.
    expect(prompt).toContain(roleTextOf("worker"));
    expect(currentInstructionsHash("worker")).toBe(instructionsHashOf(workerMd));
  });

  it("gives a new Manager the same part, and a Reviewer or the Orchestrator none", async () => {
    writePrecedents(entries);
    const { run } = setup(listing);
    const manager = String((await run({ config: { provider: "bm-manager", cwd: "/repo" } }))?.config?.systemPrompt);
    expect(section(manager)).toHaveLength(20);
    expect(manager).toContain(roleTextOf("manager"));
    for (const provider of ["bm-reviewer", "bm-orchestrator"]) {
      const prompt = (await run({ config: { provider, cwd: "/repo" } }))?.config?.systemPrompt;
      expect(String(prompt), provider).not.toContain(OWNER_PRECEDENTS_HEADING);
    }
  });

  it("gives only the global ones when the workspace of the cwd cannot be told", async () => {
    writePrecedents(entries);
    for (const [paseo, cwd] of [[listing, "/elsewhere"], [{}, "/repo"], [{ workspaces: { list: async () => { throw new Error("busy"); } } }, "/repo"]] as const) {
      const { run } = setup(paseo);
      const prompt = (await run({ config: { provider: "bm-worker", cwd } }))?.config?.systemPrompt;
      expect(section(prompt)).toEqual(["- `subject-global` — Answer global. (all projects, until 2099-10-20)"]);
    }
  });

  it("gives a new Worker the owner's review budget from Settings → Coordination; a Worker created before keeps its own (bead 7gxw.12)", async () => {
    const { run } = setup(listing);
    const before = String((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.systemPrompt);
    expect(before).toContain(`\n${BUDGET_LINE}\n`);
    createCoordinationStore(dataHome).set({ key: "review.largeBudget", value: 6 });
    const after = String((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.systemPrompt);
    expect(after).toContain("\nReview calls per request: Small 2, Medium 2, Large 6.\n");
    // The earlier Worker's instructions were fixed when it was created: nothing sends it the new budget.
    expect(before).toContain(`\n${BUDGET_LINE}\n`);
    // Only a Worker is told a budget.
    for (const provider of ["bm-manager", "bm-reviewer", "bm-orchestrator"]) {
      expect(String((await run({ config: { provider, cwd: "/repo" } }))?.config?.systemPrompt), provider).not.toContain("Review calls per request");
    }
  });

  it("writes no heading when there are none, or when the store cannot be read, and still creates the agent", async () => {
    const { run } = setup(listing);
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.systemPrompt).toBe(workerFacts("auto", BOUNDARY_OFF));
    writePrecedents([entry("expired", { expiresAt: "2000-01-01T00:00:00.000Z" }), entry("theirs", { scope: "ws-2" })]);
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo" } }))?.config?.systemPrompt).toBe(workerFacts("auto", BOUNDARY_OFF));
    writeFileSync(join(dataHome, "autonomy", "precedents.json"), "{ not json");
    expect((await run({ config: { provider: "bm-manager", cwd: "/repo" } }))?.config?.systemPrompt).toBe(managerMd);
  });

  it("keeps a Manager's prompt that manager.ensure already built with its precedents, without a second copy", async () => {
    writePrecedents(entries);
    const { run } = setup(listing);
    // manager.ensure read the store a moment earlier, when only the global one existed.
    const built = `${managerMd.trimEnd()}\n\n${OWNER_PRECEDENTS_HEADING}\n\n- \`subject-global\` — Answer global. (all projects, until 2099-10-20)\n`;
    expect(await run({ config: { provider: "bm-manager/opus", cwd: "/repo", systemPrompt: built } })).toBeUndefined();
  });
});

describe("workspaceOfFolder", () => {
  it("names the one live workspace whose folder is the cwd, else null", async () => {
    const paseo = (entries: unknown[]) => ({ workspaces: { list: async () => ({ entries }) } });
    expect(await workspaceOfFolder(paseo([{ workspace: { id: "ws-1", directory: "/repo" } }]), "/repo/")).toBe("ws-1");
    expect(await workspaceOfFolder(paseo([{ workspace: { id: "ws-1", directory: "/repo" } }, { workspace: { id: "ws-2", directory: "/repo" } }]), "/repo")).toBeNull();
    expect(await workspaceOfFolder(paseo([{ workspace: { id: "ws-1", directory: "/repo", archivedAt: "2026-09-01T00:00:00.000Z" } }]), "/repo")).toBeNull();
    expect(await workspaceOfFolder(paseo([]), "/repo")).toBeNull();
    expect(await workspaceOfFolder({}, "/repo")).toBeNull();
    expect(await workspaceOfFolder(null, "/repo")).toBeNull();
  });
});

/**
 * The action boundary per project (autonomy design §D.2, change-009 C2,
 * change-010 C1–C5): off by default; where the owner turned it on, a new
 * Worker or Reviewer on Claude or Codex starts in the least permissive mode,
 * and its Runtime facts say `Action boundary: on`. Elsewhere today's modes,
 * and a creator's boundary mode is moved back to today's pick.
 */
describe("before(\"agent.create\") — the action boundary per project (autonomy design §D.2, change-010)", () => {
  let dataHome: string;
  const ON_AT = "2026-10-01T08:00:00.000Z";
  const OPENCODE = [{ id: "bytes", label: "Bytes" }, { id: "review", label: "Review" }];
  const MODES: Record<string, ProviderMode[]> = { claude: CLAUDE_MODES, codex: CODEX_MODES, opencode: OPENCODE, pi: [] };
  const CODEX_WORKER_OPTIONS = { approval_policy: "untrusted", sandbox_mode: "danger-full-access", web_search: "disabled" };
  const CODEX_REVIEWER_OPTIONS = { approval_policy: "untrusted", sandbox_mode: "workspace-write", web_search: "disabled" };
  const ON = "Action boundary: on";

  /** A host with two projects (`/on` has the boundary on, `/off` not), each alias on `bases`' provider, and the profiles given. */
  function host(bases: Record<string, string>, profiles: Array<Record<string, unknown>> = []) {
    return {
      workspaces: {
        list: async () => ({ entries: [{ workspace: { id: "ws-on", directory: "/on" } }, { workspace: { id: "ws-off", directory: "/off" } }] }),
      },
      providers: {
        listModes: async (alias: string) => ({ modes: MODES[bases[alias] ?? ""] ?? [] }),
        listFeatures: async () => ({ features: [{ type: "toggle", id: "auto_accept", value: false }] }),
      },
      config: {
        get: async () => ({
          config: { providers: Object.fromEntries(Object.entries(bases).map(([alias, base]) => [alias, { extends: base }])), agentProfiles: profiles },
        }),
      },
    };
  }
  const prompt = (result: Request | undefined) => String(result?.config?.systemPrompt);
  const boundaryLine = (result: Request | undefined) => {
    const text = prompt(result);
    const at = text.lastIndexOf("\n## Runtime facts\n");
    return at === -1 ? null : (/^Action boundary: .*$/m.exec(text.slice(at))?.[0] ?? null);
  };

  beforeEach(() => {
    dataHome = mkdtempSync(join(isolatedHome, "bm-boundary-"));
    process.env.PASEO_BM_HOME = dataHome;
    createAutonomyStore(dataHome).setBoundary({ workspaceId: "ws-on", enabled: true, confirmed: true }, ON_AT);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PASEO_BM_HOME;
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("the modes table is §D.2's, by base provider and role", () => {
    expect(BOUNDARY_MODES).toEqual({
      claude: { worker: { modeId: "default" }, reviewer: { modeId: "default" } },
      codex: { worker: { modeId: "auto", providerOptions: CODEX_WORKER_OPTIONS }, reviewer: { modeId: "auto", providerOptions: CODEX_REVIEWER_OPTIONS } },
    });
    const on = (role: "worker" | "reviewer" | "manager" | "orchestrator", base: string | null, profileModeId: string | null = null, modes: ProviderMode[] | null = CLAUDE_MODES) =>
      boundaryPostureOf({ role, base, project: "on", modes, profileModeId });
    expect(on("worker", "claude")).toEqual({ on: true, modeId: "default" });
    expect(on("reviewer", "codex", null, CODEX_MODES)).toEqual({ on: true, modeId: "auto", providerOptions: CODEX_REVIEWER_OPTIONS });
    expect(on("manager", "claude")).toBeNull();
    expect(on("orchestrator", "claude")).toBeNull();
    expect(on("worker", "opencode", null, OPENCODE)).toEqual({ on: false, reason: "its provider is only watched (detection)" });
    expect(on("worker", null)).toEqual({ on: false, reason: "its provider could not be read" });
    expect(on("worker", "claude", "acceptEdits")).toEqual({ on: false, reason: "its profile's mode is set by hand" });
    // A list without the boundary mode: today's rule. A list that cannot be read: the table (Claude and Codex list them).
    expect(on("worker", "claude", null, [m("bypassPermissions", "dangerous")])).toEqual({ on: false, reason: "its provider does not list the boundary's mode" });
    expect(on("worker", "claude", null, null)).toEqual({ on: true, modeId: "default" });
    expect(boundaryPostureOf({ role: "worker", base: "claude", project: "off", modes: CLAUDE_MODES, profileModeId: null })).toEqual({ on: false, reason: "the project's boundary is off" });
    expect(boundaryPostureOf({ role: "worker", base: "claude", project: "unknown", modes: CLAUDE_MODES, profileModeId: null })).toEqual({
      on: false,
      reason: "the project could not be told from the agent's folder",
    });
    // Off: a creator's boundary mode counts as none; another mode is kept.
    expect(creatorModeOffBoundary("worker", "claude", "default")).toBeUndefined();
    expect(creatorModeOffBoundary("worker", "claude", "acceptEdits")).toBe("acceptEdits");
    expect(creatorModeOffBoundary("orchestrator", "claude", "default")).toBe("default");
  });

  it("on: a Claude Worker and Reviewer start in default, a creator's bypassPermissions corrected with one log line", async () => {
    const { run } = setup(host({ "bm-worker": "claude", "bm-reviewer": "claude", "bm-manager": "claude" }));
    const warn = vi.mocked(console.warn);
    const worker = await run({ config: { provider: "bm-worker", cwd: "/on", modeId: "bypassPermissions" } });
    expect(worker?.config?.modeId).toBe("default");
    expect(worker?.config).not.toHaveProperty("providerOptions");
    expect(boundaryLine(worker)).toBe(ON);
    expect(warn.mock.calls.some((call) => /"bypassPermissions".*action boundary.*"default"/.test(String(call[0])))).toBe(true);
    // The Worker is told the Reviewer's boundary mode to pass.
    expect(prompt(worker)).toContain("Reviewer mode: `default` — pass it as `settings.modeId` when you create a Reviewer.");
    const reviewer = await run({ config: { provider: "bm-reviewer/claude-sonnet-5", cwd: "/on", modeId: "default" } });
    expect(reviewer?.config?.modeId).toBe("default");
    expect(boundaryLine(reviewer)).toBe(ON);
  });

  it("on: a Codex Worker in auto with the danger-full-access options, a Codex Reviewer in auto with the workspace-write options", async () => {
    const { run } = setup(host({ "bm-worker": "codex", "bm-reviewer": "codex" }));
    const worker = await run({ config: { provider: "bm-worker", cwd: "/on", modeId: "full-access", providerOptions: { model_reasoning_summary: "auto", sandbox_mode: "read-only" } } });
    expect(worker?.config).toMatchObject({ modeId: "auto", providerOptions: { model_reasoning_summary: "auto", ...CODEX_WORKER_OPTIONS } });
    expect(boundaryLine(worker)).toBe(ON);
    expect(prompt(worker)).toContain("Reviewer mode: `auto` —");
    const reviewer = await run({ config: { provider: "bm-reviewer", cwd: "/on", modeId: "full-access" } });
    expect(reviewer?.config).toMatchObject({ modeId: "auto", providerOptions: CODEX_REVIEWER_OPTIONS });
    expect(boundaryLine(reviewer)).toBe(ON);
  });

  it("on: a mode hand-set on the profile wins, and the facts say the boundary is off for it", async () => {
    const { run } = setup(host({ "bm-worker": "claude", "bm-reviewer": "claude", "bm-manager": "claude" }, [{ id: "bm-worker", modeId: "acceptEdits" }]));
    const worker = await run({ config: { provider: "bm-worker", cwd: "/on" } });
    expect(worker?.config?.modeId).toBe("acceptEdits");
    expect(boundaryLine(worker)).toBe("Action boundary: off — its profile's mode is set by hand");
    // The Manager is told the profile's mode, not the boundary's.
    const manager = await run({ config: { provider: "bm-manager", cwd: "/on" } });
    expect(prompt(manager)).toContain("Worker mode: `acceptEdits` —");
  });

  it("on: the Orchestrator keeps auto and gets no facts line; the Manager's own mode is untouched and it is told the Worker's boundary mode", async () => {
    const { run } = setup(host({ "bm-worker": "claude", "bm-reviewer": "codex", "bm-manager": "claude", "bm-orchestrator": "claude" }));
    const orchestrator = await run({ config: { provider: "bm-orchestrator", cwd: "/on" } });
    expect(orchestrator?.config?.modeId).toBe("auto");
    expect(prompt(orchestrator)).not.toContain("Action boundary");
    const manager = await run({ config: { provider: "bm-manager", cwd: "/on", modeId: "bypassPermissions" } });
    expect(manager?.config?.modeId).toBe("bypassPermissions");
    expect(prompt(manager)).toContain("Worker mode: `default` — pass it as `settings.modeId` when you create a Worker.");
    expect(prompt(manager)).not.toContain("Action boundary");
  });

  it("on: OpenCode and a provider without modes keep today's posture, only watched", async () => {
    const { run } = setup(host({ "bm-worker": "opencode", "bm-reviewer": "pi" }));
    const worker = await run({ config: { provider: "bm-worker", cwd: "/on" } });
    expect(worker?.config).toMatchObject({ modeId: "bytes", featureValues: { auto_accept: true } });
    expect(worker?.config).not.toHaveProperty("providerOptions");
    expect(boundaryLine(worker)).toBe("Action boundary: off — its provider is only watched (detection)");
    const reviewer = await run({ config: { provider: "bm-reviewer", cwd: "/on", modeId: "default" } });
    expect(reviewer?.config).not.toHaveProperty("modeId");
    expect(boundaryLine(reviewer)).toBe("Action boundary: off — its provider is only watched (detection)");
  });

  it("off, or a project it cannot find: today's modes, and a creator's boundary mode is moved back to today's pick", async () => {
    const { run } = setup(host({ "bm-worker": "claude", "bm-reviewer": "claude", "bm-manager": "claude" }));
    for (const [cwd, line] of [
      ["/off", "Action boundary: off — the project's boundary is off"],
      ["/elsewhere", "Action boundary: off — the project could not be told from the agent's folder"],
    ] as const) {
      const fresh = await run({ config: { provider: "bm-worker", cwd } });
      expect(fresh?.config?.modeId, cwd).toBe("bypassPermissions");
      expect(boundaryLine(fresh), cwd).toBe(line);
      expect(prompt(fresh), cwd).toContain("Reviewer mode: `auto` —");
      // Runtime facts written while the switch was on: the Worker would ask with nobody answering.
      expect((await run({ config: { provider: "bm-worker", cwd, modeId: "default" } }))?.config?.modeId, cwd).toBe("bypassPermissions");
      expect((await run({ config: { provider: "bm-reviewer", cwd, modeId: "default" } }))?.config?.modeId, cwd).toBe("auto");
      // Another mode the creator chose is kept, as today.
      expect((await run({ config: { provider: "bm-worker", cwd, modeId: "acceptEdits" } }))?.config?.modeId, cwd).toBe("acceptEdits");
      const manager = await run({ config: { provider: "bm-manager", cwd } });
      expect(prompt(manager), cwd).toContain("Worker mode: `bypassPermissions` —");
    }
    const { run: codex } = setup(host({ "bm-worker": "codex", "bm-reviewer": "codex" }));
    const worker = await codex({ config: { provider: "bm-worker", cwd: "/off", modeId: "auto" } });
    expect(worker?.config?.modeId).toBe("full-access");
    expect(worker?.config).not.toHaveProperty("providerOptions");
  });

  // Live check 2026-10-01 F1: agent.created sees no prompt yet, so the hook keeps what it applied for it.
  it("records the boundary it applied to each Worker and Reviewer, by alias and folder, for agent.created's bm.boundary", async () => {
    forgetCreatedBoundaries();
    const { run } = setup(host({ "bm-worker": "codex", "bm-reviewer": "claude", "bm-manager": "claude", "bm-orchestrator": "claude" }));
    await run({ config: { provider: "bm-worker/gpt-5.6-luna", cwd: "/on", modeId: "full-access" } });
    await run({ config: { provider: "bm-reviewer", cwd: "/off" } });
    await run({ config: { provider: "bm-manager", cwd: "/on" } });
    await run({ config: { provider: "bm-orchestrator", cwd: "/on" } });
    // agent.created names the alias with or without the model, and the same folder.
    expect(takeCreatedBoundary("bm-worker", "/on/")).toBe("on");
    expect(takeCreatedBoundary("bm-worker", "/on")).toBeNull();
    expect(takeCreatedBoundary("bm-reviewer/claude-sonnet-5", "/off")).toBe("off");
    // Nothing for the roles the boundary does not cover.
    expect(takeCreatedBoundary("bm-manager", "/on")).toBeNull();
    expect(takeCreatedBoundary("bm-orchestrator", "/on")).toBeNull();
  });

  it("a Phase 2/3 policy file, an absent and a malformed entry read as off", async () => {
    const { run } = setup(host({ "bm-worker": "claude", "bm-reviewer": "claude" }));
    for (const boundary of [undefined, { "ws-on": { enabled: false, at: ON_AT } }, { "ws-on": { enabled: true } }, { "ws-on": true }, "on"]) {
      writeFileSync(
        join(dataHome, "autonomy", "policy.json"),
        JSON.stringify({ version: 1, projects: {}, challenger: {}, ...(boundary === undefined ? {} : { boundary }) }),
      );
      const worker = await run({ config: { provider: "bm-worker", cwd: "/on" } });
      expect(worker?.config?.modeId, JSON.stringify(boundary)).toBe("bypassPermissions");
      expect(boundaryLine(worker), JSON.stringify(boundary)).toBe("Action boundary: off — the project's boundary is off");
    }
  });

  it("a hook that runs out of its budget leaves the facts line off (no line) and the creator's mode as it was", async () => {
    forgetCreatedBoundaries();
    const never = new Promise(() => {});
    const { run } = setup({ ...host({ "bm-worker": "claude" }), workspaces: { list: () => never }, providers: { listModes: () => never } });
    const result = await run({ config: { provider: "bm-worker", cwd: "/on", modeId: "default" } });
    expect(result?.config?.systemPrompt).toBe(workerMd);
    expect(result?.config?.modeId).toBe("default");
    expect(boundaryLine(result)).toBeNull();
    // Outside the boundary, so agent.created labels it off (live check 2026-10-01 F1).
    expect(takeCreatedBoundary("bm-worker", "/on")).toBe("off");
  }, 20000);
});

describe("before(\"agent.create\") — a bound creation (design §16.5)", () => {
  const roleUrl = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
  const paseo = { config: { get: async () => ({ config: { providers: { "bm-worker": { extends: "claude" }, "bm-worker-fallback-1": { extends: "pi" } } } }) } };
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bm-hook-bound-"));
    mkdirSync(join(root, ".paseo-bm"));
  });
  afterEach(() => {
    clearBindingCache();
    rmSync(root, { recursive: true, force: true });
  });
  function hookWith(bindings: BindingStore) {
    let hook: ((input: { request: AgentCreateRequest }, context: unknown) => unknown) | undefined;
    registerRoleHook({ before: ((_name: string, handler: typeof hook) => ((hook = handler), () => {})) as never }, { urlFor: roleUrl, bindings });
    return async (config: Record<string, unknown>) => (await hook!({ request: { config } as unknown as AgentCreateRequest }, { paseo })) as AgentCreateRequest | undefined;
  }

  it("keeps the token URL of a pending binding and attaches it; the same creation without a token gets the role path and the same prompt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bindings = createBindingStore(join(root, ".paseo-bm"));
    const issued = binderOf(roleUrl, bindings, () => {}).issue({ role: "worker", base: "claude", workspaceId: "wks_1" })!;
    const create = hookWith(bindings);
    const bound = await create({ provider: "bm-worker/claude-opus-5", cwd: "/repo", mcpServers: { "paseo-bm": issued.mcpServer } });
    expect(bound?.config.mcpServers).toEqual({ "paseo-bm": issued.mcpServer });
    expect(bindings.list()[0]?.attachedAt).not.toBeNull();
    const plain = await create({ provider: "bm-worker/claude-opus-5", cwd: "/repo" });
    expect(plain?.config.mcpServers).toEqual({ "paseo-bm": { type: "http", url: roleUrl("worker"), alwaysLoad: true } });
    // No agent sees a change in this step: the role text and its facts are the same.
    expect(bound?.config.systemPrompt).toBe(plain?.config.systemPrompt);
    expect(bound?.config.toolPolicy).toEqual(plain?.config.toolPolicy);
  });

  it("rewrites a foreign URL and attaches nothing; removes a paseo-bm entry on a provider without tools", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bindings = createBindingStore(join(root, ".paseo-bm"));
    const create = hookWith(bindings);
    const foreign = await create({ provider: "bm-worker/claude-opus-5", cwd: "/repo", mcpServers: { "paseo-bm": { type: "http", url: `${roleUrl("worker")}/${"d".repeat(64)}` } } });
    expect(foreign?.config.mcpServers).toEqual({ "paseo-bm": { type: "http", url: roleUrl("worker"), alwaysLoad: true } });
    const onPi = await create({ provider: "bm-worker-fallback-1/pi-default", cwd: "/repo", mcpServers: { "paseo-bm": { type: "http", url: roleUrl("worker") }, keep: { type: "http", url: "http://x" } } });
    expect(onPi?.config.mcpServers).toEqual({ keep: { type: "http", url: "http://x" } });
    expect(onPi?.config.toolPolicy).toBeUndefined();
    expect(bindings.list()).toEqual([]);
  });
});
