import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { clearBindingCache, createBindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { runSnapshotGit, snapshotTree, type CheckpointGit } from "../plugin/server/checkpoint";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry, noteReviewResult } from "../plugin/server/request-registry";
import { REREVIEW_DIFF_MAX_CHARS, createReviewTools, fixDiffOf } from "../plugin/server/review-tools";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { toolNamed } from "../plugin/shared/bm-tools";
import { reviewCallIdOf, reviewerBriefLineOf } from "../plugin/shared/notices";
import { WORKER_CALLER } from "./helpers/bindings";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * Re-reviews on the fix diff (delivery line design §17.2, ADR-036), over a
 * real temporary git repository: the snapshot of a review call writes a tree
 * object and leaves the owner's HEAD, index bytes, working tree and refs as
 * they were; bm_create_reviewer and bm_rereview record their trees; a
 * re-review creates a fresh Reviewer whose brief holds the previous blocking
 * findings verbatim, the files changed since the last call and their diff,
 * inline up to the bound, else the command.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T10:05:00.000Z");

// The owner's own git configuration (signing, hooks, maintenance) stays out of these repositories.
const saved = { global: process.env["GIT_CONFIG_GLOBAL"], system: process.env["GIT_CONFIG_NOSYSTEM"] };
beforeAll(() => {
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});
afterAll(() => {
  for (const [name, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  forgetModes();
  removeDataFolders();
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A Worker's checkout: a commit, a staged change changed again, an untracked file, an ignored one. */
function checkout(home: string): string {
  const root = join(dirname(home), "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "develop");
  git(root, "config", "user.name", "Owner");
  git(root, "config", "user.email", "owner@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "src", "date.ts"), "export const format = 'en';\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "src", "date.ts"), "export const format = 'staged';\n");
  git(root, "add", "src/date.ts");
  writeFileSync(join(root, "src", "date.ts"), "export const format = locale;\n");
  writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n");
  writeFileSync(join(root, "debug.log"), "ignored\n");
  return root;
}

/** Every file of the working tree outside `.git`, with its bytes and mode. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out[relative(root, path)] = `${stat.mode}:${readFileSync(path).toString("base64")}`;
    }
  };
  walk(root);
  return out;
}

/** What the owner has: HEAD (the file and the commit), the index file's bytes, the working tree, the status, the refs. */
function ownerState(root: string) {
  return {
    headFile: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    head: git(root, "rev-parse", "HEAD"),
    index: readFileSync(join(root, ".git", "index")).toString("base64"),
    tree: treeOf(root),
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    refs: git(root, "for-each-ref", "--format=%(refname)"),
  };
}

/** The snapshot git, recording each call's temporary index. */
function recordingGit(): CheckpointGit & { indexes: string[] } {
  const indexes: string[] = [];
  const run = (async (args, options) => {
    indexes.push(options.env["GIT_INDEX_FILE"] ?? "");
    return runSnapshotGit(args, options);
  }) as CheckpointGit & { indexes: string[] };
  run.indexes = indexes;
  return run;
}

describe("the snapshot of a review call (§17.2): a tree object, the owner's HEAD, index and tree untouched", () => {
  it("writes the working tree as it is — untracked included, ignored left out — and changes nothing of the owner's", async () => {
    const root = checkout(dataFolder("bm-snapshot-"));
    const before = ownerState(root);
    const recorder = recordingGit();
    const tree = await snapshotTree(root, { git: recorder });
    expect(ownerState(root)).toEqual(before);
    expect(git(root, "cat-file", "-t", tree)).toBe("tree");
    expect(git(root, "ls-tree", "-r", "--name-only", tree).split("\n").sort()).toEqual([".gitignore", "src/date.ts", "src/new.ts"]);
    // The working tree's content, not the index's.
    expect(git(root, "show", `${tree}:src/date.ts`)).toBe("export const format = locale;");
    // The temporary index lived outside the repository and is gone.
    const index = recorder.indexes[0]!;
    expect(recorder.indexes.length).toBe(3);
    expect(recorder.indexes.every((path) => path === index)).toBe(true);
    expect(index.startsWith(root)).toBe(false);
    expect(existsSync(dirname(index))).toBe(false);
  });

  it("rejects in a folder without git, removing its temporary index", async () => {
    const folder = join(dirname(dataFolder("bm-snapshot-")), "plain");
    mkdirSync(folder);
    const recorder = recordingGit();
    await expect(snapshotTree(folder, { git: recorder })).rejects.toThrow(/read-tree failed/);
    expect(existsSync(dirname(recorder.indexes[0]!))).toBe(false);
  });

  it("fixDiffOf: the changed files and the diff of two trees; the diff null past the bound", async () => {
    const root = checkout(dataFolder("bm-snapshot-"));
    const first = await snapshotTree(root);
    writeFileSync(join(root, "src", "date.ts"), "export const format = owner.locale;\n");
    const second = await snapshotTree(root);
    const fixes = (await fixDiffOf(root, first, second))!;
    expect(fixes.stat).toContain("src/date.ts");
    expect(fixes.stat).not.toContain("src/new.ts");
    expect(fixes.diff).toContain("+export const format = owner.locale;");
    writeFileSync(join(root, "src", "big.ts"), `${"x".repeat(REREVIEW_DIFF_MAX_CHARS)}\n`);
    const third = await snapshotTree(root);
    expect(await fixDiffOf(root, second, third)).toMatchObject({ from: second, to: third, diff: null });
    expect(await fixDiffOf(root, second, "0".repeat(40))).toBeNull();
  });
});

describe("bm_rereview on the fix diff, with a fresh Reviewer (§17.2)", () => {
  function setup() {
    const home = dataFolder("bm-snapshot-");
    const root = checkout(home);
    const store = createBindingStore(home);
    const fake = fakePaseo({
      agents: [
        { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, cwd: root, labels: { "bm.role": "manager" } },
        { id: WORKER, provider: "bm-worker/claude-opus-5", status: "running", workspaceId: WS, cwd: root, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
      ],
      workspaces: [{ id: WS, directory: root }],
      config: {
        agentProfiles: [{ id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6" }],
        providers: { "bm-reviewer": { extends: "codex" }, "bm-worker": { extends: "claude" } },
        mcp: { injectIntoAgents: true },
      },
      providers: { modes: { "bm-reviewer": [{ id: "auto", colorTier: "safe" }] } },
      created: (request: FakeCreateRequest) => {
        applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "codex");
        return {};
      },
    });
    const registry = createRequestRegistry(home, { backfill: () => [] });
    registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
    registry.noteReport(WS, REQ, { tier: "Medium", phase: "received", at: T0.toISOString() });
    let clock = T0;
    let n = 0;
    const tools = createReviewTools({
      binder: () => binderOf(ROLE_URL, store, () => {}),
      paseo: () => fake.paseo,
      home: () => home,
      log: () => {},
      now: () => clock,
      queue: createNoticeQueue({ log: () => {} }),
      outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    });
    const tick = () => {
      clock = new Date(clock.getTime() + 60_000);
    };
    /** The Reviewer's BM-REVIEW of b1 as bm_review stores and records it. */
    const review = (findings: Array<{ severity: "blocking" | "non-blocking"; location: string; reason: string; suggestedFix: string }>) => {
      const text = toolNamed("bm_review")!.run({ requestId: REQ, batchId: "b1", reviewKind: "first", checked: "src/", findings, notChecked: "none" });
      if (!text.ok) throw new Error(text.issues.join("; "));
      const record = createOutbox(home, { now: () => clock }).add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: "created-1", to: WORKER, text: text.text });
      noteReviewResult(home, WS, record, () => {});
      tick();
    };
    const calls = () => createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls;
    return { home, root, fake, tools, tick, review, calls };
  }

  const INPUT = { batchId: "b1", stages: ["implementation"], scope: "src/date.ts", checks: "npm test: 12 passed." };
  const BLOCKING = { severity: "blocking" as const, location: "src/date.ts:1", reason: "The locale is hard-coded.", suggestedFix: "Read the owner's locale." };
  const SECOND = { severity: "blocking" as const, location: "src/new.ts:1", reason: "It is not exported from the index.", suggestedFix: "Export it." };

  it("records a tree at each call, and the fresh Reviewer's brief holds the findings verbatim, the changed files and the diff; the owner's state is untouched", async () => {
    const { root, fake, tools, tick, review, calls } = setup();
    const before = ownerState(root);
    expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(true);
    const first = calls()[0]!.tree!;
    expect(git(root, "cat-file", "-t", first)).toBe("tree");
    review([BLOCKING, { severity: "non-blocking", location: "src/new.ts:1", reason: "A short name.", suggestedFix: "Rename it." }, SECOND]);

    // The Worker's fix, uncommitted.
    writeFileSync(join(root, "src", "date.ts"), "export const format = owner.locale;\n");
    const fixedState = ownerState(root);
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "F1: reads the owner's locale; npm test -- test/date.test.ts passed." }, WORKER_CALLER);
    expect(JSON.parse(result.text)).toEqual({ reviewerId: "created-2", reviewCalls: "2 of 3" });
    // Objects only: the snapshot changed nothing the owner has.
    expect(ownerState(root)).toEqual(fixedState);
    expect({ ...fixedState, tree: null, index: null, status: null }).toEqual({ ...before, tree: null, index: null, status: null });
    expect(fixedState.index).toBe(before.index);

    const second = calls()[1]!.tree!;
    expect(calls().map((call) => [call.kind, call.reviewerId])).toEqual([
      ["create", "created-1"],
      ["rereview", "created-2"],
    ]);
    expect(second).not.toBe(first);
    expect(fake.sends).toEqual([]);
    const prompt = fake.creates[1]!.options.prompt!;
    expect(reviewCallIdOf(prompt)).toBe(calls()[1]!.callId);
    const lines = prompt.split("\n");
    expect(lines[0]).toBe(reviewerBriefLineOf(REQ, "b1", calls()[1]!.callId));
    expect(lines.slice(1, 11)).toEqual([
      `Re-review batch b1 of request ${REQ}: a fresh Reviewer checks only the fixes.`,
      "Previous blocking findings (verbatim):",
      "- severity: blocking",
      "  location: src/date.ts:1",
      "  reason: The locale is hard-coded.",
      "  suggestedFix: Read the owner's locale.",
      "- severity: blocking",
      "  location: src/new.ts:1",
      "  reason: It is not exported from the index.",
      "  suggestedFix: Export it.",
    ]);
    expect(prompt).not.toContain("A short name.");
    expect(lines[11]).toBe("Fixes — files changed since the last review:");
    expect(lines[12]).toMatch(/^ src\/date\.ts \| 2 \+-$/);
    expect(prompt).toContain(`The diff (up to 40,000 characters; else: git diff ${first} ${second}):\ndiff --git a/src/date.ts b/src/date.ts`);
    expect(prompt).toContain("-export const format = locale;\n+export const format = owner.locale;");
    expect(prompt).toContain("Checks the Worker ran for these files: F1: reads the owner's locale; npm test -- test/date.test.ts passed.");
    expect(lines.slice(-2)).toEqual([`requestId: ${REQ}`, "batchId: b1"]);

    // The next re-review's diff starts from this call's tree.
    review([BLOCKING]);
    tick();
    writeFileSync(join(root, "src", "big.ts"), `${"y".repeat(REREVIEW_DIFF_MAX_CHARS)}\n`);
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "F1 again." }, WORKER_CALLER)).ok).toBe(true);
    const third = calls()[2]!.tree!;
    const bounded = fake.creates[2]!.options.prompt!;
    expect(bounded).toContain(" src/big.ts | 1 +");
    expect(bounded).not.toContain("src/date.ts |");
    expect(bounded).toContain(`The diff (up to 40,000 characters; else: git diff ${second} ${third}):\n(longer than 40,000 characters: run git diff ${second} ${third} in your folder)`);
    expect(bounded).not.toContain("y".repeat(100));
    expect(bounded.length).toBeLessThan(4_000);
  });
});
