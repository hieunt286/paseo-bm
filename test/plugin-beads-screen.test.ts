import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMessage, getBeadDetail, listBeadRows, runBeadAction } from "../plugin/server/bead-actions";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  handleBeadsAction,
  handleBeadsGet,
  handleBeadsList,
  handleWorkspacesOverview,
  type DashboardPaseo,
} from "../plugin/server/dashboard-rpc";
import {
  EMPTY_FILTER,
  actionSpec,
  activeFilters,
  previewValues,
  sortBeads,
  actionsFor,
  beadsOverview,
  facetsOf,
  filterBeads,
  formatDays,
  statusBucket,
  toggle,
  workSummary,
} from "../plugin/client/beads-model";
import { TRACE_STORE_SCHEMA_VERSION, type BeadRow, type BeadStats } from "../plugin/shared/contracts";

/**
 * The Beads screen (design delta 20260916-beads-screen): list, detail, six
 * overview sections, filters, and three actions that go to the Manager.
 */
let workspace: string;
const WS = "wks_beads";

const bead = (overrides: Record<string, unknown>) => ({
  id: "demo-a",
  title: "A bead",
  description: "## Acceptance Criteria\n- works",
  status: "open",
  priority: 2,
  issue_type: "task",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
  closed_at: null,
  close_reason: "",
  labels: ["feature:demo"],
  dependencies: [],
  ...overrides,
});

function writeStore(lines: unknown[]): void {
  mkdirSync(join(workspace, ".beads"), { recursive: true });
  writeFileSync(join(workspace, ".beads", "issues.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  clearBeadsCache();
}

function fakePaseo(): DashboardPaseo & { agents: { ref: (id: string) => { send: ReturnType<typeof vi.fn> } } } {
  const send = vi.fn(async () => undefined);
  return {
    agents: { list: vi.fn(async () => ({ entries: [] })), ref: () => ({ send }) },
    workspaces: { list: vi.fn(async () => ({ entries: [{ id: WS, directory: workspace }] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  } as never;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "bm-beads-screen-"));
  writeStore([
    bead({ id: "demo-epic", issue_type: "epic", title: "Epic", priority: 1 }),
    bead({
      id: "demo-a",
      status: "closed",
      closed_at: "2026-09-12T10:00:00.000Z",
      updated_at: "2026-09-12T10:00:00.000Z",
      close_reason: "done with evidence",
      dependencies: [{ issue_id: "demo-a", depends_on_id: "demo-epic", type: "parent-child" }],
    }),
    bead({
      id: "demo-b",
      title: "Blocked one",
      priority: "1",
      issue_type: "bug",
      labels: ["feature:demo", "wp:wp-2"],
      dependencies: [{ issue_id: "demo-b", depends_on_id: "demo-c", type: "blocks" }],
    }),
    bead({ id: "demo-c", status: "in_progress", updated_at: "2026-09-15T10:00:00.000Z" }),
  ]);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("reading beads for the screen", () => {
  it("lists every bead with derived readiness and its parent", () => {
    const rows = listBeadRows(workspace);
    expect(rows.map((row) => row.id)).toEqual(["demo-c", "demo-a", "demo-epic", "demo-b"]);
    const b = rows.find((row) => row.id === "demo-b")!;
    expect(b).toMatchObject({ priority: 1, issueType: "bug", ready: false });
    expect(rows.find((row) => row.id === "demo-a")?.parentId).toBe("demo-epic");
  });

  it("returns a bead in full, with its children", () => {
    const epic = getBeadDetail(workspace, "demo-epic");
    expect(epic.children).toEqual(["demo-a"]);
    const a = getBeadDetail(workspace, "demo-a");
    expect(a).toMatchObject({ closeReason: "done with evidence", description: "## Acceptance Criteria\n- works" });
  });

  it("fails with E_BEAD_NOT_FOUND for an unknown id", () => {
    expect(() => getBeadDetail(workspace, "demo-missing")).toThrow(/E_BEAD_NOT_FOUND/);
  });
});

describe("actions go to the Manager, never to the store", () => {
  it("builds an English request that names the action, the bead and the user's confirmation", () => {
    const text = actionMessage("delete", { id: "demo-b", title: "Blocked one" });
    expect(text).toContain('[Beads screen] The user asks: delete bead demo-b ("Blocked one").');
    expect(text).toContain("assess whether this bead is still needed");
    expect(text).toContain("The user confirmed this action");
    expect(text).toContain("Do not commit or push.");
    expect(actionMessage("close", { id: "x", title: null })).toContain("check whether this bead can be closed");
  });

  it("ensures a Manager and sends it the request", async () => {
    const send = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const ensure = vi.fn<(workspaceId: string) => Promise<{ agentId: string; created: boolean }>>(async () => ({
      agentId: "mgr-1",
      created: true,
    }));
    const result = await runBeadAction(
      { workspaceId: WS, action: "implement", bead: { id: "demo-b", title: "Blocked one" } },
      { paseo: { agents: { ref: () => ({ send }) } }, ensure },
    );
    expect(result).toEqual({ managerId: "mgr-1", created: true });
    expect(ensure).toHaveBeenCalledWith(WS);
    expect(send.mock.calls[0]?.[0]).toContain("implement bead demo-b");
  });

  it("sends nothing for an unknown bead", async () => {
    const paseo = fakePaseo();
    const ensure = vi.fn(async () => ({ agentId: "mgr-1", created: false }));
    await expect(
      handleBeadsAction({ workspaceId: WS, id: "demo-missing", action: "close" }, paseo as never, ensure),
    ).rejects.toThrow(/E_BEAD_NOT_FOUND/);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("leaves the bead store byte-identical", async () => {
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(join(workspace, ".beads", "issues.jsonl"), "utf8");
    await handleBeadsAction({ workspaceId: WS, id: "demo-b", action: "delete" }, fakePaseo() as never, async () => ({
      agentId: "mgr-1",
      created: false,
    }));
    expect(readFileSync(join(workspace, ".beads", "issues.jsonl"), "utf8")).toBe(before);
  });
});

describe("list and get handlers", () => {
  it("list returns rows and stats; get returns one bead", async () => {
    const list = await handleBeadsList({ workspaceId: WS }, fakePaseo(), { homedir: () => join(workspace, "no-home") });
    expect(list.beads).toHaveLength(4);
    // No trace store: the list is complete, only the names are missing.
    expect(list.beads.find((row) => row.id === "demo-c")?.work).toBeNull();
    expect(list.stats.total).toBe(4);
    expect((await handleBeadsGet({ workspaceId: WS, id: "demo-c" }, fakePaseo())).bead.status).toBe("in_progress");
  });

  it("list names the Worker of an in-progress bead from the trace store", async () => {
    const home = join(workspace, "bm-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
    await appendRecord({ tracesDir: join(home, "traces") }, {
      v: TRACE_STORE_SCHEMA_VERSION, kind: "turn", at: "2026-09-16T10:00:00.000Z", workspaceId: WS, agentId: "w1",
      role: "worker", turnId: "t1", requestId: "req-A", parentAgentId: null, agentCreatedAt: null, startedAt: null,
      endedAt: "2026-09-16T10:00:00.000Z", outcome: "completed", sent: [], received: [], reports: [], reviews: [], usage: null,
      evidence: [{ kind: "shell", detail: "br update demo-c --status in_progress", agentId: "w1", at: "2026-09-16T09:30:00.000Z" }],
    });
    clearTraceStoreCache();
    const paseo = fakePaseo();
    paseo.config.get = vi.fn(async () => ({ config: { plugins: { "paseo-bm": { source: "directory", path: join(home, "plugin", "0.2.0") } } } }));
    paseo.agents.list = vi.fn(async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
      entries: filter.labels["bm.role"] === "worker" ? [{ id: "w1", workspaceId: WS, status: "idle", title: "Worker for C", labels: {} }] : [],
    })) as never;
    const list = await handleBeadsList({ workspaceId: WS }, paseo, { homedir: () => join(workspace, "no-home") });
    expect(list.beads.find((row) => row.id === "demo-c")?.work?.started).toEqual({
      agentId: "w1", at: "2026-09-16T09:30:00.000Z", title: "Worker for C", status: "idle",
    });
    expect(list.beads.find((row) => row.id === "demo-b")?.work).toBeNull();
  });

  it("list is empty for a workspace Paseo does not list", async () => {
    const list = await handleBeadsList({ workspaceId: "wks_gone" }, fakePaseo(), { homedir: () => join(workspace, "no-home") });
    expect(list).toMatchObject({ beads: [], stats: { present: false } });
  });
});

describe("workspaces.overview", () => {
  it("counts beads and running Workers per listed workspace, and skips archived ones", async () => {
    const paseo = fakePaseo();
    paseo.workspaces.list = vi.fn(async () => ({
      entries: [
        { id: WS, directory: workspace },
        { id: "wks_nobeads", directory: join(workspace, "missing") },
        { id: "wks_archived", directory: workspace, archivingAt: "2026-09-16T00:00:00.000Z" },
      ],
    }));
    paseo.agents.list = vi.fn(async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
      entries:
        filter.labels["bm.role"] === "worker"
          ? [
              { id: "w1", workspaceId: WS, status: "running", labels: {} },
              { id: "w2", workspaceId: WS, status: "idle", labels: {} },
              { id: "w3", workspaceId: "wks_nobeads", status: "running", labels: {} },
            ]
          : [{ id: "r1", workspaceId: WS, status: "running", labels: {} }],
    })) as never;
    const { workspaces } = await handleWorkspacesOverview(paseo);
    expect(workspaces).toEqual([
      { workspaceId: WS, beads: { total: 4, inProgress: 1, blocked: 2, ready: 0 }, runningWorkers: 1 },
      { workspaceId: "wks_nobeads", beads: null, runningWorkers: 1 },
    ]);
  });
});

describe("the six overview sections", () => {
  const rows = (): BeadRow[] => listBeadRows(workspace);
  const stats: BeadStats = {
    total: 4, open: 2, inProgress: 1, blocked: 2, closed: 1, ready: 0,
    readAt: "", source: "", skippedLines: 0, present: true,
  };

  it("summarises status, progress, activity, type, priority and time", () => {
    const view = beadsOverview(rows(), stats, new Date("2026-09-16T12:00:00.000Z"), 7);
    expect(view.status.map((card) => [card.label, card.value])).toEqual([
      ["Total", "4"], ["Ready", "0"], ["In progress", "1"], ["Blocked", "2"], ["Closed", "1"],
    ]);
    // The epic is not work: 1 of 3.
    expect(view.progress).toMatchObject({ closed: 1, total: 3 });
    expect(view.progress.label).toContain("33% done");
    expect(view.activity).toHaveLength(7);
    expect(view.activity.find((day) => day.day === "09-12")).toEqual({ day: "09-12", created: 0, closed: 1 });
    expect(view.byType.map((bar) => [bar.label, bar.value])).toEqual([["task", 2], ["epic", 1], ["bug", 1]]);
    expect(view.byPriority.map((bar) => bar.label)).toEqual(["P1", "P2"]);
    const timing = Object.fromEntries(view.timing.map((card) => [card.label, card.value]));
    expect(timing["Median time to close"]).toBe("2.0d");
    expect(timing["Longest in progress"]).toBe("1.1d");
    // Last updated six days ago: not stale yet.
    expect(timing["Stale"]).toBe("0");
    const later = beadsOverview(rows(), stats, new Date("2026-09-18T12:00:00.000Z"), 7);
    expect(later.timing.find((card) => card.label === "Stale")?.value).toBe("2");
  });

  it("formats durations in hours or days", () => {
    expect(formatDays(null)).toBe("—");
    expect(formatDays(2 * 3_600_000)).toBe("2h");
    expect(formatDays(36 * 3_600_000)).toBe("1.5d");
  });
});

describe("filters", () => {
  const rows = (): BeadRow[] => listBeadRows(workspace);

  it("offers status, type, priority and label facets with counts", () => {
    const facets = facetsOf(rows());
    expect(facets.statuses).toEqual([
      { value: "in_progress", count: 1 },
      { value: "blocked", count: 2 },
      { value: "closed", count: 1 },
    ]);
    expect(facets.types).toEqual([
      { value: "task", count: 2 },
      { value: "bug", count: 1 },
      { value: "epic", count: 1 },
    ]);
    // Every bead is feature:demo, so that group cannot narrow anything and is hidden.
    expect(facets.labelGroups).toEqual([{ category: "wp", values: [{ value: "wp:wp-2", count: 1 }], selected: 0 }]);
  });

  it("counts each facet against the other active filters and hides values that would show nothing", () => {
    const facets = facetsOf(rows(), { ...EMPTY_FILTER, types: new Set(["bug"]) });
    // Only the bug is left, so only its status and priority remain offered…
    expect(facets.statuses).toEqual([{ value: "blocked", count: 1 }]);
    expect(facets.priorities).toEqual([{ value: "P1", count: 1 }]);
    // …while the type facet still shows every type, counted without itself.
    expect(facets.types.map((entry) => entry.value)).toEqual(["task", "bug", "epic"]);
  });

  it("previews five label values, keeps selected ones visible, and lists active filters", () => {
    const values = Array.from({ length: 9 }, (_, index) => ({ value: `wp:wp-${index}`, count: 9 - index }));
    const preview = previewValues(values, new Set(["wp:wp-8"]), false);
    expect(preview.shown.map((entry) => entry.value)).toEqual(["wp:wp-8", "wp:wp-0", "wp:wp-1", "wp:wp-2", "wp:wp-3"]);
    expect(preview.hidden).toBe(4);
    expect(previewValues(values, new Set(), true).hidden).toBe(0);
    expect(activeFilters({ ...EMPTY_FILTER, types: new Set(["bug"]), labels: new Set(["wp:wp-2"]) })).toEqual([
      { facet: "types", value: "bug" },
      { facet: "labels", value: "wp:wp-2" },
    ]);
  });

  it("sorts newest first, flips direction, and keeps missing values last", () => {
    const all = rows();
    expect(sortBeads(all, "updated").map((row) => row.id)).toEqual(["demo-c", "demo-a", "demo-b", "demo-epic"]);
    expect(sortBeads(all, "closed").map((row) => row.id)).toEqual(["demo-a", "demo-b", "demo-c", "demo-epic"]);
    expect(sortBeads(all, "closed", false)[0]?.id).toBe("demo-a");
    expect(sortBeads(all, "priority").map((row) => row.id)).toEqual(["demo-b", "demo-epic", "demo-a", "demo-c"]);
  });

  it("ORs within a facet and ANDs across facets, with text search", () => {
    const all = rows();
    expect(filterBeads(all, EMPTY_FILTER)).toHaveLength(4);
    const byStatus = { ...EMPTY_FILTER, statuses: new Set(["closed", "in_progress"]) };
    expect(filterBeads(all, byStatus).map((row) => row.id).sort()).toEqual(["demo-a", "demo-c"]);
    expect(filterBeads(all, { ...byStatus, types: new Set(["bug"]) })).toEqual([]);
    expect(filterBeads(all, { ...EMPTY_FILTER, labels: new Set(["wp:wp-2"]) }).map((row) => row.id)).toEqual(["demo-b"]);
    expect(filterBeads(all, { ...EMPTY_FILTER, text: "blocked ONE" }).map((row) => row.id)).toEqual(["demo-b"]);
    expect(statusBucket(all.find((row) => row.id === "demo-b")!)).toBe("blocked");
    expect([...toggle(new Set(["a"]), "a")]).toEqual([]);
  });
});

describe("action wording", () => {
  it("offers no Close on a closed bead and marks Delete as dangerous", () => {
    expect(actionsFor({ status: "closed" })).toEqual(["delete"]);
    expect(actionsFor({ status: "open" })).toEqual(["implement", "close", "delete"]);
    expect(actionSpec("delete", { id: "x", status: "open" }).danger).toBe(true);
    expect(actionSpec("implement", { id: "x", status: "open" }).body).toContain("uses model quota");
  });
});

describe("an in-progress bead says who is on it", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const mark = (overrides: Record<string, unknown> = {}) => ({
    agentId: "d91ccf32-aaaa", at: "2026-09-16T09:25:40.000Z", title: "Contact dialog", status: "running", ...overrides,
  });

  it("names the Worker, the start and how long it has run", () => {
    const summary = workSummary({ status: "in_progress", work: { started: mark(), last: mark({ at: "2026-09-16T10:14:11.000Z" }) } }, now)!;
    expect(summary.headline).toMatch(/^Contact dialog · since \d\d\/09 \d\d:\d\d \(2h 34m\) · running$/);
    expect(summary.agentId).toBe("d91ccf32-aaaa");
    expect(summary.tone).toBe("info");
    expect(summary.lines.join("\n")).toContain("Last activity");
  });

  it("does not invent a start time", () => {
    const summary = workSummary({ status: "in_progress", work: { started: null, last: mark({ title: null, status: "idle" }) } }, now)!;
    expect(summary.headline).toBe("Worker d91ccf32 · start not recorded · idle");
    expect(summary.lines[0]).toContain("not recorded");
  });

  it("follows a different Worker that picked the bead up later", () => {
    const summary = workSummary(
      { status: "in_progress", work: { started: mark(), last: mark({ agentId: "w2", title: "Second worker", at: "2026-09-16T11:00:00.000Z", status: null }) } },
      now,
    )!;
    expect(summary.agentId).toBe("w2");
    expect(summary.headline).toMatch(/^Second worker · last active \d\d\/09 \d\d:00 · no longer in Paseo$/);
    expect(summary.tone).toBe("warning");
  });

  it("says when nobody was recorded, and says nothing for other statuses", () => {
    expect(workSummary({ status: "in_progress", work: null }, now)?.headline).toBe("In progress · no Worker recorded on it");
    expect(workSummary({ status: "open", work: null }, now)).toBeNull();
  });
});
