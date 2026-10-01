import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { DECISIONS_FILE_VERSION } from "../plugin/server/decision-store";
import { deriveChain } from "../plugin/server/links";
import { reconstructTraces } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import {
  A10_LINKS,
  drawOutputs,
  judgeChain,
  quotaOf,
  seededRandom,
  type LinksAudit,
  type Output,
  type OutputKind,
} from "../scripts/eval/links-audit";
import { runReplay, type ReplayReport } from "../scripts/eval/replay";
import { MANAGER, file, msg, report, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";

/**
 * The A-10 links audit in the replay (evaluation design §4 A-10; bead
 * `bm-autonomy-phase5-3e5v.6`): on a synthetic data folder and a temporary
 * git repository, the seeded draw is reproducible, a short kind is filled
 * and reported, each required link is judged found, stated absent or
 * missing, the commit rule holds, the output carries numbers, link kinds and
 * ids only, and nothing is written.
 */

const WS = "wks_links";
const SECRET_REQUEST = "Private request text about invoices";
const SECRET_QUESTION = "Private question about the vendor";
const SECRET_TITLE = "Private bead title";

const R_MED = "req-20260926T100000Z";
const R_SMALL = "req-20260926T110000Z";
const R_NOREVIEW = "req-20260926T120000Z";
const R_GHOST = "req-20260926T130000Z";
const R_COMMIT = "req-20260926T140000Z";
const R_OPEN = "req-20260926T150000Z";
const R_OLD = "req-20260920T100000Z";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let home: string;
let repo: string;

const t = (hour: number, minute: number, day = "2026-09-26"): string => `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

interface RequestShape {
  requestId: string;
  hour: number;
  day?: string;
  tier: "Small" | "Medium";
  filesChanged: string[];
  beads: string[];
  reviewed: boolean;
  /** A file the Worker's turn edited (absolute, as Claude records it). */
  edited?: string;
  finished?: boolean;
}

function requestRecords(shape: RequestShape): TraceRecord[] {
  const { requestId, hour, day } = shape;
  const when = (minute: number) => t(hour, minute, day);
  const worker = `agent-worker-${requestId}`;
  const reviewer = `agent-reviewer-${requestId}`;
  const base = { workspaceId: WS, requestId };
  const records: TraceRecord[] = [
    turn({ ...base, at: when(1), turnId: `m-1-${requestId}`, startedAt: when(0), endedAt: when(1), sent: [msg(MANAGER, when(0), SECRET_REQUEST, "user")] }),
    turn({
      ...base,
      agentId: worker,
      role: "worker",
      at: when(4),
      turnId: "w-1",
      startedAt: when(2),
      endedAt: when(4),
      sent: [msg(worker, when(2), `Request ${requestId}: ${SECRET_REQUEST}`, "agent")],
      evidence: shape.edited === undefined ? [] : [file(join(repo, shape.edited), when(3), worker)],
    }),
  ];
  if (shape.reviewed) {
    records.push(
      turn({
        ...base,
        agentId: reviewer,
        role: "reviewer",
        at: when(6),
        turnId: "r-1",
        endedAt: when(6),
        reviews: [{ agentId: reviewer, at: when(5), batchId: "b1", verdict: "pass", blockingCount: 0 }],
      }),
    );
  }
  const phase = shape.finished === false ? "received" : "finished";
  records.push(
    turn({
      ...base,
      at: when(8),
      turnId: `m-2-${requestId}`,
      startedAt: when(7),
      endedAt: when(8),
      sent: [msg(MANAGER, when(7), `BM-REPORT\nrequestId: ${requestId}\nphase: ${phase}`, "agent")],
      reports: [
        report({
          agentId: worker,
          at: when(7),
          requestId,
          phase,
          tier: shape.tier,
          filesChanged: shape.filesChanged,
          beadsCreated: shape.beads,
          beadsClosed: shape.beads,
          buildAndTests: "`npm test`: 3 passed",
          blockers: "none",
        }),
      ],
    }),
  );
  return records;
}

/**
 * Five finished requests in the window, one open, one finished before it:
 * - R_MED (Medium): a bead, a file, a decision, a review — complete;
 * - R_SMALL (Small): a file only — complete, its beads, review and decisions stated absent;
 * - R_NOREVIEW (Medium): no review — review missing;
 * - R_GHOST (Medium): names a bead the bead store does not hold — beads missing;
 * - R_COMMIT (Medium): a commit by time touches a file no record names — change missing.
 */
const SHAPES: RequestShape[] = [
  { requestId: R_MED, hour: 10, tier: "Medium", filesChanged: ["src/a.ts"], beads: ["bm-1"], reviewed: true, edited: "src/a.ts" },
  { requestId: R_SMALL, hour: 11, tier: "Small", filesChanged: ["docs/typo.md"], beads: [], reviewed: false },
  { requestId: R_NOREVIEW, hour: 12, tier: "Medium", filesChanged: ["src/b.ts"], beads: ["bm-2"], reviewed: false },
  { requestId: R_GHOST, hour: 13, tier: "Medium", filesChanged: ["src/c.ts"], beads: ["bm-ghost"], reviewed: true },
  { requestId: R_COMMIT, hour: 14, tier: "Medium", filesChanged: ["src/d.ts"], beads: ["bm-3"], reviewed: true },
  { requestId: R_OPEN, hour: 15, tier: "Medium", filesChanged: ["src/e.ts"], beads: ["bm-4"], reviewed: true, finished: false },
  { requestId: R_OLD, hour: 10, day: "2026-09-20", tier: "Medium", filesChanged: ["src/old.ts"], beads: ["bm-old"], reviewed: true },
];

const gitIn = (when: string | null, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(when === null ? {} : { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }),
    },
    stdio: "pipe",
  });

function commit(when: string, message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  gitIn(null, "add", ".");
  gitIn(when, "commit", "-q", "-m", message);
}

function writeRepository(): void {
  mkdirSync(repo, { recursive: true });
  gitIn(null, "init", "-q", "-b", "main");
  commit("2026-09-26T09:00:00Z", "Start", { "README.md": "# Links\n", "src/a.ts": "// a\n", "src/d.ts": "// d\n" });
  // In R_COMMIT's span, naming no bead: src/d.ts is its file, src/extra.ts is in no record of it.
  commit("2026-09-26T14:05:00Z", "Tidy formatting", { "src/d.ts": "export const d = 1;\n", "src/extra.ts": "export const extra = 2;\n" });
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const bead = (id: string) => JSON.stringify({ id, title: `${SECRET_TITLE} ${id}`, status: "closed", issue_type: "task", updated_at: t(16, 0), description: null });
  writeFileSync(join(repo, ".beads", "issues.jsonl"), `${["bm-1", "bm-2", "bm-3", "bm-4", "bm-old"].map(bead).join("\n")}\n`);
}

function writeStore(): void {
  const dir = join(home, "traces", WS);
  mkdirSync(dir, { recursive: true });
  const records = SHAPES.flatMap(requestRecords);
  writeFileSync(join(dir, "events-202609.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ lastKnownName: "links", lastKnownDirectory: repo, lastSeenAt: t(16, 0) }));
  mkdirSync(join(home, "decisions"), { recursive: true });
  const decisions = [
    makeDecision({ id: `q:${R_MED}:Q1`, workspaceId: WS, requestId: R_MED, askedAt: t(10, 3), question: SECRET_QUESTION }),
    makeDecision({ id: `q:${R_NOREVIEW}:Q1`, workspaceId: WS, requestId: R_NOREVIEW, askedAt: t(12, 3), question: SECRET_QUESTION }),
    // Not a decision: counted, never read.
    { id: "broken", workspaceId: WS },
  ];
  writeFileSync(join(home, "decisions", `${WS}.json`), JSON.stringify({ version: DECISIONS_FILE_VERSION, entries: decisions }));
}

const WINDOW = ["--since", "2026-09-25T00:00:00Z", "--until", "2026-09-27T00:00:00Z"];

function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runReplay(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { env: {}, homedir: () => "/nonexistent-home" });
  return { code, stdout, stderr };
}

function audit(argv: string[]): { report: ReplayReport; audit: LinksAudit } {
  const result = run(["--home", home, "--json", ...WINDOW, ...argv]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout) as ReplayReport;
  expect(report.linksAudit).toBeDefined();
  return { report, audit: report.linksAudit! };
}

/** Every file under `dir` with its size, mtime and bytes, and every folder. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) {
      out[path] = "dir";
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = statSync(path);
    out[path] = `${stat.size}:${stat.mtimeMs}:${readFileSync(path).toString("base64")}`;
  }
  return out;
}

const byRequest = (result: LinksAudit, requestId: string) => result.outputs.filter((output) => output.requestId === requestId);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bm-links-audit-"));
  home = join(root, "data");
  repo = join(root, "repo");
  if (!hasGit) return;
  writeRepository();
  writeStore();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearBeadsCache();
});

describe("links audit: the seeded draw (evaluation design §4 A-10)", () => {
  const population = (count: number): Record<OutputKind, Output[]> => ({
    bead: Array.from({ length: count }, (_, index) => ({ kind: "bead" as const, workspaceId: "w", requestId: `r${index % 7}`, id: `bm-${index}` })),
    file: Array.from({ length: count }, (_, index) => ({ kind: "file" as const, workspaceId: "w", requestId: `r${index % 5}`, id: `f${index}` })),
    decision: Array.from({ length: 3 }, (_, index) => ({ kind: "decision" as const, workspaceId: "w", requestId: `r${index}`, id: `q:r${index}:Q1` })),
  });

  it("is reproducible: the same outputs, seed and size draw the same sample, whatever order the outputs came in", () => {
    const outputs = population(40);
    const first = drawOutputs(outputs, { size: 30, seed: 20261001 });
    const again = drawOutputs(
      { bead: [...outputs.bead].reverse(), file: [...outputs.file].reverse(), decision: [...outputs.decision].reverse() },
      { size: 30, seed: 20261001 },
    );
    expect(again.drawn).toEqual(first.drawn);
    expect(drawOutputs(outputs, { size: 30, seed: 7 }).drawn).not.toEqual(first.drawn);
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });

  it("fills a short kind from the others in turn and reports the counts per kind", () => {
    const { drawn, quota, filledFromOthers } = drawOutputs(population(40), { size: 30, seed: 3 });
    expect(quota).toEqual({ bead: 10, file: 10, decision: 10 });
    expect(drawn).toHaveLength(30);
    // 3 decisions: 7 short, filled bead, file, bead, file, …
    expect(drawn.filter((output) => output.kind === "decision")).toHaveLength(3);
    expect(filledFromOthers).toEqual({ bead: 4, file: 3, decision: 0 });
    expect(new Set(drawn.map((output) => `${output.kind}:${output.id}`)).size).toBe(30);
    expect(quotaOf(31)).toEqual({ bead: 11, file: 10, decision: 10 });
  });

  it("takes everything when the population is smaller than the sample", () => {
    const { drawn, filledFromOthers } = drawOutputs(population(2), { size: 30, seed: 3 });
    expect(drawn).toHaveLength(7);
    expect(filledFromOthers).toEqual({ bead: 0, file: 0, decision: 0 });
  });
});

describe.skipIf(!hasGit)("links audit in the replay: a synthetic store and a temporary repository", () => {
  it("draws from the window's finished requests only, reproducibly, and fills a short kind", () => {
    const { report, audit: result } = audit(["--links-sample", "9", "--seed", "42"]);
    expect(result.population.finishedRequests).toBe(5);
    expect(result.population.finishedRequests).toBe(report.metrics.requests.finished);
    expect(result.population.outputs).toEqual({ bead: 4, file: 5, decision: 2 });
    expect(result.draw).toEqual({
      quota: { bead: 3, file: 3, decision: 3 },
      drawn: { bead: 4, file: 3, decision: 2 },
      filledFromOthers: { bead: 1, file: 0, decision: 0 },
      total: 9,
    });
    expect(result.outputs.map((output) => output.requestId)).not.toContain(R_OPEN);
    expect(result.outputs.map((output) => output.requestId)).not.toContain(R_OLD);
    expect(result.unknowns.invalidDecisions).toBe(1);
    // The same store, window and seed: the same outputs and the same verdicts.
    expect(audit(["--links-sample", "9", "--seed", "42"]).audit).toEqual(result);
  });

  it("judges each required link found, stated absent or missing, and names the missing ones", () => {
    const { audit: result } = audit(["--links-sample", "30", "--seed", "1"]);
    expect(result.draw.total).toBe(11);

    // Complete: every link found.
    for (const output of byRequest(result, R_MED)) {
      expect(output).toMatchObject({ complete: true, missing: [] });
      expect(output.links).toEqual({ request: "found", decisions: "found", beads: "found", change: "found", review: "found", turns: "found" });
    }
    // A Small request: no question, no bead, no review — each absent with the reason the chain states; complete.
    const small = byRequest(result, R_SMALL);
    expect(small).toHaveLength(1);
    expect(small[0]).toMatchObject({ kind: "file", id: null, complete: true, missing: [] });
    expect(small[0]!.links).toEqual({ request: "found", decisions: "absent", beads: "absent", change: "found", review: "absent", turns: "found" });
    // A Medium request with no review: missing.
    for (const output of byRequest(result, R_NOREVIEW)) expect(output).toMatchObject({ complete: false, missing: ["review"] });
    // A bead the bead store does not hold: missing.
    for (const output of byRequest(result, R_GHOST)) expect(output).toMatchObject({ complete: false, missing: ["beads"] });

    expect(result.complete).toBe(4);
    expect(result.incomplete).toBe(7);
    expect(result.rate).toBeCloseTo(4 / 11);
    expect(result.byKind).toEqual({ bead: { drawn: 4, complete: 1 }, file: { drawn: 5, complete: 2 }, decision: { drawn: 2, complete: 1 } });
    expect(result.missingByLink).toEqual({ request: 0, decisions: 0, beads: 2, change: 2, review: 3, turns: 0 });
    expect(result.links.review).toEqual({ found: 7, absent: 1, missing: 3 });
    expect(result.causes).toEqual({ beadNotInStore: 2, changeOnlyCommitByTime: 2 });
    expect(Object.keys(result.links)).toEqual([...A10_LINKS]);
    expect(result.unknowns.commitsUnread).toBe(0);
  });

  it("counts a change linked only by a commit by time incomplete, while a commit is never required", () => {
    const { audit: result } = audit(["--links-sample", "30", "--seed", "1"]);
    const outputs = byRequest(result, R_COMMIT);
    expect(outputs.map((output) => output.kind).sort()).toEqual(["bead", "file"]);
    for (const output of outputs) expect(output).toMatchObject({ complete: false, missing: ["change"] });
    // R_MED, R_SMALL, R_NOREVIEW and R_GHOST have no commit in their span, and nothing is missing for it.
    expect(byRequest(result, R_MED).every((output) => output.complete)).toBe(true);
  });

  it("an absent link with no stated reason, and an output without a rebuilt chain, count as missing", () => {
    const records = SHAPES.flatMap(requestRecords);
    const trace = reconstructTraces({ records, agents: [] }).find((candidate) => candidate.requestId === R_SMALL)!;
    const chain = deriveChain(trace, {
      workspaceId: WS,
      agents: null,
      workspaceDirectory: repo,
      decisions: { ok: true, value: [] },
      precedents: { ok: true, value: [] },
      beads: { ok: true, value: { present: false, beads: new Map() } },
      commits: { ok: true, commits: [], truncated: false },
      env: {},
    })!;
    expect(judgeChain(chain).links.review).toBe("absent");
    expect(judgeChain({ ...chain, reviews: { ...chain.reviews, reason: "" } }).links.review).toBe("missing");
    expect(Object.values(judgeChain(null).links)).toEqual(A10_LINKS.map(() => "missing"));
  });

  it("prints numbers, link kinds and ids only: no message text, bead title, reason or path", () => {
    const json = run(["--home", home, "--json", ...WINDOW, "--links-sample", "30", "--seed", "5"]);
    const markdown = run(["--home", home, ...WINDOW, "--links-sample", "30", "--seed", "5"]);
    for (const { stdout, code } of [json, markdown]) {
      expect(code).toBe(0);
      for (const forbidden of [SECRET_REQUEST, SECRET_QUESTION, SECRET_TITLE, repo, home, "src/", "docs/typo.md", "Small request", "no BM-REVIEW"]) {
        expect(stdout).not.toContain(forbidden);
      }
    }
    const parsed = JSON.parse(json.stdout) as ReplayReport;
    for (const output of parsed.linksAudit!.outputs) {
      if (output.kind === "file") expect(output.id).toBeNull();
      else expect(output.id).toMatch(/^(?:bm-|q:)/);
    }
    expect(markdown.stdout).toContain("## Links audit (A-10)");
    expect(markdown.stdout).toContain("**Complete chains: 4 / 11 (36.4 %).**");
    expect(markdown.stdout).toContain("| review | 7 | 1 | 3 |");
  });

  it("leaves the output as it was without --links-sample", () => {
    const plain = run(["--home", home, "--json", ...WINDOW]);
    expect(plain.code).toBe(0);
    expect((JSON.parse(plain.stdout) as ReplayReport).linksAudit).toBeUndefined();
    const markdown = run(["--home", home, ...WINDOW]);
    expect(markdown.stdout).not.toContain("Links audit");
  });

  it("is read-only: the data folder's files, sizes and mtimes and every byte of the repository, .git included, are unchanged", () => {
    const homeBefore = fingerprint(home);
    const repoBefore = fingerprint(repo);
    run(["--home", home, "--json", ...WINDOW, "--links-sample", "30", "--seed", "9"]);
    run(["--home", home, "--links-sample", "3", "--seed", "10"]);
    expect(fingerprint(home)).toEqual(homeBefore);
    expect(fingerprint(repo)).toEqual(repoBefore);
  });
});

describe("links audit command line", () => {
  it("needs --links-sample and --seed together, as whole numbers in range", () => {
    for (const argv of [
      ["--links-sample", "30"],
      ["--seed", "1"],
      ["--links-sample", "0", "--seed", "1"],
      ["--links-sample", "30", "--seed", "-1"],
      ["--links-sample", "3.5", "--seed", "1"],
      ["--links-sample", "30", "--seed", "4294967296"],
      ["--links-sample", "30", "--links-sample", "30", "--seed", "1"],
    ]) {
      const result = run(["--home", root, ...argv]);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr).toContain("usage: npm run eval:replay");
    }
    expect(run(["--help"]).stdout).toContain("--links-sample <n>");
  });
});
