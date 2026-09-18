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
  beadTitleTone,
  closedBeadsVisibility,
  doneText,
  groupBeads,
  beadsOverview,
  facetsOf,
  filterBeads,
  formatDays,
  statusBadge,
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
    // A daemon answers a bm.role=worker query with agents that carry that label.
    paseo.agents.list = vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
      entries:
        filter.labels === undefined || filter.labels["bm.role"] === "worker"
          ? [{ id: "w1", workspaceId: WS, status: "idle", title: "Worker for C", labels: { "bm.role": "worker" } }]
          : [],
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
    const byRole: Record<string, Array<Record<string, unknown>>> = {
      worker: [
        { id: "w1", workspaceId: WS, status: "running", labels: {} },
        { id: "w2", workspaceId: WS, status: "idle", labels: {} },
        { id: "w3", workspaceId: "wks_nobeads", status: "running", labels: {} },
      ],
      reviewer: [{ id: "r1", workspaceId: WS, status: "running", labels: {} }],
      manager: [
        { id: "m1", workspaceId: WS, status: "idle", labels: {} },
        { id: "m2", workspaceId: "wks_nobeads", status: "running", labels: {} },
      ],
    };
    // Each agent carries the bm.role label of its group, as the daemon's would.
    const labelled = Object.entries(byRole).flatMap(([role, agents]) =>
      agents.map((agent) => ({ ...agent, labels: { ...(agent["labels"] as Record<string, string>), "bm.role": role } })),
    );
    paseo.agents.list = vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
      entries: labelled.filter((agent) => filter.labels === undefined || agent.labels["bm.role"] === filter.labels["bm.role"]),
    })) as never;
    const { workspaces } = await handleWorkspacesOverview(paseo);
    expect(workspaces).toEqual([
      {
        workspaceId: WS,
        beads: { total: 4, inProgress: 1, blocked: 2, ready: 0 },
        runningWorkers: 1,
        runningAgents: { manager: 0, worker: 1, reviewer: 1 },
      },
      {
        workspaceId: "wks_nobeads",
        beads: null,
        runningWorkers: 1,
        runningAgents: { manager: 1, worker: 1, reviewer: 0 },
      },
    ]);
  });

  /**
   * Owner decision Q25 (delta 20260917e): a Reviewer running is a project at
   * work. Counting Workers alone left the screen still exactly while a review
   * was happening — this case goes red if anyone reverts to that.
   */
  it("reports a workspace as busy when only a Reviewer is running", async () => {
    const paseo = fakePaseo();
    paseo.workspaces.list = vi.fn(async () => ({ entries: [{ id: WS, directory: workspace }] }));
    paseo.agents.list = vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
      entries:
        filter.labels === undefined || filter.labels["bm.role"] === "reviewer"
          ? [{ id: "r1", workspaceId: WS, status: "running", labels: { "bm.role": "reviewer" } }]
          : [],
    })) as never;
    const { workspaces } = await handleWorkspacesOverview(paseo);
    const row = workspaces[0]!;
    expect(row.runningAgents).toEqual({ manager: 0, worker: 0, reviewer: 1 });
    const total = row.runningAgents.manager + row.runningAgents.worker + row.runningAgents.reviewer;
    expect(total).toBeGreaterThan(0);
    // `runningWorkers` keeps its old meaning, which is exactly why it cannot
    // carry the new signal on its own.
    expect(row.runningWorkers).toBe(0);
  });
});

describe("the six overview sections", () => {
  const rows = (): BeadRow[] => listBeadRows(workspace);
  const stats: BeadStats = {
    total: 4, open: 2, inProgress: 1, blocked: 2, closed: 1, ready: 0,
    readAt: "", source: "", skippedLines: 0, present: true,
  };

  it("summarises status, progress, type, priority and time", () => {
    const view = beadsOverview(rows(), stats, new Date("2026-09-16T12:00:00.000Z"));
    expect(view.status.map((card) => [card.label, card.value])).toEqual([
      ["Total", "4"], ["Ready", "0"], ["In progress", "1"], ["Blocked", "2"], ["Closed", "1"],
    ]);
    // The epic is not work: 1 of 3.
    expect(view.progress).toMatchObject({ closed: 1, total: 3 });
    expect(view.progress.label).toContain("33% done");
    expect(view.byType.map((bar) => [bar.label, bar.value])).toEqual([["task", 2], ["epic", 1], ["bug", 1]]);
    expect(view.byPriority.map((bar) => bar.label)).toEqual(["P1", "P2"]);
    const timing = Object.fromEntries(view.timing.map((card) => [card.label, card.value]));
    expect(timing["Median time to close"]).toBe("2.0d");
    expect(timing["Longest in progress"]).toBe("1.1d");
    // Last updated six days ago: not stale yet.
    expect(timing["Stale"]).toBe("0");
    const later = beadsOverview(rows(), stats, new Date("2026-09-18T12:00:00.000Z"));
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

describe("a bead title and its chip say the status in one colour (delta 20260918e, Q8)", () => {
  // One bead per bucket, including an open bead that is not ready: it is
  // "blocked" although its status is "open".
  const samples = [
    { name: "ready", bead: { status: "open", ready: true } },
    { name: "in_progress", bead: { status: "in_progress", ready: false } },
    { name: "blocked (status)", bead: { status: "blocked", ready: false } },
    { name: "blocked (open, not ready)", bead: { status: "open", ready: false } },
    { name: "closed", bead: { status: "closed", ready: false } },
  ] as const;

  it("gives the four statuses four different title colours", () => {
    const tones = Object.fromEntries(samples.map(({ name, bead }) => [name, beadTitleTone(bead)]));
    expect(tones).toEqual({
      ready: "info",
      in_progress: "warning",
      "blocked (status)": "danger",
      "blocked (open, not ready)": "danger",
      closed: "success",
    });
    expect(new Set(Object.values(tones)).size).toBe(4);
  });

  it.each(samples)("colours the chip of a $name bead like its title, with the same words as before", ({ bead }) => {
    expect(statusBadge(bead).tone).toBe(beadTitleTone(bead));
    const words = { ready: "Ready", in_progress: "In progress", blocked: "Blocked", closed: "Closed" } as const;
    expect(statusBadge(bead).text).toBe(words[statusBucket(bead)]);
  });
});

describe("the Beads list in four groups, closed beads behind the eye (delta 20260918e, Q9, Q10)", () => {
  // Only status and readiness decide a group; the rest of a row is not read.
  const row = (id: string, status: string, ready = false) => ({ id, status, ready }) as unknown as BeadRow;
  const sorted = [
    row("r1", "open", true),
    row("c1", "closed"),
    row("p1", "in_progress"),
    row("b1", "open", false),
    row("r2", "open", true),
    row("p2", "in_progress"),
    row("b2", "blocked"),
    row("c2", "closed"),
  ];

  it("puts work in progress first, then blocked, ready and closed, keeping the sort inside each group", () => {
    const { groups, visible, closed, truncated } = groupBeads(sorted, { showClosed: true, limit: 200 });
    expect(groups.map((group) => [group.bucket, group.label, group.tone, group.total, group.beads.map((bead) => bead.id)])).toEqual([
      ["in_progress", "In progress", "warning", 2, ["p1", "p2"]],
      ["blocked", "Blocked", "danger", 2, ["b1", "b2"]],
      ["ready", "Ready", "info", 2, ["r1", "r2"]],
      ["closed", "Closed", "success", 2, ["c1", "c2"]],
    ]);
    expect({ visible, closed, truncated }).toEqual({ visible: 8, closed: 2, truncated: 0 });
  });

  it("drops empty groups, and the Closed group while closed beads are hidden, still counting them", () => {
    const hidden = groupBeads(sorted.filter((bead) => bead.id !== "b1" && bead.id !== "b2"), { showClosed: false, limit: 200 });
    expect(hidden.groups.map((group) => group.bucket)).toEqual(["in_progress", "ready"]);
    expect({ visible: hidden.visible, closed: hidden.closed }).toEqual({ visible: 4, closed: 2 });
    expect(groupBeads([row("c1", "closed")], { showClosed: false, limit: 200 })).toEqual({ groups: [], visible: 0, closed: 1, truncated: 0 });
  });

  it("spends the list limit in group order and says how many it cut", () => {
    const three = groupBeads([row("p1", "in_progress"), row("p2", "in_progress"), row("b1", "blocked"), row("b2", "blocked"), row("r1", "open", true)], {
      showClosed: true,
      limit: 3,
    });
    expect(three.groups.map((group) => [group.bucket, group.total, group.beads.length])).toEqual([
      ["in_progress", 2, 2],
      ["blocked", 2, 1],
    ]);
    expect(three.truncated).toBe(2);
  });

  it("hides closed beads by default and remembers the choice for the session", () => {
    expect(closedBeadsVisibility.get()).toBe(false);
    const heard = vi.fn();
    const stop = closedBeadsVisibility.subscribe(heard);
    closedBeadsVisibility.set(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(closedBeadsVisibility.get()).toBe(true);
    stop();
    closedBeadsVisibility.set(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("done / total at the top of the Beads screen (delta 20260918e, Q11)", () => {
  const row = (id: string, issueType: string, status: string) =>
    ({ id, issueType, status, ready: false, priority: 2, createdAt: null, updatedAt: null, closedAt: null, work: null, labels: [] }) as unknown as BeadRow;
  const stats: BeadStats = {
    total: 5, open: 2, inProgress: 0, blocked: 0, closed: 3, ready: 2,
    readAt: "", source: "", skippedLines: 0, present: true,
  };

  it("counts closed beads over all beads, leaving epics out like the Progress card", () => {
    const beads = [row("t1", "task", "closed"), row("t2", "bug", "closed"), row("t3", "task", "open"), row("e1", "epic", "closed"), row("e2", "epic", "open")];
    const done = doneText(beadsOverview(beads, stats, new Date("2026-09-18T12:00:00.000Z")).progress);
    expect(done).toEqual({ text: "✓ 2 / 3 done", label: "2 of 3 beads done, epics not counted" });
  });

  it("writes the figure the same way for any counts", () => {
    expect(doneText({ closed: 12, total: 40 })).toEqual({ text: "✓ 12 / 40 done", label: "12 of 40 beads done, epics not counted" });
  });
});
