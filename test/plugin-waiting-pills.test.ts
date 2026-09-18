import { afterEach, describe, expect, it, vi } from "vitest";
import { WAITING_POLL_MS, fnv1a32Hex, pillIdOf, pillOf, planPills, questionCountOf } from "../plugin/client/waiting-pills-model";
import type { WaitingWorker } from "../plugin/shared/contracts";

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
