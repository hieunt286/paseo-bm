/**
 * The server gets no Paseo handle of its own; hooks and RPCs bring one. After a
 * plugin reload (2026-10-01, the owner's daemon) the Orchestrator's tools
 * refused every call — "paseo-bm has no connection to Paseo yet" — because only
 * a paseo-bm creation handed the endpoint a handle. Any turn start now does.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import contribute from "../plugin/index.server";

type Handler = (event: unknown, context: unknown) => unknown;

function fakeServer() {
  const hooks = new Map<string, Handler[]>();
  const server = {
    handle: vi.fn(),
    registerSettings: vi.fn(),
    before: vi.fn(() => () => {}),
    on: vi.fn((name: string, handler: Handler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => {};
    }),
  };
  return { server, hooks };
}

const fakePaseo = {
  agents: { list: vi.fn(async () => ({ entries: [], nextCursor: null })), ref: vi.fn() },
  workspaces: { list: vi.fn(async () => ({ entries: [], nextCursor: null })) },
};

async function endpoint(): Promise<string> {
  const ui = join(homedir(), ".paseo-bm", "ui");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const { port } = JSON.parse(readFileSync(join(ui, "agent-tools.json"), "utf8")) as { port: number };
      const { secret } = JSON.parse(readFileSync(join(ui, "orchestrator-endpoint.json"), "utf8")) as { secret: string };
      return `http://127.0.0.1:${port}/mcp/orchestrator/${secret}`;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("the endpoint never started");
}

async function callProjects(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bm_projects", arguments: {} } }),
  });
  return JSON.stringify(await response.json());
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

describe("the Paseo handle reaches the Orchestrator's tools", () => {
  it("refuses before any handle, and answers once any agent's turn has started", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server, hooks } = fakeServer();
    cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
    const url = await endpoint();
    expect(await callProjects(url)).toContain("no connection to Paseo");

    for (const started of hooks.get("agent.turn_started") ?? []) await started({ agent: { id: "a1", provider: "claude" }, turnId: "t1" }, { paseo: fakePaseo });
    expect(await callProjects(url)).not.toContain("no connection to Paseo");
    expect(fakePaseo.agents.list).toHaveBeenCalled();
  });
});
