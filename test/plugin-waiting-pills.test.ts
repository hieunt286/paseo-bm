import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_PILL_ICON,
  WAITING_PILL_ICON,
  WAITING_POLL_MS,
  fallbackPillIdOf,
  fallbackPillsOf,
  fnv1a32Hex,
  pillChatOf,
  pillIdOf,
  pillOf,
  planPills,
  questionCountOf,
} from "../plugin/client/waiting-pills-model";
import type { FallbackIncident, WaitingFallback, WaitingWorker } from "../plugin/shared/contracts";

/**
 * The "questions waiting" pills (delta 20260918d-card-replies §4.8, REQ-059 j):
 * one per waiting Worker, redrawn only when something it shows changed.
 */

const REQ = "req-20260918T041426Z";

function asking(questions: number, requestId = REQ): string {
  const lines = ["BM-QUESTIONS", `requestId: ${requestId}`];
  for (let n = 1; n <= questions; n += 1) lines.push(`Q${n}: Topic ${n} — which one?`, "- a: this. (recommended)", "- b: that.");
  return [
    "BM-REPORT",
    `requestId: ${requestId}`,
    "phase: blocked",
    "tier: Large (changed: no)",
    `blockers: ${questions} questions — see BM-QUESTIONS`,
    "",
    ...lines,
  ].join("\n");
}

const entry = (overrides: Partial<WaitingWorker> = {}): WaitingWorker => ({
  managerId: "m1",
  workspaceId: "wks_a",
  workerId: "w1",
  workerTitle: "Card replies",
  requestId: REQ,
  text: asking(2),
  at: "2026-09-18T05:00:00.000Z",
  ...overrides,
});

describe("a waiting Worker's pill", () => {
  it("names the Worker and counts its questions", () => {
    expect(questionCountOf(entry())).toBe(2);
    expect(pillOf(entry())).toMatchObject({
      id: "bm-waiting-w1",
      label: "Worker · Card replies · 2 questions",
      title: `Questions from Worker · Card replies about ${REQ}`,
    });
    expect(pillOf(entry({ text: asking(1) }))?.label).toBe("Worker · Card replies · 1 question");
    expect(pillIdOf("w9")).toBe("bm-waiting-w9");
  });

  it("is not made for a report without questions", () => {
    expect(pillOf(entry({ text: asking(0) }))).toBeNull();
  });
});

describe("planning the pills", () => {
  const first = entry();
  const second = entry({ workerId: "w2", workerTitle: "Beads tab", requestId: "req-20260918T043115Z", text: asking(1, "req-20260918T043115Z") });
  const shownOf = (...pills: WaitingWorker[]) => new Map(pills.map((e) => [pillOf(e)!.id, pillOf(e)!.key]));

  it("adds a pill for each new waiting Worker", () => {
    const plan = planPills(new Map(), [first, second]);
    expect(plan.add.map((pill) => pill.id)).toEqual(["bm-waiting-w1", "bm-waiting-w2"]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("leaves unchanged pills alone", () => {
    expect(planPills(shownOf(first, second), [first, second])).toEqual({ add: [], update: [], remove: [] });
  });

  it("redraws a pill whose report changed", () => {
    const plan = planPills(shownOf(first, second), [entry({ at: "2026-09-18T05:30:00.000Z", text: asking(3) }), second]);
    expect(plan.update.map((pill) => [pill.id, pill.label])).toEqual([["bm-waiting-w1", "Worker · Card replies · 3 questions"]]);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("redraws a pill whose report text changed even when there is no timestamp (delta 20260918f F14)", () => {
    const undated = entry({ at: null, text: asking(2) });
    const shown = new Map([[pillIdOf("w1"), pillOf(undated)!.key]]);
    // Same Worker, same number of questions, still no time: only the text differs.
    const newer = entry({ at: null, text: asking(2).replace("Topic 1", "Storage") });
    expect(planPills(shown, [newer]).update.map((pill) => pill.id)).toEqual([pillIdOf("w1")]);
    expect(planPills(shown, [undated])).toEqual({ add: [], update: [], remove: [] });
  });

  it("hashes the report text with FNV-1a 32-bit, in hex", () => {
    expect(fnv1a32Hex("")).toBe("811c9dc5");
    expect(fnv1a32Hex("a")).toBe("e40c292c");
  });

  it("removes the pill of a Worker that no longer waits", () => {
    const plan = planPills(shownOf(first, second), [second]);
    expect(plan.remove).toEqual(["bm-waiting-w1"]);
    expect(plan.add).toEqual([]);
    expect(plan.update).toEqual([]);
  });

  it("skips a report without questions, and a Worker listed twice", () => {
    const plan = planPills(new Map(), [entry({ text: asking(0) }), second, second]);
    expect(plan.add.map((pill) => pill.id)).toEqual(["bm-waiting-w2"]);
  });
});

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-3f9a2c1d7e4b",
  role: "worker",
  workspaceId: "wks_a",
  requestId: REQ,
  agentId: "w1",
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: "m1",
  managerId: "m1",
  class: "L1",
  signal: "failed",
  message: "You've hit your usage limit.",
  perModelWindow: false,
  resetsAt: "2026-09-21T15:40:00Z",
  candidate: { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: null },
  status: "pending",
  detectedAt: "2026-09-21T14:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

/** A `chat.waiting` fallback entry: the incident in its Manager's chat. */
const waitingOn = (managerId: string, workspaceId: string, overrides: Partial<FallbackIncident> = {}): WaitingFallback => ({
  managerId,
  workspaceId,
  incident: incident({ managerId, ...overrides }),
});

describe("a Manager's fallback pill (delta 20260921 §4.4.6)", () => {
  it("counts the pending incidents of that Manager only, one pill per Manager", () => {
    const pills = fallbackPillsOf([
      waitingOn("m1", "wks_a"),
      waitingOn("m1", "wks_a", { id: "fb-000000000002" }),
      waitingOn("m2", "wks_b", { id: "fb-000000000003" }),
      // Not pending, or not this Manager's: never counted, even if sent.
      waitingOn("m1", "wks_a", { id: "fb-000000000004", status: "dismissed" }),
      waitingOn("m1", "wks_a", { id: "fb-000000000005", status: "switched" }),
      { managerId: "m1", workspaceId: "wks_a", incident: incident({ id: "fb-000000000006", managerId: "m9" }) },
      // Listed twice: counted once.
      waitingOn("m1", "wks_a"),
    ]);
    expect(pills.map((pill) => [pill.id, pill.label, pill.incidents.map((i) => i.id)])).toEqual([
      ["bm-fallback-m1", "Fallback · 2 decisions", ["fb-3f9a2c1d7e4b", "fb-000000000002"]],
      ["bm-fallback-m2", "Fallback · 1 decision", ["fb-000000000003"]],
    ]);
    expect(pills[0]).toMatchObject({ kind: "fallback", managerId: "m1", workspaceId: "wks_a" });
    expect(pills[1]!.title).toBe("An agent stopped by its provider plan waits for your decision");
    expect(pills[0]!.title).toBe("2 agents stopped by their provider plan wait for your decision");
    expect(fallbackPillIdOf("m7")).toBe("bm-fallback-m7");
    expect(pillChatOf(pills[1]!)).toEqual({ managerId: "m2", workspaceId: "wks_b" });
  });

  it("is not made when nothing is pending", () => {
    expect(fallbackPillsOf([])).toEqual([]);
    expect(fallbackPillsOf([waitingOn("m1", "wks_a", { status: "waiting" }), waitingOn("m1", "wks_a", { status: "failed" })])).toEqual([]);
  });

  it("sits next to the question pills, redrawn when its incidents change and removed when none is pending", () => {
    const asked = entry();
    expect(pillChatOf(pillOf(asked)!)).toEqual({ managerId: "m1", workspaceId: "wks_a" });
    const first = planPills(new Map(), [asked], [waitingOn("m1", "wks_a")]);
    expect(first.add.map((pill) => [pill.id, pill.label])).toEqual([
      ["bm-waiting-w1", "Worker · Card replies · 2 questions"],
      ["bm-fallback-m1", "Fallback · 1 decision"],
    ]);
    const shown = new Map(first.add.map((pill) => [pill.id, pill.key]));
    expect(planPills(shown, [asked], [waitingOn("m1", "wks_a")])).toEqual({ add: [], update: [], remove: [] });
    // One more incident redraws the pill; so does a different one at the same count.
    const more = planPills(shown, [asked], [waitingOn("m1", "wks_a"), waitingOn("m1", "wks_a", { id: "fb-000000000002" })]);
    expect(more.update.map((pill) => [pill.id, pill.label])).toEqual([["bm-fallback-m1", "Fallback · 2 decisions"]]);
    const swapped = planPills(shown, [asked], [waitingOn("m1", "wks_a", { id: "fb-000000000002" })]);
    expect(swapped.update.map((pill) => pill.id)).toEqual(["bm-fallback-m1"]);
    // Decided: the pill goes, the question pill stays.
    expect(planPills(shown, [asked], [waitingOn("m1", "wks_a", { status: "dismissed" })])).toEqual({ add: [], update: [], remove: ["bm-fallback-m1"] });
    expect(planPills(shown, [asked])).toEqual({ add: [], update: [], remove: ["bm-fallback-m1"] });
  });
});

// `waiting-pills.tsx` draws a chat card, so `react-native` is replaced by inert
// stand-ins, as in test/plugin-launcher.test.ts.
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Pressable: () => null,
  ScrollView: () => null,
  Text: () => null,
  TextInput: () => null,
  View: () => null,
}));

describe("a pill keeps its popover when it is redrawn (delta 20260918f F13)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates title and label but hands the same Content, which reads the newest report", async () => {
    vi.useFakeTimers();
    const pillsPath = "../plugin/client/waiting-pills.tsx";
    const { registerWaitingPills, waitingEntryOf } = (await import(pillsPath)) as {
      registerWaitingPills: (client: unknown) => () => void;
      waitingEntryOf: (pillId: string) => WaitingWorker | undefined;
    };
    const answers = [
      { waiting: [entry({ text: asking(1), at: "2026-09-18T05:00:00.000Z" })] },
      { waiting: [entry({ text: asking(2), at: "2026-09-18T05:10:00.000Z" })] },
    ];
    const added: Array<{ button: { behavior: { Content: unknown } } }> = [];
    const updates: Array<{ behavior: { Content: unknown }; label: string }> = [];
    const client = {
      rpc: vi.fn(async () => answers.shift() ?? { waiting: [] }),
      addComposerPill: vi.fn((registration: { button: { behavior: { Content: unknown } } }) => {
        added.push(registration);
        return { update: vi.fn((button: (typeof updates)[number]) => updates.push(button)), remove: vi.fn() };
      }),
    };

    const stop = registerWaitingPills(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(added).toHaveLength(1);
    expect(waitingEntryOf(pillIdOf("w1"))?.text).toBe(asking(1));

    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.label).toBe("Worker · Card replies · 2 questions");
    expect(updates[0]!.behavior.Content).toBe(added[0]!.button.behavior.Content);
    expect(waitingEntryOf(pillIdOf("w1"))?.text).toBe(asking(2));

    stop();
    expect(waitingEntryOf(pillIdOf("w1"))).toBeUndefined();
  });
});

describe("the fallback pill's popover (delta 20260921 §4.4.6)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes on the Manager's chat and shows that Manager's pending incidents, newest set after each read", async () => {
    vi.useFakeTimers();
    const pillsPath = "../plugin/client/waiting-pills.tsx";
    const { registerWaitingPills, fallbackEntriesOf, waitingEntryOf } = (await import(pillsPath)) as {
      registerWaitingPills: (client: unknown) => () => void;
      fallbackEntriesOf: (pillId: string) => FallbackIncident[] | undefined;
      waitingEntryOf: (pillId: string) => WaitingWorker | undefined;
    };
    const answers = [
      { waiting: [], fallback: [waitingOn("m1", "wks_a")] },
      { waiting: [], fallback: [waitingOn("m1", "wks_a"), waitingOn("m1", "wks_a", { id: "fb-000000000002" })] },
      { waiting: [], fallback: [] },
    ];
    const added: Array<{ id: string; workspaceId: string; agentId: string; button: { icon: string; label: string; behavior: { Content: unknown } } }> = [];
    const updates: Array<{ label: string; behavior: { Content: unknown } }> = [];
    const removed = vi.fn();
    const client = {
      rpc: vi.fn(async () => answers.shift() ?? { waiting: [], fallback: [] }),
      addComposerPill: vi.fn((registration: (typeof added)[number]) => {
        added.push(registration);
        return { update: vi.fn((button: (typeof updates)[number]) => updates.push(button)), remove: removed };
      }),
    };

    const stop = registerWaitingPills(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: "bm-fallback-m1", workspaceId: "wks_a", agentId: "m1" });
    expect(added[0]!.button).toMatchObject({ icon: FALLBACK_PILL_ICON, label: "Fallback · 1 decision" });
    expect(FALLBACK_PILL_ICON).not.toBe(WAITING_PILL_ICON);
    expect(fallbackEntriesOf(fallbackPillIdOf("m1"))?.map((i) => i.id)).toEqual(["fb-3f9a2c1d7e4b"]);
    expect(waitingEntryOf(fallbackPillIdOf("m1"))).toBeUndefined();

    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
    expect(updates.map((button) => button.label)).toEqual(["Fallback · 2 decisions"]);
    expect(updates[0]!.behavior.Content).toBe(added[0]!.button.behavior.Content);
    expect(fallbackEntriesOf(fallbackPillIdOf("m1"))?.map((i) => i.id)).toEqual(["fb-3f9a2c1d7e4b", "fb-000000000002"]);

    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(fallbackEntriesOf(fallbackPillIdOf("m1"))).toBeUndefined();
    stop();
  });
});
