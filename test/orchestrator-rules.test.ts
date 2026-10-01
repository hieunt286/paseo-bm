import { describe, expect, it } from "vitest";
import { EXCERPT_MAX_CHARS, excerptOf, flagsOf, isProcessDocumentPath, type Flag, type RuleFacts } from "../plugin/shared/orchestrator-rules";
import * as rules from "../plugin/shared/orchestrator-rules";
import { RULE_IDS, type RuleId } from "../plugin/shared/orchestrator";
import type { RuleInput, RuleMessage } from "../plugin/shared/rule-input";
import {
  MANAGER,
  REVIEWER,
  agent,
  at,
  clean,
  factsWith,
  failedFirstTurn,
  inputOf,
  languageAfterReport,
  msg,
  shell,
  smallWithBead,
  turn,
} from "./fixtures/orchestrator-traces";

/**
 * Orchestrator design §4.1–§4.3, REQ-072: the one runtime rule left,
 * `review.over-budget`, which the stall pass reads (autonomy design §A.8). The
 * six rules that served only the workflow assessment are retired (§B.8, §B.9):
 * their figures are the replay's (`test/eval-metrics.test.ts`).
 */

const only = (input: RuleInput, facts: RuleFacts, rule: RuleId): Flag | undefined =>
  flagsOf(input, facts).find((flag) => flag.rule === rule);

/** The clean request with some fields of its input replaced. */
function cleanWith(patch: Partial<RuleInput>): { input: RuleInput; facts: RuleFacts } {
  const fixture = clean();
  return { input: { ...fixture.input, ...patch }, facts: fixture.facts };
}

const message = (overrides: Partial<RuleMessage> & Pick<RuleMessage, "at" | "text">): RuleMessage => ({
  agentId: MANAGER,
  role: "manager",
  truncated: false,
  origin: null,
  ...overrides,
});

describe("the retired rules (autonomy design §B.9)", () => {
  it("leaves review.over-budget alone in the catalogue", () => {
    expect(RULE_IDS).toEqual(["review.over-budget"]);
    // Their helpers went with them; the process-document test stays for the Worker watch and the replay.
    expect(Object.keys(rules).sort()).toEqual(["EXCERPT_MAX_CHARS", "excerptOf", "flagsOf", "isProcessDocumentPath"]);
  });

  it("raises nothing for the 2026-09-26 slips they used to flag", () => {
    for (const fixture of [smallWithBead(), languageAfterReport(), failedFirstTurn(), clean()]) {
      expect(flagsOf(fixture.input, fixture.facts)).toEqual([]);
    }
  });

  it("reads only the tier, the review calls and the inbound messages of a request", () => {
    expect(Object.keys(clean().input).sort()).toEqual(["inbound", "requestId", "reviewCalls", "tier", "traceId"]);
    expect(Object.keys(factsWith())).toEqual(["reviewBudget"]);
  });
});

describe("review.over-budget", () => {
  it("raised: more review calls than REVIEW_BUDGET[tier], with the review calls as evidence", () => {
    const medium = cleanWith({ reviewCalls: 3 });
    const flag = only(medium.input, medium.facts, "review.over-budget");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.observed).toBe("The Medium request made 3 review calls, over its budget of 2.");
    expect(flag?.evidence.map((entry) => [entry.agentId, entry.kind])).toEqual([[REVIEWER, "sent"]]);
    const large = cleanWith({ tier: "Large", reviewCalls: 5 });
    expect(only(large.input, large.facts, "review.over-budget")?.state).toBe("raised");
  });

  it("not raised: at the budget, or no review call count", () => {
    expect(only(clean().input, clean().facts, "review.over-budget")).toBeUndefined();
    const atBudget = cleanWith({ tier: "Large", reviewCalls: 4 });
    expect(only(atBudget.input, atBudget.facts, "review.over-budget")).toBeUndefined();
    const small = cleanWith({ tier: "Small", reviewCalls: 2 });
    expect(only(small.input, small.facts, "review.over-budget")).toBeUndefined();
    const unknownCalls = cleanWith({ reviewCalls: null });
    expect(only(unknownCalls.input, unknownCalls.facts, "review.over-budget")).toBeUndefined();
  });

  it("reads the budget from facts, not from server code", () => {
    const { input, facts } = cleanWith({ reviewCalls: 2 });
    expect(only(input, { ...facts, reviewBudget: { Small: 1, Medium: 1, Large: 1 } }, "review.over-budget")?.state).toBe(
      "raised",
    );
  });

  it("unknown: more calls than the smallest budget, but no tier", () => {
    const { input, facts } = cleanWith({ tier: null, reviewCalls: 3 });
    expect(only(input, facts, "review.over-budget")?.state).toBe("unknown");
    const withinEvery = cleanWith({ tier: null, reviewCalls: 2 });
    expect(only(withinEvery.input, withinEvery.facts, "review.over-budget")).toBeUndefined();
  });

  it("leaves a review block and a plugin notice out of its evidence", () => {
    const { input, facts } = cleanWith({
      reviewCalls: 3,
      inbound: [
        message({ agentId: REVIEWER, role: "reviewer", at: at(4), text: "Review batch b2, stage implementation." }),
        message({ agentId: REVIEWER, role: "reviewer", at: at(4, 30), text: "BM-REVIEW\nrequestId: r\nbatchId: b2\nverdict: approved" }),
        message({ agentId: MANAGER, at: at(5), text: "Anything for the Manager is not a review call." }),
      ],
    });
    expect(only(input, facts, "review.over-budget")?.evidence.map((entry) => entry.at)).toEqual([at(4)]);
  });
});

describe("the flag", () => {
  it("carries excerpts of at most 160 characters, one English sentence for observed and why, and names no agent to nudge", () => {
    expect(EXCERPT_MAX_CHARS).toBe(160);
    const { input, facts } = cleanWith({
      reviewCalls: 3,
      inbound: [message({ agentId: REVIEWER, role: "reviewer", at: at(1), text: `Review ${"x".repeat(400)}`, origin: "agent" })],
    });
    const [flag] = flagsOf(input, facts);
    expect(flag).toBeDefined();
    for (const entry of flag!.evidence) expect(Array.from(entry.excerpt).length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(Object.keys(flag!).sort()).toEqual(["evidence", "observed", "rule", "severity", "state", "why"]);
    for (const sentence of [flag!.observed, flag!.why]) {
      expect(sentence).toMatch(/^[A-Z0-9][^\n]*\.$/);
      expect(sentence).toMatch(/^[\x20-\x7E]+$/);
    }
    const cut = excerptOf(`a\n\n${"b".repeat(300)}`);
    expect(Array.from(cut)).toHaveLength(160);
    expect(cut.startsWith("a b")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(excerptOf("  short   text \n")).toBe("short text");
  });

  it("is deterministic, leaves its arguments untouched, and a rebuilt fixture gives the same flags", () => {
    const { input, facts } = cleanWith({ reviewCalls: 3 });
    const before = JSON.stringify([input, facts]);
    expect(flagsOf(input, facts)).toEqual(flagsOf(input, facts));
    expect(JSON.stringify([input, facts])).toBe(before);
    // The rebuild helper also serves a hand-made record set.
    const built = inputOf(
      "req-20260926T110000Z",
      [
        turn({
          at: at(0, 40),
          requestId: "req-20260926T110000Z",
          sent: [msg(MANAGER, at(0, 20), "Sửa giúp mình lỗi định dạng ngày nhé.", "user")],
          evidence: [shell("npm test", at(0, 30), MANAGER)],
        }),
      ],
      [agent({ id: MANAGER, role: "manager" })],
    );
    expect(flagsOf(built, factsWith())).toEqual([]);
  });
});

describe("isProcessDocumentPath (the Worker watch and the replay)", () => {
  it("docs/plans and docs/adr only, relative or absolute, either separator", () => {
    expect(isProcessDocumentPath("docs/plans/x.md")).toBe(true);
    expect(isProcessDocumentPath("/work/app/docs/adr/ADR-001.md")).toBe(true);
    expect(isProcessDocumentPath("C:\\work\\app\\docs\\plans\\x.md")).toBe(true);
    expect(isProcessDocumentPath("docs/design/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/product/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/archive/plans/x.md")).toBe(false);
    expect(isProcessDocumentPath("mydocs/plans/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/plans")).toBe(false);
  });
});
