import { describe, expect, it, vi } from "vitest";
import {
  HOST_SCOPE_NOTICE,
  PRIVACY_NOTICE,
  ROLE_MARK,
  barShare,
  confidenceSuffix,
  createConfirmationGate,
  dashboardStyles,
  describeAction,
  formatBytes,
  formatCost,
  formatDuration,
  formatTokens,
  requestsPerDay,
  storageView,
  toneColor,
} from "../plugin/client/dashboard-model";
import type { TraceSummary, Usage } from "../plugin/shared/contracts";

/**
 * WP-211.1: the Dashboard's logic and wording, with no renderer.
 *
 * Most of these tests are about honesty of wording rather than layout: a
 * duration that is unknown must not read as zero, a bead claim must not read as
 * "none" unless it was reported as none, and a delete confirmation must say
 * what is lost.
 */

const theme = {
  colors: {
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#00f",
    accentForeground: "#fff",
    statusSuccess: "#0f0",
    statusWarning: "#ff0",
    statusDanger: "#f00",
  },
} as const;

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 12_345,
  cachedInputTokens: 2_000_000,
  outputTokens: 900,
  costUsd: 1.5,
  costBasis: "estimated",
  model: "claude-opus-5",
  pricesUpdatedAt: "2026-06-24",
  ...overrides,
});

const counts = (created: number, confidence: TraceSummary["beadCounts"]["created"]["confidence"]) => ({
  created: { count: created, confidence },
  updated: { count: 0, confidence },
  closed: { count: 0, confidence },
  ready: { count: 0, confidence },
});

const trace = (overrides: Partial<TraceSummary> = {}): TraceSummary => ({
  traceId: "req:req-A",
  requestId: "req-A",
  turn: null,
  requestedAt: "2026-09-16T10:00:00.000Z",
  excerpt: "thêm màn hình báo cáo",
  state: "completed",
  workerIds: ["w1"],
  reviewerIds: ["rev-1"],
  reviewCalls: 2,
  guardrailReported: null,
  durationMs: 600_000,
  usage: usage(),
  messageCount: 8,
  userMessageCount: 0,
  workerUsage: [{ agentId: "w1", title: null, usage: usage() }],
  beadCounts: counts(2, "exact"),
  tier: "Medium",
  linking: "exact",
  agentsMissing: [],
  workspaceState: "live",
  reassignedFrom: null,
  notices: [],
  ...overrides,
});

describe("formatting", () => {
  it("never reads an unknown duration as zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
  });

  it.each([
    [500, "500 ms"],
    [1_500, "2s"],
    [65_000, "1m 5s"],
    [120_000, "2m"],
    [3_600_000, "1h"],
    [7_830_000, "2h 10m"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([
    [512, "512 B"],
    [2048, "2.0 KB"],
    [1024 * 1024 * 15, "15 MB"],
    [1024 * 1024 * 1024 * 3, "3.0 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([
    [900, "900"],
    [1200, "1.2k"],
    [45_000, "45k"],
    [9_500, "9.5k"],
    [2_000_000, "2.0M"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });

});

describe("cost wording (REQ-052)", () => {
  it("labels a provider figure as reported", () => {
    expect(formatCost(usage({ costBasis: "provider", costUsd: 2 }))).toBe("$2.00 (reported by the tool)");
  });

  it("labels an estimate with the price date", () => {
    expect(formatCost(usage())).toBe("$1.50 (estimated, prices of 2026-06-24)");
  });

  it("shows no money for an unknown model", () => {
    expect(formatCost(usage({ costBasis: "unavailable", costUsd: null }))).toBe("cost unavailable");
  });

  it("keeps small amounts readable", () => {
    expect(formatCost(usage({ costUsd: 0.0042 }))).toContain("$0.0042");
  });
});

describe("confidence", () => {
  it("spells out confidence as a suffix", () => {
    expect(confidenceSuffix("exact")).toBe("");
    expect(confidenceSuffix("inferred")).toBe(" (inferred)");
    expect(confidenceSuffix("unknown")).toBe(" (unknown)");
  });
});

describe("bead statistics and storage", () => {
  it("warns only above the threshold, and says the threshold is machine-wide", () => {
    const store = { traces: 5, bytes: 300 * 1024 * 1024, workspaceBytes: 1024 };
    const warned = storageView(store, 200 * 1024 * 1024);
    expect(warned.warning?.tone).toBe("warning");
    expect(warned.warning?.text).toContain(HOST_SCOPE_NOTICE);
    expect(storageView(store, 400 * 1024 * 1024).warning).toBeNull();
    // No trace count here: the storage line reports bytes, because the store's
    // unit count and the number of rows in the list are not the same number
    // (WP-214 acceptance, defect 6).
    expect(warned.summary).not.toMatch(/\d+ traces?\b/);
    expect(warned.summary).toContain("of traces here");
  });
});

describe("destructive actions", () => {
  it("names what is lost for each delete scope and says it cannot be undone", () => {
    const one = describeAction({
      kind: "delete",
      scope: { traceId: "req:req-A" },
      preview: { traces: 1, bytes: 2048 },
      running: 0,
    });
    expect(one.title).toBe("Delete these traces?");
    expect(one.body[0]).toContain("1 trace(s) (2.0 KB)");
    expect(one.body[0]).toContain("this one request");
    expect(one.body.join(" ")).toContain("cannot be undone");
    expect(one.body.join(" ")).toContain("Beads, documents, agents");

    expect(
      describeAction({
        kind: "delete",
        scope: { before: "2026-09-01T00:00:00.000Z" },
        preview: { traces: 9, bytes: 1024 },
        running: 0,
      }).body[0],
    ).toContain("before 2026-09-01");

    expect(
      describeAction({
        kind: "delete",
        scope: { allOfWorkspace: true },
        preview: { traces: 30, bytes: 1024 },
        running: 0,
      }).body[0],
    ).toContain("every trace of this workspace");
  });

  it("warns when a trace in scope is still running (REQ-054e)", () => {
    const described = describeAction({
      kind: "delete",
      scope: { allOfWorkspace: true },
      preview: { traces: 3, bytes: 1024 },
      running: 1,
    });
    expect(described.body.join(" ")).toContain("still have a running turn");
  });

  it("describes a reassignment without claiming anything else moves", () => {
    const described = describeAction({
      kind: "reassign",
      fromWorkspaceId: "wks_old",
      toWorkspaceId: "wks_new",
      preview: { traces: 4, bytes: 4096 },
    });
    expect(described.confirmLabel).toBe("Reassign");
    expect(described.body.join(" ")).toContain("keep the workspace they were recorded under");
    expect(described.body.join(" ")).toContain("Nothing else on this machine is touched");
  });
});

describe("the confirmation gate defaults to No", () => {
  it("cannot run anything until an action was requested with a preview", async () => {
    const gate = createConfirmationGate();
    const run = vi.fn(async () => "ran");
    expect(gate.getPending()).toBeNull();
    expect(await gate.confirm(run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once confirmed, then forgets the action", async () => {
    const gate = createConfirmationGate();
    const seen: string[] = [];
    const unsubscribe = gate.subscribe(() => seen.push(gate.getPending()?.kind ?? "none"));
    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    expect(gate.getPending()?.kind).toBe("delete");

    const run = vi.fn(async () => "deleted");
    expect(await gate.confirm(run)).toBe("deleted");
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.getPending()).toBeNull();
    expect(seen).toEqual(["delete", "none"]);
    unsubscribe();
  });

  it("clears the action on cancel and after a failure", async () => {
    const gate = createConfirmationGate();
    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    gate.cancel();
    expect(gate.getPending()).toBeNull();

    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    await expect(
      gate.confirm(async () => {
        throw new Error("rpc failed");
      }),
    ).rejects.toThrow("rpc failed");
    expect(gate.getPending()).toBeNull();
  });
});

describe("figures", () => {
  it("counts requests per day, oldest first", () => {
    const bars = requestsPerDay(
      [trace({ requestedAt: "2026-09-16T10:00:00.000Z" }), trace({ requestedAt: "2026-09-15T09:00:00.000Z" })],
      new Date("2026-09-16T12:00:00.000Z"),
      3,
    );
    expect(bars.map((bar) => [bar.label, bar.value])).toEqual([
      ["09-14", 0],
      ["09-15", 1],
      ["09-16", 1],
    ]);
  });

  it("scales a bar to the largest of its chart", () => {
    const bars = [
      { label: "a", value: 1000, display: "1.0k" },
      { label: "b", value: 104, display: "104" },
    ];
    expect(barShare(bars[0]!, bars)).toBe(1);
    expect(barShare(bars[1]!, bars)).toBeCloseTo(0.104);
    expect(barShare(bars[0]!, [{ label: "z", value: 0, display: "0" }])).toBe(0);
  });
});

describe("styles and the privacy notice", () => {
  it("takes every colour from the theme", () => {
    const palette = new Set<string>(Object.values(theme.colors));
    const styles = dashboardStyles(theme as never, false);
    const colours = JSON.stringify(styles).match(/"#[0-9a-f]{3,8}"/gi) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(palette.has(colour.slice(1, -1))).toBe(true);
  });

  it("marks each role with an icon of its own", () => {
    expect(Object.keys(ROLE_MARK)).toEqual(["request", "worker", "reviewer", "orchestrator"]);
    expect(new Set(Object.values(ROLE_MARK).map((mark) => mark.icon)).size).toBe(4);
    expect(ROLE_MARK.request.role).toBe("Manager");
  });

  it("maps every tone to a theme colour", () => {
    for (const tone of ["muted", "info", "warning", "danger", "success"] as const) {
      expect(Object.values(theme.colors)).toContain(toneColor(theme as never, tone));
    }
  });

  it("tells the user the history holds conversation they can delete", () => {
    expect(PRIVACY_NOTICE).toContain("conversation");
    expect(PRIVACY_NOTICE).toContain("delete");
  });
});


/**
 * One row per question (delta 20260917e §4.3), and the chart that must NOT
 * follow it (owner decision Q27).
 */
describe("turns of a request", () => {
  const turned = (index: number, total: number, at: string) =>
    trace({ turn: { index, total }, requestedAt: at, traceId: "req:req-A", requestId: "req-A" });

  it("counts a request once however many times the user asked", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay(
      [turned(1, 3, `${day}T09:00:00.000Z`), turned(2, 3, `${day}T09:10:00.000Z`), turned(3, 3, `${day}T09:20:00.000Z`)],
      new Date(`${day}T23:00:00.000Z`),
    );
    // Three rows, one request.
    expect(bars.at(-1)).toEqual({ label: "09-17", value: 1, display: "1" });
  });

  it("still counts a request that was never followed up", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay([trace({ requestedAt: `${day}T09:00:00.000Z` })], new Date(`${day}T23:00:00.000Z`));
    expect(bars.at(-1)?.value).toBe(1);
  });

  it("counts two separate requests on the same day as two", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay(
      [
        trace({ traceId: "req:req-A", requestId: "req-A", requestedAt: `${day}T09:00:00.000Z` }),
        trace({ traceId: "req:req-B", requestId: "req-B", requestedAt: `${day}T11:00:00.000Z` }),
      ],
      new Date(`${day}T23:00:00.000Z`),
    );
    expect(bars.at(-1)?.value).toBe(2);
  });
});
