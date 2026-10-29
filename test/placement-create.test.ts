import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NO_BINDER, clearBindingCache, type ToolCaller } from "../plugin/server/agent-bindings";
import { createWorkerCreationTools, missionRepoOf } from "../plugin/server/create-worker";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { MISSIONS_DIR_NAME, createMissionStore, type Mission, type Placement } from "../plugin/server/mission-store";
import { applyMissionChange } from "../plugin/server/mission-tools";
import { listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "../plugin/server/paseo-directory";
import { addCheckpointOffer, writeCutOver } from "../plugin/server/checkpoint";
import {
  INTEGRATION_BRANCH_REFUSAL,
  PLACEMENT_MODE_FILE_NAME,
  ROOT_WAIT_BRIEF_LINE,
  SETUP_NOTE,
  MAX_LANES,
  createPlacementLifecycle,
  ensureLane,
  ensurePlacement,
  moveRequestToPlacement,
  newWorkerPlaceOf,
  openArchiveCards,
  placementBriefLines,
  placementModeOn,
  reconcilePlacements,
  successorPlacementOf,
  type CloneRunner,
  type PlacementResult,
} from "../plugin/server/placement-create";
import { placementBlockOf, placementOf, repoKeyOf } from "../plugin/server/placements";
import { GIT_READ_ONLY_PREFIX, type GitRunner } from "../plugin/server/repo-tool";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { integrationFactsOf, runtimeFactsText } from "../plugin/server/role-instructions";
import { forgetModes } from "../plugin/server/role-mode";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Mission placements made and kept (delivery line design §3.3–§3.6; spikes
 * S1 and S3): lazily at the first Worker once the cut-over file exists, under
 * a fixed request id and an exact body, with the branch checked before and
 * after, adopted after a reload, re-created from the branch after an archive;
 * the dependency clone gated on the lockfiles with a fake runner; retire,
 * archive card and the archived hook. A fake daemon that behaves as the
 * spike measured Paseo 0.11.2, a fake read-only git, temporary folders only.
 */

const NOW = new Date("2026-10-21T10:00:00.000Z");
const REPO = "wks_repo";
const PROJECT = "prj_repo";
const MAIN = "agent-main";

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearJsonFileCache();
  forgetModes();
  removeDataFolders();
});

/** The folders of a test: the data folder, the repo's root checkout (outside it) and Paseo's worktrees. */
function folders() {
  const home = dataFolder();
  const root = join(dirname(home), "repo");
  const worktrees = join(dirname(home), "worktrees");
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(root, "yarn.lock"), "left-pad@1.3.0\n");
  return { home, root, worktrees };
}

const cutOver = (home: string) => {
  mkdirSync(join(home, MISSIONS_DIR_NAME), { recursive: true });
  writeFileSync(join(home, MISSIONS_DIR_NAME, PLACEMENT_MODE_FILE_NAME), "{}\n");
};

interface GitWorld {
  upstream: string | null;
  originHead: string | null;
  local: Set<string>;
  remote: Set<string>;
  /** `<rev>:<path>` → the committed text. */
  committed: Map<string, string>;
  status: string;
  ahead: string;
  calls: string[][];
}

/** A read-only git over `world`: every call must start with the read-only prefix and be a reading subcommand. */
function fakeGit(world: GitWorld): GitRunner {
  return async (args) => {
    expect(args.slice(0, GIT_READ_ONLY_PREFIX.length)).toEqual(GIT_READ_ONLY_PREFIX);
    const command = args.slice(GIT_READ_ONLY_PREFIX.length);
    world.calls.push(command);
    expect(["rev-parse", "symbolic-ref", "show", "status", "rev-list"]).toContain(command[0]);
    const out = (stdout: string | null | undefined) => {
      if (stdout === null || stdout === undefined) throw Object.assign(new Error("fatal"), { code: 1 });
      return { stdout };
    };
    const joined = command.join(" ");
    if (joined === "rev-parse --abbrev-ref @{upstream}") return out(world.upstream === null ? null : `${world.upstream}\n`);
    if (joined === "symbolic-ref refs/remotes/origin/HEAD") return out(world.originHead === null ? null : `${world.originHead}\n`);
    if (command[0] === "rev-parse" && command[1] === "--verify") {
      const ref = command[3]!;
      if (ref.startsWith("refs/heads/")) return out(world.local.has(ref.slice("refs/heads/".length)) ? "abc1234\n" : null);
      return out(world.remote.has(ref.slice("refs/remotes/origin/".length)) ? "abc1234\n" : null);
    }
    if (command[0] === "show") return out(world.committed.get(command[2]!));
    if (command[0] === "status") return out(world.status);
    if (command[0] === "rev-list") return out(`${world.ahead}\n`);
    return out(null);
  };
}

function gitWorld(over: Partial<GitWorld> = {}): GitWorld {
  return {
    upstream: "origin/develop",
    originHead: "refs/remotes/origin/main",
    local: new Set(),
    remote: new Set(),
    committed: new Map([["origin/develop:yarn.lock", "left-pad@1.3.0\n"]]),
    status: "",
    ahead: "0",
    calls: [],
    ...over,
  };
}

/**
 * A daemon whose `workspaces.create` behaves as spike S1 measured: the same
 * `requestId` with a byte-identical body answers the same workspace, with any
 * other body `workspace_request_key_conflict`, an archived one's
 * `directory_not_found`; a taken branch name silently becomes the slug.
 */
function daemon(root: string, worktrees: string, world: GitWorld, options: { refuseOnce?: string } = {}) {
  const fake = fakePaseo({
    agents: [{ id: MAIN, provider: "bm-manager/claude-opus-5", status: "running", workspaceId: "wks_home", cwd: "/elsewhere/home", labels: { "bm.role": "manager" } }],
    config: {
      agentProfiles: [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }],
      providers: { "bm-worker": { extends: "claude" }, "bm-manager": { extends: "claude" } },
      mcp: { injectIntoAgents: true },
    },
    providers: { modes: { "bm-worker": [{ id: "default", colorTier: "safe" }] } },
  });
  const listed: Array<Record<string, unknown>> = [{ id: REPO, projectId: PROJECT, workspaceKind: "local_checkout", workspaceDirectory: root, archivingAt: null }];
  const requests = new Map<string, { body: string; id: string }>();
  const creations: Array<Record<string, unknown>> = [];
  let refuse = options.refuseOnce;
  const handleOf = (workspace: Record<string, unknown>, branch: string) => ({
    id: String(workspace["id"]),
    projectId: String(workspace["projectId"]),
    directory: String(workspace["workspaceDirectory"]),
    current: () => ({ ...workspace, gitRuntime: { currentBranch: branch } }),
  });
  fake.api.workspaces.list.mockImplementation(async () => ({ requestId: "r", entries: listed.map((entry) => ({ ...entry })), pageInfo: { nextCursor: null, hasMore: false } }) as never);
  fake.api.workspaces.create.mockImplementation((async (input: Record<string, unknown>) => {
    creations.push(input);
    if (refuse !== undefined) {
      const reason = refuse;
      refuse = undefined;
      throw new Error(reason);
    }
    const body = JSON.stringify(input);
    const requestId = String(input["requestId"]);
    const known = requests.get(requestId);
    if (known !== undefined) {
      if (known.body !== body) throw new Error("workspace_request_key_conflict");
      const workspace = listed.find((entry) => entry["id"] === known.id)!;
      if (workspace["archivingAt"] !== null) throw new Error("directory_not_found");
      return handleOf(workspace, String((workspace["project"] as { checkout: { currentBranch: string } }).checkout.currentBranch));
    }
    const source = input["source"] as Record<string, string>;
    let slug = source["worktreeSlug"]!;
    for (let n = 1; existsSync(join(worktrees, slug)); n += 1) slug = `${source["worktreeSlug"]}-${n}`;
    const directory = join(worktrees, slug);
    mkdirSync(directory, { recursive: true });
    const branch = source["action"] === "checkout" ? source["refName"]! : world.local.has(source["branchName"]!) ? source["worktreeSlug"]! : source["branchName"]!;
    world.local.add(branch);
    const workspace = {
      id: `wks_wt_${requests.size + 1}`,
      projectId: source["projectId"],
      workspaceKind: "worktree",
      workspaceDirectory: directory,
      worktreeSlug: slug,
      project: { checkout: { cwd: directory, isGit: true, currentBranch: branch } },
      archivingAt: null,
    };
    listed.push(workspace);
    requests.set(requestId, { body, id: workspace.id });
    return handleOf(workspace, branch);
  }) as never);
  return {
    fake,
    listed,
    creations,
    archive(workspaceId: string) {
      const workspace = listed.find((entry) => entry["id"] === workspaceId)!;
      workspace["archivingAt"] = NOW.toISOString();
    },
  };
}

function missionIn(home: string, repos: string[] = [REPO]): Mission {
  const made = createMissionStore(home, { now: () => NOW }).create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos, createdBy: "owner", mainId: MAIN });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  return made.mission;
}

const mainCaller = (missionId: string): ToolCaller => ({ agentId: MAIN, role: "manager", workspaceId: "wks_home", requestId: null, parentId: null, batchId: null, missionId });

/** A clone runner that records its calls and makes the target, or fails after half making it. */
function fakeClone(fail = false): CloneRunner & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const run = (async (source: string, target: string) => {
    calls.push([source, target]);
    mkdirSync(join(target, "half"), { recursive: true });
    if (fail) throw new Error("clonefile: Operation not supported");
  }) as CloneRunner & { calls: Array<[string, string]> };
  run.calls = calls;
  return run;
}

async function placed(home: string, paseo: unknown, missionId: string, world: GitWorld, clone = fakeClone()): Promise<PlacementResult> {
  const mission = createMissionStore(home).get(missionId)!;
  const listed = (await listedWorkspaces(paseo as DashboardPaseo)) as ListedWorkspace[];
  return ensurePlacement(home, paseo, mission, REPO, listed, { log: () => {}, git: fakeGit(world), clone, now: () => NOW });
}

const placementsOf = (home: string, missionId: string): Placement[] => createMissionStore(home).get(missionId)!.placements ?? [];

describe("the switch: placements only after the cut-over (§4.8)", () => {
  it("before the file a mission's Worker keeps the repo's root; after it, the mission's worktree", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const tools = createWorkerCreationTools({ binder: () => NO_BINDER, paseo: () => fake.paseo, home: () => home, log: () => {} });
    expect(placementModeOn(home)).toBe(false);

    const before = await tools.call("bm_create_worker", { request: "Fix the header.", context: [] }, mainCaller(mission.missionId));
    expect(before.ok, before.text).toBe(true);
    expect(creations).toHaveLength(0);
    expect(fake.creates[0]!.workspaceId).toBe(REPO);
    expect(placementsOf(home, mission.missionId)).toEqual([]);
    cutOver(home);
    expect(placementModeOn(home)).toBe(true);
  });
});

describe("creation (§3.3)", () => {
  it("the first bm_create_worker makes the worktree with the fixed requestId and exact body, then creates the Worker there with the placement's brief lines", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const clone = fakeClone();
    const tools = createWorkerCreationTools({ binder: () => NO_BINDER, paseo: () => fake.paseo, home: () => home, log: () => {}, placements: { git: fakeGit(world), clone } });
    const answer = await tools.call("bm_create_worker", { request: "Fix the header.", context: [] }, mainCaller(mission.missionId));
    expect(answer.ok, answer.text).toBe(true);
    expect(creations).toEqual([
      {
        requestId: `bm-place-${mission.missionId}-${REPO}`,
        title: "ABC · repo",
        source: { kind: "worktree", cwd: root, projectId: PROJECT, action: "branch-off", baseBranch: "origin/develop", branchName: "m/ABC/repo", worktreeSlug: "m-abc-repo" },
      },
    ]);
    const [placement] = placementsOf(home, mission.missionId);
    expect(placement).toMatchObject({
      repo: REPO,
      workspaceId: "wks_wt_1",
      directory: join(worktrees, "m-abc-repo"),
      branch: "m/ABC/repo",
      target: "develop",
      base: "origin/develop",
      worktreeSlug: "m-abc-repo",
      state: "ready",
      requestKey: `bm-place-${mission.missionId}-${REPO}`,
      requestBody: JSON.stringify(creations[0]),
      integration: null,
    });
    // The index maps it: the placement is its repo for every owner-level reader.
    expect(repoKeyOf(home, "wks_wt_1")).toBe(REPO);
    // The Worker in the worktree, through its workspace.
    const { requestId } = JSON.parse(answer.text) as { requestId: string };
    expect(fake.creates[0]!.workspaceId).toBe("wks_wt_1");
    expect(fake.api.workspaces.ref).toHaveBeenCalledWith("wks_wt_1");
    expect(createRequestRegistry(home).get("wks_wt_1", requestId)).toMatchObject({ missionId: mission.missionId });
    expect(createMissionRoster(home).get(mission.missionId, requestId)).toMatchObject({ workspaceId: "wks_wt_1" });
    const lines = fake.creates[0]!.options.prompt!.split("\n");
    const directory = join(worktrees, "m-abc-repo");
    expect(lines).toContain(`repository: ${directory} (beads in ${directory}/.beads/)`);
    expect(lines).toEqual(
      expect.arrayContaining([
        `worktree: ${directory} on branch m/ABC/repo (integration: develop)`,
        "commit: on this branch at finished and rollover",
        "push and merge request: ask the owner (paseo-bm does, at your first finished)",
        "dependencies: being prepared",
      ]),
    );

    // Its request finishes; the next Worker finds the placement ready: no second creation.
    createMissionRoster(home).setState(mission.missionId, requestId, "finished");
    const next = await tools.call("bm_create_worker", { request: "Fix the footer.", context: [] }, mainCaller(mission.missionId));
    expect(next.ok, next.text).toBe(true);
    expect(creations).toHaveLength(1);
    expect(fake.creates[1]!.workspaceId).toBe("wks_wt_1");
  });

  it("the integration branch: the root's upstream, else origin/HEAD, else refused", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld({ upstream: null });
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    expect(await placed(home, fake.paseo, mission.missionId, world)).toMatchObject({ ok: true, placement: { target: "main", base: "origin/main" } });

    const { home: home2, root: root2, worktrees: worktrees2 } = folders();
    const none = gitWorld({ upstream: null, originHead: null });
    const second = daemon(root2, worktrees2, none);
    const other = missionIn(home2);
    const refused = await placed(home2, second.fake.paseo, other.missionId, none);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reasons[0]).toContain(INTEGRATION_BRANCH_REFUSAL);
    expect(second.creations).toHaveLength(0);
    expect(creations).toHaveLength(1);
  });

  it("a taken branch, local or only on origin, becomes m/<code>-<tail 4>/<slug> (Paseo would silently take the slug)", async () => {
    for (const taken of ["local", "remote"] as const) {
      const { home, root, worktrees } = folders();
      const world = gitWorld();
      (taken === "local" ? world.local : world.remote).add("m/ABC/repo");
      const { fake, creations } = daemon(root, worktrees, world);
      const mission = missionIn(home);
      const result = await placed(home, fake.paseo, mission.missionId, world);
      const tail = mission.missionId.slice(-4);
      expect(result).toMatchObject({ ok: true, placement: { branch: `m/ABC-${tail}/repo`, worktreeSlug: `m-abc-${tail}-repo`, state: "ready" } });
      expect((creations[0]!["source"] as Record<string, string>)["branchName"]).toBe(`m/ABC-${tail}/repo`);
    }
  });

  it("a retry resends the stored body byte for byte, so Paseo answers the same workspace", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world, { refuseOnce: "socket hang up" });
    const mission = missionIn(home);
    const failed = await placed(home, fake.paseo, mission.missionId, world);
    expect(failed).toEqual({ ok: false, reasons: ["Paseo refused to create mission ABC's worktree of repo: socket hang up"] });
    expect(placementsOf(home, mission.missionId)).toMatchObject([{ state: "creating", workspaceId: null }]);

    const retried = await placed(home, fake.paseo, mission.missionId, world);
    expect(retried).toMatchObject({ ok: true, placement: { state: "ready", workspaceId: "wks_wt_1" } });
    expect(JSON.stringify(creations[1])).toBe(JSON.stringify(creations[0]));
    // Asked again with the same body, the daemon answers the same workspace: no duplicate.
    const again = await placed(home, fake.paseo, mission.missionId, world);
    expect(again).toMatchObject({ ok: true, placement: { workspaceId: "wks_wt_1" } });
    expect(creations).toHaveLength(2);
    expect(placementsOf(home, mission.missionId)).toHaveLength(1);
  });

  it("a branch Paseo did not make (the post-check) is failed, with one owner line; its live workspace blocks the next attempt", async () => {
    const { home, root, worktrees } = folders();
    // The daemon sees the branch taken, the plugin's read did not: Paseo takes the slug.
    const world = gitWorld({ local: new Set(["m/ABC/repo"]) });
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const hidden = gitWorld();
    const result = await placed(home, fake.paseo, mission.missionId, hidden);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasons[0]).toBe(
      `mission ABC's worktree of repo failed: Paseo made workspace wks_wt_1 on branch m-abc-repo in project ${PROJECT}, not m/ABC/repo in ${PROJECT}. Tell the owner in one line; they archive workspace wks_wt_1 in Paseo`,
    );
    expect(placementsOf(home, mission.missionId)).toMatchObject([{ state: "failed", workspaceId: "wks_wt_1" }]);
    expect(placementBlockOf(home, "wks_wt_1")).toContain("failed");

    const blocked = await placed(home, fake.paseo, mission.missionId, hidden);
    expect(!blocked.ok && blocked.reasons[0]).toContain("the owner archives workspace wks_wt_1 in Paseo first");
    expect(creations).toHaveLength(1);
  });
});

describe("reload and archive (§3.3 steps 4–5, §3.6)", () => {
  it("a creating placement Paseo lists is adopted at the reconciliation", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, listed } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const record: Placement = {
      repo: REPO,
      workspaceId: null,
      directory: null,
      branch: "m/ABC/repo",
      target: "develop",
      base: "origin/develop",
      worktreeSlug: "m-abc-repo",
      state: "creating",
      requestKey: `bm-place-${mission.missionId}-${REPO}`,
      createdAt: NOW.toISOString(),
      deps: { cloned: [], at: null, note: null },
      integration: null,
      requestBody: "{}",
    };
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, placements: [record] }));
    const directory = join(worktrees, "m-abc-repo");
    mkdirSync(directory, { recursive: true });
    listed.push({ id: "wks_wt_9", projectId: PROJECT, workspaceKind: "worktree", workspaceDirectory: directory, worktreeSlug: "m-abc-repo", project: { checkout: { currentBranch: "m/ABC/repo" } }, archivingAt: null });

    await reconcilePlacements(home, fake.paseo, { log: () => {}, git: fakeGit(world), clone: fakeClone(), now: () => NOW });
    expect(placementsOf(home, mission.missionId)).toMatchObject([{ state: "ready", workspaceId: "wks_wt_9", directory }]);
  });

  it("an archived placement is recorded so and re-created from its branch with checkout and a new requestId; the old requestId answers directory_not_found", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, creations, archive } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    await placed(home, fake.paseo, mission.missionId, world);
    archive("wks_wt_1");

    // The workspace.archived hook.
    const lifecycle = createPlacementLifecycle({ home: () => home, log: () => {}, now: () => NOW });
    lifecycle.archived("wks_wt_1");
    expect(placementsOf(home, mission.missionId)).toMatchObject([{ state: "archived" }]);
    expect(placementBlockOf(home, "wks_wt_1")).toContain("was archived in Paseo, so no new agent starts in it");
    // The archived placement takes no new agent of its requests (a continuation, a successor, a Reviewer).
    const listed = (await listedWorkspaces(fake.paseo as DashboardPaseo))!;
    expect(missionRepoOf(home, createMissionStore(home).get(mission.missionId)!, "wks_wt_1", listed)).toEqual([`project wks_wt_1 is archived or no longer listed in Paseo`]);

    const again = await placed(home, fake.paseo, mission.missionId, world);
    expect(again).toMatchObject({ ok: true, placement: { state: "ready", workspaceId: "wks_wt_2", branch: "m/ABC/repo", requestKey: `bm-place-${mission.missionId}-${REPO}-2` } });
    expect(creations[1]).toEqual({
      requestId: `bm-place-${mission.missionId}-${REPO}-2`,
      title: "ABC · repo",
      source: { kind: "worktree", cwd: root, projectId: PROJECT, action: "checkout", refName: "m/ABC/repo", worktreeSlug: "m-abc-repo" },
    });
    expect(placementsOf(home, mission.missionId).map((placement) => placement.state)).toEqual(["archived", "ready"]);
    // The old placement still resolves to its repo; placementOf names the newest.
    expect(repoKeyOf(home, "wks_wt_1")).toBe(REPO);
    expect(placementOf(home, mission.missionId, REPO)?.workspaceId).toBe("wks_wt_2");
  });

  it("a creating record whose workspace was archived before it was recorded: the replay answers directory_not_found, recorded as archived", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, archive } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const made = await placed(home, fake.paseo, mission.missionId, world);
    if (made.ok) await made.deps;
    archive("wks_wt_1");
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, placements: current.placements!.map((entry) => ({ ...entry, state: "creating", workspaceId: null, directory: null })) }));
    const replay = await placed(home, fake.paseo, mission.missionId, world);
    expect(replay).toEqual({ ok: false, reasons: ["mission ABC's worktree of repo was archived before paseo-bm recorded it; call bm_create_worker again to re-create it from its branch"] });
    expect(placementsOf(home, mission.missionId)).toMatchObject([{ state: "archived" }]);
  });

  it("a ready placement Paseo no longer lists is archived at the reconciliation; a cut-short clone is recorded as not prepared", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake, archive } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const made = await placed(home, fake.paseo, mission.missionId, world);
    if (made.ok) await made.deps;
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, placements: current.placements!.map((entry) => ({ ...entry, deps: { cloned: [], at: null, note: null } })) }));
    await reconcilePlacements(home, fake.paseo, { log: () => {}, git: fakeGit(world), now: () => NOW });
    expect(placementsOf(home, mission.missionId)[0]!.deps).toEqual({ cloned: [], at: NOW.toISOString(), note: "a plugin reload cut the dependency preparation short" });

    archive("wks_wt_1");
    await reconcilePlacements(home, fake.paseo, { log: () => {}, git: fakeGit(world), now: () => NOW });
    expect(placementsOf(home, mission.missionId)[0]!.state).toBe("archived");
  });
});

describe("dependencies (§3.5)", () => {
  it("clones node_modules copy-on-write when the lockfile at the base equals the root's, recorded with a journal line", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const clone = fakeClone();
    const result = await placed(home, fake.paseo, mission.missionId, world, clone);
    expect(result.ok).toBe(true);
    // Being prepared until it ends.
    expect(result.ok && placementBriefLines(result.placement)).toContain("dependencies: being prepared");
    if (result.ok) await result.deps;
    const directory = join(worktrees, "m-abc-repo");
    expect(clone.calls).toEqual([[join(root, "node_modules"), join(directory, "node_modules")]]);
    const [placement] = placementsOf(home, mission.missionId);
    expect(placement!.deps).toEqual({ cloned: ["node_modules"], at: NOW.toISOString(), note: null });
    expect(placementBriefLines(placement!)).toContain("dependencies: cloned from the root (node_modules)");
    expect(createMissionStore(home).journal(mission.missionId).at(-1)).toMatchObject({ kind: "note", text: "Dependencies of the worktree of repo: cloned copy-on-write from the root: node_modules." });
    expect(world.calls).toContainEqual(["show", "--no-textconv", "origin/develop:yarn.lock"]);
  });

  it("a lockfile that differs at the base: nothing is cloned and the brief says installing them is a dependency install", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld({ committed: new Map([["origin/develop:yarn.lock", "left-pad@1.4.0\n"]]) });
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const clone = fakeClone();
    const result = await placed(home, fake.paseo, mission.missionId, world, clone);
    if (result.ok) await result.deps;
    expect(clone.calls).toEqual([]);
    const [placement] = placementsOf(home, mission.missionId);
    expect(placement!.deps.note).toBe("yarn.lock at origin/develop differs from the root's");
    expect(placementBriefLines(placement!)).toContain("dependencies: not prepared — installing them is a dependency install");
  });

  it("the repository's own setup wins: the base's committed paseo.json, else the root's file; nothing is cloned", async () => {
    for (const where of ["base", "root"] as const) {
      const { home, root, worktrees } = folders();
      const world = gitWorld();
      const setup = JSON.stringify({ worktree: { setup: "yarn install --frozen-lockfile" } });
      if (where === "base") world.committed.set("origin/develop:paseo.json", setup);
      else writeFileSync(join(root, "paseo.json"), setup);
      const { fake } = daemon(root, worktrees, world);
      const mission = missionIn(home);
      const clone = fakeClone();
      const result = await placed(home, fake.paseo, mission.missionId, world, clone);
      if (result.ok) await result.deps;
      expect(clone.calls).toEqual([]);
      const [placement] = placementsOf(home, mission.missionId);
      expect(placement!.deps).toEqual({ cloned: [], at: NOW.toISOString(), note: SETUP_NOTE });
      expect(placementBriefLines(placement!)).toContain(`dependencies: ${SETUP_NOTE}`);
    }
  });

  it("a failed clone is removed and never followed by a copy or a symlink", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const clone = fakeClone(true);
    const result = await placed(home, fake.paseo, mission.missionId, world, clone);
    if (result.ok) await result.deps;
    const target = join(worktrees, "m-abc-repo", "node_modules");
    expect(clone.calls).toEqual([[join(root, "node_modules"), target]]);
    expect(existsSync(target)).toBe(false);
    const [placement] = placementsOf(home, mission.missionId);
    expect(placement!.deps).toEqual({ cloned: [], at: NOW.toISOString(), note: "the copy-on-write clone of node_modules failed: clonefile: Operation not supported" });
    expect(placementBriefLines(placement!)).toContain("dependencies: not prepared — installing them is a dependency install");
  });
});

describe("lifecycle (§3.6)", () => {
  async function twoPlacements(home: string, world: GitWorld, root: string, worktrees: string) {
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home, [REPO, "wks_other"]);
    await placed(home, fake.paseo, mission.missionId, world);
    return { fake, mission: createMissionStore(home).get(mission.missionId)! };
  }

  it("a repo leaving the charter retires its placement, and the owner's archive card warns of a dirty tree with commit first as the default", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld({ status: " M src/a.ts\n?? notes.md\n", ahead: "2" });
    const { mission } = await twoPlacements(home, world, root, worktrees);
    const changed = applyMissionChange(mission, { removeRepos: [REPO] }, NOW.toISOString());
    expect("reasons" in changed).toBe(false);
    createMissionStore(home).update(mission.missionId, () => changed as Mission);
    expect(placementsOf(home, mission.missionId)[0]!.state).toBe("retired");
    expect(placementBlockOf(home, "wks_wt_1")).toContain("is retired");

    const id = await openArchiveCards(home, mission.missionId, { log: () => {}, git: fakeGit(world), now: () => NOW });
    expect(id).toBe(`m:${mission.missionId}:1`);
    const card = createMissionDecisionStore(home).get(id!)!;
    const directory = join(worktrees, "m-abc-repo");
    expect(card).toMatchObject({ ownerOnly: true, class: "data", subject: "worktree-archive", askedBy: { role: "plugin", agentId: null } });
    expect(card.question).toBe(
      [
        "Mission ABC: this worktree is retired, and archiving is yours, in Paseo.",
        `- ${directory} on m/ABC/repo: uncommitted changes 2 files; not pushed 2 commits, the branch was never pushed; merge request none`,
        "Archiving a worktree deletes its uncommitted changes; its branch and commits stay.",
      ].join("\n"),
    );
    expect(card.options.map((option) => [option.key, option.label, option.recommended])).toEqual([
      ["a", "Commit first", true],
      ["b", "Archive it as it is", false],
      ["c", "Keep it", false],
    ]);
    // One card per event: asked again, nothing new.
    expect(await openArchiveCards(home, mission.missionId, { log: () => {}, git: fakeGit(world), now: () => NOW })).toBeNull();
    expect(placementsOf(home, mission.missionId)[0]!.archiveCard).toBe(id);
  });

  it("the mission closing retires every placement, in one card that names the clean tree's state", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { mission } = await twoPlacements(home, world, root, worktrees);
    world.remote.add("m/ABC/repo");
    const changed = applyMissionChange(mission, { close: true }, NOW.toISOString()) as Mission;
    expect(changed.placements!.map((placement) => placement.state)).toEqual(["retired"]);
    createMissionStore(home).update(mission.missionId, () => changed);
    const id = await openArchiveCards(home, mission.missionId, { log: () => {}, git: fakeGit(world), now: () => NOW });
    const card = createMissionDecisionStore(home).get(id!)!;
    expect(card.question.split("\n")[0]).toBe("Mission ABC is closed: this worktree is retired, and archiving is yours, in Paseo.");
    expect(card.question).toContain("uncommitted changes none; not pushed none; merge request none");
    expect(card.options.map((option) => [option.key, option.label, option.recommended])).toEqual([
      ["a", "Archive it in Paseo", true],
      ["b", "Keep it", false],
    ]);
  });
});

describe("what agents are told (§3.4)", () => {
  it("the Runtime facts' Integration line, and the brief's push line once the grant is given", async () => {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    await placed(home, fake.paseo, mission.missionId, world);
    const facts = integrationFactsOf(home, "wks_wt_1")!;
    expect(facts).toEqual({ branch: "m/ABC/repo", target: "develop", push: false });
    expect(runtimeFactsText("worker", { bound: true, integration: facts })).toContain("Integration: m/ABC/repo → develop; commit: yes; push/MR: no.");
    expect(integrationFactsOf(home, REPO)).toBeNull();

    const grant = { state: "granted" as const, decisionId: `m:${mission.missionId}:1`, grantedAt: "2026-10-21T10:42:00.000Z", revokedAt: null, scope: { remote: "origin" as const, branch: "m/ABC/repo", target: "develop" }, mr: null };
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, placements: current.placements!.map((entry) => ({ ...entry, integration: grant })) }));
    expect(integrationFactsOf(home, "wks_wt_1")!.push).toBe(true);
    expect(placementBriefLines(placementsOf(home, mission.missionId)[0]!)).toContain("push and merge request: allowed since 2026-10-21T10:42:00.000Z");
  });
});

describe("from the checkpoint (§4.8 steps 3 and 5)", () => {
  const CHECKPOINT = "bm/checkpoint-20261021";
  const REQ = "req-20261021T090000Z";

  /** After the cut-over (an hour after the mission started) with the repo's checkpoint made, or none yet. */
  function migrated(made: boolean) {
    const { home, root, worktrees } = folders();
    const world = gitWorld();
    world.local.add(CHECKPOINT);
    world.committed.set(`${CHECKPOINT}:yarn.lock`, "left-pad@1.3.0\n");
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    writeCutOver(home, new Date("2026-10-21T11:00:00.000Z"), () => {});
    if (made) {
      addCheckpointOffer(home, {
        repo: REPO,
        directory: root,
        name: "repo",
        card: `m:${mission.missionId}:1`,
        missionIds: [mission.missionId],
        openedAt: "2026-10-21T11:30:00.000Z",
        parent: null,
        busy: false,
        outcome: { at: "2026-10-21T12:00:00.000Z", kind: "made", branch: CHECKPOINT, commit: "abc1234" },
      });
    }
    return { home, root, worktrees, world, fake, creations, mission };
  }

  it("a mission from before the cut-over makes no worktree while its root holds work and no checkpoint was offered: it works in the root", async () => {
    const { home, fake, creations, mission, world } = migrated(false);
    world.status = " M src/a.ts\n";
    const result = await placed(home, fake.paseo, mission.missionId, world);
    expect(result).toEqual({ ok: false, inRoot: true, reasons: ["paseo-bm asks the owner to checkpoint the shared checkout of repo first"] });
    expect(creations).toHaveLength(0);
    expect(placementsOf(home, mission.missionId)).toEqual([]);
  });

  it("with the card answered 'later', bm_create_worker creates the Worker in the root with the not-yet line; after the checkpoint, the next one goes to the placement", async () => {
    const { home, root, worktrees, fake, creations, mission, world } = migrated(false);
    addCheckpointOffer(home, {
      repo: REPO,
      directory: root,
      name: "repo",
      card: `m:${mission.missionId}:1`,
      missionIds: [mission.missionId],
      openedAt: "2026-10-21T11:30:00.000Z",
      parent: null,
      busy: true,
      outcome: { at: "2026-10-21T11:40:00.000Z", kind: "later" },
    });
    const tools = createWorkerCreationTools({ binder: () => NO_BINDER, paseo: () => fake.paseo, home: () => home, log: () => {}, placements: { git: fakeGit(world), clone: fakeClone() } });
    // What /bm-worker-new tells the owner: this workspace, the shared checkout.
    expect(await newWorkerPlaceOf(home, fake.paseo, createMissionStore(home).get(mission.missionId)!, REPO, { git: fakeGit(world) })).toEqual({ workerIn: "shared-checkout", worktreeTitle: null });
    const first = await tools.call("bm_create_worker", { request: "Fix the header.", context: [] }, mainCaller(mission.missionId));
    expect(first.ok, first.text).toBe(true);
    const answer = JSON.parse(first.text) as { requestId: string; worktree?: string };
    expect(answer.worktree).toBe("not yet: it works in the shared checkout repo because the owner asked to checkpoint the shared checkout of repo once no mission Worker works in it");
    // The root, exactly as before the cut-over: no worktree, no placement, no integration lines.
    expect(creations).toHaveLength(0);
    expect(placementsOf(home, mission.missionId)).toEqual([]);
    expect(fake.creates[0]!.workspaceId).toBe(REPO);
    expect(createRequestRegistry(home).get(REPO, answer.requestId)).toMatchObject({ missionId: mission.missionId });
    expect(createMissionRoster(home).get(mission.missionId, answer.requestId)).toMatchObject({ workspaceId: REPO });
    const lines = fake.creates[0]!.options.prompt!.split("\n");
    expect(lines).toContain(`repository: ${root} (beads in ${root}/.beads/)`);
    expect(lines).toContain(ROOT_WAIT_BRIEF_LINE);
    expect(ROOT_WAIT_BRIEF_LINE).toBe("worktree: not yet — this mission works in the shared checkout until its checkpoint is made; paseo-bm moves new Workers to the mission's worktree after it.");
    expect(lines.filter((line) => line.startsWith("commit:") || line.startsWith("push and merge request:") || line.startsWith("dependencies:") || line.includes("integration:"))).toEqual([]);
    expect(integrationFactsOf(home, REPO)).toBeNull();

    // The owner checkpoints the root; the next Worker of the mission goes to its worktree, branched from the checkpoint.
    createMissionRoster(home).setState(mission.missionId, answer.requestId, "finished");
    addCheckpointOffer(home, {
      repo: REPO,
      directory: root,
      name: "repo",
      card: `m:${mission.missionId}:2`,
      missionIds: [mission.missionId],
      openedAt: "2026-10-21T11:50:00.000Z",
      parent: null,
      busy: false,
      outcome: { at: "2026-10-21T12:00:00.000Z", kind: "made", branch: CHECKPOINT, commit: "abc1234" },
    });
    expect(await newWorkerPlaceOf(home, fake.paseo, createMissionStore(home).get(mission.missionId)!, REPO, { git: fakeGit(world) })).toEqual({ workerIn: "worktree", worktreeTitle: "ABC · repo" });
    const next = await tools.call("bm_create_worker", { request: "Fix the footer.", context: [] }, mainCaller(mission.missionId));
    expect(next.ok, next.text).toBe(true);
    expect(JSON.parse(next.text)).not.toHaveProperty("worktree");
    expect(creations).toHaveLength(1);
    expect(creations[0]!["source"]).toMatchObject({ cwd: root, action: "branch-off", baseBranch: CHECKPOINT });
    expect(fake.creates[1]!.workspaceId).toBe("wks_wt_1");
    const placedLines = fake.creates[1]!.options.prompt!.split("\n");
    expect(placedLines).toContain(`worktree: ${join(worktrees, "m-abc-repo")} on branch m/ABC/repo (integration: develop)`);
    expect(placedLines).not.toContain(ROOT_WAIT_BRIEF_LINE);
    // Ready now: named by its workspace title; typed in the worktree itself, it is this workspace.
    const after = createMissionStore(home).get(mission.missionId)!;
    expect(await newWorkerPlaceOf(home, fake.paseo, after, REPO, { git: fakeGit(world) })).toEqual({ workerIn: "worktree", worktreeTitle: "ABC · repo" });
    expect(await newWorkerPlaceOf(home, fake.paseo, after, "wks_wt_1", { git: fakeGit(world) })).toEqual({ workerIn: "here", worktreeTitle: null });
  });

  it("a mission open at the checkpoint branches from the checkpoint branch, never its sha; the target stays the integration branch", async () => {
    const { home, root, fake, creations, mission, world } = migrated(true);
    expect(await placed(home, fake.paseo, mission.missionId, world)).toMatchObject({ ok: true, placement: { base: CHECKPOINT, target: "develop", branch: "m/ABC/repo" } });
    expect(creations[0]!["source"]).toMatchObject({ cwd: root, action: "branch-off", baseBranch: CHECKPOINT });
  });

  it("a handoff's successor of a request in the root moves into the placement once the root differs from the checkpoint in nothing", async () => {
    const { home, fake, mission, world } = migrated(true);
    createRequestRegistry(home, { backfill: () => [] }).register(REPO, REQ, { source: "agent-typed", managerId: MAIN, workerId: "w1" });
    createMissionRoster(home).add(mission.missionId, { requestId: REQ, workspaceId: REPO, topic: "the export", workerId: "w1" });
    const base = fakeGit(world);
    const same: GitRunner = async (args, options) => {
      const command = args.slice(GIT_READ_ONLY_PREFIX.length);
      if (command[0] === "status" && command.includes("-z")) return { stdout: "" };
      if (command[0] === "diff") return { stdout: "" };
      return base(args, options);
    };
    const unknown: GitRunner = async (args, options) => (args.slice(GIT_READ_ONLY_PREFIX.length)[0] === "diff" ? Promise.reject(new Error("fatal")) : same(args, options));
    const deps = { log: () => {}, clone: fakeClone(), now: () => NOW };
    // What the root cannot be compared with keeps the request in place.
    expect(await successorPlacementOf(home, fake.paseo, { workspaceId: REPO, missionId: mission.missionId }, { ...deps, git: unknown })).toBeNull();

    const place = await successorPlacementOf(home, fake.paseo, { workspaceId: REPO, missionId: mission.missionId }, { ...deps, git: same });
    expect(place).toMatchObject({ workspaceId: "wks_wt_1" });
    expect(moveRequestToPlacement(home, { requestId: REQ, missionId: mission.missionId, from: REPO, to: place!.workspaceId }, deps)).toBe(true);
    expect(createRequestRegistry(home).get("wks_wt_1", REQ)).toMatchObject({ workspaceId: "wks_wt_1", workerIds: ["w1"], movedFrom: [{ workspaceId: REPO, at: NOW.toISOString() }] });
    expect(createMissionRoster(home).get(mission.missionId, REQ)).toMatchObject({ workspaceId: "wks_wt_1" });
    // Already moved: true again, nothing changes.
    expect(moveRequestToPlacement(home, { requestId: REQ, missionId: mission.missionId, from: REPO, to: "wks_wt_1" }, deps)).toBe(true);
    // A placement is no root: its successors stay where they are.
    expect(await successorPlacementOf(home, fake.paseo, { workspaceId: "wks_wt_1", missionId: mission.missionId }, { ...deps, git: same })).toBeNull();
  });
});

/** Delivery line design §19.1 (ADR-038): lanes of one repo, made from the mission branch, reused when free, bounded. */
describe("lanes (§19.1)", () => {
  /** The read-only fake git, plus the lane writes (`switch`, `branch -f`) recorded and a `merge-base` answer. */
  function laneGit(world: GitWorld, writes: string[][], dirty: Set<string> = new Set()): GitRunner {
    const read = fakeGit(world);
    return async (args, options) => {
      if (args[0] === "switch" || args[0] === "branch") {
        writes.push([...args, `@${options.cwd}`]);
        return { stdout: "" };
      }
      const command = args.slice(GIT_READ_ONLY_PREFIX.length);
      if (command[0] === "merge-base") return { stdout: "" };
      if (command[0] === "status" && dirty.has(options.cwd)) return { stdout: " M src/a.ts\n" };
      return read(args, options);
    };
  }

  async function lane(home: string, paseo: unknown, missionId: string, git: GitRunner) {
    const mission = createMissionStore(home).get(missionId)!;
    const listed = (await listedWorkspaces(paseo as DashboardPaseo)) as ListedWorkspace[];
    return ensureLane(home, paseo, mission, REPO, listed, { log: () => {}, git, clone: fakeClone(), now: () => NOW });
  }

  const busy = (home: string, missionId: string, workspaceId: string, n: number) =>
    createMissionRoster(home, { now: () => NOW }).add(missionId, { requestId: `req-20261025T0${String(n).padStart(5, "0")}Z`, workspaceId, topic: `work ${n}`, workerId: `wkr-${n}` });

  it("makes lane 2 from the mission branch's head, on its own branch and worktree, mapped to the repo", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const made = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    expect(made.ok, made.ok ? "" : made.reasons.join("\n")).toBe(true);
    // Lane 1 first, then lane 2 branched off it.
    expect(creations).toHaveLength(2);
    expect(creations[1]!["source"]).toMatchObject({ action: "branch-off", baseBranch: "m/ABC/repo", branchName: "m/ABC/repo-2", worktreeSlug: "m-abc-repo-2" });
    expect(creations[1]!["title"]).toBe("ABC · repo · 2");
    expect(creations[1]!["requestId"]).toBe(`bm-place-${mission.missionId}-${REPO}-lane2`);
    if (!made.ok) return;
    expect(made.placement).toMatchObject({ lane: 2, branch: "m/ABC/repo-2", base: "m/ABC/repo", state: "ready", integration: null });
    expect(repoKeyOf(home, made.placement.workspaceId!)).toBe(REPO);
    // The mission's placement of the repo is still lane 1, the mission branch.
    expect(placementOf(home, mission.missionId, REPO)).toMatchObject({ branch: "m/ABC/repo" });
    expect(writes).toEqual([]);
  });

  it("opens lane 3 while lane 2 works, and reuses a free, clean lane reset to the mission branch", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const two = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    if (!two.ok) throw new Error(two.reasons.join("\n"));
    busy(home, mission.missionId, two.placement.workspaceId!, 1);
    const three = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    if (!three.ok) throw new Error(three.reasons.join("\n"));
    expect(three.placement).toMatchObject({ lane: 3, branch: "m/ABC/repo-3" });
    expect(creations).toHaveLength(3);

    // Lane 3 merged and freed: it is reused, reset to the mission branch, and not made again.
    createMissionStore(home, { now: () => NOW }).update(mission.missionId, (current) => ({
      ...current,
      placements: current.placements!.map((placement) => (placement.lane === 3 ? { ...placement, freeSince: NOW.toISOString(), mergedAt: NOW.toISOString() } : placement)),
    }));
    const again = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    if (!again.ok) throw new Error(again.reasons.join("\n"));
    expect(again.placement).toMatchObject({ lane: 3, freeSince: null });
    expect(creations).toHaveLength(3);
    expect(writes).toEqual([["switch", "-C", "m/ABC/repo-3", "m/ABC/repo", `@${three.placement.directory}`]]);
  });

  it("skips unmanaged draft branches even above the live-lane cap, without changing them", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const occupied = Array.from({ length: MAX_LANES }, (_, i) => `m/ABC/repo-${i + 2}`);
    const world = gitWorld({ local: new Set(occupied) });
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const made = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    expect(made.placement).toMatchObject({ lane: MAX_LANES + 2, branch: `m/ABC/repo-${MAX_LANES + 2}`, state: "ready" });
    expect(creations[1]!["source"]).toMatchObject({ action: "branch-off", baseBranch: "m/ABC/repo", branchName: `m/ABC/repo-${MAX_LANES + 2}` });
    expect(writes).toEqual([]);
    expect(occupied.every((branch) => world.local.has(branch))).toBe(true);
  });

  it.each([false, true])("reuses an archived lane only when ancestry is established (merged: %s)", async (merged) => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake, creations, archive } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const read = laneGit(world, writes);
    const git: GitRunner = async (args, options) => {
      if (!merged && args[GIT_READ_ONLY_PREFIX.length] === "merge-base") throw new Error("ancestry not established");
      return read(args, options);
    };
    const two = await lane(home, fake.paseo, mission.missionId, git);
    if (!two.ok) throw new Error(two.reasons.join("\n"));
    archive(two.placement.workspaceId!);
    const made = await lane(home, fake.paseo, mission.missionId, git);
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    expect(made.placement).toMatchObject({ lane: merged ? 2 : 3, branch: merged ? "m/ABC/repo-2" : "m/ABC/repo-3", state: "ready" });
    expect(creations[2]!["source"]).toMatchObject(merged ? { action: "checkout", refName: "m/ABC/repo-2" } : { action: "branch-off", branchName: "m/ABC/repo-3" });
    expect(writes).toEqual(merged ? [["branch", "-f", "m/ABC/repo-2", "m/ABC/repo", `@${root}`]] : []);
  });

  it("does not reuse a free lane with uncommitted changes, and makes a new one", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const two = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    if (!two.ok) throw new Error(two.reasons.join("\n"));
    createMissionStore(home, { now: () => NOW }).update(mission.missionId, (current) => ({
      ...current,
      placements: current.placements!.map((placement) => (placement.lane === 2 ? { ...placement, freeSince: NOW.toISOString() } : placement)),
    }));
    const next = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes, new Set([two.placement.directory!])));
    if (!next.ok) throw new Error(next.reasons.join("\n"));
    expect(next.placement.lane).toBe(3);
    expect(writes).toEqual([]);
  });

  it(`refuses past ${MAX_LANES} live lanes, naming each lane's work`, async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    for (let n = 2; n <= MAX_LANES; n += 1) {
      const made = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
      if (!made.ok) throw new Error(made.reasons.join("\n"));
      expect(made.placement.lane).toBe(n);
      busy(home, mission.missionId, made.placement.workspaceId!, n);
    }
    const refused = await lane(home, fake.paseo, mission.missionId, laneGit(world, writes));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reasons[0]).toContain(`already has ${MAX_LANES} lanes in repo`);
    expect(refused.reasons[0]).toContain("lane 2: req-20261025T000002Z work 2");
    expect(refused.reasons[0]).toContain("hold the request with after, or stop one");
  });

  it("bm_create_worker with lane: \"new\" runs independent work in lane 2 beside lane 1, with the lane's brief lines; refused without staffing delegated", async () => {
    const { home, root, worktrees } = folders();
    cutOver(home);
    const world = gitWorld();
    const { fake, creations } = daemon(root, worktrees, world);
    const mission = missionIn(home);
    const writes: string[][] = [];
    const tools = createWorkerCreationTools({ binder: () => NO_BINDER, paseo: () => fake.paseo, home: () => home, log: () => {}, placements: { git: laneGit(world, writes), clone: fakeClone() } });
    createMissionAutonomyStore(home).setLevel(mission.missionId, 1);
    const first = await tools.call("bm_create_worker", { request: "Audit the repo.", context: [] }, mainCaller(mission.missionId));
    expect(first.ok, first.text).toBe(true);
    const refused = await tools.call("bm_create_worker", { request: "Fix the compile error.", context: [], lane: "new" }, mainCaller(mission.missionId));
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("a new lane adds a live Worker to mission ABC in repo: staffing is not delegated in this mission, so ask the owner first");

    createMissionAutonomyStore(home).setLevel(mission.missionId, 2);
    const second = await tools.call("bm_create_worker", { request: "Fix the compile error.", context: [], lane: "new" }, mainCaller(mission.missionId));
    expect(second.ok, second.text).toBe(true);
    expect(JSON.parse(second.text)).toMatchObject({ lane: 2 });
    expect(creations.map((creation) => (creation["source"] as { branchName?: string; refName?: string }).branchName)).toEqual(["m/ABC/repo", "m/ABC/repo-2"]);
    const lane2 = placementsOf(home, mission.missionId).find((placement) => placement.lane === 2)!;
    expect(fake.creates.at(-1)!.workspaceId).toBe(lane2.workspaceId);
    const prompt = fake.creates.at(-1)!.options.prompt!;
    expect(prompt).toContain(`worktree: ${lane2.directory} on branch m/ABC/repo-2 (lane 2; the mission branch is m/ABC/repo)`);
    expect(prompt).toContain("lane: at finished, merge m/ABC/repo into m/ABC/repo-2, resolve conflicts, check what the merge touched, commit, then report finished; paseo-bm moves m/ABC/repo forward. Never push this branch.");
    expect(prompt).not.toContain("push and merge request:");
  });
});

