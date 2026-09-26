import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TOOLS_SERVER, MAX_BODY_BYTES, answer, savedPort, startAgentTools, statePath, withAgentTools, type AgentToolsEndpoint } from "../plugin/server/agent-tools";
import { applyAgentTools, registerRoleHook, type AgentCreateRequest } from "../plugin/server/role-hook";

/**
 * The agent tools endpoint (design delta 20260924b-agent-tools, AT-2): a real
 * server on 127.0.0.1, spoken to the way an agent's MCP client does.
 */

const REQ = "req-20260924T065116Z";
const homes: string[] = [];
const endpoints: AgentToolsEndpoint[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "bm-agent-tools-"));
  mkdirSync(join(dir, ".paseo-bm"));
  homes.push(dir);
  return dir;
}

async function start(dir = home()) {
  const path = join(dir, ".paseo-bm", "ui", "agent-tools.json");
  const logs: string[] = [];
  const endpoint = startAgentTools({ statePath: path, log: (line) => logs.push(line) });
  endpoints.push(endpoint);
  await endpoint.ready;
  return { endpoint, path, logs };
}

async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the MCP conversation", () => {
  it("initializes, lists only the role's own tool, and builds a block", async () => {
    const { endpoint } = await start();
    const url = endpoint.urlFor("worker")!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/worker$/);
    const init = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: AGENT_TOOLS_SERVER } });
    expect((await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const listed = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["bm_report"]);
    expect(listed.body.result.tools[0].inputSchema.type).toBe("object");
    const called = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bm_report", arguments: { requestId: REQ, phase: "received", tier: { level: "Small" }, buildAndTests: "not run" } },
    });
    expect(called.body.result.isError).toBeUndefined();
    expect(called.body.result.content[0].text).toMatch(/^BM-REPORT\nrequestId: req-20260924T065116Z\nphase: received/);
  });

  it("returns the input's problems as a tool error the agent can act on", async () => {
    const { endpoint } = await start();
    const called = await rpc(endpoint.urlFor("reviewer")!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bm_review", arguments: { requestId: REQ, batchId: "one" } } });
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.content[0].text).toMatch(/^The block was not built\. Fix these and call bm_review again:\n- /);
    expect(called.body.result.content[0].text).toContain("- input.batchId: must match");
    expect(called.body.result.content[0].text).toContain("- input.checked: is required");
  });

  it("answers a batch, and refuses another role's tool, an unknown method, bad JSON", async () => {
    const { endpoint } = await start();
    const url = endpoint.urlFor("manager")!;
    const batch = await rpc(url, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bm_report", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
    ]);
    expect(batch.body).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Unknown tool: bm_report" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found: resources/list" } },
    ]);
    const response = await fetch(url, { method: "POST", body: "{nope" });
    expect(response.status).toBe(400);
  });

  it("refuses what no agent sends: a browser Origin, a GET, an unknown path", async () => {
    const { endpoint } = await start();
    const url = endpoint.urlFor("worker")!;
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url.replace("/mcp/worker", "/mcp/admin"), { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("checks the Host case-blind, refuses a foreign one, and answers an empty batch and an oversized body", async () => {
    const { endpoint } = await start();
    const url = endpoint.urlFor("worker")!;
    const port = new URL(url).port;
    const raw = (host: string, body: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
          socket.write(`POST /mcp/worker HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
        socket.on("error", reject);
      });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(await raw(`LOCALHOST:${port}`, ping)).toBe(200);
    expect(await raw(`evil.example:${port}`, ping)).toBe(403);
    expect((await rpc(url, [])).status).toBe(400);
    expect((await rpc(url, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202);
    const big = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: `"${"x".repeat(MAX_BODY_BYTES + 10)}"` });
    expect(big.status).toBe(413);
  });

  it("logs one line per block built, and nothing for an unknown tool", async () => {
    const { endpoint, logs } = await start();
    const url = endpoint.urlFor("worker")!;
    await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } });
    await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bm_report", arguments: {} } });
    expect(logs).toEqual(["[paseo-bm] bm_report refused its input for a worker"]);
  });

  it("the pure answer: no reply to a notification, an invalid request is refused", () => {
    expect(answer("worker", { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(answer("worker", 42)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect(answer("worker", { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "1999-01-01" } })).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  });
});

describe("the port kept across restarts", () => {
  it("saves the port, takes it again after a restart, and moves on when it is taken", async () => {
    const dir = home();
    const first = await start(dir);
    const port = Number(new URL(first.endpoint.urlFor("worker")!).port);
    expect(savedPort(first.path)).toBe(port);
    await first.endpoint.close();
    const second = await start(dir);
    expect(second.endpoint.urlFor("worker")).toBe(`http://127.0.0.1:${port}/mcp/worker`);
    await second.endpoint.close();

    // Someone else holds the port now.
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
    try {
      const third = await start(dir);
      const moved = Number(new URL(third.endpoint.urlFor("worker")!).port);
      expect(moved).not.toBe(port);
      expect(savedPort(third.path)).toBe(moved);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("creates the data folder 0700 and the file 0600 on a machine that has neither", async () => {
    const bare = mkdtempSync(join(tmpdir(), "bm-agent-tools-bare-"));
    homes.push(bare);
    const dataHome = join(bare, ".paseo-bm");
    const path = join(dataHome, "ui", "agent-tools.json");
    const endpoint = startAgentTools({ statePath: path, log: () => {} });
    endpoints.push(endpoint);
    await endpoint.ready;

    expect(endpoint.urlFor("worker")).not.toBeNull();
    // Before 0.4.0 nothing here was allowed to create the install home, so the
    // port was simply lost. The plugin owns the folder now (ADR-012 decision 3).
    expect(savedPort(path)).toBe(Number(new URL(endpoint.urlFor("worker")!).port));
    expect(statSync(dataHome).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataHome, "ui")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("ignores a state file it does not understand", () => {
    const dir = home();
    const statePath = join(dir, ".paseo-bm", "ui", "agent-tools.json");
    mkdirSync(join(dir, ".paseo-bm", "ui"));
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 99, port: 1234 }));
    expect(savedPort(statePath)).toBeNull();
  });

  it("writes through no symlink, and keeps serving when it cannot save", async () => {
    const dir = home();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, ".paseo-bm", "ui"));
    const logs: string[] = [];
    const endpoint = startAgentTools({ statePath: join(dir, ".paseo-bm", "ui", "agent-tools.json"), log: (line) => logs.push(line) });
    endpoints.push(endpoint);
    await endpoint.ready;

    expect(endpoint.urlFor("worker")).not.toBeNull();
    expect(() => readFileSync(join(outside, "agent-tools.json"))).toThrow();
    expect(logs.join("\n")).toContain("could not save the agent tools port");
  });
});

describe("where the port file goes", () => {
  it("follows PASEO_BM_HOME rather than ~/.paseo-bm", () => {
    const dir = home();
    const custom = join(dir, "custom-bm");
    process.env["PASEO_BM_HOME"] = custom;
    try {
      expect(statePath()).toEqual({ path: join(custom, "ui", "agent-tools.json"), home: custom });
    } finally {
      delete process.env["PASEO_BM_HOME"];
    }
  });

  it("follows the home.json pointer", () => {
    const dir = home();
    const custom = join(dir, "pointed-bm");
    writeFileSync(
      join(dir, ".paseo-bm", "home.json"),
      JSON.stringify({ schemaVersion: 1, home: custom, writtenBy: "paseo-bm@0.4.0", at: "2026-09-25T00:00:00.000Z" }),
    );
    const previous = process.env["HOME"];
    process.env["HOME"] = dir;
    try {
      expect(statePath()).toEqual({ path: join(custom, "ui", "agent-tools.json"), home: custom });
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
    }
  });

  it("reports an unusable data folder and starts no endpoint", async () => {
    process.env["PASEO_BM_HOME"] = "relative/bm";
    const logs: string[] = [];
    try {
      const endpoint = startAgentTools({ log: (line) => logs.push(line) });
      await endpoint.ready;
      expect(endpoint.urlFor("worker")).toBeNull();
    } finally {
      delete process.env["PASEO_BM_HOME"];
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("cannot use the paseo-bm data folder");
    expect(logs[0]).toContain("agents write their BM-* blocks by hand.");
  });

  it("closes: no URL after close, also when closed before it listened", async () => {
    const { endpoint } = await start();
    await endpoint.close();
    expect(endpoint.urlFor("worker")).toBeNull();
    const early = startAgentTools({ statePath: join(home(), ".paseo-bm", "ui", "agent-tools.json"), log: () => {} });
    await early.close();
    expect(early.urlFor("worker")).toBeNull();
  });
});

describe("the creation hook's part", () => {
  const url = "http://127.0.0.1:4567/mcp/worker";

  it("adds the server and pre-approves the role's tools, keeping what is there", () => {
    const config = {
      provider: "bm-worker/claude-opus-5",
      mcpServers: { paseo: { type: "http", url: "http://x/mcp" } },
      toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "paseo", tool: "create_agent" }] },
    };
    expect(withAgentTools(config, "worker", url)).toEqual({
      provider: "bm-worker/claude-opus-5",
      mcpServers: { paseo: { type: "http", url: "http://x/mcp" }, [AGENT_TOOLS_SERVER]: { type: "http", url, alwaysLoad: true } },
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: "paseo", tool: "create_agent" },
          { kind: "mcp", server: AGENT_TOOLS_SERVER, tool: "bm_report" },
        ],
      },
    });
    expect(withAgentTools({}, "worker", null)).toBeUndefined();
  });

  it("applies to bm-* agents on a provider that can take the tools only, and never throws", () => {
    const tools = { urlFor: (role: string) => `http://127.0.0.1:4567/mcp/${role}` };
    const request = (provider: string) => ({ config: { provider, cwd: "/repo" } }) as unknown as AgentCreateRequest;
    const reviewer = applyAgentTools(request("bm-reviewer/gpt-5.6-sol"), tools, "codex");
    expect(reviewer?.config.mcpServers?.[AGENT_TOOLS_SERVER]).toEqual({ type: "http", url: "http://127.0.0.1:4567/mcp/reviewer", alwaysLoad: true });
    expect(reviewer?.config.toolPolicy?.preapproved).toEqual([{ kind: "mcp", server: AGENT_TOOLS_SERVER, tool: "bm_review" }]);
    expect(applyAgentTools(request("bm-worker-fallback-1/x"), tools, "opencode")?.config.toolPolicy?.preapproved).toEqual([{ kind: "mcp", server: AGENT_TOOLS_SERVER, tool: "bm_report" }]);
    // Paseo refuses a toolPolicy on Pi, Oh My Pi or Copilot: the agent must still be created.
    for (const base of ["pi", "omp", "copilot", null]) expect(applyAgentTools(request("bm-worker"), tools, base)).toBeUndefined();
    expect(applyAgentTools(request("claude/opus"), tools, "claude")).toBeUndefined();
    expect(applyAgentTools(request("bm-worker"), null, "claude")).toBeUndefined();
    expect(applyAgentTools(request("bm-worker"), { urlFor: () => null }, "claude")).toBeUndefined();
    expect(applyAgentTools(null as unknown as AgentCreateRequest, tools, "claude")).toBeUndefined();
  });

  it("many creations at once each get their own role's tools, and none on a provider that cannot take them", async () => {
    let hook: ((input: { request: AgentCreateRequest }, context: unknown) => unknown) | undefined;
    registerRoleHook({ before: ((_name: string, handler: typeof hook) => ((hook = handler), () => {})) as never }, { urlFor: (role) => `http://127.0.0.1:4567/mcp/${role}` });
    const bases: Record<string, string> = { "bm-manager": "claude", "bm-worker": "codex", "bm-reviewer": "opencode", "bm-worker-fallback-1": "pi" };
    // A config read that answers late and out of order, as a busy daemon does.
    const paseo = { config: { get: () => new Promise((resolve) => setTimeout(() => resolve({ config: { providers: Object.fromEntries(Object.entries(bases).map(([id, base]) => [id, { extends: base }])) } }), Math.random() * 20)) } };
    const providers = Object.keys(bases);
    const expected: Record<string, string | undefined> = { "bm-manager": "bm_answers", "bm-worker": "bm_report", "bm-reviewer": "bm_review", "bm-worker-fallback-1": undefined };
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const provider = providers[index % providers.length]!;
        const out = (await hook!({ request: { config: { provider: `${provider}/m`, cwd: `/repo/${index}` } } as unknown as AgentCreateRequest }, { paseo })) as AgentCreateRequest | undefined;
        return { provider, tool: out?.config.toolPolicy?.preapproved?.[0]?.tool, cwd: out?.config.cwd };
      }),
    );
    for (const [index, result] of results.entries()) {
      expect(result.tool).toBe(expected[result.provider]);
      expect(result.cwd).toBe(`/repo/${index}`);
    }
  });

  it("the registered hook adds the tools on top of the role config, by the alias's base provider", async () => {
    let hook: ((input: { request: AgentCreateRequest }, context: unknown) => unknown) | undefined;
    registerRoleHook({ before: ((_name: string, handler: typeof hook) => ((hook = handler), () => {})) as never }, { urlFor: (role) => `http://127.0.0.1:4567/mcp/${role}` });
    const paseo = { config: { get: async () => ({ config: { providers: { "bm-manager": { extends: "claude" }, "bm-worker": { extends: "pi" } } } }) } };
    const create = async (provider: string, context: unknown) => (await hook!({ request: { config: { provider, cwd: "/repo" } } as unknown as AgentCreateRequest }, context)) as AgentCreateRequest | undefined;
    const manager = await create("bm-manager/claude-opus-5", { paseo });
    expect(manager?.config.systemPrompt).toMatch(/Beads Manager/);
    expect(manager?.config.toolPolicy?.preapproved).toEqual([{ kind: "mcp", server: AGENT_TOOLS_SERVER, tool: "bm_answers" }]);
    // On Pi: the role config, no tools.
    const worker = await create("bm-worker/some-model", { paseo });
    expect(worker?.config.systemPrompt).toMatch(/Beads Worker/);
    expect(worker?.config.toolPolicy).toBeUndefined();
    expect(worker?.config.mcpServers).toBeUndefined();
    // No readable config: no tools either.
    expect((await create("bm-manager", {}))?.config.toolPolicy).toBeUndefined();
    expect(await create("claude", { paseo })).toBeUndefined();
  });
});
