import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_BY_NAME,
  DENIED_MESSAGE,
  REPLACED_MESSAGE,
  codexCommandOf,
  codexMcpToolOf,
  createActionBoundary,
  packageScriptBody,
  isHeldOpen,
  type ActionBoundary,
  type BoundaryAgent,
  type BoundaryRequest,
} from "../plugin/server/action-boundary";
import { fullInstructions } from "../plugin/server/role-instructions";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import { MANAGER_DISABLED_PASEO_TOOLS, WORKER_DISABLED_PASEO_TOOLS, paseoToolsPolicyOfAlias } from "../plugin/server/setup-roles";
import { decideRefusalOf, predictionRefusalOf, recommendedDelegationOf, EMPTY_AUTONOMY_POLICY } from "../plugin/shared/autonomy";
import { DashboardError } from "../plugin/shared/contracts";
import { overrideRefusalOf } from "../plugin/shared/decision-override";
import { answerDecision, decisionKindOf, deliveryKindOf, heldDecisionId, type Decision } from "../plugin/shared/decisions";
import { precedentResolutionOf } from "../plugin/shared/precedents";
import { fakePaseo, type FakeAgent, type FakePaseo } from "./helpers/fake-paseo";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * The action boundary (autonomy design §D.2, ADR-019; change-009 C4–C8)
 * against a temporary data folder and the one fake Paseo handle. Never the
 * real HOME, daemon or agents.
 */

const WS_DIR = "/work/invoice-app";
const NOW = "2026-10-01T08:00:00.000Z";
const WORKER = "w-1";
const REVIEWER = "r-1";
const PACKAGE = JSON.stringify({ scripts: { test: "vitest run", build: "tsup", release: "npm publish" } });

let root: string;
let home: string;
let logs: string[];
let clock: Date;

const worker = (overrides: Partial<FakeAgent> = {}): FakeAgent => ({
  id: WORKER,
  workspaceId: DECISION_WS,
  status: "running",
  provider: "bm-worker/claude-sonnet-5",
  cwd: WS_DIR,
  // Created under the boundary (change-010 C5): only such agents are answered.
  labels: { "bm.role": "worker", "bm.requestId": DECISION_REQUEST, "bm.boundary": "on" },
  pendingPermissions: [],
  ...overrides,
});
const hookAgent = (agent: FakeAgent): BoundaryAgent => ({
  id: agent.id,
  workspaceId: (agent.workspaceId as string | null) ?? null,
  provider: String(agent.provider),
  cwd: String(agent.cwd ?? WS_DIR),
  parentAgentId: null,
});
const bash = (id: string, command: string, extra: Partial<BoundaryRequest> = {}): BoundaryRequest => ({
  id,
  provider: "claude",
  name: "Bash",
  kind: "tool",
  detail: { type: "shell", command },
  input: { command },
  // Offers the boundary must never take (spike §2).
  suggestions: [{ type: "addRules", destination: "localSettings" }],
  ...extra,
} as BoundaryRequest);

function boundaryOf(bases: Record<string, string> = { "bm-worker": "claude", "bm-reviewer": "codex", "bm-manager": "claude" }): ActionBoundary {
  return createActionBoundary({
    home: () => home,
    now: () => clock,
    log: (message) => logs.push(message),
    env: { TMPDIR: "/var/folders/ab/cd/T/" },
    homeDirectory: "/Users/owner",
    readFile: (path) => {
      if (path === join(WS_DIR, "package.json")) return PACKAGE;
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    },
    aliasBases: async () => bases,
  });
}

function daemon(agents: FakeAgent[], timelines: Record<string, unknown[]> = {}): FakePaseo<unknown> {
  return fakePaseo({ agents, timelines });
}

/** Raises `request` for `agent` as Paseo would: the request is pending on the agent while it waits. */
async function raise(boundary: ActionBoundary, fake: FakePaseo<unknown>, agent: FakeAgent, request: BoundaryRequest) {
  const live = fake.byId(agent.id)!;
  live.pendingPermissions = [...((live.pendingPermissions as unknown[]) ?? []), request];
  return boundary.onRequested({ agent: hookAgent(agent), request }, fake.paseo);
}

const decisions = () => createDecisionStore(home);
const held = (requestId: string, agentId = WORKER) => decisions().get(heldDecisionId(agentId, requestId));

/** An answered Worker question of the request whose chosen option granted `effects`. */
function grantOf(n: number, effects: Decision["options"][number]["effects"], by: "owner" | "policy" = "owner"): Decision {
  const open = makeDecision({
    id: `q:${DECISION_REQUEST}:Q${n}`,
    options: [
      { key: "a", label: "Yes", recommended: true, effects },
      { key: "b", label: "No", recommended: false, effects: ["none"] },
    ],
  });
  const result = answerDecision(open, { via: "inbox", optionKey: "a", at: new Date(clock.getTime() - 60_000).toISOString(), ...(by === "policy" ? { by: "policy", predictor: "recommended" } : {}) });
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

async function codeOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-action-boundary-"));
  home = join(root, "data");
  logs = [];
  clock = new Date(NOW);
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("reading a request, per provider (§D.2 table)", () => {
  it("Claude: Bash by its command, the file tools by their path, WebFetch as network, tools by name", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), bash("p1", "npm test"))).toBe("allowed");
    expect(await raise(boundary, fake, worker(), { id: "p2", name: "Edit", kind: "tool", detail: { type: "edit", filePath: `${WS_DIR}/src/a.ts` } })).toBe("allowed");
    expect(await raise(boundary, fake, worker(), { id: "p3", name: "Write", kind: "tool", detail: { type: "write", filePath: "/etc/hosts" } })).toBe("held");
    expect(await raise(boundary, fake, worker(), { id: "p4", name: "WebFetch", kind: "tool", detail: { url: "https://example.com" } })).toBe("held");
    expect(await raise(boundary, fake, worker(), { id: "p5", name: "mcp__paseo__list_agents", kind: "tool", input: {} })).toBe("allowed");
    expect(await raise(boundary, fake, worker(), { id: "p6", name: "mcp__paseo-bm__bm_report", kind: "tool", input: {} })).toBe("allowed");
    expect(await raise(boundary, fake, worker(), { id: "p7", name: "Skill", kind: "tool", input: {} })).toBe("allowed");
    expect(ALLOWED_BY_NAME.has("TodoWrite")).toBe(true);
    expect(held("p3")?.class).toBe("environment");
    expect(held("p4")?.options[0]?.effects).toEqual(["network"]);
  });

  it("a Worker's create_agent for a Reviewer is allowed; for any other provider it is held as security", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const create = (id: string, provider: string): BoundaryRequest => ({ id, name: "mcp__paseo__create_agent", kind: "tool", input: { provider } });
    expect(await raise(boundary, fake, worker(), create("c1", "bm-reviewer/gpt-5.6"))).toBe("allowed");
    expect(await raise(boundary, fake, worker(), create("c2", "bm-reviewer-fallback-1/x"))).toBe("allowed");
    expect(await raise(boundary, fake, worker(), create("c3", "claude/claude-sonnet-5"))).toBe("held");
    expect(await raise(boundary, fake, worker(), create("c4", "bm-worker/claude-sonnet-5"))).toBe("held");
    expect(held("c3")).toMatchObject({ class: "security", subject: "held-security" });
  });

  it("an unknown tool or another MCP server's tool is unreadable: held, its Allow declares security", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), { id: "u1", name: "mcp__github__create_pr", kind: "tool", input: {} })).toBe("held");
    expect(await raise(boundary, fake, worker(), { id: "u2", name: "SomethingNew", kind: "tool", input: {} })).toBe("held");
    expect(await raise(boundary, fake, worker(), { id: "u3", name: "Bash", kind: "tool", detail: {}, input: {} })).toBe("held");
    for (const id of ["u1", "u2", "u3"]) expect(held(id)?.options.find((option) => option.key === "allow")?.effects).toEqual(["security"]);
    expect(fake.permissions).toEqual([]);
  });

  it("Codex: CodexBash with its own cwd; a file change by its pending timeline item's path, unreadable without one", async () => {
    const boundary = boundaryOf();
    const codex = worker({ id: "cx", provider: "bm-reviewer/gpt-5.6-terra" });
    const timeline = [
      { item: { type: "tool_call", callId: "item-in", status: "running", detail: { type: "edit", filePath: "src/a.ts" } }, timestamp: NOW },
      { item: { type: "tool_call", callId: "item-out", status: "running", detail: { type: "write", filePath: "/work/other-app/x.ts" } }, timestamp: NOW },
    ];
    const fake = daemon([codex], { cx: timeline });
    const change = (id: string, itemId: string | null): BoundaryRequest => ({ id, name: "CodexFileChange", kind: "tool", detail: { type: "unknown", input: { reason: "" } }, metadata: itemId === null ? {} : { itemId } });
    expect(await raise(boundary, fake, codex, { id: "b1", name: "CodexBash", kind: "tool", detail: { type: "shell", command: "rm -rf ../x", cwd: `${WS_DIR}/src` } })).toBe("allowed");
    expect(await raise(boundary, fake, codex, { id: "b2", name: "CodexBash", kind: "tool", detail: { type: "shell", command: "rm -rf ../../x", cwd: `${WS_DIR}/src` } })).toBe("held");
    // Codex's own wrapper is read, not Paseo's unwrapped copy (which keeps the wrapper's quoting).
    const wrapped = `/bin/zsh -lc 'grep -E '"'"'a|b'"'"' src && git push'`;
    expect(await raise(boundary, fake, codex, { id: "b3", name: "CodexBash", kind: "tool", input: { command: wrapped }, detail: { type: "shell", command: `grep -E '"'"'a|b'"'"' src`, cwd: WS_DIR } })).toBe("held");
    expect(held("b3", "cx")?.options[0]?.effects).toEqual(["push"]);
    expect(await raise(boundary, fake, codex, { id: "b4", name: "CodexBash", kind: "tool", input: { command: ["/bin/zsh", "-lc", "grep -E 'a|b' src"] }, detail: { type: "shell", command: "x" } })).toBe("allowed");
    expect(codexCommandOf(["git", "push", "origin"])).toBe("git push origin");
    expect(codexCommandOf(["echo", "a b"])).toBe("echo 'a b'");
    expect(await raise(boundary, fake, codex, change("f1", "item-in"))).toBe("allowed");
    expect(await raise(boundary, fake, codex, change("f2", "item-out"))).toBe("held");
    expect(await raise(boundary, fake, codex, change("f3", "item-missing"))).toBe("held");
    expect(await raise(boundary, fake, codex, change("f4", null))).toBe("held");
    expect(held("f2", "cx")?.options[0]?.effects).toEqual(["outside-workspace"]);
    expect(held("f3", "cx")?.options[0]?.effects).toEqual(["security"]);
    expect(fake.refetches.some((read) => read.id === "cx" && read.options.direction === "tail")).toBe(true);
  });

  // Live check 2026-10-01 §5, F2: under `untrusted`, Codex asks for each Paseo tool call as a CodexMcpElicitation.
  it("Codex: an MCP request for Paseo's or paseo-bm's tools is allowed by name, as Claude's are; create_agent and other servers are held", async () => {
    const boundary = boundaryOf();
    const codex = worker({ id: "cx", provider: "bm-worker/gpt-5.6-luna" });
    const fake = daemon([codex]);
    // The captured shape: the server in metadata, the tool only in the description, no arguments.
    const elicitation = (id: string, server: string, description: string): BoundaryRequest => ({
      id,
      name: "CodexMcpElicitation",
      kind: "tool",
      title: `MCP approval: ${server}`,
      description,
      input: { mode: "form", requestedSchema: { type: "object", properties: {} }, url: null },
      metadata: { threadId: "thr-1", turnId: "turn-1", serverName: server, elicitationId: null },
    });
    const ask = (server: string, tool: string) => `Allow the ${server} MCP server to run tool "${tool}"?`;
    expect(await raise(boundary, fake, codex, elicitation("e1", "paseo", ask("paseo", "send_agent_prompt")))).toBe("allowed");
    expect(await raise(boundary, fake, codex, elicitation("e2", "paseo", ask("paseo", "list_agents")))).toBe("allowed");
    expect(await raise(boundary, fake, codex, elicitation("e3", "paseo-bm", ask("paseo-bm", "bm_report")))).toBe("allowed");
    expect(fake.permissions.map((answer) => answer.requestId)).toEqual(["e1", "e2", "e3"]);
    // Without its arguments a create_agent cannot be read: held as security, only the owner allows it.
    expect(await raise(boundary, fake, codex, elicitation("e4", "paseo", ask("paseo", "create_agent")))).toBe("held");
    expect(held("e4", "cx")).toMatchObject({ class: "security", subject: "held-security" });
    // Another server, a description naming no tool or two, no server: unreadable.
    expect(await raise(boundary, fake, codex, elicitation("e5", "github", ask("github", "create_pr")))).toBe("held");
    expect(await raise(boundary, fake, codex, elicitation("e6", "paseo", "Allow the paseo MCP server to continue?"))).toBe("held");
    expect(await raise(boundary, fake, codex, elicitation("e7", "paseo", `${ask("paseo", "list_agents")} Then run tool "create_agent"?`))).toBe("held");
    expect(await raise(boundary, fake, codex, { ...elicitation("e8", "paseo", ask("paseo", "list_agents")), metadata: {} })).toBe("held");
    for (const id of ["e5", "e6", "e7", "e8"]) expect(held(id, "cx")?.options.find((option) => option.key === "allow")?.effects, id).toEqual(["security"]);
    expect(codexMcpToolOf(elicitation("x", "paseo", ask("paseo", "send_agent_prompt")))).toEqual({ server: "paseo", tool: "send_agent_prompt" });
  });

  it("reads a package script from the nearest package.json; an unreadable one is unreadable", () => {
    const files: Record<string, string> = { "/a/package.json": PACKAGE, "/b/package.json": "{ not json" };
    const read = (path: string) => {
      if (path in files) return files[path]!;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(packageScriptBody("release", "/a/src/deep", read)).toBe("npm publish");
    expect(packageScriptBody("nope", "/a", read)).toBeNull();
    expect(packageScriptBody("test", "/b/x", read)).toBeUndefined();
    expect(packageScriptBody("test", "/c", read)).toBeNull();
  });
});

describe("allow or hold (§D.2, §D.4)", () => {
  it("ordinary work is allowed at once with a plain allow-once, never a suggestion", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), bash("p1", "npm test && git status"))).toBe("allowed");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
    expect(decisions().list()).toEqual([]);
  });

  it("a held effect no grant or policy covers opens one decision and leaves the request pending", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), bash("p1", "git push origin main"))).toBe("held");
    expect(fake.permissions).toEqual([]);
    const decision = held("p1")!;
    expect(decisionKindOf(decision.id)).toBe("held");
    expect(deliveryKindOf(decision)).toBe("held");
    expect(decision).toMatchObject({
      id: `h:${WORKER}:p1`,
      workspaceId: DECISION_WS,
      requestId: DECISION_REQUEST,
      askedBy: { role: "plugin", agentId: WORKER },
      class: "release",
      subject: "held-release",
      status: "open",
      prediction: { recommended: null, orchestrator: null },
    });
    expect(decision.question).toContain("`git push origin main`");
    expect(decision.options).toEqual([
      { key: "allow", label: "Allow once", recommended: false, effects: ["push"], action: { kind: "permission", agentId: WORKER, requestId: "p1", allow: true } },
      { key: "deny", label: "Deny", recommended: false, effects: ["none"], action: { kind: "permission", agentId: WORKER, requestId: "p1", allow: false } },
    ]);
    // The same request again (a scan, a duplicate event) opens nothing more and answers nothing.
    expect(await boundary.onRequested({ agent: hookAgent(worker()), request: bash("p1", "git push origin main") }, fake.paseo)).toBe("held");
    expect(decisions().list()).toHaveLength(1);
    expect(fake.permissions).toEqual([]);
  });

  it("a Reviewer's held request belongs to its Worker's request", async () => {
    const boundary = boundaryOf();
    const reviewer = worker({ id: REVIEWER, provider: "bm-reviewer", labels: { "bm.role": "reviewer", "paseo.parent-agent-id": WORKER, "bm.boundary": "on" } });
    const fake = daemon([worker(), reviewer]);
    expect(await raise(boundary, fake, reviewer, bash("r1", "curl https://example.com"))).toBe("held");
    expect(held("r1", REVIEWER)).toMatchObject({ requestId: DECISION_REQUEST, askedBy: { role: "plugin", agentId: REVIEWER } });
    expect(held("r1", REVIEWER)?.question.startsWith("The Reviewer asks to run")).toBe(true);
  });

  it("a live grant of the request covers it and is spent; a second such request is held", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    decisions().open(grantOf(1, ["push"]));
    expect(await raise(boundary, fake, worker(), bash("p1", "git push"))).toBe("allowed-grant");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
    expect(decisions().get(`q:${DECISION_REQUEST}:Q1`)?.grant?.usedAt).toBe(NOW);
    expect(await raise(boundary, fake, worker(), bash("p2", "git push"))).toBe("held");
    expect(fake.permissions).toHaveLength(1);
  });

  it("a grant the owner did not give, an expired one, or one of another effect does not cover", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    decisions().open(grantOf(1, ["publish"]));
    decisions().open(grantOf(2, ["network"], "policy"));
    expect(await raise(boundary, fake, worker(), bash("p1", "git push"))).toBe("held");
    expect(await raise(boundary, fake, worker(), bash("p2", "curl x"))).toBe("held");
    decisions().open(grantOf(3, ["push"]));
    clock = new Date(Date.parse(NOW) + 2 * 60 * 60_000);
    expect(await raise(boundary, fake, worker(), bash("p3", "git push"))).toBe("held");
    expect(fake.permissions).toEqual([]);
  });

  it("a delegate cell covers dependency and environment: allowed, stored answered by the policy; release or data never", async () => {
    createAutonomyStore(home).set({ workspaceId: DECISION_WS, class: "dependency", mode: "delegate", confirmed: true }, NOW);
    createAutonomyStore(home).set({ workspaceId: DECISION_WS, class: "environment", mode: "delegate", confirmed: true }, NOW);
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), bash("p1", "npm install left-pad"))).toBe("allowed-policy");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
    const decision = held("p1")!;
    expect(decision.status).toBe("answered");
    expect(decision.answer).toMatchObject({ by: "policy", optionKey: "allow", class: "dependency", predictor: "recommended" });
    expect(decision.grant?.usedAt).toBe(NOW);
    // Release and data are never the policy's; an unreadable request neither.
    expect(await raise(boundary, fake, worker(), bash("p2", "npm install x && git push"))).toBe("held");
    expect(await raise(boundary, fake, worker(), bash("p3", `sqlite3 app.db "DROP TABLE users"`))).toBe("held");
    expect(await raise(boundary, fake, worker(), bash("p4", `rm -rf "$OUT"`))).toBe("held");
    expect(fake.permissions).toHaveLength(1);
    expect(overrideRefusalOf(decision)?.refusal).toBe("not-delegated");
  });

  it("negative: nothing that must be held is ever allowed, whatever the grants and the policy", async () => {
    createAutonomyStore(home).set({ workspaceId: DECISION_WS, class: "dependency", mode: "delegate", confirmed: true }, NOW);
    createAutonomyStore(home).set({ workspaceId: DECISION_WS, class: "environment", mode: "delegate", confirmed: true }, NOW);
    decisions().open(grantOf(1, ["security"]));
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const mustHold = [
      "git push",
      "npm publish",
      "kubectl apply -f x.yaml",
      "vercel --prod",
      `psql -c "DELETE FROM invoices"`,
      "npx prisma migrate deploy",
      "npm run release",
      `bash -c "git push"`,
      "$CMD",
      `echo "open`,
    ];
    for (const [index, command] of mustHold.entries()) {
      expect([command, await raise(boundary, fake, worker(), bash(`n${index}`, command))]).toEqual([command, "held"]);
    }
    expect(await raise(boundary, fake, worker(), { id: "n-create", name: "mcp__paseo__create_agent", kind: "tool", input: { provider: "claude" } })).toBe("held");
    expect(await raise(boundary, fake, worker(), { id: "n-unknown", name: "Mystery", kind: "tool" })).toBe("held");
    expect(fake.permissions).toEqual([]);
  });

  it("ignores what is not its own: other agents, the Manager, other kinds, providers on detection", async () => {
    const boundary = boundaryOf({ "bm-worker": "opencode", "bm-reviewer": "codex" });
    const other = worker({ id: "x", provider: "claude", labels: {} });
    const manager = worker({ id: "m", provider: "bm-manager" });
    const opencode = worker({ id: "o" });
    const fake = daemon([other, manager, opencode]);
    expect(await raise(boundary, fake, other, bash("x1", "git push"))).toBe("ignored");
    expect(await raise(boundary, fake, manager, bash("m1", "git push"))).toBe("ignored");
    expect(await raise(boundary, fake, opencode, bash("o1", "git push"))).toBe("ignored");
    const reviewer = worker({ id: REVIEWER, provider: "bm-reviewer" });
    expect(await boundary.onRequested({ agent: hookAgent(reviewer), request: { id: "q1", name: "AskUserQuestion", kind: "question" } }, fake.paseo)).toBe("ignored");
    expect(fake.permissions).toEqual([]);
    expect(decisions().list()).toEqual([]);
  });

  it("a replaced Worker's request is denied", async () => {
    const boundary = boundaryOf();
    const replaced = worker({ labels: { "bm.role": "worker", "bm.requestId": DECISION_REQUEST, "bm.boundary": "on", "bm.replacedBy": "w-2" } });
    const fake = daemon([replaced]);
    expect(await raise(boundary, fake, replaced, bash("p1", "git push"))).toBe("denied-replaced");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "deny", message: REPLACED_MESSAGE } }]);
  });

  it("with no data folder a held request is left to Paseo's own prompt, never allowed", async () => {
    const boundary = createActionBoundary({ home: () => null, now: () => clock, log: (message) => logs.push(message), aliasBases: async () => ({ "bm-worker": "claude" }) });
    const fake = daemon([worker()]);
    expect(await raise(boundary, fake, worker(), bash("p1", "git push"))).toBe("left");
    expect(fake.permissions).toEqual([]);
  });
});

describe("the owner's answer is delivered exactly once (§D.2)", () => {
  async function heldPush(boundary: ActionBoundary, fake: FakePaseo<unknown>, id = "p1", command = "git push") {
    expect(await raise(boundary, fake, worker(), bash(id, command))).toBe("held");
    return heldDecisionId(WORKER, id);
  }
  const depsOf = (boundary: ActionBoundary) => ({ home, now: () => clock, log: (message: string) => logs.push(message), onSettled: settledByKind({ held: boundary.onSettled }) });

  it("Allow on a release effect needs the owner's confirmation; confirmed, it allows the request once and spends the grant", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const id = await heldPush(boundary, fake);
    expect(await codeOf(() => handleDecisionsAnswer({ id, optionKey: "allow" }, fake.paseo, depsOf(boundary)))).toBe("E_DECISION_NOT_CONFIRMED");
    expect(decisions().get(id)?.status).toBe("open");
    const { decision } = await handleDecisionsAnswer({ id, optionKey: "allow", confirmed: true }, fake.paseo, depsOf(boundary));
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
    expect(decision.delivery).toMatchObject({ to: WORKER, kind: "permission:allow", outcome: "sent" });
    expect(decision.grant?.usedAt).not.toBeNull();
    // A second answer is refused; a re-delivery (a reload) answers nothing.
    expect(await codeOf(() => handleDecisionsAnswer({ id, optionKey: "deny" }, fake.paseo, depsOf(boundary)))).toBe("E_DECISION_SETTLED");
    await boundaryOf().onSettled([decisions().get(id)!], { paseo: fake.paseo });
    expect(fake.permissions).toHaveLength(1);
  });

  it("Deny answers deny; words are refused", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const id = await heldPush(boundary, fake, "p1", "curl https://example.com");
    expect(await codeOf(() => handleDecisionsAnswer({ id, words: "go ahead" }, fake.paseo, depsOf(boundary)))).toBe("E_DECISION_ANSWER_INVALID");
    const { decision } = await handleDecisionsAnswer({ id, optionKey: "deny" }, fake.paseo, depsOf(boundary));
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "deny", message: DENIED_MESSAGE } }]);
    expect(decision.grant).toBeNull();
    expect(decision.delivery).toMatchObject({ kind: "permission:deny", outcome: "sent" });
  });

  it("an environment Allow needs no confirmation; an unreadable one needs it (security)", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const net = await heldPush(boundary, fake, "p1", "curl https://example.com");
    await handleDecisionsAnswer({ id: net, optionKey: "allow" }, fake.paseo, depsOf(boundary));
    const unread = await heldPush(boundary, fake, "p2", "$CMD");
    expect(await codeOf(() => handleDecisionsAnswer({ id: unread, optionKey: "allow" }, fake.paseo, depsOf(boundary)))).toBe("E_DECISION_NOT_CONFIRMED");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
  });

  it("a request already resolved is recorded failed, and nothing is answered", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const id = await heldPush(boundary, fake);
    fake.byId(WORKER)!.pendingPermissions = [];
    const { decision } = await handleDecisionsAnswer({ id, optionKey: "allow", confirmed: true }, fake.paseo, depsOf(boundary));
    expect(decision.delivery).toMatchObject({ outcome: "failed" });
    expect(fake.permissions).toEqual([]);
  });

  it("two deliveries at once answer once", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const id = await heldPush(boundary, fake);
    const answered = answerDecision(decisions().get(id)!, { via: "inbox", optionKey: "allow", at: NOW });
    if (!answered.ok) throw new Error(answered.message);
    decisions().transition(id, () => answered);
    await Promise.all([boundary.onSettled([answered.decision], { paseo: fake.paseo }), boundaryOf().onSettled([answered.decision], { paseo: fake.paseo })]);
    expect(fake.permissions).toHaveLength(1);
  });

  it("bm_decide, bm_predict, a precedent and the policy's predictor never answer a held request", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    const id = await heldPush(boundary, fake, "p1", "curl x");
    const decision = decisions().get(id)!;
    expect(decideRefusalOf(EMPTY_AUTONOMY_POLICY, decision)).toMatch(/only the owner allows or denies it/);
    expect(predictionRefusalOf(EMPTY_AUTONOMY_POLICY, decision)).toMatch(/only the owner allows or denies it/);
    expect(recommendedDelegationOf(EMPTY_AUTONOMY_POLICY, decision)).toBeNull();
    const precedent = { id: "p-1", workspaceId: DECISION_WS, subject: "held-environment", text: "allow", createdAt: NOW, expiresAt: null, supersededBy: null } as never;
    expect(precedentResolutionOf(decision, [precedent], clock)).toBeNull();
    expect(answerDecision(decision, { via: "inbox", optionKey: "allow", at: NOW, by: "precedent", precedentId: "p-1" }).ok).toBe(false);
  });
});

describe("answered elsewhere (agent.permission_resolved)", () => {
  it("an allow in Paseo's prompt is the owner's answer via paseo, its grant spent at once; a deny withdraws", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    await raise(boundary, fake, worker(), bash("p1", "git push"));
    await raise(boundary, fake, worker(), bash("p2", "curl x"));
    expect(await boundary.onResolved({ agent: hookAgent(worker()), requestId: "p1", resolution: { behavior: "allow" } }, fake.paseo)).toBe("answered");
    expect(held("p1")).toMatchObject({ status: "answered", answer: { by: "owner", via: "paseo", optionKey: "allow" } });
    expect(held("p1")?.grant?.usedAt).toBe(NOW);
    expect(await boundary.onResolved({ agent: hookAgent(worker()), requestId: "p2", resolution: { behavior: "deny" } }, fake.paseo)).toBe("withdrawn");
    expect(held("p2")?.status).toBe("withdrawn");
    // A request it allowed itself, or one already settled, changes nothing.
    expect(await boundary.onResolved({ agent: hookAgent(worker()), requestId: "p1", resolution: { behavior: "deny" } }, fake.paseo)).toBe("none");
    expect(await boundary.onResolved({ agent: hookAgent(worker()), requestId: "zz", resolution: { behavior: "allow" } }, fake.paseo)).toBe("none");
    // Nothing of it is delivered again.
    await boundary.onSettled([held("p1")!], { paseo: fake.paseo });
    expect(fake.permissions).toEqual([]);
  });
});

describe("restart: the scan of pending requests (§D.2, change-009 C8)", () => {
  it("opens a held decision for a request raised while the plugin was down, allows ordinary ones, and never a second time", async () => {
    const pending = [bash("d1", "git push"), bash("d2", "npm test")];
    const fake = daemon([worker({ pendingPermissions: pending })]);
    const boundary = boundaryOf();
    const first = await boundary.scan(fake.paseo);
    expect(first.requests).toEqual([
      { key: `${WORKER}|d1`, outcome: "held" },
      { key: `${WORKER}|d2`, outcome: "allowed" },
    ]);
    expect(held("d1")?.status).toBe("open");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "d2", response: { behavior: "allow" } }]);
    // A later scan, or a new plugin run, opens nothing more and answers nothing more.
    await boundary.scan(fake.paseo);
    await boundaryOf().scan(fake.paseo);
    expect(decisions().list()).toHaveLength(1);
    expect(fake.permissions).toHaveLength(1);
  });

  it("usePaseo scans once per run, at the first handle", async () => {
    const fake = daemon([worker({ pendingPermissions: [bash("d1", "git push")] })]);
    const boundary = boundaryOf();
    boundary.usePaseo(fake.paseo);
    boundary.usePaseo(fake.paseo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held("d1")?.status).toBe("open");
    expect(fake.lists).toHaveLength(1);
  });

  it("withdraws a replaced Worker's held decisions and denies its requests; withdraws one whose request is gone", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker(), worker({ id: "w-2" })]);
    await raise(boundary, fake, worker(), bash("p1", "git push"));
    await raise(boundary, fake, worker({ id: "w-2" }), bash("p2", "git push"));
    fake.byId("w-2")!.pendingPermissions = [];
    fake.byId(WORKER)!.labels = { ...fake.byId(WORKER)!.labels, "bm.replacedBy": "w-3" };
    clock = new Date(Date.parse(NOW) + 60_000);
    const result = await boundary.scan(fake.paseo);
    expect(result.denied).toEqual([`${WORKER}|p1`]);
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "deny", message: REPLACED_MESSAGE } }]);
    expect(result.withdrawn.sort()).toEqual([heldDecisionId(WORKER, "p1"), heldDecisionId("w-2", "p2")].sort());
    expect(held("p1")?.status).toBe("withdrawn");
  });

  it("a finished report never expires a held decision: only the scan's rules end it", async () => {
    const boundary = boundaryOf();
    const fake = daemon([worker()]);
    await raise(boundary, fake, worker(), bash("p1", "git push"));
    clock = new Date(Date.parse(NOW) + 60_000);
    await boundary.scan(fake.paseo);
    expect(held("p1")?.status).toBe("open");
  });
});

describe("negative (authority): only the plugin answers a permission", () => {
  it("respond_to_permission stays disabled for the Manager and the Worker; the Reviewer and the Orchestrator have no Paseo tools", () => {
    for (const list of [MANAGER_DISABLED_PASEO_TOOLS, WORKER_DISABLED_PASEO_TOOLS]) {
      expect(list).toEqual(expect.arrayContaining(["respond_to_permission", "list_pending_permissions", "set_agent_mode"]));
    }
    expect(paseoToolsPolicyOfAlias("bm-reviewer")).toEqual({ enabled: false });
    expect(paseoToolsPolicyOfAlias("bm-orchestrator")).toEqual({ enabled: false });
  });
});

/**
 * Which agents the handler answers (change-010 C5): only Workers and
 * Reviewers under the boundary — labelled `bm.boundary=on`, or, until the
 * label lands, whose Runtime facts say `Action boundary: on` — whatever their
 * project's switch says now. Every other request waits in Paseo's own prompt,
 * with the watch's `permission-waiting` alert (no open `h:` decision).
 */
describe("the agents under the boundary (change-010 C5)", () => {
  const ON_PROMPT = fullInstructions("worker", { reviewerModeId: "default", actionBoundary: { on: true, modeId: "default" } });
  const OFF_PROMPT = fullInstructions("worker", { reviewerModeId: "auto", actionBoundary: { on: false, reason: "the project's boundary is off" } });
  const labelsOf = (boundary?: "on" | "off") => ({ "bm.role": "worker", "bm.requestId": DECISION_REQUEST, ...(boundary === undefined ? {} : { "bm.boundary": boundary }) });

  it("a Worker labelled on is still answered after its project's switch is turned off", async () => {
    const store = createAutonomyStore(home);
    store.setBoundary({ workspaceId: DECISION_WS, enabled: true, confirmed: true }, NOW);
    store.setBoundary({ workspaceId: DECISION_WS, enabled: false, confirmed: true }, NOW);
    const agent = worker();
    const fake = daemon([agent]);
    const boundary = boundaryOf();
    expect(await raise(boundary, fake, agent, bash("p1", "npm test"))).toBe("allowed");
    expect(await raise(boundary, fake, agent, bash("p2", "git push"))).toBe("held");
    expect(held("p2")?.status).toBe("open");
  });

  it("a Worker whose label has not landed yet is answered from its Runtime facts line", async () => {
    const agent = worker({ labels: labelsOf(), persistence: { metadata: { systemPrompt: ON_PROMPT } } });
    const fake = daemon([agent]);
    expect(await raise(boundaryOf(), fake, agent, bash("p1", "npm test"))).toBe("allowed");
    expect(fake.permissions).toEqual([{ id: WORKER, requestId: "p1", response: { behavior: "allow" } }]);
  });

  it("NEGATIVE: a Worker created with the boundary off, or without the line, is left to Paseo's prompt: nothing answered, nothing held", async () => {
    for (const agent of [
      worker({ labels: labelsOf("off") }),
      worker({ labels: labelsOf("off"), persistence: { metadata: { systemPrompt: ON_PROMPT } } }),
      worker({ labels: labelsOf(), persistence: { metadata: { systemPrompt: OFF_PROMPT } } }),
      worker({ labels: labelsOf() }),
    ]) {
      const fake = daemon([agent]);
      const boundary = boundaryOf();
      for (const [id, command] of [["q1", "npm test"], ["q2", "git push"]] as const) {
        expect(await raise(boundary, fake, agent, bash(id, command)), JSON.stringify(agent.labels)).toBe("ignored");
        // No open `h:` decision: the watch keeps this request's `permission-waiting` alert.
        expect(isHeldOpen(decisions(), WORKER, id)).toBe(false);
      }
      expect(fake.permissions).toEqual([]);
    }
    expect(decisions().list()).toEqual([]);
  });

  it("the restart scan skips agents not under the boundary: their requests stay pending in Paseo's prompt", async () => {
    const on = worker({ id: "w-on", pendingPermissions: [bash("a1", "npm test")] });
    const off = worker({ id: "w-off", labels: labelsOf("off"), pendingPermissions: [bash("b1", "npm test"), bash("b2", "git push")] });
    const bare = worker({ id: "w-bare", labels: labelsOf(), pendingPermissions: [bash("c1", "npm test")] });
    const replacedOff = worker({ id: "w-old", labels: { ...labelsOf("off"), "bm.replacedBy": "w-on" }, pendingPermissions: [bash("d1", "npm test")] });
    const fake = daemon([on, off, bare, replacedOff]);
    const result = await boundaryOf().scan(fake.paseo);
    expect(result.requests).toEqual([{ key: "w-on|a1", outcome: "allowed" }]);
    expect(result.denied).toEqual([]);
    expect(fake.permissions).toEqual([{ id: "w-on", requestId: "a1", response: { behavior: "allow" } }]);
    expect(decisions().list()).toEqual([]);
  });

  it("plugin down: a Worker created while the plugin was stopped has no Runtime facts, so the restart scan leaves its request to the owner in Paseo's prompt", async () => {
    // Created without the hook: the creator's boundary mode, but no instructions, no facts line and no label.
    const agent = worker({ labels: { "bm.role": "worker" }, currentModeId: "default", persistence: { metadata: { systemPrompt: "" } }, pendingPermissions: [bash("x1", "git push origin main")] });
    const fake = daemon([agent]);
    const result = await boundaryOf().scan(fake.paseo);
    expect(result.requests).toEqual([]);
    expect(fake.permissions).toEqual([]);
    expect(isHeldOpen(decisions(), WORKER, "x1")).toBe(false);
    // Still pending: nothing allowed it silently.
    expect((fake.byId(WORKER)!.pendingPermissions as unknown[]).map((request) => (request as { id: string }).id)).toEqual(["x1"]);
  });
});
