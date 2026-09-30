import type { Decision } from "../../plugin/shared/decisions";

/** The workspace and request every decision fixture belongs to unless told otherwise. */
export const DECISION_WS = "wks_1";
export const DECISION_REQUEST = "req-20260929T073348Z";
export const DECISION_ASKED_AT = "2026-09-29T07:40:00.000Z";

/**
 * An open Worker question with three options: `a` (recommended, pushes), `b`
 * (pushes and publishes) and `c` (no effect).
 */
export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  const requestId = overrides.requestId === undefined ? DECISION_REQUEST : overrides.requestId;
  return {
    id: `q:${requestId}:Q1`,
    workspaceId: DECISION_WS,
    requestId,
    askedBy: { role: "worker", agentId: "agent-worker" },
    askedAt: DECISION_ASKED_AT,
    round: 1,
    question: "Push both backends to origin/dev?",
    subject: "push-backends",
    options: [
      { key: "a", label: "Push contract only", recommended: true, effects: ["push"], action: { kind: "answer-worker" } },
      { key: "b", label: "Push both and publish", recommended: false, effects: ["push", "publish"] },
      { key: "c", label: "Hold", recommended: false, effects: ["none"] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}
