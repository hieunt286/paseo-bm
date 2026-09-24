/**
 * The MCP endpoint that serves the agents' block-building tools (design delta
 * 20260924b-agent-tools §3.3, ADR-010).
 *
 * The plugin's own server process listens on 127.0.0.1 and answers MCP's
 * JSON-RPC over HTTP with one JSON response per request: `initialize`,
 * `tools/list`, `tools/call`, `ping`, and notifications. Each role has its own
 * path, `/mcp/<role>`, so an agent lists only its own tool. The tools have no
 * side effect (`shared/bm-tools.ts`), which is why the endpoint asks nobody who
 * they are; it still refuses what no agent sends — a browser's `Origin`, a
 * foreign `Host`, a body over `MAX_BODY_BYTES`.
 *
 * The port outlives the process: it is kept in `~/.paseo-bm/ui/agent-tools.json`
 * and taken again on the next start, so a live agent keeps its tools across a
 * plugin reload. A port someone else took costs only that: a new port, and old
 * agents write their blocks by hand again (ADR-010, Q3 a).
 *
 * Nothing here throws into the plugin: a failure is one log line and no tools.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { toolNamed, toolsFor, type AgentTool, type ToolRole } from "../shared/bm-tools";
import { UI_DIR_NAME } from "./install-home";

/** Name of the MCP server in an agent's config; Claude shows the tools as `mcp__paseo-bm__<tool>`. */
export const AGENT_TOOLS_SERVER = "paseo-bm";
export const MAX_BODY_BYTES = 1_000_000;
/**
 * The providers Paseo can pre-approve an MCP tool for. For any other, a
 * creation request that carries `toolPolicy` is refused outright ("cannot
 * preapprove exact MCP tools for unattended execution", Paseo 0.8
 * `applyProviderConfiguration`, `PROVIDER_CONTRACTS.supportsExactMcpPreapproval`),
 * so an agent on Pi or Copilot gets no tools and writes its blocks by hand.
 */
export const TOOL_PROVIDERS: readonly string[] = ["claude", "codex", "opencode"];
const STATE_FILE = "agent-tools.json";
const STATE_VERSION = 1;
/** Newest first: a client asking for one we do not know gets the newest (MCP lifecycle). */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type JsonRpcReply = { jsonrpc: "2.0"; id: unknown; result: unknown } | { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

function reply(id: unknown, result: unknown): JsonRpcReply {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: unknown, code: number, message: string): JsonRpcReply {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function describe(tool: AgentTool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * The answer to one JSON-RPC message for `role`, or null for a notification.
 * Pure: the transport is `startAgentTools`.
 */
export function answer(role: ToolRole, message: unknown): JsonRpcReply | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return failure(null, -32600, "Invalid Request");
  const { id, method, params } = message as JsonRpcRequest;
  if (typeof method !== "string") return failure(id, -32600, "Invalid Request");
  // A notification (no id) is acknowledged by the transport, never answered.
  if (id === undefined) return null;
  switch (method) {
    case "initialize": {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof asked === "string" && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
      return reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: AGENT_TOOLS_SERVER, version: "1" } });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: toolsFor(role).map(describe) });
    case "tools/call": {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = typeof call.name === "string" ? toolNamed(call.name) : undefined;
      if (tool === undefined || tool.role !== role) return failure(id, -32602, `Unknown tool: ${String(call.name)}`);
      const result = tool.run(call.arguments ?? {});
      return result.ok
        ? reply(id, { content: [{ type: "text", text: result.text }] })
        : reply(id, {
            content: [{ type: "text", text: `The block was not built. Fix these and call ${tool.name} again:\n${result.issues.map((issue) => `- ${issue}`).join("\n")}` }],
            isError: true,
          });
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

function roleOfPath(path: string): ToolRole | null {
  const match = /^\/mcp\/(worker|reviewer|manager)\/?$/.exec(path);
  return match === null ? null : (match[1] as ToolRole);
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, answer 413, and let `connection: close` end the socket.
        request.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status, status === 413 ? { connection: "close" } : {}).end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse, log: (line: string) => void): Promise<void> {
  // An agent's MCP client sends no Origin; a web page always does.
  if (request.headers.origin !== undefined) return send(response, 403);
  const host = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") return send(response, 403);
  const role = roleOfPath(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  if (role === null) return send(response, 404);
  // Streamable HTTP lets a client open a server-sent event stream with GET; there is nothing to stream.
  if (request.method !== "POST") return send(response, 405);
  const body = await readBody(request);
  if (body === null) return send(response, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(response, 400, failure(null, -32700, "Parse error"));
  }
  if (Array.isArray(parsed) && parsed.length === 0) return send(response, 400, failure(null, -32600, "Invalid Request"));
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const replies = messages
    .map((message) => {
      const reply = answer(role, message);
      // One line per call of a real tool, for the numbers of AT-5; an unknown tool is not worth one.
      if (reply !== null && "result" in reply && (message as JsonRpcRequest).method === "tools/call") {
        const name = String(((message as JsonRpcRequest).params as { name?: unknown }).name);
        log(`[paseo-bm] ${name} ${(reply.result as { isError?: boolean }).isError === true ? "refused its input" : "built a block"} for a ${role}`);
      }
      return reply;
    })
    .filter((reply): reply is JsonRpcReply => reply !== null);
  if (replies.length === 0) return send(response, 202);
  send(response, 200, Array.isArray(parsed) ? replies : replies[0]);
}

// ---------------------------------------------------------------------------
// The port kept across restarts.
// ---------------------------------------------------------------------------

export function statePath(home: string = homedir()): string {
  return join(home, ".paseo-bm", UI_DIR_NAME, STATE_FILE);
}

/** The port saved by an earlier start, or null. Never throws. */
export function savedPort(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; port?: unknown };
    const port = parsed.port;
    return parsed.schemaVersion === STATE_VERSION && typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** Saves the port, but only inside an install home that exists: this never creates one. */
function savePort(path: string, port: number, log: (line: string) => void): void {
  try {
    const home = dirname(dirname(path));
    if (!existsSync(home)) return;
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: STATE_VERSION, port })}\n`);
    renameSync(temp, path);
  } catch (error) {
    log(`[paseo-bm] could not save the agent tools port: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function listen(server: Server, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const onError = () => {
      server.off("listening", onListening);
      resolve(null);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : null);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export interface AgentToolsEndpoint {
  /** The URL of `role`'s tools, or null while the endpoint is not listening. */
  urlFor(role: ToolRole): string | null;
  /** Resolves once the endpoint listens, or failed to. */
  ready: Promise<void>;
  close(): Promise<void>;
}

export interface StartOptions {
  statePath?: string;
  log?: (line: string) => void;
}

/** Starts the endpoint: the saved port first, any free port after. Never throws. */
export function startAgentTools(options: StartOptions = {}): AgentToolsEndpoint {
  const log = options.log ?? ((line: string) => console.warn(line));
  const path = options.statePath ?? statePath();
  let port: number | null = null;
  const server = createServer((request, response) => {
    handle(request, response, log).catch(() => send(response, 500));
  });
  const ready = (async () => {
    try {
      const saved = savedPort(path);
      port = saved === null ? null : await listen(server, saved);
      if (port === null) port = await listen(server, 0);
      // The plugin process lives for its IPC channel, not for this socket.
      server.unref();
      if (port === null) {
        log("[paseo-bm] the agent tools endpoint could not listen; agents write their BM-* blocks by hand.");
        return;
      }
      if (port !== saved) savePort(path, port, log);
    } catch (error) {
      port = null;
      log(`[paseo-bm] the agent tools endpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return {
    urlFor: (role) => (port === null ? null : `http://127.0.0.1:${port}/mcp/${role}`),
    ready,
    // After `ready`: closing a server whose listen is still pending leaves that listen unanswered.
    close: async () => {
      await ready;
      port = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The creation hook's part.
// ---------------------------------------------------------------------------

interface ToolConfig {
  mcpServers?: Record<string, unknown>;
  toolPolicy?: { preapproved?: Array<{ kind: "mcp"; server: string; tool: string }> };
}

/**
 * `config` with the role's tool server added and its tools pre-approved, or
 * undefined when there is nothing to add (no URL, not a role with tools).
 * Keeps every server and approval already there.
 */
export function withAgentTools<C extends object>(config: C, role: ToolRole, url: string | null): C | undefined {
  if (url === null) return undefined;
  const current = config as C & ToolConfig;
  const approved = current.toolPolicy?.preapproved ?? [];
  const ours = toolsFor(role)
    .map((tool) => ({ kind: "mcp" as const, server: AGENT_TOOLS_SERVER, tool: tool.name }))
    .filter((ref) => !approved.some((known) => known.server === ref.server && known.tool === ref.tool));
  return {
    ...current,
    // `alwaysLoad`: Claude otherwise hides the tool behind a tool search, one
    // more step before every report (AT-3, 2026-09-24). Other providers ignore it.
    mcpServers: { ...current.mcpServers, [AGENT_TOOLS_SERVER]: { type: "http", url, alwaysLoad: true } },
    toolPolicy: { ...current.toolPolicy, preapproved: [...approved, ...ours] },
  };
}
