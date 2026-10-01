import { describe, expect, it, vi } from "vitest";
import { ago, barShare, confidenceSuffix, formatBytes, formatCost, formatDuration, formatTokens, localTimeText, shortSpan } from "../plugin/client/format";
import { HOST_SCOPE_NOTICE, PRIVACY_NOTICE, createConfirmationGate, describeAction, storageView } from "../plugin/client/history-model";
import { dashboardStyles } from "../plugin/client/styles";
import { ROLE_MARK, toneColor } from "../plugin/client/tone";
import type { Usage } from "../plugin/shared/contracts";
import { plural, shorten } from "../plugin/shared/text";
import { timeOrNull, timeOrZero } from "../plugin/shared/time";

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

describe("formatting", () => {
  it("never reads an unknown duration as zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
  });

  // The one duration style of every screen (code review 2026-09-30 §3.6).
  it.each([
    [500, "500 ms"],
    [1_500, "2 s"],
    [65_000, "1 min 5 s"],
    [120_000, "2 min"],
    [3_600_000, "1 h"],
    [7_830_000, "2 h 10 min"],
    [86_400_000, "1 d"],
    [129_600_000, "1 d 12 h"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("says a span to the minute in the same style, and how long ago", () => {
    expect(shortSpan(30_000)).toBe("under 1 min");
    expect(shortSpan(12 * 60_000 + 40_000)).toBe("12 min");
    expect(shortSpan(180 * 60_000)).toBe("3 h");
    expect(shortSpan(185 * 60_000)).toBe("3 h 5 min");
    expect(shortSpan(3 * 86_400_000)).toBe("3 d");
    expect(shortSpan(-5_000)).toBe("under 1 min");
    const now = new Date("2026-09-30T12:00:00.000Z");
    expect(ago("2026-09-30T11:59:30.000Z", now)).toBe("just now");
    expect(ago("2026-09-30T11:55:00.000Z", now)).toBe("5 min ago");
    expect(ago("2026-09-28T10:00:00.000Z", now)).toBe("2 d 2 h ago");
    expect(ago(null, now)).toBe("—");
    expect(ago("not a time", now)).toBe("—");
  });

  // The one date style of every screen, in the device's time zone (code review 2026-09-30 §3.6).
  it("writes a moment as the time today, yesterday or tomorrow, else with its day", () => {
    const now = new Date(2026, 8, 30, 18, 0);
    expect(localTimeText(new Date(2026, 8, 30, 15, 40), now)).toBe("15:40");
    expect(localTimeText(new Date(2026, 8, 29, 9, 5), now)).toBe("yesterday 09:05");
    expect(localTimeText(new Date(2026, 9, 1, 7, 0), now)).toBe("tomorrow 07:00");
    expect(localTimeText(new Date(2026, 8, 24, 15, 40), now)).toBe("Thu 24 Sep 15:40");
    expect(localTimeText(new Date(2025, 8, 24, 15, 40), now)).toBe("Wed 24 Sep 2025 15:40");
    expect(localTimeText(new Date("not a time"), now)).toBe("");
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

describe("the shared text and time helpers (code review 2026-09-30 §3.6)", () => {
  it("counts with a plural, regular or given", () => {
    expect(plural(1, "bead")).toBe("1 bead");
    expect(plural(3, "bead")).toBe("3 beads");
    expect(plural(0, "item needs", "items need")).toBe("0 items need");
  });

  it("shortens to one line of at most the given length, with an ellipsis", () => {
    expect(shorten("  a\n b  ", 10)).toBe("a b");
    expect(shorten("abcdefghij", 10)).toBe("abcdefghij");
    expect(shorten("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(shorten("abcd efghijk", 6)).toBe("abcd…");
  });

  it("reads an ISO time as milliseconds, or null / 0 when it is absent or does not read", () => {
    const at = "2026-09-30T12:00:00.000Z";
    expect(timeOrNull(at)).toBe(Date.parse(at));
    expect(timeOrZero(at)).toBe(Date.parse(at));
    for (const missing of [null, undefined, "", "not a time"]) {
      expect(timeOrNull(missing)).toBeNull();
      expect(timeOrZero(missing)).toBe(0);
    }
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
