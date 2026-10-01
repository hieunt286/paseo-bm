import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { clearLinksCache } from "../plugin/server/links";
import { handleLinksWhy, registerLinksRpcs, type LinksRpcDeps } from "../plugin/server/links-rpc";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import type { GitRunner } from "../plugin/server/repo-tool";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { LINKS_WHY_MAX_INPUT_CHARS, linksWhyRpc, type TraceRecord } from "../plugin/shared/contracts";
import type { Decision } from "../plugin/shared/decisions";
import { MANAGER, WORKSPACE_ID, at, file, msg, report, shell, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * `links.why` (autonomy design §E.2, §E.4; change-011 C7) over a temporary
 * data folder and workspace folder, never the real HOME: its input is refused
 * unless it names exactly one lookup, each error is a code that exists, a
 * bead or file no request names comes back as no chain with the reason, the
 * output is bounded and drops the sources, and no file changes.
 */

const REQ_A = "req-20260926T100020Z";
const REQ_B = "req-20260926T101500Z";
const W1 = "agent-worker-1";
const W2 = "agent-worker-2";

let root: string;
let home: string;
let repo: string;

/** Request A: a question superseded by a second, one bead split from another, a changed file, a check. Request B: a Small one. */
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
      evidence: [file(`${repo}/src/invoice/export-pdf.ts`, at(2), W1), { ...shell("npm test", at(2, 30), W1), status: "completed", exitCode: 0 }],
    }),
    turn({
      at: at(9),
      turnId: "m-2",
      requestId: REQ_A,
      endedAt: at(9),
      sent: [msg(MANAGER, at(8, 30), `BM-REPORT\nrequestId: ${REQ_A}\nphase: finished`, "agent")],
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
          buildAndTests: "`npm test`: 7 passed",
          blockers: "none",
        }),
      ],
    }),
    turn({ at: at(15, 10), turnId: "m-3", requestId: REQ_B, startedAt: at(15), endedAt: at(15, 10), sent: [msg(MANAGER, at(15), "Fix the typo in the footer", "user")] }),
    turn({ agentId: W2, role: "worker", at: at(16), turnId: "w-1", requestId: REQ_B, endedAt: at(16), sent: [msg(W2, at(15, 20), `Request ${REQ_B}`, "agent")] }),
  ];
}

const AGENTS = [
  { id: MANAGER, workspaceId: WORKSPACE_ID, status: "idle", labels: { "bm.role": "manager" } },
  { id: W1, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(0, 45), labels: { "bm.role": "worker", "bm.requestId": REQ_A, "paseo.parent-agent-id": MANAGER } },
  { id: W2, workspaceId: WORKSPACE_ID, status: "idle", createdAt: at(15, 15), labels: { "bm.role": "worker", "bm.requestId": REQ_B, "paseo.parent-agent-id": MANAGER } },
];

const DECISIONS: Decision[] = [
  makeDecision({ id: `q:${REQ_A}:Q1`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(3), subject: "pdf-library" }),
  makeDecision({ id: `q:${REQ_A}:Q2`, workspaceId: WORKSPACE_ID, requestId: REQ_A, askedAt: at(4), subject: "pdf-library", supersedes: `q:${REQ_A}:Q1` }),
  makeDecision({ id: "o:project-1", workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "orchestrator", agentId: null }, askedAt: at(2), round: null }),
];

function writeStores(): void {
  const dir = join(home, "traces", WORKSPACE_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events-202609.jsonl"), `${records().map((record) => JSON.stringify(record)).join("\n")}\n`);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ lastKnownName: "invoice-app", lastKnownDirectory: repo, lastSeenAt: at(17) }));
  const store = createDecisionStore(home, { log: () => undefined });
  for (const decision of DECISIONS) store.open(decision);
  mkdirSync(join(repo, "src", "invoice"), { recursive: true });
  writeFileSync(join(repo, "src", "invoice", "export-pdf.ts"), "export const pdf = 1;\n");
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const bead = (id: string, description: string | null) => JSON.stringify({ id, title: `Bead ${id}`, status: "closed", issue_type: "task", updated_at: at(9), description });
  writeFileSync(join(repo, ".beads", "issues.jsonl"), `${[bead("bm-p0", null), bead("bm-p1", "Export to PDF.\n\nSplit-from: bm-p0"), bead("bm-lonely", null)].join("\n")}\n`);
}

/** No `git log` is needed: the workspace folder is not a repository, so the commits are missing with that reason. */
const noGit: GitRunner = () => Promise.reject(new Error("git must not run here"));

function deps(overrides: Partial<LinksRpcDeps> = {}): LinksRpcDeps {
  return { home, env: {}, git: noGit, ...overrides };
}

const paseo = () => fakePaseo<DashboardPaseo>({ agents: AGENTS, workspaces: [{ id: WORKSPACE_ID, directory: repo }] }).paseo;

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

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded: ${String(error)}`;
  }
  return "resolved";
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-bm-links-rpc-"));
  home = join(root, "data");
  repo = join(root, "invoice-app");
  clearLinksCache();
  clearBeadsCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  writeStores();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("links.why: the input", () => {
  const parse = (input: unknown) => linksWhyRpc.input.safeParse(input).success;

  it("takes a workspace and exactly one of requestId, bead, file or decision", () => {
    for (const key of ["requestId", "bead", "file", "decision"]) expect(parse({ workspaceId: WORKSPACE_ID, [key]: "x" }), key).toBe(true);
  });

  it("refuses none, two, an empty or over-long value, an unknown key, and no workspace", () => {
    expect(parse({ workspaceId: WORKSPACE_ID })).toBe(false);
    expect(parse({ workspaceId: WORKSPACE_ID, requestId: REQ_A, bead: "bm-p1" })).toBe(false);
    expect(parse({ workspaceId: WORKSPACE_ID, bead: "" })).toBe(false);
    expect(parse({ workspaceId: WORKSPACE_ID, bead: "   " })).toBe(false);
    expect(parse({ workspaceId: WORKSPACE_ID, file: "a".repeat(LINKS_WHY_MAX_INPUT_CHARS + 1) })).toBe(false);
    expect(parse({ workspaceId: WORKSPACE_ID, requestId: REQ_A, detail: "full" })).toBe(false);
    expect(parse({ requestId: REQ_A })).toBe(false);
    expect(parse({ workspaceId: "", requestId: REQ_A })).toBe(false);
  });
});

describe("links.why: the chain of a request", () => {
  it("answers one chain in order, bounded, with supersession and Split-from as edges and no sources", async () => {
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, paseo(), deps());
    expect(linksWhyRpc.output.parse(output)).toEqual(output);
    expect(output).toMatchObject({ more: 0, reason: null });
    const [chain] = output.chains;
    expect(chain!.request).toMatchObject({ requestId: REQ_A, text: "Export invoices to PDF", basis: "live", tier: "Small" });
    expect(chain!.decisions.items.map((decision) => decision.id).sort()).toEqual([`q:${REQ_A}:Q1`, `q:${REQ_A}:Q2`]);
    expect(chain!.edges).toContainEqual({ kind: "superseded-by", from: `q:${REQ_A}:Q1`, to: `q:${REQ_A}:Q2` });
    expect(chain!.edges).toContainEqual({ kind: "split-into", from: "bm-p0", to: "bm-p1" });
    expect(chain!.beads.items).toEqual([expect.objectContaining({ id: "bm-p1", inStore: true, title: "Bead bm-p1", splitFrom: ["bm-p0"] })]);
    expect(chain!.changes.items).toEqual([expect.objectContaining({ path: "src/invoice/export-pdf.ts", label: "detected" })]);
    expect(chain!.checks).toMatchObject({ status: "found", verdict: "detected", named: [{ check: "npm test", label: "detected" }] });
    expect(chain!.turns.items.map((agent) => [agent.role, agent.count])).toEqual([
      ["manager", 2],
      ["worker", 1],
    ]);
    // Missing links say why, never throw: the folder is not a repository.
    expect(chain!.commits).toMatchObject({ status: "missing", reason: "The workspace folder is not in a git repository." });
    // A Small request: no review, and the chain says so.
    expect(chain!.reviews).toMatchObject({ status: "absent", reason: "A Small request: no review." });
    expect(JSON.stringify(output)).not.toContain('"source"');
  });

  it("an unknown request → E_TRACE_NOT_FOUND", async () => {
    expect(await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: "req-20260101T000000Z" }, paseo(), deps()))).toBe("E_TRACE_NOT_FOUND");
    expect(await codeOf(handleLinksWhy({ workspaceId: "wks_none", requestId: REQ_A }, paseo(), deps()))).toBe("E_TRACE_NOT_FOUND");
  });

  it("rebuilds from the store alone without Paseo's handle: the handoff link is missing with its reason", async () => {
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, null, deps());
    expect(output.chains[0]!.request.basis).toBe("store-only");
    expect(output.chains[0]!.handoffs.status).toBe("missing");
  });
});

describe("links.why: lookups", () => {
  it("a bead names the chains that hold it", async () => {
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, bead: "bm-p1" }, paseo(), deps());
    expect(output.chains.map((chain) => chain.request.requestId)).toEqual([REQ_A]);
    expect(output).toMatchObject({ beadInStore: true, reason: null });
  });

  it("a stored bead no request names → no chain, with the reason", async () => {
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, bead: "bm-lonely" }, paseo(), deps());
    expect(output).toEqual({ chains: [], more: 0, reason: "No request's reports or br commands name bm-lonely.", beadInStore: true });
  });

  it("a bead the bead store does not hold, and no request names → E_BEAD_NOT_FOUND", async () => {
    expect(await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, bead: "bm-nowhere" }, paseo(), deps()))).toBe("E_BEAD_NOT_FOUND");
  });

  it("a file names the chains that changed it; a file no request names → no chain, with the reason", async () => {
    const hit = await handleLinksWhy({ workspaceId: WORKSPACE_ID, file: "src/invoice/export-pdf.ts" }, paseo(), deps());
    expect(hit.chains.map((chain) => chain.request.requestId)).toEqual([REQ_A]);
    const miss = await handleLinksWhy({ workspaceId: WORKSPACE_ID, file: "docs/unknown.md" }, paseo(), deps());
    expect(miss).toEqual({ chains: [], more: 0, reason: "No request's reports or recorded edits name docs/unknown.md." });
  });

  it("a decision answers its request's chain with the decision; a project-wide one comes back alone", async () => {
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, decision: `q:${REQ_A}:Q1` }, paseo(), deps());
    expect(output.decision).toMatchObject({ id: `q:${REQ_A}:Q1`, kind: "question", status: "superseded", supersededBy: `q:${REQ_A}:Q2` });
    expect(output.chains.map((chain) => chain.request.requestId)).toEqual([REQ_A]);
    const alone = await handleLinksWhy({ workspaceId: WORKSPACE_ID, decision: "o:project-1" }, paseo(), deps());
    expect(alone).toMatchObject({ chains: [], reason: "A project-wide decision (no request): it is in no request's chain.", decision: { id: "o:project-1" } });
  });

  it("an unknown decision → E_DECISION_NOT_FOUND", async () => {
    expect(await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, decision: "q:nothing:Q9" }, paseo(), deps()))).toBe("E_DECISION_NOT_FOUND");
  });
});

describe("links.why: the data folder", () => {
  it("no usable data folder → E_DATA_HOME_UNAVAILABLE", async () => {
    expect(await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, paseo(), deps({ home: null })))).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("a decision store that cannot be read → E_DATA_HOME_UNAVAILABLE for a decision; a request's chain says its decisions are missing", async () => {
    const path = join(home, "decisions", `${WORKSPACE_ID}.json`);
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(path));
    rmSync(path);
    symlinkSync(elsewhere, path);
    clearDecisionStoreCache();
    expect(await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, decision: `q:${REQ_A}:Q1` }, paseo(), deps()))).toBe("E_DATA_HOME_UNAVAILABLE");
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, paseo(), deps());
    expect(output.chains[0]!.decisions.status).toBe("missing");
  });
});

describe("links.why: bounds and read-only", () => {
  it("sends at most the bounded number of items of a link and counts the rest", async () => {
    const many = Array.from({ length: 130 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`);
    const dir = join(home, "traces", WORKSPACE_ID);
    // The Worker's edits, as the collector records them.
    const extra = turn({ agentId: W1, role: "worker", at: at(5), turnId: "w-2", requestId: REQ_A, endedAt: at(5), evidence: many.map((path) => file(path, at(4, 30), W1)) });
    writeFileSync(join(dir, "events-202609.jsonl"), `${[...records(), extra].map((record) => JSON.stringify(record)).join("\n")}\n`);
    clearTraceStoreCache();
    const output = await handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, paseo(), deps());
    const changes = output.chains[0]!.changes;
    expect(changes.items).toHaveLength(100);
    expect(changes.more).toBe(31);
  });

  it("writes nothing: the data folder and the workspace folder are unchanged after every lookup", async () => {
    const before = { home: fingerprint(home), repo: fingerprint(repo) };
    await handleLinksWhy({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, paseo(), deps());
    await handleLinksWhy({ workspaceId: WORKSPACE_ID, bead: "bm-p1" }, paseo(), deps());
    await handleLinksWhy({ workspaceId: WORKSPACE_ID, file: "src/invoice/export-pdf.ts" }, paseo(), deps());
    await handleLinksWhy({ workspaceId: WORKSPACE_ID, decision: `q:${REQ_A}:Q2` }, paseo(), deps());
    await codeOf(handleLinksWhy({ workspaceId: WORKSPACE_ID, bead: "bm-nowhere" }, paseo(), deps()));
    expect({ home: fingerprint(home), repo: fingerprint(repo) }).toEqual(before);
  });

  it("registers links.why, and its handler reads with the call's Paseo handle", async () => {
    const handle = vi.fn();
    registerLinksRpcs({ handle } as unknown as Parameters<typeof registerLinksRpcs>[0], deps());
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["links.why"]);
    const handler = handle.mock.calls[0]![1] as (input: unknown, context: { paseo: unknown }) => Promise<{ chains: Array<{ request: { basis: string } }> }>;
    const output = await handler({ workspaceId: WORKSPACE_ID, requestId: REQ_A }, { paseo: paseo() });
    expect(output.chains[0]!.request.basis).toBe("live");
  });
});
