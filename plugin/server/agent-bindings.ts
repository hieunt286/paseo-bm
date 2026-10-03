/**
 * Per-agent tool bindings (design §16.5, ADR-027 decisions 3 and 9).
 *
 * When the plugin itself creates an agent on a provider that can take
 * pre-approved tools, it gives that agent its own endpoint path,
 * `/mcp/<role>/<token>`, and keeps a binding: what the token stands for (the
 * agent, its role, workspace, request, parent and batch). The endpoint then
 * knows who calls a tool. Every other paseo-bm agent is unbound and keeps
 * ADR-010's role path, `/mcp/<role>`, and its builder-only tools.
 *
 * The store is `<data folder>/ui/agent-bindings.json` (`0600`, beside
 * `orchestrator-endpoint.json`), a `createJsonFileStore` file: atomic writes,
 * no symlink, a newer `schemaVersion` read as empty and never written. Only
 * the token's SHA-256 is stored; the token itself lives in the agent's MCP
 * configuration and, while the plugin creates the agent, in its memory. A
 * token never reaches a log line, an RPC result, an MCP result or a trace:
 * log lines name the agent id.
 *
 * Lifecycle (§16.5): `pending` is written before `agents.create`; the
 * creation hook records `attachedAt` when it keeps the token URL; the binding
 * becomes `bound` when `agents.create` returns AND `attachedAt` is set, and is
 * deleted otherwise (the agent is then unbound), when the creation throws
 * before the hook attached it, or when it stays `pending` for more than ten
 * minutes. An attached binding outlives a creation that threw, and a plugin
 * reload: Paseo may still have created the agent, so `agent.created` settles
 * it by the agent's role, parent and `bm.batchId` / `bm.requestId` labels
 * (`settleCreated`). `agent.archived` revokes
 * it; a revoked binding goes seven days later; the first Paseo handle of a
 * plugin run sweeps away every binding whose agent Paseo no longer lists. At
 * most 5,000 bindings are kept, the oldest revoked ones dropped first.
 *
 * Every function is synchronous on the file (the plugin server is one
 * thread, so a read-modify-write cannot interleave with another) and the
 * lookups never throw: a lost or unreadable file must never cost an agent its
 * tools — an unknown token is simply an unbound caller.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents } from "./agent-role";
import { capBy, clearJsonFileCache, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { UI_DIR_NAME } from "./data-home";
import { timeOrZero } from "../shared/time";

/** Name of the MCP server in an agent's config; Claude shows the tools as `mcp__paseo-bm__<tool>` (`agent-tools.ts` re-exports it). */
export const AGENT_TOOLS_SERVER = "paseo-bm";
/** The binding store's file, in the data folder's `ui/`. */
export const BINDINGS_FILE = "agent-bindings.json";
export const BINDINGS_VERSION = 1;
/** Bytes of a token: 64 hex characters on the path. */
export const BINDING_TOKEN_BYTES = 32;
/** A binding still `pending` after this long was never attached: deleted. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** A revoked binding is deleted this long after its revocation. */
export const REVOKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The most bindings the file keeps; the oldest revoked ones go first. */
export const MAX_BINDINGS = 5_000;
/** The answer a delivering or creating tool gives a caller whose binding is still pending. */
export const PENDING_CALLER_MESSAGE = "paseo-bm is still setting up this agent's tools; try again in a moment. Nothing was created, stored or sent.";

export const BOUND_ROLES = ["manager", "worker", "reviewer"] as const;
export type BoundRole = (typeof BOUND_ROLES)[number];
export type BindingState = "pending" | "bound" | "revoked";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const isoOrNull = z.string().nullable();
const bindingSchema = z.object({
  tokenSha256: z.string().regex(TOKEN_PATTERN),
  role: z.enum(BOUND_ROLES),
  state: z.enum(["pending", "bound", "revoked"]),
  agentId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1),
  requestId: z.string().nullable(),
  parentId: z.string().nullable(),
  batchId: z.string().nullable(),
  createdAt: z.string(),
  attachedAt: isoOrNull,
  boundAt: isoOrNull,
  revokedAt: isoOrNull,
});

export type AgentBinding = z.infer<typeof bindingSchema>;

/**
 * Who calls a tool through a token path (§16.5): a bound agent, which lists
 * and runs its role's delivering and creating tools (§16.6); `agentId: null`
 * while the binding is still pending.
 */
export interface ToolCaller {
  agentId: string | null;
  role: BoundRole;
  workspaceId: string;
  requestId: string | null;
  parentId: string | null;
  batchId: string | null;
}

/**
 * The live (bound) binding of `agentId` — of `role` when given — or null: the
 * plugin's tools create that agent's children and carry its blocks, so it is
 * "bound" for §16.4, §16.8 and §16.9. Pure over `bindings`.
 */
export function liveBindingOf(bindings: readonly AgentBinding[], agentId: string | null, role?: BoundRole): AgentBinding | null {
  if (agentId === null) return null;
  return bindings.find((binding) => binding.agentId === agentId && binding.state === "bound" && (role === undefined || binding.role === role)) ?? null;
}

/** What a binding is issued for: everything but the agent, which does not exist yet. */
export interface BindingInput {
  role: BoundRole;
  workspaceId: string;
  requestId?: string | null;
  parentId?: string | null;
  batchId?: string | null;
}

export function isBoundRole(value: unknown): value is BoundRole {
  return typeof value === "string" && (BOUND_ROLES as readonly string[]).includes(value);
}

/** A new token: 32 random bytes in hex. */
export function newBindingToken(): string {
  return randomBytes(BINDING_TOKEN_BYTES).toString("hex");
}

/** The SHA-256 of a token, in hex: the only form the store keeps. */
export function tokenHashOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isBindingToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** True when `binding` is past its time at `now`: pending over ten minutes, revoked over seven days. */
export function isExpired(binding: AgentBinding, now: number): boolean {
  if (binding.state === "pending") return now - timeOrZero(binding.createdAt) > PENDING_TTL_MS;
  if (binding.state === "revoked") return now - timeOrZero(binding.revokedAt) > REVOKED_TTL_MS;
  return false;
}

/** The bindings kept at `now`: the expired ones out, then at most `MAX_BINDINGS`, the oldest revoked ones first to go. */
export function capBindings(bindings: readonly AgentBinding[], now: number): AgentBinding[] {
  const live = bindings.filter((binding) => !isExpired(binding, now));
  return capBy(live, MAX_BINDINGS, (binding) => (binding.state === "revoked" ? timeOrZero(binding.revokedAt) : Number.MAX_SAFE_INTEGER));
}

export interface BindingStore {
  /** The file's absolute path. */
  readonly path: string;
  /** Every binding still in its time, as stored. Never throws: an unreadable file reads as none. */
  list(): AgentBinding[];
  /** Writes a `pending` binding and returns its token, which is never stored. Throws when the file cannot be written. */
  issue(input: BindingInput): { token: string; tokenSha256: string };
  /** True when `token` belongs to a `pending`, unexpired binding of `role`. Never throws. */
  isPending(token: string, role: BoundRole): boolean;
  /** The creation hook kept `token`'s URL: records `attachedAt` on its pending binding of `role`. False when there is none. Never throws. */
  attach(token: string, role: BoundRole): boolean;
  /**
   * `agents.create` returned `agentId`: the binding becomes `bound` when the
   * hook attached it, and is deleted otherwise (the agent is unbound). Never throws.
   */
  settle(tokenSha256: string, agentId: string): "bound" | "unbound";
  /**
   * `agents.create` threw: an unattached binding is deleted; an attached one is
   * kept (`"kept"`) for `agent.created` to settle, or its ten minutes to end:
   * the hook ran, so Paseo may have created the agent. One `agent.created`
   * already bound is kept too (`"kept"`): the agent exists. Never throws.
   */
  discard(tokenSha256: string): "deleted" | "kept" | "none";
  /**
   * `agent.created` of an agent the plugin may have created while its own
   * `agents.create` did not settle the binding (it threw, or a reload lost it):
   * the one attached, unexpired `pending` binding of that role, parent and
   * workspace — and `bm.batchId` (a Reviewer) or `bm.requestId` (a Worker) —
   * becomes `bound` to it. Returns the agent's binding (one it already had
   * included, `settledNow: false`), or null. Never throws.
   */
  settleCreated(agent: CreatedBindingAgent): { binding: AgentBinding | null; settledNow: boolean };
  /** The caller a token path names: bound → its agent, pending → `agentId: null`; unknown, revoked or another role's → null. Never throws. */
  callerOf(token: string, role: BoundRole): ToolCaller | null;
  /** `agent.archived`: every bound binding of `agentId` is revoked. Returns how many. Never throws. */
  revokeAgent(agentId: string): number;
  /**
   * The start-up sweep: deletes every binding with an agent that `listed`
   * does not hold and that was bound before `since` (a binding made while
   * the list was read is kept). Returns how many. Never throws.
   */
  sweep(listed: ReadonlySet<string>, since: Date): number;
  /** The binding of `agentId` (bound or revoked), or null. Never throws. */
  bindingOfAgent(agentId: string): AgentBinding | null;
}

interface BindingsFile {
  bindings: AgentBinding[];
}

/** What `settleCreated` matches a new agent by: `agent.created` and the agent's labels. */
export interface CreatedBindingAgent {
  agentId: string;
  role: BoundRole;
  parentId: string | null;
  workspaceId: string | null;
  /** Its `bm.requestId` label. */
  requestId: string | null;
  /** Its `bm.batchId` label (a Reviewer). */
  batchId: string | null;
}

/** Drops the read cache; tests only. */
export function clearBindingCache(): void {
  clearJsonFileCache();
}

export interface BindingStoreDeps {
  now?: () => Date;
  log?: (message: string) => void;
}

/** The binding store of the data folder `home`. Creating it touches nothing on disk. */
export function createBindingStore(home: string, deps: BindingStoreDeps = {}): BindingStore {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  const file: JsonFileStore<BindingsFile> = createJsonFileStore<BindingsFile>({
    home,
    dir: UI_DIR_NAME,
    file: BINDINGS_FILE,
    version: BINDINGS_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ bindings: entriesOf(bindingSchema, body["bindings"]) }),
    empty: () => ({ bindings: [] }),
    cap: (value) => ({ bindings: capBindings(value.bindings, now().getTime()) }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    cached: true,
  });

  const list = (): AgentBinding[] => {
    try {
      const at = now().getTime();
      return file.read().bindings.filter((binding) => !isExpired(binding, at));
    } catch {
      return [];
    }
  };

  /** One read-modify-write; `change` returns null to write nothing. Throws on a write failure. */
  const update = (change: (bindings: AgentBinding[]) => AgentBinding[] | null): void => {
    file.update((current) => {
      const next = change(current.bindings);
      return next === null ? null : { bindings: next };
    });
  };

  /** `update` that never throws: a failure is one log line naming what was being done. */
  const quietly = (what: string, change: (bindings: AgentBinding[]) => AgentBinding[] | null): boolean => {
    try {
      update(change);
      return true;
    } catch (error) {
      log(`[paseo-bm] could not ${what} in ${BINDINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const pendingOf = (token: string, role: BoundRole): AgentBinding | null => {
    if (!isBindingToken(token)) return null;
    const hash = tokenHashOf(token);
    return list().find((binding) => binding.tokenSha256 === hash && binding.role === role && binding.state === "pending") ?? null;
  };

  return {
    path: file.path,
    list,
    issue(input) {
      const token = newBindingToken();
      const tokenSha256 = tokenHashOf(token);
      const binding: AgentBinding = {
        tokenSha256,
        role: input.role,
        state: "pending",
        agentId: null,
        workspaceId: input.workspaceId,
        requestId: input.requestId ?? null,
        parentId: input.parentId ?? null,
        batchId: input.batchId ?? null,
        createdAt: now().toISOString(),
        attachedAt: null,
        boundAt: null,
        revokedAt: null,
      };
      update((bindings) => [...bindings, bindingSchema.parse(binding)]);
      return { token, tokenSha256 };
    },
    isPending: (token, role) => pendingOf(token, role) !== null,
    attach(token, role) {
      if (pendingOf(token, role) === null) return false;
      const hash = tokenHashOf(token);
      let attached = false;
      const at = now().toISOString();
      const written = quietly("record an attached tool endpoint", (bindings) =>
        bindings.map((binding) => {
          if (binding.tokenSha256 !== hash || binding.state !== "pending" || binding.role !== role) return binding;
          attached = true;
          return { ...binding, attachedAt: at };
        }),
      );
      return written && attached;
    },
    settle(tokenSha256, agentId) {
      let outcome: "bound" | "unbound" = "unbound";
      const at = now().toISOString();
      quietly(`settle the binding of agent ${agentId}`, (bindings) => {
        // `agent.created` came first and settled it to this agent already (`settleCreated`).
        if (bindings.some((entry) => entry.tokenSha256 === tokenSha256 && entry.state === "bound" && entry.agentId === agentId)) {
          outcome = "bound";
          return null;
        }
        const binding = bindings.find((entry) => entry.tokenSha256 === tokenSha256 && entry.state === "pending");
        if (binding === undefined) return null;
        // Never bound without the hook's word that the agent got the token URL.
        if (binding.attachedAt === null || isExpired(binding, now().getTime())) {
          return bindings.filter((entry) => entry !== binding);
        }
        outcome = "bound";
        return bindings.map((entry) => (entry === binding ? { ...entry, state: "bound" as const, agentId, boundAt: at } : entry));
      });
      return outcome;
    },
    discard(tokenSha256) {
      let outcome: "deleted" | "kept" | "none" = "none";
      quietly("remove a binding whose agent was not created", (bindings) => {
        // `agent.created` already settled it to the new agent (`settleCreated`): the agent exists.
        if (bindings.some((entry) => entry.tokenSha256 === tokenSha256 && entry.state === "bound")) {
          outcome = "kept";
          return null;
        }
        const binding = bindings.find((entry) => entry.tokenSha256 === tokenSha256 && entry.state === "pending");
        if (binding === undefined) return null;
        // The hook kept the token URL: Paseo may have created the agent after all.
        if (binding.attachedAt !== null) {
          outcome = "kept";
          return null;
        }
        outcome = "deleted";
        return bindings.filter((entry) => entry !== binding);
      });
      return outcome;
    },
    settleCreated(agent) {
      const own = list().find((binding) => binding.agentId === agent.agentId) ?? null;
      if (own !== null) return { binding: own, settledNow: false };
      const none = { binding: null, settledNow: false };
      if (agent.parentId === null) return none;
      const key = agent.role === "reviewer" ? agent.batchId : agent.role === "worker" ? agent.requestId : null;
      if (key === null) return none;
      // Set inside the update, which runs synchronously.
      let settled = null as AgentBinding | null;
      const at = now();
      quietly(`settle the binding of the new agent ${agent.agentId}`, (bindings) => {
        const candidate = bindings
          .filter(
            (binding) =>
              binding.state === "pending" &&
              binding.attachedAt !== null &&
              !isExpired(binding, at.getTime()) &&
              binding.role === agent.role &&
              binding.parentId === agent.parentId &&
              (agent.workspaceId === null || binding.workspaceId === agent.workspaceId) &&
              (agent.role === "reviewer"
                ? binding.batchId === key && (agent.requestId === null || binding.requestId === agent.requestId)
                : binding.requestId === key),
          )
          .sort((a, b) => timeOrZero(a.createdAt) - timeOrZero(b.createdAt))[0];
        if (candidate === undefined) return null;
        settled = { ...candidate, state: "bound" as const, agentId: agent.agentId, boundAt: at.toISOString() };
        return bindings.map((entry) => (entry === candidate ? settled! : entry));
      });
      return settled === null ? none : { binding: settled, settledNow: true };
    },
    callerOf(token, role) {
      if (!isBindingToken(token)) return null;
      const hash = tokenHashOf(token);
      const binding = list().find((entry) => entry.tokenSha256 === hash);
      if (binding === undefined || binding.role !== role || binding.state === "revoked") return null;
      if (binding.state === "bound" && binding.agentId === null) return null;
      return {
        agentId: binding.state === "bound" ? binding.agentId : null,
        role: binding.role,
        workspaceId: binding.workspaceId,
        requestId: binding.requestId,
        parentId: binding.parentId,
        batchId: binding.batchId,
      };
    },
    revokeAgent(agentId) {
      let revoked = 0;
      const at = now().toISOString();
      quietly(`revoke the binding of agent ${agentId}`, (bindings) => {
        const next = bindings.map((binding) => {
          if (binding.agentId !== agentId || binding.state !== "bound") return binding;
          revoked += 1;
          return { ...binding, state: "revoked" as const, revokedAt: at };
        });
        return revoked === 0 ? null : next;
      });
      return revoked;
    },
    sweep(listed, since) {
      let removed = 0;
      quietly("sweep the bindings of deleted agents", (bindings) => {
        const next = bindings.filter((binding) => {
          if (binding.agentId === null || listed.has(binding.agentId)) return true;
          // Bound while the list was being read: Paseo may not have shown it yet.
          if (timeOrZero(binding.boundAt ?? binding.createdAt) >= since.getTime()) return true;
          removed += 1;
          return false;
        });
        return removed === 0 ? null : next;
      });
      return removed;
    },
    bindingOfAgent: (agentId) => list().find((binding) => binding.agentId === agentId) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The shared guard of the tools that act (§16.5).
// ---------------------------------------------------------------------------

/**
 * The refusal every delivering or creating tool gives a caller whose binding
 * is still pending (`agentId: null`), or null when the call may go on. A
 * builder-only caller (`null`) and a bound one pass. One check, shared
 * (`tool-kit.ts` `actingTools`), so no tool can forget it; read-only tools do
 * not use it.
 */
export function pendingCallerRefusal(caller: ToolCaller | null): string | null {
  return caller !== null && caller.agentId === null ? PENDING_CALLER_MESSAGE : null;
}

// ---------------------------------------------------------------------------
// Creating an agent with a binding.
// ---------------------------------------------------------------------------

/** What a creation needs to be bound: the role, its base provider and the binding's facts. */
export interface BindingRequest extends BindingInput {
  /** The base provider of the new agent's alias (`claude`, `codex`, …), or null when unknown: no token then. */
  base: string | null;
}

/** An issued binding: its hash, and the MCP server entry carrying the token URL (never logged). */
export interface IssuedBinding {
  readonly tokenSha256: string;
  readonly mcpServer: { type: "http"; url: string; alwaysLoad: true };
}

/** Issues, settles and discards bindings for the creations the plugin makes itself. */
export interface AgentBinder {
  /** A pending binding and its token URL, or null: a base provider that cannot take tools, no endpoint, or a store that cannot be written. Never throws. */
  issue(request: BindingRequest): IssuedBinding | null;
  /** `agents.create` returned. Never throws. */
  settle(issued: IssuedBinding, agentId: string): "bound" | "unbound";
  /** `agents.create` threw: the store's outcome (see `BindingStore.discard`). Never throws. */
  discard(issued: IssuedBinding): "deleted" | "kept" | "none";
}

/** The binder that never binds: no endpoint, or a caller without one. */
export const NO_BINDER: AgentBinder = { issue: () => null, settle: () => "unbound", discard: () => "none" };

/** A token path of the agents' endpoint (`/mcp/<role>/<64 hex>`), wherever it appears in a text. */
const TOKEN_PATH = /\/mcp\/(worker|reviewer|manager|orchestrator)\/[0-9a-f]{64}/gi;

/**
 * `text` with every token path of the agents' endpoint cut to its role path
 * (`/mcp/<role>/…`), and `token` itself wherever it appears: what Paseo
 * echoes of a refused creation's config never carries a token on to an agent
 * or a log. Pure.
 */
export function withoutTokenPaths(text: string, token: string | null = null): string {
  const cut = text.replace(TOKEN_PATH, (_path, role: string) => `/mcp/${role}/…`);
  return token === null || token === "" ? cut : cut.split(token).join("…");
}

/** True when `error` came from a creation whose hook had already kept the token URL: Paseo may have created the agent (`createBound`). */
export function creationMayExist(error: unknown): boolean {
  return error instanceof Error && (error as Error & { mayExist?: unknown }).mayExist === true;
}

/**
 * Creates an agent through `create`, bound when `binder` issues a token: the
 * MCP servers `create` must put in the creation config (the token URL under
 * `AGENT_TOOLS_SERVER`), or undefined for an unbound creation. A
 * creation that throws discards the binding and rethrows, with every token
 * path cut from its message (`withoutTokenPaths`), marked `mayExist` when the
 * binding was attached and is kept (`creationMayExist`). Logs name the agent
 * id, never the token.
 */
export async function createBound<T extends { id: string }>(
  binder: AgentBinder,
  request: BindingRequest,
  create: (mcpServers: Record<string, IssuedBinding["mcpServer"]> | undefined) => Promise<T>,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<T> {
  let issued: IssuedBinding | null = null;
  try {
    issued = binder.issue(request);
  } catch {
    issued = null;
  }
  let created: T;
  try {
    created = await create(issued === null ? undefined : { [AGENT_TOOLS_SERVER]: issued.mcpServer });
  } catch (error) {
    const kept = issued !== null && binder.discard(issued) === "kept";
    const message = error instanceof Error ? error.message : String(error);
    const clean = withoutTokenPaths(message, issued === null ? null : issued.mcpServer.url.slice(-64));
    if (clean === message && !kept && error instanceof Error) throw error;
    const thrown = new Error(clean) as Error & { mayExist?: boolean };
    if (error instanceof Error) thrown.name = error.name;
    if (kept) thrown.mayExist = true;
    throw thrown;
  }
  if (issued !== null) {
    const outcome = binder.settle(issued, created.id);
    log(
      outcome === "bound"
        ? `[paseo-bm] ${request.role} ${created.id} is bound to its own tool path.`
        : `[paseo-bm] ${request.role} ${created.id} was created without its tool token attached; it is unbound and keeps the role path.`,
    );
  }
  return created;
}

// ---------------------------------------------------------------------------
// The lifecycle events.
// ---------------------------------------------------------------------------

/** The SDK slice the start-up sweep reads: every agent, archived ones included. */
export interface SweepPaseo {
  agents: {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{ entries: Array<{ agent: { id?: unknown } }>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }>;
  };
}

/**
 * The once-per-run sweep (§16.5): at the first Paseo handle, every binding
 * whose agent Paseo no longer lists — archived agents are still listed — is
 * deleted. A list that cannot be read sweeps nothing, and is tried again at
 * the next handle. Never throws.
 */
export function createBindingSweep(store: () => BindingStore | null, deps: { now?: () => Date; log?: (message: string) => void } = {}) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  let state: "idle" | "running" | "done" = "idle";
  return {
    async run(paseo: unknown): Promise<void> {
      if (state !== "idle") return;
      const bindings = store();
      const api = paseo as Partial<SweepPaseo> | null | undefined;
      if (bindings === null || typeof api?.agents?.list !== "function") return;
      state = "running";
      try {
        const since = now();
        const agents = await listAllAgents((options) => (api as SweepPaseo).agents.list(options), { includeArchived: true });
        const listed = new Set(agents.map((agent) => agent.id).filter((id): id is string => typeof id === "string" && id !== ""));
        const removed = bindings.sweep(listed, since);
        if (removed > 0) log(`[paseo-bm] removed ${removed} tool binding(s) of agents Paseo no longer lists.`);
        state = "done";
      } catch {
        state = "idle";
      }
    },
  };
}

export type BindingLifecycleHost = Partial<Pick<PluginServerContext, "on">>;

/** Registers `on("agent.archived")`, which revokes the archived agent's binding (§16.5), and returns its remover. */
export function registerBindingLifecycle(host: BindingLifecycleHost, store: () => BindingStore | null): () => void {
  if (typeof host.on !== "function") return () => {};
  const remove = host.on("agent.archived", (event) => {
    try {
      const id = (event as { agent?: { id?: unknown } } | null)?.agent?.id;
      if (typeof id === "string" && id !== "") store()?.revokeAgent(id);
    } catch {
      // A binding left bound costs nothing: the sweep and its archive both end it.
    }
  });
  return typeof remove === "function" ? remove : () => {};
}
