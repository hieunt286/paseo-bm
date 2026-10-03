/**
 * The MCP endpoint that serves the agents' block-building tools (design delta
 * 20260924b-agent-tools §3.3, ADR-010).
 *
 * The plugin's own server process listens on 127.0.0.1 and answers MCP's
 * JSON-RPC over HTTP with one JSON response per request: `initialize`,
 * `tools/list`, `tools/call`, `ping`, and notifications. Each role has its own
 * path, `/mcp/<role>`, so an agent lists only its own tools. The block tools
 * have no side effect (`shared/bm-tools.ts`), which is why their paths ask
 * nobody who they are; the endpoint still refuses what no agent sends — a
 * browser's `Origin`, a foreign `Host`, a body over `MAX_BODY_BYTES`.
 *
 * One tool of the Manager's path is served by the plugin too: `bm_decisions`
 * (autonomy design §A.9, `decision-tools.ts`) reads the decisions of one
 * request from the decision store. It writes nothing, so the path still asks
 * nobody who they are.
 *
 * One tool of the Worker's path is served by the plugin as well: `bm_reply`
 * (change-014 outcome 3, Ask back; `decision-ask.ts`). It appends the
 * Worker's reply to a decision's thread, and only to a `q:` decision whose
 * owner asked and got no reply yet, so the path still asks nobody who they
 * are: a call can add one reply where the owner is waiting for one, nothing
 * else.
 *
 * The Orchestrator's tools read every paseo-bm project, ask the owner and
 * send commands (Orchestrator design §5, ADR-014 decision 3), so its path carries a secret:
 * `/mcp/orchestrator/<secret>`, 32 random bytes in hex. Any other
 * `/mcp/orchestrator…` path is a `404`. The creation hook gets the URL from
 * `urlFor`; `orchestrator-tools.ts` runs the tools.
 *
 * The port outlives the process: it is kept in `~/.paseo-bm/ui/agent-tools.json`
 * and taken again on the next start, so a live agent keeps its tools across a
 * plugin reload. A port someone else took costs only that: a new port, and old
 * agents write their blocks by hand again (ADR-010, Q3 a).
 *
 * So does the secret, in `ui/orchestrator-endpoint.json` beside it (`0600`,
 * written atomically, read and written through no symlink): made once, when
 * that file is missing or unusable, and reused by every later start. Before
 * 2026-09-29 it lived in memory only, and a plugin reload left the Orchestrator
 * the owner opened the day before with a dead URL ("Error POSTing to
 * endpoint"). `secretSince` is when the stored secret was made.
 *
 * An agent the plugin creates itself, on a provider that can take the tools,
 * gets its own path instead: `/mcp/<worker|reviewer|manager>/<token>`, backed
 * by a binding in `ui/agent-bindings.json` (design §16.5, `agent-bindings.ts`).
 * The endpoint hashes the token and looks it up: a bound binding of the path's
 * role is the caller (`ToolCaller`) the server-run tools receive; a pending one
 * is a caller without an agent, whom every tool that acts refuses ("try again
 * in a moment"); an unknown, revoked or other role's token is no caller at all
 * and gets the role's builder-only tools — never a 404, so a lost binding file
 * never costs an agent its tools. A token never reaches a log line or a result.
 *
 * Nothing here throws into the plugin: a failure is one log line and no tools.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serverToolsFor, toolNamed, toolFacesFor, type ToolRole, type ToolFace } from "../shared/bm-tools";
import {
  AGENT_TOOLS_SERVER,
  NO_BINDER,
  createBindingStore,
  isBindingToken,
  isBoundRole,
  type AgentBinder,
  type BindingStore,
  type BoundRole,
  type ToolCaller,
} from "./agent-bindings";
import { ensureDataHome, resolveDataHome, type DataHomeDeps } from "./data-home";
import { UI_DIR_NAME } from "./data-home";
import { createManagerTools, type ServerTools } from "./decision-tools";
import { createOrchestratorTools, type OrchestratorTools } from "./orchestrator-tools";
import { createWorkerTools } from "./decision-ask";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically } from "./trace-store";

/** Name of the MCP server in an agent's config; Claude shows the tools as `mcp__paseo-bm__<tool>`. */
export { AGENT_TOOLS_SERVER };
export const MAX_BODY_BYTES = 1_000_000;
/**
 * The providers Paseo can pre-approve an MCP tool for. For any other, a
 * creation request that carries `toolPolicy` is refused outright ("cannot
 * preapprove exact MCP tools for unattended execution", Paseo 0.8
 * `applyProviderConfiguration`, `PROVIDER_CONTRACTS.supportsExactMcpPreapproval`),
 * so an agent on Pi or Copilot gets no tools and writes its blocks by hand.
 */
export const TOOL_PROVIDERS: readonly string[] = ["claude", "codex", "opencode"];
/** Bytes of the Orchestrator path's secret (design §5.1). */
export const ORCHESTRATOR_SECRET_BYTES = 32;
const STATE_FILE = "agent-tools.json";
const STATE_VERSION = 1;
/** The Orchestrator path's secret, kept beside the port (design §5.1). */
export const SECRET_FILE = "orchestrator-endpoint.json";
const SECRET_VERSION = 1;
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

function describe(tool: ToolFace) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * The send step a builder-only answer ends with (design §16.5): an unbound
 * agent briefed by a shorter role file may not know what to do with the block.
 * It is the answer's last content item, after the block, so the block itself
 * stays exactly what `checkBlocks` checked.
 */
export const BUILDER_SEND_LINES: Readonly<Record<string, string>> = {
  bm_report:
    "Send this block with `send_agent_prompt` to the agent that created you (its id is in your first prompt), with `notifyOnFinish: false`.",
  bm_review: "Make this block your final answer, exactly as it is.",
  bm_answers: "Put this block in your reply to the owner; the plugin delivers it. Send the Worker nothing.",
};

/**
 * The answer to one JSON-RPC message for `role`, or null for a notification.
 * Pure: the transport is `startAgentTools`. The Orchestrator's tool calls are
 * not answered here — they read and write plugin data — but by
 * `answerOrchestrator`.
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
      return reply(id, { tools: toolFacesFor(role).map(describe) });
    case "tools/call": {
      if (role === "orchestrator") return failure(id, -32603, "The Orchestrator's tools run on the plugin server");
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
      if (serverToolsFor(role).some((face) => face.name === call.name)) return failure(id, -32603, `${String(call.name)} runs on the plugin server`);
      const tool = typeof call.name === "string" ? toolNamed(call.name) : undefined;
      if (tool === undefined || tool.role !== role) return failure(id, -32602, `Unknown tool: ${String(call.name)}`);
      const result = tool.run(call.arguments ?? {});
      const sendLine = BUILDER_SEND_LINES[tool.name];
      return result.ok
        ? reply(id, { content: [{ type: "text", text: result.text }, ...(sendLine === undefined ? [] : [{ type: "text", text: sendLine }])] })
        : reply(id, {
            content: [{ type: "text", text: `The block was not built. Fix these and call ${tool.name} again:\n${result.issues.map((issue) => `- ${issue}`).join("\n")}` }],
            isError: true,
          });
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * `answer`, with the Orchestrator's tool calls run by `tools`. An unknown
 * tool is a JSON-RPC error; a refused call is a tool result with `isError`,
 * so the agent reads why.
 */
export async function answerOrchestrator(message: unknown, tools: OrchestratorTools): Promise<JsonRpcReply | null> {
  return answerWithServerTools("orchestrator", message, tools);
}

/**
 * `answer` for `role`, with calls of the tools `tools` has run by them (the
 * Orchestrator's, or the Manager's `bm_decisions`); every other message is the
 * pure `answer`'s. For the Orchestrator, a tool `tools` does not have is a
 * JSON-RPC error. `caller` is who a token path names (design §16.5), or null
 * on the role path; the tools receive it.
 */
export async function answerWithServerTools(
  role: ToolRole,
  message: unknown,
  tools: Pick<ServerTools, "has" | "call">,
  caller: ToolCaller | null = null,
): Promise<JsonRpcReply | null> {
  const { id, method, params } = (message ?? {}) as JsonRpcRequest;
  if (method !== "tools/call" || id === undefined || message === null || typeof message !== "object" || Array.isArray(message)) {
    return answer(role, message);
  }
  const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof call.name !== "string" || !tools.has(call.name)) {
    return role === "orchestrator" ? failure(id, -32602, `Unknown tool: ${String(call.name)}`) : answer(role, message);
  }
  const result = await tools.call(call.name, call.arguments ?? {}, caller);
  return result.ok
    ? reply(id, { content: [{ type: "text", text: result.text }] })
    : reply(id, { content: [{ type: "text", text: result.text }], isError: true });
}

/** A new secret for the Orchestrator's path; `startAgentTools` keeps it on disk. */
export function newOrchestratorSecret(): string {
  return randomBytes(ORCHESTRATOR_SECRET_BYTES).toString("hex");
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What a path serves: the role, and the per-agent token of a bound path
 * (`/mcp/<worker|reviewer|manager>/<64 hex>`, design §16.5), else null. The
 * Orchestrator's only with the right secret. A token is only its shape here;
 * the endpoint looks it up.
 */
export function routeOfPath(path: string, secret: string): { role: ToolRole; token: string | null } | null {
  const match = /^\/mcp\/(worker|reviewer|manager)(?:\/([0-9a-f]{64}))?\/?$/.exec(path);
  if (match !== null) return { role: match[1] as ToolRole, token: match[2] ?? null };
  const orchestrator = /^\/mcp\/orchestrator\/([0-9a-f]+)\/?$/.exec(path);
  return orchestrator !== null && sameSecret(orchestrator[1]!, secret) ? { role: "orchestrator", token: null } : null;
}

/** The role a path serves; the Orchestrator's only with the right secret. */
export function roleOfPath(path: string, secret: string): ToolRole | null {
  return routeOfPath(path, secret)?.role ?? null;
}

/**
 * The caller a token path names (design §16.5): the binding's agent when it
 * is bound to `role`, an agent-less caller while it is pending, and null —
 * the role's builder-only tools — for no token, an unknown, revoked or other
 * role's token, or no binding store. Never throws.
 */
export function callerOfRoute(route: { role: ToolRole; token: string | null }, bindings: BindingStore | null): ToolCaller | null {
  if (route.token === null || bindings === null || !isBoundRole(route.role)) return null;
  try {
    return bindings.callerOf(route.token, route.role);
  } catch {
    return null;
  }
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

interface HandleContext {
  secret: string;
  orchestrator: OrchestratorTools;
  manager: ServerTools;
  worker: ServerTools;
  /** The per-agent bindings (design §16.5); null without a data folder. */
  bindings: BindingStore | null;
  log: (line: string) => void;
}

async function handle(request: IncomingMessage, response: ServerResponse, { secret, orchestrator, manager, worker, bindings, log }: HandleContext): Promise<void> {
  // An agent's MCP client sends no Origin; a web page always does.
  if (request.headers.origin !== undefined) return send(response, 403);
  const host = (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") return send(response, 403);
  const route = routeOfPath(new URL(request.url ?? "/", "http://127.0.0.1").pathname, secret);
  if (route === null) return send(response, 404);
  const role = route.role;
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
  // Looked up once per request: who the token path names, if anyone (design §16.5).
  const caller = callerOfRoute(route, bindings);
  // Log lines name the bound agent, never the token.
  const who = caller === null ? "" : caller.agentId === null ? " (binding still pending)" : ` (agent ${caller.agentId})`;
  const answered: Array<JsonRpcReply | null> = [];
  for (const message of messages) {
    const reply =
      role === "orchestrator"
        ? await answerOrchestrator(message, orchestrator)
        : role === "manager"
          ? await answerWithServerTools(role, message, manager, caller)
          : role === "worker"
            ? await answerWithServerTools(role, message, worker, caller)
            : answer(role, message);
    // One line per call of a real tool, for the numbers of AT-5; an unknown tool is not worth one.
    if (reply !== null && "result" in reply && (message as JsonRpcRequest).method === "tools/call") {
      const name = String(((message as JsonRpcRequest).params as { name?: unknown }).name);
      const refused = (reply.result as { isError?: boolean }).isError === true;
      const served = serverToolsFor(role).some((face) => face.name === name);
      log(
        role === "orchestrator"
          ? `[paseo-bm] ${name} ${refused ? "refused a call" : "answered"} for the orchestrator`
          : served
            ? `[paseo-bm] ${name} ${refused ? "refused a call" : "answered"} for a ${role}${who}`
            : `[paseo-bm] ${name} ${refused ? "refused its input" : "built a block"} for a ${role}${who}`,
      );
    }
    answered.push(reply);
  }
  const replies = answered.filter((reply): reply is JsonRpcReply => reply !== null);
  if (replies.length === 0) return send(response, 202);
  send(response, 200, Array.isArray(parsed) ? replies : replies[0]);
}

// ---------------------------------------------------------------------------
// The port kept across restarts.
// ---------------------------------------------------------------------------

/**
 * Where the port is remembered, or `null` with the reason the data folder is
 * unusable.
 *
 * Resolution goes through `resolveDataHome` (design §5.1), which is why that
 * function is synchronous: the endpoint starts while the plugin is still
 * loading, long before there is a Paseo handle to ask. The path was fixed at
 * `~/.paseo-bm` before 0.4.0, so a user with a data folder anywhere else lost
 * the port on every reload.
 */
export function statePath(deps: DataHomeDeps = {}): { path: string; home: string } | { path: null; reason: string } {
  const resolution = resolveDataHome(deps);
  if (resolution.home === null) return { path: null, reason: resolution.reason };
  return { path: join(resolution.home, UI_DIR_NAME, STATE_FILE), home: resolution.home };
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

/**
 * Writes one of the endpoint's files with the same writer every other store
 * uses: the folder created 0700 when missing, a temporary file fsynced and
 * renamed, 0600, and no symlink anywhere on the path. Before 0.4.0 the port
 * file was the one exception to all three rules, because nothing was allowed
 * to create the install home; the plugin owns the folder now, so the
 * exception is gone. Throws; the callers log.
 */
function saveState(path: string, body: unknown): void {
  const home = dirname(dirname(path));
  const tracesDir = join(home, "traces");
  ensureDataHome(home);
  ensureStoreDir(tracesDir, dirname(path));
  writeStoreFileAtomically({ tracesDir }, path, `${JSON.stringify(body)}\n`);
}

function savePort(path: string, port: number, log: (line: string) => void): void {
  try {
    saveState(path, { schemaVersion: STATE_VERSION, port });
  } catch (error) {
    log(`[paseo-bm] could not save the agent tools port: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The binding store of the data folder the port file `statePath` is in, or null when it cannot be opened. */
function bindingStoreBeside(statePath: string, log: (line: string) => void): BindingStore | null {
  try {
    return createBindingStore(dirname(dirname(statePath)), { log });
  } catch (error) {
    log(`[paseo-bm] the agent tool bindings cannot be used; every agent keeps its role path: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Where the secret is kept: beside the port file. */
export function secretPathOf(statePath: string): string {
  return join(dirname(statePath), SECRET_FILE);
}

/**
 * The secret saved by an earlier start and when it was made, or null when
 * there is none to trust: no file, not ours, a symlink on the way, readable by
 * anyone but the user, a secret of the wrong shape, or a time that cannot be
 * read or lies ahead of `now` (every agent would then look stale, and each
 * wake-up would replace the Orchestrator again). Never throws.
 */
export function savedSecret(path: string, now: Date): { secret: string; since: Date } | null {
  try {
    assertNoSymlinkOnPath(dirname(dirname(path)), path);
    if ((lstatSync(path).mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; secret?: unknown; createdAt?: unknown };
    if (parsed.schemaVersion !== SECRET_VERSION || typeof parsed.secret !== "string" || typeof parsed.createdAt !== "string") return null;
    if (!new RegExp(`^[0-9a-f]{${ORCHESTRATOR_SECRET_BYTES * 2}}$`).test(parsed.secret)) return null;
    const since = Date.parse(parsed.createdAt);
    if (Number.isNaN(since) || since > now.getTime()) return null;
    return { secret: parsed.secret, since: new Date(since) };
  } catch {
    return null;
  }
}

/**
 * The saved secret, or a new one saved for the next start. A secret that
 * cannot be saved still serves this start; the next one makes another, and an
 * Orchestrator created meanwhile is then replaced at its next wake-up.
 */
function orchestratorSecretOf(path: string, now: Date, log: (line: string) => void): { secret: string; since: Date } {
  const saved = savedSecret(path, now);
  if (saved !== null) return saved;
  const made = { secret: newOrchestratorSecret(), since: now };
  try {
    saveState(path, { schemaVersion: SECRET_VERSION, secret: made.secret, createdAt: now.toISOString() });
  } catch (error) {
    log(`[paseo-bm] could not save the Orchestrator's endpoint secret: ${error instanceof Error ? error.message : String(error)}`);
  }
  return made;
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
  /** The URL of `role`'s tools, or null while the endpoint is not listening; the Orchestrator's carries the secret. */
  urlFor(role: ToolRole): string | null;
  /** The per-agent bindings (design §16.5); null when the data folder cannot be used. */
  readonly bindings: BindingStore | null;
  /** Issues and settles the bindings of the agents the plugin creates itself (a fallback Worker, a Manager). */
  readonly binder: AgentBinder;
  /** Hands the Orchestrator's tools a Paseo handle from a hook or RPC context (`orchestrator-tools.ts`). */
  usePaseo(paseo: unknown): void;
  /**
   * When the Orchestrator path's secret was made — by this start or, the
   * secret being kept on disk, an earlier one — or null when the endpoint has
   * none. An Orchestrator created before it has an old URL and no tools
   * (design §5.1, `toolsStaleSince`).
   */
  readonly secretSince: Date | null;
  /** Resolves once the endpoint listens, or failed to. */
  ready: Promise<void>;
  close(): Promise<void>;
}

export interface StartOptions {
  statePath?: string;
  log?: (line: string) => void;
  /** The Orchestrator's tools; `createOrchestratorTools()` by default. */
  orchestrator?: OrchestratorTools;
  /** The Manager's server-run tools (`bm_decisions`); `createManagerTools()` by default. */
  manager?: ServerTools;
  /** The Worker's server-run tools (`bm_reply`, change-014 Ask back); `createWorkerTools()` by default. */
  worker?: ServerTools;
  /** The per-agent bindings; the data folder's `ui/agent-bindings.json` by default (design §16.5). */
  bindings?: BindingStore | null;
  /** The clock that stamps a new secret's `secretSince`; tests only. */
  now?: () => Date;
}

/** The URL of a bound agent's own tool path, `<role URL>/<token>` (design §16.5). */
export function boundUrlOf(roleUrl: string, token: string): string {
  return `${roleUrl}/${token}`;
}

/**
 * The binder of an endpoint (design §16.5): a token only for a base provider
 * in `TOOL_PROVIDERS` while the endpoint listens and the store can be
 * written. Never throws; a failure is one log line and an unbound agent.
 */
export function binderOf(
  urlFor: (role: ToolRole) => string | null,
  bindings: BindingStore | null,
  log: (line: string) => void,
): AgentBinder {
  if (bindings === null) return NO_BINDER;
  return {
    issue(request) {
      if (request.base === null || !TOOL_PROVIDERS.includes(request.base)) return null;
      const roleUrl = urlFor(request.role);
      if (roleUrl === null) return null;
      try {
        const { token, tokenSha256 } = bindings.issue(request);
        return { tokenSha256, mcpServer: { type: "http", url: boundUrlOf(roleUrl, token), alwaysLoad: true } };
      } catch (error) {
        log(`[paseo-bm] could not issue a tool binding for a new ${request.role}; it is created unbound: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    settle: (issued, agentId) => bindings.settle(issued.tokenSha256, agentId),
    discard: (issued) => bindings.discard(issued.tokenSha256),
  };
}

/**
 * Whether an Orchestrator agent created at `createdAt` has lost its tools: it
 * was created before the secret made at `since`, so the URL its session holds
 * is `404` now (design §5.1). A missing or unreadable creation time, or no
 * secret at all, cannot tell, and reads as not stale.
 */
export function toolsStaleSince(since: Date | null): (agent: { createdAt: string | null }) => boolean {
  return (agent) => {
    if (since === null || agent.createdAt === null) return false;
    const created = Date.parse(agent.createdAt);
    return !Number.isNaN(created) && created < since.getTime();
  };
}

/** Starts the endpoint: the saved port first, any free port after. Never throws. */
export function startAgentTools(options: StartOptions = {}): AgentToolsEndpoint {
  const log = options.log ?? ((line: string) => console.warn(line));
  const resolved = options.statePath === undefined ? statePath() : { path: options.statePath };
  if (resolved.path === null) {
    log(
      `[paseo-bm] the agent tools endpoint cannot use the paseo-bm data folder (${resolved.reason}); agents write their BM-* blocks by hand.`,
    );
    return {
      urlFor: () => null,
      bindings: null,
      binder: NO_BINDER,
      usePaseo: () => {},
      secretSince: null,
      ready: Promise.resolve(),
      close: async () => {},
    };
  }
  const path = resolved.path;
  const orchestrator = options.orchestrator ?? createOrchestratorTools();
  const manager = options.manager ?? createManagerTools();
  const worker = options.worker ?? createWorkerTools();
  const { secret, since: secretSince } = orchestratorSecretOf(secretPathOf(path), (options.now ?? (() => new Date()))(), log);
  // Beside the port and the secret: `<data folder>/ui/agent-bindings.json` (design §16.5).
  const bindings = options.bindings !== undefined ? options.bindings : bindingStoreBeside(path, log);
  let port: number | null = null;
  const server = createServer((request, response) => {
    handle(request, response, { secret, orchestrator, manager, worker, bindings, log }).catch(() => send(response, 500));
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
  const urlFor = (role: ToolRole): string | null =>
    port === null ? null : `http://127.0.0.1:${port}/mcp/${role}${role === "orchestrator" ? `/${secret}` : ""}`;
  return {
    urlFor,
    bindings,
    binder: binderOf(urlFor, bindings, log),
    usePaseo: (paseo) => orchestrator.usePaseo(paseo),
    secretSince,
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
 * `config` without a `paseo-bm` MCP server entry, or undefined when it has
 * none (design §16.5): on a base provider outside `TOOL_PROVIDERS` that
 * entry would give the agent tools that are not pre-approved. Every other
 * server is kept.
 */
export function withoutAgentTools<C extends object>(config: C): C | undefined {
  const servers = (config as C & ToolConfig).mcpServers;
  if (servers === null || typeof servers !== "object" || !(AGENT_TOOLS_SERVER in servers)) return undefined;
  const rest = { ...servers };
  delete rest[AGENT_TOOLS_SERVER];
  return { ...config, mcpServers: rest };
}

/**
 * The token of the bound URL `config` already carries for `role`, or null
 * (design §16.5): `config.mcpServers["paseo-bm"].url` must be exactly
 * `<roleUrl>/<64 hex>` — the endpoint's own port and role path. Whether the
 * token is pending is the binding store's to say.
 */
export function boundTokenOf(config: unknown, role: BoundRole, roleUrl: string | null): string | null {
  if (roleUrl === null) return null;
  const servers = (config as ToolConfig | null | undefined)?.mcpServers;
  const entry = servers !== null && typeof servers === "object" ? (servers[AGENT_TOOLS_SERVER] as { url?: unknown } | null | undefined) : undefined;
  const url = entry !== null && typeof entry === "object" ? entry.url : undefined;
  if (typeof url !== "string" || !url.startsWith(`${roleUrl}/`)) return null;
  const token = url.slice(roleUrl.length + 1);
  return isBindingToken(token) ? token : null;
}

/**
 * `config` with the role's tool server added and its tools pre-approved, or
 * undefined when there is nothing to add (no URL, not a role with tools).
 * Keeps every server and approval already there; a `paseo-bm` entry is
 * replaced by `url`.
 */
export function withAgentTools<C extends object>(config: C, role: ToolRole, url: string | null): C | undefined {
  if (url === null) return undefined;
  const current = config as C & ToolConfig;
  const approved = current.toolPolicy?.preapproved ?? [];
  const ours = toolFacesFor(role)
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
