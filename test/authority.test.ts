import { describe, expect, it } from "vitest";
import { deciderOf, type AuthorityFacts } from "../plugin/shared/authority";
import type { Decision, DecisionOption } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";

/**
 * The authority resolver (mission runtime design §4.1, ADR-033 decision 3,
 * REQ-204): each rule, in order. The review rules are retired (delivery line
 * design §5.6). Pure.
 */

const MISSION = "mis-0123456789";
const REQ = "req-20260929T073348Z";

function facts(over: Partial<{ repo: Record<string, string>; mission: string[]; inMission: boolean; unverified: boolean }> = {}): AuthorityFacts {
  const repo = over.repo ?? {};
  return {
    modeOf: (_workspaceId, decisionClass) => (repo[decisionClass] ?? repo["*"] ?? "owner") as never,
    missionOf: (requestId) => (over.inMission === false || requestId === null ? null : MISSION),
    missionDelegates: (_missionId, cell) => (over.mission ?? []).includes(cell),
    ...(over.unverified === undefined ? {} : { finishedUnverified: () => over.unverified! }),
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

  it("ADR-040: a mission request's delegated fallback belongs to its Main", () => {
    const incident = question({ id: "f:fallback-1", class: "environment" });
    expect(deciderOf(incident, facts({ repo: { environment: "delegate" } }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    expect(deciderOf(incident, facts({ mission: ["answer-effects"] }))).toMatchObject({ decider: "main", withoutEffects: true });
    expect(deciderOf(incident, facts({ mission: ["answer-technical"] })).decider).toBe("owner");
    expect(deciderOf(incident, facts({ repo: { environment: "delegate" }, inMission: false })).decider).toBe("orchestrator");
    expect(deciderOf({ ...incident, requestId: null }, facts({ repo: { environment: "delegate" } })).decider).toBe("orchestrator");
  });

  it("rule 2 (delivery line design §7.1, case 2): an f: incident whose every acting option the unverified-finish rule refuses is the owner's", () => {
    const commit = { kind: "command", to: "worker", agentId: "w-1", intent: "continue", body: "commit it", effects: ["commit"] } as never;
    const resend = { kind: "fallback", action: "resend", target: "fallback-1" } as never;
    const finishing = question({ id: "f:fallback-1", class: "environment", options: [{ key: "a", label: "Commit", recommended: true, effects: ["none"], action: commit }, { key: "b", label: "Wait", recommended: false, effects: ["none"] }] });
    expect(deciderOf(finishing, facts({ repo: { environment: "delegate" }, unverified: true }))).toMatchObject({ decider: "owner", rule: "owner" });
    // In a mission, a verified finish or an allowed recovery option belongs to its Main.
    expect(deciderOf(finishing, facts({ repo: { environment: "delegate" }, unverified: false })).decider).toBe("main");
    expect(deciderOf(finishing, facts({ repo: { environment: "delegate" } })).decider).toBe("main");
    const mixed = question({ id: "f:fallback-1", class: "environment", options: [{ key: "a", label: "Commit", recommended: true, effects: ["none"], action: commit }, { key: "b", label: "Resend", recommended: false, effects: ["none"], action: resend }] });
    expect(deciderOf(mixed, facts({ repo: { environment: "delegate" }, unverified: true })).decider).toBe("main");
  });

  it("no review rule (delivery line design §5.6): a legacy review-budget question is decided as any question of its class", () => {
    // Cost delegated by the repo or the mission: the Main, as any delegated class — never code, whatever its grants.
    expect(deciderOf(budget({ calls: 2 }), facts({ repo: { cost: "delegate" } }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    expect(deciderOf(budget({ untilClean: "b2" }), facts({ mission: ["answer-effects"] }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    // Not delegated, or outside a mission: the owner.
    expect(deciderOf(budget({ calls: 2 }), facts()).decider).toBe("owner");
    expect(deciderOf(budget({ calls: 9 }), facts({ repo: { cost: "delegate" }, inMission: false })).decider).toBe("owner");
  });

  it("the review cap's question is ownerOnly: the owner's at every level (rule 1)", () => {
    const capQuestion = question({ class: "cost", subject: "review-cap", ownerOnly: true, options: [{ key: "a", label: "One more round", recommended: true, effects: ["cost"], grant: { calls: 3 } }, { key: "b", label: "Finish", recommended: false, effects: ["none"] }] });
    expect(deciderOf(capQuestion, facts({ repo: { "*": "delegate" }, mission: ["answer-technical", "answer-effects"] }))).toMatchObject({ decider: "owner", rule: "owner-only" });
  });

  it("rule 3: a question of a mission request whose class the repo or the mission delegates is the Main's", () => {
    expect(deciderOf(question(), facts({ repo: { scope: "delegate" } }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    expect(deciderOf(question(), facts({ mission: ["answer-technical"] })).decider).toBe("main");
    // Outside a mission, the policy has no Main to name.
    expect(deciderOf(question(), facts({ repo: { scope: "delegate" }, inMission: false })).decider).toBe("owner");
  });

  it("rule 3 (delivery line design §7.1, case 1): delegated by the mission only, the Main is named only when an option leaves no effect", () => {
    const push: DecisionOption = { key: "a", label: "Push", recommended: true, effects: ["push"] };
    const pushOnly = question({ class: "release", options: [{ ...push }, { key: "b", label: "Publish", recommended: false, effects: ["publish"] }] });
    // The Main's answer covers no effect: the owner decides, the Main recommending.
    expect(deciderOf(pushOnly, facts({ mission: ["answer-effects"] }))).toMatchObject({ decider: "owner", rule: "mission-effects", recommend: true });
    // A command approving an effect leaves it too.
    const commanded = question({ class: "release", options: [{ key: "a", label: "Push", recommended: true, effects: ["none"], action: { kind: "command", to: "worker", agentId: "w-1", intent: "release", body: "push", effects: ["push"] } as never }, { ...push, key: "b", recommended: false }] });
    expect(deciderOf(commanded, facts({ mission: ["answer-effects"] })).rule).toBe("mission-effects");
    // One option with no effect: the Main settles it.
    expect(deciderOf(question({ class: "release", options: [{ ...push }, { key: "b", label: "Wait", recommended: false, effects: ["none"] }] }), facts({ mission: ["answer-effects"] }))).toMatchObject({ decider: "main", rule: "delegated-main" });
    // The repo cell delegates the class: the policy covers the effects, so the Main decides.
    expect(deciderOf(pushOnly, facts({ repo: { release: "delegate" } }))).toMatchObject({ decider: "main", rule: "delegated-main" });
  });

  it("rule 4: a shadow cell — the owner decides, the Main recommends; rule 5: anything else is the owner's", () => {
    expect(deciderOf(question(), facts({ repo: { scope: "shadow" } }))).toMatchObject({ decider: "owner", rule: "shadow-main", recommend: true });
    expect(deciderOf(question(), facts())).toMatchObject({ decider: "owner", rule: "owner", recommend: false });
  });
});
