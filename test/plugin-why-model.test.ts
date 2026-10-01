import { describe, expect, it, vi } from "vitest";
import type { LinksWhyOutput, WhyChain } from "../plugin/shared/contracts";
import { localTimeText } from "../plugin/client/format";
import { checkLabelText, claimCountsText, FINISHED_UNVERIFIED_CHIP } from "../plugin/client/verification-view";
import { WHY_QUERY_OPTIONS, WHY_SECTIONS, whyQueryKey, whyState, whyView, type WhyView } from "../plugin/client/why-model";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";

/**
 * Work → request → Why? (autonomy design §E.2; change-011 C7): the pure view
 * model of the chain, and the hook-free view expanded with the element-tree
 * helper at phone (`compact`) and desktop widths. `react-native` is a named
 * stand-in.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const whyPath = "../plugin/client/why.tsx";
const workPath = "../plugin/client/work.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { WhyBody, WhySectionRow } = (await import(whyPath)) as Record<"WhyBody" | "WhySectionRow", Component>;
const { RequestCard, workQueryKeys } = (await import(workPath)) as {
  RequestCard: Component;
  workQueryKeys: {
    projects: readonly string[];
    traces: (workspaceId: string) => readonly string[];
    trace: (workspaceId: string, traceId: string) => readonly string[];
    decisions: (workspaceId: string) => readonly string[];
    tokens: (workspaceId: string, traceId?: string) => readonly string[];
  };
};

const styles = new Proxy({}, { get: (_target, key) => (key === "content" ? { padding: 12, gap: 8 } : { name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;

const NOW = new Date("2026-09-26T12:00:00.000Z");
const at = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const REQ = "req-20260926T100020Z";
const W1 = "agent-worker-1";
const W2 = "agent-worker-2";
const MGR = "agent-manager";
const REV = "agent-reviewer";

const link = <T>(items: T[], status: "found" | "absent" | "missing" = "found", reason: string | null = null) => ({ status, reason, items, more: 0 });

/** A Medium request: two questions (one replaced), a standing answer, a split bead, changes and commits, a check, a review, a handover. */
function chain(overrides: Partial<WhyChain> = {}): WhyChain {
  return {
    workspaceId: "wks_invoice",
    request: {
      requestId: REQ,
      traceId: "trace-abc",
      requestedAt: at(0),
      text: "Export invoices to PDF",
      state: "completed",
      tier: "Medium",
      linking: "exact",
      workerIds: [W1, W2],
      reviewerIds: [REV],
      basis: "live",
    },
    decisions: link([
      { id: `q:${REQ}:Q1`, kind: "question", status: "superseded", askedAt: at(3), question: "Which PDF library?", answeredBy: null, answeredAt: null, precedentId: null, supersedes: null, supersededBy: `q:${REQ}:Q2` },
      { id: `q:${REQ}:Q2`, kind: "question", status: "answered", askedAt: at(4), question: "Which PDF library, pdf-lib or pdfkit?", answeredBy: "precedent", answeredAt: at(4), precedentId: "p:old-1", supersedes: `q:${REQ}:Q1`, supersededBy: null },
    ]),
    precedents: link([
      { id: "p:old-1", decisionId: `q:${REQ}:Q2`, found: true, reason: null, subject: "pdf-library", scope: "all", text: "Use pdf-lib", createdAt: at(0), expiresAt: null, supersededBy: "p:new-1" },
    ]),
    beads: link([
      { id: "bm-p0", actions: ["updated"], confidence: "inferred", via: ["br"], inStore: true, recordReason: null, title: "Export an invoice", status: "closed", splitFrom: [] },
      { id: "bm-p1", actions: ["created", "closed"], confidence: "exact", via: ["report"], inStore: true, recordReason: null, title: "Export an invoice to PDF", status: "closed", splitFrom: ["bm-p0"] },
      { id: "bm-p9", actions: ["created"], confidence: "exact", via: ["report"], inStore: false, recordReason: "bm-p9 is not in the workspace's bead store.", title: null, status: null, splitFrom: ["bm-gone"] },
    ]),
    changes: link([
      { path: "src/invoice/export-pdf.ts", label: "detected", via: ["report", "file-evidence", "commit-bead"], commits: ["a1b2c3d4e5f6a7b8"], onlyCommitByTime: false },
      { path: "src/invoice/totals.ts", label: "detected", via: ["file-evidence"], commits: [], onlyCommitByTime: false },
      { path: "README.md", label: "self-reported", via: ["report"], commits: [], onlyCommitByTime: false },
      { path: "src/invoice/extra.ts", label: null, via: ["commit-path-time"], commits: ["f0e1d2c3b4a59687"], onlyCommitByTime: true },
    ]),
    commits: {
      ...link([
        { hash: "a1b2c3d4e5f6a7b8", at: at(5), subject: "Close bm-p1: export invoices to PDF", files: ["src/invoice/export-pdf.ts"], filesMore: 0, link: "bead" as const, beads: ["bm-p1"] },
        { hash: "f0e1d2c3b4a59687", at: at(8), subject: "Tidy formatting", files: ["src/invoice/extra.ts"], filesMore: 0, link: "path-and-time" as const, beads: [] },
      ]),
      unlinked: 1,
      truncated: false,
    },
    checks: { status: "found", reason: null, verdict: "self-reported", named: [{ check: "npm test", label: "detected" }, { check: "npm run lint", label: "self-reported" }], unverified: false, reportAt: at(9) },
    reviews: link([{ batchId: "b1", verdict: "pass", reviews: [{ agentId: REV, at: at(7), verdict: "changes-required", blockingCount: 1 }, { agentId: REV, at: at(8), verdict: "pass", blockingCount: null }] }]),
    turns: link([
      { agentId: MGR, role: "manager", count: 3, first: at(0), last: at(9) },
      { agentId: W1, role: "worker", count: 2, first: at(1), last: at(4) },
      { agentId: W2, role: "worker", count: 1, first: at(6), last: at(6) },
      { agentId: REV, role: "reviewer", count: 1, first: at(8), last: at(8) },
    ]),
    handoffs: link([{ kind: "handoff", from: W1, to: W2 }]),
    edges: [
      { kind: "superseded-by", from: `q:${REQ}:Q1`, to: `q:${REQ}:Q2` },
      { kind: "superseded-by", from: "p:old-1", to: "p:new-1" },
      { kind: "split-into", from: "bm-p0", to: "bm-p1" },
      { kind: "split-into", from: "bm-gone", to: "bm-p9" },
      { kind: "handoff", from: W1, to: W2 },
    ],
    edgesMore: 0,
    notices: [],
    ...overrides,
  };
}

const sectionOf = (view: WhyView, key: string) => view.sections.find((section) => section.key === key)!;
const linesOf = (view: WhyView, key: string) => sectionOf(view, key).lines.map((line) => line.text);

/** Every id, path and hash of `chain()`: none may show outside Details. */
const IDS = [REQ, "trace-abc", `q:${REQ}:Q1`, "p:old-1", "bm-p0", "bm-p1", "bm-p9", "src/invoice", "README.md", "a1b2c3d4e5f6", "f0e1d2c3b4a5", "b1", W1, W2, MGR, REV];

const body = (view: WhyView | null, extra: Record<string, unknown> = {}) =>
  renderTree(
    WhyBody({
      state: view === null ? { kind: "loading" } : { kind: "ready", view, error: null },
      refreshing: false,
      detailsOpen: false,
      onBack: noop,
      onRefresh: noop,
      onToggleDetails: noop,
      compact: false,
      styles,
      theme,
      ...extra,
    }),
  );

describe("Why? view model", () => {
  it("draws the chain in order: decisions, beads, changes, checks, reviews, turns", () => {
    const view = whyView(chain(), NOW);
    expect(view.sections.map((section) => section.key)).toEqual(["decisions", "beads", "changes", "checks", "reviews", "turns"]);
    expect(WHY_SECTIONS.map((section) => section.key)).toEqual(view.sections.map((section) => section.key));
    expect(view.title).toBe("Export invoices to PDF");
    expect(view.meta).toBe("Finished · Medium · asked 2 h ago");
    // Rendered in the same order.
    const shown = texts(body(view)).filter((text) => WHY_SECTIONS.some((section) => section.title === text));
    expect(shown).toEqual(["Decisions", "Beads", "Changes", "Checks", "Reviews", "Turns"]);
  });

  it("labels checks and claims as verification-view.ts labels them", () => {
    const view = whyView(chain(), NOW);
    const verdict = { checks: "self-reported" as const };
    expect(linesOf(view, "checks")).toEqual([
      "Checks: self-reported",
      `npm test — ${checkLabelText(verdict, { label: "detected" })}`,
      `npm run lint — ${checkLabelText(verdict, { label: "self-reported" })}`,
    ]);
    expect(linesOf(view, "checks")[1]).toBe("npm test — detected ✓");
    // The files it claims: three labelled, as a finish's claims read.
    expect(linesOf(view, "changes")[0]).toBe(`3 files changed — ${claimCountsText([{ label: "detected" }, { label: "detected" }, { label: "self-reported" }])}`);
    expect(linesOf(view, "changes")[0]).toBe("3 files changed — 2 detected, 1 self-reported");
    // Finished-unverified reads as the card's chip; an unverified check says so.
    const unverified = whyView(chain({ checks: { status: "found", reason: null, verdict: "unverified", named: [{ check: "npm test", label: "self-reported" }], unverified: true, reportAt: at(9) } }), NOW);
    expect(linesOf(unverified, "checks")).toEqual([`${FINISHED_UNVERIFIED_CHIP}: not every check was seen to pass after the last edit`, "npm test — unverified"]);
    expect(sectionOf(unverified, "checks").lines[0]!.tone).toBe("warning");
  });

  it("gives the turns per agent — role, count, first → last — and the handover by role", () => {
    const view = whyView(chain(), NOW);
    const time = (minute: number) => localTimeText(new Date(at(minute)), NOW);
    expect(linesOf(view, "turns")).toEqual([
      `Manager — 3 turns · ${time(0)} → ${time(9)}`,
      `Worker 1 — 2 turns · ${time(1)} → ${time(4)}`,
      `Worker 2 — 1 turn · ${time(6)}`,
      `Reviewer — 1 turn · ${time(8)}`,
      "Worker 1 handed over to Worker 2",
    ]);
  });

  it("shows a missing link with its reason, and an absent one as none with why", () => {
    const view = whyView(
      chain({
        reviews: link([], "missing", "A Medium request with no recorded BM-REVIEW."),
        decisions: link([], "absent", "No decision carries the request's id: no question was asked."),
        precedents: link([], "absent", "No decision of the request was answered by a precedent."),
      }),
      NOW,
    );
    expect(sectionOf(view, "reviews")).toMatchObject({ status: "missing", statusText: "missing", statusTone: "warning", reason: "A Medium request with no recorded BM-REVIEW.", lines: [] });
    expect(sectionOf(view, "decisions")).toMatchObject({ status: "absent", statusText: "none", statusTone: "muted", reason: "No decision carries the request's id: no question was asked." });
    const tree = renderTree(WhySectionRow({ section: sectionOf(view, "reviews"), compact: true, styles, theme }));
    expect(texts(tree)).toEqual(["Reviews", "missing", "A Medium request with no recorded BM-REVIEW."]);
    const reason = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "A Medium request with no recorded BM-REVIEW.")!;
    expect(JSON.stringify(reason.props.style)).toContain("#statusWarning");
    expect((allNodes(tree)[0] as RNode).props.accessibilityLabel).toBe("Reviews: missing. A Medium request with no recorded BM-REVIEW.");
    // Commits: not read, with why; never a throw, never zero.
    const noGit = whyView(chain({ commits: { ...link([], "missing", "The workspace folder is not in a git repository."), unlinked: 0, truncated: false } }), NOW);
    expect(linesOf(noGit, "changes")).toContain("Commits not read: The workspace folder is not in a git repository.");
  });

  it("shows a superseded decision, a replaced standing answer and a Split-from bead as replaced", () => {
    const view = whyView(chain(), NOW);
    expect(linesOf(view, "decisions")).toEqual([
      "Question: Which PDF library? · replaced · replaced by a later question",
      "Question: Which PDF library, pdf-lib or pdfkit? · answered by a standing answer",
      "↳ Standing answer: Use pdf-lib · replaced by a newer standing answer",
    ]);
    expect(sectionOf(view, "decisions").lines[0]!.tone).toBe("muted");
    expect(linesOf(view, "beads")).toEqual([
      "Export an invoice — updated (inferred) · closed · replaced by “Export an invoice to PDF” (split)",
      "Export an invoice to PDF — created, closed · closed · split from “Export an invoice”",
      "A bead not in the bead store — created · replaces an earlier bead (split)",
    ]);
    expect(sectionOf(view, "beads").lines.map((line) => line.tone)).toEqual(["muted", "plain", "warning"]);
    // An override that supersedes an answer names what replaced it.
    const overridden = whyView(
      chain({
        decisions: link([
          { id: "q:x:Q1", kind: "question", status: "answered", askedAt: at(1), question: "Ship it?", answeredBy: "orchestrator", answeredAt: at(2), precedentId: null, supersedes: null, supersededBy: null },
          { id: "r:o-1", kind: "override", status: "answered", askedAt: at(3), question: "Override: no", answeredBy: "owner", answeredAt: at(3), precedentId: null, supersedes: "q:x:Q1", supersededBy: null },
        ]),
        precedents: link([], "absent", "none"),
        edges: [{ kind: "superseded-by", from: "q:x:Q1", to: "r:o-1" }],
      }),
      NOW,
    );
    expect(linesOf(overridden, "decisions")).toEqual([
      "Question: Ship it? · answered by the Orchestrator · replaced by a later override",
      "Override: Override: no · answered by you",
    ]);
  });

  it("never draws unknown data as zero", () => {
    const view = whyView(
      chain({
        reviews: link([{ batchId: null, verdict: null, reviews: [{ agentId: REV, at: at(7), verdict: null, blockingCount: null }] }]),
        request: { ...chain().request, text: null, tier: null, state: "unknown" },
        decisions: link([{ id: "q:x:Q1", kind: null, status: "open", askedAt: at(1), question: null, answeredBy: null, answeredAt: null, precedentId: null, supersedes: null, supersededBy: null }]),
        precedents: link([], "absent", "none"),
        edges: [],
      }),
      NOW,
    );
    expect(linesOf(view, "reviews")).toEqual(["Review: verdict not recorded · 1 review · blocking findings unknown"]);
    expect(linesOf(view, "decisions")).toEqual(["Decision: question not recorded · open"]);
    expect(view.meta).toBe("asked 2 h ago");
    expect(view.title).toMatch(/^Request text not recorded/);
    const all = view.sections.flatMap((section) => section.lines.map((line) => line.text)).join("\n");
    expect(all).not.toMatch(/\b0 blocking|\b0 turns|\b0 files/);
    // The reviewed batch with a known count says it.
    expect(linesOf(whyView(chain(), NOW), "reviews")).toEqual(["Review: pass · 2 reviews · blocking findings unknown"]);
  });

  it("puts ids, paths and hashes only under Details", () => {
    const view = whyView(chain(), NOW);
    const closed = texts(body(view)).join("\n");
    for (const id of IDS) expect(closed, id).not.toContain(id);
    const tree = body(view, { detailsOpen: true });
    const mono = allNodes(tree).filter((node) => node.type === "Text" && (node.props.style as { name?: string }).name === "mono").map(textOf);
    expect(mono).toEqual(view.details);
    for (const id of IDS) expect(mono.join("\n"), id).toContain(id);
    expect(view.details.slice(0, 3)).toEqual([`Request: ${REQ}`, "Trace: trace-abc", `Decision: q:${REQ}:Q1 — superseded → q:${REQ}:Q2`]);
    expect(view.details).toContain("Worker 1: agent-worker-1");
    expect(view.details).toContain("File: src/invoice/extra.ts — commit only · f0e1d2c3b4a5");
  });

  it("counts what the server left out, and shows notices and a store-only rebuild", () => {
    const view = whyView(chain({ beads: { ...chain().beads, more: 7 }, notices: ["1 agent(s) of the request are no longer listed; their recorded turns are shown."], request: { ...chain().request, basis: "store-only" } }), NOW);
    expect(linesOf(view, "beads").at(-1)).toBe("+7 more not shown");
    expect(view.notices).toEqual([
      "Rebuilt from the stored history alone: Paseo's agent list was not read.",
      "1 agent(s) of the request are no longer listed; their recorded turns are shown.",
    ]);
  });
});

describe("Why? states and reads", () => {
  it("draws loading, an error, no chain with its reason, and a chain with a failed refresh", () => {
    expect(whyState(undefined, null, NOW)).toEqual({ kind: "loading" });
    expect(whyState(undefined, "E_TRACE_NOT_FOUND: no request", NOW)).toEqual({ kind: "error", text: "Could not read the chain. E_TRACE_NOT_FOUND: no request" });
    const none: LinksWhyOutput = { chains: [], more: 0, reason: "No request's reports or recorded edits name x." };
    expect(whyState(none, null, NOW)).toEqual({ kind: "empty", text: "No request's reports or recorded edits name x." });
    const ready = whyState({ chains: [chain()], more: 0, reason: null }, "offline", NOW);
    expect(ready).toMatchObject({ kind: "ready", error: "Could not read the chain again. offline" });
    const tree = renderTree(
      WhyBody({ state: ready, refreshing: false, detailsOpen: false, onBack: noop, onRefresh: noop, onToggleDetails: noop, compact: true, styles, theme }),
    );
    expect(texts(tree)).toContain("Could not read the chain again. offline");
    expect(texts(tree)).toContain("Export invoices to PDF");
    expect(texts(body(null))).toEqual(["←", "Why?", "Refresh", "What this request asked, decided, changed and proved, as the stores record it."]);
  });

  it("reads when opened and on Refresh only: no interval, no refetch on focus or reconnect, and a key Work never polls or invalidates", () => {
    expect(WHY_QUERY_OPTIONS).toMatchObject({ refetchInterval: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: "always", staleTime: Number.POSITIVE_INFINITY });
    const key = whyQueryKey("wks_invoice", REQ);
    expect(key).toEqual(["paseo-bm", "work", "why", "wks_invoice", REQ]);
    const polled = [workQueryKeys.projects, workQueryKeys.traces("wks_invoice"), workQueryKeys.trace("wks_invoice", "t"), workQueryKeys.decisions("wks_invoice"), workQueryKeys.tokens("wks_invoice")];
    const invalidated = [["paseo-bm", "work", "trace", "wks_invoice"], ["paseo-bm", "work", "tokens", "wks_invoice"]];
    for (const prefix of [...polled, ...invalidated]) expect(key.slice(0, prefix.length), prefix.join("/")).not.toEqual([...prefix]);
  });

  it("offers ←, Refresh and Details as labelled buttons, and Refresh is the only read", () => {
    const onBack = vi.fn();
    const onRefresh = vi.fn();
    const onToggleDetails = vi.fn();
    const tree = body(whyView(chain(), NOW), { onBack, onRefresh, onToggleDetails });
    const buttons = pressables(tree);
    for (const button of buttons) {
      expect(button.props.accessibilityRole).toBe("button");
      expect(typeof button.props.accessibilityLabel).toBe("string");
    }
    const byLabel = (label: string) => buttons.find((button) => button.props.accessibilityLabel === label)!;
    (byLabel("Back to the requests").props.onPress as () => void)();
    (byLabel("Read the chain behind this request again").props.onPress as () => void)();
    (byLabel("Show the ids behind this chain").props.onPress as () => void)();
    expect([onBack, onRefresh, onToggleDetails].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
    // While a Refresh reads, the button says so and is disabled.
    const busy = pressables(body(whyView(chain(), NOW), { refreshing: true })).find((button) => button.props.accessibilityLabel === "Read the chain behind this request again")!;
    expect(busy.props).toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: true } });
  });
});

describe("Why? at both widths", () => {
  it("stacks a link's name over its lines on a phone and puts them side by side on a wide screen", () => {
    const view = whyView(chain(), NOW);
    for (const compact of [true, false]) {
      const tree = renderTree(WhySectionRow({ section: sectionOf(view, "changes"), compact, styles, theme }));
      const row = tree[0] as RNode;
      const style = (row.props.style as unknown[])[1] as { flexDirection: string };
      expect(style.flexDirection, String(compact)).toBe(compact ? "column" : "row");
      expect(texts(tree), String(compact)).toEqual([
        "Changes",
        "found",
        "3 files changed — 2 detected, 1 self-reported",
        "1 file named only by a commit",
        "1 file linked only by a commit's time",
        "2 commits — 1 name a bead of the request, 1 matched by file and time",
        "1 other commit in its span, linked to nothing of it",
      ]);
    }
    // The whole view draws the same text at both widths.
    expect(texts(body(view, { compact: true }))).toEqual(texts(body(view, { compact: false })));
  });

  it("colours only through the theme", () => {
    const tree = body(whyView(chain(), NOW), { detailsOpen: true });
    const colours = allNodes(tree).flatMap((node) => {
      const style = node.props.style;
      const flat = Array.isArray(style) ? style : [style];
      return flat.flatMap((entry) => (entry !== null && typeof entry === "object" && "color" in entry ? [(entry as { color: string }).color] : []));
    });
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(colour).toMatch(/^#[a-zA-Z0-9]+$/);
    expect(colours.every((colour) => /^#(foreground|foregroundMuted|accent|statusWarning|statusDanger|statusSuccess)$/.test(colour))).toBe(true);
  });
});

describe("Work's request card: Why?", () => {
  const view = {
    key: "trace-abc",
    title: "Export invoices to PDF",
    meta: "Worker · started 2 h ago",
    stage: null,
    evidence: [],
    cost: "Cost 1.0k tokens · cost unavailable",
    workerId: null,
    live: false,
    details: [],
    accessibilityLabel: "Export invoices to PDF",
  };
  const card = (onWhy?: () => void) =>
    renderTree(
      RequestCard({ view, expanded: false, timeline: null, loading: false, error: null, detailsOpen: false, onToggle: noop, onToggleDetails: noop, onWhy, compact: true, styles, theme }),
    );

  it("offers Why? on a request with an id, and opens the view", () => {
    const onWhy = vi.fn();
    const why = pressables(card(onWhy)).find((node) => textOf(node) === "Why? ▸")!;
    expect(why.props.accessibilityRole).toBe("button");
    expect(why.props.accessibilityLabel).toBe("Show why: the decisions, beads, changes, checks and reviews behind this request");
    (why.props.onPress as () => void)();
    expect(onWhy).toHaveBeenCalledTimes(1);
  });

  it("offers no Why? on a request with no id", () => {
    expect(pressables(card()).map(textOf)).not.toContain("Why? ▸");
  });
});
