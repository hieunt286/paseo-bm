import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_TOOLS_SERVER,
  BINDINGS_FILE,
  MAX_BINDINGS,
  PENDING_CALLER_MESSAGE,
  PENDING_TTL_MS,
  REVOKED_TTL_MS,
  capBindings,
  clearBindingCache,
  createBindingStore,
  createBindingSweep,
  createBound,
  creationMayExist,
  pendingCallerRefusal,
  registerBindingLifecycle,
  tokenHashOf,
  type AgentBinding,
  type BindingStore,
  type ToolCaller,
  withoutTokenPaths,
} from "../plugin/server/agent-bindings";
import { BUILDER_SEND_LINES, binderOf, boundTokenOf, routeOfPath, startAgentTools, type AgentToolsEndpoint } from "../plugin/server/agent-tools";
import type { ServerTools } from "../plugin/server/decision-tools";
import { applyAgentTools, pendingBoundToken, type AgentCreateRequest } from "../plugin/server/role-hook";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * Per-agent tool bindings (design §16.5, ADR-027 decisions 3 and 9): the
 * store and its lifecycle, the endpoint's token paths, the creation hook that
 * keeps a bound URL, and the plugin's own bound creations. Temporary data
 * folders only; the endpoint is a real server on 127.0.0.1.
 */

const T0 = new Date("2026-10-03T10:00:00.000Z");
const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const endpoints: AgentToolsEndpoint[] = [];

/** A store whose clock the test moves. */
function storeAt(home: string, clock: { now: Date }, log: string[] = []): BindingStore {
  return createBindingStore(home, { now: () => clock.now, log: (line) => log.push(line) });
}

const later = (ms: number): Date => new Date(T0.getTime() + ms);

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  clearBindingCache();
  removeDataFolders();
});

describe("the binding store (design §16.5)", () => {
  it("writes a pending binding 0600 in ui/, keeping only the token's SHA-256", () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS, requestId: REQ, parentId: "mgr-1" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenSha256).toBe(tokenHashOf(token));
    expect(store.path).toBe(join(home, "ui", BINDINGS_FILE));
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "ui")).mode & 0o777).toBe(0o700);
    const text = readFileSync(store.path, "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      bindings: [
        {
          tokenSha256,
          role: "worker",
          state: "pending",
          agentId: null,
          workspaceId: WS,
          requestId: REQ,
          parentId: "mgr-1",
          batchId: null,
          createdAt: T0.toISOString(),
          attachedAt: null,
          boundAt: null,
          revokedAt: null,
        },
      ],
    });
  });

  it("binds only after the hook attached the token, and drops a binding the hook never attached", () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const store = storeAt(home, clock);
    const attached = store.issue({ role: "worker", workspaceId: WS });
    clock.now = later(1_000);
    expect(store.attach(attached.token, "reviewer")).toBe(false);
    expect(store.attach(attached.token, "worker")).toBe(true);
    clock.now = later(2_000);
    expect(store.settle(attached.tokenSha256, "agent-w1")).toBe("bound");
    expect(store.bindingOfAgent("agent-w1")).toMatchObject({ state: "bound", agentId: "agent-w1", attachedAt: later(1_000).toISOString(), boundAt: later(2_000).toISOString() });

    // Never bound without attachedAt: the creation came back unattached, so the agent is unbound.
    const unattached = store.issue({ role: "worker", workspaceId: WS });
    expect(store.settle(unattached.tokenSha256, "agent-w2")).toBe("unbound");
    expect(store.list().map((binding) => binding.tokenSha256)).toEqual([attached.tokenSha256]);
    expect(store.list().every((binding) => binding.state !== "bound" || binding.attachedAt !== null)).toBe(true);

    // A creation that threw: discarded.
    const thrown = store.issue({ role: "manager", workspaceId: WS });
    store.discard(thrown.tokenSha256);
    expect(store.list()).toHaveLength(1);
  });

  it("expires a pending binding after ten minutes: no longer pending, attachable or a caller, and dropped at the next write", () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const store = storeAt(home, clock);
    const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS });
    clock.now = later(PENDING_TTL_MS);
    expect(store.isPending(token, "worker")).toBe(true);
    clock.now = later(PENDING_TTL_MS + 1);
    expect(store.isPending(token, "worker")).toBe(false);
    expect(store.attach(token, "worker")).toBe(false);
    expect(store.callerOf(token, "worker")).toBeNull();
    store.issue({ role: "reviewer", workspaceId: WS });
    expect(readFileSync(store.path, "utf8")).not.toContain(tokenSha256);
  });

  it("revokes on agent.archived, and deletes a revoked binding seven days later", () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const store = storeAt(home, clock);
    const { token, tokenSha256 } = store.issue({ role: "manager", workspaceId: WS });
    store.attach(token, "manager");
    store.settle(tokenSha256, "mgr-1");
    expect(store.callerOf(token, "manager")).toMatchObject({ agentId: "mgr-1" });

    let archived: ((event: unknown) => void) | undefined;
    const remove = registerBindingLifecycle({ on: ((name: string, handler: (event: unknown) => void) => {
      if (name === "agent.archived") archived = handler;
      return () => {};
    }) as never }, () => store);
    expect(typeof remove).toBe("function");
    clock.now = later(60_000);
    archived!({ agent: { id: "mgr-1" }, archivedAt: later(60_000).toISOString() });
    expect(store.bindingOfAgent("mgr-1")).toMatchObject({ state: "revoked", revokedAt: later(60_000).toISOString() });
    expect(store.callerOf(token, "manager")).toBeNull();

    clock.now = later(60_000 + REVOKED_TTL_MS);
    expect(store.list()).toHaveLength(1);
    clock.now = later(60_000 + REVOKED_TTL_MS + 1);
    expect(store.list()).toEqual([]);
    store.issue({ role: "worker", workspaceId: WS });
    expect(readFileSync(store.path, "utf8")).not.toContain(tokenSha256);
  });

  it("sweeps once at start-up: a binding whose agent Paseo no longer lists goes, a listed one stays", async () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const store = storeAt(home, clock);
    for (const id of ["agent-listed", "agent-archived", "agent-deleted"]) {
      const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS });
      store.attach(token, "worker");
      store.settle(tokenSha256, id);
    }
    const pending = store.issue({ role: "worker", workspaceId: WS });
    clock.now = later(5_000);
    const filters: unknown[] = [];
    const paseo = {
      agents: {
        list: async (options: { filter: unknown }) => {
          filters.push(options.filter);
          return { entries: [{ agent: { id: "agent-listed" } }, { agent: { id: "agent-archived", archivedAt: T0.toISOString() } }], pageInfo: { nextCursor: null, hasMore: false } };
        },
      },
    };
    const logs: string[] = [];
    const sweep = createBindingSweep(() => store, { now: () => clock.now, log: (line) => logs.push(line) });
    await sweep.run(paseo);
    await sweep.run(paseo);
    expect(filters).toEqual([{ includeArchived: true }]);
    expect(store.list().map((binding) => binding.agentId)).toEqual(["agent-listed", "agent-archived", null]);
    expect(store.isPending(pending.token, "worker")).toBe(true);
    expect(logs).toEqual(["[paseo-bm] removed 1 tool binding(s) of agents Paseo no longer lists."]);
  });

  it("keeps a binding bound while the list was read, and sweeps nothing when the list cannot be read", async () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const { token, tokenSha256 } = store.issue({ role: "worker", workspaceId: WS });
    store.attach(token, "worker");
    store.settle(tokenSha256, "agent-new");
    // The sweep started before this agent was bound: Paseo may not show it yet.
    expect(store.sweep(new Set(), new Date(T0.getTime() - 1))).toBe(0);
    const failing = createBindingSweep(() => store, { now: () => later(1) });
    await failing.run({ agents: { list: async () => Promise.reject(new Error("daemon busy")) } });
    expect(store.list()).toHaveLength(1);
  });

  it("holds at most 5,000 bindings, the oldest revoked ones going first", () => {
    const binding = (n: number, state: AgentBinding["state"], revokedAt: string | null = null): AgentBinding => ({
      tokenSha256: n.toString(16).padStart(64, "0"),
      role: "worker",
      state,
      agentId: `agent-${n}`,
      workspaceId: WS,
      requestId: null,
      parentId: null,
      batchId: null,
      createdAt: T0.toISOString(),
      attachedAt: T0.toISOString(),
      boundAt: T0.toISOString(),
      revokedAt,
    });
    const many = Array.from({ length: MAX_BINDINGS - 2 }, (_, n) => binding(n + 10, "bound"));
    const revokedNew = binding(2, "revoked", later(2_000).toISOString());
    const revokedOld = binding(1, "revoked", later(1_000).toISOString());
    const capped = capBindings([...many, revokedNew, revokedOld, binding(3, "bound")], later(3_000).getTime());
    expect(capped).toHaveLength(MAX_BINDINGS);
    expect(capped.map((entry) => entry.agentId)).not.toContain("agent-1");
    expect(capped.map((entry) => entry.agentId)).toContain("agent-2");

    // Through the store: a full file and one more binding.
    const home = dataFolder();
    mkdirSync(join(home, "ui"), { mode: 0o700 });
    writeFileSync(join(home, "ui", BINDINGS_FILE), JSON.stringify({ schemaVersion: 1, bindings: [revokedOld, revokedNew, ...many] }), { mode: 0o600 });
    const store = storeAt(home, { now: later(3_000) });
    store.issue({ role: "worker", workspaceId: WS });
    const stored = JSON.parse(readFileSync(store.path, "utf8")).bindings as AgentBinding[];
    expect(stored).toHaveLength(MAX_BINDINGS);
    expect(stored.map((entry) => entry.agentId)).not.toContain("agent-1");
    expect(stored.map((entry) => entry.agentId)).toContain("agent-2");
  });

  it("keeps its bindings across a plugin reload: a new store and a new endpoint on the same folder know the token", async () => {
    const home = dataFolder();
    const first = storeAt(home, { now: T0 });
    const { token, tokenSha256 } = first.issue({ role: "worker", workspaceId: WS, requestId: REQ });
    first.attach(token, "worker");
    first.settle(tokenSha256, "agent-w1");
    clearBindingCache();
    expect(storeAt(home, { now: later(1) }).callerOf(token, "worker")).toEqual({ agentId: "agent-w1", role: "worker", workspaceId: WS, requestId: REQ, parentId: null, batchId: null });

    const { endpoint } = await start(home);
    const whoami = await call(boundUrl(endpoint, "worker", token), "bm_stub_whoami");
    expect(JSON.parse(whoami.body.result.content[0].text)).toMatchObject({ agentId: "agent-w1" });
  });

  it("a file a newer paseo-bm wrote reads as empty and is never written", () => {
    const home = dataFolder();
    mkdirSync(join(home, "ui"), { mode: 0o700 });
    const body = JSON.stringify({ schemaVersion: 2, bindings: [] });
    writeFileSync(join(home, "ui", BINDINGS_FILE), body, { mode: 0o600 });
    const store = storeAt(home, { now: T0 });
    expect(store.list()).toEqual([]);
    expect(() => store.issue({ role: "worker", workspaceId: WS })).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// The endpoint's token paths.
// ---------------------------------------------------------------------------

/** Stub server-run tools: one that delivers, one that creates (both behind the shared guard), one that says who called. */
function stubTools(ran: string[]): ServerTools {
  const acting = (name: string) => async (_input: unknown, caller: ToolCaller | null) => {
    const refusal = pendingCallerRefusal(caller);
    if (refusal !== null) return { ok: false, text: refusal };
    ran.push(name);
    return { ok: true, text: `${name} done` };
  };
  const tools: Record<string, (input: unknown, caller: ToolCaller | null) => Promise<{ ok: boolean; text: string }>> = {
    bm_stub_deliver: acting("bm_stub_deliver"),
    bm_stub_create: acting("bm_stub_create"),
    bm_stub_whoami: async (_input, caller) => ({ ok: true, text: JSON.stringify(caller) }),
  };
  return { faces: [], has: (name) => name in tools, call: (name, input, caller) => tools[name]!(input, caller ?? null) };
}

async function start(home: string, ran: string[] = []) {
  const logs: string[] = [];
  const endpoint = startAgentTools({ statePath: join(home, "ui", "agent-tools.json"), log: (line) => logs.push(line), worker: stubTools(ran), manager: stubTools(ran) });
  endpoints.push(endpoint);
  await endpoint.ready;
  return { endpoint, logs };
}

const boundUrl = (endpoint: AgentToolsEndpoint, role: "worker" | "manager" | "reviewer", token: string): string => `${endpoint.urlFor(role)!}/${token}`;

const responses: string[] = [];
async function call(url: string, name: string, args: unknown = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const text = await response.text();
  responses.push(text);
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

/** Binds a token of `role` for `agentId` in `store`, the way a creation does. */
function bindIn(store: BindingStore, role: "worker" | "manager" | "reviewer", agentId: string): string {
  const { token, tokenSha256 } = store.issue({ role, workspaceId: WS, requestId: REQ, parentId: "mgr-1", batchId: role === "reviewer" ? "b1" : null });
  store.attach(token, role);
  store.settle(tokenSha256, agentId);
  return token;
}

describe("the endpoint's token paths (design §16.5)", () => {
  it("routes /mcp/<role>/<64 hex> to the role with its token, and nothing else", () => {
    const token = "a".repeat(64);
    expect(routeOfPath(`/mcp/worker/${token}`, "s")).toEqual({ role: "worker", token });
    expect(routeOfPath(`/mcp/manager/${token}/`, "s")).toEqual({ role: "manager", token });
    expect(routeOfPath("/mcp/reviewer", "s")).toEqual({ role: "reviewer", token: null });
    expect(routeOfPath(`/mcp/worker/${token.slice(1)}`, "s")).toBeNull();
    expect(routeOfPath(`/mcp/worker/${token.toUpperCase()}`, "s")).toBeNull();
    expect(routeOfPath(`/mcp/orchestrator/${token}`, "s")).toBeNull();
  });

  it("a bound token: the tools receive its caller", async () => {
    const home = dataFolder();
    const { endpoint, logs } = await start(home);
    const token = bindIn(endpoint.bindings!, "worker", "agent-w1");
    const answered = await call(boundUrl(endpoint, "worker", token), "bm_stub_whoami");
    expect(JSON.parse(answered.body.result.content[0].text)).toEqual({ agentId: "agent-w1", role: "worker", workspaceId: WS, requestId: REQ, parentId: "mgr-1", batchId: null });
    // The log line names the bound agent; a server tool answered it.
    expect(logs).toEqual(["[paseo-bm] bm_stub_whoami answered for a worker (agent agent-w1)"]);
  });

  it("a pending token: every tool that delivers or creates refuses with 'try again in a moment', and runs nothing", async () => {
    const home = dataFolder();
    const ran: string[] = [];
    const { endpoint } = await start(home, ran);
    const { token } = endpoint.bindings!.issue({ role: "worker", workspaceId: WS });
    for (const name of ["bm_stub_deliver", "bm_stub_create"]) {
      const refused = await call(boundUrl(endpoint, "worker", token), name);
      expect(refused.body.result).toEqual({ content: [{ type: "text", text: PENDING_CALLER_MESSAGE }], isError: true });
    }
    expect(ran).toEqual([]);
    expect(PENDING_CALLER_MESSAGE).toMatch(/try again in a moment/);
    const whoami = await call(boundUrl(endpoint, "worker", token), "bm_stub_whoami");
    expect(JSON.parse(whoami.body.result.content[0].text)).toMatchObject({ agentId: null, role: "worker" });
    // A bound or builder-only caller passes the same guard.
    expect(pendingCallerRefusal(null)).toBeNull();
    expect(pendingCallerRefusal({ agentId: "a", role: "worker", workspaceId: WS, requestId: null, parentId: null, batchId: null })).toBeNull();
  });

  it("an unknown, revoked or other role's token: no caller and the builder-only tools — never a 404", async () => {
    const home = dataFolder();
    const ran: string[] = [];
    const { endpoint } = await start(home, ran);
    const store = endpoint.bindings!;
    const revoked = bindIn(store, "worker", "agent-gone");
    store.revokeAgent("agent-gone");
    const workerToken = bindIn(store, "worker", "agent-w1");
    const cases: Array<[string, string]> = [
      ["unknown", boundUrl(endpoint, "worker", "f".repeat(64))],
      ["revoked", boundUrl(endpoint, "worker", revoked)],
      ["another role's", boundUrl(endpoint, "manager", workerToken)],
    ];
    for (const [what, url] of cases) {
      const whoami = await call(url, "bm_stub_whoami");
      expect(whoami.status, what).toBe(200);
      expect(whoami.body.result.content[0].text, what).toBe("null");
      // An acting tool runs for a builder-only caller: in step 2 the guard only stops a pending one.
      expect((await call(url, "bm_stub_deliver")).body.result.isError, what).toBeUndefined();
    }
    const report = await call(boundUrl(endpoint, "worker", "f".repeat(64)), "bm_report", { requestId: REQ, phase: "received", tier: { level: "Small" }, buildAndTests: "not run" });
    expect(report.status).toBe(200);
    expect(report.body.result.content[0].text).toMatch(/^BM-REPORT\n/);
    // A lost binding file costs nothing either.
    rmSync(store.path);
    clearBindingCache();
    expect((await call(boundUrl(endpoint, "worker", workerToken), "bm_stub_whoami")).body.result.content[0].text).toBe("null");
  });

  it("ends each builder-only answer with its send line", async () => {
    const home = dataFolder();
    const { endpoint } = await start(home);
    const cases: Array<["worker" | "reviewer" | "manager", string, unknown]> = [
      ["worker", "bm_report", { requestId: REQ, phase: "received", tier: { level: "Small" }, buildAndTests: "not run" }],
      ["reviewer", "bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "the diff", notChecked: "nothing", findings: [] }],
      ["manager", "bm_answers", { requestId: REQ, answers: [{ id: "Q1", option: "a", optionText: "Keep it." }] }],
    ];
    for (const [role, name, args] of cases) {
      const answered = await call(endpoint.urlFor(role)!, name, args);
      expect(answered.body.result.isError, name).toBeUndefined();
      const content = answered.body.result.content as Array<{ text: string }>;
      expect(content[0]!.text, name).toMatch(/^BM-/);
      expect(content.at(-1)!.text, name).toBe(BUILDER_SEND_LINES[name]);
    }
    expect(BUILDER_SEND_LINES).toEqual({
      bm_report: "Nothing is delivered yet: write this block in your reply, exactly as it is; the plugin delivers it to the agent that created you. Never send it yourself.",
      bm_review: "Make this block your final answer, exactly as it is.",
      bm_answers: "Put this block in your reply to the owner; the plugin delivers it. Send the Worker nothing.",
    });
  });
});

// ---------------------------------------------------------------------------
// The plugin's own creations, and the hook that keeps a bound URL.
// ---------------------------------------------------------------------------

const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;

describe("binding a creation (design §16.5)", () => {
  it("issues no token for a base provider outside TOOL_PROVIDERS, nor without an endpoint", () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const binder = binderOf(ROLE_URL, store, () => {});
    for (const base of ["pi", "copilot", "omp", null]) expect(binder.issue({ role: "worker", base, workspaceId: WS })).toBeNull();
    expect(binderOf(() => null, store, () => {}).issue({ role: "worker", base: "claude", workspaceId: WS })).toBeNull();
    expect(store.list()).toEqual([]);
    for (const base of ["claude", "codex", "opencode"]) {
      const issued = binderOf(ROLE_URL, store, () => {}).issue({ role: "manager", base, workspaceId: WS });
      expect(issued?.mcpServer).toEqual({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4567\/mcp\/manager\/[0-9a-f]{64}$/), alwaysLoad: true });
    }
    expect(store.list()).toHaveLength(3);
  });

  it("the hook keeps a bound URL and records attachedAt; it rewrites a foreign one and removes the entry on a provider without tools", () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const tools = { urlFor: ROLE_URL, bindings: store };
    const issued = binderOf(ROLE_URL, store, () => {}).issue({ role: "worker", base: "codex", workspaceId: WS })!;
    const request = (provider: string, url: string, extra: Record<string, unknown> = {}) =>
      ({ config: { provider, cwd: "/repo", mcpServers: { other: { type: "http", url: "http://x/mcp" }, [AGENT_TOOLS_SERVER]: { type: "http", url } }, ...extra } }) as unknown as AgentCreateRequest;

    expect(pendingBoundToken(request("bm-worker-fallback-1/gpt", issued.mcpServer.url), tools)).not.toBeNull();
    const kept = applyAgentTools(request("bm-worker-fallback-1/gpt", issued.mcpServer.url), tools, "codex");
    expect(kept?.config.mcpServers?.[AGENT_TOOLS_SERVER]).toEqual({ type: "http", url: issued.mcpServer.url, alwaysLoad: true });
    expect(kept?.config.mcpServers?.["other"]).toEqual({ type: "http", url: "http://x/mcp" });
    // Bound: its delivering and creating tools are pre-approved too (design §16.6).
    expect(kept?.config.toolPolicy?.preapproved).toEqual(["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_reply"].map((tool) => ({ kind: "mcp", server: AGENT_TOOLS_SERVER, tool })));
    expect(store.list()[0]).toMatchObject({ state: "pending", attachedAt: T0.toISOString() });

    // Foreign: another port, an unknown token, or another role's binding — rewritten to the role path.
    const token = issued.mcpServer.url.slice(-64);
    const foreign = [
      ["another port", "bm-worker/gpt", `http://127.0.0.1:9999/mcp/worker/${token}`],
      ["an unknown token", "bm-worker/gpt", `${ROLE_URL("worker")}/${"e".repeat(64)}`],
      ["another role's", "bm-reviewer/gpt", `${ROLE_URL("reviewer")}/${token}`],
      ["no token", "bm-worker/gpt", "http://evil.example/mcp"],
    ] as const;
    for (const [what, provider, url] of foreign) {
      const out = applyAgentTools(request(provider, url), tools, "claude");
      expect((out?.config.mcpServers?.[AGENT_TOOLS_SERVER] as { url: string }).url, what).toBe(ROLE_URL(provider.startsWith("bm-reviewer") ? "reviewer" : "worker"));
    }
    expect(boundTokenOf({ mcpServers: { [AGENT_TOOLS_SERVER]: { url: `${ROLE_URL("worker")}/${token}` } } }, "worker", ROLE_URL("worker"))).toBe(token);

    // A provider without pre-approvable tools: the paseo-bm entry goes, every other server stays, no toolPolicy.
    for (const base of ["pi", null]) {
      const stripped = applyAgentTools(request("bm-worker/x", issued.mcpServer.url), tools, base);
      expect(stripped?.config.mcpServers).toEqual({ other: { type: "http", url: "http://x/mcp" } });
      expect(stripped?.config.toolPolicy).toBeUndefined();
    }
  });

  it("createBound: bound when the hook attached, unbound when it did not, and discarded when the creation throws", async () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const logs: string[] = [];
    const binder = binderOf(ROLE_URL, store, (line) => logs.push(line));
    const seen: unknown[] = [];
    // A creation whose hook ran: the token URL is attached.
    const hooked = await createBound(binder, { role: "worker", base: "claude", workspaceId: WS, requestId: REQ }, async (mcpServers) => {
      seen.push(mcpServers);
      const request = { config: { provider: "bm-worker/x", cwd: "/repo", mcpServers } } as unknown as AgentCreateRequest;
      applyAgentTools(request, { urlFor: ROLE_URL, bindings: store }, "claude");
      return { id: "agent-hooked" };
    }, (line) => logs.push(line));
    expect(hooked.id).toBe("agent-hooked");
    expect(store.bindingOfAgent("agent-hooked")).toMatchObject({ state: "bound", requestId: REQ });

    // The hook never kept the URL (it timed out): no binding, an unbound agent.
    await createBound(binder, { role: "worker", base: "claude", workspaceId: WS }, async () => ({ id: "agent-plain" }), (line) => logs.push(line));
    expect(store.bindingOfAgent("agent-plain")).toBeNull();

    // Paseo refused it: the binding goes, the error stays the caller's.
    await expect(createBound(binder, { role: "manager", base: "codex", workspaceId: WS }, async () => Promise.reject(new Error("refused")), (line) => logs.push(line))).rejects.toThrow("refused");
    expect(store.list().map((binding) => binding.agentId)).toEqual(["agent-hooked"]);

    // No token on Pi: created exactly as before, with no MCP servers.
    await createBound(binder, { role: "worker", base: "pi", workspaceId: WS }, async (mcpServers) => (seen.push(mcpServers), { id: "agent-pi" }), (line) => logs.push(line));
    expect(seen.at(-1)).toBeUndefined();

    expect(logs).toEqual([
      "[paseo-bm] worker agent-hooked is bound to its own tool path.",
      "[paseo-bm] worker agent-plain was created without its tool token attached; it is unbound and keeps the role path.",
    ]);
    // No token anywhere in what was logged.
    const tokens = (seen.filter(Boolean) as Array<Record<string, { url: string }>>).map((servers) => servers[AGENT_TOOLS_SERVER]!.url.slice(-64));
    expect(tokens).toHaveLength(1);
    for (const token of tokens) expect(logs.join("\n")).not.toContain(token);
  });
});

describe("a token is never logged or returned", () => {
  it("scans every log line and every MCP answer of a session that used bound, pending and unknown tokens", async () => {
    const home = dataFolder();
    responses.splice(0);
    const { endpoint, logs } = await start(home);
    const bound = bindIn(endpoint.bindings!, "worker", "agent-w1");
    const { token: pending } = endpoint.bindings!.issue({ role: "manager", workspaceId: WS });
    const unknown = "c".repeat(64);
    await call(boundUrl(endpoint, "worker", bound), "bm_stub_whoami");
    await call(boundUrl(endpoint, "worker", bound), "bm_report", { requestId: REQ, phase: "received", tier: { level: "Small" }, buildAndTests: "not run" });
    await call(boundUrl(endpoint, "manager", pending), "bm_stub_deliver");
    await call(boundUrl(endpoint, "worker", unknown), "bm_stub_whoami");
    await call(boundUrl(endpoint, "worker", bound), "nope");
    expect(logs.length).toBeGreaterThan(0);
    const said = [...logs, ...responses].join("\n");
    for (const token of [bound, pending]) expect(said).not.toContain(token);
    expect(said).toContain("agent agent-w1");
    // On disk, only hashes.
    const file = readFileSync(endpoint.bindings!.path, "utf8");
    for (const token of [bound, pending]) expect(file).not.toContain(token);
  });
});

describe("a creation Paseo did not settle (review of ADR-027's creation paths)", () => {
  it("discard keeps an attached binding (the agent may exist) and deletes an unattached one", () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const attached = store.issue({ role: "reviewer", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b1" });
    store.attach(attached.token, "reviewer");
    const plain = store.issue({ role: "reviewer", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b2" });
    expect(store.discard(attached.tokenSha256)).toBe("kept");
    expect(store.discard(plain.tokenSha256)).toBe("deleted");
    expect(store.discard("f".repeat(64))).toBe("none");
    expect(store.list().map((binding) => [binding.batchId, binding.state])).toEqual([["b1", "pending"]]);
  });

  it("settleCreated binds the one attached pending binding of that role, parent, workspace and batch or request; settle afterwards agrees", () => {
    const home = dataFolder();
    const clock = { now: T0 };
    const store = storeAt(home, clock);
    const reviewer = store.issue({ role: "reviewer", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b1" });
    store.attach(reviewer.token, "reviewer");
    const worker = store.issue({ role: "worker", workspaceId: WS, requestId: REQ, parentId: "mgr-1" });
    store.attach(worker.token, "worker");
    const unattached = store.issue({ role: "reviewer", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b2" });
    const created = (over: Partial<Parameters<BindingStore["settleCreated"]>[0]>) => ({ agentId: "rev-1", role: "reviewer" as const, parentId: "wrk-1", workspaceId: WS, requestId: REQ, batchId: "b1", ...over });

    // Another parent, workspace, batch or request, an unattached binding, or no parent: nothing.
    const none = { binding: null, settledNow: false };
    expect(store.settleCreated(created({ parentId: "wrk-2" }))).toEqual(none);
    expect(store.settleCreated(created({ workspaceId: "wks_other" }))).toEqual(none);
    expect(store.settleCreated(created({ batchId: "b9" }))).toEqual(none);
    expect(store.settleCreated(created({ requestId: "req-20261003T110000Z" }))).toEqual(none);
    expect(store.settleCreated(created({ batchId: "b2" }))).toEqual(none);
    expect(store.settleCreated(created({ parentId: null }))).toEqual(none);

    clock.now = later(5_000);
    expect(store.settleCreated(created({}))).toMatchObject({ binding: { tokenSha256: reviewer.tokenSha256, state: "bound", agentId: "rev-1", boundAt: later(5_000).toISOString() }, settledNow: true });
    // Seen again: its own binding, unchanged.
    expect(store.settleCreated(created({}))).toMatchObject({ binding: { agentId: "rev-1", boundAt: later(5_000).toISOString() }, settledNow: false });
    // agents.create returned after all: the binding is bound to that agent, and discard keeps it.
    expect(store.settle(reviewer.tokenSha256, "rev-1")).toBe("bound");
    expect(store.discard(reviewer.tokenSha256)).toBe("kept");

    // A Worker by its request.
    expect(store.settleCreated({ agentId: "wrk-9", role: "worker", parentId: "mgr-1", workspaceId: WS, requestId: REQ, batchId: null })).toMatchObject({ binding: { tokenSha256: worker.tokenSha256, agentId: "wrk-9" }, settledNow: true });
    expect(store.list().find((binding) => binding.tokenSha256 === unattached.tokenSha256)?.state).toBe("pending");

    // Past its ten minutes, a pending binding settles nothing.
    const late = store.issue({ role: "reviewer", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b3" });
    store.attach(late.token, "reviewer");
    clock.now = later(5_000 + PENDING_TTL_MS + 1);
    expect(store.settleCreated(created({ agentId: "rev-3", batchId: "b3" }))).toEqual({ binding: null, settledNow: false });
  });

  it("withoutTokenPaths cuts every token path, and the token itself, from a text", () => {
    const token = "ab".repeat(32);
    const text = `MCP server paseo-bm at http://127.0.0.1:4567/mcp/reviewer/${token} refused; also /mcp/worker/${"c".repeat(64)} and ${token}`;
    const cut = withoutTokenPaths(text, token);
    expect(cut).toBe("MCP server paseo-bm at http://127.0.0.1:4567/mcp/reviewer/… refused; also /mcp/worker/… and …");
    expect(withoutTokenPaths("no path here")).toBe("no path here");
  });

  it("createBound: Paseo's error loses every token path, and is marked mayExist when the hook had kept the token", async () => {
    const home = dataFolder();
    const store = storeAt(home, { now: T0 });
    const binder = binderOf(ROLE_URL, store, () => {});
    const urls: string[] = [];
    // Refused before the hook: the binding goes, the error is plain but loses the URL it echoed.
    const before = await createBound(binder, { role: "worker", base: "claude", workspaceId: WS, requestId: REQ }, async (mcpServers) => {
      urls.push(mcpServers![AGENT_TOOLS_SERVER]!.url);
      throw new Error(`cannot start MCP server ${mcpServers![AGENT_TOOLS_SERVER]!.url}`);
    }).catch((error: unknown) => error as Error);
    expect(before.message).toBe("cannot start MCP server http://127.0.0.1:4567/mcp/worker/…");
    expect(creationMayExist(before)).toBe(false);
    expect(store.list()).toEqual([]);

    // Refused after the hook kept the token: the binding stays pending for agent.created, the error says so.
    const after = await createBound(binder, { role: "reviewer", base: "codex", workspaceId: WS, requestId: REQ, parentId: "wrk-1", batchId: "b1" }, async (mcpServers) => {
      urls.push(mcpServers![AGENT_TOOLS_SERVER]!.url);
      applyAgentTools({ config: { provider: "bm-reviewer/x", cwd: "/repo", mcpServers } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "codex");
      throw new Error("socket hang up");
    }).catch((error: unknown) => error as Error);
    expect(after.message).toBe("socket hang up");
    expect(creationMayExist(after)).toBe(true);
    expect(store.list()).toMatchObject([{ role: "reviewer", state: "pending", batchId: "b1" }]);
    for (const url of urls) {
      expect(before.message).not.toContain(url.slice(-64));
      expect(after.message).not.toContain(url.slice(-64));
    }
  });
});
