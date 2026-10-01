import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TOOLS_SERVER,
  MAX_BODY_BYTES,
  answer,
  roleOfPath,
  savedPort,
  savedSecret,
  secretPathOf,
  startAgentTools,
  statePath,
  toolsStaleSince,
  withAgentTools,
  type AgentToolsEndpoint,
} from "../plugin/server/agent-tools";
import { createOrchestratorTools, type OrchestratorTools } from "../plugin/server/orchestrator-tools";
import { createManagerTools, type ServerTools } from "../plugin/server/decision-tools";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { answerDecision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
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

/** The Orchestrator's tools on the test's own data folder, never the real HOME. */
function orchestratorTools(dir: string): OrchestratorTools {
  return createOrchestratorTools({ env: { PASEO_BM_HOME: join(dir, ".paseo-bm") }, homedir: () => dir });
}

/** The Manager's server-run tools on the test's own data folder. */
function managerTools(dir: string): ServerTools {
  return createManagerTools({ env: { PASEO_BM_HOME: join(dir, ".paseo-bm") }, homedir: () => dir, redactEnv: {} });
}

async function start(dir = home(), orchestrator = orchestratorTools(dir), now?: () => Date) {
  const path = join(dir, ".paseo-bm", "ui", "agent-tools.json");
  const logs: string[] = [];
  const endpoint = startAgentTools({ statePath: path, log: (line) => logs.push(line), orchestrator, manager: managerTools(dir), ...(now === undefined ? {} : { now }) });
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
    // Change-014 outcome 3: the Worker's server-run bm_reply follows its block tool.
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["bm_report", "bm_reply"]);
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

describe("the Orchestrator's endpoint (orchestrator design §5.1)", () => {
  const ORCHESTRATOR_TOOLS = ["bm_projects", "bm_request", "bm_agent_messages", "bm_send_command", "bm_decisions", "bm_ask_owner", "bm_decide", "bm_predict", "bm_direct_worker", "bm_repo", "bm_note", "bm_findings", "bm_compact", "bm_handoff", "bm_why", "bm_reply"];
  /** The Orchestrator's tools no other role has: the Manager has a bm_decisions of its own, the Worker a bm_reply (change-014). */
  const ORCHESTRATOR_ONLY = ORCHESTRATOR_TOOLS.filter((name) => name !== "bm_decisions" && name !== "bm_reply");

  it("serves the Orchestrator only under its 64-hex secret, and answers 404 without it", async () => {
    const { endpoint } = await start();
    const url = endpoint.urlFor("orchestrator")!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/orchestrator\/[0-9a-f]{64}$/);
    const listed = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(ORCHESTRATOR_TOOLS);
    const bare = url.replace(/\/[0-9a-f]{64}$/, "");
    const secret = url.slice(-64);
    const wrong = `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`;
    for (const path of [bare, `${bare}/`, `${bare}/${wrong}`, `${bare}/${secret.slice(0, 32)}`, `${bare}/${secret}0`, `${bare}/${secret.toUpperCase()}`, `${bare}/${secret}/x`]) {
      expect((await rpc(path, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    }
    expect((await rpc(`${url}/`, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("makes a secret per data folder, and never puts one on the other roles' paths", async () => {
    const first = await start();
    const second = await start();
    expect(first.endpoint.urlFor("orchestrator")!.slice(-64)).not.toBe(second.endpoint.urlFor("orchestrator")!.slice(-64));
    for (const role of ["worker", "reviewer", "manager"] as const) expect(first.endpoint.urlFor(role)).toMatch(new RegExp(`/mcp/${role}$`));
    expect(roleOfPath("/mcp/orchestrator", "ab")).toBeNull();
    expect(roleOfPath("/mcp/orchestrator/ab", "ab")).toBe("orchestrator");
    expect(roleOfPath("/mcp/orchestrator/ab", "")).toBeNull();
    expect(roleOfPath("/mcp/worker", "ab")).toBe("worker");
    expect(roleOfPath("/mcp/worker/ab", "ab")).toBeNull();
  });

  it("refuses a call before any Paseo handle arrived, records nothing, and logs one line per call", async () => {
    const dir = home();
    const { endpoint, logs } = await start(dir);
    const url = endpoint.urlFor("orchestrator")!;
    const before = snapshot(dir);
    const called = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bm_note", arguments: { workspaceId: "wks_a", text: "A note." } } });
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.content[0].text).toMatch(/^Refused: paseo-bm has no connection to Paseo yet/);
    const invalid = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bm_note", arguments: { text: "A note." } } });
    expect(invalid.body.result.content[0].text).toBe("The call was refused. Fix these and call bm_note again:\n- input.workspaceId: is required");
    expect(snapshot(dir)).toEqual(before);
    expect(logs).toEqual(["[paseo-bm] bm_note refused a call for the orchestrator", "[paseo-bm] bm_note refused a call for the orchestrator"]);
  });

  it("runs a tool with the handle the creation hook gave it", async () => {
    const dir = home();
    const { endpoint, logs } = await start(dir);
    const paseo = { agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries: [] }) }, config: { get: async () => ({ config: {} }) } };
    endpoint.usePaseo(paseo);
    const called = await rpc(endpoint.urlFor("orchestrator")!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bm_projects", arguments: {} } });
    expect(called.body.result.isError).toBeUndefined();
    expect(JSON.parse(called.body.result.content[0].text)).toMatchObject({ sinceHours: 24, projects: [] });
    expect(logs).toEqual(["[paseo-bm] bm_projects answered for the orchestrator"]);
  });

  it("refuses the other roles' tools, and the other roles cannot call the Orchestrator's", async () => {
    const { endpoint } = await start();
    const own = await rpc(endpoint.urlFor("orchestrator")!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bm_review", arguments: {} } });
    expect(own.body.error).toEqual({ code: -32602, message: "Unknown tool: bm_review" });
    for (const role of ["worker", "reviewer", "manager"] as const) {
      const listed = await rpc(endpoint.urlFor(role)!, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      for (const name of ORCHESTRATOR_ONLY) expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(name);
      for (const name of ORCHESTRATOR_ONLY) {
        const called = await rpc(endpoint.urlFor(role)!, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } });
        expect(called.body.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
      }
    }
    // The pure answer never runs an Orchestrator tool: it reads and writes plugin data.
    expect(answer("orchestrator", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "bm_projects", arguments: {} } })).toMatchObject({ error: { code: -32603 } });
  });
});

describe("the Manager's bm_decisions (autonomy design §A.9)", () => {
  const REQUEST = "req-20260929T073348Z";
  const OTHER = "req-20260929T090000Z";
  const call = (url: string, args: unknown, id = 1) => rpc(url, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "bm_decisions", arguments: args } });
  afterEach(() => clearDecisionStoreCache());

  /** Three decisions: two of REQUEST (a Worker's, answered with a grant, and the Orchestrator's), one of OTHER in another project. */
  function seed(dir: string): void {
    const store = createDecisionStore(join(dir, ".paseo-bm"));
    store.open(makeDecision({ requestId: REQUEST, id: `q:${REQUEST}:Q1`, }));
    store.transition(`q:${REQUEST}:Q1`, (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: "2026-09-29T07:50:00.000Z" }));
    store.open(
      makeDecision({
        requestId: REQUEST,
        id: "o:push-contract",
        askedBy: { role: "orchestrator", agentId: "agent-orchestrator" },
        askedAt: "2026-09-29T08:00:00.000Z",
        round: null,
        options: [{ key: "a", label: "Push", recommended: true, effects: ["push"], action: { kind: "command", to: "manager", agentId: "agent-manager", intent: "release", body: "Push now.", effects: ["push"] } }],
      }),
    );
    store.open(makeDecision({ requestId: OTHER, id: `q:${OTHER}:Q1`, workspaceId: "wks_2" }));
  }

  it("lists only the named request's decisions, newest asked first, without grants, and writes nothing", async () => {
    const dir = home();
    seed(dir);
    const { endpoint, logs } = await start(dir);
    const url = endpoint.urlFor("manager")!;
    const listed = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["bm_answers", "bm_decisions"]);
    const before = snapshot(dir);

    const called = await call(url, { requestId: REQUEST });
    expect(called.body.result.isError).toBeUndefined();
    const answer = JSON.parse(called.body.result.content[0].text) as { decisions: Array<Record<string, unknown>>; total: number; truncated: boolean };
    expect(answer.decisions.map((decision) => decision.id)).toEqual(["o:push-contract", `q:${REQUEST}:Q1`]);
    expect(answer).toMatchObject({ total: 2, truncated: false });
    expect(answer.decisions[1]).toMatchObject({ status: "answered", answer: { via: "inbox", optionKey: "a", words: null } });
    // Each with its class; one stored without it reads by its effects (autonomy design §B.1, §B.9).
    expect(answer.decisions.map((decision) => decision["class"])).toEqual(["release", "release"]);
    expect(answer.decisions[0]!["options"]).toEqual([
      { key: "a", label: "Push", recommended: true, effects: ["push"], action: "command to the manager agent-manager (release), delivered by the plugin when chosen" },
    ]);
    for (const decision of answer.decisions) expect(decision).not.toHaveProperty("grant");
    // Filtered by status; an unknown request is none.
    expect(JSON.parse((await call(url, { requestId: REQUEST, status: "unsettled" })).body.result.content[0].text).decisions.map((d: { id: string }) => d.id)).toEqual(["o:push-contract"]);
    expect(JSON.parse((await call(url, { requestId: "req-20200101T000000Z" })).body.result.content[0].text)).toEqual({ decisions: [], total: 0, truncated: false });
    // Read-only: every file is byte for byte as it was.
    expect(snapshot(dir)).toEqual(before);
    expect(logs).toContain("[paseo-bm] bm_decisions answered for a manager");
  });

  it("refuses a call without its request, creates no data folder when there is none, and never runs on the pure path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-agent-tools-"));
    homes.push(dir);
    const tools = createManagerTools({ env: { PASEO_BM_HOME: join(dir, "data") }, homedir: () => dir });
    const refused = await tools.call("bm_decisions", { status: "open" });
    expect(refused).toEqual({ ok: false, text: "The call was refused. Fix these and call bm_decisions again:\n- input.requestId: is required" });
    expect(await tools.call("bm_decisions", { requestId: REQUEST })).toEqual({ ok: true, text: JSON.stringify({ decisions: [], total: 0, truncated: false }, null, 2) });
    expect(readdirSync(dir)).toEqual([]);
    expect(answer("manager", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bm_decisions", arguments: { requestId: REQUEST } } })).toMatchObject({ error: { code: -32603 } });
    // A Worker or a Reviewer has no bm_decisions.
    const { endpoint } = await start();
    for (const role of ["worker", "reviewer"] as const) {
      expect((await call(endpoint.urlFor(role)!, { requestId: REQUEST })).body.error).toEqual({ code: -32602, message: "Unknown tool: bm_decisions" });
    }
  });
});

describe("the Orchestrator's secret kept across restarts (design §5.1)", () => {
  const made = new Date("2026-09-28T09:00:00.000Z");
  const later = new Date("2026-09-29T08:00:00.000Z");

  it("reuses the secret after a restart: the old URL still answers, secretSince stays, and an Orchestrator created after it is not stale", async () => {
    const dir = home();
    const first = await start(dir, undefined, () => made);
    const url = first.endpoint.urlFor("orchestrator")!;
    const secretFile = secretPathOf(first.path);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(savedSecret(secretFile, later)).toEqual({ secret: url.slice(-64), since: made });
    await first.endpoint.close();

    const second = await start(dir, undefined, () => later);
    expect(second.endpoint.urlFor("orchestrator")).toBe(url);
    expect(second.endpoint.secretSince).toEqual(made);
    expect((await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    // The Orchestrator the owner opened the day before keeps its tools.
    const stale = toolsStaleSince(second.endpoint.secretSince);
    expect(stale({ createdAt: "2026-09-28T10:00:00.000Z" })).toBe(false);
    expect(stale({ createdAt: "2026-09-28T08:00:00.000Z" })).toBe(true);
    // The secret never reaches a log line.
    expect([...first.logs, ...second.logs].join("\n")).not.toContain(url.slice(-64));
    // Still only under the secret: any other path is a 404.
    const bare = url.replace(/\/[0-9a-f]{64}$/, "");
    expect((await rpc(`${bare}/${"0".repeat(64)}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    expect((await rpc(bare, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("makes and saves a new secret when the file is missing, corrupt, of the wrong shape, readable by others, or dated in the future", async () => {
    const dir = home();
    const first = await start(dir, undefined, () => made);
    const secretFile = secretPathOf(first.path);
    const original = first.endpoint.urlFor("orchestrator")!.slice(-64);
    await first.endpoint.close();

    const bodies: Array<[string, string | null]> = [
      ["missing", null],
      ["not JSON", "{not json"],
      ["another schema", JSON.stringify({ schemaVersion: 2, secret: original, createdAt: made.toISOString() })],
      ["a short secret", JSON.stringify({ schemaVersion: 1, secret: original.slice(0, 32), createdAt: made.toISOString() })],
      ["an upper-case secret", JSON.stringify({ schemaVersion: 1, secret: original.toUpperCase(), createdAt: made.toISOString() })],
      ["an unreadable time", JSON.stringify({ schemaVersion: 1, secret: original, createdAt: "yesterday" })],
      ["a time ahead of now", JSON.stringify({ schemaVersion: 1, secret: original, createdAt: "2026-09-30T00:00:00.000Z" })],
      ["readable by others", "world-readable"],
    ];
    let previous = original;
    for (const [what, body] of bodies) {
      rmSync(secretFile, { force: true });
      if (body === "world-readable") {
        writeFileSync(secretFile, JSON.stringify({ schemaVersion: 1, secret: previous, createdAt: made.toISOString() }));
        chmodSync(secretFile, 0o644);
      } else if (body !== null) {
        writeFileSync(secretFile, body, { mode: 0o600 });
      }
      const next = await start(dir, undefined, () => later);
      const secret = next.endpoint.urlFor("orchestrator")!.slice(-64);
      expect(secret, what).not.toBe(previous);
      expect(next.endpoint.secretSince, what).toEqual(later);
      expect(savedSecret(secretFile, later), what).toEqual({ secret, since: later });
      expect(statSync(secretFile).mode & 0o777, what).toBe(0o600);
      // The old secret's path is a 404 now.
      const bare = next.endpoint.urlFor("orchestrator")!.replace(/\/[0-9a-f]{64}$/, "");
      expect((await rpc(`${bare}/${previous}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, what).toBe(404);
      await next.endpoint.close();
      previous = secret;
    }
  });

  it("reads no secret through a symlink, writes none through one, and still serves with a secret of its own", async () => {
    const dir = home();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "orchestrator-endpoint.json"), JSON.stringify({ schemaVersion: 1, secret: "a".repeat(64), createdAt: made.toISOString() }), {
      mode: 0o600,
    });
    symlinkSync(outside, join(dir, ".paseo-bm", "ui"));
    const path = join(dir, ".paseo-bm", "ui", "agent-tools.json");
    expect(savedSecret(secretPathOf(path), later)).toBeNull();
    const logs: string[] = [];
    const endpoint = startAgentTools({ statePath: path, log: (line) => logs.push(line), now: () => later });
    endpoints.push(endpoint);
    await endpoint.ready;
    expect(endpoint.urlFor("orchestrator")!.slice(-64)).not.toBe("a".repeat(64));
    expect(endpoint.secretSince).toEqual(later);
    expect(JSON.parse(readFileSync(join(outside, "orchestrator-endpoint.json"), "utf8")).secret).toBe("a".repeat(64));
    expect(logs.join("\n")).toContain("could not save the Orchestrator's endpoint secret");
  });
});

/** Every file under `dir`, with its content: what a refused call must leave as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath, entry.name)] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return out;
}

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

  it("says when the Orchestrator path's secret was made, for the stale-tools check (design §5.1)", async () => {
    const dir = home();
    const made = new Date("2026-09-28T09:00:00.000Z");
    const endpoint = startAgentTools({ statePath: join(dir, ".paseo-bm", "ui", "agent-tools.json"), log: () => {}, now: () => made });
    endpoints.push(endpoint);
    await endpoint.ready;
    expect(endpoint.secretSince).toEqual(made);
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
      // No secret, so no Orchestrator can be told it lost one (design §5.1).
      expect(endpoint.secretSince).toBeNull();
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
          { kind: "mcp", server: AGENT_TOOLS_SERVER, tool: "bm_reply" },
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
    expect(applyAgentTools(request("bm-worker-fallback-1/x"), tools, "opencode")?.config.toolPolicy?.preapproved).toEqual(
      ["bm_report", "bm_reply"].map((tool) => ({ kind: "mcp", server: AGENT_TOOLS_SERVER, tool })),
    );
    const orchestrator = applyAgentTools(request("bm-orchestrator/claude-opus-5"), tools, "claude");
    expect(orchestrator?.config.mcpServers?.[AGENT_TOOLS_SERVER]).toEqual({ type: "http", url: "http://127.0.0.1:4567/mcp/orchestrator", alwaysLoad: true });
    expect(orchestrator?.config.toolPolicy?.preapproved).toEqual(
      ["bm_projects", "bm_request", "bm_agent_messages", "bm_send_command", "bm_decisions", "bm_ask_owner", "bm_decide", "bm_predict", "bm_direct_worker", "bm_repo", "bm_note", "bm_findings", "bm_compact", "bm_handoff", "bm_why", "bm_reply"].map((tool) => ({ kind: "mcp", server: AGENT_TOOLS_SERVER, tool })),
    );
    expect(applyAgentTools(request("bm-orchestrator"), tools, "copilot")).toBeUndefined();
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
    const bases: Record<string, string> = { "bm-manager": "claude", "bm-worker": "codex", "bm-reviewer": "opencode", "bm-worker-fallback-1": "pi", "bm-orchestrator": "codex" };
    // A config read that answers late and out of order, as a busy daemon does.
    const paseo = { config: { get: () => new Promise((resolve) => setTimeout(() => resolve({ config: { providers: Object.fromEntries(Object.entries(bases).map(([id, base]) => [id, { extends: base }])) } }), Math.random() * 20)) } };
    const providers = Object.keys(bases);
    const expected: Record<string, string | undefined> = { "bm-manager": "bm_answers", "bm-worker": "bm_report", "bm-reviewer": "bm_review", "bm-worker-fallback-1": undefined, "bm-orchestrator": "bm_projects" };
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
    expect(manager?.config.toolPolicy?.preapproved).toEqual(["bm_answers", "bm_decisions"].map((tool) => ({ kind: "mcp", server: AGENT_TOOLS_SERVER, tool })));
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
