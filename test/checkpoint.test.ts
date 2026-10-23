import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import {
  CHECKPOINT_BRANCH_PREFIX,
  PLACEMENT_MODE_FILE_NAME,
  checkpointBaseOf,
  checkpointOffers,
  checkpointWaitOf,
  cutOverSince,
  latestCheckpointOf,
  makeCheckpoint,
  rootDiffersFrom,
  runCheckpointGit,
  statusPathsOf,
  writeCutOver,
  type CheckpointGit,
} from "../plugin/server/checkpoint";
import { CHECKPOINT_SUBJECT, isCheckpointCard, offerCheckpoints } from "../plugin/server/checkpoint-card";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster, requestIndexOf } from "../plugin/server/mission-roster";
import { MISSIONS_DIR_NAME, createMissionStore, type Mission } from "../plugin/server/mission-store";
import { createOutbox } from "../plugin/server/outbox";
import { placementModeOn } from "../plugin/server/placement-create";
import { runGit } from "../plugin/server/repo-tool";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { appendRecord, clearTraceStoreCache, readRecords } from "../plugin/server/trace-store";
import { turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The migration of missions on a shared checkout (delivery line design §4.8):
 * the checkpoint over a real temporary git repository leaves the owner's
 * HEAD, index and working tree byte for byte as they were and holds the dirty
 * and untracked state on one new branch, ignored files left out; the
 * read-only comparison with it; the cut-over file; a moved request keeps its
 * registry, outbox and traces readable; the owner-only card, its tap and the
 * follow-up offer.
 */

const NOW = new Date("2026-10-21T10:00:00.000Z");
const BEFORE = new Date("2026-10-01T09:00:00.000Z");
const REPO = "wks_repo";
const PLACEMENT = "wks_wt_1";
const REQ = "req-20261001T090000Z";

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
  clearRequestIndexCache();
  clearJsonFileCache();
  clearTraceStoreCache();
  removeDataFolders();
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/**
 * A shared checkout as missions leave it: committed files, a modified one, a
 * deleted one, one staged and then changed again, untracked files, and
 * ignored files and folders.
 */
function sharedCheckout(): string {
  const home = dataFolder("bm-checkpoint-");
  const root = join(dirname(home), "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "develop");
  git(root, "config", "user.name", "Owner");
  git(root, "config", "user.email", "owner@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), "*.log\nbuild/\n");
  writeFileSync(join(root, "a.txt"), "a1\n");
  writeFileSync(join(root, "b.txt"), "b1\n");
  writeFileSync(join(root, "gone.txt"), "gone\n");
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "a.txt"), "a2 — Worker of mission ABC\n");
  unlinkSync(join(root, "gone.txt"));
  writeFileSync(join(root, "b.txt"), "b2 staged\n");
  git(root, "add", "b.txt");
  writeFileSync(join(root, "b.txt"), "b3 changed after staging\n");
  writeFileSync(join(root, "src", "new.ts"), "export const fresh = 1;\n");
  writeFileSync(join(root, "debug.log"), "ignored\n");
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build", "out.js"), "ignored too\n");
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
    refs: git(root, "for-each-ref", "--format=%(refname)").split("\n"),
  };
}

/** The checkpoint git, recording each call's temporary index. */
function recordingGit(fail?: string): CheckpointGit & { indexes: string[]; calls: string[][] } {
  const indexes: string[] = [];
  const calls: string[][] = [];
  const run = (async (args, options) => {
    calls.push([...args]);
    indexes.push(options.env["GIT_INDEX_FILE"] ?? "");
    if (fail !== undefined && args.includes(fail)) throw new Error(`git ${fail} failed: refused by the test`);
    return runCheckpointGit(args, options);
  }) as CheckpointGit & { indexes: string[]; calls: string[][] };
  run.indexes = indexes;
  run.calls = calls;
  return run;
}

describe("the checkpoint (§4.8 step 2): objects and one ref, the owner's HEAD, index and tree untouched", () => {
  it("leaves HEAD, .git/index and the working tree byte-identical and holds the dirty, untracked-but-not-ignored state", async () => {
    const root = sharedCheckout();
    const before = ownerState(root);
    const recorder = recordingGit();

    const made = await makeCheckpoint(root, { now: NOW, message: "paseo-bm checkpoint", git: recorder });

    const after = ownerState(root);
    expect(after.headFile).toBe(before.headFile);
    expect(after.head).toBe(before.head);
    expect(after.index).toBe(before.index);
    expect(after.tree).toEqual(before.tree);
    expect(after.status).toBe(before.status);
    // One new ref, the branch; nothing pushed, no other ref.
    expect(after.refs).toEqual([...before.refs, "refs/heads/bm/checkpoint-20261021"].sort());
    expect(made).toMatchObject({ branch: "bm/checkpoint-20261021", parents: [before.head] });
    expect(git(root, "rev-parse", "bm/checkpoint-20261021")).toBe(made.commit);
    expect(git(root, "rev-parse", "bm/checkpoint-20261021^")).toBe(before.head);
    // The working tree's state, not the index's: b.txt as changed after staging.
    expect(git(root, "show", "bm/checkpoint-20261021:a.txt")).toBe("a2 — Worker of mission ABC");
    expect(git(root, "show", "bm/checkpoint-20261021:b.txt")).toBe("b3 changed after staging");
    expect(git(root, "show", "bm/checkpoint-20261021:src/new.ts")).toBe("export const fresh = 1;");
    const files = git(root, "ls-tree", "-r", "--name-only", "bm/checkpoint-20261021").split("\n");
    expect(files.sort()).toEqual([".gitignore", "a.txt", "b.txt", "src/main.ts", "src/new.ts"]);
    // The temporary index lived outside the repository and is gone.
    const index = recorder.indexes.find((path) => path !== "")!;
    expect(index.startsWith(join(root, ".git"))).toBe(false);
    expect(recorder.indexes.every((path) => path === index)).toBe(true);
    expect(existsSync(dirname(index))).toBe(false);
    expect(recorder.calls.map((args) => args.find((arg) => ["rev-parse", "read-tree", "add", "write-tree", "config", "commit-tree", "branch", "merge-base"].includes(arg)))).toEqual([
      "rev-parse",
      "read-tree",
      "add",
      "write-tree",
      "config",
      "commit-tree",
      "rev-parse",
      "branch",
    ]);
  });

  it("a taken name gets -2; a follow-up is parented on the previous checkpoint, the owner's HEAD still untouched", async () => {
    const root = sharedCheckout();
    const first = await makeCheckpoint(root, { now: NOW, message: "first" });
    writeFileSync(join(root, "a.txt"), "a3 — after the checkpoint\n");
    const before = ownerState(root);

    const follow = await makeCheckpoint(root, { now: NOW, message: "follow-up", parent: first.branch });

    expect(follow.branch).toBe("bm/checkpoint-20261021-2");
    expect(follow.parents).toEqual([first.commit]);
    expect(git(root, "rev-parse", `${follow.branch}^`)).toBe(first.commit);
    expect(git(root, "show", `${follow.branch}:a.txt`)).toBe("a3 — after the checkpoint");
    expect(git(root, "diff", "--name-only", first.branch, follow.branch)).toBe("a.txt");
    const after = ownerState(root);
    expect({ ...after, refs: null }).toEqual({ ...before, refs: null });
  });

  it("a git refusal leaves no branch and no temporary index; an unborn checkout is refused", async () => {
    const root = sharedCheckout();
    const before = ownerState(root);
    const recorder = recordingGit("write-tree");
    await expect(makeCheckpoint(root, { now: NOW, message: "m", git: recorder })).rejects.toThrow(/write-tree failed/);
    expect(existsSync(dirname(recorder.indexes.find((path) => path !== "")!))).toBe(false);
    expect(ownerState(root)).toEqual(before);

    const empty = join(dirname(root), "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    const unborn = recordingGit();
    await expect(makeCheckpoint(empty, { now: NOW, message: "m", git: unborn })).rejects.toThrow(/no commit yet/);
    expect(existsSync(dirname(unborn.indexes[0]!))).toBe(false);
  });
});

describe("the read-only comparison with a checkpoint (§4.8 step 5)", () => {
  it("is false right after it, true for a changed or new file, false for an ignored one; it writes nothing", async () => {
    const root = sharedCheckout();
    const made = await makeCheckpoint(root, { now: NOW, message: "m" });
    const before = ownerState(root);
    expect(await rootDiffersFrom(runGit, root, made.branch)).toBe(false);
    expect(ownerState(root)).toEqual(before);

    writeFileSync(join(root, "debug.log"), "still ignored\n");
    expect(await rootDiffersFrom(runGit, root, made.branch)).toBe(false);
    writeFileSync(join(root, "src", "later.ts"), "export {};\n");
    expect(await rootDiffersFrom(runGit, root, made.branch)).toBe(true);
    rmSync(join(root, "src", "later.ts"));
    expect(await rootDiffersFrom(runGit, root, made.branch)).toBe(false);
    writeFileSync(join(root, "b.txt"), "b4\n");
    expect(await rootDiffersFrom(runGit, root, made.branch)).toBe(true);
  });

  it("reads both sides of a rename in -z status output", () => {
    expect(statusPathsOf(" M a.txt\0R  new name.txt\0old name.txt\0?? x\0")).toEqual(["a.txt", "new name.txt", "old name.txt", "x"]);
  });
});

describe("the cut-over (§4.8 step 1)", () => {
  it("writes missions/placement-mode.json { since } once and never rewrites it", () => {
    const home = dataFolder();
    expect(placementModeOn(home)).toBe(false);
    expect(writeCutOver(home, NOW, () => {})).toBe(true);
    expect(JSON.parse(readFileSync(join(home, MISSIONS_DIR_NAME, PLACEMENT_MODE_FILE_NAME), "utf8"))).toEqual({ since: NOW.toISOString() });
    expect(writeCutOver(home, new Date("2026-11-01T00:00:00.000Z"), () => {})).toBe(false);
    expect(cutOverSince(home)).toBe(NOW.toISOString());
    expect(placementModeOn(home)).toBe(true);
  });

  it("a file without since switches placements on but dates no mission before it", () => {
    const home = dataFolder();
    mkdirSync(join(home, MISSIONS_DIR_NAME), { recursive: true });
    writeFileSync(join(home, MISSIONS_DIR_NAME, PLACEMENT_MODE_FILE_NAME), "{}\n");
    expect(placementModeOn(home)).toBe(true);
    expect(cutOverSince(home)).toBeNull();
  });
});

describe("registry.move (§4.8 step 5): a handed-off request from before the cut-over", () => {
  it("moves the registry entry and the roster's workspace; the registry, outbox and traces stay readable", async () => {
    const home = dataFolder();
    const mission = createMissionStore(home, { now: () => BEFORE }).create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "agent-main" });
    if (!mission.ok) throw new Error(mission.reasons.join("; "));
    const missionId = mission.mission.missionId;
    const registry = createRequestRegistry(home, { now: () => BEFORE, backfill: () => [] });
    registry.register(REPO, REQ, { source: "agent-typed", managerId: "agent-main", workerId: "w1" });
    registry.addReviewCall(REPO, REQ, "b1", { callId: "c1", kind: "create", reviewerId: "r1", at: BEFORE.toISOString() }, "Review the plan.");
    registry.noteReport(REPO, REQ, { tier: "Medium", phase: "blocked", at: BEFORE.toISOString() });
    createMissionRoster(home, { now: () => BEFORE }).add(missionId, { requestId: REQ, workspaceId: REPO, topic: "the export", workerId: "w1" });
    const record = createOutbox(home, { now: () => BEFORE }).add(REPO, { kind: "report", requestId: REQ, from: "w1", to: "agent-main", text: "phase: blocked" });
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: REPO, agentId: "w1", role: "worker", requestId: REQ, at: BEFORE.toISOString(), endedAt: BEFORE.toISOString() }));
    const kept = registry.get(REPO, REQ)!;

    expect(createRequestRegistry(home, { now: () => NOW, backfill: () => [] }).move(REPO, PLACEMENT, REQ)).toBe("moved");
    expect(createMissionRoster(home).moveWorkspace(missionId, REQ, PLACEMENT)).toBe(true);

    const moved = createRequestRegistry(home).get(PLACEMENT, REQ);
    expect(moved).toEqual({ ...kept, workspaceId: PLACEMENT, movedFrom: [{ workspaceId: REPO, at: NOW.toISOString() }] });
    expect(createRequestRegistry(home).get(REPO, REQ)).toBeNull();
    expect(requestIndexOf(home, REQ)).toEqual({ missionId, workspaceId: PLACEMENT });
    expect(createMissionRoster(home).get(missionId, REQ)).toMatchObject({ workspaceId: PLACEMENT, workerIds: ["w1"], topic: "the export" });
    // Where they were written: under the workspace the request moved out of.
    expect(createOutbox(home).list(REPO).map((entry) => entry.id)).toEqual([record.id]);
    expect(readRecords({ tracesDir: join(home, "traces") }, REPO).records.map((entry) => entry.requestId)).toEqual([REQ]);
    // Twice is refused, and a request the target holds is never overwritten.
    expect(createRequestRegistry(home).move(REPO, PLACEMENT, REQ)).toBe("no-request");
    createRequestRegistry(home, { backfill: () => [] }).register(REPO, "req-20261002T090000Z", { source: "agent-typed" });
    createRequestRegistry(home, { backfill: () => [] }).register(PLACEMENT, "req-20261002T090000Z", { source: "agent-typed" });
    expect(createRequestRegistry(home).move(REPO, PLACEMENT, "req-20261002T090000Z")).toBe("taken");
    expect(createRequestRegistry(home).get(REPO, "req-20261002T090000Z")).not.toBeNull();
  });
});

describe("the owner's checkpoint card (§4.8 steps 2–5)", () => {
  /** A data folder after the cut-over, one mission from before it on the shared checkout, and a fake Paseo listing the root. */
  function world(options: { workerRunning?: boolean } = {}) {
    const root = sharedCheckout();
    const home = join(dirname(root), ".paseo-bm");
    writeCutOver(home, NOW, () => {});
    const made = createMissionStore(home, { now: () => BEFORE }).create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "agent-main" });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const mission: Mission = made.mission;
    createMissionRoster(home, { now: () => BEFORE }).add(mission.missionId, { requestId: REQ, workspaceId: REPO, topic: "the export", workerId: "w1" });
    createRequestRegistry(home, { now: () => BEFORE, backfill: () => [] }).register(REPO, REQ, { source: "tool", managerId: "agent-main", workerId: "w1" });
    const fake = fakePaseo({
      agents: [{ id: "w1", provider: "bm-worker/claude-opus-5", status: options.workerRunning === true ? "running" : "idle", workspaceId: REPO, labels: { "bm.role": "worker" }, archivedAt: options.workerRunning === true ? null : NOW.toISOString() }],
      workspaces: [{ id: REPO, directory: root, projectId: "prj_repo" }],
    });
    return { root, home, mission, paseo: fake.paseo, fake };
  }

  const deps = { log: () => {}, now: () => NOW };

  it("offers an owner-only card once no mission Worker runs in the root; the tap makes the branch, placements branch from it", async () => {
    const { root, home, mission, paseo } = world();
    const head = git(root, "rev-parse", "HEAD");
    // Before the card exists, the mission has no worktree yet (its Workers work in the root meanwhile).
    expect(await checkpointWaitOf(home, runGit, mission, REPO, root, "repo")).toBe("paseo-bm asks the owner to checkpoint the shared checkout of repo first");

    const [id] = await offerCheckpoints(home, paseo, deps);
    expect(await offerCheckpoints(home, paseo, deps)).toEqual([]);
    const card = createMissionDecisionStore(home).get(id!)!;
    expect(card).toMatchObject({ ownerOnly: true, class: "data", subject: CHECKPOINT_SUBJECT, askedBy: { role: "plugin", agentId: null }, workspaceId: mission.missionId });
    expect(card.options.map((option) => [option.key, option.label, option.recommended])).toEqual([
      ["a", "Checkpoint now", true],
      ["b", "Not now", false],
    ]);
    expect(card.question).toContain("without touching your HEAD, index or working tree");
    expect(card.question).toContain("Then, yours: push the checkpoint branch and merge its own merge request first; each mission's merge request then shows only its own changes.");
    expect(isCheckpointCard(home, card)).toBe(true);
    expect(await checkpointWaitOf(home, runGit, mission, REPO, root, "repo")).toBe(`the owner's checkpoint card ${id!} for the shared checkout of repo waits for their answer`);
    // Nothing was written into the repository by the offer.
    expect(git(root, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/develop");

    const before = ownerState(root);
    const answered = await handleDecisionsAnswer({ id: id!, optionKey: "a" }, paseo, { home, now: () => NOW, log: () => {} });
    expect(answered.decision.status).toBe("answered");
    expect(ownerState(root)).toEqual({ ...before, refs: [...before.refs, "refs/heads/bm/checkpoint-20261021"].sort() });
    expect(git(root, "rev-parse", "bm/checkpoint-20261021^")).toBe(head);
    expect(latestCheckpointOf(home, REPO)).toMatchObject({ branch: "bm/checkpoint-20261021", at: NOW.toISOString() });
    expect(checkpointOffers(home, REPO)[0]!.outcome).toMatchObject({ kind: "made", branch: "bm/checkpoint-20261021" });
    // The branch, never its sha (spike S1); the mission no longer waits.
    expect(checkpointBaseOf(home, mission, REPO)).toBe(`${CHECKPOINT_BRANCH_PREFIX}20261021`);
    expect(await checkpointWaitOf(home, runGit, mission, REPO, root, "repo")).toBeNull();
    // A mission created after the checkpoint branches from the integration branch.
    expect(checkpointBaseOf(home, { createdAt: "2026-10-22T00:00:00.000Z" }, REPO)).toBeNull();
    expect(createMissionStore(home).journal(mission.missionId).map((line) => line.text).join("\n")).toContain("as the branch bm/checkpoint-20261021");
  });

  it("while a mission Worker runs a turn in the root: 'Ask me again once they finish' or 'Checkpoint now anyway' with the warning; asked again once it is idle", async () => {
    const { root, home, mission, paseo, fake } = world({ workerRunning: true });
    const [id] = await offerCheckpoints(home, paseo, deps);
    const card = createMissionDecisionStore(home).get(id!)!;
    expect(card.options.map((option) => option.label)).toEqual(["Ask me again once they finish", "Checkpoint now anyway"]);
    expect(card.question).toContain(`Still working in it: ${REQ} (mission ABC). A checkpoint now misses what they change later; that needs a follow-up checkpoint.`);

    await handleDecisionsAnswer({ id: id!, optionKey: "a" }, paseo, { home, now: () => NOW, log: () => {} });
    expect(checkpointOffers(home, REPO)[0]!.outcome?.kind).toBe("later");
    expect(git(root, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/develop");
    // Meanwhile the mission works in the root (no worktree yet).
    expect(await checkpointWaitOf(home, runGit, mission, REPO, root, "repo")).toBe("the owner asked to checkpoint the shared checkout of repo once no mission Worker works in it");
    // Asked again only once none runs a turn.
    expect(await offerCheckpoints(home, paseo, deps)).toEqual([]);
    // Idle between turns (not archived, its request not finished) holds the offer back no longer.
    fake.agents.find((agent) => agent.id === "w1")!.status = "idle";
    const [again] = await offerCheckpoints(home, paseo, deps);
    expect(again).toBeDefined();
    const next = createMissionDecisionStore(home).get(again!)!;
    expect(next.options.map((option) => option.label)).toEqual(["Checkpoint now", "Not now"]);
    expect(next.question).not.toContain("Still working in it");
  });

  it("a checkpoint that cannot be made answers nothing and leaves the card open", async () => {
    const { root, home, paseo } = world();
    const [id] = await offerCheckpoints(home, paseo, deps);
    rmSync(root, { recursive: true, force: true });
    await expect(handleDecisionsAnswer({ id: id!, optionKey: "a" }, paseo, { home, now: () => NOW, log: () => {} })).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
    expect(createMissionDecisionStore(home).get(id!)!.status).toBe("open");
    expect(checkpointOffers(home, REPO)[0]!.outcome).toBeUndefined();
  });

  it("offers a follow-up, parented on the checkpoint, when a request in the root finished with changes after it", async () => {
    const { root, home, paseo } = world();
    const [id] = await offerCheckpoints(home, paseo, deps);
    await handleDecisionsAnswer({ id: id!, optionKey: "a" }, paseo, { home, now: () => NOW, log: () => {} });
    const later = new Date("2026-10-21T12:00:00.000Z");
    const at = { log: () => {}, now: () => later };
    // Finished, but nothing changed since the checkpoint: no follow-up.
    createRequestRegistry(home).noteReport(REPO, REQ, { tier: "Small", phase: "finished", at: "2026-10-21T11:00:00.000Z" });
    expect(await offerCheckpoints(home, paseo, at)).toEqual([]);
    writeFileSync(join(root, "a.txt"), "a4 — the shared-tree Worker went on\n");
    const [follow] = await offerCheckpoints(home, paseo, at);
    const card = createMissionDecisionStore(home).get(follow!)!;
    expect(card.question).toContain(`${REQ} (mission ABC) finished with changes in the shared checkout of repo`);
    expect(card.question).toContain("parented on bm/checkpoint-20261021");
    expect(card.options[0]!.label).toBe("Make the follow-up checkpoint");

    await handleDecisionsAnswer({ id: follow!, optionKey: "a" }, paseo, { home, now: () => later, log: () => {} });
    expect(git(root, "rev-parse", "bm/checkpoint-20261021-2^")).toBe(git(root, "rev-parse", "bm/checkpoint-20261021"));
    expect(latestCheckpointOf(home, REPO)?.branch).toBe("bm/checkpoint-20261021-2");
    expect(await rootDiffersFrom(runGit, root, "bm/checkpoint-20261021-2")).toBe(false);
  });

  it("'Not now' is final: no checkpoint, the missions branch from the integration branch", async () => {
    const { root, home, mission, paseo } = world();
    const [id] = await offerCheckpoints(home, paseo, deps);
    await handleDecisionsAnswer({ id: id!, optionKey: "b" }, paseo, { home, now: () => NOW, log: () => {} });
    expect(checkpointOffers(home, REPO)[0]!.outcome?.kind).toBe("declined");
    expect(git(root, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/develop");
    expect(await checkpointWaitOf(home, runGit, mission, REPO, root, "repo")).toBeNull();
    expect(checkpointBaseOf(home, mission, REPO)).toBeNull();
    expect(await offerCheckpoints(home, paseo, deps)).toEqual([]);
  });
});
