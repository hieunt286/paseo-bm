import { execFileSync } from "node:child_process";
import type * as NodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  chainsOfBead,
  chainsOfDecision,
  chainsOfFile,
  clearLinksCache,
  deriveChain,
  parseGitLog,
  requestChainOf,
  splitFromOf,
  type ChainContext,
  type LinksDeps,
  type RequestChain,
} from "../plugin/server/links";
import { runGit, type GitRunner } from "../plugin/server/repo-tool";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { reconstructTraces } from "../plugin/server/traces";
import type { Decision } from "../plugin/shared/decisions";
import type { Evidence, TraceRecord } from "../plugin/shared/contracts";
import { MANAGER, REVIEWER, WORKSPACE_ID, agent, at, file, msg, report, shell, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";

// Every file read goes through this spy, so the cache test can count them.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const REQ_A = "req-20260926T100020Z";
const REQ_B = "req-20260926T101500Z";
const W1 = "agent-worker-1";
const W2 = "agent-worker-2";
const W3 = "agent-worker-3";
const STRAY = "agent-stray";
const ENV = {};

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

/** Writes `files` (relative to the repository) and commits them at `when`. */
function commit(when: string, message: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  gitIn(null, "add", ".");
  gitIn(when, "commit", "-q", "-m", message);
}

const withStatus = (evidence: Evidence, status: string, exitCode: number | null): Evidence => ({ ...evidence, status, exitCode });

/** Request A (Medium): W1 hands over to W2, one Reviewer, questions, precedents, beads and commits. Request B (Small). One record with no request. */
function records(): TraceRecord[] {
  return [
    turn({ at: at(0, 40), turnId: "m-1", requestId: REQ_A, startedAt: at(0, 20), endedAt: at(0, 40), sent: [msg(MANAGER, at(0, 20), "Export invoices to PDF", "user")] }),
    turn({
      agentId: W1,
      role: "worker",
      at: at(3),
      turnId: "w-1",
      requestId: REQ_A,
      endedAt: at(3),
      sent: [msg(W1, at(1), `Request ${REQ_A}: export invoices`, "agent")],
      evidence: [shell(`br create "Export an invoice to PDF" --json`, at(1, 30), W1), shell("br update bm-p2 --status in_progress", at(1, 40), W1), file(`${repo}/src/invoice/export-pdf.ts`, at(2), W1)],
    }),
    // Paseo reused the turn id: a second, different turn of the same Worker.
    turn({ agentId: W1, role: "worker", at: at(4), turnId: "w-1", requestId: REQ_A, endedAt: at(4), sent: [msg(W1, at(3, 30), "Continue with the totals", "agent")] }),
    turn({
      agentId: W2,
      role: "worker",
      at: at(7),
      turnId: "w-1",
      requestId: REQ_A,
      startedAt: at(5, 30),
      endedAt: at(7),
      sent: [msg(W2, at(5, 30), "You take this request over.", "agent")],
      evidence: [file("src/invoice/totals.ts", at(6, 10), W2), withStatus(shell("npm test", at(6, 40), W2), "completed", 0)],
    }),
    turn({
      agentId: REVIEWER,
      role: "reviewer",
      at: at(8),
      turnId: "r-1",
      requestId: REQ_A,
      endedAt: at(8),
      sent: [msg(REVIEWER, at(7, 10), `Review batch b1 of ${REQ_A}`, "agent")],
      reviews: [
        { agentId: REVIEWER, at: at(7, 30), batchId: "b1", verdict: "changes-required", blockingCount: 1 },
        { agentId: REVIEWER, at: at(7, 50), batchId: "b1", verdict: "pass", blockingCount: 0 },
      ],
    }),
    turn({
      at: at(9),
      turnId: "m-2",
      requestId: REQ_A,
      endedAt: at(9),
      sent: [msg(MANAGER, at(8, 30), `BM-REPORT\nrequestId: ${REQ_A}\nphase: finished`, "agent")],
      reports: [
        report({
          agentId: W2,
          at: at(8, 30),
          requestId: REQ_A,
          phase: "finished",
          tier: "Medium",
          filesChanged: ["src/invoice/export-pdf.ts", "README.md"],
          beadsCreated: ["bm-p1"],
          beadsClosed: ["bm-p1"],
          buildAndTests: "`npm test`: 7 passed",
          blockers: "none",
        }),
      ],
    }),
    // A record with no request: in no chain.
    turn({ agentId: STRAY, role: "worker", at: at(12), turnId: "s-1", requestId: null, endedAt: at(12), evidence: [file("src/invoice/export-pdf.ts", at(12), STRAY)] }),
    turn({ at: at(15, 10), turnId: "m-3", requestId: REQ_B, startedAt: at(15), endedAt: at(15, 10), sent: [msg(MANAGER, at(15), "Fix the typo in the footer", "user")] }),
    turn({ agentId: W3, role: "worker", at: at(16), turnId: "w-1", requestId: REQ_B, endedAt: at(16), sent: [msg(W3, at(15, 20), `Request ${REQ_B}`, "agent")] }),
    turn({
      at: at(17),
      turnId: "m-4",
      requestId: REQ_B,
      endedAt: at(17),
      sent: [msg(MANAGER, at(16, 30), `BM-REPORT\nrequestId: ${REQ_B}\nphase: finished`, "agent")],
      reports: [report({ agentId: W3, at: at(16, 30), requestId: REQ_B, phase: "finished", tier: "Small", buildAndTests: "none ran", blockers: "none" })],
    }),
  ];
}

const AGENTS = [
  { id: MANAGER, workspaceId: WORKSPACE_ID, status: "idle", provider: "bm-manager", labels: { "bm.role": "manager" } },
  { id: W1, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(0, 45), provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": REQ_A, "paseo.parent-agent-id": MANAGER } },
  { id: W2, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(5), provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": REQ_A, "bm.handoffFrom": W1, "paseo.parent-agent-id": MANAGER } },
  { id: REVIEWER, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(7), provider: "bm-reviewer", labels: { "bm.role": "reviewer", "bm.requestId": REQ_A, "paseo.parent-agent-id": W2 } },
  { id: W3, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(15, 15), provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": REQ_B, "paseo.parent-agent-id": MANAGER } },
];

const answeredAt = at(4, 30);
const DECISIONS: Decision[] = [
  makeDecision({ id: `q:${REQ_A}:Q1`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(3), subject: "pdf-library" }),
  makeDecision({
    id: `q:${REQ_A}:Q2`,
    workspaceId: WORKSPACE_ID,
    requestId: REQ_A,
    askedAt: at(4),
    subject: "pdf-library",
    supersedes: `q:${REQ_A}:Q1`,
    status: "answered",
    settledAt: answeredAt,
    answer: { by: "precedent", via: "inbox", optionKey: "a", words: null, at: answeredAt, reason: "Standing answer", precedentId: "p:old-1" },
  }),
  makeDecision({ id: `h:${W2}:perm-1`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedBy: { role: "plugin", agentId: null }, askedAt: at(6), round: null, question: "Allow git push?" }),
  makeDecision({ id: "r:override-1", workspaceId: WORKSPACE_ID, requestId: REQ_A, askedBy: { role: "plugin", agentId: null }, askedAt: at(5), round: null, supersedes: `q:${REQ_A}:Q2` }),
  makeDecision({ id: "f:incident-1", workspaceId: WORKSPACE_ID, requestId: REQ_A, askedBy: { role: "plugin", agentId: null }, askedAt: at(6, 30), round: null }),
  makeDecision({ id: "o:project-1", workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "orchestrator", agentId: null }, askedAt: at(2), round: null }),
];

function writeStores(): void {
  const dir = join(home, "traces", WORKSPACE_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events-202609.jsonl"), `${records().map((record) => JSON.stringify(record)).join("\n")}\n`);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ lastKnownName: "invoice-app", lastKnownDirectory: repo, lastSeenAt: at(17) }));
  const store = createDecisionStore(home, { log: () => undefined });
  for (const decision of DECISIONS) store.open(decision);
  mkdirSync(join(home, "autonomy"), { recursive: true });
  const precedent = (id: string, supersededBy: string | null) => ({
    id,
    scope: "all",
    subject: "pdf-library",
    text: "Use pdf-lib",
    sourceDecisionId: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2026-12-20T00:00:00.000Z",
    supersededBy,
  });
  writeFileSync(join(home, "autonomy", "precedents.json"), JSON.stringify({ version: 1, entries: [precedent("p:old-1", "p:new-1"), precedent("p:new-1", null)] }));
}

function writeRepository(): void {
  mkdirSync(repo, { recursive: true });
  gitIn(null, "init", "-q", "-b", "main");
  commit("2026-09-26T09:00:00Z", "Start", { "README.md": "# Invoices\n", "src/invoice/export-pdf.ts": "// todo\n" });
  commit("2026-09-26T10:05:00Z", "Close bm-p1: export invoices to PDF", { "src/invoice/export-pdf.ts": "export const pdf = 1;\n" });
  commit("2026-09-26T10:08:00Z", "Tidy formatting", { "src/invoice/totals.ts": "export const total = 2;\n", "src/invoice/extra.ts": "export const extra = 3;\n" });
  commit("2026-09-26T10:08:30Z", "Work on bm-other", { "src/other.ts": "export const other = 4;\n" });
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const bead = (id: string, description: string | null) => JSON.stringify({ id, title: `Bead ${id}`, status: "closed", issue_type: "task", updated_at: at(9), description });
  writeFileSync(join(repo, ".beads", "issues.jsonl"), `${[bead("bm-p0", null), bead("bm-p1", "Export to PDF.\n\nSplit-from: bm-p0"), bead("bm-p2", null), bead("bm-other", null)].join("\n")}\n`);
}

function daemon() {
  return fakePaseo({ agents: AGENTS, workspaces: [{ id: WORKSPACE_ID, directory: repo }] });
}

function counting(): { git: GitRunner; runs: string[][] } {
  const runs: string[][] = [];
  const git: GitRunner = (args, options) => {
    runs.push([...args]);
    return runGit(args, options);
  };
  return { git, runs };
}

function depsWith(paseo: LinksDeps["paseo"], git?: GitRunner): LinksDeps {
  return { location: { tracesDir: join(home, "traces") }, paseo, env: ENV, ...(git === undefined ? {} : { git }) };
}

/** Every file under `dir` with its size, mtime and bytes. */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const stat = statSync(path);
    out[path] = `${stat.size}:${stat.mtimeMs}:${readFileSync(path).toString("base64")}`;
  }
  return out;
}

const ids = <T extends { id: string }>(items: readonly T[]) => items.map((item) => item.id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-bm-links-"));
  home = join(root, "data");
  repo = join(root, "invoice-app");
  clearLinksCache();
  clearBeadsCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("links (autonomy design §E.1): the chain behind a request", () => {
  beforeEach(() => {
    writeRepository();
    writeStores();
  });

  it("links decisions with supersession kept, h: and r: of the request, and no project-wide o:", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    expect(chain.request).toMatchObject({ requestId: REQ_A, basis: "live", text: "Export invoices to PDF", tier: "Medium" });
    expect(chain.decisions.status).toBe("found");
    expect(ids(chain.decisions.items).sort()).toEqual([`h:${W2}:perm-1`, "f:incident-1", `q:${REQ_A}:Q1`, `q:${REQ_A}:Q2`, "r:override-1"].sort());
    const q1 = chain.decisions.items.find((item) => item.id === `q:${REQ_A}:Q1`)!;
    expect(q1).toMatchObject({ status: "superseded", supersededBy: `q:${REQ_A}:Q2`, kind: "question", source: { store: "decisions", id: q1.id } });
    expect(chain.decisions.items.find((item) => item.id === `h:${W2}:perm-1`)!.kind).toBe("held");
    expect(chain.decisions.items.find((item) => item.id === "r:override-1")!.kind).toBe("override");
    expect(chain.edges).toContainEqual({ kind: "superseded-by", from: `q:${REQ_A}:Q1`, to: `q:${REQ_A}:Q2`, source: { store: "decisions", id: `q:${REQ_A}:Q1` } });
    expect(chain.edges.filter((edge) => edge.from === `q:${REQ_A}:Q1` && edge.to === `q:${REQ_A}:Q2`)).toHaveLength(1);
    expect(chain.edges).toContainEqual({ kind: "superseded-by", from: `q:${REQ_A}:Q2`, to: "r:override-1", source: { store: "decisions", id: "r:override-1" } });
  });

  it("links a precedent answer to its precedent, with the precedent's supersession as an edge", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    expect(chain.precedents.status).toBe("found");
    expect(chain.precedents.items).toEqual([
      expect.objectContaining({ id: "p:old-1", decisionId: `q:${REQ_A}:Q2`, found: true, supersededBy: "p:new-1", text: "Use pdf-lib", source: { store: "precedents", id: "p:old-1" } }),
    ]);
    expect(chain.edges).toContainEqual({ kind: "superseded-by", from: "p:old-1", to: "p:new-1", source: { store: "precedents", id: "p:old-1" } });
  });

  it("links beads from reports (exact) and from br commands (inferred), with Split-from as an edge", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    expect(chain.beads.status).toBe("found");
    const p1 = chain.beads.items.find((bead) => bead.id === "bm-p1")!;
    expect(p1).toMatchObject({ confidence: "exact", via: ["report"], actions: ["created", "closed"], inStore: true, title: "Bead bm-p1", splitFrom: ["bm-p0"] });
    expect(chain.beads.items.find((bead) => bead.id === "bm-p2")).toMatchObject({ confidence: "inferred", via: ["br"], actions: ["updated"], inStore: true });
    expect(chain.edges).toContainEqual({ kind: "split-into", from: "bm-p0", to: "bm-p1", source: { store: "beads", id: "bm-p1" } });
  });

  it("links changes from filesChanged and file evidence, and commits by bead and by path and time", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    const change = (path: string) => chain.changes.items.find((item) => item.path === path);
    expect(change("src/invoice/export-pdf.ts")).toMatchObject({ label: "detected", via: ["report", "file-evidence", "commit-bead"], onlyCommitByTime: false });
    expect(change("README.md")).toMatchObject({ label: "self-reported", via: ["report"], onlyCommitByTime: false });
    expect(change("src/invoice/totals.ts")).toMatchObject({ label: "detected", via: ["file-evidence", "commit-path-time"], onlyCommitByTime: false });
    // In no report and no file evidence: its only link is a commit by time (incomplete for A-10).
    expect(change("src/invoice/extra.ts")).toMatchObject({ label: null, via: ["commit-path-time"], onlyCommitByTime: true });
    expect(change("src/other.ts")).toBeUndefined();

    expect(chain.commits.status).toBe("found");
    const [byBead, byPath] = [...chain.commits.items].sort((a, b) => (a.at < b.at ? -1 : 1));
    expect(byBead).toMatchObject({ link: "bead", beads: ["bm-p1"], subject: "Close bm-p1: export invoices to PDF", files: ["src/invoice/export-pdf.ts"] });
    expect(byPath).toMatchObject({ link: "path-and-time", beads: [], subject: "Tidy formatting" });
    // "Work on bm-other" names another request's bead: not linked. "Start" is before the span.
    expect(chain.commits.unlinked).toBe(1);
    expect(chain.commits.truncated).toBe(false);
  });

  it("shows the checks as verificationOf labels them, the successor proving again, and the review verdicts by batch", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    expect(chain.checks).toMatchObject({ status: "found", verdict: "detected", named: [{ check: "npm test", label: "detected" }], unverified: false });
    expect(chain.reviews.status).toBe("found");
    expect(chain.reviews.items).toEqual([
      expect.objectContaining({ batchId: "b1", verdict: "pass", reviews: [expect.objectContaining({ verdict: "changes-required" }), expect.objectContaining({ verdict: "pass" })] }),
    ]);
  });

  it("keeps a handoff as an edge between two Workers, and two turns with a reused turn id apart", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_A))!;
    expect(chain.handoffs).toEqual({ status: "found", reason: null, items: [{ kind: "handoff", from: W1, to: W2, source: { store: "paseo", id: `${W2}:bm.handoffFrom` } }] });
    expect(chain.edges).toContainEqual(chain.handoffs.items[0]);
    const w1 = chain.turns.items.find((item) => item.agentId === W1)!;
    expect(w1.count).toBe(2);
    expect(w1.turns.map((item) => item.turnId)).toEqual(["w-1", "w-1"]);
    expect(new Set(w1.turns.map((item) => item.key)).size).toBe(2);
    expect(chain.turns.items.map((item) => item.agentId)).toEqual(expect.arrayContaining([MANAGER, W1, W2, REVIEWER]));
    // A record with no request is attached to no chain.
    expect(chain.turns.items.map((item) => item.agentId)).not.toContain(STRAY);
  });

  it("states why a Small request has no decision, bead, review, change or commit", async () => {
    const chain = (await requestChainOf(depsWith(daemon().paseo), WORKSPACE_ID, REQ_B))!;
    expect(chain.decisions).toEqual({ status: "absent", reason: "No decision carries the request's id: no question was asked.", items: [] });
    expect(chain.beads).toMatchObject({ status: "absent", reason: "A Small request: its reports name no bead." });
    expect(chain.reviews).toMatchObject({ status: "absent", reason: "A Small request: no review." });
    expect(chain.changes).toMatchObject({ status: "absent", reason: expect.stringContaining("filesChanged: none") });
    expect(chain.commits.status).toBe("absent");
    expect(chain.checks).toMatchObject({ status: "found", verdict: "unverified" });
    expect(chain.handoffs.status).toBe("absent");
  });

  it("rebuilds from the store alone without Paseo's agent list: the handoff link is missing with its reason", async () => {
    const chain = (await requestChainOf(depsWith(null), WORKSPACE_ID, REQ_A))!;
    expect(chain.request.basis).toBe("store-only");
    expect(chain.handoffs).toMatchObject({ status: "missing", reason: expect.stringContaining("agent list was not read") });
    expect(chain.handoffs.items).toEqual([]);
    // The rest is read from the stores: the folder from the trace store's meta.json.
    expect(chain.beads.status).toBe("found");
    expect(chain.commits.status).toBe("found");
    expect(chain.turns.items.map((item) => item.agentId)).toEqual(expect.arrayContaining([W1, W2, REVIEWER]));
  });

  it("finds the request(s) behind a bead, a file and a decision", async () => {
    const deps = depsWith(daemon().paseo);
    const requestsOf = (result: { chains: RequestChain[] }) => result.chains.map((chain) => chain.request.requestId);

    expect(await chainsOfBead(deps, WORKSPACE_ID, "bm-p1")).toMatchObject({ beadInStore: true, reason: null });
    expect(requestsOf(await chainsOfBead(deps, WORKSPACE_ID, "bm-p2"))).toEqual([REQ_A]);
    expect(await chainsOfBead(deps, WORKSPACE_ID, "bm-other")).toMatchObject({ beadInStore: true, chains: [], reason: "No request's reports or br commands name bm-other." });
    expect(await chainsOfBead(deps, WORKSPACE_ID, "bm-nope")).toMatchObject({ beadInStore: false, chains: [] });

    expect(requestsOf(await chainsOfFile(deps, WORKSPACE_ID, "src/invoice/export-pdf.ts"))).toEqual([REQ_A]);
    expect(requestsOf(await chainsOfFile(deps, WORKSPACE_ID, join(repo, "src/invoice/totals.ts")))).toEqual([REQ_A]);
    expect(await chainsOfFile(deps, WORKSPACE_ID, "src/nothing.ts")).toMatchObject({ chains: [], reason: expect.stringContaining("src/nothing.ts") });

    const byDecision = await chainsOfDecision(deps, WORKSPACE_ID, `q:${REQ_A}:Q1`);
    expect(byDecision.decision).toMatchObject({ id: `q:${REQ_A}:Q1` });
    expect(requestsOf(byDecision)).toEqual([REQ_A]);
    expect(await chainsOfDecision(deps, WORKSPACE_ID, "o:project-1")).toMatchObject({
      decision: { id: "o:project-1" },
      chains: [],
      reason: "A project-wide decision (no request): it is in no request's chain.",
    });
    expect(await chainsOfDecision(deps, WORKSPACE_ID, "o:unknown")).toMatchObject({ decision: null, chains: [] });
    expect(await requestChainOf(deps, WORKSPACE_ID, "req-20260101T000000Z")).toBeNull();
  });

  it("is read-only: every file of the repository (.git included) and of the data folder is unchanged", async () => {
    const repoBefore = fingerprint(repo);
    const homeBefore = fingerprint(home);
    for (const paseo of [daemon().paseo, null]) {
      clearLinksCache();
      const deps = depsWith(paseo);
      await requestChainOf(deps, WORKSPACE_ID, REQ_A);
      await requestChainOf(deps, WORKSPACE_ID, REQ_B);
      await chainsOfBead(deps, WORKSPACE_ID, "bm-p1");
      await chainsOfFile(deps, WORKSPACE_ID, "README.md");
      await chainsOfDecision(deps, WORKSPACE_ID, `q:${REQ_A}:Q2`);
    }
    expect(fingerprint(repo)).toEqual(repoBefore);
    expect(fingerprint(home)).toEqual(homeBefore);
  });

  it("reads no file and runs no git again while its sources are unchanged; Paseo is read live; a changed source is re-read", async () => {
    const fake = daemon();
    const { git, runs } = counting();
    const deps = depsWith(fake.paseo, git);
    const reads = vi.mocked(readFileSync);
    const readsUnder = () => reads.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(root));

    const first = await requestChainOf(deps, WORKSPACE_ID, REQ_A);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(0, 7)).toEqual(["--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "core.quotePath=false"]);
    const listsBefore = fake.lists.length;
    reads.mockClear();

    expect(await requestChainOf(deps, WORKSPACE_ID, REQ_A)).toEqual(first);
    expect(readsUnder()).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(fake.lists.length).toBeGreaterThan(listsBefore);

    // A new decision of the request: the decision file is read again, nothing else.
    createDecisionStore(home, { log: () => undefined }).open(makeDecision({ id: `q:${REQ_A}:Q3`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(8) }));
    clearDecisionStoreCache();
    reads.mockClear();
    const third = (await requestChainOf(deps, WORKSPACE_ID, REQ_A))!;
    expect(ids(third.decisions.items)).toContain(`q:${REQ_A}:Q3`);
    expect(readsUnder()).toEqual([join(home, "decisions", `${WORKSPACE_ID}.json`)]);
    expect(runs).toHaveLength(1);

    // A new commit: git log runs again.
    commit("2026-09-26T10:09:00Z", "Close bm-p2", { "src/invoice/p2.ts": "export const p2 = 5;\n" });
    const fourth = (await requestChainOf(deps, WORKSPACE_ID, REQ_A))!;
    expect(runs).toHaveLength(2);
    expect(fourth.commits.items.map((item) => item.subject)).toContain("Close bm-p2");
  });

  it("reports git missing, a timeout or an oversized output as a missing commit link, never a throw", async () => {
    const failing = (error: Record<string, unknown>): GitRunner => () => Promise.reject(Object.assign(new Error("git failed"), error));
    const reasonWith = async (error: Record<string, unknown>) => {
      clearLinksCache();
      const chain = (await requestChainOf(depsWith(daemon().paseo, failing(error)), WORKSPACE_ID, REQ_A))!;
      expect(chain.commits.status).toBe("missing");
      // The request's own records still link its changes.
      expect(chain.changes.status).toBe("found");
      return chain.commits.reason;
    };
    expect(await reasonWith({ code: "ENOENT" })).toBe("git is not installed on this machine.");
    expect(await reasonWith({ killed: true, signal: "SIGTERM" })).toBe("git log took longer than 10 seconds.");
    expect(await reasonWith({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })).toBe("git log printed more than 1024 KB.");
    expect(await reasonWith({ stderr: "fatal: your current branch does not have any commits yet\n" })).toBe(
      "git log failed: fatal: your current branch does not have any commits yet",
    );
  });

  it("with an unknown workspace folder, the bead records and commits are missing with their reason", async () => {
    writeFileSync(join(home, "traces", WORKSPACE_ID, "meta.json"), JSON.stringify({ lastKnownName: null, lastKnownDirectory: null, lastSeenAt: at(17) }));
    const chain = (await requestChainOf(depsWith(null), WORKSPACE_ID, REQ_A))!;
    expect(chain.commits).toMatchObject({ status: "missing", reason: "The workspace folder is not known, so its commits were not read." });
    expect(chain.beads.items.find((bead) => bead.id === "bm-p1")).toMatchObject({ inStore: null, recordReason: expect.stringContaining("folder is not known") });
    expect(chain.notices[0]).toMatch(/workspace folder is not known/);
  });

  it("masks secrets in the text it shows", async () => {
    const chain = (await requestChainOf({ ...depsWith(daemon().paseo), env: { PASEO_PASSWORD: "invoices" } }, WORKSPACE_ID, REQ_A))!;
    expect(chain.request.text).toBe("Export [redacted] to PDF");
  });
});

describe("links: the pure derivation", () => {
  const REQ = "req-20260926T100020Z";
  const W = "agent-worker";

  function chainOf(evidence: Evidence[], buildAndTests: string | null, reported = true): RequestChain {
    const trace = reconstructTraces({
      records: [
        turn({ at: at(0, 40), requestId: REQ, sent: [msg(MANAGER, at(0, 20), "Do it", "user")] }),
        turn({ agentId: W, role: "worker", at: at(3), turnId: "w-1", requestId: REQ, evidence: [file("src/a.ts", at(1), W), ...evidence] }),
        turn({
          at: at(5),
          turnId: "m-2",
          requestId: REQ,
          reports: reported ? [report({ agentId: W, at: at(4), requestId: REQ, phase: "finished", tier: "Medium", filesChanged: ["src/a.ts"], buildAndTests, blockers: "none" })] : [],
        }),
      ],
      agents: [agent({ id: MANAGER, role: "manager" }), agent({ id: W, role: "worker", requestIdLabel: REQ })],
    }).find((candidate) => candidate.requestId === REQ)!;
    const context: ChainContext = {
      workspaceId: WORKSPACE_ID,
      agents: new Map(),
      workspaceDirectory: "/work/app",
      decisions: { ok: true, value: [] },
      precedents: { ok: true, value: [] },
      beads: { ok: true, value: { present: false, beads: new Map() } },
      commits: { ok: false, reason: "not read" },
      env: ENV,
    };
    return deriveChain(trace, context)!;
  }

  it("shows the checks in each of the four verdicts", () => {
    expect(chainOf([withStatus(shell("npm test", at(2), W), "completed", 0)], "`npm test`: 3 passed").checks.verdict).toBe("detected");
    expect(chainOf([], "`npm test`: 3 passed").checks.verdict).toBe("self-reported");
    expect(chainOf([], null).checks.verdict).toBe("unverified");
    expect(chainOf([shell("npm test", at(2), W)], "`npm test`: 3 passed").checks.verdict).toBe("not-checked");
  });

  it("a link that should exist and is not found is missing, with its reason; one the report states as none is absent", () => {
    const chain = chainOf([], null);
    expect(chain.reviews).toMatchObject({ status: "missing", reason: "A Medium request with no recorded BM-REVIEW." });
    expect(chain.beads).toMatchObject({ status: "absent", reason: "Its reports name no bead (beadsCreated, beadsUpdated and beadsClosed: none)." });
    expect(chain.commits).toMatchObject({ status: "missing", reason: "not read", unlinked: 0 });
    const unreported = chainOf([], null, false);
    expect(unreported.beads).toMatchObject({ status: "missing", reason: "No report and no br command of the request names a bead." });
    expect(unreported.checks).toMatchObject({ status: "absent", verdict: null });
    expect(unreported.changes.items).toEqual([expect.objectContaining({ path: "src/a.ts", label: "detected", via: ["file-evidence"] })]);
  });

  it("reads Split-from and parses git log output", () => {
    expect(splitFromOf("Provenance\nSplit-from: `bm-autonomy-phase5-3e5v.2`\nSplit-from: bm-a1")).toEqual(["bm-autonomy-phase5-3e5v.2", "bm-a1"]);
    expect(splitFromOf(null)).toEqual([]);
    expect(parseGitLog("\x1eabc1234\x1f2026-09-26T10:05:00Z\x1fClose bm-p1\n\nBody\x1f\n\nsrc/a.ts\nsrc/b.ts\n")).toEqual([
      { hash: "abc1234", at: "2026-09-26T10:05:00Z", message: "Close bm-p1\n\nBody", files: ["src/a.ts", "src/b.ts"] },
    ]);
  });
});
