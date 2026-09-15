import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import contribute from "../plugin/index.server";
import { ROLE_PROMPT_SEPARATOR, applyRoleInstructions } from "../plugin/server/role-hook";

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

function setup() {
  const fake = fakeServer();
  const cleanup = contribute(fake.server as unknown as Parameters<typeof contribute>[0]);
  const hook = fake.hooks.get("agent.create");
  expect(hook).toBeTypeOf("function");
  const run = (request: Request) => hook!({ request }, { paseo: {}, signal: new AbortController().signal }) as Request | undefined;
  return { ...fake, cleanup, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("before(\"agent.create\") role hook", () => {
  it("registers exactly one agent.create hook", () => {
    const { server, hooks } = setup();
    expect(server.before).toHaveBeenCalledTimes(1);
    expect([...hooks.keys()]).toEqual(["agent.create"]);
  });

  it("gives bm-worker the text of roles/worker.md and keeps the rest of the request", () => {
    const { run } = setup();
    const request = { config: { provider: "bm-worker", cwd: "/repo", modeId: "default", model: "gpt-5.6-sol" }, env: { A: "1" } };
    const result = run(request);
    expect(result).toEqual({ config: { ...request.config, systemPrompt: workerMd }, env: { A: "1" } });
    expect(request.config).not.toHaveProperty("systemPrompt");
  });

  it("recognises a provider given as <id>/<model>", () => {
    const { run } = setup();
    expect(run({ config: { provider: "bm-worker/gpt-5.6-sol", cwd: "/repo" } })?.config?.systemPrompt).toBe(workerMd);
  });

  it("gives bm-reviewer the text of roles/reviewer.md", () => {
    const { run } = setup();
    expect(run({ config: { provider: "bm-reviewer", cwd: "/repo" } })?.config?.systemPrompt).toBe(reviewerMd);
  });

  it("puts the role instructions first and keeps a different existing system prompt after them", () => {
    const { run } = setup();
    const result = run({ config: { provider: "bm-reviewer", cwd: "/repo", systemPrompt: "Review only src/." } });
    expect(result?.config?.systemPrompt).toBe(`${reviewerMd}${ROLE_PROMPT_SEPARATOR}Review only src/.`);
  });

  it("does not duplicate instructions that are already in the system prompt", () => {
    const { run } = setup();
    expect(run({ config: { provider: "bm-worker", cwd: "/repo", systemPrompt: workerMd } })).toBeUndefined();
    const once = run({ config: { provider: "bm-worker", cwd: "/repo", systemPrompt: "extra" } });
    expect(run(once!)).toBeUndefined();
  });

  it("sets roles/manager.md for a bm-manager created without it", () => {
    const { run } = setup();
    expect(run({ config: { provider: "bm-manager/opus", cwd: "/repo" } })?.config?.systemPrompt).toBe(managerMd);
    expect(run({ config: { provider: "bm-manager", cwd: "/repo", systemPrompt: "   " } })?.config?.systemPrompt).toBe(managerMd);
  });

  it("leaves a bm-manager created by manager.ensure unchanged", () => {
    const { run } = setup();
    expect(run({ config: { provider: "bm-manager/opus", cwd: "/repo", systemPrompt: managerMd } })).toBeUndefined();
  });

  it("does not touch agents of other providers", () => {
    const { run } = setup();
    expect(run({ config: { provider: "claude", cwd: "/repo" } })).toBeUndefined();
    expect(run({ config: { provider: "codex/gpt-5", cwd: "/repo", systemPrompt: "x" } })).toBeUndefined();
    expect(run({ config: { provider: "bm-workers", cwd: "/repo" } })).toBeUndefined();
    expect(run({ config: { provider: "toString", cwd: "/repo" } })).toBeUndefined();
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

  it("replaces a non-string systemPrompt with the instructions", () => {
    expect(applyRoleInstructions({ config: { provider: "bm-worker", systemPrompt: 7 } } as never)?.config.systemPrompt).toBe(workerMd);
  });

  it("removes the hook on cleanup", () => {
    const { cleanup, hooks, removers } = setup();
    cleanup();
    expect(removers).toEqual(["agent.create"]);
    expect(hooks.size).toBe(0);
  });

  it("skips the hook safely, with one log line, on a host without before()", () => {
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
