import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import contribute from "../plugin/index.server";
import { ROLE_PROMPT_SEPARATOR, applyRoleInstructions, chooseModeId, type ProviderMode } from "../plugin/server/role-hook";
import { LOOKUP_TIMEOUT_MS, TIMED_OUT, withTimeout } from "../plugin/server/role-mode";

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

type Request = { config?: Record<string, unknown>; env?: Record<string, string> };
type BeforeHandler = (input: { request: Request }, context: unknown) => unknown;

function fakeServer(options: { withBefore?: boolean } = {}) {
  const hooks = new Map<string, BeforeHandler>();
  const removers: string[] = [];
  const server: Record<string, unknown> = {
    handle: vi.fn(),
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
    expect(result).toEqual({ config: { ...request.config, systemPrompt: workerMd }, env: { A: "1" } });
    expect(request.config).not.toHaveProperty("systemPrompt");
  });

  it("recognises a provider given as <id>/<model>", async () => {
    const { run } = setup();
    expect((await run({ config: { provider: "bm-worker/gpt-5.6-sol", cwd: "/repo" } }))?.config?.systemPrompt).toBe(workerMd);
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
    expect((await run({ config: { provider: "bm-worker", cwd: "/repo", systemPrompt: workerMd } }))).toBeUndefined();
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

  it("starts a Worker created without a mode in the no-prompt mode, looking up the bare provider id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { spy, paseo } = paseoWith(async () => ({ provider: "bm-worker", modes: CLAUDE_MODES, error: null }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo" }, env: { A: "1" } });
    // The bare provider id, plus the cwd hint so the daemon can answer from the
    // snapshot it already warmed for this directory (review b2).
    expect(spy.mock.calls[0]).toEqual(["bm-worker", { cwd: "/repo" }]);
    expect(result).toEqual({ config: { provider: "bm-worker/claude-opus-5", cwd: "/repo", systemPrompt: workerMd, modeId: "bypassPermissions" }, env: { A: "1" } });
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

  it("keeps a Worker's chosen mode without a lookup", async () => {
    const { spy, paseo } = paseoWith(async () => ({ modes: CLAUDE_MODES }));
    const { run } = setup(paseo);
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo", modeId: "default" } });
    expect(spy).not.toHaveBeenCalled();
    expect(result?.config?.modeId).toBe("default");
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
  ])("still creates the agent, with its instructions and a log line, when %s", async (_name, paseo, logged) => {
    const { run } = setup(paseo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run({ config: { provider: "bm-worker", cwd: "/repo" } });
    expect(result?.config?.systemPrompt).toBe(workerMd);
    expect(result?.config).not.toHaveProperty("modeId");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(logged);
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
