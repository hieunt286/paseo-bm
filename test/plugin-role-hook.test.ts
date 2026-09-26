import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import contribute from "../plugin/index.server";
import { ROLE_PROMPT_SEPARATOR, applyRoleInstructions, chooseModeId, type ProviderMode } from "../plugin/server/role-hook";
import { LOOKUP_TIMEOUT_MS, TIMED_OUT, capabilityOf, forgetModes, modesFor, runPostureOf, withTimeout } from "../plugin/server/role-mode";

// The entry resolves the install home from $HOME when Paseo's config names no
// plugin path; point it at an empty directory so this machine's real
// ~/.paseo-bm (and any role-extras.json in it) never leaks into the test.
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
/**
 * What a Worker gets on a host that cannot read the bm-reviewer modes: its role
 * text plus the fallback Reviewer mode `auto` (delta 20260918g §4.9, owner
 * decisions Q4 a and Q9 a), because Paseo refuses a Reviewer created without
 * a mode. Before that delta it got the role text alone.
 */
const workerWithFallback = `${workerMd.trimEnd()}\n\n## Runtime facts\n\nReviewer mode: \`auto\` — pass it as \`settings.modeId\` when you create a Reviewer.\n`;

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

  it("gives bm-reviewer the text of roles/reviewer.md", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-reviewer", cwd: "/repo" } }))?.config?.systemPrompt).toBe(reviewerMd);
  });

  it("puts the role instructions first and keeps a different existing system prompt after them", async () => {
    const { run } = setup();
    const result = (await run({ config: { provider: "bm-reviewer", cwd: "/repo", systemPrompt: "Review only src/." } }));
    expect(result?.config?.systemPrompt).toBe(`${reviewerMd}${ROLE_PROMPT_SEPARATOR}Review only src/.`);
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
  const workerWithReviewerMode = (mode: string) =>
    `${workerMd.trimEnd()}\n\n## Runtime facts\n\nReviewer mode: \`${mode}\` — pass it as \`settings.modeId\` when you create a Reviewer.\n`;

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
    expect(downgraded?.config).toMatchObject({ modeId: "auto", systemPrompt: reviewerMd });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/full-access.*auto/);
  });

  it("changes only the mode when the instructions are already in place", async () => {
    const { paseo } = paseoWith(async () => ({ modes: CODEX_MODES }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-reviewer", cwd: "/repo", systemPrompt: reviewerMd } });
    expect(result?.config).toEqual({ provider: "bm-reviewer", cwd: "/repo", systemPrompt: reviewerMd, modeId: "auto" });
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
