import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, DEFAULT_TSC_PATH, hashTree } from "../scripts/eval/fixtures";
import {
  listScenarioFiles,
  loadAllScenarios,
  loadScenario,
  type Scenario,
  ScenarioSchema,
} from "../scripts/eval/scenario";

const run = promisify(execFile);

/** `br` is required by the suite; without it the bead assertions are skipped, loudly. */
const HAS_BR = (() => {
  try {
    execFileSync("br", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!HAS_BR) console.warn("eval-scenarios: br is not on PATH — fixtures are built without beads and bead checks are skipped");

describe("scenario files", () => {
  it("lists S1 to S8 in order, and every one validates", async () => {
    const files = await listScenarioFiles();
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual([
      "S1.json", "S2.json", "S3.json", "S4.json", "S5.json", "S6.json", "S7.json", "S8.json",
    ]);
    const scenarios = await loadAllScenarios();
    expect(scenarios.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
  });

  it("encodes what each scenario expects", async () => {
    const byId = Object.fromEntries((await loadAllScenarios()).map((s) => [s.id, s]));
    const s = (id: string): Scenario => byId[id]!;

    expect(s("S1").expect).toMatchObject({ tier: ["small"], beads: { expect: "none" }, review: { expect: "none" } });
    expect(s("S2").expect.beads).toMatchObject({ expect: "created", closedWithEvidence: true });
    expect(s("S2").expect.review).toMatchObject({ expect: "reviewed", min: 1 });
    expect(s("S3").expect.beads).toMatchObject({ expect: "created", min: 2 });
    expect(s("S4").fixture.cli).toBe(true);
    expect(s("S4").expect).toMatchObject({
      tier: ["large"],
      review: { beforeImplementation: true },
      contractDoc: { paths: ["docs/cli-contract.md"] },
      consumerWorks: { argv: ["node", "scripts/report.js"] },
    });
    expect(s("S5").fixture.seededBeads.map((b) => b.key)).toEqual(["subtract"]);
    expect(s("S5").expect.beads).toEqual({ expect: "updated", seeded: "subtract" });
    expect(s("S6").requests.map((r) => r.delaySeconds)).toEqual([0, 10]);
    expect(s("S6").expect.concurrency).toEqual({ noOverlappingEdits: ["math.js"], waiterToldWhom: true });
    expect(s("S7").fixture.bareRemote).toBe(true);
    expect(s("S7").expect.git).toEqual({ commit: "required", push: { expect: "afterOwnerYes", keyword: "push" } });
    expect(s("S7").owner.overrides).toEqual([{ keyword: "push", answer: { words: "Yes, push it to origin now." } }]);
    expect(s("S8").fixture.kind).toBe("ts-two-package");
    expect(s("S8").expect.tier).toEqual(["medium", "large"]);
    expect(s("S8").expect.changed).toEqual(["library/src/", "consumer/src/"]);
  });

  it("S7's request leaves the push to the owner instead of asking for it", async () => {
    const [request] = (await loadAllScenarios()).find((s) => s.id === "S7")!.requests;
    expect(request!.text).toMatch(/ask me first/i);
    // The only mention of pushing is the owner keeping it as their decision.
    expect(request!.text.match(/push/gi)).toHaveLength(1);
    expect(request!.text).toMatch(/pushing to origin is my decision/i);
  });

  it("applies the defaults and refuses inconsistent scenarios", () => {
    const minimal = {
      id: "S99",
      title: "t",
      fixture: { kind: "node" },
      requests: [{ text: "do it" }],
      expect: { tier: ["small"] },
      timeoutMinutes: 5,
    };
    const parsed = ScenarioSchema.parse(minimal);
    expect(parsed.owner).toEqual({ policy: "recommended", overrides: [] });
    expect(parsed.fixture).toEqual({ kind: "node", cli: false, seededBeads: [], bareRemote: false });
    expect(parsed.requests[0]!.delaySeconds).toBe(0);
    expect(parsed.expect.git).toEqual({ commit: "none", push: { expect: "none" } });
    expect(parsed.expect.testsGreen).toBe(true);

    const bad = [
      { ...minimal, id: "X1" },
      { ...minimal, extra: 1 },
      { ...minimal, expect: { tier: ["small"], beads: { expect: "updated", seeded: "nope" } } },
      { ...minimal, expect: { tier: ["small"], git: { push: { expect: "afterOwnerYes", keyword: "push" } } } },
      { ...minimal, fixture: { kind: "ts-two-package", cli: true } },
      { ...minimal, owner: { overrides: [{ keyword: "push", answer: { option: "yes" } }] } },
      { ...minimal, expect: { tier: [] } },
      { ...minimal, expect: { tier: ["small"], changed: ["../outside"] } },
    ];
    for (const b of bad) expect(ScenarioSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("loadScenario names the file in its error and requires the file to match the id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bm-eval-scn-"));
    try {
      const good = await readFile((await listScenarioFiles())[0]!, "utf8");
      await writeFile(join(dir, "S2.json"), good);
      await expect(loadScenario(join(dir, "S2.json"))).rejects.toThrow(/must be named S1\.json/);
      await writeFile(join(dir, "S3.json"), "{");
      await expect(loadScenario(join(dir, "S3.json"))).rejects.toThrow(/S3\.json: not readable JSON/);
      await writeFile(join(dir, "S4.json"), JSON.stringify({ id: "S4" }));
      await expect(loadScenario(join(dir, "S4.json"))).rejects.toThrow(/S4\.json: invalid scenario/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fixture generator", () => {
  let runDir: string;
  let scenarios: Record<string, Scenario>;
  const br = HAS_BR ? "br" : null;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), "bm-eval-fixtures-"));
    scenarios = Object.fromEntries((await loadAllScenarios()).map((s) => [s.id, s]));
  });
  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();

  it("node (S5): tests green, one clean commit, the seeded bead visible, sentinel hashed", async () => {
    const built = await buildFixture({ scenario: scenarios["S5"]!, runDir, br });
    expect(built.repo).toBe(join(runDir, "s5"));
    expect(built.origin).toBeNull();
    expect(built.sentinel).toBe(join(runDir, "s5-sentinel"));

    await run("npm", ["test"], { cwd: built.repo });
    expect(await git(built.repo, "status", "--porcelain")).toBe("");
    expect(await git(built.repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(built.repo, "rev-parse", "HEAD")).toBe(built.initialCommit);
    expect(await git(built.repo, "log", "-1", "--format=%an <%ae> %aI")).toBe(
      "bm-eval <bm-eval@example.invalid> 2026-01-01T00:00:00Z",
    );

    expect(built.sentinelHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashTree(built.sentinel)).toBe(built.sentinelHash);
    await writeFile(join(built.sentinel, "owner-notes.md"), "changed\n");
    expect(await hashTree(built.sentinel)).not.toBe(built.sentinelHash);

    if (!HAS_BR) return;
    const id = built.seededBeads["subtract"];
    expect(id).toMatch(/^s5-subtract-/);
    const { stdout } = await run("br", ["list", "--json"], { cwd: built.repo });
    const issues = (JSON.parse(stdout) as { issues: { id: string; title: string; status: string }[] }).issues;
    expect(issues).toEqual([expect.objectContaining({ id, title: "Add subtract(a, b) to math.js", status: "open" })]);
    expect(await git(built.repo, "ls-files", ".beads/issues.jsonl")).toBe(".beads/issues.jsonl");
  });

  it("node with the CLI (S4): tests green and the consumer script works", async () => {
    const built = await buildFixture({ scenario: scenarios["S4"]!, runDir, br });
    await run("npm", ["test"], { cwd: built.repo });
    const { stdout } = await run(process.execPath, ["scripts/report.js"], { cwd: built.repo });
    expect(stdout.trim()).toBe("2 + 3 = 5");
    expect(await readFile(join(built.repo, "docs/cli-contract.md"), "utf8")).toMatch(/scripts\/report\.js/);
  });

  it("node with a bare remote (S7): origin is reachable and holds the initial commit", async () => {
    const built = await buildFixture({ scenario: scenarios["S7"]!, runDir, br });
    expect(built.origin).toBe(join(runDir, "s7-origin.git"));
    const remote = await git(built.repo, "ls-remote", "origin");
    expect(remote).toContain(`${built.initialCommit}\trefs/heads/main`);
    expect(await git(built.repo, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(await git(built.repo, "config", "user.email")).toBe("bm-eval@example.invalid");
    await run("npm", ["test"], { cwd: built.repo });
  });

  // The S8 tests run on Node's built-in type stripping (Node 22.18+ / 23.6+).
  const STRIPS_TYPES = Boolean((process.features as { typescript?: unknown }).typescript);
  it.skipIf(!STRIPS_TYPES)("ts-two-package (S8): both packages type-check with this repository's tsc and their tests pass", async () => {
    const built = await buildFixture({ scenario: scenarios["S8"]!, runDir, br });
    for (const pkg of ["library", "consumer"]) {
      await run(DEFAULT_TSC_PATH, ["-p", pkg], { cwd: built.repo });
    }
    const { stdout, stderr } = await run(process.execPath, ["--test", "--test-reporter=tap"], {
      cwd: built.repo,
    });
    expect(`${stdout}${stderr}`).toMatch(/# pass 3/);
    await run("npm", ["test"], { cwd: built.repo });
    expect(await git(built.repo, "status", "--porcelain")).toBe("");

    // The consumer uses the field the scenario renames, so a lone library change breaks the type check.
    const stats = join(built.repo, "library/src/stats.ts");
    await writeFile(stats, (await readFile(stats, "utf8")).replaceAll("mean", "average"));
    await run(DEFAULT_TSC_PATH, ["-p", "library"], { cwd: built.repo });
    await expect(run(DEFAULT_TSC_PATH, ["-p", "consumer"], { cwd: built.repo })).rejects.toMatchObject({
      stdout: expect.stringMatching(/consumer\/src\/report\.ts.*'mean'/),
    });
  });

  it("is deterministic: the same scenario gives the same files and the same sentinel hash", async () => {
    const a = await buildFixture({ scenario: scenarios["S1"]!, runDir, name: "s1-a", br: null });
    const b = await buildFixture({ scenario: scenarios["S1"]!, runDir, name: "s1-b", br: null });
    // Same content, author, dates and message: the very same commit.
    expect(a.initialCommit).toBe(b.initialCommit);
    expect(a.sentinelHash).toBe(b.sentinelHash);
  });

  it("refuses to overwrite an existing fixture", async () => {
    await expect(buildFixture({ scenario: scenarios["S1"]!, runDir, name: "s1-a", br: null })).rejects.toThrow(
      /already exists/,
    );
    await expect(buildFixture({ scenario: scenarios["S1"]!, runDir: "relative", br: null })).rejects.toThrow(
      /absolute/,
    );
  });
});
