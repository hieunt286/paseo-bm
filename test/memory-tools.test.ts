import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { MAX_ACTIVE_MEMORY, MAX_MEMORY_SOURCE, MAX_MEMORY_TEXT, MEMORY_FULL_REASON, createMemoryStore } from "../plugin/server/memory-store";
import { MEMORY_INDEX_ENTRIES, MEMORY_INDEX_TEXT, MEMORY_NOT_BOUND_MESSAGE, MEMORY_QUERY_ENTRIES, createMemoryTools } from "../plugin/server/memory-tools";
import { createMissionStore } from "../plugin/server/mission-store";
import { NOT_A_MAIN_MESSAGE } from "../plugin/server/mission-tools";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import type { GitRunner } from "../plugin/server/repo-tool";
import { MEMORY_TOOL_LIMITS, toolFacesFor } from "../plugin/shared/bm-tools";
import { answerDecision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";
import { fillMemory } from "./helpers/memory";

/**
 * WP-108 (missions design §2.5, §4, §5, §7): bm_memory for a Main (read, add,
 * remove in its charter's repos) and a Worker (read, add in its own repo), the
 * owner's answers added by the plugin, precedents read through, and the Main's
 * read-only bm_repo limited to its charter's repos. A fake Paseo and a fake
 * git; no daemon is contacted and no real repository is read.
 */

const MAIN = "main-1";
const NOW = new Date("2026-10-09T10:00:00.000Z");

let root: string;
let home: string;
let repoA: string;
let gitCalls: string[][];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-memory-tools-"));
  home = join(root, ".paseo-bm");
  repoA = join(root, "api");
  mkdirSync(join(repoA, "docs"), { recursive: true });
  writeFileSync(join(repoA, "docs", "prd.md"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
  writeFileSync(join(repoA, "credentials.json"), "{}");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  gitCalls = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  clearDecisionStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const git: GitRunner = async (args) => {
  gitCalls.push([...args]);
  if (args.includes("check-ignore")) throw Object.assign(new Error("exit 1"), { code: 1 });
  return { stdout: "## dev\n" };
};

function setup() {
  const fake = fakePaseo({ workspaces: [{ id: "wks-a", directory: repoA }, { id: "wks-b", directory: join(root, "web") }, { id: "wks-c", directory: join(root, "other") }] });
  const tools = createMemoryTools({ paseo: () => fake.paseo, home: () => home, now: () => NOW, git, env: {} });
  const call = (role: "manager" | "worker", name: string, input: unknown, who: ToolCaller | null) => tools[role].call(name, input, who);
  const json = async (role: "manager" | "worker", name: string, input: unknown, who: ToolCaller | null) => {
    const result = await call(role, name, input, who);
    expect(result.ok, result.text).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  };
  return { call, json };
}

const caller = (overrides: Partial<ToolCaller> = {}): ToolCaller => ({
  agentId: MAIN,
  role: "manager",
  workspaceId: "wks-home",
  requestId: null,
  parentId: null,
  batchId: null,
  ...overrides,
});

function mission() {
  const created = createMissionStore(home, { now: () => NOW }).create({ code: "WEB", name: "Website", goal: "Ship v2", repos: ["wks-a", "wks-b"], createdBy: "owner", mainId: MAIN });
  if (!created.ok) throw new Error(created.reasons.join("; "));
  return { mission: created.mission, main: caller({ missionId: created.mission.missionId }) };
}

const WORKER = caller({ agentId: "wrk-1", role: "worker", workspaceId: "wks-a", requestId: "req-20261009T100000Z", parentId: MAIN });

describe("the faces (§4, §5)", () => {
  it("lists bm_memory and bm_repo for a bound Manager and bm_memory for a bound Worker, with the store's bounds", () => {
    expect(toolFacesFor("manager", true).map((face) => face.name)).toEqual(expect.arrayContaining(["bm_memory", "bm_repo"]));
    const worker = toolFacesFor("worker", true).find((face) => face.name === "bm_memory")!;
    expect(worker.inputSchema.properties!["op"]!.enum).toEqual(["read", "add"]);
    expect(worker.inputSchema.properties!["kind"]!.enum).toEqual(["fact", "convention", "contract"]);
    expect(toolFacesFor("manager").map((face) => face.name)).not.toContain("bm_memory");
    expect([MEMORY_TOOL_LIMITS.text, MEMORY_TOOL_LIMITS.source]).toEqual([MAX_MEMORY_TEXT, MAX_MEMORY_SOURCE]);
  });
});

describe("bm_memory for a Main (§2.5, §4)", () => {
  it("adds, reads with a query and removes in a charter repo; the removal's why goes to the journal", async () => {
    const { json } = setup();
    const { mission: created, main } = mission();
    const added = (await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "convention", text: "Money is integer cents", source: "docs/prd.md" }, main))["added"] as Record<string, string>;
    expect(added).toMatchObject({ kind: "convention", text: "Money is integer cents", by: "main" });
    expect(createMemoryStore(home).active("wks-a")[0]!.by).toEqual({ role: "main", agentId: MAIN, missionId: created.missionId });
    await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "fact", text: "CI runs on Node 22", source: "ci.yml" }, main);
    const read = await json("manager", "bm_memory", { project: "wks-a", op: "read", query: "CENTS" }, main);
    expect(read).toMatchObject({ project: "wks-a", live: 2, retired: 0, limit: MAX_ACTIVE_MEMORY });
    expect((read["entries"] as Array<{ id: string }>).map((entry) => entry.id)).toEqual([added.id]);
    expect(await json("manager", "bm_memory", { project: "wks-a", op: "remove", id: added.id, why: "Moved to decimal strings" }, main)).toEqual({ removed: added.id });
    expect(createMemoryStore(home).active("wks-a").map((entry) => entry.text)).toEqual(["CI runs on Node 22"]);
    expect(createMissionStore(home).journal(created.missionId, 5).at(-1)).toMatchObject({ kind: "note", by: "main", ref: added.id, text: `The Main removed memory entry ${added.id} of wks-a: Moved to decimal strings` });
  });

  it("a removal whose journal line cannot be written is still the removal: one log line, never a refusal", async () => {
    const { json } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mission: created, main } = mission();
    const added = (await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "fact", text: "CI runs on Node 22", source: "ci.yml" }, main))["added"] as Record<string, string>;
    mkdirSync(join(home, "missions", `${created.missionId}.journal.jsonl`));
    expect(await json("manager", "bm_memory", { project: "wks-a", op: "remove", id: added.id, why: "Outdated" }, main)).toEqual({ removed: added.id });
    expect(createMemoryStore(home).active("wks-a")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`the journal of mission ${created.missionId} could not record a note line`));
    warn.mockRestore();
  });

  it("refuses a repo outside the charter, a caller that is not a Main, missing op fields and an add past 300", async () => {
    const { call } = setup();
    const { main } = mission();
    const outside = await call("manager", "bm_memory", { project: "wks-c", op: "read" }, main);
    expect(outside.ok).toBe(false);
    expect(outside.text).toContain("project wks-c is not a repo of mission WEB (wks-a, wks-b)");
    expect(await call("manager", "bm_memory", { project: "wks-a", op: "read" }, null)).toEqual({ ok: false, text: MEMORY_NOT_BOUND_MESSAGE });
    expect(await call("manager", "bm_memory", { project: "wks-a", op: "read" }, caller({ agentId: "other" }))).toEqual({ ok: false, text: NOT_A_MAIN_MESSAGE });
    const missing = await call("manager", "bm_memory", { project: "wks-a", op: "remove" }, main);
    expect(missing.text).toContain("input.id: remove needs it");
    expect(missing.text).toContain("input.why: remove needs it");
    expect((await call("manager", "bm_memory", { project: "wks-a", op: "add", kind: "precedent", text: "x", source: "y" }, main)).ok).toBe(false);

    fillMemory(home, "wks-b", MAX_ACTIVE_MEMORY, () => ({ by: { role: "main", agentId: MAIN, missionId: null } }));
    const full = await call("manager", "bm_memory", { project: "wks-b", op: "add", kind: "fact", text: "one more", source: "test" }, main);
    expect(full).toEqual({ ok: false, text: `${MEMORY_FULL_REASON}\nNothing was stored.` });
  });

  it("shows the owner's precedents of the repo as precedent entries, read through and never copied", async () => {
    const { json } = setup();
    const { main } = mission();
    createPrecedentStore(home).save({ scope: "wks-a", subject: "push-backends", text: "Push contract only", sourceDecisionId: "q:req-20261009T100000Z:Q1", expiresInDays: 30 }, NOW);
    const read = await json("manager", "bm_memory", { project: "wks-a", op: "read" }, main);
    expect(read["index"]).toEqual([]);
    expect(read["precedents"]).toEqual([expect.objectContaining({ kind: "precedent", text: "push-backends: Push contract only", source: "q:req-20261009T100000Z:Q1", by: "owner" })]);
    const queried = (await json("manager", "bm_memory", { project: "wks-a", op: "read", query: "contract" }, main))["entries"];
    expect(queried).toEqual([expect.objectContaining({ kind: "precedent", by: "owner" })]);
    expect(createMemoryStore(home).list("wks-a")).toEqual([]);
  });
});

describe("bm_memory reads a summary first (delivery line design §18.3)", () => {
  it("gives an index newest first with cut text, a query in full, an id, and retired entries only when asked", async () => {
    const { call, json } = setup();
    const { main } = mission();
    const long = `Money is integer cents everywhere. ${"x".repeat(400)}`;
    const first = (await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "convention", text: long, source: "docs/prd.md" }, main))["added"] as Record<string, string>;
    await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "fact", text: "CI runs on Node 22", source: "ci.yml", scope: "repo" }, main);
    fillMemory(home, "wks-a", MEMORY_INDEX_ENTRIES + 5, (n) => ({ kind: "convention", text: `rule ${n}`, at: new Date(NOW.getTime() - (n + 1) * 1000).toISOString() }));
    const index = await json("manager", "bm_memory", { project: "wks-a", op: "read" }, main);
    const lines = index["index"] as Array<Record<string, string>>;
    expect(lines).toHaveLength(MEMORY_INDEX_ENTRIES);
    expect(index).toMatchObject({ live: MEMORY_INDEX_ENTRIES + 7, retired: 0, more: "7 older entries: read with a query or an id" });
    expect(lines[0]).toMatchObject({ kind: "fact", scope: "repo", text: "CI runs on Node 22" });
    expect(lines[0]).not.toHaveProperty("source");
    const cut = lines.find((line) => line.id === first.id)!.text!;
    expect(cut).toHaveLength(MEMORY_INDEX_TEXT);
    expect(cut.endsWith("…")).toBe(true);
    const queried = await json("manager", "bm_memory", { project: "wks-a", op: "read", query: "rule" }, main);
    expect(queried["entries"] as unknown[]).toHaveLength(MEMORY_QUERY_ENTRIES);
    expect(queried["more"]).toBe(MEMORY_INDEX_ENTRIES + 5 - MEMORY_QUERY_ENTRIES);
    expect((await json("manager", "bm_memory", { project: "wks-a", op: "read", id: first.id }, main))["entry"]).toMatchObject({ id: first.id, text: long, source: "docs/prd.md" });
    const unknown = await call("manager", "bm_memory", { project: "wks-a", op: "read", id: "mem-ffffffffff" }, main);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("memory entry mem-ffffffffff is not an active entry of wks-a");
  });

  it("retires an entry by subject on add, names it, and shows it again with retired: true", async () => {
    const { json } = setup();
    const { main } = mission();
    const old = (await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "contract", text: "GET /users v1", source: "api.md", subject: "Users API" }, main))["added"] as Record<string, string>;
    const later = new Date(NOW.getTime() + 1000);
    const tools = createMemoryTools({ paseo: () => fakePaseo({ workspaces: [{ id: "wks-a", directory: repoA }] }).paseo, home: () => home, now: () => later, git, env: {} });
    const answer = await tools.manager.call("bm_memory", { project: "wks-a", op: "add", kind: "contract", text: "GET /users v2", source: "api.md", subject: "users api" }, main);
    const added = JSON.parse(answer.text) as Record<string, unknown>;
    expect(added).toMatchObject({ added: { subject: "users api", scope: "repo" }, live: 1, retires: [old.id] });
    const plain = await json("manager", "bm_memory", { project: "wks-a", op: "read", query: "users" }, main);
    expect((plain["entries"] as Array<{ text: string }>).map((entry) => entry.text)).toEqual(["GET /users v2"]);
    const all = await json("manager", "bm_memory", { project: "wks-a", op: "read", query: "users", retired: true }, main);
    expect(all["entries"]).toEqual([expect.objectContaining({ text: "GET /users v2" }), expect.objectContaining({ id: old.id, retired: "superseded" })]);
    expect((await json("manager", "bm_memory", { project: "wks-a", op: "read", id: old.id }, main))["entry"]).toMatchObject({ id: old.id, retired: "superseded" });
  });

  it("says when a mission entry leaves a repo entry of the same subject live", async () => {
    const { json } = setup();
    const { main } = mission();
    const rule = (await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "convention", text: "Dates are ISO-8601", source: "AGENTS.md", subject: "date-format" }, main))["added"] as Record<string, string>;
    const later = new Date(NOW.getTime() + 1000);
    const tools = createMemoryTools({ paseo: () => fakePaseo({ workspaces: [{ id: "wks-a", directory: repoA }] }).paseo, home: () => home, now: () => later, git, env: {} });
    const answer = JSON.parse((await tools.manager.call("bm_memory", { project: "wks-a", op: "add", kind: "decision", text: "This mission shows dd/mm", source: "owner chat", subject: "date-format" }, main)).text) as Record<string, unknown>;
    expect(answer).toMatchObject({ added: { scope: "mission" }, live: 2, stillLive: [rule.id] });
    expect(answer["note"]).toBe(`${rule.id} (repo) keeps holding for later missions; add with scope repo to replace it.`);
    expect(answer).not.toHaveProperty("retires");
  });

  it("keeps a closed mission's entries out of reads, and its repo entries in", async () => {
    const { json } = setup();
    const { mission: created, main } = mission();
    await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "fact", text: "Merged into dev at abc123", source: "out-1" }, main);
    await json("manager", "bm_memory", { project: "wks-a", op: "add", kind: "convention", text: "Use yarn", source: "README" }, main);
    createMissionStore(home, { now: () => NOW }).update(created.missionId, (current) => ({ ...current, state: "closed", closedAt: NOW.toISOString() }));
    const next = mission();
    const read = await json("manager", "bm_memory", { project: "wks-a", op: "read" }, next.main);
    expect((read["index"] as Array<{ text: string }>).map((entry) => entry.text)).toEqual(["Use yarn"]);
    expect(read).toMatchObject({ live: 1, retired: 1 });
  });
});

describe("bm_memory for a Worker (§5)", () => {
  it("reads and adds a fact in its own repo only; never removes", async () => {
    const { call, json } = setup();
    const added = (await json("worker", "bm_memory", { op: "add", kind: "fact", text: "The API paginates with ?page", source: "src/routes.ts" }, WORKER))["added"] as Record<string, string>;
    expect(added).toMatchObject({ kind: "fact", by: "worker" });
    expect(((await json("worker", "bm_memory", { project: "wks-a", op: "read" }, WORKER))["index"] as unknown[]).length).toBe(1);
    expect((await call("worker", "bm_memory", { project: "wks-b", op: "read" }, WORKER)).text).toContain("your own repo's memory only (wks-a)");
    expect((await call("worker", "bm_memory", { op: "remove", id: added.id, why: "x" }, WORKER)).ok).toBe(false);
    expect((await call("worker", "bm_memory", { op: "add", kind: "decision", text: "x", source: "y" }, WORKER)).ok).toBe(false);
    expect(await call("worker", "bm_memory", { op: "read" }, null)).toEqual({ ok: false, text: MEMORY_NOT_BOUND_MESSAGE });
  });
});

describe("automatic entries (§2.5)", () => {
  it("adds a decision entry when the owner answers a request's question, and supersedes it when answered again", () => {
    const decisions = createDecisionStore(home, { log: () => {} });
    const question = makeDecision({ workspaceId: "wks-a", requestId: "req-20261009T100000Z", id: "q:req-20261009T100000Z:Q1" });
    decisions.open(question);
    decisions.transition(question.id, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: NOW.toISOString() }));
    // A later write of the answered decision (its delivery) adds nothing.
    decisions.transition(question.id, (current) => ({ ok: true, decision: { ...current, delivery: { to: "wrk-1", kind: "answers", at: NOW.toISOString(), outcome: "sent" } } }));
    const [entry] = createMemoryStore(home).active("wks-a");
    expect(createMemoryStore(home).active("wks-a")).toHaveLength(1);
    expect(entry).toMatchObject({ kind: "decision", text: "Push both backends to origin/dev? — the owner: Push contract only", source: `the owner's answer to ${question.id}`, by: { role: "plugin", agentId: null, missionId: null } });

    decisions.transition(question.id, (current) => ({ ok: true, decision: { ...current, status: "open", settledAt: null, answer: null, grant: null } }));
    decisions.transition(question.id, (current) => answerDecision(current, { via: "chat-worker", words: "Hold until Monday", at: NOW.toISOString() }));
    const active = createMemoryStore(home).active("wks-a");
    expect(active.map((found) => found.text)).toEqual(["Push both backends to origin/dev? — the owner: Hold until Monday"]);
    expect(active[0]!.supersedes).toBe(entry!.id);
  });

  it("adds nothing for an answer that is not the owner's", () => {
    const decisions = createDecisionStore(home, { log: () => {} });
    const question = makeDecision({ workspaceId: "wks-a" });
    decisions.open(question);
    decisions.transition(question.id, (current) => answerDecision(current, { by: "policy", via: "inbox", optionKey: "c", at: NOW.toISOString() }));
    expect(createMemoryStore(home).list("wks-a")).toEqual([]);
  });
});

describe("bm_repo for a Main (§4)", () => {
  it("reads a window of a file's lines and runs git in a charter repo", async () => {
    const { call } = setup();
    const { main } = mission();
    const read = await call("manager", "bm_repo", { workspaceId: "wks-a", action: "read", path: "docs/prd.md", from: 3, lines: 2 }, main);
    expect(read).toEqual({ ok: true, text: "docs/prd.md lines 3–4 of 10 (as it is now) — in . of project wks-a\n\nline 3\nline 4" });
    expect((await call("manager", "bm_repo", { workspaceId: "wks-a", action: "status" }, main)).text).toContain("## dev");
    expect(gitCalls.some((args) => args.includes("status"))).toBe(true);
  });

  it("refuses a repo outside the charter, a path outside the repo, a secret-shaped file and a caller that is not a Main", async () => {
    const { call } = setup();
    const { main } = mission();
    expect((await call("manager", "bm_repo", { workspaceId: "wks-c", action: "status" }, main)).text).toContain("project wks-c is not a repo of mission WEB");
    expect((await call("manager", "bm_repo", { workspaceId: "wks-a", action: "read", path: "../web/x.md" }, main)).text).toBe("../web/x.md is outside the project's folder. Nothing was read.");
    expect((await call("manager", "bm_repo", { workspaceId: "wks-a", action: "read", path: "credentials.json" }, main)).text).toBe("credentials.json may hold secrets; bm_repo does not read it. Nothing was read.");
    expect((await call("manager", "bm_repo", { workspaceId: "wks-a", action: "read", path: "docs/prd.md", from: 11 }, main)).text).toBe("docs/prd.md has 10 lines. Nothing was read.");
    expect(await call("manager", "bm_repo", { workspaceId: "wks-a", action: "status" }, caller({ agentId: "other" }))).toEqual({ ok: false, text: NOT_A_MAIN_MESSAGE });
    expect(await call("manager", "bm_repo", { workspaceId: "wks-a", action: "status" }, WORKER)).toEqual({ ok: false, text: MEMORY_NOT_BOUND_MESSAGE });
  });
});
