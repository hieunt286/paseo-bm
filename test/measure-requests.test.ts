import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script without type declarations
import { measure } from "../scripts/measure-requests.mjs";

/**
 * The before/after measurement (design delta 20260924-worker-autonomy §2,
 * PRD delta N5): what it counts, on a request small enough to count by hand.
 */
const REQ = "req-20260924T010000Z";
const questions = [
  "BM-REPORT",
  `requestId: ${REQ}`,
  "phase: blocked",
  "",
  "BM-QUESTIONS",
  `requestId: ${REQ}`,
  "Q1: Storage?",
  "- a: table. (recommended)",
  "- b: file.",
  "Q2: Cookie?",
  "- a: keep. (recommended)",
  "- b: rename.",
].join("\n");
const answers = ["BM-ANSWERS", `requestId: ${REQ}`, "Q1: a — table.", "Q2: b — rename."].join("\n");

const records = [
  { at: "2026-09-24T01:01:00Z", startedAt: "2026-09-24T01:00:00Z", endedAt: "2026-09-24T01:01:00Z", role: "manager", requestId: REQ, usage: { inputTokens: 0, cachedInputTokens: 100, outputTokens: 1 }, sent: [{ at: "2026-09-24T01:00:30Z", origin: "agent", text: questions }], reports: [{ tier: "Medium" }] },
  { at: "2026-09-24T01:20:00Z", startedAt: "2026-09-24T01:10:00Z", endedAt: "2026-09-24T01:20:00Z", role: "worker", requestId: REQ, usage: { inputTokens: 0, cachedInputTokens: 600, outputTokens: 10 }, sent: [{ at: "2026-09-24T01:10:30Z", origin: "user", text: answers }], reports: [] },
  { at: "2026-09-24T01:30:00Z", startedAt: "2026-09-24T01:25:00Z", endedAt: "2026-09-24T01:30:00Z", role: "worker", requestId: REQ, usage: { inputTokens: 0, cachedInputTokens: 200, outputTokens: 5 }, sent: [], reports: [] },
  { at: "2026-09-24T01:28:00Z", startedAt: "2026-09-24T01:26:00Z", endedAt: "2026-09-24T01:28:00Z", role: "reviewer", requestId: REQ, usage: { inputTokens: 0, cachedInputTokens: 100, outputTokens: 3 }, sent: [{ at: "2026-09-24T01:26:00Z", origin: "agent", text: "Review b1" }], reports: [] },
];

describe("measure", () => {
  it("counts context by role, wake-ups, rounds, waiting, recommendations and per-tier averages", () => {
    const result = measure(records);
    expect(result.contextShareByRole).toEqual({ manager: 10, worker: 80, reviewer: 10 });
    expect(result.workerWakeShareOfWorker).toBe(25);
    expect(result.questionRounds).toBe(1);
    expect(result.userWaitHours).toBe(0.2); // 01:00:30 → 01:10:30
    expect(result.workerBusyHours).toBe(0.3); // 10 + 5 minutes
    expect(result.answeredQuestions).toBe(2);
    expect(result.tookRecommendationPercent).toBe(50);
    expect(result.perRequestByTier).toEqual({ Medium: { requests: 1, questions: 2, workerTurns: 2, reviewerTurns: 1, contextMillions: 0 } });
  });

  it("does not count an answer twice, nor an answer to a question it never saw asked", () => {
    const again = { ...records[1], at: "2026-09-24T01:40:00Z", sent: [{ at: "2026-09-24T01:40:00Z", origin: "user", text: answers }] };
    const stray = { ...records[1], at: "2026-09-24T01:41:00Z", sent: [{ at: "2026-09-24T01:41:00Z", origin: "user", text: answers.replace(REQ, "req-20260924T020000Z").replace(REQ, "req-20260924T020000Z") }] };
    expect(measure([...records, again, stray]).answeredQuestions).toBe(2);
  });
});
