import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Beads at integration (delivery line design §4.7, spike S2). `.beads/issues.jsonl`
 * is tracked and sorted by id, so it merges like code at the Worker's "update
 * the branch" step: new beads in different places of the file merge cleanly,
 * and the same bead edited on two branches is a line conflict, resolved by
 * taking the integration branch's line, committing the merge, then re-applying
 * the request's own change.
 *
 * Temporary git repositories, no remote: `main` stands for `origin/<target>`,
 * and each mission branch has its own worktree, as a placement does. The
 * JSONL-only variant writes the lines itself, as br exports them; the br
 * variant runs the real `br` and is skipped when it is not on PATH. Each test
 * has its own folder, so they run concurrently.
 */

const BRANCH_A = "m/AAA/fe";
const BRANCH_B = "m/BBB/fe";
const JSONL = ".beads/issues.jsonl";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const brPath = (() => {
  try {
    return execFileSync("which", ["br"], { stdio: "pipe", encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

const run = promisify(execFile);
// No background maintenance, no user config (as test/line-state.test.ts).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const GIT_FLAGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];
const gitIn = async (cwd: string, ...args: string[]): Promise<string> => (await run("git", [...GIT_FLAGS, ...args], { cwd, env: GIT_ENV, encoding: "utf8" })).stdout.trim();
/** A merge that may stop on a conflict: true when it went through. */
const mergeIn = async (cwd: string, ref: string): Promise<boolean> => {
  try {
    await gitIn(cwd, "merge", "--no-edit", "-q", ref);
    return true;
  } catch {
    return false;
  }
};
const conflictedIn = async (cwd: string): Promise<string[]> => (await gitIn(cwd, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
const commitAll = async (cwd: string, message: string): Promise<void> => {
  await gitIn(cwd, "add", "-A");
  await gitIn(cwd, "commit", "-q", "-m", message);
};

type Bead = { id: string; title: string; status: string; priority: number; updated_at: string };
const bead = (id: string, over: Partial<Bead> = {}): Bead => ({ id, title: `Bead ${id}`, status: "open", priority: 2, updated_at: "2026-10-20T10:00:00.000Z", ...over });
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The file as br exports it: one JSON object per line, sorted by id. */
const writeBeads = (cwd: string, beads: Bead[]): void => {
  const sorted = [...beads].sort((a, b) => byId(a.id, b.id));
  writeFileSync(join(cwd, JSONL), sorted.map((b) => JSON.stringify(b)).join("\n") + "\n");
};
const readText = (cwd: string): string => readFileSync(join(cwd, JSONL), "utf8");
/** Parses every line (throws on a conflict marker or bad JSON). */
const readBeads = (cwd: string): Bead[] =>
  readText(cwd)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Bead);
const edit = (cwd: string, id: string, over: Partial<Bead>): Bead[] => readBeads(cwd).map((x) => (x.id === id ? { ...x, ...over } : x));
const idOf = (line: string): string => (JSON.parse(line) as { id: string }).id;

/** Valid JSONL, one line per id, sorted by id: what br reads back. */
function expectValidBeads(cwd: string): Bead[] {
  expect(readText(cwd)).not.toMatch(/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m);
  const beads = readBeads(cwd);
  const ids = beads.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort(byId));
  return beads;
}

/**
 * The rule at the "update the branch" step, line by line inside each conflict
 * hunk of `issues.jsonl`: for an id on both sides, the integration branch's
 * line (`theirs`, since the Worker runs `git merge origin/<target>` on the
 * mission branch); a line whose id only one side has is kept. The hunk is a
 * contiguous range of the sorted file, so its lines are re-sorted in place.
 */
function takeIntegrationLines(text: string): string {
  const out: string[] = [];
  let side: "none" | "ours" | "base" | "theirs" = "none";
  let ours: string[] = [];
  let theirs: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      side = "ours";
      ours = [];
      theirs = [];
    } else if (line.startsWith("|||||||") && side === "ours") side = "base";
    else if (line.startsWith("=======") && side !== "none") side = "theirs";
    else if (line.startsWith(">>>>>>>") && side === "theirs") {
      const lines = new Map<string, string>();
      for (const l of ours) lines.set(idOf(l), l);
      for (const l of theirs) lines.set(idOf(l), l);
      out.push(...[...lines.entries()].sort(([a], [b]) => byId(a, b)).map(([, l]) => l));
      side = "none";
    } else if (side === "ours") ours.push(line);
    else if (side === "theirs") theirs.push(line);
    else if (side === "none") out.push(line);
  }
  return out.join("\n");
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temporary folder: `main` holds the integration branch, a worktree per mission branch beside it. */
function lab() {
  const root = mkdtempSync(join(tmpdir(), "bm-beads-merge-"));
  roots.push(root);
  const main = join(root, "main");
  mkdirSync(main);
  const worktree = async (branch: string, name: string): Promise<string> => {
    const dir = join(root, name);
    await gitIn(main, "worktree", "add", "-q", "-b", branch, dir, "main");
    return dir;
  };
  /** One after the other: `git worktree add` takes locks in the shared repository. */
  const worktrees = async (): Promise<[string, string]> => [await worktree(BRANCH_A, "a"), await worktree(BRANCH_B, "b")];
  /** `.beads/issues.jsonl` committed on main. */
  const beadsRepo = async (beads: Bead[]): Promise<void> => {
    await gitIn(main, "init", "-q", "-b", "main");
    mkdirSync(join(main, ".beads"));
    writeBeads(main, beads);
    await commitAll(main, "Base beads");
  };
  /** What taking the integration side of every hunk gives (`git merge-file --theirs`). */
  const wholeHunkTheirs = async (cwd: string): Promise<string> => {
    const stage = async (n: number): Promise<string> => {
      const file = join(root, `stage-${n}`);
      writeFileSync(file, (await gitIn(cwd, "show", `:${n}:${JSONL}`)) + "\n");
      return file;
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    await gitIn(cwd, "merge-file", "--theirs", ours, base, theirs);
    return readFileSync(ours, "utf8");
  };
  /** br with no user config: HOME is the test's own folder. */
  const br = async (cwd: string, ...args: string[]): Promise<string> => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config") };
    // A developer's BEADS_* would point br at another workspace.
    for (const key of Object.keys(env)) if (key.startsWith("BEADS_")) delete env[key];
    return (await run("br", args, { cwd, env, encoding: "utf8" })).stdout.trim();
  };
  const brCreate = (cwd: string, slug: string, title: string): Promise<string> => br(cwd, "create", title, "--slug", slug, "-t", "task", "-p", "2", "--silent");
  const brShow = async (cwd: string, id: string): Promise<{ id: string; title: string; priority: number }> => {
    const parsed = JSON.parse(await br(cwd, "show", id, "--json")) as { id: string; title: string; priority: number }[];
    return parsed[0]!;
  };
  /**
   * `br init` in main, base beads whose slugs fix the sort order, committed.
   * `br init` leaves `issue_prefix` commented in config.yaml, and a fresh
   * worktree infers the prefix from the first id (`t-bravo` from
   * `t-bravo-xyz`), so the committed config names it; metrics stay off.
   */
  const brRepo = async (slugs: string[]): Promise<Record<string, string>> => {
    await gitIn(main, "init", "-q", "-b", "main");
    await br(main, "init", "--prefix", "t");
    const config = join(main, ".beads", "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8") + "issue_prefix: t\nmetrics.disabled: true\n");
    const ids: Record<string, string> = {};
    for (const slug of slugs) ids[slug] = await brCreate(main, slug, `Base ${slug}`);
    await commitAll(main, "Base beads");
    expect(await gitIn(main, "ls-files", ".beads")).toContain(JSONL);
    return ids;
  };
  return { root, main, worktrees, beadsRepo, wholeHunkTheirs, br, brCreate, brShow, brRepo };
}

const WITH_BR = brPath ? "with br" : "with br (skipped: `which br` found no br on PATH)";

// One concurrent suite, so the br tests overlap the JSONL-only ones.
describe.concurrent("beads at integration (§4.7, spike S2)", () => {
  it.skipIf(!hasGit)("JSONL only: new beads on two mission branches merge cleanly into a third branch: sorted, one line per id", async () => {
    const { main, worktrees, beadsRepo } = lab();
    await beadsRepo([bead("bd-a10"), bead("bd-m50"), bead("bd-z90")]);
    const [a, b] = await worktrees();
    writeBeads(a, [...readBeads(a), bead("bd-c20", { title: "From A" })]);
    writeBeads(b, [...readBeads(b), bead("bd-p60", { title: "From B" })]);
    await Promise.all([commitAll(a, "A: a new bead"), commitAll(b, "B: a new bead")]);

    await gitIn(main, "checkout", "-q", "-b", "integration");
    expect(await mergeIn(main, BRANCH_A)).toBe(true);
    expect(await mergeIn(main, BRANCH_B)).toBe(true);
    expect(await conflictedIn(main)).toEqual([]);
    expect(expectValidBeads(main).map((x) => x.id)).toEqual(["bd-a10", "bd-c20", "bd-m50", "bd-p60", "bd-z90"]);
  });

  it.skipIf(!hasGit)("JSONL only: the same bead edited on two branches is a line conflict; the rule gives the integration line plus the request's own change", async () => {
    const { main, worktrees, beadsRepo } = lab();
    await beadsRepo([bead("bd-a10"), bead("bd-m50"), bead("bd-z90")]);
    const [a, b] = await worktrees();
    // Mission A renames the shared bead and lands first on the integration branch;
    // the request on mission B changes the same bead's priority.
    writeBeads(a, edit(a, "bd-m50", { title: "Renamed by A", updated_at: "2026-10-20T11:00:00.000Z" }));
    writeBeads(b, edit(b, "bd-m50", { priority: 0, updated_at: "2026-10-20T12:00:00.000Z" }));
    await Promise.all([commitAll(a, "A: rename bd-m50"), commitAll(b, "B: raise bd-m50")]);
    await gitIn(main, "merge", "-q", "--ff-only", BRANCH_A);

    // 1. git merge origin/<target>: a line conflict on bd-m50's line only.
    expect(await mergeIn(b, "main")).toBe(false);
    expect(await conflictedIn(b)).toEqual([JSONL]);
    expect(() => readBeads(b)).toThrow();
    // 2. Take the integration branch's line, commit the merge.
    writeFileSync(join(b, JSONL), takeIntegrationLines(readText(b)));
    expect(expectValidBeads(b).find((x) => x.id === "bd-m50")).toMatchObject({ title: "Renamed by A", priority: 2 });
    await gitIn(b, "add", JSONL);
    await gitIn(b, "commit", "-q", "--no-edit");
    expect((await gitIn(b, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(3);
    // 3. Re-apply the request's own change, as br would export it.
    writeBeads(b, edit(b, "bd-m50", { priority: 0, updated_at: "2026-10-20T13:00:00.000Z" }));
    await commitAll(b, "B: re-apply bd-m50 priority");

    const beads = expectValidBeads(b);
    expect(beads.map((x) => x.id)).toEqual(["bd-a10", "bd-m50", "bd-z90"]);
    expect(beads.find((x) => x.id === "bd-m50")).toMatchObject({ title: "Renamed by A", priority: 0 });
    // The branch is now up to date with the integration branch.
    expect(await gitIn(b, "rev-list", "--count", "HEAD..main")).toBe("0");
  });

  it.skipIf(!hasGit)("JSONL only: the request's own new bead next to the conflicting line is in the same hunk: kept by the line rule, lost by taking the whole hunk", async () => {
    const { main, worktrees, beadsRepo, wholeHunkTheirs } = lab();
    await beadsRepo([bead("bd-a10"), bead("bd-m50"), bead("bd-z90")]);
    const [a, b] = await worktrees();
    writeBeads(a, edit(a, "bd-m50", { title: "Renamed by A" }));
    // B edits bd-m50 and creates bd-m55, which sorts right after it.
    writeBeads(b, [...edit(b, "bd-m50", { priority: 0 }), bead("bd-m55", { title: "New in B" })]);
    await Promise.all([commitAll(a, "A: rename bd-m50"), commitAll(b, "B: raise bd-m50, add bd-m55")]);
    await gitIn(main, "merge", "-q", "--ff-only", BRANCH_A);

    expect(await mergeIn(b, "main")).toBe(false);
    expect(await conflictedIn(b)).toEqual([JSONL]);
    // Taking the integration side of the whole hunk drops the request's new bead.
    expect(await wholeHunkTheirs(b)).not.toContain('"bd-m55"');
    writeFileSync(join(b, JSONL), takeIntegrationLines(readText(b)));
    const beads = expectValidBeads(b);
    expect(beads.map((x) => x.id)).toEqual(["bd-a10", "bd-m50", "bd-m55", "bd-z90"]);
    expect(beads.find((x) => x.id === "bd-m50")).toMatchObject({ title: "Renamed by A", priority: 2 });
  });

  it.skipIf(!hasGit)("JSONL only: two new beads that sort between the same two lines conflict too; the line rule keeps both", async () => {
    const { main, worktrees, beadsRepo, wholeHunkTheirs } = lab();
    await beadsRepo([bead("bd-a10"), bead("bd-z90")]);
    const [a, b] = await worktrees();
    writeBeads(a, [...readBeads(a), bead("bd-c20", { title: "From A" })]);
    writeBeads(b, [...readBeads(b), bead("bd-p60", { title: "From B" })]);
    await Promise.all([commitAll(a, "A: a new bead"), commitAll(b, "B: a new bead")]);
    await gitIn(main, "merge", "-q", "--ff-only", BRANCH_A);

    expect(await mergeIn(b, "main")).toBe(false);
    expect(await conflictedIn(b)).toEqual([JSONL]);
    expect(await wholeHunkTheirs(b)).not.toContain('"bd-p60"');
    writeFileSync(join(b, JSONL), takeIntegrationLines(readText(b)));
    expect(expectValidBeads(b).map((x) => x.id)).toEqual(["bd-a10", "bd-c20", "bd-p60", "bd-z90"]);
  });

  it.skipIf(!hasGit || !brPath)(`${WITH_BR}: br create on two branches merges cleanly; br show finds both in a fresh worktree`, async () => {
    const { root, main, worktrees, brCreate, brShow, brRepo } = lab();
    // t-bravo-* < t-delta-* < t-mike-* < t-romeo-* < t-yankee-*: the new beads land apart.
    await brRepo(["bravo", "mike", "yankee"]);
    const [a, b] = await worktrees();
    const [fromA, fromB] = await Promise.all([brCreate(a, "delta", "From A"), brCreate(b, "romeo", "From B")]);
    await Promise.all([commitAll(a, "A: a new bead"), commitAll(b, "B: a new bead")]);

    await gitIn(main, "checkout", "-q", "-b", "integration");
    expect(await mergeIn(main, BRANCH_A)).toBe(true);
    expect(await mergeIn(main, BRANCH_B)).toBe(true);
    expect(expectValidBeads(main)).toHaveLength(5);
    // br imports the file into a new database in a fresh worktree.
    const fresh = join(root, "fresh");
    await gitIn(main, "worktree", "add", "-q", "--detach", fresh, "integration");
    expect((await brShow(fresh, fromA)).title).toBe("From A");
    expect((await brShow(fresh, fromB)).title).toBe("From B");
  });

  it.skipIf(!hasGit || !brPath)(`${WITH_BR}: the same bead updated on two branches: integration line, commit, br sync --rebuild, then br update re-applies the request's change`, async () => {
    const { main, worktrees, br, brShow, brRepo } = lab();
    const shared = (await brRepo(["bravo", "mike", "yankee"]))["mike"]!;
    const [a, b] = await worktrees();
    await br(a, "update", shared, "--title", "Renamed by A");
    await commitAll(a, "A: rename the shared bead");
    await gitIn(main, "merge", "-q", "--ff-only", BRANCH_A);
    // The request's change is the later one.
    await br(b, "update", shared, "-p", "0");
    await commitAll(b, "B: raise the shared bead");

    expect(await mergeIn(b, "main")).toBe(false);
    expect(await conflictedIn(b)).toEqual([JSONL]);
    writeFileSync(join(b, JSONL), takeIntegrationLines(readText(b)));
    expect(expectValidBeads(b).find((x) => x.id === shared)).toMatchObject({ title: "Renamed by A", priority: 2 });
    await gitIn(b, "add", JSONL);
    await gitIn(b, "commit", "-q", "--no-edit");
    // The worktree's database still holds the request's newer row; the
    // committed file is made authoritative before br writes again.
    await br(b, "sync", "--rebuild");
    await br(b, "update", shared, "-p", "0");
    await commitAll(b, "B: re-apply the priority");

    const beads = expectValidBeads(b);
    expect(beads).toHaveLength(3);
    expect(beads.find((x) => x.id === shared)).toMatchObject({ title: "Renamed by A", priority: 0 });
    expect(await brShow(b, shared)).toMatchObject({ title: "Renamed by A", priority: 0 });
  });
});
