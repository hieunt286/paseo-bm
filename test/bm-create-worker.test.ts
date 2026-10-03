import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TOOLS_SERVER,
  NO_BINDER,
  PENDING_CALLER_MESSAGE,
  clearBindingCache,
  createBindingStore,
  liveBindingOf,
  type BindingStore,
  type ToolCaller,
} from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import {
  NOT_BOUND_MESSAGE,
  NO_PASEO_MESSAGE,
  NO_WORKER_PROFILE_MESSAGE,
  SCOPE_LINE,
  WORKER_TITLE,
  createWorkerCreationTools,
  workerBriefOf,
} from "../plugin/server/create-worker";
import { AGENT_TOOLS_OFF_SWITCH_MESSAGE, AGENT_TOOLS_OFF_TOOL_MESSAGE } from "../plugin/server/manager";
import { REQUEST_ID_PATTERN, REQUESTS_DIR_NAME, clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { boundToolFacesFor } from "../plugin/shared/bm-tools";
import { originOf } from "../plugin/shared/message-origin";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * `bm_create_worker` for a bound Manager (design §16.6; ADR-027 decisions 2
 * and 7): the Worker it creates — labels, mode, folder, parent, binding and
 * its `BM-BRIEF` first prompt — the request it registers under the caller,
 * and each refusal of §16.6, each creating nothing. Temporary data folders and
 * the one fake daemon only.
 */

const WS = "wks_1";
const MANAGER = "agent-manager";
const FOLDER = "/work/invoice-app";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const roots: string[] = [];

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  forgetModes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-create-worker-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

/** The Manager a token path names once its binding is bound. */
const BOUND_MANAGER: ToolCaller = { agentId: MANAGER, role: "manager", workspaceId: WS, requestId: null, parentId: null, batchId: null };

interface DaemonOptions {
  base?: string;
  toolsOff?: boolean;
  profile?: boolean;
  refuse?: string;
  /** Paseo refuses, echoing the MCP server URL of the creation config (its token path included). */
  refuseEchoingUrl?: boolean;
  /** The `agent.create` hook's part: keeps the token URL (`applyAgentTools`), as the real hook does. */
  store?: BindingStore;
}

function daemon(options: DaemonOptions = {}) {
  const base = options.base ?? "claude";
  return fakePaseo({
    agents: [{ id: MANAGER, provider: "bm-manager/claude-opus-5", status: "running", workspaceId: WS, cwd: FOLDER, labels: { "bm.role": "manager" } }],
    workspaces: [{ id: WS, directory: FOLDER }],
    config: {
      agentProfiles: options.profile === false ? [{ id: "bm-manager", provider: "bm-manager" }] : [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }],
      providers: { "bm-worker": { extends: base }, "bm-manager": { extends: "claude" } },
      mcp: { injectIntoAgents: options.toolsOff !== true },
    },
    providers: {
      modes: {
        "bm-worker": [
          { id: "default", colorTier: "safe" },
          { id: "acceptEdits", colorTier: "moderate" },
          { id: "bypassPermissions", colorTier: "dangerous" },
        ],
      },
    },
    created: (request: FakeCreateRequest) => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      if (options.refuseEchoingUrl === true) {
        const servers = request.config["mcpServers"] as Record<string, { url: string }> | undefined;
        throw new Error(`MCP server ${AGENT_TOOLS_SERVER} (${servers?.[AGENT_TOOLS_SERVER]?.url ?? "none"}) failed to start`);
      }
      if (options.store !== undefined) {
        applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: options.store }, base);
      }
      return {};
    },
  });
}

function toolsOf(home: string, fake: ReturnType<typeof daemon> | null, store: BindingStore | null, logs: string[] = []) {
  return createWorkerCreationTools({
    binder: () => (store === null ? NO_BINDER : binderOf(ROLE_URL, store, (line) => logs.push(line))),
    paseo: () => fake?.paseo ?? null,
    home: () => home,
    log: (line) => logs.push(line),
  });
}

const INPUT = {
  request: "Fix the invoice date format.\nUse the owner's locale.",
  size: "Medium",
  context: [
    { fact: "The owner wants dd/mm/yyyy everywhere.", source: "owner message, 2026-10-03" },
    { fact: "Worker agent-w2 changes src/pdf.ts\nfor request req-20261002T080000Z.", source: "list_agents" },
  ],
};

describe("bm_create_worker creates the Worker of a new request (design §16.6)", () => {
  it("labels, mode, folder, parent, a bound token, and a BM-BRIEF first prompt; the request registered under the caller", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    const logs: string[] = [];
    const answer = await toolsOf(home, fake, store, logs).call("bm_create_worker", INPUT, BOUND_MANAGER);

    expect(answer.ok).toBe(true);
    const { workerId, requestId } = JSON.parse(answer.text) as { workerId: string; requestId: string };
    expect(requestId).toMatch(REQUEST_ID_PATTERN);
    expect(workerId).toBe("created-1");
    expect(fake.creates).toHaveLength(1);
    const { options } = fake.creates[0]!;
    expect(options).toMatchObject({
      config: { provider: "bm-worker/claude-opus-5", modeId: "bypassPermissions" },
      cwd: FOLDER,
      parent: MANAGER,
      title: WORKER_TITLE,
      labels: { "bm.role": "worker", "bm.requestId": requestId, "bm.version": PLUGIN_VERSION },
    });
    expect(Object.keys(options.labels!).sort()).toEqual(["bm.requestId", "bm.role", "bm.version"]);
    const url = (options.config["mcpServers"] as Record<string, { url: string }>)[AGENT_TOOLS_SERVER]!.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:4567\/mcp\/worker\/[0-9a-f]{64}$/);

    // The prompt: the BM-BRIEF line first, classified as the plugin's prompt, never the owner's words.
    const prompt = options.prompt!;
    expect(prompt.split("\n")[0]).toBe(`BM-BRIEF worker requestId: ${requestId}`);
    expect(originOf({ text: prompt, clientMessageId: "m-1" })).toBe("plugin-prompt");
    expect(prompt).toBe(
      [
        `BM-BRIEF worker requestId: ${requestId}`,
        "The owner's request, verbatim:",
        "> Fix the invoice date format.",
        "> Use the owner's locale.",
        "",
        `requestId: ${requestId}`,
        `repository: ${FOLDER} (beads in ${FOLDER}/.beads/)`,
        SCOPE_LINE,
        `managerAgentId: ${MANAGER}`,
        "Context:",
        "- The owner wants dd/mm/yyyy everywhere. (source: owner message, 2026-10-03)",
        "- Worker agent-w2 changes src/pdf.ts for request req-20261002T080000Z. (source: list_agents)",
      ].join("\n"),
    );
    expect(SCOPE_LINE).toBe("Do only what the request asks. Anything extra is a suggestion for the owner, not work.");

    // The registry names the caller as the request's Manager, the Worker its first.
    expect(createRequestRegistry(home).get(WS, requestId)).toMatchObject({ source: "tool", managerId: MANAGER, workerIds: [workerId] });
    // Bound: its children's ids will come from its tools.
    expect(store.bindingOfAgent(workerId)).toMatchObject({ role: "worker", state: "bound", workspaceId: WS, requestId, parentId: MANAGER });
    expect(liveBindingOf(store.list(), workerId, "worker")).not.toBeNull();
    // No token in the answer or a log line.
    const token = url.slice(-64);
    expect([answer.text, ...logs].join("\n")).not.toContain(token);
    expect(logs).toEqual([`[paseo-bm] worker ${workerId} is bound to its own tool path.`]);
  });

  it("every call is a new request: a second call gets its own id; a size passed by an agent on older instructions is ignored (ADR-027 amended)", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    const tools = toolsOf(home, fake, store);
    const first = JSON.parse((await tools.call("bm_create_worker", INPUT, BOUND_MANAGER)).text) as { requestId: string };
    const second = await tools.call("bm_create_worker", { request: "Add a CSV export.", size: null, context: [] }, BOUND_MANAGER);
    expect(second.ok).toBe(true);
    const { requestId } = JSON.parse(second.text) as { requestId: string };
    expect(requestId).not.toBe(first.requestId);
    const prompt = fake.creates[1]!.options.prompt!;
    expect(prompt).not.toMatch(/^size:/m);
    expect(fake.creates[0]!.options.prompt!).not.toMatch(/^size:/m);
    expect(prompt.endsWith("Context:\n- none")).toBe(true);
    // The tool lists no size: the owner's size stays in the request, in their words.
    expect(JSON.stringify(boundToolFacesFor("manager").find((face) => face.name === "bm_create_worker")!.inputSchema)).not.toContain('"size"');
    expect(createRequestRegistry(home).list(WS).map((entry) => entry.requestId)).toEqual([first.requestId, requestId]);
  });

  it("a profile on a provider without tools gives an unbound Worker and no binding", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ base: "pi", store });
    const answer = await toolsOf(home, fake, store).call("bm_create_worker", INPUT, BOUND_MANAGER);
    expect(answer.ok).toBe(true);
    const { workerId, requestId } = JSON.parse(answer.text) as { workerId: string; requestId: string };
    expect(fake.creates[0]!.options.config["mcpServers"]).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.bindingOfAgent(workerId)).toBeNull();
    expect(createRequestRegistry(home).get(WS, requestId)).toMatchObject({ managerId: MANAGER, workerIds: [workerId] });
  });
});

describe("bm_create_worker refuses, creating nothing (design §16.6)", () => {
  const nothingCreated = (home: string, fake: ReturnType<typeof daemon>, store: BindingStore) => {
    expect(fake.creates).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(existsSync(join(home, REQUESTS_DIR_NAME))).toBe(false);
  };

  it("a caller that is not a bound Manager", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    const tools = toolsOf(home, fake, store);
    const callers: Array<ToolCaller | null> = [null, { ...BOUND_MANAGER, role: "worker" }];
    for (const caller of callers) expect(await tools.call("bm_create_worker", INPUT, caller)).toEqual({ ok: false, text: NOT_BOUND_MESSAGE });
    nothingCreated(home, fake, store);
  });

  it("a caller whose binding is still pending: 'try again in a moment'", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    expect(await toolsOf(home, fake, store).call("bm_create_worker", INPUT, { ...BOUND_MANAGER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(PENDING_CALLER_MESSAGE).toMatch(/try again in a moment/);
    nothingCreated(home, fake, store);
  });

  it("input the schema refuses, each problem on its own line", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    const answer = await toolsOf(home, fake, store).call(
      "bm_create_worker",
      { size: "Huge", context: Array.from({ length: 21 }, () => ({ fact: "f", source: "s" })), how: "x" },
      BOUND_MANAGER,
    );
    expect(answer.ok).toBe(false);
    expect(answer.text.split("\n")).toEqual([
      "The call was refused. Fix these and call bm_create_worker again:",
      "- input.request: is required",
      "- input.context: takes at most 20 items",
      "- input.how: is not a field of this tool",
    ]);
    nothingCreated(home, fake, store);
  });

  it("no Paseo handle, Paseo's agent tools off, no bm-worker profile", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const cases: Array<[string, ReturnType<typeof toolsOf>, ReturnType<typeof daemon>]> = [];
    const plain = daemon({ store });
    cases.push([NO_PASEO_MESSAGE, toolsOf(home, null, store), plain]);
    const off = daemon({ store, toolsOff: true });
    cases.push([AGENT_TOOLS_OFF_TOOL_MESSAGE, toolsOf(home, off, store), off]);
    const noProfile = daemon({ store, profile: false });
    cases.push([NO_WORKER_PROFILE_MESSAGE, toolsOf(home, noProfile, store), noProfile]);
    for (const [text, tools, fake] of cases) {
      expect(await tools.call("bm_create_worker", INPUT, BOUND_MANAGER)).toEqual({ ok: false, text });
      nothingCreated(home, fake, store);
    }
    // The agent's own refusal, not the fallback Switch's wording (no Settings step, no Switch).
    expect(AGENT_TOOLS_OFF_TOOL_MESSAGE).toBe(
      "paseo-bm cannot create agents while Paseo's agent tools are off; nothing was created. Tell the owner in one line and stop.",
    );
    expect(AGENT_TOOLS_OFF_TOOL_MESSAGE).not.toBe(AGENT_TOOLS_OFF_SWITCH_MESSAGE);
    expect(AGENT_TOOLS_OFF_TOOL_MESSAGE).not.toMatch(/Switch|Settings/);
  });

  it("a registry that cannot be written: nothing created", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const fake = daemon({ store });
    // A file where the registry's folder goes: the write fails.
    writeFileSync(join(home, REQUESTS_DIR_NAME), "not a folder");
    const answer = await toolsOf(home, fake, store).call("bm_create_worker", INPUT, BOUND_MANAGER);
    expect(answer.ok).toBe(false);
    expect(answer.text).toMatch(/^paseo-bm could not write its request registry \(.+\); nothing was created\. Tell the owner in one line\.$/);
    expect(fake.creates).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("Paseo's refusal, verbatim: the binding is removed and the request kept with no Worker, so its id is never reused", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const logs: string[] = [];
    const fake = daemon({ store, refuse: "Provider 'bm-worker' is not available" });
    const tools = toolsOf(home, fake, store, logs);
    const answer = await tools.call("bm_create_worker", INPUT, BOUND_MANAGER);
    expect(answer).toEqual({ ok: false, text: "Paseo refused to create the Worker: Provider 'bm-worker' is not available" });
    // It asked with a token, and that binding is gone.
    expect(fake.creates).toHaveLength(1);
    expect((fake.creates[0]!.options.config["mcpServers"] as Record<string, unknown>)[AGENT_TOOLS_SERVER]).toBeDefined();
    expect(store.list()).toEqual([]);
    const [kept] = createRequestRegistry(home).list(WS);
    expect(kept).toMatchObject({ source: "tool", managerId: MANAGER, workerIds: [] });
    expect(fake.agents.map((agent) => agent.id)).toEqual([MANAGER]);
    expect(logs.at(-1)).toBe(`[paseo-bm] bm_create_worker could not create the Worker of request ${kept!.requestId} for Manager ${MANAGER}: Provider 'bm-worker' is not available`);
    // The next call gets another id.
    await tools.call("bm_create_worker", INPUT, BOUND_MANAGER);
    const ids = createRequestRegistry(home).list(WS).map((entry) => entry.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("a token never reaches the agent (design §16.5)", () => {
  it("Paseo's refusal that echoes the token path reaches the Manager and the log with the path cut", async () => {
    const home = dataFolder();
    const store = createBindingStore(home);
    const logs: string[] = [];
    const fake = daemon({ store, refuseEchoingUrl: true });
    const answer = await toolsOf(home, fake, store, logs).call("bm_create_worker", INPUT, BOUND_MANAGER);
    const token = ((fake.creates[0]!.options.config["mcpServers"] as Record<string, { url: string }>)[AGENT_TOOLS_SERVER]!.url).slice(-64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(answer).toEqual({ ok: false, text: `Paseo refused to create the Worker: MCP server ${AGENT_TOOLS_SERVER} (http://127.0.0.1:4567/mcp/worker/…) failed to start` });
    expect(logs.join("\n")).toContain("/mcp/worker/…");
    expect(logs.join("\n")).not.toContain(token);
    expect(store.list()).toEqual([]);
  });
});

describe("the brief (design §16.6)", () => {
  it("quotes every line of the request, keeps blank lines inside the quote, and trims the folder's trailing slash", () => {
    const brief = workerBriefOf({ requestId: "req-20261003T100000Z", request: "One.\n\nTwo.", cwd: "/repo/", managerId: "m", context: [] });
    expect(brief.split("\n").slice(0, 5)).toEqual(["BM-BRIEF worker requestId: req-20261003T100000Z", "The owner's request, verbatim:", "> One.", ">", "> Two."]);
    expect(brief).toContain("repository: /repo (beads in /repo/.beads/)");
    expect(originOf({ text: brief })).toBe("plugin-prompt");
  });
});
