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
 * deleted otherwise (the agent is then unbound), when the creation throws, or
 * when it stays `pending` for more than ten minutes. `agent.archived` revokes
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
import { lstatSync } from "node:fs";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents } from "./agent-role";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { UI_DIR_NAME } from "./data-home";

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
  /**
   * True when the agent was issued its binding together with the tools that
   * create (`bm_create_worker`, `bm_create_reviewer`, ship point C): only then
   * do its children's request ids come from those tools alone (§16.4). A
   * binding issued before them (ship point B) leaves its children on the hand
   * path. Absent in older files: false.
   */
  creationTools: z.boolean().default(false),
  createdAt: z.string(),
  attachedAt: isoOrNull,
  boundAt: isoOrNull,
  revokedAt: isoOrNull,
});

export type AgentBinding = z.infer<typeof bindingSchema>;

/** Who calls a tool through a token path (§16.5); `agentId: null` while the binding is still pending. */
export interface ToolCaller {
  agentId: string | null;
  role: BoundRole;
  workspaceId: string;
  requestId: string | null;
  parentId: string | null;
  batchId: string | null;
  /**
   * True when the binding was issued with the creation tools (ship point C,
   * design §16.6): only then does the caller list and run them. Absent
   * otherwise.
   */
  creationTools?: boolean;
}

/** True when `caller` is bound (or pending) with the creation tools (design §16.6). */
export function hasCreationTools(caller: ToolCaller | null | undefined): boolean {
  return caller !== null && caller !== undefined && caller.creationTools === true;
}

/**
 * True when `agentId` has a live (bound) binding issued with the creation
 * tools: the plugin's tools create its children, so it is "bound" for §16.4
 * and §16.9. Pure over `bindings`.
 */
export function isCreationBound(agentId: string, bindings: readonly AgentBinding[]): boolean {
  return bindings.some((binding) => binding.agentId === agentId && binding.state === "bound" && binding.creationTools);
}

/** What a binding is issued for: everything but the agent, which does not exist yet. */
export interface BindingInput {
  role: BoundRole;
  workspaceId: string;
  requestId?: string | null;
  parentId?: string | null;
  batchId?: string | null;
  /** The agent gets the creation tools with this binding (§16.4); false until ship point C. */
  creationTools?: boolean;
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

const timeOf = (iso: string | null): number => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
};

/** True when `binding` is past its time at `now`: pending over ten minutes, revoked over seven days. */
export function isExpired(binding: AgentBinding, now: number): boolean {
  if (binding.state === "pending") return now - timeOf(binding.createdAt) > PENDING_TTL_MS;
  if (binding.state === "revoked") return now - timeOf(binding.revokedAt) > REVOKED_TTL_MS;
  return false;
}

/** The bindings kept at `now`: the expired ones out, then at most `MAX_BINDINGS`, the oldest revoked ones first to go. */
export function capBindings(bindings: readonly AgentBinding[], now: number): AgentBinding[] {
  const live = bindings.filter((binding) => !isExpired(binding, now));
  return capBy(live, MAX_BINDINGS, (binding) => (binding.state === "revoked" ? timeOf(binding.revokedAt) : Number.MAX_SAFE_INTEGER));
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
  /** `agents.create` threw: the binding is deleted. Never throws. */
  discard(tokenSha256: string): void;
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

/** Parsed files by path, kept while the file's identity (mtime, size, inode) does not change. */
const readCache = new Map<string, { key: string; bindings: AgentBinding[] }>();

function fileKeyOf(path: string): string | null {
  try {
    const stat = lstatSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** Drops the read cache; tests only. */
export function clearBindingCache(): void {
  readCache.clear();
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
  });

  const stored = (): AgentBinding[] => {
    const key = fileKeyOf(file.path);
    const cached = readCache.get(file.path);
    if (key !== null && cached !== undefined && cached.key === key) return cached.bindings;
    const bindings = file.read().bindings;
    if (key !== null) readCache.set(file.path, { key, bindings });
    return bindings;
  };

  const list = (): AgentBinding[] => {
    try {
      const at = now().getTime();
      return stored().filter((binding) => !isExpired(binding, at));
    } catch {
      return [];
    }
  };

  /** One read-modify-write; `change` returns null to write nothing. Throws on a write failure. */
  const update = (change: (bindings: AgentBinding[]) => AgentBinding[] | null): void => {
    readCache.delete(file.path);
    file.update((current) => {
      const next = change(current.bindings);
      return next === null ? null : { bindings: next };
    });
    readCache.delete(file.path);
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
        creationTools: input.creationTools ?? false,
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
      quietly("remove a binding whose agent was not created", (bindings) => {
        const next = bindings.filter((binding) => !(binding.tokenSha256 === tokenSha256 && binding.state === "pending"));
        return next.length === bindings.length ? null : next;
      });
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
        ...(binding.creationTools ? { creationTools: true } : {}),
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
          if (timeOf(binding.boundAt ?? binding.createdAt) >= since.getTime()) return true;
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
 * builder-only caller (`null`) and a bound one pass. One check, shared, so no
 * tool can forget it; read-only tools do not use it.
 */
export function pendingCallerRefusal(caller: ToolCaller | null): string | null {
  return caller !== null && caller.agentId === null ? PENDING_CALLER_MESSAGE : null;
}

/** A tool that acts, behind the shared guard: a pending caller is refused before `run` is reached. */
export function guardActingTool<A extends { ok: boolean; text: string }>(
  run: (input: unknown, caller: ToolCaller | null) => Promise<A>,
): (input: unknown, caller: ToolCaller | null) => Promise<A | { ok: false; text: string }> {
  return async (input, caller) => {
    const refusal = pendingCallerRefusal(caller);
    if (refusal !== null) return { ok: false, text: refusal };
    return run(input, caller);
  };
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
  /** `agents.create` threw. Never throws. */
  discard(issued: IssuedBinding): void;
}

/** The binder that never binds: no endpoint, or a caller without one. */
export const NO_BINDER: AgentBinder = { issue: () => null, settle: () => "unbound", discard: () => {} };

/**
 * Creates an agent through `create`, bound when `binder` issues a token: the
 * MCP servers `create` must put in the creation config (the token URL under
 * `AGENT_TOOLS_SERVER`), or undefined for an unbound creation. A
 * creation that throws discards the binding and rethrows. Logs name the agent
 * id, never the token.
 */
export async function createBound<T extends { id: string }>(
  binder: AgentBinder | null | undefined,
  request: BindingRequest,
  create: (mcpServers: Record<string, IssuedBinding["mcpServer"]> | undefined) => Promise<T>,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<T> {
  let issued: IssuedBinding | null = null;
  try {
    issued = binder?.issue(request) ?? null;
  } catch {
    issued = null;
  }
  let created: T;
  try {
    created = await create(issued === null ? undefined : { [AGENT_TOOLS_SERVER]: issued.mcpServer });
  } catch (error) {
    if (issued !== null) binder?.discard(issued);
    throw error;
  }
  if (issued !== null && binder !== null && binder !== undefined) {
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
