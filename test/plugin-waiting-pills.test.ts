import { describe, expect, it } from "vitest";
import { pillIdOf, pillOf, planPills, questionCountOf } from "../plugin/client/waiting-pills-model";
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
