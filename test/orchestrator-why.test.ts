import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { REDACTED } from "../plugin/server/collector";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { clearLinksCache } from "../plugin/server/links";
import { ORCHESTRATOR_FIRST_PROMPT } from "../plugin/server/orchestrator-agent";
import { createOrchestratorTools, type OrchestratorTools } from "../plugin/server/orchestrator-tools";
import { WHY_BOUNDED_NOTE, WHY_FULL_BOUNDED_NOTE, boundedJson } from "../plugin/server/orchestrator-why";
import type { GitRunner } from "../plugin/server/repo-tool";
import { REQUEST_MAX_CHARS } from "../plugin/server/request-render";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { ORCHESTRATOR_SERVER_TOOLS, REQUEST_SUMMARY_MAX_CHARS } from "../plugin/shared/bm-tools";
import type { TraceRecord } from "../plugin/shared/contracts";
import type { Decision } from "../plugin/shared/decisions";
import { MANAGER, WORKSPACE_ID, at, file, msg, report, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * `bm_why` (autonomy design §E.2, REQ-151, REQ-152; bead 3e5v.3): the chain
 * behind a bead, a changed file or a decision, through the Orchestrator's
 * registry, on a temporary data folder and workspace with a fake Paseo SDK and
 * a fake `git` — never the real HOME, a daemon or a real repository.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
const SECRET = "tok-very-secret-123";
const REQ_A = "req-20260926T100020Z";
const REQ_B = "req-20260926T101500Z";
const REQ_BIG = "req-20260926T103000Z";
const W1 = "agent-worker-1";
const W3 = "agent-worker-3";
const W_BIG = "agent-worker-big";
const HASH_BEAD = "a".repeat(40);
const HASH_PATH = "b".repeat(40);

let root: string;
let home: string;
let repo: string;
let gitRuns: number;
let gitLog: string;

const location = () => ({ tracesDir: join(home, "traces") });
const count = (text: string) => Array.from(text).length;

/** One `git log` record as `links.ts` asks for it: hash, committer date, message, then the files. */
const logEntry = (hash: string, when: string, message: string, files: readonly string[]) => `\x1e${hash}\x1f${when}\x1f${message}\x1f\n${files.join("\n")}\n`;

const git: GitRunner = async () => {
  gitRuns += 1;
  return { stdout: gitLog };
};

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
      evidence: [file("src/invoice/export-pdf.ts", at(2), W1)],
    }),
    turn({
      at: at(9),
      turnId: "m-2",
      requestId: REQ_A,
      endedAt: at(9),
      reports: [
        report({
          agentId: W1,
          at: at(8, 30),
          requestId: REQ_A,
          phase: "finished",
          tier: "Small",
          filesChanged: ["src/invoice/export-pdf.ts"],
          beadsCreated: ["bm-p1"],
          beadsClosed: ["bm-p1"],
          buildAndTests: "none ran",
          blockers: "none",
        }),
      ],
    }),
    turn({ at: at(15, 10), turnId: "m-3", requestId: REQ_B, startedAt: at(15), endedAt: at(15, 10), sent: [msg(MANAGER, at(15), "Fix the footer of the PDF", "user")] }),
    turn({
      agentId: W3,
      role: "worker",
      at: at(16),
      turnId: "w-1",
      requestId: REQ_B,
      endedAt: at(16),
      sent: [msg(W3, at(15, 20), `Request ${REQ_B}`, "agent")],
      evidence: [file("src/invoice/export-pdf.ts", at(15, 40), W3)],
    }),
  ];
}

const AGENTS = [
  { id: MANAGER, workspaceId: WORKSPACE_ID, status: "idle", labels: { "bm.role": "manager" } },
  { id: W1, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(0, 45), labels: { "bm.role": "worker", "bm.requestId": REQ_A, "paseo.parent-agent-id": MANAGER } },
  { id: W3, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(15, 15), labels: { "bm.role": "worker", "bm.requestId": REQ_B, "paseo.parent-agent-id": MANAGER } },
];

const DECISIONS: Decision[] = [
  makeDecision({ id: `q:${REQ_A}:Q1`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(2), subject: "pdf-library", question: "Which PDF library?" }),
  makeDecision({ id: `q:${REQ_A}:Q2`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(4), subject: "pdf-library", supersedes: `q:${REQ_A}:Q1` }),
  makeDecision({ id: "o:project-1", workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "orchestrator", agentId: null }, askedAt: at(1), round: null }),
];

async function writeStores(recordList: readonly TraceRecord[], decisions: readonly Decision[], beads: readonly string[]): Promise<void> {
  for (const record of recordList) await appendRecord(location(), record);
  writeWorkspaceMeta(location(), WORKSPACE_ID, { lastKnownName: "invoice-app", lastKnownDirectory: repo, lastSeenAt: at(17) });
  const store = createDecisionStore(home, { log: () => undefined });
  for (const decision of decisions) store.open(decision);
  mkdirSync(join(repo, ".beads"), { recursive: true });
  // An empty .git folder: the repository is found, and the fake runner answers its log.
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".beads", "issues.jsonl"), `${beads.join("\n")}\n`);
}

const bead = (id: string, title: string, description: string | null = null) => JSON.stringify({ id, title, status: "closed", issue_type: "task", updated_at: at(9), description });

function toolsWith(agents: readonly Record<string, unknown>[] = AGENTS): { tools: OrchestratorTools; list: () => number } {
  const fake = fakePaseo({ agents: agents as never, workspaces: [{ id: WORKSPACE_ID, directory: repo }] });
  const tools = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: { PASEO_PASSWORD: SECRET }, git });
  tools.usePaseo(fake.paseo);
  return { tools, list: () => (fake.api.agents.list as unknown as { mock: { calls: unknown[] } }).mock.calls.length };
}

type Item = Record<string, unknown>;
interface LinkView {
  status: string;
  reason?: string;
  /** A cut list ends in a "...[N more]" string. */
  items: Item[];
}
interface ChainView {
  request: Item;
  decisions: LinkView;
  beads: LinkView;
  changes: LinkView;
  commits: LinkView;
  reviews: LinkView;
  turns: LinkView;
  edges: Item[];
}
interface WhyAnswer {
  chains: ChainView[];
  [key: string]: unknown;
}

/** The JSON of an answer, after its bounded note when it has one. */
function jsonOf(text: string): WhyAnswer {
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start)) as WhyAnswer;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-why-"));
  home = join(root, "data");
  repo = join(root, "invoice-app");
  gitRuns = 0;
  gitLog = "";
  clearLinksCache();
  clearBeadsCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("bm_why { workspaceId, bead | file | decision } (autonomy design §E.2)", () => {
  beforeEach(async () => {
    await writeStores(records(), DECISIONS, [bead("bm-p0", "Plan the export"), bead("bm-p1", "Export to PDF", "Split-from: bm-p0")]);
    gitLog = [
      logEntry(HASH_BEAD, "2026-09-26T10:05:00+00:00", "Close bm-p1: export invoices to PDF", ["src/invoice/export-pdf.ts"]),
      logEntry(HASH_PATH, "2026-09-26T10:06:00+00:00", "Tidy the export", ["src/invoice/export-pdf.ts"]),
    ].join("");
  });

  it("by bead: the chain of the request that names it, with its decisions, the bead's record and split edge, and the commit naming it", async () => {
    const { tools } = toolsWith();
    const result = await tools.call("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-p1" });
    expect(result.ok).toBe(true);
    expect(count(result.text)).toBeLessThanOrEqual(REQUEST_SUMMARY_MAX_CHARS);
    const answer = jsonOf(result.text);
    expect(answer).toMatchObject({ workspaceId: WORKSPACE_ID, lookup: { bead: "bm-p1" }, found: true, beadInStore: true });
    expect(answer["reason"]).toBeUndefined();
    expect(answer.chains).toHaveLength(1);
    const chain = answer.chains[0]!;
    expect(chain.request).toMatchObject({ requestId: REQ_A, text: "Export invoices to PDF", tier: "Small", basis: "live", workerIds: [W1] });
    expect(chain.decisions).toMatchObject({ status: "found" });
    expect(chain.decisions.items.map((item) => item["id"])).toEqual([`q:${REQ_A}:Q1`, `q:${REQ_A}:Q2`]);
    expect(chain.beads.items).toEqual([
      { id: "bm-p1", actions: ["created", "closed"], confidence: "exact", via: ["report"], inStore: true, title: "Export to PDF", status: "closed", splitFrom: ["bm-p0"] },
    ]);
    expect(chain.edges).toEqual(
      expect.arrayContaining([
        { kind: "superseded-by", from: `q:${REQ_A}:Q1`, to: `q:${REQ_A}:Q2` },
        { kind: "split-into", from: "bm-p0", to: "bm-p1" },
      ]),
    );
    // The summary: short hashes, a count of files, no sources and no turn list.
    expect(chain.commits.items[0]).toMatchObject({ hash: HASH_BEAD.slice(0, 12), link: "bead", beads: ["bm-p1"], files: 1 });
    expect(chain.turns.items.find((item) => item["agentId"] === W1)).toEqual({ agentId: W1, role: "worker", count: 1, first: at(3), last: at(3) });
    expect(result.text).not.toContain('"source"');
    // A Small request: no review, and the chain says why.
    expect(chain.reviews).toEqual({ status: "absent", reason: "A Small request: no review." });
    expect(gitRuns).toBe(1);
  });

  it("by file: every request whose reports or recorded edits name it, newest first", async () => {
    const { tools } = toolsWith();
    const answer = jsonOf((await tools.call("bm_why", { workspaceId: WORKSPACE_ID, file: "src/invoice/export-pdf.ts" })).text);
    expect(answer).toMatchObject({ lookup: { file: "src/invoice/export-pdf.ts" }, found: true });
    expect(answer.chains.map((chain) => chain.request["requestId"])).toEqual([REQ_B, REQ_A]);
    const change = answer.chains[1]!.changes.items.find((item) => item["path"] === "src/invoice/export-pdf.ts")!;
    expect(change).toMatchObject({ label: "detected", onlyCommitByTime: false });
    expect(change["via"]).toEqual(expect.arrayContaining(["report", "file-evidence", "commit-bead"]));
  });

  it("by decision: the decision and its request's chain; a project-wide decision alone, saying it is in no chain", async () => {
    const { tools } = toolsWith();
    const answer = jsonOf((await tools.call("bm_why", { workspaceId: WORKSPACE_ID, decision: `q:${REQ_A}:Q2` })).text);
    expect(answer).toMatchObject({ found: true, decision: { id: `q:${REQ_A}:Q2`, kind: "question", status: "open", supersedes: `q:${REQ_A}:Q1` } });
    expect(answer.chains.map((chain) => chain.request["requestId"])).toEqual([REQ_A]);

    const project = jsonOf((await tools.call("bm_why", { workspaceId: WORKSPACE_ID, decision: "o:project-1" })).text);
    expect(project).toMatchObject({ found: true, decision: { id: "o:project-1" }, reason: "A project-wide decision (no request): it is in no request's chain.", chains: [] });
  });

  it("with detail: \"full\", each link's source, every turn, full hashes and the commits' files", async () => {
    const { tools } = toolsWith();
    const answer = jsonOf((await tools.call("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-p1", detail: "full" })).text);
    const chain = answer.chains[0]!;
    expect(chain.request["source"]).toBe(`traces:req:${REQ_A}`);
    expect(chain.commits.items[0]).toMatchObject({ hash: HASH_BEAD, files: ["src/invoice/export-pdf.ts"] });
    expect(chain.turns.items.find((item) => item["agentId"] === W1)!["turns"]).toEqual([
      { key: `${W1}@${at(3)}`, endedAt: at(3), turnId: "w-1", outcome: "completed" },
    ]);
  });

  it("refuses anything but exactly one of bead, file or decision, reading nothing", async () => {
    const { tools, list } = toolsWith();
    expect(await tools.call("bm_why", { workspaceId: WORKSPACE_ID })).toEqual({
      ok: false,
      text: "The call was refused. Fix these and call bm_why again:\n- input: give one of bead, file or decision",
    });
    expect(await tools.call("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-p1", file: "a.ts", decision: "o:x" })).toEqual({
      ok: false,
      text: "The call was refused. Fix these and call bm_why again:\n- input: give only one of bead, file or decision, not bead and file and decision",
    });
    expect(await tools.call("bm_why", { workspaceId: WORKSPACE_ID, request: REQ_A })).toMatchObject({ ok: false, text: expect.stringContaining("- input.request: is not a field of this tool") });
    expect(await tools.call("bm_why", { bead: "bm-p1" })).toMatchObject({ ok: false, text: expect.stringContaining("- input.workspaceId: is required") });
    expect(list()).toBe(0);
    expect(gitRuns).toBe(0);
  });

  it("answers an unknown project and an unknown id as not found, with the reason, never a throw", async () => {
    const { tools } = toolsWith();
    const nowhere = await tools.call("bm_why", { workspaceId: "wks_nowhere", bead: "bm-p1" });
    expect(nowhere.ok).toBe(true);
    expect(jsonOf(nowhere.text)).toEqual({
      workspaceId: "wks_nowhere",
      lookup: { bead: "bm-p1" },
      found: false,
      reason: "No paseo-bm project wks_nowhere: use the workspaceId bm_projects gave.",
      chains: [],
    });
    expect(gitRuns).toBe(0);

    const cases: Array<[Record<string, string>, Record<string, unknown>]> = [
      [{ bead: "bm-nowhere" }, { found: false, beadInStore: false, reason: "No request's reports or br commands name bm-nowhere." }],
      [{ file: "src/nowhere.ts" }, { found: false, reason: "No request's reports or recorded edits name src/nowhere.ts." }],
      [{ decision: "q:nowhere:Q1" }, { found: false, reason: "No decision q:nowhere:Q1 is stored for this project." }],
    ];
    for (const [lookup, expected] of cases) {
      const result = await tools.call("bm_why", { workspaceId: WORKSPACE_ID, ...lookup });
      expect(result.ok, JSON.stringify(lookup)).toBe(true);
      expect(jsonOf(result.text)).toEqual({ workspaceId: WORKSPACE_ID, lookup, chains: [], ...expected });
    }
  });
});

describe("bm_why's bound and masking on a large chain (autonomy design §A.9, §E.2)", () => {
  const FILES = Array.from({ length: 400 }, (_, index) => `src/module-${index}/component-${index}-with-a-longer-name.ts`);
  const BEADS = Array.from({ length: 300 }, (_, index) => `bm-big-${index}`);

  beforeEach(async () => {
    const big: TraceRecord[] = [
      turn({ at: at(30, 10), turnId: "m-1", requestId: REQ_BIG, startedAt: at(30), endedAt: at(30, 10), sent: [msg(MANAGER, at(30), `Export everything with --password ${SECRET} and ${SECRET}`, "user")] }),
      ...Array.from({ length: 150 }, (_, index) =>
        turn({
          agentId: W_BIG,
          role: "worker",
          at: at(31 + Math.floor(index / 6), index % 60),
          turnId: `w-${index % 3}`,
          requestId: REQ_BIG,
          endedAt: at(31 + Math.floor(index / 6), index % 60),
        }),
      ),
      turn({
        at: at(59),
        turnId: "m-2",
        requestId: REQ_BIG,
        endedAt: at(59),
        reports: [
          report({
            agentId: W_BIG,
            at: at(58),
            requestId: REQ_BIG,
            phase: "finished",
            tier: "Large",
            filesChanged: [`src/${SECRET}/config.ts`, ...FILES],
            beadsCreated: BEADS,
            beadsClosed: BEADS,
            buildAndTests: "none ran",
            blockers: "none",
          }),
        ],
      }),
    ];
    const decisions = Array.from({ length: 40 }, (_, index) =>
      makeDecision({ id: `q:${REQ_BIG}:Q${index + 1}`, workspaceId: WORKSPACE_ID, requestId: REQ_BIG, askedAt: at(32, index), question: `Use ${SECRET} for step ${index}?` }),
    );
    await writeStores(big, decisions, BEADS.map((id) => bead(id, `Bead ${id} keeps ${SECRET} out`)));
    gitLog = Array.from({ length: 200 }, (_, index) =>
      logEntry(`${String(index).padStart(4, "0")}${"c".repeat(36)}`, "2026-09-26T10:40:00+00:00", `Close bm-big-${index}: ship ${SECRET}`, FILES.slice(index, index + 5)),
    ).join("");
  });

  const agents = [
    { id: MANAGER, workspaceId: WORKSPACE_ID, status: "idle", labels: { "bm.role": "manager" } },
    { id: W_BIG, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(30, 20), labels: { "bm.role": "worker", "bm.requestId": REQ_BIG, "paseo.parent-agent-id": MANAGER } },
  ];

  it("keeps the summary within 4,000 characters, the note first and the longest lists cut, every secret masked", async () => {
    const { tools } = toolsWith(agents);
    const result = await tools.call("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-big-7" });
    expect(result.ok).toBe(true);
    expect(count(result.text)).toBeLessThanOrEqual(REQUEST_SUMMARY_MAX_CHARS);
    expect(result.text.startsWith(`${WHY_BOUNDED_NOTE}\n`)).toBe(true);
    expect(result.text).not.toContain(SECRET);
    const answer = jsonOf(result.text);
    expect(answer).toMatchObject({ found: true, lookup: { bead: "bm-big-7" } });
    const chain = answer.chains[0]!;
    expect(chain.request).toMatchObject({ requestId: REQ_BIG, tier: "Large" });
    expect(chain.request["text"]).toContain(REDACTED);
    // The long lists end in their count of what was cut; every link keeps its status.
    for (const link of ["decisions", "beads", "changes", "commits"] as const) {
      expect(chain[link].status, link).toBe("found");
      expect(chain[link].items.at(-1), link).toMatch(/^\.\.\.\[\d+ more\]$/);
    }
    const cut = String(chain.beads.items.at(-1));
    expect(chain.beads.items.length - 1 + Number(/\d+/.exec(cut)![0])).toBe(BEADS.length);
  });

  it("keeps detail: \"full\" within 60,000 characters, masked, with its own note", async () => {
    const { tools } = toolsWith(agents);
    const result = await tools.call("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-big-7", detail: "full" });
    expect(result.ok).toBe(true);
    expect(count(result.text)).toBeLessThanOrEqual(REQUEST_MAX_CHARS);
    expect(count(result.text)).toBeGreaterThan(REQUEST_SUMMARY_MAX_CHARS);
    expect(result.text.startsWith(`${WHY_FULL_BOUNDED_NOTE}\n`)).toBe(true);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain(REDACTED);
    const chain = jsonOf(result.text).chains[0]!;
    expect(chain.request["source"]).toBe(`traces:req:${REQ_BIG}`);
  });
});

describe("boundedJson", () => {
  it("returns what fits as it is, and cuts the list of chains only after the lists inside them", () => {
    expect(boundedJson({ a: [1, 2, 3] }, 100, "note")).toBe('{"a":[1,2,3]}');
    const value = { chains: [{ items: Array.from({ length: 50 }, (_, index) => `item-${index}`) }, { items: ["x"] }] };
    const text = boundedJson(value, 200, "note");
    expect(count(text)).toBeLessThanOrEqual(200);
    const parsed = JSON.parse(text.slice("note\n".length)) as { chains: Array<{ items: string[] }> };
    expect(parsed.chains).toHaveLength(2);
    expect(parsed.chains[0]!.items.at(-1)).toMatch(/^\.\.\.\[\d+ more\]$/);
  });

  it("cuts a long string when no list is left to cut, and never goes above the bound", () => {
    const text = boundedJson({ text: "y".repeat(5_000) }, 300, "note");
    expect(count(text)).toBeLessThanOrEqual(300);
    expect(JSON.parse(text.slice("note\n".length))).toMatchObject({ text: expect.stringMatching(/…$/) });
  });
});

describe("the Orchestrator's first prompt (change-011 C6)", () => {
  it("names every tool of its endpoint, bm_why and bm_handoff among them", () => {
    for (const face of ORCHESTRATOR_SERVER_TOOLS) expect(ORCHESTRATOR_FIRST_PROMPT, face.name).toContain(`${face.name} (`);
    expect(ORCHESTRATOR_FIRST_PROMPT).toContain("bm_why (why a bead, a changed file or a decision exists");
    expect(ORCHESTRATOR_FIRST_PROMPT).toContain("bm_handoff (have a Worker's request handed to a new Worker");
  });
});
