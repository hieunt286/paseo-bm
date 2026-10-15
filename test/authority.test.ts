import { describe, expect, it } from "vitest";
import { deciderOf, grantWithin, type AuthorityFacts } from "../plugin/shared/authority";
import type { Decision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";

/**
 * The authority resolver (mission runtime design §4.1, ADR-033 decision 3,
 * REQ-204): each rule, in order, and the review caps of §4.3. Pure.
 */

const MISSION = "mis-0123456789";
const REQ = "req-20260929T073348Z";

function facts(over: Partial<{ repo: Record<string, string>; mission: string[]; inMission: boolean; caps: { codeLeft: number; mainLeft: number } | null }> = {}): AuthorityFacts {
  const repo = over.repo ?? {};
  return {
    modeOf: (_workspaceId, decisionClass) => (repo[decisionClass] ?? repo["*"] ?? "owner") as never,
    missionOf: (requestId) => (over.inMission === false || requestId === null ? null : MISSION),
    missionDelegates: (_missionId, cell) => (over.mission ?? []).includes(cell),
    reviewCaps: () => (over.caps === undefined ? { codeLeft: 2, mainLeft: 2 } : over.caps),
  };
}

const question = (over: Partial<Decision> = {}): Decision =>
  makeDecision({ requestId: REQ, class: "scope", subject: "tools", options: [{ key: "a", label: "A", recommended: true, effects: ["none"] }, { key: "b", label: "B", recommended: false, effects: ["none"] }], ...over });
const budget = (grant: { calls: number } | { untilClean: string }): Decision =>
  question({ class: "cost", subject: "review-budget", options: [{ key: "a", label: "More", recommended: true, effects: ["none"], grant }, { key: "b", label: "Commit", recommended: false, effects: ["commit"] }] });

describe("deciderOf (design §4.1)", () => {
  it("rule 1: ownerOnly, o:, r:, h:, m: and prepared changes are the owner's", () => {
    const all = facts({ repo: { "*": "delegate" }, mission: ["answer-technical", "answer-effects"] });
    expect(deciderOf(question({ ownerOnly: true }), all).decider).toBe("owner");
    expect(deciderOf(question({ id: "o:3b823408-382c-45b2-8d7d-9551cd9ff058" }), all).decider).toBe("owner");
    expect(deciderOf(question({ id: `m:${MISSION}:1` }), all)).toMatchObject({ decider: "owner", rule: "owner-kind" });
    expect(deciderOf(question({ options: [{ key: "a", label: "Raise", recommended: true, effects: ["none"], action: { kind: "coordination.set", key: "review.smallBudget", value: 4 } as never }] }), all).rule).toBe("prepared-change");
  });

  it("rule 2: an f: incident whose class is delegated is the Orchestrator's", () => {
    const incident = question({ id: "f:fallback-1", requestId: null, class: "environment" });
    expect(deciderOf(incident, facts({ repo: { environment: "delegate" } })).decider).toBe("orchestrator");
    expect(deciderOf(incident, facts()).decider).toBe("owner");
  });

  it("rule 3: a review budget within the code cap, cost delegated by the repo or the mission, is code's — untilClean too, while any cap is left", () => {
    expect(deciderOf(budget({ calls: 2 }), facts({ repo: { cost: "delegate" } }))).toMatchObject({ decider: "code", rule: "review-budget-code" });
    expect(deciderOf(budget({ untilClean: "b2" }), facts({ mission: ["answer-effects"] })).decider).toBe("code");
    // The XAI case: Full auto, untilClean recommended — no longer the owner's.
    expect(deciderOf(budget({ untilClean: "b2" }), facts({ repo: { "*": "delegate" } })).decider).toBe("code");
  });

  it("rule 4 for a review budget: past the code cap, the Main within its own; past both, the owner", () => {
    expect(deciderOf(budget({ calls: 3 }), facts({ repo: { cost: "delegate" }, caps: { codeLeft: 2, mainLeft: 3 } })).decider).toBe("main");
    expect(deciderOf(budget({ untilClean: "b1" }), facts({ repo: { cost: "delegate" }, caps: { codeLeft: 0, mainLeft: 1 } })).decider).toBe("main");
    // Option b grants nothing: the Main may always choose not to review more.
    expect(deciderOf(budget({ calls: 9 }), facts({ repo: { cost: "delegate" }, caps: { codeLeft: 0, mainLeft: 0 } })).decider).toBe("main");
    expect(deciderOf(budget({ calls: 2 }), facts()).decider).toBe("owner");
    expect(deciderOf(budget({ calls: 2 }), facts({ repo: { cost: "delegate" }, inMission: false, caps: { codeLeft: 0, mainLeft: 2 } })).decider).toBe("owner");
  });

  it("rule 4: a question of a mission request whose class the repo or the mission delegates is the Main's — any class, effects included", () => {
    expect(deciderOf(question(), facts({ repo: { scope: "delegate" } }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    expect(deciderOf(question(), facts({ mission: ["answer-technical"] })).decider).toBe("main");
    expect(deciderOf(question({ class: "release", options: [{ key: "a", label: "Push", recommended: true, effects: ["push"] }] }), facts({ mission: ["answer-effects"] })).decider).toBe("main");
    // Outside a mission, the policy has no Main to name.
    expect(deciderOf(question(), facts({ repo: { scope: "delegate" }, inMission: false })).decider).toBe("owner");
  });

  it("rule 5: a shadow cell — the owner decides, the Main recommends; rule 6: anything else is the owner's", () => {
    expect(deciderOf(question(), facts({ repo: { scope: "shadow" } }))).toMatchObject({ decider: "owner", rule: "shadow-main", recommend: true });
    expect(deciderOf(question(), facts())).toMatchObject({ decider: "owner", rule: "owner", recommend: false });
  });

  it("grantWithin: calls up to what is left; untilClean while anything is left", () => {
    expect(grantWithin(undefined, 0)).toBe(true);
    expect(grantWithin({ calls: 2 }, 2)).toBe(true);
    expect(grantWithin({ calls: 3 }, 2)).toBe(false);
    expect(grantWithin({ untilClean: "b1" }, 1)).toBe(true);
    expect(grantWithin({ untilClean: "b1" }, 0)).toBe(false);
  });
});
